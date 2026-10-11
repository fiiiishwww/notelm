/**
 * 概念库（L2/L3，2026-09-21 接入）——多鱼愿景「全库概念地图」的第一块地基。
 *
 * ★ 设计立场：名锚分离 ★
 *   概念的**身份** = 证据集（出现在哪些文档哪些节、块号），全部程序派生、可复算；
 *   概念的**名字** = 证据集的展示标签（正名取首次登记的树节点名，将来允许模型概括词做别名）。
 *   幻觉防线：没有证据（sources 为空）的概念不允许存在。
 *
 * ★ 派生数据哲学（同 chapters/units）★
 *   concepts.json 是**所有 sidecar 的 sec.tree 节点的派生索引**，不是第二事实源——
 *   随时可全量重建、重建结果按 key 幂等（id 由 key 的 hash 定，稳定不变）。
 *   树删除/重生成后重建一次即对齐，不存在「概念库和树打架」的问题。
 *
 * L3 的用途：渲染树时查同 key 概念在其他节的出处 → 「另见 XX 节」反向索引。
 * L4 预留：跨篇对齐（异名同概念）将来在这个结构上加 aliases + merge 记录，现在不做。
 */
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR_NAME, requireVaultRoot } from '../core';
import { listAllSidecars } from './sidecar';
import type { KnowledgeTree } from '../../shared/text';

export interface ConceptSource {
  docRel: string;
  headingId: string;
  headingText: string;
  /** 节点首次出现处的块号（树节点 bi，缺省无） */
  bi?: number;
}

export interface Concept {
  /** 稳定 id：c-<key 的 md5 前 8 位>。key 相同 → id 相同，重建不变。 */
  id: string;
  /** 规范化 key（小写、去空白） */
  key: string;
  /** 正名：首次登记时的节点名 */
  name: string;
  /** 别名（L4 跨篇对齐时启用；现在恒空但结构先占位） */
  aliases: string[];
  /** 反向索引：这个概念在哪些文档哪些节出现过（树节点级） */
  sources: ConceptSource[];
}

export interface ConceptStore {
  version: 1;
  rebuiltAt: string;
  concepts: Concept[];
}

const FILE = 'concepts.json';

export const conceptKeyOf = (s: string): string =>
  s.toLowerCase().replace(/\s+/g, ' ').trim();

const idOf = (key: string): string =>
  'c-' + createHash('md5').update(key).digest('hex').slice(0, 8);

const conceptsPath = async (): Promise<string> =>
  path.join(await requireVaultRoot(), DATA_DIR_NAME, FILE);

/**
 * 从全库 sidecar 派生概念索引并落盘。
 * 幂等：同 key 聚合为同一概念；sources 按 (docRel, headingId) 去重；
 * 正名保留首次登记的（重建时按 key 找旧 name，避免「重名漂移」）。
 */
export async function rebuildConcepts(): Promise<ConceptStore> {
  const all = await listAllSidecars();
  const byKey = new Map<string, Concept>();

  for (const { docRel, sidecar } of all) {
    for (const s of sidecar.cheatsheet?.sections ?? []) {
      const tree: KnowledgeTree | undefined = s.tree;
      if (!tree) continue;
      for (const n of tree.nodes ?? []) {
        const name = (n.name ?? '').trim();
        if (!name) continue;
        const key = conceptKeyOf(name);
        if (!key) continue;
        let c = byKey.get(key);
        if (!c) {
          c = { id: idOf(key), key, name, aliases: [], sources: [] };
          byKey.set(key, c);
        }
        const src: ConceptSource = {
          docRel,
          headingId: s.headingId,
          headingText: s.headingText ?? '',
          ...(n.bi != null ? { bi: n.bi } : {}),
        };
        if (!c.sources.some((x) => x.docRel === docRel && x.headingId === s.headingId)) {
          c.sources.push(src);
        }
      }
    }
  }

  const store: ConceptStore = {
    version: 1,
    rebuiltAt: new Date().toISOString(),
    concepts: [...byKey.values()].sort((a, b) => b.sources.length - a.sources.length || a.key.localeCompare(b.key)),
  };
  await fsp.writeFile(await conceptsPath(), JSON.stringify(store, null, 2), 'utf8');
  cache = store;
  return store;
}

let cache: ConceptStore | null = null;

/** 读概念库（带内存缓存）；文件不存在时自动派生一次。 */
export async function loadConcepts(): Promise<ConceptStore> {
  if (cache) return cache;
  try {
    const raw = JSON.parse(await fsp.readFile(await conceptsPath(), 'utf8')) as ConceptStore;
    if (raw?.version === 1) {
      cache = raw;
      return raw;
    }
  } catch {
    /* 不存在/损坏 → 重建 */
  }
  return rebuildConcepts();
}

/**
 * 一篇文档内、按节渲染用的跨节出处表：
 * key → 该概念在**同一篇其他节**的出处（L3 的「另见」只做篇内，跨篇留给 L4）。
 */
export async function docXrefs(
  docRel: string,
): Promise<Map<string, { headingId: string; headingText: string }[]>> {
  const store = await loadConcepts();
  const out = new Map<string, { headingId: string; headingText: string }[]>();
  for (const c of store.concepts) {
    const inDoc = c.sources.filter((s) => s.docRel === docRel);
    if (inDoc.length < 2) continue;
    out.set(
      c.key,
      inDoc.map((s) => ({ headingId: s.headingId, headingText: s.headingText })),
    );
  }
  return out;
}

// ─────────────────────────── L4：人工确认的合并层（B4-S3） ───────────────────────────

/**
 * `notes/.notebook/concept-merges.json` —— 跨篇概念对齐的**人工确认层**。
 *
 * ★ 为什么独立成文件 ★
 *   concepts.json 是派生物（随时重建），而「这两个名字是同一个概念」是**人的判断**
 *   ——人的判断只追加、必须活过重建。所以 merges 存在派生物之外，
 *   在**读取时**套用（applyMerges），重建 concepts.json 永远不会丢它。
 *
 * ★ 只标记不自动合并 ★
 *   错分裂只是少一条边（看得见、能补），错合并是错误连接（看不出错）。
 *   这个文件只由探针候选表 + 她确认产生；agent 只能读，不能写。
 *
 * 结构：{ version: 1, merges: [{ aliasKey, canonicalKey, note?, confirmedAt }] }
 * aliasKey → canonicalKey，方向固定：读的时候把 alias 并进 canonical。
 */

export interface ConceptMerge {
  aliasKey: string;
  canonicalKey: string;
  note?: string;
  confirmedAt: string;
}

export interface ConceptMergeStore {
  version: 1;
  merges: ConceptMerge[];
}

const mergesPath = async (): Promise<string> =>
  path.join(await requireVaultRoot(), DATA_DIR_NAME, 'concept-merges.json');

export async function loadMerges(): Promise<ConceptMergeStore> {
  try {
    const raw = JSON.parse(await fsp.readFile(await mergesPath(), 'utf8')) as ConceptMergeStore;
    if (raw?.version === 1 && Array.isArray(raw.merges)) return raw;
  } catch {
    /* 不存在 = 还没有任何人工确认的合并，合法状态 */
  }
  return { version: 1, merges: [] };
}

/** 把人工确认的合并套到概念库上（读取时视图，不改盘上的 concepts.json）。 */
export function applyMerges(store: ConceptStore, merges: ConceptMerge[]): ConceptStore {
  if (!merges.length) return store;
  const aliasToCanon = new Map(merges.map((m) => [m.aliasKey, m.canonicalKey]));
  const byKey = new Map<string, Concept>();
  for (const c of store.concepts) {
    const canonKey = aliasToCanon.get(c.key) ?? c.key;
    if (canonKey === c.key) {
      byKey.set(c.key, { ...c, aliases: [...c.aliases] });
      continue;
    }
    // alias 并进 canonical：sources 并入（去重），原名字进 canonical 的 aliases
    const canon = byKey.get(canonKey);
    if (canon) {
      for (const s of c.sources) {
        if (!canon.sources.some((x) => x.docRel === s.docRel && x.headingId === s.headingId)) {
          canon.sources.push(s);
        }
      }
      if (!canon.aliases.includes(c.name)) canon.aliases.push(c.name);
    } else {
      // canonical 不在库里（极端：alias 先出现）——alias 自立门户但记录在案
      byKey.set(c.key, { ...c, aliases: [...c.aliases, `⤳ ${canonKey}`] });
    }
  }
  return { ...store, concepts: [...byKey.values()] };
}

/** key（或名字）→ 合并后视图里的概念。agent 工具和图谱查询共用。 */
export async function conceptByKey(key: string): Promise<Concept | null> {
  const store = await loadConcepts();
  const k = conceptKeyOf(key);
  return store.concepts.find((c) => c.key === k || c.aliases.some((a) => conceptKeyOf(a) === k)) ?? null;
}

/** 按关键词粗筛概念（名字/别名子串匹配，大小写不敏感）。给 agent 的概念查询工具。 */
export async function searchConcepts(q: string, limit = 15): Promise<Concept[]> {
  const store = await loadConcepts();
  const needle = conceptKeyOf(q);
  if (!needle) return [];
  const scored = store.concepts
    .map((c) => {
      const hay = conceptKeyOf(`${c.name} ${c.aliases.join(' ')}`);
      const idx = hay.indexOf(needle);
      return { c, score: idx < 0 ? -1 : (idx === 0 ? 2 : 1) + c.sources.length / 100 };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((x) => x.c);
}
