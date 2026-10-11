/**
 * server/services/imageSize.ts —— 只为了一个目的：拿到图片的**真实像素尺寸**。
 *
 * ★ 为什么要这个 ★
 *   一篇从飞书导出的文档可以带几百张图。HTML 里虽然写了 `loading="lazy"`，
 *   但只要 `<img>` 没有 width/height，浏览器在图片下载前就不知道它有多高，
 *   于是几百张高度为零的图全挤在视口顶部——**全部落进 lazy 的加载阈值里**，
 *   结果就是一次性把整个目录下载下来（实测一篇 769 张图 = 177MB）。
 *   属性写了等于没写。
 *
 *   补上 width/height 之后，浏览器能算出每张图大致落在第几屏，
 *   lazy 才真的开始工作：只下载滚得到的那几张。
 *   顺带消掉了「图一张张加载时页面往下跳」的问题。
 *
 * ★ 为什么手写解析而不是装个 image-size ★
 *   这个项目刻意保持零依赖。而且我们要的只是宽高，
 *   读文件头几十个字节就够了——不需要把整张 5MB 的图读进内存。
 *
 * ★ 为什么必须先预热 ★
 *   renderDocument 是同步的，而把图片引用解析成绝对路径的 resolveInVault 是
 *   异步的（内部要 realpath），同步侧调不了。所以流程是：
 *   粗扫 markdown 里的引用 → 异步批量探测填缓存 → 再渲染，渲染时同步查表。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { resolveInVault } from '../security';

export interface ImageSize {
  width: number;
  height: number;
}

/** 读文件头多大。JPEG 的 SOF 段偶尔靠后（缩略图之后），64KB 足够覆盖。 */
const HEAD_BYTES = 64 * 1024;

/**
 * 尺寸缓存，key 是 `文档路径 \u0000 图片引用`。
 *
 * ★ 为什么用「引用」而不是「绝对路径」当 key ★
 *   渲染时是同步查表，而解析绝对路径要异步 realpath，同步侧拿不到。
 *   用引用当 key，查表退化成纯字符串匹配，也省掉每次渲染都 stat 一遍。
 *
 * ★ 为什么不做 mtime 失效 ★
 *   换掉一张图而尺寸不变的几率很低，每次查表都 stat 一遍的成本却是实打实的。
 *   真换了图，重启服务就恢复——缓存只活在进程内存里。
 */
const cache = new Map<string, ImageSize | null>();
/** 上限，防着笔记库越滚越大把内存吃满。超了整表清空（简单胜过 LRU）。 */
const MAX_ENTRIES = 20000;

/**
 * 解码一次；解不动（百分号写得不对，比如 "100%.png"）就原样返回。
 */
function safeDecode(ref: string): string {
  try {
    return decodeURIComponent(ref);
  } catch {
    return ref;
  }
}

/**
 * ★ key 必须先解码再拼接 ★
 * 查表有两种来源，拿到的字符串不是一个形态：
 *   - 预热侧（collectImageRefs）：markdown 原文，如 `assets/截图 1.png`
 *   - 渲染侧（token 的 src）：被 markdown-it 的 normalizeLink 编码过，
 *     如 `assets/%E6%88%AA%E5%9B%BE%201.png`
 * 不统一解码的话，凡是路径里有空格或非 ASCII 字符的图，尺寸表会整片落空。
 */
function keyOf(docRel: string, ref: string): string {
  return `${docRel}\u0000${safeDecode(ref).replace(/\\/g, '/')}`;
}

function remember(k: string, size: ImageSize | null): void {
  if (cache.size >= MAX_ENTRIES) cache.clear();
  cache.set(k, size);
}

// ───────────────────────── 各格式的头解析 ─────────────────────────

/** PNG：8 字节签名，紧接着的 IHDR 里第 16~24 字节是宽、高（大端）。 */
function pngSize(b: Buffer): ImageSize | null {
  if (b.length < 24) return null;
  if (b.readUInt32BE(0) !== 0x89504e47 || b.readUInt32BE(4) !== 0x0d0a1a0a) return null;
  const w = b.readUInt32BE(16);
  const h = b.readUInt32BE(20);
  return w > 0 && h > 0 ? { width: w, height: h } : null;
}

/** GIF：前 6 字节是 "GIF87a"/"GIF89a"，接着两个小端 16 位分别是宽、高。 */
function gifSize(b: Buffer): ImageSize | null {
  if (b.length < 10) return null;
  const sig = b.toString('ascii', 0, 6);
  if (sig !== 'GIF87a' && sig !== 'GIF89a') return null;
  const w = b.readUInt16LE(6);
  const h = b.readUInt16LE(8);
  return w > 0 && h > 0 ? { width: w, height: h } : null;
}

/** BMP：'BM' 开头，offset 18/22 是宽高（小端 32 位，高度可能为负表示上下翻转）。 */
function bmpSize(b: Buffer): ImageSize | null {
  if (b.length < 26) return null;
  if (b.toString('ascii', 0, 2) !== 'BM') return null;
  const w = b.readInt32LE(18);
  const h = b.readInt32LE(22);
  return w > 0 && h !== 0 ? { width: w, height: Math.abs(h) } : null;
}

/**
 * JPEG：一串 marker，要找到 SOF（帧开始）段才有尺寸。
 * 0xFFD8 是开头，之后每段是 0xFF + 标记 + 长度(2 字节)，按长度跳着走。
 */
function jpegSize(b: Buffer): ImageSize | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i++; // 不是 marker 开头，跳过填充字节
      continue;
    }
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      i++;
      continue;
    }
    // 独立标记：没有长度字段，直接跳过
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = b.readUInt16BE(i + 2);
    if (len < 2) return null;
    // SOFn 是 0xC0~0xCF，但要排除 DHT(C4) / JPG(C8) / DAC(CC)
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      const h = b.readUInt16BE(i + 5);
      const w = b.readUInt16BE(i + 7);
      return w > 0 && h > 0 ? { width: w, height: h } : null;
    }
    i += 2 + len;
  }
  return null;
}

/**
 * WEBP：RIFF 容器，第 12~16 字节的子类型决定怎么读。
 *   VP8（有损）：宽高各 14 位
 *   VP8X（扩展）：canvas 宽高各 24 位，存的是「减一」
 *   VP8L（无损）：位域编码，这里不啃，宁可没尺寸也不要算错
 */
function webpSize(b: Buffer): ImageSize | null {
  if (b.length < 30) return null;
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WEBP') return null;
  const fmt = b.toString('ascii', 12, 16);
  if (fmt === 'VP8 ') {
    const w = b.readUInt16LE(26) & 0x3fff;
    const h = b.readUInt16LE(28) & 0x3fff;
    return w > 0 && h > 0 ? { width: w, height: h } : null;
  }
  if (fmt === 'VP8X') {
    const w = (b.readUIntLE(24, 3) & 0xffffff) + 1;
    const h = (b.readUIntLE(27, 3) & 0xffffff) + 1;
    return w > 1 && h > 1 ? { width: w, height: h } : null;
  }
  return null;
}

/**
 * ★ 按**文件头**嗅探格式，绝不按扩展名 ★
 *
 * 飞书 / 微信导出的素材里，扩展名说谎是常态：实测这篇文档 832 张图里，
 * 有 282 张名字叫 `.png`、实际是 JPEG（`FFD8FFE0` + JFIF）。按扩展名分派
 * 解析器，这 282 张会全部探测失败、退回「没有尺寸」，优化等于白做一半。
 *
 * 每种格式的签名都独一无二，顺序无所谓，认出来就交给对应解析器。
 */
function sniffSize(head: Buffer): ImageSize | null {
  if (head.length < 12) return null;

  // PNG：89 50 4E 47 0D 0A 1A 0A
  if (head.length >= 24 && head.readUInt32BE(0) === 0x89504e47 && head.readUInt32BE(4) === 0x0d0a1a0a) {
    return pngSize(head);
  }
  // GIF87a / GIF89a
  const gif = head.toString('ascii', 0, 6);
  if (head.length >= 10 && (gif === 'GIF87a' || gif === 'GIF89a')) return gifSize(head);
  // RIFF ____ WEBP
  if (
    head.length >= 30 &&
    head.toString('ascii', 0, 4) === 'RIFF' &&
    head.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return webpSize(head);
  }
  // JPEG：FF D8 FF
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return jpegSize(head);
  // BMP：'BM'
  if (head.toString('ascii', 0, 2) === 'BM') return bmpSize(head);

  // SVG 是文本没有固有尺寸，AVIF 的盒子结构太碎，都不猜 —— 返回 null 只是不写宽高，不犯错
  return null;
}

/** 只读开头一小段，不整个读进内存——一张 5MB 的图只需要前 64KB。 */
async function readHead(abs: string): Promise<Buffer> {
  const fh = await fsp.open(abs, 'r');
  try {
    const st = await fh.stat();
    const want = Math.min(HEAD_BYTES, st.size);
    const buf = Buffer.alloc(want);
    await fh.read(buf, 0, want, 0);
    return buf;
  } finally {
    await fh.close();
  }
}

// ───────────────────────── 对外接口 ─────────────────────────

/**
 * 把「文档 + 图片引用」解析成绝对路径，规则和 routes/asset.ts 保持一致：
 * 先按文档所在目录找，找不到再按库根找。
 */
async function resolveImageAbs(docRel: string, ref: string): Promise<string | null> {
  const raw = ref.replace(/\\/g, '/');
  const docDir = docRel.includes('/') ? docRel.slice(0, docRel.lastIndexOf('/')) : '';
  const candidates = docDir ? [`${docDir}/${raw}`, raw] : [raw];
  for (const c of candidates) {
    try {
      const abs = await resolveInVault(normalize(c));
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;
    } catch {
      // 路径不合法（越界等）就换下一个候选
    }
  }
  return null;
}

/** 去掉开头的 ./ 和 /，压掉多余分隔符（越界由 resolveInVault 兜底）。 */
function normalize(rel: string): string {
  return rel
    .replace(/\\/g, '/')
    .split('/')
    .filter((p) => p && p !== '.')
    .join('/');
}

/**
 * 预热：把这篇文档里所有图片的尺寸提前探测好。
 *
 * 限了并发度——一篇 800 张图的文档如果一口气发 800 个 open，在机械盘上会抖。
 * 16 个一批足够快也足够温和。
 */
export async function warmImageSizes(docRel: string, refs: string[]): Promise<void> {
  const BATCH = 16;
  for (let i = 0; i < refs.length; i += BATCH) {
    await Promise.all(
      refs.slice(i, i + BATCH).map(async (ref) => {
        const k = keyOf(docRel, ref);
        if (cache.has(k)) return; // 这篇文档上次打开时已经探过
        try {
          const abs = await resolveImageAbs(docRel, ref);
          if (!abs) {
            remember(k, null);
            return;
          }
          remember(k, sniffSize(await readHead(abs)));
        } catch {
          // 单张图探测失败无所谓的：最坏就是不写尺寸，退回原来的行为
          remember(k, null);
        }
      }),
    );
  }
}

/**
 * 渲染时同步查表用。
 * 预热过就一定命中；没命中（比如引用是代码块里的示例文本）就返回 null，
 * 不写 width/height——宁可少一个优化，也不能为了猜尺寸把渲染卡住。
 */
export function makeImageSizer(docRel: string): (ref: string) => ImageSize | null {
  return (ref: string) => cache.get(keyOf(docRel, ref)) ?? null;
}

/**
 * 粗扫 markdown 里的图片引用，用来预热。
 *
 * 故意不精确：宁可多扫（代码块里的 `![]()` 也会命中），也不要为了精确
 * 去把整篇 markdown parse 一遍——那是一笔更大的开销，而多扫几个不存在的
 * 路径的成本几乎为零（解析不到就是 null，进缓存后下次直接跳过）。
 */
export function collectImageRefs(markdown: string): string[] {
  const out = new Set<string>();
  const re = /!\[[^\]]*\]\(\s*([^)\s]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown))) {
    const src = m[1] ?? '';
    // 远程地址和 data: 不需要本地探测
    if (/^(https?:)?\/\//i.test(src) || /^data:/i.test(src) || src.startsWith('#')) continue;
    out.add(safeDecode(src));
  }
  return [...out];
}
