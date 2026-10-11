/**
 * server/services/sidecar.ts —— 结构化数据的读写（批注 / 高亮 / 小抄 / 题目 / 闪卡）。
 *
 * 为什么每篇文章一个 JSON 文件、而不是一个全局大 JSON：
 *   - 单文件损坏不扩散；
 *   - 用户移动 / 重命名文章时只需要搬一个文件；
 *   - 一次请求就能拿到该文章的全部结构化数据；
 *   - 用单文件串行队列就能解决并发，不需要事务。
 *
 * 并发的处理方式：同一篇文章的所有写操作排在同一条 Promise 链上，
 * 每个写操作在链内**重新读盘再合并**，所以不会丢更新。
 * 覆盖前留 .bak，读坏了还能捞回来。
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Dirent } from 'node:fs';
import {
  DATA_DIR_NAME,
  bad,
  backupBeforeWrite,
  ensureDirSync,
  exists,
  readJson,
  requireVaultRoot,
  writeFileAtomic,
} from '../core';
import { assertSafeRel } from '../security';
import { SIDECAR_VERSION, type Sidecar } from '../../shared/text';

export function notebookDir(root: string): string {
  return path.join(root, DATA_DIR_NAME);
}

export function sidecarAbsPath(root: string, docRel: string): string {
  assertSafeRel(docRel);
  return path.join(root, DATA_DIR_NAME, 'doc', ...docRel.split('/')) + '.json';
}

/** 对应目录的 sidecar 目录（目录下每篇文章各有一个 .json）。 */
export function sidecarDirAbsPath(root: string, dirRel: string): string {
  if (!dirRel) return path.join(root, DATA_DIR_NAME, 'doc');
  assertSafeRel(dirRel);
  return path.join(root, DATA_DIR_NAME, 'doc', ...dirRel.split('/'));
}

/** 首次使用时把 .notebook 的骨架建起来。 */
export async function ensureNotebook(root: string): Promise<void> {
  const nb = notebookDir(root);
  ensureDirSync(path.join(nb, 'doc'));
  ensureDirSync(path.join(nb, 'index'));
  ensureDirSync(path.join(nb, 'trash'));
  const gi = path.join(nb, '.gitignore');
  if (!(await exists(gi))) {
    // 万一用户把整个笔记库推到公开仓库，API Key 和批注不会跟着泄露
    await fsp.writeFile(gi, '*\n', 'utf8');
  }
}

export function emptySidecar(docRel: string): Sidecar {
  return {
    version: SIDECAR_VERSION,
    docPath: docRel,
    docHash: '',
    indexedAt: new Date().toISOString(),
    chapters: [],
    units: [],
    highlights: [],
    notes: [],
    cheatsheet: { sections: [] },
    quizzes: [],
    cards: [],
  };
}

/** 把可能缺字段的旧数据补全，避免升级后到处判空。 */
export function normalizeSidecar(raw: unknown, docRel: string): Sidecar {
  const base = emptySidecar(docRel);
  if (!raw || typeof raw !== 'object') return base;
  const r = raw as Partial<Sidecar>;
  return {
    version: typeof r.version === 'number' ? r.version : SIDECAR_VERSION,
    docPath: typeof r.docPath === 'string' && r.docPath ? r.docPath : docRel,
    docHash: typeof r.docHash === 'string' ? r.docHash : '',
    indexedAt: typeof r.indexedAt === 'string' ? r.indexedAt : base.indexedAt,
    chapters: Array.isArray(r.chapters) ? r.chapters : [],
    units: Array.isArray(r.units) ? r.units : [],
    highlights: Array.isArray(r.highlights) ? r.highlights : [],
    notes: Array.isArray(r.notes) ? r.notes : [],
    cheatsheet:
      r.cheatsheet && Array.isArray(r.cheatsheet.sections)
        ? { sections: r.cheatsheet.sections }
        : { sections: [] },
    quizzes: Array.isArray(r.quizzes) ? r.quizzes : [],
    cards: Array.isArray(r.cards) ? r.cards : [],
  };
}

// ─────────────────────── 串行写队列 ───────────────────────

const writeQueues = new Map<string, Promise<unknown>>();

function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prev = writeQueues.get(key) ?? Promise.resolve();
  const next = prev.then(task, task);
  // 队列尾部只保留一个「占位 promise」，避免内存无限增长
  writeQueues.set(
    key,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

/** 等待该文章的写队列排空（读之前调用，避免读到写了一半的状态）。 */
export async function drainSidecarQueue(docRel: string): Promise<void> {
  await (writeQueues.get(docRel) ?? Promise.resolve());
}

export async function readSidecar(docRel: string): Promise<Sidecar> {
  assertSafeRel(docRel);
  await drainSidecarQueue(docRel);
  const root = await requireVaultRoot();
  const abs = sidecarAbsPath(root, docRel);

  const raw = await readJson<unknown>(abs, null);
  if (raw === null) {
    // 主文件读不出来，尝试从 .bak 恢复（只恢复、不覆盖，交给用户决定下一步）
    const bak = await readJson<unknown>(`${abs}.bak`, null);
    if (bak !== null) return normalizeSidecar(bak, docRel);
    return emptySidecar(docRel);
  }
  return normalizeSidecar(raw, docRel);
}

export async function writeSidecar(docRel: string, data: Sidecar): Promise<void> {
  assertSafeRel(docRel);
  const root = await requireVaultRoot();
  const abs = sidecarAbsPath(root, docRel);
  await backupBeforeWrite(abs);
  await writeFileAtomic(abs, JSON.stringify(data, null, 2));
}

/**
 * 读-改-写，整个过程在串行队列内完成。
 * 这是唯一推荐的修改 sidecar 的方式：并发调用不会互相覆盖。
 */
export function updateSidecar<T>(
  docRel: string,
  fn: (s: Sidecar) => T | Promise<T>,
): Promise<T> {
  assertSafeRel(docRel);
  return enqueue(docRel, async () => {
    const root = await requireVaultRoot();
    const abs = sidecarAbsPath(root, docRel);
    const raw = await readJson<unknown>(abs, null);
    const cur = raw === null ? emptySidecar(docRel) : normalizeSidecar(raw, docRel);
    const result = await fn(cur);
    cur.version = SIDECAR_VERSION;
    cur.docPath = docRel;
    await backupBeforeWrite(abs);
    await writeFileAtomic(abs, JSON.stringify(cur, null, 2));
    return result;
  });
}

/**
 * 文章 / 目录被重命名或移动时，sidecar 跟着走。
 * @param isDir true 表示 fromRel 是目录，整棵 sidecar 子树一起搬
 */
export async function relocateSidecar(fromRel: string, toRel: string, isDir: boolean): Promise<void> {
  assertSafeRel(fromRel);
  assertSafeRel(toRel);
  const root = await requireVaultRoot();
  const fromAbs = isDir ? sidecarDirAbsPath(root, fromRel) : sidecarAbsPath(root, fromRel);
  const toAbs = isDir ? sidecarDirAbsPath(root, toRel) : sidecarAbsPath(root, toRel);

  if (!(await exists(fromAbs))) return;

  await fsp.mkdir(path.dirname(toAbs), { recursive: true });
  await fsp.rename(fromAbs, toAbs);
  await fsp.rm(`${fromAbs}.bak`, { force: true }).catch(() => undefined);

  if (isDir) {
    // 子树内部每个文件里的 docPath 也要跟着改，否则从回收站恢复时会错位
    const base = path.join(root, DATA_DIR_NAME, 'doc');
    const walk = async (dir: string): Promise<void> => {
      const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) {
          await walk(abs);
        } else if (e.isFile() && e.name.endsWith('.json')) {
          const relFromDoc = path.relative(base, abs).split(path.sep).join('/');
          const docRel = relFromDoc.slice(0, -'.json'.length);
          try {
            const raw = await readJson<unknown>(abs, null);
            if (raw) {
              const data = normalizeSidecar(raw, docRel);
              data.docPath = docRel;
              await writeFileAtomic(abs, JSON.stringify(data, null, 2));
            }
          } catch {
            /* 单个文件坏掉不阻塞整体迁移 */
          }
        }
      }
    };
    await walk(toAbs);
    return;
  }

  const data = await readSidecar(toRel);
  data.docPath = toRel;
  await writeSidecar(toRel, data);
}

/** 文章 / 目录被删除时，对应的 sidecar 跟着进回收站。 */
export async function trashSidecarTree(root: string, rel: string, isDir: boolean, stamp: string): Promise<void> {
  const fromAbs = isDir ? sidecarDirAbsPath(root, rel) : sidecarAbsPath(root, rel);
  if (!(await exists(fromAbs))) return;
  const destBase = path.join(root, DATA_DIR_NAME, 'trash', stamp, 'sidecar');
  const dest = isDir ? path.join(destBase, ...rel.split('/')) : path.join(destBase, ...rel.split('/')) + '.json';
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.rename(fromAbs, dest);
  await fsp.rm(`${fromAbs}.bak`, { force: true }).catch(() => undefined);
}

/** 遍历整个 vault 下所有 sidecar，用于全局复习队列 / 统计 / 全库重锚。 */
export async function listAllSidecars(): Promise<{ docRel: string; sidecar: Sidecar }[]> {
  const root = await requireVaultRoot();
  const base = path.join(root, DATA_DIR_NAME, 'doc');
  const out: { docRel: string; sidecar: Sidecar }[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(abs);
      } else if (e.isFile() && e.name.endsWith('.json')) {
        const relFromDoc = path.relative(base, abs).split(path.sep).join('/');
        const docRel = relFromDoc.slice(0, -'.json'.length);
        try {
          const raw = await readJson<unknown>(abs, null);
          if (raw) out.push({ docRel, sidecar: normalizeSidecar(raw, docRel) });
        } catch {
          /* 单个文件坏掉不影响整体 */
        }
      }
    }
  }
  await walk(base);
  return out;
}

/** 追加复盘日志（复习事件流，用于统计与撤销）。 */
export async function appendReviewLog(entry: Record<string, unknown>): Promise<void> {
  const root = await requireVaultRoot();
  const abs = path.join(root, DATA_DIR_NAME, 'review-log.jsonl');
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.appendFile(abs, JSON.stringify(entry) + '\n', 'utf8');
}

export async function readReviewLog(limit = 200): Promise<Record<string, unknown>[]> {
  const root = await requireVaultRoot();
  const abs = path.join(root, DATA_DIR_NAME, 'review-log.jsonl');
  try {
    const raw = await fsp.readFile(abs, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    return lines.slice(-limit).map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
}

/** 把 sidecar 相对路径反解成 doc 相对路径。 */
export function docRelFromSidecarRel(sidecarRel: string): string {
  if (!sidecarRel.endsWith('.json')) throw bad('非法 sidecar 路径', 'bad_path');
  return sidecarRel.slice(0, -'.json'.length).split(path.sep).join('/');
}
