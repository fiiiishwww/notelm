/**
 * BottomDock —— 正文下方常驻板块：相关段落 / AI 助手 两个 tab。
 *
 * 助手tab 演进：内建（版A 双 tab）→ 外挂 DSH iframe → **库内 agent 直聊**
 * （2026-09-22，DSH 撤下；AgentChatPanel 调 chatWithAgent，工具层与批注回复/MCP 同一份）。
 *
 * 主动性（C，2026-09-22）：nudge 在这里拉取而不是面板里——tab 一直挂载，
 * 小笔「有话想说」时 tab 上冒个点，她不切过去也知道。看过/忽略后点消。
 */
import { useCallback, useEffect, useState } from 'react';
import { api, type AgentNudge } from '../api';
import { useApp } from '../state/store';
import { RelatedPanel } from './RelatedPanel';
import { AgentChatPanel } from './AgentChatPanel';

export function BottomDock(props: { scrollRef: React.RefObject<HTMLDivElement | null> }) {
  const { state } = useApp();
  const [tab, setTab] = useState<'related' | 'assistant'>('related');
  const [nudge, setNudge] = useState<AgentNudge | null>(null);
  const [seen, setSeen] = useState(false);
  /**
   * 收起/展开整个面板（多鱼 2026-09-23）：按钮在 tabs 行上，两个 tab 都够得着——
   * 之前收起钮在相关段落面板内部，切到 AI 助手就没法收起了。
   */
  const [open, setOpen] = useState(true);

  const docRel = state.doc?.path;

  // 有新 nudge 或换文档后重新拉一次；忽略的当次会话不再出现（服务端另有 7 天冷却）
  useEffect(() => {
    let alive = true;
    api
      .nudge()
      .then((r) => {
        if (alive) {
          setNudge(r.nudge);
          setSeen(false);
        }
      })
      .catch(() => {
        /* nudge 拉不到就安静，不值得报错 */
      });
    return () => {
      alive = false;
    };
  }, [docRel]);

  const dismiss = useCallback(() => {
    setNudge(null);
    setSeen(true);
  }, []);

  return (
    <div className="bottom-dock">
      <div className="dock-tabs" role="tablist">
        <button
          className={`dock-tab${tab === 'related' ? ' on' : ''}`}
          onClick={() => setTab('related')}
        >
          相关段落
        </button>
        <button
          className={`dock-tab${tab === 'assistant' ? ' on' : ''}`}
          onClick={() => setTab('assistant')}
        >
          AI 助手
          {nudge && !seen ? <span className="nudge-dot" title="小笔有话想说" /> : null}
        </button>
        <span style={{ flex: 1 }} />
        <button className="btn sm dock-fold" onClick={() => setOpen((v) => !v)}>
          {open ? '收起' : '展开'}
        </button>
      </div>
      {open ? (
        tab === 'related' ? (
          <RelatedPanel scrollRef={props.scrollRef} />
        ) : (
          <AgentChatPanel nudge={nudge} onNudgeDismiss={dismiss} />
        )
      ) : null}
    </div>
  );
}
