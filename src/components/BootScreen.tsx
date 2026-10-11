/**
 * src/components/BootScreen.tsx —— 启动期的两个界面：启动失败、首次设置笔记库。
 *
 * 单独成文件的原因：这两个界面在「三栏布局还没有意义」的阶段显示，
 * 混进 App 会让 App 里全是 if (settings === null) 之类的分支。
 */

import { useState } from 'react';
import { api, errorText } from '../api';
import { useApp } from '../state/store';
import { Warning } from './Icons';

export function BootError({ message }: { message: string }) {
  return (
    <div className="center-screen">
      <div className="boot-error">
        <h1>启动没成功</h1>
        <p style={{ fontSize: 13.5, lineHeight: 1.7, color: 'var(--text-2)' }}>
          前端拿不到后端的状态。最常见的原因是服务已经退出了，或者浏览器缓存了一个旧的页面。
        </p>
        <pre>{message}</pre>
        <div className="row" style={{ marginTop: 14 }}>
          <button className="btn primary" onClick={() => window.location.reload()}>
            重新加载页面
          </button>
        </div>
        <div className="foot-hint">
          如果反复出现，请回到启动窗口看一眼有没有报错信息，然后重新启动一次。
        </div>
      </div>
    </div>
  );
}

/**
 * 首次使用：选择笔记库。
 *
 * 强烈推荐默认目录：它就在软件自己的文件夹里，用户不需要理解「笔记库」这个概念
 * 就能开始写。想放到别处的人自然会去填路径，所以把「用默认目录」做成主按钮。
 */
export function VaultSetup() {
  const { state, actions } = useApp();
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const defaultVault = state.settings?.defaultVault ?? '';

  const useDefault = async () => {
    setBusy(true);
    setError(null);
    try {
      await actions.setVault({ useDefault: true });
    } finally {
      setBusy(false);
    }
  };

  const useCustom = async () => {
    const p = path.trim().replace(/^"(.*)"$/, '$1');
    if (!p) {
      setError('请填一个绝对路径，例如 D:\\我的笔记');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await actions.setVault({ root: p });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="center-screen">
      <div className="setup-card">
        <h1>
          <span className="brand-dot" />
          欢迎使用 NoteLM
        </h1>
        <p className="lead">
          左边目录、中间文章、右边批注。所有内容都是你自己磁盘上的 Markdown 文件，
          用 Obsidian 或者 VS Code 打开同一个文件夹就能看到同样的内容。
          <br />
          先选一个文件夹当笔记库，之后随时可以在设置里改。
        </p>

        <div className="field">
          <label>推荐：用软件自带的目录</label>
          <div className="path-box">{defaultVault}</div>
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn primary" disabled={busy} onClick={() => void useDefault()}>
              {busy ? <span className="spinner" /> : null} 就用这个目录
            </button>
          </div>
        </div>

        <div className="field" style={{ marginTop: 8 }}>
          <label>或者，指定一个已存在的文件夹</label>
          <div className="row">
            <input
              className="input"
              style={{ flex: 1, minWidth: 240 }}
              value={path}
              placeholder="D:\我的笔记"
              onChange={(e) => setPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void useCustom();
              }}
            />
            <button className="btn" disabled={busy || !path.trim()} onClick={() => void useCustom()}>
              使用这个目录
            </button>
          </div>
          <div className="hint">目录不存在会自动创建。里面的 .md 文件会立刻出现在左侧目录里。</div>
        </div>

        {error ? (
          <div className="banner error" style={{ marginTop: 12 }}>
            <Warning width={14} height={14} />
            <span>{error}</span>
          </div>
        ) : null}

        <div className="foot-hint">
          批注和小抄会存在笔记库里的 <code>.notebook</code> 目录，不会污染你的 Markdown 文件。
        </div>
      </div>
    </div>
  );
}

/** 一个极简的「探活」：后端不可用时不要显示出一堆看不懂的报错。 */
export async function pingBackend(): Promise<string | null> {
  try {
    await api.settingsState();
    return null;
  } catch (e) {
    return errorText(e);
  }
}
