/**
 * server/services/embed.ts —— 向量接口（embedding）的调用封装。
 *
 * ★ 为什么它是一套完全独立的配置，不复用 aiClient 的凭据 ★
 *   用户要的就是这个：对话走一个 API，向量走另一个。现实里这几乎是标配——
 *   DeepSeek / OpenAI 的对话便宜，但 embedding 模型要么没有（DeepSeek 就没有），
 *   要么贵；专门做 embedding 的厂家（硅基流动、Gemini、本地 Ollama）价格差一个量级。
 *   所以 baseURL / model / apiKey 三项全都独立存，谁也不依赖谁。
 *
 * ★ 为什么失败时允许调用方降级，而不是直接抛错 ★
 *   检索是「加分项」不是主流程。embedding 接口挂了（欠费、地址填错、模型下架），
 *   用户至少还应该能用关键词把笔记翻出来。所以这里只负责「尽力拿到向量」，
 *   拿不到就抛一个带明确文案的 ApiError，由 vectorstore 决定怎么降级。
 */

import { ApiError, readConfig, readSecret, writeConfig } from '../core';
import { mapLimit } from './concurrency';

export interface EmbedSettings {
  baseURL: string;
  model: string;
  apiKey: string;
  /** 0 = 未指定，用接口返回的原生维度 */
  dimensions: number;
  configured: boolean;
}

export async function getEmbedSettings(): Promise<EmbedSettings> {
  const cfg = await readConfig();
  const secret = await readSecret();
  const baseURL = (cfg.embedding.baseURL || '').trim();
  const model = (cfg.embedding.model || '').trim();
  const apiKey = (secret.embedApiKey || '').trim();
  const dimensions = Number.isFinite(cfg.embedding.dimensions) ? Math.max(0, Math.trunc(cfg.embedding.dimensions)) : 0;
  return { baseURL, model, apiKey, dimensions, configured: Boolean(baseURL && model && apiKey) };
}

/**
 * 把用户填的 baseURL 规整成 /embeddings 的完整地址。
 * 和 completionsUrl() 同一套思路：用户可能填到任意深度，这里统一补全。
 */
export function embeddingsUrl(baseURL: string): string {
  const b = baseURL.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(b)) throw new ApiError(400, '向量接口地址必须以 http:// 或 https:// 开头', 'bad_base_url');
  if (/\/embeddings$/i.test(b)) return b;
  if (/\/v\d+$/i.test(b)) return `${b}/embeddings`;
  return `${b}/v1/embeddings`;
}

/**
 * 各家返回向量的位置五花八门，这里把见过的都认一遍：
 *   OpenAI 系：{ data: [{ index, embedding }] }
 *   部分网关：{ data: [{ embedding }] }（没有 index，按数组顺序）
 *   Ollama  ：{ embeddings: [[...]] }
 *   少数    ：{ data: [[...]] }（直接是数组的数组）
 */
function extractVectors(parsed: unknown, want: number): number[][] {
  const p = parsed as Record<string, unknown>;

  const asVec = (v: unknown): number[] | null => {
    if (Array.isArray(v) && v.every((x) => typeof x === 'number')) return v as number[];
    if (v && typeof v === 'object') {
      const e = (v as Record<string, unknown>).embedding;
      if (Array.isArray(e) && e.every((x) => typeof x === 'number')) return e as number[];
    }
    return null;
  };

  const data = p.data;
  if (Array.isArray(data)) {
    const withIndex: { i: number; v: number[] }[] = [];
    for (let i = 0; i < data.length; i++) {
      const v = asVec(data[i]);
      if (!v) continue;
      const item = data[i] as Record<string, unknown>;
      const idx = typeof item?.index === 'number' ? item.index : i;
      withIndex.push({ i: idx, v });
    }
    if (withIndex.length) {
      withIndex.sort((a, b) => a.i - b.i);
      return withIndex.map((x) => x.v);
    }
  }

  const embs = p.embeddings;
  if (Array.isArray(embs)) {
    const list = embs.map(asVec).filter((v): v is number[] => v !== null);
    if (list.length) return list;
  }

  throw new ApiError(
    502,
    `向量接口返回里找不到 embedding 数组（前 200 字）：${JSON.stringify(parsed).slice(0, 200)}`,
    'embed_bad_response',
  );
}

/** 单次批量请求。调用方负责把大批次切成小批次。 */
async function embedBatch(
  texts: string[],
  s: EmbedSettings,
  timeoutMs: number,
  signal?: AbortSignal,
  /** 重试时置 true：只发最必要的字段，免得网关不认的附加字段又挡一道 */
  minimal = false,
): Promise<number[][]> {
  const url = embeddingsUrl(s.baseURL);
  const body: Record<string, unknown> = { model: s.model, input: texts };
  if (s.dimensions > 0) body.dimensions = s.dimensions;
  // OpenAI 新模型支持，老模型忽略；带上能让「想省空间」的用户真的省到。
  // 但少数网关不认这个字段会直接 400，所以重试时不再携带。
  if (!minimal) body.encoding_format = 'float';

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const onAbort = () => ctl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.apiKey}` },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
  } catch (e) {
    const err = e as Error;
    if (err.name === 'AbortError') {
      throw new ApiError(504, `向量接口超时（${Math.round(timeoutMs / 1000)} 秒）`, 'embed_timeout');
    }
    throw new ApiError(502, `连不上向量接口：${err.message}。请检查「设置 → 检索」里的地址是否正确。`, 'embed_unreachable');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }

  const raw = await res.text();
  if (!res.ok) {
    // 同 aiClient：402 是「去充钱」而不是「配错了」，单独识别；
    // 网关原文（含余额等隐私）只进日志，不给用户看。
    if (res.status === 402) {
      console.warn('[embed] 402 out of credit:', raw.slice(0, 300));
      throw new ApiError(402, EMBED_OUT_OF_CREDIT, 'embed_out_of_credit', { status: 402 });
    }
    throw new ApiError(
      res.status === 401 || res.status === 403 ? 401 : 502,
      translateEmbedError(res.status, raw),
      'embed_http_error',
      // 把原始返回体留在 extra 里：上层要靠它判断「是不是批量太大」这类可自愈的错误
      { status: res.status, body: raw.slice(0, 500) },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ApiError(502, `向量接口返回的不是 JSON（前 200 字）：${raw.slice(0, 200)}`, 'embed_bad_response');
  }

  return extractVectors(parsed, texts.length);
}

/** 向量接口的欠费文案。同上：只给结论和下一步动作，不转述网关原文。 */
const EMBED_OUT_OF_CREDIT =
  '向量接口提示余额不足或额度已用尽。请到「设置 → 检索」看看这个接口的余额，或换一个还有额度的接口。';

function translateEmbedError(status: number, body: string): string {
  const detail = body.slice(0, 300);
  if (status === 402) return EMBED_OUT_OF_CREDIT;
  if (status === 400 && /batch[_ ]?size|batchsize/i.test(body)) {
    return `向量接口不接受这个批量大小（HTTP 400）。已自动减少每次发送的文本条数并重试：${detail}`;
  }
  if (status === 401 || status === 403) return `向量接口的 API Key 无效或没有权限（HTTP ${status}）：${detail}`;
  if (status === 404) return `向量接口地址不存在（HTTP 404）。常见原因是地址少填了 /v1。返回：${detail}`;
  if (status === 422) return `向量接口拒绝了请求（HTTP 422）。多半是模型名不支持 embedding，或一次传的文本太长：${detail}`;
  if (status === 429) return `向量接口调用过于频繁或额度不足（HTTP 429）：${detail}`;
  if (status >= 500) return `向量接口服务端出错（HTTP ${status}）：${detail}`;
  return `向量接口返回错误（HTTP ${status}）：${detail}`;
}

/** 带并发上限的 map。建索引时一次发几百个请求会把接口打挂，也会触发限流。 */
// ★ 已收编到共享并发模块（2026-10-11）：原本地实现逐字移入 concurrency.ts，行为不变。

/**
 * 每批最多几条文本。
 *
 * ★ 为什么默认 10 而不是更大 ★
 *   各家上限差得离谱：DashScope（阿里云百炼）一次最多 10 条，百度千帆 16 条，
 *   智谱 64 条，还有的网关干脆只收 1 条。取一个谁都不出错的保守值是唯一稳妥做法——
 *   请求数多一点只是慢一点，400 会让整个索引退化成关键词检索。
 *   真撞上「batch size is invalid」时 embedTexts 会自动减半重试，并把能用的值写进配置。
 */
const DEFAULT_BATCH = 10;
const MIN_BATCH = 1;
/**
 * 单条文本最多送多少字符。
 * 一条超长文本会让整批被拒，宁可截断这一条，也不要连累同批的其它片。
 * DashScope v4 上限约 8192 token，中文按 1 token ≈ 1.5 字估，6000 字留足了余量。
 */
const MAX_CHARS = 6000;
/** 单批超时。embedding 比对话快得多，30s 足够。 */
const BATCH_TIMEOUT = 30_000;

/** 本次进程内试出来的可用批量，省得每次请求都从头试错 */
let learnedBatch: number | null = null;

async function preferredBatch(): Promise<number> {
  if (learnedBatch && learnedBatch >= MIN_BATCH) return learnedBatch;
  const cfg = await readConfig();
  const n = cfg.embedding.batchSize ?? 0;
  return n >= MIN_BATCH ? Math.trunc(n) : DEFAULT_BATCH;
}

/** 把试出来的可用批量写回配置，下次启动直接生效（写失败无所谓，大不了再试一次）。 */
async function rememberBatch(n: number): Promise<void> {
  learnedBatch = n;
  try {
    const cfg = await readConfig();
    await writeConfig({ embedding: { ...cfg.embedding, batchSize: n } });
  } catch {
    /* 记不住就算了，不影响本次结果 */
  }
}

/** 只有「批量太大」这类错误减小批量才有意义，其它错误别瞎重试。 */
function isBatchSizeError(e: unknown): boolean {
  if (!(e instanceof ApiError)) return false;
  if (e.extra?.status !== undefined && Number(e.extra.status) !== 400) return false;
  const body = typeof e.extra?.body === 'string' ? e.extra.body : e.message;
  return /batch[_ ]?size|batchsize/i.test(body);
}

export interface EmbedResult {
  vectors: number[][];
  dim: number;
}

/** 按给定批量把文本全部送一遍，并做维度 / 条数校验。 */
async function runBatches(
  clean: string[],
  size: number,
  s: EmbedSettings,
  minimal: boolean,
  signal?: AbortSignal,
): Promise<EmbedResult> {
  const batches: string[][] = [];
  for (let i = 0; i < clean.length; i += size) batches.push(clean.slice(i, i + size));

  const results = await mapLimit(batches, 3, (b) => embedBatch(b, s, BATCH_TIMEOUT, signal, minimal));

  const vectors: number[][] = [];
  let dim = 0;
  for (const group of results) {
    for (const v of group) {
      if (!dim) dim = v.length;
      // 维度不一致会让余弦相似度算出一堆 NaN，宁可报错也不要静默出错
      if (v.length !== dim) {
        throw new ApiError(
          502,
          `向量接口返回的维度不一致（有 ${dim} 维也有 ${v.length} 维）。请确认同一个模型不会混合输出不同维度。`,
          'embed_dim_mismatch',
        );
      }
      vectors.push(v);
    }
  }

  if (vectors.length !== clean.length) {
    throw new ApiError(
      502,
      `向量接口返回的条数不对：发了 ${clean.length} 条，只回来 ${vectors.length} 条。`,
      'embed_count_mismatch',
    );
  }
  return { vectors, dim };
}

/**
 * 把一批文本变成向量。
 *
 * 两个防御：
 *   - 空文本替换成一个空格——有些接口对空串直接 400（我们的 chunk 理论上非空，纯防御）；
 *   - 批量太大被拒时自动减半重试（10 → 5 → 2 → 1），能用的值写回配置。
 */
export async function embedTexts(texts: string[], opts: { signal?: AbortSignal } = {}): Promise<EmbedResult> {
  const s = await getEmbedSettings();
  if (!s.configured) {
    throw new ApiError(409, '还没有配置向量接口。请在「设置 → 检索」里填写地址、模型名和 API Key。', 'embed_not_configured');
  }

  const clean = texts.map((t) => {
    const v = t.trim() ? t : ' ';
    return v.length > MAX_CHARS ? v.slice(0, MAX_CHARS) : v;
  });

  let size = await preferredBatch();
  let attempt = 0;
  for (;;) {
    try {
      const r = await runBatches(clean, size, s, attempt > 0, opts.signal);
      if (learnedBatch !== size) await rememberBatch(size);
      return r;
    } catch (e) {
      if (!isBatchSizeError(e)) throw e;
      if (size <= MIN_BATCH) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new ApiError(
          400,
          `向量接口连「每次 1 条」都拒绝了，看来不是批量的问题，请检查模型名和文本长度：${msg}`,
          'embed_http_error',
          { status: 400 },
        );
      }
      size = Math.max(MIN_BATCH, Math.floor(size / 2));
      attempt++;
    }
  }
}

/** 给设置页的「测试连接」用。 */
export async function testEmbedding(): Promise<{ ok: true; model: string; dim: number; ms: number }> {
  const t0 = Date.now();
  const r = await embedTexts(['这是一段用于测试向量接口的文本。']);
  return { ok: true, model: (await getEmbedSettings()).model, dim: r.dim, ms: Date.now() - t0 };
}
