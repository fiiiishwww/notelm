/**
 * src/hooks/buildBlockMap.ts —— 「归一化文本偏移」↔「DOM 位置」的双向索引。
 *
 * 这是整个高亮叠加层的地基，也是全项目**第二个**必须和 shared/text.ts 逐字符对齐的
 * 地方（第一个是 shared/blocks.ts）。三者的分工：
 *
 *   shared/blocks.ts   markdown 源码 ──(markdown-it)──> blocks[].text   ← 锚点坐标的定义方
 *   buildBlockMap.ts   DOM 文本节点  ──(本文件)──────> 同一种归一化文本 ← 坐标的消费方
 *   shared/text.ts     normalizeText() 的唯一实现，两边都必须用它的规则
 *
 * ★ 维护红线 ★
 * 1. 归一化规则必须与 normalizeText(s)=s.replace(/\s+/g,' ').trim() 完全一致。
 *    本文件为了同时产出「偏移 → 位置」的映射表，不能直接调用 normalizeText，
 *    只能逐字符重建同一套规则。改任何一边都必须同时改另一边。
 * 2. 高亮**不能重渲染文字**。做法是在原有文本节点上包一层 inline 的 <mark>，
 *    文字本身、字体、标点、换行全部保持原样。一旦改成「拼字符串 + innerHTML」，
 *    换行位置会变，屏幕上看到的段落就和 blocks 里的偏移对不上了。
 * 3. 不要用「数 DOM 子节点」来推块号。正文里 h1/ul/blockquote/pre 这些容器不产块，
 *    块号只能从 data-bi 属性读（它由服务端 annotateBlocks 写进 token）。
 */

import {
  bestFuzzySubstring,
  dice,
  isSpaceChar,
  type Block,
  type HighlightColor,
  type TextQuoteSelector,
} from '../../shared/text';

// ─────────────────────────── 数据结构 ───────────────────────────

/** 一个归一化字符在 DOM 里的落点。 */
export interface DomPos {
  node: Text;
  offset: number;
}

/** 归一化文本里的一个字符：字符本身 + 它在 DOM 里的位置（可能暂时没有）。 */
interface CharSlot {
  ch: string;
  pos: DomPos | null;
}

/** 一个块（bi）的索引：归一化文本 + 每个字符的 DOM 落点。 */
export interface BlockMapEntry {
  bi: number;
  el: HTMLElement;
  /** 由 DOM 现场重建出来的归一化文本 */
  text: string;
  /** text 与后端 blocks[].text 是否逐字符一致（不一致就意味着锚点可能漂移） */
  exact: boolean;
  chars: CharSlot[];
  /** 该块是标题块时，标题的稳定 id（其余块为 undefined） */
  headingId?: string;
}

export interface BlockIndex {
  /** 后端给的块序列（偏移坐标系的定义方）。下标与 offsets 一一对应。 */
  blocks: Block[];
  /**
   * 已经走过 DOM 的块，**惰性增长**：只有被 ensure() 问到的块才在里面，按 bi 升序。
   * ★ 不要假设它覆盖全篇 —— 它是「这次重绘真正用到的块」，通常只有个位数。
   */
  entries: BlockMapEntry[];
  /** 同上，按 bi 查。要取某个块的索引请一律走 ensure()，别直接 get 完就当它一定在。 */
  byBi: Map<number, BlockMapEntry>;
  /** 全部块号（含还没走 DOM 的）。判断「这个元素是不是一个块」用它，别用 byBi。 */
  allBi: Set<number>;
  /** 全部块的归一化文本用 \n 连接，与后端 DocAnalysis.docPlain 同构，供全篇搜索用 */
  docPlain: string;
  /** blocks[i] 在 docPlain 里的起始偏移（下标与 blocks 一致，**不是**与 entries 一致） */
  offsets: number[];
  /** 惰性走 DOM：拿到 bi 的索引。走过了直接返回缓存，没走过才遍历它内部的文本节点。 */
  ensure: (bi: number) => BlockMapEntry | null;
}

/** 一次高亮渲染的目标：一条高亮（或一处待确认的选区）落在哪一段文字上。 */
export interface OverlayItem {
  /** 高亮 id；待确认选区用 '__pending__' */
  key: string;
  selector: TextQuoteSelector;
  color: HighlightColor;
  /** 后端已经标记为失效的，渲染成虚线下划提示「位置不确定」 */
  orphan?: boolean;
  /** 这处高亮底下挂着一条批注（正文里据此和「只划了颜色」区分开） */
  hasNote?: boolean;
}

interface PaintTarget extends OverlayItem {
  range: ResolvedRange;
  /** 绘制顺序（越大越新），重叠处显示最新那个的颜色 */
  z: number;
}

/** 选择器被解析回块内区间之后的结果。 */
export interface ResolvedRange {
  bi: number;
  /** 块内归一化起点（含） */
  start: number;
  /** 块内归一化终点（不含） */
  end: number;
  /** 怎么找到的：exact 最可靠，fuzzy 表示只是「大概像」，要提示用户 */
  how: 'exact' | 'searched' | 'global' | 'fuzzy';
}

// ─────────────────────────── ① 建索引 ───────────────────────────

/** 这些标签里的文字不属于「可见正文」，一律跳过。 */
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'CANVAS', 'SVG']);

type RawItem =
  | { kind: 'text'; node: Text }
  | { kind: 'ws' }
  | { kind: 'alt'; text: string };

/**
 * 按文档顺序收集一个块内的「可见文字来源」。
 *
 * 三条规则，缺一不可：
 *   - 遇到带 data-bi 的后代元素就**不再往下走**。嵌套列表里外层 <li> 包着内层 <li>，
 *     不剪枝就会把子项的文字算进父项，偏移整体后移。
 *   - <br> 折算成一个空格。markdown 的 hardbreak 在 shared/blocks.ts 里也是折算成空格，
 *     不这么做两边就差一个字符。
 *   - <img> 取 alt 文字。markdown-it 的 image token 的 content 就是 alt，后端把它算进了
 *     block.text；DOM 里 <img> 不贡献文本，不补上这一块偏移同样会错位。
 *     （alt 没有对应的 TextNode，位置先留空，后面统一兜底。）
 *   - .ktx（公式，2026-10-10）取 data-tex（dollar 包裹的公式规范文本，与后端
 *     shared/blocks.ts 的 CANON 一致），**整个跳过**：KaTeX 渲染出的内部 DOM
 *     （mathml 注解、视觉 span）不是正文，算进去偏移必然漂移。位置同样留空兜底。
 */
function collectItems(el: HTMLElement): RawItem[] {
  const out: RawItem[] = [];
  const visit = (parent: Node) => {
    for (const child of Array.from(parent.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        out.push({ kind: 'text', node: child as Text });
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue; // 注释等
      const e = child as HTMLElement;
      if (e.hasAttribute('data-bi')) continue; // 嵌套块，自成一块
      const tag = e.tagName;
      if (SKIP_TAGS.has(tag)) continue;
      if (e.classList.contains('ktx')) {
        out.push({ kind: 'alt', text: e.getAttribute('data-tex') ?? '' });
        continue;
      }
      if (tag === 'BR') {
        out.push({ kind: 'ws' });
        continue;
      }
      if (tag === 'IMG') {
        out.push({ kind: 'alt', text: e.getAttribute('alt') ?? '' });
        continue;
      }
      visit(e);
    }
  };
  visit(el);
  return out;
}

/**
 * 在一个块上重建归一化文本，并记下每个字符在 DOM 里的落点。
 *
 * 归一化规则逐字符复刻 normalizeText：
 *   任意长度的空白串 → 一个半角空格，且这个空格「继承」空白串里第一个字符的位置；
 *   开头的空白串整个丢弃（trim 的左半边）；
 *   结尾的空白串因为一直没有被后续的非空白字符冲刷出来，自然也就丢了（trim 的右半边）。
 */
function walkBlock(b: Block, el: HTMLElement): BlockMapEntry {
  const chars: CharSlot[] = [];

  /** 待定的空白：还没确定要不要留下，也不知道落在哪 */
  let hasPending = false;
  let pendingPos: DomPos | null = null;
  /** 是否已经出现过非空白字符（等价于 trim 的左边界） */
  let started = false;
  const emitSpace = (pos: DomPos | null) => {
    // trim：开头的空白不要；同一段空白串只记一次（记第一个字符的位置）
    if (!started || hasPending) return;
    hasPending = true;
    pendingPos = pos;
  };

  const emitChar = (ch: string, pos: DomPos | null) => {
    if (hasPending) {
      chars.push({ ch: ' ', pos: pendingPos });
      hasPending = false;
      pendingPos = null;
    }
    started = true;
    chars.push({ ch, pos });
  };

  // ★ 行间公式的块元素本身就是 .ktx（data-bi 和 data-tex 都在它身上）：
  //   collectItems 只看子节点，根自己就命中时必须在这里取 data-tex，
  //   否则会走进 KaTeX 内部 DOM 把渲染产物当正文收进去（2026-10-10 DOM 闭合探针抓到）。
  const items: RawItem[] = el.classList.contains('ktx')
    ? [{ kind: 'alt', text: el.getAttribute('data-tex') ?? '' }]
    : collectItems(el);

  for (const it of items) {
    if (it.kind === 'text') {
      const data = it.node.data;
      // 逐 code unit 走。TextNode 的 offset 和 JS 字符串下标同样是 code unit，
      // 所以代理对（emoji）天然对齐，不需要特殊处理。
      for (let i = 0; i < data.length; i++) {
        const ch = data[i];
        if (isSpaceChar(ch)) emitSpace({ node: it.node, offset: i });
        else emitChar(ch, { node: it.node, offset: i });
      }
    } else if (it.kind === 'ws') {
      emitSpace(null);
    } else {
      for (let i = 0; i < it.text.length; i++) {
        const ch = it.text[i];
        if (isSpaceChar(ch)) emitSpace(null);
        else emitChar(ch, null);
      }
    }
  }

  // 兜底：没有 DOM 落点的字符（<img alt>、<br> 折算出的空格）挂到最近的有落点的字符上，
  // 保证它们不会让后面所有字符的偏移整体错位。
  let next: DomPos | null = null;
  for (let i = chars.length - 1; i >= 0; i--) {
    if (chars[i].pos) next = chars[i].pos;
    else if (next) chars[i].pos = next;
  }
  let prev: DomPos | null = null;
  for (let i = 0; i < chars.length; i++) {
    if (chars[i].pos) prev = chars[i].pos;
    else if (prev) chars[i].pos = { node: prev.node, offset: prev.offset + 1 };
  }

  const text = chars.map((c) => c.ch).join('');
  return { bi: b.bi, el, text, exact: text === b.text, chars, headingId: b.headingId };
}

/**
 * 为整篇正文建索引。
 *
 * ★ 索引是惰性的 ★
 * 这里只做两件便宜的事：把块元素收进一张 Map、用后端 blocks 算出偏移表。
 * 真正昂贵的 walkBlock 推迟到 ensure() 被调用时才发生，于是「画 3 条高亮」
 * 只走 3 个块，而不是把整篇 8819 块全翻一遍。
 *
 * @param root 渲染后的 .article 元素
 * @param blocks 服务端分析出来的块序列（偏移坐标系的定义方）
 * @param docPlain 后端算好的全篇纯文本；不传就用 blocks 现拼（同构，只是多一次百万字符的 join）
 */
export function buildBlockMap(root: HTMLElement, blocks: Block[], docPlain?: string): BlockIndex {
  // 一次 querySelectorAll 拿全部块元素，避免每个块各查一次导致 O(n²)。
  // 注意这里**只取元素引用**，不碰它们内部的文字。
  const els = new Map<number, HTMLElement>();
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('[data-bi]'))) {
    const bi = Number(el.dataset.bi);
    if (Number.isFinite(bi) && !els.has(bi)) els.set(bi, el);
  }

  const byBlock = new Map<number, Block>();
  const allBi = new Set<number>();
  const offsets: number[] = [];
  let acc = 0;
  for (const b of blocks) {
    byBlock.set(b.bi, b);
    allBi.add(b.bi);
    offsets.push(acc);
    acc += b.text.length + 1; // join('\n')
  }

  const entries: BlockMapEntry[] = [];
  const byBi = new Map<number, BlockMapEntry>();

  /**
   * 惰性走 DOM：第一次问到某个块，才真的遍历它内部的文本节点。
   *
   * ★ 为什么必须惰性 ★
   * walkBlock 每归一化一个字符就要 new 两个对象（CharSlot + DomPos）。大文档的
   * docPlain 动辄上百万字符，全量建一次索引就是上百万次分配外加一次大 GC，
   * 单次几百毫秒到数秒——而它真正被用到的块只有「挂着高亮的那几个」和
   * 「用户当前选中的那个」，通常是个位数。
   */
  const ensure = (bi: number): BlockMapEntry | null => {
    const cached = byBi.get(bi);
    if (cached) return cached;
    const el = els.get(bi);
    const b = byBlock.get(bi);
    if (!el || !b) return null;
    const e = walkBlock(b, el);
    byBi.set(bi, e);
    entries.push(e);
    entries.sort((x, y) => x.bi - y.bi); // 用到的是个位数，排序代价可以忽略
    return e;
  };

  return {
    blocks,
    entries,
    byBi,
    allBi,
    docPlain: docPlain ?? blocks.map((b) => b.text).join('\n'),
    offsets,
    ensure,
  };
}

/** 索引与后端 blocks 对不上的块（数量、bi 都能对上，但文字内容不一致）。 */
export function driftBlocks(index: BlockIndex): BlockMapEntry[] {
  return index.entries.filter((e) => !e.exact);
}

// ─────────────────────────── ② 解析选择器 ───────────────────────────

/**
 * 置信度阈值，与后端 server/services/anchor.ts 的 S3_WEAK / S4_ACCEPT 对齐。
 * 两边必须用同一套数字，否则会出现「后端说修好了、前端不敢画」这种自相矛盾的状态
 * （用户看到批注卡片是正常的，正文里却没颜色，完全无从排查）。
 *
 * 模糊匹配这里只留一道门槛，不像后端那样分「采纳 / 弱采纳」两档，
 * 因为前端对 fuzzy 结果的呈现是一视同仁的：一律画成虚线下划（表示位置不确定）。
 * 再加一档也不会让屏幕上多出任何区别，只会多一个没人看的常量。
 */
const S3_WEAK = 0.6;
const S4_GATE = 0.6;

/**
 * 在 docPlain 的某个偏移处反查它属于哪个块（含分隔符的容错）。
 *
 * 只看后端 blocks + offsets，不碰 DOM，所以惰性索引下依然成立。
 * offsets 单调递增，二分即可；找不到返回 null（调用方按「定位失败」处理）。
 */
function blockAtOffset(index: BlockIndex, g: number): { bi: number; local: number } | null {
  const { offsets, blocks } = index;
  if (!offsets.length) return null;
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= g) lo = mid;
    else hi = mid - 1;
  }
  const s = offsets[lo];
  const e = s + blocks[lo].text.length;
  if (g >= s && g <= e) return { bi: blocks[lo].bi, local: g - s };
  return null;
}

/**
 * 把一条 TextQuoteSelector 解析回块内区间。
 *
 * 降级顺序与后端 anchor.ts 同源，但这里**只做定位、不改数据**：
 * 后端负责把修好的偏移写回 sidecar，前端负责「这一屏该怎么画」。
 *
 *   S1 块内精确：textOffset 直接命中（绝大多数情况，一次字符串比较）
 *   S2 块内唯一：quote 在块内只出现一次 → 就是它
 *   S3 块内多处：用 prefix/suffix 的 bigram Dice 打分挑最像的那个
 *   S4 块内模糊：被改了几个字，用 bestFuzzySubstring 找回大概区间
 *   S5 全篇唯一：块被拆开或合并过（用户在 Obsidian 里把两段并成了一段）
 *
 * 全部失败返回 null —— 宁可不画，也绝不在错的字上画一道高亮。
 */
export function resolveSelector(index: BlockIndex, sel: TextQuoteSelector): ResolvedRange | null {
  const q = sel.quote;
  if (!q) return null;
  // 惰性：只有这条高亮所在的那个块才真的去走 DOM
  const entry = index.ensure(sel.blockIndex);

  if (entry) {
    // S1
    const off = sel.textOffset;
    if (off >= 0 && off + q.length <= entry.text.length && entry.text.startsWith(q, off)) {
      return { bi: entry.bi, start: off, end: off + q.length, how: 'exact' };
    }

    const first = entry.text.indexOf(q);
    if (first >= 0) {
      const second = entry.text.indexOf(q, first + 1);
      // S2
      if (second < 0) return { bi: entry.bi, start: first, end: first + q.length, how: 'searched' };

      // S3：多处出现，靠上下文消歧。
      // prefix/suffix 两条 Dice 取平均归一化到 0~1，好和后端的单条 Dice 阈值直接比。
      let best: { i: number; s: number } | null = null;
      for (let i = first; i >= 0; i = entry.text.indexOf(q, i + 1)) {
        const pre = entry.text.slice(Math.max(0, i - sel.prefix.length), i);
        const suf = entry.text.slice(i + q.length, i + q.length + sel.suffix.length);
        const s = (dice(pre, sel.prefix) + dice(suf, sel.suffix)) / 2;
        if (!best || s > best.s) best = { i, s };
      }
      // 上下文完全对不上说明定位不可信，交给 S4 重新找区间，别硬套第一个候选
      if (best && best.s >= S3_WEAK) {
        return { bi: entry.bi, start: best.i, end: best.i + q.length, how: 'searched' };
      }
    }

    // S4
    const f = bestFuzzySubstring(entry.text, q);
    if (f && f.score >= S4_GATE) {
      // 记成 fuzzy 而不是 searched：它不是逐字符相等，达不到「确定」的可信度。
      // 调用方据此画成虚线下划，明确告诉用户「这里只是大概像」。
      return { bi: entry.bi, start: f.index, end: f.index + f.length, how: 'fuzzy' };
    }
  }

  // S5：全篇找，且必须唯一命中，否则不敢认
  const g = index.docPlain.indexOf(q);
  if (g >= 0 && index.docPlain.indexOf(q, g + 1) < 0) {
    const hit = blockAtOffset(index, g);
    const entry = hit ? index.ensure(hit.bi) : null;
    if (hit && entry) {
      const start = Math.max(0, Math.min(hit.local, entry.text.length));
      const end = Math.max(start, Math.min(start + q.length, entry.text.length));
      if (end > start) return { bi: entry.bi, start, end, how: 'global' };
    }
  }

  return null;
}

// ─────────────────────────── ③ 绘制高亮 ───────────────────────────

/**
 * 把上一轮画的 <mark> 全部拆掉，恢复成纯文本。
 *
 * 为什么不是「重新 innerHTML」：那样会把浏览器里的选区、滚动锚点、图片解码
 * 一起丢掉，用户改个颜色会看到正文闪一下。拆 mark 只是把子节点搬回父节点。
 */
export function unwrapHighlights(root: HTMLElement): void {
  const marks = Array.from(root.querySelectorAll('mark.hl'));
  /** 被拆过的父节点。记下来是为了只 normalize 它们，见下方说明。 */
  const touched = new Set<Node>();
  // 从后往前拆：嵌套的高亮（同一段被两条批注覆盖）先拆内层，父节点不会被提前摘掉
  for (let i = marks.length - 1; i >= 0; i--) {
    const m = marks[i];
    const parent = m.parentNode;
    if (!parent) continue;
    while (m.firstChild) parent.insertBefore(m.firstChild, m);
    parent.removeChild(m);
    touched.add(parent);
  }
  // 合并被 mark 切开的相邻文本节点，否则文本节点会越切越碎，索引越来越不可读。
  //
  // 只 normalize 真正被拆过的那几个父节点，不用 root.normalize()：
  // 后者会遍历整棵子树。一篇上万块的文档里，正文 99.99% 的节点跟高亮毫无关系，
  // 为它们走一遍是纯粹的浪费；而且 normalize 还会动到浏览器的滚动锚定。
  for (const p of touched) {
    if (p.isConnected) p.normalize();
  }
}

/**
 * 按目标区间在原有文本节点上包一层 <mark>。
 *
 * 关键：所有区间的位置在**动手改 DOM 之前**一次性算完。因为拆文本节点会让
 * 后面算出来的 (node, offset) 全部失效，边算边改是必错的。
 */
export function paintHighlights(index: BlockIndex, targets: PaintTarget[]): void {
  /** 文本节点 → （目标 → 它在这个节点里的局部区间） */
  const perNode = new Map<Text, Map<PaintTarget, { s: number; e: number }>>();

  for (const t of targets) {
    const entry = index.ensure(t.range.bi);
    if (!entry) continue;
    for (let i = t.range.start; i < t.range.end; i++) {
      const p = entry.chars[i]?.pos;
      if (!p) continue;
      let m = perNode.get(p.node);
      if (!m) {
        m = new Map();
        perNode.set(p.node, m);
      }
      const cur = m.get(t);
      if (!cur) m.set(t, { s: p.offset, e: p.offset + 1 });
      else {
        if (p.offset < cur.s) cur.s = p.offset;
        if (p.offset + 1 > cur.e) cur.e = p.offset + 1;
      }
    }
  }

  for (const [node, rangeMap] of perNode) {
    const list = Array.from(rangeMap.entries()).filter(([, r]) => r.e > r.s);
    if (!list.length) continue;
    list.sort((a, b) => a[1].s - b[1].s || a[0].z - b[0].z);

    // 所有区间端点把节点切成若干「基本段」，每一段被哪些高亮覆盖是确定的。
    // 这样重叠的高亮不需要嵌套 mark：重叠处直接显示最上面那条的颜色，
    // 非重叠处各显各的色，两条高亮都还能被点中（data-hl-ids 里都记着）。
    const bounds = new Set<number>();
    for (const [, r] of list) {
      bounds.add(Math.max(0, r.s));
      bounds.add(Math.min(node.data.length, r.e));
    }
    const pts = Array.from(bounds)
      .filter((v) => v >= 0 && v <= node.data.length)
      .sort((a, b) => a - b);
    if (pts.length < 2) continue;

    const frag = document.createDocumentFragment();
    let cursor = 0;
    for (let k = 0; k < pts.length - 1; k++) {
      const a = pts[k];
      const b = pts[k + 1];
      if (a > cursor) frag.appendChild(document.createTextNode(node.data.slice(cursor, a)));
      const covering = list.filter(([, r]) => r.s <= a && r.e >= b).map(([t]) => t);
      if (covering.length) {
        covering.sort((x, y) => x.z - y.z);
        const top = covering[covering.length - 1];
        const mark = document.createElement('mark');
        // has-note：这一段文字底下有批注（不是只划了颜色）。用 CSS 的 inset 阴影画，
        // 不占布局空间——见 theme.css 里那条规则的说明。
        mark.className =
          `hl hl-${top.color}` +
          (covering.some((c) => c.orphan) ? ' orphan' : '') +
          (covering.some((c) => c.hasNote) ? ' has-note' : '');
        mark.dataset.hlIds = covering.map((c) => c.key).join(' ');
        mark.dataset.hlTop = top.key;
        if (covering.some((c) => c.key === PENDING_KEY)) mark.classList.add('pending');
        mark.appendChild(document.createTextNode(node.data.slice(a, b)));
        frag.appendChild(mark);
      } else {
        frag.appendChild(document.createTextNode(node.data.slice(a, b)));
      }
      cursor = b;
    }
    if (cursor < node.data.length) {
      frag.appendChild(document.createTextNode(node.data.slice(cursor)));
    }
    node.replaceWith(frag);
  }
}

export const PENDING_KEY = '__pending__';

/**
 * 完整重绘一遍叠加层：拆旧 mark → 建索引 → 解析 → 上色。
 * @returns 索引（选区捕获还要接着用）与「解析不出位置」的条目 key
 */
export function rebuildOverlay(
  root: HTMLElement,
  blocks: Block[],
  items: OverlayItem[],
): { index: BlockIndex; missed: string[] } {
  unwrapHighlights(root);
  const index = buildBlockMap(root, blocks);

  const targets: PaintTarget[] = [];
  const missed: string[] = [];
  items.forEach((it, z) => {
    const range = resolveSelector(index, it.selector);
    if (!range) {
      missed.push(it.key);
      return;
    }
    targets.push({
      ...it,
      range,
      z,
      // 模糊匹配出来的位置本身就不确定，标成虚线下划，别让用户以为定位是准的
      orphan: it.orphan || range.how === 'fuzzy',
    });
  });

  paintHighlights(index, targets);
  return { index, missed };
}

/** 只改 class，不重绘 DOM —— 点批注时的「高亮那一下」走这条路，代价接近零。 */
export function syncActiveClass(root: HTMLElement, activeKeys: string[]): void {
  for (const m of Array.from(root.querySelectorAll('mark.hl.active'))) m.classList.remove('active');
  for (const key of activeKeys) {
    if (!key) continue;
    const esc = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(key) : key.replace(/"/g, '\\"');
    for (const m of Array.from(root.querySelectorAll(`mark.hl[data-hl-ids~="${esc}"]`))) {
      m.classList.add('active');
    }
  }
}

/** 读一个 <mark> 上挂的高亮 id（从新到旧）。 */
export function markKeys(mark: Element): string[] {
  return (mark.getAttribute('data-hl-ids') ?? '').split(/\s+/).filter(Boolean);
}

// ─────────────────────────── ④ 选区 → 选择器 ───────────────────────────

export type RangePick =
  | { ok: true; selector: TextQuoteSelector }
  | { ok: false; reason: 'outside' | 'cross-block' | 'empty' };

/** 从任意节点往上找最近的「带 data-bi 且在建索引范围内的」元素。 */
function blockElementOf(index: BlockIndex, node: Node | null): HTMLElement | null {
  let cur: Node | null = node;
  while (cur) {
    if (cur.nodeType === Node.ELEMENT_NODE) {
      const el = cur as HTMLElement;
      const raw = el.getAttribute('data-bi');
      // ★ 用 allBi 而不是 byBi：索引是惰性的，byBi 里只有「这次用过的块」，
      // 用它判断会让「在一个没有高亮的段落里划词」直接失败。
      if (raw !== null && index.allBi.has(Number(raw))) return el;
    }
    cur = cur.parentNode;
  }
  return null;
}

/**
 * 把一个（选区端点所在的）DOM 位置换算成块内归一化偏移。
 *
 * 端点是文本节点时用「第一个偏移 >= 给定 offset 的字符槽」，
 * 于是 end 端点天然得到「不含」的语义，正好能当区间右开边界用。
 */
function locate(entry: BlockMapEntry, container: Node, offset: number, isEnd: boolean): number | null {
  if (container.nodeType === Node.TEXT_NODE) {
    const t = container as Text;
    let last = -1;
    for (let i = 0; i < entry.chars.length; i++) {
      const p = entry.chars[i].pos;
      if (!p || p.node !== t) continue;
      last = i;
      if (p.offset >= offset) return i;
    }
    // offset 落在节点末尾（或节点里全是被折叠掉的空白）：退回该节点贡献的末尾
    return last >= 0 ? last + 1 : null;
  }

  if (container.nodeType !== Node.ELEMENT_NODE) return null;
  const el = container as Element;

  // 元素端点：offset 语义是「第几个子节点」。
  // 先看锚定的那个子节点，里面找不到字符槽就顺着方向在兄弟节点里找。
  // 找不到就返回 null（调用方按「选不出内容」处理），绝不猜一个位置出来。
  const anchor = el.childNodes[offset - (isEnd ? 1 : 0)] ?? null;
  const dir: 1 | -1 = isEnd ? -1 : 1;
  let cur: Node | null = anchor;
  while (cur) {
    for (let i = isEnd ? entry.chars.length - 1 : 0; i >= 0 && i < entry.chars.length; i += dir) {
      const p = entry.chars[i].pos;
      if (!p) continue;
      if (p.node === cur || (cur.nodeType === Node.ELEMENT_NODE && cur.contains(p.node))) {
        return isEnd ? i + 1 : i;
      }
    }
    cur = isEnd ? cur.previousSibling : cur.nextSibling;
  }
  return null;
}

/**
 * 某个块所属章节的 headingId —— 沿块序列往前找最近的标题块。
 * 存进选择器是为了「原文大改、块号失效」时，后端的重锚还能靠章节线索缩小搜索范围。
 */
function headingIdAt(index: BlockIndex, bi: number): string | undefined {
  // 从后端 blocks 里找，不从 index.entries 里找：后者是惰性的、稀疏的，
  // 用它会在「标题块恰好没被用到」时退回到更早的一个标题，章节线索就错了。
  let hit: string | undefined;
  for (const b of index.blocks) {
    if (b.bi > bi) break;
    if (b.headingId) hit = b.headingId;
  }
  return hit;
}

/**
 * 把当前选区换算成一条 TextQuoteSelector。
 *
 * 只支持「同一块之内」的选区。跨块选择（比如把标题和下面那段一起选中）无法用
 * 「块号 + 块内偏移」表达，这里明确拒绝并告诉用户，不做静默截断——静默截断会让
 * 用户以为整段都被批注了，实际上只存了半句。
 */
export function selectorFromRange(index: BlockIndex, range: Range): RangePick {
  const startEl = blockElementOf(index, range.startContainer);
  const endEl = blockElementOf(index, range.endContainer);
  if (!startEl || !endEl) return { ok: false, reason: 'outside' };
  if (startEl !== endEl) return { ok: false, reason: 'cross-block' };

  const raw = startEl.getAttribute('data-bi');
  const bi = Number(raw);
  // 惰性：只走用户选中的那一个块
  const entry = index.ensure(bi);
  if (!entry) return { ok: false, reason: 'outside' };

  const i0 = locate(entry, range.startContainer, range.startOffset, false);
  const i1 = locate(entry, range.endContainer, range.endOffset, true);
  if (i0 === null || i1 === null) return { ok: false, reason: 'empty' };

  let a = Math.min(i0, i1);
  let b = Math.max(i0, i1);
  // 选区两端常常带上空白（双击一个词会把后面的空格也圈进去），收掉，
  // 否则高亮会比用户想标的那几个字长出一点点，看起来像画歪了。
  while (a < b && isSpaceChar(entry.text[a])) a++;
  while (b > a && isSpaceChar(entry.text[b - 1])) b--;
  if (b <= a) return { ok: false, reason: 'empty' };

  const quote = entry.text.slice(a, b);
  return {
    ok: true,
    selector: {
      type: 'text-quote',
      quote,
      prefix: entry.text.slice(Math.max(0, a - 40), a),
      suffix: entry.text.slice(b, b + 40),
      blockIndex: bi,
      textOffset: a,
      headingId: headingIdAt(index, bi),
      quoteLength: quote.length,
    },
  };
}

/** 选区在视口里的位置（给浮动工具条定位用）。 */
export function rangeRect(range: Range): { x: number; y: number; bottom: number; width: number } {
  const r = range.getBoundingClientRect();
  return { x: r.x, y: r.y, bottom: r.bottom, width: r.width };
}
