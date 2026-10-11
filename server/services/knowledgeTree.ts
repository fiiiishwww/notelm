/**
 * server/services/knowledgeTree.ts —— 「按知识点关系组织」的小抄形态。
 *
 * ★ 它要解决的问题 ★
 *   现役管道三处咬着同一个东西：生成喂的是「一个原文小节」、分组按原文子标题、
 *   显示跟着分组走。组织主轴 = **原文位置**。后果是必然的：小抄 ≈ 原文的浓缩版，
 *   读者带着「在 Harness 那节的护栏部分」这条锚点，而锚点本身来自课本目录，不是知识。
 *
 *   这一层换一条主轴：**知识点之间的关系**。
 *   先抽出知识点 → 排层级（谁包含谁）→ 连关系（谁是谁的前提 / 谁导致谁）→
 *   具体信息（等式/数值/定义/类比/清单）挂在知识点下面。
 *
 * ★ 顺带解开的一个死结 ★
 *   「三档深度」做成减法一直做不出来（推不出层级标签）。内容长成一棵树之后，
 *   档位就是**展开到第几层**，不需要「哪条该砍」的判据。
 *
 * ★ 它不改任何现有数据 ★
 *   独立模块，无调用方。原型验证通过再考虑接进管线。
 */

import type { Block, RelationKind, KDetail, KDetailKind, KNode, KNodeKind, KNodeRole, KnowledgeTree } from '../../shared/text';
import { RELATION_KINDS, KDETAIL_KINDS, KNODE_KINDS, KNODE_ROLES, itemKeyOf } from '../../shared/text';
import { validateQuote } from './anchor';
import { conceptKeyOf } from './concepts';

// ─────────────────────────── 数据契约 ───────────────────────────

/**
 * ★ 类型契约住在 shared/text.ts ★（2026-09-20 接入管线时搬过去的）
 *
 * 原型期类型定义在这里没问题；接入管线后 CheatsheetSection.tree 要引用它，
 * 而 shared 不能反过来 import server（前端会把整个服务端打进 bundle）。
 * 所以 KDetail / KRelation / KNode / KnowledgeTree 及两个 kind 闭集都搬进了 shared，
 * 这里 re-export 维持探针脚本（scripts/knowledge-tree-probe.ts）的既有 import 不断。
 */
export type { KDetail, KDetailKind, KNode, KNodeKind, KnowledgeTree };
export { KDETAIL_KINDS, KNODE_KINDS };

/**
 * 知识点的种类。判据不是「它是什么词性」，而是**读者拿它做什么**：
 * 要理解的（概念/机制）、要照做的（做法）、要遵守的（原则）、要记住的（事实）。
 *
 * ★ 实测补的两类 ★
 *   第一版只给了 概念/机制/方法/事实，模型自己写了「模式」「原则」「决策」——
 *   说明「方法」这个筐装不下「做法」和「准则」两种东西，硬归一等于把信息抹平。
 */
export const KDETAIL_COMMENT = '';

/**
 * 细节条的种类。
 *
 * ★ 为什么要加「要点」★
 *   实测第一版：模型把「确定性路径把攻击面限制在单个节点内」这类**具体结论**
 *   全塞进了「定义」。它们不是定义，而是「挂在某个知识点下的具体结论」——
 *   而这恰恰是知识树里最常见的一种挂载关系。没有这个筐，模型只能硬塞。
 *   ENTRY_KINDS 里没有它，是因为现役管道的条目是「按原文顺序平铺」的，
 *   不存在「挂在谁下面」这层语义。
 *
 * ★ 为什么要加「例子」★（2026-09-20 补）
 *   这是个**实打实的 bug**，不是设计取舍：第一版没有这一档，而 DETAIL_SYNONYM 里
 *   把「示例 / 例子 / 举例 / 场景」统统收编进了「要点」。模型明明给了例子，
 *   标签被我抹掉，渲染出来只剩「要点」——用户看成品的第一反应就是
 *   「怎么没有例子这个类」。
 *
 *   为什么例子值得单独一档：它是教辅里最有用的一类，且**读者用它做的事不同**——
 *   定义要背、等式要抄、例子要「类比着迁移到自己的场景」。混进「要点」之后，
 *   「举例子」这条最有效的理解路径在界面上就消失了。
 *
 *   ⚠️ 判据（跟「照抄」相关的那个坑连着）：例子允许**改写、允许压缩**，
 *   但必须能指出它在讲哪件事。原文若给了具体案例（「某团队把重试次数从 3 提到 10」），
 *   就摘取要点写进 text；原文只有一句「例如 X」，就照实写，不要自己编一个例子。
 */

// ─────────────────────────── 提示词 ───────────────────────────

/**
 * 组织轴从「原文位置」换成「知识点关系」。
 *
 * 两条对称的禁令，对应两条已经踩过的坑：
 *   · 不许照抄原文的句子当结论 → 否则还是「原文的浓缩版」；
 *   · 不许用原文的架构说事（「本节介绍了…」）→ 否则组织轴又滑回目录。
 */
const NO_SELF_REF =
  '禁止在输出里出现「本章」「本节」「这一节」「上文」「下文」这类指代词；' +
  '需要指代内容时直接写具体名词。';

/**:schema 说明。模型对「举例」远比「约束」敏感，所以每条规则都跟一个例子。 */
const SCHEMA_EXAMPLE = `{
  "title": "Harness 工程",
  "question": "除了模型本身，还有什么在决定 Agent 的可靠性？",
  "nodes": [
    {
      "name": "Harness",
      "kind": "概念",
      "essence": "模型之外、把模型能力兑现成可靠行为的那一层工程",
      "parent": null,
      "relations": [{"rel": "用于解决", "target": "模型能力不可预测", "note": "同一模型换 Harness 得分差 30 分"}],
      "details": [
        {"kind": "等式", "text": "Agent = Model + Harness", "quote": "原文里那句原话"},
        {"kind": "要点", "text": "Harness 不是「模型之外的一切」，判断某个能力归属看它在不在 Agent 边界内", "quote": "原文里对应的那句话"},
        {"kind": "例子", "text": "同一模型换 Harness，Terminal Bench 2.0 得分从 52.8% 提到 66.5%", "quote": "原文里讲这个案例的那句"}
      ]
    },
    {
      "name": "上下文管理",
      "kind": "机制",
      "essence": "决定模型在每一步能看到什么",
      "parent": "Harness",
      "relations": [{"rel": "区别于", "target": "工具接口", "note": "一个管输入，一个管动作"}],
      "details": []
    }
  ]
}`;

export function knowledgeTreePrompt(args: {
  docTitle: string;
  headingPath: string[];
  unitTitle: string;
  text: string;
}): { system: string; user: string } {
  const path = args.headingPath.length ? args.headingPath.join(' > ') : '（无标题）';

  const system = [
    '你是一个帮人**重建知识结构**的助教。我给你一篇文章里的正文。',
    '你的任务**不是摘要**，是把这段内容里的知识抽出来，摆成一张**知识点地图**：',
    '知识点之间谁包含谁（层级）、谁是谁的前提（关系），具体的等式/数值/定义挂在知识点下面。',
    '',
    '★ 最重要的一条：组织轴是知识点，不是原文的叙述顺序 ★',
    '  原文怎么分段、怎么起小标题、先讲什么后讲什么，**跟你输出什么没有关系**。',
    '  你的输出里不许出现按原文顺序编排的痕迹。具体地：',
    '  ✗ 节点名写成「概述」「背景」「导言」「小结」「总结」「其它」「第一部分」「注意事项」',
    '  ✗ 句子里写「本节介绍了…」「文中提到…」「随后作者…」「接下来讨论…」',
    '  ✓ 节点名写成读者会拿去问人的**领域名词**：「上下文管理」「工具接口」「护栏」',
    '',
    '★ 树要有一个主干，不要摊成一片 ★',
    '  先回答一个问题：这段内容**在讲哪一个东西**？那个东西就是根，其余知识点挂在它下面。',
    '  顶层节点（parent 为 null）**控制在 1~3 个**。摊成五六个平行的顶层，等于没组织。',
    '  只有内容里确实存在另一个平行主题（有自己的独立定义、自己的组成）时，才允许另起一个根。',
    '',
    '★ 骨架从哪里来 ★',
    '  原文如果给出了**组成式**（`A = B + C + D`）或**明确的分类清单**，那就是天然的骨架：',
    '  让 B、C、D 作为 A 的子节点挂上去——这是知识点自己的结构，不是文本的结构。',
    '  原文如果按「问题 → 做法 → 边界」讲一个东西，那么这三个是它下面的要点，不是三个兄弟节点。',
    '',
    '★ 一个节点该不该有：看名字 ★',
    '  判据：把这个名字单独抄在纸上，读者看一眼就知道在说什么吗？',
    '  答不出的（「设计考虑」「关键要点」「优势」）——合并进上一级，或者删掉。',
    '',
    '★ kind 怎么选（知识点的**类型**，不是重要程度）★',
    '  闭集五选一，按「读者拿它做什么」来分：',
    '  · 概念 —— 一个「东西」：名词、术语、框架、组件、产品形态',
    '        例：LLM、上下文、MCP、观察空间与动作空间',
    '  · 机制 —— 一个「过程 / 原理」：怎么起作用的、为什么是这样',
    '        例：ReAct 循环、上下文压缩、上下文消融实验',
    '  · 做法 —— 一个「该怎么做」：方法、步骤、策略、设计手法',
    '        例：工具设计原则、能力扩展路径、上下文卸载策略',
    '  · 原则 —— 一条「要遵守的约束 / 判断准绳」',
    '        例：故障安全默认值、最小 Harness、只加不改',
    '  · 事实 —— 一个具体的数据点 / 现状 / 实验结果',
    '        例：同一模型换 Harness 后 Terminal Bench 2.0 从 52.8% 到 66.5%',
    '  ★ 最常见的错：把「要照做 / 要遵守」的东西标成「概念」——它要表达的是「该执行」，不是「是什么」。',
    '',
    '★ 层级 = 包含关系，不是叙述先后 ★',
    '  父子关系必须是「B 是 A 的一部分 / 一种」。「先讲 A 再讲 B」不构成父子。',
    '  一般 2~4 层。同一层的节点必须**互相独立**：',
    '  ✗ 把「护栏」和「护栏的作用」并列（后者是前者的属性，合并进去）',
    '',
    `★ 关系边：只写有意义的，从这 ${RELATION_KINDS.length} 个里选，不许自创 ★`,
    `  ${RELATION_KINDS.join(' / ')}`,
    '  ★ 写一条边之前先问：这两端是不是其实是父子？★',
    '  如果你想说「A 用于解决 B」「A 前提是 B」而 B 其实是 A 所在领域的上位概念，',
    '  那就该把 B 设成 A 的父节点，而不是连一条边。关系边是留给**跨分支**的关系的。',
    '  实测踩过：把「多模态感知的输出形态」和「多模态感知」写成两个兄弟 + 一条边，',
    '  而它本来就是后者的一部分。判断顺序永远是：先定层级，再连边。',
    '  另一端有两种：',
    '  ✓ 图里的另一个知识点 —— **必须逐字使用它的 name**（写错一个字程序就对不上了）',
    '  ✓ 图外的一个**问题 / 条件 / 场景** —— 名词短语，例如「提示注入与数据越权」「误拒绝」',
    '  第二种要节制：图外的边不超过关系边的三分之一。多数关系应该连在图内的知识点之间。',
    '  「属于」「等价」加起来不许超过 40%——父子边已经表达了包含关系，再用「属于」就是重复。',
    '  没有真正的关系就留空数组，不要为了凑数写。',
    '',
    '★ 细节条（details）：挂在这个知识点下、离了它就不完整的具体信息 ★',
    '  kind 七选一（这是**信息类型**，不是「重要程度」）：',
    '    · 要点 —— 一句话的具体结论。**这是最常用的**，拿不准就写它。',
    '        例：「故障安全默认值：所有能力默认关闭，必须显式开放」',
    '    · 定义 —— 「X 是……」这种给一个词下定义，逐字保留关键限定词',
    '        例：「Harness 是 Agent 边界内、模型之外的运行与治理层」',
    '    · 等式 —— 逐字抄，一个符号都不许改（`A = B + C`）',
    '    · 数值 —— 具体的数字、比例、对比数据',
    '        例：「LangChain 只改 Harness，得分 52.8% → 66.5%」',
    '    · 类比 —— 帮助理解的比喻（「就像……一样」）',
    '    · 例子 —— 原文举的**具体案例 / 场景 / 实践**。',
    '        ★ 这是教辅里最有用的一类 ★ 读者拿它做的是「迁移到自己的场景」，',
    '        跟「要点」的使用方式完全不同，所以不许塞进「要点」。',
    '        例：「Claude Code 中每个工具默认需要用户授权才执行」（一个具体产品实例）',
    '        例：「某团队把重试上限从 3 提到 10，误报率下降但延迟上升」',
    '        ✗ 原文只说了「例如要注意边界」，没有具体案例 —— 那就写「要点」，',
    '          **绝对不要自己编一个例子**（编出来的读者没法回原文核对）。',
    '        ✗ 一串名词的枚举（「MCP 工具、代码解释器、搜索工具」）是**清单**，不是例子。',
    '          判断：它在列举**有哪几种**，还是在讲**发生过的一件事**？前者是清单。',
    '    · 清单 —— 原文明确枚举出来的几项（`A、B、C`），或组成/分类',
    '',
    '★ 最常见的两个错 ★',
    '  ① 把具体结论写成「定义」——只有「给一个词下定义」才是定义，其余是「要点」。',
    '  ② 把例子写成「要点」——原文有具体案例时，用「例子」标出来。',
    '  **每个知识点最多 4 条**，没有就给空数组。',
    '  判据：「如果这条不写，读者会损失什么？」答不出具体损失的删掉。',
    '  只在某个节点下才讲得通的信息，不要提到上一级去——挂在它自己的知识点下。',
    '',
    '★ 语气：改写还是照抄，按信息类型分 ★',
    '  这是最容易做错的一处。不是「一律不许抄」，也不是「一律照抄」：',
    '  ✓ **必须逐字抄**（改了就读不出来 / 回不到原文）：等式、数值、定义里的关键限定词',
    '  ✓ **必须自己重述**（照抄等于这段可以直接删掉）：',
    '     要点、类比、例子 —— 用**你自己的话**把信息说清楚，',
    '     判据：把你写的句子放回原文旁边，读者能看出这是**加工过的**，不是复制来的。',
    '     允许、而且鼓励挪用原文的**专业术语和概念名**（术语就是要用的），',
    '     但不许挪用**整句**。照抄一整句 = 没做加工。',
    '  ✓ 长度参考：要点 15~50 字；超过 60 字通常说明你在复述原文而不是提炼。',
    '',
    '★ 引文 ★',
    '  每条 details 必须带 quote：从正文里**逐字复制的连续片段**（10~60 字）。',
    '  不要改写、不要加省略号、不要拼接不相邻的句子——程序要拿它回原文定位。',
    '',
    '★ 数量：由内容量决定，覆盖优先 ★',
    '  短内容 4~8 个正常；上万字的长内容 15~25 个、甚至 30 个以上也正常。',
    '  ✗ 不许为了「精简」把两个不同的知识点合并成一个节点。',
    '  ✗ 也不许凑数：每个节点都要有独立的 essence、都能被单独提问。',
    '  essence 不超过 40 字且能独立看懂。title 是这段内容真正的主题，不是小标题的复制。',
    '  question 是这段内容在回答的那个问题，用读者会问的口气写。',
    '',
    '★ 覆盖判据：读者会拿去问人的名词，图上都要找得到 ★',
    '  逐条扫一遍正文，下面这些**该立节点就立节点**，不许只当成别的节点下的一条 detail：',
    '  ✓ 有名字的概念 / 术语（如 Policy、Environment、ReAct、提示注入）',
    '  ✓ 产品 / 工具 / 框架 / 机构（如 OpenClaw、Manus、Codex、Kimi K3、SWE-bench）',
    '  ✓ 具体的实验、案例、时间点、数值（如「实验 1-1」「2026 年」「Terminal Bench 2.0 得分」）',
    '  ✓ **框架里的每一方**：原文若讲了一个闭环或一组角色，闭环里的每一方都要有节点',
    '  ✓ 原文单独成段说明的机制（即使名字不显眼）',
    '  反例（不许立成节点）：过渡句、铺垫、纯小标题、图注、目录。',
    '  自查：把正文里所有**加粗的词**和**专有名词**扫一遍，问「读者想查这个，图上找得到吗？」',
    '',
    '★ essence 怎么写（这决定了成品像不像原文的浓缩版）★',
    '  essence 是**你自己组织的**一句话，不是从原文挑一句抄过来。',
    '  ✗ 「本节介绍了 Harness 工程的五个组成部分」——用了原文的叙述框架',
    '  ✗ 把原文第一句原样搬过来',
    '  ✓ 写「它是什么 / 起什么作用」，用读者能直接拿去理解下一条的说法',
    '  ✓ 允许用原文的**术语**（「上下文管理」「工具接口」），但不许用原文的**句子**。',
    '',
    NO_SELF_REF,
    '',
    '输出 JSON，不要任何解释文字，不要 Markdown 代码围栏：',
    SCHEMA_EXAMPLE,
  ].join('\n');

  const user =
    `文章：${args.docTitle}\n标题链：${path}\n` +
    `原文里的位置（仅供你定位这段内容出自哪里，不要写进输出）：${args.unitTitle}\n\n` +
    `正文：\n---\n${args.text}\n---\n\n` +
    '请把这段内容里的知识抽出来，组织成知识点地图，输出 JSON。';

  return { system, user };
}

// ─────────────────────────── 校验与归一 ───────────────────────────

export interface TreeIssue {
  level: '丢弃' | '归一' | '提示';
  msg: string;
}

interface RawNode {
  name?: unknown;
  kind?: unknown;
  essence?: unknown;
  parent?: unknown;
  relations?: unknown;
  details?: unknown;
}

/** 名字归一：去空白 + 大小写 —— 模型复述同一个名字时可能带空格。 */
function norm(s: string): string {
  return (s ?? '').replace(/\s+/g, '').toLowerCase();
}

function asStr(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * 闭集外的取值 → 就近收编，收不了才回退默认。
 *
 * ★ 为什么不做「一律回退默认」★
 *   实测模型写了「模式」「原则」「决策」——一律按「概念」处理等于把这些差别抹平，
 *   而它们本来就对应着不同的用法（要照做 / 要遵守）。同义收编是猜，但猜的是**明显同义**的词，
 *   不是任意词，风险远小于信息损失。
 */
const KIND_SYNONYM: Record<string, KNodeKind> = {
  模式: '做法', 方法: '做法', 手段: '做法', 流程: '做法', 步骤: '做法', 技巧: '做法', 策略: '做法',
  原则: '原则', 准则: '原则', 决策: '原则', 建议: '原则', 约束: '原则', 规范: '原则',
  机制: '机制', 原理: '机制', 过程: '机制',
  事实: '事实', 数据: '事实', 统计: '事实', 现状: '事实',
  概念: '概念', 定义: '概念', 术语: '概念', 模型: '概念', 架构: '概念',
};

const DETAIL_SYNONYM: Record<string, KDetailKind> = {
  结论: '要点', 事实: '要点', 特征: '要点', 说明: '要点', 描述: '要点',
  陈述: '要点', 推论: '要点', 建议: '要点', 注意事项: '要点',
  释义: '定义', 含义: '定义', 概念: '定义',
  公式: '等式',
  数字: '数值', 数据: '数值', 指标: '数值', 参数: '数值', 比例: '数值',
  比喻: '类比', 隐喻: '类比',
  // ★ 「例子」自己就是一类了，不再往「要点」吞。同义的收进来。★
  示例: '例子', 举例: '例子', 案例: '例子', 实例: '例子', 场景: '例子', 用例: '例子',
  列表: '清单', 枚举: '清单', 分类: '清单', 组成: '清单', 步骤: '清单',
};

function coerceNodeKind(raw: string, issues: TreeIssue[]): KNodeKind {
  if ((KNODE_KINDS as readonly string[]).includes(raw)) return raw as KNodeKind;
  const hit = KIND_SYNONYM[raw];
  if (hit) {
    issues.push({ level: '归一', msg: `kind「${raw}」收编为「${hit}」` });
    return hit;
  }
  if (raw) issues.push({ level: '归一', msg: `kind 不在闭集，按概念处理：${raw}` });
  return '概念';
}

function coerceDetailKind(raw: string, issues: TreeIssue[]): KDetailKind {
  if ((KDETAIL_KINDS as readonly string[]).includes(raw)) return raw as KDetailKind;
  const hit = DETAIL_SYNONYM[raw];
  if (hit) {
    issues.push({ level: '归一', msg: `detail.kind「${raw}」收编为「${hit}」` });
    return hit;
  }
  if (raw) issues.push({ level: '归一', msg: `detail.kind 不在闭集，按要点处理：${raw}` });
  return '要点';
}

/**
 * ★ 顶层收编：顶层节点超过 maxRoots 时，把「其实是主干的一部分」的顶层收回去 ★
 *
 * 为什么必须在程序里做，不能只写在提示词里：
 *   提示词里写了「顶层 1~3 个」，第一版（12 节点）执行得很好（顶层 2）；
 *   但一加入「例子」这一类，模型注意力转到「给每个知识点配例子」上，
 *   顶层立刻从 2 炸到 6、层级从 3 层塌成 2 层——**同一句提示词，两次执行结果完全不同**。
 *   结构是硬要求，不能交给一次生成的自觉。
 *
 * 判据（确定性，不看语义）：
 *   1. 候选人：顶层里 detail 最少、子树最小的（主干通常细节多、挂得深）；
 *   2. 被挂到：`relations` 里被 `属于` 指向的那个，或名字是被约束的候选的上位词；
 *   3. 兜底：挂到「子树最大」的那个顶层下——它是主干。
 *
 * ★ 为什么不上模糊匹配 ★
 *   「上下文管理」vs「上下文工程」dice 会很高但不是一回事（这条教训来自小抄合并层）。
 *   这里只认**精确包含**（「护栏」⊂「护栏与安全性」这种名字上的包含关系），
 *   认不出就交给 relations 或子树大小。
 */
export function collapseRoots(tree: KnowledgeTree, maxRoots = 3): TreeIssue[] {
  const issues: TreeIssue[] = [];
  const sizeOf = (name: string): number => {
    const count = (n: KNode): number =>
      1 + tree.nodes.filter((x) => x.parent === n.name).reduce((s, c) => s + count(c), 0);
    const self = tree.nodes.find((n) => norm(n.name) === norm(name));
    return self ? count(self) : 0;
  };
  const detailOf = (name: string): number => {
    const count = (n: KNode): number =>
      n.details.length + tree.nodes.filter((x) => x.parent === n.name).reduce((s, c) => s + count(c), 0);
    const self = tree.nodes.find((n) => norm(n.name) === norm(name));
    return self ? count(self) : 0;
  };

  // 主干的判据：子树最大（并列时细节最多）
  const pickTrunk = (cands: KNode[]): KNode =>
    [...cands].sort((a, b) => sizeOf(b.name) - sizeOf(a.name) || detailOf(b.name) - detailOf(a.name))[0];

  let guard = 0;
  while (guard++ < 12) {
    const roots = tree.nodes.filter((n) => !n.parent);
    if (roots.length <= maxRoots) break;

    // 主干 = 子树最大的那个顶层（它最像「这一节在讲的东西」）
    const trunk = pickTrunk(roots);
    // 收编对象：优先「自称属于主干」或「名字被主干包含」的；没有就收编最小的那个
    const others = roots.filter((n) => n !== trunk);
    const claimed = others.find((n) =>
      n.relations.some((r) => r.rel === '属于' && norm(r.target) === norm(trunk.name)),
    );
    const named = others.find(
      (n) => norm(trunk.name).includes(norm(n.name)) || norm(n.name).includes(norm(trunk.name)),
    );
    const victim = claimed ?? named ?? [...others].sort((a, b) => sizeOf(a.name) - sizeOf(b.name))[0];
    if (!victim) break;

    victim.parent = trunk.name;
    // 它原来那条「属于 → 主干」的边现在成了父子关系，去掉避免同一件事写两遍
    victim.relations = victim.relations.filter(
      (r) => !(r.rel === '属于' && norm(r.target) === norm(trunk.name)),
    );
    issues.push({ level: '归一', msg: `顶层超限：${victim.name} 收编到 ${trunk.name} 之下` });
  }
  if (guard >= 12) issues.push({ level: '提示', msg: '顶层收编未收敛（可能有环），已中止' });
  return issues;
}

/**
 * 把模型输出整理成合法结构。
 *
 * ★ 原则：能救的救，救不了的丢，绝不「因为一处不合规就整份作废」★
 *   模型输出里最常见的三类小毛病：parent 写成空字符串、关系词自创、details 缺 quote。
 *   前两类归一即可，第三类丢掉那一条。全部原样保留会污染渲染，整份作废则白花钱。
 */
export function normalizeTree(raw: unknown, opts: { maxNodes?: number; maxRoots?: number } = {}): {
  tree: KnowledgeTree;
  issues: TreeIssue[];
} {
  const issues: TreeIssue[] = [];
  const o = (raw ?? {}) as Record<string, unknown>;
  const rawNodes = Array.isArray(o.nodes) ? (o.nodes as RawNode[]) : [];

  // 第一遍：名字与主体
  const nodes: KNode[] = [];
  const byName = new Map<string, KNode>();
  for (const rn of rawNodes) {
    const name = asStr(rn.name);
    if (!name) {
      issues.push({ level: '丢弃', msg: '有一个节点没有 name' });
      continue;
    }
    const key = norm(name);
    if (byName.has(key)) {
      issues.push({ level: '丢弃', msg: `知识点重名：${name}` });
      continue;
    }
    const kind = coerceNodeKind(asStr(rn.kind), issues);

    const node: KNode = {
      id: `k${nodes.length + 1}`,
      name,
      kind,
      essence: asStr(rn.essence),
      parent: null,
      relations: [],
      details: [],
    };
    nodes.push(node);
    byName.set(key, node);
  }

  if (opts.maxNodes && nodes.length > opts.maxNodes) {
    issues.push({ level: '提示', msg: `知识点 ${nodes.length} 个，超过上限 ${opts.maxNodes}` });
  }

  // 第二遍：父子、关系、细节（此时 byName 已完整，可以解析引用）
  for (let i = 0; i < rawNodes.length; i++) {
    const rn = rawNodes[i];
    const node = byName.get(norm(asStr(rn.name)));
    if (!node) continue;

    const pRaw = asStr(rn.parent);
    if (pRaw) {
      const p = byName.get(norm(pRaw));
      if (!p) {
        issues.push({ level: '归一', msg: `父节点不存在，${node.name} 提到顶层：${pRaw}` });
      } else if (p === node) {
        issues.push({ level: '丢弃', msg: `自指父节点：${node.name}` });
      } else {
        node.parent = p.name;
      }
    }

    const rels = Array.isArray(rn.relations) ? (rn.relations as Record<string, unknown>[]) : [];
    for (const rr of rels) {
      const rel = asStr(rr.rel);
      const target = asStr(rr.target);
      if (!target) continue;
      if (!(RELATION_KINDS as readonly string[]).includes(rel)) {
        // 自创关系词一律丢：关系词闭集是图谱/闪卡能用的前提，收编相近词是猜测，不做
        issues.push({ level: '丢弃', msg: `关系词不在闭集，丢弃：${node.name} —${rel}→ ${target}` });
        continue;
      }
      const t = byName.get(norm(target));
      if (t === node) continue;
      if (!t) {
        // ★ 图外的另一端：问题 / 条件 / 场景 ★
        //   「护栏 —例外→ 误拒绝」「Harness —用于解决→ 模型能力不可预测」都是正常表达，
        //   硬要求另一端必须是图里的节点，会丢掉大量关系（实测 12 条里 11 条属于这类）。
        //   但「像一句话」的要挡住：名词短语不带句末标点，也不会太长。
        if (target.length > 24 || /[。！？；，]/.test(target)) {
          issues.push({ level: '丢弃', msg: `关系另一端像句子而非名词短语：${node.name} —${rel}→ ${target}` });
          continue;
        }
        node.relations.push({ rel: rel as RelationKind, target, toNode: false, note: asStr(rr.note) || undefined });
        continue;
      }
      // ★ 「属于」+ 另一端就是它的父节点 = 纯冗余 ★
      //   父子边已经表达了包含关系。实测模型会写「感知工具 MCP 服务器 —属于→ 感知工具」，
      //   读起来像多给了一条信息，其实是同一件事说两遍。确定性判据，不必靠提示词自觉。
      if (rel === '属于' && node.parent && norm(node.parent) === norm(t.name)) continue;
      node.relations.push({ rel: rel as RelationKind, target: t.name, toNode: true, note: asStr(rr.note) || undefined });
    }

    const dets = Array.isArray(rn.details) ? (rn.details as Record<string, unknown>[]) : [];
    for (const dd of dets) {
      const text = asStr(dd.text);
      const quote = asStr(dd.quote);
      if (!text) continue;
      const kind = coerceDetailKind(asStr(dd.kind), issues);
      node.details.push({ kind, text, quote });
    }
  }

  // 环检测：父子关系必须是一棵森林，否则渲染会无限递归
  const parentOf = new Map(nodes.map((n) => [n.id, n.parent] as const));
  for (const n of nodes) {
    const seen = new Set<string>([n.id]);
    let cur = n.parent;
    while (cur) {
      const p = byName.get(norm(cur));
      if (!p) break;
      if (seen.has(p.id)) {
        issues.push({ level: '归一', msg: `父子成环，${n.name} 提到顶层` });
        n.parent = null;
        break;
      }
      seen.add(p.id);
      cur = parentOf.get(p.id) ?? null;
    }
  }

  const tree: KnowledgeTree = {
    title: asStr(o.title) || '（未命名）',
    question: asStr(o.question),
    nodes,
  };
  // ★ 顶层收编：结构是硬要求，不能靠一次生成的自觉（同一句提示词两次跑结果能差 2 → 6 个顶层）★
  issues.push(...collapseRoots(tree, opts.maxRoots ?? 3));
  return { tree, issues };
}

/** 给 details 补块号；节点本身也用它的第一条 detail 定位。 */
export function locateTree(tree: KnowledgeTree, blocks: Block[]): { located: number; total: number } {
  let located = 0;
  let total = 0;
  for (const n of tree.nodes) {
    for (const d of n.details) {
      total++;
      if (!d.quote) continue;
      const hit = validateQuote(d.quote, blocks);
      if (hit) {
        d.bi = hit.blockIndex;
        located++;
      }
    }
    const first = n.details.find((d) => d.bi != null);
    if (first) n.bi = first.bi;
  }
  return { located, total };
}

// ─────────────────────────── V2 两段式：调用 1 挖结构 ───────────────────────────
//
// ★ 为什么拆两次调用（多鱼 2026-10-10）★
//   「指望一次调用实现所有目的，显然是不可能的」。V1 的一次调用同时干
//   「挖知识结构 + 写 details 条目（含逐字引文）」两件事：结构挖对了条目写得烂，
//   整棵树一起报废重跑。拆开后：
//     调用 1 只管结构（分层 + kind + role + 锚点）——输出极短，可程序收编到位；
//     调用 2 只管条目（按节点 id 写 details + 引文）——坏节点可单独重试。
//   中间的原文切片是**纯程序**（锚点定位 + 区间切分），零 LLM 成本，可断言。

/** role 的同义收编表（仿 KIND_SYNONYM）。收不了的一律回缺省「讲解」。 */
const ROLE_SYNONYM: Record<string, KNodeRole> = {
  例: '例题', 例题: '例题', 示例: '例题', 例子: '例题', 案例: '例题', 典例: '例题',
  习题: '练习', 练习: '练习', 练习题: '练习', 作业: '练习', 训练: '练习',
  总结: '总结', 小结: '总结', 章末总结: '总结', 归纳: '总结', 小结与复习: '总结',
  讲解: '讲解', 正文: '讲解', 知识: '讲解', 知识点: '讲解',
};

function coerceNodeRole(raw: string, issues: TreeIssue[]): KNodeRole {
  const r = (raw ?? '').trim();
  if (!r) return '讲解';
  if ((KNODE_ROLES as readonly string[]).includes(r)) return r as KNodeRole;
  const hit = ROLE_SYNONYM[r];
  if (hit) {
    issues.push({ level: '归一', msg: `role「${raw}」收编为「${hit}」` });
    return hit;
  }
  issues.push({ level: '归一', msg: `role 不在闭集，按讲解处理：${raw}` });
  return '讲解';
}

/** 调用 1 的输出契约：sid 引用 + level + role + anchor（锚点给程序定位用）。 */
interface RawSkeletonNode {
  sid?: unknown;
  name?: unknown;
  kind?: unknown;
  essence?: unknown;
  role?: unknown;
  level?: unknown;
  parent?: unknown;
  relations?: unknown;
  anchor?: unknown;
}

/**
 * 调用 1：挖结构。
 *
 * ★ 分层怎么要求才不违反「结构感来自原文目录」★
 *   分层说的是「知识的包含关系有几层」，不是把原文重新分组。所以措辞上只要求
 *   「包含关系该多深就多深（2~3 层），不许摊成一层」，不引入任何原文没有的筐。
 *   对应课标三层（评价器的参照系）：L1≈大概念、L2≈重要概念、L3≈次位概念。
 *
 * ★ role 与铁律的关系 ★
 *   例题/习题/小结**本来就是原文目录的一部分**，role 只是把它们如实翻译成节点，
 *   不是另造分组。kind 闭集不动——kind 管知识类型，role 管职能，两个正交轴。
 */
export function treeSkeletonPrompt(args: {
  docTitle: string;
  headingPath: string[];
  unitTitle: string;
  text: string;
}): { system: string; user: string } {
  const path = args.headingPath.length ? args.headingPath.join(' > ') : '（无标题）';

  const system = [
    '你是一个帮人**重建知识结构**的助教。我给你一段正文，你只做一件事：',
    '把这段内容里的**知识骨架**挖出来——知识点、谁包含谁（层级）、谁关联谁（关系）。',
    '你**不写细节条目**（等式/结论/例子等下一步另有专人去写），只交结构。',
    '',
    '★ 分层：2~3 层，不许摊成一层 ★',
    '  知识天然有粒度差：一个领域里既有大块头（一类东西的总称），也有细颗粒（具体的一条性质/一条结论）。',
    '  大块头做上层（L1/L2），细颗粒做下层（L3）。判据还是「B 是 A 的一部分 / 一种」。',
    '  ✗ 全部节点都是顶层（摊成一片）——这等于没组织，是最大的失败。',
    '  ✗ 为了凑层数硬造中间层——没有包含关系就别硬分层，宁可两层。',
    '',
    '★ 职能标注（role）：原文里有什么就如实标什么 ★',
    '  闭集四选一：讲解（默认，可不写）/ 例题 / 练习 / 总结。',
    '  · 原文里成段的例题（「例 1」「例 2」、带解答的具体案例）→ 立节点，role 填「例题」，',
    '    name 写「例N：它讲的知识」如「例1：两个重要极限」',
    '  · 原文里的习题块（「习题 1-1」及题组）→ 立节点，role 填「练习」',
    '  · 原文里的小结/本章要点块 → 立节点，role 填「总结」',
    '  · 其余讲解性知识不写 role（默认讲解）。',
    '  ★ 这些块是原文内容的一部分，如实保留它们，不许因为「不像知识点」就扔掉 ★',
    '',
    '★ kind 怎么选（知识类型，与 role 无关）★',
    '  闭集五选一：概念（一个「东西」）/ 机制（一个过程/原理）/ 做法（该怎么做）/ 原则（要遵守的约束）/ 事实（具体数据点/结果）。',
    '  例题节点按它讲的知识标 kind（多数是「做法」或「事实」）。',
    '',
    '★ 顶层 1~3 个 ★',
    '  这段内容在讲哪一个东西？那个东西就是根。确实存在另一个平行主题才另起根。',
    '',
    '★ anchor（定位锚点）：每个节点一个 ★',
    '  从正文里**逐字复制**一段 10~30 字的连续片段，它所在的位置就是讲这个知识点的地方。',
    '  不要改写、不要拼接不相邻的句子、不要加省略号——程序要拿它回原文定位切块。',
    '  例题/习题/总结节点的 anchor 就抄它的标题行附近原句。',
    '',
    '★ 父子引用：用 sid ★',
    '  每个节点给自己编一个 sid（s1、s2…即可），parent 写**父节点的 sid**；顶层写 null。',
    '  不要用 name 当 parent——程序只认 sid。',
    '',
    '★ 关系边：只写有意义的，从这些里选，不许自创 ★',
    `  ${RELATION_KINDS.join(' / ')}`,
    '  另一端若是图里的知识点，**必须逐字用它的 name**；若是图外的问题/条件/场景，用名词短语（≤24 字，不带句末标点）。',
    '  「属于」「等价」合计不超过 40%；没有真关系就留空数组。',
    '',
    '★ 覆盖判据（与结构版一致）★',
    '  读者会拿去问人的名词都要有节点：概念/术语、产品/工具/框架、具体实验与数值、框架里的每一方、单独成段的机制。',
    '  反例：过渡句、铺垫、纯小标题、图注、目录不立节点（但例题/习题/总结块要立，见 role）。',
    '  essence ≤40 字且能独立看懂；title 是这段内容真正的主题；question 用读者会问的口气写。',
    '',
    NO_SELF_REF,
    '',
    '输出 JSON，不要任何解释文字，不要 Markdown 代码围栏：',
    `{
  "title": "这一节的主题",
  "question": "这一节在回答的问题",
  "nodes": [
    {
      "sid": "s1",
      "name": "函数极限",
      "kind": "概念",
      "essence": "描述自变量变化时函数值的趋进行为",
      "role": "讲解",
      "level": 1,
      "parent": null,
      "relations": [{"rel": "用于解决", "target": "变化趋势的定量描述", "note": ""}],
      "anchor": "数列的极限是研究函数极限的基础"
    },
    {
      "sid": "s2",
      "name": "例1：两个重要极限",
      "kind": "做法",
      "essence": "用夹逼准则推导 sin x/x 与 (1+1/x)^x 的极限",
      "role": "例题",
      "level": 2,
      "parent": "s1",
      "relations": [],
      "anchor": "例1 求 lim sinx/x"
    }
  ]
}`,
  ].join('\n');

  const user =
    `文章：${args.docTitle}\n标题链：${path}\n` +
    `原文里的位置（仅供你定位，不要写进输出）：${args.unitTitle}\n\n` +
    `正文：\n---\n${args.text}\n---\n\n` +
    '请把这段内容的知识骨架挖出来（分层 + kind + role + anchor），输出 JSON。';
  return { system, user };
}

/**
 * 调用 1 输出的收编。
 *
 * ★ 与 normalizeTree（V1）的关系 ★
 *   V1 的 normalizeTree **原样冻结**（off 开关下逐字节旧行为）；这里是 V2 专用，
 *   核心差别：parent 按 **sid 精确匹配**（名字断链问题从源头消掉），并新增
 *   层深校验（level ∈ [1,3]）与 role 收编。收编完成后按森林遍历序分配正式 id，
 *   **sid 的寿命到此为止**（调用 2 只见正式 id）。
 */
export function normalizeSkeleton(
  raw: unknown,
  opts: { maxRoots?: number; maxLevels?: number } = {},
): { tree: KnowledgeTree; anchors: Map<string, string>; issues: TreeIssue[] } {
  const issues: TreeIssue[] = [];
  const maxLevels = opts.maxLevels ?? 3;
  const o = (raw ?? {}) as Record<string, unknown>;
  const rawNodes = Array.isArray(o.nodes) ? (o.nodes as RawSkeletonNode[]) : [];

  // ── 第一遍：sid 分配、重名丢弃、kind/role 收编 ──
  interface Entry {
    sid: string;
    name: string;
    kind: KNodeKind;
    role: KNodeRole;
    essence: string;
    anchor: string;
    parentSid: string | null;
    relations: { rel: RelationKind; target: string; note?: string; toNode: boolean }[];
  }
  const entries: Entry[] = [];
  const bySid = new Map<string, Entry>();
  const byName = new Map<string, Entry>();
  rawNodes.forEach((rn, i) => {
    const name = asStr(rn.name);
    if (!name) {
      issues.push({ level: '丢弃', msg: '有一个节点没有 name' });
      return;
    }
    const nkey = norm(name);
    if (byName.has(nkey)) {
      issues.push({ level: '丢弃', msg: `知识点重名：${name}` });
      return;
    }
    let sid = asStr(rn.sid);
    if (!sid) sid = `s${i + 1}`;
    while (bySid.has(sid)) sid = `${sid}x`; // sid 撞车：补 x 直到不撞
    const e: Entry = {
      sid,
      name,
      kind: coerceNodeKind(asStr(rn.kind), issues),
      role: coerceNodeRole(asStr(rn.role), issues),
      essence: asStr(rn.essence),
      anchor: asStr(rn.anchor),
      parentSid: null,
      relations: [],
    };
    entries.push(e);
    bySid.set(sid, e);
    byName.set(nkey, e);
  });

  if (entries.length === 0) {
    return {
      tree: { title: asStr(o.title) || '（未命名）', question: asStr(o.question), nodes: [] },
      anchors: new Map(),
      issues,
    };
  }

  // ── 第二遍：parent 按 sid 精确解析 + 环检测 ──
  const parentSidOf = new Map<Entry, string | null>();
  for (const rn of rawNodes) {
    const name = asStr(rn.name);
    const e = byName.get(norm(name));
    if (!e) continue;
    const pSid = asStr(rn.parent);
    if (!pSid) {
      parentSidOf.set(e, null);
      continue;
    }
    if (pSid === e.sid) {
      issues.push({ level: '丢弃', msg: `自指父节点：${e.name}` });
      parentSidOf.set(e, null);
      continue;
    }
    const p = bySid.get(pSid);
    if (!p) {
      issues.push({ level: '归一', msg: `父 sid 不存在，${e.name} 提到顶层：${pSid}` });
      parentSidOf.set(e, null);
      continue;
    }
    parentSidOf.set(e, pSid);
  }

  // 环检测：parentSid 链上有环的整环拆散（全部提顶层），沿 V1 哲学「能救的救」
  for (const e of entries) {
    const seen = new Set<string>([e.sid]);
    let cur: string | null = parentSidOf.get(e) ?? null;
    while (cur) {
      if (seen.has(cur)) {
        issues.push({ level: '归一', msg: `父子成环（sid ${cur}），${e.name} 提到顶层` });
        parentSidOf.set(e, null);
        break;
      }
      seen.add(cur);
      const p = bySid.get(cur);
      if (!p) break;
      cur = parentSidOf.get(p) ?? null;
    }
  }

  // ── 第三遍：层深校验（computed depth 为准，声明 level 只做核对） ──
  const depthOf = new Map<Entry, number>();
  const computeDepth = (e: Entry, guard: number): number => {
    if (depthOf.has(e)) return depthOf.get(e)!;
    if (guard > 16) return (depthOf.set(e, 0), 0);
    const p = bySid.get(parentSidOf.get(e) ?? '');
    const d = p ? computeDepth(p, guard + 1) + 1 : 0;
    depthOf.set(e, d);
    return d;
  };
  for (const e of entries) computeDepth(e, 0);
  for (const e of entries) {
    const d = depthOf.get(e)!;
    if (d >= maxLevels) {
      issues.push({ level: '归一', msg: `超过 ${maxLevels} 层，${e.name} 提到顶层` });
      parentSidOf.set(e, null);
      depthOf.set(e, 0);
    }
  }

  // ── 关系边（与 V1 同规则，target 按 name 解析） ──
  for (const rn of rawNodes) {
    const e = byName.get(norm(asStr(rn.name)));
    if (!e) continue;
    const rels = Array.isArray(rn.relations) ? (rn.relations as Record<string, unknown>[]) : [];
    for (const rr of rels) {
      const rel = asStr(rr.rel);
      const target = asStr(rr.target);
      if (!target) continue;
      if (!(RELATION_KINDS as readonly string[]).includes(rel)) {
        issues.push({ level: '丢弃', msg: `关系词不在闭集，丢弃：${e.name} —${rel}→ ${target}` });
        continue;
      }
      const t = byName.get(norm(target));
      if (t === e) continue;
      if (!t) {
        if (target.length > 24 || /[。！？；，]/.test(target)) {
          issues.push({ level: '丢弃', msg: `关系另一端像句子而非名词短语：${e.name} —${rel}→ ${target}` });
          continue;
        }
        e.relations.push({ rel: rel as RelationKind, target, toNode: false, note: asStr(rr.note) || undefined });
        continue;
      }
      const myParent = bySid.get(parentSidOf.get(e) ?? '');
      if (rel === '属于' && myParent && myParent === t) continue; // 父子边已表达包含，去冗余
      e.relations.push({ rel: rel as RelationKind, target: t.name, toNode: true, note: asStr(rr.note) || undefined });
    }
  }

  // ── 顶层收编（sid 版 collapseRoots；判据与 V1 一致：子树最大者为主干） ──
  {
    const subtreeSize = (e: Entry): number => {
      const count = (x: Entry, guard: number): number =>
        guard > 16 ? 1 : 1 + entries.filter((c) => (parentSidOf.get(c) ?? null) === x.sid).reduce((s, c2) => s + count(c2, guard + 1), 0);
      return count(e, 0);
    };
    let guard = 0;
    while (guard++ < 12) {
      const roots = entries.filter((e) => !parentSidOf.get(e));
      if (roots.length <= (opts.maxRoots ?? 3)) break;
      const trunk = [...roots].sort((a, b) => subtreeSize(b) - subtreeSize(a))[0];
      const others = roots.filter((n) => n !== trunk);
      const claimed = others.find((n) =>
        n.relations.some((r) => r.rel === '属于' && norm(r.target) === norm(trunk.name)),
      );
      const named = others.find(
        (n) => norm(trunk.name).includes(norm(n.name)) || norm(n.name).includes(norm(trunk.name)),
      );
      const victim = claimed ?? named ?? [...others].sort((a, b) => subtreeSize(a) - subtreeSize(b))[0];
      if (!victim) break;
      parentSidOf.set(victim, trunk.sid);
      victim.relations = victim.relations.filter(
        (r) => !(r.rel === '属于' && norm(r.target) === norm(trunk.name)),
      );
      issues.push({ level: '归一', msg: `顶层超限：${victim.name} 收编到 ${trunk.name} 之下` });
    }
  }

  // ── 收编后再做一次层深防御：收编把子树整体压深一层，可能顶破 maxLevels ──
  {
    const recompute = new Map<Entry, number>();
    const dep = (e: Entry, guard: number): number => {
      if (recompute.has(e)) return recompute.get(e)!;
      if (guard > 16) return 0;
      const p = bySid.get(parentSidOf.get(e) ?? '');
      const d = p ? dep(p, guard + 1) + 1 : 0;
      recompute.set(e, d);
      return d;
    };
    for (const e of entries) dep(e, 0);
    for (const e of entries) {
      if ((recompute.get(e) ?? 0) >= (opts.maxLevels ?? 3)) {
        issues.push({ level: '归一', msg: `收编后超层，${e.name} 提到顶层` });
        parentSidOf.set(e, null);
      }
    }
  }

  // ── 分配正式 id：森林 DFS 序（k1..kN），sid 寿命终止于此 ──
  const formalId = new Map<Entry, string>();
  let counter = 0;
  const assign = (list: Entry[]): void => {
    for (const e of list) {
      counter++;
      formalId.set(e, `k${counter}`);
      assign(entries.filter((c) => (parentSidOf.get(c) ?? null) === e.sid));
    }
  };
  assign(entries.filter((e) => !parentSidOf.get(e)));
  // 兜底：上层收编后理论上不会有孤儿，防御性处理
  for (const e of entries) {
    if (!formalId.has(e)) {
      counter++;
      formalId.set(e, `k${counter}`);
    }
  }

  const nodes: KNode[] = entries.map((e) => ({
    id: formalId.get(e)!,
    name: e.name,
    kind: e.kind,
    ...(e.role !== '讲解' ? { role: e.role } : {}),
    essence: e.essence,
    parent: (() => {
      const ps = parentSidOf.get(e);
      if (!ps) return null;
      const p = bySid.get(ps);
      return p ? (formalId.get(p) ?? null) : null;
    })(),
    relations: e.relations.map((r) => ({
      rel: r.rel,
      target: r.target,
      toNode: r.toNode,
      ...(r.note ? { note: r.note } : {}),
    })),
    details: [],
  }));

  const anchors = new Map<string, string>();
  for (const e of entries) {
    const a = e.anchor.trim();
    if (a) anchors.set(formalId.get(e)!, a);
  }

  return {
    tree: { title: asStr(o.title) || '（未命名）', question: asStr(o.question), nodes },
    anchors,
    issues,
  };
}

// ─────────────────────────── V2 两段式：原文切片（纯程序） ───────────────────────────

export interface TreeFragment {
  id: string;
  /** 片段文本（blocks 按 unitText 同约定 '\n' join；超 2000 字截窗） */
  text: string;
  /** 片段覆盖的全局块号（quote 边界校验用） */
  bis: number[];
  biStart: number;
  biEnd: number;
}

/**
 * 锚点定位 + 区间切分。零 LLM 成本，产出**可断言**（锚点定位率是 V2 第一个自洽指标）。
 *
 * 规则：
 *   · 叶子节点：[自己的锚点块, 下一个锚点块) —— 讲解区间互不重叠；
 *   · 内部节点：子树区间的并集（取 min..max 连续区间）——它讲的是「一大段」；
 *   · anchor 定位失败 → 回退父节点锚点；再失败 → 该节点无片段（记入 unanchored）。
 */
export function sliceFragments(
  tree: KnowledgeTree,
  blocks: Block[],
  anchors: Map<string, string>,
  opts: { maxChars?: number } = {},
): { fragments: Map<string, TreeFragment>; anchored: number; total: number } {
  const maxChars = opts.maxChars ?? 2000;
  const byId = new Map(tree.nodes.map((n) => [n.id, n]));
  const childrenOf = new Map<string, KNode[]>();
  for (const n of tree.nodes) {
    const p = n.parent ?? '';
    if (!childrenOf.has(p)) childrenOf.set(p, []);
    childrenOf.get(p)!.push(n);
  }

  // 第一步：锚定（节点 → 块号），失败沿父链回退
  const biOf = new Map<string, number>();
  const resolveBi = (n: KNode, guard: number): number | null => {
    if (biOf.has(n.id)) return biOf.get(n.id)!;
    const a = anchors.get(n.id);
    let bi: number | null = null;
    if (a) {
      const hit = validateQuote(a, blocks);
      if (hit) bi = hit.blockIndex;
    }
    if (bi == null && n.parent && guard < 8) {
      const p = byId.get(n.parent);
      if (p) bi = resolveBi(p, guard + 1); // 父锚点回退（结果会缓存）
    }
    if (bi != null) biOf.set(n.id, bi);
    return bi;
  };
  for (const n of tree.nodes) resolveBi(n, 0);

  const anchoredBis = [...biOf.values()].sort((a, b) => a - b);
  const nextAnchor = (bi: number): number => {
    const hit = anchoredBis.find((x) => x > bi);
    return hit ?? (blocks.length ? blocks[blocks.length - 1].bi + 1 : bi + 1);
  };
  const blockText = (bi: number): string => blocks.find((b) => b.bi === bi)?.text ?? '';

  const makeFragment = (id: string, start: number, end: number): TreeFragment => {
    const bis: number[] = [];
    for (const b of blocks) if (b.bi >= start && b.bi < end) bis.push(b.bi);
    let text = bis.map(blockText).join('\n');
    if (text.length > maxChars && bis.length) {
      // 截窗：以锚点块为中心，前 1/4 后 3/4（锚点 quote 大概率落在窗口内）
      const anchorOffset = text.indexOf(blockText(start));
      const at = anchorOffset >= 0 ? anchorOffset : 0;
      const from = Math.max(0, at - Math.floor(maxChars / 4));
      text = text.slice(from, from + maxChars);
    }
    return { id, text, bis, biStart: start, biEnd: end };
  };

  const fragments = new Map<string, TreeFragment>();
  const build = (n: KNode): { lo: number; hi: number } | null => {
    const kids = childrenOf.get(n.id) ?? [];
    const own = biOf.get(n.id);
    if (!kids.length) {
      if (own == null) return null;
      const hi = nextAnchor(own);
      fragments.set(n.id, makeFragment(n.id, own, hi));
      return { lo: own, hi };
    }
    let lo: number | null = own ?? null;
    let hi = 0;
    let any = false;
    for (const c of kids) {
      const r = build(c);
      if (!r) continue;
      any = true;
      lo = lo == null ? r.lo : Math.min(lo, r.lo);
      hi = Math.max(hi, r.hi);
    }
    if (!any) {
      if (own == null) return null;
      const end = nextAnchor(own);
      fragments.set(n.id, makeFragment(n.id, own, end));
      return { lo: own, hi: end };
    }
    const start = lo ?? own ?? 0;
    fragments.set(n.id, makeFragment(n.id, start, Math.max(hi, start + 1)));
    return { lo: start, hi: Math.max(hi, start + 1) };
  };
  for (const r of tree.nodes.filter((n) => !n.parent)) build(r);

  // 没被任何遍历覆盖到的节点（断链防御）：给空片段
  for (const n of tree.nodes) {
    if (!fragments.has(n.id)) {
      fragments.set(n.id, { id: n.id, text: '', bis: [], biStart: -1, biEnd: -1 });
    }
  }

  return { fragments, anchored: biOf.size, total: tree.nodes.length };
}

// ─────────────────────────── V2 两段式：调用 2 写条目 ───────────────────────────

/** 按 id 引用的条目请求。节点数 > maxBatch 时按顶层子树分批，防输出截断。 */
export function batchBySubtree(tree: KnowledgeTree, maxBatch = 25): string[][] {
  const childrenOf = new Map<string, KNode[]>();
  for (const n of tree.nodes) {
    const p = n.parent ?? '';
    if (!childrenOf.has(p)) childrenOf.set(p, []);
    childrenOf.get(p)!.push(n);
  }
  if (tree.nodes.length <= maxBatch) return [tree.nodes.map((n) => n.id)];
  const batches: string[][] = [];
  const collect = (n: KNode, acc: string[]): string[] => {
    acc.push(n.id);
    for (const c of childrenOf.get(n.id) ?? []) collect(c, acc);
    return acc;
  };
  for (const r of tree.nodes.filter((n) => !n.parent)) {
    const ids = collect(r, []);
    for (let i = 0; i < ids.length; i += maxBatch) batches.push(ids.slice(i, i + maxBatch));
  }
  return batches.length ? batches : [tree.nodes.map((n) => n.id)];
}

/**
 * 调用 2：写条目。输入**只含正式 id**（sid 不出现），quote 必须出自该节点自己的片段。
 * 细节条的 kind/语气/引文规则与 V1 完全一致（原文案搬用，不重写判据）。
 */
export function treeDetailsPrompt(args: {
  docTitle: string;
  unitTitle: string;
  tree: KnowledgeTree;
  fragments: Map<string, TreeFragment>;
  ids: string[];
}): { system: string; user: string } {
  const byId = new Map(args.tree.nodes.map((n) => [n.id, n]));
  const scope = args.ids.map((id) => byId.get(id)).filter((n): n is KNode => !!n);
  const nameOf = (id: string | null): string => (id ? (byId.get(id)?.name ?? '') : '');

  const nodeList = scope
    .map((n) => {
      const rels = n.relations.length
        ? `，关系：${n.relations.map((r) => `${r.rel}→${r.target}`).join('、')}`
        : '';
      const parentName = n.parent ? `（父节点：${nameOf(n.parent)}）` : '（顶层）';
      return `- ${n.id}「${n.name}」[${n.kind}${n.role ? '/' + n.role : ''}]${parentName}：${n.essence}${rels}`;
    })
    .join('\n');

  const fragmentBlocks = scope
    .map((n) => {
      const f = args.fragments.get(n.id);
      if (!f || !f.text) return null;
      return `### ${n.id}「${n.name}」的原文片段\n---\n${f.text}\n---`;
    })
    .filter((s): s is string => !!s)
    .join('\n\n');

  const system = [
    '你是一个帮人**读透知识**的助教。结构骨架已经挖好（下面给你），你只做一件事：',
    '给指定知识点写下「挂在它下面、离了它就不完整」的具体信息（细节条）。',
    '你**不改结构**：不增删节点、不改父子关系、不改名字——只填 details。',
    '',
    '★ 细节条 kind 七选一（信息类型，不是重要程度）★',
    '    · 要点 —— 一句话的具体结论。**最常用**，拿不准就写它。',
    '    · 定义 —— 「X 是……」给一个词下定义，逐字保留关键限定词',
    '    · 等式 —— 逐字抄，一个符号都不许改（`A = B + C`）',
    '    · 数值 —— 具体的数字、比例、对比数据',
    '    · 类比 —— 帮助理解的比喻（「就像……一样」）',
    '    · 例子 —— 原文举的具体案例/场景/实践（不许自己编一个）',
    '    · 清单 —— 原文明确枚举的几项（A、B、C）或组成/分类',
    '',
    '★ 语气：改写还是照抄，按信息类型分 ★',
    '  ✓ 必须逐字抄：等式、数值、定义里的关键限定词',
    '  ✓ 必须自己重述：要点、类比、例子——用你自己的话，允许用原文术语但不许抄整句',
    '  ✓ 长度参考：要点 15~50 字；超过 60 字通常说明你在复述原文而不是提炼',
    '',
    '★ 引文（quote）：必须逐字出自**该节点自己的原文片段** ★',
    '  每条 details 必须带 quote：从**该节点的片段**里逐字复制的连续片段（10~60 字）。',
    '  不要改写、不要加省略号、不要拼接不相邻的句子、**不要从别的节点的片段里抄**。',
    '  程序会拿 quote 回该节点的片段里核对，对不上这条会被丢掉。',
    '',
    '★ 数量与归属 ★',
    '  **每个知识点最多 4 条**，没有就给空数组——不许为了凑数硬写。',
    '  只在某个节点下才讲得通的信息，不要写到别的节点去。',
    '  判据：「如果这条不写，读者会损失什么？」答不出具体损失的删掉。',
    '',
    NO_SELF_REF,
    '',
    '输出 JSON，不要任何解释文字，不要 Markdown 代码围栏：',
    `{
  "items": [
    {"id": "k3", "details": [
      {"kind": "定义", "text": "……", "quote": "逐字出自 k3 片段的原话"},
      {"kind": "要点", "text": "……", "quote": "逐字出自 k3 片段的原话"}
    ]},
    {"id": "k4", "details": []}
  ]
}`,
  ].join('\n');

  const user =
    `文章：${args.docTitle}\n原文位置：${args.unitTitle}\n\n` +
    `## 待填的知识点（只许给这些 id 填 details）\n${nodeList}\n\n` +
    `## 各节点的原文片段\n${fragmentBlocks || '（无片段——请只依据你的知识谨慎填写，quote 留空字符串）'}\n\n` +
    '请给上面每个知识点写 details，输出 JSON（items 数组，每个 id 一项）。';

  return { system, user };
}

/**
 * 条目合并（程序收编，调用 2 输出 → 树）。
 *
 * ★ 一致性收编的三道闸 ★
 *   ① id 必须存在于骨架：不存在 = 孤儿条目，丢弃 + issue（名字断链的最后一道闸）；
 *   ② quote 边界：先在该节点的片段里找（逐块 includes）；找不到回退全文 validateQuote
 *      （越出片段但真在原文里 → 保留 + 提示）；全文也没有 → 丢条（「缺 quote 丢条目」哲学）；
 *   ③ 每节点 ≤4 条裁剪；空 details 节点率返回给调用方（>40% 触发整体重试）。
 *
 * onlyIds：只合并这些节点的 details（坏节点重试用），其余节点原样保留（含 feedback）。
 */
export function applyDetails(
  tree: KnowledgeTree,
  raw: unknown,
  blocks: Block[],
  fragments: Map<string, TreeFragment>,
  onlyIds?: Set<string>,
): { issues: TreeIssue[]; orphans: number; emptyIds: string[] } {
  const issues: TreeIssue[] = [];
  let orphans = 0;
  const o = (raw ?? {}) as Record<string, unknown>;
  const items = Array.isArray(o.items) ? (o.items as Record<string, unknown>[]) : [];
  const byId = new Map(tree.nodes.map((n) => [n.id, n]));

  for (const it of items) {
    const id = asStr(it.id);
    const node = byId.get(id);
    if (!node) {
      orphans++;
      issues.push({ level: '丢弃', msg: `孤儿条目（id 不在骨架里），丢弃：${id}` });
      continue;
    }
    if (onlyIds && !onlyIds.has(id)) continue;
    const dets = Array.isArray(it.details) ? (it.details as Record<string, unknown>[]) : [];
    const frag = fragments.get(id);
    const details: KDetail[] = [];
    for (const dd of dets) {
      const text = asStr(dd.text);
      if (!text) continue;
      const quote = asStr(dd.quote);
      if (!quote) {
        issues.push({ level: '丢弃', msg: `缺 quote，丢条：${id}「${text.slice(0, 20)}…」` });
        continue;
      }
      // ① 片段内逐块核对（quote 允许带省略号回退：与 validateQuote 同哲学）
      let ok = false;
      if (frag && frag.bis.length) {
        ok = frag.bis.some((bi) => (blocks.find((b) => b.bi === bi)?.text ?? '').includes(quote));
        if (!ok) {
          const head = quote.slice(0, 12);
          if (head.length >= 4) ok = frag.bis.some((bi) => (blocks.find((b) => b.bi === bi)?.text ?? '').includes(head));
        }
      }
      // ② 全文回退：真在原文里（哪怕越出片段）也保留
      if (!ok) {
        const hit = validateQuote(quote, blocks);
        if (!hit) {
          issues.push({ level: '丢弃', msg: `quote 回不到原文，丢条：${id}「${quote.slice(0, 20)}…」` });
          continue;
        }
        issues.push({ level: '提示', msg: `quote 越出片段但在原文中，保留：${id}` });
      }
      details.push({ kind: coerceDetailKind(asStr(dd.kind), issues), text, quote });
      if (details.length >= 4) {
        issues.push({ level: '归一', msg: `${id} 超过 4 条，多余裁剪` });
        break;
      }
    }
    node.details = details;
  }

  const scope = onlyIds ? tree.nodes.filter((n) => onlyIds.has(n.id)) : tree.nodes;
  const emptyIds = scope.filter((n) => n.details.length === 0).map((n) => n.id);
  return { issues, orphans, emptyIds };
}

/**
 * 坏节点重试：只把目标节点（含子树骨架 + 各自片段）发给调用 2 的同一 prompt，
 * 返回后**只替换这些节点的 details**，其余节点（含 bi/feedback）原样保留。
 *
 * ★ 知识树模块保持零 LLM 依赖 ★：callJson 由调用方注入（route 里的 chatJson /
 *   探针 runner 各自实现），本模块只管 prompt 与合并。
 */
export async function regenNodeDetails(args: {
  tree: KnowledgeTree;
  nodeIds: string[];
  blocks: Block[];
  fragments: Map<string, TreeFragment>;
  docTitle: string;
  unitTitle: string;
  callJson: (p: { system: string; user: string }, label: string) => Promise<unknown>;
}): Promise<{ tree: KnowledgeTree; issues: TreeIssue[]; orphans: number }> {
  const { tree, nodeIds, blocks, fragments } = args;
  // 目标集合 = 指定节点 + 其子树（骨架一起给，模型才有上下文）
  const childrenOf = new Map<string, KNode[]>();
  for (const n of tree.nodes) {
    const p = n.parent ?? '';
    if (!childrenOf.has(p)) childrenOf.set(p, []);
    childrenOf.get(p)!.push(n);
  }
  const scope = new Set<string>();
  const collect = (id: string): void => {
    scope.add(id);
    for (const c of childrenOf.get(id) ?? []) collect(c.id);
  };
  for (const id of nodeIds) collect(id);

  const subTree: KnowledgeTree = { ...tree, nodes: tree.nodes.filter((n) => scope.has(n.id)) };
  const p = treeDetailsPrompt({ docTitle: args.docTitle, unitTitle: args.unitTitle, tree: subTree, fragments, ids: [...scope] });
  const raw = await args.callJson(p, `重试 ${nodeIds.join(',')} 的条目`);
  const r = applyDetails(tree, raw, blocks, fragments, scope);
  return { tree, issues: r.issues, orphans: r.orphans };
}

/** 树的最大深度（0 基；单层树 = 0）。draft/active 判据与评价器共用。 */
export function treeMaxDepth(tree: KnowledgeTree): number {
  return Math.max(-1, ...buildTree(tree).map(function depth(n): number {
    return n.children.length ? 1 + Math.max(...n.children.map(depth)) : 0;
  }));
}

// ─────────────────────────── 结构渲染 ───────────────────────────


export interface TreeNode extends KNode {
  children: TreeNode[];
  depth: number;
}

/**
 * 由 parent 建树。顶层 = parent 为 null。
 *
 * ★ 双格式兼容（V2 起）★：新树 parent 存**父节点 id**（精确匹配，改名不断链），
 *   旧树 parent 存**父节点的 name**——先按 id 精确匹配，miss 再按归一名兜底。
 *   id 与 name 的命名空间在旧数据里可能重叠（id 形如 k1/k12，名字几乎不会撞上），
 *   所以 id 优先是安全的。旧树在其自然生命周期内（sourceHash 过期重生成）被 v2 替换。
 */
export function buildTree(tree: KnowledgeTree): TreeNode[] {
  const nodes: TreeNode[] = tree.nodes.map((n) => ({ ...n, children: [], depth: 0 }));
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const byName = new Map(nodes.map((n) => [norm(n.name), n] as const));
  const roots: TreeNode[] = [];
  for (const n of nodes) {
    if (!n.parent) {
      roots.push(n);
      continue;
    }
    const p = byId.get(n.parent) ?? byName.get(norm(n.parent)) ?? null;
    if (p) p.children.push(n);
    else roots.push(n);
  }
  const walk = (list: TreeNode[], depth: number): void => {
    for (const n of list) {
      n.depth = depth;
      walk(n.children, depth + 1);
    }
  };
  walk(roots, 0);
  return roots;
}

export type Depth = 'simple' | 'basic' | 'deep';

/**
 * 三档的提示文案（= 用户认可的那一版形态，2026-09-20 已回退到此）。
 * ★ 回退原因：上一轮我把三档一起改了（含用户认可的基础档），是超范围的改动。
 */
const DEPTH_HINT: Record<Depth, string> = {
  simple: '只看骨架：知识点名',
  basic: '知识点名 + 一句话 + 关系',
  deep: '全部展开，含等式数值等细节',
};

/** md 展开：同一棵树的文本形态。depth 决定展开到第几层的信息量。 */
export function renderTreeMarkdown(tree: KnowledgeTree, opts: { depth?: Depth } = {}): string {
  const depth = opts.depth ?? 'deep';
  const roots = buildTree(tree);
  const out: string[] = [];
  out.push(`# ${tree.title}`);
  if (tree.question) out.push('', `> ${tree.question}`);
  out.push('');

  const walk = (n: TreeNode, indent: number): void => {
    const pad = '  '.repeat(indent);
    const loc = n.bi != null ? ` \`¶${n.bi}\`` : '';
    const es = depth === 'simple' ? '' : ` — ${n.essence}`;
    out.push(`${pad}- **${n.name}**（${n.kind}）${es}${loc}`);
    if (depth !== 'simple') {
      for (const r of n.relations) {
        // → 指向图里的知识点；⇢ 指向图外的问题/条件（读者点不过去，所以视觉上要区分开）
        const arrow = r.toNode ? '→' : '⇢';
        out.push(`${pad}  - ⤳ ${r.rel} ${arrow} ${r.target}${r.note ? `（${r.note}）` : ''}`);
      }
    }
    if (depth === 'deep') {
      for (const d of n.details) {
        // ★ md 里不带 quote ★
        //   quote 是 HTML 视图里回跳原文的抓手；md 是笔记形态（教辅不抄课本原句），
        //   把它排进去一行会拖到一百多字，等宽视图根本没法读。块号保留——要查原文时知道去哪看。
        const bi = d.bi != null ? ` \`¶${d.bi}\`` : '';
        out.push(`${pad}  - \`${d.kind}\` ${d.text}${bi}`);
      }
    }
    for (const c of n.children) walk(c, indent + 1);
  };
  for (const r of roots) walk(r, 0);
  out.push('');
  return out.join('\n');
}

function esc(s: string): string {
  return (s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
}

/** 知识点 kind → 颜色（导图节点与折叠树共用一套语义） */
/**
 * 节点种类 → 主题糖果色（var 带字面 fallback：嵌入版吃应用主题，独立整页用 fallback）。
 * ★ 2026-09-20 晚 ★ 多鱼反馈「导图没融合前端风格」——原来是 GitHub 冷色盘
 * （#1f6feb 蓝系），和应用奶油底+糖果绿主色完全不搭，全换 --c1..--c5。
 */
const KIND_COLOR: Record<string, string> = {
  概念: 'var(--c2, #4ecdc4)', // 湖蓝
  机制: 'var(--c3, #a78bfa)', // 薰衣草
  做法: 'var(--c1, #35c47f)', // 糖果绿
  方法: 'var(--c1, #35c47f)',
  原则: 'var(--c4, #ff8fab)', // 樱粉
  事实: 'var(--c5, #ffc94d)', // 奶油黄
};

/**
 * ─────────────────── 思维导图布局 ───────────────────
 *
 * ★ 为什么不能直接复用折叠树 ★
 *   折叠树是「缩进大纲」：所有节点向右堆叠，层级靠左缩进表达。
 *   思维导图是**辐射**结构：主题在中间，分支向两侧发散，层级靠离中心的距离表达。
 *   两者能共用同一棵树的数据，但布局算法完全不同——这就是为什么树做完了还得单独做导图。
 *
 * ★ 布局怎么定 ★
 *   左右两棵树各自按「叶子数」分配纵向槽位（经典的 tidy-tree 简化版）：
 *   一个节点的 y = 它所有叶子 y 的中位数；叶子按遍历顺序依次占槽。
 *   这样分支不会互相压叠，也不用引第三方布局库（保持零依赖）。
 *
 * ★ 一级分支左右分配 ★
 *   轮流分到两侧（i 偶数 → 右，奇数 → 左），这样两侧叶数大致均衡。
 *   只有 1 个一级分支时全放右侧（左侧空着比硬摊开好读）。
 */
interface MmNode {
  name: string;
  kind: KNodeKind;
  essence: string;
  depth: number;
  side: 0 | 1; // 0 = 右，1 = 左
  x: number;
  y: number;
  w: number;
  h: number;
  children: MmNode[];
  parent: MmNode | null;
}

/** 估算节点宽度：中文按 13px、英文按 7.2px 计，再加内边距。够用即可，不必精确。 */
function estimateWidth(s: string, fontSize: number, pad: number): number {
  let w = 0;
  for (const ch of s) w += /[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/.test(ch) ? fontSize : fontSize * 0.55;
  return Math.min(240, w + pad);
}

export function layoutMindmap(tree: KnowledgeTree): {
  nodes: MmNode[];
  width: number;
  height: number;
} {
  const roots = buildTree(tree);
  if (!roots.length) return { nodes: [], width: 0, height: 0 };
  // 多个顶层时：第一个当中心主题，其余当独立分支（导图只能有一个中心）
  const center = roots[0];
  const extra = roots.slice(1);

  const ROW = 32; // 每个叶子占的纵向槽高
  const H_GAP = 96; // 父边缘到子边缘的横向间距
  const GAP_Y = 18; // 一级分支之间的额外留白
  const CENTER_W = estimateWidth(center.name, 15, 36);

  const mk = (n: TreeNode, depth: number, side: 0 | 1, parent: MmNode | null): MmNode => {
    const fontSize = depth === 0 ? 15 : depth === 1 ? 13 : 12;
    const w =
      depth === 0 ? CENTER_W : estimateWidth(n.name, fontSize, depth === 1 ? 24 : 20);
    const h = depth === 0 ? 36 : depth === 1 ? 27 : 23;
    const node: MmNode = {
      name: n.name,
      kind: n.kind,
      essence: n.essence,
      depth,
      side,
      x: 0,
      y: 0,
      w,
      h,
      children: [],
      parent,
    };
    node.children = n.children.map((c) => mk(c, depth + 1, side, node));
    return node;
  };

  // 一级分支：轮流分到两侧（奇偶），两侧叶数大致均衡；只有 1 个分支时全放右侧
  const branchTrees = [...center.children, ...extra];
  const left: MmNode[] = [];
  const right: MmNode[] = [];
  branchTrees.forEach((b, i) => {
    const side: 0 | 1 = branchTrees.length > 1 && i % 2 === 1 ? 1 : 0;
    const m = mk(b, 1, side, null);
    (side === 1 ? left : right).push(m);
  });
  const centerNode: MmNode = {
    name: center.name,
    kind: center.kind,
    essence: center.essence,
    depth: 0,
    side: 0,
    x: 0,
    y: 0,
    w: CENTER_W,
    h: 36,
    children: [...right, ...left],
    parent: null,
  };

  // ── 纵向排布（tidy-tree 简化版）──
  //   叶子按遍历顺序依次占槽、光标只进不退（★ 上一版所有叶子取同一个 top，全叠在
  //   同一位置——这正是首图里「叶子消失」的原因：它们叠成了一摞 ★）；
  //   内部节点的 y = 首叶子与末叶子的中点。
  const place = (list: MmNode[]): number => {
    let cursor = 0;
    const assign = (n: MmNode): void => {
      if (!n.children.length) {
        n.y = cursor + ROW / 2;
        cursor += ROW;
        return;
      }
      for (const c of n.children) assign(c);
      n.y = (n.children[0].y + n.children[n.children.length - 1].y) / 2;
    };
    for (const br of list) {
      assign(br);
      cursor += GAP_Y;
    }
    return Math.max(cursor - GAP_Y, ROW);
  };

  const rightH = place(right);
  const leftH = place(left);
  const totalH = Math.max(rightH, leftH, 220);

  // ── 横向坐标：子节点的中心 = 父边缘 + H_GAP + 自身半宽 ──
  const setX = (n: MmNode): void => {
    const dir = n.side === 1 ? -1 : 1;
    const px = n.parent ? n.parent.x : 0;
    const pw = n.parent ? n.parent.w : centerNode.w;
    n.x = px + dir * (pw / 2 + H_GAP + n.w / 2);
    for (const c of n.children) setX(c);
  };
  for (const b of [...right, ...left]) setX(b);

  // 垂直居中：两侧各自相对中线居中
  const shift = (list: MmNode[], h: number): void => {
    if (!list.length) return;
    const step = (n: MmNode): void => {
      n.y += (totalH - h) / 2;
      for (const c of n.children) step(c);
    };
    for (const b of list) step(b);
  };
  shift(right, rightH);
  shift(left, leftH);
  centerNode.y = totalH / 2;

  // ── 归一化到正坐标 ──
  const all: MmNode[] = [];
  const collect = (n: MmNode): void => {
    all.push(n);
    for (const c of n.children) collect(c);
  };
  collect(centerNode);
  const minX = Math.min(...all.map((n) => n.x - n.w / 2));
  const dx = minX < 16 ? 16 - minX : 0;
  if (dx) for (const n of all) n.x += dx;
  const width = Math.max(...all.map((n) => n.x + n.w / 2)) + 16;

  return { nodes: all, width, height: totalH + 48 };
}

/**
 * 把布局好的节点画成 HTML（绝对定位 + SVG 连线）。
 *
 * ★ 导图只放节点，不放细节条 ★
 *   59 条细节直接排进图里会把结构糊成一堵墙——导图回答「知识怎么组织」，
 *   细节条回答「每个知识点上挂了什么」，后者是树视图的职责（深度档全展开）。
 *   两视图共用同一份 JSON，各答各的问题。
 *
 * ★ 连线与节点的遮挡关系 ★
 *   线画在 SVG 层（z 序在下），节点必须**不透明**——上一版一级分支用 12% 透明度的
 *   底色，线从节点底下穿过去，看起来像文字被划了一道删除线。
 */
function renderMindmapHtml(tree: KnowledgeTree): string {
  const { nodes, width, height } = layoutMindmap(tree);
  if (!nodes.length) return '<div class="mm-empty">这一节没有可组织的知识点。</div>';

  const parts: string[] = [];
  const paths: string[] = [];

  for (const n of nodes) {
    const dir = n.side === 1 ? -1 : 1;
    for (const c of n.children) {
      const x1 = n.x + (dir * n.w) / 2;
      const y1 = n.y;
      const x2 = c.x - (dir * c.w) / 2;
      const y2 = c.y;
      const mx = (x1 + x2) / 2;
      const color = c.depth === 1 ? KIND_COLOR[c.kind] ?? 'var(--text-3, #a8937c)' : 'var(--border-strong, #e0c49a)';
      // 三次贝塞尔：出水平、入水平，转折在中点 —— 脑图经典的曲线
      // data-to-depth：简单档会把叶子藏起来，通向叶子的线也要一起藏（不然留一截断头）
      // ★ stroke 走 style 属性：表现属性（stroke="..."）不支持 var()，主题色传不进去
      paths.push(
        `<path data-to-depth="${c.depth}" d="M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}" style="stroke:${color}"/>`,
      );
    }
    const color = KIND_COLOR[n.kind] ?? 'var(--text-3, #a8937c)';
    if (n.depth === 0) {
      parts.push(
        `<div class="mm-node root" style="left:${n.x - n.w / 2}px;top:${n.y}px;width:${n.w}px;` +
          `background:var(--accent, #35c47f);text-align:center">${esc(n.name)}</div>`,
      );
      continue;
    }
    if (n.depth === 1) {
      // 一级分支：白底不透明 + 彩色描边 + 彩色字（上一版半透明底让连线透了过来）
      parts.push(
        `<div class="mm-node lv1" data-name="${esc(n.name)}" style="left:${n.x - n.w / 2}px;top:${n.y}px;` +
          `width:${n.w}px;border-color:${color};color:${color}" ` +
          `title="${esc(n.essence)}">${esc(n.name)}</div>`,
      );
      continue;
    }
    parts.push(
      `<div class="mm-node leaf" style="left:${n.x - n.w / 2}px;top:${n.y}px;width:${n.w}px" ` +
        `title="${esc(n.essence)}">${esc(n.name)}</div>`,
    );
  }

  return (
    `<div class="mm-wrap"><div class="mm-canvas" style="width:${width}px;height:${height}px">` +
    `<svg class="mm-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${paths.join('')}</svg>` +
    parts.join('') +
    `</div></div>`
  );
}

const TREE_CSS = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { font-family: 'Segoe UI', system-ui, 'Microsoft YaHei', sans-serif; max-width: 940px;
         margin: 0 auto; padding: 20px 18px 80px; color: #1f2328; background: #fff; line-height: 1.6; }
  .head h1 { font-size: 22px; margin: 0 0 6px; }
  .head .q { color: #57606a; font-size: 14px; margin: 0 0 14px; }
  .bar { position: sticky; top: 0; background: #fff; padding: 10px 0 12px; border-bottom: 1px solid #d8dee4;
         display: flex; gap: 14px; align-items: center; flex-wrap: wrap; z-index: 5; }
  .seg { display: inline-flex; border: 1px solid #d0d7de; border-radius: 8px; overflow: hidden; }
  .seg button { border: 0; background: #fff; padding: 5px 12px; font-size: 13px; cursor: pointer; color: #57606a; }
  .seg button + button { border-left: 1px solid #d0d7de; }
  .seg button.on { background: #0969da; color: #fff; }
  .hint { font-size: 12px; color: #8b949e; }
  ul.tree, ul.tree ul { list-style: none; margin: 0; padding: 0; }
  ul.tree ul { margin-left: 18px; border-left: 1px solid #e6eaef; padding-left: 12px; }
  li.node { margin: 2px 0; }
  .row { display: flex; gap: 8px; align-items: baseline; padding: 5px 6px; border-radius: 6px; cursor: pointer; }
  .row:hover { background: #f6f8fa; }
  .tw { flex: none; width: 12px; color: #8b949e; font-size: 11px; }
  .badge { flex: none; font-size: 11px; line-height: 1.5; padding: 0 7px; border-radius: 9px; color: #fff; }
  .b-概念 { background: #1f6feb; } .b-机制 { background: #8250df; }
  .b-方法 { background: #1a7f37; } .b-事实 { background: #9a6700; }
  .b-做法 { background: #1a7f37; } .b-原则 { background: #bc4c00; }
  .name { font-weight: 600; font-size: 15px; }
  .row.root .name { font-size: 17px; }
  .row.root { background: #f6f8fa; }
  .es { color: #57606a; font-size: 13px; }
  .loc { color: #b6bec6; font-size: 11px; margin-left: auto; flex: none; }
  .body { display: none; margin: 0 0 4px 12px; }
  li.open > .body { display: block; }
  .rels { margin: 2px 0 4px; font-size: 13px; color: #57606a; }
  .rels .r { display: block; }
  .rels .r.out { color: #8b949e; }
  .rels .rel { color: #bc4c00; font-weight: 600; }
  .details { margin: 4px 0 6px; }
  .d { display: flex; gap: 8px; align-items: baseline; padding: 4px 0; border-top: 1px dashed #eef1f4; }
  .d .kb { flex: none; font-size: 11px; padding: 0 6px; border-radius: 8px; color: #fff; }
  .k-定义 { background: #1a7f37; } .k-等式 { background: #8250df; }
  .k-数值 { background: #9a6700; } .k-类比 { background: #0e7c86; } .k-清单 { background: #57606a; }
  .k-要点 { background: #57606a; }
  /* ★ 例子单独一个高饱和色：它是读者最想找的一类，不能跟「要点」混成一片灰 ★ */
  .k-例子 { background: #cf222e; }
  .d .tx { flex: 1; min-width: 0; font-size: 14px; }
  .d .qt { color: #8b949e; font-size: 12px; }
  .d .bi { color: #b6bec6; font-size: 11px; flex: none; }
  /* 档位：显示多少信息（= 用户认可的那一版，2026-09-20 已回退到此形态） */
  .d-simple .es, .d-simple .rels, .d-simple .details { display: none; }
  .d-basic .details { display: none; }
  pre.md { display: none; white-space: pre-wrap; word-break: break-word; background: #f6f8fa;
           border: 1px solid #d0d7de; border-radius: 8px; padding: 14px; font-size: 13px; line-height: 1.7; }
  body.as-md pre.md { display: block; }
  body.as-md #tree { display: none; }
  body.as-md #mm { display: none; }
  #mm { display: none; }
  body.as-mm #tree { display: none; }
  body.as-mm #mm { display: block; }

  /* ─── 思维导图：从中心向两侧发散 ─── */
  .mm-wrap { position: relative; padding: 8px 0 20px; overflow-x: auto; }
  .mm-canvas { position: relative; min-width: 640px; }
  .mm-svg { position: absolute; inset: 0; pointer-events: none; }
  .mm-svg path { fill: none; stroke-width: 2; }
  .mm-node { position: absolute; transform: translateY(-50%); border-radius: 8px; padding: 5px 11px;
             font-size: 13px; line-height: 1.45; white-space: nowrap; border: 1px solid transparent;
             max-width: 240px; background: #fff; }
  .mm-node.root { font-size: 15px; font-weight: 700; padding: 9px 16px; border: 0; color: #fff; }
  .mm-node.lv1 { font-weight: 600; cursor: pointer; border-width: 1px; }
  .mm-node.lv1:hover { filter: brightness(0.96); }
  .mm-node.leaf { font-size: 12px; color: #1f2328; border-radius: 7px; }
  .mm-node .mk { font-size: 10px; padding: 0 4px; border-radius: 6px; color: #fff; margin-right: 4px; }
  .mm-node.lv1.dim, .mm-node.leaf.dim { opacity: .32; }
  .mm-empty { color: #8b949e; font-size: 13px; padding: 20px 0; }
  .foot { margin-top: 28px; padding-top: 12px; border-top: 1px solid #d8dee4; color: #8b949e; font-size: 12px; }
`;

const TREE_JS = `
  var tree = document.getElementById('tree');
  var body = document.body;
  function setDepth(d) {
    body.classList.remove('d-simple','d-basic','d-deep');
    body.classList.add('d-' + d);
    var lim = d === 'simple' ? 1 : d === 'basic' ? 2 : 99;
    tree.querySelectorAll('li.node').forEach(function (li) {
      li.classList.toggle('open', Number(li.dataset.depth) < lim);
    });
    document.querySelectorAll('[data-depth-btn]').forEach(function (b) {
      var on = b.dataset.depthBtn === d;
      b.classList.toggle('on', on);
      if (on) document.getElementById('dhint').textContent = b.getAttribute('data-hint');
    });
    // 导图：简单档只留骨架（一级分支），通向叶子的线也要一起藏
    document.querySelectorAll('#mm .mm-node.leaf').forEach(function (el) {
      el.style.display = d === 'simple' ? 'none' : '';
    });
    document.querySelectorAll('#mm path[data-to-depth]').forEach(function (p) {
      p.style.display = d === 'simple' && Number(p.dataset.toDepth) >= 2 ? 'none' : '';
    });
  }
  document.querySelectorAll('[data-depth-btn]').forEach(function (b) {
    b.addEventListener('click', function () { setDepth(b.dataset.depthBtn); });
  });
  document.querySelectorAll('[data-view-btn]').forEach(function (b) {
    b.addEventListener('click', function () {
      var v = b.dataset.viewBtn;
      body.classList.toggle('as-md', v === 'md');
      body.classList.toggle('as-mm', v === 'mm');
      document.querySelectorAll('[data-view-btn]').forEach(function (x) {
        x.classList.toggle('on', x.dataset.viewBtn === v);
      });
    });
  });
  // 知识树里悬停某个知识点 → 导图里对应节点高亮（两视图共用同一份数据，联动是免费的）
  tree.querySelectorAll('.row').forEach(function (r) {
    r.addEventListener('click', function () {
      var li = r.parentElement;
      if (li.querySelector('.body')) li.classList.toggle('open');
    });
    r.addEventListener('mouseenter', function () {
      var name = r.querySelector('.name');
      if (!name) return;
      var t = name.textContent.trim();
      document.querySelectorAll('#mm .mm-node').forEach(function (el) {
        var txt = (el.dataset.name || el.textContent).trim();
        el.classList.toggle('dim', txt !== t && txt.indexOf(t) !== 0);
      });
    });
    r.addEventListener('mouseleave', function () {
      document.querySelectorAll('#mm .mm-node').forEach(function (el) { el.classList.remove('dim'); });
    });
  });
  setDepth('basic');
`;

/** 可展开的 HTML。档位 = 展开到第几层（不是减法）。 */
export function renderTreeHtml(tree: KnowledgeTree, opts: { depth?: Depth } = {}): string {
  const roots = buildTree(tree);
  const relsOf = (n: KNode): string =>
    n.relations.length
      ? `<div class="rels">${n.relations
          .map(
            (r) =>
              `<span class="r${r.toNode ? '' : ' out'}">⤳ <span class="rel">${esc(r.rel)}</span> ${
                r.toNode ? '→' : '⇢'
              } ${esc(r.target)}${r.note ? ` <span class="qt">（${esc(r.note)}）</span>` : ''}</span>`,
          )
          .join('')}</div>`
      : '';
  const detailsOf = (n: KNode): string =>
    n.details.length
      ? `<div class="details">${n.details
          .map(
            (d) =>
              `<div class="d"><span class="kb k-${esc(d.kind)}">${esc(d.kind)}</span>` +
              `<span class="tx">${esc(d.text)}${d.quote ? `<br><span class="qt">「${esc(d.quote)}」</span>` : ''}</span>` +
              `<span class="bi">${d.bi != null ? '¶' + d.bi : '·'}</span></div>`,
          )
          .join('')}</div>`
      : '';

  const walk = (n: TreeNode): string =>
    `<li class="node" data-depth="${n.depth}">` +
    `<div class="row${n.depth === 0 ? ' root' : ''}"><span class="tw">${n.children.length ? '▸' : '·'}</span>` +
    `<span class="badge b-${esc(n.kind)}">${esc(n.kind)}</span>` +
    `<span class="name">${esc(n.name)}</span>` +
    `<span class="es">${esc(n.essence)}</span>` +
    `<span class="loc">${n.bi != null ? '¶' + n.bi : ''}</span></div>` +
    `<div class="body">${relsOf(n)}${detailsOf(n)}${n.children.length ? `<ul>${n.children.map(walk).join('')}</ul>` : ''}</div>` +
    `</li>`;

  const md = renderTreeMarkdown(tree, { depth: 'deep' });
  const mm = renderMindmapHtml(tree);

  const depthBtn = (d: Depth, label: string): string =>
    `<button data-depth-btn="${d}" data-hint="${esc(DEPTH_HINT[d])}">${label}</button>`;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>知识树 · ${esc(tree.title)}</title>
<style>${TREE_CSS}</style>
</head>
<body class="d-basic">
<div class="head">
  <h1>${esc(tree.title)}</h1>
  ${tree.question ? `<p class="q">${esc(tree.question)}</p>` : ''}
</div>
<div class="bar">
  <div class="seg">${(['simple', 'basic', 'deep'] as Depth[]).map((d) => depthBtn(d, { simple: '简单', basic: '基础', deep: '深度' }[d])).join('')}</div>
  <span class="hint" id="dhint">${esc(DEPTH_HINT.basic)}</span>
  <div class="seg" style="margin-left:auto">
    <button data-view-btn="mm">思维导图</button>
    <button data-view-btn="tree" class="on">知识树</button>
    <button data-view-btn="md">markdown</button>
  </div>
</div>
<div id="tree"><ul class="tree">${roots.map(walk).join('')}</ul></div>
<div id="mm">${mm}</div>
<pre class="md">${esc(md)}</pre>
<div class="foot">
  ${tree.nodes.length} 个知识点 · ${tree.nodes.reduce((s, n) => s + n.details.length, 0)} 条细节 ·
  ${tree.nodes.reduce((s, n) => s + n.relations.length, 0)} 条关系 ·
  ¶n = 该条在原文中的块号（回跳用）· 点节点名展开/收起
</div>
<script>${TREE_JS}</script>
</body>
</html>
`;
}

// ─────────────────────────── 嵌入版渲染（小抄面板用） ───────────────────────────

/**
 * 嵌入小抄面板的知识树 HTML 片段（renderTreeSectionHtml）。
 *
 * ★ 与 renderTreeHtml（探针整页）的三个本质差别 ★
 *   1. 片段不能带 <script>：小抄 html 走 innerHTML 注入，脚本按规范不执行。
 *      所以交互（展开/收起、三视图切换）全部由前端事件委托做（StudyPanel.onTreeClick），
 *      这里只输出**静态结构 + data-* 属性**。
 *   2. 类名全部加 kt- 前缀，避免和应用样式互伤；样式在 src/styles/theme.css。
 *   3. 标注三件套（data-ik / data-fb / .fb b[data-mark]）与小抄条目**完全同构**——
 *      前端现有的反馈事件委托、服务端现有的 /cheatsheet/feedback 都不用为树另写一套。
 *
 * 三视图（树 / 思维导图 / markdown）都在片段里，用 hidden 属性切换；
 * 前端在容器上挂 kt-as-mm / kt-as-md 类，CSS 决定显示哪一份。
 */
export function renderTreeSectionHtml(
  tree: KnowledgeTree,
  xrefs?: Map<string, { headingId: string; headingText: string }[]>,
  answers?: Map<number, import('./answerLink').AnswerRow>,
  /** ★ 节级考频（多鱼 2026-10-07 拍：档位化徽章，树上不排序，只展示）★ */
  freq?: { marks: number; companies: number; level: 0 | 1 | 2 | 3 },
): string {
  const roots = buildTree(tree);
  const fbHtml =
    `<span class="fb"><b data-mark="up" title="有用">▲</b>` +
    `<b data-mark="down" title="反馈（可填理由）">▽</b>` +
    `<b data-mark="dup" title="和别条重复">⧉</b></span>`;
  const fbAttrs = (fb?: { mark: string; why?: string }): string =>
    (fb ? ` data-fb="${esc(fb.mark)}"${fb.why ? ` data-fbwhy="${esc(fb.why)}"` : ''}` : '');

  // ★ L3 跨节「另见」★ 同 key 概念在本篇其他节也出现过 → 节点行给一枚跳转徽章。
  //   data-jump-hid = 目标节 headingId；多于一处时点徽章跳第一处，悬停 title 列出全部。
  const xrefOf = (name: string): string => {
    if (!xrefs) return '';
    const list = xrefs.get(conceptKeyOf(name));
    if (!list || list.length === 0) return '';
    const titles = list.map((x) => x.headingText).join('；');
    return (
      `<button class="kt-xref" data-jump-hid="${esc(list[0].headingId)}" ` +
      `title="这个知识点还出现在：${esc(titles)}">↗ 另见${list.length > 1 ? ` ${list.length} 节` : ' 1 节'}</button>`
    );
  };

  const detailsOf = (n: KNode): string =>
    n.details.length
      ? `<ul class="kt-details">${n.details
          .map((d) => {
            const ik = itemKeyOf((d.text ?? '').trim());
            const bi = d.bi != null ? ` data-bi="${d.bi}"` : '';
            // ★「答案见」（B1-2，2026-09-22）★ 这条细节落在思考题块上、且参考答案
            //   文件里有对应答案 → 给一枚跨文档跳转徽章（前端 requestJump + openDoc）。
            const ans = d.bi != null ? answers?.get(d.bi) : undefined;
            const ansChip = ans
              ? `<button class="kt-xref kt-answer" data-jump-rel="${esc(ans.answerRel)}" data-jump-bi="${ans.answerBi}" title="这道题在参考答案里有答案，点这里跳过去">答案见</button>`
              : '';
            return (
              `<li class="kt-d"${bi} data-ik="${ik}"${fbAttrs(d.feedback)}>` +
              `<span class="kt-kb kt-k-${esc(d.kind)}">${esc(d.kind)}</span>` +
              `<span class="kt-tx">${esc(d.text)}${
                d.quote ? `<br><span class="kt-qt">「${esc(d.quote)}」</span>` : ''
              }</span>` +
              (d.bi != null ? `<span class="kt-jump" title="跳到原文">↗</span>` : '') +
              ansChip +
              fbHtml +
              `</li>`
            );
          })
          .join('')}</ul>`
      : '';

  const relsOf = (n: KNode): string =>
    n.relations.length
      ? `<div class="kt-rels">${n.relations
          .map(
            (r) =>
              `<span class="kt-r${r.toNode ? '' : ' out'}">⤳ <b>${esc(r.rel)}</b> ${r.toNode ? '→' : '⇢'} ${esc(r.target)}${
                r.note ? ` <span class="kt-note">（${esc(r.note)}）</span>` : ''
              }</span>`,
          )
          .join('')}</div>`
      : '';

  // 节点：data-ik = essence 的内容 hash（essence 也可标注）；行点击=展开/收起（前端做）
  const walk = (n: TreeNode): string =>
    `<li class="kt-node${n.depth === 0 ? ' open' : ''}" data-ik="${itemKeyOf((n.essence ?? '').trim())}"${fbAttrs(n.feedback)}>` +
    `<div class="kt-row${n.depth === 0 ? ' kt-root' : ''}">` +
    `<span class="kt-tw${n.children.length ? ' kt-can' : ''}">${n.children.length ? '▸' : '·'}</span>` +
    `<span class="kt-badge kt-b-${esc(n.kind)}">${esc(n.kind)}</span>` +
    // ★ 点名字跳原文（2026-09-22 拍板：点名字跳、点三角展开）★
    //   data-bi 只在有块号时输出——没有块号的名字保持不可点外观，前端把它当展开用。
    `<span class="kt-name"${n.bi != null ? ` data-bi="${n.bi}"` : ''}>${esc(n.name)}</span>` +
    xrefOf(n.name) +
    (n.essence ? `<span class="kt-es">${esc(n.essence)}</span>` : '') +
    (n.bi != null ? `<span class="kt-loc" title="原文第 ${n.bi} 块（点左边的名字跳过去）">¶${n.bi}</span>` : '') +
    fbHtml +
    `</div>` +
    `<div class="kt-body">${relsOf(n)}${detailsOf(n)}${
      n.children.length ? `<ul class="kt-sub">${n.children.map(walk).join('')}</ul>` : ''
    }</div>` +
    `</li>`;

  const md = renderTreeMarkdown(tree, { depth: 'deep' });
  const mm = renderMindmapHtml(tree);
  const dCount = tree.nodes.reduce((s, n) => s + n.details.length, 0);
  const rCount = tree.nodes.reduce((s, n) => s + n.relations.length, 0);

  // ★ 考频徽章（节级，档位化）★
  //   挂在**节标题**旁而不是节点行上 —— 考频是这一节的属性，不是某个知识点的属性。
  //   档位用相对分位（见 sectionFrequency.applyLevels 的说明），所以面经文件变多时
  //   不会出现「全库整体升档、徽章看着像坏了」。具体数字放 title，宽度留给档位。
  const lv = freq?.level ?? 0;
  const freqHtml = lv
    ? `<span class="kt-freq" data-lv="${lv}" title="本节内容在面经里被问过 ${freq!.marks} 次，涉及 ${freq!.companies} 家公司（考频 = 公司标注次数）">${'●'.repeat(lv)}${'○'.repeat(3 - lv)}</span>`
    : '';

  return (
    `<div class="ktree" data-tree="1">` +
    `<div class="kt-head"><span class="kt-title">${esc(tree.title)}</span>` +
    freqHtml +
    (tree.question ? `<span class="kt-q">${esc(tree.question)}</span>` : '') +
    `</div>` +
    `<div class="kt-view kt-v-tree"><ul class="kt-tree">${roots.map(walk).join('')}</ul></div>` +
    `<div class="kt-view kt-v-mm" hidden>${mm}</div>` +
    `<div class="kt-view kt-v-md" hidden><pre class="kt-md">${esc(md)}</pre></div>` +
    `<div class="kt-foot">${tree.nodes.length} 个知识点 · ${dCount} 条细节 · ${rCount} 条关系 · ` +
    `¶n = 原文块号，点细节跳原文 · ▲▽ 标注会进评测集</div>` +
    `</div>`
  );
}
