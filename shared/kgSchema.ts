/**
 * ★ SKOS 知识图谱 —— schema 定义（2026-10-10）★
 *
 * 目标：产出一份**人读 + 机读**双用的知识图谱。
 *
 * ═══ 为什么是这套 schema ═══
 *
 * 知识组织学对概念间关系的标准二分是：
 *   ① 分类关系（Taxonomic）  —— Is-A / Part-of，构成层级
 *   ② 非分类关系（Non-Taxonomic）—— 其余一切语义关联
 *
 * ① 交给 W3C 的 SKOS 标准（专为概念体系设计，任何工具能校验）；
 * ② 用 6 类自定义谓词（项目已验证的闭集，减掉 2 类层级关系）。
 *
 * ★ 为什么不自己造一套谓词表 ★
 *   项目 `shared/text.ts` 原有 8 类 `RELATION_KINDS`，正好落在标准框架内：
 *     `属于` = subclassOf、`等价` = synonymOf、`导致` = causes。
 *   不是自造轮子，是把其中的**层级类**挪给 SKOS，其余 6 类保留。
 *
 * ★ 为什么不用 `skos:related` 兜底 ★
 *   主流（Microsoft GraphRAG、企业 GraphRAG 实践）明确把 `A related B` 当反例：
 *   「错误：`A related B` 价值很低。应该设计：`Supplier supplies Component`」。
 *   所以宁可给具体的 6 类谓词，也不要一个笼统的 related。
 *   （Turtle 导出时这 6 类会声明 `rdfs:subPropertyOf skos:related`，兼顾标准与语义。）
 */

// ───────────────────────── 命名空间 ─────────────────────────

/** 本图谱的 URI 命名空间。概念 id 由此派生（稳定，不用顺序号）。 */
export const KG_NS = 'https://notelm.local/kg/';

/** Turtle 里的前缀绑定。 */
export const KG_PREFIXES: Record<string, string> = {
  skos: 'http://www.w3.org/2004/02/skos/core#',
  dcterms: 'http://purl.org/dc/terms/',
  rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
  nb: 'https://notelm.local/kg/vocab#',
};

/** 自定义谓词的命名空间（6 类非分类关系）。 */
export const NB_VOCAB = 'https://notelm.local/kg/vocab#';

// ───────────────────── 非分类关系（6 类）─────────────────────

/**
 * ★ 非分类关系闭集（6 类）★
 *
 * 从 `shared/text.ts` 的 `RELATION_KINDS`（8 类）减掉 2 类**层级关系**：
 *   - `属于` → 交给 `skos:broader`（层级归标准管）
 *   - `等价` → 交给 `skos:altLabel`（别名归标准管）
 *
 * 减掉的理由是**职责不重叠**：分类归 SKOS（可被标准工具校验），语义归自定义谓词。
 * 两边都写"属于"会让同一件事有两个真相来源。
 */
export const KG_RELATIONS = [
  '导致', // A 导致 B（恒定的因果，无条件约束）
  '用于解决', // A 被用来解决 B（目的 / 功能）
  '前提是', // A 成立的前提是 B（条件）
  '区别于', // A 与 B 的关键差别（对比）
  '优于', // A 在某个维度上优于 B（取舍）
  '例外', // A 一般成立，但 B 情况下不成立（边界）
] as const;

export type KgRelation = (typeof KG_RELATIONS)[number];

/**
 * ★ 谓词的定义（给机器读的 schema 文档，也给人读）★
 *
 * 主流（GRAPHCO 论文、企业 GraphRAG 实践）都强调：**关系必须有定义域/值域/判据**，
 * 否则模型自由发挥会让同一个谓词在不同地方表达不同的意思。
 */
export const KG_RELATION_DEFS: Record<
  KgRelation,
  { label: string; rdf: string; def: string; domain: string; range: string; sample: string }
> = {
  导致: {
    label: '导致',
    rdf: 'nb:导致',
    def: 'A 是 B 的原因，B 随 A 发生。强调恒定因果，不依赖额外条件。',
    domain: '概念 / 机制 / 做法',
    range: '概念 / 机制 / 事实',
    sample: '上下文膨胀 → 导致 → 模型注意力被稀释',
  },
  用于解决: {
    label: '用于解决',
    rdf: 'nb:用于解决',
    def: 'A 是手段，B 是它要解决的问题。强调目的与功能。',
    domain: '做法 / 机制 / 工具',
    range: '概念 / 问题 / 事实',
    sample: '隔离沙盒 → 用于解决 → 工具执行的安全边界问题',
  },
  前提是: {
    label: '前提是',
    rdf: 'nb:前提是',
    def: 'A 成立或可用的前提是 B。强调条件约束，B 缺失则 A 不成立。',
    domain: '概念 / 做法 / 机制',
    range: '概念 / 事实',
    sample: '工具调用 → 前提是 → 模型具备稳定的结构化输出能力',
  },
  区别于: {
    label: '区别于',
    rdf: 'nb:区别于',
    def: 'A 与 B 容易混淆，但存在关键差别。用于划清边界。',
    domain: '任意',
    range: '任意',
    sample: '自由格式工具调用 → 区别于 → JSON 格式工具调用',
  },
  优于: {
    label: '优于',
    rdf: 'nb:优于',
    def: 'A 在某个明确维度上比 B 更好。必须在 description 里写清是哪个维度。',
    domain: '任意',
    range: '任意',
    sample: '最窄能力起步 → 优于 → 一次性暴露全部工具',
  },
  例外: {
    label: '例外',
    rdf: 'nb:例外',
    def: 'A 一般成立，但在 B 所述情况下不成立或需修正。用于记录边界。',
    domain: '任意',
    range: '任意',
    sample: '参数更新 → 例外 → 小样本场景下不值得更新参数',
  },
};

// ──────────────────── 分类关系 → SKOS 映射 ────────────────────

/**
 * ★ 分类关系交给 SKOS 原生谓词（不自己造）★
 *
 * 这张表是「语义 → 标准谓词」的映射说明，同时也给归一逻辑用：
 * 模型若输出了 `属于` / `等价` 这类措辞，按本表改写成 SKOS 谓词。
 */
export const SKOS_MAP = {
  broader: {
    skos: 'skos:broader',
    label: '上位概念',
    def: 'A 是 B 的一种 / 一部分。严格偏序，允许多父。',
  },
  narrower: {
    skos: 'skos:narrower',
    label: '下位概念',
    def: 'A 比 B 更具体。broader 的逆，导出时只写 broader，narrower 由推理器补。',
  },
  altLabel: {
    skos: 'skos:altLabel',
    label: '别名',
    def: '同一概念的另一个说法（全称 / 简称 / 英文名 / 俗称）。★ 这是「同族重复」的标准解法。',
  },
  prefLabel: {
    skos: 'skos:prefLabel',
    label: '首选标签',
    def: '概念的首选名，每语言最多一个。',
  },
  definition: {
    skos: 'skos:definition',
    label: '定义',
    def: '概念的一句话说明。',
  },
  notation: {
    skos: 'skos:notation',
    label: '记号',
    def: '概念的类型标记（概念 / 机制 / 原则）。★ 用 SKOS 原生机制，不引入新闭集。',
  },
  example: {
    skos: 'skos:example',
    label: '示例',
    def: '挂在概念下的具体案例 / 数字 / 图表。★ 案例不是概念，按 SKOS 规范不进 ConceptScheme 主体。',
  },
  scopeNote: {
    skos: 'skos:scopeNote',
    label: '范围说明',
    def: '补充说明：出处、适用边界、注意事项。',
  },
} as const;

// ───────────────────── 节点类型（notation）─────────────────────

/**
 * ★ 概念的类型标记 ★
 *
 * 用 `skos:notation` 存，**不引入新的 kind 闭集**（知识树的教训：kind + role 两个正交闭集
 * 是为「教辅层次感」设计的，不是知识组织学分类）。
 *
 * 判据是「读者拿它做什么」，与项目 `KNODE_KINDS` 一致，但只保留 3 类——
 * `做法` 与 `原则` 合并为 `原则`（都是"要照做/要遵守"），`事实` 降级成 example。
 */
export const KG_NOTATIONS = ['概念', '机制', '原则'] as const;
export type KgNotation = (typeof KG_NOTATIONS)[number];

/** 闭集外的 notation 就近收编（不是任意词，只收明显同义的）。 */
export const KG_NOTATION_SYNONYM: Record<string, KgNotation> = {
  概念: '概念',
  定义: '概念',
  术语: '概念',
  模型: '概念',
  架构: '概念',
  机制: '机制',
  原理: '机制',
  过程: '机制',
  流程: '机制',
  方法: '机制',
  原则: '原则',
  做法: '原则',
  准则: '原则',
  方法学: '原则',
  规范: '原则',
  建议: '原则',
  约束: '原则',
  策略: '原则',
};

// ───────────────────────── 数据结构 ─────────────────────────

/** 溯源：一条信息出自原文哪个块、哪句。 */
export interface KgProvenance {
  /** 原文块号（全文档唯一，DOM 上是 data-bi）。 */
  bi: number;
  /** 原文片段（verbatim）。过不了 validateQuote 的会被丢弃。 */
  quote: string;
}

/** 知识图谱节点（一个概念）。 */
export interface KgNode {
  /** ★ 稳定 id：sha256(归一后的名字)[:8]。重跑不变，增量更新才可能。 */
  id: string;
  /** 完整 URI，形如 `<KG_NS>chapter1#<id>`。 */
  uri: string;
  /** 首选名（skos:prefLabel）。 */
  prefLabel: string;
  /** 别名（skos:altLabel）：全称 / 简称 / 英文名 / 俗称。 */
  altLabel: string[];
  /** 一句话说明（skos:definition）。 */
  definition: string;
  /** 类型标记（skos:notation → KG_NOTATIONS）。 */
  notation: KgNotation;
  /** 上位概念 id 数组。★ 允许多父（与知识树单父的关键差异）。 */
  broader: string[];
  /** 挂在本概念下的示例（skos:example）：案例 / 数字 / 图表。 */
  examples: { text: string; provenance: KgProvenance[] }[];
  /** 补充说明（skos:scopeNote）。 */
  scopeNote: string;
  /** 本概念自身的出处。 */
  provenance: KgProvenance[];
}

/** 知识图谱边（一条非分类关系）。 */
export interface KgEdge {
  source: string;
  target: string;
  /** 6 类闭集之一。 */
  rel: KgRelation;
  /** ★ 一句话说清这条关系的关键（对齐 GraphRAG 官方关系模型）。不是光一个谓词。 */
  description: string;
  /** 强度：同一关系在原文出现的次数 / 上下文权重。 */
  weight: number;
  /** ★ 无边出处则不可审计（GraphRAG 官方原话）。 */
  provenance: KgProvenance[];
}

/** 整份图谱。 */
export interface KgGraph {
  meta: {
    /** 源文档相对路径。 */
    docRel: string;
    /** 节标题。 */
    unitTitle: string;
    /** 节的 headingId。 */
    headingId: string;
    /** 原文块区间。 */
    scope: { from: number; to: number; blocks: number };
    /** 生成信息。 */
    generatedAt: string;
    model: string;
    /** 提示词版本，便于回放对照。 */
    promptVer: string;
  };
  nodes: KgNode[];
  edges: KgEdge[];
}
