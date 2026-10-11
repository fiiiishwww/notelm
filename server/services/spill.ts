/**
 * server/services/spill.ts —— 工具结果溢出层（对标 DSH 的 dsh-spill / spill-policy）。
 *
 * ★ 解决什么问题 ★
 *   read_doc 大区间、run_code 大输出会原样进模型上下文。实测一次论文转换轮
 *   烧掉 96K prompt token，大头就是工具结果堆积。溢出策略：超过阈值的结果
 *   全文落盘（留档可审计），上下文里只留「头 + 尾 + 全文路径」——
 *   模型要细节时有两条正路：换更窄的参数重新查，或用 run_code 读落盘文件。
 *
 * ★ 为什么落盘而不是直接丢弃 ★
 *   丢弃（compaction-only）省得最狠但模型可能丢结论；落盘保留了完整过程，
 *   她随时能审计 agent 那一轮到底看到了什么——这和 M3 的全量留痕是同一哲学。
 */

import fs from 'fs/promises';
import path from 'path';
import { resolveInVault } from '../security';

/** 超过这个字符数的结果触发溢出。2.7K 字符 ≈ 1.5K token，单条结果的安全水位。 */
const SPILL_THRESHOLD = 2700;

/**
 * 记忆类工具豁免（2026-09-23 加，实测换来的）。
 *
 * ★ 为什么必须豁免 ★
 *   2026-09-23 下午三轮失败复盘：8 次「回读自己的存档」的浪费步，**全部**发生在
 *   recall_sessions 的溢出文件上，read_doc / run_code / search 的 12 次溢出零回读。
 *   原因很直白——这些工具的输出是**agent 记忆本身**，砍成「头+尾」之后信息结构被破坏
 *   （JSON 中间断了），它只能花步数去读落盘原文，反而烧掉稀缺的步数预算。
 *   普通工具（大段原文、脚本输出）没有这个语义，溢出继续适用。
 *
 * 注：recall_sessions 的输出尺寸本身偏大（含审计轨迹），形态改造在探针之后单独做。
 */
export const MEMORY_TOOL_NAMES = new Set(['recall_sessions', 'learning_status', 'annotations', 'feedback_digest']);

/** 溢出后上下文里保留的头/尾字符数。 */
const PREVIEW_HEAD = 2000;
const PREVIEW_TAIL = 400;

/**
 * 按工具的溢出参数覆盖（2026-09-23 加，web_fetch 带来的）。
 *
 * ★ 为什么 web_fetch 要单独一档 ★
 *   默认档（2700 触发、只留头 2000 + 尾 400）是为**库内查询**调的：库内结果
 *   砍了之后有明确的补救路径——换个更窄的参数（块区间/检索词）再查一次，
 *   成本一步。网页没有这条路：她让 agent 查的那个 URL 就是唯一入口，
 *   头 2000 字通常只够读到导航和标题，把正文砍掉等于这次抓取白做。
 *   所以 web_fetch 自己先把正文收敛在 12,000 字符（超出部分另存全文并告知路径），
 *   这里的上限设得比它高——**正常情况下不触发**，只在环境变量把工具上限
 *   调得很大时兜底，不让它把上下文灌爆。
 */
const TOOL_LIMITS: Record<string, { limit: number; head: number; tail: number }> = {
  web_fetch: { limit: 16_000, head: 16_000, tail: 0 },
};

/**
 * 把全文写进 spill 目录，返回库内相对路径（失败返回 null）。
 *
 * ★ 为什么抽出来导出 ★
 *   webTools 需要在「工具自己就有完整全文」时主动留档（正文超上限，
 *   被截断进上下文的那份不是全文），走的必须是和溢出同一条目录约定——
 *   否则她审计时要在两个地方翻。
 */
export async function writeSpill(toolName: string, text: string): Promise<string | null> {
  const day = new Date().toISOString().slice(0, 10);
  // 工具名只留安全字符，防止拼路径出幺蛾子
  const safeName = toolName.replace(/[^a-zA-Z0-9_-]/g, '_') || 'tool';
  const relDir = `.assistant/agent/spill/${day}`;
  const fileName = `${new Date().toISOString().replace(/[:.]/g, '-')}-${safeName}.txt`;
  try {
    const absDir = await resolveInVault(relDir);
    await fs.mkdir(absDir, { recursive: true });
    await fs.writeFile(path.join(absDir, fileName), text, 'utf8');
    return `${relDir}/${fileName}`;
  } catch {
    return null;
  }
}

/** 工具结果进上下文前的统一变换。小的原样通过，大的溢出落盘。 */
export async function spillIfLarge(toolName: string, text: string): Promise<string> {
  if (!text) return text;
  if (MEMORY_TOOL_NAMES.has(toolName)) return text;
  const cfg = TOOL_LIMITS[toolName] ?? { limit: SPILL_THRESHOLD, head: PREVIEW_HEAD, tail: PREVIEW_TAIL };
  if (text.length <= cfg.limit) return text;

  const rel = await writeSpill(toolName, text);
  if (!rel) {
    // 溢出写盘失败不该炸工具调用：退化为直接截断，保底不灌爆上下文
    return `${text.slice(0, cfg.head)}…（结果过长且落盘失败，已截断）`;
  }

  const omitted = text.length - cfg.head - cfg.tail;
  return (
    text.slice(0, cfg.head) +
    `\n…（中间省略 ${omitted} 字符）…\n` +
    (cfg.tail > 0 ? text.slice(-cfg.tail) : '') +
    `\n\n[溢出] 本次结果共 ${text.length} 字符，全文已存到库内 ${rel}。` +
    '要细节：用更窄的参数重新查询，或用 run_code 读这个文件。不要原样重复上一次调用。'
  );
}
