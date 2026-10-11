/**
 * server/services/mineru.ts —— MinerU v4 云文档解析客户端（零依赖 fetch）。
 *
 * ★ 为什么走云而不本地跑 MinerU ★
 *   本地版要 torch，她的机器内存常年 <1GB 剩余带不动；云 API 免费
 *   （2000 页/天、单文件 200MB/600 页）质量更好（公式/表格/扫描件 OCR）。
 *   隐私边界：只有**外部新下载的文件**会交给它——她的笔记永不出库。
 *
 * ★ 协议来源：mineru.net 官方 API 文档（2026-09-23 实读，不猜协议）★
 *   - 单文件 URL 提交  POST /api/v4/extract/task              → data.task_id
 *   - 文件上传（两步）  POST /api/v4/file-urls/batch          → data.batch_id + data.file_urls[]
 *                      PUT 文件字节到签名 URL（**无须** Content-Type 与 Authorization，
 *                      传完系统自动提交解析，无须再调提交接口）
 *   - 单任务查询       GET  /api/v4/extract/task/{id}        → data.state / data.full_zip_url / data.err_msg
 *   - 批量查询         GET  /api/v4/extract-results/batch/{id} → data.extract_result[]（file_name/state/full_zip_url/err_msg）
 *   - state 枚举：waiting-file / pending / running / converting / done / failed
 *   - 已知坑：GitHub、AWS 等国外 URL 在 MinerU 侧请求会超时（工具层提示换源）
 *
 * 结果 zip 的成员与引用格式官方文档**没有钉死**（v4 说 full.md，4.0 本地版说
 * markdown.md；图片引用「跟随文档实际引用，不要拼文件名」）——落盘层
 * （docImport.ts）因此按「找得到哪个用哪个 + 跟随实际引用」实现。
 */

import { ApiError, readSecret } from '../core';

const MINERU_BASE = 'https://mineru.net/api/v4';
const UA = 'NoteLM/1.0 (local note vault)';

/** 轮询间隔与总上限。部署配置，不给模型/前端旋钮。 */
function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.round(v) : fallback;
}
const POLL_INTERVAL_MS = 3_000;
export function mineruPollMs(): number {
  return envInt('NB_MINERU_POLL_MS', 240_000); // 默认 4 分钟（免费档排队典型 1~2 分钟）
}

/** 密钥：env 优先（部署环境），其次 secrets.mineruToken（设置页）。都没有 = null。 */
export async function mineruToken(): Promise<string | null> {
  const env = (process.env.NB_MINERU_TOKEN ?? '').trim();
  if (env) return env;
  try {
    const s = await readSecret();
    const t = (s.mineruToken ?? '').trim();
    return t || null;
  } catch {
    return null;
  }
}

export type MineruErrorCode = 'MINERU_NOT_CONFIGURED' | 'MINERU_API' | 'MINERU_TASK_FAILED' | 'MINERU_TIMEOUT' | 'MINERU_UPLOAD';

export class MineruError extends ApiError {
  constructor(code: MineruErrorCode, message: string, status = 502) {
    super(status, message, code);
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 统一的 API 响应检查：code!==0 一律按失败处理（文档约定 code=0 为成功）。 */
async function apiJson<T>(path: string, init: RequestInit, token: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${MINERU_BASE}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': UA, ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new MineruError('MINERU_API', `连不上 MinerU（${(e as Error).message}）`);
  }
  const text = await res.text();
  let j: { code?: number; data?: T; msg?: string };
  try {
    j = JSON.parse(text) as { code?: number; data?: T; msg?: string };
  } catch {
    throw new MineruError('MINERU_API', `MinerU 返回了非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`);
  }
  if (res.status < 200 || res.status >= 300 || (j.code !== undefined && j.code !== 0)) {
    throw new MineruError('MINERU_API', `MinerU 接口报错（HTTP ${res.status} code=${j.code}）：${j.msg ?? text.slice(0, 200)}`);
  }
  return j.data as T;
}

// ─────────────────────────── 提交 ───────────────────────────

/** URL 模式：MinerU 云端自己去抓这个地址并解析（支持 pdf/word/ppt/xls/图片/html）。 */
export async function submitUrlDoc(url: string, token: string): Promise<{ taskId: string }> {
  const data = await apiJson<{ task_id?: string }>(
    '/extract/task',
    { method: 'POST', body: JSON.stringify({ url, language: 'ch' }) },
    token,
  );
  if (!data?.task_id) throw new MineruError('MINERU_API', 'MinerU 没有返回 task_id');
  return { taskId: data.task_id };
}

/**
 * 文件模式（两步）：申请签名上传链接 → PUT 字节。传完系统自动提交解析，
 * 之后用 pollBatch 查结果。
 */
export async function submitFileDoc(
  name: string,
  buf: Buffer,
  token: string,
): Promise<{ batchId: string }> {
  const data = await apiJson<{ batch_id?: string; file_urls?: string[] }>(
    '/file-urls/batch',
    { method: 'POST', body: JSON.stringify({ files: [{ name }], language: 'ch' }) },
    token,
  );
  const put = data?.file_urls?.[0];
  if (!data?.batch_id || !put) throw new MineruError('MINERU_API', 'MinerU 没有返回上传链接');
  let up: Response;
  try {
    // 文档明确：无须 Content-Type、无须 Authorization（签名 URL 本身即凭证）
    //
    // ★ 上传超时按体积算，不能写死 ★
    //   写死 120s 时，35MB 的扫描版教材必挂（本机上行常常只有 100~300KB/s，
    //   35MB 要 2~6 分钟）。规则：每 1MB 给 20 秒，最少 3 分钟、最多 15 分钟。
    const seconds = Math.min(900, Math.max(180, Math.ceil(buf.length / 1048576) * 20));
    up = await fetch(put, { method: 'PUT', body: new Uint8Array(buf), signal: AbortSignal.timeout(seconds * 1000) });
  } catch (e) {
    throw new MineruError('MINERU_UPLOAD', `上传到 MinerU 失败：${(e as Error).message}`);
  }
  if (up.status < 200 || up.status >= 300) {
    throw new MineruError('MINERU_UPLOAD', `上传到 MinerU 失败（HTTP ${up.status}）`);
  }
  return { batchId: data.batch_id };
}

// ─────────────────────────── 轮询 ───────────────────────────

interface TaskState {
  state: string;
  full_zip_url?: string;
  err_msg?: string;
  extract_progress?: { extracted_pages?: number; total_pages?: number };
}

function describe(p?: TaskState['extract_progress']): string {
  if (p?.total_pages) return `（已解析 ${p.extracted_pages ?? 0}/${p.total_pages} 页）`;
  return '';
}

/** 单任务轮询直到 done，返回结果 zip 的下载地址。 */
export async function pollTaskDoc(taskId: string, timeoutMs: number, token: string): Promise<Buffer> {
  const t0 = Date.now();
  for (;;) {
    const d = await apiJson<TaskState>(`/extract/task/${taskId}`, { method: 'GET' }, token);
    if (d.state === 'done' && d.full_zip_url) return downloadZip(d.full_zip_url);
    if (d.state === 'failed') throw new MineruError('MINERU_TASK_FAILED', `MinerU 解析失败：${d.err_msg || '原因未说明'}`);
    if (Date.now() - t0 > timeoutMs) {
      throw new MineruError('MINERU_TIMEOUT', `解析超时（>${Math.round(timeoutMs / 1000)}s）${describe(d.extract_progress)}——免费档高峰要排队，稍后可用「导入 PDF」入口重试`, 504);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

/** 批量查询轮询（文件上传模式只有 batch 查询）。按提交文件名找结果。 */
export async function pollBatchDoc(batchId: string, timeoutMs: number, fileName: string, token: string): Promise<Buffer> {
  const t0 = Date.now();
  for (;;) {
    const d = await apiJson<{ extract_result?: (TaskState & { file_name?: string })[] }>(
      `/extract-results/batch/${batchId}`,
      { method: 'GET' },
      token,
    );
    const list = d.extract_result ?? [];
    const mine = list.find((x) => x.file_name === fileName) ?? (list.length === 1 ? list[0] : undefined);
    if (mine) {
      if (mine.state === 'done' && mine.full_zip_url) return downloadZip(mine.full_zip_url);
      if (mine.state === 'failed') throw new MineruError('MINERU_TASK_FAILED', `MinerU 解析失败：${mine.err_msg || '原因未说明'}`);
    }
    if (Date.now() - t0 > timeoutMs) {
      throw new MineruError('MINERU_TIMEOUT', `解析超时（>${Math.round(timeoutMs / 1000)}s）${describe(mine?.extract_progress)}——免费档高峰要排队，稍后可用「导入 PDF」入口重试`, 504);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

// ─────────────────────────── 结果下载 ───────────────────────────

/** 下载结果 zip。流式累计 + 硬上限（结果包远小于 200MB 输入上限，防呆即可）。 */
async function downloadZip(zipUrl: string): Promise<Buffer> {
  const max = 200 * 1024 * 1024;
  let res: Response;
  try {
    // ★ 120s 不够 ★ 教材的结果包含 OCR 出的整本插图，动辄几十 MB，
    //   本机下载常常要几分钟。超时写死 120s 时表现为「解析明明 done 了却报 timeout」——
    //   很容易被误读成 MinerU 解析失败，实际卡在下载。
    res = await fetch(zipUrl, { signal: AbortSignal.timeout(600_000) });
  } catch (e) {
    throw new MineruError('MINERU_API', `下载解析结果失败：${(e as Error).message}`);
  }
  if (res.status < 200 || res.status >= 300 || !res.body) {
    throw new MineruError('MINERU_API', `下载解析结果失败（HTTP ${res.status}）`);
  }
  const cl = Number(res.headers.get('content-length') ?? '0');
  if (cl > max) throw new MineruError('MINERU_API', `解析结果包超过 ${Math.round(max / 1024 / 1024)}MB 上限`);
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) throw new MineruError('MINERU_API', `解析结果包超过 ${Math.round(max / 1024 / 1024)}MB 上限`);
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}
