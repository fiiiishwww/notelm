/**
 * server/routes/dedupe.ts —— 一键去重的两个接口。
 *
 * 刻意拆成两步：
 *   1. GET  /api/dedupe        —— 只扫描，列出重复组，一个字节都不动；
 *   2. POST /api/dedupe/apply  —— 用户勾选确认后，才把选中的文章移进回收站。
 *
 * 「先给清单再让用户点头」不是多此一举：去重是唯一一种「删错了要花几小时才能
 * 发现」的操作，而扫描本身既便宜又无副作用。
 */

import { Router } from 'express';
import { dedupeReport } from '../services/dedupe';
import { deleteEntry } from '../vault';
import { h, parse, z } from './http';

export const dedupeRouter = Router();

/** 扫描全库，返回重复组清单。 */
dedupeRouter.get(
  '/dedupe',
  h(async (_req, res) => {
    res.json(await dedupeReport());
  }),
);

const applySchema = z.object({
  rels: z.array(z.string().min(1).max(1024)).max(1000),
});

/**
 * 把选中的文章移进回收站。
 *
 * 逐篇处理而不是「先全部校验再一起删」：单篇失败（被别的程序占用）不该
 * 让整批回滚，把失败的那几篇如实报给前端即可。
 */
dedupeRouter.post(
  '/dedupe/apply',
  h(async (req, res) => {
    const body = parse(applySchema, req.body, '去重请求');
    const trashed: string[] = [];
    const failed: { rel: string; message: string }[] = [];
    for (const rel of body.rels) {
      try {
        const r = await deleteEntry(rel);
        trashed.push(r.trashedTo);
      } catch (e) {
        failed.push({ rel, message: e instanceof Error ? e.message : String(e) });
      }
    }
    res.json({ removed: trashed.length, trashed, failed });
  }),
);
