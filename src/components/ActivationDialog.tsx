/**
 * src/components/ActivationDialog.tsx —— 「记忆激活」的入口与待确认清单。
 *
 * ★ 为什么这个面板必须能「关掉再打开还在」★
 *   一次激活要跑 4 分钟左右（实测 13 次模型调用 / 31 次工具调用），
 *   不可能让人盯着进度条等。所以会话在服务端落盘（.notebook/activation/<id>.json），
 *   前端只负责轮询——关掉弹层、甚至重启应用，回来还是同一个会话、同一批待确认的卡。
 *
 * ★ 为什么要人工确认，不直接入库 ★
 *   卡片一旦进了复习队列，就会按 SM-2 在未来几个月里反复出现。
 *   一张坏卡不是「看一眼关掉」就完了，而是会持续打扰。
 *   所以第一版一律走待确认，等坏卡率压到足够低再考虑自动写。
 *
 * ★ 面板上刻意展示的东西 ★
 *   每张卡都带判据结论（哪条没过、为什么）。这不是给用户添堵，
 *   而是让「机器的判断」和「人的判断」摆在同一个界面上——
 *   机器判过但你划掉 = 判据有漏；机器判不过但你勾了 = 判据太严。
 *   这两类分歧积累起来，就是调判据阈值的真实依据。
 */

import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../state/store';
import { api, errorText, type ActivationCandidate, type ActivationSession } from '../api';
import { Modal } from './Dialog';
import { Warning } from './Icons';

/** 判据 id → 中文说明。后端返回的是英文 id，直接显示没人看得懂。 */
const CHECK_LABEL: Record<string, string> = {
  quote: '引文可定位',
  grounded: '说法有出处',
  selfContained: '答案对得上问题',
  noDuplicate: '和已有卡不重复',
  atomic: '一张卡只问一件事',
  notCopy: '不是原文照搬',
};

/** 硬判据：不过就不能要。软判据：只是提醒。 */
const HARD = new Set(['quote', 'grounded', 'noDuplicate']);

export function ActivationDialog({ communityId, onClose }: { communityId: number; onClose: () => void }) {
  const { actions } = useApp();
  const [session, setSession] = useState<ActivationSession | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 用户在本面板上的勾选；null 表示沿用会话里已保存的状态 */
  const [picked, setPicked] = useState<Record<string, boolean>>({});

  const loadLatest = useCallback(async () => {
    try {
      const r = await api.activationLatest(communityId);
      setSession(r.session);
      setErr(null);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setLoaded(true);
    }
  }, [communityId]);

  useEffect(() => {
    void loadLatest();
  }, [loadLatest]);

  // 跑的过程中每 2 秒拉一次。agent 每走一步都会写盘，所以这里看到的 steps 是实时的
  useEffect(() => {
    if (!session || session.status !== 'running') return;
    const t = window.setInterval(async () => {
      try {
        const r = await api.activationGet(session.id);
        setSession(r.session);
        if (r.session.status !== 'running' && !r.running) window.clearInterval(t);
      } catch {
        /* 轮询失败不打扰用户，下一轮再来 */
      }
    }, 2000);
    return () => window.clearInterval(t);
  }, [session?.id, session?.status]);

  const start = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.activationStart(communityId);
      setSession(r.session);
      setPicked({});
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!session) return;
    const decided = session.candidates.map((c) => ({
      id: c.id,
      accepted: picked[c.id] ?? c.accepted ?? false,
    }));
    setBusy(true);
    try {
      await api.activationDecide(session.id, decided);
      const r = await api.activationApply(session.id);
      setSession(r.session);
      actions.toast('ok', `已写入 ${r.written} 张卡片${r.failed.length ? `，${r.failed.length} 篇失败` : ''}`);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const drop = async () => {
    if (!session) return;
    setBusy(true);
    try {
      await api.activationDrop(session.id);
      setSession(null);
      setPicked({});
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const nPicked = session
    ? session.candidates.filter((c) => (picked[c.id] ?? c.accepted) === true).length
    : 0;

  return (
    <Modal
      title={`记忆激活 · 主题团 ${communityId}`}
      onClose={onClose}
      width={760}
      footer={
        <>
          <span className="hint" style={{ flex: 1, textAlign: 'left' }}>
            {session?.status === 'applied'
              ? '这批卡已经进了复习队列。'
              : '勾选想要的，写入后可在「学习」里复习。'}
          </span>
          {session && session.status !== 'running' ? (
            <button className="btn ghost" disabled={busy} onClick={() => void drop()}>
              丢弃这次结果
            </button>
          ) : null}
          <button
            className="btn primary"
            disabled={busy || !session || session.status === 'running' || nPicked === 0}
            onClick={() => void apply()}
          >
            {busy ? <span className="spinner" /> : null} 写入 {nPicked} 张卡
          </button>
        </>
      }
    >
      {!loaded ? (
        <div className="empty" style={{ padding: '40px 0' }}>
          <span className="spinner" style={{ width: 18, height: 18 }} />
        </div>
      ) : err ? (
        <div className="banner error">
          <Warning width={14} height={14} />
          <span>{err}</span>
        </div>
      ) : !session || session.status === 'abandoned' ? (
        <Intro
          communityId={communityId}
          busy={busy}
          hadBefore={!!session}
          onStart={() => void start()}
        />
      ) : session.status === 'running' ? (
        <Running session={session} />
      ) : session.status === 'applied' ? (
        <Applied session={session} />
      ) : (
        <Review session={session} picked={picked} setPicked={setPicked} />
      )}
    </Modal>
  );
}

// ─────────────────── 没有会话：先说清楚要花什么代价 ───────────────────

function Intro({
  communityId,
  busy,
  hadBefore,
  onStart,
}: {
  communityId: number;
  busy: boolean;
  hadBefore: boolean;
  onStart: () => void;
}) {
  return (
    <div className="act-intro">
      <p>
        让 agent 通读主题团 {communityId} 的笔记，找出<strong>重要但你还没记下来</strong>的概念，
        为它们生成可复习的闪卡。
      </p>
      <ul className="act-points">
        <li>它会自己决定读哪几篇、提炼哪些概念、为哪些概念出卡</li>
        <li>每张卡都会过六条判据（引文能不能定位、说法有没有出处、是不是重复……），不合格的会被自己改掉</li>
        <li>
          <strong>卡不会直接进复习队列</strong>——生成完先摆在这里等你逐张点头
        </li>
      </ul>
      <div className="banner warn">
        <Warning width={14} height={14} />
        <span>
          一次大约要 3 到 5 分钟、十几万 token。要不要花钱由你决定，中途关掉窗口不会中断它（结果会存下来）。
        </span>
      </div>
      {hadBefore ? <p className="hint">上一次的会话没有产出可用卡片。</p> : null}
      <button className="btn primary" disabled={busy} onClick={onStart}>
        {busy ? <span className="spinner" /> : null} 开始激活
      </button>
    </div>
  );
}

// ─────────────────── 进行中：把 agent 的每一步摆出来 ───────────────────

function Running({ session }: { session: ActivationSession }) {
  const steps = session.steps.slice(-12);
  return (
    <div className="act-running">
      <div className="act-sum">
        <span className="spinner" style={{ width: 12, height: 12 }} /> 正在跑：已经走了 {session.steps.length} 步
        {session.candidates.length ? ` · 已提交 ${session.candidates.length} 张卡` : ''}
      </div>
      <p className="hint">
        可以随时关掉这个窗口，agent 会在服务端继续跑，回来时结果还在。
      </p>
      <div className="act-steps">
        {steps.map((s, i) => (
          <div className="act-step" key={i}>
            <span className={`act-step-kind ${s.kind}`}>
              {s.kind === 'tool' ? '工具' : s.kind === 'model' ? '模型' : s.kind === 'error' ? '出错' : '停止'}
            </span>
            <span className="act-step-label ellipsis">{s.summary}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────── 待确认 ───────────────────

function Review({
  session,
  picked,
  setPicked,
}: {
  session: ActivationSession;
  picked: Record<string, boolean>;
  setPicked: (v: Record<string, boolean>) => void;
}) {
  const all = session.candidates.length;
  const on = session.candidates.filter((c) => (picked[c.id] ?? c.accepted) === true).length;
  const setAll = (v: boolean) => {
    const next: Record<string, boolean> = { ...picked };
    for (const c of session.candidates) next[c.id] = v;
    setPicked(next);
  };

  return (
    <div className="act-review">
      <div className="act-review-head">
        <span>
          找到 <strong>{all}</strong> 张候选卡
        </span>
        <span style={{ flex: 1 }} />
        <button className="link-btn" onClick={() => setAll(true)}>
          全选
        </button>
        <button className="link-btn" onClick={() => setAll(false)}>
          全不选
        </button>
        <span className="hint">已选 {on}</span>
      </div>
      {session.usage ? (
        <div className="act-sum">
          消耗 {session.usage.promptTokens + session.usage.completionTokens} token ·{' '}
          {Math.round(session.usage.ms / 1000)} 秒 · {session.steps.length} 步
        </div>
      ) : null}
      {session.candidates.map((c) => (
        <CandidateRow
          key={c.id}
          c={c}
          checked={(picked[c.id] ?? c.accepted) === true}
          onChange={(v) => setPicked({ ...picked, [c.id]: v })}
        />
      ))}
    </div>
  );
}

function CandidateRow({
  c,
  checked,
  onChange,
}: {
  c: ActivationCandidate;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  const failed = Object.entries(c.checks).filter(([, v]) => !v);
  const hardFailed = failed.filter(([k]) => HARD.has(k));

  return (
    <div className={`act-cand${checked ? ' on' : ''}`}>
      <label className="act-pick">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      </label>
      <div className="act-cand-body">
        <div className="act-concept">{c.concept}</div>
        <div className="act-q">问：{c.front}</div>
        <div className="act-a">答：{c.back}</div>
        <div className="act-quote">引：{c.quote}</div>
        <div className="act-checks">
          {failed.length === 0 ? (
            <span className="tag-chip">六条判据全过</span>
          ) : (
            failed.map(([k]) => (
              <span key={k} className={`tag-chip${hardFailed.some(([x]) => x === k) ? ' warn' : ''}`}>
                {CHECK_LABEL[k] ?? k}：未过
              </span>
            ))
          )}
          <span className="hint" style={{ marginLeft: 'auto' }}>
            {c.docRel.replace(/^.*\//, '')}
          </span>
        </div>
      </div>
    </div>
  );
}

// ─────────────────── 已写入 ───────────────────

function Applied({ session }: { session: ActivationSession }) {
  const n = session.candidates.filter((c) => c.accepted === true).length;
  return (
    <div className="act-intro">
      <p>
        已写入 <strong>{n}</strong> 张卡片，可以在「学习」里开始复习了。
      </p>
      {session.usage ? (
        <div className="act-sum">
          这次消耗 {session.usage.promptTokens + session.usage.completionTokens} token ·{' '}
          {Math.round(session.usage.ms / 1000)} 秒
        </div>
      ) : null}
      <div className="act-steps">
        {session.candidates
          .filter((c) => c.accepted)
          .map((c) => (
            <div className="act-step" key={c.id}>
              <span className="act-step-kind tool">已存</span>
              <span className="act-step-label ellipsis">{c.front}</span>
            </div>
          ))}
      </div>
      <p className="hint">想再来一次就点「丢弃这次结果」，会回到开始界面。</p>
    </div>
  );
}
