/**
 * src/components/TopBar.tsx —— 顶栏。
 *
 * 放什么不放什么的判断标准：**和「正在读的这篇文章」有关的操作放顶栏**，
 * 和整篇文档无关的（新建、删除文件）留在目录树，和全局有关的（主题、接口）
 * 收进设置。顶栏只留一行，任何需要换行排布的按钮都说明放错地方了。
 */

import { useApp } from '../state/store';
import { Anchor, Gear, Moon, Pencil, Save, Split, Sun, Warning } from './Icons';

/** 超过这个块数，打开时布局会明显发顿（8819 块实测 985ms，近似线性）。 */
const SPLIT_BLOCK_THRESHOLD = 600;

export function TopBar() {
  const { state, actions } = useApp();
  const doc = state.doc;
  const s = state.settings;
  const theme = s?.theme ?? 'light';

  const notes = doc?.sidecar.notes ?? [];
  // 失效的批注可能来自 note 或 highlight，两个加起来才是用户看到的「红了几条」
  const orphanCount =
    notes.filter((n) => n.anchorState === 'orphan').length +
    (doc?.sidecar.highlights ?? []).filter((h) => h.anchorState === 'orphan').length;

  const name = doc ? (doc.path.split('/').pop() ?? doc.path).replace(/\.[^.]+$/, '') : '';
  // 块数是「打开会不会卡」的唯一可靠指标：图片数会骗人（一张图也可能只有一个块），
  // 字符数也会骗人（代码块字符多但块少）。
  const blockCount = doc?.analysis.blocks.length ?? 0;
  const tooLong = blockCount > SPLIT_BLOCK_THRESHOLD;

  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-dot" />
        NoteLM
      </div>
      <div className="topbar-sep" />
      {doc ? (
        <>
          <span className="doc-title" title={name}>
            {name}
          </span>
          <span className="doc-path" title={doc.path}>
            {doc.path}
          </span>
        </>
      ) : (
        <span style={{ color: 'var(--text-3)', fontSize: 13 }}>
          {state.docLoading ? '正在打开…' : '还没有打开文章'}
        </span>
      )}
      {state.docLoading ? <span className="spinner" /> : null}

      <span className="topbar-spacer" />

      {doc ? (
        <>
          <span className="count-chip" title={`${notes.length} 条批注 · ${doc.sidecar.highlights.length} 处高亮`}>
            批注 {notes.length}
          </span>
          {tooLong ? (
            <button
              className="btn sm"
              onClick={() => void actions.splitDoc()}
              title={`这篇有 ${blockCount} 个块，打开时布局会明显发顿。按标题拆成每篇不超过 ${SPLIT_BLOCK_THRESHOLD} 块的小文档，批注会跟着搬过去，原文移入回收站。`}
            >
              <Split width={13} height={13} /> 拆分
            </button>
          ) : null}
          {orphanCount > 0 ? (
            <>
              <span className="count-chip" style={{ color: 'var(--danger)', background: 'var(--danger-soft)' }}>
                <Warning width={11} height={11} style={{ verticalAlign: -1 }} /> {orphanCount} 条失效
              </span>
              <button className="btn sm" onClick={() => void actions.runReanchor()} title="按原文重新定位一遍所有批注">
                <Anchor width={13} height={13} /> 重新定位
              </button>
            </>
          ) : null}
          {state.editorOpen ? (
            <>
              <button className="btn sm" onClick={() => actions.setEditorMode(state.editorMode === 'edit' ? 'preview' : 'edit')}>
                {state.editorMode === 'edit' ? '预览' : '继续编辑'}
              </button>
              <button className="btn sm primary" onClick={() => void actions.saveDoc()} title="Ctrl+S">
                <Save width={13} height={13} /> 保存
              </button>
            </>
          ) : (
            <button className="btn sm" onClick={() => actions.openEditor('edit')} title="Ctrl+E 编辑正文">
              <Pencil width={13} height={13} /> 编辑
            </button>
          )}
        </>
      ) : null}

      <button
        className="btn ghost icon sm"
        title={theme === 'light' ? '切换到深色' : '切换到浅色'}
        onClick={() => actions.setTheme(theme === 'light' ? 'dark' : 'light')}
      >
        {theme === 'light' ? <Moon /> : <Sun />}
      </button>
      <button className="btn ghost icon sm" title="设置" onClick={actions.openSettings}>
        <Gear />
      </button>
    </header>
  );
}
