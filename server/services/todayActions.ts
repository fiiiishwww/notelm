/**
 * 今天的统一行动清单（2026-10-11，学习流程重构 S2a）。
 *
 * ★ 解决什么问题 ★
 *   今天栏此前有三套互不通气的口径：
 *     ① 考频行（/frequency/top，节级、面经标注派生）
 *     ② 小笔计划（/review/plan，覆盖式、三型混排）
 *     ③ SM-2 到期（/review/queue，StudyPanel 的「今日到期」）
 *   三个数字可能互相矛盾（「复习·今天的都过完了」但 SM-2 还有到期卡），
 *   每行为什么在那全藏在 tooltip 里。这里把三个口径合并成**一份行动清单**：
 *   一行 = 今天值得动手的一件事，reasons 结构化地写清它为什么在。
 *
 * ★ 合并规则 ★
 *   - 同一张卡既是 SM-2 到期又在计划里 → 一条 row，两个 reasons（cardId 精确合并）
 *   - 计划的 qa/blank 条目与某张到期卡同概念 → 并进那条卡（conceptKey 二次合并）
 *   - 考频节已被复习行覆盖 → 仍保留（阅读素材与动手复习是两回事）但排最后
 */
import { listAllSidecars, updateSidecar } from './sidecar';
import { readTodayPlan, readLastPlan, type ReviewPlan } from './reviewPlan';
import { dueQueue, isDue, schedule } from './sm2';
import { computeSectionFrequency, topSections } from './sectionFrequency';
import { quizPickForItems } from './conceptMaterial';
import { localDate } from '../../shared/text';
import type { Card } from '../../shared/text';

export type ReasonSource = 'sm2' | 'plan' | 'freq' | 'mistake';

export interface ActionRow {
  id: string;
  /** 与 ReviewKind 对齐（card/blank/qa）+ jump（考频阅读行） */
  kind: 'card' | 'blank' | 'qa' | 'jump';
  title: string;
  /** 一句话理由，常驻 UI（不再藏 tooltip） */
  why: string;
  reasons: { source: ReasonSource; detail: string }[];
  conceptKey?: string;
  doc?: string;
  headingId?: string;
  cardId?: string;
  planItemId?: string;
  /** 0=错题+到期 > 1=到期 > 2=仅计划 > 3=考频阅读 */
  priority: number;
  action: 'open-reviewer' | 'open-plan-item' | 'jump-section';
}

const clip = (s: string, n: number): string => (s.length <= n ? s : s.slice(0, n) + '…');

/** 理由文案：mistake 永远最先说 → 来源 → 考频；单理由直接说，多理由「；」连接，≤40 字。 */
export function whyText(row: ActionRow): string {
  const parts: string[] = [];
  const by = new Map(row.reasons.map((r) => [r.source, r.detail]));
  const mistake = by.get('mistake');
  const sm2 = by.get('sm2');
  const plan = by.get('plan');
  const freq = by.get('freq');
  if (mistake) parts.push(mistake);
  else if (sm2) parts.push(sm2);
  if (plan && parts.length < 2) parts.push(plan);
  if (freq && parts.length < 2) parts.push(freq);
  let text = parts.join('；');
  if (row.action === 'jump-section' && !text) text = '这节考频高，读一遍原文';
  if (text.length > 40) text = clip(text, 40);
  return text;
}

interface Collected {
  rows: ActionRow[];
  meta: {
    date: string;
    hasPlan: boolean;
    planRationale: string | null;
    dueCount: number;
    planCount: number;
    mergedByCard: number;
    mergedByConcept: number;
  };
}

export async function collectTodayActions(): Promise<Collected> {
  const today = localDate();
  const all = await listAllSidecars();

  // ── 全库卡片（带 docPath） ──
  const allCards: (Card & { docPath: string })[] = [];
  for (const { docRel, sidecar } of all) {
    for (const c of sidecar.cards ?? []) allCards.push({ ...c, docPath: docRel });
  }

  // ── 口径①：SM-2 到期 ──
  const due = dueQueue(allCards, today) as (Card & { docPath: string })[];
  const dueById = new Map(due.map((c) => [c.id, c]));

  // ── 口径②：计划（今天优先，没有就取最近一份） ──
  const plan: ReviewPlan | null = (await readTodayPlan()) ?? (await readLastPlan());

  // ── 口径③：考频 ──
  const freq = await computeSectionFrequency({ force: false });
  const freqBySection = new Map(freq.sections.map((s) => [`${s.rel}#${s.headingId}`, s]));

  const rows: ActionRow[] = [];
  let mergedByCard = 0;
  let mergedByConcept = 0;
  const coveredConcepts = new Set<string>();

  // 考频理由：卡所在节有面经标注就带一条（读原文的同时知道这节常考）
  const freqReasonOf = (doc: string, headingId: string): { source: ReasonSource; detail: string } | null => {
    const s = freqBySection.get(`${doc}#${headingId}`);
    return s && s.marks > 0 ? { source: 'freq', detail: `这节被问过 ${s.marks} 次` } : null;
  };

  // ── 第一层：到期卡 ──
  for (const c of due) {
    const reasons: ActionRow['reasons'] = [];
    if ((c.sm2.lapses ?? 0) > 0) {
      reasons.push({ source: 'mistake', detail: `忘了 ${c.sm2.lapses} 次的卡，今天到期` });
    } else {
      reasons.push({ source: 'sm2', detail: c.sm2.dueAt < today ? `${c.sm2.dueAt} 该复习的卡` : '今天到期的卡' });
    }
    const fr = freqReasonOf(c.docPath, c.headingId);
    if (fr) reasons.push(fr);
    rows.push({
      id: `card-${c.id}`,
      kind: 'card',
      title: clip(c.front, 60),
      why: '',
      reasons,
      conceptKey: c.conceptKey ?? undefined,
      doc: c.docPath,
      headingId: c.headingId,
      cardId: c.id,
      priority: (c.sm2.lapses ?? 0) > 0 ? 0 : 1,
      action: 'open-reviewer',
    });
    if (c.conceptKey) coveredConcepts.add(c.conceptKey);
  }

  // ── 第二层：计划条目（cardId 合并 / conceptKey 合并 / 新条目） ──
  const planQuizPick = plan?.items.length ? await quizPickForItems(plan.items, all) : {};
  for (const it of plan?.items ?? []) {
    if (it.result) continue; // 已作答的不再出现在行动清单
    if (it.kind === 'card' && it.cardId) {
      const hit = rows.find((r) => r.cardId === it.cardId);
      if (hit) {
        hit.reasons.push({ source: 'plan', detail: '小笔也把它排进了今天' });
        hit.planItemId = it.id;
        hit.priority = Math.min(hit.priority, 0);
        mergedByCard++;
        continue;
      }
      // 计划里有这张卡但已不在到期队列（今天刚复习过或被改期）→ 仍按计划列出
      const card = allCards.find((x) => x.id === it.cardId);
      if (!card) continue;
      rows.push({
        id: `card-${card.id}`,
        kind: 'card',
        title: clip(card.front, 60),
        why: '',
        reasons: [{ source: 'plan', detail: '小笔排进今天的卡' }],
        conceptKey: card.conceptKey ?? undefined,
        doc: card.docPath,
        headingId: card.headingId,
        cardId: card.id,
        planItemId: it.id,
        priority: 2,
        action: 'open-reviewer',
      });
      if (card.conceptKey) coveredConcepts.add(card.conceptKey);
      continue;
    }
    // blank/qa：与同概念的到期卡合并；没有就自立一条
    if (it.conceptKey && coveredConcepts.has(it.conceptKey)) {
      const hit = rows.find((r) => r.conceptKey === it.conceptKey);
      if (hit) {
        hit.reasons.push({ source: 'plan', detail: '小笔也把它排进了今天' });
        hit.planItemId = it.id;
        mergedByConcept++;
        continue;
      }
    }
    const pick = planQuizPick[it.id];
    const title = clip(it.question || pick?.question?.stem || it.conceptKey || it.why, 60);
    rows.push({
      id: `plan-${it.id}`,
      kind: it.kind,
      title,
      why: '',
      reasons: [{ source: 'plan', detail: '小笔排进今天的一条' }],
      conceptKey: it.conceptKey ?? undefined,
      doc: it.doc,
      headingId: it.headingId,
      planItemId: it.id,
      priority: 2,
      action: it.kind === 'card' ? 'open-reviewer' : 'open-plan-item',
    });
  }

  // ── 第三层：考频节（阅读素材；已被复习行覆盖的标注后排最后） ──
  const top = await topSections(6, freq);
  for (const s of top) {
    const covered = rows.some((r) => r.headingId === s.headingId && r.action !== 'jump-section');
    rows.push({
      id: `jump-${s.rel}-${s.headingId}`,
      kind: 'jump',
      title: clip(s.headingText || s.headingId, 60),
      why: '',
      reasons: [
        { source: 'freq', detail: covered ? `正在复习清单里（这节被问过 ${s.marks} 次），读的同时顺便` : `这节被问过 ${s.marks} 次` },
      ],
      doc: s.rel,
      headingId: s.headingId,
      priority: 3,
      action: 'jump-section',
    });
  }

  // ── 排序：priority 升序；同级内到期日/EF 升序（难的先出） ──
  rows.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    const ea = a.cardId ? allCards.find((x) => x.id === a.cardId)?.sm2.ef ?? 2.5 : 2.5;
    const eb = b.cardId ? allCards.find((x) => x.id === b.cardId)?.sm2.ef ?? 2.5 : 2.5;
    return ea - eb;
  });
  for (const r of rows) r.why = whyText(r);

  // 到期但被挂起的卡也数一下（口径一致性：dueCount 用 isDue 判，含挂起与否见 sm2.isDue——挂起不算到期）
  const dueCount = allCards.filter((c) => isDue(c, today)).length;

  return {
    rows,
    meta: {
      date: today,
      hasPlan: plan != null,
      planRationale: plan?.rationale ?? null,
      dueCount,
      planCount: plan?.items.filter((x) => !x.result).length ?? 0,
      mergedByCard,
      mergedByConcept,
    },
  };
}

// ───────────────────── verdict 写回 SM-2（S2b，开关默认关） ─────────────────────

/**
 * 计划作答写回卡片 SM-2 状态。
 *
 * ★ 为什么要有这一步 ★
 *   此前 plan 的 verdict 与 Card.sm2 完全不通气——在计划里答错的卡，
 *   SM-2 队列毫无察觉，第二天照旧不排它。三口径不通气的根因之一。
 *
 * ★ 边界（刻意保守）★
 *   - 开关 NB_PLAN_SM2_WRITE=1 才生效，默认关（关闭时逐字节不变，铁律）；
 *   - 只写回 again/wrong（答错才改期）——答对/答对的灰度让 /review 正常打分路径管，
 *     这里不做第二套「答对也推进」的写法，避免与 Reviewer 的直接打分双写；
 *   - 只动 item.cardId 指到的卡；qa/blank 没挂卡的概念级条目不写（没有 SM-2 状态可写）。
 *
 * @returns 实际是否写回（探针对账用）
 */
export async function applyVerdictToSm2(
  plan: ReviewPlan,
  itemId: string,
  verdict: string,
): Promise<{ written: boolean; cardId?: string; doc?: string; dueAt?: string; reason?: string }> {
  if (process.env.NB_PLAN_SM2_WRITE !== '1') {
    return { written: false, reason: '开关 NB_PLAN_SM2_WRITE 未开' };
  }
  if (verdict !== 'again' && verdict !== 'wrong') {
    return { written: false, reason: `verdict=${verdict} 不写回（只写 again/wrong）` };
  }
  const item = plan.items.find((x) => x.id === itemId);
  if (!item?.cardId) return { written: false, reason: '该条没有 cardId（概念级条目无 SM-2 状态）' };
  const all = await listAllSidecars();
  const hit = all.find(({ sidecar }) => (sidecar.cards ?? []).some((c) => c.id === item.cardId));
  if (!hit) return { written: false, reason: `找不到 cardId=${item.cardId} 所在文档` };
  let dueAt = '';
  await updateSidecar(hit.docRel, (s) => {
    const c = s.cards.find((x) => x.id === item.cardId);
    if (!c) throw new Error(`sidecar 里没有 cardId=${item.cardId}`);
    c.sm2 = schedule(c.sm2, 'forgot');
    dueAt = c.sm2.dueAt;
    return { card: c };
  });
  return { written: true, cardId: item.cardId, doc: hit.docRel, dueAt };
}
