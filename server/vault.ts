/**
 * server/vault.ts —— 笔记库的目录树扫描与文件增删改。
 *
 * vault 就是用户自己的 Markdown 文件夹。我们只读写 .md/.markdown/.txt，
 * 隐藏项（. 开头）和 node_modules 一律跳过，所以 .notebook 不会被扫进目录树。
 *
 * 所有删除都是「移进 .notebook/trash/<时间戳>/」，不真删。
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Dirent, Stats } from 'node:fs';
import {
  ApiError,
  bad,
  conflict,
  exists,
  normalizeFsError,
  requireVaultRoot,
  sha256,
  toAbs,
  writeFileAtomic,
} from './core';
import { assertAllowedExt, resolveInVault } from './security';
import { relocateSidecar, trashSidecarTree } from './services/sidecar';

export interface TreeNode {
  type: 'dir' | 'doc';
  /** 显示名：目录用目录名，文档去掉扩展名 */
  name: string;
  /** vault 相对路径，统一 / 分隔 */
  relPath: string;
  mtime: number;
  size: number;
  children?: TreeNode[];
}

const DOC_EXT = new Set(['.md', '.markdown', '.txt']);
const SKIP_DIR = new Set(['node_modules', '.git', '.svn', '.obsidian', '.trash', 'dist']);

const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });

// ─────────────────────────── 目录树 ───────────────────────────

export async function scanTree(): Promise<TreeNode> {
  const root = await requireVaultRoot();

  async function walk(absDir: string, relDir: string): Promise<TreeNode[]> {
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(absDir, { withFileTypes: true });
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') return [];
      throw normalizeFsError(e, '读取目录');
    }

    const dirs: TreeNode[] = [];
    const docs: TreeNode[] = [];

    for (const e of entries) {
      if (e.name.startsWith('.') || SKIP_DIR.has(e.name)) continue;
      const abs = path.join(absDir, e.name);
      const rel = relDir ? `${relDir}/${e.name}` : e.name;

      if (e.isDirectory()) {
        dirs.push({ type: 'dir', name: e.name, relPath: rel, mtime: 0, size: 0, children: await walk(abs, rel) });
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        if (!DOC_EXT.has(ext)) continue;
        let st: Stats;
        try {
          st = await fsp.stat(abs);
        } catch {
          continue;
        }
        docs.push({
          type: 'doc',
          name: e.name.slice(0, e.name.length - ext.length),
          relPath: rel,
          mtime: st.mtimeMs,
          size: st.size,
        });
      }
    }

    dirs.sort((a, b) => collator.compare(a.name, b.name));
    docs.sort((a, b) => collator.compare(a.name, b.name));
    return [...dirs, ...docs];
  }

  const children = await walk(root, '');
  return { type: 'dir', name: path.basename(root) || 'notes', relPath: '', mtime: 0, size: 0, children };
}

// ─────────────────────────── 文章读写 ───────────────────────────

export interface DocPayload {
  path: string;
  markdown: string;
  /** 磁盘内容的 sha256，用于乐观锁 */
  docHash: string;
}

export async function readDoc(rel: string): Promise<DocPayload> {
  const abs = await resolveInVault(rel);
  assertAllowedExt(abs);
  let markdown: string;
  try {
    markdown = await fsp.readFile(abs, 'utf8');
  } catch (e) {
    throw normalizeFsError(e, '读取文章');
  }
  // 去掉 BOM，否则第一个块会多一个看不见的字符，锚点会整体漂一位
  if (markdown.charCodeAt(0) === 0xfeff) markdown = markdown.slice(1);
  return { path: rel, markdown, docHash: sha256(markdown) };
}

/**
 * 保存文章。
 *
 * 乐观锁：磁盘上的内容已经不是前端读到的那个版本（Obsidian 或别的程序改过），
 * 默认拒绝并返回磁盘版本，让用户并排比较后决定；force=true 才强行覆盖。
 */
export async function writeDoc(
  rel: string,
  markdown: string,
  baseHash: string | undefined,
  force: boolean,
): Promise<DocPayload> {
  const abs = await resolveInVault(rel);
  assertAllowedExt(abs);

  const current = await readDoc(rel);
  if (!force && baseHash && current.docHash !== baseHash) {
    throw conflict('磁盘上的内容已被其他程序修改', {
      diskMarkdown: current.markdown,
      diskHash: current.docHash,
    });
  }
  await writeFileAtomic(abs, markdown);
  return { path: rel, markdown, docHash: sha256(markdown) };
}

/** 新建文章，重名自动加 -2 / -3。 */
export async function createDoc(relPathRaw: string, content = ''): Promise<DocPayload> {
  let rel = relPathRaw.replace(/\\/g, '/').trim().replace(/^\/+/, '');
  if (!rel) throw bad('文件名不能为空');
  if (!/\.(md|markdown|txt)$/i.test(rel)) rel += '.md';

  const finalRel = await uniqueRel(rel);
  const abs = await resolveInVault(finalRel);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await writeFileAtomic(abs, content);
  return { path: finalRel, markdown: content, docHash: sha256(content) };
}

export async function ensureUniqueRel(rel: string): Promise<string> {
  return uniqueRel(rel);
}

async function uniqueRel(rel: string): Promise<string> {
  const root = await requireVaultRoot();
  const ext = path.extname(rel);
  const stem = rel.slice(0, rel.length - ext.length);
  if (!(await exists(toAbs(root, rel)))) return rel;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${stem}-${i}${ext}`;
    if (!(await exists(toAbs(root, candidate)))) return candidate;
  }
  throw conflict('同名文件太多了');
}

export async function createDir(rel: string): Promise<void> {
  const abs = await resolveInVault(rel);
  await fsp.mkdir(abs, { recursive: true });
}

// ─────────────────────────── 重命名 / 移动 ───────────────────────────

/** 重命名或移动。文档 / 目录对应的 sidecar 会跟着迁移。 */
export async function renameEntry(fromRel: string, toRel: string): Promise<void> {
  const fromAbs = await resolveInVault(fromRel);
  const toAbs = await resolveInVault(toRel);
  if (fromAbs === toAbs) return;
  if (await exists(toAbs)) throw conflict('目标已存在');

  let st: Stats;
  try {
    st = await fsp.stat(fromAbs);
  } catch (e) {
    throw normalizeFsError(e, '重命名');
  }

  // 不允许把一个目录移进它自己的子目录
  if (st.isDirectory() && (toAbs + path.sep).startsWith(fromAbs + path.sep)) {
    throw bad('不能把目录移动到它自己的子目录里');
  }

  await fsp.mkdir(path.dirname(toAbs), { recursive: true });
  try {
    await fsp.rename(fromAbs, toAbs);
  } catch (e) {
    throw normalizeFsError(e, '重命名');
  }

  await relocateSidecar(fromRel, toRel, st.isDirectory());
}

// ─────────────────────────── 删除（进回收站） ───────────────────────────

export function trashStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/** 删除文档或目录 —— 不真删，移进 .notebook/trash/<时间戳>/。 */
export async function deleteEntry(rel: string): Promise<{ trashedTo: string }> {
  const root = await requireVaultRoot();
  const abs = await resolveInVault(rel);
  let st: Stats;
  try {
    st = await fsp.stat(abs);
  } catch (e) {
    throw normalizeFsError(e, '删除');
  }

  const stamp = trashStamp();
  const destRoot = path.join(root, '.notebook', 'trash', stamp);
  const dest = path.join(destRoot, 'vault', ...rel.split('/'));
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  try {
    await fsp.rename(abs, dest);
  } catch (e) {
    throw normalizeFsError(e, '移动到回收站');
  }

  await trashSidecarTree(root, rel, st.isDirectory(), stamp);
  return { trashedTo: `.notebook/trash/${stamp}` };
}

// ─────────────────────────── 汇总信息 ───────────────────────────

export interface VaultInfo {
  configured: boolean;
  root: string | null;
  name: string;
  docCount: number;
}

export async function vaultInfo(): Promise<VaultInfo> {
  const root = await requireVaultRoot().catch(() => null);
  if (!root) return { configured: false, root: null, name: '', docCount: 0 };
  const tree = await scanTree();
  let count = 0;
  const countDocs = (nodes: TreeNode[] | undefined) => {
    for (const n of nodes ?? []) {
      if (n.type === 'doc') count++;
      else countDocs(n.children);
    }
  };
  countDocs(tree.children);
  return { configured: true, root, name: path.basename(root), docCount: count };
}

export { ApiError };
