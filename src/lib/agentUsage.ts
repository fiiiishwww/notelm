/**
 * src/lib/agentUsage.ts —— agent 一轮账单的显示逻辑（C 层，2026-09-23）。
 *
 * ★ 为什么单独放一个文件 ★
 *   AgentChatPanel 用它渲染气泡下的账单，store 用它拼批注回复的 toast——
 *   而 store 是 AgentChatPanel 的依赖，把函数留在组件里会形成循环 import。
 *   显示逻辑本来也不该寄生在某个组件里。
 *
 * ★ 别把 promptTokens 当花费 ★
 *   `promptTokens` 是线上原值、**含**缓存命中，而命中那一段是打折的。
 *   所以这里把「未命中 + 命中」分开写；缓存信息缺失（老会话 / 网关不报）
 *   时只报输入总数，**不假装命中率是 0%**——「没测到」不等于「很差」。
 */
import type { AgentUsage } from '../api';

/** 大数显示：12345 → 12.3K。账单是给人扫一眼的，不需要精确到个位。 */
export function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

/** 一轮的账单行：3 次调用 · 输入 4.2K + 命中 3.1K（74%）· 输出 1.4K · 9.1s */
export function usageLine(u: AgentUsage): string {
  const hit = u.cacheReadTokens;
  const miss = hit !== undefined ? Math.max(0, u.promptTokens - hit) : u.promptTokens;
  const input =
    hit !== undefined
      ? `输入 ${fmtTokens(miss)} + 命中 ${fmtTokens(hit)}（${Math.round((hit / Math.max(1, u.promptTokens)) * 100)}%）`
      : `输入 ${fmtTokens(u.promptTokens)}`;
  const reasoning = u.reasoningTokens ? ` · 推理 ${fmtTokens(u.reasoningTokens)}` : '';
  return `${u.calls} 次调用 · ${input} · 输出 ${fmtTokens(u.completionTokens)}${reasoning} · ${(u.ms / 1000).toFixed(1)}s`;
}
