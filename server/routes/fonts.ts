/**
 * server/routes/fonts.ts —— 自备字体的管理接口 + 字体文件服务。
 *
 * ## 两个 router，挂载位置不同
 *
 *   fontsRouter      → `/api/fonts*`，走 securityMiddleware 的 token 校验（管理操作）
 *   fontAssetRouter  → `/font/:file`，**挂在 /api 之外**
 *
 * ★ 为什么字体文件必须脱离 /api ★
 *   `@font-face { src: url(...) }` 由 CSS 引擎发起，和 `<img src>` 一样
 *   **带不了自定义头**，挂在 /api 下面必然 403，字体永远加载不出来。
 *   这和 routes/asset.ts 是同一个坑，那边的头注释写得更细。
 *   脱离 /api 不等于没鉴权：securityMiddleware 的「只绑 127.0.0.1 + Host 白名单
 *   + Origin/Sec-Fetch-Site 校验」三层照旧生效，外部网页引用会被拦掉。
 *
 * ★ 这个接口只能吐字体文件 ★
 *   路径参数只允许**单个文件名**（fontAbsPath 里 basename 校验），扩展名走字体白名单，
 *   目录固定在 `.local/fonts/`。所以它开不出「免 token 读任意文件」的口子——
 *   不接受路径、不认笔记库里的任何东西。
 */

import fs from 'node:fs';
import { Router } from 'express';
import {
  deleteFont,
  fontAbsPath,
  fontMime,
  listFonts,
  saveFont,
  sniffFont,
  FONT_EXTENSIONS,
} from '../services/fonts';
import { ApiError } from '../core';
import { h, pStr, qStr } from './http';

/** 管理接口（/api/fonts），带 token。 */
export const fontsRouter = Router();

fontsRouter.get(
  '/fonts',
  h(async (_req, res) => {
    res.json({ fonts: await listFonts(), accept: FONT_EXTENSIONS });
  }),
);

/**
 * 上传字体：请求体是**原始二进制**（不是 multipart），文件名放 query。
 * 为什么不用 multipart：本项目零依赖，没有 multer；express.raw 一行就能收二进制，
 * 前端 fetch 直接 body=File 即可。文件名只用来判扩展名和起 label，不参与路径拼接。
 */
fontsRouter.post(
  '/fonts',
  h(async (req, res) => {
    const name = qStr(req, 'name');
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!buf.length) {
      throw new ApiError(400, '没有收到字体内容（请求体应为原始二进制）', 'empty_body');
    }
    const font = await saveFont(name, buf);
    res.json({ font });
  }),
);

fontsRouter.delete(
  '/fonts/:file',
  h(async (req, res) => {
    await deleteFont(pStr(req, 'file'));
    res.json({ ok: true, fonts: await listFonts() });
  }),
);

// ─────────────────────────── 字体文件（免 token，但在 /api 之外） ───────────────────────────

export const fontAssetRouter = Router();

fontAssetRouter.get('/font/:file', (req, res) => {
  const file = String(req.params.file ?? '');
  const abs = fontAbsPath(file);
  if (!abs) {
    res.status(415).type('text/plain; charset=utf-8').send('不是支持的字体文件');
    return;
  }
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    res.status(404).type('text/plain; charset=utf-8').send('找不到这个字体');
    return;
  }
  if (!st.isFile()) {
    res.status(404).type('text/plain; charset=utf-8').send('找不到这个字体');
    return;
  }

  // 字体是静态资源，给强缓存；用 mtime+size 做 ETag，换字体（同名覆盖）也能刷新
  const etag = `W/"${st.mtimeMs.toString(36)}-${st.size.toString(36)}"`;
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  const head = Buffer.alloc(Math.min(st.size, 64));
  const fd = fs.openSync(abs, 'r');
  try {
    fs.readSync(fd, head, 0, head.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  const sniffed = sniffFont(head);
  res.setHeader('Content-Type', sniffed ? fontMime(sniffed) : 'application/octet-stream');
  // 显式给长度：字体动辄几 MB，浏览器拿不到长度就没法算进度/做可靠缓存
  res.setHeader('Content-Length', String(st.size));
  // 字体是二进制、不会执行，加 nosniff 防止被当成 HTML/脚本解释
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.headers['if-none-match'] === etag) {
    res.status(304).end();
    return;
  }
  fs.createReadStream(abs).pipe(res);
});
