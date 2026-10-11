/**
 * server/services/assetRegistry.ts —— 生成资产的统一账本（2026-10-10 V2 树重构配套）。
 *
 * ★ 三原则（docs/生成资产统一管理-方案.md，多鱼 10-10 拍板）★
 *   1. 账本不搬家：树/卡/题等资产本体留在各自存储位（sec.tree、quizzes…），
 *      这里只登记「谁、什么时候、用什么生成的、替换了谁、现在什么状态」。
 *   2. 派生 vs 事实源分离：registry 是**事实源**（append-only，不重算），
 *      concepts.json 那种派生索引的教训不能重犯。
 *   3. 可独立用也可被 agent 用：draft 不进 agent 可见范围（agent 只读 active）。
 *
 * ★ append-only 的含义 ★
 *   永远只追加行，不改旧行。一个 aid 的最新状态 = 该 aid 最后出现的那一行
 *   （所以「转 active」= 追加一行同 aid 不同 status，而不是改旧行）。
 *   好处：完整审计轨迹（谁在什么时候改过状态），坏处只有文件变长——可接受。
 *
 * ★ replaces 版本链 ★
 *   重生成**不覆盖**旧资产本体：旧树序列化存 archive/{aid}.json，
 *   新登记行的 replaces 指向旧 aid。想对比新旧，顺着链拉回来即可。
 *   这是「AB 对照」从离线探针延伸到生产的基础。
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DATA_DIR_NAME, requireVaultRoot } from '../core';

// ─────────────────────────── 数据契约 ───────────────────────────

/** 资产种类。第一刀只接 tree，其余枚举先占位（导入时用得上）。 */
export const ASSET_KINDS = ['tree', 'example', 'quiz', 'flashcard', 'concept-map'] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

/** draft = 判据不过线，不进 agent 可见范围；active = 现役；retired = 被替换/废弃（不删，回收站哲学）。 */
export const ASSET_STATUS = ['draft', 'active', 'retired'] as const;
export type AssetStatus = (typeof ASSET_STATUS)[number];

export interface AssetRow {
  /** 资产登记号，形如 as-tree-<docSlug>-<headingId>-<6位hash> */
  aid: string;
  kind: AssetKind;
  status: AssetStatus;
  source: { type: 'textbook' | 'model' | 'human'; ref?: string };
  origin: { doc: string; headingId?: string; headingText?: string };
  generator: { tool: string; promptVer: string | null; recordedAt: string };
  /** 被本条替换的上一代 aid；null = 首代 */
  replaces: string | null;
  /** 被替换的上一代本体的存档路径（相对 vault），拉回对比用 */
  archive?: string;
  note?: string | null;
}

// ─────────────────────────── 路径 ───────────────────────────

const REG_REL = ['assets', 'registry.jsonl'];

export function registryAbsPath(root: string): string {
  return path.join(root, DATA_DIR_NAME, ...REG_REL);
}

export function archiveAbsPath(root: string, aid: string): string {
  return path.join(root, DATA_DIR_NAME, 'assets', 'archive', `${aid}.json`);
}

/** 存档路径的 vault 相对形式（落进 AssetRow.archive，可移植） */
function archiveRelPath(aid: string): string {
  return ['.notebook', 'assets', 'archive', `${aid}.json`].join('/');
}

// ─────────────────────────── aid ───────────────────────────

/** 文档路径转 slug：保留中文与字母数字，其余折线 */
function docSlug(docRel: string): string {
  return (
    docRel
      .replace(/\.[^.]+$/, '')
      .replace(/[^\w一-龥]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'doc'
  );
}

/** 短 hash：同一文档同一节多次生成时区分代次 */
function shortHash(s: string, len = 6): string {
  return createHash('sha256').update(s).digest('hex').slice(0, len);
}

export function makeAid(kind: AssetKind, docRel: string, headingId: string, salt: string): string {
  return `as-${kind}-${docSlug(docRel)}-${headingId || 'root'}-${shortHash(salt)}`;
}

// ─────────────────────────── 读写 ───────────────────────────

function parseRow(line: string): AssetRow | null {
  try {
    const o = JSON.parse(line) as Partial<AssetRow>;
    if (!o || typeof o !== 'object') return null;
    if (!o.aid || typeof o.aid !== 'string') return null;
    if (!o.kind || !(ASSET_KINDS as readonly string[]).includes(o.kind)) return null;
    if (!o.status || !(ASSET_STATUS as readonly string[]).includes(o.status)) return null;
    return {
      aid: o.aid,
      kind: o.kind,
      status: o.status,
      source: { type: o.source?.type === 'human' ? 'human' : o.source?.type === 'textbook' ? 'textbook' : 'model', ref: o.source?.ref },
      origin: { doc: String(o.origin?.doc ?? ''), headingId: o.origin?.headingId, headingText: o.origin?.headingText },
      generator: {
        tool: String(o.generator?.tool ?? ''),
        promptVer: o.generator?.promptVer ?? null,
        recordedAt: String(o.generator?.recordedAt ?? ''),
      },
      replaces: typeof o.replaces === 'string' ? o.replaces : null,
      archive: typeof o.archive === 'string' ? o.archive : undefined,
      note: typeof o.note === 'string' ? o.note : null,
    };
  } catch {
    return null;
  }
}

/** 读全部行（按文件顺序）。文件不存在 = 空表；坏行跳过 + 警告（sidecar 同哲学）。 */
export async function readRegistry(root: string): Promise<{ rows: AssetRow[]; badLines: number }> {
  let raw: string;
  try {
    raw = await fsp.readFile(registryAbsPath(root), 'utf8');
  } catch {
    return { rows: [], badLines: 0 };
  }
  const rows: AssetRow[] = [];
  let badLines = 0;
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const row = parseRow(t);
    if (row) rows.push(row);
    else badLines++;
  }
  return { rows, badLines };
}

/** 追加一行。目录不存在自动建。 */
export async function appendAsset(row: AssetRow, root?: string): Promise<void> {
  const r = root ?? (await requireVaultRoot());
  const file = registryAbsPath(r);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.appendFile(file, `${JSON.stringify(row)}\n`, 'utf8');
}

export interface AssetFilter {
  kind?: AssetKind;
  status?: AssetStatus;
  doc?: string;
  headingId?: string;
}

/**
 * 按 filter 列出「每个 aid 的最新状态行」。
 * 读语义：append-only 表里同一 aid 多行时，取**最后一行**为当前状态。
 */
export async function listAssets(f: AssetFilter = {}, root?: string): Promise<AssetRow[]> {
  const r = root ?? (await requireVaultRoot());
  const { rows } = await readRegistry(r);
  const latest = new Map<string, AssetRow>();
  for (const row of rows) latest.set(row.aid, row);
  return [...latest.values()].filter((row) => {
    if (f.kind && row.kind !== f.kind) return false;
    if (f.status && row.status !== f.status) return false;
    if (f.doc && row.origin.doc !== f.doc) return false;
    if (f.headingId && row.origin.headingId !== f.headingId) return false;
    return true;
  });
}

/** 某文档某节当前 active 的资产（agent 只读 active 的依据）。 */
export async function latestActive(
  docRel: string,
  headingId: string,
  kind: AssetKind = 'tree',
  root?: string,
): Promise<AssetRow | null> {
  const rows = await listAssets({ kind, status: 'active', doc: docRel, headingId }, root);
  return rows[rows.length - 1] ?? null;
}

// ─────────────────────────── 存档 ───────────────────────────

/** 把被替换的资产本体序列化存档，返回 vault 相对路径。 */
export async function archiveAsset(aid: string, body: unknown, root?: string): Promise<string> {
  const r = root ?? (await requireVaultRoot());
  const file = archiveAbsPath(r, aid);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(body, null, 2), 'utf8');
  return archiveRelPath(aid);
}

/** 拉回一份存档（AB 对比用）。 */
export async function readArchive<T = unknown>(aid: string, root?: string): Promise<T | null> {
  const r = root ?? (await requireVaultRoot());
  try {
    return JSON.parse(await fsp.readFile(archiveAbsPath(r, aid), 'utf8')) as T;
  } catch {
    return null;
  }
}
