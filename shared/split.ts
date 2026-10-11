/**
 * shared/split.ts —— 把一篇过长的 Markdown 按标题切成若干篇。
 *
 * ★ 为什么要有这个文件 ★
 *   实测一篇 833 张图 / 8819 个块的飞书导出，浏览器打开时布局要 985ms
 *   （52317 个 DOM 节点）。切成分片后每片约 600 块，布局降到 65ms 量级。
 *   这是唯一不牺牲交互质量的方案：不用 content-visibility，滚动条不跳、
 *   Ctrl+F 行为不变、getClientRects 不返回空。
 *
 * ★ 唯一的正确性红线：纯切片，零注入 ★
 *   每个分片必须是**原文块数组的一个连续区间**，且分片内不得新增任何内容
 *   （不补 H1、不加「上接下续」、不生成索引页）。这样
 *       newBi = oldBi - startBi
 *   成立，TextQuoteSelector 的 blockIndex 直接平移，S1 精确命中，
 *   一条批注都不用重锚。一旦注入新块，块序列错位，只能退化到 S3/S4
 *   靠 quote 猜位置 —— 那是整套方案里唯一会让批注静默损坏的地方。
 *   所以 planSplit() 每一层都会**校验块总数守恒**，不守恒就换一层重来，
 *   全都守恒不了就拒绝拆分（fail closed），绝不带着不确定性落盘。
 *
 * ★ 为什么块数要由调用方注入 ★
 *   本文件在 shared/ 下，不能 import ./blocks —— 后者 import 了 markdown-it，
 *   会把它拖进前端依赖图（见 blocks.ts 文件头的维护红线）。
 *   所以「数一段 markdown 有几个块」由服务端用 analyzeDocument 传进来。
 *
 * ★ 为什么块数守恒能当校验 ★
 *   Block 结构里没有行号（annotateBlocks 只在 token 流里递增 bi），
 *   「第 N 行对应 bi 几」是算不出来的。所以反向验证：
 *   切完逐片重新解析，各片块数之和必须等于原文块数。相等即证明
 *   每一片都是原文的连续切片，且没有任何内容被吞掉或重复。
 */

/** 一个分片。 */
export interface SplitChunk {
  /** 分片里第一个标题的文字；没有标题时为「开篇」。供上层生成文件名。 */
  title: string;
  /** 分片正文（原文的原样切片，未注入任何新内容） */
  text: string;
  /** 该分片在**原文**块数组中的起始下标 */
  startBi: number;
  /** 该分片的块数 */
  blockCount: number;
}

export type SplitReason = 'ok' | 'no_heading' | 'structure_broken' | 'section_too_big';

export interface SplitResult {
  needed: boolean;
  reason: SplitReason;
  /** 实际采用的切分层级（1 = h1，2 = h2 …）；0 表示没切 */
  level: number;
  chunks: SplitChunk[];
}

export interface SplitOptions {
  /** 原文的块总数，用于校验守恒 */
  totalBlocks: number;
  /** 统计一段 markdown 的块数，由服务端注入 */
  countBlocks: (markdown: string) => number;
  /** 单个分片的块数上限，默认 600（≈65ms 布局） */
  maxBlocks?: number;
  /** 参与切分的最粗层级，默认 1（h1） */
  minLevel?: number;
  /** 参与切分的最细层级，默认 3（h3） */
  maxLevel?: number;
}

/** 代码围栏的起止行。支持 ``` 与 ~~~，且闭合行的标记不得短于起始行。 */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
/** ATX 标题行。前置最多 3 个空格，尾部允许任意个 #（闭合式 ATX）。 */
const HEADING_RE = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;

export interface HeadingLine {
  /** 行号（0 起） */
  line: number;
  /** 标题层级，1~6 */
  level: number;
  text: string;
}

/**
 * 扫出所有**不在代码块里**的标题行。
 *
 * 这一步是正确性的关键：这本书有 140 段代码围栏，围栏里出现 `# 注释`
 * 或 `# 标题示例` 是常事。不维护围栏状态的话，切分会切进代码里，
 * 把一个代码块劈成两半 —— 两半各自都解析不出原来的块，批注随之错位。
 */
export function scanHeadings(markdown: string): HeadingLine[] {
  const lines = markdown.split(/\r?\n/);
  const out: HeadingLine[] = [];
  let fence: { marker: string; len: number } | null = null;
  // 开头的 YAML front matter 里 `#` 是注释，不能当标题
  let inFrontMatter = lines.length > 0 && lines[0].trim() === '---';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (inFrontMatter) {
      if (i > 0 && line.trim() === '---') inFrontMatter = false;
      continue;
    }

    const f = line.match(FENCE_RE);
    if (f) {
      const marker = f[1].charAt(0);
      const len = f[1].length;
      if (!fence) fence = { marker, len };
      else if (fence.marker === marker && len >= fence.len) fence = null;
      continue;
    }
    if (fence) continue;

    const h = line.match(HEADING_RE);
    if (h) out.push({ line: i, level: h[1].length, text: h[2] });
  }
  return out;
}

/** 按行号切点把原文切成若干段；空段丢弃。 */
function sliceAt(lines: string[], cuts: number[]): string[] {
  const out: string[] = [];
  let start = 0;
  for (const c of cuts) {
    if (c > start) out.push(lines.slice(start, c).join('\n'));
    start = c;
  }
  if (start < lines.length) out.push(lines.slice(start).join('\n'));
  return out.filter((s) => s.trim().length > 0);
}

/** 取一段文本里第一个标题的文字；没有就返回「开篇」。 */
function firstTitle(text: string): string {
  const h = scanHeadings(text)[0];
  return h ? h.text : '开篇';
}

/**
 * 贪心打包：按顺序累积小节，装不下就切一刀。
 * 返回每个分片包含的小节下标区间。
 */
function greedyPack(counts: number[], maxBlocks: number): number[][] {
  const out: number[][] = [];
  let cur: number[] = [];
  let sum = 0;
  for (let i = 0; i < counts.length; i++) {
    if (cur.length > 0 && sum + counts[i] > maxBlocks) {
      out.push(cur);
      cur = [];
      sum = 0;
    }
    cur.push(i);
    sum += counts[i];
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/**
 * 规划一次拆分。
 *
 * 策略：从最粗的层级（h1）开始试，把该层级的所有小节贪心打包到
 * `maxBlocks` 以内。若某一刀怎么切都还是超阈值（比如单个 h1 小节
 * 本身就超过 600 块），就降级到 h2、h3 再试。
 *
 * 普通文档（几张图、几十个块）会因为「原文没超阈值」而直接返回
 * needed=false，不会被拆分。
 */
export function planSplit(markdown: string, opts: SplitOptions): SplitResult {
  const maxBlocks = opts.maxBlocks ?? 600;
  const minLevel = opts.minLevel ?? 1;
  const maxLevel = opts.maxLevel ?? 3;

  const whole: SplitChunk = {
    title: firstTitle(markdown),
    text: markdown,
    startBi: 0,
    blockCount: opts.totalBlocks,
  };

  // 原文已经不超阈值，没必要切
  if (opts.totalBlocks <= maxBlocks) {
    return { needed: false, reason: 'ok', level: 0, chunks: [whole] };
  }

  const headings = scanHeadings(markdown);
  if (headings.length === 0) {
    return { needed: false, reason: 'no_heading', level: 0, chunks: [whole] };
  }

  const lines = markdown.split(/\r?\n/);
  let sawBroken = false;

  for (let level = minLevel; level <= maxLevel; level++) {
    const cuts = headings.filter((h) => h.level <= level).map((h) => h.line);
    if (cuts.length === 0) continue;

    const sections = sliceAt(lines, cuts);
    if (sections.length <= 1) continue;

    const counts = sections.map((s) => opts.countBlocks(s));
    const total = counts.reduce((a, b) => a + b, 0);

    // 守恒校验：切出来的块数之和必须等于原文块数。
    // 不等就说明这一层的切法破坏了结构（最可能是切进了代码围栏），换更细的层级。
    if (total !== opts.totalBlocks) {
      sawBroken = true;
      continue;
    }

    // 有小节本身就超过阈值 → 这一层切不动，降级到更细的层级
    if (counts.some((n) => n > maxBlocks)) continue;

    const groups = greedyPack(counts, maxBlocks);
    if (groups.length <= 1) continue;

    const chunks: SplitChunk[] = [];
    let acc = 0;
    for (const g of groups) {
      const text = g.map((i) => sections[i]).join('\n');
      const blockCount = g.reduce((a, i) => a + counts[i], 0);
      chunks.push({ title: firstTitle(text), text, startBi: acc, blockCount });
      acc += blockCount;
    }

    return { needed: true, reason: 'ok', level, chunks };
  }

  return {
    needed: false,
    reason: sawBroken ? 'structure_broken' : 'section_too_big',
    level: 0,
    chunks: [whole],
  };
}

/** 把原因翻成给用户看的一句话。 */
export function splitReasonText(reason: SplitReason): string {
  switch (reason) {
    case 'no_heading':
      return '这篇文档里没有标题，找不到可以下刀的位置';
    case 'structure_broken':
      return '按标题切开会破坏文档结构（多半是代码块被劈开了），已放弃拆分，原文没有改动';
    case 'section_too_big':
      return '单个标题下的内容就已经超过阈值，再切只会更碎，已放弃拆分';
    default:
      return '';
  }
}
