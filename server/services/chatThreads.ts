/**
 * server/services/chatThreads.ts —— 对话线程（会话层），2026-10-08。
 *
 * ★ 结构照搬 DSH 的会话模型，代码自己写 ★
 *   DSH（@deepseek-ai/dsh-api-session-controller）那套已经验证过，逐条对齐：
 *
 *   | DSH                              | 这里                                  |
 *   |----------------------------------|---------------------------------------|
 *   | durable address（稳定 id）        | `th-<yyyymmdd>-<8>`                   |
 *   | 事件流追加（dsh-session-jsonl）   | `<id>.jsonl`，只 append 不重写        |
 *   | workspaceId + cwd 归属            | `docRel`（文档即 workspace）          |
 *   | 首问 LLM 自动标题                 | `autoTitle()`，异步补，不阻塞首轮     |
 *   | fork（从某轮分叉）                | `forkThread()`                        |
 *   | list（有界冷摘要，不激活 agent）   | `listThreads()`                       |
 *   | page（冷读历史分页）              | `pageThread()`                        |
 *   | 清空 = 新建（不是删除）           | `createThread()`，旧的留在列表里      |
 *
 * ★ 为什么不直接 import DSH 的包 ★
 *   那是 200+ 个依赖，且它的存储不在她的库里。小笔必须是她自己的 agent
 *   （她的原话：「情感上和面试上我希望拥有自己的 agent」）——**照搬做法，不接管主链路**。
 *
 * ★ 事件流的取舍 ★
 *   元数据变更（改标题、归档）不回写旧行，而是**追加一条新的 meta 行**，
 *   读取时以最后一条为准。这样文件永远是 append-only：
 *   崩了不会写坏历史，也不需要「读全量→改→写全量」那种危险的读写循环。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR_NAME, requireVaultRoot } from '../core';
import { localDate } from '../../shared/text';
import { chat } from './aiClient';

/**
 * 会话 id 前缀用的日期。
 *
 * ★ 为什么不用 `new Date().toISOString().slice(0,10)` ★
 *   toISOString 是 UTC。本机 GMT+8，凌晨（0~8 点）开的会话会被算成**前一天**
 *   —— 冒烟时实测生成了 `th-20261007`（实际是 10-08 02:07 建的）。
 *   id 里带错日期不影响功能，但会让「按日期找会话」这种直觉失效。
 *   `localDate()` 就是为这个存在的（shared/text.ts 的注释也写了同一条）。
 */
function stampId(): string {
  return `th-${localDate().replace(/-/g, '')}-${shortId()}`;
}

/**
 * 8 位小写字母数字。
 *
 * ★ 为什么不用 shared/text 的 makeId ★
 *   它的签名是 `makeId(prefix)` —— 参数是**前缀不是长度**，传 8 会得到 `"8_xxx"`，
 *   而且带下划线，过不了下面 `SAFE_ID` 的 `[a-z0-9]`（id 要进文件名，字符集必须窄）。
 */
function shortId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.slice(-8).toLowerCase();
}

// ─────────────────────────── 类型 ───────────────────────────

/** 线程元数据（列表里看到的东西；DSH 叫「有界冷摘要」）。 */
export interface ThreadMeta {
  id: string;
  /** 归属文档（= DSH 的 workspaceId/cwd）。空 = 全局会话，不属于任何一篇。 */
  docRel?: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** 归档 = 从默认列表消失，但文件还在（后台不清）。 */
  archived: boolean;
  turnCount: number;
}

/** 一轮对话。 */
export interface ThreadTurn {
  at: string;
  role: 'user' | 'assistant';
  content: string;
  /**
   * 指向 agentMemory 里那一次 run 的审计记录（tools/steps/usage 在那边）。
   * 会话层只存「她说了什么、小笔答了什么」，不重复存轨迹。
   */
  sessionId?: string;
  stop?: string;
  usage?: { promptTokens?: number; completionTokens?: number };
  steps?: { kind: string; label: string; ms: number; failed?: boolean }[];
}

/** JSONL 里的事件：meta 可出现多次（后写的为准），turn 追加。 */
type ThreadEvent =
  | ({ t: 'meta' } & ThreadMeta)
  | ({ t: 'turn' } & ThreadTurn);

export interface ThreadDetail {
  meta: ThreadMeta;
  turns: ThreadTurn[];
}

// ─────────────────────────── 存储 ───────────────────────────

const threadsDir = async (): Promise<string> => {
  const root = await requireVaultRoot();
  const dir = path.join(root, DATA_DIR_NAME, 'agent', 'threads');
  await fs.mkdir(dir, { recursive: true });
  return dir;
};

const fileOf = async (id: string): Promise<string> => path.join(await threadsDir(), `${id}.jsonl`);

/** id 只认这个形状——拼路径前先卡死，避免任何形式的路径穿越。 */
const SAFE_ID = /^th-\d{8}-[a-z0-9]{4,16}$/;

function assertId(id: string): void {
  if (!SAFE_ID.test(id)) throw new Error(`会话 id 不合法：${id}`);
}

/** 读一个线程的全部事件（小文件，一个人的库不会有 MB 级会话）。 */
async function readEvents(id: string): Promise<ThreadEvent[]> {
  assertId(id);
  let raw: string;
  try {
    raw = await fs.readFile(await fileOf(id), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const out: ThreadEvent[] = [];
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s) as ThreadEvent);
    } catch {
      // 坏行跳过（追加写崩过一行不该让整条会话读不出来）
    }
  }
  return out;
}

/** 追加一行。追加是原子的，不需要读-改-写。 */
async function appendEvent(id: string, ev: ThreadEvent): Promise<void> {
  assertId(id);
  await fs.appendFile(await fileOf(id), `${JSON.stringify(ev)}\n`, 'utf8');
}

/** 折叠事件流：最后一条 meta 为准 + 按顺序的 turn 列表。 */
function fold(events: ThreadEvent[]): ThreadDetail | null {
  let meta: ThreadMeta | undefined;
  const turns: ThreadTurn[] = [];
  for (const ev of events) {
    if (ev.t === 'meta') {
      const { t: _t, ...rest } = ev;
      meta = rest as ThreadMeta;
    } else {
      const { t: _t, ...rest } = ev;
      turns.push(rest as ThreadTurn);
    }
  }
  if (!meta) return null;
  return { meta: { ...meta, turnCount: turns.length }, turns };
}

// ─────────────────────────── 对外 API ───────────────────────────

/**
 * 新建线程（DSH 的 `create`）。
 *
 * ★ 她的预期「可以新建、可以清空，但后台不清」在 DSH 里的落地就是这一条：
 *   **「清空」= 新建一条**，旧的还在列表里。所以这里不提供「清空历史」这种
 *   会毁数据的操作——要翻回去，从列表点就行。
 */
export async function createThread(docRel?: string): Promise<ThreadMeta> {
  const now = new Date().toISOString();
  const id = stampId();
  const meta: ThreadMeta = {
    id,
    ...(docRel ? { docRel } : {}),
    title: '新对话',
    createdAt: now,
    updatedAt: now,
    archived: false,
    turnCount: 0,
  };
  await appendEvent(id, { t: 'meta', ...meta });
  return meta;
}

/** 列表（DSH 的 `list`）：只读 meta，不加载 turns，不激活 agent。 */
export async function listThreads(opts: { docRel?: string; scope?: 'doc' | 'all'; limit?: number; includeArchived?: boolean } = {}): Promise<ThreadMeta[]> {
  const { docRel, scope = 'doc', limit = 40, includeArchived = false } = opts;
  const dir = await threadsDir();
  const names = (await fs.readdir(dir)).filter((n) => n.endsWith('.jsonl'));
  const out: ThreadMeta[] = [];
  for (const n of names) {
    const id = n.replace(/\.jsonl$/, '');
    if (!SAFE_ID.test(id)) continue;
    const d = fold(await readEvents(id));
    if (!d) continue;
    if (!includeArchived && d.meta.archived) continue;
    // scope='doc'：只给「属于这篇文档的」+「全局的」（全局会话在哪篇都能接着聊）
    if (scope === 'doc' && docRel && d.meta.docRel && d.meta.docRel !== docRel) continue;
    out.push(d.meta);
  }
  out.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return out.slice(0, limit);
}

/** 读整条（含 turns）。前端打开一条会话时用。 */
export async function readThread(id: string): Promise<ThreadDetail | null> {
  return fold(await readEvents(id));
}

/**
 * 冷读一页（DSH 的 `page`）：不激活 agent，只按游标取历史。
 * 消息很多时前端靠它分屏加载。
 */
export async function pageThread(req: { id: string; from?: number; limit?: number }): Promise<{ turns: ThreadTurn[]; next: number | null; total: number }> {
  const d = await readThread(req.id);
  if (!d) return { turns: [], next: null, total: 0 };
  const from = Math.max(0, req.from ?? 0);
  const limit = Math.min(Math.max(req.limit ?? 50, 1), 500);
  const slice = d.turns.slice(from, from + limit);
  const next = from + slice.length < d.turns.length ? from + slice.length : null;
  return { turns: slice, next, total: d.turns.length };
}

/** 追加一轮（用户问 或 小笔答）。会顺带把 meta 的 updatedAt/turnCount 推进。 */
export async function appendTurn(id: string, turn: Omit<ThreadTurn, 'at'>): Promise<ThreadMeta> {
  assertId(id);
  const now = new Date().toISOString();
  await appendEvent(id, { t: 'turn', at: now, ...turn });
  const d = await readThread(id);
  if (!d) throw new Error(`会话不存在：${id}`);
  const meta: ThreadMeta = { ...d.meta, updatedAt: now, turnCount: d.turns.length };
  await appendEvent(id, { t: 'meta', ...meta });
  return meta;
}

/** 改名（DSH 的 `rename`）。 */
export async function renameThread(id: string, title: string): Promise<ThreadMeta> {
  const d = await readThread(id);
  if (!d) throw new Error(`会话不存在：${id}`);
  const meta: ThreadMeta = { ...d.meta, title: title.trim().slice(0, 60) || d.meta.title, updatedAt: new Date().toISOString() };
  await appendEvent(id, { t: 'meta', ...meta });
  return meta;
}

/** 归档 / 取消归档：从默认列表消失，文件和内容都还在。 */
export async function setArchived(id: string, archived: boolean): Promise<ThreadMeta> {
  const d = await readThread(id);
  if (!d) throw new Error(`会话不存在：${id}`);
  const meta: ThreadMeta = { ...d.meta, archived, updatedAt: new Date().toISOString() };
  await appendEvent(id, { t: 'meta', ...meta });
  return meta;
}

/**
 * 分叉（DSH 的 `fork`）：从第 `upto` 轮（不含）之后截断，开一条新线程。
 * 原线程**不动**——这也是「后台不清」的一部分：试错不毁历史。
 */
export async function forkThread(id: string, upto: number): Promise<ThreadMeta> {
  const src = await readThread(id);
  if (!src) throw new Error(`会话不存在：${id}`);
  const now = new Date().toISOString();
  const newId = stampId();
  const meta: ThreadMeta = {
    id: newId,
    ...(src.meta.docRel ? { docRel: src.meta.docRel } : {}),
    title: `${src.meta.title}（分叉）`,
    createdAt: now,
    updatedAt: now,
    archived: false,
    turnCount: 0,
  };
  await appendEvent(newId, { t: 'meta', ...meta });
  for (const t of src.turns.slice(0, Math.max(0, upto))) {
    await appendEvent(newId, { t: 'turn', ...t });
  }
  const final: ThreadMeta = { ...meta, turnCount: src.turns.slice(0, Math.max(0, upto)).length };
  await appendEvent(newId, { t: 'meta', ...final });
  return final;
}

/**
 * 首问 → 标题（对标 DSH 的 `dsh-session-title-first-prompt-llm`）。
 *
 * ★ 为什么单独做 ★
 *   一旦有会话列表，标题就是她第一眼看到的东西，截断的「帮我看看第3章…」
 *   没法用（这是 DSH 专门分包做这件事的原因）。
 *
 * ★ 为什么不阻塞 ★
 *   首轮已经在跑几十秒了，再等一次模型调用体感很差。**失败就回退本地截断**，
 *   标题质量是体验问题不是正确性问题，不值得让它拖慢或报错。
 */
export async function autoTitle(id: string, firstQuestion: string): Promise<string> {
  const fallback = firstQuestion.replace(/\s+/g, ' ').trim().slice(0, 24) || '新对话';
  try {
    const raw = await chat(
      [
        {
          role: 'user',
          content: `给下面这句提问起一个 6~14 字的中文标题，只输出标题本身，不要引号、不要标点结尾、不要解释。\n\n提问：${firstQuestion.slice(0, 400)}`,
        },
      ],
      // 标题是体验不是正确性：15s 拿不到就用截断，绝不拖慢她
      { maxTokens: 64, temperature: 0.3, timeoutMs: 15_000 },
    );
    const t = raw.replace(/^["'「」《》\s]+|["'「」《》\s。！？]+$/g, '').trim().slice(0, 40);
    if (!t) return fallback;
    await renameThread(id, t);
    return t;
  } catch {
    // 模型不可用/超时：用截断，不抛
    await renameThread(id, fallback).catch(() => undefined);
    return fallback;
  }
}
