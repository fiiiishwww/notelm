/**
 * server/services/prompts.ts —— 所有提示词的唯一出处。
 *
 * ★ 一条贯穿全部的约束：引用必须是「逐字复制」★
 *   小抄、题目、闪卡的答案里都可以带 citations（原文引用），而这些引用会被用来
 *   在正文里定位、跳转、生成高亮。如果模型把引文改写了，validateQuote 会丢弃它——
 *   也就是说，改写引用 = 功能失效。所以每个提示词都反复强调这一点，并且在
 *   server/services/anchor.ts 的 validateQuote 里做二次校验，双保险。
 *
 * ★ 另一条：不许编造原文里没有的知识 ★
 *   这是学习工具，用户会根据它去记忆。模型补充的「常识」如果和原文冲突，
 *   用户会记错。所以每个提示词都要求「只依据给定文本」。
 */

import type { StudyUnit } from '../../shared/text';
import {
  ENTRY_KINDS,
  RELATION_KINDS,
  STRUCTURAL_RELATIONS,
  type CheatsheetEntry,
  type CheatsheetProposition,
  type CheatsheetTerm,
  type EntryKind,
  type RelationKind,
} from '../../shared/text';

export { ENTRY_KINDS, RELATION_KINDS, STRUCTURAL_RELATIONS };
export type { CheatsheetEntry, CheatsheetProposition, CheatsheetTerm, EntryKind, RelationKind };

export interface UnitContext {
  unit: StudyUnit;
  /** 该单元的正文纯文本 */
  text: string;
  /** 从文章标题到该单元的标题链，如 ["第一章", "1.2 状态转移"] */
  headingPath: string[];
  /** 整篇文章的标题（文件名） */
  docTitle: string;
}

/**
 * ★ 为什么需要这条禁令 ★
 *
 * 教材类笔记的原文自己就爱写「本章」「本节」（这本书里约 13 处），
 * 而提示词里只要出现「本节」二字——哪怕是否定式的「不要写本节介绍了……」——
 * 模型都会照着原文的措辞写进输出。所以两件事要同时做：
 *   1. 把提示词里所有「本节 / 本章 / 这一节」换成中性说法；
 *   2. 再显式列一条禁令兜底（模型的注意力对「禁止」比对「不要写某某」更敏感）。
 *
 * 注意：这只影响**新生成**的内容。已经落在磁盘上的小抄/测验不会变，
 * 要清干净得在界面上对那一节重新生成。
 */
const NO_SELF_REF =
  '禁止在输出里出现「本章」「本节」「这一节」「本小节」「上文」「下文」这类指代词；' +
  '需要指代内容时直接写具体名词（例如「上下文工程」「动态规划」）。';

function header(ctx: UnitContext): string {
  const path = ctx.headingPath.length ? `文章标题链：${ctx.headingPath.join(' > ')}` : '（无标题）';
  // 标题只是给模型定位用的，别让它把「小节」这个概念学进输出里
  return `文章：${ctx.docTitle}\n${path}\n所在位置（仅用于定位，${NO_SELF_REF}）：${ctx.unit.headingText}`;
}

/** 文本太长时截断，并明确告诉模型「后面被截掉了」，避免它以为这就是全部。 */
function clip(text: string, max = 12_000): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n（……内容过长，以上为前 ${max} 字，后续内容已省略）`;
}

// ─────────────────────────── 小抄 ───────────────────────────

export interface CheatsheetShape {
  /** 一句话总结这段内容在讲什么 */
  gist: string;
  /** 要点列表，每条尽量短、可独立成立 */
  points: { text: string; quote: string }[];
  /** 容易混淆 / 容易忘的地方 */
  pitfalls: { text: string; quote: string }[];
  /** 需要记住的术语，key 是术语，value 是解释 */
  terms: { term: string; meaning: string; quote: string }[];
}

export function cheatsheetPrompt(ctx: UnitContext) {
  const system = [
    '你是一个帮助学生复习的助教。你的任务是把一段正文压缩成「一页小抄」。',
    '',
    '硬性要求：',
    '1. 只能依据给定的正文内容，绝对不要引入正文里没有的知识。',
    '2. 每条要点都要带一个 quote 字段，它是**从正文里逐字复制的连续片段**（10~40 字）。',
    '   不要改写、不要加省略号、不要拼接不相邻的两句话。程序要拿它去正文里定位，改写就找不到了。',
    '3. points 每条不超过 60 字，要能脱离上下文独立看懂。',
    '4. pitfalls 只写正文里明确提到的易错点；如果正文没提，返回空数组，不要硬凑。',
    '5. terms 只收录正文里出现的术语；正文里为 0 就返回空数组。',
    '6. 用中文输出。不要写「这一段介绍了……」这类空话，直接给结论。',
    `7. ${NO_SELF_REF}`,
    '',
    '输出 JSON，结构如下：',
    '{"gist":"一句话总结","points":[{"text":"要点","quote":"原文片段"}],',
    '"pitfalls":[{"text":"易错点","quote":"原文片段"}],',
    '"terms":[{"term":"术语","meaning":"解释","quote":"原文片段"}]}',
  ].join('\n');

  const user = `${header(ctx)}\n\n正文：\n---\n${clip(ctx.text)}\n---\n\n请生成小抄 JSON。`;
  return { system, user };
}

// ─────────────────────────── 小抄 V2（命题式） ───────────────────────────
/**
 * 为什么要有 V2：
 *   V1 的产物是「原句压缩 + 引文」的平铺列表，实测平均 25 条/节——那是把文章抄短了，
 *   不是整理。条目之间没有任何关系，读完之后你知道了一堆句子，但不知道它们怎么咬合。
 *
 *   V2 的基本单位改成 **命题（proposition）= 概念 + 关系 + 概念**，来自 Novak 概念图：
 *   "interrelatedness 是知识的本质属性，理解 = 重要概念之间丰富的关系集合"。
 *   关系取闭集，闭集才能统计、检索、跨文档合并、自动出卡（出卡时天然原子，不会被拆碎）。
 */

// 关系闭集 / 命题 / 速查 / 术语的结构定义已移到 shared/text.ts。
// 原因：它们要**落盘**（sidecar 的 section.items），而 shared 层是数据契约的唯一出处；
// 留在这里会让「服务端提示词」和「磁盘上的数据形状」两处定义各说各话。
// 这里 import 进来供提示词拼接用，并原样转出，历史 import 路径不受影响。

export interface CheatsheetV2Shape {
  /** 焦点问题：这一节到底在回答什么问题 */
  focus: string;
  /** 一句话回答焦点问题 */
  gist: string;
  /** 命题，硬上限 7 条 */
  propositions: CheatsheetProposition[];
  /** 找不到可靠关系的孤立事实（定义、数值、专名），上限 3 条 */
  facts: { concept: string; claim: string; quote: string }[];
  /** 术语 / 缩写，上限 5 条 */
  terms: { term: string; meaning: string }[];
}

export function cheatsheetV2Prompt(ctx: UnitContext) {
  const system = [
    '你是一个帮人做知识整理的助教。你的任务不是把一段正文压缩短，',
    '而是把它整理成一组**命题**——每个命题说清两个概念之间是什么关系。',
    '',
    '★ 什么是命题 ★',
    '命题 = 概念A + 关系 + 概念B。例如：',
    '  远距离依赖 —导致→ 梯度消失',
    '  self-attention —用于解决→ 长序列的远距离依赖',
    '  NF4 —优于→ 普通 4-bit 量化（权重近似正态分布，分位数量化误差更小）',
    '',
    `★ 关系只能从这 ${RELATION_KINDS.length} 个里选，不许自创 ★`,
    RELATION_KINDS.map((r) => `  ${r}`).join('\n'),
    '',
    '硬性要求：',
    '1. 最多 7 条命题、3 条孤立事实、5 条术语。**宁缺毋滥**：',
    '   凑不满就少写，凑不满说明这一节本来就没那么多东西。写满 7 条往往意味着你在复述。',
    '2. **优先写「为什么」**：导致 / 用于解决 / 前提 / 例外 这几类最能帮人理解，',
    `   它们加起来要占命题总数的一半以上。「属于」「等价」加起来不许超过 40%`,
    '   （全是「A 属于 B」= 把目录重画一遍，等于没整理）。',
    '3. 每条必须带 quote：**从正文里逐字复制的连续片段**（10~60 字），不要改写、',
    '   不要加省略号、不要拼接不相邻的句子。程序要拿它去正文里定位，改写就找不到了。',
    '4. quote 优先选**同时提到关系两端**的那句原文；找不到就退而求其次，',
    '   选最贴近其中一端、又能看出这个关系的那句。',
    '   **禁止**引文短于 10 字，也禁止「这时」「如下」「也就是说」这类没有信息量的碎片。',
    '   如果连一端的依据都找不到，说明这个关系是你脑补的——降级进 facts，或者干脆不写。',
    '5. subject / object 是**名词短语**（「远距离依赖」「4-bit 量化」），不是整句。',
    '6. statement 不超过 60 字，能脱离上下文独立看懂，不写「它」「这个」这类指代词。',
    '7. **不许同义反复**：subject 和 object 必须是两个不同的概念。',
    '   「模型参数固定 —导致→ 模型参数可以被量化」这种等于没说，宁可不写这条。',
    '8. why 字段写「为什么会这样」，一句话。正文没讲原因就留空字符串，**不要自己编**。',
    '9. 只依据给定的正文，绝对不要引入正文之外的知识。',
    `10. ${NO_SELF_REF}`,
    '',
    '★ 反面例子（不要这样写）★',
    '  ✗ "self-attention 把序列不同位置关联起来"  —— 只是复述，没有关系，不成命题',
    '  ✓ self-attention —用于解决→ 远距离依赖导致的梯度问题',
    '  ✗ "NF4 是信息论上最优的数据类型" —— 孤立事实，没说清它和谁的关系',
    '  ✓ NF4 —优于→ 均匀量化（权重近似正态分布，分位数量化让各区间落入相同数量的值）',
    '',
    '输出 JSON：',
    '{"focus":"这一节在回答什么问题","gist":"一句话回答",',
    '"propositions":[{"subject":"概念A","rel":"导致","object":"概念B",',
    '"statement":"完整陈述","why":"为什么，没有就空字符串","quote":"原文片段"}],',
    '"facts":[{"concept":"概念","claim":"事实","quote":"原文片段"}],',
    '"terms":[{"term":"术语","meaning":"解释"}]}',
  ].join('\n');

  const user = `${header(ctx)}\n\n正文：\n---\n${clip(ctx.text)}\n---\n\n请生成命题式小抄 JSON。`;
  return { system, user };
}

/** V2 小抄的 markdown 呈现（探针和正式落盘共用）。 */
export function renderCheatsheetV2Markdown(s: {
  focus: string;
  gist: string;
  propositions: CheatsheetProposition[];
  facts: { concept: string; claim: string; quote: string }[];
  terms: { term: string; meaning: string }[];
}): string {
  const out: string[] = [];
  if (s.focus) out.push(`**焦点问题**：${s.focus}`);
  if (s.gist) out.push(`**一句话**：${s.gist}`);

  if (s.propositions.length) {
    out.push('', '**命题**');
    for (const p of s.propositions) {
      out.push(`- **${p.subject}** —${p.rel}→ **${p.object}** —— ${p.statement} \`${p.quote}\``);
      if (p.why) out.push(`  - 为什么：${p.why}`);
    }
  }
  if (s.facts.length) {
    out.push('', '**孤立事实**');
    for (const f of s.facts) out.push(`- **${f.concept}**：${f.claim} \`${f.quote}\``);
  }
  if (s.terms.length) {
    out.push('', '**术语**');
    for (const t of s.terms) out.push(`- **${t.term}**：${t.meaning}`);
  }
  return out.join('\n');
}

// ─────────────────── 小抄 V3（窗口化采集） ───────────────────
/**
 * 为什么还要有 V3 ★
 *
 * 实测 28 节小抄：V2 的「最多 7 条」在 10 块的短节上覆盖 70%，在 162 块的长节上只有 6%。
 * 而且位置分布**单调递减**（开头 29% → 25% → 15% → 13% → 14%）。
 * 这说明漏不是「取舍」，是输出预算被前段吃掉了——越往后越敷衍。
 *
 * 放宽上限治不了：162 块要覆盖 80% 得 90 条，那就是回到 V1 的「缩写」。
 * 真正的解法是**别让一次调用看整个长节**：按块切成窗口，每个窗口独立采集，最后合并。
 * 每个窗口都是「第一个窗口」，递减就不存在了。
 *
 * 第二个改动是**采集清单**。V2 只收「概念—关系—概念」，于是
 *   `Agent = Model + Harness`（等号两侧都不是名词短语）
 *   `上下文是眼睛，工具是手脚`（类比）
 *   `得分从 52.8% 提升到 66.5%`（数值）
 * 这类内容被**系统性**排除——它们恰恰是原文最核心的东西。
 * V3 把值得记的八类都列成逐类必查项。
 */

/** 速查区的条目类型见 shared/text.ts 的 ENTRY_KINDS（闭集，方便统计「哪一类总被漏」）。 */

export interface WindowItemsShape {
  propositions: CheatsheetProposition[];
  entries: CheatsheetEntry[];
  /** 术语也带 quote —— 没有引文就回跳不了，呈现层会把它并进速查的【定义】 */
  terms: CheatsheetTerm[];
}

/**
 * ★ 对照实验用：整节一次给模型的单发提示词 ★
 *
 * 为什么值得试：V3 那条路（切窗 → 逐窗采集 → 合并 → 判据复核）存在的全部理由是
 * 「一次输出装不下整节」——短窗是为了让每一窗的输出预算够用、不被前段吃掉。
 * 但代价明确：N+2 次调用、跨窗重复要靠合并去抹、判据只能做减法。
 * 如果模型能一次读完整个节（长上下文），单发可能用 1 次调用拿到不差的结果。
 *
 * ★ 两档刻意写成「几乎不管」★
 *   minimal —— 只给 JSON 骨架 + 一条 quote 硬约束。回答「模型自己会不会整理」。
 *   brief   —— 多给四行类别说明。回答「那几行提示词值不值这个钱」。
 * 提示词写长很容易显得专业，但那样就看不出**哪几句是真正必要的**。
 * 要判断该留什么，得先减到最少再往上加。
 *
 * 唯一不能省的是 quote 的形状：覆盖率、定位回跳、去重全靠它，
 * 模型自己发明的「引用」没法回原文比对（见 coverage.ts）。
 */
export function cheatsheetOneShotPrompt(args: {
  docTitle: string;
  headingPath: string[];
  unitTitle: string;
  text: string;
  style?: 'minimal' | 'brief';
  /**
   * 正文放哪：
   *   'user'（默认）—— 拼在 user 消息里，最直白。
   *   'context'     —— 不放进来，由调用方作为独立上下文消息提供
   *                    （Kimi 的 files 接口就是这条：抽取后的文本官方建议单独放 system）。
   */
  bodyPlacement?: 'user' | 'context';
}) {
  const path = args.headingPath.length ? args.headingPath.join(' > ') : '（无标题）';
  const style = args.style ?? 'minimal';

  const schema =
    '{"focus":"这一节在回答什么问题","gist":"一句话回答",' +
    '"propositions":[{"subject":"概念A","rel":"关系","object":"概念B","statement":"完整陈述","why":"为什么（没有就空串）","quote":"原文片段"}],' +
    '"entries":[{"kind":"定义|等式|数值|类比|清单","text":"完整内容","quote":"原文片段"}],' +
    '"terms":[{"term":"术语","meaning":"解释","quote":"原文片段"}]}';

  const system =
    style === 'minimal'
      ? [
          '你是帮人做知识整理的助教。把下面这一节整理成一份小抄：关键信息，以及关键信息之间的关键关联。',
          '每条都要带 quote —— 从原文里**逐字复制**的连续片段（10~60 字）。程序要拿它回原文定位，改写或拼接不相邻的句子就找不到了。',
          '只输出 JSON，不要任何解释：',
          schema,
        ].join('\n')
      : [
          '你是帮人做知识整理的助教。把下面这一节整理成一份小抄：关键信息，以及关键信息之间的关键关联。',
          '· propositions 写概念之间的关系，rel 用「导致 / 用于解决 / 前提是 / 区别于 / 优于 / 例外 / 属于 / 等价」这类词。',
          '· entries 按 kind 分类：定义 / 等式 / 数值 / 类比 / 清单。等式与数值**原样保留**，一个符号都不许改。',
          '· terms 写专有名词及解释。',
          '· 只依据原文；不许写「本节」「上文」这类指代词，直接写具体名词；不要复述原文，不要写目录导览句。',
          '每条都要带 quote —— 从原文里**逐字复制**的连续片段（10~60 字）。程序要拿它回原文定位，改写或拼接不相邻的句子就找不到了。',
          '只输出 JSON，不要任何解释：',
          schema,
        ].join('\n');

  const head = `文章：${args.docTitle}\n标题链：${path}\n这一节：${args.unitTitle}\n\n`;
  const user =
    args.bodyPlacement === 'context'
      ? head + '正文已作为上下文提供。请整理成小抄，输出 JSON。'
      : head + `正文：\n---\n${args.text}\n---\n\n请整理成小抄，输出 JSON。`;

  return { system, user };
}

/** 一个窗口（长节的一段）的采集提示词。 */
export function cheatsheetV3WindowPrompt(args: {
  docTitle: string;
  headingPath: string[];
  unitTitle: string;
  index: number;
  total: number;
  text: string;
  /** 本片段里带「▲用户高亮」标记的段落数；大于 0 时追加用户标注指令 */
  hlCount?: number;
}) {
  const path = args.headingPath.length ? args.headingPath.join(' > ') : '（无标题）';
  const where =
    args.total === 1
      ? '这一段就是全部内容。'
      : `这是这一节的第 ${args.index} 段（共 ${args.total} 段）。` +
        (args.index === args.total ? '它是**最后一段**，别因为快结束了就写得潦草。' : '');

  const system = [
    '你是一个帮人做知识整理的助教。我给你一篇文章里的**一个片段**，不是全文。',
    '你的任务不是概括它，而是**把它值得留下的东西捡出来**。',
    '',
    '★ 你是这个片段的唯一负责人 ★',
    '后面合并时只看你交上来的东西——你漏了的，没人能补。',
    '所以别偷懒跳过任何一段；但也别把原文换个说法再抄一遍。',
    ...(args.hlCount
      ? [
          '',
          '★ 用户的标注（最高优先级）★',
          `  正文里带「▲用户高亮」标记的段落，是读者读到这里时亲手划下的重点（本片段共 ${args.hlCount} 处）。`,
          '  这些段落里值得留下的信息**一条都不许漏**——漏一处就是缺陷。',
          '  其余段落照常按八类判据采集，不要因为存在标注就只顾标注段。',
          '  「▲用户高亮」这个标记本身不是正文：quote 里绝对不能包含它。',
        ]
      : []),
    '',
    '★ 每条都要过一遍这个判据 ★',
    '「如果这条不写，读者会损失什么？」——答不出具体损失的，删掉。',
    '  复述式的句子（把原文的同义句抄短）、过渡句、目录导览（「后续章节将…」',
    '  「第六章讲的是…」）、纯举例，都答不出损失，不要写。',
    '',
    '★ 逐类过一遍，这八类都要查（不是只挑好写的）★',
    'A 命题：两个概念之间的一条关系。关系只能从这 8 个里选，不许自创：',
    `   ${RELATION_KINDS.join(' / ')}`,
    '   注意：「属于 / 等价」加起来不许超过命题数的 40%——',
    '   全是「A 属于 B」等于把目录重画一遍，那是没整理。',
    'B 定义：某个概念「是什么」。',
    'C 等式：X = Y + Z 这类式子。**必须逐字抄下来，一个符号都不许改**',
    '   （例如 `Agent = Model + Harness`、`Harness = 上下文管理 + 工具接口 + 约束 + 验证 + 纠正`）。',
    'D 数值：具体数字、比例、参数、性能对比（例如「得分从 52.8% 提升到 66.5%」）。',
    'E 类比：帮助理解的比喻（例如「LLM 是大脑，上下文是眼睛，工具是手脚」）。',
    'F 清单：原文枚举出来的几类东西（例如「工具分感知、执行、协作、事件触发四类」）。',
    'G 边界：什么条件下成立、什么条件下不成立。',
    'H 术语：这一段出现的专有名词及其解释。',
    '',
    '★ 数量（是上限，不是目标）★',
    '  propositions 最多 8 条、entries 最多 6 条、terms 最多 5 条。',
    '  一段一两千字通常只值得记 4~6 条命题；写满上限往往说明你在复述。',
    '',
    '★ 落到哪个字段 ★',
    '  A → propositions（要用 subject / rel / object 三个字段，关系取自上面 8 个）',
    '  B C D E F → entries（用 kind 标类别：定义 / 等式 / 数值 / 类比 / 清单）',
    '  G → propositions（rel 用「例外」或「前提是」）',
    '  H → terms（★ 术语也要带 quote：抄「术语名第一次出现的那句话」或者给它下定义的那句）',
    '',
    '硬性要求：',
    '1. 只依据给定的片段，不要引入片段之外的知识。',
    '2. 每条都要带 quote：**从片段里逐字复制的连续片段**（10~60 字）。',
    '   不要改写、不要加省略号、不要拼接不相邻的句子——程序要拿它回正文定位，改写就找不到了。',
    '3. subject / object 是**名词短语**（「观察空间」「4-bit 量化」），不是整句。',
    '4. statement / text 不超过 60 字，能脱离上下文独立看懂，',
    '   禁止写「本节」「上文」这类指代词，直接写具体名词。',
    '5. 不许同义反复：subject 和 object 必须是两个不同的概念。',
    '6. entries 的 text 要写完整；等式要带等号两侧，不要只写左边。',
    `7. ${NO_SELF_REF}`,
    '',
    '★ 反面例子 ★',
    '  ✗ 只写「模型能力不可预测」——这是复述，不是可用的知识',
    '  ✓ Harness —用于解决→ 模型能力不可预测导致的可靠性问题',
    '  ✗ 等式改成「Agent 由模型和 Harness 组成」——把式子改写了，找不回原文',
    '  ✓ 原样抄下 `Agent = Model + Harness`',
    '  ✗ 「第六章（交互）不属于 Harness 五要素」——这是书的目录信息，不是知识',
    '  ✗ 「后续章节将逐一深入 Harness 的各个组件」——导览句，读者没有损失',
    '',
    '输出 JSON（没有的类别给空数组，不要硬凑，但确实有就必须写）：',
    '{"propositions":[{"subject":"概念A","rel":"导致","object":"概念B",',
    '"statement":"完整陈述","why":"为什么，没有就空字符串","quote":"原文片段"}],',
    '"entries":[{"kind":"等式","text":"Agent = Model + Harness","quote":"原文片段"}],',
    '"terms":[{"term":"术语","meaning":"解释","quote":"原文片段"}]}',
  ].join('\n');

  const user =
    `文章：${args.docTitle}\n标题链：${path}\n所在位置（仅用于定位，${NO_SELF_REF}）：${args.unitTitle}\n` +
    `${where}\n\n片段正文：\n---\n${args.text}\n---\n\n` +
    `请把这个片段里值得留下的东西全部捡出来，输出 JSON。`;

  return { system, user };
}

/**
 * 合并各窗口的采集结果：跨窗口去重、排序、写焦点问题与一句话。
 *
 * ★ 两种形态，别混用 ★
 *   - `batch`：长节分批归并里的**一批**。只做减法（合并重复 / 删不该记的 / 压层级链），
 *     不写 focus / gist——那是顶层收口的事。为什么不让每一批都写：一批只看得见
 *     整节的一部分，它写的"焦点问题"必然是局部的；而且那几十个字的输出预算
 *     要从同一份预算里扣，等于又回到「预算被前段吃掉」。
 *   - 不传 `batch`：顶层收口，输入是（可能已经归并过的）全节条目，写 focus / gist。
 */
export function cheatsheetV3MergePrompt(args: {
  docTitle: string;
  headingPath: string[];
  unitTitle: string;
  collected: WindowItemsShape[];
  /** 分批归并的第 index / total 批（1 起）。传了就按「批」的形态写提示词。 */
  batch?: { index: number; total: number };
  /** 输入是上一级归并的结果（不是原始窗口采集结果），措辞要跟着变。 */
  fromMerge?: boolean;
}) {
  const path = args.headingPath.length ? args.headingPath.join(' > ') : '（无标题）';
  const batch = args.batch;

  const head = batch
    ? [
        `你在归并一份「分段采集」结果里的**一批**（第 ${batch.index} 批，共 ${batch.total} 批）。`,
        '这一节太长了，采集结果被分成几批分别归并，最后再统一收口。',
        `**你只管这一批**：其它批由别的调用处理，你不要替它们操心，也不要写焦点问题。`,
        '采集阶段的策略是「宁可多写」，所以**你这一环是减法**——一份好的小抄比输入短。',
      ]
    : [
        '你在把一份「分段采集」的结果合并成一份完整小抄。',
        args.fromMerge
          ? '输入是这一节分组归并后的结果（不是原始分段采集结果）——跨组的重复还没合并完，继续做减法。'
          : '输入是同一个节的若干段各自采集出的条目（已由机器去过一遍同引文的重复）。',
        '采集阶段的策略是「宁可多写」，所以**你这一环是减法**——一份好的小抄比输入短。',
      ];

  const tasks = batch
    ? [
        // ★ 批层只做去重，不做取舍（2026-09-17 实测改的）★
        //   原来这里让批层也做「删不该记的 + 压层级链」，还写着「合并后的条数一般
        //   降到输入的 50~70%」。结果：3 批各自砍一半，层层累积 —— 12 窗的节
        //   总压缩 0.52×，比单点收口（0.59×）砍得还狠，覆盖率反而低 2 个点。
        //   取舍是**全局判断**，一批只看得见局部，让它删就是盲删。
        '★ 你要做的事：只合并重复，不做取舍 ★',
        '1. 同一个知识点在这一批里出现了两次以上的，合成一条，保留信息更全的版本，',
        '   quote 选更能支撑它的那句。',
        '2. **不要因为「这条不够重要 / 太细 / 只是个数值」就删它** ——',
        '   取舍统一由最后收口的那一步做，你这里删掉的东西后面没人能补回来。',
        '3. 「属于 / 等价」占比、层级链怎么压，也归收口那一步，你不用管。',
        '',
        '也就是说：**你的输出条数应该和输入差不多**（只少了重复的那些）。',
        '如果你砍掉了一半以上，说明你在越权做取舍 —— 那是错的。',
      ]
    : [
        '★ 你要做的四件事 ★',
        '1. **合并重复**：同一个知识点在多段里都出现过，合成一条，',
        '   保留信息更全的版本，quote 选更能支撑它的那句。',
        '   分段采集的重复率通常很高——**合并后的条数一般会降到输入的 50~70%**。',
        '   如果你合并完几乎没减少，说明你没找出重复。',
        '2. **删掉不该记的**：同义反复、复述式句子、目录导览',
        '   （「后续章节将…」「第六章讲的是…」这类），以及纯举例的句子。',
        '3. **压掉层级链**：「属于 / 等价」类的关系加起来不许超过命题总数的 40%。',
        '   如果输入里有一串 A属于B、B属于C、C属于D，合成一条把整体层级说清楚就够，',
        '   不要每一层都留一条。',
        '4. 写 focus（这一节整体在回答什么问题）和 gist（一句话回答）。',
        '   focus / gist 要覆盖**整节**，不要只反映开头那几段。',
      ];

  const system = [
    ...head,
    '',
    ...tasks,
    '',
    '★ 两条铁律 ★',
    '· **quote 必须原样保留**，一个字符都不许改。要换一句也必须从输入里已有的 quote 里挑。',
    '  程序会拿 quote 回原文定位，改写了这条就会被丢弃。',
    '· **减法只减冗余，不减具体信息**。等式、数值、专名、明确的机制——',
    '  这些是这份小抄的价值所在，哪怕它们「不够概括」也要留着。',
    '  该减的是「同一件事说了两遍」和「换个说法重抄原文」。',
    '',
    '其它：',
    `· ${NO_SELF_REF}`,
    '· entries 的 kind 只能是：' + ENTRY_KINDS.join(' / '),
    '· 术语（terms）和速查里的【定义】讲的是同一个词时只留【定义】，别出现两条说同一件事的；',
    '  术语条同样必须带 quote（抄术语名出现的那句原话）。',
    '· 保持中文。',
    '',
    '输出 JSON：',
    ...(batch
      ? [
          '{"propositions":[{"subject":"","rel":"","object":"","statement":"","why":"","quote":""}],',
          '"entries":[{"kind":"","text":"","quote":""}],',
          '"terms":[{"term":"","meaning":"","quote":""}]}',
        ]
      : [
          '{"focus":"这一节在回答什么问题","gist":"一句话回答",',
          '"propositions":[{"subject":"","rel":"","object":"","statement":"","why":"","quote":""}],',
          '"entries":[{"kind":"","text":"","quote":""}],',
          '"terms":[{"term":"","meaning":"","quote":""}]}',
        ]),
  ].join('\n');

  const itemsWord = batch
    ? `本批条目（第 ${batch.index}/${batch.total} 批${args.fromMerge ? '，来自上一级归并' : ''}）：`
    : args.fromMerge
      ? `各组归并结果（共 ${args.collected.length} 组，每组是一批的归并产物）：`
      : `各段采集结果（共 ${args.collected.length} 组）：`;

  const user =
    `文章：${args.docTitle}\n标题链：${path}\n这一节：${args.unitTitle}\n\n` +
    itemsWord +
    '\n```json\n' +
    JSON.stringify(args.collected, null, 1) +
    '\n```\n\n' +
    (batch ? '请把这一批归并成更短的一份，输出 JSON。' : '请合并成一份完整小抄。');

  return { system, user };
}

/** V3 小抄的 markdown 呈现。 */
export function renderCheatsheetV3Markdown(s: {
  focus: string;
  gist: string;
  propositions: CheatsheetProposition[];
  entries: CheatsheetEntry[];
  terms: { term: string; meaning: string }[];
}): string {
  const out: string[] = [];
  if (s.focus) out.push(`**焦点问题**：${s.focus}`);
  if (s.gist) out.push(`**一句话**：${s.gist}`);

  if (s.propositions.length) {
    out.push('', '**命题**');
    for (const p of s.propositions) {
      out.push(`- **${p.subject}** —${p.rel}→ **${p.object}** —— ${p.statement} \`${p.quote}\``);
      if (p.why) out.push(`  - 为什么：${p.why}`);
    }
  }
  if (s.entries.length) {
    out.push('', '**速查**');
    for (const e of s.entries) {
      out.push(`- 【${e.kind}】${e.text}${e.quote ? ` \`${e.quote}\`` : ''}`);
    }
  }
  if (s.terms.length) {
    out.push('', '**术语**');
    for (const t of s.terms) out.push(`- **${t.term}**：${t.meaning}`);
  }
  return out.join('\n');
}

// ─────────────────────────── 测验题 ───────────────────────────

export interface QuizShape {
  questions: {
    type: 'single' | 'multi' | 'blank' | 'short';
    stem: string;
    options: string[];
    answer: (number | string)[];
    explain: string;
    citations: { quote: string; blockIndex: number }[];
  }[];
}

export function quizPrompt(ctx: UnitContext, count: number, blockIndexHint: string) {
  const system = [
    '你是一个出题老师。根据给定的一段正文出测验题，用来检验学生是否真的读懂了。',
    '',
    '硬性要求：',
    '1. 只能考正文里明确讲过的内容，不要考正文之外的常识。',
    '2. 每道题的 citations 至少有一条，quote 必须是**从正文里逐字复制的连续片段**',
    '   （10~40 字，不要改写、不要加省略号），blockIndex 从给定的块号表里选。',
    '3. 题型分布：优先 single（四选一）；有多个并列要点的内容用 multi；',
    '   定义类、术语类可以用 blank；需要理解的因果类可以用 short。',
    '4. single 必须有 4 个选项，干扰项要**似是而非**（常见误解、容易混淆的近邻概念），',
    '   不要用「以上都对」「以上都不对」凑数。answer 是正确选项的下标（从 0 开始）。',
    '5. multi 至少 4 个选项、至少 2 个正确。answer 是所有正确项下标。',
    '6. blank 的答案要唯一确定；answer 可以给多个可接受的写法。',
    '7. short 是简答题，answer 给评分要点（字符串数组，每条一个要点）。',
    '8. explain 要说明为什么这个答案对、其他选项错在哪，不超过 100 字。',
    '9. 用中文。题干要具体，不要「关于这段内容，下列说法正确的是」这种空泛问法。',
    `10. ${NO_SELF_REF}`,
    '',
    '输出 JSON：',
    '{"questions":[{"type":"single","stem":"题干","options":["A","B","C","D"],',
    '"answer":[0],"explain":"解析","citations":[{"quote":"原文片段","blockIndex":12}]}]}',
  ].join('\n');

  const user = [
    header(ctx),
    '',
    '正文：',
    '---',
    clip(ctx.text, 10_000),
    '---',
    '',
    blockIndexHint,
    '',
    `请出 ${count} 道题。`,
  ].join('\n');
  return { system, user };
}

/** 告诉模型「哪块文字对应哪个块号」，这样它给的 blockIndex 才可能是对的。 */
export function blockIndexHint(blocks: { bi: number; text: string }[], unit: StudyUnit): string {
  const rows = blocks
    .filter((b) => b.bi >= unit.startBi && b.bi < unit.endBi)
    .map((b) => `[${b.bi}] ${b.text.slice(0, 80)}`);
  if (!rows.length) return '（块号表为空）';
  return ['块号表（blockIndex 必须从下表里选）：', ...rows].join('\n');
}

// ─────────────────────────── 闪卡 ───────────────────────────

export interface CardShape {
  cards: { front: string; back: string; quote: string }[];
}

/**
 * 一棵树要拆成闪卡时的「取卡清单」。
 *
 * ★ 为什么是清单而不是直接给 markdown ★
 *   「全部覆盖」这种要求，光写进提示词是不算数的——模型只会出它想得到的那些。
 *   ���把树里每个可考的东西编号列出来（一个节点一条、每条「值得单独考」的细节再一条），
 *   并要求每条都有交代，模型就必须逐条处理。
 *
 * ★ 哪些细节不单独出卡 ★
 *   细节条本身已经是「精炼过的一句话」，把它照搬成卡的正面既不构成问题、
 *   也没有额外信息量（那是把树抄了一遍）。真正值得单独出卡的是**能被提问的**那几类：
 *   等式、数值、定义、类比、例子、原则。其余（要点/清单）留在 essence 那张卡里。
 */
export interface CardSlot {
  /** N1 / N2（节点）或 D3.1（某节点的第 1 条细节） */
  id: string;
  /**
   * ★ 这条槽位「该问什么」—— 直接写成问句方向 ★
   *
   * ★ 为什么不能写成名词短语 ★
   *   第一版这里给的是「Agent 产品形态 · 例子」这种标签。它是名词短语，
   *   而模型的任务是「造一个问题」——给它名词，它就会照抄成正面，
   *   于是卡就长成「Agent 产品形态 · 例子」，这在复习时根本没法用。
   *   现在这一行本身就是问句方向，模型的任务降级成「把这句方向写成自然的提问」，
   *   抄无可抄。`label` 仍然保留（给人看 + 报错时定位），但不再当提示词的主体。
   */
  ask: string;
  /** 给人看的来源标签（不出现在给模型的主提示里，只在清单里标注） */
  label: string;
  /** 该考什么（节点的 essence 或细节原文）——这是答案素材 */
  body: string;
}

/** 值得单独出卡的细节类型。其余类型只进 essence 卡。 */
const CARDABLE_DETAIL = new Set(['等式', '数值', '定义', '类比', '例子', '原则', '事实']);

/** 节点 kind → 该问什么方向。写问句而不是「是什么」，逼模型问出真正的问题。 */
const ASK_BY_KIND: Record<string, string> = {
  概念: '它是什么、在解决什么问题',
  机制: '它怎么起作用的（说清过程，不是复述结论）',
  做法: '具体该怎么做（步骤 / 判据 / 手法）',
  方法: '具体该怎么做（步骤 / 判据 / 手法）',
  原则: '做这件事时必须遵守什么、违反会怎样',
  事实: '具体是多少 / 什么时候 / 什么结果',
};

/** 细节 kind → 该问什么方向。 */
const ASK_BY_DETAIL: Record<string, string> = {
  等式: '写出这条公式（逐字，别改符号）',
  数值: '具体数字是多少、和什么对比',
  定义: '给出这个定义（逐字保留关键限定词）',
  类比: '原文用什么打比方来说明它',
  例子: '原文举了哪个具体例子 / 哪个产品或场景',
  原则: '这条要求是什么、为什么这么要求',
  事实: '这个实验 / 事件的具体结论是什么',
};

/**
 * 把一棵树摊成带编号的取卡清单。
 *
 * 编号用「节点 N / 细节 N.k」，是为了让提示词能说「每一条都要交代」，
 * 也能让返回的卡反查自己出自哪一条 —— 覆盖这件事因此是可核对的。
 */
export function cardSlotsOf(nodes: {
  name: string;
  essence: string;
  kind: string;
  details: { kind: string; text: string; quote?: string }[];
}[]): CardSlot[] {
  const slots: CardSlot[] = [];
  let n = 0;
  for (const node of nodes) {
    n += 1;
    const name = node.name;
    const dir = ASK_BY_KIND[node.kind] ?? ASK_BY_KIND['概念'];
    slots.push({
      id: `N${n}`,
      // 主语带上完整节点名 —— 正面不许出现「它的作用是什么」这种无主语的问法
      ask: `围绕「${name}」提问：${dir}`,
      label: `${name}（${node.kind}）`,
      body: node.essence || '',
    });
    node.details.forEach((d, i) => {
      if (!CARDABLE_DETAIL.has(d.kind)) return;
      if (!d.text || d.text.trim().length < 4) return;
      const dir2 = ASK_BY_DETAIL[d.kind] ?? ASK_BY_DETAIL['事实'];
      slots.push({
        id: `D${n}.${i + 1}`,
        // 细节这类最容易照抄，所以把要问的东西直接说出来，让模型没有可抄的对象
        ask: `就「${name}」的这条${d.kind}提问：${dir2}`,
        label: `${name} · ${d.kind}`,
        body: d.text,
      });
    });
  }
  return slots;
}

/** 清单的可读渲染：编号 + 该问什么 + 答案素材。 */
export function renderCardSlots(slots: CardSlot[]): string {
  return slots
    .map(
      (s) =>
        `[${s.id}] 该问：${s.ask}\n` +
        `     素材：${s.body}\n` +
        `     ⚠ 上面这一行是**答案素材**，不要照抄成正面；正面要写成一句完整的问句。`,
    )
    .join('\n');
}

/**
 * 树 → 闪卡。
 *
 * ★ 与旧版 cardsFromCheatsheetPrompt 的唯一区别是「输入源」★
 *   旧版喂小抄 markdown（小抄已退役，新节拿不到）；这一版喂知识树，
 *   也就是这一节真正有的东西。判据、SM-2、存储结构一概不动。
 */
export function cardsFromTreePrompt(
  ctx: UnitContext,
  tree: { title: string; question?: string; nodes: Parameters<typeof cardSlotsOf>[0] },
  opts?: { nodeCount?: number; detailCount?: number },
) {
  const slots = cardSlotsOf(tree.nodes);
  const nodeCount = opts?.nodeCount ?? tree.nodes.length;

  const system = [
    '把一张「知识点地图」拆成闪卡（正面提问、背面回答），供人间隔复习。',
    '',
    '★ 第一条：正面必须是一句完整的问句 ★',
    '正面要写成「读者会真的问出口的一句话」，句子完整、主语明确、能独立看懂。',
    '★ 绝对不许把下面这些形状当成正面 ★（它们是**标签**，不是问题）：',
    '  ✗ 「Agent 产品形态 · 例子」        ← 节点名 + 类型，直接抄标签',
    '  ✗ 「上下文压缩策略」                ← 只有名词',
    '  ✗ 「例子：Cursor 这类编码 Agent…」   ← 把素材原样贴上来',
    '  ✗ 「它的作用是什么？」              ← 无主语，不知道在问谁',
    '  ✗ 「这段讲了什么」',
    '★ 每张卡都按这个自查 ★',
    '  1. 它是一个问句吗？（有问号或「是什么/为什么/怎么/哪些/写出/说说」）',
    '  2. 不看清单能知道在问什么吗？（不许依赖「上面那条」「这个概念」）',
    '  3. 主语写出来了吗？（要能说出具体名词，不许用「它」「这个」）',
    '  4. 它还是「知识点名 + 类型标签」的形状吗？（是就重写成问句）',
    '',
    '★ 覆盖要求：清单里每一条都要处理，一个都不许漏 ★',
    '清单每条都给了「该问：…」——那是**已经写好的提问方向**，你的任务是把它',
    '改写成一句自然的完整提问，再写出答案；不是看着名词短语自己造题。',
    '每一条都要为它产出至少一张卡，或者判断它不值得单独出卡',
    '（只在真的没有可问的角度时，例如它只是上一条的同义重复）。',
    '★ 逐条核对：交卷前把清单从头到尾扫一遍，确认每个编号都已被覆盖 ★',
    '',
    '要求：',
    '1. 一张卡只考一个点。不要把两条要点塞进同一张卡。',
    '2. 正面完整（有主语、能独立看懂、是真问句）；不要写成需要「看卡片才知道问什么」的线索。',
    '3. 背面直接给答案，**不超过 60 字**（等式和定义可以照抄完整，但别加解释）。',
    '4. quote 字段填该卡片对应的原文引用（从正文里逐字复制 10~40 字）。',
    '   取不到合适引文的，quote 留空字符串，不要硬凑。',
    '5. 只依据知识树和正文，不要新增知识、不要编例子。',
    `6. ${NO_SELF_REF}`,
    '7. 用中文。',
    '',
    '★ 同一个知识点的「节点卡」和「细节卡」不许答成同一个东西 ★',
    '   节点卡问的是这个知识点**整体**（是什么 / 起什么作用 / 由什么组成）；',
    '   细节卡问的是那条**具体信息**本身（这条公式、这个例子、这个数字）。',
    '   ✗ 节点卡「Harness 由哪五个要素组成？」背面「Harness = 上下文管理 + 工具接口 + …」',
    '     细节卡「Harness 的组成等式怎么写？」背面**同一句等式** —— 两张卡考的是同一件事，删一张。',
    '   正确做法：节点卡写「Harness 为什么要拆成五块？拆开后每个块各自管什么？」，',
    '           等式那张细节卡只管「写出那个式子」。',
    '',
    '输出 JSON（cards 的顺序按清单编号排，方便核对）：',
    '{"cards":[{"slot":"N1","front":"正面","back":"背面","quote":"原文片段"}]}',
  ].join('\n');

  const user = [
    header(ctx),
    '',
    `这一节的知识点：${tree.title}`,
    tree.question ? `它回答的问题：${tree.question}` : '',
    '',
    `取卡清单（共 ${slots.length} 条 = ${nodeCount} 个知识点 + ${Math.max(slots.length - nodeCount, 0)} 条值得单独考的细节）：`,
    '---',
    renderCardSlots(slots),
    '---',
    '',
    '正文（仅作参考，用于取 quote 和校对细节，别从中新增卡片）：',
    '---',
    clip(ctx.text, 4000),
    '---',
    '',
    '请输出闪卡 JSON。',
  ]
    .filter(Boolean)
    .join('\n');

  return { system, user, slots };
}

export function cardsFromCheatsheetPrompt(ctx: UnitContext, cheatsheetMarkdown: string) {
  const system = [
    '把一份「小抄」拆成一张张独立的闪卡（正面提问、背面回答）。',
    '',
    '要求：',
    '1. 一张卡只考一个点。不要把两条要点塞进同一张卡。',
    '2. 正面必须是一个具体的问题或一个需要补全的线索（例如「状态转移方程的作用是什么？」',
    '   或「动态规划的两个核心要素：___ 和 ___」），不要写「这段讲了什么」。',
    '3. 背面直接给答案，不超过 80 字。',
    '4. quote 字段填该卡片对应的原文引用（逐字复制 10~40 字）。',
    '5. 只依据小抄和正文，不要新增知识。',
    '6. 用中文。',
    `7. ${NO_SELF_REF}`,
    '',
    '输出 JSON：{"cards":[{"front":"正面","back":"背面","quote":"原文片段"}]}',
  ].join('\n');

  const user = [
    header(ctx),
    '',
    '小抄：',
    '---',
    cheatsheetMarkdown.slice(0, 6000),
    '---',
    '',
    '正文（仅作参考，避免小抄里省略的细节被写错）：',
    '---',
    clip(ctx.text, 4000),
    '---',
    '',
    '请输出闪卡 JSON。',
  ].join('\n');
  return { system, user };
}

export function cardsFromNotesPrompt(
  docTitle: string,
  notes: { body: string; quote: string }[],
) {
  const system = [
    '把用户的读书批注转成闪卡，帮助他在将来复习时想起当时的想法。',
    '',
    '要求：',
    '1. 每张卡的正面是一个能唤起回忆的问题，背面是答案。',
    '   正面应该指向「原文那句话说了什么」，而不是复述批注的措辞。',
    '2. 一条批注最多产出一张卡。批注本身没有信息量的（例如只写了「同意」「注意」），跳过它。',
    '3. quote 必须原样使用给定的原文引用，不要改写。',
    '4. 用中文。',
    `5. ${NO_SELF_REF}`,
    '',
    '输出 JSON：{"cards":[{"front":"正面","back":"背面","quote":"原文片段"}]}',
  ].join('\n');

  const user = [
    `文章：${docTitle}`,
    '',
    '批注列表：',
    ...notes.map((n, i) => `${i + 1}. 原文：${n.quote}\n   批注：${n.body}`),
    '',
    '请输出闪卡 JSON。',
  ].join('\n');
  return { system, user };
}

// ─────────────────────────── AI 排版（规则版不够好时的加强） ───────────────────────────

export function formatPrompt(raw: string) {
  const system = [
    '你是一个 Markdown 排版工具。把用户给的杂乱文本整理成结构清晰的 Markdown。',
    '',
    '铁律：',
    '1. **只整理格式，绝不增删改写内容**。不要润色措辞，不要补充信息，不要删掉「多余」的句子。',
    '2. 不要输出任何解释、开场白或 Markdown 围栏，直接输出排版后的正文。',
    '3. 可以做的：合并被硬换行截断的段落、把疑似标题的行标成 ## 或 ###、',
    '   统一列表标记、去掉重复的页眉页脚和页码、规整空行、在代码块外围加上 ``` 围栏。',
    '4. 不确定某一行是不是标题时，就当普通段落，不要乱加 #。',
    '5. 保留原文的语言（中文就中文，英文就英文）。',
  ].join('\n');

  const user = `请排版以下文本：\n\n---\n${raw.slice(0, 20_000)}\n---`;
  return { system, user };
}

// ─────────────────────────── 跨文章问答（RAG） ───────────────────────────

export interface RagPassage {
  /** 展示给模型的编号，从 1 开始 */
  n: number;
  docTitle: string;
  headingPath: string[];
  text: string;
}

/**
 * 已经逐字比对确认过的分歧，喂给问答模型用。
 *
 * ★ 这一层为什么值得接 ★
 *   提示词第 3 条本来就写着「片段之间可能有冲突，遇到冲突就都列出来」——
 *   但那是**完全指望模型自己发现**。片段一多、话一绕，模型经常直接挑一个说法当答案，
 *   而用户看到的是「我的笔记里就是这么说」，等于把冲突掩盖掉了。
 *   现在程序已经做过一次确定性的比对（共享稀有短语锁定同一件事 + 数值/上下限/反义），
 *   把这个结论明确告诉模型，才能真的做到「分别陈述两侧」。
 */
export interface RagConflict {
  /** 是哪两个片段对不上（和下面的 [n] 对应） */
  aN: number | null;
  bN: number | null;
  aClaim: string;
  bClaim: string;
  conflictAt: string;
  reason: string;
}

/**
 * 跨文章问答的提示词。
 *
 * ★ 为什么这里不要求 quote 逐字复制 ★
 *   小抄 / 测验里的引用要拿去正文里定位做高亮，所以必须逐字；
 *   这里的引用只是给模型「这段话来自哪里」的线索，最终展示给用户的是
 *   片段编号 [1][2]，用户点一下就跳过去。要求模型逐字复制长段落只会
 *   浪费额度并且更容易出错，所以只要求「用编号标注来源」。
 *
 * ★ 为什么强调「没找到就说没找到」 ★
 *   检索召回的片段里经常只有擦边内容，模型很容易用自己脑子里的知识
 *   把答案补完整，而用户会以为这是自己笔记里写的。这对学习工具是致命的。
 *   所以第一条就是硬约束：片段里没有，就直说。
 */
export function ragAnswerPrompt(question: string, passages: RagPassage[], conflicts: RagConflict[] = []) {
  const system = [
    '你是一个帮用户查阅自己笔记的助手。用户会在整个笔记库里检索到若干片段，',
    '你要**只依据这些片段**回答他的问题。',
    '',
    '硬性要求：',
    '1. 只能用给定片段里的内容回答。片段里没有的信息，就直接说明「笔记里没有提到」，',
    '   **绝对不要**用自己的知识补充、推测或举例。',
    '2. 每个结论或每句话后面，用方括号标出它依据的片段编号，例如 [1] 或 [2][3]。',
    '   编号必须是下面列出的片段里真实存在的。',
    '3. 片段之间可能有冲突（不同书写于不同时间、观点不同）。遇到冲突就都列出来，',
    '   并标明各自来自哪个片段，不要擅自选一个当正确答案。',
    // 程序已经比对过的分歧：把「靠自己发现」变成「按给定结论陈述」
    conflicts.length
      ? '3.1 下面「已确认的分歧」是程序逐字比对片段后确认的，**不是猜测**。' +
        '回答时必须分别陈述两侧的说法并各自标注 [n]，不要说成同一个结论，也不要只讲其中一侧。'
      : '',
    '4. 用中文回答。条理清楚，能用列表就用列表，但不要为了凑长度而重复。',
    '5. 如果所有片段都和问题无关，只回答「笔记库里没有找到相关内容」，并简述这几个片段实际在讲什么。',
    `6. ${NO_SELF_REF}`,
    '',
    '直接输出回答正文，不要写「根据你提供的片段」这类开场白。',
  ].join('\n');

  const body = passages
    .map(
      (p) =>
        `[${p.n}] 来源：${p.docTitle}${p.headingPath.length ? ` › ${p.headingPath.join(' › ')}` : ''}\n${clip(p.text, 4000)}`,
    )
    .join('\n\n');

  const lines: (string | null)[] = ['下面是笔记库里检索到的片段：', '---', body, '---'];
  if (conflicts.length) {
    lines.push('', `已确认的分歧（共 ${conflicts.length} 处，程序逐字比对得出）：`);
    conflicts.forEach((c, i) => {
      const x = `[${c.aN ?? '?'}]`;
      const y = `[${c.bN ?? '?'}]`;
      lines.push(
        [
          `分歧 ${i + 1}：${x} 与 ${y}`,
          `  ${x} 的说法：${c.aClaim || '见片段原文'}`,
          `  ${y} 的说法：${c.bClaim || '见片段原文'}`,
          c.conflictAt ? `  对不上在哪：${c.conflictAt}` : null,
        ]
          .filter((s): s is string => !!s)
          .join('\n'),
      );
    });
  }
  lines.push('', `问题：${question}`, '', '请回答。');
  const user = lines.filter((x): x is string => x !== null).join('\n');
  return { system, user };
}
