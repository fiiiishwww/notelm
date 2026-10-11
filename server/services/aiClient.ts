/**
 * server/services/aiClient.ts —— OpenAI 兼容接口的调用封装。
 *
 * ★ 为什么 AI 请求要经过后端转发，而不是前端直连 ★
 *   1. CORS：DeepSeek、月之暗面、通义等一大批兼容接口**不返回** Access-Control-Allow-Origin，
 *      浏览器直连会被拦掉。后端转发没有这个限制。
 *   2. API Key：放在前端意味着它出现在 DevTools、内存快照、以及任何一次截图里。
 *      放后端 + 独立的 secrets.json（且 .notebook 下有 .gitignore）安全得多。
 *   3. 统一治理：超时、重试、JSON 修复、错误翻译只写一遍。
 *
 * 所有出网的 URL 都必须由用户自己填的 baseURL 拼出来——我们不硬编码任何第三方地址。
 */

import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { ApiError, bad, readConfig, readSecret, LOCAL_DIR, type AiEndpoint } from '../core';
import { normalizeUsage, type NormalizedUsage, type RawUsage } from './tokenMeter';
import { withAiGate } from './concurrency';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** role==='tool' 时必填：这次结果对应哪一次调用 */
  tool_call_id?: string;
  /** role==='tool' 时建议填：工具名，部分网关靠它对不上就报错 */
  name?: string;
  /** role==='assistant' 且模型那轮要求调工具时，必须原样带回 */
  tool_calls?: ToolCall[];
}

/**
 * OpenAI 兼容的 function calling 工具声明。
 *
 * 只声明了用得到的字段。`description` 不是注释而是契约——
 * 模型全靠它决定「调不调、传什么参」，写得含糊它就不会用。
 */
export interface ToolSpec {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** 模型要求调用某个工具。arguments 是**字符串**，需要自己 JSON.parse。 */
export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatOptions {
  /** 期望返回 JSON（会设置 response_format，并按 JSON 解析） */
  json?: boolean;
  temperature?: number;
  maxTokens?: number;
  /** 毫秒；默认 90s —— 生成小抄这种任务比 chat 慢得多 */
  timeoutMs?: number;
  /** 覆盖配置里的模型 */
  model?: string;
  /** ★ 指定用哪套具名接口（config.ai.profiles 的键）。不传 = 默认那套。 */
  profile?: string;
  signal?: AbortSignal;
  /** 可用工具。传了之后模型可能返回 tool_calls 而不是文本 */
  tools?: ToolSpec[];
  /** 'auto' 让它自己决定；'none' 强制不调；指定名字则强制调那个 */
  toolChoice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
  /**
   * ★ 思考模式开关（DeepSeek V4 / 兼容网关）★
   *
   * ★ 为什么必须有它 ★
   *   deepseek-flash 等推理模型**默认开启思考**，而 reasoning_tokens 与正文
   *   共享 max_tokens 额度（官文：「思维链内容通过 reasoning_content 返回，与 content 同级」）。
   *   实测（2026-10-10，chapter1 第一节，1200 字输入、max_tokens=8000）：
   *     · 默认思考：21 次调用里 17 次 finish_reason=length，其中 14 次推理吃满 8000、**正文 0 字**
   *     · 传 disabled：全部 finish_reason=stop，推理 token 归零，正文正常产出，**耗时从 30~35s 降到 5~6s**
   *   即：不关思考时，长输出任务有一半以上的调用是在**白烧额度**。
   *
   * false = 显式关思考；true = 显式开；不传 = 沿用网关默认（推理模型即开启）。
   * 网关不支持该字段时会被忽略，不会报错。
   */
  thinking?: boolean;
}

export interface AiSettings {
  /** 具名接口的名字；默认那套为空串 */
  name: string;
  baseURL: string;
  model: string;
  apiKey: string;
  /** 地址、模型、Key 三者齐全才算配好 */
  configured: boolean;
  /** 这一套接口的默认温度（profile 自己的优先，其次全局 ai.temperature） */
  temperature: number;
}

/**
 * 具名接口的 Key 还可以从环境变量取，方便脚本/CI 里跑实验而不落盘。
 * 约定：`NB_<大写名>_API_KEY`；另给常见服务商配几个别名，省得记约定。
 * ★ 别名是「同一个模型被不同网关托管」的实际情况 ★
 *   kimi 这套接口既可能直连月之暗面、也可能走硅基流动/其他聚合网关，
 *   名下的 Key 也就可能存在于好几种惯例命名里。挨个试一遍比让人记约定强。
 */
const ENV_KEY_ALIASES: Record<string, string[]> = {
  bailian: ['DASHSCOPE_API_KEY'],
  dashscope: ['DASHSCOPE_API_KEY'],
  kimi: ['MOONSHOT_API_KEY', 'KIMI_API_KEY', 'SILICONFLOW_API_KEY'],
  moonshot: ['MOONSHOT_API_KEY', 'KIMI_API_KEY', 'SILICONFLOW_API_KEY'],
};

function envKeyFor(profile: string): string {
  const upper = profile.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const names = [`NB_${upper}_API_KEY`, ...(ENV_KEY_ALIASES[profile.toLowerCase()] ?? [])];
  for (const n of names) {
    const v = (process.env[n] ?? '').trim();
    if (v) return v;
  }
  return '';
}

/** 取某一套接口的设置。`profile` 为空 = 原来那套（config.ai + secrets.apiKey）。 */
export async function getAiSettings(profile?: string): Promise<AiSettings> {
  const cfg = await readConfig();
  const secret = await readSecret();
  const name = (profile ?? '').trim();

  if (name) {
    const p: AiEndpoint | undefined = cfg.ai.profiles?.[name];
    const baseURL = (p?.baseURL ?? '').trim();
    const model = (p?.model ?? '').trim();
    const apiKey = ((secret.profileKeys ?? {})[name] ?? '').trim() || envKeyFor(name);
    return {
      name,
      baseURL,
      model,
      apiKey,
      configured: Boolean(baseURL && model && apiKey),
      temperature: p?.temperature ?? cfg.ai.temperature,
    };
  }

  const baseURL = (cfg.ai.baseURL || '').trim();
  const model = (cfg.ai.model || '').trim();
  const apiKey = (secret.apiKey || '').trim();
  return {
    name: '',
    baseURL,
    model,
    apiKey,
    configured: Boolean(baseURL && model && apiKey),
    temperature: cfg.ai.temperature,
  };
}

/** 列出配置里所有具名接口（含是否已有 Key）。给设置页和探针用。 */
export async function listAiProfiles(): Promise<
  { name: string; baseURL: string; model: string; hasApiKey: boolean; configured: boolean }[]
> {
  const cfg = await readConfig();
  const secret = await readSecret();
  const out: { name: string; baseURL: string; model: string; hasApiKey: boolean; configured: boolean }[] = [];
  for (const [name, p] of Object.entries(cfg.ai.profiles ?? {})) {
    const key = ((secret.profileKeys ?? {})[name] ?? '').trim() || envKeyFor(name);
    out.push({
      name,
      baseURL: p.baseURL ?? '',
      model: p.model ?? '',
      hasApiKey: Boolean(key),
      configured: Boolean((p.baseURL ?? '').trim() && (p.model ?? '').trim() && key),
    });
  }
  return out;
}

/**
 * 拉取该接口下可用的模型列表（GET /models）。
 *
 * ★ 为什么要它 ★ 各家模型名换代很快，写死在代码里的名字一年后就是错的。
 * 与其让人猜「到底该填 kimi-k2.6 还是 kimi-k2.5」，不如问接口一句它有哪些模型。
 */
export async function listModels(profile?: string): Promise<string[]> {
  const s = await getAiSettings(profile);
  // ★ 列模型恰恰是「模型名还没定」时要做的事，所以这里只要求地址 + Key
  if (!s.baseURL || !s.apiKey) throw new ApiError(409, `接口「${s.name || '默认'}」未配置完整`, 'ai_not_configured');
  const res = await fetch(modelsUrl(s.baseURL), {
    headers: { Authorization: `Bearer ${s.apiKey}` },
    signal: AbortSignal.timeout(20_000),
  });
  const raw = await res.text();
  if (!res.ok) throw new ApiError(res.status === 401 ? 401 : 502, translateHttpError(res.status, raw), 'ai_http_error');
  const parsed = JSON.parse(raw) as { data?: { id?: string }[] };
  return (parsed.data ?? []).map((m) => m.id ?? '').filter(Boolean).sort();
}

/** 把用户填的 baseURL 规整成 chat/completions 的完整地址。 */
export function completionsUrl(baseURL: string): string {
  const b = baseURL.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(b)) throw bad('接口地址必须以 http:// 或 https:// 开头', 'bad_base_url');
  // 用户可能填到不同深度，这里统一补到 /chat/completions
  if (/\/chat\/completions$/i.test(b)) return b;
  if (/\/v\d+$/i.test(b)) return `${b}/chat/completions`;
  return `${b}/v1/chat/completions`;
}

/** 同 completionsUrl，指向 /models（列模型接口）。 */
export function modelsUrl(baseURL: string): string {
  const b = baseURL.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(b)) throw bad('接口地址必须以 http:// 或 https:// 开头', 'bad_base_url');
  if (/\/models$/i.test(b)) return b;
  if (/\/v\d+$/i.test(b)) return `${b}/models`;
  return `${b}/v1/models`;
}

/** 拼子路径（files 等）：baseURL 可能填到 /v1 也可能不填。 */
export function apiUrl(baseURL: string, sub: string): string {
  const b = baseURL.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(b)) throw bad('接口地址必须以 http:// 或 https:// 开头', 'bad_base_url');
  const tail = sub.replace(/^\/+/, '');
  if (/\/v\d+$/.test(b)) return `${b}/${tail}`;
  return `${b}/v1/${tail}`;
}

/** 组装调用参数（拆出来是为了能单测，不用真的发请求）。 */
export function buildRequestBody(model: string, messages: ChatMessage[], opts: ChatOptions) {
  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: opts.temperature ?? 0.3,
  };
  if (opts.maxTokens) body.max_tokens = opts.maxTokens;
  // response_format 与 tools 一起发，部分网关会 400；调用方需要时自己二选一
  if (opts.json) body.response_format = { type: 'json_object' };
  if (opts.tools?.length) {
    body.tools = opts.tools;
    if (opts.toolChoice) body.tool_choice = opts.toolChoice;
  }
  // ★ 思考模式开关 ★ 见 ChatOptions.thinking 的注释：
  //   推理模型的思维链也占 max_tokens，长输出任务里会把正文挤成 0 字。
  //   显式给 thinking.type 是 DeepSeek V4 的官方开关（OpenAI 格式）。
  if (opts.thinking === true) body.thinking = { type: 'enabled' };
  else if (opts.thinking === false) body.thinking = { type: 'disabled' };
  return body;
}

export interface ChatResult {
  content: string;
  /** OpenAI 语义：'stop' 正常结束；'length' 表示被 max_tokens 拦腰截断；'tool_calls' 表示要调工具 */
  finishReason: string | null;
  /** 模型要求调用的工具。没传 tools 时一定是空数组 */
  toolCalls: ToolCall[];
  /**
   * 用量（已归一化，见 tokenMeter）：
   * `promptTokens`/`completionTokens` 是线上原值（promptTokens **含**缓存命中，
   * 预算判定一直用它，别改）；`cacheReadTokens` 等是可选拆分，网关不报就没有。
   */
  usage: NormalizedUsage | null;
}

/** fetch 的 TypeError 往往只说 "fetch failed"，底层原因（DNS/拒连/重置）在 cause 里。 */
function causeOf(e: Error): string {
  const c = (e as { cause?: unknown }).cause;
  if (!c) return '';
  if (c instanceof Error) return `（${c.name}: ${c.message}）`;
  if (typeof c === 'object' && c !== null) {
    const o = c as Record<string, unknown>;
    return `（${o.code ?? ''} ${o.message ?? ''}）`.trimEnd();
  }
  return `（${String(c)}）`;
}

/**
 * ★ 长请求专用 POST：走 node:http/https，不走全局 fetch ★
 *
 * 为什么：Node 内置 fetch（undici）有硬编码的「5 分钟等不到响应头就断开」
 * （HeadersTimeoutError，对外只表现为 TypeError: fetch failed）。
 * 推理模型整节读入 + 生成大 JSON，首字节经常超过 5 分钟 —— 硅基流动上的
 * Kimi-K2.6 全军覆没就是这个原因，和平台无关，换谁都会中。
 * node:http/https 没有响应头超时，req.setTimeout 只管 socket 空闲，
 * 模型慢慢写、连接保持活跃就不会被掐。
 */
function longPost(
  url: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request(
      u,
      { method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          cleanup();
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') });
        });
        res.on('error', (e) => {
          cleanup();
          reject(e);
        });
      },
    );
    req.setTimeout(timeoutMs, () => {
      const e = new Error(`连接空闲超过 ${Math.round(timeoutMs / 1000)} 秒`);
      e.name = 'AbortError';
      req.destroy(e);
    });
    const onAbort = () => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      req.destroy(e);
    };
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    signal?.addEventListener('abort', onAbort, { once: true });
    req.on('error', (e) => {
      cleanup();
      reject(e);
    });
    req.end(body);
  });
}

/**
 * 单次请求。比 chat() 多返回一个 finish_reason。
 *
 * 为什么要它：生成小抄、出题这类长输出经常被 max_tokens 截断，只剩半截 JSON。
 * 光看内容分不清是「模型乱写」还是「被截断了」，而这两种情况的补救办法完全不同——
 * 前者要让模型重新格式化，后者得加额度并让它写短一点。
 */
async function chatOnceRaw(
  messages: ChatMessage[],
  opts: ChatOptions & { noResponseFormat?: boolean } = {},
): Promise<ChatResult> {
  const s = await getAiSettings(opts.profile);
  // 有的网关/模型不认 response_format，会直接 400。降级一次，别让用户卡死在这。
  const wantJson = opts.json === true && opts.noResponseFormat !== true;
  if (!s.configured) {
    throw new ApiError(
      409,
      s.name
        ? `接口「${s.name}」还没配好。它需要 config.ai.profiles.${s.name} 的地址与模型，` +
          `以及 secrets 里同名的 profileKeys.${s.name}（或环境变量）。`
        : '还没有配置 AI 接口。请在「设置」里填写接口地址、模型名和 API Key。',
      'ai_not_configured',
    );
  }
  const url = completionsUrl(s.baseURL);
  const model = opts.model?.trim() || s.model;

  const ctl = new AbortController();
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  // 外部 signal 也要能取消（用户关掉面板就中断请求）
  const onAbort = () => ctl.abort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });

  let status = 0;
  let raw = '';
  try {
    const r = await longPost(
      url,
      {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${s.apiKey}`,
      },
      JSON.stringify(
        buildRequestBody(model, messages, {
          ...opts,
          json: wantJson,
          // 这套接口自己的温度优先于硬编码默认值（不同模型对温度的手感不一样）
          temperature: opts.temperature ?? s.temperature,
        }),
      ),
      timeoutMs,
      ctl.signal,
    );
    status = r.status;
    raw = r.text;
  } catch (e) {
    const err = e as Error;
    if (err.name === 'AbortError') {
      throw new ApiError(504, `AI 请求超时（${Math.round(timeoutMs / 1000)} 秒）或已被取消`, 'ai_timeout');
    }
    throw new ApiError(
      502,
      `连不上 AI 接口：${err.message}${causeOf(err)}。请检查「设置」里的接口地址是否正确、网络是否可达。`,
      'ai_unreachable',
    );
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }

  if (status < 200 || status >= 300) {
    if (wantJson && status === 400 && /response_format|json_object|json_schema/i.test(raw)) {
      return chatOnceRaw(messages, { ...opts, noResponseFormat: true });
    }
    // ★ 网关不支持 function calling 必须单独识别 ★
    //   报错文案和「参数写错」混在一起会让上层以为是自己的 bug。
    //   这里不静默降级：降级到 JSON 模式靠正则猜意图，成功率不可控，
    //   宁可明确告诉用户「换一个支持工具调用的模型」。
    if (opts.tools?.length && status === 400 && /tool|function/i.test(raw)) {
      throw new ApiError(
        400,
        `当前接口/模型似乎不支持 function calling（HTTP 400）：${raw.slice(0, 200)}。` +
          '「记忆激活」依赖工具调用，请换一个支持它的模型。',
        'ai_tools_unsupported',
        { status },
      );
    }
    // ★ 402 = 余额不足 / 额度用尽 ★
    //   单独识别，因为它既不是「配置错了」也不是「服务挂了」，而是一句要人去充钱的话。
    //   网关返回体里常带着余额、套餐等隐私字段，所以**只进服务端日志**，
    //   不拼进给用户看的文案（其它错误分支保留了原文，是因为那些确实要靠它排查）。
    if (status === 402) {
      console.warn('[ai] 402 out of credit:', raw.slice(0, 300));
      throw new ApiError(402, AI_OUT_OF_CREDIT, 'ai_out_of_credit', { status });
    }
    throw new ApiError(status === 401 || status === 403 ? 401 : 502, translateHttpError(status, raw), 'ai_http_error', {
      status,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ApiError(502, `AI 接口返回的不是 JSON（前 200 字）：${raw.slice(0, 200)}`, 'ai_bad_response');
  }

  const toolCalls = extractToolCalls(parsed);
  const content = extractContent(parsed);
  // 模型只调工具时 content 通常是 null 或空串，这是正常的，不能当成「返回里找不到文本」
  if (content === null && toolCalls.length === 0) {
    throw new ApiError(502, `AI 接口返回里找不到文本内容：${raw.slice(0, 300)}`, 'ai_bad_response');
  }
  return {
    content: content ?? '',
    finishReason: extractFinishReason(parsed),
    toolCalls,
    usage: extractUsage(parsed),
  };
}

// ───────────────── 429/529 退避重试 + 全局并发闸（2026-10-11）─────────────────

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function isRateLimitError(e: unknown): boolean {
  if (!(e instanceof ApiError)) return false;
  const http = Number(e.extra?.status ?? e.status);
  return http === 429 || http === 529;
}

/**
 * 传输层 429 退避：撞限流就等一等再试，而不是把错误文案甩给用户。
 *
 * ★ 与 chatJson 的 ×2.5 重试正交 ★
 *   chatJson 的重试是**内容层**（JSON 坏/截断才重试），这里是**传输层**（真 429 才触发），
 *   两者不会互相放大：最坏 3 内容轮 × (1+3 传输) = 12 次请求，且只在真限流时发生。
 * ★ 退避期间仍占着并发闸的名额 ★ —— 释放后重试瞬间再打满，闸就形同虚设。
 * ★ 开关 AI_RETRY_429=off 回到旧行为（429 直接抛文案，不重试）★
 * （导出仅供探针 probe-concurrency 验证退避行为）
 */
export async function withBackoff429<T>(fn: () => Promise<T>): Promise<T> {
  if (process.env.AI_RETRY_429 === 'off') return fn();
  const maxRetry = 3;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetry; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!isRateLimitError(e) || attempt === maxRetry) throw e;
      const wait = Math.min(2000 * 2 ** attempt + Math.floor(Math.random() * 500), 30_000);
      console.warn(`[ai] HTTP 429/529，第 ${attempt + 1}/${maxRetry} 次退避，等待 ${wait}ms 后重试`);
      await sleep(wait);
    }
  }
  throw lastErr; // 不可达（循环里要么 return 要么 throw），类型兜底
}

/**
 * 单次请求的对外入口：包全局并发闸 + 429 退避。
 *
 * ★ AI_PARALLEL=off 时闸是直通快路径（不排队不计数），行为与未包闸逐字节一致 ★
 *   —— 见 concurrency.ts 的注释。闸开时同一时刻最多 AI_CONCURRENCY 个请求在途，
 *   多路由同时触发生成也不会把用户额度瞬间打满。
 */
async function chatOnce(
  messages: ChatMessage[],
  opts: ChatOptions & { noResponseFormat?: boolean } = {},
): Promise<ChatResult> {
  return withAiGate(() => withBackoff429(() => chatOnceRaw(messages, opts)));
}

/** 只要文本的兼容层：多数调用点不关心 finish_reason。 */
export async function chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
  return (await chatOnce(messages, opts)).content;
}

/**
 * 带工具的单次调用。
 *
 * 和 chat() 的区别只在于会带上 tools，并把模型返回的 tool_calls / usage 一并交出来——
 * agent 循环需要这两样：前者决定下一步调什么，后者用于成本统计与「token 预算用完就停」。
 */
export async function chatWithTools(
  messages: ChatMessage[],
  tools: ToolSpec[],
  opts: Omit<ChatOptions, 'tools' | 'toolChoice'> & { toolChoice?: ChatOptions['toolChoice'] } = {},
): Promise<ChatResult> {
  return chatOnce(messages, { ...opts, tools, toolChoice: opts.toolChoice ?? 'auto' });
}

/**
 * 取工具调用。
 *
 * 兼容两种返回：标准 `choices[0].message.tool_calls`，
 * 以及少数网关的 `choices[0].message.tool_calls[].function.arguments` 直接是对象而非字符串
 * （按 OpenAI 规范应该是字符串，实测有网关不遵守）。
 */
function extractToolCalls(parsed: unknown): ToolCall[] {
  const msg = firstMessage(parsed);
  const raw = msg?.tool_calls;
  if (!Array.isArray(raw)) return [];
  const out: ToolCall[] = [];
  for (const c of raw) {
    if (typeof c !== 'object' || c === null) continue;
    const r = c as Record<string, unknown>;
    const fn = (r.function ?? {}) as Record<string, unknown>;
    const name = typeof fn.name === 'string' ? fn.name : typeof r.name === 'string' ? r.name : '';
    if (!name) continue;
    let args = fn.arguments ?? r.arguments;
    if (typeof args === 'object' && args !== null) args = JSON.stringify(args);
    out.push({
      id: typeof r.id === 'string' ? r.id : `call_${out.length}`,
      type: 'function',
      function: { name, arguments: typeof args === 'string' ? args : '' },
    });
  }
  return out;
}

/**
 * 取用量，交给 tokenMeter 归一化。
 *
 * ★ 为什么把字段解析全推给 tokenMeter ★
 *   各家字段名不一样（DeepSeek 的 `prompt_cache_hit_tokens`、OpenAI 系的
 *   `prompt_tokens_details.cached_tokens`），而且 DeepSeek 的 `prompt_tokens`
 *   是**含命中**的、跟内部互斥约定不一致——这套换算只该有一处实现，
 *   散在调用方里迟早算重（DSH 把同样的逻辑收敛在适配器的一个 mapUsage 里）。
 */
function extractUsage(parsed: unknown): NormalizedUsage | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const u = (parsed as Record<string, unknown>).usage;
  if (typeof u !== 'object' || u === null) return null;
  return normalizeUsage(u as RawUsage);
}

function firstMessage(parsed: unknown): Record<string, unknown> | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const choices = (parsed as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || !choices.length) return null;
  const c0 = choices[0] as Record<string, unknown>;
  const msg = c0.message;
  return typeof msg === 'object' && msg !== null ? (msg as Record<string, unknown>) : null;
}

/** 取 finish_reason，用来判断输出是不是被 max_tokens 截断的。 */
function extractFinishReason(parsed: unknown): string | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const p = parsed as Record<string, unknown>;
  const choices = p.choices;
  if (Array.isArray(choices) && choices.length) {
    const fr = (choices[0] as Record<string, unknown>)?.finish_reason;
    if (typeof fr === 'string') return fr;
  }
  return null;
}

/**
 * 欠费 / 额度用尽。
 * 网关返回体里通常带着余额、套餐之类的隐私字段，所以这里只给结论和下一步动作，
 * 原文一律只进服务端日志。
 */
export const AI_OUT_OF_CREDIT =
  'AI 接口提示余额不足或额度已用尽。请到「设置 → AI 接口」看看这个接口的余额，或换一个还有额度的接口。';

export function translateHttpError(status: number, body: string): string {
  const detail = body.slice(0, 300);
  // 402 单独走上面的分支（要记日志、不给原文），这里兜住其它调用点
  if (status === 402) return AI_OUT_OF_CREDIT;
  if (status === 401 || status === 403) return `API Key 无效或没有权限（HTTP ${status}）：${detail}`;
  if (status === 404) return `接口地址不存在（HTTP 404）。常见原因是 baseURL 填少了 /v1。返回：${detail}`;
  if (status === 429) return `请求过于频繁或额度不足（HTTP 429）：${detail}`;
  if (status >= 500) return `AI 服务端出错（HTTP ${status}）：${detail}`;
  return `AI 接口返回错误（HTTP ${status}）：${detail}`;
}

/** 兼容 OpenAI 的 choices[0].message.content 与各种变体。 */
function extractContent(parsed: unknown): string | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const p = parsed as Record<string, unknown>;
  const choices = p.choices;
  if (Array.isArray(choices) && choices.length) {
    const c0 = choices[0] as Record<string, unknown>;
    const msg = c0.message as Record<string, unknown> | undefined;
    if (msg) {
      const c = asText(msg.content);
      if (c !== null) return c;
    }
    const c = asText(c0.text);
    if (c !== null) return c;
  }
  // 有些网关会直接返回 { content: "..." } 或 { output_text: "..." }
  for (const key of ['content', 'output_text', 'response', 'text'] as const) {
    const v = asText(p[key]);
    if (v !== null) return v;
  }
  return null;
}

/**
 * 取文本。content 除了字符串，还可能是 [{type:'text',text:'…'}, …] 这种多段结构
 * （Anthropic 风格、以及一批聚合网关都这么返回），早期版本会被判成「找不到文本」。
 */
function asText(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    const parts = v
      .map((it) => (typeof it === 'string' ? it : (it as Record<string, unknown>)?.text))
      .filter((t): t is string => typeof t === 'string');
    if (parts.length) return parts.join('');
  }
  return null;
}

// ─────────────────────── JSON 解析与修复 ───────────────────────

/**
 * 从模型输出里抠出一个 JSON 值。
 *
 * 模型即使被要求「只输出 JSON」也经常加 ```json 围栏、加一句开场白、
 * 或者在结尾多写一段解释。这里逐层尝试，尽量把能救的救回来。
 */
export function parseLooseJson<T>(text: string): T | null {
  const s = text.replace(/^\uFEFF/, '').trim();
  const slices = jsonCandidates(s);

  // 第一轮：原样试。能不改写就别改写。
  for (const cand of slices) {
    const v = tryParse<T>(cand);
    if (v !== null) return v;
  }
  // 第二轮：上修复手段（补转义、去尾随逗号、去注释、认中文引号）。
  for (const cand of slices) {
    const v = tryParse<T>(sanitizeJson(cand));
    if (v !== null) return v;
  }
  return null;
}

/** 按「最像 JSON」的顺序列出候选切片，逐个试。 */
function jsonCandidates(s: string): string[] {
  const out: string[] = [s];

  // ```json … ``` 围栏
  const fenced = /```(?:json|JSON|jsonc)?[ \t]*\r?\n?([\s\S]*?)```/.exec(s);
  if (fenced) out.push(fenced[1].trim());
  // 围栏没闭合（多半是输出被截断了）：从 ``` 之后一直取到结尾
  const openFence = /```(?:json|JSON|jsonc)?[ \t]*\r?\n?([\s\S]*)$/.exec(s);
  if (openFence) out.push(openFence[1].trim());

  for (const [open, close] of [
    ['{', '}'],
    ['[', ']'],
  ] as const) {
    const a = s.indexOf(open);
    const b = s.lastIndexOf(close);
    if (a >= 0 && b > a) {
      const mid = s.slice(a, b + 1);
      out.push(mid);
      out.push(repairTruncatedJson(mid));
    }
    if (a >= 0) out.push(repairTruncatedJson(s.slice(a)));
  }

  return [...new Set(out)].filter(Boolean);
}

/**
 * 把「像 JSON 但不合法」的文本修成合法的。逐字符扫描、区分字符串内外，
 * 一次过处理四类问题：
 *
 *   1. 字符串里出现裸换行 / 制表符 —— 最高频的翻车点。小抄、闪卡的 text 字段
 *      经常是多行内容，模型图省事直接换行写，JSON.parse 当场报错，
 *      而且肉眼看过去完全正常，很难发现。
 *   2. 尾随逗号：{"a":1,}
 *   3. 注释：// … 和 /* … *\/
 *   4. 中文引号当字符串定界符：“…” —— 只在「确实由中文引号打开」时才认，
 *      避免把正文里的中文引号误判成字符串结束。
 */
function sanitizeJson(s: string): string {
  const out: string[] = [];
  let inStr = false;
  let esc = false;
  let smartOpened = false;
  // 最近一个「可能是尾随逗号」的 ',' 在 out 里的下标
  let pendingComma = -1;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];

    if (inStr) {
      if (esc) {
        out.push(ch);
        esc = false;
        continue;
      }
      if (ch === '\\') {
        out.push(ch);
        esc = true;
        continue;
      }
      if (ch === '"') {
        out.push(ch);
        inStr = false;
        smartOpened = false;
        continue;
      }
      if (smartOpened && ch === '”') {
        out.push('"');
        inStr = false;
        smartOpened = false;
        continue;
      }
      // 裸控制字符 → 转义
      if (ch === '\n') {
        out.push('\\n');
        continue;
      }
      if (ch === '\r') {
        out.push('\\n');
        if (s[i + 1] === '\n') i++;
        continue;
      }
      if (ch === '\t') {
        out.push('\\t');
        continue;
      }
      if (ch < ' ') {
        out.push('\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
        continue;
      }
      out.push(ch);
      continue;
    }

    // ── 字符串外 ──
    if (ch === '"') {
      pendingComma = -1;
      out.push(ch);
      inStr = true;
      smartOpened = false;
      continue;
    }
    if ((ch === '“' || ch === '＂') && !smartOpened) {
      pendingComma = -1;
      out.push('"');
      inStr = true;
      smartOpened = true;
      continue;
    }
    if (ch === '/' && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && s[i + 1] === '*') {
      i += 2;
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++;
      i++;
      continue;
    }
    if (ch === ',') {
      pendingComma = out.length;
      out.push(ch);
      continue;
    }
    if (ch === '}' || ch === ']') {
      if (pendingComma >= 0) out.length = pendingComma; // 砍掉尾随逗号（及其后的空白）
      pendingComma = -1;
      out.push(ch);
      continue;
    }
    if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t') {
      out.push(ch); // 逗号后的空白不影响判定
      continue;
    }
    pendingComma = -1;
    out.push(ch);
  }
  return out.join('');
}

function tryParse<T>(s: string): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

/**
 * 修补被 max_tokens 截断的 JSON：补齐未闭合的字符串、数组和对象。
 * 只在「末尾被截断」这一种情况下有效，不做通用 JSON5 解析。
 */
export function repairTruncatedJson(s: string): string {
  let out = '';
  const stack: string[] = [];
  let inStr = false;
  let esc = false;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    out += ch;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
    else if (ch === '}' || ch === ']') stack.pop();
  }

  if (inStr) out += '"';
  // 去掉尾随的逗号 / 冒号造成的半截键
  out = out.replace(/,\s*$/, '');
  // 逆序闭合
  while (stack.length) out += stack.pop();
  return out;
}

const BAD_JSON_NOTE =
  '你上面的输出不是合法 JSON，程序解析失败。请**只**输出一个合法 JSON 对象：' +
  '不要任何解释文字，不要 Markdown 代码围栏；字符串内部的换行必须写成 \\n；' +
  '不要出现尾随逗号；不要用中文引号代替英文双引号。';

/** 要 JSON 结果的调用：解析/校验不过就重试，最多三次。 */
export async function chatJson<T>(
  messages: ChatMessage[],
  opts: ChatOptions & {
    label?: string;
    /** 额外校验：形状不对时返回一句人话说明（返回 null 表示通过） */
    validate?: (v: unknown) => string | null;
    /**
     * 观测钩子：每次实际调用后回调一次（含用法/结束原因/耗时）。
     * ★ 只为探针与成本归因用，纯观测，不参与流程控制；不传则零开销。
     */
    onCall?: (info: {
      attempt: number;
      finishReason: string | null;
      truncated: boolean;
      promptTokens: number | null;
      completionTokens: number | null;
      reasoningTokens: number | null;
      contentChars: number;
      ms: number;
    }) => void;
  } = {},
): Promise<T> {
  const label = opts.label ?? 'AI';
  const notes: string[] = [];
  let budget = opts.maxTokens ?? 8000;
  let history: ChatMessage[] = [...messages];
  let last = '';
  let sawEmpty = false;
  let sawTruncated = false;
  const raws: string[] = [];

  for (let attempt = 1; attempt <= 3; attempt++) {
    const tCall = Date.now();
    const r = await chatOnce(history, {
      ...opts,
      json: true,
      maxTokens: budget,
      // 重试就降到 0，别再靠随机性碰运气
      temperature: attempt === 1 ? opts.temperature : 0,
    });
    last = r.content;
    raws.push(r.content);

    const truncated = r.finishReason === 'length';
    if (truncated) sawTruncated = true;
    if (!r.content.trim()) sawEmpty = true;
    opts.onCall?.({
      attempt,
      finishReason: r.finishReason,
      truncated,
      promptTokens: r.usage?.promptTokens ?? null,
      completionTokens: r.usage?.completionTokens ?? null,
      reasoningTokens: r.usage?.reasoningTokens ?? null,
      contentChars: r.content.length,
      ms: Date.now() - tCall,
    });

    const v = parseLooseJson<T>(r.content);
    const problem =
      v === null
        ? '输出不是合法 JSON'
        : truncated
          ? '输出被长度上限截断，内容不完整'
          : opts.validate?.(v) ?? null;

    if (problem === null) return v as T;
    notes.push(`第 ${attempt} 次：${problem}`);

    // ★ 推理模型（实测 deepseek-flash 就是）的思考过程也占 max_tokens 额度 ★
    // 实测：给 3000 时 reasoning_tokens 正好吃掉 3000，正文一个字都没输出。
    // 所以截断时必须「大幅」加额度 —— 加一点点等于原地打转，第二次必然同样失败。
    const next = Math.min(Math.round(budget * 2.5), 32_000);
    const grew = next > budget;
    budget = next;

    history = [
      ...history,
      { role: 'assistant', content: r.content.slice(0, 2000) || '（这次没有输出任何内容）' },
      {
        role: 'user',
        content:
          `${BAD_JSON_NOTE}\n\n具体问题是：${problem}。` +
          (grew ? `这次额度已提高到 ${budget}，请把思考过程写短一些，优先保证 JSON 完整。` : ''),
      },
    ];
  }

  // 三次输出全留着：只留最后一次的话，看不出「第一次是什么样」，也就判断不了是偶发还是必然
  const saved = dumpAiRaw(label, raws);
  const head = last.replace(/\s+/g, ' ').trim().slice(0, 160);
  const why = sawEmpty
    ? '（模型有几次一个字都没输出——推理模型的思考过程会把额度用光）'
    : sawTruncated
      ? '（输出被长度上限截断）'
      : '';
  throw new ApiError(
    502,
    `${label}：${notes.join('；')}${why}。最后一次输出的开头是：${head || '（空）'}` +
      (saved ? `\n完整原文已存到 ${saved}` : ''),
    'ai_bad_json',
    { sample: last.slice(0, 500), savedTo: saved ?? undefined, notes },
  );
}

/**
 * 解析失败时把模型原文落盘。
 *
 * 没有它，用户只会看到一句「不是合法 JSON」，我们也没法判断到底坏在哪——
 * 是围栏？是裸换行？是截断？还是网关把内容包在了别的结构里？
 * 存到 .local/ai-debug/ 下，不进笔记库，只保留最近 20 份。
 */
function dumpAiRaw(label: string, contents: string[]): string | null {
  try {
    const dir = path.join(LOCAL_DIR, 'ai-debug');
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(dir, `${stamp}.txt`);
    const body = [
      `label: ${label}`,
      `time: ${new Date().toISOString()}`,
      ...contents.map((c, i) => `\n===== 第 ${i + 1} 次输出 =====\n${c}`),
    ].join('\n');
    writeFileSync(file, body, 'utf8');

    // 只留最近 20 份，别无限堆积
    const files = readdirSync(dir).filter((f) => f.endsWith('.txt')).sort();
    for (const old of files.slice(0, Math.max(0, files.length - 20))) {
      try {
        unlinkSync(path.join(dir, old));
      } catch {
        /* 删不掉就留着 */
      }
    }
    return file;
  } catch {
    return null; // 记日志失败不能把主流程搞崩
  }
}

/** 连通性自检：给设置页的「测试连接」用。 */
export async function testConnection(): Promise<{ ok: true; model: string; reply: string }> {
  const s = await getAiSettings();
  const reply = await chat([{ role: 'user', content: '回复两个字：可用' }], {
    temperature: 0,
    maxTokens: 16,
    timeoutMs: 20_000,
  });
  return { ok: true, model: s.model, reply: reply.trim().slice(0, 50) };
}
