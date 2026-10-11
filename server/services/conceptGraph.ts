/**
 * server/services/conceptGraph.ts —— 概念图谱查询（B4-S4，2026-09-22）。
 *
 * ★ 设计立场：图谱不是第二事实源 ★
 *   「不做独立三元组库」（方案 §7）。这里的边全部**现查现算**：
 *     - 边来源 1：知识树的关系边（KRelation），toNode=true 的才是图内边；
 *     - 边来源 2：L4 人工确认的合并（concept-merges.json）——alias 与 canonical 互指；
 *     - 边来源 3：同节共存不画边（太噪），只在「另见」语境给 sources。
 *   每条边带证据（doc/heading/bi），-agent 说「谁和谁有关」必须能回落到原文。
 */

import { listAllSidecars } from './sidecar';
import {
  applyMerges,
  conceptKeyOf,
  loadConcepts,
  loadMerges,
  type Concept,
} from './concepts';

export interface GraphEdge {
  /** 另一端的 conceptKey */
  key: string;
  name: string;
  /** 关系词（树关系边）或 'merged'（人工确认的同一概念） */
  rel: string;
  /** 另一端是否图内知识点（树关系的 toNode） */
  toNode: boolean;
  note?: string;
  evidence: { docRel: string; headingId: string; headingText?: string; bi?: number }[];
}

export interface GraphView {
  key: string;
  name: string;
  aliases: string[];
  /** 这个概念出现在哪些节（合并后视图） */
  sources: { docRel: string; headingId: string; headingText: string; bi?: number }[];
  out: GraphEdge[];
  in: GraphEdge[];
}

/** 全库概念邻接（合并后视图，现查现算；全库 436 概念毫秒级）。 */
export async function graphNeighbors(key: string): Promise<GraphView | null> {
  const merges = await loadMerges();
  const base = await loadConcepts();
  const store = applyMerges(base, merges.merges);

  const k = conceptKeyOf(key);
  const self = store.concepts.find(
    (c) => c.key === k || c.aliases.some((a) => conceptKeyOf(a) === k),
  );
  if (!self) return null;

  // 索引：概念名/key → 概念（合并后视图里找得到才算图内节点）
  const byKey = new Map(store.concepts.map((c) => [c.key, c]));
  const out = new Map<string, GraphEdge>();
  const inc = new Map<string, GraphEdge>();

  const addEdge = (
    map: Map<string, GraphEdge>,
    target: Concept | undefined,
    rel: string,
    toNode: boolean,
    note: string | undefined,
    ev: GraphEdge['evidence'][number],
  ): void => {
    if (!target) return;
    let e = map.get(target.key);
    if (!e) {
      e = { key: target.key, name: target.name, rel, toNode, evidence: [] };
      if (note) e.note = note;
      map.set(target.key, e);
    }
    if (toNode && !e.toNode) e.toNode = true;
    if (!e.evidence.some((x) => x.docRel === ev.docRel && x.headingId === ev.headingId && x.bi === ev.bi)) {
      e.evidence.push(ev);
    }
  };

  // 1) 知识树的关系边：扫全库 sidecar 的 sec.tree
  const all = await listAllSidecars();
  const nameIndex = new Map(store.concepts.map((c) => [c.key, c]));
  for (const { docRel, sidecar } of all) {
    for (const s of sidecar.cheatsheet?.sections ?? []) {
      for (const n of s.tree?.nodes ?? []) {
        const nk = conceptKeyOf(n.name);
        if (nk !== self.key && !self.aliases.some((a) => conceptKeyOf(a) === nk)) continue;
        const ev = {
          docRel,
          headingId: s.headingId,
          headingText: s.headingText ?? '',
          ...(n.bi != null ? { bi: n.bi } : {}),
        };
        for (const r of n.relations ?? []) {
          const tk = conceptKeyOf(r.target);
          const target = tk ? nameIndex.get(tk) : undefined;
          addEdge(out, target, r.rel, r.toNode, r.note, ev);
          // 反向：target 那个概念也该看见这条边（in）
          if (target) {
            const backEv = { docRel, headingId: s.headingId, headingText: s.headingText ?? '', ...(n.bi != null ? { bi: n.bi } : {}) };
            addEdge(inc, self, r.rel, true, r.note, backEv);
          }
        }
      }
    }
  }

  // 2) 人工确认的合并：alias / canonical 互指（rel='merged'）
  for (const m of merges.merges) {
    if (m.canonicalKey === self.key) {
      const alias = store.concepts.find((c) => c.key === m.aliasKey);
      if (alias) addEdge(out, alias, 'merged（人工确认同一概念）', true, m.note, { docRel: '', headingId: '' });
    } else if (m.aliasKey === self.key) {
      const canon = store.concepts.find((c) => c.key === m.canonicalKey);
      if (canon) addEdge(out, canon, 'merged（人工确认同一概念）', true, m.note, { docRel: '', headingId: '' });
    }
  }

  return {
    key: self.key,
    name: self.name,
    aliases: self.aliases,
    sources: self.sources.map((s) => ({
      docRel: s.docRel,
      headingId: s.headingId,
      headingText: s.headingText,
      ...(s.bi != null ? { bi: s.bi } : {}),
    })),
    out: [...out.values()],
    in: [...inc.values()],
  };
}

/** 概念在合并后视图里的名字（learning.json 等消费方对齐用）。 */
export async function canonicalKeyOf(key: string): Promise<string> {
  const merges = await loadMerges();
  const k = conceptKeyOf(key);
  const hit = merges.merges.find((m) => m.aliasKey === k);
  return hit ? hit.canonicalKey : k;
}

export type { Concept };
