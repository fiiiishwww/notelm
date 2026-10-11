/**
 * server/services/coverage.ts —— 块级覆盖记账：小抄到底漏了多少原文？
 *
 * ★ 为什么把它从 hlSignal 里分出来 ★
 *   hlSignal 管的是「用户高亮 → 块号」这层**输入信号**；
 *   覆盖率是**质量判据**，两者关注点不同：
 *   高亮问「用户划的重点被盖住了吗」，覆盖率问「原文的内容块被盖住了多少」。
 *   而且覆盖率有两个消费者，必须共用同一套代码，否则会出现
 *   「探针说 60%、管道说 80%」这种自欺：
 *     1) 生成时当质量门 —— 漏得离谱就定向补采（见 runCheatsheetV3）
 *     2) 离线评估 —— cheatsheet-gate-probe.ts / cheatsheet-coverage.ts
 *
 * ★ 为什么补采要收严到「孤立漏块」★
 *   如果连续十几块全都没被覆盖，那是模型判定「这一整段不值得记」，
 *   硬补回来只会稀释信噪比（用户已经反馈过「数值必要性不强」）。
 *   而「前一块盖住了、后一块也盖住了，就中间这块没有」——
 *   那是连续采集里漏掉的，才是真漏。
 *
 * 判据全是确定性的，零模型成本。
 */

import { type Block, type Chapter, type KnowledgeTree, type StudyUnit } from '../../shared/text';
import { informativeBlock } from './cheatsheet';

/** 带引文的条目（命题 / 速查 / 术语都一样）。 */
export type QuoteItem = { quote?: string };

/** 值得被小抄覆盖的块：标题是结构不是内容；太短的段落（图注、过渡）也不强求。 */
export function isContentBlock(b: Block): boolean {
  return !/^h[1-6]$/.test(b.type) && b.text.trim().length >= 8;
}

/**
 * 一批条目的引文覆盖了哪些块。
 *
 * ★ 覆盖判断要考虑「长引文跨块」★：quote 从块 A 开始但有 300 字，
 *   它其实盖住了 A 后面好几个块——只算起始块会把已经覆盖的块误判成「没覆盖」，
 *   白白触发补采。所以和 mapHighlightsToBlocks 一样往后延伸。
 */
export function coveredBlocks(
  items: QuoteItem[],
  blocks: Block[],
  locate: (q: string) => number | null,
): Set<number> {
  const out = new Set<number>();
  for (const it of items) {
    const q = (it.quote ?? '').trim();
    if (!q) continue;
    const bi = locate(q);
    if (bi == null) continue;
    out.add(bi);
    const start = blocks.findIndex((b) => b.bi === bi);
    if (start < 0) continue;
    let remaining = q.length - (blocks[start]?.text.length ?? 0);
    for (let i = start + 1; remaining > 0 && i < blocks.length; i++) {
      out.add(blocks[i].bi);
      remaining -= blocks[i].text.length + 1;
    }
  }
  return out;
}

/**
 * 覆盖率低于它就认为这一节「漏得离谱」，值得定向补采。
 *
 * ★ 阈值是按落盘数据量出来的，不是拍的（scripts/cheatsheet-gate-probe.ts）★
 *   49 个 V3 节的覆盖率：最低 32% / p25 54% / 中位 69% / p75 100%，平均 72%。
 *   定 0.7 → 25 节触发（51%），总补采 41 次调用、平均每节 +1.64 次、补进约 850 字。
 *   定 0.8 也只多 6 节 —— 收益递减，但 0.9 会把近七成节都拉进补采队列。
 */
export const COVER_GATE = 0.7;
/** 一次生成最多为覆盖率补采几段（每段 1 次调用）——防止「补漏」变成「重采一遍」。 */
export const MAX_GATE_SEGMENTS = 2;
/** 单段补采的正文上限（与高亮补采一致） */
export const SEGMENT_MAX_CHARS = 3600;
/** 两个候选块之间隔着多少个块还算「同一段」 */
const SEGMENT_GAP = 3;
/** 「孤立」的判据：前后各看几块 */
const NEIGHBOR_WINDOW = 1;

/**
 * 把内容块按位置等分，算每一段的覆盖率。
 *
 * ★ 这是诊断「输出预算被前段吃掉」的专用工具 ★
 *   长节的覆盖率是 29→25→15→13→14%，**单调递减** —— 而且这个形状是靠这个函数
 *   量出来的：光看总覆盖率（比如「28%」）看不出问题在哪，也就没法判断
 *   「该放宽条数还是该切窗口」。同理，改完合并策略之后也要看这个形状有没有变平，
 *   只看总覆盖率会被前段的收益掩盖后段的变化。
 *
 * 与 measureCoverage 共用 coveredBlocks，保证口径一致。
 */
export function coverageByPosition(args: {
  blocks: Block[];
  unit: StudyUnit;
  items: QuoteItem[];
  locate: (q: string) => number | null;
  /** 等分成几段（默认 5，和当初诊断 V2 时一致） */
  parts?: number;
}): { from: number; to: number; total: number; covered: number; rate: number }[] {
  const parts = Math.max(1, args.parts ?? 5);
  const content = args.blocks.slice(args.unit.startBi, args.unit.endBi).filter(isContentBlock);
  const hit = coveredBlocks(args.items, args.blocks, args.locate);
  const out: { from: number; to: number; total: number; covered: number; rate: number }[] = [];
  for (let p = 0; p < parts; p++) {
    const from = Math.floor((p * content.length) / parts);
    const to = Math.floor(((p + 1) * content.length) / parts);
    const slice = content.slice(from, to);
    const covered = slice.filter((b) => hit.has(b.bi)).length;
    out.push({
      from: slice[0]?.bi ?? -1,
      to: slice[slice.length - 1]?.bi ?? -1,
      total: slice.length,
      covered,
      rate: slice.length ? covered / slice.length : 0,
    });
  }
  return out;
}

export interface CoverageReport {
  /** 节内内容块总数 */
  total: number;
  /** 被条目引文碰到的块数 */
  covered: number;
  /** covered / total */
  rate: number;
  /** 漏掉的内容块 */
  missing: Block[];
  /** 收严后的候选补采块 */
  candidates: Block[];
  /** 候选块聚成的连续段，按字数降序、已封顶到 maxSegments */
  segments: Block[][];
  /** 候选块的正文总量（估算补采成本用） */
  candidateChars: number;
}

/**
 * 算一节的内容覆盖情况，并挑出值得补采的连续段。
 *
 * 注意 `blocks` 是全文档的块数组（coveredBlocks 要在全文里定位 quote），
 * 而统计范围限定在 `unit` 的 `[startBi, endBi)` —— 与 unitText 同口径。
 */
export function measureCoverage(args: {
  blocks: Block[];
  unit: StudyUnit;
  items: QuoteItem[];
  locate: (q: string) => number | null;
  /** 收严开关：false 时把「全部漏块」当候选（探针用来对照成本） */
  isolatedOnly?: boolean;
  maxSegments?: number;
}): CoverageReport {
  const inUnit = args.blocks.slice(args.unit.startBi, args.unit.endBi);
  const content = inUnit.filter(isContentBlock);
  const hit = coveredBlocks(args.items, args.blocks, args.locate);
  const coveredSet = new Set(content.filter((b) => hit.has(b.bi)).map((b) => b.bi));
  const missing = content.filter((b) => !coveredSet.has(b.bi));

  const idx = new Map(content.map((b, i) => [b.bi, i]));
  const candidates = missing.filter((b) => {
    const i = idx.get(b.bi);
    if (i == null) return false;
    if (args.isolatedOnly !== false) {
      let near = false;
      for (let d = 1; d <= NEIGHBOR_WINDOW && !near; d++) {
        const p = content[i - d];
        const n = content[i + d];
        if ((p && coveredSet.has(p.bi)) || (n && coveredSet.has(n.bi))) near = true;
      }
      if (!near) return false;
    }
    const t = b.text.trim();
    return t.length >= 60 || informativeBlock(t);
  });

  // 把候选块聚成连续段：断开的块单独喂给模型会丢掉上下文，
  // 聚成段之后补采窗口里才有连续的正文可读。
  const sorted = [...candidates].sort((a, b) => a.bi - b.bi);
  const segments: Block[][] = [];
  for (const b of sorted) {
    const last = segments[segments.length - 1];
    const chars = last ? last.reduce((s, x) => s + x.text.length, 0) : 0;
    if (last && b.bi - last[last.length - 1].bi <= SEGMENT_GAP && chars + b.text.length <= SEGMENT_MAX_CHARS) {
      last.push(b);
    } else {
      segments.push([b]);
    }
  }
  // 大段优先：字多的段信息量大，最坏情况下先保它们
  segments.sort((a, b) => b.reduce((s, x) => s + x.text.length, 0) - a.reduce((s, x) => s + x.text.length, 0));
  const maxSeg = args.maxSegments ?? MAX_GATE_SEGMENTS;

  return {
    total: content.length,
    covered: coveredSet.size,
    rate: content.length ? coveredSet.size / content.length : 1,
    missing,
    candidates,
    segments: segments.slice(0, maxSeg),
    candidateChars: candidates.reduce((s, b) => s + b.text.length, 0),
  };
}

// ─────────────────────── 骨架覆盖（树「该有的」在不在） ───────────────────────

/**
 * ★ 为什么树的覆盖率不能用上面那套块级口径 ★
 *
 * 块级覆盖率（`measureCoverage`）问的是「原文的内容块被引文盖住了多少」。
 * 它服务小抄 —— 小抄是一条条引文拼出来的，块级口径成立。
 * 但树**不是**逐块铺开的：例子、铺垫、过渡句不进树是对的，
 * 把它们算进分母，得到的就是「34%」这种既难看又不可行动的假数。
 *
 * 树该拿什么当尺子？答案是**原文的小标题**：
 *   · 它是作者自己划的知识点边界，不是程序猜的（不依赖加粗、不依赖句式）
 *   · 它天然带位置（`bi`），能落到节内做分布，不需要拿 markdown 字符串去 indexOf
 *   · ★ 多鱼说过「我的结构感来自原文目录，不是另造的分组」—— 尺子和她的体感同源
 *   · 它还是「定向补采」现成的输入单位：一个漏掉的标题，就是一段要补的正文
 *
 * ★ 三档判据，递进放宽 ★
 *   严格   标题核心词与某个节点名互为子串
 *   核心词 标题核心词出现在树的任何文本里（节点名 / essence / detail.text）
 *   近似   与某个节点名的字符 dice ≥ OUTLINE_DICE（模型按提示词改了名字的情况）
 * 三档都记进 `via`，**校准时要看的就是「哪一档在误判」**，不能只看总命中率。
 *
 * ★ 三档都不算「命中」的，也不等于「真漏」★
 *   「前言」「小结」「其他」这类标题本来就不是知识点。
 *   所以本函数只出**待人工判定的清单**，判据在上线前必须先用真实数据标定
 *   （这条是为了不再犯「拿没校准的秤下结论」的错，见文件头的注释）。
 */
export const OUTLINE_DICE = 0.45;

/** 字符 2-gram dice。做「模型改写了名字」的近似匹配用。 */
export function diceOf(a: string, b: string): number {
  const x = (a ?? '').replace(/\s+/g, '');
  const y = (b ?? '').replace(/\s+/g, '');
  if (!x || !y) return 0;
  const grams = (s: string): string[] => {
    if (s.length === 1) return [s];
    const out: string[] = [];
    for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
    return out;
  };
  const A = grams(x);
  const B = grams(y);
  const bag = new Map<string, number>();
  for (const g of B) bag.set(g, (bag.get(g) ?? 0) + 1);
  let hit = 0;
  for (const g of A) {
    const c = bag.get(g) ?? 0;
    if (c > 0) {
      hit++;
      bag.set(g, c - 1);
    }
  }
  return (2 * hit) / (A.length + B.length);
}

/** 标题里的编号、强调符、引号先剥掉，再取冒号前的核心词。 */
export function outlineCore(text: string): string {
  return (text ?? '')
    .replace(/\*\*/g, '')
    .replace(/[`*]/g, '')
    .replace(/["“”'‘’「」『』]/g, '')
    .replace(/^\s*(\d+(\.\d+)*|[一二三四五六七八九十]+)\s*[.、)）:：]?\s*/, '')
    .split(/[:：]/)[0]
    .trim();
}

/** 节内更深层的原文标题 —— 这一节的骨架。表/图注不算（它们是图表的标签，不是知识点）。 */
export function outlineHeadings(chapters: Chapter[], unit: StudyUnit): Chapter[] {
  return chapters.filter(
    (c) =>
      c.bi > unit.startBi &&
      c.bi < unit.endBi &&
      c.level > unit.level &&
      !/^(表|图)\s*\d/.test(c.text.trim()),
  );
}

/** 树里所有能拿去比对的文本。 */
export function treeVocab(tree: KnowledgeTree): { names: string[]; all: string } {
  const names: string[] = [];
  const parts: string[] = [];
  for (const n of tree.nodes ?? []) {
    names.push(n.name ?? '');
    parts.push(n.name ?? '', n.essence ?? '');
    for (const d of n.details ?? []) parts.push(d.text ?? '');
  }
  return { names, all: parts.join('\u0001') };
}

export interface OutlineRow {
  headingId: string;
  level: number;
  /** 标题块自身的 bi —— 补采时用它取正文范围 */
  bi: number;
  endBi: number;
  text: string;
  core: string;
  hit: boolean;
  via: '严格' | '核心词' | '近似' | '';
  /** 树里最接近的候选节点（按接近度降序，最多 3 条）——校准表要人读这一列 */
  candidates: { name: string; score: number }[];
}

export interface OutlineReport {
  total: number;
  hit: number;
  rate: number;
  rows: OutlineRow[];
}

/**
 * 算一节的知识树在骨架上的覆盖。
 *
 * `unit` 是树对应的生成单位；`chapters` 来自同一份 `analyzeDocument`。
 * 树可以不覆盖每一个块，但**原文作者划出的每一个小标题，读者都会想知道它在哪** ——
 * 这就是这一杆秤的全部理由。
 */
export function outlineCoverage(args: {
  tree: KnowledgeTree;
  chapters: Chapter[];
  unit: StudyUnit;
}): OutlineReport {
  const { names, all } = treeVocab(args.tree);
  const rows: OutlineRow[] = [];

  for (const c of outlineHeadings(args.chapters, args.unit)) {
    const core = outlineCore(c.text);
    const flat = (s: string) => s.replace(/\s+/g, '').toLowerCase();
    const fc = flat(core);

    // 候选：先算接近度，再判命中（校准表要看到「最接近的是谁」才好判）
    const scored = args.tree.nodes
      .map((n) => {
        const fn = flat(n.name ?? '');
        const dice = diceOf(core, n.name ?? '');
        const contains = fn.length >= 2 && fc.length >= 2 && (fc.includes(fn) || fn.includes(fc));
        return { name: n.name ?? '', score: contains ? Math.max(dice, 0.9) : dice };
      })
      .sort((a, b) => b.score - a.score);
    const candidates = scored.slice(0, 3);

    let via: OutlineRow['via'] = '';
    if (fc.length >= 2) {
      if (scored[0] && scored[0].score >= 0.9) via = '严格';
      else if (fc.length >= 2 && all.replace(/\s+/g, '').toLowerCase().includes(fc)) via = '核心词';
      else if (scored[0] && scored[0].score >= OUTLINE_DICE) via = '近似';
    }

    rows.push({
      headingId: c.headingId,
      level: c.level,
      bi: c.bi,
      endBi: c.endBi,
      text: c.text,
      core,
      hit: via !== '',
      via,
      candidates,
    });
  }

  const hit = rows.filter((r) => r.hit).length;
  return { total: rows.length, hit, rate: rows.length ? hit / rows.length : 1, rows };
}
