/**
 * server/index.ts —— 服务入口：单进程、单端口，同时提供 API 与前端。
 *
 * ★ 为什么把 Vite 嵌进 Express（middleware 模式），而不是前后端两个进程 ★
 *   1. 只有一个端口，用户不会看到两个黑窗口，也不用记得「先开哪个」；
 *   2. 同源 → 没有 CORS，也没有 cookie / token 的跨源麻烦；
 *   3. 生产模式直接 serve dist/，开发模式走 Vite 的 HMR，代码路径完全一样，
 *      不会出现「开发能跑、打包后 404」这类经典问题。
 *
 * ★ 安全 ★
 *   只绑 127.0.0.1；启动时生成一次性 token 写进 process.env，
 *   由 Vite 插件替换进 index.html 的 meta 标签；之后所有 /api/ 请求都要带这个头。
 *   外部网页拿不到 token，也就打不进这个本地服务。
 */

import express from 'express';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { PROJECT_ROOT, randomToken, ensureDirSync, LOCAL_DIR } from './core';
import { basicAuthMiddleware, securityMiddleware } from './security';
import { apiErrorHandler, apiRouter } from './routes/index';
import { assetRouter } from './routes/asset';
import { fontAssetRouter } from './routes/fonts';
import { startBackupLoop } from './services/backup';

const PORT = Number(process.env.PORT ?? 3000);
// 默认只绑本机回环。设 NB_HOST=0.0.0.0（启动.bat 已设）即开放局域网：
// 手机连同一个 Wi-Fi 访问 http://<电脑IP>:3000，和电脑看的是同一份笔记（天然同步）。
const HOST = process.env.NB_HOST ?? '127.0.0.1';
const IS_PROD = process.argv.includes('--prod') || process.env.NODE_ENV === 'production';

/** 收集本机私有网段 IPv4（优先 192.168），给启动横幅用。 */
function lanIPv4s(): string[] {
  const out: string[] = [];
  try {
    for (const addrs of Object.values(os.networkInterfaces())) {
      for (const a of addrs ?? []) {
        if (a.family === 'IPv4' && !a.internal) out.push(a.address);
      }
    }
  } catch {
    /* 拿不到就不显示，不影响服务 */
  }
  // 内网地址排前面，虚拟网卡（WSL/Docker 的 172.x）排后面
  return out.sort((a, b) => Number(b.startsWith('192.168.')) - Number(a.startsWith('192.168.')));
}

async function main(): Promise<void> {
  // ── 本地令牌：必须在加载 Vite 之前设好，Vite 插件会读它
  const token = process.env.NB_LOCAL_TOKEN || randomToken();
  process.env.NB_LOCAL_TOKEN = token;
  // 局域网模式开关：绑非回环地址 = 允许手机访问，security.ts 会据此放宽 Host/Origin 校验
  if (HOST !== '127.0.0.1' && HOST !== 'localhost' && HOST !== '[::1]') process.env.NB_LAN = '1';
  ensureDirSync(LOCAL_DIR);

  const app = express();
  app.disable('x-powered-by');
  // 只信任本机反向代理层（这里其实没有代理，写成 false 更严格）
  app.set('trust proxy', false);

  // 1) 登录门（公网部署必开；不设 NB_AUTH_USER/PASS 时完全不生效）
  app.use(basicAuthMiddleware);

  // 1.5) 安全边界：任何静态资源也要过 Host 校验
  app.use(securityMiddleware);

  // 2) /api/upload 和 /api/import/zip 收的是原始二进制，必须排在 json 解析之前
  app.use('/api/upload', express.raw({ type: () => true, limit: '100mb' }));
  app.use('/api/import/zip', express.raw({ type: () => true, limit: '200mb' }));
  // 上传字体也是原始二进制（零依赖方案下不引 multer，express.raw 一行搞定）
  app.use('/api/fonts', express.raw({ type: () => true, limit: '60mb' }));

  // 3) 其余接口用 JSON。正文可能很大（整本书粘进来），给 16MB
  app.use(express.json({ limit: '16mb' }));

  // 4) API
  app.use('/api', apiRouter);
  app.use('/api', apiErrorHandler);

  // 5) 笔记库里的图片。
  //    ★ 必须排在前端静态兜底**之前** ★：否则 Vite / 生产静态的 SPA fallback
  //    会把 index.html 当成图片返回（HTTP 200 + text/html），浏览器解不出 → 一片空白。
  //    它挂在 /api 之外是因为 <img src> 发不出 X-Local-Token，详见 routes/asset.ts 的头注释。
  app.use(assetRouter);

  // 5.5) 用户自备字体。同样必须在静态兜底之前，同样挂 /api 之外——
  //      CSS 的 @font-face 也发不出 X-Local-Token（和 <img> 同一个坑）。
  app.use(fontAssetRouter);

  // 6) 前端
  if (IS_PROD) {
    await attachProdStatic(app, token);
  } else {
    await attachViteDev(app, token);
  }

  const server = app.listen(PORT, HOST, () => {
    const url = `http://127.0.0.1:${PORT}`;
    const lans = lanIPv4s();
    console.log('');
    console.log('  ┌──────────────────────────────────────────────┐');
    console.log('  │  NoteLM · 学习型笔记                          │');
    console.log('  └──────────────────────────────────────────────┘');
    console.log(`  ▸ 已在浏览器打开：${url}`);
    console.log(`  ▸ 模式：${IS_PROD ? '生产（dist/）' : '开发（Vite HMR）'}`);
    if (process.env.NB_LAN === '1' && lans.length) {
      console.log('  ▸ 手机访问（连同一个 Wi-Fi，浏览器打开）：');
      for (const ip of lans) console.log(`      http://${ip}:${PORT}`);
      console.log('  ▸ 首次启动若弹出 Windows 防火墙提示，请勾选「专用网络」并允许');
    }
    if (process.env.NB_PUBLIC_HOST) {
      console.log(`  ▸ 公网主机名：${process.env.NB_PUBLIC_HOST}（Host 校验白名单）`);
    }
    console.log(
      process.env.NB_AUTH_USER && process.env.NB_AUTH_PASS
        ? `  ▸ 登录门：已开启（用户 ${process.env.NB_AUTH_USER}）`
        : '  ▸ 登录门：未开启（仅本机/局域网使用；放公网前务必设 NB_AUTH_USER / NB_AUTH_PASS）',
    );
    console.log('  ▸ 按 Ctrl+C 停止服务');
    console.log('');
    if (process.env.NB_NO_OPEN !== '1') openBrowser(url);
    // 笔记库自动备份：启动时查上次备份时间，超 24h 就补一份；之后每 6h 自查（run_code 上线后的灾难兜底）
    startBackupLoop();
  });

  server.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`\n端口 ${PORT} 已被占用。可能是上一次的服务还没关掉。`);
      console.error('解决办法：关掉那个窗口，或换个端口启动：PORT=3001 npm run dev\n');
    } else {
      console.error('服务启动失败：', e);
    }
    process.exit(1);
  });

  const shutdown = () => {
    console.log('\n正在停止服务…');
    server.close(() => process.exit(0));
    // 兜底：3 秒内没关干净就强退，避免窗口卡住
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function attachViteDev(app: express.Express, token: string): Promise<void> {
  const { createServer } = await import('vite');
  // token 已经写进 process.env，vite.config.ts 的 inject-local-token 插件会把它
  // 替换进 index.html；这里不需要再传 define，避免两套机制打架。
  void token;
  const vite = await createServer({
    root: PROJECT_ROOT,
    server: { middlewareMode: true },
    appType: 'spa',
  });
  app.use(vite.middlewares);
}

async function attachProdStatic(app: express.Express, token: string): Promise<void> {
  const fsp = await import('node:fs/promises');
  const dist = path.join(PROJECT_ROOT, 'dist');
  const indexFile = path.join(dist, 'index.html');

  let indexHtml: string;
  try {
    indexHtml = await fsp.readFile(indexFile, 'utf8');
  } catch {
    console.error('找不到 dist/index.html —— 请先运行 `npm run build`，或改用 `npm run dev`。');
    process.exit(1);
  }
  // 生产下 index.html 是构建产物，token 每次启动都不同，所以运行时替换
  const html = indexHtml.replace(/__LOCAL_TOKEN__/g, token);

  app.use(
    express.static(dist, {
      index: false,
      setHeaders: (res, p) => {
        // 带 hash 的产物可以长缓存；index.html 绝对不缓存
        if (/\.[0-9a-f]{8,}\.(js|css)$/i.test(p)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      },
    }),
  );
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(html);
  });
}

/** 尽力打开系统默认浏览器；失败也不影响服务运行。 */
function openBrowser(url: string): void {
  void (async () => {
    try {
      const { spawn } = await import('node:child_process');
      const cmd =
        process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
      const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
      spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
    } catch {
      /* 忽略：控制台里已经有地址了，用户手动点也一样 */
    }
  })();
}

main().catch((e) => {
  console.error('启动失败：', e);
  process.exit(1);
});
