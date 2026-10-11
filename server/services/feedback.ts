/**
 * server/services/feedback.ts —— 把人的判断汇总成一份能读的文件。
 *
 * ★ 为什么要有这个 digest ★
 *   `feedback` 散落在 27 个 sidecar 的 1797 条条目里，等于没有。
 *   汇总出来才有三个用处：
 *     1. 你自己看得见「我到底标了些什么」；
 *     2. 它是「判断回流」的可见产物 —— 系统第一次有了人对产出的评价；
 *     3. 外部助手（DSH）直接读这一个文件就能拿到你的偏好，不用去翻 sidecar。
 *
 * 每次标注后增量重写（全库扫一遍 27 篇，不调模型，几毫秒）。
 */

import fs from 'fs/promises';
import path from 'path';
import { DATA_DIR_NAME, requireVaultRoot } from '../core';
import { listAllSidecars } from './sidecar';
import { coverage } from './cheatsheet';
import {
  dice,
  itemKeyOf,
  type CheatsheetDropped,
  type CheatsheetItems,
  type CheatsheetProposition,
  type CheatsheetEntry,
  type CheatsheetTerm,
  type Feedback,
  type FeedbackMark,
} from '../../shared/text';

const MARK_LABEL: Record<FeedbackMark, string> = {
  up: '▲ 有用',
  down: '▽ 反馈',
  dup: '⧉ 重复',
};

// ─────────────────────────── 标注随行 ───────────────────────────

/**
 * ★ 标注随行：重新生成小抄时，把旧条目上的偏好标注搬进新条目 ★
 *
 * 背景：标注存在 `sec.items.*[].feedback`，而生成路径是按 headingId 整节替换
 * （study.ts），不搬的话用户标过的判断随重生成一起蒸发——进化循环就断了
 * （▲ 率永远没有跨代基线）。
 *
 * 搬运判据（和 sidecar 自愈、条目去重同一哲学：锚断了就按内容重锚）：
 *   1. 精确：内容 hash（itemKeyOf）相同 → 直接搬。措辞没改的条目走这条，零误伤。
 *   2. 相似：dice ≥ 0.75 或 coverage ≥ 0.9 → 搬。同一判据的阈值是
 *      dedupeEntriesAgainstEntries 实测量出来的（0.6/0.8 有 40% 假阳性）。
 *   3. ★ 等式/数值条目只走精确匹配 ★ —— 这两个 kind 骨架相同语义不同的假阳性
 *      是实测过的（H(x) vs H(p,q) dice 0.90），宁可丢进孤儿存档也不误贴。
 *
 * 认不出爹的旧标注不删：返回给调用方落 `feedback-orphaned.jsonl` 存档。
 */
export type FeedbackLayer = '命题' | '条目' | '术语' | '树节点' | '树条';

interface FbItem {
  layer: FeedbackLayer;
  /** 条目才有 kind（定义/等式/数值/类比/清单），用于等式豁免 */
  kind?: string;
  text: string;
  /** 条目自带的原文引文（术语可能没有）——评测集三元组里的「原文位置」 */
  quote?: string;
  feedback: Feedback;
}

/** 存档行：孤儿 = 认不出爹的旧标注。历史也是数据，一条不真丢。 */
export interface OrphanedFeedbackRow extends FbItem {
  doc: string;
  headingId: string;
  headingText: string;
  archivedAt: string;
}

function harvest(items: CheatsheetItems): FbItem[] {
  const out: FbItem[] = [];
  for (const p of items.propositions ?? []) {
    if (p.feedback && (p.statement ?? '').trim()) {
      out.push({ layer: '命题', text: p.statement!.trim(), quote: (p.quote ?? '').trim() || undefined, feedback: p.feedback });
    }
  }
  for (const e of items.entries ?? []) {
    if (e.feedback && (e.text ?? '').trim()) {
      out.push({ layer: '条目', kind: e.kind, text: e.text!.trim(), quote: (e.quote ?? '').trim() || undefined, feedback: e.feedback });
    }
  }
  for (const t of items.terms ?? []) {
    if (!t.feedback) continue;
    const text = `${(t.term ?? '').trim()}：${(t.meaning ?? '').trim()}`;
    if (text !== '：') {
      out.push({ layer: '术语', text, quote: (t.quote ?? '').trim() || undefined, feedback: t.feedback });
    }
  }
  return out;
}

/** 回贴结果：carried = 搬成了几条；orphans = 认不出爹的；carriedRows = 明细（评测集用）。 */
export function carryFeedback(
  oldItems: CheatsheetItems,
  newItems: CheatsheetItems,
): {
  carried: number;
  orphans: FbItem[];
  /** 每条搬成的：旧文本（was）/ 新文本（text）/ 标注原样。相似轮搬运的「改写前长什么样」就靠 was。 */
  carriedRows: { layer: FeedbackLayer; kind?: string; text: string; was: string; feedback: Feedback }[];
} {
  const carriedRows: { layer: FeedbackLayer; kind?: string; text: string; was: string; feedback: Feedback }[] = [];
  const oldFb = harvest(oldItems);
  if (!oldFb.length) return { carried: 0, orphans: [], carriedRows: [] };

  // 候选 = 新条目里「还没有 feedback 且文本非空」的。consume 闭包直接写回原对象。
  const cands: { layer: FeedbackLayer; kind?: string; text: string; formula: boolean; taken: boolean; consume: (fb: Feedback) => void }[] = [];
  for (const p of newItems.propositions ?? []) {
    const t = (p.statement ?? '').trim();
    if (t && !p.feedback) cands.push({ layer: '命题', text: t, formula: false, taken: false, consume: (fb) => { p.feedback = fb; } });
  }
  for (const e of newItems.entries ?? []) {
    const t = (e.text ?? '').trim();
    if (t && !e.feedback) cands.push({ layer: '条目', kind: e.kind, text: t, formula: e.kind === '等式' || e.kind === '数值', taken: false, consume: (fb) => { e.feedback = fb; } });
  }
  for (const t of newItems.terms ?? []) {
    const text = `${(t.term ?? '').trim()}：${(t.meaning ?? '').trim()}`;
    if (text !== '：' && !t.feedback) cands.push({ layer: '术语', text, formula: false, taken: false, consume: (fb) => { t.feedback = fb; } });
  }

  const orphans: FbItem[] = [];
  let carried = 0;
  /** 精确轮已搬走的旧标注，相似度轮必须跳过 —— 否则搬成的同时又被丢进孤儿（探针抓过这个 bug）。 */
  const handled = new Set<FbItem>();

  // 第 1 轮：精确（内容 hash 相同）
  for (const o of oldFb) {
    const hit = cands.find((c) => !c.taken && c.layer === o.layer && itemKeyOf(c.text) === itemKeyOf(o.text));
    if (hit) {
      hit.taken = true;
      hit.consume(o.feedback);
      carried++;
      carriedRows.push({ layer: o.layer, kind: o.kind, text: hit.text, was: o.text, feedback: o.feedback });
      handled.add(o);
    }
  }

  // 第 2 轮：相似重锚。等式/数值不参与（骨架同 ≠ 语义同）。
  for (const o of oldFb) {
    if (handled.has(o)) continue;
    let best: (typeof cands)[number] | null = null;
    let bestScore = 0;
    for (const c of cands) {
      if (c.taken || c.layer !== o.layer || c.formula) continue;
      const d = dice(o.text, c.text);
      const short = o.text.length <= c.text.length ? o.text : c.text;
      const long = short === o.text ? c.text : o.text;
      const cov = coverage(short, long);
      const ok = d >= 0.75 || cov >= 0.9;
      const score = Math.max(d, cov);
      if (ok && score > bestScore) {
        best = c;
        bestScore = score;
      }
    }
    if (best) {
      best.taken = true;
      best.consume(o.feedback);
      carried++;
      carriedRows.push({ layer: o.layer, kind: o.kind, text: best.text, was: o.text, feedback: o.feedback });
    } else {
      orphans.push(o);
    }
  }

  return { carried, orphans, carriedRows };
}

/** 孤儿存档：追加进 `notes/.notebook/feedback-orphaned.jsonl`，一条不真丢。 */
export async function archiveOrphanedFeedback(rows: Omit<OrphanedFeedbackRow, 'archivedAt'>[]): Promise<void> {
  if (!rows.length) return;
  const root = await requireVaultRoot();
  const file = path.join(root, DATA_DIR_NAME, 'feedback-orphaned.jsonl');
  const at = new Date().toISOString();
  const lines = rows.map((r) => JSON.stringify({ ...r, archivedAt: at }));
  await fs.appendFile(file, lines.join('\n') + '\n', 'utf8');
}

// ─────────────────────────── 回收站裁决（被裁条目的 ▲▽⧉） ───────────────────────────

/** 回收站条目的展示文本 —— 必须和呈现层的 ik 算法一致（renderSectionHtml 的术语合成规则）。 */
export function droppedText(d: CheatsheetDropped): string {
  if (d.layer === '命题') return ((d.item as CheatsheetProposition).statement ?? '').trim();
  if (d.layer === '条目') return ((d.item as CheatsheetEntry).text ?? '').trim();
  const t = d.item as CheatsheetTerm;
  return `${(t.term ?? '').trim()}：${(t.meaning ?? '').trim()}`;
}

export interface BinResult {
  found: boolean;
  /** resurrected = ▲ 复活回正文；removed = ▽/⧉ 确认裁决，从回收站移除；null = 取消标注，不动 */
  action: 'resurrected' | 'removed' | null;
  /** 被裁决那条的快照（评测集用） */
  event?: { layer: FeedbackLayer; kind?: string; text: string; quote?: string };
}

/**
 * ★ 回收站里点 ▲▽⧉ —— 「合并层裁得对不对」第一次有了裁判 ★
 *
 *   ▲ = 复活：条目原样放回 items 对应层（用户的判断优先于模型的取舍）
 *   ▽/⧉ = 确认裁决：从回收站移除（这条裁对了，顺手记进评测集）
 *   null（取消）= 不动 —— 回收站条目没有落盘的 feedback 状态可取消
 *
 * ik 匹配走 droppedText 的 hash —— 与呈现层同一套文本构造，认得出来的才是自己的。
 */
export function applyBinFeedback(
  sec: { items: CheatsheetItems; dropped?: CheatsheetDropped[] },
  ik: string,
  mark: FeedbackMark | null,
): BinResult {
  const bin = sec.dropped ?? [];
  const idx = bin.findIndex((d) => itemKeyOf(droppedText(d)) === ik);
  if (idx < 0) return { found: false, action: null };
  const d = bin[idx];
  const text = droppedText(d);
  const quote = ((d.item as CheatsheetProposition).quote ?? '').trim() || undefined;
  const kind = d.layer === '条目' ? (d.item as CheatsheetEntry).kind : undefined;

  if (mark === 'up') {
    // 复活：放回对应层的末尾（用户点过头的顺序不值得精确复原，内容在就行）
    if (d.layer === '命题') (sec.items.propositions ??= []).push(d.item as CheatsheetProposition);
    else if (d.layer === '术语') (sec.items.terms ??= []).push(d.item as CheatsheetTerm);
    else (sec.items.entries ??= []).push(d.item as CheatsheetEntry);
    bin.splice(idx, 1);
  } else if (mark) {
    bin.splice(idx, 1);
  }
  if (!bin.length) delete sec.dropped;
  return {
    found: true,
    action: mark === 'up' ? 'resurrected' : mark ? 'removed' : null,
    event: { layer: d.layer, kind, text, quote },
  };
}

// ─────────────────────────── 评测集（eval-set.jsonl） ───────────────────────────

/**
 * ★ 评测集 = 三元组：原文位置 + 被判那一刻的条目原文 + 标注 ★
 *
 * 和 sidecar 的分工：sidecar 里的 feedback 是「当前状态」（会随重生成整节替换、
 * 随搬运重锚），eval-set 是「历史事实」——标注那一刻把条目原文和上下文拍快照，
 * **只追加、永不改写**。所以重新生成毁掉 sidecar，也毁不掉「错的那一版长什么样」。
 *
 * 这就是进化验证的真金标准数据源：任何提示词/模型改动，前后两代的 ▲▽⧉ 率、
 * 改写幅度（carried 的 was vs text）、孤儿率，全从这里算。
 */
export type EvalSource = 'user' | 'cancel' | 'carried' | 'orphan';

export interface EvalEvent {
  at: string;
  /** user=人点的；cancel=撤销标注；carried=重生成时相似重锚搬过去的（was=旧文本）；orphan=没搬走的 */
  source: EvalSource;
  doc: string;
  headingId: string;
  headingText: string;
  layer: FeedbackLayer;
  kind?: string;
  /** 被判的条目文本（user 事件 = 标注那一刻的原文；carried 事件 = 新文本，旧文本在 was） */
  text: string;
  /** 原文位置：条目自带的逐字引文（术语可能没有） */
  quote?: string;
  mark?: FeedbackMark;
  why?: string;
  /** carried 专属：搬运前的旧条目文本 —— 「改写前错的/对的长什么样」 */
  was?: string;
  /** 回收站裁决事件（applyBinFeedback）：这条判断是针对「被合并层裁掉的条目」的 */
  bin?: true;
}

export async function appendEvalEvents(events: EvalEvent[]): Promise<void> {
  if (!events.length) return;
  const root = await requireVaultRoot();
  const file = path.join(root, DATA_DIR_NAME, 'eval-set.jsonl');
  await fs.appendFile(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
}

/**
 * 反馈执行 agent 的动作审计（feedback-actions.jsonl）。
 * ★ 与 eval-set.jsonl 的边界 ★：eval-set 是「她本人的判断」金标准（EvalSource 闭集），
 * agent 的改动只进这里——两边永远不混，评测基线不被机器动作污染。
 */
export interface FeedbackActionRow {
  at: string;
  op: string;
  doc: string;
  headingId?: string;
  target: unknown;
  reason: string;
  basedOn: unknown;
  before?: unknown;
  result: 'applied' | 'skipped' | 'rejected';
  rejectedWhy?: string;
}

export async function appendFeedbackActions(rows: FeedbackActionRow[]): Promise<void> {
  if (!rows.length) return;
  const root = await requireVaultRoot();
  const file = path.join(root, DATA_DIR_NAME, 'feedback-actions.jsonl');
  await fs.appendFile(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

export interface FeedbackDigest {
  total: number;
  up: number;
  down: number;
  dup: number;
  file: string;
}

/** 扫全库，重写 `notes/.notebook/feedback.md`。 */
export async function writeFeedbackDigest(): Promise<FeedbackDigest> {
  const all = await listAllSidecars();
  const buckets: Record<FeedbackMark, string[]> = { up: [], down: [], dup: [] };

  for (const { docRel, sidecar } of all) {
    for (const s of sidecar.cheatsheet?.sections ?? []) {
      const push = (kind: string, text: string, fb?: { mark: FeedbackMark; why?: string; at?: string }) => {
        if (!fb) return;
        const line = `- [${kind}] ${text.slice(0, 90)}  \n    ﹙${docRel} · ${s.headingText} · ${itemKeyOf(text)}﹚`;
        buckets[fb.mark].push(fb.why ? `${line}\n  - 理由：${fb.why}` : line);
      };
      // ★ 知识树层的标注别漏——「digest 必须全数」的教训（漏术语层曾差 4 倍）★
      const tree = s.tree;
      if (tree) {
        for (const nd of tree.nodes ?? []) {
          push('树节点', nd.essence ?? '', nd.feedback);
          for (const d of nd.details ?? []) push(`树·${d.kind}`, d.text ?? '', d.feedback);
        }
      }
      const items = s.items;
      if (!items) continue;
      for (const p of items.propositions ?? []) push('命题', p.statement ?? '', p.feedback);
      for (const e of items.entries ?? []) push(e.kind, e.text ?? '', e.feedback);
      // ★ 术语层别漏——2026-09-19 实测它占 55/222，漏了 digest 就比真实少一个量级的四分之一
      for (const t of items.terms ?? []) push('术语', `${(t.term ?? '').trim()}：${(t.meaning ?? '').trim()}`, t.feedback);
    }
  }

  const n = (k: FeedbackMark) => buckets[k].length;
  const total = n('up') + n('down') + n('dup');
  const lines: string[] = [
    '# 小抄偏好标注',
    '',
    `> 自动生成，每次标注后重写。共 ${total} 条判断（有用 ${n('up')} · 反馈 ${n('down')} · 重复 ${n('dup')}）。`,
    '> 这是系统里唯一「人的判断」的载体 —— 提示词和去重阈值的对齐基准。',
    '',
  ];
  for (const k of ['up', 'down', 'dup'] as FeedbackMark[]) {
    if (!buckets[k].length) continue;
    lines.push(`## ${MARK_LABEL[k]}（${buckets[k].length}）`, '', ...buckets[k], '');
  }

  const root = await requireVaultRoot();
  const file = path.join(root, DATA_DIR_NAME, 'feedback.md');
  await fs.writeFile(file, lines.join('\n'), 'utf8');
  return { total, up: n('up'), down: n('down'), dup: n('dup'), file };
}
