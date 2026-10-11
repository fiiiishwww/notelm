/**
 * server/services/graph.ts —— 派生图谱（社区检测）+ 矛盾检测
 *
 * ★ 这个模块不生成任何内容 ★
 *   llm_wiki 那一类做法是用大模型抽出「概念页」当节点，页面是被创作出来的内容，
 *   一旦落盘就成了第二份真相：原文改了页面不会跟着改，幻觉还会被写死并自我引用。
 *   这里完全不生成节点——节点就是你已经写下的文档，边由相似度算出来。
 *   所以它是**派生产物**：删掉重算即可，不需要任何人维护，也不存在第二份真相。
 *
 * 两件事共用同一批「跨文档相似片段对」，算一次两处受益：
 *   1. 把片对折叠成文档级边 → Louvain 分组 → 社区 / 桥接点 / 孤立点 / 内聚度
 *   2. 在片对里找「讲同一件事但结论对不上」的 → 矛盾候选
 *
 * 全程离线、零大模型调用。
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { readIndex, type IndexChunk } from './vectorstore';
import { getCorpus, mergeSpans, plain, sharedSpans, spanRarity, trimEdges, type Corpus } from './related';
import { readJson, requireVaultRoot, writeFileAtomic } from '../core';

// ───────────────────────── 参数 ─────────────────────────

/** 每片保留最像的几片作为候选边。用 kNN 而不是全局阈值，保证每个节点度数可控。 */
const TOPK = 8;
/** 片对相似度低于这个值就不算「有关系」。太低会让图全连通，Louvain 分不出东西。 */
const PAIR_MIN = 0.55;
/** 文档级边权重下限，滤掉只有一两片偶然相近的弱连接。 */
const EDGE_MIN = 0.04;
/** 折叠时最多累加几对（防止长文档靠片数堆出巨边）。 */
const FOLD_PAIRS = 12;
/** 每个文档最多保留几条边。图太密 Louvain 就分不出东西——实测 27 篇能连出近 200 条边。 */
const KEEP_PER_NODE = 6;
/** 进入矛盾判定的相似度门槛。 */
const CONFLICT_SIM = 0.72;
/** 共享短语的稀有度门槛——决定「这两段确实在讲同一个东西」。 */
const CONFLICT_RARITY = 2;
const MAX_CONFLICTS = 24;
/** 交给 LLM 判定前，候选最多留这么多条（每条一次判定，直接决定花多少 token）。 */
const MAX_POOL = 40;
/** 每条文档边展示几条共享短语 */
const EDGE_EVIDENCE = 3;

// ───────────────────────── 类型 ─────────────────────────

export interface GraphNodeView {
  rel: string;
  title: string;
  chars: number;
  chunks: number;
  community: number;
  degree: number;
}

export interface GraphEdgeView {
  a: number;
  b: number;
  w: number;
  pairs: number;
  top: number;
  evidence: string[];
  cross: boolean;
  sole: boolean;
}

export interface CommunityView {
  id: number;
  members: number[];
  cohesion: number;
  label: string;
}

export interface ConflictSide {
  docRel: string;
  docTitle: string;
  headingText: string;
  startBi: number;
  quote: string;
}

export type ConflictKind = 'number' | 'modal' | 'antonym';

export interface ConflictSignal {
  kind: ConflictKind;
  detail: string;
  weight: number;
}

export interface Conflict {
  a: ConflictSide;
  b: ConflictSide;
  sim: number;
  score: number;
  shared: string[];
  signals: ConflictSignal[];
}

export interface DocGraph {
  builtAt: string;
  mode: 'semantic' | 'lexical';
  notice: string | null;
  nodes: GraphNodeView[];
  edges: GraphEdgeView[];
  communities: CommunityView[];
  isolates: number[];
  bridges: number[];
  conflicts: Conflict[];
  stat: { chunks: number; docs: number; pairs: number; ms: number };
}

// ───────────────────────── 片对生成 ─────────────────────────

/** 一片跨文档的相似片对：i / j 是片在索引里的下标，s 是余弦相似度 */
export interface Pair {
  i: number;
  j: number;
  s: number;
}

/**
 * ★ 让出事件循环 ★
 *   kNN 是纯 CPU 的同步双重循环，2673 片要跑十几秒。中间不让出的话，
 *   这段时间整个服务是**卡死**的——连「进度」都刷不出来，用户只会以为坏了。
 *   每算完一批让一次，别的请求就能插进来（实测让出的总代价不到 5%）。
 */
const yieldLoop = () => new Promise<void>((r) => setImmediate(r));

/**
 * 向量模式：先把所有向量归一化成 Float32Array，再做两两点积。
 *
 * ★ 只连跨文档的片 ★
 *   同一篇文档的片必然互相最相似，不排除的话折叠出来的社区就是「一篇一团」，
 *   等于把目录重画一遍，信息量为零。
 */
export async function pairsSemantic(chunks: IndexChunk[], onTick?: (done: number, total: number) => void): Promise<Pair[]> {
  const dim = chunks.find((c) => c.vec && c.vec.length)?.vec?.length ?? 0;
  if (!dim) return [];
  const n = chunks.length;
  const mat = new Float32Array(n * dim);
  for (let i = 0; i < n; i++) {
    const v = chunks[i].vec;
    if (!v) continue;
    const off = i * dim;
    let sq = 0;
    for (let d = 0; d < dim; d++) sq += v[d] * v[d];
    const inv = sq > 0 ? 1 / Math.sqrt(sq) : 0;
    for (let d = 0; d < dim; d++) mat[off + d] = v[d] * inv;
  }

  const out: Pair[] = [];
  for (let i = 0; i < n; i++) {
    if (i % 200 === 0) {
      onTick?.(i, n);
      await yieldLoop();
    }
    if (!chunks[i].vec) continue;
    const oi = i * dim;
    const bestJ: number[] = [];
    const bestS: number[] = [];
    for (let j = 0; j < n; j++) {
      if (j === i || !chunks[j].vec) continue;
      if (chunks[j].docRel === chunks[i].docRel) continue;
      const oj = j * dim;
      let s = 0;
      for (let d = 0; d < dim; d++) s += mat[oi + d] * mat[oj + d];
      if (s <= PAIR_MIN) continue;
      if (bestJ.length < TOPK) {
        bestJ.push(j);
        bestS.push(s);
      } else {
        let minAt = 0;
        for (let k = 1; k < bestS.length; k++) if (bestS[k] < bestS[minAt]) minAt = k;
        if (s > bestS[minAt]) {
          bestS[minAt] = s;
          bestJ[minAt] = j;
        }
      }
    }
    for (let k = 0; k < bestJ.length; k++) {
      const j = bestJ[k];
      if (j > i) out.push({ i, j, s: bestS[k] });
    }
  }
  onTick?.(n, n);
  return out;
}

/** 词面模式（没配向量时）：用 IDF 加权的稀疏余弦，只算共享了签名词的那些对。 */
async function pairsLexical(chunks: IndexChunk[], corpus: Corpus): Promise<Pair[]> {
  const n = chunks.length;
  const hiDf = Math.max(4, n * 0.4);
  const weights = new Map<string, Map<string, number>>();
  const inv = new Map<string, number[]>();

  for (let i = 0; i < n; i++) {
    const w = new Map<string, number>();
    const tf = corpus.tfs.get(chunks[i].id);
    if (!tf) continue;
    for (const [t, k] of tf) {
      const df = corpus.df.get(t) ?? 0;
      if (df < 2 || df > hiDf) continue;
      const v = (corpus.idf.get(t) ?? 0) * (1 + Math.log(k));
      if (v <= 0) continue;
      w.set(t, v);
      let arr = inv.get(t);
      if (!arr) inv.set(t, (arr = []));
      arr.push(i);
    }
    weights.set(chunks[i].id, w);
  }

  const norm = new Map<string, number>();
  for (const [id, w] of weights) {
    let sq = 0;
    for (const v of w.values()) sq += v * v;
    norm.set(id, Math.sqrt(sq) || 1);
  }

  const out: Pair[] = [];
  for (let i = 0; i < n; i++) {
    if (i % 200 === 0) await yieldLoop();
    const wi = weights.get(chunks[i].id);
    if (!wi || !wi.size) continue;
    const sig = [...wi.entries()].sort((a, b) => b[1] - a[1]).slice(0, 24);
    const acc = new Map<number, number>();
    for (const [t, vi] of sig) {
      const arr = inv.get(t);
      if (!arr || arr.length > 500) continue;
      for (const j of arr) {
        if (j === i || chunks[j].docRel === chunks[i].docRel) continue;
        const vj = weights.get(chunks[j].id)?.get(t);
        if (!vj) continue;
        acc.set(j, (acc.get(j) ?? 0) + vi * vj);
      }
    }
    const ni = norm.get(chunks[i].id) ?? 1;
    const rows: Pair[] = [];
    for (const [j, raw] of acc) {
      const s = raw / (ni * (norm.get(chunks[j].id) ?? 1));
      if (s > PAIR_MIN) rows.push({ i, j, s });
    }
    rows.sort((a, b) => b.s - a.s);
    for (const r of rows.slice(0, TOPK)) if (r.j > i) out.push(r);
  }
  return out;
}

// ───────────────────────── Louvain ─────────────────────────

interface WEdge {
  a: number;
  b: number;
  w: number;
}

/**
 * Louvain 社区检测。纯图算法，跟大模型没有任何关系。
 *
 * 每个节点自成一派 → 反复把节点挪到「能让模块度涨最多」的邻居派里 →
 * 把每一派收缩成一个超级节点，在更大的尺度上再来一遍。
 * 组数不用指定，是从连接结构里自己长出来的。
 */
function louvain(nIn: number, edgesIn: WEdge[], resolution = 1): { comm: number[]; modularity: number } {
  let n = nIn;
  let edges = edgesIn;
  let membership: number[][] = Array.from({ length: n }, (_, i) => [i]);

  for (let level = 0; level < 12; level++) {
    const adj: { to: number; w: number }[][] = Array.from({ length: n }, () => []);
    const self = new Array<number>(n).fill(0);
    for (const e of edges) {
      if (e.a === e.b) {
        self[e.a] += e.w;
        continue;
      }
      adj[e.a].push({ to: e.b, w: e.w });
      adj[e.b].push({ to: e.a, w: e.w });
    }
    const deg = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) {
      let s = self[i] * 2;
      for (const e of adj[i]) s += e.w;
      deg[i] = s;
    }
    const m2 = deg.reduce((a, b) => a + b, 0);
    if (m2 <= 0) break;

    const comm = Array.from({ length: n }, (_, i) => i);
    const totC = deg.slice();

    let moved = true;
    let guard = 0;
    while (moved && guard++ < 40) {
      moved = false;
      for (let i = 0; i < n; i++) {
        const ci = comm[i];
        totC[ci] -= deg[i];
        const wToC = new Map<number, number>();
        for (const e of adj[i]) wToC.set(comm[e.to], (wToC.get(comm[e.to]) ?? 0) + e.w);
        wToC.set(ci, (wToC.get(ci) ?? 0) + self[i]);

        let bestC = ci;
        let bestGain = (wToC.get(ci) ?? 0) - (totC[ci] * deg[i] * resolution) / m2;
        for (const [c, kIn] of wToC) {
          if (c === ci) continue;
          const gain = kIn - (totC[c] * deg[i] * resolution) / m2;
          if (gain > bestGain + 1e-12) {
            bestGain = gain;
            bestC = c;
          }
        }
        comm[i] = bestC;
        totC[bestC] += deg[i];
        if (bestC !== ci) moved = true;
      }
    }

    const remap = new Map<number, number>();
    for (let i = 0; i < n; i++) {
      const c = comm[i];
      if (!remap.has(c)) remap.set(c, remap.size);
    }
    const cnt = remap.size;
    if (cnt === n) {
      const finalComm = new Array<number>(membership.length);
      membership.forEach((members, idx) => {
        for (const m of members) finalComm[m] = remap.get(comm[idx]) ?? idx;
      });
      return { comm: finalComm, modularity: modularityOf(nIn, edgesIn, finalComm) };
    }

    const nextMembers: number[][] = Array.from({ length: cnt }, () => []);
    for (let i = 0; i < n; i++) {
      const c = remap.get(comm[i])!;
      nextMembers[c].push(...membership[i]);
    }
    const agg = new Map<string, number>();
    for (const e of edges) {
      const a = remap.get(comm[e.a])!;
      const b = remap.get(comm[e.b])!;
      const key = a <= b ? `${a}|${b}` : `${b}|${a}`;
      agg.set(key, (agg.get(key) ?? 0) + e.w);
    }
    edges = [...agg.entries()].map(([k, w]) => {
      const [a, b] = k.split('|').map(Number);
      return { a, b, w };
    });
    membership = nextMembers;
    n = cnt;
  }

  const finalComm = new Array<number>(membership.length);
  membership.forEach((members, c) => {
    for (const m of members) finalComm[m] = c;
  });
  return { comm: finalComm, modularity: modularityOf(nIn, edgesIn, finalComm) };
}

function modularityOf(n: number, edges: WEdge[], comm: number[]): number {
  const deg = new Array<number>(n).fill(0);
  const inC = new Map<number, number>();
  const totC = new Map<number, number>();
  let m = 0;
  for (const e of edges) {
    m += e.w;
    deg[e.a] += e.w;
    if (e.a !== e.b) deg[e.b] += e.w;
  }
  if (m <= 0) return 0;
  for (let i = 0; i < n; i++) totC.set(comm[i], (totC.get(comm[i]) ?? 0) + deg[i]);
  for (const e of edges) {
    if (e.a === e.b || comm[e.a] === comm[e.b]) inC.set(comm[e.a], (inC.get(comm[e.a]) ?? 0) + e.w);
  }
  let q = 0;
  for (const c of new Set(comm)) {
    q += (inC.get(c) ?? 0) / m - Math.pow((totC.get(c) ?? 0) / (2 * m), 2);
  }
  return q;
}

// ───────────────────────── 矛盾判定 ─────────────────────────

const MODAL_UP = /最多|上限|不超过|至多|最高|最大|不大于|不得超/;
const MODAL_DOWN = /至少|最少|不低于|最低|最小|不小于/;

/**
 * 反义对。只收两字以上的实词，单字（有/无）噪音太大。
 * 这是「同一个对象被说成两种相反属性」最直接的证据。
 */
const ANTONYMS: [string, string][] = [
  ['串行', '并行'],
  ['同步', '异步'],
  ['有状态', '无状态'],
  ['阻塞', '非阻塞'],
  ['持久化', '临时'],
  ['增量', '全量'],
  ['本地', '云端'],
  ['离线', '在线'],
  ['同步执行', '并行执行'],
  ['允许', '禁止'],
  ['推荐', '不推荐'],
  ['建议', '避免'],
  ['支持', '不支持'],
  ['启用', '禁用'],
  ['开启', '关闭'],
  ['必须', '不能'],
  ['必须', '禁止'],
  ['需要', '无需'],
  ['建议', '不建议'],
  ['应该', '不应该'],
  ['可以', '不可以'],
];

/**
 * 这个短语能不能拿给人看。
 *
 * ★ 三样东西必须挡掉，都是实测里真出现过的 ★
 *   - 附件路径：两篇都贴了同一张「微信截图\20240922180616\.png」，相似度极高却毫无意义
 *   - 跨词接缝：「的 token」「为零，只」——长度够了，但不是一个说法
 *   - 带句读的片段：说明它跨过了句子边界，不是同一句话里的同一个东西
 */
export function isCleanPhrase(p: string): boolean {
  if (p.length < 4) return false;
  if (/[\\{}|<>]|\.(png|jpe?g|gif|webp|svg)/i.test(p)) return false;
  if (/[，。；！？、]/.test(p)) return false;
  // 首尾是虚词说明它切在了词与词的接缝上，不是一个「说法」。
  // 尾部这一组实测漏过「Skill 时」——A 是「每次调用新 Skill 时回头改写上下文」，
  // B 是「判断需要某个 Skill 时加载完整内容」，靠这个接缝把两件不相干的事锁在了一起。
  // 只加尾部，不加首部：中文里「上下文压缩」「内容安全」这类正常名词就是以
  // 上/下/内 开头的，首部加虚词会把它们一起误伤。
  const FN = '的了是在和这那有也就而或与把被从到为以对及等很更最只才还却让向于时后前中里内外上下过之者些该们';
  if (/^[的了是在和这那有也就而或与把被从到为以对及等很更最只才还却让向于]/.test(p)) return false;
  if (new RegExp(`[${FN}]$`).test(p)) return false;
  return true;
}

/** 数后面跟的量词/单位——只有认得出量词，才说明这个数字在说「一个量」。 */
const UNIT_NOUN =
  /^\s*(%|％|倍|条|个|次|轮|层|维|步|秒|毫秒|ms|分钟|小时|天|tokens?|字|字符|张|份|篇|节|批|组|类|种|项|行|列|块|片|位|元|万|亿)/i;
/** 紧跟量词后面的分母：「180 tokens/ms」「30 tokens 每秒」——这半截以前被整段丢掉了。 */
const UNIT_PER = /^\s*(?:\/\s*|\s*每\s*)(s|秒|ms|毫秒|min|分钟|h|小时|天|token|tokens|字)/i;
/** 数前面跟的量词/界限词：「最多 10 条」「上限为 16」这种才是真正的断言 */
const UNIT_BEFORE =
  /(最多|上限|不超过|至多|至少|最少|不低于|不小于|约为|大约|左右|超过|小于|大于|等于|支持|允许|限制|默认|取值|设为)[^\d]{0,4}$/;

/**
 * 判断一个数字到底「是什么量」，返回可比较的单位键；判断不出来就返回 null。
 *
 * ★ 分母必须一起算 ★
 *   实测漏了这条，报出一条毫无意义的「矛盾」：
 *     vLLM 那段写「Prefill 阶段在 B×L≥512 时就能达到巅峰吞吐量 180 tokens/ms」，
 *     Qwen3 那段写「为了满足人类的阅读速度需要每秒 ~30 tokens」。
 *   分子都是 tokens，于是被判成同一个单位、同一个量，直接报警。
 *   一个是每毫秒、一个是每秒，而且还分属「吞吐量」与「阅读体验」两个话题——
 *   **分子相同不代表同一个量**。
 */
function unitAt(sentence: string, idx: number, len: number): string | null {
  const tail = sentence.slice(idx + len, idx + len + 24);
  const m = UNIT_NOUN.exec(tail);
  if (m) {
    let unit = m[1].toLowerCase();
    const per = UNIT_PER.exec(tail.slice(m[0].length));
    if (per) unit += `/${per[1].toLowerCase()}`;
    return unit;
  }
  const b = UNIT_BEFORE.exec(sentence.slice(Math.max(0, idx - 12), idx));
  return b ? `#${b[1]}` : null;
}
function shares(a: Set<string>, b: Set<string>): boolean {
  for (const x of a) if (b.has(x)) return true;
  return false;
}

/**
 * 抓「带版本的实体名」：K2 / K3 / GPT-4 / Qwen3 / DeepSeek-V4。
 *
 * ★ 两边主语不是同一个东西时不能判矛盾 ★
 *   实测：「Kimi K3 是 2.8 万亿参数的混合专家」对「Kimi K2 是 1 万亿参数的…」——
 *   数值确实不同，但那是两个模型，不是同一个论断的两种说法。
 */
function versionTokens(s: string): Set<string> {
  const out = new Set<string>();
  for (const m of s.matchAll(/[A-Za-z][A-Za-z0-9]*[-\s]?\d+(?:\.\d+)?/g)) {
    out.add(m[0].replace(/\s+/g, '').toLowerCase());
  }
  return out;
}

/** 短语前后各取一段作为判定窗口（不再用整句）。pad 越小，判定越严。 */
function windowAround(sentence: string, pos: number, len: number, pad = 22): string {
  return sentence.slice(Math.max(0, pos - pad), Math.min(sentence.length, pos + len + pad));
}

/** 取 at 所在的那句话（按句读切），返回文本和它在全文中的起点。 */
function sentenceAt(text: string, at: number): { s: string; start: number } {
  const isBreak = (c: string) => '。！？；\n'.includes(c);
  let a = at;
  let b = at;
  while (a > 0 && !isBreak(text[a - 1])) a--;
  while (b < text.length && !isBreak(text[b])) b++;
  return { s: text.slice(a, b), start: a };
}

/**
 * 取句子里离锚点最近的那个数。
 * 排除「5.1」「第三章」「v3」这类不是数值断言的数字。
 *
 * ★ 距离按「离锚点最近的那条边」算，不按锚点起点算 ★
 *   以前拿数字和锚点**起点**比距离，于是锚点一长就永远够不着：
 *   「上下文压缩阈值默认取 3000」里，3000 就在锚点正后面，距离却是 12 个字，
 *   正好卡在上限上；锚点再长一个字，这条真矛盾就被静默丢掉了。
 */
function numberNear(
  sentence: string,
  spanStart: number,
  spanEnd: number,
): { value: number; text: string; idx: number; unit: string } | null {
  const re = /\d+(?:\.\d+)?/g;
  let m: RegExpExecArray | null;
  let best: { value: number; text: string; d: number; idx: number; unit: string } | null = null;
  while ((m = re.exec(sentence))) {
    const idx = m.index;
    const before = sentence.slice(Math.max(0, idx - 2), idx);
    const after = sentence.slice(idx + m[0].length, idx + m[0].length + 2);
    if (/[.vV第]/.test(before)) continue;
    if (/^[章节页行版]/.test(after)) continue;
    const before8 = sentence.slice(Math.max(0, idx - 8), idx);
    // K1/K2、Qwen3、vllm 这类编号不是数值断言：数字紧跟在拉丁字母后面的一律跳过。
    // 实测没这条时，「KL-散度和 K1 估计」里 K1 对 K2 会被报成「一边说 1 一边说 2」。
    if (/[a-zA-Z]$/.test(before8)) continue;
    // 必须是「带单位的量」或「跟着上限下限词」的数，否则一个公式里的下标就能触发误报
    const unit = unitAt(sentence, idx, m[0].length);
    if (!unit) continue;
    const d = idx >= spanStart && idx < spanEnd ? 0 : Math.min(Math.abs(idx - spanStart), Math.abs(idx - spanEnd));
    if (d > 12) continue;
    const value = Number(m[0]);
    if (!Number.isFinite(value)) continue;
    if (!best || d < best.d) best = { value, text: m[0], d, idx, unit };
  }
  return best ? { value: best.value, text: best.text, idx: best.idx, unit: best.unit } : null;
}

export interface CandidateEval {
  /** 通过「稀有 + 可读」两道检查的共享短语，按强度降序 */
  solid: string[];
  signals: ConflictSignal[];
  strongest: number;
  /** 最强信号来自哪条短语——展示的引文必须跟着它走，否则引文和判定对不上 */
  best: { phrase: string; qa: string; qb: string; w: number } | null;
}

/**
 * 对一对「讲同一件事」的片段做结论比对。
 *
 * ★ 矛盾是三元关系：同一个对象 + 同一个条件 + 互相排斥 ★
 *   少任何一元都不叫矛盾。这里用「共享的稀有短语」锁定对象和条件，
 *   只在锁定的那句话内部比数值、上下限、反义属性。
 *   不这么做的话，「A 说上限 10、B 说上限 16」很容易变成误报——
 *   它们说的可能是两个不同的接口。
 *
 * ★ 它只配当筛选器，不配当判决 ★
 *   实测它筛出来的两条，一条单位判错、一条其实是补充。
 *   「互斥」这一元要靠读懂语义，机械规则永远差一口气。
 *   所以这一层的职责是**别漏**（把 2673 片缩成几十对），
 *   定性交给 conflict.ts 的 LLM 三分类。
 */
export function evalPair(A: IndexChunk, B: IndexChunk, corpus: Corpus): CandidateEval {
  const bodyA = plain(A.text);
  const bodyB = plain(B.text);
  const spans = mergeSpans(sharedSpans(bodyA.toLowerCase(), bodyB.toLowerCase()));
  const solid = spans
    .map((s) => ({ s, r: spanRarity(s.text, corpus.idf), len: s.text.trim().length }))
    .filter((x) => x.r >= CONFLICT_RARITY && isCleanPhrase(trimEdges(bodyB.slice(x.s.at, x.s.at + x.s.text.length))))
    .sort((a, b) => b.r * b.len - a.r * a.len)
    .slice(0, 3);

  const signals: ConflictSignal[] = [];
  let strongest = 0;
  let best: CandidateEval['best'] = null;

  for (const { s } of solid) {
    const phrase = trimEdges(bodyB.slice(s.at, s.at + s.text.length));
    if (!phrase) continue;
    const atA = bodyA.toLowerCase().indexOf(s.text.toLowerCase());
    if (atA < 0) continue;
    const sa = sentenceAt(bodyA, atA);
    const sb = sentenceAt(bodyB, s.at);
    const posA = atA - sa.start;
    const posB = s.at - sb.start;
    // ★ 只在短语附近的窗口里判定，不用整句 ★
    //   实测用整句会误报：「最小工程实现」里的「最小」被当成下限；
    //   讲「在线/离线区别」的句子两个词都有，被当成了断言「离线」。
    const winA = windowAround(sa.s, posA, s.text.length);
    const winB = windowAround(sb.s, posB, s.text.length);
    // 反义属性要求更近：差一个宾语就不是同一个论断
    // （「无需 Routing Replay」对「不需要 critic model」——都提到 GRPO，说的却不是一件事）
    const tightA = windowAround(sa.s, posA, s.text.length, 12);
    const tightB = windowAround(sb.s, posB, s.text.length, 12);

    // 版本名用整句抓：短语窗口只有 22 字，「Kimi K3」常在窗口外一格
    const va = versionTokens(sa.s);
    const vb = versionTokens(sb.s);
    if (va.size && vb.size && !shares(va, vb)) continue;

    // ① 数值冲突：同一个量，两边给了不一样的值
    const na = numberNear(sa.s, posA, posA + s.text.length);
    const nb = numberNear(sb.s, posB, posB + s.text.length);
    if (na && nb && na.value !== nb.value) {
      const rel = Math.abs(na.value - nb.value) / Math.max(Math.abs(na.value), Math.abs(nb.value));
      // 两边的数必须真的是同一个量：**完整的**单位（含分母）得是同一个。
      // 「再训练 1000 步」和「超过 128K」是两个不同的量；
      // 「180 tokens/ms」和「30 tokens/s」也是——这条以前漏判过。
      if (rel >= 0.1 && na.unit === nb.unit) {
        signals.push({
          kind: 'number',
          detail: `「${phrase}」附近：一边说 ${na.text}${na.unit[0] === '#' ? '' : ' ' + na.unit}，另一边说 ${nb.text}${nb.unit[0] === '#' ? '' : ' ' + nb.unit}`,
          weight: 1,
        });
        strongest = Math.max(strongest, 1);
        if (!best) best = { phrase, qa: sa.s, qb: sb.s, w: 1 };
      }
    }

    // ② 上下限对立。一边同时提到上下限，说明它在讲区间，不是在断言
    const mixed = (t: string) => MODAL_UP.test(t) && MODAL_DOWN.test(t);
    if (!mixed(sa.s) && !mixed(sb.s)) {
      const upA = MODAL_UP.test(winA);
      const upB = MODAL_UP.test(winB);
      const dnA = MODAL_DOWN.test(winA);
      const dnB = MODAL_DOWN.test(winB);
      if ((upA && dnB) || (dnA && upB)) {
        signals.push({
          kind: 'modal',
          detail: `「${phrase}」：一边说${upA ? '上限' : '下限'}，另一边说${upA ? '下限' : '上限'}`,
          weight: 0.8,
        });
        strongest = Math.max(strongest, 0.8);
        if (!best || best.w < 0.8) best = { phrase, qa: sa.s, qb: sb.s, w: 0.8 };
      }
    }

    // ③ 反义属性：两边各执一端。任何一边同时出现两端，说明它在解释区别
    for (const [x, y] of ANTONYMS) {
      const both = (t: string) => t.includes(x) && t.includes(y);
      if (both(sa.s) || both(sb.s)) continue;
      if (tightA.includes(x) && tightB.includes(y)) {
        signals.push({ kind: 'antonym', detail: `「${phrase}」：一边是「${x}」，另一边是「${y}」`, weight: 0.75 });
        strongest = Math.max(strongest, 0.75);
        if (!best || best.w < 0.75) best = { phrase, qa: sa.s, qb: sb.s, w: 0.75 };
        break;
      }
      if (tightA.includes(y) && tightB.includes(x)) {
        signals.push({ kind: 'antonym', detail: `「${phrase}」：一边是「${y}」，另一边是「${x}」`, weight: 0.75 });
        strongest = Math.max(strongest, 0.75);
        if (!best || best.w < 0.75) best = { phrase, qa: sa.s, qb: sb.s, w: 0.75 };
        break;
      }
    }

    // ④ 肯否对立不做独立信号：中文技术文本里「需要 / 不能 / 必须」太常见，
    //    实测只要两边各撞上一个就报，误报率高到没有价值。
    //    真正成对的（必须↔不能、需要↔无需）已经并进上面的反义表，用精确匹配。
  }

  return {
    solid: solid.map((x) => trimEdges(bodyB.slice(x.s.at, x.s.at + x.s.text.length))).filter(Boolean),
    signals: signals.sort((x, y) => y.weight - x.weight).slice(0, 3),
    strongest,
    best,
  };
}

/** 漏斗诊断用的一行：这一对走到了哪一步、被什么拦下的。 */
export interface ConflictDiagRow {
  a: string;
  b: string;
  sim: number;
  solid: string[];
  signals: string[];
  used: boolean;
  why: string;
}

// ─────────────── 近重复对：走「对齐 → 差异」而不是「找信号」 ───────────────

/** 余弦到这个程度才算「同一段文字的两个版本」。 */
const NEAR_SIM = 0.88;
/** 最长共享片段要覆盖较短那一片的这个比例，才认定是「同一段文字」。 */
const NEAR_COVER = 0.6;
/** 单侧差异超过这么多字就不算「局部改动」——那是两篇不同的东西，不是版本差异。 */
const DIFF_MAX = 80;
/** 差异点前后各取多少字做上下文（两边共用同一段上下文，差异才凸显得出来）。 */
const SPOT_CONTEXT = 60;

export interface DiffSpot {
  /** 差异点之前的共同文字（决定「说的是同一件事」） */
  before: string;
  aOnly: string;
  bOnly: string;
  /** 差异点之后的共同文字 */
  after: string;
}

/**
 * 一道差异算不算「值得看的差异」。
 *
 * ★ 规则是「≥10 字，但含数字的不受限制」★
 *   10 字这条是为了滤掉标点、错别字之类的抖动。
 *   可是**只改了一个数字**的差异往往只有一两个字符：两段都写「默认取 3000 tokens」，
 *   共享片段会把共有的 "000 tokens" 整段吃掉，剩下的差异就只有 "3" 和 "12"。
 *   而这种恰恰是最典型、最该抓的矛盾——数字对不上。
 */
function gapUsable(text: string): boolean {
  return text.length >= 10 || /\d/.test(text);
}

/** 取出一段文字里「没和另一段连续共享」的区段。 */
function gaps(spans: { text: string; at: number }[], text: string): { at: number; text: string }[] {
  const out: { at: number; text: string }[] = [];
  let cur = 0;
  for (const s of spans) {
    const seg = text.slice(cur, s.at);
    if (seg.length && gapUsable(seg)) out.push({ at: cur, text: seg });
    cur = Math.max(cur, s.at + s.text.length);
  }
  const tail = text.slice(cur);
  if (tail.length && gapUsable(tail)) out.push({ at: cur, text: tail });
  return out;
}

/**
 * 把「同一段文字的两个版本」对齐，找出**局部不一致**的地方。
 *
 * ★ 为什么不能沿用上面那套「共享短语 + 附近找信号」★
 *   两段几乎一样时，连续共享片段会拉成一整条（实测：一整片 483 个字全是共享的），
 *   那条短语里带句号，被判成「跨了句子、不是一个说法」直接丢掉——
 *   于是「同一个段落、只有一个数字不同」这种**最典型、最该抓**的矛盾，一个候选也生不出来。
 *   自测里注入的「默认取 3000 tokens」对「默认取 12000 tokens」就是这么被漏掉的。
 *   近重复场景下，正确的做法不是找锚点，而是**先把差异本身定位出来**：
 *   差异点两侧的文字天然就是锚点，差异点自己就是待判定的对象。
 */
export function diffSpots(A: IndexChunk, B: IndexChunk): DiffSpot[] {
  const a = plain(A.text);
  const b = plain(B.text);
  const sB = sharedSpans(a.toLowerCase(), b.toLowerCase());
  const sA = sharedSpans(b.toLowerCase(), a.toLowerCase());
  const cover = sB.reduce((n, s) => n + s.text.length, 0) / Math.max(1, Math.min(a.length, b.length));
  if (cover < NEAR_COVER) return [];

  const gA = gaps(sA, a);
  const gB = gaps(sB, b);
  const out: DiffSpot[] = [];
  const used = new Set<number>();
  for (const gb of gB) {
    if (gb.text.length > DIFF_MAX) continue;
    // 两处差异按「在各自片段里的相对位置」配对——绝对偏移会因为两边长度不同而错开
    const rel = gb.at / Math.max(1, b.length);
    let pickAt = -1;
    let pickD = 0.18;
    gA.forEach((ga, i) => {
      if (used.has(i)) return;
      const d = Math.abs(ga.at / Math.max(1, a.length) - rel);
      if (d < pickD) {
        pickD = d;
        pickAt = i;
      }
    });
    if (pickAt < 0 || gA[pickAt].text.length > DIFF_MAX) continue;
    used.add(pickAt);
    const ga = gA[pickAt];
    out.push({
      before: a.slice(Math.max(0, ga.at - SPOT_CONTEXT), ga.at),
      aOnly: ga.text,
      bOnly: gb.text,
      after: a.slice(ga.at + ga.text.length, ga.at + ga.text.length + SPOT_CONTEXT),
    });
  }
  return out;
}

/** 把一小段文字里出现过的「量」抓出来：单位键 → 数值。 */
function quantify(text: string): Map<string, number> {
  const out = new Map<string, number>();
  const re = /\d+(?:\.\d+)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const unit = unitAt(text, m.index, m[0].length);
    const v = Number(m[0]);
    if (unit && Number.isFinite(v)) out.set(unit, v);
  }
  return out;
}

/**
 * 就着差异点本身判信号。
 *
 * ★ 为什么要带上前后文 ★
 *   差异可能只有一个字（「3000」对「12000」里差异是 "3" 和 "12"），
 *   单位「tokens」在两个共用区段里。只拿差异本身去抓「量」是什么都抓不到的，
 *   得把差异**和它两侧共用的那一小段**拼起来看：
 *   两侧共用部分是相同的，所以里面出现的数在两边永远相等、自动被跳过，
 *   真正会撞上的只有那个被改掉的数——这正是我们要的。
 */
function spotSignals(spot: DiffSpot): ConflictSignal[] {
  const sig: ConflictSignal[] = [];
  const winA = `${spot.before.slice(-14)}${spot.aOnly}${spot.after.slice(0, 14)}`;
  const winB = `${spot.before.slice(-14)}${spot.bOnly}${spot.after.slice(0, 14)}`;
  const na = quantify(winA);
  const nb = quantify(winB);
  for (const [unit, va] of na) {
    const vb = nb.get(unit);
    if (vb === undefined || vb === va) continue;
    const rel = Math.abs(va - vb) / Math.max(Math.abs(va), Math.abs(vb));
    if (rel < 0.1) continue;
    sig.push({ kind: 'number', detail: `同一个量「${unit}」：一边是 ${va}，另一边是 ${vb}`, weight: 1 });
  }
  if (MODAL_UP.test(spot.aOnly) !== MODAL_UP.test(spot.bOnly)) {
    sig.push({ kind: 'modal', detail: `一边带「上限」类限定词，另一边没有`, weight: 0.8 });
  }
  for (const [x, y] of ANTONYMS) {
    const both = (t: string) => t.includes(x) && t.includes(y);
    if (both(spot.aOnly) || both(spot.bOnly)) continue;
    if ((spot.aOnly.includes(x) && spot.bOnly.includes(y)) || (spot.aOnly.includes(y) && spot.bOnly.includes(x))) {
      sig.push({ kind: 'antonym', detail: `一边是「${x}」，另一边是「${y}」`, weight: 0.75 });
      break;
    }
  }
  return sig;
}

/**
 * 把所有「锁定了同一件事」的片段对变成候选。
 *
 * requireSignal=true（离线模式）：只留机械信号命中的那些，宁可漏，不要误报。
 * requireSignal=false（接了 AI 的模式）：只要锁定了同一件事、又足够像，就交上去让模型读。
 *   —— 因为机械信号只认数值/上下限/反义这三类，
 *   像「A 说 RL 用 PPO、B 说 RL 用 GRPO」这种一句话就能看出来的矛盾，它一个信号也抓不到。
 */
export interface FindConflictsOpts {
  /** true（默认）：只留机械信号命中的；false：只要锁定了同一件事就交上来（给 LLM 判） */
  requireSignal?: boolean;
  limit?: number;
  diag?: { from: number; rows: ConflictDiagRow[] };
  /**
   * 候选的相似度下限，默认 CONFLICT_SIM。
   *
   * ★ 检索侧必须传 0 ★
   *   全库建图时「够像」是一条有效的闸门，但检索命中的 8 个片段本来就来自不同文档、
   *   未必互相像（一句问话可能同时命中两本不相干的书）。要是照搬 0.72，
   *   检索侧一条候选都不会剩。「讲的是不是同一件事」本来就由共享稀有短语负责判定，
   *   所以那边把相似度闸门打开即可。
   */
  minSim?: number;
  /** 是否「同一对文档只留一条」。默认 true；检索侧传 false（两次命中是两件事） */
  onePerDocPair?: boolean;
}

export function findConflicts(
  chunks: IndexChunk[],
  pairs: Pair[],
  corpus: Corpus,
  opts: FindConflictsOpts = {},
): Conflict[] {
  const requireSignal = opts.requireSignal !== false;
  const from = opts.minSim ?? opts.diag?.from ?? CONFLICT_SIM;
  const onePerDocPair = opts.onePerDocPair !== false;
  const out: Conflict[] = [];
  const byDocPair = new Map<string, Conflict>();
  const seenPhrase = new Set<string>();

  const docKey = (x: string, y: string) => (x < y ? `${x}|${y}` : `${y}|${x}`);

  /** 收下一条候选。返回 null 表示收下了，否则返回被拦下的原因。 */
  const emit = (rec: Conflict, anchor: string): string | null => {
    const key = docKey(rec.a.docRel, rec.b.docRel);
    const seenKey = onePerDocPair ? key : `${key}#${anchor}`;
    const prev = byDocPair.get(seenKey);
    // 全库建图：同一对文档只留分最高的一条（否则 chapter2⇄chapter8 会刷满整个列表）
    // 检索侧：两次命中可能就是两件事，只按「同一对文档 + 同一个锚点」去重
    if (onePerDocPair && prev && rec.score <= prev.score) return '同一对文档已有更强的候选';
    if (!onePerDocPair && prev) return '同一处说法已经收过了';
    if (anchor && seenPhrase.has(anchor) && prev?.shared[0] !== anchor) return `锚点「${anchor}」已在别处用过`;
    if (prev) {
      const at = out.indexOf(prev);
      if (at >= 0) out.splice(at, 1);
    }
    out.push(rec);
    byDocPair.set(seenKey, rec);
    if (anchor) seenPhrase.add(anchor);
    return null;
  };

  const side = (A: IndexChunk, quote: string): ConflictSide => ({
    docRel: A.docRel,
    docTitle: A.docTitle,
    headingText: A.headingText,
    startBi: A.partFrom ?? A.startBi,
    quote: quote.replace(/\s+/g, ' ').trim().slice(0, 220),
  });

  // ① 近重复对：先对齐、再逐处比差异（「同一段文字被抄了两遍，其中一处改了」）
  for (const p of pairs.filter((x) => x.s >= NEAR_SIM).sort((a, b) => b.s - a.s)) {
    const A = chunks[p.i];
    const B = chunks[p.j];
    const scored = diffSpots(A, B)
      .map((s) => ({ s, sig: spotSignals(s) }))
      .sort(
        (x, y) =>
          Number(y.sig.length > 0) - Number(x.sig.length > 0) ||
          y.s.aOnly.length + y.s.bOnly.length - (x.s.aOnly.length + x.s.bOnly.length),
      );
    const top = scored[0];
    const row: ConflictDiagRow | null = opts.diag
      ? {
          a: A.docRel,
          b: B.docRel,
          sim: Math.round(p.s * 1000) / 1000,
          solid: [],
          signals: top?.sig.map((s) => s.kind) ?? [],
          used: false,
          why: '',
        }
      : null;
    if (row) {
      row.solid = top ? ['（近重复：差异点即锚点）'] : [];
      opts.diag!.rows.push(row);
    }
    if (!top) {
      if (row) row.why = '两段几乎一样但没有「局部改动」，只是窗口错位';
      continue;
    }
    if (!top.sig.length && requireSignal) {
      if (row) row.why = '有局部差异，但三类机械信号都没命中';
      continue;
    }
    const anchor = trimEdges(top.s.before).slice(-20);
    const strongest = top.sig.reduce((m, s) => Math.max(m, s.weight), 0);
    const rec: Conflict = {
      a: side(A, `${top.s.before}【${top.s.aOnly}】${top.s.after}`),
      b: side(B, `${top.s.before}【${top.s.bOnly}】${top.s.after}`),
      sim: Math.round(p.s * 100) / 100,
      score: Math.round(Math.min(1, 0.3 * p.s + 0.7 * strongest) * 100),
      shared: anchor ? [anchor] : [],
      signals: top.sig,
    };
    const why = emit(rec, anchor);
    if (row) {
      row.used = why === null;
      row.why = why ?? `近重复对，共 ${scored.length} 处差异`;
    }
  }

  // ② 一般对：用共享的稀有短语锁定「同一个对象」，再在锚点附近比结论
  const cands = pairs.filter((p) => p.s >= from).sort((a, b) => b.s - a.s);
  for (const p of cands) {
    const A = chunks[p.i];
    const B = chunks[p.j];
    const ev = evalPair(A, B, corpus);
    const row: ConflictDiagRow | null = opts.diag
      ? {
          a: A.docRel,
          b: B.docRel,
          sim: Math.round(p.s * 1000) / 1000,
          solid: ev.solid,
          signals: ev.signals.map((s) => s.kind),
          used: false,
          why: '',
        }
      : null;
    if (row) opts.diag!.rows.push(row);

    if (!ev.solid.length) {
      if (row) row.why = '没有可信的共享短语 → 不是同一个对象';
      continue;
    }
    if (!ev.best && requireSignal) {
      if (row) row.why = '锁定了同一件事，但三类机械信号都没命中';
      continue;
    }
    // 池模式下没信号的也收，用最强的那条共享短语当锚点（LLM 读的时候需要它）
    const anchor = ev.best?.phrase || ev.solid[0];
    const qa = ev.best?.qa || quoteAt(plain(A.text), anchor);
    const qb = ev.best?.qb || quoteAt(plain(B.text), anchor);

    const rec: Conflict = {
      a: side(A, qa),
      b: side(B, qb),
      sim: Math.round(p.s * 100) / 100,
      score: Math.round(Math.min(1, 0.3 * p.s + 0.7 * ev.strongest) * 100),
      shared: ev.solid,
      signals: ev.signals,
    };
    const why = emit(rec, anchor);
    if (row) {
      row.used = why === null;
      row.why = why ?? '';
    }
  }

  return out.sort((a, b) => b.score - a.score).slice(0, opts.limit ?? MAX_CONFLICTS);
}

/** 取 A 侧含这个短语的那句话。 */
function quoteAt(body: string, phrase: string): string {
  const at = body.toLowerCase().indexOf(phrase.toLowerCase());
  return sentenceAt(body, at < 0 ? 0 : at).s;
}

// ───────────────────────── 主流程 ─────────────────────────

/**
 * 每个节点只保留最强的 KEEP_PER_NODE 条边（两端只要还有一个没满就保留）。
 *
 * ★ 不剪的话图太密 ★
 *   实测 27 篇连出 186 条边，而全部可能的对数只有 351——超过一半都连上了。
 *   这么密的图里「谁和谁更近」的区别被抹平，Louvain 分出来的团也就说明不了什么。
 */
function pruneEdges(edges: GraphEdgeView[], keep = KEEP_PER_NODE): GraphEdgeView[] {
  const count = new Map<number, number>();
  const out: GraphEdgeView[] = [];
  for (const e of [...edges].sort((a, b) => b.w - a.w)) {
    const ca = count.get(e.a) ?? 0;
    const cb = count.get(e.b) ?? 0;
    if (ca >= keep && cb >= keep) continue;
    out.push(e);
    count.set(e.a, ca + 1);
    count.set(e.b, cb + 1);
  }
  return out;
}

// ─────────────────────── 缓存：算过的片对不重算 ───────────────────────

/**
 * ★ 为什么必须落盘 ★
 *   实测（scripts/perf-probe.ts）建图 13.5s 里，13.8s 是 kNN 两两算余弦，
 *   Louvain 加矛盾检测加起来不到 0.1s。所以优化图算法一点用都没有，
 *   唯一有效的是「同一个库、同一套参数，别算第二遍」。
 *   pairs 落盘只有 400KB 左右，之后每次建图都是读个文件的事。
 *
 * ★ key 里必须编进参数 ★
 *   否则调了 TOPK / PAIR_MIN / 阈值之后会拿旧结果当新结果用，
 *   「调了没反应」这种 bug 比慢十倍难查得多。版本号一变旧文件自动作废。
 */
const GRAPH_CACHE_NAME = 'graph.json';
/**
 * 缓存格式版本。**改了会影响结果的计算逻辑就要 +1**。
 * v2：修掉 sharedSpans 的切词误判（数字前停下的长共享片段被整段丢弃），
 *     证据短语与矛盾候选的结论都会变，旧缓存必须作废。
 */
const GRAPH_CACHE_VERSION = 2;

interface GraphCacheFile {
  version: number;
  /** 只跟「索引 + kNN 参数」有关：这部分没变，片对就不用重算 */
  pairsKey: string;
  mode: 'semantic' | 'lexical';
  savedAt: string;
  /** 紧凑三元组 [i, j, s]。同一个数组用对象存要 1.2MB，这样只要 400KB */
  pairs: [number, number, number][];
  /** 图本身也一起存：阈值没动就直接返回，连折叠都不必做 */
  graph: { key: string; data: DocGraph } | null;
}

function graphCacheDir(root: string): string {
  return path.join(root, '.notebook', 'index');
}

/** 片对的钥匙：索引变了、或 kNN 参数改了，就必须重算 */
function pairsKeyOf(f: { builtAt: string }, n: number): string {
  return [GRAPH_CACHE_VERSION, f.builtAt, n, TOPK, PAIR_MIN].join('#');
}

/** 图的钥匙：在片对之上再叠所有「影响谁和谁算有关系 / 谁算冲突」的阈值 */
function graphKeyOf(pairsKey: string, pool: boolean): string {
  return [
    pairsKey,
    pool ? 'pool' : 'sig',
    CONFLICT_SIM,
    CONFLICT_RARITY,
    NEAR_SIM,
    EDGE_MIN,
    KEEP_PER_NODE,
    FOLD_PAIRS,
    MAX_CONFLICTS,
    MAX_POOL,
  ].join('#');
}

async function readGraphCache(): Promise<GraphCacheFile | null> {
  try {
    const root = await requireVaultRoot();
    const f = await readJson<GraphCacheFile | null>(path.join(graphCacheDir(root), GRAPH_CACHE_NAME), null);
    if (!f || f.version !== GRAPH_CACHE_VERSION || !Array.isArray(f.pairs)) return null;
    return f;
  } catch {
    return null;
  }
}

async function writeGraphCache(f: GraphCacheFile): Promise<void> {
  try {
    const root = await requireVaultRoot();
    const dir = graphCacheDir(root);
    await fsp.mkdir(dir, { recursive: true });
    await writeFileAtomic(path.join(dir, GRAPH_CACHE_NAME), JSON.stringify(f));
  } catch {
    /* 缓存写不进去不影响功能，下次重算一遍而已 */
  }
}

/** 落盘时把相似度压到 4 位小数：cosine 的第 5 位对分组结果没有影响，但能让文件小一截 */
function packPairs(pairs: Pair[]): [number, number, number][] {
  return pairs.map((p) => [p.i, p.j, Math.round(p.s * 1e4) / 1e4] as [number, number, number]);
}

/** 磁盘里的紧凑三元组 → 内存里的片对 */
function toPair(t: [number, number, number]): Pair {
  return { i: t[0], j: t[1], s: t[2] };
}

/** 当前索引是语义还是词面模式 */
function mode(chunks: IndexChunk[]): 'semantic' | 'lexical' {
  return chunks.some((c) => c.vec && c.vec.length) ? 'semantic' : 'lexical';
}

/** 内存里的片对。这是最贵的一步（十几秒），单独缓存 */
let cachedPairs: { key: string; pairs: Pair[] } | null = null;
/** 内存里的图。建它几乎不花时间，但它依赖 pairs，所以要跟 pairsKey 对上 */
let cachedGraph: { key: string; graph: DocGraph } | null = null;
/** 后台重建中。前端轮询时不要反复起同一个活 */
let building: Promise<void> | null = null;

/**
 * 取跨文档片对，三层复用：内存 → 磁盘 → 现算。
 *
 * ★ 诊断脚本也走这里 ★
 *   conflict-probe 每跑一次都要这批片对。以前它自己调 pairsSemantic，
 *   于是每改一行判定逻辑、每看一眼结果，都得再等十几秒。
 *   走缓存之后「改一点、看一眼」是秒级的，调参才有可能做得动。
 */
export async function loadPairs(opts: { force?: boolean; onTick?: (done: number, total: number) => void } = {}): Promise<{
  chunks: IndexChunk[];
  pairs: Pair[];
  corpus: Corpus;
}> {
  const f = await readIndex();
  const chunks = f.chunks;
  const key = pairsKeyOf(f, chunks.length);
  const corpus = getCorpus(chunks, key);
  if (!opts.force && cachedPairs && cachedPairs.key === key) return { chunks, pairs: cachedPairs.pairs, corpus };

  if (!opts.force) {
    const disk = await readGraphCache();
    if (disk && disk.pairsKey === key) {
      const pairs = disk.pairs.map(toPair);
      cachedPairs = { key, pairs };
      return { chunks, pairs, corpus };
    }
  }

  const md = mode(chunks);
  const pairs = md === 'semantic' ? await pairsSemantic(chunks, opts.onTick) : await pairsLexical(chunks, corpus);
  cachedPairs = { key, pairs };
  // 现算出来的先落盘。就算这次调用者只是看一眼，也顺手把十几秒留给下次
  void writeGraphCache({
    version: GRAPH_CACHE_VERSION,
    savedAt: new Date().toISOString(),
    pairsKey: key,
    mode: md,
    pairs: packPairs(pairs),
    graph: null,
  });
  return { chunks, pairs, corpus };
}

/**
 * 建图。
 *
 * ★ 耗时全在片对上 ★
 *   实测 13.5s 里 13.8s 是 kNN，折叠 / Louvain / 矛盾检测加起来不到 0.1s，
 *   所以这里只对片对做缓存，其余每次现算——又快又不会拿到过期的社区结构。
 */
export async function buildGraph(
  opts: { force?: boolean; pool?: boolean; onTick?: (done: number, total: number) => void } = {},
): Promise<DocGraph> {
  const f = await readIndex();
  const chunks = f.chunks;
  const t0 = Date.now();
  const pairsKey = pairsKeyOf(f, chunks.length);
  const key = graphKeyOf(pairsKey, !!opts.pool);
  if (!opts.force && cachedGraph && cachedGraph.key === key) return cachedGraph.graph;

  if (!opts.force) {
    const disk = await readGraphCache();
    if (disk?.graph && disk.graph.key === key) {
      cachedPairs = { key: disk.pairsKey, pairs: disk.pairs.map(toPair) };
      cachedGraph = { key, graph: disk.graph.data };
      return disk.graph.data;
    }
  }

  const { pairs, corpus } = await loadPairs({ force: opts.force, onTick: opts.onTick });

  const md = mode(chunks);
  const rels = [...new Set(chunks.map((c) => c.docRel))].sort();
  const idxOf = new Map(rels.map((r, i) => [r, i]));
  const chars = new Map<string, number>();
  const titles = new Map<string, string>();
  const nChunks = new Map<string, number>();
  for (const c of chunks) {
    chars.set(c.docRel, (chars.get(c.docRel) ?? 0) + c.text.length);
    nChunks.set(c.docRel, (nChunks.get(c.docRel) ?? 0) + 1);
    if (!titles.has(c.docRel)) titles.set(c.docRel, c.docTitle);
  }

  const acc = new Map<string, { a: number; b: number; sims: number[]; topPair: Pair }>();
  for (const p of pairs) {
    const a = idxOf.get(chunks[p.i].docRel)!;
    const b = idxOf.get(chunks[p.j].docRel)!;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const ek = `${lo}|${hi}`;
    let e = acc.get(ek);
    if (!e) acc.set(ek, (e = { a: lo, b: hi, sims: [], topPair: p }));
    e.sims.push(p.s);
    if (p.s > e.topPair.s) e.topPair = p;
  }

  const edgeList: GraphEdgeView[] = [];
  for (const e of acc.values()) {
    const sims = e.sims.sort((x, y) => y - x).slice(0, FOLD_PAIRS);
    // 除以两文档片数的几何平均：否则长文档靠片数堆出巨边，社区退化成「按篇幅分」
    const norm = Math.sqrt((nChunks.get(rels[e.a]) ?? 1) * (nChunks.get(rels[e.b]) ?? 1));
    const w = sims.reduce((s, x) => s + x, 0) / norm;
    if (w < EDGE_MIN) continue;
    edgeList.push({
      a: e.a,
      b: e.b,
      w: Math.round(w * 1000) / 1000,
      pairs: e.sims.length,
      top: Math.round(e.topPair.s * 100) / 100,
      evidence: edgeEvidence(chunks[e.topPair.i], chunks[e.topPair.j], corpus),
      cross: false,
      sole: false,
    });
  }
  edgeList.sort((x, y) => y.w - x.w);
  const edges = pruneEdges(edgeList);

  const wEdges: WEdge[] = edges.map((e) => ({ a: e.a, b: e.b, w: e.w }));
  const { comm } = louvain(rels.length, wEdges);

  const degree = new Array<number>(rels.length).fill(0);
  for (const e of edges) {
    degree[e.a] += e.w;
    degree[e.b] += e.w;
  }

  const groupByPair = new Map<string, number[]>();
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    if (comm[e.a] === comm[e.b]) continue;
    const k = [comm[e.a], comm[e.b]].sort((x, y) => x - y).join('|');
    let arr = groupByPair.get(k);
    if (!arr) groupByPair.set(k, (arr = []));
    arr.push(i);
  }
  const bridges: number[] = [];
  for (const arr of groupByPair.values()) {
    for (const i of arr) {
      edges[i].cross = true;
      edges[i].sole = arr.length === 1;
      bridges.push(i);
    }
  }
  bridges.sort((x, y) => Number(edges[y].sole) - Number(edges[x].sole) || edges[y].w - edges[x].w);

  const communities: CommunityView[] = [];
  const byComm = new Map<number, number[]>();
  comm.forEach((c, i) => {
    let arr = byComm.get(c);
    if (!arr) byComm.set(c, (arr = []));
    arr.push(i);
  });
  for (const [c, members] of [...byComm.entries()].sort((a, b) => b[1].length - a[1].length)) {
    let inner = 0;
    let all = 0;
    const set = new Set(members);
    for (const e of edges) {
      if (!set.has(e.a) && !set.has(e.b)) continue;
      all += e.w;
      if (set.has(e.a) && set.has(e.b)) inner += e.w;
    }
    communities.push({
      id: c,
      members,
      cohesion: all ? Math.round((inner / all) * 100) / 100 : 0,
      label: `${members.length} 篇`,
    });
  }

  const isolates = rels.map((_, i) => i).filter((i) => !edges.some((e) => e.a === i || e.b === i));
  const conflicts = findConflicts(chunks, pairs, corpus, {
    requireSignal: !opts.pool,
    limit: opts.pool ? MAX_POOL : MAX_CONFLICTS,
  });

  const graph: DocGraph = {
    builtAt: f.builtAt,
    mode: md,
    notice:
      md === 'lexical' ? '没配向量接口，图谱只能按词面相似度建；配好之后这里会换成语义相似度。' : null,
    nodes: rels.map((rel, i) => ({
      rel,
      title: titles.get(rel) ?? rel,
      chars: chars.get(rel) ?? 0,
      chunks: nChunks.get(rel) ?? 0,
      community: comm[i],
      degree: Math.round(degree[i] * 1000) / 1000,
    })),
    edges,
    communities,
    isolates,
    bridges,
    conflicts,
    stat: { chunks: chunks.length, docs: rels.length, pairs: pairs.length, ms: Date.now() - t0 },
  };
  cachedGraph = { key, graph };
  void writeGraphCache({
    version: GRAPH_CACHE_VERSION,
    savedAt: new Date().toISOString(),
    pairsKey,
    mode: md,
    pairs: packPairs(pairs),
    graph: { key, data: graph },
  });
  return graph;
}

// ─────────────────── 给界面用的读法：宁可先给旧的，不要转 14 秒 ───────────────────

export interface GraphShot {
  graph: DocGraph | null;
  /** true = 这份图是旧索引算的，后台正在重建，界面上该显示「正在更新」 */
  stale: boolean;
  /** 后台正在建（首次打开就是这种情况，graph 为 null） */
  building: boolean;
}

function startRebuild(pool?: boolean): void {
  if (building) return;
  building = (async () => {
    try {
      await buildGraph({ pool });
    } catch {
      /* 后台任务，失败就下次再试，不要把异常抛给已经返回的请求 */
    } finally {
      building = null;
    }
  })();
}

/**
 * 秒开的读法。
 *
 * ★ 先旧后新，绝不阻塞 ★
 *   库里加了一篇文档 → 索引重建 → 旧图就过期了。这时候如果老老实实重算，
 *   用户点开面板要等十几秒。所以先把旧图返回去（标 stale），后台默默重算，
 *   重算完前端下次轮询自然拿到新的。
 *   库特别大之后这会从「体验优化」变成「能不能用」的分界线。
 */
export async function readGraph(opts: { pool?: boolean } = {}): Promise<GraphShot> {
  const f = await readIndex();
  const chunks = f.chunks;
  if (!chunks.length) return { graph: null, stale: false, building: false };

  const pairsKey = pairsKeyOf(f, chunks.length);
  const want = graphKeyOf(pairsKey, !!opts.pool);
  if (cachedGraph && cachedGraph.key === want) return { graph: cachedGraph.graph, stale: false, building: false };

  const disk = await readGraphCache();
  if (disk?.graph && disk.graph.key === want) {
    cachedPairs = { key: disk.pairsKey, pairs: disk.pairs.map(toPair) };
    cachedGraph = { key: want, graph: disk.graph.data };
    return { graph: disk.graph.data, stale: false, building: false };
  }

  startRebuild(opts.pool);
  if (disk?.graph) return { graph: disk.graph.data, stale: true, building: true };
  return { graph: null, stale: false, building: true };
}

/** 让图谱缓存作废（下次读会全量重算）。给「重建知识地图」用。 */
export async function dropGraphCache(): Promise<void> {
  cachedPairs = null;
  cachedGraph = null;
  try {
    const root = await requireVaultRoot();
    const dir = graphCacheDir(root);
    // 不用 rm：这个项目里 fs.rm 被 shim 接管了（会走回收站逻辑），
    // 缓存文件挪个名字就等于作废，简单且没有副作用。
    await fsp.rename(path.join(dir, GRAPH_CACHE_NAME), path.join(dir, `${GRAPH_CACHE_NAME}.old`));
  } catch {
    /* 本来就不存在也算成功 */
  }
}

/** 一条文档边的证据：取最强那个片对的共享短语，只留又长又稀有的。 */
function edgeEvidence(A: IndexChunk, B: IndexChunk, corpus: Corpus): string[] {
  const bodyA = plain(A.text);
  const bodyB = plain(B.text);
  const spans = mergeSpans(sharedSpans(bodyA.toLowerCase(), bodyB.toLowerCase()));
  return spans
    .map((s) => ({ phrase: trimEdges(bodyB.slice(s.at, s.at + s.text.length)), r: spanRarity(s.text, corpus.idf) }))
    .filter((x) => isCleanPhrase(x.phrase) && x.r >= 1.8)
    .sort((a, b) => b.phrase.length * b.r - a.phrase.length * a.r)
    .slice(0, EDGE_EVIDENCE)
    .map((x) => x.phrase);
}

export async function graphStat(): Promise<{ chunks: number; withVec: number }> {
  const f = await readIndex();
  return { chunks: f.chunks.length, withVec: f.chunks.filter((c) => c.vec && c.vec.length).length };
}
