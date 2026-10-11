/**
 * shared/text.ts —— 全项目唯一的「可见文本」坐标体系定义。
 *
 * ★ 维护红线 ★
 * 本文件是锚点体系的根基。它必须满足两条不可破坏的约束：
 *   1. 不 import 任何东西（尤其不能 import markdown-it），保证前端可以安全地把它
 *      打进客户端 bundle 而不会把 markdown-it 一起拖进来。
 *   2. normalizeText 的实现必须与前端 src/hooks/buildBlockMap.ts 里逐字符构建
 *      归一化索引的逻辑**完全一致**。任何一侧改动都必须同时改另一侧。
 *
 * 为什么锚点不基于 markdown 源字符偏移？
 *   因为 `**加粗**` 的星号、`[文字](url)` 里的 url、代码块的反引号都会让「源偏移」
 *   和「屏幕上的可见偏移」错位。这类编辑在 Obsidian 里极其常见（加个粗体、改个
 *   链接写法），一旦用源偏移做锚点，批注就会集体漂移。所以全项目只用一套坐标：
 *   「渲染后可见纯文本，按块切分后的块内偏移」。
 */

// ─────────────────────────── 块模型 ───────────────────────────

export type BlockType =
  | 'p'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'h4'
  | 'h5'
  | 'h6'
  | 'li'
  | 'td'
  | 'th'
  | 'code';

/** 文档被切分后的一个「块」，是锚点定位的最小单位。 */
export interface Block {
  /** 块序号，从 0 递增，全文档唯一，也是 DOM 上 data-bi 属性的值 */
  bi: number;
  type: BlockType;
  /** 列表 / 引用嵌套层级，顶层为 0 */
  depth: number;
  /** 该块的归一化纯文本 */
  text: string;
  /** 该块在 docPlain 中的起始偏移（仅作参考，锚点不用它） */
  offset: number;
  /** type 为 h1..h6 时，由标题文本生成的稳定 id */
  headingId?: string;
  /** type 为 h1..h6 时，全部祖先标题文本（由外到内） */
  headingPath?: string[];
  /** type 为 h1..h6 时，同层级同名标题中的出现序号 */
  order?: number;
}

/** 文章里的一个标题。 */
export interface Chapter {
  headingId: string;
  level: number;
  text: string;
  headingPath: string[];
  order: number;
  /** 标题块自身的 bi */
  bi: number;
  /** 该标题管辖内容的结束位置（不含），即下一个同级或更高级标题的 bi */
  endBi: number;
}

/**
 * 小抄 / quiz 的生成单位。
 *
 * 基线规则：取最浅一层的 h2（无 h2 时降级 h3，全无标题则整篇一章）。
 * 开启 `NB_UNIT_REPLAN=1` 后按内容量重划：超 15 分钟按原文下一层标题切、
 * 不足 5 分钟的相邻单元合并（见 shared/blocks.ts 的 deriveUnits）。
 *
 * ★ 无论怎么重划，startBi/endBi 永远落在块边界上 ★
 *   所以引文回跳、高亮定位、检索分片的语义都不变。
 */
export interface StudyUnit {
  headingId: string;
  headingText: string;
  /** 0 表示「整篇」这一降级单元 */
  level: number;
  startBi: number;
  endBi: number;
  /**
   * 本单元覆盖的原文标题 id（未合并时 = `[headingId]`）。
   * ★ 为什么需要它 ★ 重划后一个单元可能跨 / 合并多个 h2 节，
   *   存量 sidecar 的 section 是按旧 headingId 存的，靠这个列表才能把它们认回来。
   */
  headingIds?: string[];
  /**
   * 标题链（含自身），供提示词 / 索引描述上下文。
   * ★ 合成单元（按块切分产生、id 带 `~n`）在 chapters 里找不到，
   *   所以标题链必须随单元落盘，不能靠 headingId 反查。
   */
  path?: string[];
}

export interface DocAnalysis {
  blocks: Block[];
  docPlain: string;
  chapters: Chapter[];
  /** 小抄 / quiz 的生成单位 */
  units: StudyUnit[];
}

// ─────────────────────────── 归一化 ───────────────────────────

/**
 * 把任意文本归一化成「渲染后可见文本」的标准形式：
 * 连续空白（含换行、制表、全角空格 \u3000、\u00A0）压缩为单个半角空格，并 trim 首尾。
 *
 * 前端 buildBlockMap 用同样的 `/\s/` 规则逐字符重建索引，两边必须保持一致。
 */
export function normalizeText(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** 判断单个字符是否属于空白（与 normalizeText 的 \s 语义一致）。 */
export function isSpaceChar(ch: string): boolean {
  return /\s/.test(ch);
}

// ─────────────────────────── 锚点选择器 ───────────────────────────

export type AnchorState = 'ok' | 'repaired' | 'orphan';

/**
 * 一条批注 / 一个高亮的定位信息。
 *
 * textOffset 存的是**块内偏移**而不是全文档偏移：全文档偏移在任何一个前置块被
 * 增删之后就全部失效；块内偏移只依赖本块内容，稳定性高一个数量级。
 */
export interface TextQuoteSelector {
  type: 'text-quote';
  /** 被选中的原文（归一化后） */
  quote: string;
  /** 前 40 字上下文，用于消歧 */
  prefix: string;
  /** 后 40 字上下文，用于消歧 */
  suffix: string;
  /** 主定位：块序号 */
  blockIndex: number;
  /** 块内起始偏移（相对 block.text） */
  textOffset: number;
  /** 所在章节的 headingId，辅助失效重定位 */
  headingId?: string;
  quoteLength: number;
}

export interface AnchorRepairRecord {
  at: string;
  reason: string;
  from: { blockIndex: number; textOffset: number };
  to: { blockIndex: number; textOffset: number };
}

// ─────────────────────────── 批注 / 高亮 / 小抄 / 题目 / 卡片 ───────────────────────────

export interface Highlight {
  id: string;
  selector: TextQuoteSelector;
  /** 关联的批注 id；纯高亮（没写批注）时为 null */
  noteId: string | null;
  color: HighlightColor;
  anchorState: AnchorState;
  createdAt: string;
  updatedAt: string;
}

/**
 * 批注下的一条回复（B2-2，2026-09-22 接入）。
 *
 * ★ author 是硬隔离，不是展示细节 ★
 *   反馈汇总（feedback digest）、eval-set、偏好投影只准读 author:'user' 的内容；
 *   助手回复不得被下游当成「她认可过的知识」。隔离做在数据模型里，
 *   不靠调用方自觉（DSH 施工图《批注回复通道》第 1 条语义）。
 */
export interface NoteReply {
  id: string;
  author: 'user' | 'assistant';
  body: string;
  createdAt: string;
  /** 哪个入口写的（如 'mcp:reply_note' / 'web'），便于审计 */
  source?: string;
}

export interface Note {
  id: string;
  selector: TextQuoteSelector;
  body: string;
  tags: string[];
  color: HighlightColor;
  anchorState: AnchorState;
  repairHistory: AnchorRepairRecord[];
  createdAt: string;
  updatedAt: string;
  /**
   * 这条批注下的回复线程。可选字段：存量批注没有它也完全合法（不触发锚点重算）。
   * 回复锚在 note 上、不锚在 bi 上——锚点修复搬运 note 时 replies 自然跟着走。
   */
  replies?: NoteReply[];
}

export type HighlightColor = 'yellow' | 'green' | 'blue' | 'pink' | 'purple';

// ─────────────────── 小抄的结构化条目（落盘契约） ───────────────────
/**
 * ★ 为什么条目结构必须落在共享层、而且必须落盘 ★
 *
 * 一开始 sidecar 里只存 markdown，后果有两个：
 *   1. 想改**呈现方式**（比如按原文标题分层）就得重跑一遍模型——结构已经丢了，
 *      而没有任何一条理由是「渲染」需要花 LLM 的钱；
 *   2. 后面「由小抄出闪卡」要拿命题，只能反解析我们自己渲染的 markdown，脆。
 *
 * markdown 和 html 一样，本质是**渲染产物**（会随样式、分组规则过期）。
 * 真正的数据是这些条目。所以：条目落盘，markdown / html 都现渲染。
 */

/** 关系闭集。模型必须从中选一个，不许自创。 */
export const RELATION_KINDS = [
  '导致', // A 导致 B（因果）
  '用于解决', // A 被用来解决 B（目的 / 功能）
  '前提是', // A 成立的前提是 B（条件）
  '区别于', // A 与 B 的关键差别（对比）
  '优于', // A 在某个维度上优于 B（取舍）
  '例外', // A 一般成立，但 B 情况下不成立（边界）
  '属于', // A 是 B 的一种 / 的一部分（层级）
  '等价', // A 也叫 / 等价于 B（别名）
] as const;

export type RelationKind = (typeof RELATION_KINDS)[number];

/**
 * 「有效关联」= 前 6 类。
 * 只写「属于 / 等价」等于把目录重画一遍（做社区检测时就栽过这个坑）。
 * 所以判据里要求这 6 类占比不低于 60%。
 */
export const STRUCTURAL_RELATIONS: readonly RelationKind[] = [
  '导致',
  '用于解决',
  '前提是',
  '区别于',
  '优于',
  '例外',
];

/**
 * 关系边的「另一端」按语义应该是什么（2026-09-22，B1-3）。
 *
 * ★ 为什么需要它 ★ `KRelation.toNode` 只是一个布尔：分不清「另一端本来就是图外的
 * 问题/场景（合法）」和「本该命中图内节点却没命中（可疑）」。给每个关系词一个
 * 期望值，统计脚本才能把后者单独拎出来当回归指标。
 *
 * ★ 这是期望不是裁决 ★ 「用于解决」当然也可以连到图内节点；这里记的是多数情况，
 * 探针按词输出分布，期望表要不要调以数据为准。
 */
export function expectOf(rel: RelationKind): 'node' | 'external' {
  switch (rel) {
    case '用于解决': // 另一端是它要解决的问题/场景（「模型幻觉」「误拒绝」），多半不在图内
    case '例外': // 例外条件是场景/边界情况，同样多半不在图内
      return 'external';
    default:
      // 属于/等价（父概念、别名）、前提是（另一个知识点）、
      // 区别于/优于（对比两端都是知识点）、导致（结果通常也是知识点）
      return 'node';
  }
}

export interface CheatsheetProposition {
  /** 主语概念：名词短语，不写整句 */
  subject: string;
  rel: RelationKind;
  /** 客体概念：名词短语 */
  object: string;
  /** 完整陈述，能脱离上下文独立看懂，不超过 60 字 */
  statement: string;
  /** 为什么（可空）。答不出就留空，绝对不要编——这是 elaborative interrogation 的抓手 */
  why?: string;
  /**
   * ★ 原文是疑问句，这条是模型给出的表述，不是原文的结论 ★
   *   由判据 R2（questionTurnedAssertion）在 vetItems 里打上。
   *   为什么是「标记」不是「删除」：思考题节 5/5 命中，删光会让整节变空、
   *   覆盖率掉到 0 进而触发补采；而且设问句（「什么是 X？」后紧跟答案）里
   *   写答案是**对的**，判据分不清设问与开放式提问。标记只多一个徽章，
   *   删错则是丢内容——判据不确定时，用标记代替删除。
   */
  fromQuestion?: boolean;
  /** 用户的判断。见 FeedbackMark —— 这是系统里唯一的人的反馈。 */
  feedback?: Feedback;
  /** 逐字复制的原文片段；要能同时看到关系两端，找不到就降级进 facts */
  quote: string;
  /**
   * 引文在原文里的块号。落盘时用 validateQuote 算一次，之后归组、渲染、跳转都直接用它。
   *
   * ★ 为什么要落盘、而不是每次现算 ★
   *   现算要拿每条 quote 去扫全部块（一节 40 条 × 全文 362 块），每次打开文档都算一遍；
   *   而块号是确定性的、只跟原文有关 —— 算一次就够。缺省表示引文定位不到。
   */
  bi?: number;
}

/** 速查区的条目类型。闭集，方便统计「哪一类总被漏」。 */
export const ENTRY_KINDS = ['定义', '等式', '数值', '类比', '清单'] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];

/**
 * ★ 用户对一条小抄的判断 —— 系统里唯一「人的判断」的载体 ★
 *
 * 为什么必须有它：整个系统到 2026-09-19 为止都是 **LLM → 人** 的单向流。
 * 1797 条小抄条目，人觉得哪条有用、哪条是废话、哪条重复，
 * **一条都没进系统**。所以「小抄质量好不好」只能靠覆盖率这种代理指标去猜。
 * 有了这个字段，判断才回流，去重阈值、提示词才有了真标签可以对齐。
 *
 * 三个标而不是四个：「差劲」和「没意义」在处置上完全一样，合并成 `down`。
 * `dup` 单独留着，因为它是**唯一能自动验证的标** —— 现在 dice 阈值是拍的，
 * 有了它就变成量出来的。
 */
export type FeedbackMark = 'up' | 'down' | 'dup';

export interface Feedback {
  mark: FeedbackMark;
  /** 选填理由，只有 down 会用到，默认折叠 */
  why?: string;
  at?: string;
}

/** 条目的稳定标识：内容 hash。
 *
 * ★ 为什么不给条目发 id ★
 *   落盘发 id 要改所有已经生成的 1797 条，且条目顺序会随去重/合并变化。
 *   内容的 hash 天然稳定：同一句话不管排在哪个位置、哪次渲染，key 都一样。
 *   所以 id 不落盘，渲染时现算。
 */
export function itemKeyOf(text: string): string {
  // FNV-1a 32bit → 8 位十六进制。零依赖，够短够稳。
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export interface CheatsheetEntry {
  kind: EntryKind;
  /** 完整陈述，能独立看懂 */
  text: string;
  quote: string;
  /** 引文块号，含义同 CheatsheetProposition.bi */
  bi?: number;
  /** 同 CheatsheetProposition.fromQuestion：原文是疑问句，此条不是原文的结论 */
  fromQuestion?: boolean;
  /**
   * 来自术语层的条目会带这一项（术语名）。
   * ★ 术语为什么要并进速查区 ★
   *   实测 chapter2：术语 111 条 = 全部条目的 27.6%，而它的结构里**没有 quote**，
   *   于是 0% 能回跳原文，直接违背「逐字可回跳」；释义平均 49 字（跟命题陈述上限
   *   60 字几乎一样长），同节还重名 8 个。它和【定义】本来就是一回事，
   *   区别只是退掉了引文和关系词。并进来之后：条目数 −27.6%、可回跳率补到 100%。
   */
  term?: string;
  /** 用户的判断。见 FeedbackMark —— 这是系统里唯一的人的反馈。 */
  feedback?: Feedback;
}

export interface CheatsheetTerm {
  term: string;
  meaning: string;
  /** 术语的引文。模型给不出时由程序回原文找（见 cheatsheetRender 的兜底） */
  quote?: string;
  /** 渲染时术语会并进【定义】条目，条目上的三图标要能写回术语本身 */
  feedback?: Feedback;
}

/** 小抄真正的内容。落盘存它，markdown / html 由它现渲染。 */
export interface CheatsheetItems {
  focus: string;
  gist: string;
  propositions: CheatsheetProposition[];
  entries: CheatsheetEntry[];
  terms: CheatsheetTerm[];
}

/**
 * 呈现层会把术语并进速查区的【定义】；这里给出**真正会新增**的术语。
 *
 * ★ 判据放在 shared 而不是渲染层 ★
 *   前端的类型显隐开关要统计「显示出来会有多少条」，统计口径必须和渲染层一致，
 *   否则面板上的数字对不上界面。两边 import 同一个函数，就不会漂移。
 */
export function termsToMerge(items: Pick<CheatsheetItems, 'entries' | 'terms'>): CheatsheetTerm[] {
  const entries = items.entries ?? [];
  const used = new Set<string>();
  const out: CheatsheetTerm[] = [];
  for (const t of items.terms ?? []) {
    const name = (t.term ?? '').trim();
    // 名字太短没意义，同节重名只留第一个
    if (name.length < 2 || used.has(name)) continue;
    used.add(name);
    // 已经有【定义】条目以这个词开头 → 并进去就是重复，跳过
    const already = entries.some(
      (e) => e.kind === '定义' && (e.text ?? '').slice(0, name.length + 2).includes(name),
    );
    if (already) continue;
    out.push(t);
  }
  return out;
}

/** 关系词的同义归一：模型偶尔会写近义词，能对上的就地收编。 */
const REL_SYNONYMS: Record<string, RelationKind> = {
  等价于: '等价',
  就是: '等价',
  前提条件: '前提是',
  需要: '前提是',
  用于: '用于解决',
  解决: '用于解决',
  会造成: '导致',
  引起: '导致',
  好于: '优于',
  不同: '区别于',
};

/**
 * 关系闭集的强制入口。闭集外的自造词（实测 chapter3 出过「共用/职责/边界/分别用于」）
 * 是数据契约的破洞：统计「哪类关系有效」时它们全掉在桶外，闪卡也不敢用。
 * 能同义归一的收编，收编不了的返回 null（调用方决定丢弃还是降级）。
 */
export function normalizeRel(rel: string): RelationKind | null {
  const r = (rel ?? '').trim();
  if (!r) return null;
  if ((RELATION_KINDS as readonly string[]).includes(r)) return r as RelationKind;
  return REL_SYNONYMS[r] ?? null;
}

// ─────────────────────────── 知识树（按知识点关系组织的小抄形态） ───────────────────────────

/**
 * 知识点的种类。判据不是「它是什么词性」，而是读者拿它做什么：
 * 要理解的（概念/机制）、要照做的（做法）、要遵守的（原则）、要记住的（事实）。
 */
export const KNODE_KINDS = ['概念', '机制', '做法', '原则', '事实'] as const;
export type KNodeKind = (typeof KNODE_KINDS)[number];

/**
 * 节点的**职能**维度（2026-10-10 V2 两段式新增，与 kind 正交）。
 *
 * kind 回答「这是什么知识」（概念/机制/…），role 回答「读者拿它做什么」：
 * 讲解=要读懂、例题=要看懂一个具体案例怎么用、练习=要动手做、总结=考前收拢。
 * 张宇教辅验证过：教辅「显得有层次」靠的是顶层职能分区+节点类型化，不是层级深。
 *
 * ★ 与铁律「结构感来自原文目录」不冲突 ★：例题/习题/小结本来就是原文目录的一部分，
 * role 只是把原文已有的分区如实翻译，不是另造分组。
 */
export const KNODE_ROLES = ['讲解', '例题', '练习', '总结'] as const;
export type KNodeRole = (typeof KNODE_ROLES)[number];

/** 细节条的种类（信息类型，不是重要程度）。 */
export const KDETAIL_KINDS = ['要点', '定义', '等式', '数值', '类比', '例子', '清单'] as const;
export type KDetailKind = (typeof KDETAIL_KINDS)[number];

/** 挂在知识点下的具体信息。判断标准：合上原文就再也找不回来的东西。 */
export interface KDetail {
  kind: KDetailKind;
  text: string;
  quote: string;
  /** 引文在原文中的块号。程序定位，模型不给（模型给会错）。 */
  bi?: number;
  /** 用户标注（▲▽⧉）。树条目同样接「人的判断」通道，写回时挂在细节条上。 */
  feedback?: Feedback;
}

export interface KRelation {
  rel: RelationKind;
  /** 另一端：图里的知识点名，或图外的一个问题/条件/场景（名词短语） */
  target: string;
  /** 程序判定：target 是否命中图里的知识点。渲染时区分（实心边 vs 灰边）。 */
  toNode: boolean;
  /** 可选补充，一句话说清这条关系的关键 */
  note?: string;
}

export interface KNode {
  id: string;
  name: string;
  kind: KNodeKind;
  /** 职能（V2 新增，可选；缺省 = 讲解）。旧树无此字段，读路径按缺省处理。 */
  role?: KNodeRole;
  /** 一句话：它是什么 / 起什么作用。≤40 字，必须能独立看懂。 */
  essence: string;
  /**
   * 父知识点的引用；null = 顶层。
   * ★ 双格式兼容（V2 起）★：v2 树存的是**父节点的 id**（精确匹配，改名不断链）；
   *   旧树存的是**父节点的 name**（读路径 id miss 后按归一名兜底匹配）。不迁移旧数据。
   */
  parent: string | null;
  relations: KRelation[];
  details: KDetail[];
  /** 该知识点首次出现处的块号 */
  bi?: number;
  /** 用户对 essence 的标注（同 details.feedback） */
  feedback?: Feedback;
}

export interface KnowledgeTree {
  /** 这一节的主题（不是小标题的复制） */
  title: string;
  /** 这一节在回答的问题 */
  question: string;
  nodes: KNode[];
  /** 以下为生成元信息（不参与结构渲染） */
  model?: string;
  generatedAt?: string;
  /** 生成时该节正文的 hash，用于判断树是否已过期 */
  sourceHash?: string;
  /** 引文定位成功率（located/total），生成时算好落盘 */
  locate?: { located: number; total: number };
  /** 生成管线版本（V2 起）。缺省 = v1（单次调用整树）。 */
  pipeline?: 'v1' | 'v2';
  /** 生成用的 prompt 版本号（离线 AB 把关用），如 'v2-rc1' */
  promptVer?: string;
  /** 资产登记号（assetRegistry 的 aid）。旧树无此字段。 */
  aid?: string;
}

export interface CheatsheetSection {
  headingId: string;
  headingText: string;
  /**
   * 渲染后的小抄 markdown。
   *
   * ★ 它是**快照**，不是数据源 ★
   *   数据源是下面的 items；markdown 只在响应时按当前分组/样式现渲染。
   *   留着这个字段是为了兼容旧 sidecar（那时只有 markdown）和探针脚本。
   *   旧数据没有 items 时，渲染层会现场反解析它（见 parseCheatsheetMarkdown）。
   */
  markdown: string;
  /** 小抄的真正内容。缺省表示旧数据，需要从 markdown 反解析。 */
  items?: CheatsheetItems;
  /**
   * 知识树形态（2026-09-20 起的第二种形态，多鱼拍板「往知识树方向改」）。
   *
   * ★ 与 items 并存，不是替代 ★ 现役条目视图保留作对比；有树的节优先呈现树。
   *   覆盖率/去重/回收站/闪卡仍然全部基于 items——树是**呈现层的新主轴**，
   *   不是新的事实来源。
   */
  tree?: KnowledgeTree;
  /**
   * markdown 渲染后的 HTML —— **只在接口响应里带，不落盘**。
   *
   * 为什么不让前端自己渲染：shared/blocks.ts 依赖 markdown-it，import 它会把整个
   * 库打进客户端包（那个文件顶部也明确写了「前端不要直接 import」）。
   * 为什么不存进 sidecar：正文一改这份 html 立刻过期，留着只会误导。
   * 所以由服务端在每次响应时现渲染，前端拿到即用。
   *
   * ★ 代价是「凡是把 sidecar 发给前端的接口，都必须过一遍 withCheatsheetHtml」★
   *   漏掉任何一个，用户看到的就是「刚生成时内容正常、重新打开只剩一排按钮」。
   *   这个 bug 真发生过：/doc 那条路径当初忘了补。
   */
  html?: string;
  /**
   * 知识树的嵌入版 HTML —— 同 html 一样**只在接口响应里带，不落盘**。
   * 由 withCheatsheetHtml 现渲染（凡发 sidecar 的接口都会过它，树自动跟出去）。
   */
  treeHtml?: string;
  model: string;
  generatedAt: string;
  /** 生成时该章节文本的 hash，用于判断小抄是否已过期 */
  sourceHash: string;
  /**
   * 生成体检数据。落盘的理由：**没有量就没有改进的靶子**。
   *
   * 以前这些都是跑完就丢的返回值，于是「这一节质量如何」只能凭感觉说，
   * 覆盖率探针也只能在离线脚本里读 markdown 反推。落盘之后：
   *   · 界面能直接显示「覆盖 69%」，哪节漏得厉害一眼可见；
   *   · 调提示词前后能对比同一节的数字，而不是靠手感；
   *   · 覆盖率质量门触发了多少次补采，事后可追溯。
   */
  stats?: CheatsheetStats;
  /**
   * 被裁条目回收站（见 CheatsheetDropped）。缺省 = 旧数据/这一节没有裁过东西。
   * 落盘保存：用户 ▲ 复活时从这移回 items，▽/⧉ 确认后移除。
   */
  dropped?: CheatsheetDropped[];
  /**
   * 小抄版本。缺省（1）= 旧版「原句压缩」列表；2 = 命题式；
   * 3 = 窗口化采集（长节分窗口各自提炼，再合并），见 services/cheatsheetV3.ts。
   *
   * 为什么要在数据里留个版本号：切版本后旧小抄的正文没变，sourceHash 判定为
   * 「没过期」，于是用户永远看不到新版。显式记版本才能区分「内容过期」和「格式过期」。
   */
  version?: 2 | 3;
}

/**
 * 合并/复核阶段被裁掉的条目 —— 「回收站」。
 *
 * ★ 为什么留全尸 ★
 *   管线的取舍（同义反复、整句重复、合并归并未保留）以前裁了就没了，
 *   「合并层丢的对不对」永远没有裁判。现在落盘保存，前端折叠区展示，
 *   用户点 ▲ 就复活回正文、点 ▽/⧉ 就是确认裁决 —— 裁决质量第一次有了反馈通道，
 *   而且每一次 ▲/▽ 都是评测数据（见 services/feedback.ts 的 eval-set）。
 */
export interface CheatsheetDropped {
  layer: '命题' | '条目' | '术语';
  /** 为什么被裁（同义反复 / 整句重复 / 术语重名 / 合并归并未保留…） */
  reason: string;
  item: CheatsheetProposition | CheatsheetEntry | CheatsheetTerm;
}

/** 小抄的生成体检数据（见 CheatsheetSection.stats）。 */
export interface CheatsheetStats {
  /** 节内内容块总数（非标题、正文 ≥8 字）——覆盖率的分母 */
  blocks: number;
  /** 被条目引文覆盖的块数 —— 分子 */
  covered: number;
  /** 覆盖率质量门触发的补采次数（0 = 覆盖率达标，没补） */
  gateBackfill: number;
  /** 采集阶段拿到的原始条数（含重复，用于判断模型是不是在复述） */
  collected?: number;
  /** 被判据丢掉的条数 */
  dropped?: number;
  /** 命题里「属于 / 等价」的占比（>0.4 说明在重画目录） */
  catalogRatio?: number;
  /** 各阶段调用的模型次数 */
  calls?: number;
  /** 拆了几个采集窗口 */
  windows?: number;
  /**
   * 合并阶段做了几轮「批内归并」（0 = 顶层一次装得下，没分批）。
   * 长节 >0：说明这一节确实撞上了「一次塞不下」的输出预算问题。
   */
  mergeRounds?: number;
  /** 高亮覆盖：本节高亮块数 / 被覆盖数 / 是否补采过 */
  hl?: { total: number; covered: number; backfill: boolean };
  /**
   * 内部重复率（验收维度之一，判据见 services/cheatsheet.ts 的 dupScan）。
   *
   * `rate` = 被卷进重复的条数 / 总条数。`termPairs` 是「术语层 vs 内容层」的对数
   * ——**结构性的**（术语表本来就是内容层的索引，两份文字一样才是病），
   * `contentPairs` 才是内容层内部的**真重复**。两者处置不同，所以分开记。
   *
   * ★ 它只是指标，不是裁决 ★ 判据在她标注上的判对率 44–56%，假阳性实测过
   *   （`[命题] Model 只负责决定下一步…` vs `[术语] Environment：负责产生…` jac=0.40）。
   */
  dup?: { rate: number; pairs: number; termPairs: number; contentPairs: number };
}

export interface QuizQuestion {
  id: string;
  type: 'single' | 'multi' | 'blank' | 'short';
  stem: string;
  options: string[];
  /** single/multi 用选项下标；blank/short 用可接受答案字符串 */
  answer: (number | string)[];
  explain: string;
  citations: { quote: string; blockIndex: number }[];
}

export interface QuizAttempt {
  at: string;
  answers: Record<string, (number | string)[]>;
  score: number;
  total: number;
  durationMs: number;
}

export interface Quiz {
  id: string;
  headingId: string;
  headingText: string;
  model: string;
  generatedAt: string;
  questions: QuizQuestion[];
  attempts: QuizAttempt[];
}

export interface Sm2State {
  ef: number;
  interval: number;
  repetitions: number;
  lapses: number;
  /** YYYY-MM-DD */
  dueAt: string;
  lastReviewedAt: string | null;
}

export interface Card {
  id: string;
  front: string;
  back: string;
  /**
   * 卡片来源。
   *
   * 'agent' 是「记忆激活」生成的。加这个值的唯一目的是**能把两类卡分开统计**：
   * 要证明 agent 有用，就得能回答「agent 出的卡和人自己出的卡，留存率、复习表现
   * 差多少」。不加这个字段，事后只能靠猜。refId 存激活会话 id，便于回溯整批。
   */
  source: { type: 'cheatsheet' | 'note' | 'quiz' | 'agent'; refId: string; quote: string };
  headingId: string;
  /**
   * 树→闪卡迁移（B3 前置）：卡片归属的知识点 key（conceptKeyOf(节点名)）。
   * 由 migrateCardConcepts 程序派生（quote→原文块→树节点），可重算；只补挂不摘除。
   * 挂上了它，闪卡评分才能聚合进 learning.json 的 cardStats（M2）。
   */
  conceptKey?: string;
  /**
   * 闪卡反馈三件套（2026-09-23）：对齐小抄条目的 ▲▽⧉——这张卡要不要留、
   * 信号供后续生成闪卡时对齐偏好。可选项：存量卡无此字段 = 未标注。
   */
  fb?: 'up' | 'down' | 'dup';
  /** ▽ 反馈的理由（fb=down 时用户可填，随 feedback 快照一起被消费） */
  fbWhy?: string;
  sm2: Sm2State;
  suspended: boolean;
  createdAt: string;
}

export interface Sidecar {
  version: number;
  docPath: string;
  docHash: string;
  indexedAt: string;
  chapters: Chapter[];
  units: StudyUnit[];
  highlights: Highlight[];
  notes: Note[];
  cheatsheet: { sections: CheatsheetSection[] };
  quizzes: Quiz[];
  cards: Card[];
}

export const SIDECAR_VERSION = 1;

// ─────────────────────────── 工具函数 ───────────────────────────

/**
 * 二字符 bigram 集合的 Dice 系数。对中文和英文都表现良好，且不需要分词。
 * 用于 S3（上下文打分）和 S4（模糊 quote 匹配）。
 */
export function dice(a: string, b: string): number {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  if (a === b) return 1;
  const grams = (s: string): Map<string, number> => {
    const m = new Map<string, number>();
    if (s.length === 1) {
      m.set(s, 1);
      return m;
    }
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const ga = grams(a);
  const gb = grams(b);
  let inter = 0;
  let totalA = 0;
  let totalB = 0;
  for (const [, v] of ga) totalA += v;
  for (const [, v] of gb) totalB += v;
  for (const [g, v] of ga) {
    const w = gb.get(g);
    if (w) inter += Math.min(v, w);
  }
  return (2 * inter) / (totalA + totalB || 1);
}

/** 句末标点：模糊匹配的边界扩展不允许跨越它们。 */
const HARD_EDGE = /[。！？；!?;…]/;

/**
 * 找出 needle 在 haystack 中与 needle 最相似的子串。
 * 用于 S4：用户把被批注的那句话改了几个字，但大致还认得出来。
 *
 * 性能：窗口长度限制在 needle 的 ±30%，且当 needle 较长时对「长度」和「位置」
 * 都做粗粒度步进，把复杂度压到可接受范围（最坏情况约 1e5 次 bigram 比较）。
 */
export function bestFuzzySubstring(
  haystack: string,
  needleRaw: string,
): { index: number; length: number; score: number } | null {
  const needle = needleRaw.length > 120 ? needleRaw.slice(0, 120) : needleRaw;
  const n = needle.length;
  if (!haystack || n === 0) return null;
  if (haystack.length < n) {
    const score = dice(haystack, needle);
    return score >= 0.8 ? { index: 0, length: haystack.length, score } : null;
  }
  let best: { index: number; length: number; score: number } | null = null;
  const minLen = Math.max(1, Math.floor(n * 0.7));
  const maxLen = Math.min(haystack.length, Math.ceil(n * 1.3));
  const lenStep = n > 60 ? 3 : 1;
  const posStep = n > 60 ? 2 : 1;

  for (let len = minLen; len <= maxLen; len += lenStep) {
    for (let i = 0; i + len <= haystack.length; i += posStep) {
      const score = dice(haystack.slice(i, i + len), needle);
      if (!best || score > best.score) best = { index: i, length: len, score };
    }
  }
  // 粗步进之后再在最优位置附近做一次细粒度收尾
  if (best && (lenStep > 1 || posStep > 1)) {
    const lo = Math.max(0, best.index - posStep);
    const hi = Math.min(haystack.length, best.index + best.length + posStep);
    for (let len = Math.max(1, best.length - lenStep); len <= Math.min(haystack.length, best.length + lenStep); len++) {
      for (let i = lo; i + len <= hi; i++) {
        const score = dice(haystack.slice(i, i + len), needle);
        if (score > best.score) best = { index: i, length: len, score };
      }
    }
  }
  if (!best) return null;

  // ── 边界扩展 ──────────────────────────────────────────────
  // Dice 天生偏好「短窗口」：把长句截掉一半，剩下那半的 bigram 全部命中，分数反而更高。
  // 直接返回最优窗口会导致高亮只覆盖半句话（用户看起来像画歪了）。
  // 所以拿到最优窗口后，在不把置信度拉低到 85% 以下的前提下向两侧尽量扩，
  // 让命中区间贴合原句的真实边界。
  // 注意：返回的 score 仍是「最优窗口的置信度」，它衡量的是「这里是不是那句话」；
  // 而 index/length 是「建议覆盖的区间」，两者语义不同，不要混用。
  {
    const floor = best.score * 0.85;
    const maxExtend = n;
    let index = best.index;
    let end = best.index + best.length;
    // 句末标点是硬边界：高亮不应该跨句吞掉句号，也不应该从上一句的句号后开始
    const isHardEdge = (ch: string) => HARD_EDGE.test(ch);
    for (let k = 0; k < maxExtend && end < haystack.length; k++) {
      if (isHardEdge(haystack[end])) break;
      if (dice(haystack.slice(index, end + 1), needle) < floor) break;
      end++;
    }
    for (let k = 0; k < maxExtend && index > 0; k++) {
      if (isHardEdge(haystack[index - 1])) break;
      if (dice(haystack.slice(index - 1, end), needle) < floor) break;
      index--;
    }
    if (end - index > best.length) best = { index, length: end - index, score: best.score };
  }
  return best;
}

/** 生成短小的稳定 id。 */
export function shortHash(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c + i, 0x85ebca6b) >>> 0;
  }
  return (h1.toString(36) + h2.toString(36)).slice(0, 10);
}

/** 生成带前缀的业务 id。 */
export function makeId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** 本地日期 YYYY-MM-DD（不用 toISOString，避免时区把日期推错一天）。 */
export function localDate(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 在本地日期上加减天数。 */
export function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, (m ?? 1) - 1, d ?? 1);
  dt.setDate(dt.getDate() + days);
  return localDate(dt);
}
