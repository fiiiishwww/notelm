/**
 * server/services/learning.ts —— M2 学习者状态（B3，2026-09-22）。
 *
 * ★ 它是什么 ★
 *   把散落在全库 sidecar 里的学习信号（▲▽标注、闪卡评分、高亮、批注）
 *   按 conceptKey 聚合成 `notes/.notebook/learning.json`——
 *   回答「她学到哪了、哪里卡住了」的唯一数据源。
 *
 * ★ 铁律 ★
 *   - **绝不写进 concepts.json**：派生（learning.json 可全量重建、幂等）
 *     与事实源（concepts.json 的证据集）分离。
 *   - **只读聚合**：本模块不改任何 sidecar 数据，除了 migrateCardConcepts
 *     往 Card 上补挂 conceptKey（可重算的派生字段，只补挂不摘除）。
 *   - **零模型调用**：原料全是现成的标注/评分/高亮。
 *
 * ★ 归属判据（evidence.match，可审计）★
 *   信号（标注/高亮）落在某个块上，要回答「这算哪个知识点」：
 *     - 'node'    块号精确命中某树节点（或该节点细节条的 bi）→ 归该节点，零误差；
 *     - 'quote'   quote 与节点 essence/细节引文 dice ≥ 0.5 → 归该节点；
 *     - 'section' 同节兜底：该节所有概念都记一笔（scope 级，宁多勿漏，
 *                 证据里带 scope 标记，下游想严格就只取 node/quote）。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR_NAME, requireVaultRoot } from '../core';
import { listAllSidecars, updateSidecar } from './sidecar';
import { loadConcepts, conceptKeyOf, type ConceptStore } from './concepts';
import { dice, type Card, type Feedback } from '../../shared/text';

// ─────────────────────────── 数据结构 ───────────────────────────

export type EvidenceKind = 'mark' | 'card' | 'highlight' | 'note';
export type MatchKind = 'node' | 'quote' | 'section';

export interface LearningEvidence {
  kind: EvidenceKind;
  docRel: string;
  headingId: string;
  bi?: number;
  quote?: string;
  at?: string;
  /** mark 时的判定：up/down/dup */
  mark?: Feedback['mark'];
  /** mark 时的补充理由（目前只有闪卡 ▽ 反馈会填） */
  why?: string;
  match: MatchKind;
  /** 概念名（冗余存一份，learning.json 单独读时不用回查概念库） */
  name: string;
}

export interface ConceptState {
  marks: { up: number; down: number; dup: number };
  cardStats: { total: number; lapses: number; bestEf: number; fbUp: number; fbDown: number; fbDup: number };
  highlight: { count: number; lastAt: string | null };
  noteCount: number;
  lastTouchedAt: string | null;
}

export interface LearningEntry {
  key: string;
  name: string;
  state: ConceptState;
  evidence: LearningEvidence[];
}

export interface LearningStore {
  version: 1;
  rebuiltAt: string;
  /** 迁移覆盖情况（卡片挂上 conceptKey 的比例） */
  cardMigration: { total: number; linked: number };
  entries: LearningEntry[];
  /** 挂不上任何概念的卡的反馈（如开篇元描述卡）——概念级装不下，但信号不能丢 */
  unlinkedCardFb: UnlinkedCardFb[];
}

export interface UnlinkedCardFb {
  docRel: string;
  headingId: string;
  front: string;
  mark: 'up' | 'down' | 'dup';
  why?: string;
}

const FILE = 'learning.json';

const learningPath = async (): Promise<string> =>
  path.join(await requireVaultRoot(), DATA_DIR_NAME, FILE);

// ─────────────────────────── 归属索引 ───────────────────────────

interface NodeRef {
  key: string;
  name: string;
  bi?: number;
  essence: string;
  detailBis: number[];
  detailQuotes: string[];
}

interface SectionIndex {
  docRel: string;
  headingId: string;
  nodes: NodeRef[];
}

interface Attribution {
  index: SectionIndex[];
  /** (docRel, headingId) → nodes */
  bySection: Map<string, NodeRef[]>;
}

async function buildAttribution(): Promise<Attribution> {
  const all = await listAllSidecars();
  const index: SectionIndex[] = [];
  for (const { docRel, sidecar } of all) {
    for (const s of sidecar.cheatsheet?.sections ?? []) {
      const tree = s.tree;
      if (!tree?.nodes?.length) continue;
      const nodes: NodeRef[] = tree.nodes.map((n) => ({
        key: conceptKeyOf(n.name),
        name: n.name,
        ...(n.bi != null ? { bi: n.bi } : {}),
        essence: n.essence ?? '',
        detailBis: (n.details ?? []).map((d) => d.bi).filter((b): b is number => b != null),
        detailQuotes: (n.details ?? []).map((d) => d.quote ?? '').filter(Boolean),
      }));
      index.push({ docRel, headingId: s.headingId, nodes });
    }
  }
  const bySection = new Map<string, NodeRef[]>();
  for (const sec of index) bySection.set(`${sec.docRel}\u0000${sec.headingId}`, sec.nodes);
  return { index, bySection };
}

/**
 * 把「落在某文档某节某块的一个信号」归到知识点。
 * 归属判据见文件头。返回空数组 = 该节没有树（没法归，宁缺毋滥）。
 */
function attribute(
  at: Attribution,
  docRel: string,
  headingId: string,
  bi: number | undefined,
  quote: string | undefined,
): { node: NodeRef; match: MatchKind }[] {
  const nodes = at.bySection.get(`${docRel}\u0000${headingId}`);
  if (!nodes?.length) return [];

  // 1) 块号精确命中：节点本体 bi 或细节条 bi
  if (bi != null) {
    const exact = nodes.filter((n) => n.bi === bi || n.detailBis.includes(bi));
    if (exact.length) return exact.map((node) => ({ node, match: 'node' as const }));
  }

  // 2) quote 相似：节点 essence / 细节引文
  if (quote && quote.trim().length >= 4) {
    const q = quote.trim();
    const byQuote: { node: NodeRef; score: number }[] = [];
    for (const n of nodes) {
      let best = 0;
      if (n.essence) best = Math.max(best, dice(q, n.essence));
      for (const dq of n.detailQuotes) best = Math.max(best, dice(q, dq));
      if (best >= 0.5) byQuote.push({ node: n, score: best });
    }
    if (byQuote.length) {
      byQuote.sort((a, b) => b.score - a.score);
      return byQuote.slice(0, 3).map(({ node }) => ({ node, match: 'quote' as const }));
    }
  }

  // 3) 同节兜底（宁多勿漏，scope 级标记）
  return nodes.map((node) => ({ node, match: 'section' as const }));
}

// ─────────────────────────── 主重建 ───────────────────────────

const emptyState = (): ConceptState => ({
  marks: { up: 0, down: 0, dup: 0 },
  cardStats: { total: 0, lapses: 0, bestEf: 0, fbUp: 0, fbDown: 0, fbDup: 0 },
  highlight: { count: 0, lastAt: null },
  noteCount: 0,
  lastTouchedAt: null,
});

const touch = (st: ConceptState, at?: string): void => {
  if (!at) return;
  if (!st.lastTouchedAt || at > st.lastTouchedAt) st.lastTouchedAt = at;
};

export async function rebuildLearning(): Promise<LearningStore> {
  const concepts: ConceptStore = await loadConcepts();
  const nameOf = new Map(concepts.concepts.map((c) => [c.key, c.name]));
  const at = await buildAttribution();
  const all = await listAllSidecars();

  const entries = new Map<string, LearningEntry>();
  const ensure = (key: string, name: string): LearningEntry => {
    let e = entries.get(key);
    if (!e) {
      e = { key, name, state: emptyState(), evidence: [] };
      entries.set(key, e);
    }
    return e;
  };

  const push = (
    node: NodeRef,
    match: MatchKind,
    ev: Omit<LearningEvidence, 'name' | 'match'>,
  ): void => {
    const e = ensure(node.key, node.name);
    e.evidence.push({ ...ev, match, name: node.name });
    if (e.evidence.length > 60) e.evidence.splice(0, e.evidence.length - 60); // 保留最近的
  };

  // 1) ▲▽⧉ 标注：树节点本体 / 细节条 / 旧条目（命题+条目+术语）
  for (const { docRel, sidecar } of all) {
    for (const s of sidecar.cheatsheet?.sections ?? []) {
      const tree = s.tree;
      if (tree?.nodes?.length) {
        for (const n of tree.nodes) {
          const key = conceptKeyOf(n.name);
          if (!key) continue;
          const fb = n.feedback as Feedback | undefined;
          if (fb?.mark) {
            const e = ensure(key, n.name);
            e.state.marks[fb.mark] += 1;
            touch(e.state, fb.at);
            push(
              { key, name: n.name, essence: n.essence ?? '', detailBis: [], detailQuotes: [] },
              'node',
              { kind: 'mark', docRel, headingId: s.headingId, bi: n.bi, quote: n.essence, at: fb.at, mark: fb.mark },
            );
          }
          for (const d of n.details ?? []) {
            const dfb = d.feedback as Feedback | undefined;
            if (!dfb?.mark) continue;
            for (const { node, match } of attribute(at, docRel, s.headingId, d.bi, d.quote)) {
              ensure(node.key, node.name).state.marks[dfb.mark] += 1;
              touch(entries.get(node.key)!.state, dfb.at);
              push(node, match, {
                kind: 'mark', docRel, headingId: s.headingId, bi: d.bi, quote: d.quote, at: dfb.at, mark: dfb.mark,
              });
            }
          }
        }
      }
      const items = s.items;
      if (!items) continue;
      const harvest: { quote?: string; bi?: number; fb?: Feedback }[] = [
        ...(items.propositions ?? []).map((p) => ({ quote: p.quote, bi: p.bi, fb: p.feedback as Feedback | undefined })),
        ...(items.entries ?? []).map((e) => ({ quote: e.quote, bi: e.bi, fb: e.feedback as Feedback | undefined })),
        ...(items.terms ?? []).map((t) => ({ quote: t.quote, bi: undefined, fb: t.feedback as Feedback | undefined })),
      ];
      for (const h of harvest) {
        if (!h.fb?.mark) continue;
        for (const { node, match } of attribute(at, docRel, s.headingId, h.bi, h.quote)) {
          ensure(node.key, node.name).state.marks[h.fb.mark] += 1;
          touch(entries.get(node.key)!.state, h.fb.at);
          push(node, match, {
            kind: 'mark', docRel, headingId: s.headingId, bi: h.bi, quote: h.quote, at: h.fb.at, mark: h.fb.mark,
          });
        }
      }
    }
  }

  // 2) 闪卡：只认挂了 conceptKey 的（迁移负责挂）；挂不上的卡反馈进 unlinked 兜底
  let cardTotal = 0;
  let cardLinked = 0;
  const unlinkedCardFb: UnlinkedCardFb[] = [];
  for (const { docRel, sidecar } of all) {
    for (const c of sidecar.cards ?? []) {
      cardTotal += 1;
      const key = c.conceptKey ? conceptKeyOf(c.conceptKey) : '';
      if (!key || !nameOf.has(key)) {
        // 没挂上概念的卡（quote 与任何节点都够不着，如开篇过渡句）：
        // 无法归属到概念，但她的 ▲▽ 反馈是真实信号，库级记一笔
        if (c.fb && unlinkedCardFb.length < 30) {
          unlinkedCardFb.push({
            docRel,
            headingId: c.headingId,
            front: (c.front ?? '').slice(0, 60),
            mark: c.fb,
            ...(c.fb === 'down' && c.fbWhy ? { why: c.fbWhy.slice(0, 200) } : {}),
          });
        }
        continue;
      }
      cardLinked += 1;
      const e = ensure(key, nameOf.get(key)!);
      e.state.cardStats.total += 1;
      e.state.cardStats.lapses += c.sm2?.lapses ?? 0;
      e.state.cardStats.bestEf = Math.max(e.state.cardStats.bestEf, c.sm2?.ef ?? 0);
      // 闪卡三件套反馈（2026-09-23 新增）：她给卡打的 ▲▽⧉ 与理由
      if (c.fb) e.state.cardStats[c.fb === 'up' ? 'fbUp' : c.fb === 'down' ? 'fbDown' : 'fbDup'] += 1;
      touch(e.state, c.sm2?.lastReviewedAt ?? undefined);
      push(
        { key, name: nameOf.get(key)!, essence: '', detailBis: [], detailQuotes: [] },
        'node',
        {
          kind: 'card', docRel, headingId: c.headingId, quote: c.front,
          at: c.sm2?.lastReviewedAt ?? c.createdAt,
          ...(c.fb ? { mark: c.fb } : {}),
          ...(c.fb === 'down' && c.fbWhy ? { why: c.fbWhy } : {}),
        },
      );
    }
  }

  // 3) 高亮：她在原文哪里停留过。高亮/批注不知道自己属于哪一节，
  //    所以做**全文归属**：块号精确命中 → 引文相似 → 都不中就放弃（宁缺毋滥）。
  for (const { docRel, sidecar } of all) {
    for (const h of sidecar.highlights ?? []) {
      const at2 = h.createdAt ?? undefined;
      for (const { node, match } of attributeDocWide(at, docRel, h.selector?.blockIndex, h.selector?.quote)) {
        const e = ensure(node.key, node.name);
        e.state.highlight.count += 1;
        if (at2 && (!e.state.highlight.lastAt || at2 > e.state.highlight.lastAt)) {
          e.state.highlight.lastAt = at2;
        }
        touch(e.state, at2);
        push(node, match, { kind: 'highlight', docRel, headingId: headingOfDoc(at, docRel, node.key), bi: h.selector?.blockIndex, quote: h.selector?.quote, at: at2 });
      }
    }
  }

  // 4) 批注：有想法 ≈ 有接触
  for (const { docRel, sidecar } of all) {
    for (const n of sidecar.notes ?? []) {
      for (const { node, match } of attributeDocWide(at, docRel, n.selector?.blockIndex, n.selector?.quote)) {
        const e = ensure(node.key, node.name);
        e.state.noteCount += 1;
        touch(e.state, n.createdAt);
        push(node, match, { kind: 'note', docRel, headingId: headingOfDoc(at, docRel, node.key), bi: n.selector?.blockIndex, quote: n.selector?.quote, at: n.createdAt });
      }
    }
  }

  const store: LearningStore = {
    version: 1,
    rebuiltAt: new Date().toISOString(),
    cardMigration: { total: cardTotal, linked: cardLinked },
    unlinkedCardFb,
    entries: [...entries.values()]
      .filter((e) => {
        const st = e.state;
        return (
          st.marks.up + st.marks.down + st.marks.dup > 0 ||
          st.cardStats.total > 0 ||
          st.highlight.count > 0 ||
          st.noteCount > 0
        );
      })
      .sort((a, b) => (b.state.marks.down + b.state.cardStats.lapses) - (a.state.marks.down + a.state.cardStats.lapses)),
  };
  await fs.writeFile(await learningPath(), JSON.stringify(store, null, 2), 'utf8');
  cache = store;
  return store;
}

/**
 * 后台懒重建（防并发）：闪卡打完反馈等写入后调用。
 * learning.json 一旦落盘 loadLearning 就不会再看 sidecar，必须显式刷新；
 * 直接调 rebuildLearning 会在连续打分时并发重入，这里收敛成一趟。
 */
let rebuilding: Promise<unknown> | null = null;
export function refreshLearning(): void {
  if (rebuilding) return;
  rebuilding = rebuildLearning()
    .catch(() => undefined)
    .finally(() => {
      rebuilding = null;
    });
}

/**
 * 落卡后的后台补挂：新卡生成时不知道自己属于哪个知识点（refId 只是节内序号），
 * 靠 migrateCardConcepts 的 quote 相似判据补挂，挂完刷新 learning.json。
 * 单飞防并发（连续生成多节时收敛成一趟）；幂等，只补挂不摘除。
 */
let migrating: Promise<unknown> | null = null;
export function refreshCardMigration(): void {
  if (migrating) return;
  migrating = migrateCardConcepts()
    .catch(() => undefined)
    .then(() => rebuildLearning().catch(() => undefined))
    .finally(() => {
      migrating = null;
    });
}

/** 高亮/批注的**全文归属**：不知道节，就跨全文档的树节点找。
 *  1) 块号精确命中节点/细节条 bi；2) 引文 dice ≥ 0.5；
 *  都不中 → 返回空（不硬塞：一块原文附近可能根本没有被树覆盖）。 */
function attributeDocWide(
  at: Attribution,
  docRel: string,
  bi: number | undefined,
  quote: string | undefined,
): { node: NodeRef; match: MatchKind }[] {
  const docNodes: NodeRef[] = [];
  for (const sec of at.index) {
    if (sec.docRel !== docRel) continue;
    docNodes.push(...sec.nodes);
  }
  if (!docNodes.length) return [];
  if (bi != null) {
    const exact = docNodes.filter((n) => n.bi === bi || n.detailBis.includes(bi));
    if (exact.length) return exact.map((node) => ({ node, match: 'node' as const }));
  }
  if (quote && quote.trim().length >= 4) {
    const q = quote.trim();
    const scored: { node: NodeRef; score: number }[] = [];
    for (const n of docNodes) {
      let best = 0;
      if (n.essence) best = Math.max(best, dice(q, n.essence));
      for (const dq of n.detailQuotes) best = Math.max(best, dice(q, dq));
      if (best >= 0.5) scored.push({ node: n, score: best });
    }
    if (scored.length) {
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, 3).map(({ node }) => ({ node, match: 'quote' as const }));
    }
  }
  return [];
}

/** 证据落盘用的 headingId：找该概念在该文档的首次出处节。 */
function headingOfDoc(at: Attribution, docRel: string, key: string): string {
  for (const sec of at.index) {
    if (sec.docRel !== docRel) continue;
    if (sec.nodes.some((n) => n.key === key)) return sec.headingId;
  }
  return '';
}

// ─────────────────────────── 读取 / 摘要 ───────────────────────────

let cache: LearningStore | null = null;

export async function loadLearning(): Promise<LearningStore> {
  if (cache) return cache;
  try {
    const raw = JSON.parse(await fs.readFile(await learningPath(), 'utf8')) as LearningStore;
    if (raw?.version === 1) {
      cache = raw;
      return raw;
    }
  } catch {
    /* 不存在/损坏 → 重建 */
  }
  return rebuildLearning();
}

/** 「卡住的概念」排序：▽多、lapse 多、最近有接触的排前。给 agent 注入 / learning_status 工具用。 */
export function strugglingTop(store: LearningStore, n = 12) {
  return store.entries
    .map((e) => ({
      key: e.key,
      name: e.name,
      down: e.state.marks.down,
      up: e.state.marks.up,
      lapses: e.state.cardStats.lapses,
      cards: e.state.cardStats.total,
      cardFbDown: e.state.cardStats.fbDown,
      cardFbWhy: e.evidence
        .filter((x) => x.kind === 'card' && x.why)
        .map((x) => x.why as string)
        .slice(-3),
      highlights: e.state.highlight.count,
      notes: e.state.noteCount,
      lastTouchedAt: e.state.lastTouchedAt,
    }))
    .sort(
      (a, b) =>
        b.down + b.cardFbDown + b.lapses * 2 - (a.down + a.cardFbDown + a.lapses * 2) ||
        (b.lastTouchedAt ?? '').localeCompare(a.lastTouchedAt ?? ''),
    )
    .slice(0, n);
}

/** 注入 agent 首轮 context 的学习者状态摘要（紧凑，几行）。 */
export async function learnerBrief(): Promise<string> {
  const store = await loadLearning();
  const top = strugglingTop(store, 8);
  if (!top.length) return '';
  const lines = top.map((t) => {
    const bits: string[] = [];
    if (t.down) bits.push(`▽${t.down}`);
    if (t.up) bits.push(`▲${t.up}`);
    if (t.cardFbDown) bits.push(`卡片反馈▽${t.cardFbDown}`);
    if (t.lapses) bits.push(`遗忘${t.lapses}次`);
    if (t.notes) bits.push(`${t.notes}条批注`);
    return `- ${t.name}（${bits.join(' / ') || '有过接触'}，最近${t.lastTouchedAt ?? '久远'}）`;
  });
  return [
    '学习者状态摘要（learning.json 派生，▲有用 ▽反馈）：',
    ...lines,
    '回答时可参考：▽多或遗忘多的概念她可能还没吃透，解释多铺垫一步；带「卡片反馈」的说明她对相关闪卡本身有意见（理由可调 learning_status 看 cardFbWhy）。',
  ].join('\n');
}

// ─────────────────────────── 树→闪卡迁移 ───────────────────────────

/**
 * 给没挂 conceptKey 的卡片补挂知识点（B3 前置）。
 *
 * 判据（全部程序派生，幂等，只补挂不摘除）：
 *   1. 精确：卡片 source.quote 的原文块号命中树节点/细节条 bi → 归该节点；
 *   2. 相似：quote 与节点 essence / 细节引文 dice ≥ 0.5 → 归该节点；
 *   3. 挂不上的保持 undefined（宁缺毋滥，不硬塞）。
 *
 * 返回迁移统计。重复跑 = 二次确认已挂的不动。
 */
export async function migrateCardConcepts(opts: { dry?: boolean } = {}): Promise<{
  total: number; linked: number; alreadyLinked: number; byMatch: Record<string, number>;
}> {
  const at = await buildAttribution();
  const all = await listAllSidecars();
  const byMatch: Record<string, number> = { node: 0, quote: 0 };
  let total = 0;
  let alreadyLinked = 0;
  let linked = 0;

  for (const { docRel, sidecar } of all) {
    const cards = sidecar.cards ?? [];
    if (!cards.length) continue;
    const pending: { cardId: string; key: string; match: MatchKind }[] = [];
    for (const c of cards) {
      total += 1;
      if (c.conceptKey) {
        alreadyLinked += 1;
        continue;
      }
      // 卡片没有块号，只有 quote + headingId → 先用 quote 相似匹配，再退同节
      const hits = attribute(at, docRel, c.headingId, undefined, c.source?.quote);
      const strict = hits.filter((x) => x.match !== 'section');
      if (!strict.length) continue; // 同节兜底对卡片太滥（一张卡挂五个概念没有意义），不挂
      const best = strict[0];
      pending.push({ cardId: c.id, key: best.node.key, match: best.match });
    }
    if (!pending.length || opts.dry) continue;
    await updateSidecar(docRel, (s) => {
      for (const p of pending) {
        const card = (s.cards ?? []).find((x) => x.id === p.cardId);
        if (card && !card.conceptKey) {
          card.conceptKey = p.key;
          byMatch[p.match] = (byMatch[p.match] ?? 0) + 1;
          linked += 1;
        }
      }
      return null;
    });
  }

  return { total, linked, alreadyLinked, byMatch };
}

/** Card 类型在此文件只作类型用 */
export type { Card };
