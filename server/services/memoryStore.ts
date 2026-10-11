/**
 * server/services/memoryStore.ts —— 记忆层 v2：条目化长期记忆（2026-09-23）。
 *
 * ★ 与 M3（agentMemory.ts sessions/*.json）的分工 ★
 *   M3 = 情景层（episodic）：每轮发生了什么，ADD-only，只追加不更新。
 *   本文件 = 语义层（semantic）：跨会话稳定的偏好/习惯/事实，条目化、可更新、强制溯源。
 *
 * ★ 主流对齐（Mem0 / Letta / LangMem 的共同内核）★
 *   - 记忆 = 结构化条目，不是自由 markdown：{id, kind, content, source, status, timestamps}。
 *   - 更新走显式操作：add / update（原条改写）/ supersede（新条取代旧条，旧条 status 留痕）/
 *     revoke（作废）。任何操作都不删历史——和 M3 同一条 ADD-only 纪律。
 *   - 溯源强制：她的原话（her-words）必须带 quote（M3 已存全量，随时回查核对，残句根治）；
 *     推断必须标 inferred。她随时抽查时可逐条对账。
 *   - 常驻注入（Letta core blocks 思路）：memoryBrief() 把活跃条目目录注入每轮 context，
 *     不再凭 agent 自觉去读文件。
 *
 * ★ 位置纪律：memory.json 在 `.assistant/agent/` 下 = agent 自己的授权写区，
 *   与她的笔记、.notebook、learning.json（M2）彻底隔离。
 */

import fs from 'node:fs/promises';
import { resolveInVault } from '../security';
import { makeId } from '../../shared/text';

export type MemoryKind = 'preference' | 'habit' | 'fact' | 'understanding';
export type MemoryStatus = 'active' | 'superseded' | 'revoked';
export type MemorySourceType = 'her-words' | 'inferred' | 'observed';

export interface MemorySource {
  type: MemorySourceType;
  /** 她的原话（type='her-words' 必填）。照录，禁止凭印象补全；查得到就先 read/recall_sessions 核对。 */
  quote?: string;
  /** 来源会话 id（M3 sessions），可据此回放当轮全文 */
  sessionId?: string;
  /** 迁移来源 / 取代链等说明 */
  origin?: string;
}

export interface MemoryEntry {
  id: string;
  kind: MemoryKind;
  content: string;
  source: MemorySource;
  status: MemoryStatus;
  createdAt: string;
  updatedAt: string;
  /** supersede 后指向新条目 */
  supersededBy?: string;
  /** revoke 的原因（可空） */
  revokedReason?: string;
}

export interface MemoryStore {
  version: 1;
  updatedAt: string;
  entries: MemoryEntry[];
}

const MEMORY_REL = '.assistant/agent/memory.json';

const now = (): string => new Date().toISOString();

async function memoryFile(): Promise<string> {
  return resolveInVault(MEMORY_REL);
}

export async function loadMemory(): Promise<MemoryStore> {
  try {
    const raw = JSON.parse(await fs.readFile(await memoryFile(), 'utf8')) as MemoryStore;
    if (!Array.isArray(raw.entries)) throw new Error('bad shape');
    return raw;
  } catch {
    /* 文件不存在/损坏：空库起步（不挡对话） */
    return { version: 1, updatedAt: now(), entries: [] };
  }
}

async function saveMemory(store: MemoryStore): Promise<void> {
  store.updatedAt = now();
  await fs.writeFile(await memoryFile(), JSON.stringify(store, null, 2), 'utf8');
}

function findEntry(store: MemoryStore, id: string): MemoryEntry {
  const e = store.entries.find((x) => x.id === id);
  if (!e) throw new Error(`记忆条目不存在: ${id}`);
  return e;
}

function assertEntryInput(kind: string, content: string, source: MemorySource): void {
  if (!content?.trim()) throw new Error('content 不能为空');
  if (content.length > 500) throw new Error('单条记忆超过 500 字符——一条只记一件事，长的拆条');
  if (!['preference', 'habit', 'fact', 'understanding'].includes(kind)) {
    throw new Error(`kind 必须是 preference/habit/fact/understanding，收到: ${kind}`);
  }
  if (source.type === 'her-words' && !source.quote?.trim()) {
    throw new Error('她说的话必须带 quote（原话照录）；记不全就去 recall_sessions 查，查不到就别标 her-words');
  }
}

/** 新增一条。重复主题靠她自己 supersede 旧的，这里不做语义去重（Mem0 的比对属于巩固管线，后置）。 */
export async function addMemory(input: {
  kind: MemoryKind;
  content: string;
  source: MemorySource;
}): Promise<MemoryEntry> {
  assertEntryInput(input.kind, input.content, input.source);
  const store = await loadMemory();
  const entry: MemoryEntry = {
    id: makeId('mem'),
    kind: input.kind,
    content: input.content.trim(),
    source: input.source,
    status: 'active',
    createdAt: now(),
    updatedAt: now(),
  };
  store.entries.push(entry);
  await saveMemory(store);
  return entry;
}

/** 原条改写（微调措辞/补细节）。大改用 supersede，保留决策链。 */
export async function updateMemory(id: string, content: string): Promise<MemoryEntry> {
  const store = await loadMemory();
  const e = findEntry(store, id);
  if (e.status !== 'active') throw new Error(`条目 ${id} 状态是 ${e.status}，只有 active 条目可 update`);
  if (!content?.trim() || content.length > 500) throw new Error('content 1~500 字符');
  e.content = content.trim();
  e.updatedAt = now();
  await saveMemory(store);
  return e;
}

/** 新条取代旧条：旧条 status=superseded 并指向新条，历史不删。她推翻旧认知时用这个。 */
export async function supersedeMemory(
  id: string,
  input: { kind?: MemoryKind; content: string; source?: MemorySource },
): Promise<MemoryEntry> {
  const store = await loadMemory();
  const old = findEntry(store, id);
  const kind = input.kind ?? old.kind;
  const source = input.source ?? { type: old.source.type, origin: `supersedes ${id}` };
  assertEntryInput(kind, input.content, source);
  const fresh: MemoryEntry = {
    id: makeId('mem'),
    kind,
    content: input.content.trim(),
    source,
    status: 'active',
    createdAt: now(),
    updatedAt: now(),
  };
  old.status = 'superseded';
  old.supersededBy = fresh.id;
  old.updatedAt = now();
  store.entries.push(fresh);
  await saveMemory(store);
  return fresh;
}

/** 作废（记错了/她否认）。status=revoked 留审计，不删。 */
export async function revokeMemory(id: string, reason?: string): Promise<MemoryEntry> {
  const store = await loadMemory();
  const e = findEntry(store, id);
  e.status = 'revoked';
  e.revokedReason = reason?.slice(0, 200) || undefined;
  e.updatedAt = now();
  await saveMemory(store);
  return e;
}

/** 活跃条目，最近更新优先。 */
export async function listActive(limit = 30): Promise<MemoryEntry[]> {
  const store = await loadMemory();
  return store.entries
    .filter((e) => e.status === 'active')
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .slice(0, limit);
}

/**
 * 注入用：活跃记忆目录（每条一行）。Letta core-blocks 的库内版——
 * 每轮至少保证 agent「见过目录」，要细节再 read memory.json 或调 remember(list)。
 */
export async function memoryBrief(limit = 15): Promise<string> {
  const entries = await listActive(limit);
  if (!entries.length) return '';
  const lines = entries.map((e) => {
    const src = e.source.type === 'her-words' ? '她说的' : e.source.type === 'observed' ? '观察到' : '我推断';
    return `- [${e.kind}/${src}] ${e.content}（${e.id}）`;
  });
  return ['长期记忆（活跃条目；括号里是 id，可用来 update/supersede/revoke）：', ...lines].join('\n');
}
