/**
 * server/routes/asset.ts —— 把笔记库里的图片吐给浏览器。
 *
 * ## 为什么是 `/asset` 而不是 `/api/asset`
 *
 * `<img src>` 发的是普通导航请求，**没有任何办法附加自定义头**，
 * 而 `securityMiddleware` 对 `/api/*` 强制要求 `X-Local-Token`。
 * 挂到 `/api` 下面会 100% 403，图片永远出不来。
 *
 * 放在 `/api` 之外**不代表绕过鉴权**——它依然完整经过 `securityMiddleware` 的三层：
 *   1. 服务只绑 127.0.0.1
 *   2. Host 白名单
 *   3. Origin + `Sec-Fetch-Site` 校验
 * 外部网页里嵌一个 `<img src="http://127.0.0.1:3000/asset?...">` 时，
 * 浏览器会带上 `Sec-Fetch-Site: cross-site`，直接被第 3 层拦掉。
 *
 * ## 为什么扩展名白名单比全局的更窄
 *
 * 这个接口是给 `<img>` 用的，只需要图片。全局 `ALLOWED_EXT` 里还有
 * `.md` / `.pdf` / `.txt`，放进来等于开了一个「免 token 读任意笔记」的口子。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Router } from 'express';
import { z } from 'zod';
import { ApiError } from '../core';
import { resolveInVault } from '../security';

export const assetRouter = Router();

/** 只认图片。绝不能读到 .md / .pdf / .txt。 */
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
};

const querySchema = z.object({
  /** 引用这张图的文档（相对路径），用来解析相对路径 */
  doc: z.string().max(1024).default(''),
  /** 图片引用，可能是 `assets/x.png`（相对文档）或 `a/b/x.png`（相对库根） */
  ref: z.string().min(1).max(1024),
});

assetRouter.get(
  '/asset',
  // 不用 h()：这里要自己管响应头和错误码，不是标准 JSON 接口
  async (req, res) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).type('text/plain; charset=utf-8').send('资源请求不合法');
      return;
    }
    const { doc, ref } = parsed.data;
    const rawRef = ref.replace(/\\/g, '/');

    // ★ 为什么要准备「解码后」和「原样」两个候选 ★
    //   一条图片引用在到达这里之前被编码了**两次**：
    //     1. markdown-it 的 normalizeLink（飞书导出的中文档名 → %E5%9B%BE…）
    //     2. shared/blocks.ts 的 rewriteImageSrc 又 encodeURIComponent 一次
    //   而 Express 的 req.query 只解一层，于是拿到的是「还编码着一层」的字符串，
    //   直接拼路径一定找不到 —— 图片引用里只要有中文或 %20 就必踩，
    //   飞书导出的文档几乎全是这种。PDF 导入那种纯 ASCII 图名反而从不出问题，
    //   所以这个 bug 一直没人发现。
    //   反过来，如果某个文件名里真的带 % 字符，解码反而会破坏它，
    //   所以两种写法都要试：先试解码后的，失败再退回原样。
    const decoded = safeDecode(rawRef);
    const refVariants = decoded === rawRef ? [rawRef] : [decoded, rawRef];

    try {
      // 扩展名必须看解码后的那个：原样版本可能是 `.png%20` 这种畸形尾巴
      const ext = path.extname(decoded).toLowerCase();
      const mime = IMAGE_MIME[ext];
      // 非图片扩展名一律拒绝：这条白名单是整个接口的安全边界
      if (!mime) throw new ApiError(415, `不是支持的图片格式：${ext || '(无扩展名)'}`, 'bad_ext');

      // 两种写法都要支持：
      //   1. 相对文档（Obsidian 的 `![](assets/x.png)`，PDF 导入的图就是这种）
      //   2. 相对笔记库根（`![](a/b/x.png)`）
      const docDir = doc.includes('/') ? doc.slice(0, doc.lastIndexOf('/')) : '';

      let abs: string | null = null;
      outer: for (const v of refVariants) {
        const candidates = docDir ? [`${docDir}/${v}`, v] : [v];
        for (const c of candidates) {
          const p = await resolveInVault(normalizeRel(c));
          if (fs.existsSync(p) && fs.statSync(p).isFile()) {
            abs = p;
            break outer;
          }
        }
      }
      if (!abs) {
        res.status(404).type('text/plain; charset=utf-8').send('找不到这个图片');
        return;
      }

      const st = await fsp.stat(abs);
      const etag = `W/"${st.mtimeMs.toString(36)}-${st.size.toString(36)}"`;
      res.setHeader('ETag', etag);
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.setHeader('Content-Type', mime);

      // SVG 里能带 <script>。用户在标签页直接打开 /asset?ref=x.svg 就是同源 XSS，
      // 必须掐掉脚本执行（<img> 里引用本来就不执行，这层是防直接导航）。
      if (ext === '.svg') {
        res.setHeader(
          'Content-Security-Policy',
          "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
        );
      }

      if (req.headers['if-none-match'] === etag) {
        res.status(304).end();
        return;
      }
      fs.createReadStream(abs).pipe(res);
    } catch (e) {
      const code = e instanceof ApiError ? e.status : 500;
      res.status(code).type('text/plain; charset=utf-8').send(e instanceof Error ? e.message : '读取失败');
    }
  },
);

/** 去掉开头的 ./ 和 /，压掉 .. 之外的多余分隔符（越界由 resolveInVault 兜底）。 */
function normalizeRel(rel: string): string {
  return rel.replace(/^\.?\/+/, '').replace(/\/{2,}/g, '/');
}

/**
 * 解码一层百分号编码。已经是明文或编码非法时原样返回。
 * 解码失败（比如文件名里恰好有个孤立的 %）绝不能抛 —— 退回原样还有救。
 */
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
