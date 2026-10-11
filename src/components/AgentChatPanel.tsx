/**
 * AgentChatPanel —— 库内 agent 的直接对话面板（2026-09-22 起）。
 *
 * ★ DSH 撤下，换自建 agent ★
 *   以前这里是 iframe 装 DSH Web UI；现在 BottomDock 的「AI 助手」直接聊
 *   库内的 agent（server/services/libraryAgent.chatWithAgent）：
 *     - 工具层与批注回复 / MCP 是同一份（agentTools.ts）；
 *     - 它调的是你的笔记库，不是上传（数据不出库）；
 *     - AssistantPanel（DSH）代码保留未删，要回滚换回来即可。
 *
 * ★ 2026-10-08：不再是「每轮无状态」★
 *   以前历史全靠前端带回、服务端只留一轮 M3 摘要，所以「清空」= 真丢。
 *   现在有会话层（`server/services/chatThreads.ts`，结构照搬 DSH 的 session
 *   controller，存储落在 `notes/.notebook/agent/threads/`）：
 *     - **以文档为单位挂会话**（docRel = DSH 的 workspace）；
 *     - **「清空」= 新建一条**——旧的仍在列表里，随时点回来（后台不清）；
 *     - 每轮的问与答都追加进 `<id>.jsonl`，崩了也不丢已说过的话。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
  type AgentApproval,
  type AgentApprovalEvent,
  type AgentChatStepEvent,
  type AgentNudge,
  type AgentUsage,
  type ChatThreadMeta,
  type TreeNode,
} from '../api';
import { useApp } from '../state/store';

interface Turn {
  role: 'user' | 'assistant';
  content: string;
  /** 助手轮的渲染版（服务端 createMd 产出 + ¶块号已织成 .agent-ref）。 */
  html?: string;
  /** 这一轮的账单（服务端 tokenMeter 归一化后的用量），只用于展示 */
  usage?: AgentUsage;
}

/** 确认卡的本地状态：pending 时可点，其余是结果。 */
type ApprovalCard = AgentApproval & { state: 'pending' | 'approved' | 'rejected' | 'timeout'; by?: string };

/** 工具名 → 给她看的动词。没进表的工具退回工具名本身。 */
const TOOL_VERB: Record<string, string> = {
  search: '检索',
  read_doc: '读文档',
  concepts: '查概念库',
  graph_neighbors: '查概念关系',
  learning_status: '看你的学习状态',
  recall_sessions: '回忆过往会话',
  feedback_digest: '汇总你的批注',
  annotations: '看批注',
  reply_note: '写回复',
  write_workspace: '记进自己的工作区',
  run_code: '写代码算',
  remember: '记进长期记忆',
  web_fetch: '读网页',
  web_search: '联网搜索',
  save_web_file: '存进知识库',
  feedback_review: '审查你的反馈',
  feedback_apply: '执行反馈修订',
  edit_library: '请求改库（等你确认）',
  cheatsheet: '看知识树',
};

/** 一轮的账单行（C 层）：次数 / 输入（+缓存命中）/ 输出 / 耗时。实现见 lib/agentUsage。 */
import { usageLine, fmtTokens } from '../lib/agentUsage';

/** 工具步骤的一句人话：动词 + 关键入参（如检索词 / 文档名）+ 耗时。（NotePanel 批注轨迹也用它） */
export function stepText(s: AgentChatStepEvent): string {
  if (s.kind === 'error') return `✗ ${s.label}`;
  if (s.kind === 'stop') return s.label;
  if (s.kind === 'model') return s.label.includes('给出') ? '组织答案' : ''; // 「要求调用 X」由工具行自己表达
  const verb = TOOL_VERB[s.label] ?? s.label;
  let arg = '';
  if (s.input) {
    try {
      const o = JSON.parse(s.input) as Record<string, unknown>;
      // url（web_fetch 的入参）与 queries 数组（web_search 的入参）也认，
      // 否则联网那几步只显示「读网页」而她看不出读的是哪个地址。
      const v = o.q ?? o.query ?? o.rel ?? o.doc ?? o.name ?? o.key ?? o.url;
      if (typeof v === 'string') arg = `「${v.length > 24 ? `${v.slice(0, 24)}…` : v}」`;
      else if (Array.isArray(o.queries) && typeof o.queries[0] === 'string') {
        const first = o.queries[0];
        arg = `「${first.length > 24 ? `${first.slice(0, 24)}…` : first}」`;
        if (o.queries.length > 1) arg += ` 等 ${o.queries.length} 条`;
      }
    } catch {
      /* 入参不是 JSON 就不显示细节 */
    }
  }
  const secs = s.ms ? ` ${(s.ms / 1000).toFixed(1)}s` : '';
  return `${verb}${arg}${secs}`;
}

/** 事件间隔里的「它此刻在干嘛」：按最后一个已完成事件推断。 */
function nowDoing(live: AgentChatStepEvent[]): string {
  const last = live[live.length - 1];
  if (!last) return '正在思考…';
  if (last.kind === 'tool' || last.kind === 'error') return '正在思考…';
  if (last.kind === 'model') return last.label.includes('给出') ? '组织答案…' : '正在查资料…';
  return '正在收尾…';
}

/**
 * 确认卡的状态文案。
 * ★ 结果必须说清「库到底有没有被动过」——她最关心的就是这个，别只给个「已拒绝」。
 */
function approvalStateLabel(a: ApprovalCard): string {
  if (a.state === 'pending') return '等你决定';
  if (a.state === 'approved') return '已批准';
  if (a.state === 'timeout') return '超时没等到你 · 库没动';
  return '你拒绝了 · 库没动';
}

/** 会话列表里的相对时间：「刚刚 / 12 分钟前 / 昨天 / 10-05」。 */
function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const d = Date.now() - t;
  if (d < 60_000) return '刚刚';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} 分钟前`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} 小时前`;
  if (d < 172_800_000) return '昨天';
  return iso.slice(5, 10);
}

const GREETING: Turn = {
  role: 'assistant',
  content:
    '我在。这个面板直接对话的是你笔记库里的 agent——可以问我「我学到哪了」「X 和 Y 什么关系」，也可以让我查原文、讲概念。',
};

export function AgentChatPanel(props: {
  /** 小笔主动开口（C）：BottomDock 拉取后传进来，有话就在列表顶上冒一句。 */
  nudge?: AgentNudge | null;
  /** 忽略 / 已继续聊后通知 BottomDock 消点。 */
  onNudgeDismiss?: () => void;
} = {}): React.JSX.Element {
  const { state, actions } = useApp();
  const [turns, setTurns] = useState<Turn[]>([GREETING]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 本轮 agent 的实时步骤轨迹（每步完成时由流式事件推进）。 */
  const [live, setLive] = useState<AgentChatStepEvent[]>([]);
  /**
   * 本轮的确认卡（写工具挂起等她在界面上点批准，2026-09-24）。
   * 她点按钮后本地立刻置态（不等服务端回执），流结束不清理——
   * 她得能看到「刚才批准/拒绝了什么」。
   */
  const [approvals, setApprovals] = useState<ApprovalCard[]>([]);
  const [expanded, setExpanded] = useState(false);
  /** 近 7 天总账（C 层）：打开面板时拉一次，让她知道这个月大概烧了多少、命中多少。 */
  const [stats, setStats] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  /** 本轮是否存过文件进库（save_web_file）——流结束后刷新左栏目录树。 */
  const savedTreeRef = useRef(false);

  // ── 会话层（2026-10-08）─────────────────────────────────────────
  // ★ 她的预期：可以新建、可以清空，但**后台不清**，以文档为单位挂会话。
  //   落地方式照 DSH：**「清空」= 新建一条**，旧的留在列表里随时翻回去。
  const [threadId, setThreadId] = useState<string | null>(null);
  const [threadTitle, setThreadTitle] = useState<string>('新对话');
  const [threads, setThreads] = useState<ChatThreadMeta[]>([]);
  const [showThreads, setShowThreads] = useState(false);

  const docRel = state.doc?.path;

  /** 拉当前文档的会话列表（+ 全局的）。切文档会重拉。 */
  const loadThreads = useCallback(async (): Promise<void> => {
    try {
      const r = await api.threadsList(docRel, 'doc', 40);
      setThreads(r.threads);
    } catch {
      setThreads([]); // 列表拉不到不影响聊天
    }
  }, [docRel]);

  useEffect(() => {
    void loadThreads();
  }, [loadThreads]);

  /**
   * 新建会话 —— 这就是「清空」。
   * 旧的还在列表里（后台不清），这里只是把界面指向一条新的空会话。
   */
  const newThread = useCallback(async (): Promise<void> => {
    try {
      const r = await api.threadsCreate(docRel);
      setThreadId(r.thread.id);
      setThreadTitle(r.thread.title);
    } catch {
      setThreadId(null); // 建不了也能聊，只是这一轮不进历史
      setThreadTitle('新对话');
    }
    setTurns([GREETING]);
    setError(null);
    setShowThreads(false);
    void loadThreads();
  }, [docRel, loadThreads]);

  /** 打开一条已有会话：把历史读回来。 */
  const openThread = useCallback(async (id: string): Promise<void> => {
    try {
      const r = await api.threadsRead(id);
      setThreadId(id);
      setThreadTitle(r.meta.title);
      setTurns(
        r.turns.length
          ? r.turns.map((t) => ({ role: t.role, content: t.content }))
          : [GREETING],
      );
      setError(null);
      setShowThreads(false);
    } catch {
      setError('这条会话读不出来，可能已经不在了。');
    }
  }, []);

  const loadStats = useCallback(async (): Promise<void> => {
    try {
      const s = await api.agentStats(7);
      if (!s.sessions) {
        setStats(null);
        return;
      }
      const hit = s.hitRate === null ? '' : ` · 缓存命中 ${Math.round(s.hitRate * 100)}%`;
      setStats(`近 7 天 ${s.sessions} 轮 · ${fmtTokens(s.promptTokens + s.completionTokens)} token${hit}`);
    } catch {
      setStats(null); // 统计拉不到不影响聊天
    }
  }, []);

  // busy 从 true 变 false 时刷新——刚跑完的那轮账单立刻进总账
  useEffect(() => {
    if (!busy) void loadStats();
  }, [busy, loadStats]);

  /** 把 agent 提到的文件名（"chapter2.md" / "chapter1" / "jly/chapter2.md"）解析成库内 relPath。 */
  const resolveDoc = useCallback(
    (name: string): string | null => {
      const base = name.replace(/\.(md|markdown|txt)$/i, '');
      let hit: string | null = null;
      const walk = (n: TreeNode): void => {
        if (n.type === 'doc') {
          const bn = n.name.replace(/\.(md|markdown|txt)$/i, '');
          if (
            n.relPath === name ||
            n.relPath.endsWith(`/${name}`) ||
            n.name === name ||
            bn === base
          ) {
            hit = n.relPath;
          }
        }
        for (const c of n.children ?? []) walk(c);
      };
      walk(state.tree ?? { type: 'dir', name: 'notes', relPath: '', mtime: 0, size: 0, children: [] });
      return hit;
    },
    [state.tree],
  );

  /** 点 ¶块号 引用：data-doc 解析得到就跨文档；解析不到（agent 写的是普通词）回退当前文档。 */
  const onRefClick = (e: React.MouseEvent<HTMLElement>): void => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('.agent-ref');
    if (!el) return;
    const bi = Number(el.dataset.bi);
    if (!Number.isFinite(bi)) return;
    const docName = el.dataset.doc;
    const rel = (docName ? resolveDoc(docName) : null) ?? docRel ?? null;
    if (!rel) return;
    actions.requestJump(rel, bi);
    if (rel !== docRel) void actions.openDoc(rel);
  };

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, busy]);

  /**
   * 她在确认卡上点了批准/拒绝。
   * 本地**立刻**置态（她点了就得马上有反馈），再回传服务端解开挂起的那一轮。
   * 回传失败（404=已超时/重复点击）就把卡改成超时——如实显示，别装作批准成功。
   */
  const answerApproval = useCallback(async (id: string, approved: boolean): Promise<void> => {
    setApprovals((v) =>
      v.map((a) => (a.id === id && a.state === 'pending' ? { ...a, state: approved ? 'approved' : 'rejected' } : a)),
    );
    try {
      await api.resolveApproval(id, approved);
    } catch {
      setApprovals((v) => v.map((a) => (a.id === id ? { ...a, state: 'timeout' } : a)));
    }
  }, []);

  const send = useCallback(
    async (override?: string) => {
      const text = (override ?? input).trim();
      if (!text || busy) return;
    const next: Turn[] = [...turns, { role: 'user', content: text }];
    setTurns(next);
    setInput('');
    setBusy(true);
    setError(null);
    setLive([]);
    setApprovals([]);
    try {
      const r = await api.chatWithAgentStream(
        next.filter((t) => t !== GREETING),
        docRel,
        (s) => {
          if (s.label === 'save_web_file' && s.kind !== 'error') savedTreeRef.current = true;
          setLive((v) => [...v, s]);
        },
        (ev: AgentApprovalEvent) => {
          if (ev.type === 'approval') {
            setApprovals((v) => [...v, { ...ev.approval, state: 'pending' }]);
          } else {
            // 服务端侧的结果（她点了 / 超时）：只更新还挂着的卡，别覆盖她刚点的乐观状态
            setApprovals((v) =>
              v.map((a) =>
                a.id === ev.id && a.state === 'pending'
                  ? { ...a, state: ev.timedOut ? 'timeout' : ev.approved ? 'approved' : 'rejected', by: ev.by }
                  : a,
              ),
            );
          }
        },
        undefined,
        threadId ?? undefined,
      );
      setTurns([...next, { role: 'assistant', content: r.answer, html: r.answerHtml, usage: r.usage }]);
      // 服务端自动建了会话（首轮）：接住 id，并把它放进列表
      if (r.threadId && r.threadId !== threadId) {
        setThreadId(r.threadId);
        void loadThreads();
        // 标题是异步用模型起的，晚两秒再拉一次，让它从「新对话」变成真的标题
        window.setTimeout(() => void loadThreads(), 2500);
      }
      // agent 存了新文件就刷新树——不然她要在左栏看不到刚收进来的那篇
      if (savedTreeRef.current) {
        savedTreeRef.current = false;
        void actions.reloadTree();
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg || 'agent 没能回答，稍后再试。');
      // 她那条话留在输入框里，别丢
      setInput(text);
      setTurns(turns);
    } finally {
      setBusy(false);
      setLive([]);
      inputRef.current?.focus();
    }
  }, [input, busy, turns, docRel, threadId, loadThreads]);

  const list = (
    <div className="agent-chat-list" ref={listRef}>
      {props.nudge ? (
        <div className="agent-nudge">
          <span className="agent-nudge-who">小笔</span>
          <span className="agent-nudge-text">{props.nudge.text}</span>
          <span className="agent-nudge-actions">
            <button
              className="btn sm"
              onClick={() => {
                props.onNudgeDismiss?.();
                void send(props.nudge!.question);
              }}
            >
              继续聊
            </button>
            <button className="btn sm" onClick={() => props.onNudgeDismiss?.()}>
              忽略
            </button>
          </span>
        </div>
      ) : null}
      {turns.map((t, i) => (
        <div key={i} className={`note-reply${t.role === 'assistant' ? ' reply-assistant' : ''}`}>
          <span className="reply-who">{t.role === 'assistant' ? '助手' : '你'}</span>
          {t.html ? (
            // html 由服务端 createMd(html:false) 产出（原始 HTML 已转义），¶块号已织成可点的 .agent-ref
            <span
              className="reply-body agent-md"
              onClick={onRefClick}
              dangerouslySetInnerHTML={{ __html: t.html }}
            />
          ) : (
            <span className="reply-body">{t.content}</span>
          )}
          {t.usage ? <span className="agent-bill">{usageLine(t.usage)}</span> : null}
        </div>
      ))}
      {busy ? (
        <div className="note-reply reply-assistant">
          <span className="reply-who">助手</span>
          <span className="reply-body">
            <span className="agent-steps">
              {live
                .map((s, i) => ({ s, i, text: stepText(s) }))
                .filter(({ text }) => text)
                .map(({ s, i, text }) => (
                  <span key={i} className={`agent-step${s.failed ? ' step-fail' : ''}`}>
                    {text}
                  </span>
                ))}
              <span className="agent-step step-now">{nowDoing(live)}</span>
            </span>
          </span>
        </div>
      ) : null}
      {approvals.length ? (
        <div className="approval-stack">
          {approvals.map((a) => (
            <div
              key={a.id}
              className={`approval-card${a.danger ? ' danger' : ''}${a.state === 'pending' ? '' : ' settled'}`}
            >
              <div className="approval-head">
                <strong>{a.title}</strong>
                <span className={`approval-state st-${a.state}`}>{approvalStateLabel(a)}</span>
              </div>
              {a.note ? <div className="approval-note">依据：{a.note}</div> : null}
              {a.actions.map((act, i) => (
                <div key={i} className="approval-item">
                  <div className="approval-where">
                    <span className={`approval-op${act.danger ? ' danger' : ''}`}>{act.opLabel}</span>
                    {act.where}
                  </div>
                  {act.before ? (
                    <div className="approval-diff">
                      <div className="approval-before">{act.before}</div>
                      {act.after ? <div className="approval-after">{act.after}</div> : null}
                    </div>
                  ) : null}
                </div>
              ))}
              {a.state === 'pending' ? (
                <div className="approval-actions">
                  <button className="btn sm" onClick={() => void answerApproval(a.id, false)}>
                    拒绝
                  </button>
                  <span style={{ flex: 1 }} />
                  <button
                    className={`btn sm ${a.danger ? 'danger' : 'primary'}`}
                    onClick={() => void answerApproval(a.id, true)}
                  >
                    批准
                  </button>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );

  const inputRow = (
    <div className="agent-chat-input">
      <textarea
        ref={inputRef}
        value={input}
        rows={2}
        placeholder={docRel ? `问点什么（当前文档：${docRel.split('/').pop()}）…` : '问点什么…'}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void send();
          }
        }}
        disabled={busy}
      />
      <div className="agent-chat-actions">
        <span className="agent-chat-hint">Ctrl+Enter 发送</span>
        <button className="btn sm" onClick={() => void send()} disabled={busy || !input.trim()}>
          发送
        </button>
      </div>
    </div>
  );

  /**
   * 会话条：当前标题 + 点开列表 + 新建。放在消息列表上方。
   *
   * ★ 「新会话」只在这里出现一次 ★
   *   面板头部原来有个「清空」按钮，我改会话层时把它改名成「新会话」却**没删**，
   *   结果头尾各一个、界面上并排两个一样的按钮（2026-10-08 她当场指出）。
   *   新建是「会话管理」的一部分，跟标题和列表放一起才对，所以只留这一处。
   *
   * ★ 为什么叫「新会话」而不是「清空」★
   *   原来的 `setTurns([GREETING])` 是真的把对话丢掉（内存一扔就没，后台也没有）。
   *   她的预期是「清空界面但后台不清」——这在 DSH 里的落地就是**新建一条**：
   *   界面干净了，旧的仍在列表里，随时点回来。
   */
  const threadBar = (
    <div className="agent-thread-bar">
      <button
        className="agent-thread-title"
        onClick={() => setShowThreads((v) => !v)}
        disabled={busy}
        title="切换会话"
      >
        <span className="agent-thread-name">{threadTitle}</span>
        <span className="agent-thread-caret">{showThreads ? '▴' : '▾'}</span>
      </button>
      <span style={{ flex: 1 }} />
      <button className="btn sm" onClick={() => void newThread()} disabled={busy} title="开一条新会话（旧的还在列表里）">
        新会话
      </button>
    </div>
  );

  /** 会话列表：这篇文档的 + 全局的，最近的在上面。 */
  const threadList = showThreads ? (
    <div className="agent-thread-list">
      {threads.length === 0 ? (
        <div className="agent-thread-empty">这篇文档还没有会话</div>
      ) : (
        threads.map((t) => (
          <button
            key={t.id}
            className={`agent-thread-item${t.id === threadId ? ' on' : ''}`}
            onClick={() => void openThread(t.id)}
          >
            <span className="agent-thread-item-title">{t.title}</span>
            <span className="agent-thread-item-meta">
              {t.turnCount} 轮 · {relTime(t.updatedAt)}
              {t.docRel ? '' : ' · 全局'}
            </span>
          </button>
        ))
      )}
    </div>
  ) : null;

  /** 总账小条：点一下重新拉。没有数据（还没跑过）就不占位置。 */
  const statChip = stats ? (
    <button className="agent-stat-chip" onClick={() => void loadStats()} title="近 7 天总账，点击刷新">
      {stats}
    </button>
  ) : null;

  const body = (
    <div className="agent-chat">
      {threadBar}
      {threadList}
      {list}
      {error ? <div className="agent-chat-error">{error}</div> : null}
      {inputRow}
    </div>
  );

  if (expanded) {
    return (
      <div className="assistant-overlay">
        <div className="assistant-overlay-head">
          <strong>AI 助手</strong>
          <span style={{ flex: 1 }} />
          {statChip}
          <button className="btn sm" onClick={() => setExpanded(false)}>
            还原
          </button>
        </div>
        <div className="assistant-overlay-body">{body}</div>
      </div>
    );
  }

  return (
    <div className="related-panel assistant-panel">
      <div className="related-head">
        <strong>AI 助手</strong>
        <span style={{ flex: 1 }} />
        {statChip}
        <button className="btn sm" onClick={() => setExpanded(true)}>
          放大
        </button>
      </div>
      <div className="assistant-inline">{body}</div>
    </div>
  );
}
