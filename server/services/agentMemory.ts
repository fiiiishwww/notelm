/**
 * server/services/agentMemory.ts —— M3 情景记忆 = 会话留痕（B3，2026-09-22）。
 *
 * ★ 它是什么 ★
 *   `notes/.notebook/agent/sessions/*.json`：agent 每跑一轮就追加一条记录——
 *   干了什么（task）、用了哪些工具、结论是什么、她有没有当场纠正。
 *
 * ★ 写入纪律（方案里定死的）★
 *   - **ADD-only**：只追加新文件，绝不覆盖/删除旧记录（Mem0 的做法——历史始终
 *     可审计，冲突靠检索时的时间排序解决）。
 *   - **唯一 agent 可自由写的记忆层**——但只写自己的会话；不进偏好投影、
 *     不进 learning.json（M2 只聚合她本人的信号）。
 *   - 一轮一个文件：`<时间戳>-<taskId>.json`，天然按时间排序。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR_NAME, requireVaultRoot } from '../core';
import { makeId } from '../../shared/text';
import type { RunResult } from './agentRuntime';

export interface AgentSession {
  id: string;
  at: string;
  /** 这轮在干什么：'answer_note' = 回答批注（后续任务类型在这里扩） */
  task: string;
  /** 任务定位信息（按任务类型含义不同） */
  ref?: Record<string, unknown>;
  /** 她的原话/问题（写入层不截断：截断是读取层的事） */
  question?: string;
  /** agent 的最终回答（写入层不截断） */
  answer?: string;
  /**
   * 逐步轨迹（主流做法：存储层=追加式全量日志，LangSmith/Letta 同思路）。
   * 与 agentRuntime.RunStep 对齐；input/output 运行时已做长度预算，直接透传。
   * 2026-09-23 补全：此前只存 {name, failed}，过程轨迹当轮蒸发、跨轮不可回放。
   */
  steps?: AgentSessionStep[];
  /** 结论是否落盘成功（answer_note：回复写进批注了吗） */
  resolved: boolean;
  /** 工具调用流水（紧凑：名字 + 是否失败） */
  tools: { name: string; failed?: boolean }[];
  stop: RunResult['stop'];
  usage: RunResult['usage'];
  /**
   * 状态标注：'done' 完成 / 'followup' 未完成待接着做 / 'preference' 她确认过的偏好。
   * 写入时自动判 done/followup；'preference' 目前只有她确认后由系统标（agent 不得自封）。
   */
  status: 'done' | 'followup' | 'preference';
}

/** 单步轨迹：与 agentRuntime.RunStep 对齐（input/output 运行时已截断，直接存）。 */
export interface AgentSessionStep {
  at: string;
  kind: string;
  label: string;
  ms: number;
  input?: string;
  output?: string;
  failed?: boolean;
}

const sessionsDir = async (): Promise<string> => {  const root = await requireVaultRoot();
  const dir = path.join(root, DATA_DIR_NAME, 'agent', 'sessions');
  await fs.mkdir(dir, { recursive: true });
  return dir;
};

/** 追加一轮会话记录（不覆盖任何已有文件）。 */
export async function appendSession(s: Omit<AgentSession, 'id' | 'at' | 'status'>): Promise<AgentSession> {
  const rec: AgentSession = {
    id: makeId('ses'),
    at: new Date().toISOString(),
    status: s.resolved ? 'done' : 'followup',
    ...s,
  };
  const stamp = rec.at.replace(/[:.]/g, '-');
  const file = path.join(await sessionsDir(), `${stamp}-${rec.id}.json`);
  await fs.writeFile(file, JSON.stringify(rec, null, 2), 'utf8');
  return rec;
}

/** 按时间倒序取最近的会话记录。 */
export async function listSessions(limit = 20): Promise<AgentSession[]> {
  const dir = await sessionsDir();
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json')).sort().reverse();
  const out: AgentSession[] = [];
  for (const f of files) {
    if (out.length >= limit) break;
    try {
      out.push(JSON.parse(await fs.readFile(path.join(dir, f), 'utf8')) as AgentSession);
    } catch {
      /* 单个文件损坏不挡整体 */
    }
  }
  return out;
}

/** 注入 agent 首轮 context 的会话记忆（紧凑）：未完成的事 + 最近几轮干了什么。 */
export async function sessionBrief(limit = 5): Promise<string> {
  const sessions = await listSessions(30);
  if (!sessions.length) return '';
  const followups = sessions.filter((s) => s.status === 'followup').slice(0, 3);
  const recent = sessions.slice(0, limit);
  const lines: string[] = [];
  if (followups.length) {
    lines.push('上次没做完的事（优先接着做）：');
    for (const s of followups) {
      lines.push(`- [${s.at.slice(0, 10)}] ${s.task}：${(s.question ?? s.answer ?? '').slice(0, 60)}`);
    }
  }
  lines.push('最近几轮你（助手）做过的事：');
  for (const s of recent) {
    lines.push(`- [${s.at.slice(0, 10)}] ${s.task}${s.ref?.doc ? `（${String(s.ref.doc)}）` : ''}：${(s.answer ?? s.question ?? '').slice(0, 50)}${s.resolved ? '' : '（未完成）'}`);
  }
  return lines.join('\n');
}
