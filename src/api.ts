/**
 * src/api.ts —— 前端访问后端的唯一入口。
 *
 * 三件事必须在这里做掉，其它任何地方都不许自己 fetch：
 *   1. 自动带上 X-Local-Token（后端靠它挡住外部网页的跨站请求）。
 *      这个 token 是每次启动随机生成的，由服务端注入 index.html 的 meta 标签，
 *      所以**不要在模块加载时缓存到变量之外的任何持久化地方**。
 *   2. 把后端的 { error, code, ...extra } 统一翻成 ApiError，
 *      这样调用方可以直接 `e.code === 'conflict'` 判断，不用解构 JSON。
 *   3. 定义所有响应类型。类型是手写的镜像（不能 import 服务端模块，
 *      那些模块会 import node:fs，拖进浏览器包会炸）。
 */

// ─────────────────────────── 类型 ───────────────────────────

import type {
  Card,
  CheatsheetSection,
  DocAnalysis,
  Highlight,
  Note,
  NoteReply,
  Quiz,
  Sidecar,
  StudyUnit,
  TextQuoteSelector,
} from '../shared/text';

export type { Card, CheatsheetSection, Highlight, Note, Quiz, Sidecar, StudyUnit, TextQuoteSelector };

export interface TreeNode {
  type: 'dir' | 'doc';
  name: string;
  /** vault 相对路径，统一 / 分隔 */
  relPath: string;
  mtime: number;
  size: number;
  children?: TreeNode[];
}

export interface VaultInfo {
  configured: boolean;
  root: string | null;
  name: string;
  docCount: number;
}

export interface AiState {
  baseURL: string;
  model: string;
  temperature: number;
  hasApiKey: boolean;
  configured: boolean;
}

/** 向量（embedding）接口的状态。和 ai 完全独立的一套凭据。 */
export interface EmbeddingState {
  baseURL: string;
  model: string;
  /** 0 = 未指定，用接口返回的原生维度 */
  dimensions: number;
  hasApiKey: boolean;
  configured: boolean;
}

/** 飞书导入的状态。appId 可以明文显示（它不算机密），appSecret 只回有没有。 */
export interface FeishuState {
  appId: string;
  hasAppSecret: boolean;
  configured: boolean;
}

export interface SettingsState {
  vault: VaultInfo;
  defaultVault: string;
  theme: 'light' | 'dark';
  /** 界面主色 #RRGGBB，hover/soft/border/夜色版由前端派生 */
  themeColor: string;
  panelWidths: { left: number; right: number };
  ai: AiState;
  embedding: EmbeddingState;
  feishu: FeishuState;
}

/** 一条检索命中。docRel + startBi 足够跳回正文的对应位置。 */
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
  snippet: string;
  /** snippet 渲染后的 HTML（服务端 createMd 产出，可安全插入）；老接口没有此字段时回退到 snippet */
  html?: string;
  /** 完整原文，问答模式要用；检索列表里不展示 */
  text: string;
}

export interface SearchOutcome {
  hits: SearchHit[];
  /** vector = 语义检索；keyword = 降级成了字面匹配 */
  mode: 'vector' | 'keyword';
  notice: string | null;
}

export interface SearchAskResult extends SearchOutcome {
  answer: string;
  /** answer 渲染后的 HTML；缺失时回退到纯文本（保留换行） */
  answerHtml?: string;
  model: string;
  /** 问答前顺带做的矛盾检查。没开这个开关、或检查失败时为 null */
  scan: ConflictScan | null;
}

// ── 矛盾检测（检索侧） ──

export type ConflictVerdict = 'contradiction' | 'complement' | 'unrelated' | 'unknown';

export interface ConflictSignal {
  kind: 'number' | 'modal' | 'antonym';
  detail: string;
  weight: number;
}

export interface ConflictSide {
  docRel: string;
  docTitle: string;
  headingText: string;
  startBi: number;
  quote: string;
}

export interface ScannedConflict {
  a: ConflictSide;
  b: ConflictSide;
  /** 两段本身的语义相似度；检索命中的片段之间可能很低，这不影响判定 */
  sim: number;
  score: number;
  /** 锁定「讲的是同一件事」的共享短语 */
  shared: string[];
  signals: ConflictSignal[];
  verdict: ConflictVerdict;
  reason: string;
  aClaim: string;
  bClaim: string;
  conflictAt: string;
  /** 对应界面上的 [n]，拿不到时为 null */
  aN: number | null;
  bN: number | null;
}

export interface ConflictScan {
  pairs: number;
  candidates: number;
  judged: boolean;
  counts: Record<ConflictVerdict, number>;
  items: ScannedConflict[];
  errors: string[];
  ms: number;
}

// ── 知识地图（主题团） ──

export interface GraphNode {
  rel: string;
  title: string;
  chars: number;
  chunks: number;
  community: number;
  degree: number;
}

export interface GraphEdge {
  a: number;
  b: number;
  /** 折叠后的文档级权重 */
  w: number;
  pairs: number;
  /** 最强那一对片段的余弦 */
  top: number;
  /** 团内最强边的共享短语证据 */
  evidence: string[];
  /** 是不是跨团（桥接）边 */
  cross: boolean;
  /** 是两团之间唯一的一条边 */
  sole: boolean;
}

export interface GraphCommunity {
  id: number;
  members: number[];
  /** 团内边权重 / 团内外总权重，1 表示完全不和外面来往 */
  cohesion: number;
  label: string;
}

export interface DocGraph {
  builtAt: string;
  mode: 'semantic' | 'lexical';
  notice: string | null;
  nodes: GraphNode[];
  edges: GraphEdge[];
  communities: GraphCommunity[];
  isolates: number[];
  bridges: number[];
  conflicts: ScannedConflict[];
  stat: { chunks: number; docs: number; pairs: number; ms: number };
}

// ── 记忆激活（agent） ──
//
// 这些类型是服务端 server/services/activation.ts 的手写镜像。
// 不能 import：那个模块会 import node:fs，拖进浏览器包会炸。

export type ActivationStatus = 'running' | 'pending_review' | 'applied' | 'abandoned';

export interface ActivationStep {
  at: string;
  kind: 'model' | 'tool' | 'error' | 'stop';
  summary: string;
  ms: number;
}

export interface ActivationConcept {
  name: string;
  importance: number;
  coveredBy: string[];
  gap: boolean;
  reason?: string;
}

export interface ActivationCandidate {
  id: string;
  concept: string;
  front: string;
  back: string;
  quote: string;
  docRel: string;
  headingId: string;
  /** 六条判据逐条结果，键是判据 id */
  checks: Record<string, boolean>;
  blocked: string[];
  warned: string[];
  attempts: number;
  /** null = 还没看；true/false = 用户勾选/划掉 */
  accepted: boolean | null;
}

export interface ActivationSession {
  id: string;
  version: number;
  scope: { kind: 'community'; communityId: number; docRels: string[] };
  createdAt: string;
  updatedAt: string;
  status: ActivationStatus;
  concepts: ActivationConcept[];
  candidates: ActivationCandidate[];
  steps: ActivationStep[];
  usage: {
    promptTokens: number;
    completionTokens: number;
    model: string;
    ms: number;
    cacheReadTokens?: number;
    reasoningTokens?: number;
  } | null;
}

export interface GraphResponse {
  graph: DocGraph | null;
  /** 这份图是旧索引算的，后台正在重建 */
  stale: boolean;
  /** 后台正在建（首次打开就是这种，graph 为 null），隔一会再来问 */
  building: boolean;
  indexed: { chunks: number; withVec: number };
}

export interface IndexStatus {
  configured: boolean;
  model: string;
  dim: number;
  withVector: number;
  total: number;
  docs: number;
  builtAt: string | null;
}

export interface IndexBuildReport {
  docs: number;
  chunks: number;
  added: number;
  updated: number;
  removed: number;
  embedded: number;
  usedEmbedding: boolean;
  model: string;
  notice: string | null;
}

export interface AnchorDetail {
  id: string;
  kind: 'note' | 'highlight';
  status: 'ok' | 'repaired' | 'orphan';
  reason: string;
  score: number;
  needConfirm: boolean;
  from: { blockIndex: number; textOffset: number };
  to: { blockIndex: number; textOffset: number };
  preview: string;
}

export interface AnchorReport {
  ok: number;
  repaired: number;
  orphan: number;
  skipped: number;
  tookMs: number;
  details: AnchorDetail[];
}

export interface DocPayload {
  path: string;
  markdown: string;
  docHash: string;
  html: string;
  analysis: DocAnalysis;
  sidecar: Sidecar;
  anchorReport: AnchorReport | null;
}

export interface NoteWithHighlight {
  note: Note;
  highlight: Highlight | null;
}

/** 一次拆分的结果。dryRun 时 chunks 里是「将会写成什么名字」，磁盘没动。 */
export interface SplitOutcome {
  ok: boolean;
  reason: 'ok' | 'no_heading' | 'structure_broken' | 'section_too_big';
  /** 实际采用的切分层级（1 = h1）；0 表示没切 */
  level: number;
  original: string;
  chunks: { rel: string; title: string; blockCount: number; startBi: number }[];
  migrated: { highlights: number; notes: number; cards: number };
  /** 归属不明的批注数，正常应为 0 */
  unplaced: number;
  message: string;
}

/** 一条「别处的相关段落」。score 已归一化到 0~1。 */
export interface RelatedItem {
  id: string;
  docRel: string;
  docTitle: string;
  headingText: string;
  headingPath: string[];
  startBi: number;
  score: number;
  /** 证据：两边**连续共享**的短语（≥4 字），如「上下文压缩」。可能是空的（纯语义命中） */
  shared: string[];
  snippet: string;
}

/**
 * 去重：一组重复文章。
 *
 * kind 的三档区分了三种完全不同的「重复」，UI 必须分开对待：
 *   - exact  ：一模一样，删副本零风险
 *   - similar：高度重合但有出入，值得看一眼
 *   - subset ：一篇是另一篇的一部分，删前要慎重（默认不勾选）
 */
export type DupKind = 'exact' | 'similar' | 'subset';

export interface DupDoc {
  rel: string;
  title: string;
  chars: number;
  mtime: number;
  notes: number;
  highlights: number;
  cards: number;
  /** 与保留者的重合度（0~1） */
  similarity: number;
  /** 这一篇有多少内容能在保留者里找到（0~1）；「包含关系」那档看它 */
  containment: number;
  kind: DupKind;
}

export interface DupGroup {
  id: string;
  kind: DupKind;
  keeper: DupDoc;
  dups: DupDoc[];
  saveChars: number;
}

export interface DedupeReport {
  scanned: number;
  groups: DupGroup[];
  removable: number;
  saveChars: number;
  ms: number;
}

export interface DedupeApplyResult {
  removed: number;
  trashed: string[];
  failed: { rel: string; message: string }[];
}

export interface RelatedResult {
  center: { docRel: string; docTitle: string; headingText: string; startBi: number } | null;
  items: RelatedItem[];
  /** 'semantic' 有向量参与；'lexical' 没配向量接口或这次算失败，纯关键词 */
  mode: 'lexical' | 'semantic';
  notice: string | null;
}

export interface FontInfo {
  /** 文件名（唯一标识） */
  file: string;
  /** CSS font-family 值 */
  family: string;
  /** 界面上显示的名字 */
  label: string;
  size: number;
  format: 'truetype' | 'opentype' | 'collection' | 'woff' | 'woff2';
  addedAt: string;
}

export interface UploadResult {
  ok: true;
  type: 'pdf' | 'text' | 'binary';
  relPath: string;
  savedPdf?: string | null;
  pageCount?: number;
  warnings?: string[];
  charCount?: number;
  changes?: { rule: string; count: number }[];
  bytes?: number;
}

export interface FormatResult {
  markdown: string;
  changes: { rule: string; count: number }[];
  mode: 'rules' | 'ai';
}

/** 飞书导入前的预览：只查标题，不下载图片，所以很快。 */
export interface FeishuPeek {
  title: string;
  documentId: string;
  kind: 'docx' | 'wiki' | 'docs';
  /** 后端清理过的文件名（不含扩展名） */
  suggestedName: string;
  suggestedRel: string;
  /** 目标目录里已经有同名文章了，会存成 xxx-2.md */
  renamed: boolean;
}

export interface FeishuImportResult {
  ok: true;
  relPath: string;
  title: string;
  renamed: boolean;
  imageCount: number;
  charCount: number;
  blockCount: number;
  changes: { rule: string; count: number }[];
  warnings: string[];
}

export interface ZipImportResult {
  ok: true;
  /** 导入的文章数 */
  count: number;
  imageCount: number;
  relPaths: string[];
  /** 导入后自动打开这一篇 */
  primaryRel: string | null;
  changes: { rule: string; count: number }[];
  warnings: string[];
  skipped: string[];
}

export interface CheatsheetResult {
  sections: CheatsheetSection[];
  generated: number;
  skipped: number;
  droppedQuotes: number;
}

export interface QuizResult {
  quiz: Quiz;
  droppedCitations: number;
}

export interface AttemptResult {
  score: number;
  total: number;
  perQuestion: { id: string; correct: boolean; partial: number; expected: (number | string)[] }[];
  attempt: { at: string; score: number; total: number };
}

export interface CardsResult {
  cards: Card[];
  created: number;
  droppedQuotes: number;
  /**
   * 树转闪卡才有的两项：自筛淘汰了哪些卡、以及取卡清单的逐条核销结果。
   * 有了 coverage，「全部覆盖」才是可核对的，而不是「模型说它覆盖了」。
   */
  rejected?: { front: string; blocked: string[]; detail: string[] }[];
  coverage?: {
    slots: number;
    covered: number;
    rate: number;
    uncovered: { id: string; label: string }[];
  };
}

export interface ReviewQueueResult {
  queue: (Card & { docPath: string })[];
  stats: { total: number; due: number; forecast: number[]; returned: number };
}

/** 三型混排的复习计划（今天栏的数据源）。kind: card=闪卡 / blank=填空 / qa=问答 */
export interface ReviewPlanItem {
  id: string;
  kind: 'card' | 'blank' | 'qa';
  /** 她排这条的理由（界面上会摆出来，让她能反驳） */
  why: string;
  cardId?: string;
  conceptKey?: string;
  question?: string;
  result: { verdict: string; note?: string; at: string } | null;
  card: (Card & { docPath: string }) | null;
  /** 填空/问答两型的素材：从知识树节点现挖（旧路径，走到测验管线后仅作兜底） */
  material: {
    doc: string;
    headingId: string;
    nodeName: string;
    kind: string;
    essence: string;
    details: { kind: string; text: string; quote: string }[];
  } | null;
  /**
   * 测验管线（quizPrompt）给**这一条**分配的那道题。
   * 服务端按条目顺序轮询，保证同一小节的几条不会问同一句。
   * 有了它就走 QuizPane（程序判对错），不再受「能不能挖空」的限制。
   */
  quiz: {
    id: string;
    type: 'single' | 'multi' | 'blank' | 'short';
    stem: string;
    options: string[];
    answer: (number | string)[];
    explain: string;
  } | null;
  /** 那一节总共有几道题（还剩多少可换） */
  quizTotal: number;
  /** 题出自哪个小节 */
  quizFrom: string | null;
}

export interface ReviewPlanResult {
  hasPlan: boolean;
  date?: string;
  plannedBy?: 'agent' | 'her';
  rationale?: string;
  today?: string;
  message?: string;
  items: ReviewPlanItem[];
}

/** 节级考频（派生自 markdown 里的面经文件；口径 = 公司标注次数） */
export interface SectionFreq {
  rel: string;
  headingId: string;
  headingText: string;
  /** 公司标注次数 */
  marks: number;
  companies: number;
  qn: number;
  /** 档位徽章：0 = 没有考频 */
  level: 0 | 1 | 2 | 3;
}

// ── 今天的统一行动清单（2026-09-14-15-10-08 S2）──

/** 与 server/services/todayActions.ts 的 ActionRow 对齐 */
export interface TodayActionRow {
  id: string;
  kind: 'card' | 'blank' | 'qa' | 'jump';
  title: string;
  /** 一句话理由，常驻 UI */
  why: string;
  reasons: { source: 'sm2' | 'plan' | 'freq' | 'mistake'; detail: string }[];
  conceptKey?: string;
  doc?: string;
  headingId?: string;
  cardId?: string;
  planItemId?: string;
  /** 0=错题+到期 > 1=到期 > 2=仅计划 > 3=考频阅读 */
  priority: number;
  action: 'open-reviewer' | 'open-plan-item' | 'jump-section';
}

export interface TodayResult {
  today: string;
  rows: TodayActionRow[];
  meta: {
    date: string;
    hasPlan: boolean;
    planRationale: string | null;
    dueCount: number;
    planCount: number;
    mergedByCard: number;
    mergedByConcept: number;
  };
}

export interface ReviewStatsResult {
  days: { date: string; cards: number; quizzes: number; avgScore: number | null }[];
  events: number;
}

// ─────────────────────────── 错误 ───────────────────────────

export class ApiError extends Error {
  status: number;
  code: string;
  extra: Record<string, unknown>;

  constructor(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.extra = extra;
  }

  /** 保存冲突（磁盘上的版本已经变了）。extra 里有 diskMarkdown / diskHash。 */
  get isConflict(): boolean {
    return this.status === 409 && this.code === 'conflict';
  }

  get isVaultMissing(): boolean {
    return this.code === 'vault_not_configured';
  }

  get isAiMissing(): boolean {
    return this.code === 'ai_not_configured';
  }
}

/** 把任意异常转成一句能直接显示给用户的中文。 */
export function errorText(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof DOMException && e.name === 'AbortError') return '请求已取消';
  if (e instanceof Error) return e.message;
  return String(e);
}

// ─────────────────────────── 请求核心 ───────────────────────────

const TOKEN = (() => {
  if (typeof document === 'undefined') return '';
  return document.querySelector<HTMLMetaElement>('meta[name="x-local-token"]')?.content ?? '';
})();

type Query = Record<string, string | number | boolean | undefined | null>;

function buildUrl(path: string, query?: Query): string {
  const url = `/api${path}`;
  if (!query) return url;
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    sp.set(k, String(v));
  }
  const qs = sp.toString();
  return qs ? `${url}?${qs}` : url;
}

interface CallOptions {
  query?: Query;
  body?: unknown;
  /** 原始二进制请求体（上传用），与 body 互斥 */
  raw?: BodyInit;
  signal?: AbortSignal;
  /** 覆盖 Content-Type（raw 时用） */
  contentType?: string;
}

async function call<T>(method: string, path: string, opts: CallOptions = {}): Promise<T> {
  const headers: Record<string, string> = { 'X-Local-Token': TOKEN };
  let body: BodyInit | undefined;
  if (opts.raw !== undefined) {
    body = opts.raw;
    if (opts.contentType) headers['Content-Type'] = opts.contentType;
  } else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }

  let res: Response;
  try {
    res = await fetch(buildUrl(path, opts.query), { method, headers, body, signal: opts.signal });
  } catch (e) {
    // 网络层失败（服务被关了 / 断网）：给一句比 "Failed to fetch" 有用得多的话
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new ApiError(0, 'network_error', '连不上本地服务，请确认启动窗口没有关闭', { cause: String(e) });
  }

  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  if (!res.ok) {
    const obj = (parsed ?? {}) as Record<string, unknown>;
    const msg = typeof obj.error === 'string' ? obj.error : `请求失败（HTTP ${res.status}）`;
    const code = typeof obj.code === 'string' ? obj.code : 'http_error';
    const { error: _e, code: _c, ...extra } = obj;
    throw new ApiError(res.status, code, msg, extra);
  }
  return parsed as T;
}

// ─────────────────────────── 接口 ───────────────────────────

/**
 * agent 一轮的用量（服务端 tokenMeter 归一化后的形状）。
 *
 * ★ 两个数不能混 ★ `promptTokens` 是线上原值、**含**缓存命中；
 * `cacheReadTokens` 是其中真的命中缓存的那部分（1/10 价）。所以
 * 「没命中」= promptTokens − cacheReadTokens，别直接拿 promptTokens 当花费。
 * 缓存字段可能不存在（老会话或网关不报）——那时不要当 0 看。
 */
export interface AgentUsage {
  promptTokens: number;
  completionTokens: number;
  calls: number;
  toolCalls: number;
  ms: number;
  /** 缓存命中的输入 token（可选：网关不报就没有） */
  cacheReadTokens?: number;
  /** 推理 token（可选） */
  reasoningTokens?: number;
}

/** 流式对话的单步事件（/agent/chat/stream 的 {type:'step'} 行）。 */
export interface AgentChatStepEvent {
  type: 'step';
  kind: 'model' | 'tool' | 'error' | 'stop';
  label: string;
  /** tool 步骤的入参（已截断） */
  input?: string;
  detail?: string;
  ms: number;
  failed?: boolean;
}

/** 流式对话的收尾事件（{type:'done'} 行）。 */
export interface AgentChatDone {
  type: 'done';
  answer: string;
  /** 服务端 createMd(html:false) 渲染 + ¶块号织成 .agent-ref 的 html，可安全插入 */
  answerHtml: string;
  stop: string;
  usage: AgentUsage;
  /** 这一轮落在哪条会话里（服务端自动新建时回传，前端拿它续聊）。 */
  threadId?: string;
}

/** 会话列表里的一条（服务端 ThreadMeta 的镜像）。 */
export interface ChatThreadMeta {
  id: string;
  docRel?: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  turnCount: number;
}

/** 会话里的一轮。 */
export interface ChatThreadTurn {
  at: string;
  role: 'user' | 'assistant';
  content: string;
  sessionId?: string;
  stop?: string;
  usage?: { promptTokens?: number; completionTokens?: number };
  steps?: { kind: string; label: string; ms: number; failed?: boolean }[];
}

export interface ChatThreadDetail {
  meta: ChatThreadMeta;
  turns: ChatThreadTurn[];
}

/** 审批卡里的一条变更（服务端 ApprovalAction 的镜像）。 */
export interface AgentApprovalAction {
  op: string;
  opLabel: string;
  doc: string;
  where: string;
  before?: string;
  after?: string;
  danger?: boolean;
}

/** 写工具要动库 → 挂起整轮等她在卡上点批准（2026-09-24）。 */
export interface AgentApproval {
  id: string;
  title: string;
  note?: string;
  actions: AgentApprovalAction[];
  danger: boolean;
}

/**
 * 审批相关事件对（同一批事件的开始与结束）：
 *   {type:'approval'}      挂起，等她点按钮
 *   {type:'approval_done'} 已决议（她点了，或超时自动拒绝）
 */
export type AgentApprovalEvent =
  | { type: 'approval'; approval: AgentApproval }
  | { type: 'approval_done'; id: string; approved: boolean; by: string; timedOut: boolean };

/** 小笔主动开口（C）：至多一条；kind=resume 断点续读 / stuck 卡壳概念。 */
export interface AgentNudge {
  kind: 'resume' | 'stuck';
  question: string;
  text: string;
  dedupKey: string;
}

/** 流式批注回复的收尾事件（/agent/notes/answer/stream 的 {type:'done'} 行）。 */
export interface AgentAnswerDone {
  type: 'done';
  replyWritten: boolean;
  reply: NoteReply | null;
  answer: string;
  /** 渲染 + ¶块号织成 .agent-ref 的 html，可安全插入 */
  answerHtml: string;
  stop: string;
  usage: AgentUsage;
}

export const api = {
  /**
   * 外部 AI 助手（DSH）的入口地址。NoteLM 托管它的启停和令牌；
   * 不可用时 available=false 并带给人看的原因（比如你从手机访问，而助手只装在电脑上）。
   */
  getAssistant: () =>
    call<{ available: boolean; url?: string; reason?: string }>('GET', '/assistant'),

  /**
   * 小抄条目的偏好标注 —— 系统里唯一「人的判断」入口。
   * ik 是条目内容的 hash（渲染时现算，不落盘）；mark 传 null 表示取消这一条。
   */
  cheatsheetFeedback: (
    rel: string,
    headingId: string,
    ik: string,
    mark: 'up' | 'down' | 'dup' | null,
    why?: string,
  ) =>
    call<{ ok: true; bin?: 'resurrected' | 'removed' | null; digest: { total: number; up: number; down: number; dup: number } }>(
      'POST',
      '/cheatsheet/feedback',
      { body: { rel, headingId, ik, mark, why } },
    ),

  /** 为一节生成知识树（组织主轴 = 知识点关系；现役条目视图保留作对比）。 */
  generateTree: (rel: string, headingId: string, force = false) =>
    call<{ section: CheatsheetSection; reused: boolean; located?: number; total?: number; issues: { level: string; msg: string }[] }>(
      'POST',
      '/cheatsheet/tree',
      { body: { rel, headingId, force } },
    ),

  // ── 设置 ──
  settingsState: () => call<SettingsState>('GET', '/settings/state'),

  setVault: (patch: { root?: string; useDefault?: boolean }) =>
    call<{ vault: VaultInfo }>('POST', '/settings/vault', { body: patch }),

  setAi: (patch: { baseURL?: string; model?: string; temperature?: number; apiKey?: string }) =>
    call<{ ai: AiState }>('POST', '/settings/ai', { body: patch }),

  clearAiKey: () => call<{ ok: true }>('DELETE', '/settings/ai/key'),

  testAi: () => call<{ ok: boolean; model?: string; ms?: number; reply?: string; error?: string }>('POST', '/settings/ai/test'),

  /** 向量接口：和对话接口分开存，互不干扰 */
  setEmbedding: (patch: { baseURL?: string; model?: string; dimensions?: number; apiKey?: string }) =>
    call<{ embedding: EmbeddingState }>('POST', '/settings/embedding', { body: patch }),

  clearEmbeddingKey: () => call<{ ok: true }>('DELETE', '/settings/embedding/key'),

  testEmbedding: () => call<{ ok: boolean; model?: string; dim?: number; ms?: number; error?: string }>('POST', '/settings/embedding/test'),

  /**
   * 飞书导入凭据。appId 明文存在配置里（它不是机密，报错信息里也要能用），
   * appSecret 走和 AI key 一样的 secret 文件；传空串表示「不改」。
   */
  setFeishu: (patch: { appId?: string; appSecret?: string }) =>
    call<{ feishu: FeishuState }>('POST', '/settings/feishu', { body: patch }),

  clearFeishuSecret: () => call<{ ok: true }>('DELETE', '/settings/feishu/secret'),

  testFeishu: () => call<{ ok: boolean; message: string }>('POST', '/settings/feishu/test'),

  setPrefs: (patch: {
    theme?: 'light' | 'dark';
    themeColor?: string;
    panelWidths?: { left: number; right: number };
  }) =>
    call<{ theme: 'light' | 'dark'; themeColor: string; panelWidths: { left: number; right: number } }>('POST', '/settings/prefs', {
      body: patch,
    }),

  // ── 目录树 ──
  tree: () => call<{ tree: TreeNode }>('GET', '/tree'),

  createEntry: (patch: { type: 'doc' | 'dir'; parent: string; name: string }) =>
    call<{ ok: true; relPath: string; type: 'doc' | 'dir'; docHash?: string }>('POST', '/entry', { body: patch }),

  renameEntry: (from: string, to: string) => call<{ ok: true; from: string; to: string }>('PATCH', '/entry', { body: { from, to } }),

  deleteEntry: (rel: string) => call<{ ok: true; trashedTo: string }>('DELETE', '/entry', { query: { rel } }),

  reveal: (rel: string) => call<{ ok: true }>('POST', '/reveal', { body: { rel } }),

  openVault: () => call<{ ok: true; root: string }>('POST', '/open-vault'),

  existsRel: (rel: string) => call<{ exists: boolean }>('GET', '/exists', { query: { rel } }),

  // ── 文章 ──
  doc: (rel: string, signal?: AbortSignal) => call<DocPayload>('GET', '/doc', { query: { rel }, signal }),

  outline: (rel: string) =>
    call<{ path: string; docHash: string; chapters: DocAnalysis['chapters']; units: StudyUnit[]; blockCount: number }>(
      'GET',
      '/doc/outline',
      { query: { rel } },
    ),

  docUnit: (rel: string, headingId: string) =>
    call<{ unit: StudyUnit; text: string; headingPath: string[] }>('GET', '/doc/unit', { query: { rel, headingId } }),

  docHash: (rel: string) => call<{ docHash: string; size: number }>('GET', '/doc/hash', { query: { rel } }),

  /** 块级相关性：我在读这一块，别的文章里谁在讲同一件事。 */
  docRelated: (rel: string, bi: number, topK = 5, signal?: AbortSignal) =>
    call<RelatedResult>('GET', '/doc/related', { query: { rel, bi, topK }, signal }),

  /**
   * 把一篇过长的文档按标题切成若干篇。
   * dryRun=true 只返回会切成什么样，一个字节都不动。
   */
  splitDoc: (patch: { rel: string; maxBlocks?: number; dryRun?: boolean; removeOriginal?: boolean }) =>
    call<SplitOutcome>('POST', '/doc/split', { body: patch }),

  // ── 去重 ──
  /** 扫描全库，列出重复组。只读，不动任何文件。 */
  dedupeScan: () => call<DedupeReport>('GET', '/dedupe'),

  /** 用户确认后，把这几篇移进回收站（不是真删，可恢复）。 */
  dedupeApply: (rels: string[]) => call<DedupeApplyResult>('POST', '/dedupe/apply', { body: { rels } }),

  saveDoc: (patch: { rel: string; markdown: string; baseHash?: string; force?: boolean }) =>
    call<DocPayload & { reindexed?: boolean }>('PUT', '/doc', { body: { ...patch, reanalyze: true } }),

  /** 上传文件：原始二进制 + query 传文件名（不需要 multipart）。 */
  upload: (file: File, opts: { dir?: string; format?: boolean; keepOriginal?: boolean } = {}) =>
    call<UploadResult>('POST', '/upload', {
      query: {
        dir: opts.dir ?? '',
        name: file.name,
        format: opts.format ? '1' : undefined,
        keepOriginal: opts.keepOriginal ? '1' : undefined,
      },
      raw: file,
      contentType: file.type || 'application/octet-stream',
    }),

  // ── 导入（飞书 / 压缩包） ──
  /** 只看标题，不下载图片——用于「粘贴链接后先确认是哪一篇」。 */
  feishuPeek: (url: string, dir?: string) =>
    call<FeishuPeek>('POST', '/import/feishu/peek', { body: { url, dir: dir ?? '' } }),

  importFeishu: (patch: {
    url: string;
    /** 预览阶段拿到的，传了可以省掉接口调用 */
    documentId?: string;
    title?: string;
    dir?: string;
    name?: string;
    format?: boolean;
  }) => call<FeishuImportResult>('POST', '/import/feishu', { body: patch }),

  /** 导入飞书 / 语雀 / Notion 导出的 zip：原始二进制 + query 传目标目录。 */
  importZip: (file: File, opts: { dir?: string; format?: boolean } = {}) =>
    call<ZipImportResult>('POST', '/import/zip', {
      query: { dir: opts.dir ?? '', format: opts.format ? '1' : undefined },
      raw: file,
      contentType: file.type || 'application/zip',
    }),

  importPdf: (patch: { rel: string; outDir?: string; keepOriginal?: boolean }) =>
    call<{ ok: true; relPath: string; pageCount: number; warnings: string[]; charCount: number; markdown: string }>(
      'POST',
      '/import-pdf',
      { body: patch },
    ),

  format: (markdown: string, options?: Record<string, boolean>) =>
    call<FormatResult>('POST', '/format', { body: { markdown, options } }),

  formatApply: (patch: { rel: string; baseHash?: string; force?: boolean }) =>
    call<{ docHash: string; markdown: string; changes: { rule: string; count: number }[] }>('POST', '/format/apply', {
      body: patch,
    }),

  /** AI 排版：让模型把这篇重写成规范的 Markdown。耗时十几秒到几十秒，所以要能取消。 */
  formatAi: (markdown: string, signal?: AbortSignal) =>
    call<FormatResult>('POST', '/format/ai', { body: { markdown }, signal }),

  // ── 批注 / 高亮 / 锚点 ──
  createNote: (patch: { rel: string; selector: TextQuoteSelector; body: string; tags?: string[]; color?: string; createHighlight?: boolean }) =>
    call<NoteWithHighlight>('POST', '/notes', { body: patch }),

  patchNote: (id: string, patch: { rel: string; body?: string; tags?: string[]; color?: string }) =>
    call<Note>('PATCH', `/notes/${encodeURIComponent(id)}`, { body: patch }),

  /** 在一条批注下追加回复（B2-2 批注回复通道）。 */
  addNoteReply: (id: string, patch: { rel: string; body: string }) =>
    call<NoteReply>('POST', `/notes/${encodeURIComponent(id)}/replies`, { body: patch }),

  /** 让库内 agent 就地回答一条批注（同步，几十秒量级）。 */
  askAssistantNote: (rel: string, noteId: string) =>
    call<{
      ok: true;
      replyWritten: boolean;
      reply: NoteReply | null;
      answer: string;
      stop: string;
      usage: AgentUsage;
    }>('POST', '/agent/notes/answer', { body: { rel, noteId } }),

  /**
   * 流式批注回复：每步完成回调 onStep（NDJSON 逐行），结束返回最终结果。
   * 事件形状与 chatWithAgentStream 一致；done 额外带 replyWritten / reply。
   */
  answerNoteStream: async (
    rel: string,
    noteId: string,
    onStep: (s: AgentChatStepEvent) => void,
    signal?: AbortSignal,
  ): Promise<AgentAnswerDone> => {
    let res: Response;
    try {
      res = await fetch(buildUrl('/agent/notes/answer/stream'), {
        method: 'POST',
        headers: { 'X-Local-Token': TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ rel, noteId }),
        signal,
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') throw e;
      throw new ApiError(0, 'network_error', '连不上本地服务，请确认启动窗口没有关闭', { cause: String(e) });
    }
    if (!res.ok) {
      const text = await res.text();
      let obj: Record<string, unknown> = {};
      try {
        obj = JSON.parse(text) as Record<string, unknown>;
      } catch {
        /* 保持空对象 */
      }
      const msg = typeof obj.error === 'string' ? obj.error : `请求失败（HTTP ${res.status}）`;
      const code = typeof obj.code === 'string' ? obj.code : 'http_error';
      throw new ApiError(res.status, code, msg);
    }
    const reader = res.body?.getReader();
    if (!reader) throw new ApiError(0, 'stream_unsupported', '当前环境不支持流式响应');
    const dec = new TextDecoder();
    let buf = '';
    let done: AgentAnswerDone | null = null;
    const handleLine = (line: string): void => {
      const t = line.trim();
      if (!t) return;
      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(t) as Record<string, unknown>;
      } catch {
        return; // 半行/脏行直接跳过
      }
      if (ev.type === 'step') {
        onStep(ev as unknown as AgentChatStepEvent);
      } else if (ev.type === 'done') {
        done = ev as unknown as AgentAnswerDone;
      } else if (ev.type === 'error') {
        throw new Error(typeof ev.error === 'string' ? ev.error : 'agent 出错了');
      }
    };
    try {
      for (;;) {
        const { done: fin, value } = await reader.read();
        if (fin) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          handleLine(buf.slice(0, i));
          buf = buf.slice(i + 1);
        }
      }
      handleLine(buf);
    } finally {
      reader.releaseLock();
    }
    if (!done) throw new ApiError(0, 'stream_incomplete', 'agent 的响应流提前结束，没有拿到回答');
    return done;
  },

  /** 和库内 agent 直接聊一轮（BottomDock「AI 助手」，DSH 已撤下）。历史由前端带回，服务端不存对话。 */
  chatWithAgent: (
    messages: { role: 'user' | 'assistant'; content: string }[],
    docRel?: string,
  ) =>
    call<{
      ok: true;
      answer: string;
      stop: string;
      usage: AgentUsage;
    }>('POST', '/agent/chat', { body: { messages, docRel } }),

  /** 小笔主动开口：有话就冒一句（服务端已记 7 天冷却），没话 null。 */
  nudge: () => call<{ nudge: AgentNudge | null }>('GET', '/agent/nudge'),

  /**
   * 成本总账（C 层）：从已落盘的会话文件纯回放折出来，不调模型。
   * `instrumented` = 带缓存字段的会话数，只有它 > 0，`hitRate` 才有意义。
   */
  agentStats: (days = 7) =>
    call<{
      sessions: number;
      instrumented: number;
      calls: number;
      toolCalls: number;
      promptTokens: number;
      completionTokens: number;
      cacheReadTokens: number;
      reasoningTokens: number;
      ms: number;
      hitRate: number | null;
      days: number;
      byTool: { name: string; n: number }[];
      byDay: { day: string; calls: number; promptTokens: number; cacheReadTokens: number }[];
    }>('GET', `/agent/stats?days=${days}`),

  // ───────────── 会话层（threads，2026-10-08）─────────────
  // 结构照搬 DSH 的 session controller，数据落在她的库里。
  // ★ 「清空」不是一个操作 —— 新建一条就是清空，旧的还在列表里。

  /** 新建会话（= 清空当前对话，旧的不动）。 */
  threadsCreate: (docRel?: string) =>
    call<{ ok: true; thread: ChatThreadMeta }>('POST', '/agent/threads', {
      body: { ...(docRel ? { docRel } : {}) },
    }),

  /** 列表。scope='doc' 只给这篇文档的 + 全局的；'all' 给全部。 */
  threadsList: (docRel?: string, scope: 'doc' | 'all' = 'doc', limit = 40) =>
    call<{ ok: true; threads: ChatThreadMeta[] }>(
      'GET',
      `/agent/threads?scope=${scope}&limit=${limit}${docRel ? `&docRel=${encodeURIComponent(docRel)}` : ''}`,
    ),

  /** 读整条（含 turns）。 */
  threadsRead: (id: string) => call<{ ok: true } & ChatThreadDetail>('GET', `/agent/threads/${encodeURIComponent(id)}`),

  /** 改名。 */
  threadsRename: (id: string, title: string) =>
    call<{ ok: true; thread: ChatThreadMeta }>('POST', `/agent/threads/${encodeURIComponent(id)}/rename`, { body: { title } }),

  /** 归档 / 取消归档：只从默认列表消失，内容还在。 */
  threadsArchive: (id: string, archived: boolean) =>
    call<{ ok: true; thread: ChatThreadMeta }>('POST', `/agent/threads/${encodeURIComponent(id)}/archive`, { body: { archived } }),

  /** 分叉：把前 upto 轮复制到新会话，原会话不动。 */
  threadsFork: (id: string, upto: number) =>
    call<{ ok: true; thread: ChatThreadMeta }>('POST', `/agent/threads/${encodeURIComponent(id)}/fork`, { body: { upto } }),

  /**
   * 流式对话：每步完成回调 onStep（NDJSON 逐行），结束后返回最终结果。
   * onApproval：写工具挂起等确认时推来的事件对（approval / approval_done）——
   * AgentChatPanel 拿它渲染内联确认卡。
   * 事件形状见 server/routes/agent.ts 的 /agent/chat/stream 注释。
   */
  chatWithAgentStream: async (
    messages: { role: 'user' | 'assistant'; content: string }[],
    docRel: string | undefined,
    onStep: (s: AgentChatStepEvent) => void,
    onApproval?: (ev: AgentApprovalEvent) => void,
    signal?: AbortSignal,
    /**
     * 会话 id。不传 = 服务端自动新建一条（「清空」的落地方式就是开新的，
     * 旧的留在列表里），新建的 id 从 done 事件的 threadId 拿回来。
     */
    threadId?: string,
  ): Promise<AgentChatDone> => {
    let res: Response;
    try {
      res = await fetch(buildUrl('/agent/chat/stream'), {
        method: 'POST',
        headers: { 'X-Local-Token': TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages, docRel, ...(threadId ? { threadId } : {}) }),
        signal,
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') throw e;
      throw new ApiError(0, 'network_error', '连不上本地服务，请确认启动窗口没有关闭', { cause: String(e) });
    }
    if (!res.ok) {
      const text = await res.text();
      let obj: Record<string, unknown> = {};
      try {
        obj = JSON.parse(text) as Record<string, unknown>;
      } catch {
        /* 保持空对象 */
      }
      const msg = typeof obj.error === 'string' ? obj.error : `请求失败（HTTP ${res.status}）`;
      const code = typeof obj.code === 'string' ? obj.code : 'http_error';
      throw new ApiError(res.status, code, msg);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new ApiError(0, 'stream_unsupported', '当前环境不支持流式响应');
    const dec = new TextDecoder();
    let buf = '';
    let done: AgentChatDone | null = null;
    const handleLine = (line: string): void => {
      const t = line.trim();
      if (!t) return;
      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(t) as Record<string, unknown>;
      } catch {
        return; // 半行/脏行直接跳过，不能让一次解析错误炸掉整轮
      }
      if (ev.type === 'step') {
        onStep(ev as unknown as AgentChatStepEvent);
      } else if (ev.type === 'approval' || ev.type === 'approval_done') {
        onApproval?.(ev as unknown as AgentApprovalEvent);
      } else if (ev.type === 'done') {
        done = ev as unknown as AgentChatDone;
      } else if (ev.type === 'error') {
        throw new Error(typeof ev.error === 'string' ? ev.error : 'agent 出错了');
      }
    };
    try {
      for (;;) {
        const { done: fin, value } = await reader.read();
        if (fin) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          handleLine(buf.slice(0, i));
          buf = buf.slice(i + 1);
        }
      }
      handleLine(buf);
    } finally {
      reader.releaseLock();
    }
    if (!done) throw new ApiError(0, 'stream_incomplete', 'agent 的响应流提前结束，没有拿到回答');
    return done;
  },

  /**
   * 她在确认卡上点「批准 / 拒绝」。服务端据此解开挂起的 agent 轮次。
   * 404 = 这条已经不在等待了（超时/重复点击），按无害处理即可。
   */
  resolveApproval: (id: string, approved: boolean) =>
    call<{ ok: true; id: string; approved: boolean }>('POST', `/agent/approvals/${encodeURIComponent(id)}`, {
      body: { approved },
    }),

  deleteNote: (id: string, rel: string, keepHighlight = false) =>
    call<{ ok: true; id: string }>('DELETE', `/notes/${encodeURIComponent(id)}`, {
      query: { rel, keepHighlight: keepHighlight ? '1' : undefined },
    }),

  createHighlight: (patch: { rel: string; selector: TextQuoteSelector; color?: string; noteId?: string | null }) =>
    call<Highlight>('POST', '/highlights', { body: patch }),

  patchHighlight: (id: string, patch: { rel: string; color?: string; noteId?: string | null }) =>
    call<Highlight>('PATCH', `/highlights/${encodeURIComponent(id)}`, { body: patch }),

  deleteHighlight: (id: string, rel: string) =>
    call<{ ok: true; id: string }>('DELETE', `/highlights/${encodeURIComponent(id)}`, { query: { rel } }),

  reanchor: (rel: string) => call<{ report: AnchorReport }>('POST', '/anchors/reanchor', { body: { rel } }),

  rebind: (patch: { rel: string; kind: 'note' | 'highlight'; id: string; selector: TextQuoteSelector }) =>
    call<Note | Highlight>('POST', '/anchors/rebind', { body: patch }),

  locate: (rel: string, quote: string) =>
    call<{ found: boolean; blockIndex?: number; textOffset?: number; quoteLength?: number }>('POST', '/anchors/locate', {
      body: { rel, quote },
    }),

  anchorHealth: (rel: string) =>
    call<{
      notes: { total: number; orphan: number };
      highlights: { total: number; orphan: number };
      indexedAt: string;
      staleHash: boolean;
    }>('GET', '/anchors/health', { query: { rel } }),

  clearAnnotations: (rel: string, what: 'notes' | 'highlights' | 'all' = 'all') =>
    call<{ ok: true }>('POST', '/annotations/clear', { body: { rel, what } }),

  // ── AI 学习功能 ──
  generateCheatsheet: (patch: { rel: string; headingIds?: string[]; force?: boolean; strict?: boolean }) =>
    call<CheatsheetResult>('POST', '/cheatsheet/generate', { body: patch }),

  getCheatsheet: (rel: string) => call<{ sections: CheatsheetSection[] }>('GET', '/cheatsheet', { query: { rel } }),

  deleteCheatsheet: (rel: string, headingId?: string) =>
    call<{ ok: true }>('DELETE', '/cheatsheet', { query: { rel, headingId } }),

  generateQuiz: (patch: { rel: string; headingId: string; count?: number; force?: boolean }) =>
    call<QuizResult>('POST', '/quiz/generate', { body: patch }),

  getQuiz: (rel: string) => call<{ quizzes: Quiz[] }>('GET', '/quiz', { query: { rel } }),

  deleteQuiz: (rel: string, quizId?: string) => call<{ ok: true }>('DELETE', '/quiz', { query: { rel, quizId } }),

  submitAttempt: (patch: { rel: string; quizId: string; answers: Record<string, (number | string)[]>; durationMs?: number }) =>
    call<AttemptResult>('POST', '/quiz/attempt', { body: patch }),

  cardsFromCheatsheet: (patch: { rel: string; headingId: string; skipExisting?: boolean }) =>
    call<CardsResult>('POST', '/cards/from-cheatsheet', { body: patch }),

  /** 知识树 → 闪卡。这是现在唯一能对有树的节用的那条路（旧的依赖已退役的小抄）。 */
  cardsFromTree: (patch: { rel: string; headingId: string; skipExisting?: boolean; strict?: boolean }) =>
    call<CardsResult>('POST', '/cards/from-tree', { body: patch }),

  cardsFromNotes: (patch: { rel: string; noteIds?: string[]; skipExisting?: boolean }) =>
    call<CardsResult>('POST', '/cards/from-notes', { body: patch }),

  createCard: (patch: { rel: string; front: string; back: string; headingId?: string; quote?: string }) =>
    call<Card>('POST', '/cards', { body: patch }),

  patchCard: (id: string, patch: { rel: string; front?: string; back?: string; suspended?: boolean; reset?: boolean; fb?: 'up' | 'down' | 'dup' | null; fbWhy?: string }) =>
    call<Card>('PATCH', `/cards/${encodeURIComponent(id)}`, { body: patch }),

  deleteCard: (id: string, rel: string) => call<{ ok: true; id: string }>('DELETE', `/cards/${encodeURIComponent(id)}`, { query: { rel } }),

  getCards: (rel: string) =>
    call<{ cards: Card[]; stats: { total: number; due: number; newCount: number; forecast: number[] } }>('GET', '/cards', {
      query: { rel },
    }),

  reviewQueue: (limit = 50) => call<ReviewQueueResult>('GET', '/review/queue', { query: { limit } }),

  /**
   * 节级考频 top-N（左栏「今天」用）。
   * ★ 派生值：markdown 是唯一事实源，面经文件一变 signature 就变、这里就重算。
   */
  frequencyTop: (n = 6, rel?: string) =>
    call<{ signature: string; computedAt: string; unresolved: number; sections: SectionFreq[] }>(
      'GET',
      '/frequency/top',
      { query: rel ? { rel } : { n } },
    ),

  /** 复习计划（小笔排的，今天栏用）。没有计划时 hasPlan=false，不是错误。 */
  reviewPlan: () => call<ReviewPlanResult>('GET', '/review/plan'),

  /** 今天的统一行动清单（SM-2 到期 + 小笔计划 + 考频，三口径合一，每行带 why）。 */
  today: () => call<TodayResult>('GET', '/today'),

  /** 记一条作答。verdict：again/hard/good（闪卡自评）、correct/partial/wrong（填空与问答）、skipped */
  answerReviewItem: (patch: { itemId: string; verdict: string; note?: string }) =>
    call<{ ok: true; answered: number; total: number }>('POST', '/review/plan/answer', { body: patch }),

  /**
   * 计划历史（append-only 快照）。
   *
   * ★ 为什么要看历史 ★
   *   计划每天覆盖 `current`，所以「昨天小笔排了什么」只在历史里。
   *   那是她唯一能问「为什么今天是这个」的地方 —— 小笔说了什么会消失，
   *   「它当时为什么这么排」才留得住。
   */
  reviewPlanHistory: () =>
    call<{
      history: {
        seq: number;
        date: string;
        plannedBy: string;
        rationale: string;
        count: number;
        at: string;
        isCurrent: boolean;
      }[];
      note: string;
    }>('GET', '/review/plan/history'),

  /** 和小笔的历史会话（M3 留痕，每条只存首问与结果） */
  agentSessions: (limit = 40) =>
    call<{
      sessions: {
        id: string;
        startedAt?: string;
        prompt?: string;
        steps?: number;
        stop?: string;
        usage?: { promptTokens?: number; completionTokens?: number };
      }[];
    }>('GET', '/agent/sessions', { query: { limit } }),

  /** 全库闪卡存量（她问「闪卡是不是太少了」时给数，不是靠翻库） */
  cardStock: () =>
    call<{
      total: number;
      linked: number;
      unlinked: number;
      treeSourced: number;
      suspended: number;
      docs: { doc: string; count: number; linked: number }[];
      note: string;
    }>('GET', '/cards/stock'),

  review: (patch: { rel: string; cardId: string; grade: 'forgot' | 'hard' | 'good'; durationMs?: number }) =>
    call<{ card: Card }>('POST', '/review', { body: patch }),

  reviewStats: () => call<ReviewStatsResult>('GET', '/review/stats'),

  /** 全库所有卡片（导出用）。不是复习队列：不做到期过滤、不截断。 */
  allCards: () => call<{ cards: (Card & { docPath: string })[]; total: number }>('GET', '/cards/all'),

  // ── 跨文章检索（RAG） ──
  searchStatus: () => call<IndexStatus>('GET', '/search/status'),

  buildSearchIndex: (force?: boolean) => call<IndexBuildReport>('POST', '/search/index', { body: { force: force === true } }),

  clearSearchIndex: () => call<{ ok: true }>('DELETE', '/search/index'),

  search: (q: string, topK?: number) => call<SearchOutcome>('GET', '/search', { query: { q, topK } }),

  askSearch: (question: string, topK?: number, conflicts?: boolean) =>
    call<SearchAskResult>('POST', '/search/ask', { body: { question, topK, conflicts: conflicts === true } }),

  /** 对「屏幕上这几条命中」做矛盾检查（会调模型，所以是 POST） */
  scanConflicts: (hits: SearchHit[], max?: number) =>
    call<ConflictScan>('POST', '/search/conflicts', {
      body: {
        hits: hits.map((h) => ({
          id: h.id,
          docRel: h.docRel,
          docTitle: h.docTitle,
          headingText: h.headingText,
          headingPath: h.headingPath,
          startBi: h.startBi,
          text: h.text,
        })),
        max,
      },
    }),

  // ── 知识地图（主题团，零模型调用） ──
  graph: () => call<GraphResponse>('GET', '/graph'),

  rebuildGraph: (force?: boolean) =>
    call<{ graph: DocGraph; stat: { chunks: number; withVec: number } }>('POST', '/graph/rebuild', { body: { force: force === true } }),

  // ── 记忆激活（agent） ──
  //
  // start 是「发起」不是「跑完」：它立刻返回会话 id，agent 在服务端后台跑，
  // 前端靠轮询 activationGet 看进度。一次激活要几十秒到几分钟，
  // 挂在这里等会把请求卡死。
  activationStart: (communityId: number) =>
    call<{ session: ActivationSession; reused: boolean }>('POST', '/activation/start', { body: { communityId } }),

  activationGet: (id: string) =>
    call<{ session: ActivationSession; running: boolean }>('GET', `/activation/${encodeURIComponent(id)}`),

  activationLatest: (communityId: number) =>
    call<{ session: ActivationSession | null }>('GET', '/activation', { query: { communityId } }),

  activationDecide: (id: string, decided: { id: string; accepted: boolean }[]) =>
    call<{ session: ActivationSession }>('POST', `/activation/${encodeURIComponent(id)}/decide`, { body: { decided } }),

  activationApply: (id: string) =>
    call<{ session: ActivationSession; written: number; failed: string[] }>(
      'POST',
      `/activation/${encodeURIComponent(id)}/apply`,
      { body: {} },
    ),

  activationDrop: (id: string) => call<{ ok: true }>('DELETE', `/activation/${encodeURIComponent(id)}`),

  // ── 自备字体（小抄的呈现偏好） ──
  // 文件本身走 /font/:file（不走 /api，因为 CSS 的 @font-face 带不了 token 头），
  // 所以这里给一个纯字符串 URL，而不是走 call()。
  fonts: () => call<{ fonts: FontInfo[]; accept: string[] }>('GET', '/fonts'),

  uploadFont: (file: File) =>
    call<{ font: FontInfo }>('POST', '/fonts', {
      query: { name: file.name },
      raw: file,
      contentType: 'application/octet-stream',
    }),

  deleteFont: (file: string) =>
    call<{ ok: true; fonts: FontInfo[] }>('DELETE', `/fonts/${encodeURIComponent(file)}`),
};

/**
 * 字体文件 URL。注意它**不在 /api 下**：@font-face 发不出 X-Local-Token。
 *
 * @param v 版本号（一般是字体的 addedAt）。字体文件是强缓存（24h），
 *   同名覆盖上传后靠这个参数让浏览器重新去取，否则要等一天才看得到新字体。
 */
export function fontUrl(file: string, v?: string): string {
  const base = `/font/${encodeURIComponent(file)}`;
  return v ? `${base}?v=${encodeURIComponent(v)}` : base;
}
