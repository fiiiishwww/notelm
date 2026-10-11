/**
 * server/services/vectorstore.ts —— 全笔记库的检索索引。
 *
 * ★ 索引存在哪 ★
 *   `<笔记库>/.notebook/index/embeddings.json`——放在库内而不是 .local/，
 *   因为它是这份笔记的派生物：换笔记库必须换索引，跟着库走才不会串味。
 *   .notebook 下已有 .gitignore（内容是 `*`），不会污染用户的 git。
 *
 * ★ chunk 边界怎么定 ★
 *   直接复用现成的章节（StudyUnit），不再自创切分规则。理由：
 *   1. 章节本来就是语义完整的单元，比按字数硬切好得多；
 *   2. 命中之后能直接跳回正文的对应位置（startBi 就在手边）；
 *   3. 小抄 / 测验 / 闪卡都按章节组织，检索结果和它们能对上号。
 *   只有「一章超过 1200 字」时才再切成几片，切片尽量断在句读处并留重叠，
 *   避免一句话被劈成两半后两边都不像。
 *
 * ★ 为什么没配置 embedding 也能建索引、也能搜 ★
 *   纯关键词检索对「我记得我写过 XX」这个最常见的诉求已经够用了，
 *   而配置一个向量接口是有门槛的（要注册、要找模型名、要充值）。
 *   让功能在零配置下就能用，配置好之后自动变强，比「先去配接口」友好得多。
 *   降级时前端会明确显示「关键词模式」，不会让人误以为搜到的就是语义结果。
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { ApiError, readJson, requireVaultRoot, sha256, writeFileAtomic } from '../core';
import { analyzeDocument, createMd, headingPathOf } from '../../shared/blocks';
import { readDoc, scanTree, type TreeNode } from '../vault';
import { embedTexts, getEmbedSettings } from './embed';

// ─────────────────────────── 类型 ───────────────────────────

export interface IndexChunk {
  /** docRel + '#' + headingId + '#p' + part，稳定不变，命中比对用 */
  id: string;
  docRel: string;
  docTitle: string;
  headingId: string;
  headingText: string;
  headingPath: string[];
  /** 一章被切成多片时的序号，从 0 开始 */
  part: number;
  /** 该章第一个块的下标，用于跳回正文 */
  startBi: number;
  /**
   * ★ 这一片自己覆盖的块区间 [partFrom, partTo) ★
   * 以前所有分片共用章节的 startBi，于是「命中第 3 片」也会跳回本章开头——
   * 用户看到的是节首那几句，而面板上预览的明明是片中间的某段话，
   * 观感就是「它算错了」。分片级别才是能对上预览的粒度。
   */
  partFrom: number;
  partTo: number;
  text: string;
  /** 内容的 sha256。内容没变就不必重新算向量 */
  hash: string;
  /** 为 null 表示「没配 embedding 或当时算失败了」，检索时走关键词 */
  vec: number[] | null;
}

export interface SearchIndexFile {
  version: number;
  /** 建索引时用的 embedding 模型。换模型必须全量重算，否则向量空间对不上 */
  model: string;
  dim: number;
  builtAt: string;
  chunks: IndexChunk[];
}

export interface SearchHit {
  id: string;
  docRel: string;
  docTitle: string;
  headingId: string;
  headingText: string;
  headingPath: string[];
  part: number;
  startBi: number;
  score: number;
  /** 给界面显示的片段（可能带省略号） */
  snippet: string;
  /**
   * 片段渲染后的 HTML，界面直接显示这个。
   * 由 createMd（html:false）产出，所以原始 HTML 不会被执行——前端可以放心插入。
   * 没有它的时候界面只能把 markdown 源码当纯文本显示，「**加粗**」会带着星号一起出现。
   */
  html: string;
  /** 完整原文，问答模式要整段喂给模型 */
  text: string;
}

/** 还没算向量的片：建索引时先凑齐这些，再统一去算向量。 */
type ChunkSeed = Omit<IndexChunk, 'vec'>;

const INDEX_VERSION = 1;
const INDEX_NAME = 'embeddings.json';
/**
 * 单片上限。宁可小一点：塞给模型的上下文按片取，太大反而稀释。
 *
 * ★ 从 1200 降到 500 的原因（2026-09-16）★
 *   1200 字的片经常横跨好几个主题——一章里"用文件系统当记忆"和"熔断阈值"
 *   被装进同一片是常态。检索时这一片同时和很多问题"有那么一点像"，
 *   于是相关段落面板永远把同一片排在前面（实测 chapter5 无论滚到哪里，
 *   第一名都是 5.1 Coding Agent 那一片）；跳过去的落点也总是偏。
 *   切短之后每片只讲一件事，命中和落点都跟着变准。
 */
const MAX_PART = 500;
/** 切片之间的重叠字数，防止一句话被切断。片变短了，重叠也相应收一点。 */
const OVERLAP = 80;
/** 太短的章节没有检索价值（多半只有一个标题） */
const MIN_TEXT = 20;
/** 关键词检索的最低「IDF 加权覆盖率」，低于此值视为没搜到。取值依据见 keywordSearch 的注释 */
const COVERAGE_MIN = 0.5;

function indexDir(root: string): string {
  return path.join(root, '.notebook', 'index');
}

function indexFile(root: string): string {
  return path.join(indexDir(root), INDEX_NAME);
}

// ─────────────────────────── 读写 ───────────────────────────

const EMPTY_INDEX: SearchIndexFile = { version: INDEX_VERSION, model: '', dim: 0, builtAt: '', chunks: [] };

/**
 * ★ 索引的内存缓存（2026-09-16）★
 *
 * 23MB / 2673 片的索引，JSON.parse 一次要 185ms。而 readIndex 有 4 处调用点
 * （检索、相关段落、图谱、状态），每处都重新 parse 一遍整个文件——
 * 一次「打开相关段落」就能白烧半秒，建图那 14 秒之外又叠了好几层。
 *
 * 命中条件：同一个库 + 文件 mtime 与大小都没变。写索引之后会主动刷新缓存，
 * 所以「刚重建完立刻读」也不会退回旧数据。
 * 返回的是同一个对象，调用方一律只读，不要原地改（要改先自己浅拷贝）。
 */
let indexCache: { root: string; mtimeMs: number; size: number; data: SearchIndexFile } | null = null;

/** 测试/脚本用：强制丢掉缓存，下一次读必定重新 parse */
export function dropIndexCache(): void {
  indexCache = null;
}

export async function readIndex(): Promise<SearchIndexFile> {
  const root = await requireVaultRoot();
  const file = indexFile(root);

  let stamp: { mtimeMs: number; size: number } | null = null;
  try {
    const st = await fsp.stat(file);
    stamp = { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    stamp = null; // 文件还不存在（还没建过索引）
  }

  if (
    indexCache &&
    indexCache.root === root &&
    stamp &&
    indexCache.mtimeMs === stamp.mtimeMs &&
    indexCache.size === stamp.size
  ) {
    return indexCache.data;
  }

  const raw = await readJson<SearchIndexFile>(file, EMPTY_INDEX);
  const data = !raw || !Array.isArray(raw.chunks) ? { ...EMPTY_INDEX } : { ...EMPTY_INDEX, ...raw, chunks: raw.chunks };
  indexCache = stamp ? { root, mtimeMs: stamp.mtimeMs, size: stamp.size, data } : null;
  return data;
}

/**
 * 写盘前把浮点压到 4 位小数。
 * 1024 维 × 几千片直接存原始 double 会让文件涨到几十 MB，
 * 而 4 位小数对余弦相似度的影响在小数点后第四位，完全无感。
 */
function roundVec(v: number[]): number[] {
  return v.map((x) => Math.round(x * 1e4) / 1e4);
}

async function writeIndex(f: SearchIndexFile): Promise<void> {
  const root = await requireVaultRoot();
  await fsp.mkdir(indexDir(root), { recursive: true });
  const slim: SearchIndexFile = {
    ...f,
    chunks: f.chunks.map((c) => ({ ...c, vec: c.vec ? roundVec(c.vec) : null })),
  };
  await writeFileAtomic(indexFile(root), JSON.stringify(slim));
  // 写盘后把缓存指向新数据：接着读回来的是刚写的这份，不必再 parse 一遍 23MB。
  indexCache = null;
  try {
    const st = await fsp.stat(indexFile(root));
    indexCache = { root, mtimeMs: st.mtimeMs, size: st.size, data: slim };
  } catch {
    /* stat 失败就下次读时自然回源 */
  }
}

// ─────────────────────────── 切分 ───────────────────────────

/**
 * 把过长的章节切成有重叠的片段，返回每片在原文里的 [start, end) 字符范围。
 *
 * 为什么返回范围而不是子串：分片落盘时同时要记住「这一片对应正文的哪几个块」，
 * 只拿子串就没有位置信息了，跳转只能退回到章节首块。
 */
export function splitPartRanges(text: string): [number, number][] {
  const t = text.trim();
  if (t.length <= MAX_PART) return t ? [[0, t.length]] : [];

  const ranges: [number, number][] = [];
  let i = 0;
  let guard = 0;
  while (i < t.length && guard++ < 200) {
    let end = Math.min(i + MAX_PART, t.length);
    if (end < t.length) {
      const win = t.slice(i, end);
      // 越靠后越好（少留半句），但不能为了断句把片段切得太短
      const cut = Math.max(win.lastIndexOf('\n'), win.lastIndexOf('。'), win.lastIndexOf('！'), win.lastIndexOf('？'), win.lastIndexOf('；'), win.lastIndexOf('. '));
      if (cut > MAX_PART * 0.5) end = i + cut + 1;
    }
    if (end > i) ranges.push([i, end]);
    if (end >= t.length) break;
    i = Math.max(end - OVERLAP, i + 1);
  }
  return ranges;
}

/** 把过长的章节切成有重叠的片段，尽量断在句读处。 */
export function splitParts(text: string): string[] {
  const t = text.trim();
  const parts = splitPartRanges(t).map(([s, e]) => t.slice(s, e).trim()).filter(Boolean);
  return parts.length ? parts : [t];
}

/** 列出库里所有文档（相对路径）。复用 scanTree，跳过规则不会两边不一致。 */
async function listDocRels(): Promise<{ rel: string; mtime: number }[]> {
  const tree = await scanTree();
  const out: { rel: string; mtime: number }[] = [];
  const walk = (nodes: TreeNode[] | undefined) => {
    for (const n of nodes ?? []) {
      if (n.type === 'doc') out.push({ rel: n.relPath, mtime: n.mtime });
      else walk(n.children);
    }
  };
  walk(tree.children);
  return out;
}

/** 把一篇文档拆成待索引的片段（不含向量）。 */
async function chunksOfDoc(rel: string): Promise<ChunkSeed[]> {
  let markdown: string;
  try {
    markdown = (await readDoc(rel)).markdown;
  } catch {
    return []; // 单篇读不动（权限 / 编码）不影响整体
  }
  const a = analyzeDocument(markdown);
  const docTitle = rel.split('/').pop()?.replace(/\.(md|markdown|txt)$/i, '') ?? rel;

  const out: ChunkSeed[] = [];
  for (const u of a.units) {
    const unitBlocks = a.blocks.slice(u.startBi, u.endBi);
    // 不直接用 unitText()：这里还要知道「每个字符落在第几个块」，
    // 才能把分片的字符范围折算成块范围（跳转落点用）。
    const raw = unitBlocks.map((b) => b.text).join('\n');
    const text = raw.trim();
    if (text.length < MIN_TEXT) continue;

    const spans: [number, number][] = [];
    let pos = 0;
    for (const b of unitBlocks) {
      spans.push([pos, pos + b.text.length]);
      pos += b.text.length + 1; // 连接用的 '\n'
    }
    const blockAt = (charIdx: number): number => {
      for (let k = spans.length - 1; k >= 0; k--) if (charIdx >= spans[k][0]) return k;
      return 0;
    };

    const headingPath = headingPathOf(a.chapters, u);
    const lead = raw.length - raw.trimStart().length;
    const ranges = splitPartRanges(text);
    for (let p = 0; p < ranges.length; p++) {
      const body = text.slice(ranges[p][0], ranges[p][1]).trim();
      if (body.length < MIN_TEXT) continue;
      const s = ranges[p][0] + lead;
      const e = ranges[p][1] + lead;
      out.push({
        id: `${rel}#${u.headingId}#p${p}`,
        docRel: rel,
        docTitle,
        headingId: u.headingId,
        headingText: u.headingText,
        headingPath,
        part: p,
        startBi: u.startBi,
        partFrom: u.startBi + blockAt(s),
        partTo: u.startBi + blockAt(Math.max(s, e - 1)) + 1,
        text: body,
        hash: sha256(body),
      });
    }
  }
  return out;
}

// ─────────────────────────── 建索引 ───────────────────────────

export interface BuildReport {
  docs: number;
  chunks: number;
  added: number;
  updated: number;
  removed: number;
  embedded: number;
  /** 这次是不是用向量建的；false 表示只有关键词能用 */
  usedEmbedding: boolean;
  model: string;
  notice: string | null;
}

/**
 * 增量重建索引。
 *
 * 增量判据是「片内容」而不是「文件」：改了一章就只重算那一章的向量，
 * 在几百篇文章的库里这是「等 2 秒」和「等 2 分钟」的区别。
 * 换 embedding 模型时全部重算——不同模型的向量空间不可比，混着用等于乱搜。
 */
export async function buildIndex(opts: { force?: boolean } = {}): Promise<BuildReport> {
  await requireVaultRoot(); // 先确认有库，免得白扫一圈才报错
  const old = await readIndex();
  const es = await getEmbedSettings();

  const docs = await listDocRels();
  const wanted: ChunkSeed[] = [];
  for (const d of docs) wanted.push(...(await chunksOfDoc(d.rel)));

  const oldById = new Map(old.chunks.map((c) => [c.id, c]));
  // 换模型或换维度都必须全量重算。不同模型的向量空间不可比；
  // 同模型换维度更直接——旧向量是 64 维、新的是 1024 维，
  // 混在一份索引里算 cosine 只会得到一堆 NaN。
  // （dimensions 配 0/空表示「用接口默认值」，那时无从预判，只能按模型名判断。）
  const dimChanged = es.configured && es.dimensions > 0 && old.chunks.length > 0 && old.dim !== es.dimensions;
  const modelChanged = Boolean(es.configured) && (old.model !== es.model || dimChanged);

  // 决定哪些片需要重新算向量
  const next: IndexChunk[] = [];
  for (const w of wanted) {
    const prev = oldById.get(w.id);
    const canReuse = Boolean(
      prev && prev.vec && prev.vec.length > 0 && prev.hash === w.hash && !modelChanged && opts.force !== true,
    );
    next.push({ ...w, vec: canReuse && prev ? prev.vec : null });
  }

  const todo = next.filter((c) => !c.vec);
  let embedded = 0;
  let notice: string | null = null;

  if (todo.length) {
    if (!es.configured) {
      notice = '没有配置向量接口，索引里只有原文，检索将按关键词匹配。想要语义检索就去「设置 → 检索」配一个。';
    } else {
      try {
        const r = await embedTexts(todo.map((c) => c.text));
        for (let i = 0; i < todo.length; i++) todo[i].vec = r.vectors[i];
        embedded = todo.length;
      } catch (e) {
        // 建索引失败不应该让「索引」这件事整体失败：留一份纯文本的索引仍然有用
        const msg = e instanceof Error ? e.message : String(e);
        notice = `向量计算失败，已保存为纯文本索引（检索退化为关键词匹配）。原因：${msg}`;
      }
    }
  }

  const nextIds = new Set(next.map((c) => c.id));
  const removed = old.chunks.filter((c) => !nextIds.has(c.id)).length;

  const file: SearchIndexFile = {
    version: INDEX_VERSION,
    model: es.configured ? es.model : '',
    dim: next.find((c) => c.vec)?.vec?.length ?? 0,
    builtAt: new Date().toISOString(),
    chunks: next,
  };
  await writeIndex(file);

  const added = next.filter((c) => !oldById.has(c.id)).length;
  return {
    docs: docs.length,
    chunks: next.length,
    added,
    updated: next.length - added,
    removed,
    embedded,
    usedEmbedding: file.chunks.some((c) => c.vec && c.vec.length > 0),
    model: file.model,
    notice,
  };
}

export async function clearIndex(): Promise<void> {
  const root = await requireVaultRoot();
  await fsp.rm(indexFile(root), { force: true });
}

export interface IndexStatus {
  configured: boolean;
  model: string;
  dim: number;
  /** 有向量的片数。可能小于 total（没配 embedding 时为 0） */
  withVector: number;
  total: number;
  docs: number;
  builtAt: string | null;
}

export async function indexStatus(): Promise<IndexStatus> {
  const es = await getEmbedSettings();
  const f = await readIndex();
  const docs = new Set(f.chunks.map((c) => c.docRel)).size;
  return {
    configured: es.configured,
    model: es.model,
    dim: f.dim,
    withVector: f.chunks.filter((c) => c.vec && c.vec.length > 0).length,
    total: f.chunks.length,
    docs,
    builtAt: f.builtAt || null,
  };
}

// ─────────────────────────── 检索 ───────────────────────────

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * 中文没有空格，只能按字 / 二元切。
 * 二元（bigram）比单字准得多：「上下文工程」切成 上下/下文/文工/工程，
 * 既不会因为单字「文」到处命中而稀释，也不用依赖分词库。
 */
export function tokenize(s: string): string[] {
  const out: string[] = [];
  for (const m of s.toLowerCase().match(/[a-z0-9]+/g) ?? []) out.push(m);
  const cjk = s.replace(/[^\u4e00-\u9fff]/g, ' ');
  for (const run of cjk.split(/\s+/)) {
    const r = run.trim();
    if (!r) continue;
    if (r.length === 1) {
      out.push(r);
      continue;
    }
    for (let i = 0; i + 2 <= r.length; i++) out.push(r.slice(i, i + 2));
  }
  return out;
}

/** 数一个词在文本里出现几次。用 indexOf 扫，比先 split 再 filter 省内存。 */
function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i >= 0) {
    n++;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

/**
 * 关键词打分：TF × IDF，再按片段长度做个惩罚，避免长章节靠字数取胜。
 *
 * ★ 为什么还要一道「覆盖率」门槛，而且是用 IDF 加权算的 ★
 *   二元切分出来的词里有大量高频组合（「在的」「这个」），只靠 IDF 压不住：
 *   搜「zzz不存在的词zzz」会命中所有含「存在的」的段落，用户只会觉得检索坏了。
 *
 *   第一版按「命中了几个词」卡，失败得很典型：查询切成 不存/存在/在的/的词，
 *   而原文里一句「存在的」就同时命中了「存在」和「在的」两个词——
 *   它们根本不是两份独立证据，只是同一个三字串的两个重叠切片。
 *   所以改成按 IDF 加权算覆盖率：漏掉一个罕见词（「不存」「的词」）代价极高，
 *   而靠「在的」这种常见词凑数几乎攒不出分。
 *
 *   阈值取 0.5，是在真实笔记库上扫出来的：
 *     0.34 → 垃圾查询还剩 21 条；0.45 → 垃圾查询清零，真查询一条没少；
 *     0.65 → 真查询「上下文工程」从 100 条掉到 48 条，开始误伤。
 *   所以可用区间是 0.45~0.55，取中间值 0.5 留两边余量。
 *   整串被完整包含时直接放行——用户搜的就是原文里的一句话，没理由再卡它。
 */
function keywordSearch(chunks: IndexChunk[], q: string, topK: number): Map<string, number> {
  const terms = [...new Set(tokenize(q))].slice(0, 16);
  const lower = chunks.map((c) => c.text.toLowerCase());
  const phrase = q.trim().toLowerCase();

  const df = terms.map((t) => lower.reduce((n, txt) => (txt.includes(t) ? n + 1 : n), 0));
  const idf = df.map((d) => Math.log(1 + chunks.length / (1 + d)));
  const idfSum = idf.reduce((a, b) => a + b, 0) || 1;

  const scores = new Map<string, number>();
  for (let i = 0; i < chunks.length; i++) {
    let s = 0;
    let covered = 0;
    for (let t = 0; t < terms.length; t++) {
      const tf = countOccurrences(lower[i], terms[t]);
      if (tf) {
        s += (1 + Math.log(tf)) * idf[t];
        covered += idf[t];
      }
    }
    if (!s) continue;
    if (covered / idfSum < COVERAGE_MIN && !lower[i].includes(phrase)) continue;
    scores.set(chunks[i].id, s / (1 + Math.log(1 + chunks[i].text.length)));
  }

  // 再砍掉「比最好的那条差太多」的，避免列表里挂着一堆勉强沾边的
  const best = Math.max(0, ...scores.values());
  if (best > 0) {
    for (const [id, v] of [...scores]) {
      if (v < best * 0.2) scores.delete(id);
    }
  }
  return topN(scores, topK);
}

function topN(scores: Map<string, number>, topK: number): Map<string, number> {
  const arr = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, topK);
  return new Map(arr);
}

/**
 * 生成显示用片段。关键词模式下尽量把命中处挪到中间，让人一眼看到为什么是这条。
 *
 * ★ 只压水平空白，不动换行 ★
 *   换行是 markdown 的语法（列表项、标题、代码块全靠它）。以前把 \s+ 全压成空格，
 *   片段就成了一坨纯文本，既没法渲染，读起来也不像原文。
 */
function snippetOf(text: string, terms: string[], mode: 'vector' | 'keyword'): string {
  const flat = text.replace(/[ \t]+/g, ' ').trim();
  const LIMIT = 300;
  if (flat.length <= LIMIT) return flat;

  if (mode === 'keyword') {
    const low = flat.toLowerCase();
    let at = -1;
    for (const t of terms) {
      const i = low.indexOf(t);
      if (i >= 0 && (at < 0 || i < at)) at = i;
    }
    if (at >= 0) {
      const start = Math.max(0, at - 60);
      return (start > 0 ? '…' : '') + flat.slice(start, start + LIMIT) + (start + LIMIT < flat.length ? '…' : '');
    }
  }
  return flat.slice(0, LIMIT) + '…';
}

let mdSingleton: ReturnType<typeof createMd> | null = null;

/**
 * 把一小段 markdown 渲染成 HTML（检索片段和问答回答都走它）。
 *
 * 必须用 createMd 而不是自己 new MarkdownIt：那边 html:false，
 * 原始 HTML 不会被当标签解析，所以前端 dangerouslySetInnerHTML 插入它是安全的。
 * 实例只建一次——markdown-it 的构造不算便宜，而检索一次要渲染几十条。
 */
export function renderMdInline(md: string): string {
  if (!mdSingleton) mdSingleton = createMd();
  return mdSingleton.render(md);
}

export interface SearchOutcome {
  hits: SearchHit[];
  mode: 'vector' | 'keyword';
  /** 需要告诉用户的话（降级原因等） */
  notice: string | null;
}

export async function search(q: string, topK = 8): Promise<SearchOutcome> {
  const query = q.trim();
  if (!query) throw new ApiError(400, '请输入要检索的内容', 'bad_request');

  const f = await readIndex();
  if (!f.chunks.length) {
    throw new ApiError(409, '检索索引还是空的。请先在「检索」页点一下「重建索引」。', 'index_empty');
  }

  const terms = [...new Set(tokenize(query))].slice(0, 16);
  const es = await getEmbedSettings();
  let scores: Map<string, number> | null = null;
  let notice: string | null = null;
  let mode: 'vector' | 'keyword' = 'keyword';

  if (es.configured && f.chunks.some((c) => c.vec && c.vec.length > 0)) {
    try {
      const r = await embedTexts([query]);
      const qv = r.vectors[0];
      const s = new Map<string, number>();
      for (const c of f.chunks) {
        if (!c.vec || c.vec.length !== qv.length) continue;
        s.set(c.id, cosine(qv, c.vec));
      }
      scores = topN(s, topK);
      mode = 'vector';
    } catch (e) {
      notice = `向量检索失败，已改用关键词匹配。原因：${e instanceof Error ? e.message : String(e)}`;
    }
  } else if (!es.configured) {
    notice = '未配置向量接口，当前是关键词匹配（按字面找，不做语义联想）。';
  } else {
    notice = '索引里还没有向量，当前是关键词匹配。重新建一次索引就会切到语义检索。';
  }

  if (!scores) scores = keywordSearch(f.chunks, query, topK);

  const byId = new Map(f.chunks.map((c) => [c.id, c]));
  const hits: SearchHit[] = [];
  for (const [id, score] of scores) {
    const c = byId.get(id);
    if (!c) continue;
    const snippet = snippetOf(c.text, terms, mode);
    hits.push({
      id: c.id,
      docRel: c.docRel,
      docTitle: c.docTitle,
      headingId: c.headingId,
      headingText: c.headingText,
      headingPath: c.headingPath,
      part: c.part,
      startBi: c.startBi,
      score,
      snippet,
      html: renderMdInline(snippet),
      text: c.text,
    });
  }
  return { hits, mode, notice };
}
