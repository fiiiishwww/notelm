/**
 * src/components/Toasts.tsx —— 右下角的轻提示。
 *
 * 定时器放在这里而不是 store 里，是因为「按住时暂停消失」只有组件知道：
 * 手指压在一条报错上读它的时候，它不该自己跑掉。
 */

import { useEffect, useRef, useState } from 'react';
import { useApp } from '../state/store';
import { Close, Warning } from './Icons';

/** 提示停留时长：报错给足读完的时间，其余短一些。 */
const TOAST_MS: Record<string, number> = { error: 12000, warn: 8000 };
const DEFAULT_MS = 5000;

/** 复制到剪贴板。http 页面上没有 navigator.clipboard，所以要留 execCommand 兜底。 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 落到下面的兜底 */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function ToastItem({
  kind,
  text,
  onDismiss,
  onSettings,
}: {
  kind: string;
  text: string;
  onDismiss: () => void;
  /** 这条消息里提到了「设置 → 某某」时给一个直接打开的入口 */
  onSettings?: () => void;
}) {
  const [held, setHeld] = useState(false);
  const [copied, setCopied] = useState<boolean | null>(null);
  const ms = TOAST_MS[kind] ?? DEFAULT_MS;

  // onDismiss 每次渲染都是新函数，放进依赖会让定时器被反复重置（等于永不消失）。
  // 用 ref 拿最新值，定时器只在「暂停状态 / 时长」变化时才重建。
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  useEffect(() => {
    if (held) return;
    const t = setTimeout(() => dismissRef.current(), ms);
    return () => clearTimeout(t);
  }, [held, ms]);

  return (
    <div
      className={`toast ${kind}`}
      // 鼠标悬停或手指按住时暂停消失：报错里常常有要看清的原因
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      onPointerDown={() => setHeld(true)}
      onPointerUp={() => setHeld(false)}
    >
      {kind === 'error' || kind === 'warn' ? (
        <Warning width={15} height={15} style={{ marginTop: 2, flex: 'none' }} />
      ) : null}
      <span className="toast-text">{text}</span>
      {onSettings ? (
        <button className="toast-copy" onClick={onSettings} title="打开设置">
          去设置
        </button>
      ) : null}
      {kind === 'error' || kind === 'warn' ? (
        <button
          className={`toast-copy${copied ? ' done' : ''}`}
          title="复制这条消息"
          onClick={() => {
            void copyText(text).then((ok) => {
              setCopied(ok);
              if (ok) setTimeout(() => setCopied(null), 1500);
              else setCopied(false);
            });
          }}
        >
          {copied === true ? '已复制' : '复制'}
        </button>
      ) : null}
      <button className="close" onClick={onDismiss} title="关闭">
        <Close width={13} height={13} />
      </button>
    </div>
  );
}

export function Toasts() {
  const { state, actions } = useApp();
  if (!state.toasts.length) return null;
  return (
    <div className="toasts">
      {state.toasts.map((t) => (
        <ToastItem
          key={t.id}
          kind={t.kind}
          text={t.text}
          onDismiss={() => actions.dismissToast(t.id)}
          // 欠费、没配接口这类提示里会写明「设置 → 某某」，顺手给个入口，
          // 省得用户关掉提示后还要自己找在哪儿改
          onSettings={/「设置 → /.test(t.text) ? actions.openSettings : undefined}
        />
      ))}
    </div>
  );
}
