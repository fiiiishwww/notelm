/**
 * server/services/tokenMeter.ts —— 用量计量层（C 层，2026-09-23）。
 *
 * ★ 为什么单独一层 ★
 *   对齐 DSH 的 `dsh-token-meter`：计量是**纯函数 + 纯回放**，不调模型、不含配置，
 *   所以「成本显示」「预算判定」「命中率审计」读的是同一份数字，不会各算各的。
 *
 * ★ 四类互斥计数（这是最容易算错的地方）★
 *   DeepSeek 线上的 `prompt_tokens` **包含**缓存命中
 *   （`prompt_tokens = prompt_cache_hit_tokens + prompt_cache_miss_tokens`），
 *   而内部约定是**互斥**的：inputTokens 只算没命中的那部分。
 *   所以这里必须减掉、不能直接相加，否则一加就重复计费。
 *   照抄 DSH `dsh-llm-deepseek` 的 mapUsage（同一套线上字段，同一个坑）。
 *
 * ★ 中文不吃「4 字符 = 1 token」★
 *   DSH 自己在文档里承认那条启发式对 CJK 与 JSON schema 严重低估。
 *   我们库全是中文，所以 estimateTokens 按 CJK / ASCII 分段：
 *   CJK ≈ 1.7 字符/token，ASCII ≈ 4 字符/token。
 *   这只是估算——**有提供方报数时一律以提供方为准**，估算只在「没数可读」时兜底。
 */

/** 线上原始 usage（各家的字段名都收在这里，别散到调用方去认）。 */
export interface RawUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  /** DeepSeek 名字（= 缓存命中数） */
  prompt_cache_hit_tokens?: number;
  /** DeepSeek 名字（= 未命中数）；OpenAI 兼容网关一般不给 */
  prompt_cache_miss_tokens?: number;
  /** OpenAI / 多数兼容网关名字 */
  prompt_tokens_details?: { cached_tokens?: number };
  /** 推理模型：思考过程单独计费的部分 */
  completion_tokens_details?: { reasoning_tokens?: number };
}

/**
 * 归一化后的用量。**互斥**：inputTokens 与 cacheReadTokens 相加等于线上 prompt_tokens。
 * cacheWriteTokens 是 Anthropic 那套「显式写缓存」的概念，DeepSeek 自动缓存没有它，
 * 所以这里保留字段但通常为空——**「未提供」与「0」是两件事，缺就不写**。
 */
export interface NormalizedUsage {
  /** 未命中的输入（= 线上 prompt_tokens − cacheReadTokens） */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  /** 兼容旧契约：线上原始 prompt_tokens（**含**缓存命中），预算判定一直用它 */
  promptTokens: number;
  completionTokens: number;
}

/** 从线上 usage 里把命中数抠出来，兼容两种字段名。 */
function cacheReadOf(raw: RawUsage): number | undefined {
  const a = raw.prompt_tokens_details?.cached_tokens;
  if (typeof a === 'number' && Number.isFinite(a)) return a;
  const b = raw.prompt_cache_hit_tokens;
  return typeof b === 'number' && Number.isFinite(b) ? b : undefined;
}

/**
 * 归一化。返回 null = 这次调用根本没报用量（网关可能省略 usage 块）。
 * 注意：`prompt_cache_miss_tokens` 只用来交叉校验，不参与计算——
 * 以 `prompt_tokens - hit` 为准，因为不是每个网关都给 miss 字段。
 */
export function normalizeUsage(raw: RawUsage | null | undefined): NormalizedUsage | null {
  if (!raw) return null;
  const prompt = typeof raw.prompt_tokens === 'number' ? raw.prompt_tokens : undefined;
  const completion = typeof raw.completion_tokens === 'number' ? raw.completion_tokens : undefined;
  if (prompt === undefined && completion === undefined) return null;
  const promptTokens = prompt ?? 0;
  const completionTokens = completion ?? 0;
  const cacheRead = cacheReadOf(raw);
  const reasoning = raw.completion_tokens_details?.reasoning_tokens;
  return {
    // ★ 互斥：减掉命中，别相加
    inputTokens: Math.max(0, promptTokens - (cacheRead ?? 0)),
    outputTokens: completionTokens,
    ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
    ...(reasoning !== undefined && Number.isFinite(reasoning) ? { reasoningTokens: reasoning } : {}),
    promptTokens,
    completionTokens,
  };
}

/** 累加器形态（agentRuntime 每步往这里加）。 */
export interface UsageAccumulator extends NormalizedUsage {
  calls: number;
  toolCalls: number;
  ms: number;
}

export function newUsageAccumulator(): UsageAccumulator {
  return {
    inputTokens: 0,
    outputTokens: 0,
    promptTokens: 0,
    completionTokens: 0,
    calls: 0,
    toolCalls: 0,
    ms: 0,
  };
}

/**
 * 把一次调用的用量加进累加器。
 *
 * ★ 缺失字段只在**第一次真的出现**时才加到累加器上，之后一直累加——
 *   这样「整轮都没有缓存信息」与「有一轮报了 0 命中」在结果里是不同的：
 *   前者字段不存在，后者存在且等于 0。混起来会让命中率看起来像 0%。
 *
 * ★ calls / toolCalls / ms 不在这里加 ★
 *   它们不是「一次调用报回来的数」，而是循环自己才知道的事实（一次调用可能
 *   被重试、一轮里可能调 N 次工具），由 agentRuntime 直接写。
 *   所以本函数只负责四类 token 计数——别在这里偷偷 ++，会两边都加。
 */
export function addUsage(acc: UsageAccumulator, one: NormalizedUsage | null): void {
  if (!one) return;
  acc.inputTokens += one.inputTokens;
  acc.outputTokens += one.outputTokens;
  acc.promptTokens += one.promptTokens;
  acc.completionTokens += one.completionTokens;
  if (one.cacheReadTokens !== undefined) acc.cacheReadTokens = (acc.cacheReadTokens ?? 0) + one.cacheReadTokens;
  if (one.cacheWriteTokens !== undefined) acc.cacheWriteTokens = (acc.cacheWriteTokens ?? 0) + one.cacheWriteTokens;
  if (one.reasoningTokens !== undefined) acc.reasoningTokens = (acc.reasoningTokens ?? 0) + one.reasoningTokens;
}

// ─────────────────────── 字符 → token 估算 ───────────────────────

/** CJK 统一表意文字 + 全角标点 + 假名/谚文。 */
const CJK_RE = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef\uac00-\ud7af]/;

/**
 * 字符数 → token 估算（CJK 口径）。
 *
 * 中文实测约 1.5~2.0 字符/token（受标点与英文夹杂影响），ASCII 约 4 字符/token。
 * 取 1.7 / 4 做中位估计。**这是估算，不要当计费依据**；有提供方报数就用报数。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let ascii = 0;
  for (const ch of text) {
    if (CJK_RE.test(ch)) cjk++;
    else ascii++;
  }
  return Math.ceil(cjk / 1.7 + ascii / 4);
}

/** 上下文构成估算：给「钱花在哪一段」用。 */
export function estimateBreakdown(parts: {
  system?: string;
  tools?: string;
  messages?: string;
}): { systemTokens: number; toolsTokens: number; messageTokens: number } {
  return {
    systemTokens: estimateTokens(parts.system ?? ''),
    toolsTokens: estimateTokens(parts.tools ?? ''),
    messageTokens: estimateTokens(parts.messages ?? ''),
  };
}

// ─────────────────────── 命中率与会话回放 ───────────────────────

/**
 * 缓存命中率 = cacheRead / (input + cacheRead)。
 * 没有缓存信息（老会话、网关不报）时返回 null——**不许拿 0 冒充「没命中」**，
 * 那会把「没测到」说成「很差」。
 */
export function cacheHitRate(u: Pick<NormalizedUsage, 'inputTokens' | 'cacheReadTokens'>): number | null {
  const hit = u.cacheReadTokens;
  if (hit === undefined) return null;
  const total = u.inputTokens + hit;
  if (total <= 0) return null;
  return hit / total;
}

/** 会话级汇总（纯回放，不调模型）。 */
export interface CostRollup {
  sessions: number;
  /** 其中带缓存字段的会话数——只有这些能算命中率 */
  instrumented: number;
  /**
   * **只统计有缓存信息的会话**的 promptTokens。
   *
   * ★ 为什么不能拿 promptTokens 当命中率分母 ★
   *   老会话（改造前落盘的）没有 cacheReadTokens 字段，它们的 promptTokens
   *   照样会进总数。若用它当分母，命中率会被一批「根本没测过缓存」的历史数据
   *   稀释——恰好违反本层开头那条原则：**没测到 ≠ 很差**。
   *   分母只该是「测过的那些」。
   */
  instrumentedPromptTokens: number;
  calls: number;
  toolCalls: number;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  reasoningTokens: number;
  ms: number;
  /** 按工具计次（谁的调用次数最多） */
  byTool: { name: string; n: number }[];
  /** 按天：次数 + token（看趋势） */
  byDay: { day: string; calls: number; promptTokens: number; cacheReadTokens: number }[];
}

/** 会话记录里跟统计有关的最小形状（避免和 agentMemory 相互 import）。 */
export interface SessionUsageLike {
  at: string;
  tools?: { name: string }[];
  usage?: Partial<NormalizedUsage> & { calls?: number; toolCalls?: number; ms?: number };
}

/**
 * 把一堆会话记录折成一份成本总账。
 * ★ 回放式：输入是已落盘的记录，输出确定，任何消费方（UI / 审计脚本）拿到的是同一个数。
 * 老会话没有新字段 → 计 0，但**不计入 instrumented**，所以命中率不会被它们拉低。
 */
export function foldSessions(sessions: SessionUsageLike[]): CostRollup {
  const byTool = new Map<string, number>();
  const byDay = new Map<string, { calls: number; promptTokens: number; cacheReadTokens: number }>();
  const out: CostRollup = {
    sessions: sessions.length,
    instrumented: 0,
    instrumentedPromptTokens: 0,
    calls: 0,
    toolCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
    ms: 0,
    byTool: [],
    byDay: [],
  };
  for (const s of sessions) {
    for (const t of s.tools ?? []) byTool.set(t.name, (byTool.get(t.name) ?? 0) + 1);
    const u = s.usage;
    if (!u) continue;
    if (u.cacheReadTokens !== undefined) {
      out.instrumented++;
      out.instrumentedPromptTokens += u.promptTokens ?? 0;
    }
    out.calls += u.calls ?? 0;
    out.toolCalls += u.toolCalls ?? 0;
    out.promptTokens += u.promptTokens ?? 0;
    out.completionTokens += u.completionTokens ?? 0;
    out.cacheReadTokens += u.cacheReadTokens ?? 0;
    out.reasoningTokens += u.reasoningTokens ?? 0;
    out.ms += u.ms ?? 0;
    const day = s.at.slice(0, 10);
    const d = byDay.get(day) ?? { calls: 0, promptTokens: 0, cacheReadTokens: 0 };
    d.calls += u.calls ?? 0;
    d.promptTokens += u.promptTokens ?? 0;
    d.cacheReadTokens += u.cacheReadTokens ?? 0;
    byDay.set(day, d);
  }
  out.byTool = [...byTool].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n);
  out.byDay = [...byDay].map(([day, v]) => ({ day, ...v })).sort((a, b) => a.day.localeCompare(b.day));
  return out;
}
