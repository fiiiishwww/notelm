/**
 * src/components/Dialog.tsx —— 弹窗三件套：通用 Modal、输入框 Prompt、确认框 Confirm。
 *
 * 为什么不用 window.prompt / window.confirm：
 *   1. 它们会阻塞整个渲染进程，拖分隔条、HMR 之类的都会卡住；
 *   2. 样式不可控，和界面其余部分完全不是一个质感；
 *   3. prompt 在某些内嵌浏览器里被禁用（返回 null），删文件这种操作会静默失败。
 */

import { useEffect, useRef, type ReactNode } from 'react';
import { Close } from './Icons';

interface ModalProps {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  /** 顶部额外的内容（比如标签页） */
  headerExtra?: ReactNode;
}

export function Modal({ title, onClose, children, footer, width, headerExtra }: ModalProps) {
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    // 打开时把焦点移进来，否则键盘用户还在原来的按钮上按 Enter
    const first = boxRef.current?.querySelector<HTMLElement>(
      'input:not([type=hidden]), textarea, select, button.primary, button',
    );
    first?.focus();
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div
      className="modal-mask"
      onMouseDown={(e) => {
        // 只有点在遮罩本身（不是弹窗内部）才关闭，避免拖选文字时误关
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal" ref={boxRef} style={width ? { width } : undefined} role="dialog" aria-modal="true">
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="btn ghost icon sm" onClick={onClose} title="关闭">
            <Close />
          </button>
        </div>
        {headerExtra}
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

interface PromptDialogProps {
  title: string;
  label?: string;
  hint?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmText?: string;
  /** 返回错误文案表示校验不通过 */
  validate?: (value: string) => string | null;
  onSubmit: (value: string) => void | Promise<void>;
  onClose: () => void;
}

export function PromptDialog({
  title,
  label,
  hint,
  defaultValue = '',
  placeholder,
  confirmText = '确定',
  validate,
  onSubmit,
  onClose,
}: PromptDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);

  const submit = async () => {
    const v = inputRef.current?.value.trim() ?? '';
    if (!v) {
      if (errorRef.current) errorRef.current.textContent = '不能为空';
      return;
    }
    const err = validate?.(v) ?? null;
    if (err) {
      if (errorRef.current) errorRef.current.textContent = err;
      return;
    }
    await onSubmit(v);
    onClose();
  };

  return (
    <Modal
      title={title}
      onClose={onClose}
      width={440}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" onClick={() => void submit()}>
            {confirmText}
          </button>
        </>
      }
    >
      <div className="field">
        {label ? <label>{label}</label> : null}
        <input
          ref={inputRef}
          className="input"
          defaultValue={defaultValue}
          placeholder={placeholder}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void submit();
            }
          }}
          onInput={() => {
            if (errorRef.current) errorRef.current.textContent = '';
          }}
        />
        <div className="hint" style={{ color: 'var(--danger)', minHeight: 16 }} ref={errorRef} />
        {hint ? <div className="hint">{hint}</div> : null}
      </div>
    </Modal>
  );
}

interface ConfirmDialogProps {
  title: string;
  message: ReactNode;
  confirmText?: string;
  danger?: boolean;
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
}

export function ConfirmDialog({ title, message, confirmText = '确定', danger, onConfirm, onClose }: ConfirmDialogProps) {
  return (
    <Modal
      title={title}
      onClose={onClose}
      width={440}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button
            className={danger ? 'btn danger' : 'btn primary'}
            onClick={() => {
              void Promise.resolve(onConfirm()).then(onClose);
            }}
          >
            {confirmText}
          </button>
        </>
      }
    >
      <div style={{ fontSize: 13.5, lineHeight: 1.7, paddingBottom: 14 }}>{message}</div>
    </Modal>
  );
}
