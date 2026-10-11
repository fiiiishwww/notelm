/**
 * src/main.tsx —— 前端挂载入口。
 *
 * 关于 StrictMode：这里**刻意不套** <StrictMode>。
 * StrictMode 在开发模式下会把每个 effect 挂载→卸载→再挂载，跑两遍。多数应用无所谓，
 * 但这个应用的启动 effect 是真在做事：读磁盘、拉文档、必要时把重锚结果写回 sidecar。
 * 双跑会让同一篇文章被并发请求两次（甚至两次写 sidecar），开发时的表现和用户实际
 * 看到的（生产构建只跑一次）不一致——这种「只在 dev 出现」的差异最擅长掩盖真问题。
 */

import { createRoot } from 'react-dom/client';
import App from './App';
import { AppProvider } from './state/store';
import './styles/theme.css';
// 公式渲染样式（服务端 KaTeX 输出的 DOM 靠它排版；字体文件由 vite 从包内解析）
import 'katex/dist/katex.min.css';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('index.html 里找不到 #root');

const token = document.querySelector<HTMLMetaElement>('meta[name="x-local-token"]')?.content ?? '';

// 没有 token 说明这个页面不是本地服务发出来的（比如直接双击了 dist/index.html，
// 或者构建时把占位符替换掉了）。这种情况下所有 /api 请求都会被拒，与其让用户看到
// 满屏「请求失败」，不如在这里把原因说清楚。
if (!token) {
  rootEl.innerHTML = `
    <div class="center-screen">
      <div class="boot-error">
        <h1>页面缺少本地访问令牌</h1>
        <p style="font-size:13.5px;line-height:1.7;margin:0 0 10px">
          这个界面必须由本地服务打开。请回到启动窗口，用 <code>npm run dev</code> 启动后
          访问 <code>http://127.0.0.1:3000</code>；不要直接双击打开 dist/index.html。
        </p>
      </div>
    </div>`;
} else {
  createRoot(rootEl).render(
    <AppProvider>
      <App />
    </AppProvider>,
  );
}
