/**
 * server/services/feedbackApplier.ts —— 反馈执行 agent 的「程序闸门」（V1，2026-09-24）。
 *
 * ★ 它是什么 ★
 *   agent（feedbackAgent.ts）产出**结构化变更计划**（JSON），本文件用确定性代码
 *   复检并执行。这是 M4「agent 只能提议不能改」铁律的受控突破：
 *   agent 不碰任何写工具，改的每一步都过五道闸——
 *     1) schema 白名单（zod discriminatedUnion，未知操作整体拒绝）
 *     2) 单轮 ops ≤ 10（超限整体拒绝，不截断——半拉子状态比不做更糟）
 *     3) existence check（cardId / ik 必须真实存在，树节点带 name 冗余校验）
 *     4) 依据回查（basedOn.quote 必须能命中真实反馈文本池——防编造理由）
 *     5) 可逆性（卡片删除 = suspended 软删不走硬删；条目删除 = sec.dropped 回收站；
 *        每条落审计 feedback-actions.jsonl 含 before 快照，可反向回放）
 *
 * ★ 零模型调用 ★
 *   本文件不 import agentRuntime / aiClient。纯函数芯（applyOpToCards /
 *   applyOpsToSection）+ IO 壳（applyFeedbackPlan）分离，离线探针直测芯。
 *   **不写 eval-set.jsonl**：那是她本人的判断金标准（EvalSource 闭集），
 *   agent 动作只进 feedback-actions.jsonl，两边永远不混。
 */

import { z } from 'zod';
import { itemKeyOf, makeId, type Card, type CheatsheetDropped, type CheatsheetSection } from '../../shared/text';
import { newSm2State } from './sm2';
import { updateSidecar } from './sidecar';
import { loadLearning } from './learning';
import { appendFeedbackActions } from './feedback';

// ─────────────────────────── 变更计划 schema ───────────────────────────

/** 反馈依据：quote 必须是她的反馈原文的**逐字**引用（应用器做子串回查，防幻觉依据）。
 *  userInstruction（2026-09-24）= 她本次对话里指名的要求——「指名就改」通道的依据来源，
 *  与历史反馈同一套回查，防 agent 自己编个理由就改东西。 */
export const evidenceSchema = z.object({
  channel: z.enum(['learning_cardFbWhy', 'unlinkedCardFb', 'itemMark', 'treeMark', 'digestLine', 'userInstruction']),
  doc: z.string().min(1).max(1024),
  headingId: z.string().max(200).optional(),
  quote: z.string().min(2).max(300),
  mark: z.enum(['up', 'down', 'dup']).optional(),
});

const targetCard = z.object({
  targetType: z.literal('card'),
  doc: z.string().min(1).max(1024),
  cardId: z.string().min(1).max(64),
});

/**
 * 新建一张卡：没有 cardId，目标由「哪一节」定位。
 *
 * ★ 为什么单独一类，而不是复用 card.revise ★
 *   revise 必须有 cardId（它改的是一张已存在的卡），而新建时卡还不存在。
 *   同理 quote 是可选的 —— 手写卡经常没有原文引用。
 */
const targetNewCard = z.object({
  targetType: z.literal('newCard'),
  doc: z.string().min(1).max(1024),
  /** 挂在哪一节（空串 = 不归类） */
  headingId: z.string().max(200).default(''),
});

const targetNode = z.object({
  targetType: z.literal('treeNode'),
  doc: z.string().min(1).max(1024),
  headingId: z.string().min(1).max(200),
  /** essence 的 itemKeyOf hash（8 位），与树标注通道同一套 */
  ik: z.string().length(8),
  /** 冗余校验：防 hash 撞车 / 模型拿旧 hash 对新文本 */
  name: z.string().min(1).max(80),
});

const targetItem = z.object({
  targetType: z.literal('item'),
  doc: z.string().min(1).max(1024),
  headingId: z.string().min(1).max(200),
  ik: z.string().length(8),
  /** 术语的 ik 是「term：meaning」合成文本的 hash，与 droppedText / 呈现层同一套 */
  /** 路由层：命题→propositions、术语→terms、其余全部→entries（定义/等式/数值/类比/清单
   *  都是 entries 里的 kind 字段，不是独立数组）。模型常用真实种类名当 layer（实测第二轮
   *  dry 5 条 op 因此被剔），所以在 parse 层归一化，别让合法目标死在路由枚举上。 */
  layer: z
    .enum(['命题', '条目', '术语', '定义', '等式', '数值', '类比', '清单'])
    .transform((v): '命题' | '条目' | '术语' => (v === '命题' ? '命题' : v === '术语' ? '术语' : '条目')),
});

export const changeOpSchema = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('card.revise'),
    target: targetCard,
    newContent: z.object({ front: z.string().min(1).max(1000).optional(), back: z.string().min(1).max(4000).optional() })
      .refine((v) => !!v.front || !!v.back, 'front/back 至少给一个'),
    reason: z.string().min(4).max(300),
    basedOn: evidenceSchema,
  }),
  z.object({
    operation: z.literal('card.suspend'),
    target: targetCard,
    reason: z.string().min(4).max(300),
    basedOn: evidenceSchema,
  }),
  /** 实现 = suspended:true（软删，可逆）。硬删 DELETE /cards/:id 不在 agent 权限内。 */
  z.object({
    operation: z.literal('card.remove'),
    target: targetCard,
    reason: z.string().min(4).max(300),
    basedOn: evidenceSchema,
  }),
  /**
   * 新建一张卡（她指名要加题，或你说「这里该加一张卡」并她点了批准）。
   * ★ 正面会被程序硬门校验 ★
   *   服务端对非问句的正面直接拒（跟 /cards/from-tree 同一把尺），
   *   所以模型不能塞「Harness 工程 · 概念」这种标签进去。
   */
  z.object({
    operation: z.literal('card.create'),
    target: targetNewCard,
    newContent: z.object({
      front: z.string().min(8).max(1000),
      back: z.string().min(1).max(4000),
      /** 原文引用可选：手写卡常常没有 */
      quote: z.string().max(300).optional(),
      /** 归属知识点（挂上才排得进按概念的复习） */
      conceptKey: z.string().max(200).optional(),
    }),
    reason: z.string().min(4).max(300),
    basedOn: evidenceSchema,
  }),
  z.object({
    operation: z.literal('treeNode.essenceRevise'),
    target: targetNode,
    /** KNode.essence 规约 ≤40 字，放宽到 60 给标点余量 */
    newContent: z.string().min(4).max(60),
    reason: z.string().min(4).max(300),
    basedOn: evidenceSchema,
  }),
  z.object({
    operation: z.literal('item.remove'),
    target: targetItem,
    reason: z.string().min(4).max(300),
    basedOn: evidenceSchema,
  }),
  /** 指名改条目文本（2026-09-24，「指名就改」通道）。定位仍用旧 ik；改完 ik 自然变。 */
  z.object({
    operation: z.literal('item.revise'),
    target: targetItem,
    newContent: z.string().min(2).max(600),
    reason: z.string().min(4).max(300),
    basedOn: evidenceSchema,
  }),
  /** 指名改树节点（name 或 essence）。选 essence 的旧路径 essenceRevise 保留兼容。 */
  z.object({
    operation: z.literal('treeNode.revise'),
    target: targetNode,
    field: z.enum(['name', 'essence']),
    newContent: z.string().min(2).max(60),
    reason: z.string().min(4).max(300),
    basedOn: evidenceSchema,
  }),
]);

export const feedbackPlanSchema = z.object({
  planVersion: z.literal(1),
  ops: z.array(changeOpSchema).max(10),
  summary: z.string().max(500),
});

export type ChangeOp = z.infer<typeof changeOpSchema>;
export type FeedbackPlan = z.infer<typeof feedbackPlanSchema>;

// ─────────────────────────── 审计 ───────────────────────────

export interface FeedbackActionRow {
  at: string;
  op: string;
  doc: string;
  headingId?: string;
  target: unknown;
  reason: string;
  basedOn: unknown;
  /** 执行前的完整快照（撤销靠它反向回放） */
  before?: unknown;
  result: 'applied' | 'skipped' | 'rejected';
  rejectedWhy?: string;
}

// ─────────────────────────── 依据回查 ───────────────────────────

const norm = (s: string): string => (s ?? '').replace(/\s+/g, '').replace(/[「」"'']/g, '');

/**
 * 反馈文本池：她的所有反馈原文（卡片 fbWhy、各层标注 why、unlinked 卡反馈、digest 全文）。
 * agent 的 basedOn.quote 必须能命中池里某条——**双向**包含：quote 是池文本的子串（agent 截了半句）
 * 或池文本是 quote 的子串（agent 带了上下文引号）。
 */
export async function buildEvidencePool(docs: string[]): Promise<string[]> {
  const pool: string[] = [];
  const store = await loadLearning();
  for (const u of store.unlinkedCardFb ?? []) if (u.why) pool.push(u.why);
  for (const e of store.entries) {
    for (const ev of e.evidence ?? []) if (ev.why) pool.push(ev.why);
  }
  for (const doc of docs) {
    try {
      const sidecar = await import('./sidecar').then((m) => m.readSidecar(doc));
      for (const c of sidecar.cards ?? []) if (c.fbWhy) pool.push(c.fbWhy);
      for (const s of sidecar.cheatsheet?.sections ?? []) {
        for (const n of s.tree?.nodes ?? []) {
          if (n.feedback?.why) pool.push(n.feedback.why);
          for (const d of n.details ?? []) if (d.feedback?.why) pool.push(d.feedback.why);
        }
        const items = s.items;
        if (!items) continue;
        for (const p of items.propositions ?? []) if (p.feedback?.why) pool.push(p.feedback.why);
        for (const e of items.entries ?? []) if (e.feedback?.why) pool.push(e.feedback.why);
        for (const t of items.terms ?? []) if (t.feedback?.why) pool.push(t.feedback.why);
      }
    } catch {
      /* 文档读不到就跳过，池里少一块不影响其他 */
    }
  }
  return pool;
}

export function evidenceHits(pool: string[], quote: string): boolean {
  const q = norm(quote);
  if (!q) return false;
  // 短引用（<4 字，如她的理由「没意义」）只允许**精确等于**池条目——
  // 子串匹配会让单字噪声假命中，失去防编造意义
  if (q.length < 4) return pool.some((p) => norm(p) === q);
  return pool.some((p) => {
    const t = norm(p);
    return t.includes(q) || q.includes(t);
  });
}

// ─────────────────────────── 纯函数芯（探针直测） ───────────────────────────

export interface OpRow extends Omit<FeedbackActionRow, 'at'> {}

function cardOpRow(op: ChangeOp & { operation: `card.${string}` }, c: Card, result: OpRow['result'], rejectedWhy?: string): OpRow {
  return {
    op: op.operation,
    doc: op.target.doc,
    target: op.target,
    reason: op.reason,
    basedOn: op.basedOn,
    before: { id: c.id, front: c.front, back: c.back, suspended: c.suspended, fb: c.fb ?? null, fbWhy: c.fbWhy ?? null },
    result,
    ...(rejectedWhy ? { rejectedWhy } : {}),
  };
}

/** 卡片三类操作（revise / suspend / remove）在内存 cards 上执行。existed=false 由调用方先判。 */
export function applyOpToCards(
  cards: Card[],
  op: ChangeOp,
  pool: string[],
  existed: boolean,
): { row: OpRow; op: ChangeOp | null } {
  if (op.operation !== 'card.revise' && op.operation !== 'card.suspend' && op.operation !== 'card.remove') {
    return { row: { op: op.operation, doc: '', target: op.target, reason: '', basedOn: op.basedOn, result: 'rejected', rejectedWhy: '不是卡片操作' }, op: null };
  }
  const c = cards.find((x) => x.id === op.target.cardId);
  if (!existed || !c) {
    return { row: { op: op.operation, doc: op.target.doc, target: op.target, reason: op.reason, basedOn: op.basedOn, result: 'rejected', rejectedWhy: 'cardId 不存在' }, op: null };
  }
  if (!evidenceHits(pool, op.basedOn.quote)) {
    return { row: cardOpRow(op, c, 'rejected', 'basedOn.quote 在反馈文本池中无命中（疑似编造依据）'), op: null };
  }
  if (op.operation === 'card.revise') {
    const nc = op.newContent;
    if (nc.front != null && nc.front === c.front && (nc.back == null || nc.back === c.back)) {
      return { row: cardOpRow(op, c, 'skipped', '新内容与现值相同'), op: null };
    }
    const before = { front: c.front, back: c.back };
    if (nc.front != null) c.front = nc.front;
    if (nc.back != null) c.back = nc.back;
    return { row: { op: op.operation, doc: op.target.doc, target: op.target, reason: op.reason, basedOn: op.basedOn, before, result: 'applied' }, op };
  }
  // suspend / remove 同一动作：软删。remove 的区别只在审计语义（撤销=恢复 suspended:false）
  if (c.suspended) return { row: cardOpRow(op, c, 'skipped', '卡已处于 suspended'), op: null };
  c.suspended = true;
  return { row: cardOpRow(op, c, 'applied'), op };
}

/**
 * 新建一张卡。
 *
 * ★ 为什么不走 applyOpToCards ★
 *   那三个操作都以「卡已存在」为前提（要先找到 cardId、改一张已有的卡），
 *   新建时卡还不存在。而它是唯一**增加**卡片的操作——所以单独一个函数，
 *   也因此是唯一一处要生成新卡 id 的地方。
 *
 * ★ 正面形状硬门（跟 /cards/from-tree 同一把尺）★
 *   模型很容易塞「Harness 工程 · 概念」这种标签当正面，复习时根本没法用。
 *   提示词说了不算数，这里挡一道。四条判据的实测见
 *   `.local/probe-out/card-front-probe-report.txt`。
 */
export function applyCardCreate(
  cards: Card[],
  op: Extract<ChangeOp, { operation: 'card.create' }>,
): { row: OpRow; card: Card | null } {
  const bad = (why: string): { row: OpRow; card: null } => ({
    row: { op: op.operation, doc: op.target.doc, target: op.target, reason: op.reason, basedOn: op.basedOn, result: 'rejected', rejectedWhy: why },
    card: null,
  });

  const front = op.newContent.front.trim();
  const back = op.newContent.back.trim();

  if (front.length < 8) return bad(`正面太短（${front.length} 字），不构成问题`);
  if (front.length > 60) return bad('正面太长（>60 字），复习时读不完');
  if (!/[？?]|是什么|为什么|怎么|哪些|哪个|如何|写出|说说|多少|能不能|会不会|差别|区别|前提|条件/.test(front)) {
    return bad('正面不是问句（没有问号也没有疑问词）');
  }
  if (/·\s*(例子|要点|定义|等式|数值|类比|清单|原则|事实|机制|做法|概念)\s*$/.test(front)) {
    return bad('正面是「名词 · 类型」标签形状，不是问题');
  }
  if (/^(它|这个|这些|那个|上述|前面)[^，。]{0,8}(是什么|做什么|怎么|如何|的作用)/.test(front)) {
    return bad('正面无主语（不知道在问谁）');
  }

  // 同节同正面 = 重复建（模型很容易对着一条内容反复建卡）
  const dup = cards.find((c) => c.headingId === op.target.headingId && c.front.trim() === front);
  if (dup) return bad(`这一节已有一张正面相同的卡（${dup.id}），别重复建`);

  const card: Card = {
    id: makeId('cd'),
    front,
    back,
    source: { type: 'note', refId: `agent:${Date.now()}`, quote: (op.newContent.quote ?? '').trim() },
    headingId: op.target.headingId,
    ...(op.newContent.conceptKey ? { conceptKey: op.newContent.conceptKey } : {}),
    sm2: newSm2State(),
    suspended: false,
    createdAt: new Date().toISOString(),
  };
  cards.push(card);
  return {
    row: {
      op: op.operation,
      doc: op.target.doc,
      target: op.target,
      reason: op.reason,
      basedOn: op.basedOn,
      before: { front, back },
      result: 'applied',
    },
    card,
  };
}

/** 树/条目操作（item.remove / treeNode.essenceRevise）在内存 section 上执行。 */
export function applyOpsToSection(
  sec: CheatsheetSection,
  ops: ChangeOp[],
  pool: string[],
): { rows: OpRow[]; applied: ChangeOp[] } {
  const rows: OpRow[] = [];
  const applied: ChangeOp[] = [];
  const items = sec.items;

  for (const op of ops) {
    if (op.operation === 'item.remove') {
      const t = op.target;
      const secOk = sec.headingId === t.headingId;
      const hit = secOk && items
        ? t.layer === '命题'
          ? items.propositions ?? []
          : t.layer === '术语'
            ? items.terms ?? []
            : items.entries ?? []
        : [];
      const idx = hit.findIndex((it) => itemKeyOf(textOf(t.layer, it)) === t.ik);
      if (idx < 0) {
        rows.push({ op: op.operation, doc: t.doc, headingId: t.headingId, target: t, reason: op.reason, basedOn: op.basedOn, result: 'rejected', rejectedWhy: 'ik 在该节该层匹配不到条目' });
        continue;
      }
      if (!evidenceHits(pool, op.basedOn.quote)) {
        rows.push({ op: op.operation, doc: t.doc, headingId: t.headingId, target: t, reason: op.reason, basedOn: op.basedOn, result: 'rejected', rejectedWhy: 'basedOn.quote 在反馈文本池中无命中（疑似编造依据）' });
        continue;
      }
      const item = hit[idx];
      hit.splice(idx, 1);
      (sec.dropped ??= []).push({ layer: t.layer, reason: op.reason, item } as CheatsheetDropped);
      rows.push({ op: op.operation, doc: t.doc, headingId: t.headingId, target: t, reason: op.reason, basedOn: op.basedOn, before: item, result: 'applied' });
      applied.push(op);
      continue;
    }

    if (op.operation === 'item.revise') {
      const t = op.target;
      const secOk = sec.headingId === t.headingId;
      const hit = secOk && items
        ? t.layer === '命题'
          ? items.propositions ?? []
          : t.layer === '术语'
            ? items.terms ?? []
            : items.entries ?? []
        : [];
      const idx = hit.findIndex((it) => itemKeyOf(textOf(t.layer, it)) === t.ik);
      if (idx < 0) {
        rows.push({ op: op.operation, doc: t.doc, headingId: t.headingId, target: t, reason: op.reason, basedOn: op.basedOn, result: 'rejected', rejectedWhy: 'ik 在该节该层匹配不到条目' });
        continue;
      }
      if (!evidenceHits(pool, op.basedOn.quote)) {
        rows.push({ op: op.operation, doc: t.doc, headingId: t.headingId, target: t, reason: op.reason, basedOn: op.basedOn, result: 'rejected', rejectedWhy: 'basedOn.quote 在依据池中无命中（疑似编造依据）' });
        continue;
      }
      const item = hit[idx] as unknown as Record<string, unknown>;
      const before = JSON.parse(JSON.stringify(item)) as unknown;
      const next = op.newContent.trim();
      if (t.layer === '命题') {
        if (String(item.statement ?? '').trim() === next) {
          rows.push({ op: op.operation, doc: t.doc, headingId: t.headingId, target: t, reason: op.reason, basedOn: op.basedOn, before, result: 'skipped', rejectedWhy: '新文本与现值相同' });
          continue;
        }
        item.statement = next;
      } else if (t.layer === '术语') {
        // 术语是「term：meaning」合成文本。带冒号 = 两段都改；不带 = 只改释义（术语名是她认的字，别动）
        const m = next.split(/[：:]/);
        if (m.length >= 2) {
          item.term = m[0].trim();
          item.meaning = m.slice(1).join('：').trim();
        } else {
          item.meaning = next;
        }
      } else {
        if (String(item.text ?? '').trim() === next) {
          rows.push({ op: op.operation, doc: t.doc, headingId: t.headingId, target: t, reason: op.reason, basedOn: op.basedOn, before, result: 'skipped', rejectedWhy: '新文本与现值相同' });
          continue;
        }
        item.text = next;
      }
      // ★ 判断对象已变：旧标注（▲▽⧉）是打在**旧文本**上的，留着会误导
      //   （新内容带着旧判断显示成淡化/隐藏）。清掉，before 快照里留了全量可恢复。
      delete item.feedback;
      rows.push({ op: op.operation, doc: t.doc, headingId: t.headingId, target: t, reason: op.reason, basedOn: op.basedOn, before, result: 'applied' });
      applied.push(op);
      continue;
    }

    if (op.operation === 'treeNode.revise') {
      const t = op.target;
      const node = sec.headingId === t.headingId
        ? (sec.tree?.nodes ?? []).find((n) => n.name === t.name && itemKeyOf(n.essence ?? '') === t.ik)
        : undefined;
      if (!node) {
        rows.push({ op: op.operation, doc: t.doc, headingId: t.headingId, target: t, reason: op.reason, basedOn: op.basedOn, result: 'rejected', rejectedWhy: 'headingId+name+ik 定位不到树节点' });
        continue;
      }
      if (!evidenceHits(pool, op.basedOn.quote)) {
        rows.push({ op: op.operation, doc: t.doc, headingId: t.headingId, target: t, reason: op.reason, basedOn: op.basedOn, result: 'rejected', rejectedWhy: 'basedOn.quote 在依据池中无命中（疑似编造依据）' });
        continue;
      }
      const cur = op.field === 'name' ? node.name : node.essence ?? '';
      if (cur === op.newContent) {
        rows.push({ op: op.operation, doc: t.doc, headingId: t.headingId, target: t, reason: op.reason, basedOn: op.basedOn, before: { name: node.name, essence: node.essence }, result: 'skipped', rejectedWhy: `${op.field} 已等于新值` });
        continue;
      }
      const before = { name: node.name, essence: node.essence };
      if (op.field === 'name') node.name = op.newContent;
      else node.essence = op.newContent;
      delete node.feedback; // 同 item.revise：内容变了，旧判断作废
      rows.push({ op: op.operation, doc: t.doc, headingId: t.headingId, target: t, reason: op.reason, basedOn: op.basedOn, before, result: 'applied' });
      applied.push(op);
      continue;
    }

    if (op.operation === 'treeNode.essenceRevise') {
      const t = op.target;
      const node = sec.headingId === t.headingId
        ? (sec.tree?.nodes ?? []).find((n) => n.name === t.name && itemKeyOf(n.essence ?? '') === t.ik)
        : undefined;
      if (!node) {
        rows.push({ op: op.operation, doc: t.doc, headingId: t.headingId, target: t, reason: op.reason, basedOn: op.basedOn, result: 'rejected', rejectedWhy: 'headingId+name+ik 定位不到树节点' });
        continue;
      }
      if (!evidenceHits(pool, op.basedOn.quote)) {
        rows.push({ op: op.operation, doc: t.doc, headingId: t.headingId, target: t, reason: op.reason, basedOn: op.basedOn, result: 'rejected', rejectedWhy: 'basedOn.quote 在反馈文本池中无命中（疑似编造依据）' });
        continue;
      }
      if ((node.essence ?? '') === op.newContent) {
        rows.push({ op: op.operation, doc: t.doc, headingId: t.headingId, target: t, reason: op.reason, basedOn: op.basedOn, before: { essence: node.essence }, result: 'skipped', rejectedWhy: 'essence 已等于新值' });
        continue;
      }
      const before = { name: node.name, essence: node.essence };
      node.essence = op.newContent;
      rows.push({ op: op.operation, doc: t.doc, headingId: t.headingId, target: t, reason: op.reason, basedOn: op.basedOn, before, result: 'applied' });
      applied.push(op);
      continue;
    }

    // 卡片操作不在这里处理（调用方拆给 applyOpToCards）
  }
  return { rows, applied };
}

/** 条目文本（ik 的输入）——术语层与 droppedText / 呈现层同一套合成规则。
 *  导出给 agentTools 的 edit_library 用（构造影响面清单要取 before 文本，规则必须同一份）。 */
export function textOf(layer: '命题' | '条目' | '术语', it: unknown): string {
  const o = it as Record<string, string>;
  if (layer === '命题') return (o.statement ?? '').trim();
  if (layer === '术语') return `${(o.term ?? '').trim()}：${(o.meaning ?? '').trim()}`;
  return (o.text ?? '').trim();
}

// ─────────────────────────── IO 壳 ───────────────────────────

export interface ApplyReport {
  dry: boolean;
  applied: number;
  skipped: number;
  rejected: number;
  rows: OpRow[];
  /** 整体拒绝的原因（超限等）——有它时 rows 为空 */
  fatal?: string;
}

/**
 * 执行变更计划。
 * - `dry`：只算不落盘（探针 / 预演）
 * - `evidencePool`：依据池。不传 = 从库内她的历史反馈收集（feedback 审查原行为）；
 *   传了就用传进来的（「指名就改」通道传她本次的原话 + 库内池）。
 */
export async function applyFeedbackPlan(
  plan: FeedbackPlan,
  opts: { dry?: boolean; evidencePool?: string[] } = {},
): Promise<ApplyReport> {
  if (plan.ops.length > 10) {
    return { dry: !!opts.dry, applied: 0, skipped: 0, rejected: 0, rows: [], fatal: `ops ${plan.ops.length} 条超上限 10，整体拒绝（不截断）` };
  }

  const docs = [...new Set(plan.ops.map((o) => o.target.doc))];
  const pool = opts.evidencePool ?? (await buildEvidencePool(docs));

  // 同一 target 只保留第一条（重复提议大概率是模型绕圈）
  const seen = new Set<string>();
  const deduped = plan.ops.filter((o) => {
    const k = `${o.operation}|${JSON.stringify(o.target)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const rows: OpRow[] = [];
  let applied = 0;
  let skipped = 0;
  let rejected = 0;

  for (const doc of docs) {
    const docOps = deduped.filter((o) => o.target.doc === doc);
    const cardOps = docOps.filter((o) => o.operation.startsWith('card.'));
    const secOps = docOps.filter((o) => !o.operation.startsWith('card.'));
    if (!cardOps.length && !secOps.length) continue;

    await updateSidecar(doc, (s) => {
      if (cardOps.length) {
        const cards = s.cards ?? [];
        for (const op of cardOps) {
          // ★ card.create 不走 applyOpToCards ★
          //   它是唯一「增加」卡片的操作：卡还不存在，所以没有 cardId 可查、
          //   也不需要 evidencePool 命中（它是她指名要加的题，不是从反馈推出来的）。
          if (op.operation === 'card.create') {
            const { row } = applyCardCreate(cards, op);
            rows.push(row);
            if (row.result === 'applied') applied += 1;
            else rejected += 1;
            continue;
          }
          const cid = (op.target as { cardId?: string }).cardId ?? '';
          const { row } = applyOpToCards(cards, op, pool, cards.some((x) => x.id === cid));
          rows.push(row);
          if (row.result === 'applied') applied += 1;
          else if (row.result === 'skipped') skipped += 1;
          else rejected += 1;
        }
      }
      if (secOps.length) {
        for (const sec of s.cheatsheet?.sections ?? []) {
          const mine = secOps.filter((o) => (o.target as { headingId: string }).headingId === sec.headingId);
          if (!mine.length) continue;
          const r = applyOpsToSection(sec, mine, pool);
          rows.push(...r.rows);
          applied += r.rows.filter((x) => x.result === 'applied').length;
          skipped += r.rows.filter((x) => x.result === 'skipped').length;
          rejected += r.rows.filter((x) => x.result === 'rejected').length;
        }
      }
      return null; // mutate in place
    });
  }

  if (!opts.dry && rows.some((r) => r.result === 'applied')) {
    await appendFeedbackActions(rows.map((r) => ({ ...r, at: new Date().toISOString() })));
  }
  return { dry: !!opts.dry, applied, skipped, rejected, rows };
}
