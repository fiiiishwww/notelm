/**
 * AssistantPanel —— 外部 AI 助手（DSH）的嵌入窗口。
 *
 * ★ 这不是内建助手 ★
 *   NoteLM 不做任何 agent 循环：这里就是一个 iframe，装着跑在
 *   本机的 DSH Web UI。会话、工具调用、确认落盘全是 DSH 的事；
 *   NoteLM 只负责「把 URL 要过来 + 给它一个面板」。
 *
 * 状态机：首次挂载就要 URL（后端会复用已运行的 DSH，或把它拉起来）。
 * 拉起可能要十几秒（Node 冷启动），所以 loading 里要说明白在等什么。
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';

export function AssistantPanel(): React.JSX.Element {
  const [info, setInfo] = useState<{ available: boolean; url?: string; reason?: string } | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setInfo(await api.getAssistant());
    } catch {
      setInfo({ available: false, reason: '请求助手地址失败，确认笔记库服务正常后再试。' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const iframe = info?.available && info.url
    ? <iframe className="assistant-frame" src={info.url} title="AI 助手" />
    : null;

  const body = loading ? (
    <p className="related-empty">正在启动助手（首次可能要十几秒）…</p>
  ) : !info?.available ? (
    <div className="related-empty assistant-offline">
      <p>{info?.reason ?? '助手不可用。'}</p>
      <p className="assistant-note">助手只在这台电脑上可用（它跑在笔记库所在的那台机器上）。</p>
      <button className="btn sm" onClick={() => void load()}>
        重试
      </button>
    </div>
  ) : (
    iframe
  );

  if (expanded) {
    return (
      <div className="assistant-overlay">
        <div className="assistant-overlay-head">
          <strong>AI 助手</strong>
          <span className="related-sub">由 DSH 驱动 · 调用的是你的笔记库，不是上传</span>
          <span style={{ flex: 1 }} />
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
        <span className="related-sub">调用你的笔记库 · 不是上传</span>
        <span style={{ flex: 1 }} />
        {info?.available ? (
          <button className="btn sm" onClick={() => setExpanded(true)}>
            放大
          </button>
        ) : null}
      </div>
      <div className="assistant-inline">{body}</div>
    </div>
  );
}
