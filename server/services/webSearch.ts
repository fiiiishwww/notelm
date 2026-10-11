/**
 * server/services/webSearch.ts —— 联网搜索适配器（B 层「核实」的另一半）。
 *
 * ★ 为什么走百炼「原生」端点，而不是 OpenAI 兼容端点 ★
 *   2026-09-23 实测（`.local/websearch-probe*.mjs`）：
 *     - 兼容端点 `POST /compatible-mode/v1/chat/completions` + `enable_search:true`
 *       → **回答里确实用了搜索**（能说出当天日期与实时天气），但响应里
 *       **没有 `search_info`**，一条结构化来源都拿不到。
 *     - 原生端点 `POST /api/v1/services/aigc/text-generation/generation` +
 *       `parameters: { enable_search:true, search_options:{ enable_source:true } }`
 *       → `output.search_info.search_results` 返回 7 条，带 title / url / site_name。
 *   对我们来说「来源」比「综述」重要得多：agent 拿到 URL 才能用 web_fetch 读原文、
 *   才能把引用写成她能点开的链接。所以这里固定用原生端点。
 *
 * ★ 为什么复用 embedding 的 Key ★
 *   本机的 `embedding.baseURL` 与 `ai.profiles.bailian.baseURL` 同在
 *   dashscope.aliyuncs.com，同一个百炼账号 —— `embedApiKey` 就是那把钥匙。
 *   但**不硬编码任何地址**：baseURL 一律从配置里推导（换账号/换代理只改配置）。
 *   P4 凭据治理会给它一个独立名字（`NB_SEARCH_TOKEN`），届时这里只是多一层回退。
 */

import { readConfig, readSecret } from '../core';
import { WebError, type WebErrorCode } from './webFetch';

export interface SearchHit {
  title: string;
  url: string;
  /** 站点名（如「网易」），不一定有 */
  site?: string;
  /**
   * 摘要。**实测当前后端（百炼原生端点）从不返回它**（2026-09-23 试过
   * enable_source / enable_citation / enable_search_extension 三种组合，
   * 四条 query 全部只有 icon/site_name/index/title/url）。
   * 字段保留是为了换后端时不用改契约；代码里继续读 `snippet ?? content`。
   */
  snippet?: string;
}

export interface WebSearchResult {
  query: string;
  hits: SearchHit[];
  /** 搜索模型综合出来的答案（未核实）。引用编号对应 hits 顺序 */
  answer?: string;
}

/** 一次调用最多几条 query（并发跑，串行会等到超时）。 */
export const MAX_QUERIES = 4;
/** 合并后的结果上限。超了只留前 N 条并说明还有多少没列。 */
export const MAX_HITS = 8;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const SEARCH_LIMITS = {
  /**
   * 超时。默认从 20s 提到 35s —— 实测（2026-09-23）同一个端点同样的问题，
   * 延迟在 1.6s ~ 18s 之间跳，有一条 query 直接撞上 20s 上限被杀。
   * 我们的策略是「任一 query 失败则整次失败」，所以超时设小等于把成功率
   * 交给运气。35s 是「宁可这一轮慢一点，也不要报一个假的失败」。
   */
  timeoutMs: () => envInt('NB_WEB_SEARCH_TIMEOUT_MS', 35_000),
  maxAnswerChars: () => envInt('NB_WEB_SEARCH_ANSWER_CHARS', 900),
  maxSnippetChars: () => envInt('NB_WEB_SEARCH_SNIPPET_CHARS', 240),
};

interface SearchEndpoint {
  key: string;
  /** 原生生成端点（由配置里的 baseURL 推导） */
  url: string;
  model: string;
}

/**
 * 推导端点：配置里给的是 OpenAI 兼容地址（`.../compatible-mode/v1`），
 * 原生端点在同一个 origin 的另一条路径上。用户填了别的域名（代理/自建网关）也照样成立。
 */
function nativeUrl(baseURL: string): string {
  const origin = new URL(baseURL).origin;
  return `${origin}/api/v1/services/aigc/text-generation/generation`;
}

async function resolveEndpoint(): Promise<SearchEndpoint> {
  const envKey = process.env.NB_SEARCH_TOKEN;
  const envBase = process.env.NB_SEARCH_BASE_URL;
  const envModel = process.env.NB_SEARCH_MODEL;
  if (envKey && envBase) {
    return { key: envKey, url: nativeUrl(envBase), model: envModel || 'qwen-plus' };
  }

  const [cfg, secrets] = await Promise.all([readConfig(), readSecret()]);
  const base = envBase || cfg.embedding.baseURL;
  const key = envKey || secrets.searchApiKey || secrets.embedApiKey;
  if (!base) {
    throw new WebError('WEB_PROVIDER_ERROR', '联网搜索需要一个百炼（DashScope）接口地址，但配置里 embedding.baseURL 是空的。');
  }
  if (!key) {
    throw new WebError(
      'WEB_PROVIDER_ERROR',
      '联网搜索需要百炼（DashScope）的 Key。请在「模型设置」里填向量接口的 Key（同一个账号即可），或设环境变量 NB_SEARCH_TOKEN。',
    );
  }
  return { key, url: nativeUrl(base), model: envModel || 'qwen-plus' };
}

/** 原生端点的返回形状（只声明我们用到的那几个字段）。 */
interface NativeResponse {
  output?: {
    choices?: { message?: { content?: string } }[];
    text?: string;
    search_info?: {
      search_results?: { title?: string; url?: string; site_name?: string; snippet?: string; content?: string }[];
    };
  };
  usage?: Record<string, number>;
  code?: string;
  message?: string;
}

function trimSnippet(s: string | undefined): string | undefined {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return undefined;
  const cap = SEARCH_LIMITS.maxSnippetChars();
  return t.length > cap ? t.slice(0, cap) + '…' : t;
}

/**
 * 单条 query。失败一律抛 WebError——**不做「部分成功」的静默降级**：
 * 若某条查询悄悄失败，agent 会把「查不到」当成「不存在」。
 */
export async function searchOnce(query: string, opts: { signal?: AbortSignal } = {}): Promise<WebSearchResult> {
  const q = (query ?? '').trim();
  if (!q) throw new WebError('WEB_INVALID_URL', 'query 不能为空');
  if (q.length > 200) throw new WebError('WEB_INVALID_URL', `query 太长（${q.length} 字符，上限 200）`);

  const ep = await resolveEndpoint();
  const timeout = SEARCH_LIMITS.timeoutMs();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('timeout')), timeout);
  const onAbort = () => ac.abort(new Error('aborted'));
  opts.signal?.addEventListener('abort', onAbort, { once: true });

  let res: Response;
  let text: string;
  try {
    res = await fetch(ep.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ep.key}` },
      body: JSON.stringify({
        model: ep.model,
        input: { messages: [{ role: 'user', content: q }] },
        parameters: {
          result_format: 'message',
          enable_search: true,
          // enable_source 才是「把来源交出来」的开关（实测缺了它就没有 search_info）
          search_options: { enable_source: true },
        },
      }),
      signal: ac.signal,
    });
    text = await res.text();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const code = ac.signal.aborted && !opts.signal?.aborted ? 'WEB_FETCH_TIMEOUT' : 'WEB_ABORTED';
    throw new WebError(code, code === 'WEB_FETCH_TIMEOUT' ? `搜索超时（${timeout}ms）：${q}` : `搜索被取消：${msg}`);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }

  if (!res.ok) {
    const detail = text.slice(0, 400);
    throw new WebError('WEB_PROVIDER_ERROR', `搜索后端返回 ${res.status}：${detail}`);
  }

  let j: NativeResponse;
  try {
    j = JSON.parse(text) as NativeResponse;
  } catch {
    throw new WebError('WEB_PROVIDER_ERROR', `搜索后端返回的不是 JSON：${text.slice(0, 200)}`);
  }
  // 原生端点把业务错误放在 200 的 body 里
  if (j.code) throw new WebError('WEB_PROVIDER_ERROR', `搜索后端报错 ${j.code}：${j.message ?? ''}`);

  const raw = j.output?.search_info?.search_results ?? [];
  const seen = new Set<string>();
  const hits: SearchHit[] = [];
  for (const r of raw) {
    const url = (r.url ?? '').trim();
    const title = (r.title ?? '').trim();
    if (!url || !/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    const snippet = trimSnippet(r.snippet ?? r.content);
    hits.push({ title: title || url, url, ...(r.site_name ? { site: r.site_name } : {}), ...(snippet ? { snippet } : {}) });
  }

  const answerRaw = (j.output?.choices?.[0]?.message?.content ?? j.output?.text ?? '').trim();
  const cap = SEARCH_LIMITS.maxAnswerChars();
  const answer = answerRaw ? (answerRaw.length > cap ? answerRaw.slice(0, cap) + '…' : answerRaw) : '';

  return { query: q, hits, ...(answer ? { answer } : {}) };
}

/**
 * 多条 query 并发。**任一失败 → 整次失败**（见文件头注释的取舍）：
 * 这样「返回了结果」就等价于「所有 query 都问到了」，agent 不会把一次
 * 网络抖动读成「这个主题网上没有」。失败信息里带上是哪条 query 失败的，
 * 它可以用更少的 query 重试。
 */
export async function webSearch(
  queries: string[],
  opts: { signal?: AbortSignal } = {},
): Promise<{ results: WebSearchResult[]; hits: SearchHit[]; dropped: number }> {
  const qs = [...new Set(queries.map((s) => (s ?? '').trim()).filter(Boolean))];
  if (!qs.length) throw new WebError('WEB_INVALID_URL', 'queries 不能为空');
  if (qs.length > MAX_QUERIES) {
    throw new WebError('WEB_INVALID_URL', `一次最多 ${MAX_QUERIES} 条 query，收到 ${qs.length} 条`);
  }

  const settled = await Promise.allSettled(qs.map((q) => searchOnce(q, opts)));
  const bad = settled.find((s) => s.status === 'rejected');
  if (bad && bad.status === 'rejected') {
    const reason = bad.reason;
    const idx = settled.indexOf(bad);
    const msg = reason instanceof Error ? reason.message : String(reason);
    // ApiError.code 的类型是宽松的 string；这里收敛回我们自己的错误码联合类型
    const code = (reason instanceof WebError ? reason.code : 'WEB_PROVIDER_ERROR') as WebErrorCode;
    throw new WebError(code, `query「${qs[idx]}」失败：${msg}（本次不返回部分结果，可用更少的 query 重试）`);
  }
  const results = (settled as PromiseFulfilledResult<WebSearchResult>[]).map((s) => s.value);

  // 跨 query 按 URL 去重，保持 query 顺序
  const seen = new Set<string>();
  const merged: SearchHit[] = [];
  for (const r of results) {
    for (const h of r.hits) {
      if (seen.has(h.url)) continue;
      seen.add(h.url);
      merged.push(h);
    }
  }
  const dropped = Math.max(0, merged.length - MAX_HITS);
  return { results, hits: merged.slice(0, MAX_HITS), dropped };
}
