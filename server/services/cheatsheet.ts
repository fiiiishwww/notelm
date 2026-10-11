/**
 * server/services/cheatsheet.ts —— 命题式小抄（V2）的确定性判据。
 *
 * ★ 为什么要单独一个文件 ★
 *   提示词负责"把话说好"，判据负责"说得对不对"。模型每次输出都会漂移，
 *   所以「这条是不是伪命题」「引文有没有信息量」这类问题必须由代码判——
 *   代码判的才能单测、才能统计、才不会今天一个样明天一个样。
 *
 * 判据一览（全部不调模型）：
 *   - tautology    主宾同义反复（"参数固定 导致 参数可以被量化"这种废话命题）
 *   - shortQuote   引文过短（"这时""如下"这类没有信息量的碎片）
 *   - endScore     关系两端与引文的贴合度（0~1，越高说明引文真在支撑这个关系）
 *   - foreign      陈述里出现正文查不到的术语/数字（幻觉粗筛）
 */

import { createMd, unitForHeadingId } from '../../shared/blocks';
import {
  bestFuzzySubstring,
  dice,
  type Block,
  type Chapter,
  type CheatsheetSection,
  type EntryKind,
  type StudyUnit,
} from '../../shared/text';
import {
  attachBlockIndex,
  groupByOutline,
  isParseFaithful,
  parseCheatsheetMarkdown,
  renderGroupedMarkdown,
  renderSectionHtml,
} from './cheatsheetRender';
import { renderTreeSectionHtml } from './knowledgeTree';
import { computeSectionFrequency, type SectionFrequency } from './sectionFrequency';

/** 从已算好的全库考频里取某一节；没有就返回 undefined（渲染时不显示徽章）。 */
function freqOfSection(
  all: SectionFrequency | undefined,
  docRel: string,
  headingId: string,
): { marks: number; companies: number; level: 0 | 1 | 2 | 3 } | undefined {
  if (!all || !docRel || !headingId) return undefined;
  const rel = docRel.replace(/\.md$/, '');
  const hit = all.sections.find((s) => s.rel === rel && s.headingId === headingId);
  if (!hit || hit.marks <= 0) return undefined;
  return { marks: hit.marks, companies: hit.companies, level: hit.level };
}
import { buildAnswerIndexForDoc } from './answerLink';

/** 渲染一节需要的上下文。`units` 是给「开篇」兜底用的，见 unitForSection。 */
export interface CheatsheetRenderCtx {
  blocks?: Block[];
  chapters?: Chapter[];
  units?: StudyUnit[];
  /** blockIndex → 高亮颜色，渲染时给条目打圆点 */
  hl?: Map<number, string>;
  /**
   * 概念跨节出处（L3，2026-09-21 接入）：conceptKey → 同一篇其他节的出处。
   * 树渲染时给节点加「另见」徽章；由 GET /cheatsheet 从概念库现查，不落盘。
   */
  xrefs?: Map<string, { headingId: string; headingText: string }[]>;
  /**
   * 文档相对路径（2026-09-22 接入）：给「答案见」配对用——思考题的答案在
   * 同目录的参考答案文件里，必须知道自己在哪才能找到它。调用方顺手传一下即可。
   */
  docRel?: string;
}

/**
 * 一节对应原文的哪一段：优先用标题（Chapter），找不到就退回学习单元（StudyUnit）。
 *
 * ★ 为什么要退回 unit ★
 *   开篇（`__preamble__`）是 `deriveUnits` 合成的伪 unit —— 正文里根本没有这个标题，
 *   所以 `chapters.find` 必然落空。以前这里直接 `return null`，调用方于是退回
 *   `createMd().render(存下来的 markdown 快照)`：没有类型徽章、没有 `<details>` 折叠、
 *   条目不带 data-bi（点不回原文），和同文档其他节的格式完全不一样。
 *   实测全库 4 个开篇 **4/4 全部中招**，而它恰恰是打开一篇文档最先看到的部分。
 */
function unitForSection(s: CheatsheetSection, ctx?: CheatsheetRenderCtx): StudyUnit | null {
  const c = ctx?.chapters?.find((x) => x.headingId === s.headingId);
  if (c) {
    return {
      headingId: c.headingId,
      headingText: c.text,
      level: c.level,
      startBi: c.bi,
      endBi: c.endBi,
    };
  }
  return ctx?.units?.find((u) => u.headingId === s.headingId) ?? null;
}

/**
 * 现渲染一节的 markdown。
 *
 * ★ 为什么要现渲染，而不是直接用 sidecar 里存的 markdown ★
 *   markdown 是**渲染产物**：它取决于分组规则和呈现样式，而这些会变。
 *   存下来的那份只是快照，按原文子标题分层这种改动不该需要重跑模型。
 *
 * 返回 null 表示这节没法分层（没有对应标题，比如 preamble），调用方退回原 markdown。
 */
export function renderSectionMarkdown(
  s: CheatsheetSection,
  ctx?: CheatsheetRenderCtx,
): string | null {
  const blocks = ctx?.blocks;
  const chapters = ctx?.chapters;
  if (!blocks?.length || !chapters?.length) return null;
  const unit = unitForSection(s, ctx);
  if (!unit) return null;

  // 优先用落盘的 items；旧数据没有 items 就现场反解析它的 markdown（零成本迁移的兜底）
  const items = s.items ?? parseCheatsheetMarkdown(s.markdown ?? '');
  if (!items.propositions.length && !items.entries.length && !items.terms.length) return null;

  // ★ 反解析不忠实就别用 ★
  //   老版本（V1：`**要点**` + 无类别前缀的条目）不是现在这套格式，只能认出一部分。
  //   拿着残缺的 items 去渲染，等于把剩下的条目静默删掉 —— 实测 3578 字 → 1373 字。
  //   认不全就退回原 markdown：宁可不分层，不能丢内容。
  if (!s.items && !isParseFaithful(s.markdown ?? '', items)) return null;

  const withBi = attachBlockIndex(items, blocks);
  const groups = groupByOutline({ items: withBi, unit, chapters, blocks });
  return renderGroupedMarkdown({ items: withBi, groups });
}

/**
 * 给小抄补上渲染后的 HTML（顺带按原文子标题分层重渲染 markdown）。
 *
 * ★ 为什么必须在这里、而不是让前端自己渲染 ★
 *   sidecar 里只存 markdown（渲染后的 html 会随样式/规则变化而过期，不该落盘）。
 *   前端如果自己 import shared/blocks 去渲染，markdown-it 会被打进客户端包。
 *   所以约定：**凡是把 sidecar 发给前端的接口，都要过一遍这个函数**。
 *
 * 踩过的坑：一开始只在 `/cheatsheet/generate` 和 `/cheatsheet` 的响应里补了 html，
 *   但重新打开文档走的是 `/doc`，那条路径没补 → 界面上一片空白，只剩按钮。
 *
 * 第二个坑（同类）：`section.markdown` 也是渲染产物。如果响应时直接用存下来的那份，
 *   改了分组规则就得重跑模型才看得到效果。所以这里一并重渲染。
 *
 * 安全性：createMd() 的 html 选项是 false，原始 HTML 会被转义而不是执行。
 */
export async function withCheatsheetHtml(
  sections: CheatsheetSection[],
  ctx?: CheatsheetRenderCtx,
): Promise<CheatsheetSection[]> {
  // ★「答案见」配对（B1-2，2026-09-22）★ 渲染侧现算：思考题的答案在同目录参考答案
  //   文件里，模型生成树时看不到它，所以这条关系只能由程序补。全程 0 模型调用，
  //   结果不落盘（同 treeHtml 的理由：答案文件一改，落盘的索引就是过期垃圾）。
  //   配对判据在 scripts/answer-link-probe.ts 上验过（chapter1 思考题 10/10、误配 0）。
  //   ★ 本函数因此变成 async——所有调用方都要 await，漏一个就是「树里没有答案见」。
  const answers = ctx?.docRel && ctx.blocks?.length
    ? await buildAnswerIndexForDoc(ctx.docRel, ctx.blocks).catch(() => undefined)
    : undefined;
  // ★ 节级考频徽章 ★ 同样**现算不落盘**（与 html/treeHtml 同理由：面经一改，落盘的档位就是过期垃圾）。
  //   整批只算一次，signature 不变时走缓存，所以平���渲染不产生 embedding 调用。
  const freqAll = ctx?.docRel ? await computeSectionFrequency().catch(() => undefined) : undefined;
  return sections.map((s) => {
    const markdown = renderSectionMarkdown(s, ctx) ?? s.markdown ?? '';
    // html 有两条来路：有 items / 反解析得出 items 的节走专用渲染（徽章、折叠、
    // 引文退出正文）；老格式认不出来的节退回 markdown-it（沿用旧的平铺样式）。
    const html = renderSectionHtmlFor(s, ctx) ?? createMd().render(markdown);
    // ★ 知识树形态（2026-09-20 接入）★ 有树的节由这里现渲染嵌入版片段。
    //   树是呈现层的新主轴，不落盘（同 html 的理由：样式/规则变了旧产物就是过期垃圾）。
    //   ctx.xrefs = 同篇其他节的同概念出处（L3），按节过滤（自己节里的不算「另见」）。
    const treeHtml = s.tree
      ? renderTreeSectionHtml(
          s.tree,
          new Map(
            [...(ctx?.xrefs ?? [])].map(([k, v]) => [
              k,
              v.filter((x) => x.headingId !== s.headingId),
            ]),
          ),
          answers,
          // 本节的考频（ctx 只有 docRel，headingId 从 section 自己取）
          freqOfSection(freqAll, ctx?.docRel ?? '', s.headingId),
        )
      : undefined;
    return { ...s, markdown, html, treeHtml };
  });
}

/** 专用 HTML：能算出分组就产出结构化 html，算不出返回 null（调用方退回 markdown 渲染）。 */
function renderSectionHtmlFor(
  s: CheatsheetSection,
  ctx?: CheatsheetRenderCtx,
): string | null {
  const blocks = ctx?.blocks;
  const chapters = ctx?.chapters;
  if (!blocks?.length || !chapters?.length || !s.items) return null;
  const unit = unitForSection(s, ctx);
  if (!unit) return null;
  const withBi = attachBlockIndex(s.items, blocks);
  const groups = groupByOutline({
    items: withBi,
    unit,
    chapters,
    blocks,
  });
  return renderSectionHtml({ items: withBi, groups, hl: ctx?.hl, dropped: s.dropped });
}

/** 结构类关系（属于/等价）只是分类学陈述，不带来新关联。 */
function isStructuralRel(rel: string): boolean {
  return rel === '属于' || rel === '等价';
}

/**
 * ★ 一条信息只出现一次 ★
 *
 * 模型经常把同一句原文既写成【定义】又写成命题 —— 实测 chapter3「三层次框架」那组，
 * `【定义】基础回忆：三层次评估框架第一层，最根本的能力…` 旁边紧跟着一条
 * `基础记忆 —属于→ 三层次评估框架第一层 —— 基础回忆是…第一层，是…最根本的能力`，
 * 整句重复，读起来就是在原地打转（用户 2026-09-17 指出）。
 *
 * 判据（确定性）：dice(命题陈述, 条目正文) ≥ 0.6 视为同一句。然后——
 *   - 命题是结构类关系（属于/等价）→ **删命题留定义**。定义更完整，而
 *     「X 属于 Y」只是把定义换个说法，没有增量；
 *   - 命题是实关系（导致/区别于…）→ 关系本身就是增量，**删掉几乎重复的条目**，
 *     但前提是命题陈述没有比条目短太多（< 0.8 倍就两个都留，宁可重复不丢内容）。
 *
 * 阈值为什么是 0.6：实测 chapter3 的真重复落在 0.64~0.86，而正常相邻条目多在 0.3 以下，
 * 中间是空的 —— 0.6 正好卡在空档上。
 */
export function dedupePropsAgainstEntries<
  P extends {
    subject: string;
    rel: string;
    object: string;
    statement?: string;
    why?: string;
    quote: string;
    bi?: number;
  },
>(args: {
  propositions: P[];
  entries: { kind: EntryKind; text: string; quote: string; term?: string; bi?: number }[];
  threshold?: number;
}): {
  propositions: P[];
  entries: { kind: EntryKind; text: string; quote: string; term?: string; bi?: number }[];
  droppedProps: P[];
  droppedEntries: { kind: EntryKind; text: string; quote: string; term?: string; bi?: number }[];
} {
  const th = args.threshold ?? 0.6;
  const keptEntries = [...args.entries];
  const propositions: P[] = [];
  const droppedProps: P[] = [];
  const droppedEntries: { kind: EntryKind; text: string; quote: string; term?: string; bi?: number }[] = [];

  for (const p of args.propositions) {
    let best = 0;
    let bestIdx = -1;
    keptEntries.forEach((e, i) => {
      const d = dice(p.statement ?? '', e.text ?? '');
      if (d > best) {
        best = d;
        bestIdx = i;
      }
    });
    if (best >= th && bestIdx >= 0) {
      if (isStructuralRel(p.rel)) {
        droppedProps.push(p);
        continue;
      }
      const e = keptEntries[bestIdx];
      if ((p.statement ?? '').length >= (e.text ?? '').length * 0.8) {
        droppedEntries.push(e);
        keptEntries.splice(bestIdx, 1);
      }
    }
    propositions.push(p);
  }
  return { propositions, entries: keptEntries, droppedProps, droppedEntries };
}

export interface PropLike {
  subject: string;
  object: string;
  statement?: string;
  quote: string;
}

/** 把一句话按标点切成片段，去掉过短的碎片。 */
function segsOf(t: string): string[] {
  return t
    .split(/[；;，,。.、：:\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
}

/**
 * 短句被长句「覆盖」的比例（0~1）：按标点切段，看多长的字符能在长句里原样找到。
 *
 * ★ 导出 ★ 标注随行（feedback.ts 的 carryFeedback）复用同一判据，
 *   不许在别处复制实现 —— 去重和重锚的阈值必须永远同源。
 *
 * ★ 为什么不用 dice ★
 *   用户举的真重复是「清单句是定义句的一个子句」—— 这种关系是**包含**，不是**相似**。
 *   包含用 dice 量不出来（长度差一大，dice 就被拉低），用覆盖率一眼就准。
 */
export function coverage(short: string, long: string): number {
  const segs = segsOf(short);
  if (!segs.length) return long.includes(short) ? 1 : 0;
  let hit = 0;
  let total = 0;
  for (const s of segs) {
    total += s.length;
    if (long.includes(s)) hit += s.length;
  }
  return total ? hit / total : 0;
}

/** 等式 / 数值：这两个 kind 的 dice 是假阳性重灾区，见下面的豁免说明。 */
function isFormulaKind(k: string): boolean {
  return k === '等式' || k === '数值';
}

export interface EntryLike {
  kind: EntryKind;
  text: string;
  quote?: string;
  term?: string;
  bi?: number;
}

/**
 * ★ 一条信息只出现一次（条目 vs 条目）★
 *
 * `dedupePropsAgainstEntries` 管的是「命题 vs 条目」，这一层管的是**条目之间**。
 * 用户 2026-09-17 指出：一条清单和一条定义说的是同一件事，读起来在原地打转。
 *
 * 判据（两条，命中任一即视为重复）：
 *   - 覆盖率 ≥ 0.8：短句是长句的子句（**用户举的正是这一类**）
 *   - dice ≥ 0.6：整体相似（沿用命题层量出来的阈值，正常相邻条目多在 0.3 以下）
 *
 * ★ 为什么等式和数值必须完全豁免 ★
 *   实测全库最高分的一对假阳性是
 *   `$H(x)=-\sum p(x)log_2p(x)$` vs `$H(p,q)=-\sum p(x)log_2q(x)$`，dice **0.90**；
 *   另一对是 `Harness = 上下文管理 + 工具接口 + 约束 + 验证 + 纠正` vs
 *   `Agent = LLM + 上下文 + 工具`，dice 只有 0.39 却仍被覆盖率判成重复。
 *   两例都是**骨架相同、语义完全不同** —— 字符重合数不出语义差别。
 *   所以只要涉及等式 / 数值，**一律不判**。
 *
 * 保留哪条：留**信息更全**的那条（text 更长）。删掉的那条若有 ≥4 字的独有片段，
 * 并进保留条（清单里的独有枚举项不该丢）—— 记在 `merged` 里。
 *
 * ★ 阈值是试出来的，不是拍的 ★
 *   先用 dice 0.6 / coverage 0.8 跑全库：拟删 5 条，其中 2 条是误删（40% 假阳性）。
 *   收到 0.75 / 0.9 后假阳性归零。宁可少删，不可误删。
 */
export function dedupeEntriesAgainstEntries<E extends EntryLike>(
  entries: E[],
  opts?: { threshold?: number; containment?: number },
): { entries: E[]; dropped: E[]; merged: number } {
  const th = opts?.threshold ?? 0.75;
  const cov = opts?.containment ?? 0.9;
  const kept: E[] = entries.map((e) => ({ ...e }));
  const dropped: E[] = [];
  let merged = 0;

  for (let i = 0; i < kept.length; i++) {
    if (!kept[i]) continue;
    for (let j = i + 1; j < kept.length; j++) {
      const a = kept[i];
      const b = kept[j];
      if (!a || !b) continue;
      // 骨架相同的两个公式语义可能完全不同，一律不判（实测假阳性率过高）
      if (isFormulaKind(a.kind) || isFormulaKind(b.kind)) continue;

      const short = a.text.length <= b.text.length ? a : b;
      const long = short === a ? b : a;
      const c = coverage(short.text, long.text);
      const d = dice(a.text, b.text);
      if (!(c >= cov || d >= th)) continue;

      // 短句里的独有片段不能丢：并进长句
      const uniq = segsOf(short.text).filter((s) => !long.text.includes(s) && s.length >= 4);
      if (uniq.length) {
        long.text = `${long.text}；${uniq.join('、')}`;
        merged++;
      }
      dropped.push(short);
      const loserIdx = short === a ? i : j;
      kept.splice(loserIdx, 1);
      if (loserIdx === i) i--;
      break;
    }
  }
  return { entries: kept, dropped, merged };
}

// ─────────────────────────── 内部重复率（验收维度之一） ───────────────────────────

/**
 * ★ 内部重复率 —— 「一条信息只出现一次」的可观测形式 ★
 *
 * 多鱼 2026-09-20 拍板：验收四维里先上这个（原话「一句话本身表达是否用其他方式重复」）。
 * 讨论稿见 docs/小抄定义-讨论稿.md。
 *
 * ★ 为什么不能用去重层的 dice 当指标 ★
 *   去重层（dedupePropsAgainstEntries / dedupeEntriesAgainstEntries）只管**内容层内部**，
 *   阈值 0.75/0.9，抓的是几乎逐字重复的。实测全库 dice ≥0.5 只有 53 对 / 16116（0.33%），
 *   可她的 ▽ 里反复出现「概念地图强调太多次」。
 *   差在哪？差在**术语层从来没参与跨层去重**（vetItems 里术语只做同名去重）：
 *
 *     [条目/定义] Harness 是 Agent 边界内环绕模型的运行与治理层，负责…
 *     [术语/术语] Harness：Agent 边界内环绕模型的运行与治理层，负责…
 *
 *   实测这类「术语层 vs 内容层」同文双份 **203 对，占全部硬重复的 76%** ——
 *   这才是「同一条信息出现两遍」的最大来源（见 scripts/internal-dup-probe.ts）。
 *
 * ★ 两个 scope 的处置完全不同，所以必须分开报 ★
 *   `术语×内容` 是**结构性**的：术语表本来就是内容层概念的索引，
 *     两份文字写成一样才是病 → 处置是**呈现层锚点化**（术语行指向条目），不是删数据；
 *   `内容×内容` 才是**真重复** → 可以进回收站等确认。
 *
 * ★ 判据不精确，所以它只当指标、不当裁决 ★
 *   拿她的标注验：D1 判对率 20%（样本仅 5 条）、D3 判对率 44–56%。
 *   假阳性样张（`--sweep` 输出）：
 *     [命题] Model 只负责决定下一步，Harness 负责组装上下文…
 *     [术语] Environment：负责产生真实状态变化和观察的组件。   ← jac=0.40，误报
 *   所以本函数**只回答「重复率是多少」，不回答「该删哪条」**。
 *   真要动手时，走的是回收站确认那条路（见 CheatsheetDropped）。
 */
export const DUP_HARD_DICE = 0.75;
export const DUP_HARD_COV = 0.9;
/** D3 阈值：扫描 0.15→0.50，**0.45 判对率最高**（56%）；再低假阳性陡增（0.30 → 31%） */
export const DUP_JAC = 0.45;

/**
 * 中文虚字表 —— 只按字删，不用分词器。
 *
 * ★ 为什么不去装个分词器 ★
 *   本机没有中文分词器（见 MEMORY.md 的「中文无分词器的坑」），而且这里只需要
 *   「虚词不参与相似度」这一个效果：按字删掉高频虚字，再取 bigram，
 *   核心名词的重合就会浮出来（`轨迹由三类条目构成：用户消息…` vs
 *   `轨迹是 Agent 在…积累的消息历史，包含用户消息…` → jac=0.39 命中）。
 */
const DUP_STOP =
  /[的了是在和与及等这那有为对以可要不也就都把被从而且或者之其此该所以因此但是不过还更最很太如果因由将会能需应该一二三四五六七八九十]/g;

/** 去虚字后的 bigram 集合 —— 同义改写判据的原料（英文/数字串保留，它们常是概念名） */
export function contentGrams(s: string): Set<string> {
  const t = (s ?? '')
    .replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '')
    .replace(DUP_STOP, '');
  const out = new Set<string>();
  for (let i = 0; i + 1 < t.length; i++) out.add(t.slice(i, i + 2));
  if (!out.size && t) out.add(t);
  return out;
}

/** 同义改写分（0~1）：去虚字后 bigram 集合的 Jaccard。 */
export function paraphraseScore(a: string, b: string): number {
  const A = contentGrams(a);
  const B = contentGrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

export type DupLayer = '命题' | '条目' | '术语';
/** 术语参与 = 结构性冗余；纯内容层 = 真重复。处置不同，别混着报。 */
export type DupScope = '术语×内容' | '内容×内容' | '术语×术语';

export interface DupPair {
  kind: '硬重复' | '同义改写';
  scope: DupScope;
  score: string;
  a: { layer: DupLayer; kind: string; text: string };
  b: { layer: DupLayer; kind: string; text: string };
}

export interface DupReport {
  pairs: DupPair[];
  total: number;
  /** 被卷进重复的条数（去重后） */
  involved: number;
  /** involved / total */
  rate: number;
  /** 术语参与的对数（结构性） */
  termPairs: number;
  /** 内容层内部的对数（真重复） */
  contentPairs: number;
}

function dupScopeOf(a: DupLayer, b: DupLayer): DupScope {
  if (a === '术语' && b === '术语') return '术语×术语';
  if (a === '术语' || b === '术语') return '术语×内容';
  return '内容×内容';
}

/**
 * 扫一遍一节的内部重复。
 *
 * 三层摊平后两两比较（一节最多几百条，O(n²) 完全够用；探针在全库跑也就几秒）。
 * 等式 / 数值豁免两条判据 —— 骨架相同语义不同的假阳性重灾区（见上面 dedupeEntriesAgainstEntries 注释）。
 */
export function dupScan(input: {
  propositions: { statement?: string }[];
  entries: { text?: string; kind?: string }[];
  terms: { term?: string; meaning?: string }[];
}): DupReport {
  const flat: { layer: DupLayer; kind: string; text: string }[] = [];
  for (const p of input.propositions) {
    const t = (p.statement ?? '').trim();
    if (t.length >= 4) flat.push({ layer: '命题', kind: '命题', text: t });
  }
  for (const e of input.entries) {
    const t = (e.text ?? '').trim();
    if (t.length >= 4) flat.push({ layer: '条目', kind: (e.kind ?? '').trim(), text: t });
  }
  for (const t of input.terms) {
    const s = `${(t.term ?? '').trim()}：${(t.meaning ?? '').trim()}`;
    if (s.length >= 4) flat.push({ layer: '术语', kind: '术语', text: s });
  }

  const pairs: DupPair[] = [];
  const involved = new Set<number>();
  let termPairs = 0;
  let contentPairs = 0;

  for (let i = 0; i < flat.length; i++) {
    for (let j = i + 1; j < flat.length; j++) {
      const a = flat[i];
      const b = flat[j];
      const exempt = isFormulaKind(a.kind) || isFormulaKind(b.kind);
      let kind: DupPair['kind'] | null = null;
      let score = '';
      if (!exempt) {
        const short = a.text.length <= b.text.length ? a : b;
        const long = short === a ? b : a;
        const cov = coverage(short.text, long.text);
        const d = dice(a.text, b.text);
        if (cov >= DUP_HARD_COV) {
          kind = '硬重复';
          score = `cov=${cov.toFixed(2)}`;
        } else if (d >= DUP_HARD_DICE) {
          kind = '硬重复';
          score = `dice=${d.toFixed(2)}`;
        } else {
          const jc = paraphraseScore(a.text, b.text);
          if (jc >= DUP_JAC) {
            kind = '同义改写';
            score = `jac=${jc.toFixed(2)}`;
          }
        }
      }
      if (!kind) continue;
      const scope = dupScopeOf(a.layer, b.layer);
      if (scope === '内容×内容') contentPairs++;
      else termPairs++;
      pairs.push({ kind, scope, score, a, b });
      involved.add(i);
      involved.add(j);
    }
  }

  return {
    pairs,
    total: flat.length,
    involved: involved.size,
    rate: flat.length ? involved.size / flat.length : 0,
    termPairs,
    contentPairs,
  };
}

/** 二元字组的召回率：概念里有多少比例的相邻二字组能在引文里找到。 */
function bigramRecall(concept: string, quote: string): number {
  const t = concept.replace(/\s+/g, ' ').trim();
  if (t.length < 2) return t && quote.includes(t) ? 1 : 0;
  const gs: string[] = [];
  for (let i = 0; i + 1 < t.length; i++) gs.push(t.slice(i, i + 2));
  if (!gs.length) return 0;
  const q = quote.replace(/\s+/g, ' ');
  let hit = 0;
  for (const g of gs) if (q.includes(g)) hit++;
  return hit / gs.length;
}

/**
 * 概念与引文的贴合度（0~1）。
 *
 * ★ 为什么取「模糊匹配」和「二字组召回」的较大值 ★
 *   概念短的时候模糊匹配会失灵：「对称量化」对上「对称的 k 位量化」，
 *   4 字概念在引文里找不到长度相近的相似窗口，dice 只有 0.33；
 *   但它的二字组「对称」「量化」两个都在引文里，召回 0.67。
 *   反过来，长概念靠模糊匹配更稳。两个都算，取大的。
 *
 * 副作用（是我们想要的）：把概念写成一长串从句会显著拉低这个分，
 *   而提示词本来要求 subject/object 是名词短语，所以这个分也在督促模型写短。
 */
export function endScore(concept: string, quote: string): number {
  const c = (concept ?? '').trim();
  const q = (quote ?? '').trim();
  if (!c || !q) return 0;
  if (q.includes(c)) return 1;
  const fuzzy = bestFuzzySubstring(q, c)?.score ?? 0;
  return Math.max(fuzzy, bigramRecall(c, q));
}

/**
 * 主宾同义反复：主语和宾语说的是一回事，等于什么都没说。
 *
 * ★ 门槛为什么定 0.75 这么保守 ★
 *   试过 0.6，结果把「Q 函数 —区别于→ V 函数」这种好命题误杀了（dice 0.67）。
 *   误杀好命题比放过废话命题更糟——好命题是要拿去出卡的。
 *   所以这里只抓两种铁定是废话的：完全一样 / 一个是另一个的子串。
 */
export function isTautology(subject: string, object: string): boolean {
  const a = (subject ?? '').trim();
  const b = (object ?? '').trim();
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  return dice(a, b) >= 0.75;
}

/** 引文有没有信息量。太短的引文即使能定位，点过去也看不到东西。 */
export function isShortQuote(quote: string): boolean {
  return (quote ?? '').trim().length < 10;
}

/**
 * 两条命题是不是在重复同一句话。
 *
 * 实测出的真问题：模型会把同一句原文拆成两条命题
 *   「clip 操作 —用于解决→ 策略突变」和「clip 操作 —导致→ 高稳定性」
 *   引的是同一句「clip 操作能有效防止策略突变，稳定性高」。
 * 这是拆分的反面——同一件事说了两遍。判据很简单：引文相同 / 互相包含 / 高度重合。
 */
export function isDuplicateQuote(a: string, b: string): boolean {
  const x = (a ?? '').trim();
  const y = (b ?? '').trim();
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.includes(y) || y.includes(x)) return true;
  return dice(x, y) >= 0.85;
}

/** 陈述里出现、但正文里查不到的术语/数字。查不到 ≠ 一定错，但值得人看一眼。 */
export function foreignTokens(text: string, sourceText: string): string[] {
  const src = (sourceText ?? '').toLowerCase();
  if (!src) return [];
  const toks = (text ?? '').match(/[A-Za-z][A-Za-z0-9\-_.]{2,}|\d+(?:\.\d+)?/g) ?? [];
  return [...new Set(toks)].filter((t) => !src.includes(t.toLowerCase()));
}

/**
 * 从渲染后的小抄 markdown 里取出所有引文（行内代码）。
 * V1 / V2 / V3 的 markdown 都用 `` `quote` `` 这个格式，所以一个函数够用。
 */
export function extractQuotes(markdown: string): string[] {
  const out: string[] = [];
  for (const m of (markdown ?? '').matchAll(/`([^`\n]{4,})`/g)) {
    const q = m[1].trim();
    if (q) out.push(q);
  }
  return out;
}

/**
 * 这句引文有没有「碰到」这一块原文。
 *
 * ★ 为什么要单独一个函数、而不是直接用 quote.includes ★
 *   引文经常是块里的一整句（块 = 段落），所以双向包含都要认；
 *   但块很短的时候「引文包含块」不算数，否则一个词就能点亮一整块。
 *   剩下的情况用字符二元组重合度兜底（同一句话被模型稍微改了几个字也能认出来）。
 */
export function quoteTouches(quote: string, blockText: string): boolean {
  const q = (quote ?? '').trim();
  const b = (blockText ?? '').trim();
  if (!q || !b) return false;
  if (q === b) return true;
  if (b.includes(q)) return true;
  if (q.includes(b) && b.length >= 8) return true;
  return dice(q, b) >= 0.5;
}

/**
 * 这一块原文「值不值得记」。
 *
 * ★ 用途是评估，不是生成 ★
 *   拿它当分母去算覆盖率（小抄碰到了多少「值得记的块」），
 *   比拿全部块当分母更诚实——否则图片和铺垫句会把覆盖率稀释掉。
 */
export function informativeBlock(text: string): boolean {
  const t = (text ?? '').trim();
  if (!t || isImageRef(t) || isFormulaHeavy(t)) return false;
  if (/\d/.test(t) && t.length >= 12) return true;
  if (/[A-Za-z]{3,}/.test(t) && t.length >= 20) return true;
  if (/因为|所以|导致|区别|相比|但是|然而|关键|注意|例如/.test(t) && t.length >= 20) return true;
  return false;
}

/** 图片 / 附件引用：出现在块里，但根本不是内容。 */
export function isImageRef(t: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|bmp)\b/i.test(t ?? '') && (t ?? '').trim().length < 80;
}

/** 公式块：$...$ 占了大半。它们是「要用的东西」，但不适合记成命题。 */
export function isFormulaHeavy(t: string): boolean {
  const s = t ?? '';
  const math = (s.match(/\$[^$]*\$/g) || []).join('').length;
  return s.length > 0 && math / s.length > 0.5;
}

export interface PropScore {
  subjectScore: number;
  objectScore: number;
  /** 两端都达到 0.45 才算"引文同时支撑了关系两端" */
  bothEnds: boolean;
  tautology: boolean;
  shortQuote: boolean;
  foreign: string[];
}

export function scoreProposition(p: PropLike, sourceText: string): PropScore {
  const subjectScore = endScore(p.subject, p.quote);
  const objectScore = endScore(p.object, p.quote);
  return {
    subjectScore,
    objectScore,
    bothEnds: subjectScore >= 0.45 && objectScore >= 0.45,
    tautology: isTautology(p.subject, p.object),
    shortQuote: isShortQuote(p.quote),
    foreign: foreignTokens(p.statement ?? '', sourceText),
  };
}
