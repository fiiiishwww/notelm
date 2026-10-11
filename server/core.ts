/**
 * server/core.ts —— 基础设施：错误类型、原子写盘、应用配置、路径工具。
 */

// ★ 副作用 import，必须在最前：把项目根的 .env 加载进 process.env。
//   放这里而不是各入口，是因为所有服务都 import core ——
//   只在 server/index.ts 里加一次的话，脚本（scripts/*.ts）就读不到 .env。
import './env';

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// ─────────────────────────── 错误 ───────────────────────────

export class ApiError extends Error {
  status: number;
  code: string;
  extra: Record<string, unknown>;

  constructor(status: number, message: string, code = 'error', extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const bad = (msg: string, code = 'bad_request') => new ApiError(400, msg, code);
export const conflict = (msg: string, extra: Record<string, unknown> = {}) =>
  new ApiError(409, msg, 'conflict', extra);

/**
 * 把 Node fs 的 errno 翻译成人能看懂的中文错误。
 * 不翻译的话前端只会看到 "ENOENT: no such file or directory, open '...'"，
 * 用户根本不知道哪个文件出了问题。
 */
export function normalizeFsError(e: unknown, what: string): ApiError {
  if (e instanceof ApiError) return e;
  const err = e as NodeJS.ErrnoException;
  const detail = err?.path ? `（${err.path}）` : '';
  switch (err?.code) {
    case 'ENOENT':
      return new ApiError(404, `${what}失败：文件或目录不存在${detail}`, 'not_found');
    case 'EACCES':
    case 'EPERM':
      return new ApiError(403, `${what}失败：没有权限${detail}`, 'no_permission');
    case 'EBUSY':
      return new ApiError(409, `${what}失败：文件被其他程序占用，请先关闭它`, 'busy');
    case 'ENOTDIR':
      return new ApiError(400, `${what}失败：路径中有一段不是目录${detail}`, 'not_a_dir');
    case 'EISDIR':
      return new ApiError(400, `${what}失败：目标是一个目录${detail}`, 'is_a_dir');
    case 'ENOSPC':
      return new ApiError(507, `${what}失败：磁盘空间不足`, 'no_space');
    case 'EEXIST':
      return new ApiError(409, `${what}失败：目标已存在${detail}`, 'exists');
    default:
      return new ApiError(500, `${what}失败：${err?.message ?? String(e)}`, 'fs_error', {
        errno: err?.code ?? null,
      });
  }
}

// ─────────────────────────── 路径 ───────────────────────────

export const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
/** 应用自身的私有目录（含「笔记库在哪」这个指针），刻意放在 vault 外面 */
export const LOCAL_DIR = path.join(PROJECT_ROOT, '.local');
export const CONFIG_FILE = path.join(LOCAL_DIR, 'config.json');
export const SECRETS_FILE = path.join(LOCAL_DIR, 'secrets.json');
/** 首次使用时推荐的默认笔记库 */
export const DEFAULT_VAULT = path.join(PROJECT_ROOT, 'notes');
/** vault 内部的私有数据目录名 */
export const DATA_DIR_NAME = '.notebook';
/**
 * 探针产物落点（唯一出口）。
 *
 * ★ 为什么单独定义、不让各处自己拼 ★
 *   2026-10-08 清理目录时，探针落点一共有 **5 种写法**
 *   （`join(vault, DATA_DIR_NAME, '_probe-out')`、`join(ROOT, 'notes', '.notebook', …)`、
 *   `path.join('notes', …)` 等），其中 3 种真的落到了 `notes/.notebook/.local/probe-out/`
 *   —— 也就是说**写进她的库里了**。写法一多就一定会错一个，所以收敛成一个常量。
 *
 * ★ 规矩见 `docs/目录规矩.md` 第 1 条 ★
 *   `notes/` 是她的库，不放开发期中间产物；`.local/` 是「可随时清空」的机器本地区。
 *   派生数据（sidecar / concepts.json / learning.json）**仍然该在 notes/.notebook/ 里**，
 *   动的只是探针产物这一个子目录。
 */
export const PROBE_OUT = path.join(LOCAL_DIR, 'probe-out');

export function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 生成 32 字节的随机十六进制串，用作本地 API token。 */
export function randomToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function ensureDirSync(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * 原子写：先写临时文件再 rename。
 * 避免「写了一半被中断」留下半截文件——Obsidian 也在看这个目录。
 */
export async function writeFileAtomic(abs: string, data: string | Buffer): Promise<void> {
  const dir = path.dirname(abs);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(abs)}.${process.pid}.${Date.now()}.tmp`);
  await fsp.writeFile(tmp, data);
  try {
    await fsp.rename(tmp, abs);
  } catch (e) {
    // 临时文件清不掉不能掩盖真正的写入错误，所以清理失败直接忽略
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
}

/**
 * 覆盖前留一份 .bak。sidecar 坏了还能捞回来。
 * 只在目标已存在时备份。
 */
export async function backupBeforeWrite(abs: string): Promise<void> {
  try {
    await fsp.copyFile(abs, `${abs}.bak`);
  } catch {
    /* 目标不存在，无需备份 */
  }
}

export async function readJson<T>(abs: string, fallback: T): Promise<T> {
  try {
    const raw = await fsp.readFile(abs, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export async function exists(abs: string): Promise<boolean> {
  try {
    await fsp.access(abs);
    return true;
  } catch {
    return false;
  }
}

export function existsSync(abs: string): boolean {
  return fs.existsSync(abs);
}

// ─────────────────────────── 应用配置 ───────────────────────────

/**
 * 一套「对话接口」的地址与模型（**不含 Key**）。
 *
 * ★ 为什么要有具名接口，而不是只有一套 ai 配置 ★
 *   小抄生成这类任务对「用哪个模型」很敏感：长上下文整篇一次读 vs 短窗口多次采集，
 *   是两种完全不同的做法，得能并排跑、并排比。只有一套配置的话，
 *   每次对比都要改配置、跑完再改回来，中途忘了改回来就会污染真实数据。
 *   Key 按**同名**去 secrets 的 profileKeys 里取，所以新增一套接口不用动 secrets 结构。
 */
export interface AiEndpoint {
  baseURL: string;
  model: string;
  /** 不填则用 ai.temperature */
  temperature?: number;
}

export interface AppConfig {
  vaultRoot: string | null;
  theme: 'light' | 'dark';
  /** 界面主色（#RRGGBB）。hover/soft/border/夜色版都由前端派生，这里只存用户挑的那一个。 */
  themeColor?: string;
  panelWidths: { left: number; right: number };
  ai: {
    baseURL: string;
    model: string;
    temperature: number;
    /** 具名接口：名字 → 地址/模型。地址一律由用户填，代码里不硬编码任何第三方地址。 */
    profiles?: Record<string, AiEndpoint>;
  };
  /**
   * 检索用的 embedding 接口。**刻意和 ai 分开**——用户要的是「换一个 API 专门做向量」，
   * 常见组合是：对话走 DeepSeek / OpenAI，向量走硅基流动、Gemini、本地 Ollama。
   * 两者的地址、模型、Key 都没有任何理由共用。
   */
  /**
   * batchSize：一次请求最多送几条文本。
   * 各家上限差得离谱（DashScope 是 10 条，有的网关只收 1 条），写死一个值必然在某家翻车。
   * 缺省时用内置默认值；一旦撞上「batch size is invalid」，embed.ts 会自动减半重试，
   * 并把最终能用的值写回这里，下次不必再试错。
   */
  embedding: { baseURL: string; model: string; dimensions: number; batchSize?: number };
  /**
   * 飞书开放平台的自建应用。**同样刻意和 ai / embedding 分开**——
   * 它是第三套凭据：app_id 不是「接口地址」，app_secret 也不是「模型 Key」，
   * 走的是完全不同的认证方式（tenant_access_token），没有理由和前两者共用。
   * 只存 appId（不算机密）；app_secret 放 secrets 文件。
   */
  feishu: { appId: string };
  /**
   * 外部 AI 助手（DSH）的托管参数。NoteLM 只管「把它拉起来 + 拿到访问地址」，
   * agent 循环全在 DSH 里，这里没有也不需要任何 AI 配置。
   */
  dsh?: { dir?: string; port?: number; autoStart?: boolean };
}

export const DEFAULT_CONFIG: AppConfig = {
  vaultRoot: null,
  theme: 'light',
  /** 糖果绿：与 theme.css 变量层的默认值保持一致，改一处必须改另一处 */
  themeColor: '#35c47f',
  panelWidths: { left: 280, right: 340 },
  ai: { baseURL: '', model: '', temperature: 0.3, profiles: {} },
  // dimensions: 0 = 未指定，发请求时不带 dimensions 字段，用接口返回的原生维度
  embedding: { baseURL: '', model: '', dimensions: 0 },
  feishu: { appId: '' },
};

let configCache: AppConfig | null = null;

export async function readConfig(): Promise<AppConfig> {
  if (configCache) return configCache;
  const raw = await readJson<Partial<AppConfig>>(CONFIG_FILE, {});
  configCache = {
    ...DEFAULT_CONFIG,
    ...raw,
    themeColor: raw.themeColor ?? DEFAULT_CONFIG.themeColor,
    panelWidths: { ...DEFAULT_CONFIG.panelWidths, ...(raw.panelWidths ?? {}) },
    ai: { ...DEFAULT_CONFIG.ai, ...(raw.ai ?? {}), profiles: { ...(raw.ai?.profiles ?? {}) } },
    embedding: { ...DEFAULT_CONFIG.embedding, ...(raw.embedding ?? {}) },
    feishu: { ...DEFAULT_CONFIG.feishu, ...(raw.feishu ?? {}) },
  };
  return configCache;
}

export async function writeConfig(patch: Partial<AppConfig>): Promise<AppConfig> {
  const cur = await readConfig();
  const next: AppConfig = {
    ...cur,
    ...patch,
    panelWidths: { ...cur.panelWidths, ...(patch.panelWidths ?? {}) },
    ai: patch.ai
      ? { ...cur.ai, ...patch.ai, profiles: { ...(cur.ai.profiles ?? {}), ...(patch.ai.profiles ?? {}) } }
      : cur.ai,
    embedding: { ...cur.embedding, ...(patch.embedding ?? {}) },
    feishu: { ...cur.feishu, ...(patch.feishu ?? {}) },
  };
  ensureDirSync(LOCAL_DIR);
  await writeFileAtomic(CONFIG_FILE, JSON.stringify(next, null, 2));
  configCache = next;
  return next;
}

/**
 * API Key 单独一个文件，方便在 vault 被分享时单独排除。
 * 对话和 embedding 两个 Key 放同一个文件里——它们是同一类东西（凭据），
 * 分成两个文件只会让人漏备份其中之一。
 */
export interface AppSecrets {
  apiKey: string;
  embedApiKey: string;
  /** 飞书自建应用的 app_secret（和 app_id 配对，用于换 tenant_access_token） */
  feishuAppSecret: string;
  /** 具名接口的 Key：名字与 config.ai.profiles 的键一一对应 */
  profileKeys?: Record<string, string>;
  /**
   * 联网搜索（web_search）的 Key。**刻意可选**：默认缺省时回退到 embedApiKey——
   * 因为实测本机的向量接口与搜索后端同属一个百炼账号，复用它零配置即可用；
   * 但两者语义不同（一个管向量、一个管检索），所以留一个独立槽位，
   * 谁能给搜索单独发一把 Key 就填这里，互不影响。
   */
  searchApiKey?: string;
  /**
   * MinerU（云文档解析）的 API token，免费申请：mineru.net/user-center/api-token。
   * **刻意可选**：未配置时 /upload 的 PDF 分支维持本地 pdfjs 管线（行为不变），
   * agent 的 save_web_file 只能存网页/md/txt、存 PDF 时返回配置指引。
   * 配了它 = 全库 PDF 解析切到 MinerU（公式/表格/扫描件质量更好）。
   */
  mineruToken?: string;
}

export async function readSecret(): Promise<AppSecrets> {
  return readJson<AppSecrets>(SECRETS_FILE, { apiKey: '', embedApiKey: '', feishuAppSecret: '' });
}

/** 只改传进来的字段，没传的保持原值（清空 Key 请显式传空串）。 */
export async function writeSecret(patch: Partial<AppSecrets>): Promise<AppSecrets> {
  const cur = await readSecret();
  const next: AppSecrets = {
    apiKey: patch.apiKey ?? cur.apiKey,
    embedApiKey: patch.embedApiKey ?? cur.embedApiKey,
    feishuAppSecret: patch.feishuAppSecret ?? cur.feishuAppSecret,
    profileKeys: { ...(cur.profileKeys ?? {}), ...(patch.profileKeys ?? {}) },
    ...(patch.searchApiKey !== undefined || cur.searchApiKey !== undefined
      ? { searchApiKey: patch.searchApiKey ?? cur.searchApiKey }
      : {}),
    ...(patch.mineruToken !== undefined || cur.mineruToken !== undefined
      ? { mineruToken: patch.mineruToken ?? cur.mineruToken }
      : {}),
  };
  ensureDirSync(LOCAL_DIR);
  await writeFileAtomic(SECRETS_FILE, JSON.stringify(next, null, 2));
  return next;
}

export async function getVaultRoot(): Promise<string | null> {
  const cfg = await readConfig();
  return cfg.vaultRoot;
}

export async function requireVaultRoot(): Promise<string> {
  const root = await getVaultRoot();
  if (!root) {
    throw new ApiError(409, '还没有选择笔记库，请先设置笔记库目录', 'vault_not_configured');
  }
  return root;
}

/** 把 vault 内的绝对路径转成相对路径（统一用 / 分隔，存进 sidecar 和 API）。 */
export function toRel(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join('/');
}

/** 相对路径 → 绝对路径（不做安全校验，调用方需自行保证）。 */
export function toAbs(root: string, rel: string): string {
  return path.resolve(root, ...rel.split('/'));
}
