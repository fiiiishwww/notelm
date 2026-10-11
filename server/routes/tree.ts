/**
 * server/routes/tree.ts —— 目录树的读取与增删改。
 *
 * 所有路径参数（relPath）都是 vault 相对路径，统一用 / 分隔，
 * 最终都会经过 resolveInVault() 做越界校验——本文件里不允许出现裸的 path.join(root, rel)。
 */

import path from 'node:path';
import { Router } from 'express';
import { z } from 'zod';
import { ApiError, requireVaultRoot, toAbs } from '../core';
import { resolveInVault } from '../security';
import { createDir, createDoc, deleteEntry, renameEntry, scanTree } from '../vault';
import { h, parse } from './http';

export const treeRouter = Router();

treeRouter.get(
  '/tree',
  h(async (_req, res) => {
    const tree = await scanTree();
    res.json({ tree });
  }),
);

const createSchema = z.object({
  type: z.enum(['doc', 'dir']),
  /** 父目录的相对路径，'' 表示根 */
  parent: z.string().max(1024).default(''),
  name: z.string().min(1).max(200),
});

/** 新建文章或目录。 */
treeRouter.post(
  '/entry',
  h(async (req, res) => {
    const body = parse(createSchema, req.body, '新建请求');
    const parent = body.parent.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const name = body.name.trim();
    if (!name) throw new ApiError(400, '名称不能为空', 'bad_request');
    // 名字里不允许出现路径分隔符，避免「名字」变成「路径」
    if (/[\\/]/.test(name)) throw new ApiError(400, '名称里不能包含斜杠', 'bad_request');

    const rel = parent ? `${parent}/${name}` : name;

    if (body.type === 'dir') {
      await createDir(rel);
      res.json({ ok: true, relPath: rel, type: 'dir' });
      return;
    }
    const doc = await createDoc(rel);
    res.json({ ok: true, relPath: doc.path, type: 'doc', docHash: doc.docHash });
  }),
);

const renameSchema = z.object({
  from: z.string().min(1).max(1024),
  to: z.string().min(1).max(1024),
});

/** 重命名或移动（文档的 sidecar 会跟着走）。 */
treeRouter.patch(
  '/entry',
  h(async (req, res) => {
    const body = parse(renameSchema, req.body, '重命名请求');
    const from = body.from.replace(/\\/g, '/');
    const to = body.to.replace(/\\/g, '/');
    await renameEntry(from, to);
    res.json({ ok: true, from, to });
  }),
);

treeRouter.delete(
  '/entry',
  h(async (req, res) => {
    const rel = typeof req.query.rel === 'string' ? req.query.rel : '';
    if (!rel) throw new ApiError(400, '缺少参数 rel', 'bad_request');
    const r = await deleteEntry(rel.replace(/\\/g, '/'));
    res.json({ ok: true, ...r });
  }),
);

/**
 * 在系统文件管理器里定位这个文件。
 * 只在 Windows / macOS 上做，且只打开已存在、且确认在 vault 内的路径。
 */
treeRouter.post(
  '/reveal',
  h(async (req, res) => {
    const body = parse(z.object({ rel: z.string().min(1).max(1024) }), req.body, '定位请求');
    const abs = await resolveInVault(body.rel.replace(/\\/g, '/'));
    const { spawn } = await import('node:child_process');
    try {
      if (process.platform === 'win32') {
        spawn('explorer.exe', ['/select,', abs], { detached: true, stdio: 'ignore' }).unref();
      } else if (process.platform === 'darwin') {
        spawn('open', ['-R', abs], { detached: true, stdio: 'ignore' }).unref();
      } else {
        spawn('xdg-open', [path.dirname(abs)], { detached: true, stdio: 'ignore' }).unref();
      }
    } catch (e) {
      throw new ApiError(500, `无法打开文件管理器：${(e as Error).message}`, 'reveal_failed');
    }
    res.json({ ok: true });
  }),
);

/** 打开笔记库根目录（设置页用）。 */
treeRouter.post(
  '/open-vault',
  h(async (_req, res) => {
    const root = await requireVaultRoot();
    const { spawn } = await import('node:child_process');
    try {
      const cmd = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
      spawn(cmd, [root], { detached: true, stdio: 'ignore' }).unref();
    } catch (e) {
      throw new ApiError(500, `无法打开目录：${(e as Error).message}`, 'reveal_failed');
    }
    res.json({ ok: true, root });
  }),
);

/** 判断某个相对路径是否已存在（新建时做重名提示）。 */
treeRouter.get(
  '/exists',
  h(async (req, res) => {
    const rel = typeof req.query.rel === 'string' ? req.query.rel : '';
    if (!rel) {
      res.json({ exists: false });
      return;
    }
    const root = await requireVaultRoot();
    const { exists } = await import('../core');
    res.json({ exists: await exists(toAbs(root, rel)) });
  }),
);
