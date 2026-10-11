/**
 * src/components/HistoryPanel.tsx —— 历史（会话 + 复习计划）。
 *
 * ★ 为什么要这个 ★
 *   之前有 148 个会话文件、`review-plan.json` 里存着 30 版计划，
 *   **但界面上一个地方都翻不到**。她问「之前排的计划呢」「上次我们聊了什么」，
 *   只能去 `notes/.notebook/` 里手翻——这等于没有。
 *
 * ★ 两个来源★
 *   · 会话：小笔的 M3 留痕（`/agent/sessions`），每条有首问 / 步数 / token / 停止原因
 *   · 计划：`review-plan.json` 的 history（append-only 快照，最近的在最前）
 *   ★ 计划这一栏的意义：它是她唯一能问「为什么今天是这个」的地方。
 *   小笔说了什么会消失，但「它当时为什么这么排」留下来了 —— 那是能复盘、能反驳的东西。
 */

import { useEffect, useState } from 'react';
import { api, errorText } from '../api';
import { Modal } from './Dialog';

interface SessionRow {
  id: string;
  startedAt?: string;
  prompt?: string;
  steps?: number;
  stop?: string;
  usage?: { promptTokens?: number; completionTokens?: number };
}

interface PlanRow {
  seq: number;
  date: string;
  plannedBy: string;
  rationale: string;
  count: number;
  at: string;
  isCurrent: boolean;
}

export function HistoryPanel({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<'plan' | 'sessions'>('plan');
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [plans, setPlans] = useState<PlanRow[] | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    let alive = true;
    void api
      .agentSessions(40)
      .then((r) => {
        if (alive) setSessions(r.sessions ?? []);
      })
      .catch((e) => {
        if (alive) setErr(errorText(e));
      });
    void api
      .reviewPlanHistory()
      .then((r) => {
        if (alive) setPlans(r.history ?? []);
      })
      .catch((e) => {
        if (alive) setErr(errorText(e));
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <Modal title="历史" onClose={onClose} width={640}>
      <div className="hist-tabs">
        <button className={tab === 'plan' ? 'on' : ''} onClick={() => setTab('plan')}>
          复习计划
        </button>
        <button className={tab === 'sessions' ? 'on' : ''} onClick={() => setTab('sessions')}>
          和小笔的对话
        </button>
      </div>

      {err ? <div className="rv-warn">{err}</div> : null}

      {tab === 'plan' ? (
        plans === null ? (
          <div className="today-empty">正在读…</div>
        ) : plans.length === 0 ? (
          <div className="today-empty">还没有排过计划。跟小笔说「今天复习什么」。</div>
        ) : (
          <>
            <p className="rv-hint" style={{ textAlign: 'left', marginBottom: 10 }}>
              「小笔排的」与「你改过的」分开标 —— 你要能看出哪一条是自己动过的。
            </p>
            <ul className="hist-list">
              {plans.map((p) => (
                <li key={`${p.seq}-${p.at}`} className={p.isCurrent ? 'cur' : ''}>
                  <div className="hist-row">
                    <span className="hist-date">{p.date}</span>
                    <span className={`hist-by ${p.plannedBy === '小笔' ? 'agent' : 'her'}`}>{p.plannedBy}</span>
                    <span className="hist-count">{p.count} 题</span>
                    {p.isCurrent ? <span className="hist-tag">当前</span> : null}
                    <span className="hist-time">{p.at.slice(0, 16).replace('T', ' ')}</span>
                  </div>
                  {p.rationale ? <div className="hist-why">{p.rationale}</div> : null}
                </li>
              ))}
            </ul>
          </>
        )
      ) : sessions === null ? (
        <div className="today-empty">正在读…</div>
      ) : sessions.length === 0 ? (
        <div className="today-empty">还没有会话记录。</div>
      ) : (
        <>
          <p className="rv-hint" style={{ textAlign: 'left', marginBottom: 10 }}>
            每条只存首问与结果（省 token）—— 想看完整对话，问小笔「上次我们聊到哪」，
            它有 <code>recall_sessions</code> 可以取回那一轮的全文。
          </p>
          <ul className="hist-list">
            {sessions.map((s) => (
              <li key={s.id}>
                <div className="hist-row">
                  <span className="hist-date">{(s.startedAt ?? '').slice(0, 10)}</span>
                  <span className="hist-count">{s.steps ?? 0} 步</span>
                  <span className="hist-time">
                    {((s.usage?.promptTokens ?? 0) + (s.usage?.completionTokens ?? 0)).toLocaleString()} token
                  </span>
                </div>
                <div className="hist-why">{s.prompt ?? '（无首问）'}</div>
                {s.stop && s.stop !== 'answer' ? <div className="hist-stop">停在：{s.stop}</div> : null}
              </li>
            ))}
          </ul>
        </>
      )}
    </Modal>
  );
}