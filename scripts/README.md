# scripts/ —— 验证脚本与工具

这个目录不是「一堆跑过就算的实验」，而是**回归盘子**：写任何生成类改动之前，先跑一遍。
它对应项目的一条硬规矩 —— **判据必须先在验收集上跑通，才能进管线**。

> 这里只挑了有代表性的十几个脚本。作者本地还有一批一次性诊断脚本（调一棵树、扫一次阈值那种），
> 结论进了设计文档就删掉了；**留下的都是「改判据前必须重跑」的尺子**。

## 跑法

先按 README 起好服务（`npm run dev`），另开一个终端：

```bash
npx tsx scripts/probes/api-smoke.ts        # 大部分探针用 tsx 直跑
node scripts/probes/mcp-smoke.mjs          # .mjs 的直接 node 跑
```

> ⚠️ **大多数探针需要先有一个已配置的笔记库**（没配库时会直接报「还没有选择笔记库」）。
> 想快速试，先把笔记库指向 `examples/sample-library`；部分探针还需要填 AI Key。
> 这些脚本验的是**本机库上的真实行为**，不是脱离数据也能跑的单元测试。

## probes/ —— 离线可复放的验收尺子

| 脚本 | 守的是什么 |
| --- | --- |
| `api-smoke.ts` | **产品最核心的承诺**：批注锚定在原文上，文档被外部编辑器改过之后还能跟住 |
| `split-probe.ts` | 大文档拆分的**块数守恒**。不守恒就 fail closed（红线，宁可拒绝也不静默丢内容） |
| `workspace-smoke.ts` | agent 写区逃逸边界：越界写入一律拒绝 |
| `mcp-smoke.mjs` | MCP 协议回归（手写 stdio JSON-RPC 的兼容性） |
| `cheatsheet-gate-probe.ts` | 覆盖率质量门：源块与生成结果双向对账，不达标的产物不进库 |
| `entry-dedupe-probe.ts` | 条目去重的相似度阈值（dice / coverage 两个旋钮的扫描结果） |
| `thinking-off-probe.ts` | 推理模型「思考」与正文共享输出额度导致的静默截断（见 README 工程实现一节） |
| `math-render-probe.ts` | 数学公式渲染与锚点（KaTeX 按块带锚点） |
| `review-quiz-smoke.ts` | 复习闭环：计划 / 测验 / 闪卡三口径能对上 |
| `probe-concurrency.mjs` | 共享并发原语与全局 AI 并发闸、429 退避的行为 |

## tools/ —— 数据处理

| 脚本 | 用途 |
| --- | --- |
| `reindex.ts` | 重建向量 / 关键词索引 |
| `cheatsheet-coverage.ts` | 统计生成产物对原文的覆盖度（质量门的上游数据） |
| `quiz-bank.ts` | 题库整理（去重、归类、导出） |
| `tree-batch.mjs` | 批量生成知识树（带并发控制） |

## 产物落在哪

探针产物一律落 `.local/`（本机临时区），**不写进 `notes/`** —— 那是用户的笔记库。
