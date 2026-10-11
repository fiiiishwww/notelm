/**
 * server/services/feishu.ts —— 从飞书云文档导出 Markdown（图片一起拿回来）。
 *
 * ★ 为什么非要走 API，而不是解析剪贴板 ★
 *   从飞书复制粘贴到别处，图片会丢。原因是飞书文档里的图不是普通外链，而是存在
 *   云空间里的「素材」，只有拿着 access token 调「下载素材」接口才能拿到字节流。
 *   剪贴板那份 HTML 里的 src 要么带一次性鉴权参数（会过期），要么干脆是内部地址，
 *   粘到别的地方就变成死链。所以要保住图，只能走官方接口。
 *
 * 四步：
 *   1. app_id + app_secret → tenant_access_token（服务端直接换，不需要 OAuth 跳转回调）
 *   2. GET /docx/v1/documents/{id}/blocks     → 整篇文档的块树
 *   3. GET /drive/v1/medias/{token}/download  → 图片字节流
 *   4. 块树 → Markdown，图片另存，正文用相对路径 ![](assets/xxx.png) 引用
 *
 * ★ 两个必须让用户知道的前提 ★
 *   - 应用只能读「授权给它」的文档：用户得把自建应用加为文档协作者，
 *     否则第 2 步就 403。这个提示在 routes/import.ts 里给了详细指引。
 *   - 块接口和素材下载都是 5 QPS，所以这里**全部串行 + 节流**，不搞并发。
 *     一篇 50 张图的文档大概要等 10~20 秒，属于一次性成本，可以接受。
 *
 * ★ 为什么按「字段名」而不是 block_type 数字判断块类型 ★
 *   官方枚举里 Table/Divider/Todo 的编号在几处文档里不一致（22 到底是分割线还是表格，
 *   不同页面说法不同），但字段名（image / table / code / divider）是稳定且自解释的。
 *   所以这里先看字段、数字只作兜底——编号万一记错了，顶多少渲染一个块，不会整篇错乱。
 */

import { ApiError, bad, readConfig, readSecret } from '../core';

const BASE = 'https://open.feishu.cn/open-apis';

/** 5 QPS 的硬限制，留点余量取 210ms（≈4.7 次/秒）。 */
const THROTTLE_MS = 210;
/** 单次请求的超时；图片下载走同一个值（飞书素材接口明确说不支持高并发） */
const TIMEOUT_MS = 30_000;

export interface FeishuSettings {
  appId: string;
  appSecret: string;
  configured: boolean;
}

export async function getFeishuSettings(): Promise<FeishuSettings> {
  const cfg = await readConfig();
  const secret = await readSecret();
  const appId = (cfg.feishu?.appId ?? '').trim();
  const appSecret = (secret.feishuAppSecret ?? '').trim();
  return { appId, appSecret, configured: Boolean(appId && appSecret) };
}

// ─────────────────────────── 取 token ───────────────────────────

let tokenCache: { token: string; expireAt: number; key: string } | null = null;

/**
 * tenant_access_token 有效期 2 小时，缓存起来避免每篇文档都换一次。
 * key 记的是 appId+secret 的组合——用户改了凭据就必须立刻失效，
 * 否则会拿着旧 token 去请求，报出来的错会让人以为是文档没授权。
 */
export async function getTenantToken(force = false): Promise<string> {
  const s = await getFeishuSettings();
  if (!s.configured) {
    throw new ApiError(409, '还没有配置飞书应用，请先到「设置 → 飞书导入」里填 App ID 和 App Secret', 'feishu_not_configured');
  }
  const key = `${s.appId}|${s.appSecret}`;
  if (!force && tokenCache && tokenCache.key === key && tokenCache.expireAt > Date.now()) {
    return tokenCache.token;
  }

  const r = await feishuPost<{ tenant_access_token: string; expire: number }>(
    '/auth/v3/tenant_access_token/internal',
    { app_id: s.appId, app_secret: s.appSecret },
    { auth: false, label: '获取飞书访问令牌' },
  );
  if (!r.tenant_access_token) {
    throw new ApiError(502, '飞书没有返回访问令牌，请检查 App ID / App Secret 是否正确', 'feishu_no_token');
  }
  // 提前 5 分钟过期，别卡在临界点上
  tokenCache = {
    token: r.tenant_access_token,
    expireAt: Date.now() + Math.max(60, (r.expire ?? 7200) - 300) * 1000,
    key,
  };
  return tokenCache.token;
}

/** 用户改了凭据之后调一次，让缓存立刻失效。 */
export function clearTokenCache(): void {
  tokenCache = null;
}

// ─────────────────────────── HTTP 底层 ───────────────────────────

let lastCallAt = 0;

async function throttle(): Promise<void> {
  const wait = lastCallAt + THROTTLE_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

async function request<T>(
  pathname: string,
  init: { method: string; body?: unknown; auth: boolean; label: string },
): Promise<T> {
  await throttle();
  const headers: Record<string, string> = { 'Content-Type': 'application/json; charset=utf-8' };
  if (init.auth) headers.Authorization = `Bearer ${await getTenantToken()}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${BASE}${pathname}`, {
      method: init.method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    const msg = e instanceof Error && e.name === 'AbortError'
      ? `${init.label}超时（${TIMEOUT_MS / 1000} 秒）`
      : `${init.label}失败：网络不通或飞书域名无法访问`;
    throw new ApiError(502, msg, 'feishu_network');
  }
  clearTimeout(timer);

  const text = await res.text();
  if (!res.ok) throw translateError(res.status, text, init.label);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new ApiError(502, `${init.label}返回的不是 JSON`, 'feishu_bad_response');
  }
  const body = parsed as { code?: number; msg?: string; data?: T };
  if (body.code !== undefined && body.code !== 0) {
    throw translateCode(body.code, body.msg ?? '', init.label);
  }
  if (body.data === undefined) {
    throw new ApiError(502, `${init.label}返回体里没有 data`, 'feishu_bad_response');
  }
  return body.data;
}

function feishuPost<T>(pathname: string, body: unknown, opts: { auth: boolean; label: string }): Promise<T> {
  return request<T>(pathname, { method: 'POST', body, auth: opts.auth, label: opts.label });
}

function feishuGet<T>(pathname: string, label: string): Promise<T> {
  return request<T>(pathname, { method: 'GET', auth: true, label });
}

/**
 * 飞书的错误码要翻成「用户下一步该干什么」，不然只会看到 code: 231001。
 * 这一步很关键：大部分导入失败都是权限问题，得直接告诉用户去加协作者。
 */
function translateError(status: number, text: string, label: string): ApiError {
  let code: number | undefined;
  let msg = '';
  try {
    const p = JSON.parse(text) as { code?: number; msg?: string };
    code = p.code;
    msg = p.msg ?? '';
  } catch {
    /* 不是 JSON 就按 HTTP 状态码翻 */
  }
  if (code !== undefined) return translateCode(code, msg, label);

  if (status === 401) return new ApiError(401, `${label}失败：访问令牌无效或已过期`, 'feishu_unauthorized');
  if (status === 403) return new ApiError(403, `${label}失败：应用没有这个文档的权限`, 'feishu_forbidden');
  if (status === 404) return new ApiError(404, `${label}失败：文档不存在或已被删除`, 'feishu_not_found');
  if (status === 429) return new ApiError(429, `${label}失败：调用太频繁，请稍后再试`, 'feishu_rate_limited');
  return new ApiError(502, `${label}失败：HTTP ${status} ${msg}`.trim(), 'feishu_http_error');
}

function translateCode(code: number, msg: string, label: string): ApiError {
  // 限频：飞书统一用 99991xxx 这一段
  if (code === 99991400 || code === 99991403 || code === 99991404) {
    return new ApiError(429, `${label}失败：触发了飞书的频率限制，请等一会再试`, 'feishu_rate_limited');
  }
  if (code === 99991663 || code === 99991661 || code === 99991667 || code === 99991668) {
    return new ApiError(401, `${label}失败：App ID 或 App Secret 不对（${msg}）`, 'feishu_bad_credential');
  }
  // 云文档权限三件套：没授权 / 没开通权限 / 应用不可见
  if (code === 231001 || code === 231002 || code === 231003 || code === 231004 || code === 231005 || code === 231006) {
    return new ApiError(
      403,
      `${label}失败：应用读不到这个文档（${msg}）。请打开文档右上角「···」→「添加文档应用」，把你的自建应用加进去`,
      'feishu_no_doc_permission',
    );
  }
  if (code === 1254045 || code === 1254040 || code === 1254044) {
    return new ApiError(404, `${label}失败：文档不存在，或链接里的 ID 不对（${msg}）`, 'feishu_not_found');
  }
  if (code === 19001 || code === 19002) {
    return new ApiError(400, `${label}失败：参数不对（${msg}）`, 'feishu_bad_param');
  }
  return new ApiError(502, `${label}失败：${msg || `错误码 ${code}`}`, 'feishu_error', { feishuCode: code });
}

// ─────────────────────────── 链接解析 ───────────────────────────

export type DocKind = 'docx' | 'wiki' | 'docs';

export interface DocRef {
  kind: DocKind;
  token: string;
}

/**
 * 从用户粘进来的一串东西里认出文档。能处理：
 *   https://xxx.feishu.cn/docx/doxcnXXXX?from=copylink
 *   https://xxx.feishu.cn/wiki/wikcnXXXX
 *   https://xxx.larksuite.com/docx/doxcnXXXX   （海外版）
 *   直接粘的裸 token: doxcnXXXX / wikcnXXXX
 */
export function parseDocRef(input: string): DocRef {
  const raw = (input ?? '').trim();
  if (!raw) throw bad('请粘贴飞书文档的链接', 'empty_doc_url');

  // 先砍掉 query 和 hash，避免把 ?from=xxx 当 token 的一部分
  const clean = raw.split(/[?#]/)[0] ?? raw;

  const m = /\/(docx|docs|wiki|sheet|sheets|base|slides|mindnotes|file)\/([A-Za-z0-9_-]+)/i.exec(clean);
  if (m) {
    const kind = m[1]!.toLowerCase();
    const token = m[2]!;
    if (kind === 'wiki') return { kind: 'wiki', token };
    if (kind === 'docx') return { kind: 'docx', token };
    if (kind === 'docs') return { kind: 'docs', token };
    throw bad(
      `暂不支持导入${kind === 'sheet' || kind === 'sheets' ? '表格' : kind === 'base' ? '多维表格' : kind === 'slides' ? '幻灯片' : kind === 'mindnotes' ? '思维导图' : '这种类型'}，只能导入新版文档（docx）和知识库文档（wiki）`,
      'unsupported_doc_type',
    );
  }

  // 裸 token
  if (/^doxcn[A-Za-z0-9]+$/i.test(clean)) return { kind: 'docx', token: clean };
  if (/^wikcn[A-Za-z0-9]+$/i.test(clean)) return { kind: 'wiki', token: clean };
  if (/^doccn[A-Za-z0-9]+$/i.test(clean)) return { kind: 'docs', token: clean };

  if (/^https?:\/\//i.test(clean)) {
    throw bad('这不像一个飞书文档链接（需要包含 /docx/ 或 /wiki/）', 'bad_doc_url');
  }
  throw bad('认不出这是什么，请粘贴完整的飞书文档链接', 'bad_doc_url');
}

/** wiki 节点要先换成真正的文档 ID 才能取块。 */
export async function resolveWiki(token: string): Promise<string> {
  const data = await feishuGet<{ node?: { obj_token?: string; obj_type?: string } }>(
    `/wiki/v2/spaces/get_node?token=${encodeURIComponent(token)}&obj_type=wiki`,
    '解析知识库节点',
  );
  const objToken = data.node?.obj_token;
  if (!objToken) {
    throw new ApiError(404, '这个知识库节点里没有文档，或者应用没有权限访问它', 'wiki_empty');
  }
  if (data.node?.obj_type && data.node.obj_type !== 'docx') {
    throw bad(`知识库节点里是「${data.node.obj_type}」，只能导入其中的新版文档（docx）`, 'unsupported_doc_type');
  }
  return objToken;
}

// ─────────────────────────── 块数据结构 ───────────────────────────

interface TextElementStyle {
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  inline_code?: boolean;
  link?: { url?: string };
}

interface TextElement {
  text_run?: { content?: string; text_element_style?: TextElementStyle };
  mention_user?: { user_id?: string; text_element_style?: TextElementStyle };
  mention_doc?: { token?: string; obj_type?: number; text_element_style?: TextElementStyle };
  equation?: { content?: string };
  reminder?: Record<string, unknown>;
}

interface FeishuBlock {
  block_id: string;
  parent_id?: string;
  children?: string[];
  block_type?: number;
  page?: Record<string, unknown>;
  text?: { elements?: TextElement[] };
  heading1?: { elements?: TextElement[] };
  heading2?: { elements?: TextElement[] };
  heading3?: { elements?: TextElement[] };
  heading4?: { elements?: TextElement[] };
  heading5?: { elements?: TextElement[] };
  heading6?: { elements?: TextElement[] };
  heading7?: { elements?: TextElement[] };
  heading8?: { elements?: TextElement[] };
  heading9?: { elements?: TextElement[] };
  bullet?: { elements?: TextElement[] };
  ordered?: { elements?: TextElement[] };
  code?: { elements?: TextElement[]; style?: { language?: number } };
  quote?: { elements?: TextElement[] };
  quote_container?: Record<string, unknown>;
  todo?: { elements?: TextElement[]; style?: { done?: boolean } };
  callout?: Record<string, unknown>;
  divider?: Record<string, unknown>;
  image?: { token?: string; caption?: { elements?: TextElement[] } };
  table?: { cells?: string[]; property?: { row_size?: number; column_size?: number; header_row?: boolean } };
  table_cell?: Record<string, unknown>;
  grid?: Record<string, unknown>;
  grid_column?: Record<string, unknown>;
}

/** 一个块可能带 elements 的字段名有哪些（用于兜底识别） */
const ELEMENT_KEYS = [
  'heading1', 'heading2', 'heading3', 'heading4', 'heading5', 'heading6', 'heading7', 'heading8', 'heading9',
] as const;

// ─────────────────────────── 主流程 ───────────────────────────

export interface FeishuImage {
  file: string;
  data: Buffer;
}

export interface FeishuDocResult {
  title: string;
  markdown: string;
  images: FeishuImage[];
  warnings: string[];
  stats: { blocks: number; images: number; chars: number };
  /** 没能渲染的块类型（按 block_type 去重），用来告诉用户「有东西没导过来」 */
  unsupported: number[];
}

export interface FetchOpts {
  /** 已经解析好的 document_id；传了就跳过链接解析和 wiki 转换（省一次接口调用） */
  documentId?: string;
  /** 图片文件名前缀，通常是「文档名-」 */
  imagePrefix?: string;
  /** 已经知道的标题（预览阶段拿到的）；传了就跳过「读取文档信息」这一次调用 */
  title?: string;
  /** 只看一眼：拉内容和统计，但不下载图片（给预览用） */
  skipImages?: boolean;
}

/**
 * 只看标题。
 * 路由层要先拿标题定文件名（重名会自动加 -2），才能算出图片前缀，
 * 所以「查标题」必须能独立调——否则会出现文章叫 xxx-2.md 而图片还叫 xxx-image-1.png，
 * 导入第二篇同名文档时把第一篇的图盖掉。
 */
export async function peekFeishuDoc(input: string): Promise<{ title: string; documentId: string; kind: DocKind }> {
  const ref = parseDocRef(input);
  if (ref.kind === 'docs') throw legacyDocError();
  const documentId = ref.kind === 'wiki' ? await resolveWiki(ref.token) : ref.token;
  const title = await fetchDocTitle(documentId);
  return { title, documentId, kind: ref.kind };
}

async function fetchDocTitle(documentId: string): Promise<string> {
  const meta = await feishuGet<{ document?: { title?: string } }>(
    `/docx/v1/documents/${encodeURIComponent(documentId)}`,
    '读取文档信息',
  );
  return (meta.document?.title ?? '').trim() || '飞书文档';
}

function legacyDocError(): ApiError {
  return bad(
    '这是旧版飞书文档（链接里是 /docs/）。请先在飞书里打开它，用「··· → 转换为新版文档」转成新版，再来导入',
    'legacy_doc',
  );
}

export async function fetchFeishuDoc(input: string, opts: FetchOpts = {}): Promise<FeishuDocResult> {
  const ref = opts.documentId ? null : parseDocRef(input);
  if (ref?.kind === 'docs') throw legacyDocError();

  const documentId =
    opts.documentId ?? (ref!.kind === 'wiki' ? await resolveWiki(ref!.token) : ref!.token);
  const title = opts.title?.trim() || (await fetchDocTitle(documentId));

  const blocks = await fetchAllBlocks(documentId);
  if (blocks.length === 0) {
    throw new ApiError(409, '这篇文档是空的，没有可导入的内容', 'empty_doc');
  }

  const map = new Map<string, FeishuBlock>();
  for (const b of blocks) map.set(b.block_id, b);
  const root = blocks.find((b) => b.block_type === 1) ?? blocks[0]!;

  const ctx: RenderCtx = {
    map,
    imageNames: new Map(),
    pending: [],
    unsupported: new Set<number>(),
    seq: 1,
    imagePrefix: opts.imagePrefix ?? '',
  };

  const bodyParts = renderChildren(root.children ?? [], ctx, 1);
  const body = joinParts(bodyParts);

  // 文档标题做一级标题，块里的标题整体降一级（否则两层标题会撞在一起）
  const rendered = `# ${title}\n\n${body}`;

  let markdown = rendered;
  let images: FeishuImage[] = [];
  let failed: string[] = [];
  if (opts.skipImages) {
    // 预览模式：名字还定不下来（扩展名要等下载才知道），保留占位名即可
    markdown = rendered;
  } else {
    const r = await resolveImages(rendered, ctx.pending, ctx.imagePrefix);
    markdown = r.markdown;
    images = r.images;
    failed = r.failed;
  }
  markdown = markdown.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';

  const warnings: string[] = [];
  if (failed.length) {
    warnings.push(
      `${failed.length} 张图片没下载下来（多半是应用只拿到了文档的阅读权限、没拿到素材下载权限），正文里已用注释标出位置`,
    );
  }
  if (ctx.unsupported.size) {
    warnings.push(`有 ${ctx.unsupported.size} 种块类型没法转成 Markdown（如公式、画板、第三方嵌入），已跳过`);
  }

  return {
    title,
    markdown,
    images,
    warnings,
    // 预览时图片还没下载，用待下载的数量报给前端
    stats: { blocks: blocks.length, images: opts.skipImages ? ctx.pending.length : images.length, chars: markdown.length },
    unsupported: [...ctx.unsupported],
  };
}

async function fetchAllBlocks(documentId: string): Promise<FeishuBlock[]> {
  const out: FeishuBlock[] = [];
  let pageToken = '';
  // 上限 100 页 × 500 = 5 万个块，真到这个量级也没必要全导
  for (let page = 0; page < 100; page++) {
    const qs = new URLSearchParams({ document_revision_id: '-1', page_size: '500' });
    if (pageToken) qs.set('page_token', pageToken);
    const data = await feishuGet<{ items?: FeishuBlock[]; page_token?: string; has_more?: boolean }>(
      `/docx/v1/documents/${encodeURIComponent(documentId)}/blocks?${qs.toString()}`,
      '读取文档内容',
    );
    out.push(...(data.items ?? []));
    if (!data.has_more || !data.page_token) break;
    pageToken = data.page_token;
  }
  return out;
}

/**
 * 下载一张图。同一个 token 在文档里出现多次只下一次（缓存文件名），
 * 否则一篇用了 20 次 logo 的文档要等 20 倍时间。
 */
async function fetchMedia(token: string): Promise<{ data: Buffer; contentType: string }> {
  await throttle();
  const auth = `Bearer ${await getTenantToken()}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${BASE}/drive/v1/medias/${encodeURIComponent(token)}/download`, {
      method: 'GET',
      headers: { Authorization: auth },
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    const msg = e instanceof Error && e.name === 'AbortError' ? '下载图片超时' : '下载图片失败：网络不通';
    throw new ApiError(502, msg, 'feishu_media_network');
  }
  clearTimeout(timer);

  if (!res.ok) throw translateError(res.status, await res.text().catch(() => ''), '下载图片');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new ApiError(502, '下载图片失败：拿到的是空文件', 'feishu_media_empty');
  return { data: buf, contentType: (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase() };
}

const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/bmp': '.bmp',
  'image/x-icon': '.ico',
  'image/avif': '.avif',
};

function extOfMime(mime: string): string {
  return MIME_EXT[mime] ?? '.png';
}

// ─────────────────────────── 块 → Markdown ───────────────────────────

interface RenderCtx {
  map: Map<string, FeishuBlock>;
  /** token → 已经定好的基础名（不含扩展名），同一张图复用同一个文件 */
  imageNames: Map<string, string>;
  /** 待下载的 token，顺序就是渲染时出现的顺序 */
  pending: string[];
  unsupported: Set<number>;
  seq: number;
  /**
   * 图片文件名前缀，一般是「文档名-」。
   * 为什么必须有：同一个目录里很可能有两篇标题相同的文档（比如都叫「会议纪要」），
   * 如果图片都叫 image-1.png，后导入的那篇会把前一篇的图整个盖掉，
   * 而文章本身因为重名自动加了 -2 反而没事——图悄悄错了最难发现。
   */
  imagePrefix: string;
}

interface Part {
  text: string;
  /** 紧凑块（列表项）：相邻两个紧凑块之间只空一个换行，否则列表会被拆散 */
  tight: boolean;
}

function joinParts(parts: Part[]): string {
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (!p.text) continue;
    if (out.length === 0) {
      out.push(p.text);
      continue;
    }
    const prev = parts[i - 1]!;
    out.push(prev.tight && p.tight ? '\n' : '\n\n', p.text);
  }
  return out.join('');
}

function renderChildren(ids: string[], ctx: RenderCtx, depth: number): Part[] {
  const out: Part[] = [];
  for (const id of ids) {
    const b = ctx.map.get(id);
    if (!b) continue;
    out.push(...renderBlock(b, ctx, depth));
  }
  return out;
}

function elementsOf(b: FeishuBlock): TextElement[] | null {
  if (b.text?.elements) return b.text.elements;
  if (b.bullet?.elements) return b.bullet.elements;
  if (b.ordered?.elements) return b.ordered.elements;
  if (b.quote?.elements) return b.quote.elements;
  if (b.todo?.elements) return b.todo.elements;
  if (b.code?.elements) return b.code.elements;
  for (const k of ELEMENT_KEYS) {
    const v = b[k];
    if (v?.elements) return v.elements;
  }
  return null;
}

function headingLevelOf(b: FeishuBlock): number | null {
  for (let n = 1; n <= 9; n++) {
    const v = b[`heading${n}` as keyof FeishuBlock] as { elements?: TextElement[] } | undefined;
    if (v) return n;
  }
  return null;
}

/**
 * 渲染一个块。容器块（页面 / 引用容器 / 高亮块 / 分栏 / 表格单元格）会展开成多个 Part。
 *
 * 判断顺序是按字段来的：先认「带 elements 的字段」，再认图片 / 表格 / 分割线，
 * 最后才看 block_type 数字兜底。这样即使官方枚举编号有出入也不会整篇崩。
 */
function renderBlock(b: FeishuBlock, ctx: RenderCtx, depth: number): Part[] {
  // 1) 页面 / 容器：直接展开子块
  if (b.block_type === 1 || b.quote_container || b.grid || b.grid_column || b.callout || b.table_cell) {
    if (b.callout) {
      // 飞书的高亮块在 Markdown 里没有对应物，用引用块兜住，至少能看出是强调内容
      const inner = renderChildren(b.children ?? [], ctx, depth);
      return inner.map((p) => ({ text: prefixLines(p.text, '> '), tight: false }));
    }
    if (b.quote_container) {
      const inner = renderChildren(b.children ?? [], ctx, depth);
      return inner.map((p) => ({ text: prefixLines(p.text, '> '), tight: false }));
    }
    return renderChildren(b.children ?? [], ctx, depth);
  }

  // 2) 图片。扩展名要等下载完看 content-type 才知道，先按 png 占位，
  //    后面 resolveImages 会把 markdown 里的占位名换成真实名字。
  const imgToken = b.image?.token;
  if (imgToken) {
    let base = ctx.imageNames.get(imgToken);
    if (!base) {
      base = `${ctx.imagePrefix}image-${ctx.seq++}`;
      ctx.imageNames.set(imgToken, base);
      ctx.pending.push(imgToken);
    }
    const parts: Part[] = [{ text: `![](assets/${base}${PLACEHOLDER_EXT})`, tight: false }];
    const cap = b.image?.caption?.elements;
    if (cap?.length) {
      const capText = renderElements(cap).trim();
      if (capText) parts.push({ text: `*${capText}*`, tight: false });
    }
    return parts;
  }

  // 3) 表格
  if (b.table?.cells?.length) {
    return [renderTable(b, ctx)];
  }

  // 4) 分割线：字段名和编号都认
  if (b.divider || b.block_type === 22) {
    return [{ text: '---', tight: false }];
  }

  // 5) 代码
  if (b.code) {
    const lang = CODE_LANG[b.code.style?.language ?? 1] ?? '';
    const text = renderElements(b.code.elements ?? []).replace(/\n+$/, '');
    return [{ text: `\`\`\`${lang}\n${text}\n\`\`\``, tight: false }];
  }

  // 6) 标题（降一级，给文档标题让出 H1 的位置）
  const hl = headingLevelOf(b);
  if (hl !== null) {
    const text = renderElements(elementsOf(b) ?? []).trim();
    if (!text) return [];
    const level = Math.min(hl + 1, 6);
    return [{ text: `${'#'.repeat(level)} ${text}`, tight: false }];
  }

  // 7) 列表项
  if (b.bullet || b.block_type === 12) {
    const text = renderElements(b.bullet?.elements ?? []).trim();
    return [{ text: `${'  '.repeat(Math.max(0, depth - 1))}- ${text}`, tight: true }];
  }
  if (b.ordered || b.block_type === 13) {
    const text = renderElements(b.ordered?.elements ?? []).trim();
    return [{ text: `${'  '.repeat(Math.max(0, depth - 1))}1. ${text}`, tight: true }];
  }
  if (b.todo) {
    const text = renderElements(b.todo.elements ?? []).trim();
    const mark = b.todo.style?.done ? 'x' : ' ';
    return [{ text: `${'  '.repeat(Math.max(0, depth - 1))}- [${mark}] ${text}`, tight: true }];
  }

  // 8) 引用
  if (b.quote) {
    const text = renderElements(b.quote.elements ?? []).trim();
    return [{ text: prefixLines(text, '> '), tight: false }];
  }

  // 9) 普通段落
  const els = elementsOf(b);
  if (els) {
    const text = renderElements(els).trim();
    return [{ text, tight: false }];
  }

  // 10) 认不出来的块：记下来，别静默吞掉
  if (b.block_type !== undefined) ctx.unsupported.add(b.block_type);
  return [];
}

function prefixLines(text: string, prefix: string): string {
  if (!text) return text;
  return text
    .split('\n')
    .map((l) => (l ? prefix + l : prefix.trimEnd()))
    .join('\n');
}

function renderTable(b: FeishuBlock, ctx: RenderCtx): Part {
  const cells = b.table!.cells!;
  const prop = b.table!.property ?? {};
  const cols = Math.max(1, prop.column_size ?? 1);
  const rows = Math.max(1, prop.row_size ?? Math.ceil(cells.length / cols));

  const grid: string[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: string[] = [];
    for (let c = 0; c < cols; c++) {
      const id = cells[r * cols + c];
      row.push(id ? cellText(id, ctx) : '');
    }
    grid.push(row);
  }

  const lines = grid.map((row) => `| ${row.join(' | ')} |`);
  // 表头分隔行插在第一行之后；没有表头就插在最前面（Markdown 表格必须有）
  const sep = `| ${Array.from({ length: cols }, () => '---').join(' | ')} |`;
  lines.splice(prop.header_row ? 1 : 0, 0, sep);
  return { text: lines.join('\n'), tight: false };
}

/** 单元格内容：把里面所有子块的文字压成一行（表格里放不下多行） */
function cellText(id: string, ctx: RenderCtx): string {
  const b = ctx.map.get(id);
  if (!b) return '';
  const text = (b.children ?? []).length
    ? renderChildren(b.children!, ctx, 1)
        .map((p) => p.text)
        .join(' ')
    : renderElements(elementsOf(b) ?? []);
  return escapeCell(text.replace(/\s+/g, ' ').trim());
}

function escapeCell(text: string): string {
  // 表格里竖线必须转义，否则整行会多出几列
  return text.replace(/\|/g, '\\|');
}

/** 行内样式：从外到内 粗 → 斜 → 删除线 → 行内码 → 链接 */
function renderElements(elements: TextElement[]): string {
  let out = '';
  for (const el of elements) {
    out += renderElement(el);
  }
  return out;
}

function renderElement(el: TextElement): string {
  if (el.text_run) {
    const style = el.text_run.text_element_style ?? {};
    let text = el.text_run.content ?? '';
    const url = style.link?.url;
    if (url) text = `[${text}](${url})`;
    if (style.inline_code) text = `\`${text}\``;
    if (style.strikethrough) text = `~~${text}~~`;
    if (style.italic) text = `*${text}*`;
    if (style.bold) text = `**${text}**`;
    return text;
  }
  if (el.mention_user) return `@${el.mention_user.user_id ?? '用户'}`;
  if (el.mention_doc) return `[@文档](${el.mention_doc.token ?? ''})`;
  if (el.equation) return `$${el.equation.content ?? ''}$`;
  // reminder、以及将来可能新增的元素类型：静默跳过，不打扰
  return '';
}

const CODE_LANG: Record<number, string> = {
  1: '', 2: 'abap', 3: 'ada', 4: 'apache', 5: 'apex', 6: 'assembly', 7: 'bash', 8: 'basic',
  9: 'c', 10: 'csharp', 11: 'cpp', 12: 'c', 13: 'cmake', 14: 'coffeescript', 15: 'css',
  16: 'd', 17: 'css', 18: 'dart', 19: 'dockerfile', 20: 'go', 21: 'html', 22: 'java',
  23: 'javascript', 24: 'json', 25: 'julia', 26: 'kotlin', 27: 'latex', 28: 'lisp',
  29: 'lua', 30: 'matlab', 31: 'makefile', 32: 'markdown', 33: 'objective-c', 34: 'ocaml',
  35: 'perl', 36: 'php', 37: 'powershell', 38: 'protobuf', 39: 'python', 40: 'python',
  41: 'r', 42: 'ruby', 43: 'rust', 44: 'rust', 45: 'scala', 46: 'shell', 47: 'sql',
  48: 'swift', 49: 'typescript', 50: 'vb', 51: 'verilog', 52: 'vhdl', 53: 'xml', 54: 'yaml',
};

// ─────────────────────────── 图片落盘前的下载 ───────────────────────────

/** 渲染阶段的图片扩展名占位（此时还不知道真实类型） */
const PLACEHOLDER_EXT = '.png';

/**
 * 逐张下载图片，并把 Markdown 里的占位名换成真实文件名。
 *
 * 单张失败不打断整体：正文里留一条 HTML 注释标出位置，最后统一报警告。
 * 这样「应用有阅读权限但没有素材下载权限」这种常见情况，至少文字能完整拿回来。
 */
async function resolveImages(
  markdown: string,
  tokens: string[],
  prefix = '',
): Promise<{ markdown: string; images: FeishuImage[]; failed: string[] }> {
  const images: FeishuImage[] = [];
  const failed: string[] = [];
  let out = markdown;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const base = `${prefix}image-${i + 1}`;
    try {
      const { data, contentType } = await fetchMedia(token);
      const file = `${base}${extOfMime(contentType)}`;
      images.push({ file, data });
      out = out.split(`assets/${base}${PLACEHOLDER_EXT}`).join(`assets/${file}`);
    } catch (e) {
      failed.push(token);
      const msg = e instanceof ApiError ? e.message : String(e);
      // 换成注释而不是留着死链——留死链的话应用里会显示一排「图片加载失败」的虚线框
      out = out
        .split(`![](assets/${base}${PLACEHOLDER_EXT})`)
        .join(`<!-- 图片下载失败：${escapeComment(msg)} -->`);
    }
  }
  return { markdown: out, images, failed };
}

function escapeComment(text: string): string {
  return text.replace(/--/g, '—').replace(/</g, '(').replace(/>/g, ')');
}

// ─────────────────────────── 连通性测试 ───────────────────────────

export async function testFeishu(): Promise<{ ok: boolean; message: string }> {
  try {
    await getTenantToken(true);
    return { ok: true, message: '凭据有效，可以开始导入了' };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}
