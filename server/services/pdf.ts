/**
 * server/services/pdf.ts —— 把 PDF 抽成 Markdown。
 *
 * 为什么用 pdfjs-dist 的 legacy 构建：
 *   新版 build 依赖一批浏览器 API（DOMMatrix、Path2D 等），在 Node 里要额外打补丁。
 *   legacy/build/pdf.mjs 是官方为 Node/旧环境准备的，开箱即用。
 *
 * ── 这一版解决了什么 ──
 *   1. 标题层级：以前只看「是不是短行」，结果整本书全是 ##，层级全平。
 *      现在按**字号**聚类定级（正文取众数，比正文大的依次是 h1/h2/h3），
 *      再用「第 N 章 / 1.2 / 1.2.3」这类编号修正级别。
 *   2. 页眉页脚：跨页重复出现在页顶/页底的同一行 → 判为页眉页脚丢掉；
 *      纯页码（阿拉伯数字、罗马数字）单独出现在页顶页底也丢掉。
 *   3. 目录页：带点线引导符 + 页码的行占比过半 → 整页跳过，不再把 40 页目录灌进正文。
 *   4. 图注：「图 1-2 …」「表 3-1 …」以前被当成标题，现在输出成引用块。
 *   5. 图片：走 operator list 把真正的位图对象取出来编码成 PNG/JPEG 写进 assets/。
 *
 * ── 做不到的事（老实说，不要假装做到了）──
 *   pdfjs 在 Node 里没有画布，**矢量绘制的插图无法栅格化**。
 *   技术书里的架构图大多是路径绘制的，导不出来，只能在正文里保留图注并给出提示。
 *   扫描件同理，本工具不含 OCR。
 */

import { createRequire } from 'node:module';
import { deflateSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { formatText } from './typographer';

// ─────────────────────────── PNG 编码 ───────────────────────────
// Node 里没有 canvas，位图只能自己打包成 PNG。好消息是只要 RGB 像素 + deflate，
// 不需要真的实现图形库。

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** 把 RGB 像素（每像素 3 字节）编码成 8bit truecolor PNG。 */
function encodePng(rgb: Uint8Array, width: number, height: number): Buffer {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  const src = Buffer.from(rgb.buffer, rgb.byteOffset, rgb.length);
  for (let y = 0; y < height; y++) {
    const o = y * (stride + 1);
    raw[o] = 0; // filter type: None（压缩率差一点，但实现最简单最不容易出错）
    src.copy(raw, o + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ─────────────────────────── 类型 ───────────────────────────

export interface PdfWord {
  str: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PdfImage {
  /** 建议文件名（不含目录），形如 文件名-p0032-1.png */
  file: string;
  /** 编好的图片字节（PNG 或原样 JPEG） */
  data: Buffer;
  width: number;
  height: number;
  /** 出现在第几页（1-based） */
  page: number;
}

export interface PdfExtractResult {
  markdown: string;
  pageCount: number;
  warnings: string[];
  /** 每页抽出的行数，用于判断抽取质量 */
  pageLines: number[];
  /** 导出的位图（路由负责落盘） */
  images: PdfImage[];
  /** 检测到的图/表题注数量，用于提示「矢量图导不出来」 */
  captionCount: number;
  /** 被判定为目录而跳过的页数 */
  tocPages: number;
}

interface TextItem {
  str?: string;
  transform?: number[];
  width?: number;
  height?: number;
  fontName?: string;
}

interface PdfPage {
  getViewport(o: { scale: number }): { width: number; height: number };
  getTextContent(): Promise<{ items: TextItem[] }>;
  getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[][] }>;
  objs?: { get(name: string, cb: (o: unknown) => void): void };
}

interface PdfDoc {
  numPages: number;
  getPage(n: number): Promise<PdfPage>;
  destroy(): Promise<void>;
}

/** 一行文本（聚合后的结果） */
interface Line {
  text: string;
  /** 行首 x，用于判断缩进另起一段 */
  x0: number;
  x1: number;
  /** 行顶端的 y（已翻成「从上到下」） */
  y: number;
  /** 该行相对于页高的位置，0=页顶 1=页底 */
  yRatio: number;
  /** 行内最大字号 */
  size: number;
  /** 主导字体名，用来判断是否等宽（代码） */
  font: string;
}

interface PageData {
  page: number;
  height: number;
  lines: Line[];
  images: PdfImage[];
}

// ─────────────────────────── 加载 pdfjs ───────────────────────────

/**
 * 动态 import：pdfjs 很大，只有真正导入 PDF 时才加载，避免拖慢启动。
 *
 * ★ workerSrc 必须是 ESM 能加载的 URL ★
 *   pdf.js 在 Node 里走 fake worker（主线程解析，不起真线程），但初始化**无论哪条
 *   分支都会检查 workerSrc**，空字符串会直接抛
 *   `Setting up fake worker failed: "No GlobalWorkerOptions.workerSrc specified."`
 *   另外 require.resolve 在 Windows 上返回 `C:\...` 这种裸路径，ESM 加载器只认
 *   file:// / data: / node:，所以必须过一层 pathToFileURL。
 */
async function loadPdfjs() {
  const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as {
    getDocument: (src: unknown) => { promise: Promise<PdfDoc> };
    GlobalWorkerOptions: { workerSrc: string };
    OPS: Record<string, number>;
  };
  if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    try {
      const require = createRequire(import.meta.url);
      const p = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');
      pdfjs.GlobalWorkerOptions.workerSrc = /^[a-zA-Z]:[\\/]|^\\|^[\\/]/.test(p)
        ? pathToFileURL(p).href
        : p;
    } catch {
      pdfjs.GlobalWorkerOptions.workerSrc = 'pdfjs-dist/legacy/build/pdf.worker.mjs';
    }
  }
  return pdfjs;
}

// ─────────────────────────── 抽取一页的位图 ───────────────────────────

const MAX_IMAGES_PER_PAGE = 20;
const MAX_IMAGE_PIXELS = 40_000_000; // 单张超过 4000 万像素就不导图了，免得内存爆掉

/** DCTDecode 的图本身就是 JPEG 字节，不用再编码一遍 */
function isJpegBytes(d: Uint8Array): boolean {
  return d.length > 3 && d[0] === 0xff && d[1] === 0xd8 && d[d.length - 2] === 0xff && d[d.length - 1] === 0xd9;
}

function toRgb(data: Uint8Array, pixels: number): Uint8Array | null {
  const ch = data.length / pixels;
  if (Math.abs(ch - 3) < 0.02) return data;
  if (Math.abs(ch - 4) < 0.02) {
    // 有 alpha 时按白底合成，否则半透明区域会变成黑块
    const out = new Uint8Array(pixels * 3);
    for (let i = 0, o = 0; i < pixels; i++, o += 3) {
      const a = data[i * 4 + 3] / 255;
      out[o] = Math.round(data[i * 4] * a + 255 * (1 - a));
      out[o + 1] = Math.round(data[i * 4 + 1] * a + 255 * (1 - a));
      out[o + 2] = Math.round(data[i * 4 + 2] * a + 255 * (1 - a));
    }
    return out;
  }
  if (Math.abs(ch - 1) < 0.02) {
    const out = new Uint8Array(pixels * 3);
    for (let i = 0, o = 0; i < pixels; i++, o += 3) {
      out[o] = out[o + 1] = out[o + 2] = data[i];
    }
    return out;
  }
  return null;
}

async function readPageImages(
  pdfjs: { OPS: Record<string, number> },
  page: PdfPage,
  pageNo: number,
  stem: string,
): Promise<PdfImage[]> {
  const out: PdfImage[] = [];
  if (!page.objs) return out;

  let ops: { fnArray: number[]; argsArray: unknown[][] };
  try {
    ops = await page.getOperatorList();
  } catch {
    return out;
  }

  const imgOps = new Set<number>(
    [pdfjs.OPS.paintImageXObject, pdfjs.OPS.paintJpegXObject, pdfjs.OPS.paintInlineImageXObject].filter(
      (x): x is number => typeof x === 'number',
    ),
  );

  let seq = 0;
  for (let i = 0; i < ops.fnArray.length; i++) {
    if (!imgOps.has(ops.fnArray[i])) continue;
    if (out.length >= MAX_IMAGES_PER_PAGE) break;
    const name = ops.argsArray[i]?.[0];
    if (typeof name !== 'string') continue;

    const obj = (await new Promise<{
      width?: number;
      height?: number;
      data?: Uint8Array;
    } | null>((res) => {
      let done = false;
      const timer = setTimeout(() => {
        if (!done) {
          done = true;
          res(null);
        }
      }, 10_000);
      try {
        page.objs!.get(name, (o) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          res(o as { width?: number; height?: number; data?: Uint8Array } | null);
        });
      } catch {
        clearTimeout(timer);
        if (!done) {
          done = true;
          res(null);
        }
      }
    })) as { width?: number; height?: number; data?: Uint8Array } | null;

    const data = obj?.data;
    const w = obj?.width ?? 0;
    const h = obj?.height ?? 0;
    if (!data || !w || !h) continue;
    if (w * h > MAX_IMAGE_PIXELS) continue;

    // 太小的多半是装饰线条、图标，导出来只会污染笔记
    if (w < 48 || h < 48) continue;

    seq++;
    const pn = String(pageNo).padStart(4, '0');
    if (isJpegBytes(data)) {
      out.push({
        file: `${stem}-p${pn}-${seq}.jpg`,
        data: Buffer.from(data),
        width: w,
        height: h,
        page: pageNo,
      });
      continue;
    }
    const rgb = toRgb(data, w * h);
    if (!rgb) continue;
    out.push({
      file: `${stem}-p${pn}-${seq}.png`,
      data: encodePng(rgb, w, h),
      width: w,
      height: h,
      page: pageNo,
    });
  }
  return out;
}

// ─────────────────────────── 一页文本 → 行 ───────────────────────────

interface RawWord {
  str: string;
  x: number;
  y: number;
  w: number;
  size: number;
  font: string;
}

function groupIntoLines(items: TextItem[], pageHeight: number): RawWord[][] {
  const words: RawWord[] = [];
  for (const it of items) {
    const s = it.str ?? '';
    if (!s.trim()) continue;
    const tr = it.transform;
    if (!tr || tr.length < 6) continue;
    // pdfjs 的 y 轴原点在页面底部，翻成「从上到下」
    const y = pageHeight - tr[5];
    // 字号 = 变换矩阵的垂直缩放；旋转文本用 hypot 才准
    const size = Math.hypot(tr[2], tr[3]);
    words.push({
      str: s,
      x: tr[4],
      y,
      w: it.width ?? s.length * 6,
      size,
      font: String(it.fontName ?? ''),
    });
  }
  if (words.length === 0) return [];

  words.sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: RawWord[][] = [];
  let cur: RawWord[] = [words[0]];
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    const ref = cur[cur.length - 1];
    // 容差取「半个字号」：字号越大，同一行内 y 的抖动也越大
    const tol = Math.max(2, ref.size * 0.5);
    if (Math.abs(w.y - ref.y) <= tol) cur.push(w);
    else {
      lines.push(cur);
      cur = [w];
    }
  }
  lines.push(cur);
  return lines.map((l) => l.sort((a, b) => a.x - b.x));
}

function lineToString(line: RawWord[]): string {
  let out = '';
  for (let i = 0; i < line.length; i++) {
    const w = line[i];
    if (i > 0) {
      const prev = line[i - 1];
      const gap = w.x - (prev.x + prev.w);
      if (gap > prev.size * 0.25 && !/\s$/.test(out) && !/^\s/.test(w.str)) out += ' ';
    }
    out += w.str;
  }
  return out.replace(/\s+/g, ' ').trim();
}

function toLines(rawLines: RawWord[][], pageHeight: number): Line[] {
  const out: Line[] = [];
  for (const raw of rawLines) {
    const text = lineToString(raw);
    if (!text) continue;
    const size = Math.max(...raw.map((w) => w.size));
    const y = Math.min(...raw.map((w) => w.y));
    // 主导字体：行内字符数最多的那个（一行里可能混了强调字重）
    const byFont = new Map<string, number>();
    for (const w of raw) byFont.set(w.font, (byFont.get(w.font) ?? 0) + w.str.length);
    let font = '';
    let bestN = -1;
    for (const [f, n] of byFont) {
      if (n > bestN) {
        bestN = n;
        font = f;
      }
    }
    out.push({
      text,
      x0: raw[0].x,
      x1: Math.max(...raw.map((w) => w.x + w.w)),
      y,
      yRatio: pageHeight ? y / pageHeight : 0,
      size,
      font,
    });
  }
  return out;
}

// ─────────────────────────── 文本特征判定 ───────────────────────────

/** 目录里的点线引导符：「. . . . 3」或「...... 3」 */
const TOC_LINE = /(?:\.\s+){5,}|\.{6,}\s*[\d]+\s*$|(?:·\s+){5,}/;
/** 图注 / 表注 */
const CAPTION = /^(?:图|表|图表|Figure|Table)\s*[\d]+[-.．:：]?[\d.\-]*\s/;
/** 页眉页脚里的纯页码：阿拉伯数字、罗马数字、"第 3 页" */
const PAGE_NUMBER = /^(?:第?\s*\d{1,4}\s*页?|[ivxlcIVXLC]{1,7}|[—–\-~～]\s*\d{1,4}\s*[—–\-~～])$/;
/** 上标脚注符号：正文里孤零零一个字母或星号 */
const FOOTNOTE_MARK = /^[a-zA-Z*†‡§¶]$/;
/** CJK 字符（含中日韩与全角标点） */
const CJK = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/;
/** 列表项开头：「1. 」「2、」「- 」「• 」「(a) 」 */
const LIST_START = /^(?:\d{1,3}[.、)]|[-•·*+]|\([a-zA-Z0-9]{1,3}\))\s+/;
/** 软换行续行符：书里代码/长句折行时会用这种箭头标记 */
const CONTINUATION = /^[↪⤷⟶➥]\s*/;
/** 一眼就是代码的开头 */
const CODE_START =
  /^(?:def |class |import |from |return |if |elif |else:|for |while |try:|except|finally:|with |async |await |function |const |let |var |public |private |static |#include|#!|\/\/|\/\*|\s{2,}\S)/;

/**
 * 这一句说完了吗。
 * ★ 注意 ★ 不能把 `)` `"` `'` 算成句末——代码里 `foo()`、`"x"` 满地都是，
 *   一算进去每个代码行都会被当成一段。先剥掉尾部的引号括号再看真正的标点。
 */
function endsSentence(s: string): boolean {
  const core = s.replace(/[\s"'”’）)》」』\]]+$/g, '');
  if (!core) return false;
  if (/[。！？；…]/.test(core.slice(-1))) return true;
  return /[.!?]$/.test(core);
}

/** 一组页码里最长的连续段：页眉页脚会连着好几页出现 */
function longestRun(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  let best = 1;
  let cur = 1;
  for (let i = 1; i < s.length; i++) {
    if (s[i] === s[i - 1] + 1) {
      cur++;
      if (cur > best) best = cur;
    } else {
      cur = 1;
    }
  }
  return best;
}

/** 把「折行的下一行」并回上一行，否则代码和长句会被切成碎片 */
function mergeContinuations(lines: Line[]): Line[] {
  const out: Line[] = [];
  for (const l of lines) {
    if (CONTINUATION.test(l.text) && out.length) {
      const prev = out[out.length - 1];
      out[out.length - 1] = {
        ...prev,
        text: prev.text + l.text.replace(CONTINUATION, ''),
      };
      continue;
    }
    out.push(l);
  }
  return out;
}

/**
 * 这一行像代码吗。两条路：
 *   1. 字体等宽（最可靠，由调用方按全本统计得出）；
 *   2. 内容像——符号密度高、且不以中文为主，或干脆以代码关键字开头。
 */
function looksLikeCode(text: string): boolean {
  const n = text.length;
  if (n === 0) return false;
  // 注释行：中文注释（# 计算总价）符号密度低、中文占比高，靠密度判不出来，
  // 但「以 # 或 // 开头且不是一句完整的话」几乎只可能是注释。
  // 注意 `#"退款政策…"`、`#→"答案…"` 这种紧贴着内容的写法也要算，不能要求 # 后面有空格。
  if (/^(?:#|\/\/)(?=\S|\s\S)/.test(text) && !endsSentence(text)) return true;
  let sym = 0;
  let cjk = 0;
  for (const ch of text) {
    if (CJK.test(ch)) cjk++;
    else if (/[{}()[\];=<>|&*+/\\"'#!~?:,$@%^`_]/.test(ch)) sym++;
  }
  const cjkRatio = cjk / n;
  const symRatio = sym / n;
  if (cjkRatio > 0.5) return false; // 中文为主，基本是正文
  if (symRatio >= 0.18 && cjkRatio < 0.15) return true;
  if (symRatio >= 0.3) return true; // 带中文注释的代码
  return CODE_START.test(text);
}

/**
 * 字号够大也不一定是标题。书里的对白示例、审阅批注、合并页眉都会被字号规则
 * 误判成标题，这里补几条窄规则挡掉——判据都是「标题不会长这样」，不会误伤真标题。
 */
function implausibleHeading(text: string): boolean {
  if (/[→←]/.test(text)) return true; // 流程/对白示例，例如 `→ " 您可以…"`
  if (/^["“'‘]/.test(text)) return true; // 以引号开头：多半是引用的一段话
  if (/…|\.\.\.$/.test(text)) return true; // 省略号收尾：被截断的引用
  if (/\bP\d{1,3}\b/.test(text)) return true; // 审阅批注里的页码标记（「核心思想 P7 字体过小」）
  if (text.includes('页码')) return true; // 表头行（「问题 页码 严重度」），不是标题
  // 一行里出现两个章号（「第 6 章 … · 第 7 章 …」「第七章的评估 第八章的训练」）是页眉或批注
  if (/第\s*[0-9一二三四五六七八九十百]+\s*章.{0,16}第\s*[0-9一二三四五六七八九十百]+\s*章/.test(text)) return true;
  return false;
}

/**
 * 正文里以 # 开头的行（代码注释漏出来了、「C# 入门」这类）会被 Markdown 当成标题。
 * 转义第一个 #，渲染出来还是 # 本身。
 */
function escapeLeadingHash(s: string): string {
  return s.startsWith('#') ? `\\${s}` : s;
}

/**
 * 代码块中间允许夹一行「不像代码」的行（中文注释），但要卡严一点，
 * 否则整句中文正文会被卷进围栏里。
 */
function isGapCandidate(l: Line): boolean {
  const t = l.text.trim();
  if (!t) return true;
  if (t.includes('。')) return false; // 有完整中文句子 = 正文，不是代码
  if (/^(?:#|\/\/)/.test(t)) return true; // 注释
  return t.length <= 50 && !endsSentence(t);
}

/**
 * 判断哪些字体是等宽的：等宽字体每个字符步进相同，
 * 所以「宽度/字数」归一化后几乎不随内容变化（cv≈0）；比例字体会明显波动。
 */
function findMonospaceFonts(stats: Map<string, number[]>): Set<string> {
  const mono = new Set<string>();
  for (const [font, ws] of stats) {
    if (ws.length < 8) continue;
    const mean = ws.reduce((a, b) => a + b, 0) / ws.length;
    const sd = Math.sqrt(ws.reduce((a, b) => a + (b - mean) ** 2, 0) / ws.length);
    if (mean > 0 && sd / mean < 0.03) mono.add(font);
  }
  return mono;
}

function normalizeForCompare(s: string): string {
  return s.replace(/\s+/g, '').replace(/[0-9]+/g, '#');
}

function modeOf(values: number[], round: number): number {
  const m = new Map<number, number>();
  for (const v of values) {
    const k = Math.round(v / round) * round;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  let best = 0;
  let bestN = -1;
  for (const [k, n] of m) {
    if (n > bestN) {
      bestN = n;
      best = k;
    }
  }
  return best;
}

/** 把两行拼成一句：中日韩**之间**不加空格，中英/西文之间加，hyphen 断词直接连起来 */
function joinLines(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  if (/[-‐-―]$/.test(a)) return a.slice(0, -1) + b;
  const tail = a[a.length - 1];
  const head = b[0];
  // 两边都是中日韩才直接相连；一边是西文时要留空格，否则会粘出「token的中间」
  if (CJK.test(tail) && CJK.test(head)) return a + b;
  return `${a} ${b}`;
}

// ─────────────────────────── 主流程 ───────────────────────────

export interface ExtractOptions {
  /** 只要这几页（1-based）。不传表示全部。 */
  pages?: number[];
  /** 用于生成图片文件名的词干 */
  stem?: string;
}

export async function extractPdfToMarkdown(
  data: Uint8Array,
  options: ExtractOptions = {},
): Promise<PdfExtractResult> {
  const pdfjs = await loadPdfjs();

  const warnings: string[] = [];
  const doc = await pdfjs.getDocument({
    data,
    verbosity: 0,
    isEvalSupported: false,
    useSystemFonts: false,
  }).promise;

  const wanted = options.pages && options.pages.length
    ? options.pages.filter((p) => p >= 1 && p <= doc.numPages)
    : Array.from({ length: doc.numPages }, (_, i) => i + 1);

  const stem = (options.stem || 'pdf').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);

  // ── 第一遍：把所有页的行和图片都读出来 ──
  const pages: PageData[] = [];
  const fontWidths = new Map<string, number[]>();
  for (const p of wanted) {
    const page = await doc.getPage(p);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();

    // 采字体宽度样本，用来找等宽字体（代码）
    for (const it of content.items) {
      const s = it.str ?? '';
      if (s.trim().length < 4 || !/^[\x20-\x7e]+$/.test(s)) continue; // 只取纯 ASCII 片段
      const tr = it.transform;
      if (!tr || tr.length < 6) continue;
      const size = Math.hypot(tr[2], tr[3]);
      const aw = (it.width ?? 0) / s.length / size;
      if (!(aw > 0.05 && aw < 3)) continue;
      const f = String(it.fontName ?? '');
      if (!f) continue;
      const arr = fontWidths.get(f) ?? [];
      if (arr.length < 400) arr.push(aw);
      fontWidths.set(f, arr);
    }

    const lines = toLines(groupIntoLines(content.items, viewport.height), viewport.height);
    const images = await readPageImages(pdfjs, page, p, stem);
    pages.push({ page: p, height: viewport.height, lines, images });
    if (lines.length === 0) warnings.push(`第 ${p} 页没有抽出任何文字，可能是扫描件或纯图片页`);
  }
  await doc.destroy().catch(() => undefined);

  const monoFonts = findMonospaceFonts(fontWidths);

  // ── 第二遍之前：先统计全本特征 ──
  const allLines = pages.flatMap((pg) => pg.lines);

  // 1) 正文基准字号：按字符数加权取众数（正文的字最多）
  const sizeWeight = new Map<number, number>();
  for (const l of allLines) {
    const k = Math.round(l.size * 2) / 2;
    sizeWeight.set(k, (sizeWeight.get(k) ?? 0) + l.text.length);
  }
  let bodySize = 0;
  let bestW = -1;
  for (const [k, w] of sizeWeight) {
    if (w > bestW) {
      bestW = w;
      bodySize = k;
    }
  }

  // 2) 字号 → 标题级别：只收「比正文大、且总量不多」的字号，从大到小排 h1/h2/…
  const headingSizes = [...sizeWeight.entries()]
    .filter(([s, w]) => s >= bodySize + 0.7 && w < bestW * 0.25)
    .map(([s]) => s)
    .sort((a, b) => b - a)
    .slice(0, 4);
  const sizeToLevel = new Map<number, number>();
  headingSizes.forEach((s, i) => sizeToLevel.set(s, i + 1));

  // 3) 正文左边界：判断「缩进另起一段」
  const bodyX0 = modeOf(allLines.filter((l) => !sizeToLevel.has(Math.round(l.size * 2) / 2)).map((l) => l.x0), 2);

  // 4) 页眉页脚：跨页重复、且贴在页顶/页底的行
  // 页眉页脚的判据是「连着好几页都出现在页顶/页底」，不是「总共出现过多少次」。
  // 用次数会漏掉这种情况：书里页眉印的是**当前节标题**，一节只有七八页，
  // 占全书 310 页的 2%，但它确实是页眉。反过来正文里偶尔重复的句子不会连着出现。
  const freq = new Map<string, number[]>();
  for (const pg of pages) {
    const seen = new Set<string>();
    for (const l of pg.lines) {
      if (l.yRatio > 0.12 && l.yRatio < 0.88) continue;
      const key = normalizeForCompare(l.text);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const arr = freq.get(key) ?? [];
      arr.push(pg.page);
      freq.set(key, arr);
    }
  }

  const isHeaderFooter = (l: Line): boolean => {
    if (l.yRatio > 0.12 && l.yRatio < 0.88) return false;
    // ★ 标题字号的行一律不删 ★ 页眉常常就是当前节的标题，
    // 但正文里那个真正的标题必须留下（两者字号通常不同，页眉用的是正文字号）
    if (sizeToLevel.has(Math.round(l.size * 2) / 2)) return false;
    if (PAGE_NUMBER.test(l.text.trim())) return true;
    const seen = freq.get(normalizeForCompare(l.text));
    return Boolean(seen && longestRun(seen) >= 3);
  };

  // ── 第三遍：组装 Markdown ──
  const out: string[] = [];
  const images: PdfImage[] = [];
  let captionCount = 0;
  let tocPages = 0;
  let para = '';
  /** 标题文字 → 上次输出时的行号，用来压制页眉里重复的节标题 */
  const headingSeenAt = new Map<string, number>();

  const flushPara = () => {
    // 正文行以 # 开头（漏出围栏的代码注释、C# 之类）会被 Markdown 当成标题，转义掉
    if (para.trim()) out.push(escapeLeadingHash(para.trim()));
    para = '';
  };
  const blank = () => {
    if (out.length && out[out.length - 1] !== '') out.push('');
  };

  for (const pg of pages) {
    const kept = pg.lines.filter((l) => !isHeaderFooter(l));
    const lines = mergeContinuations(kept);

    // 目录页：点线行占比过半就整页跳过
    const tocHits = lines.filter((l) => TOC_LINE.test(l.text)).length;
    if (lines.length >= 5 && tocHits / lines.length > 0.35) {
      tocPages++;
      continue;
    }

    // 代码块：连续 ≥3 行像代码就整体加围栏，逐行照抄（不能按段落去折）
    const codeFlags = lines.map(
      (l) => (l.font !== '' && monoFonts.has(l.font)) || looksLikeCode(l.text),
    );

    let i = 0;
    while (i < lines.length) {
      if (codeFlags[i]) {
        // 向右扩展，中间允许夹 1 行「不像代码」的行：
        // 中文注释（# 计算总价）符号密度低，常被判成正文，但它们属于这段代码
        let last = i;
        let j = i;
        let gap = 0;
        while (j < lines.length) {
          if (codeFlags[j]) {
            last = j;
            gap = 0;
            j++;
          } else if (gap < 1 && isGapCandidate(lines[j])) {
            gap++;
            j++;
          } else {
            break;
          }
        }
        let codeCount = 0;
        for (let k = i; k <= last; k++) if (codeFlags[k]) codeCount++;
        if (codeCount >= 3 && last - i < 200) {
          flushPara();
          blank();
          out.push('```');
          for (let k = i; k <= last; k++) out.push(lines[k].text);
          out.push('```');
          out.push('');
          i = last + 1;
          continue;
        }
      }

      const idx = i;
      i++;
      const l = lines[idx];
      const text = l.text.trim();
      if (!text) continue;
      if (TOC_LINE.test(text)) continue; // 混在正文里的个别目录行
      if (FOOTNOTE_MARK.test(text)) continue; // 上标脚注标记

      const sizeKey = Math.round(l.size * 2) / 2;
      const fontLevel = sizeToLevel.get(sizeKey) ?? 0;

      // 图注 / 表注：不是标题，输出成引用块
      if (CAPTION.test(text) && text.length <= 60) {
        flushPara();
        blank();
        out.push(`> ${text}`);
        out.push('');
        captionCount++;
        continue;
      }

      // 编号 → 级别：「第 3 章」h1、「2.1」h2、「2.1.3」h3
      let numLevel = 0;
      if (/^第\s*[0-9一二三四五六七八九十百]+\s*[章节篇]/.test(text)) numLevel = 1;
      else if (/^\d+\.\d+\.\d+/.test(text)) numLevel = 3;
      else if (/^\d+\.\d+(?!\d)/.test(text)) numLevel = 2;

      const prevLine = idx > 0 ? lines[idx - 1] : null;
      const prevIsBreak = !prevLine || !para || endsSentence(prevLine.text.trim());

      let level = 0;
      if (fontLevel > 0) {
        level = numLevel > 0 ? Math.max(numLevel, 1) : fontLevel;
      } else if (numLevel > 0 && text.length <= 40 && prevIsBreak && !endsSentence(text)) {
        // 字号没标出来，但编号 + 短行 + 单独成段，多半还是个小标题
        level = numLevel;
      }

      if (level > 0 && implausibleHeading(text)) level = 0;

      if (level > 0) {
        flushPara();
        blank();
        // 书里偶尔把同一标题连着印两次（页末 + 页首）。只跟「紧邻的上一个块」比，
        // 不能用变量记住上一个标题——否则每章都有的「本章小结」会被误删。
        const line = `${'#'.repeat(Math.min(level, 6))} ${text}`;
        // 去重的两道保险：
        //  1. 紧邻的上一个块就是它 —— 书里把标题连着印了两次；
        //  2. 很短的距离内出现过同名的 —— 那是页眉（页眉有时用的就是标题字号，
        //     前面按字号豁免的那条规则会放过它，只能在这里拦下来）。
        // 不能用「出现过就删」，否则每章都有的「本章小结」会被误杀。
        const last = headingSeenAt.get(text);
        const tooClose = last !== undefined && out.length - last <= 40;
        if (out.length >= 2 && out[out.length - 2] === line) {
          // 完全重复，什么都不做
        } else if (!tooClose) {
          out.push(line);
          out.push('');
        }
        headingSeenAt.set(text, out.length);
        continue;
      }

      // 正文：缩进明显、上一句已结束、或这是一条列表项 → 另起一段
      const indented = l.x0 > bodyX0 + Math.max(4, l.size * 0.8);
      const listStart = LIST_START.test(text);
      if (para && (indented || listStart || endsSentence(para))) {
        flushPara();
        out.push('');
      }
      para = para ? joinLines(para, text) : text;
    }

    // 本页导出的位图，插在本页正文之后
    if (pg.images.length) {
      flushPara();
      blank();
      for (const img of pg.images) {
        out.push(`![${img.file.replace(/\.[a-z]+$/i, '')}](assets/${encodeURIComponent(img.file)})`);
        out.push('');
        images.push(img);
      }
    }
  }
  flushPara();

  const markdown =
    out
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim() + '\n';

  // PDF 里中英之间常常没有空格（"LLM +上下文"），复用排版服务的规则补一下。
  // 只开这一条：层级、段落、代码围栏都是刚排好的，不能再让别的规则动它。
  // （formatText 会保护 ``` 围栏，代码里的内容不会被加空格）
  const spaced = formatText(markdown, {
    spaceBetweenCJKAndLatin: true,
    detectHeadings: false,
    joinHardWrappedLines: false,
    stripPageNoise: false,
  }).markdown;

  const pageLines = pages.map((p) => p.lines.length);

  if (spaced.replace(/\s/g, '').length < 20 && doc.numPages > 0) {
    warnings.push('整份 PDF 几乎没抽出文字。如果它是扫描件，需要先做 OCR，本工具不包含 OCR。');
  }
  if (tocPages > 0) {
    warnings.push(`跳过了 ${tocPages} 页目录（目录对阅读没有帮助，还会淹没有效内容）`);
  }
  if (captionCount > 0) {
    const got = new Set(images.map((i) => i.page));
    const missed = captionCount - got.size;
    warnings.push(
      `检测到 ${captionCount} 处图/表题注，导出位图 ${images.length} 张` +
        (missed > 0
          ? `；其余插图是矢量绘制的，Node 端没有画布无法栅格化，正文里只保留了图注`
          : ''),
    );
  }

  return { markdown: spaced, pageCount: doc.numPages, warnings, pageLines, images, captionCount, tocPages };
}
