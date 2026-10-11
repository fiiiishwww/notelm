/**
 * server/services/related.ts —— 块级相关性。
 *
 * 给定「我现在正在看的这一块」，找出**别的文章**里最相关的若干块。
 * 和检索（search）的区别：检索是「我输入问题 → 你给答案」，
 * 这里是「我在读 → 你告诉我别处还有谁在讲同一件事」，不需要用户输入任何东西。
 *
 * ★ 两代算法的差别（V1 词面 → V2 语义 + 短语证据）★
 *
 * V1 只用词面：中心取 12 个 IDF 最高的中文 bigram，按 IDF 加权求和。
 * 在真实笔记库上跑出来有三个硬伤，都不是调权重能救的：
 *
 *   1. **bigram 会把词切碎，接缝碎片还会拿到很高的 IDF。**
 *      「事件工具」切出 `件工`，「上下文工程」切出 `文工`。
 *      两个段落只要碰巧共享这种接缝，就被算成一条强证据——
 *      「工具的分类」和「Coding Agent 与通用 Agent」能靠 `件工` 连起来。
 *      而「共享词」那一栏写的是 `件工 索文 础能`，用户根本读不懂。
 *   2. **没有语义。** 一段话讲「上下文被塞满后怎么办」，另一段讲「上下文窗口溢出的处理」，
 *      词面几乎不重叠，但人一眼就知道该放一起。词面天花板就在这里。
 *   3. （已另行修复）分片共用章节的 startBi，点进去落在节首，
 *      和面板上预览的那段话对不上，观感就是「它算错了」。
 *
 * V2 的做法：
 *   - **语义为主**：中心窗口现场算一次向量（有 LRU 缓存，滑动阅读不会每帧都调接口），
 *     和索引里现成的分片向量算 cosine。索引本来就是为检索建的，这里等于白捡。
 *   - **词面只做两件事**：给语义分做补充，以及**产出人看得懂的证据**——
 *     改成「连续共享 ≥ 4 字」的片段。接缝碎片最多 2 字，天然被滤掉，
 *     留下的都是「上下文压缩」「Harness Engineering」这种真短语。
 *   - 会画线的连接必须有证据：语义再像，也把命中的短语写出来给人看。
 *
 * ★ 保留的四条在真实库上撞出来的规则（别删）★
 *   1. 每个文档只出一个最强块——库里常有同一份内容的副本，
 *      不去重 Top-N 会被同一段话占满。每文档一个还顺带保证 N 个方向 = N 个不同来源。
 *   2. 跨文档不能比标题树的「位置」，只能比标题的「文字」。
 *   3. 词面模式下共享证据少于一条短语就不算相关。
 *   4. 通用标题（小结/思考题/前言…）不参与重复判定，否则不同文章的「总结」会互相顶掉。
 */

import { buildIndex, cosine, readIndex, tokenize, type IndexChunk } from './vectorstore';
import { readDoc } from '../vault';
import { analyzeDocument, headingPathOf } from '../../shared/blocks';
import { embedTexts, getEmbedSettings } from './embed';

export interface RelatedItem {
  id: string;
  docRel: string;
  docTitle: string;
  headingText: string;
  headingPath: string[];
  /** 跳回正文用：目标块在目标文档里的块下标（分片级，不是章节级） */
  startBi: number;
  /** 0~1，已经按本轮最高分归一化过 */
  score: number;
  /** 证据：中心与目标**连续共享**的短语（≥4 字），最多几个 */
  shared: string[];
  /** 预览文本，已去掉 Markdown 标记；有共享短语时会从短语附近截 */
  snippet: string;
}

export interface RelatedCenter {
  docRel: string;
  docTitle: string;
  headingText: string;
  startBi: number;
}

/** 'semantic' = 有向量参与；'lexical' = 没配向量接口或这次没算出来，纯词面 */
export type RelatedMode = 'semantic' | 'lexical';

export interface RelatedResult {
  center: RelatedCenter | null;
  items: RelatedItem[];
  mode: RelatedMode;
  /** 需要告诉用户的话（索引是空的、向量退化了之类） */
  notice: string | null;
}

/** 中心窗口的长度（字）。太短签名词不够，太长又会把整章都搅进来。 */
const WINDOW_CHARS = 900;
/** 中心窗口相对当前块的起点偏移：略微往前带一点，把刚读过的上文也算进来。 */
const WINDOW_LEAD = 3;
/** 共享片段的长度门槛。中文 bigram 接缝最多 2 字，4 字起基本只剩真短语。 */
const SHARE_MIN = 4;
/** 语义分与词面分的权重。语义为主——词面的天花板见文件头。 */
const W_SEM = 0.62;
const W_LEX = 0.38;
/** 标题文字亲和的加成上限。只当调味，见规则 2。 */
const W_TITLE = 0.08;
/** 语义召回阶段最多保留多少个候选进精算（每文档一个）。 */
const RECALL = 80;
/** 语义模式下低于「本轮最高分 × 这个比例」的直接丢掉，避免凑数。 */
const SEM_FLOOR = 0.72;
/** 展示用证据的最低稀有度。低于它的短语（「Agent 的」）照旧参与打分，但不摆给用户看。 */
const EVIDENCE_RARITY = 2;
/** 签名词个数（词面模式召回用）。 */
const SIG_SIZE = 12;
/** 词面模式下共享 bigram 的门槛，见规则 3。 */
const MIN_SHARED = 2;
/** 这些标题太通用，不能拿来判断「是不是同一份内容的副本」。 */
const GENERIC_TITLES = new Set([
  '开篇', '前言', '引言', '序', '概述', '简介', '小结', '总结', '本章小结', '结论', '思考题', '参考资料', '附录',
]);

// ───────────────────────── 词面（召回 + 证据） ─────────────────────────

export interface Corpus {
  /** 词 → 出现在几个块里（算 IDF 用） */
  df: Map<string, number>;
  /** 词 → 出现在几个**文档**里。签名词必须 ≥2，否则这个词连不出去 */
  docDf: Map<string, number>;
  /** chunkId → 该块的词频表。预计算并缓存，避免每次请求重新切 2000+ 块 */
  tfs: Map<string, Map<string, number>>;
  idf: Map<string, number>;
}

/**
 * 语料缓存。
 * key 用「建索引时间 + 块数」，索引一变就自动失效。
 * 不缓存的话每次请求都要重新 tokenize 两千多个块，实测几百毫秒，滑动阅读时会卡。
 */
let cached: { key: string; corpus: Corpus } | null = null;

function buildCorpus(chunks: IndexChunk[]): Corpus {
  const df = new Map<string, number>();
  const docDf = new Map<string, number>();
  const tfs = new Map<string, Map<string, number>>();
  const byDoc = new Map<string, Set<string>>();

  for (const c of chunks) {
    const tf = new Map<string, number>();
    for (const t of tokenize(c.text)) tf.set(t, (tf.get(t) ?? 0) + 1);
    tfs.set(c.id, tf);

    let seen = byDoc.get(c.docRel);
    if (!seen) byDoc.set(c.docRel, (seen = new Set()));
    for (const t of tf.keys()) {
      df.set(t, (df.get(t) ?? 0) + 1);
      seen.add(t);
    }
  }
  for (const set of byDoc.values()) {
    for (const t of set) docDf.set(t, (docDf.get(t) ?? 0) + 1);
  }

  const n = chunks.length;
  const idf = new Map<string, number>();
  for (const [t, d] of df) idf.set(t, Math.log(1 + n / (1 + d)));
  return { df, docDf, tfs, idf };
}

export function getCorpus(chunks: IndexChunk[], key: string): Corpus {
  if (cached && cached.key === key) return cached.corpus;
  const corpus = buildCorpus(chunks);
  cached = { key, corpus };
  return corpus;
}

/** 取一段文本里最能代表它的几个词：TF 加权的 IDF 最高的那些。 */
function signature(tf: Map<string, number>, corpus: Corpus): { w: string; w8: number }[] {
  const out: { w: string; w8: number }[] = [];
  for (const [w, n] of tf) {
    // 只保留在 ≥2 个文档里出现过的词：连不出去的词不该占签名位。
    if ((corpus.docDf.get(w) ?? 0) < 2) continue;
    out.push({ w, w8: (corpus.idf.get(w) ?? 1) * (1 + Math.log(n)) });
  }
  out.sort((a, b) => b.w8 - a.w8);
  return out.slice(0, SIG_SIZE);
}

/** 词面召回分（只用 bigram，够快，精度交给后面的短语精算）。 */
function lexicalScore(
  sig: { w: string; w8: number }[],
  candTf: Map<string, number>,
  candLen: number,
): { norm: number; shared: number } {
  let s = 0;
  let hits = 0;
  for (const { w, w8 } of sig) {
    const tf = candTf.get(w);
    if (!tf) continue;
    s += w8 * (1 + Math.log(tf));
    hits++;
  }
  if (!hits) return { norm: 0, shared: 0 };
  return { norm: s / (1 + Math.log(1 + candLen)), shared: hits };
}

// ───────────────────────── 短语证据 ─────────────────────────

/** 压平空白（保留标点），让跨行的短语能连起来比。 */
export function flatten(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * 找出 b 里所有「与 a 连续共享、长度 ≥ min」的片段。
 *
 * 这是 V2 替代 bigram 的关键：要求连续共享 4 个字以上，
 * 「事件|工具」这类跨词接缝（只有 2 字）自然落选，
 * 剩下的「上下文压缩」「记忆文件」既是有效证据，也刚好能读给人听。
 * 返回的 at 是片段在 b 中的字符偏移，用来把预览和跳转落点都挪到那一句上。
 *
 * ★ 调用前必须把两边都转成小写 ★
 *   不然「Coding Agent」和「coding Agent」只从「oding Agent」开始对得上，
 *   证据栏里就会冒出 `oding Agent`、`nt 的`、`ation` 这种半截词。
 *   位置偏移不受影响（拉丁字母转小写不改变长度）。
 */
export function sharedSpans(a: string, b: string, min = SHARE_MIN): { text: string; at: number }[] {
  if (a.length < min || b.length < min) return [];
  const set = new Set<string>();
  for (let i = 0; i + min <= a.length; i++) set.add(a.slice(i, i + min));

  const out: { text: string; at: number }[] = [];
  let i = 0;
  while (i + min <= b.length) {
    if (!set.has(b.slice(i, i + min))) {
      i++;
      continue;
    }
    // 贪心向右延伸：只要「以 j 结尾、长度 min」的窗口也出现在 a 里，就能再长一个字
    let j = i + min;
    while (j < b.length && set.has(b.slice(j - min + 1, j + 1))) j++;
    // ★ 单词中间切出来的片段要丢掉 ★
    //   「Encoding Agent」和「Coding Agent」会共享 `oding Agent`，
    //   它是连续 11 个字符的真匹配，却毫无意义，还会被当成强证据。
    //
    // ★ 判据必须「两侧同时是拉丁字母/数字」★
    //   2026-09-16 修：原来只看片段外侧那一个字符，结果
    //   「…阈值默认取 3000 tokens…」对「…阈值默认取 12000 tokens…」时，
    //   共享片段会延伸到数字前停下（窗口里出现 "1200" 就匹配不上了），
    //   外侧正好是数字 '1' → 被判成「切在词中间」→ **整段 483 字的共享全被丢弃**。
    //   表现是两段几乎一模一样的文字，sharedSpans 返回 0 条，
    //   于是矛盾检测一条都生不出来，检索的相关性证据也凭空消失。
    //   数字结尾的共享片段是正常句子边界，不是半截词——所以这里要两端一起看：
    //   只有「内侧也是拉丁字母/数字」才说明真的切在词中间（`oding` 两侧都是字母）。
    //   另注意 i === 0 的情况：分片是按字数硬切的，正文开头可能正好是某个单词的
    //   后半截（实测有片子开头就是 `oding Agent`，Coding 的 C 留在了上一片），
    //   这种无法判断是否完整，一律按切词处理。
    const A2 = /[a-z0-9]/;
    const cutLeft = i > 0 ? A2.test(b[i - 1]) && A2.test(b[i]) : A2.test(b[0] ?? '');
    const cutRight = j < b.length ? A2.test(b[j]) && A2.test(b[j - 1]) : false;
    if (cutLeft || cutRight) {
      i = j;
      continue;
    }
    out.push({ text: b.slice(i, j), at: i });
    i = j;
  }
  return out;
}

/** 掐掉短语首尾的标点空白，证据栏里只留能读的部分（「。 Agent 会」→「Agent 会」）。 */
export function trimEdges(s: string): string {
  return s
    .replace(/^[\s，。、；：！？（）「」『』【】《》“”‘’\-—…·,.;:!?()[\]"'`~*_>#|/\\]+/, '')
    .replace(/[\s，。、；：！？（）「」『』【】《》“”‘’\-—…·,.;:!?()[\]"'`~*_>#|/\\]+$/, '');
}

/**
 * 合并「同一句话里重复出现」的片段，并丢掉完全被更长片段包含的那些。
 * 不合并的话，一段话里出现 4 次 Harness 就会贡献 4 份证据，
 * 权重被同一个词刷上去，列表里也会出现 4 条一模一样的「Harness」。
 *
 * ★ text 一定要原样保留（不能 trim）★
 *   去重用的 key 可以 trim，但 text 必须与 at 保持对应，
 *   否则展示时 body.slice(at, at + text.length) 会整体错位一个字符——
 *   表现就是证据栏里出现 `Sandbo`、`OpenCla` 这种「末尾少一个字」的词。
 */
export function mergeSpans(spans: { text: string; at: number }[]): { text: string; at: number }[] {
  const byText = new Map<string, { text: string; at: number }>();
  for (const s of spans) {
    const key = s.text.trim();
    if (key.length < SHARE_MIN) continue;
    const prev = byText.get(key);
    if (!prev || s.at < prev.at) byText.set(key, { text: s.text, at: s.at });
  }
  const list = [...byText.values()].sort((a, b) => a.at - b.at);
  // 去包含：如果某个片段整体出现在另一个更长的片段里，它没有独立价值
  return list.filter((s) => {
    const me = s.text.trim();
    return !list.some((o) => o !== s && o.text.trim().length > me.length && o.text.includes(me));
  });
}

/**
 * 单个短语的稀有度：内部 token 的平均 IDF。
 *
 * ★ 孤立汉字不能算 ★
 *   tokenize 对「些 agent」只切得出单字「些」（中文部分被英文隔开了），
 *   而单字在中文语料里 df 天然虚低——「些」几乎总是以「一些」「这些」的
 *   bigram 形态出现，单字形态屈指可数，于是 idf 虚高到 3.7，
 *   比「Memory」「结果验证」还"稀有"。这条规则把它挡掉。
 */
export function spanRarity(text: string, idf: Map<string, number>): number {
  let sum = 0;
  let n = 0;
  for (const t of tokenize(text)) {
    if (t.length === 1 && /[\u4e00-\u9fff]/.test(t)) continue;
    sum += idf.get(t) ?? 0;
    n++;
  }
  return n ? sum / n : 0;
}

/**
 * 短语证据的分数：越长越值钱，但最要紧的是**稀有度**。
 *
 * ★ 这里踩过一次坑，别再改回去 ★
 *   第一版只看长度：4 字以上就算一条证据。结果「Agent 的」「的 Agent」这类
 *   到处都是的片段拿满分，选出来的段落全是噪音——
 *   等于把 bigram 噪音升级成了 4-gram 噪音，问题一点没解决。
 *   所以用短语内部所有 bigram 的**平均 IDF** 加权：
 *   「Agent 的」里 agent 满地都是、idf 趋近 0；「上下文压缩」里每个 bigram 都稀罕，
 *   两者的权重能差一个数量级，这才分得开。
 */
function spanWeight(spans: { text: string; at: number }[], idf: Map<string, number>): number {
  let s = 0;
  for (const x of spans) {
    const L = Math.min(x.text.length, 24);
    s += (L - SHARE_MIN + 1) * (1 + Math.log(1 + L / 4)) * spanRarity(x.text, idf);
  }
  return s;
}

/** 标题文字重合度。跨文档时只能比文字，不能比树的位置（规则 2）。 */
function titleAffinity(a: string[], b: string[]): number {
  const ta = new Set(a.join(' ').match(/[a-z0-9]+|[\u4e00-\u9fff]{2}/gi) ?? []);
  const tb = new Set(b.join(' ').match(/[a-z0-9]+|[\u4e00-\u9fff]{2}/gi) ?? []);
  if (!ta.size || !tb.size) return 0;
  let n = 0;
  for (const t of ta) if (tb.has(t)) n++;
  return n / Math.min(ta.size, tb.size);
}

/** 去掉 Markdown 标记，压平空白。 */
export function plain(text: string): string {
  return flatten(
    text
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[*`_>~]/g, ''),
  );
}

/** 从共享短语附近截预览：让用户一眼看到「是这句话相关」，而不是片段开头。 */
function snippetAround(flat: string, at: number, spanLen: number, n = 150): string {
  if (flat.length <= n) return flat;
  const before = Math.max(0, Math.floor((n - Math.min(spanLen, n)) / 2));
  const start = Math.max(0, Math.min(at - before, flat.length - n));
  return (start > 0 ? '…' : '') + flat.slice(start, start + n) + (start + n < flat.length ? '…' : '');
}

/**
 * 挑给用户看的证据：又长又稀有的排前面，并滤掉两类不值一看的：
 *   - 稀有度低于 EVIDENCE_RARITY 的（「Agent 的」「这意味着」这类满地都是的）
 *   - 权重远低于本轮最强证据的
 * 全都被卡掉时返回空——宁可让界面写「语义相近，没有共同短语」，
 * 也不要硬塞一条「些 Agent」假装有证据。
 */
function pickEvidence(
  spans: { text: string; at: number }[],
  body: string,
  idf: Map<string, number>,
  max = 4,
): string[] {
  const rows = spans
    .map((s) => ({ s, w: s.text.trim().length * spanRarity(s.text, idf) }))
    .sort((a, b) => b.w - a.w);
  if (!rows.length) return [];

  const top = rows[0].w || 1;
  if (process.env.REL_DBG) {
    for (const x of rows.slice(0, 8)) {
      console.log(
        '[dbg]',
        JSON.stringify(x.s.text),
        'at=', x.s.at,
        'rarity=', spanRarity(x.s.text, idf).toFixed(2),
        'w=', x.w.toFixed(1),
        'slice=', JSON.stringify(body.slice(x.s.at, x.s.at + x.s.text.length)),
      );
    }
  }
  return rows
    .filter((x) => spanRarity(x.s.text, idf) >= EVIDENCE_RARITY && x.w >= top * 0.3)
    .slice(0, max)
    .map((x) => trimEdges(body.slice(x.s.at, x.s.at + x.s.text.length)))
    .filter(Boolean);
}

// ───────────────────────── 中心向量缓存 ─────────────────────────

/**
 * 中心窗口的向量缓存。
 * 滚动阅读时每停一下就换一次中心，如果每次都打接口，一是慢二是费。
 * key 用文本本身（滑到同一处会命中），容量很小、命中率却不低——
 * 因为窗口是「往后取 900 字」，连续两次停下的窗口常常大面积重叠。
 */
const VEC_CACHE = new Map<string, number[]>();
const VEC_CACHE_MAX = 48;

/**
 * 向量接口「暂时不可用」的冷却截止时间。
 * 接口挂了的时候，滚动阅读会一个接一个地发请求、一个接一个地超时，
 * 每次都要等几百毫秒才降级——体验比直接走词面差得多。
 * 失败一次就静默走词面 60 秒，期间不再试。
 */
let semDownUntil = 0;

async function centerVector(flat: string): Promise<number[]> {
  const key = `${flat.length}|${flat.slice(0, 80)}|${flat.slice(-80)}`;
  const hit = VEC_CACHE.get(key);
  if (hit) return hit;
  const r = await embedTexts([flat]);
  const v = r.vectors[0];
  if (VEC_CACHE.size >= VEC_CACHE_MAX) {
    const oldest = VEC_CACHE.keys().next().value;
    if (oldest !== undefined) VEC_CACHE.delete(oldest);
  }
  VEC_CACHE.set(key, v);
  return v;
}

// ───────────────────────── 主流程 ─────────────────────────

interface Scored {
  c: IndexChunk;
  sem: number;
  spans: { text: string; at: number }[];
  total: number;
  /** 去掉 Markdown 标记后的正文。预览截取和落点折算都以它为准，保证两者一致 */
  body?: string;
}

export async function relatedBlocks(rel: string, bi: number, topK = 5): Promise<RelatedResult> {
  let notice: string | null = null;
  let f = await readIndex();

  // 索引是空的就现建一个。
  if (!f.chunks.length) {
    await buildIndex();
    f = await readIndex();
    notice = '检索索引还是空的，已经自动建了一份。';
  }

  // 老索引里的分片没有 partFrom（跳转只能回到章节首块，会和预览对不上）。
  // 增量重建一次即可——向量按内容 hash 复用，不会重新调接口。
  if (f.chunks.some((c) => typeof c.partFrom !== 'number')) {
    try {
      await buildIndex();
      f = await readIndex();
    } catch {
      /* 重建失败就退回章节级落点，功能不至于不可用 */
    }
  }

  const chunks = f.chunks;

  // ★ 中心内容不取索引里的 chunk，而是从当前文档实时分析出一段窗口 ★
  //   索引的最小单位是「学习单元 + 分片」，一个单元可能横跨上百个块
  //   （实测 chapter5 有 337 个块却只有 5 个单元）。
  //   用索引块当中心，读者在半章之内滚动时中心一动不动，相关性永远不变——
  //   看上去就像功能坏了。所以中心是「以当前块为起点往后约一节」的实时窗口。
  const doc = await readDoc(rel);
  const a = analyzeDocument(doc.markdown);
  const blocks = a.blocks;
  if (!blocks.length) return { center: null, items: [], mode: 'lexical', notice };

  const from = Math.max(0, Math.min(bi, blocks.length - 1) - WINDOW_LEAD);
  let to = from;
  let len = 0;
  while (to < blocks.length && len < WINDOW_CHARS && to - from < 32) {
    len += blocks[to].text.length + 1;
    to++;
  }
  const centerText = blocks.slice(from, to).map((b) => b.text).join('\n');

  // 中心所属单元：只用于界面显示「你现在看的是哪一节」
  let unit = a.units[0];
  for (const u of a.units) if (u.startBi <= bi && u.startBi >= unit.startBi) unit = u;
  const center: RelatedCenter = {
    docRel: rel,
    docTitle: rel.split('/').pop()?.replace(/\.(md|markdown|txt)$/i, '') ?? rel,
    headingText: unit?.headingText ?? '',
    startBi: from,
  };
  const centerPath = unit ? headingPathOf(a.chapters, unit) : [];

  const flat = flatten(centerText);
  if (flat.length < SHARE_MIN) return { center, items: [], mode: 'lexical', notice };
  const flatLow = flat.toLowerCase();

  // ── 语义：中心现场算一个向量 ──
  const es = await getEmbedSettings();
  let cv: number[] | null = null;
  let mode: RelatedMode = 'lexical';
  if (es.configured && chunks.some((c) => c.vec && c.vec.length > 0) && Date.now() >= semDownUntil) {
    try {
      cv = await centerVector(flat);
      mode = 'semantic';
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      semDownUntil = Date.now() + 60_000; // 见 semDownUntil 的注释
      notice = `向量接口这次没算出来（${msg.slice(0, 120)}），已退回关键词匹配。`;
    }
  } else if (!notice && !es.configured) {
    notice = '没配向量接口，只能按关键词找相关段落；配好之后这里会换成语义匹配。';
  } else if (!notice && Date.now() < semDownUntil) {
    notice = '向量接口刚才报错了，这一分钟内先用关键词匹配。';
  }

  // 语料统计（词频、IDF）。语义模式下也照建——短语证据的稀有度要靠它衡量，
  // 不然「Agent 的」这种满地都是的片段会把权重刷满。建一次就缓存住了。
  const corpus = getCorpus(chunks, `${f.builtAt}#${chunks.length}`);

  // ── 召回：每文档只留最强的那一块（规则 1） ──
  const bestByDoc = new Map<string, Scored>();

  if (cv) {
    let maxSem = 0;
    const rows: Scored[] = [];
    for (const c of chunks) {
      // 维度不一致的向量直接跳过：换过 embedding 配置但索引还没重建时，
      // 硬算 cosine 会得到 NaN，排序结果就成了随机。
      if (c.docRel === rel || !c.vec || c.vec.length !== cv.length) continue;
      const sem = cosine(cv, c.vec);
      if (sem <= 0) continue;
      rows.push({ c, sem, spans: [], total: sem });
      if (sem > maxSem) maxSem = sem;
    }
    const floor = maxSem * SEM_FLOOR;
    rows.sort((x, y) => y.sem - x.sem);
    for (const r of rows) {
      if (r.sem < floor) break;
      if (!bestByDoc.has(r.c.docRel)) bestByDoc.set(r.c.docRel, r);
      if (bestByDoc.size >= RECALL) break;
    }
  } else {
    // 词面降级：先用 bigram 召回，再用短语精算
    const tf = new Map<string, number>();
    for (const t of tokenize(flat)) tf.set(t, (tf.get(t) ?? 0) + 1);
    const sig = signature(tf, corpus);
    if (!sig.length) {
      return { center, items: [], mode, notice: notice ?? '这一段里没找到能和别处连上的词。' };
    }
    const rows: Scored[] = [];
    for (const c of chunks) {
      if (c.docRel === rel) continue;
      const ctf = corpus.tfs.get(c.id);
      if (!ctf) continue;
      const { norm, shared } = lexicalScore(sig, ctf, c.text.length);
      if (norm <= 0 || shared < MIN_SHARED) continue;
      rows.push({ c, sem: 0, spans: [], total: norm });
    }
    rows.sort((x, y) => y.total - x.total);
    for (const r of rows) {
      if (!bestByDoc.has(r.c.docRel)) bestByDoc.set(r.c.docRel, r);
      if (bestByDoc.size >= RECALL) break;
    }
  }

  if (!bestByDoc.size) {
    return { center, items: [], mode, notice: notice ?? '别的文章里没有和这一段足够相关的段落。' };
  }

  // ── 精算：短语证据 + 融合打分 ──
  // 证据和预览都在「去掉 Markdown 标记之后的纯文本」上算，
  // 这样 at 偏移同时能用于截预览和折算落点，不会两边错位。
  let maxSem = 0;
  let maxLex = 0;
  const scored: Scored[] = [];
  for (const row of bestByDoc.values()) {
    const body = plain(row.c.text);
    const spans = mergeSpans(sharedSpans(flatLow, body.toLowerCase()));
    const lex = spanWeight(spans, corpus.idf);
    if (row.sem > maxSem) maxSem = row.sem;
    if (lex > maxLex) maxLex = lex;
    scored.push({ ...row, body, spans, total: lex });
  }

  // 词面模式下没有一条短语证据，说明确实找不到真相关的段落——
  // 与其凑 5 条「碰巧有相同词」的，不如老实说没有（规则 3）。
  // 语义模式不设词面门槛：「换一种说法讲同一件事」本来就该被找到。
  const pool = mode === 'semantic' ? scored : scored.filter((s) => s.spans.length > 0);
  if (!pool.length) {
    return { center, items: [], mode, notice: notice ?? '别的文章里没有和这一段足够相关的段落。' };
  }

  for (const s of pool) {
    const sem = maxSem ? s.sem / maxSem : 0;
    const lex = maxLex ? spanWeight(s.spans, corpus.idf) / maxLex : 0;
    const base = mode === 'semantic' ? W_SEM * sem + W_LEX * lex : lex;
    s.total = Math.min(1, base + W_TITLE * titleAffinity(centerPath, s.c.headingPath));
  }

  // ── 排序 + 第二道去重 ──
  // 「每文档一个」挡不住**不同文件里的同一份内容**（同一本书的两种导出、
  // 未拆分的原文和它自己的分片），不处理的话列表里会并排出现两条标题和摘要都一样的条目。
  const seenFp = new Set<string>();
  const seenTitle = new Set<string>();
  const picked: Scored[] = [];
  for (const row of pool.sort((x, y) => y.total - x.total)) {
    const fp = (row.body ?? plain(row.c.text)).slice(0, 40);
    if (seenFp.has(fp)) continue;
    // 同一本书的两种导出切分起点常差几个字，指纹对不上但标题一样。
    // 通用标题不参与，否则不同文章的「总结」会互相顶掉。
    const ht = (row.c.headingText ?? '').trim();
    const titled = ht.length > 0 && !GENERIC_TITLES.has(ht);
    if (titled && seenTitle.has(ht)) continue;
    seenFp.add(fp);
    if (titled) seenTitle.add(ht);
    picked.push(row);
    if (picked.length >= topK) break;
  }

  const items: RelatedItem[] = picked.map((row) => {
    const { c, spans } = row;
    const body = row.body ?? plain(c.text);
    // 最能说明问题的片段 = 又长又稀有的那个。预览也围着它截，
    // 用户看到的那句话就是「为什么它排在前面」。
    const best = spans
      .map((s) => ({ s, w: s.text.length * spanRarity(s.text, corpus.idf) }))
      .sort((x, y) => y.w - x.w)[0]?.s;

    // 落点：分片本身可能长达 1200 字，命中点又常在片中间。
    // 按共享片段的字符位置在分片内按比例折算到块——比「回到章节首块」准得多，
    // 也和下面 snippet 用的是同一个坐标，点进去看到的就是预览那一句。
    const partFrom = c.partFrom ?? c.startBi;
    const partTo = Math.max(partFrom + 1, c.partTo ?? c.startBi + 1);
    let startBi = partFrom;
    if (best && body.length > 0) {
      const r = Math.max(0, Math.min(1, best.at / body.length));
      startBi = Math.min(partTo - 1, partFrom + Math.floor(r * (partTo - partFrom)));
    }

    return {
      id: c.id,
      docRel: c.docRel,
      docTitle: c.docTitle,
      headingText: c.headingText,
      headingPath: c.headingPath,
      startBi,
      score: Math.round(Math.min(1, Math.max(0, row.total)) * 100) / 100,
      shared: pickEvidence(spans, body, corpus.idf),
      snippet: best
        ? snippetAround(body, best.at, best.text.length)
        : body.slice(0, 150) + (body.length > 150 ? '…' : ''),
    };
  });

  return { center, items, mode, notice };
}
