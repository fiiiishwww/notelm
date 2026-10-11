/**
 * server/routes/index.ts —— 把所有路由挂到 /api 下，并统一错误处理。
 *
 * 错误处理约定：
 *   - 抛 ApiError → 按它的 status/code/extra 原样返回，前端能拿到结构化信息
 *     （典型例子：409 时会带上 diskMarkdown / diskHash 供并排比较）；
 *   - 抛其它任何东西 → 500，并把 message 带出去，但不带堆栈（堆栈只写日志）。
 *   永远不要给前端返回 HTML 错误页——前端全部按 JSON 解析。
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import { ApiError } from '../core';
import { settingsRouter } from './settings';
import { treeRouter } from './tree';
import { docRouter } from './doc';
import { sidecarRouter } from './sidecar';
import { studyRouter } from './study';
import { searchRouter } from './search';
import { importRouter } from './import';
import { dedupeRouter } from './dedupe';
import { graphRouter } from './graph';
import { activationRouter } from './activation';
import { fontsRouter } from './fonts';
import { assistantRouter } from './assistant';
import { agentRouter } from './agent';

export const apiRouter = Router();

apiRouter.use(settingsRouter);
apiRouter.use(treeRouter);
apiRouter.use(docRouter);
apiRouter.use(sidecarRouter);
apiRouter.use(studyRouter);
apiRouter.use(searchRouter);
apiRouter.use(importRouter);
apiRouter.use(dedupeRouter);
apiRouter.use(graphRouter);
apiRouter.use(activationRouter);
apiRouter.use(fontsRouter);
apiRouter.use(assistantRouter);
apiRouter.use(agentRouter);

/** 未匹配到的 API 路径：明确返回 404 JSON，不要落到 SPA 的 index.html。 */
apiRouter.use((req: Request, res: Response) => {
  res.status(404).json({ error: `没有这个接口：${req.method} ${req.originalUrl}`, code: 'no_route' });
});

export function apiErrorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    next(err);
    return;
  }
  const e = err instanceof ApiError ? err : null;
  const status = e?.status ?? 500;
  const msg = e?.message ?? (err instanceof Error ? err.message : String(err));

  if (status >= 500) {
    // 5xx 才值得打日志；4xx 是用户操作导致的，属于正常现象
    console.error(`[api] ${req.method} ${req.originalUrl} → ${status}`, err instanceof Error ? err.stack : err);
  }

  const payload: Record<string, unknown> = { error: msg, code: e?.code ?? 'internal_error' };
  if (e?.extra && Object.keys(e.extra).length) Object.assign(payload, e.extra);
  res.status(status).json(payload);
}
