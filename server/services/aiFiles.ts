/**
 * server/services/aiFiles.ts —— OpenAI 兼容的 /files 接口封装（上传 → 取回文本）。
 *
 * ★ 先说清楚它到底做了什么，免得被「LLM 能直接读文件」这句话误导 ★
 *   Kimi 的 files 接口不是「把文件交给模型去读」，而是：
 *     1) POST /files (purpose=file-extract) —— 服务端**抽取**文本
 *     2) GET  /files/{id}/content          —— 取回抽取后的文本
 *     3) 你把这段文本塞进 messages（官方示例放 system）
 *   所以它等价于「服务端帮你把 pdf/doc 转成文本，并整理成它推荐给模型的格式」。
 *   正文本来就是 markdown 的话，走这条路只是多两次网络往返 ——
 *   它值不值得，要用同一个节、同一套覆盖率口径量出来，而不是靠感觉说。
 *   （scripts/kimi-cheatsheet-probe.ts --via=file 就是干这个的。）
 *
 * 上传与取回都走用户自己填的 baseURL，不硬编码任何第三方地址。
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ApiError } from '../core';
import { apiUrl, getAiSettings, translateHttpError } from './aiClient';

/** 上传一个文件用于内容抽取，返回 file_id。 */
export async function uploadFileForExtract(filePath: string, profile?: string): Promise<string> {
  const s = await getAiSettings(profile);
  if (!s.configured) throw new ApiError(409, `接口「${s.name || '默认'}」未配置完整`, 'ai_not_configured');

  const buf = await readFile(filePath);
  const fd = new FormData();
  fd.append('purpose', 'file-extract');
  // 不手填 Content-Type —— 让 fetch 自己带 multipart boundary
  fd.append('file', new Blob([new Uint8Array(buf)]), path.basename(filePath));

  const res = await fetch(apiUrl(s.baseURL, 'files'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${s.apiKey}` },
    body: fd,
    signal: AbortSignal.timeout(120_000),
  });
  const raw = await res.text();
  if (!res.ok) {
    throw new ApiError(502, translateHttpError(res.status, raw), 'ai_files_upload_failed', {
      status: res.status,
    });
  }
  const parsed = JSON.parse(raw) as { id?: string };
  if (!parsed.id) throw new ApiError(502, `上传成功但没拿到 file id：${raw.slice(0, 200)}`, 'ai_files_upload_failed');
  return parsed.id;
}

/** 取回上传文件被抽取出来的文本。 */
export async function fetchFileText(fileId: string, profile?: string): Promise<string> {
  const s = await getAiSettings(profile);
  if (!s.configured) throw new ApiError(409, `接口「${s.name || '默认'}」未配置完整`, 'ai_not_configured');

  const res = await fetch(apiUrl(s.baseURL, `files/${encodeURIComponent(fileId)}/content`), {
    headers: { Authorization: `Bearer ${s.apiKey}` },
    signal: AbortSignal.timeout(60_000),
  });
  const raw = await res.text();
  if (!res.ok) {
    throw new ApiError(502, translateHttpError(res.status, raw), 'ai_files_fetch_failed', {
      status: res.status,
    });
  }
  // 有的网关按 JSON 返回 {content:"..."}，有的直接吐纯文本
  if (raw.trimStart().startsWith('{')) {
    try {
      const j = JSON.parse(raw) as { content?: string };
      if (typeof j.content === 'string') return j.content;
    } catch {
      /* 不是 JSON，就当纯文本 */
    }
  }
  return raw;
}

/** 上传本地正文并取回它抽取后的文本——一步到位，给探针用。 */
export async function extractFileText(
  localPath: string,
  profile?: string,
): Promise<{ fileId: string; text: string }> {
  const fileId = await uploadFileForExtract(localPath, profile);
  const text = await fetchFileText(fileId, profile);
  return { fileId, text };
}
