/**
 * server/services/conflict.ts —— 矛盾判定的第二层：让模型读一遍，定性。
 *
 * ★ 为什么必须有这一层 ★
 *   graph.ts 里的机械规则只认三类证据：数值不同、上下限对立、反义属性。
 *   实测在 27 篇 / 2673 片的库上，它给出了 2 条候选，两条都不是真矛盾：
 *     一条把「180 tokens/ms」和「30 tokens/s」当成同一个量（分母被丢掉了），
 *     一条把「无需改写上下文」和「需要加载 Skill」当成肯否对立（其实不相干）。
 *   而且它反着漏：真正一句话就能看出来的矛盾（「A 说用 PPO、B 说用 GRPO」）
 *   一个信号也命中不了——因为「互斥」得读懂意思，不是比字符串。
 *
 *   所以分工改成：graph.ts 负责**别漏**（把 2673 片缩成几十对「锁定了同一件事」的候选），
 *   这一层负责**定性**（矛盾 / 补充 / 无关）。候选只有个位数到几十条，
 *   一次判定几百 token，成本可以忽略。
 *
 * ★ 判定结果不落盘成事实 ★
 *   只作为「候选 + 模型的看法」返回给界面，永不写进笔记库。
 *   模型改了、prompt 改了、原文改了，重算即可——跟 graph.ts 一样是派生物。
 */

import { ApiError } from '../core';
import { chatJson, getAiSettings } from './aiClient';
import { buildGraph, findConflicts, type Conflict, type Pair } from './graph';
import { getCorpus } from './related';
import { cosine, readIndex, type IndexChunk, type SearchHit } from './vectorstore';

export type ConflictVerdict = 'contradiction' | 'complement' | 'unrelated' | 'unknown';

export interface JudgedConflict extends Conflict {
  verdict: ConflictVerdict;
  /** 中文，40 字以内：为什么是这个结论 */
  reason: string;
  /** 模型读出来的 A 侧主张 */
  aClaim: string;
  /** 模型读出来的 B 侧主张 */
  bClaim: string;
  /** 判矛盾时：究竟哪一点对不上 */
  conflictAt: string;
}

export interface ConflictReview {
  /** 索引的 builtAt —— 库一改，这份结果就作废 */
  builtAt: string;
  mode: 'semantic' | 'lexical';
  /** 候选池大小、真正送去判定的条数 */
  pool: number;
  judged: number;
  counts: Record<ConflictVerdict, number>;
  items: JudgedConflict[];
  errors: string[];
  stat: { graphMs: number; judgeMs: number; calls: number; ms: number };
  aiConfigured: boolean;
}

const SYSTEM = [
  '你在帮用户校对一份个人知识库。',
  '下面会给你若干「片段对」：每一对来自两个不同的文档，程序已经确认它们讲的是同一个话题（共享了同一个罕见说法）。',
  '你要判断的是——这两段的结论是否互相排斥。',
  '',
  '每一对只能给三种结论之一：',
  '- contradiction：两段在讲同一件事，但结论互斥。你必须能明确指出「A 的哪句话」和「B 的哪句话」对不上（数值不同、上限对下限、一个说必须一个说不用、方向相反等）。',
  '- complement：同一件事的两个侧面，各自补充信息，并不冲突（例如一个讲原理一个讲实现，一个讲优点一个讲注意事项）。',
  '- unrelated：其实不是同一件事。只是碰巧共用了一个词，对象、范围或条件不同。',
  '',
  '判定要求：',
  '1. 拿不准就不要判 contradiction。宁可漏，也不能给用户一个假的警报。',
  '2. 阈值不同不算矛盾（「超过 100 条」对「超过 500 条」是两个场景的阈值）。',
  '3. 单位/量纲不同不算矛盾（每秒对每毫秒，步数对 token 数）。',
  '4. 一个是通用陈述、另一个是特定条件下的特例，不算矛盾。',
  '5. 说的是不同版本、不同型号、不同模型，不算矛盾。',
  '6. reason 用中文，40 字以内，直接说为什么。',
  '7. 判 contradiction 时给出 conflictAt：哪一点对不上，20 字以内。',
].join('\n');

function itemBlock(c: Conflict, id: number): string {
  const side = (label: string, s: Conflict['a']) =>
    `${label}（《${s.docTitle}》› ${s.headingText || '正文'}）：\n"""\n${s.quote}\n"""`;
  return [
    `【第 ${id} 对】`,
    side('A', c.a),
    side('B', c.b),
    `它们共用的说法：${c.shared.join(' | ') || '（未标出）'}`,
  ].join('\n');
}

interface RawVerdict {
  id?: number;
  verdict?: string;
  reason?: string;
  aClaim?: string;
  bClaim?: string;
  conflictAt?: string;
}

const VERDICTS = new Set<string>(['contradiction', 'complement', 'unrelated']);

function normalize(v: string | undefined): ConflictVerdict {
  const s = (v ?? '').trim().toLowerCase();
  if (VERDICTS.has(s)) return s as ConflictVerdict;
  // 模型有时会写成中文
  if (/矛盾|冲突|contradict/i.test(s)) return 'contradiction';
  if (/补充|complement|same/i.test(s)) return 'complement';
  if (/无关|不同|unrelated/i.test(s)) return 'unrelated';
  return 'unknown';
}

/**
 * 分批把候选交给模型判定。
 *
 * 为什么分批而不是一次全塞：条目一多，模型会开始串行、漏项、把 A 类的话安到 C 类上
 * （实测超过 8 对之后 id 对不上号的比例明显上升）。一批 6 对，代价是多几次请求。
 */
export async function judgeConflicts(
  items: Conflict[],
  opts: { batch?: number; signal?: AbortSignal } = {},
): Promise<{ verdicts: JudgedConflict[]; usage: { calls: number; ms: number }; errors: string[] }> {
  const batch = Math.max(1, Math.min(opts.batch ?? 6, 10));
  const t0 = Date.now();
  const out: JudgedConflict[] = [];
  const errors: string[] = [];
  let calls = 0;

  for (let start = 0; start < items.length; start += batch) {
    const slice = items.slice(start, start + batch);
    const body = slice.map((c, i) => itemBlock(c, i + 1)).join('\n\n');
    const user =
      `${body}\n\n` +
      '逐对判断，只输出一个 JSON 对象，形如：\n' +
      '{"items":[{"id":1,"verdict":"contradiction|complement|unrelated",' +
      '"reason":"40字以内","aClaim":"A主张","bClaim":"B主张","conflictAt":"哪一点对不上，非矛盾时留空"}]}\n' +
      `必须给出全部 ${slice.length} 对，id 从 1 到 ${slice.length}。不要任何解释文字、不要 Markdown 围栏。`;

    try {
      calls++;
      const raw = await chatJson<{ items?: RawVerdict[] }>(
        [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: user },
        ],
        {
          temperature: 0,
          maxTokens: 3000,
          timeoutMs: 120_000,
          label: '矛盾判定',
          signal: opts.signal,
          validate: (v) => {
            const arr = (v as { items?: unknown }).items;
            return Array.isArray(arr) && arr.length ? null : '缺少 items 数组';
          },
        },
      );
      const got = Array.isArray(raw.items) ? raw.items : [];
      const byId = new Map<number, RawVerdict>();
      got.forEach((r, idx) => {
        const id = Number(r?.id);
        byId.set(Number.isFinite(id) && id >= 1 ? id : idx + 1, r);
      });
      slice.forEach((c, i) => {
        const r = byId.get(i + 1);
        out.push({
          ...c,
          verdict: normalize(r?.verdict),
          reason: (r?.reason ?? '').trim().slice(0, 80) || '（模型没给理由）',
          aClaim: (r?.aClaim ?? '').trim().slice(0, 120),
          bClaim: (r?.bClaim ?? '').trim().slice(0, 120),
          conflictAt: (r?.conflictAt ?? '').trim().slice(0, 60),
        });
      });
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : (e as Error).message;
      errors.push(`第 ${start + 1}~${start + slice.length} 对判定失败：${msg}`);
      slice.forEach((c) => {
        out.push({ ...c, verdict: 'unknown', reason: '判定失败', aClaim: '', bClaim: '', conflictAt: '' });
      });
    }
  }

  return { verdicts: out, usage: { calls, ms: Date.now() - t0 }, errors };
}

let cache: { key: string; review: ConflictReview } | null = null;

/**
 * 完整流程：建图（带候选池）→ 逐条判定。结果只在内存里缓存，
 * 库一变（builtAt 变）立刻作废，绝不落盘成"第二份真相"。
 */
export async function reviewConflicts(
  opts: { max?: number; force?: boolean; signal?: AbortSignal } = {},
): Promise<ConflictReview> {
  const max = Math.max(1, Math.min(opts.max ?? 12, 40));
  const t0 = Date.now();
  const g = await buildGraph({ pool: true, force: opts.force });
  const key = `${g.builtAt}#${g.stat.chunks}#${max}`;
  if (cache && cache.key === key) return cache.review;

  const pool = g.conflicts;
  const picks = pool.slice(0, max);
  const { verdicts, usage, errors } = await judgeConflicts(picks, { signal: opts.signal });

  const counts: Record<ConflictVerdict, number> = {
    contradiction: 0,
    complement: 0,
    unrelated: 0,
    unknown: 0,
  };
  for (const v of verdicts) counts[v.verdict]++;

  const review: ConflictReview = {
    builtAt: g.builtAt,
    mode: g.mode,
    pool: pool.length,
    judged: verdicts.length,
    counts,
    items: verdicts.sort((a, b) => rank(a.verdict) - rank(b.verdict) || b.sim - a.sim),
    errors,
    stat: {
      graphMs: g.stat.ms,
      judgeMs: usage.ms,
      calls: usage.calls,
      ms: Date.now() - t0,
    },
    aiConfigured: (await getAiSettings()).configured,
  };
  cache = { key, review };
  return review;
}

// ─────────────── 检索侧：只在那几条命中之间查 ───────────────

/** 一条检索命中变成的「待比对片段」。n 就是界面上那个 [n] 编号。 */
export interface ScanPassage {
  n: number;
  id: string;
  docRel: string;
  docTitle: string;
  headingText: string;
  headingPath: string[];
  startBi: number;
  text: string;
}

export interface ScannedConflict extends JudgedConflict {
  /** 和界面上 [n] 对应的编号，找不到时为 null */
  aN: number | null;
  bN: number | null;
}

export interface ConflictScan {
  /** 实际比对了多少对 */
  pairs: number;
  /** 交上去判定（或机械信号命中）的候选数 */
  candidates: number;
  /** 有没有真的走模型判定 */
  judged: boolean;
  counts: Record<ConflictVerdict, number>;
  items: ScannedConflict[];
  errors: string[];
  ms: number;
}

/** 检索命中缺字段时补成可用的 IndexChunk（索引还没建到这一片时会发生） */
function fromHit(p: ScanPassage): IndexChunk {
  return {
    id: p.id,
    docRel: p.docRel,
    docTitle: p.docTitle,
    headingId: '',
    headingText: p.headingText,
    headingPath: p.headingPath,
    part: 0,
    startBi: p.startBi,
    partFrom: p.startBi,
    partTo: p.startBi + 1,
    text: p.text,
    hash: '',
    vec: null,
  };
}

/**
 * 在「这一次检索命中的这几段」之间查矛盾。
 *
 * ★ 为什么不走全库 ★
 *   全库体检是「没事不会点」的动作。而检索是用户真的在关心一个话题的时刻——
 *   这时候告诉他「你笔记里有两处说法对不上」，才是这个功能真正的使用场景。
 *   而且只在 k 条命中里两两比（k=8 → 28 对），毫秒级，不用等建图。
 *
 * ★ 为什么不套用全库那套阈值 ★
 *   相似度门槛（0.72）在这里必须去掉：命中的片段来自不同文档，本来就未必互像。
 *   「讲的是不是同一件事」由共享稀有短语负责，这个判据跟相似度无关。
 */
export async function scanPassages(
  passages: ScanPassage[],
  opts: { max?: number; judge?: boolean; signal?: AbortSignal } = {},
): Promise<ConflictScan> {
  const t0 = Date.now();
  const max = Math.max(1, Math.min(opts.max ?? 6, 20));
  if (passages.length < 2) {
    return {
      pairs: 0,
      candidates: 0,
      judged: false,
      counts: { contradiction: 0, complement: 0, unrelated: 0, unknown: 0 },
      items: [],
      errors: [],
      ms: 0,
    };
  }

  const idx = await readIndex();
  const byId = new Map(idx.chunks.map((c) => [c.id, c]));
  const chunks = passages.map((p) => byId.get(p.id) ?? fromHit(p));
  const corpus = getCorpus(chunks, `scan#${passages.length}#${chunks.map((c) => c.id).join(',')}`);

  const pairs: Pair[] = [];
  for (let i = 0; i < chunks.length; i++) {
    for (let j = i + 1; j < chunks.length; j++) {
      const A = chunks[i];
      const B = chunks[j];
      // 同一篇文档里相邻的两片，是同一段话被切开，不是库里的两个来源
      if (A.docRel === B.docRel && Math.abs(A.part - B.part) <= 1) continue;
      const s = A.vec && B.vec && A.vec.length === B.vec.length ? cosine(A.vec, B.vec) : 0;
      pairs.push({ i, j, s });
    }
  }

  const ai = await getAiSettings();
  // 有 AI：只要锁定了同一件事、又不明显跑题就交上去让它读（机械信号太窄，
  //   它认不出「一个说用 PPO、一个说用 GRPO」这种一眼可辨的矛盾）
  // 没 AI：退回机械信号，宁缺毋滥
  const cands = findConflicts(chunks, pairs, corpus, {
    requireSignal: !ai.configured,
    minSim: 0,
    limit: max,
    onePerDocPair: false,
  });

  let items: ScannedConflict[] = [];
  const errors: string[] = [];
  let judged = false;

  if (cands.length && opts.judge !== false && ai.configured) {
    const res = await judgeConflicts(cands, { signal: opts.signal, batch: 6 });
    errors.push(...res.errors);
    judged = true;
    items = res.verdicts.map((v) => withN(v, passages));
  } else {
    items = cands.map((c) => withN({ ...c, verdict: 'unknown' as ConflictVerdict, reason: '', aClaim: '', bClaim: '', conflictAt: '' }, passages));
  }

  const counts: Record<ConflictVerdict, number> = { contradiction: 0, complement: 0, unrelated: 0, unknown: 0 };
  for (const v of items) counts[v.verdict]++;

  return {
    pairs: pairs.length,
    candidates: cands.length,
    judged,
    counts,
    items: items.sort((a, b) => rank(a.verdict) - rank(b.verdict) || b.sim - a.sim),
    errors,
    ms: Date.now() - t0,
  };
}

/** 把「哪两段」翻译成界面上的 [n]：命中编号才是用户能看懂的东西 */
function withN(v: JudgedConflict, passages: ScanPassage[]): ScannedConflict {
  const find = (rel: string, bi: number): number | null => {
    const exact = passages.find((p) => p.docRel === rel && p.startBi === bi);
    if (exact) return exact.n;
    const loose = passages.find((p) => p.docRel === rel);
    return loose ? loose.n : null;
  };
  return { ...v, aN: find(v.a.docRel, v.a.startBi), bN: find(v.b.docRel, v.b.startBi) };
}

/** 把检索结果转成待比对片段 */
export function passagesFromHits(hits: SearchHit[]): ScanPassage[] {
  return hits.map((hit, i) => ({
    n: i + 1,
    id: hit.id,
    docRel: hit.docRel,
    docTitle: hit.docTitle,
    headingText: hit.headingText,
    headingPath: hit.headingPath,
    startBi: hit.startBi,
    text: hit.text,
  }));
}

function rank(v: ConflictVerdict): number {
  return v === 'contradiction' ? 0 : v === 'complement' ? 1 : v === 'unknown' ? 2 : 3;
}
