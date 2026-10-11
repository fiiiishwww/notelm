/**
 * server/services/reviewPlan.ts —— 今天栏的数据源：小笔排的复习计划。
 *
 * ★ 为什么需要这一层（而不是让前端自己算）★
 *   「今天」现在是 `frequencyTop(6)` 派生出来的——纯展示，没有任何可写的地方。
 *   而她要的是「小笔给我之后，点一下就能开始复习」，也就是：
 *     · 小笔决定今天复习什么、什么顺序、三型怎么配
 *     · 计划要能落盘、能被追问、能对比上一次
 *     · 界面上要能看到「为什么今天是这个」和「改一下」
 *   这些都要求它是**一份数据**，而不是一个函数算出来的结果。
 *
 * ★ 计划的边界（她的原话是「今天栏、闪卡栏」）★
 *   本文件只管「今天复习什么」。闪卡的增删改走已有的 edit_library / 闪卡端点，
 *   这里不重复一套写入路径——两套写入口迟早会对不上。
 *
 * ★ 计划的来源必须可追 ★
 *   每份计划都记 `rationale`（为什么这么排）和 `plannedBy`（'agent' | 'her'），
 *   因为「小笔排的」和「她自己改的」在她眼里是两种东西，混在一起她就失去
 *   对这个栏的信任。计划变更走 append-only 快照，她能看到它怎么一步步变的。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR_NAME, requireVaultRoot, writeFileAtomic } from '../core';

/** 三型混排。填空优先是因为程序能判对错（零成本且无法自欺）。 */
export type ReviewKind = 'card' | 'blank' | 'qa';

export interface ReviewItem {
  /** 计划内的稳定 id（审批与「删掉这一条」要用） */
  id: string;
  kind: ReviewKind;
  /** 给「为什么排它」用的一句话，会显示在计划详情里 */
  why: string;
  /** card 型：卡片 id */
  cardId?: string;
  /** blank / qa 型：概念 key（conceptKeyOf 口径） */
  conceptKey?: string;
  /** blank / qa 型：那一节（取素材用） */
  doc?: string;
  headingId?: string;
  /** blank / qa 型：节点名（在树里定位那一条） */
  nodeName?: string;
  /**
   * 问答型小笔给的题面。
   *
   * ★ 为什么让它随计划落盘，而不是每次现生成 ★
   *   同一份计划要能复现：她今天答的是「什么场景该用混合编排」，
   *   明天再排就变成另一个问题，那「上次哪里没答对」就追不上了。
   */
  question?: string;
  /** 她已作答后的结果（用于「上一轮」与掌握度回写） */
  result?: {
    /** 闪卡是自评；填空是程序判；问答是模型判 */
    verdict: 'again' | 'hard' | 'good' | 'correct' | 'partial' | 'wrong' | 'skipped';
    /** 模型判时给的一句话理由（问答型才有） */
    note?: string;
    at: string;
  };
}

export interface ReviewPlan {
  /** YYYY-MM-DD（本地日期，与 sm2 用同一个 localDate） */
  date: string;
  plannedBy: 'agent' | 'her';
  rationale: string;
  items: ReviewItem[];
  createdAt: string;
  updatedAt: string;
}

export interface PlanStore {
  version: 1;
  /** 当天计划（每天一份，覆盖） */
  current: ReviewPlan | null;
  /** append-only 快照：她能看到计划怎么变的，也能在追问时引用 */
  history: { date: string; plannedBy: string; rationale: string; count: number; at: string }[];
}

const FILE = 'review-plan.json';

function emptyStore(): PlanStore {
  return { version: 1, current: null, history: [] };
}

async function load(): Promise<PlanStore> {
  try {
    const root = await requireVaultRoot();
    const p = join(root, DATA_DIR_NAME, FILE);
    if (!existsSync(p)) return emptyStore();
    const raw = JSON.parse(readFileSync(p, 'utf8')) as PlanStore;
    return raw?.version === 1 ? raw : emptyStore();
  } catch {
    return emptyStore();
  }
}

async function save(store: PlanStore): Promise<void> {
  const root = await requireVaultRoot();
  await writeFileAtomic(join(root, DATA_DIR_NAME, FILE), JSON.stringify(store, null, 2));
}

/** 今天的计划（没有就返回 null，不编一份空的）。 */
export async function readTodayPlan(date?: string): Promise<ReviewPlan | null> {
  const store = await load();
  if (!store.current) return null;
  const d = date ?? today();
  return store.current.date === d ? store.current : null;
}

/** 最近一次计划（不限日期）——她隔几天没复习时也能看到上次排了什么。 */
export async function readLastPlan(): Promise<ReviewPlan | null> {
  return (await load()).current;
}

export interface SavePlanInput {
  date: string;
  plannedBy: 'agent' | 'her';
  rationale: string;
  items: ReviewItem[];
}

/**
 * 写当天计划。
 *
 * ★ 一次覆盖，不做增量合并 ★
 *   小笔重排整天时按增量合并会出现「上一版留下的 + 新加的」这种混合计划，
 *   她追问时就说不清「为什么今天有这条」——每一项都带 why，但要能对上是谁排的。
 */
export async function saveTodayPlan(input: SavePlanInput): Promise<ReviewPlan> {
  const store = await load();
  const now = new Date().toISOString();
  const plan: ReviewPlan = {
    date: input.date,
    plannedBy: input.plannedBy,
    rationale: input.rationale.trim(),
    items: input.items,
    createdAt: store.current?.date === input.date ? store.current.createdAt : now,
    updatedAt: now,
  };
  store.current = plan;
  store.history.push({
    date: plan.date,
    plannedBy: plan.plannedBy,
    rationale: plan.rationale,
    count: plan.items.length,
    at: now,
  });
  // 历史只留最近 30 条：它是为了「看变化」，不是永久审计
  if (store.history.length > 30) store.history = store.history.slice(-30);
  await save(store);
  return plan;
}

/** 在现有计划上改若干项（她手动换题 / agent 现场调整）。找不到的 id 抛给调用方。 */
export async function patchPlan(
  patch: { add?: ReviewItem[]; removeIds?: string[]; rationale?: string },
  opts?: { plannedBy?: 'agent' | 'her' },
): Promise<ReviewPlan> {
  const store = await load();
  const cur = store.current;
  if (!cur) throw new ApiPlanError('还没有今天的计划，先让小笔排一份或新建一份');
  const todayStr = today();
  if (cur.date !== todayStr) {
    throw new ApiPlanError(`计划是 ${cur.date} 的，不是今天的（今天 ${todayStr}）——别把昨天的当成今天的改`);
  }
  const remove = new Set(patch.removeIds ?? []);
  const kept = cur.items.filter((x) => !remove.has(x.id));
  const added = patch.add ?? [];
  return saveTodayPlan({
    date: todayStr,
    plannedBy: opts?.plannedBy ?? cur.plannedBy,
    rationale: patch.rationale?.trim() || cur.rationale,
    items: [...kept, ...added],
  });
}

/** 记一条作答结果（用于掌握度与「上一轮回看」）。 */
export async function recordPlanResult(itemId: string, result: NonNullable<ReviewItem['result']>): Promise<ReviewPlan> {
  const store = await load();
  const cur = store.current;
  if (!cur) throw new ApiPlanError('还没有今天的计划');
  const items = cur.items.map((x) => (x.id === itemId ? { ...x, result } : x));
  if (!items.some((x) => x.id === itemId && x.result)) {
    throw new ApiPlanError(`计划里没有 id=${itemId} 这一条`);
  }
  return saveTodayPlan({ date: cur.date, plannedBy: cur.plannedBy, rationale: cur.rationale, items });
}

export class ApiPlanError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'ApiPlanError';
  }
}

function today(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 生成计划内的稳定 id（不含随机数，便于她复述「第 3 条」时对应上）。 */
export function planItemId(kind: ReviewKind, key: string): string {
  return `${kind}-${key.replace(/[^\w一-龥-]/g, '').slice(-24)}`;
}