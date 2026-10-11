/**
 * server/services/cheatsheetV3.ts —— 窗口化采集的小抄生成。
 *
 * ★ 为什么要有这一层 ★
 *   实测：同一个「最多 7 条」，在 10 块的短节上覆盖原文 70%，在 162 块的长节上只有 6%。
 *   而且漏的位置是**单调递减**的（开头 29% → 结尾 14%）——
 *   说明不是「模型做了取舍」，而是输出预算被前段吃掉了，越往后越敷衍。
 *
 *   结论：光放宽条数治不了。162 块要覆盖 80% 得 90 条，那就退化成 V1 的「原句缩写」。
 *   治法是**别让一次调用看整个长节**：按块切窗口，每个窗口独立采集一遍，再合并。
 *   每个窗口都是「第一个窗口」，递减就消失了。
 *
 * ★ 关于「宁多勿少」★
 *   采集阶段的提示词是「多余的部分稍后会被合并掉，但漏了没人能补」，
 *   所以采集会偏多；合并阶段才做减法。**减法必须可回退**——
 *   LLM 合并后条数掉得太多就回退到确定性合并的结果（见 mergeCollected 的兜底）。
 */

import {
  dice,
  itemKeyOf,
  normalizeRel,
  type Block,
  type CheatsheetDropped,
  type CheatsheetStats,
  type CheatsheetTerm,
  type StudyUnit,
} from '../../shared/text';
import { chatJson } from './aiClient';
import { mapLimit } from './concurrency';
import { COVER_GATE, coveredBlocks, measureCoverage, SEGMENT_MAX_CHARS } from './coverage';
import {
  cheatsheetV3MergePrompt,
  cheatsheetV3WindowPrompt,
  type CheatsheetEntry,
  type CheatsheetProposition,
  type WindowItemsShape,
} from './prompts';
import {
  coverage,
  dedupeEntriesAgainstEntries,
  dedupePropsAgainstEntries,
  dupScan,
  isDuplicateQuote,
  isShortQuote,
  isTautology,
} from './cheatsheet';

export interface UnitWindow {
  /** 首尾块的 bi（含） */
  from: number;
  to: number;
  text: string;
  /** 本窗口里带「▲用户高亮」标记的块数（没有高亮时为 0） */
  hlCount: number;
}

export interface CheatsheetV3Output {
  focus: string;
  gist: string;
  propositions: CheatsheetProposition[];
  entries: CheatsheetEntry[];
  terms: CheatsheetTerm[];
  /**
   * 生成体检数据，**直接落盘**到 section.stats（见 shared/text.CheatsheetStats）。
   * 落盘之后「这一节质量如何」才是可比较的，而不是跑完就丢。
   */
  stats: CheatsheetStats & {
    /** 合并阶段是否因为丢太多而回退 */
    mergeFallback: boolean;
  };
  /** ★ 被裁条目回收站（复核 + 各轮合并的真丢）★ 落盘进 sec.dropped，用户可复活 */
  dropped: CheatsheetDropped[];
}

// ★ mapLimit 已收编到共享并发模块（2026-10-11）：原本地实现逐字移入 concurrency.ts，行为不变。

/**
 * 把一个单元切成若干窗口。
 *
 * 为什么以「块」为单位而不是按字符硬切：块是分析器的原子单位，
 * 硬切会把一句话劈成两半，模型看到半句话只会写废话；而且 quote 也就没法回跳了。
 */
export function splitUnitWindows(
  blocks: Block[],
  unit: StudyUnit,
  opts: { maxChars?: number; overlap?: number; hlBlocks?: Map<number, string> } = {},
): UnitWindow[] {
  const maxChars = opts.maxChars ?? 1800;
  const overlap = opts.overlap ?? 1;
  const hlBlocks = opts.hlBlocks;

  const items = blocks.slice(unit.startBi, unit.endBi).filter((b) => b.text.trim().length > 0);
  if (!items.length) return [];

  const groups: Block[][] = [];
  let cur: Block[] = [];
  let len = 0;
  for (const b of items) {
    cur.push(b);
    len += b.text.length + 1;
    if (len >= maxChars) {
      groups.push(cur);
      cur = overlap > 0 ? cur.slice(-overlap) : [];
      len = cur.reduce((s, x) => s + x.text.length + 1, 0);
    }
  }
  if (cur.length) groups.push(cur);

  // 尾巴只剩重叠块本身（说明上一组已经在末尾收口了），别再单独开一个窗口白花一次调用
  if (groups.length > 1 && groups[groups.length - 1].length <= overlap) groups.pop();

  return groups.map((g) => {
    // ★ 用户高亮的块在这里打标 ★ 标记放在块正文之后，模型读得到、但 quote 不许带它。
    const hlCount = hlBlocks ? g.filter((x) => hlBlocks.has(x.bi)).length : 0;
    const text = g
      .map((x) => (hlBlocks?.has(x.bi) ? `${x.text}\n▲用户高亮` : x.text))
      .join('\n');
    return { from: g[0].bi, to: g[g.length - 1].bi, text, hlCount };
  });
}

/** 采集一个窗口。 */
async function collectWindow(args: {
  docTitle: string;
  headingPath: string[];
  unitTitle: string;
  index: number;
  total: number;
  window: UnitWindow;
  temperature: number;
}): Promise<WindowItemsShape> {
  const p = cheatsheetV3WindowPrompt({
    docTitle: args.docTitle,
    headingPath: args.headingPath,
    unitTitle: args.unitTitle,
    index: args.index,
    total: args.total,
    text: args.window.text,
    hlCount: args.window.hlCount,
  });
  const shape = await chatJson<WindowItemsShape>(
    [
      { role: 'system', content: p.system },
      { role: 'user', content: p.user },
    ],
    {
      label: `「${args.unitTitle}」第 ${args.index}/${args.total} 段采集`,
      temperature: args.temperature,
      maxTokens: 16_000,
      timeoutMs: 240_000,
      // ★ 关思考：思维链与正文共享 max_tokens（实测会吃满导致正文 0 字）
      thinking: false,
      validate: (v) => {
        const o = v as Partial<WindowItemsShape> | null;
        if (!o || typeof o !== 'object') return '返回的不是对象';
        if (!Array.isArray(o.propositions)) return 'propositions 不是数组';
        return null;
      },
    },
  );
  // 提示词说「最多 8 条命题」，但模型不一定听。这里再兜一层硬的：
  // 只要有一个窗口失控，整体长度就会被它带崩（实测过一次：9 个窗口交上来 243 条，
  // 整理出来的小抄比原文还长两倍，那已经不是小抄了）。
  const cap = (arr: unknown[], n: number) => arr.slice(0, n);
  return {
    propositions: cap((shape.propositions ?? []).filter((x) => x && x.subject && x.object), 12) as CheatsheetProposition[],
    entries: cap((shape.entries ?? []).filter((x) => x && x.text), 10) as CheatsheetEntry[],
    terms: cap((shape.terms ?? []).filter((x) => x && x.term), 8) as CheatsheetTerm[],
  };
}

/**
 * 跨窗口的确定性去重：**只看引文**。
 *
 * 同一句原文被两个窗口各写了一条，就是同一件事说两遍——留信息更全的那条。
 * 这一步在调合并模型之前做，能省掉不少 token，也让合并模型少犯一次错。
 */
function dedupeByQuote<T extends { quote?: string }>(items: T[], keepLonger: (a: T, b: T) => T): T[] {
  const kept: T[] = [];
  for (const it of items) {
    const q = (it.quote ?? '').trim();
    const hit = q ? kept.findIndex((k) => isDuplicateQuote(k.quote ?? '', q)) : -1;
    if (hit < 0) kept.push(it);
    else kept[hit] = keepLonger(kept[hit], it);
  }
  return kept;
}

/* ────────────────────────────────────────────────────────────────────────────
 * ★ 2026-09-20 接进校验层的两条判据（R1 / R4）★
 *
 * 来源不是拍脑袋：scripts/vet-rules-probe.ts 先把 5 条候选判据放在**存量**上试跑，
 * 用她已经做过的 146 条标注（eval-set）当验收集算命中与误伤，结果落
 * .local/probe-out/vet-rules.txt：
 *
 *   R1 【数值】类型误判      精确率 100%（3/3），0 误伤        → 接
 *   R4 专名作主语陈述产品事实 收紧后 100%（6/6），0 误伤        → 接
 *   R2 疑问句改写成断言      缺陷明确但无标注可验（思考题节）    → 暂不接
 *   R3 同节 dice 重复        精确率 0%（误伤她 ▲ 的两条）      → 废弃
 *   R5 照抄原文              精确率 4%（36 命中 22 误伤）      → 废弃
 *
 * ★ 为什么放校验层而不是提示词 ★
 *   写进提示词 = 改了规则必须全量重生成（约 15 次调用 / 3 分钟），而且会把她 ▲ 的
 *   那 85% 也重写一遍；写进判据是 0 次调用，且只动被判中的条目。
 *   反过来，判据只能修「硬错误」——召回实测只有 36%，剩下 2/3（容器没位置、
 *   总结落点错、跨节冗余、大白话）判据写不出来，仍然只能改提示词。**两者是分工，
 *   不是二选一。**
 *
 * ⚠️ 专名表的适用边界 ⚠️
 *   只在 chapter1（AI-Agent-Book）标定过。整篇以某个产品为主题的文档里
 *   （例如「居丽叶 14 Kimi K3」），Kimi 是主题不是例证，会被误判。
 *   兜底是回收站：被判中的条目**留全尸**可 ▲ 复活，不会真的丢。
 * ──────────────────────────────────────────────────────────────────────────── */

/** 产品 / 模型专名。只在 chapter1 标定过，别当成通用词表。 */
const PROPER_NOUNS = [
  'Manus', 'OpenClaw', 'Kimi', 'K3', 'GPT', 'Qwen', 'Formula', 'LangChain',
  'Claude', 'Gemini', 'DeepSeek', 'Deep Research', 'Responses API', 'Computer Use',
  'My Computer', 'Anthropic', 'OpenAI', '百炼', '通义', '智谱',
];

/**
 * 机制词：句子在描述一个**可迁移的机制**，专名只是它的例证 → 不判。
 * 这条豁免是 v1 跑完加的：v1 误伤了她 ▲ 的
 * `GPT-5.6 接到研究需求后不立即动手，先通过提问澄清意图…`
 * 主语虽然是专名，但断言的是「意图澄清」这个机制，换任何模型都成立。
 */
const MECHANISM =
  /(并不|而非|反而|而是|先(?!是)|使(?:得|其)|让[^人]|因为|所以|意味着|本质上|关键在|取决于|不再|才(?:能|会)|无法|不可能|通过)/;

/** 产品自身属性陈述：发布 / 拥有 / 参数 / 版本 / 日期 / 计数。 */
const PRODUCT_FACT =
  /(发布|推出|上线|拥有|提供|支持|列出|内置|兼容|集成|覆盖|[0-9０-９]+ *(?:万|亿|个|种|次|轮|组|bit|token)|20[0-9０-９]{2} *年|[0-9０-９]+ *月|[0-9０-９.]+ *万亿|[0-9０-９]+ *～)/;

/** 定义句式标志：出现这些词的条目几乎不可能是【数值】 */
const DEF_MARK = /(是指|指的是|被称[为之]|定义为|泛指|特指|即(?!使|将|可|便))/;
const HAS_DIGIT = /[0-9０-９]/;

/**
 * R4：专名作主语 **且** 陈述产品自身事实 → 例证冒充了知识点。
 * 返回作主语的那个专名；不该判则返回 null。
 *
 * 两个排除条件任一成立就不判：
 *   ① 含机制词 → 专名只是机制的例证，她会 ▲
 *   ② 不含产品属性陈述 → 拿专名举例而已，不是产品卡
 *
 * 术语层整层豁免：她 ▲ 了 MCP / MoE / Responses API 这些术语，
 * 专名在术语层是概念锚点，不是句子的主语。
 */
export function properNounSubject(text: string): string | null {
  const t = (text ?? '').trim();
  if (!t) return null;
  const hit = PROPER_NOUNS.find((n) => t.slice(0, 24).includes(n));
  if (!hit) return null;
  if (MECHANISM.test(t)) return null;
  if (!PRODUCT_FACT.test(t)) return null;
  return hit;
}

/**
 * R1：【数值】条目却没有数字 / 写成了定义句式 → 类型判据错了。
 *
 * ★ 处置是「改判」不是「删」★
 *   她的原话是「这个不是没有用，很有用，应该不是数值而是定义」——
 *   内容是对的，只是放错了类型。删掉等于丢内容，违反本项目
 *   「只丢引文不丢内容」的原则。所以返回值是**改判后的类型**。
 */
export function misTypedNumeric(e: { kind?: string; text?: string }): '定义' | null {
  if (e.kind !== '数值') return null;
  const t = (e.text ?? '').trim();
  if (!t) return null;
  if (DEF_MARK.test(t)) return '定义';
  if (!HAS_DIGIT.test(t)) return '定义';
  return null;
}

/**
 * R2：原文在提问，条目却写成了断言（思考题节 5/5 中招）。
 *
 * ★ 处置是「标记」不是「删」★
 *   两条理由，任一条单独就够：
 *   ① 那一节 5 条全中，删光会让整节变空 → 覆盖率 0% → 触发补采，
 *      而补采出来的还是同样的东西，白花一次调用。
 *   ② 这条判据**分不清设问和开放式提问**：「什么是上下文工程？」后面紧跟答案时，
 *      条目写答案是完全正确的，只是 quote 恰好落在问句上。判据没有原文上下文，
 *      拿不到「问句后面有没有答案」这个信号。
 *   判据不确定时，用标记（可见、可推翻、零丢失）代替删除。
 *   标记落在 item.fromQuestion，呈现层给一颗「?」徽章。
 *
 * ★ 全库实测 6 条命中，正好两种都有（scripts/vet-rules-probe.ts）★
 *     真失真 5 条：原文问「在什么场景下反而优于开放式？」「怎样以更低成本提供 c_t？」
 *       「多条规则同时适用时该如何选择？」——条目全都答非所问地写成了结论。
 *     误伤 1 条：原文「为什么要做量化？」→ 条目「做量化的三个理由：…」。
 *       这是**设问**，给理由就是正确答案，判据却照样命中。
 *   → 1/6 的误伤率，拿去删就是实打实丢一条有用的；拿去标记只多一个问号。
 */
const Q_END = /[?？]\s*$/;
export function questionTurnedAssertion(text: string, quote: string): boolean {
  if (!quote || !text) return false;
  return Q_END.test(quote.trim()) && !Q_END.test(text.trim());
}

/** 判据复核：引文必须能在原文定位，命题不许同义反复。返回通过的和被丢掉的条数。 */
// 导出理由与 coverage 相同：回收站的「裁了什么、为什么裁」是纯函数行为，
// 探针（scripts/recycle-bin-probe.ts）直接调它做判据回归，不用真跑模型。
export function vetItems(
  props: CheatsheetProposition[],
  entries: CheatsheetEntry[],
  terms: CheatsheetTerm[],
  opts: { hit: (q: string) => boolean },
): {
  propositions: CheatsheetProposition[];
  entries: CheatsheetEntry[];
  terms: CheatsheetTerm[];
  dropped: number;
  /** ★ 被裁条目留全尸 ★ 进回收站（sec.dropped），用户可 ▲ 复活 / ▽⧉ 确认裁决 */
  droppedItems: CheatsheetDropped[];
} {
  const droppedItems: CheatsheetDropped[] = [];
  const okProps = props.filter((p) => {
    // ★ 关系闭集：能同义归一的归一（等价于→等价、前提条件→前提是）★
    //   归一不了的**保留原词**而不是丢弃 —— 实测 chapter2 有「[决定] 上下文质量 →
    //   Agent 的能力上限」这种整章论点级的命题，删了就是丢内容，违反
    //   「只丢引文不丢内容」的本项目原则。呈现层给闭集外的词标 warn 色，
    //   一眼能看出来；要不要扩闭集（比如加个「影响」）是另一个决策。
    const rel = normalizeRel(p.rel ?? '');
    if (rel && rel !== p.rel) p.rel = rel;
    if (isTautology(p.subject, p.object)) {
      droppedItems.push({ layer: '命题', reason: '同义反复', item: p });
      return false;
    }
    // ★ R4：专名作主语陈述产品自身事实 = 例证冒充知识点 ★
    //   进回收站而不是直接没：留全尸可 ▲ 复活（专名表只在 chapter1 标定过，
    //   换到以产品为主题的文档上会误判，回收站是兜底）。
    const pn = properNounSubject(p.statement ?? '');
    if (pn) {
      droppedItems.push({ layer: '命题', reason: `专名「${pn}」陈述产品自身事实（例证冒充知识点）`, item: p });
      return false;
    }
    if (p.quote && !opts.hit(p.quote)) {
      // 引文定位不到：**不丢内容，只丢引文**（内容仍然有用，只是不能回跳）
      p.quote = '';
    }
    // ★ R2：原文是疑问句、这条写成了断言 → 打标记，保留 ★
    if (questionTurnedAssertion(p.statement ?? '', p.quote ?? '')) p.fromQuestion = true;
    return true;
  });
  const okEntries = entries.filter((e) => {
    const q = (e.quote ?? '').trim();
    if (q && !opts.hit(q)) {
      e.quote = '';
    }
    // 速查条目允许比命题的引文短（等式本身就短，例如 `Agent = Model + Harness`）
    if (!e.text.trim() || isShortQuote(e.text)) {
      droppedItems.push({ layer: '条目', reason: '空条目或过短', item: e });
      return false;
    }
    // ★ R4：同命题层 ★
    const pn = properNounSubject(e.text ?? '');
    if (pn) {
      droppedItems.push({ layer: '条目', reason: `专名「${pn}」陈述产品自身事实（例证冒充知识点）`, item: e });
      return false;
    }
    // ★ R1：【数值】类型判据错 → 改判【定义】，不删 ★
    //   她对这些条目的原话是「很有用，应该不是数值而是定义」——
    //   内容没问题，只是类型放错了。删掉就是丢内容。
    const fix = misTypedNumeric(e);
    if (fix) e.kind = fix;
    // ★ R2：原文是疑问句、这条写成了断言 → 打标记，保留（理由见判据注释）★
    if (questionTurnedAssertion(e.text ?? '', q)) e.fromQuestion = true;
    return true;
  });

  // ★ 术语也要过判据 ★
  // 以前这里根本不管 terms —— 于是它既没有引文（0% 能回跳）、还在同一节里重名
  // （实测 chapter2：KV Cache 出现 6 次、渐进式披露 3 次）。
  // 现在：同名只留一条；引文定位不到就清空，交给呈现层回原文找术语名首次出现的位置。
  const seenTerm = new Set<string>();
  const okTerms = terms.filter((t) => {
    const name = (t.term ?? '').trim();
    if (!name) {
      droppedItems.push({ layer: '术语', reason: '术语名为空', item: t });
      return false;
    }
    if (seenTerm.has(name)) {
      droppedItems.push({ layer: '术语', reason: '术语重名', item: t });
      return false;
    }
    seenTerm.add(name);
    const q = (t.quote ?? '').trim();
    if (q && !opts.hit(q)) t.quote = '';
    return true;
  });

  // 4) 一条信息只出现一次：命题陈述与速查条目整句重复的，按规则二选一
  //    （【定义】旁边再放一条「—属于→」的命题，读起来就是原地打转）
  const slim = dedupePropsAgainstEntries({ propositions: okProps, entries: okEntries });
  for (const p of slim.droppedProps) droppedItems.push({ layer: '命题', reason: '与速查条目整句重复', item: p });
  for (const e of slim.droppedEntries) droppedItems.push({ layer: '条目', reason: '与命题重复', item: e });

  // 5) 条目之间再收一遍：清单句是定义句的子句，读起来也是原地打转
  const slim2 = dedupeEntriesAgainstEntries(slim.entries);
  for (const e of slim2.dropped) droppedItems.push({ layer: '条目', reason: '条目间重复', item: e });

  return {
    propositions: slim.propositions,
    entries: slim2.entries,
    terms: okTerms,
    dropped: droppedItems.length,
    droppedItems,
  };
}

/**
 * 三件套的统称——补采、覆盖率、高亮判断都按这个形状消费条目。
 */
type Items = {
  propositions: CheatsheetProposition[];
  entries: CheatsheetEntry[];
  terms: CheatsheetTerm[];
};

/**
 * ★ 合并要不要分批、一批多大 —— 全部是量出来的，不是拍的 ★
 *
 * 2026-09-17 做了两组严格对照（同一份采集结果、只换合并策略；见
 * scripts/cheatsheet-merge-probe.ts，输入取自 chapter3「超越扁平文本」）：
 *
 *   节规模                单点收口   两级归并   合并调用
 *   12 窗 / 145 条 / 33k    58%       59%      1 → 4
 *   24 窗 / 268 条 / 60k    72%       75%      1 → 12
 *      位置分布：72/100/83/47/58 → 83/95/83/42/74（尾部 +16 个点）
 *
 * 结论：
 *   1. 短节（≤33k 字符）分层**没有收益**（+1 个点），却要 4 倍调用 → 不该分批。
 *   2. 长节（60k）分层有效（+3 个点，尾部 +16，条目 162 → 178）→ 该分批。
 *   3. 所以「什么时候分批」和「一批多大」是两件事，必须分开：
 *      触发线设两组实测之间；批粒度取已经验证过质量的那一档。
 */
const MERGE_TRIGGER_CHARS = 40_000;

/**
 * 一批最多多少字符（批层粒度）。
 *
 * 12k/批（3 批、保留 0.85×）的质量已经验证过；放到 20k 是为了省调用
 * （60k 的节 3 批而不是 6 批），代价是每批更长、后段风险回升 —— 所以它是上限不是目标。
 */
const MERGE_BATCH_CHARS = 20_000;

/**
 * ★ 顶层预算要比批层宽 ★
 *   批层已经压过一遍（重复少了），而且顶层本来就要输出「最终条数」那么多东西 ——
 *   把输入再细分一遍并不会让输出变少，只会多花调用。
 */
const MERGE_TOP_CHARS = 45_000;

/** 批层最多归并几轮（轮数 0 = 顶层一次装得下，短节行为与单层合并逐字一致）。 */
const MAX_MERGE_ROUNDS = 2;

/**
 * ★ 兜底阈值按「正常情况」定，不按「最坏情况」★
 *   采集本来就偏多，合并把一半以上压掉是正常的（设 0.6 时减法全被挡回去，
 *   9 个窗口 243 条原样留下、小抄 2.2× 原文）。压到四成以下才是「在删信息」。
 */
const MERGE_KEEP_RATIO = 0.4;

/** 按 JSON 字符预算分组。单条超预算也让它独占一组，否则永远装不下、死循环。 */
function packByBudget(items: Items[], maxChars: number): Items[][] {
  const out: Items[][] = [];
  let cur: Items[] = [];
  let len = 0;
  for (const it of items) {
    const n = JSON.stringify(it).length;
    if (cur.length && len + n > maxChars) {
      out.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(it);
    len += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

/**
 * 给探针用：这份采集结果会分成几批（1 = 没到触发线，走单点收口那条路）。
 * 口径直接调 packByBudget，探针不许自己再算一遍——否则又是「探针说 3 批、管道说 1 批」。
 */
export function mergeBatchCount(
  inputs: WindowItemsShape[],
  opts: { batchChars?: number; triggerChars?: number } = {},
): number {
  const items = inputs as Items[];
  if (packByBudget(items, opts.triggerChars ?? MERGE_TRIGGER_CHARS).length <= 1) return 1;
  return packByBudget(items, opts.batchChars ?? MERGE_BATCH_CHARS).length;
}

/** 当前的分批参数（探针展示用，避免探针里再抄一份数字）。 */
export const MERGE_LIMITS = {
  trigger: MERGE_TRIGGER_CHARS,
  batch: MERGE_BATCH_CHARS,
  top: MERGE_TOP_CHARS,
  maxRounds: MAX_MERGE_ROUNDS,
} as const;

/**
 * 跨输入的确定性合并：同引文只留一条（留信息更全的）+ 术语同名的取释义更全的。
 *
 * 一次合并调用失败或收得太狠时的**回退结果**就是这个 —— 只做减法的机器版，
 * 不会丢具体信息（这正是「宁多勿少」要的兜底）。
 */
function deterministicMerge(inputs: Items[]): Items {
  const propositions = dedupeByQuote(
    inputs.flatMap((x) => x.propositions),
    (a, b) => ((b.statement ?? '').length > (a.statement ?? '').length ? b : a),
  );
  const entries = dedupeByQuote(
    inputs.flatMap((x) => x.entries),
    (a, b) => ((b.text ?? '').length > (a.text ?? '').length ? b : a),
  );
  const seen = new Map<string, CheatsheetTerm>();
  for (const t of inputs.flatMap((x) => x.terms)) {
    const key = t.term.trim().toLowerCase();
    const prev = seen.get(key);
    if (!prev) {
      seen.set(key, t);
      continue;
    }
    // 同名取释义更全的那条；引文谁有就带谁（两边都有则留更长的）
    const richer = (t.meaning ?? '').length > (prev.meaning ?? '').length;
    const pick = richer ? t : prev;
    const other = richer ? prev : t;
    const quote = (pick.quote ?? '').length >= (other.quote ?? '').length ? pick.quote : other.quote;
    seen.set(key, { ...pick, quote: quote ?? '' });
  }
  return { propositions, entries, terms: [...seen.values()] };
}

/**
 * 合并层的「真丢」检测：base 里有、输出里认不出来的条目。
 *
 * ★ 为什么不能只按 hash 找 ★
 *   合并模型经常**改写后保留**（把三条归并成一条改写版）——只按 hash 找，
 *   被吸收的也算丢，回收站会被误报淹没。所以两步：
 *   ① hash 完全一致 → 保留（没丢）；
 *   ② 相似判据（dice≥0.75 / 覆盖率≥0.9，与条目去重同一套、等式/数值豁免）
 *      找得到「吸收者」→ 视为被改写保留，不算丢；
 *   ③ 都找不到 → 真丢了，留全尸进回收站。
 */
// 导出理由与 coverage 相同：纯函数，探针直接回归「改写保留不算丢」的判据。
export function mergeDrops(base: Items, out: Items): CheatsheetDropped[] {
  const outTexts = [
    ...out.propositions.map((p) => p.statement ?? ''),
    ...out.entries.map((e) => e.text ?? ''),
  ].map((t) => t.trim());
  const outHashes = new Set(outTexts.map(itemKeyOf));
  const drops: CheatsheetDropped[] = [];

  /** 命题的吸收判据：合并改写几乎总会保留**主语概念**（这是归并的锚点），
   *  所以主语还在 + 陈述相似度不低 = 被吸收；主语都不在了才是真丢。
   *  只按 dice 量改写会大量误报（实测改写句 dice 掉到 0.5 上下）。 */
  const outSubjects = out.propositions.map((p) => (p.subject ?? '').trim());
  const absorbedProp = (p: CheatsheetProposition): boolean => {
    const st = (p.statement ?? '').trim();
    if (outHashes.has(itemKeyOf(st))) return true;
    const subj = (p.subject ?? '').trim();
    const subjKept = subj.length >= 2 && outSubjects.some((s) => s.includes(subj) || subj.includes(s));
    for (const t of outTexts) {
      const short = st.length <= t.length ? st : t;
      const long = short === st ? t : st;
      if (coverage(short, long) >= 0.9 || dice(st, t) >= 0.75) return true;
      if (subjKept && dice(st, t) >= 0.35) return true;
    }
    return subjKept;
  };

  /** 条目没有主语概念，仍用去重层同款判据；等式/数值只认精确 hash
   *  （骨架相同语义不同的假阳性在去重层实测过，不能放宽）。 */
  const absorbedEntry = (text: string): boolean => {
    if (outHashes.has(itemKeyOf(text))) return true;
    for (const t of outTexts) {
      if (/(=|\d)/.test(text) && /(=|\d)/.test(t)) continue;
      const short = text.length <= t.length ? text : t;
      const long = short === text ? t : text;
      if (coverage(short, long) >= 0.9 || dice(text, t) >= 0.75) return true;
    }
    return false;
  };

  for (const p of base.propositions) {
    if (!absorbedProp(p)) drops.push({ layer: '命题', reason: '合并归并未保留', item: p });
  }
  for (const e of base.entries) {
    if (!absorbedEntry((e.text ?? '').trim())) drops.push({ layer: '条目', reason: '合并归并未保留', item: e });
  }
  const outTerms = new Set(out.terms.map((t) => (t.term ?? '').trim()));
  for (const t of base.terms) {
    if (!outTerms.has((t.term ?? '').trim())) drops.push({ layer: '术语', reason: '合并归并未保留', item: t });
  }
  return drops;
}

/**
 * 一次合并调用。批内归并和顶层收口共用，只有提示词形态和「写不写 focus/gist」不同。
 *
 * 失败不抛：回退到 `deterministicMerge` 的结果（合并是优化环节，绝不能把整节搞崩）。
 */
async function mergeOnce(args: {
  inputs: Items[];
  docTitle: string;
  headingPath: string[];
  unitTitle: string;
  temperature: number;
  label: string;
  /** 传了就是「批内归并」（不写 focus/gist） */
  batch?: { index: number; total: number };
  /** 输入来自上一级归并 */
  fromMerge?: boolean;
}): Promise<{ items: Items; focus: string; gist: string; fallback: boolean; ok: boolean; dropped: CheatsheetDropped[] }> {
  const base = deterministicMerge(args.inputs);
  try {
    const mp = cheatsheetV3MergePrompt({
      docTitle: args.docTitle,
      headingPath: args.headingPath,
      unitTitle: args.unitTitle,
      collected: args.inputs,
      batch: args.batch,
      fromMerge: args.fromMerge,
    });
    const merged = await chatJson<{
      focus?: string;
      gist?: string;
      propositions?: CheatsheetProposition[];
      entries?: CheatsheetEntry[];
      terms?: CheatsheetTerm[];
    }>(
      [
        { role: 'system', content: mp.system },
        { role: 'user', content: mp.user },
      ],
      {
        label: args.label,
        temperature: 0.1,
        maxTokens: 16_000,
        timeoutMs: 240_000,
        thinking: false,
        validate: (v) => {
          const o = v as { propositions?: unknown } | null;
          if (!o || typeof o !== 'object') return '返回的不是对象';
          if (!Array.isArray(o.propositions)) return 'propositions 不是数组';
          return null;
        },
      },
    );

    const inCount = base.propositions.length + base.entries.length;
    const outCount = (merged.propositions?.length ?? 0) + (merged.entries?.length ?? 0);
    if (inCount > 0 && outCount < inCount * MERGE_KEEP_RATIO) {
      // 掉得太多 = 它在精简而不是合并：只采用 focus/gist，条目回退到确定性结果
      // （条目用的是 base 本身，一条没丢 → 回收站为空）
      return { items: base, focus: merged.focus ?? '', gist: merged.gist ?? '', fallback: true, ok: true, dropped: [] };
    }
    const keptTerms = (merged.terms ?? []).filter((x) => x && x.term);
    const items: Items = {
      propositions: (merged.propositions ?? []).filter((x) => x && x.subject && x.object),
      entries: (merged.entries ?? []).filter((x) => x && x.text),
      terms: keptTerms.length ? keptTerms : base.terms,
    };
    return {
      items,
      focus: merged.focus ?? '',
      gist: merged.gist ?? '',
      fallback: false,
      ok: true,
      dropped: mergeDrops(base, items),
    };
  } catch {
    return { items: base, focus: '', gist: '', fallback: true, ok: false, dropped: [] };
  }
}


/** 取出所有带引文的条目（覆盖率高亮判断只看引文）。 */
function quotesOf(it: Items): { quote?: string }[] {
  return [...it.propositions, ...it.entries, ...it.terms];
}

/** 一组条目的规模（三层加起来）。分批预算和「保留率」都看这个数。 */
const countOf = (it: Items): number => it.propositions.length + it.entries.length + it.terms.length;
/** 一批（若干组）的规模。 */
const countAll = (arr: Items[]): number => arr.reduce((s, x) => s + countOf(x), 0);

/**
 * 把补采结果**确定性**并入已有集合。返回是否真的补进了新内容。
 *
 * 为什么不用模型合并：补采是「补缺」，两边的引文本来就是不同位置的原文，
 * 同引文去重 + 术语同名取释义更全的，已经够了；再调一次模型只会引入不确定性。
 */
function mergeBackfillInto(cur: Items, extra: Items): boolean {
  const before = cur.propositions.length + cur.entries.length;
  cur.propositions = dedupeByQuote(
    [...cur.propositions, ...extra.propositions],
    (a, b) => ((b.statement ?? '').length > (a.statement ?? '').length ? b : a),
  );
  cur.entries = dedupeByQuote(
    [...cur.entries, ...extra.entries],
    (a, b) => ((b.text ?? '').length > (a.text ?? '').length ? b : a),
  );
  const seen = new Map<string, CheatsheetTerm>();
  for (const t of [...cur.terms, ...extra.terms]) {
    const k = t.term.trim().toLowerCase();
    const prev = seen.get(k);
    if (!prev || (t.meaning ?? '').length > (prev.meaning ?? '').length) seen.set(k, t);
  }
  cur.terms = [...seen.values()];
  return cur.propositions.length + cur.entries.length > before;
}

/**
 * 开一个补采窗口：把指定的块重新采一遍，过完判据返回。
 *
 * ★ 补采的两个消费者 ★
 *   1) 高亮覆盖兜底 —— 用户划的重点不许漏（markHl = true）
 *   2) 覆盖率质量门 —— 全节漏得离谱时补孤立漏块（markHl = false）
 *   两者只是「补哪些块、要不要打高亮标记」不同，其余完全一样，所以共用这里。
 *
 * 失败返回 null（补采是兜底，绝不能因为它把整节生成搞崩）。
 */
async function backfillWindow(args: {
  chunk: Block[];
  markHl: boolean;
  docTitle: string;
  headingPath: string[];
  unitTitle: string;
  index: number;
  total: number;
  temperature: number;
  hitQuote: (q: string) => boolean;
}): Promise<Items | null> {
  if (!args.chunk.length) return null;
  try {
    const raw = await collectWindow({
      docTitle: args.docTitle,
      headingPath: args.headingPath,
      unitTitle: args.unitTitle,
      index: args.index,
      total: args.total,
      window: {
        from: args.chunk[0].bi,
        to: args.chunk[args.chunk.length - 1].bi,
        text: args.chunk.map((x) => (args.markHl ? `${x.text}\n▲用户高亮` : x.text)).join('\n'),
        hlCount: args.markHl ? args.chunk.length : 0,
      },
      temperature: args.temperature,
    });
    const vetted = vetItems(raw.propositions, raw.entries, raw.terms, { hit: args.hitQuote });
    return { propositions: vetted.propositions, entries: vetted.entries, terms: vetted.terms };
  } catch {
    return null;
  }
}

export async function runCheatsheetV3(args: {
  blocks: Block[];
  unit: StudyUnit;
  headingPath: string[];
  docTitle: string;
  /** 用于把 quote 定位回原文；返回 false 表示定位不到 */
  hitQuote: (quote: string) => boolean;
  /** 把 quote 精确定位到起始块号；高亮覆盖判断和补采要用。没传就跳过高亮兜底。 */
  locateQuote?: (quote: string) => number | null;
  /** 用户高亮落到的块号 → 颜色。没有高亮（或没传）时管道行为和原来完全一样。 */
  hlBlocks?: Map<number, string>;
  temperature?: number;
  maxChars?: number;
  /**
   * 合并策略。'hier'（默认）= 长节分批两级归并；'single' = 老的单点收口。
   * 'single' 只用于对照实验（探针里跟 'hier' 跑同一份采集结果比质量）。
   */
  mergeMode?: 'hier' | 'single';
  /** 覆盖分批参数（探针标定用；生产走实测确定的那组默认值，见文件顶部的常量注释）。 */
  mergeTriggerChars?: number;
  mergeBatchChars?: number;
  mergeTopChars?: number;
  /**
   * 直接喂采集结果、跳过采集调用。探针用：**同一份采集结果**跑两种合并策略，
   * 唯一变量才是「分层」——否则两次采集的模型随机性会盖过要量的差别。
   */
  collectedOverride?: WindowItemsShape[];
  /**
   * 采集完（合并前）回调一次。探针用它把**采集结果**存盘，之后可以零成本重放
   * 不同的合并策略（配合 collectedOverride）——采集是本管道里最贵的一步。
   */
  onCollected?: (items: WindowItemsShape[]) => void;
  onStep?: (msg: string) => void;
}): Promise<CheatsheetV3Output> {
  const windows = splitUnitWindows(args.blocks, args.unit, {
    maxChars: args.maxChars,
    hlBlocks: args.hlBlocks,
  });
  if (!windows.length) {
    return {
      focus: '',
      gist: '',
      propositions: [],
      entries: [],
      terms: [],
      dropped: [],
      stats: { windows: 0, calls: 0, collected: 0, dropped: 0, mergeFallback: false, mergeRounds: 0, catalogRatio: 0, blocks: 0, covered: 0, gateBackfill: 0 },
    };
  }

  args.onStep?.(`这一段比较长，拆成 ${windows.length} 段分别整理…`);

  let calls = 0;
  const collected =
    args.collectedOverride?.length
      ? args.collectedOverride
      : await mapLimit(windows, 3, async (w, i) => {
          calls++;
          return collectWindow({
            docTitle: args.docTitle,
            headingPath: args.headingPath,
            unitTitle: args.unit.headingText,
            index: i + 1,
            total: windows.length,
            window: w,
            temperature: args.temperature ?? 0.2,
          });
        });

  const rawCount =
    collected.reduce((s, c) => s + c.propositions.length + c.entries.length, 0) + 0;
  args.onCollected?.(collected);

  // 1) 确定性去重 / 2) 合并模型
  //    ★ 长节分批两级归并（2026-09-17）★
  //    以前是「所有窗口一次塞进合并调用」：12 窗 = 3~4 万字输入 / 16k 输出上限，
  //    这跟 V2 那个「输出预算被前段吃掉」是同一个病，只是搬到了合并层 ——
  //    前面几段合并得细、后面几段直接抄过来，漏的位置照样单调递减。
  //    现在：一组装不下就先按预算分组、每组各归并一遍（批内归并，不写 focus/gist），
  //    顶层再收口一次。短节（一组装得下）走的是原来那条路径，行为不变。
  let focus = '';
  let gist = '';
  let propositions: CheatsheetProposition[] = [];
  let entries: CheatsheetEntry[] = [];
  let terms: CheatsheetTerm[] = [];
  let mergeFallback = false;
  /** 批内归并做了几轮（0 = 顶层一次装得下，没分批） */
  let mergeRounds = 0;
  let mergeCalls = 0;
  /** ★ 各轮合并「真丢」的条目（改写保留的不算，见 mergeDrops）★ */
  const mergeDropped: CheatsheetDropped[] = [];

  const nonEmpty = (c: Items) => c.propositions.length + c.entries.length > 0;
  if (collected.length > 1 || collected.some(nonEmpty)) {
    let cur: Items[] = collected.map((c) => ({
      propositions: c.propositions,
      entries: c.entries,
      terms: c.terms,
    }));

    // 2a) 批内归并：先分组各归一遍，直到顶层一次能收口
    // 'single' 模式下两个预算都是无穷大 —— 等于永远不分批，就是改版前那条路径
    const one = Number.POSITIVE_INFINITY;
    const single = args.mergeMode === 'single';
    const topBudget = single ? one : (args.mergeTopChars ?? MERGE_TOP_CHARS);
    const trigger = single ? one : (args.mergeTriggerChars ?? MERGE_TRIGGER_CHARS);
    const batchChars = args.mergeBatchChars ?? MERGE_BATCH_CHARS;
    for (;;) {
      // ★ 没到触发线就不分批（实测：短节分批只会多花调用，质量还略降）★
      if (packByBudget(cur, trigger).length <= 1) break;
      // 顶层预算宽得多：批层压过一遍后顶层一次就能收口的话，别再分批
      if (packByBudget(cur, topBudget).length <= 1) break;
      if (mergeRounds >= MAX_MERGE_ROUNDS) break;
      const packs = packByBudget(cur, batchChars);
      args.onStep?.(`条目较多，分 ${packs.length} 批先各归并一遍，再统一收口…`);
      const done = await mapLimit(packs, 2, async (g, i) => {
        const r = await mergeOnce({
          inputs: g,
          docTitle: args.docTitle,
          headingPath: args.headingPath,
          unitTitle: args.unit.headingText,
          temperature: 0.1,
          label: `「${args.unit.headingText}」分批归并 ${i + 1}/${packs.length}`,
          batch: { index: i + 1, total: packs.length },
          fromMerge: mergeRounds > 0,
        });
        // ★ 保留率是批层唯一该看的指标 ★
        //   批层只该去重，不该做取舍 —— 实测它一砍到 50% 以下，最终覆盖率就掉。
        //   打出来才能在长节生成时发现「这一批又在越权删东西」。
        const inN = countAll(g);
        const outN = countOf(r.items);
        args.onStep?.(
          `  第 ${i + 1}/${packs.length} 批：${inN} 条 → ${outN} 条` +
            `（保留 ${(inN ? outN / inN : 1).toFixed(2)}×${r.fallback ? '，已回退' : ''}）`,
        );
        return r;
      });
      mergeRounds++;
      mergeCalls += packs.length;
      if (done.some((d) => d.fallback)) mergeFallback = true;
      for (const d of done) mergeDropped.push(...d.dropped);
      cur = done.map((d) => d.items);
    }

    // 2b) 顶层收口：跨组去重 + 写 focus / gist
    const top = await mergeOnce({
      inputs: cur,
      docTitle: args.docTitle,
      headingPath: args.headingPath,
      unitTitle: args.unit.headingText,
      temperature: 0.1,
      label: `「${args.unit.headingText}」合并 ${cur.length} 组`,
      fromMerge: mergeRounds > 0,
    });
    mergeCalls++;
    if (top.fallback) mergeFallback = true;
    mergeDropped.push(...top.dropped);
    focus = top.focus;
    gist = top.gist;
    propositions = top.items.propositions;
    entries = top.items.entries;
    terms = top.items.terms;
  }
  calls += mergeCalls;

  // 3) 判据复核（引文定位 / 同义反复 / 术语重名 / 空条目 / 整句重复）
  const vetted = vetItems(propositions, entries, terms, { hit: args.hitQuote });

  // 4) ★ 用户高亮的覆盖兜底（补采）★
  //    高亮是用户亲手划的重点，漏了就是缺陷。但高亮块可能落在窗口交界、
  //    或者被合并模型当冗余压掉——所以用判据算一遍：哪些高亮块没有任何条目的
  //    引文落在上面，把这些块单独开一个补采窗口。只补缺的、最多一次调用。
  const final: Items = {
    propositions: [...vetted.propositions],
    entries: [...vetted.entries],
    terms: [...vetted.terms],
  };
  let backfill = false;
  let hlTotal = 0;
  let hlCovered = 0;
  /** 补采窗口的编号接着采集窗口往后排，提示词里「第 X 段（共 Y 段）」才连贯。 */
  let extraSeq = windows.length;

  if (args.hlBlocks?.size && args.locateQuote) {
    const locate = (q: string) => args.locateQuote!(q);
    const inUnit = [...args.hlBlocks.keys()].filter(
      (bi) => bi >= args.unit.startBi && bi < args.unit.endBi,
    );
    hlTotal = inUnit.length;
    if (inUnit.length) {
      const missing = inUnit.filter((bi) => !coveredBlocks(quotesOf(final), args.blocks, locate).has(bi));
      if (missing.length) {
        args.onStep?.(`有 ${missing.length} 处你标注过的重点还没被覆盖，补采一次…`);
        const bfBlocks = args.blocks
          .slice(missing[0], missing[missing.length - 1] + 1)
          .filter((b) => b.text.trim().length > 0 && args.hlBlocks!.has(b.bi));
        // 补采窗口也设上限，防止用户把整节都高亮了导致一次调用塞不下
        const capped = bfBlocks.slice(0, Math.ceil(SEGMENT_MAX_CHARS / 120));
        const extra = await backfillWindow({
          chunk: capped,
          markHl: true,
          docTitle: args.docTitle,
          headingPath: args.headingPath,
          unitTitle: args.unit.headingText,
          index: ++extraSeq,
          total: extraSeq,
          temperature: args.temperature ?? 0.2,
          hitQuote: args.hitQuote,
        });
        if (extra) {
          calls++;
          backfill = mergeBackfillInto(final, extra);
        }
      }
      hlCovered = inUnit.filter((bi) => coveredBlocks(quotesOf(final), args.blocks, locate).has(bi)).length;
    }
  }

  // 5) ★ 覆盖率质量门（全节，与高亮无关）★
  //    ★ 这一段是「质量不高却没有靶子」的解法 ★
  //      以前管道采完就走，不知道自己漏了多少块，用户更不知道 ——
  //      于是所有改进只能靠感觉。现在用与离线探针**同一套判据**算覆盖率，
  //      低于门槛就对着「孤立漏块」再采一次。
  //    ★ 只补孤立漏块，不补整段空白 ★
  //      连续十几块全没覆盖 = 模型判定「这一整段不值得记」，
  //      硬补进来只会稀释信噪比（用户已经反馈过「数值必要性不强」）。
  //      「前后都盖住了、就中间这块没有」才是连续采集里真漏的。
  const locate = args.locateQuote;
  let coverage = locate
    ? measureCoverage({ blocks: args.blocks, unit: args.unit, items: quotesOf(final), locate })
    : null;
  let gateBackfill = 0;

  if (locate && coverage && coverage.rate < COVER_GATE && coverage.segments.length) {
    args.onStep?.(
      `这一节只覆盖了原文的 ${(coverage.rate * 100).toFixed(0)}%，` +
        `对着漏掉的 ${coverage.candidates.length} 处补采…`,
    );
    /**
     * ★ 补采并行化（2026-10-11 S3.3，开关 V3_PARALLEL_COLLECT 默认开）★
     *   原来逐段 await，N 段就串 N 次 RTT（每次 5~30s）。改 mapLimit(…, 3) 后
     *   外层 2 段并发 × 内层 3 = 峰值仍 ≤6（与采集阶段一致，不放大限流风险）。
     *   ★ 两个保序细节 ★
     *   ① 合并（mergeBackfillInto）仍在**全部完成后按原顺序**逐个做——
     *     合并有去重语义，谁先谁后会影响结果；随完成顺序合并会让输出不确定。
     *   ② index/total 编号按段的原下标分配，日志不乱序。
     */
    const doBackfill = async (): Promise<void> => {
      const base = extraSeq;
      const extras = await mapLimit(coverage!.segments, 3, async (seg, i) => {
        // 段内如果跨度不大，就把中间已覆盖的块一起带上——补采窗口里也要有连续上下文，
        // 只喂几个断开的块，模型读不懂它在讲什么。
        const span = args.blocks.slice(seg[0].bi, seg[seg.length - 1].bi + 1).filter((b) => b.text.trim().length > 0);
        const spanChars = span.reduce((s, b) => s + b.text.length, 0);
        const chunk = spanChars <= SEGMENT_MAX_CHARS * 1.35 ? span : seg;
        return backfillWindow({
          chunk,
          markHl: false,
          docTitle: args.docTitle,
          headingPath: args.headingPath,
          unitTitle: args.unit.headingText,
          index: base + i + 1,
          total: base + coverage!.segments.length,
          temperature: args.temperature ?? 0.2,
          hitQuote: args.hitQuote,
        });
      });
      extraSeq += extras.length;
      extras.forEach((extra) => {
        if (extra) {
          calls++;
          gateBackfill++;
          mergeBackfillInto(final, extra);
        }
      });
    };
    if (process.env.V3_PARALLEL_COLLECT === 'off') {
      // 关闭开关 = 逐字回旧行为（串行 for-await）
      for (const seg of coverage.segments) {
        const span = args.blocks.slice(seg[0].bi, seg[seg.length - 1].bi + 1).filter((b) => b.text.trim().length > 0);
        const spanChars = span.reduce((s, b) => s + b.text.length, 0);
        const chunk = spanChars <= SEGMENT_MAX_CHARS * 1.35 ? span : seg;
        const extra = await backfillWindow({
          chunk,
          markHl: false,
          docTitle: args.docTitle,
          headingPath: args.headingPath,
          unitTitle: args.unit.headingText,
          index: ++extraSeq,
          total: extraSeq,
          temperature: args.temperature ?? 0.2,
          hitQuote: args.hitQuote,
        });
        if (extra) {
          calls++;
          gateBackfill++;
          mergeBackfillInto(final, extra);
        }
      }
    } else {
      await doBackfill();
    }
    coverage = measureCoverage({ blocks: args.blocks, unit: args.unit, items: quotesOf(final), locate });
  }

  const catalog = final.propositions.filter((p) => p.rel === '属于' || p.rel === '等价').length;

  // 内部重复率：验收维度之一，**只报告不裁决**（判据的判对率只有 44–56%，见 dupScan 注释）。
  // 放在去重/合并**之后**量 —— 量的是「成品还剩多少重复」，不是「模型吐了多少」。
  const dup = dupScan({
    propositions: final.propositions,
    entries: final.entries,
    terms: final.terms,
  });

  return {
    focus,
    gist,
    propositions: final.propositions,
    entries: final.entries,
    terms: final.terms,
    dropped: [...mergeDropped, ...vetted.droppedItems],
    stats: {
      windows: windows.length,
      calls,
      collected: rawCount,
      dropped: vetted.dropped,
      mergeFallback,
      mergeRounds,
      catalogRatio: final.propositions.length ? catalog / final.propositions.length : 0,
      blocks: coverage?.total ?? 0,
      covered: coverage?.covered ?? 0,
      gateBackfill,
      hl: args.hlBlocks?.size ? { total: hlTotal, covered: hlCovered, backfill } : undefined,
      dup: {
        rate: dup.rate,
        pairs: dup.pairs.length,
        termPairs: dup.termPairs,
        contentPairs: dup.contentPairs,
      },
    },
  };
}
