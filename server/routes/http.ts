/**
 * server/routes/http.ts —— 路由层的公共小工具。
 *
 * 只做三件事，不做框架：
 *   1. 把 zod 的报错转成用户能看懂的中文 400；
 *   2. 把「同步 / 异步都可能抛错」的处理器统一包成 Promise 链，
 *      这样 Express 5 的自动错误转发能稳定接住（Express 5 只接住 reject 的 Promise，
 *      同步 throw 在 async 函数里本来也会变成 reject，但显式包一层更不容易踩坑）；
 *   3. 提供读取 query / body 的便捷取参函数。
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import { ApiError } from '../core';

/** 包装异步路由处理器，任何 throw / reject 都会交给错误中间件。 */
export function h(fn: (req: Request, res: Response) => Promise<unknown> | unknown): RequestHandler {
  return (req, res, next) => {
    void Promise.resolve()
      .then(() => fn(req, res))
      .catch(next);
  };
}

/** 用 zod 解析，失败时抛 400 并把字段路径写清楚。 */
export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown, what = '请求参数'): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const first = r.error.issues[0];
    const path = first?.path?.join('.') ?? '';
    throw new ApiError(400, `${what}不合法${path ? `（字段 ${path}）` : ''}：${first?.message ?? '未知错误'}`, 'bad_request');
  }
  return r.data;
}

/** 取必填的字符串 query 参数。 */
export function qStr(req: Request, name: string): string {
  const v = req.query[name];
  if (typeof v !== 'string' || !v) throw new ApiError(400, `缺少参数 ${name}`, 'bad_request');
  return v;
}

/** 取可选的字符串 query 参数。 */
export function qOptStr(req: Request, name: string): string | undefined {
  const v = req.query[name];
  return typeof v === 'string' && v ? v : undefined;
}

export function qBool(req: Request, name: string): boolean {
  const v = req.query[name];
  return v === '1' || v === 'true' || v === 'yes';
}

export function qInt(req: Request, name: string, fallback: number): number {
  const v = req.query[name];
  const n = typeof v === 'string' ? Number.parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

/** 取路由参数（Express 5 的 params 可能被推断成 string | string[]）。 */
export function pStr(req: Request, name: string): string {
  const v = (req.params as Record<string, string | string[] | undefined>)[name];
  if (typeof v === 'string' && v) return v;
  if (Array.isArray(v) && v[0]) return v[0];
  throw new ApiError(400, `缺少路径参数 ${name}`, 'bad_request');
}

export { z };
