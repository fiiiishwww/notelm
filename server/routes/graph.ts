/**
 * server/routes/graph.ts —— 知识地图（主题团）的只读接口。
 *
 * ★ 成本分级是刻意的 ★
 *   GET  /api/graph          零大模型调用，打开面板就该秒回
 *   POST /api/graph/rebuild  重建缓存（用户手动点，会卡十几秒——首次算 kNN）
 *
 * 不做「全库矛盾体检」接口：那是个「没事不会点」的动作，
 * 而且检索侧已经在用户真正关心某个话题时顺带覆盖了同一个问题（见 routes/search.ts）。
 *
 * 图谱是**派生物**：节点就是你写下的文档，边由相似度算出来，删掉重算即可。
 * 所以这里既不生成内容，也不往笔记库里写任何东西。
 */

import { Router } from 'express';
import { buildGraph, dropGraphCache, graphStat, readGraph } from '../services/graph';
import type { DocGraph } from '../services/graph';
import { h } from './http';

export const graphRouter = Router();

export interface GraphResponse {
  graph: DocGraph | null;
  /** 这份图是旧索引算出来的（库里改过），后台正在重建 */
  stale: boolean;
  /** 后台正在建。首次打开就是这种情况，前端该轮询 */
  building: boolean;
  /** 缓存是否已落盘：用于判断「全新」还是「有旧图可看」 */
  indexed: { chunks: number; withVec: number };
}

graphRouter.get(
  '/graph',
  h(async (_req, res) => {
    const shot = await readGraph({});
    const stat = await graphStat();
    const body: GraphResponse = {
      graph: shot.graph,
      stale: shot.stale,
      building: shot.building,
      indexed: stat,
    };
    res.json(body);
  }),
);

/**
 * 重建图谱。
 *
 * 用户显式点「重建」时才走这里。问号在于要不要 await：
 * 首次算 kNN 要十几秒（之后有缓存就毫秒级）。这里是 await 的——
 * 它由人手动触发，界面可以一直转圈；而如果改成后台建，
 * 用户点完看不到任何反馈，反而以为按钮坏了。
 */
graphRouter.post(
  '/graph/rebuild',
  h(async (req, res) => {
    const force = (req.body as { force?: boolean } | undefined)?.force ?? false;
    if (force) await dropGraphCache();
    const graph = await buildGraph({ pool: false });
    res.json({ graph, stat: await graphStat() });
  }),
);
