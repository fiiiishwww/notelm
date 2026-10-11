/**
 * server/routes/assistant.ts —— 外部 AI 助手（DSH）的入口。
 *
 * 只有一个接口：GET /api/assistant。返回可直接放进 iframe 的完整 URL。
 * 拉起/复用/令牌缓存逻辑全在 services/dsh.ts，这里只做转发。
 *
 * ★ 为什么不做反向代理 ★
 *   iframe 直连 127.0.0.1:3080 就够（DSH 没有限制被嵌入的响应头），
 *   代理要手工搬 HTTP + WebSocket 升级，是纯增量的复杂度，没有换到任何东西。
 */
import { Router } from 'express';
import { getAssistantUrl } from '../services/dsh';

export const assistantRouter = Router();

assistantRouter.get('/assistant', async (_req, res, next) => {
  try {
    const info = await getAssistantUrl();
    // 不可用也返回 200：前端按 available 展示原因，不算服务器错误
    res.json(info);
  } catch (e) {
    next(e);
  }
});
