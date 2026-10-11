/**
 * 概念 → 学习资产聚合（2026-10-11，学习流程重构 S1b）。
 *
 * ★ 解决什么问题 ★
 *   用户给一个概念，要**一次拿全**它相关的所有学习资产：知识树节点细节、
 *   该节全部测验题、面经/思考题题库命中题、全部挂卡（含 SM-2 状态）、掌握状态。
 *   之前这条链要 agent 走 5+ 步（concepts → cheatsheet×N → flashcard_pool），
 *   且树内容根本读不到（cheatsheet 工具把树压成计数）、测验题完全没有工具。
 *
 * ★ 分层：检索层全量，上下文层清单 ★（「量要大（后面才能合理地控制大小）」的落地）
 *   - collectConceptAssets 组装**全量** bundle，不做业务裁剪（调用方负责落盘留档）；
 *   - toManifest 把全量压成「计数 + 全量 id/标题清单」给模型上下文——
 *     id 行很短，几百条也在溢出阈值内；明细（front/back/answer/explain/quote）
 *     一律不进清单，由调用方按 view+offset/limit 分页取。
 *   - 缺口不藏：哪类资产命中 0 条，gaps 数组如实写明，UI 和 agent 都不许假装完整。
 */
import { listAllSidecars } from './sidecar';
import { conceptByKey, conceptKeyOf, searchConcepts, type Concept } from './concepts';
import { loadLearning, strugglingTop } from './learning';
import { computeSectionFrequency, type SectionFrequency } from './sectionFrequency';
import { scanQuestionPool, type PoolQuestion } from './questionPool';
import type { KNode, Quiz, Sm2State } from '../../shared/text';

export type ResolveVia = 'exact-key' | 'alias' | 'fuzzy-search' | 'not-found';

export interface ConceptAssetBundle {
  concept: {
    key: string;
    name: string;
    aliases: string[];
    sourcesTotal: number;
    sources: { docRel: string; headingId: string; headingText: string; bi?: number }[];
    resolvedVia: ResolveVia;
  };
  /** 概念 sources 命中的节 → 树节点（全量，essence + details 不裁剪） */
  tree: {
    docRel: string;
    headingId: string;
    headingText: string;
    node: KNode;
    /** 该节树共几个节点（给规模感） */
    siblingsCount: number;
  }[];
  /** 概念命中节上的现有测验，题全量 */
  quizzes: {
    docRel: string;
    headingId: string;
    headingText: string;
    total: number;
    questions: Quiz['questions'];
  }[];
  /** 面经/思考题题库命中题（节级定位，粒度诚实标注） */
  pool: {
    id: string;
    kind: PoolQuestion['kind'];
    q: string;
    comps: string[];
    topic: string;
    rel: string;
    stars?: number;
    matchedVia: 'section-vote';
  }[];
  /** conceptKey 精确挂卡（明细层全量不截断） */
  cards: {
    id: string;
    doc: string;
    headingId: string;
    front: string;
    back: string;
    suspended: boolean;
    sm2: Sm2State;
  }[];
  /** learning.json 里该概念的掌握状态（M2） */
  learning: {
    name: string;
    marks: { up: number; down: number };
    cardStats: { total: number; lapses: number; fbUp: number; fbDown: number };
    struggling: boolean;
  } | null;
  counts: { treeNodes: number; quizQuestions: number; poolQuestions: number; cards: number };
  gaps: string[];
}

// ─────────────────────────── 概念解析（三级 fallback） ───────────────────────────

export async function resolveConcept(
  q: string,
): Promise<{ concept: Concept; resolvedVia: ResolveVia } | null> {
  const key = conceptKeyOf(q);
  if (!key) return null;
  const exact = await conceptByKey(key).catch(() => null);
  if (exact) return { concept: exact, resolvedVia: 'exact-key' };
  const fuzzy = await searchConcepts(q, 1);
  if (fuzzy.length) return { concept: fuzzy[0], resolvedVia: 'fuzzy-search' };
  return null;
}

// ─────────────────────────── 面经题按节取回 ───────────────────────────

/**
 * 节 → 题库命中题。
 *
 * ★ 定位链路（现有数据粒度，不新增标注）★
 *   questionPool 按格式抽题 → sectionFrequency 用 embedding 投票把题落到节（headingId）。
 *   投票映射原本只活在 computeSectionFrequency 内部，这里把它随缓存一起落盘，
 *   旧缓存没有 votes 字段时 force 重算一次。
 *   ★ 节级粒度的假阳性要诚实：同一节的概念共享命中题，调用方必须标 matchedVia。
 */
async function poolBySections(): Promise<{
  bySection: Map<string, PoolQuestion[]>;
  freq: SectionFrequency;
}> {
  const freq = await computeSectionFrequency();
  let votes = (freq as SectionFrequency & { votes?: Record<string, string[]> }).votes;
  let effective = freq;
  if (!votes) {
    effective = await computeSectionFrequency({ force: true });
    votes = (effective as SectionFrequency & { votes?: Record<string, string[]> }).votes;
  }
  const { questions } = await scanQuestionPool({ root: await import('../core').then((m) => m.requireVaultRoot()) });
  const byId = new Map(questions.map((q) => [q.id, q]));
  const bySection = new Map<string, PoolQuestion[]>();
  for (const [k, ids] of Object.entries(votes ?? {})) {
    const qs = ids.map((id) => byId.get(id)).filter((q): q is PoolQuestion => q != null);
    if (qs.length) bySection.set(k, qs);
  }
  return { bySection, freq: effective };
}

// ─────────────────────────── 聚合 ───────────────────────────

export async function collectConceptAssets(
  q: string,
  opts: {
    includeTree?: boolean;
    includeQuiz?: boolean;
    includePool?: boolean;
    includeCards?: boolean;
  } = {},
): Promise<ConceptAssetBundle> {
  const include = {
    tree: opts.includeTree !== false,
    quiz: opts.includeQuiz !== false,
    pool: opts.includePool !== false,
    cards: opts.includeCards !== false,
  };

  const resolved = await resolveConcept(q);
  if (!resolved) {
    return {
      concept: { key: conceptKeyOf(q), name: q, aliases: [], sourcesTotal: 0, sources: [], resolvedVia: 'not-found' },
      tree: [],
      quizzes: [],
      pool: [],
      cards: [],
      learning: null,
      counts: { treeNodes: 0, quizQuestions: 0, poolQuestions: 0, cards: 0 },
      gaps: [`概念库里找不到「${q}」——先确认名字，或用 concepts 工具模糊搜`],
    };
  }
  const { concept, resolvedVia } = resolved;

  const all = await listAllSidecars();

  // ── 树节点 + 测验：concept.sources 全量（不 slice(0,3)，聚合场景要全） ──
  const tree: ConceptAssetBundle['tree'] = [];
  const quizzes: ConceptAssetBundle['quizzes'] = [];
  const sectionKeys = new Set<string>();
  for (const src of concept.sources) {
    sectionKeys.add(`${src.docRel.replace(/\.md$/, '')}#${src.headingId}`);
    const hit = all.find((x) => x.docRel === src.docRel);
    if (!hit) continue;
    const sec = hit.sidecar.cheatsheet?.sections?.find((x) => x.headingId === src.headingId);
    if (include.tree && sec?.tree) {
      const node = sec.tree.nodes?.find((n) => n.name === concept.name);
      if (node) {
        tree.push({
          docRel: src.docRel,
          headingId: src.headingId,
          headingText: src.headingText,
          node,
          siblingsCount: sec.tree.nodes?.length ?? 0,
        });
      }
    }
    if (include.quiz) {
      const quiz = hit.sidecar.quizzes?.find((q2) => q2.headingId === src.headingId);
      if (quiz && (quiz.questions ?? []).length) {
        quizzes.push({
          docRel: src.docRel,
          headingId: src.headingId,
          headingText: quiz.headingText ?? src.headingText,
          total: quiz.questions.length,
          questions: quiz.questions,
        });
      }
    }
  }

  // ── 面经/思考题题库（节级投票定位） ──
  const pool: ConceptAssetBundle['pool'] = [];
  if (include.pool) {
    const { bySection } = await poolBySections();
    for (const k of sectionKeys) {
      for (const q2 of bySection.get(k) ?? []) {
        pool.push({
          id: q2.id,
          kind: q2.kind,
          q: q2.q,
          comps: q2.comps,
          topic: q2.topic,
          rel: q2.rel,
          ...(q2.stars != null ? { stars: q2.stars } : {}),
          matchedVia: 'section-vote',
        });
      }
    }
  }

  // ── 挂卡（conceptKey 精确匹配；与 flashcard_pool 的子串匹配不同，这里只认精确挂靠） ──
  const cards: ConceptAssetBundle['cards'] = [];
  if (include.cards) {
    for (const { docRel, sidecar } of all) {
      for (const c of sidecar.cards ?? []) {
        if (c.conceptKey !== concept.key) continue;
        cards.push({
          id: c.id,
          doc: docRel.replace(/\.md$/, ''),
          headingId: c.headingId,
          front: c.front,
          back: c.back,
          suspended: c.suspended,
          sm2: c.sm2,
        });
      }
    }
  }

  // ── 掌握状态（M2 learning.json） ──
  let learning: ConceptAssetBundle['learning'] = null;
  const store = await loadLearning();
  const entry = store.entries.find((e) => e.key === concept.key);
  if (entry) {
    const struggling = strugglingTop(store, 12).some((t) => t.key === concept.key);
    learning = {
      name: entry.name,
      marks: { up: entry.state.marks.up, down: entry.state.marks.down },
      cardStats: {
        total: entry.state.cardStats.total,
        lapses: entry.state.cardStats.lapses,
        fbUp: entry.state.cardStats.fbUp,
        fbDown: entry.state.cardStats.fbDown,
      },
      struggling,
    };
  }

  const counts = {
    treeNodes: tree.length,
    quizQuestions: quizzes.reduce((n, x) => n + x.total, 0),
    poolQuestions: pool.length,
    cards: cards.length,
  };

  // ── 缺口诚实呈现 ★ 不假装完整 ★ ──
  const gaps: string[] = [];
  if (!counts.treeNodes) gaps.push('概念库的树节点里没有命中（该节可能还没生成知识树，或树里没有同名节点）');
  if (!counts.quizQuestions) gaps.push('命中节没有出过测验（要用题得先在界面/管线里为那一节出题，或用面经题库的题）');
  if (!counts.poolQuestions) gaps.push('面经/思考题题库没有命中这个概念所在的节（节级投票粒度，同节的其他概念可能命中）');
  if (!counts.cards) gaps.push('没有卡挂到这个概念（cardMigration 全库 200 卡只挂 80——多半要重跑那一节的「转闪卡」）');
  if (!learning) gaps.push('learning.json 里还没有这个概念的掌握记录（没标注过、没复习过）');

  return {
    concept: {
      key: concept.key,
      name: concept.name,
      aliases: concept.aliases,
      sourcesTotal: concept.sources.length,
      sources: concept.sources,
      resolvedVia,
    },
    tree,
    quizzes,
    pool,
    cards,
    learning,
    counts,
    gaps,
  };
}

// ─────────────────────────── 清单层（进模型上下文的形态） ───────────────────────────

/**
 * 全量 bundle → 「计数 + 全量 id/标题清单」。
 *
 * ★ front/back/answer/explain/quote 一律不进清单 ★ —— 那些是明细层的货，
 *   上下文里只留「有什么、叫什么 id、状态如何」，按需分页取。
 *   设计目标：常见概念 ≤2700 字符（spill 阈值），不触发溢出。
 */
export function toManifest(b: ConceptAssetBundle): Record<string, unknown> {
  const clip = (s: string, n: number): string => (s.length <= n ? s : s.slice(0, n) + '…');
  return {
    concept: {
      key: b.concept.key,
      name: b.concept.name,
      aliases: b.concept.aliases,
      resolvedVia: b.concept.resolvedVia,
      sources: b.concept.sources.map((s) => `${s.docRel}#${s.headingId}${s.bi != null ? `@bi${s.bi}` : ''}`),
    },
    counts: b.counts,
    tree: b.tree.map((t) => ({
      doc: t.docRel.replace(/\.md$/, ''),
      headingId: t.headingId,
      node: t.node.name,
      kind: t.node.kind,
      essence: clip(t.node.essence ?? '', 60),
      detailsCount: t.node.details?.length ?? 0,
    })),
    quiz: b.quizzes.map((q) => ({
      doc: q.docRel.replace(/\.md$/, ''),
      headingId: q.headingId,
      from: q.headingText,
      total: q.total,
      questionIds: q.questions.map((x) => x.id),
      stems: q.questions.map((x) => clip(x.stem, 40)),
    })),
    pool: b.pool.map((p) => ({ id: p.id, kind: p.kind, q: clip(p.q, 40), comps: p.comps.length })),
    cards: b.cards.map((c) => ({
      id: c.id,
      front: clip(c.front, 40),
      dueAt: c.sm2.dueAt,
      lapses: c.sm2.lapses ?? 0,
      suspended: c.suspended,
    })),
    learning: b.learning,
    gaps: b.gaps,
    note: '★ 明细用同工具换 view=tree/quiz/pool/cards + offset/limit 分页取；全量 JSON 已落盘（见 spillPath）。',
  };
}
