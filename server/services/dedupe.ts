/**
 * server/services/dedupe.ts —— 找出库里重复的文章，交给用户确认后再删。
 *
 * ★ 为什么分三档，而不是一句「重复」就完事 ★
 *   笔记库里的「重复」其实是三种完全不同的情况，混在一起会让用户误删：
 *     - exact  ：一模一样（导入了两次、备份副本）。删掉副本零风险。
 *     - similar：内容高度重合但略有出入（改过一版、加了批注）。值得看一眼。
 *     - subset ：一篇是另一篇的一部分（整章 vs 拆出来的单节，或新旧两版）。
 *               看着「重合度 90%」，但删掉的可能正是唯一保留某段内容的那一篇，
 *               风险不小，所以默认**不勾选**，由用户自己定。
 *
 * ★ 为什么用「双向覆盖率」而不是单向 ★
 *   单向覆盖率会把「整章 vs 其中一节」显示成 100% 重合，用户一点就把整章删了。
 *   取两个方向里较小的那个，整章 vs 单节只剩三成左右，一眼看出不是一回事。
 *
 * ★ 留谁 ★
 *   先留批注最多的那一篇——批注是用户在文章上花过的时间，比文件本身更值钱；
 *   都没有批注就留内容更全的（更长），再相同就留路径更短的。
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { requireVaultRoot } from '../core';
import { scanTree, type TreeNode } from '../vault';
import { readSidecar } from './sidecar';

/** 低于这个有效长度的文章不参与相似度比较（空文件、只有标题的占位稿）。 */
const MIN_TOKENS = 24;
/** 双向覆盖率都到这个值，才算「高度相似」（可以放心当副本删）。 */
const SIMILAR_MIN = 0.9;
/**
 * 单向覆盖率到这个值，说明「一篇基本在另一篇里」——判为包含关系。
 * 只要没到 SIMILAR_MIN 都归这一档：它可能是「整章 vs 拆出来的单节」，
 * 也可能是「新版 vs 旧版」，删掉哪一边都不好替用户做主，所以只列出来、不勾选。
 */
const SUBSET_MIN = 0.9;

export type DupKind = 'exact' | 'similar' | 'subset';

export interface DupDoc {
  rel: string;
  title: string;
  chars: number;
  mtime: number;
  /** 批注 / 高亮 / 卡片 数量——「留谁」主要看它 */
  notes: number;
  highlights: number;
  cards: number;
  /** 与保留者的重合度（两个方向里较小的那个，0~1） */
  similarity: number;
  /**
   * 这一篇的内容有多少能在保留者里找到（0~1）。
   * 只在「包含关系」这档有意义：重合度可能只有 6%，但这一篇的 100% 都在对方里——
   * 也就是「它是对方的一部分」，删前必须想清楚。
   */
  containment: number;
  kind: DupKind;
}

export interface DupGroup {
  id: string;
  kind: DupKind;
  keeper: DupDoc;
  dups: DupDoc[];
  /** 删掉这个组里默认勾选的副本能省下多少字符 */
  saveChars: number;
}

export interface DedupeReport {
  scanned: number;
  groups: DupGroup[];
  /** 默认勾选（建议删除）的篇数 */
  removable: number;
  saveChars: number;
  ms: number;
}

// ─────────────────────────── 文本归一化 ───────────────────────────

/** 去掉 front matter / 代码块 / 链接地址 / 标点，只留下「说的是什么」。 */
function normalize(md: string): string {
  return md
    .replace(/^\uFEFF/, '')
    .replace(/^---\r?\n[\s\S]*?\r?\n---\s*/, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`~\-|:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 参与比对的文本上限（字符）。
 * 超长文只取开头这一段做指纹——几万字的文章，开头一万字足够区分彼此。
 * 注意：截断只影响「取哪些二元组」，**不影响覆盖率的分母**，分母永远用全文长度
 * （见 compare 的 total 参数）。否则两篇都截到同样长度，覆盖率会双双虚高到 100%，
 * 「整本 vs 其中一章」就被误判成完全一样了。
 */
const SCAN_CHARS = 60_000;

/** 不分词也能比：统一取二元组（中文按字、英文按词都能覆盖到）。 */
function bigrams(text: string): Set<string> {
  const out = new Set<string>();
  const t = text.length > SCAN_CHARS ? text.slice(0, SCAN_CHARS) : text;
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

interface Entry {
  rel: string;
  title: string;
  chars: number;
  mtime: number;
  /** 完全相同的判据：归一化后去掉所有空白再算 sha1 */
  exactHash: string;
  tokens: Set<string>;
  /** 全文的二元组总数（含重复） */
  total: number;
  /** 真正扫过的二元组数，等于 min(total, SCAN_CHARS - 1) */
  scanned: number;
  notes: number;
  highlights: number;
  cards: number;
}

/**
 * 覆盖率的分母：整篇里「不重复的二元组」大概有几个。
 *
 * 两个朴素选项都不对：
 *   - 用 total（含重复）会把覆盖率系统性压低——自然语言里大量二元组重复出现，
 *     两篇几乎一样的文章也只能算到 0.8；
 *   - 用 tokens.size 会在超长文上虚高——截断后集合不再代表全文，
 *     「整本 vs 其中一章」会被算成双向 100%。
 * 于是按采样率折算：全文都扫了就用精确的集合大小，只扫了一部分就按重复率外推。
 */
function denom(e: Entry): number {
  if (e.total <= e.scanned) return Math.max(1, e.tokens.size);
  const rate = e.tokens.size / Math.max(1, e.scanned);
  return Math.max(1, Math.max(e.tokens.size, Math.round(rate * e.total)));
}

/** 双向覆盖率：ab = a 的内容有多少能在 b 里找到。 */
function compare(a: Entry, b: Entry): { ab: number; ba: number } {
  if (!a.tokens.size || !b.tokens.size) return { ab: 0, ba: 0 };
  let inter = 0;
  const [small, big] = a.tokens.size <= b.tokens.size ? [a.tokens, b.tokens] : [b.tokens, a.tokens];
  for (const x of small) if (big.has(x)) inter++;
  return { ab: inter / denom(a), ba: inter / denom(b) };
}

function flatten(node: TreeNode, out: { rel: string; mtime: number }[] = []): { rel: string; mtime: number }[] {
  if (node.type === 'doc' && node.relPath) out.push({ rel: node.relPath, mtime: node.mtime });
  for (const c of node.children ?? []) flatten(c, out);
  return out;
}

async function collect(): Promise<Entry[]> {
  const root = await requireVaultRoot();
  const list = flatten(await scanTree());
  const out: Entry[] = [];
  for (const it of list) {
    let md = '';
    try {
      md = await fsp.readFile(path.join(root, it.rel), 'utf8');
    } catch {
      continue; // 读不出来的（权限、并发删除）跳过，不该让整次扫描失败
    }
    const norm = normalize(md);
    const sc = await readSidecar(it.rel);
    const scanned = Math.max(1, Math.min(norm.length, SCAN_CHARS) - 1);
    out.push({
      rel: it.rel,
      title: it.rel.split('/').pop()?.replace(/\.[^.]+$/, '') ?? it.rel,
      chars: md.length,
      mtime: it.mtime,
      exactHash: crypto.createHash('sha1').update(norm.replace(/\s+/g, ''), 'utf8').digest('hex'),
      tokens: bigrams(norm),
      total: Math.max(1, norm.length - 1),
      scanned,
      notes: sc.notes.length,
      highlights: sc.highlights.length,
      cards: sc.cards.length,
    });
  }
  return out;
}

function toDoc(e: Entry, similarity: number, containment: number, kind: DupKind): DupDoc {
  return {
    rel: e.rel,
    title: e.title,
    chars: e.chars,
    mtime: e.mtime,
    notes: e.notes,
    highlights: e.highlights,
    cards: e.cards,
    similarity,
    containment,
    kind,
  };
}

/** 并查集：把「A 和 B 重复、B 和 C 重复」并成一组。 */
function makeDs(rels: string[]) {
  const parent = new Map<string, string>();
  for (const r of rels) parent.set(r, r);
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r) as string;
    let cur = x;
    while (parent.get(cur) !== r) {
      const next = parent.get(cur) as string;
      parent.set(cur, r);
      cur = next;
    }
    return r;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  return { find, union };
}

function buildGroups(docs: Entry[]): DupGroup[] {
  const ds = makeDs(docs.map((d) => d.rel));

  // 1) 完全相同：同一 hash 的全部并起来
  const byHash = new Map<string, Entry[]>();
  for (const d of docs) {
    const arr = byHash.get(d.exactHash) ?? [];
    arr.push(d);
    byHash.set(d.exactHash, arr);
  }
  for (const [, arr] of byHash) {
    for (let i = 1; i < arr.length; i++) ds.union(arr[0].rel, arr[i].rel);
  }

  // 2) 相似 / 子集：O(n²) 比对。库里几百篇时是几万次集合求交，够快；
  //    真到了几千篇再上倒排索引也不迟。
  for (let i = 0; i < docs.length; i++) {
    const a = docs[i];
    if (a.tokens.size < MIN_TOKENS) continue;
    for (let j = i + 1; j < docs.length; j++) {
      const b = docs[j];
      if (b.tokens.size < MIN_TOKENS) continue;
      const { ab, ba } = compare(a, b);
      const min = Math.min(ab, ba);
      const max = Math.max(ab, ba);
      if (min >= SIMILAR_MIN || max >= SUBSET_MIN) ds.union(a.rel, b.rel);
    }
  }

  // 3) 按根分组
  const buckets = new Map<string, Entry[]>();
  for (const d of docs) {
    const r = ds.find(d.rel);
    const arr = buckets.get(r) ?? [];
    arr.push(d);
    buckets.set(r, arr);
  }

  const groups: DupGroup[] = [];
  let n = 0;
  for (const [, arr] of buckets) {
    if (arr.length < 2) continue;

    // 留谁：批注多 → 内容全 → 路径短
    const sorted = arr.slice().sort((x, y) => {
      const ax = x.notes + x.highlights + x.cards;
      const ay = y.notes + y.highlights + y.cards;
      if (ax !== ay) return ay - ax;
      if (x.chars !== y.chars) return y.chars - x.chars;
      if (x.rel.length !== y.rel.length) return x.rel.length - y.rel.length;
      return x.rel < y.rel ? -1 : 1;
    });
    const keeper = sorted[0];

    const dups: DupDoc[] = [];
    for (const d of sorted.slice(1)) {
      if (d.exactHash === keeper.exactHash) {
        dups.push(toDoc(d, 1, 1, 'exact'));
        continue;
      }
      const { ab, ba } = compare(d, keeper);
      const min = Math.min(ab, ba);
      const kind: DupKind = min >= SIMILAR_MIN ? 'similar' : 'subset';
      dups.push(toDoc(d, min, ab, kind));
    }

    const kind: DupKind = dups.some((d) => d.kind === 'exact')
      ? 'exact'
      : dups.some((d) => d.kind === 'similar')
        ? 'similar'
        : 'subset';

    groups.push({
      id: `dup-${n++}`,
      kind,
      keeper: toDoc(keeper, 1, 1, kind),
      dups,
      saveChars: dups.filter((d) => d.kind !== 'subset').reduce((s, d) => s + d.chars, 0),
    });
  }

  // 先看最该处理的（完全相同），再看能省最多的
  const rank: Record<DupKind, number> = { exact: 0, similar: 1, subset: 2 };
  groups.sort((a, b) => rank[a.kind] - rank[b.kind] || b.saveChars - a.saveChars);
  return groups;
}

/**
 * 探针用：列出所有相似度达到一定水平的配对（min/max 是双向覆盖率）。
 * 调 SIMILAR_MIN / SUBSET_MIN 这两个阈值时靠它看真实分布，不参与正式流程。
 */
export async function scanSimilarPairs(floor = 0.5): Promise<{ a: string; b: string; min: number; max: number }[]> {
  const docs = await collect();
  const out: { a: string; b: string; min: number; max: number }[] = [];
  for (let i = 0; i < docs.length; i++) {
    for (let j = i + 1; j < docs.length; j++) {
      const { ab, ba } = compare(docs[i], docs[j]);
      const min = Math.min(ab, ba);
      if (min >= floor) out.push({ a: docs[i].rel, b: docs[j].rel, min, max: Math.max(ab, ba) });
    }
  }
  return out.sort((x, y) => y.min - x.min);
}

/** 扫一遍全库，列出所有重复组。只读，不动任何文件。 */
export async function dedupeReport(): Promise<DedupeReport> {
  const t0 = Date.now();
  const docs = await collect();
  const groups = buildGroups(docs);
  const removable = groups.reduce((s, g) => s + g.dups.filter((d) => d.kind !== 'subset').length, 0);
  const saveChars = groups.reduce((s, g) => s + g.saveChars, 0);
  return { scanned: docs.length, groups, removable, saveChars, ms: Date.now() - t0 };
}
