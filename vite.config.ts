import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root,
  plugins: [
    react(),
    {
      // 把启动时生成的本地 token 注入 index.html，前端每个 /api 请求都要带上它。
      // 没有这个 token 的外部网页无法调用本机的 API。
      //
      // ★ apply: 'serve' 不能去掉 ★
      // 构建（vite build）时进程里并没有 NB_LOCAL_TOKEN，如果不限定只在 dev 生效，
      // 这一步会把占位符替换成空字符串，dist/index.html 里就永久留下一个空 token，
      // 之后 server/index.ts 的 attachProdStatic 再怎么替换也找不到占位符了，
      // 结果就是「开发能跑、npm start 起来全是 401」。
      // 让 build 保留字面量 __LOCAL_TOKEN__，交给服务端在启动时替换。
      name: 'inject-local-token',
      apply: 'serve',
      transformIndexHtml(html: string) {
        return html.replace('__LOCAL_TOKEN__', process.env.NB_LOCAL_TOKEN ?? '');
      },
    },
  ],
  server: {
    middlewareMode: true,
  },
  appType: 'spa',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
  },
});
