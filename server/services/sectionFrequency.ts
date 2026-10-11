/**
 * server/services/sectionFrequency.ts —— **节级考频**（派生层，markdown 是唯一事实源）。
 *
 * ★ 她拍的两条（2026-10-07）★
 *   1. 口径 = **公司标注次数**（不是 distinct 公司数 —— 她明确选了次数）
 *   2. ★「根据**包含面经的文件**动态变化」⇒ 抽题按**格式**识别、不认目录
 *
 * ★ 为什么要缓存 ★
 *   题向量要调 embedding 接口（249 条约 2.7 秒）。所以：
 *   `signature`（各来源文件 hash 汇总）没变就直接读缓存，变了才重算。
 *   ⇒ 平时读缓存零成本；**面经文件一改，signature 立刻变，自动重算。**
 *
 * ★ 徽章为什么用档位而不是具体数字（她选的）★
 *   ① 树节点行已经很挤（名称 + essence + 徽章），数字占宽
 *   ② 档位用**相对分位**而不是绝对阈值 —— 面经文件会增加，绝对阈值会让全库
 *      整体升档（今天 15 次算高频，题库翻倍后 15 次只算中频，读者会觉得徽章坏了）
 *   ③ 但纯分位在小样本不稳，所以叠一条**绝对上限**：
 *      标注 <3 次最多给 ●，<8 次最多给 ●●。这样「2 次标注」不会和「27 次」同级。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR_NAME, requireVaultRoot } from '../core';
import { scanQuestionPool, type PoolQuestion } from './questionPool';
import { readIndex, cosine } from './vectorstore';
import { embedTexts } from './embed';

export type FreqLevel = 0 | 1 | 2 | 3;

export interface SectionFreq {
  /** vault 相对路径（去 .md），与 sidecar / 树节同一个坐标系 */
  rel: string;
  headingId: string;
  headingText: string;
  /** 公司标注次数 —— 她要的口径 */
  marks: number;
  /** 涉及公司数（辅助信息，不用于排序） */
  companies: number;
  /** 落到这一节的题数 */
  qn: number;
  /** 档位徽章：0 = 没有考频（不显示） */
  level: FreqLevel;
}

export interface SectionFrequency {
  signature: string;
  computedAt: string;
  sections: SectionFreq[];
  /** 认领不到的题（按她的原则「留空不硬塞」） */
  unresolved: number;
  /**
   * 节 → 题 id 投票映射（2026-10-11 加，conceptAssets 用它取回某节命中的题库题）。
   * 旧缓存没有这个字段——消费方判空后 force 重算一次即可，不影响原有消费路径。
   */
  votes: Record<string, string[]>;
}

const CACHE_NAME = 'section-frequency.json';
/** 排除答案文件作为考频落点：考频要落在原文节，不是答案节 */
const isAnswerFile = (rel: string) => /reference-answers/i.test(rel);

const levelOf = (marks: number): FreqLevel => (marks <= 0 ? 0 : marks < 3 ? 1 : marks < 8 ? 2 : 3);

/**
 * 算全库节级考频。
 *
 * @param opts.forceCache=false 时会跳过重算直接读缓存 —— 平时用 true，别让每次渲染都调 embedding。
 */
export async function computeSectionFrequency(opts?: { force?: boolean; topK?: number }): Promise<SectionFrequency> {
  const root = await requireVaultRoot();
  const cachePath = join(root, DATA_DIR_NAME, CACHE_NAME);

  const pool = await scanQuestionPool({ root });
  if (!opts?.force && existsSync(cachePath)) {
    try {
      const cached = JSON.parse(readFileSync(cachePath, 'utf8')) as SectionFrequency;
      if (cached.signature === pool.signature) return cached;
    } catch {
      /* 缓存坏了就重算 */
    }
  }

  const topK = opts?.topK ?? 5;
  const idx = await readIndex();
  const vecs = idx.chunks.filter((c) => Array.isArray(c.vec) && c.vec.length > 0 && !isAnswerFile(String(c.docRel)));
  const { vectors } = await embedTexts(pool.questions.map((q) => q.q));

  const topk: { c: (typeof vecs)[number]; s: number }[][] = vectors.map((v) =>
    vecs
      .map((c) => ({ c, s: cosine(v, c.vec!) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, topK),
  );

  // 投票：sectionKey -> 题 id[]
  const votes = new Map<string, string[]>();
  const topicVote = new Map<string, Map<string, number>>();
  const topicTop = new Map<string, string[]>();
  let unresolved = 0;

  pool.questions.forEach((q, i) => {
    if (q.kind === '思考题') {
      // ★ 章是硬约束：只在同一个文件里选（rel 已含 .md）
      const pick = topk[i].find((t) => t.c.docRel === q.rel);
      if (!pick) {
        unresolved++;
        return;
      }
      push(votes, `${pick.c.docRel}#${pick.c.headingId}`, q.id);
      return;
    }
    const m = topicVote.get(q.topic) ?? new Map<string, number>();
    topk[i].forEach((t, idx) => {
      const k = `${t.c.docRel}#${t.c.headingId}`;
      m.set(k, (m.get(k) ?? 0) + 1 / (1 + idx));
    });
    topicVote.set(q.topic, m);
  });

  // 面经：主题加权票 → 前 2 名节（只取 1 名会让所有主题挤到同一节）
  for (const [topic, m] of topicVote) {
    const keys = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k]) => k);
    topicTop.set(topic, keys);
  }
  pool.questions.forEach((q, i) => {
    if (q.kind !== '面经') return;
    const keys = topicTop.get(q.topic);
    if (!keys?.length) {
      unresolved++;
      return;
    }
    const rank = topk[i].findIndex((t) => `${t.c.docRel}#${t.c.headingId}` === keys[0]);
    push(votes, rank === 0 || !keys[1] ? keys[0] : keys[1], q.id);
  });

  const byKey = new Map(vecs.map((c) => [`${c.docRel}#${c.headingId}`, c]));
  const sections: SectionFreq[] = [];
  for (const [k, ids] of votes) {
    const qs = pool.questions.filter((q) => ids.includes(q.id));
    if (!qs.length) continue;
    const comps = new Set<string>();
    let marks = 0;
    for (const q of qs) {
      marks += q.comps.length;
      for (const c of q.comps) comps.add(c);
    }
    const c = byKey.get(k);
    sections.push({
      rel: String(c?.docRel ?? k.split('#')[0]).replace(/\.md$/, ''),
      headingId: k.split('#')[1],
      headingText: String(c?.headingText ?? ''),
      marks,
      companies: comps.size,
      qn: qs.length,
      level: levelOf(marks),
    });
  }

  // 档位提升：按**非零节里的分位**重排，然后叠绝对上限
  applyLevels(sections);

  sections.sort((a, b) => b.marks - a.marks || b.qn - a.qn);

  const votesOut: Record<string, string[]> = {};
  for (const [k, ids] of votes) votesOut[k] = ids;
  const out: SectionFrequency = {
    signature: pool.signature,
    computedAt: new Date().toISOString(),
    sections,
    unresolved,
    votes: votesOut,
  };
  try {
    mkdirSync(join(root, DATA_DIR_NAME), { recursive: true });
    writeFileSync(cachePath, JSON.stringify(out), 'utf8');
  } catch {
    /* 缓存写失败不影响结果 */
  }
  return out;
}

function push(m: Map<string, string[]>, k: string, id: string): void {
  const a = m.get(k) ?? [];
  a.push(id);
  m.set(k, a);
}

/**
 * 分档：相对分位给基线，绝对值封顶。
 * · 非零节按 marks 降序，top 25% → 3 档、接下来 50% → 2 档、其余 → 1 档
 * · 硬上限：marks<3 最多 1 档；marks<8 最多 2 档
 *
 * ★ 同分同档 ★：按 marks **分组**而不是按行号定档 ——
 *   否则会出现「4 次标注是 ●●、另一处 4 次标注是 ●」这种看起来像 bug 的情况
 *   （分位落在两个同分节之间时）。取该组最好的名次，同分的所有节拿同一档。
 */
function applyLevels(rows: SectionFreq[]): void {
  const nz = rows.filter((r) => r.marks > 0).sort((a, b) => b.marks - a.marks);
  const n = nz.length;
  if (!n) return;
  const cut3 = Math.max(1, Math.round(n * 0.25));
  const cut2 = Math.max(cut3, Math.round(n * 0.75));
  nz.forEach((r, i) => {
    const rel = i < cut3 ? 3 : i < cut2 ? 2 : 1;
    r.level = Math.min(rel, levelOf(r.marks)) as FreqLevel;
  });
  // 同分回填：把每个 marks 组的档位统一成该组的最高档
  const groups = new Map<number, SectionFreq[]>();
  for (const r of nz) {
    const g = groups.get(r.marks) ?? [];
    g.push(r);
    groups.set(r.marks, g);
  }
  for (const g of groups.values()) {
    const best = g.reduce((m, r) => Math.max(m, r.level), 0);
    for (const r of g) r.level = best as FreqLevel;
  }
}

/** 查某一节的考频（渲染徽章用）。取该节所有标注之和。 */
export async function frequencyOf(
  rel: string,
  headingId: string,
  cache?: SectionFrequency,
): Promise<{ marks: number; companies: number; level: FreqLevel }> {
  const data = cache ?? (await computeSectionFrequency({ force: false }));
  const hit = data.sections.find((s) => s.rel === rel && s.headingId === headingId);
  return { marks: hit?.marks ?? 0, companies: hit?.companies ?? 0, level: hit?.level ?? 0 };
}

/** 全部有考频的节，按标注次数降序（左栏「今天」用）。 */
export async function topSections(n = 5, cache?: SectionFrequency): Promise<SectionFreq[]> {
  const data = cache ?? (await computeSectionFrequency({ force: false }));
  return data.sections.filter((s) => s.marks > 0).slice(0, n);
}
