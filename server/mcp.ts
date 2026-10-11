/**
 * server/mcp.ts —— NoteLM MCP server（stdio），给 DSH 等外部 agent 调用。
 *
 * ## 为什么手写协议而不是用官方 SDK
 *   本项目是零依赖栈（express/markdown-it/pdfjs-dist/react/zod）。
 *   MCP 的 stdio 传输就是「按行分隔的 JSON-RPC 2.0」，常用面只有四个方法
 *   （initialize / initialized / tools/list / tools/call），手写 ~80 行换零依赖，
 *   值。协议若有破坏性变更（DSH 还在 developer preview），services 层不变，
 *   只改这一层。
 *
 * ## 工具从哪来（B2-2 起）
 *   **一份实现、两处暴露**：工具本体在 services/agentTools.ts，这里只做
 *   SharedTool → MCP ToolDef 的形状适配。外部 agent 和应用内 agent
 *   （services/libraryAgent.ts）拿到的是同一套 run，行为天然一致。
 *
 * ## 安全边界
 *   写工具有两个：reply_note（批注回复，走 services/notes 服务层落盘，
 *   author 硬编码 'assistant'，只能追加）与 save_web_file（把网络文件经
 *   MinerU 存进库，走 services/docImport 落盘层——只准新增、永不覆盖）。
 *   除这两个入口外全库只读。stdio 子进程由本机拉起，不做 token 鉴权。
 *
 * ## 启动
 *   npx tsx server/mcp.ts
 *   vault root 从 .local/config.json 读（core.getVaultRoot），与 cwd 无关。
 *   DSH 的 MCP 配置见 docs/助手方案-DSH直读.md 附录。
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { ApiError, requireVaultRoot } from './core';
import { sharedTools, type SharedTool } from './services/agentTools';

// ─────────────────────────── 形状适配 ───────────────────────────

interface ToolDef {
  name: string;
  description: string;
  inputSchema: SharedTool['parameters'];
  run: (args: Record<string, unknown>) => Promise<unknown>;
}

function toToolDef(t: SharedTool): ToolDef {
  return { name: t.name, description: t.description, inputSchema: t.parameters, run: t.run };
}

const tools: ToolDef[] = sharedTools().map(toToolDef);

// ─────────────────────────── JSON-RPC / stdio ───────────────────────────

const SERVER_INFO = { name: 'notelm', version: '0.2.0' };

function reply(id: unknown, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}
function replyErr(id: unknown, code: number, message: string): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
}

async function handle(msg: Record<string, unknown>): Promise<void> {
  const { id, method, params } = msg as { id?: unknown; method?: string; params?: Record<string, unknown> };
  if (!method) return;
  // 通知（无 id）不回包
  if (id === undefined || id === null) return;

  if (method === 'initialize') {
    const ver = typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2024-11-05';
    reply(id, { protocolVersion: ver, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    return;
  }
  if (method === 'tools/list') {
    reply(id, {
      tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    });
    return;
  }
  if (method === 'tools/call') {
    const name = typeof params?.name === 'string' ? params.name : '';
    const tool = tools.find((t) => t.name === name);
    if (!tool) {
      replyErr(id, -32602, `未知工具: ${name}`);
      return;
    }
    try {
      const args = (params?.arguments ?? {}) as Record<string, unknown>;
      const result = await tool.run(args);
      reply(id, { content: [{ type: 'text', text: JSON.stringify(result) }] });
    } catch (err) {
      const text = err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err);
      reply(id, { content: [{ type: 'text', text: `错误: ${text}` }], isError: true });
    }
    return;
  }
  if (method === 'ping') {
    reply(id, {});
    return;
  }
  replyErr(id, -32601, `方法不存在: ${method}`);
}

async function main(): Promise<void> {
  await requireVaultRoot(); // 尽早失败：没配置笔记库就该立刻退出
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buf += chunk;
    let at: number;
    while ((at = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, at).trim();
      buf = buf.slice(at + 1);
      if (!line) continue;
      try {
        void handle(JSON.parse(line) as Record<string, unknown>).catch((e) =>
          process.stderr.write(`[mcp] handle 失败: ${e instanceof Error ? e.message : e}\n`),
        );
      } catch {
        process.stderr.write(`[mcp] 无法解析的行: ${line.slice(0, 120)}\n`);
      }
    }
  });
  process.stdin.on('end', () => process.exit(0));
  const here = path.dirname(fileURLToPath(import.meta.url));
  process.stderr.write(`[mcp] notelm MCP 就绪（vault 已配置），工具 ${tools.length} 个（含 reply_note），入口 ${here}\n`);
}

void main().catch((e) => {
  process.stderr.write(`[mcp] 启动失败: ${e instanceof Error ? e.message : e}\n`);
  process.exit(1);
});
