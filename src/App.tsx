/**
 * src/App.tsx —— 顶层：启动分支 + 三栏布局 + 底部状态条。
 *
 * 布局用 flex + 固定宽度侧栏，而不是 CSS Grid：
 * 分隔条拖动时改的是「侧栏宽度」这一个数，flex 下就是直接改 width 那么简单；
 * Grid 要先算出剩余给中间那一列，多一层取整误差，拖起来会有一像素的抖动。
 */

import { useEffect, useState } from 'react';
import { useApp, type RightTab } from './state/store';
import { BootError, VaultSetup } from './components/BootScreen';
import { TopBar } from './components/TopBar';
import { TreePanel } from './components/TreePanel';
import { ArticlePane } from './components/ArticlePane';
import { NotePanel } from './components/NotePanel';
import { StudyPanel } from './components/StudyPanel';
import { SearchPanel } from './components/SearchPanel';
import { SettingsDialog } from './components/SettingsDialog';
import { Splitter } from './components/Splitter';
import { Toasts } from './components/Toasts';
import { Warning } from './components/Icons';

const DEFAULT_LEFT = 280;
/* 340 装小抄偏窄（一条条目常被折成三四行），糖果风下字号又比原来大 1px，
   默认放宽到 380。用户拖过之后以持久化的宽度为准，这里只影响首次/恢复默认。 */
const DEFAULT_RIGHT = 380;

/**
 * 单栏阈值：低于这个宽度就切成「一次只显示一栏 + 底栏切换」。
 * 860 而不是 768 —— 平板竖屏（810/834）同样三栏塞不下，一起覆盖。
 */
const NARROW = 860;

/** 窄屏下当前显示哪一栏。宽屏时这个状态不参与渲染，保留着以便旋屏来回切。 */
type MobilePane = 'left' | 'center' | 'right';

export default function App() {
  const { state, actions } = useApp();
  const [left, setLeft] = useState(DEFAULT_LEFT);
  const [right, setRight] = useState(DEFAULT_RIGHT);
  const [mobilePane, setMobilePane] = useState<MobilePane>('center');
  // 视口宽度要跟着窗口缩放走：否则窗口缩小后，持久化的旧宽度直接把右栏顶出屏幕外。
  const [vw, setVw] = useState(window.innerWidth);
  useEffect(() => {
    const onResize = () => setVw(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const narrow = vw < NARROW;

  /**
   * 在正文里选中一段文字后自动切回「批注」页。
   * 否则用户正在学习页看着卡片，选了文字却看不到写批注的输入框，
   * 会以为选区工具条坏了。窄屏下还要把整栏切到右栏，否则切了 tab 也看不见。
   */
  useEffect(() => {
    if (!state.pending) return;
    actions.setRightTab('notes');
    setMobilePane('right');
  }, [state.pending, actions]);

  // 窄屏下打开一篇文档就回到正文——否则点了目录里的文件名，屏幕上什么都没变，
  // 会以为没点上。（宽屏三栏同时在，不需要这个跳转。）
  useEffect(() => {
    if (state.doc) setMobilePane('center');
  }, [state.doc?.path]);

  // 服务端保存的面板宽度加载回来后（以及设置里点「恢复默认」后）同步一次。
  // 这里只做宽松钳制（防极端脏值）；★左+右恰好装进视口★的精确调和在渲染期做——
  // 曾经两条独立公式（left≤w-340-420、right≤w-280-420）在窄窗口下双双取到上限，
  // 320+380+420=1120 > 1080，右栏整体被顶出屏幕。
  useEffect(() => {
    const p = state.settings?.panelWidths;
    if (!p) return;
    setLeft(Math.min(Math.max(p.left, 180), 600));
    setRight(Math.min(Math.max(p.right, 240), 720));
  }, [state.settings?.panelWidths.left, state.settings?.panelWidths.right]);

  if (!state.booted) {
    return (
      <div className="center-screen">
        <div className="empty">
          <div className="spinner" />
          <p>正在启动…</p>
        </div>
      </div>
    );
  }

  if (state.bootError) return <BootError message={state.bootError} />;

  if (!state.settings) return null;

  if (!state.settings.vault.configured) {
    return (
      <>
        <VaultSetup />
        <Toasts />
      </>
    );
  }

  // ── 渲染期调和（唯一真源）────────────────────────────────
  // 正文至少 420px + 两条分隔条约 16px；剩下的分给左右栏。
  // 先定左栏（右栏最少 240），右栏吃剩余——保证任何窗口宽度下都装得下。
  const SPLIT_TOTAL = 16;
  const avail = Math.max(0, vw - 420 - SPLIT_TOTAL);
  const clampedLeft = Math.min(Math.max(left, 180), Math.max(180, avail - 240));
  const clampedRight = Math.min(Math.max(right, 240), Math.max(200, avail - clampedLeft));

  // 中间那一列至少要有 420px，否则正文会挤成一列字，不如让侧栏被压缩
  const maxLeft = Math.max(180, vw - clampedRight - 420 - SPLIT_TOTAL);
  const maxRight = Math.max(220, vw - clampedLeft - 420 - SPLIT_TOTAL);

  const leftOn = !narrow || mobilePane === 'left' ? 'on' : '';
  const centerOn = !narrow || mobilePane === 'center' ? 'on' : '';
  const rightOn = !narrow || mobilePane === 'right' ? 'on' : '';
  // 窄屏时宽度交给 CSS（整栏铺满），内联的定宽只在三栏布局下有意义。
  const slotStyle = (w: number) =>
    narrow ? undefined : { width: w, flex: 'none' as const, display: 'flex', minHeight: 0 };

  return (
    <div className={narrow ? 'app narrow' : 'app'}>
      <TopBar />
      <div className="main">
        {/*
          ★ 三栏始终挂载，靠 CSS 切显示 ★
          条件渲染会让面板在切走时卸载：滚动位置、批注输入框里没提交的字、
          正在做的那张闪卡，一切都回到初始状态。手机上切来切去是高频操作，
          这个代价不能付。
        */}
        <div className={`slot ${leftOn}`} style={slotStyle(clampedLeft)}>
          <TreePanel />
        </div>
        {narrow ? null : (
          <Splitter
            side="left"
            width={clampedLeft}
            min={180}
            max={maxLeft}
            defaultWidth={DEFAULT_LEFT}
            onChange={setLeft}
            onCommit={(w) => actions.savePanelWidths({ left: w, right })}
          />
        )}
        <ArticlePane className={centerOn} />
        {narrow ? null : (
          <Splitter
            side="right"
            width={clampedRight}
            min={240}
            max={maxRight}
            defaultWidth={DEFAULT_RIGHT}
            onChange={setRight}
            onCommit={(w) => actions.savePanelWidths({ left, right: w })}
          />
        )}
        <div className={`slot ${rightOn}`} style={slotStyle(clampedRight)}>
          <RightPane tab={state.rightTab} onTab={actions.setRightTab} />
        </div>
      </div>
      {narrow ? (
        <>
          {/* 底栏占了固定位置，状态条只在真有话说时才出现（后台任务、重新绑定） */}
          {state.rebinding || state.busy ? <StatusBar /> : null}
          <MobileTabs pane={mobilePane} onPane={setMobilePane} label={RIGHT_TAB_LABEL[state.rightTab]} />
        </>
      ) : (
        <StatusBar />
      )}
      <Toasts />
      {state.settingsOpen ? <SettingsDialog /> : null}
    </div>
  );
}

const RIGHT_TAB_LABEL: Record<RightTab, string> = {
  notes: '批注',
  study: '学习',
  search: '检索',
};

/**
 * 窄屏底栏：目录 / 正文 / 右栏。
 *
 * 右栏那颗按钮的文案跟着右栏当前页变（批注 / 学习 / 检索）——
 * 否则用户按了「批注」进去，里面却是上次留下的闪卡，会以为点错了。
 */
function MobileTabs({
  pane,
  onPane,
  label,
}: {
  pane: MobilePane;
  onPane: (p: MobilePane) => void;
  label: string;
}) {
  const items = [
    { key: 'left' as const, text: '目录', icon: <IconList /> },
    { key: 'center' as const, text: '正文', icon: <IconDoc /> },
    { key: 'right' as const, text: label, icon: <IconSide /> },
  ];
  return (
    <nav className="mobile-tabs">
      {items.map((it) => (
        <button
          key={it.key}
          className={pane === it.key ? 'on' : ''}
          onClick={() => onPane(it.key)}
          aria-current={pane === it.key}
        >
          {it.icon}
          <span>{it.text}</span>
        </button>
      ))}
    </nav>
  );
}

/* 底栏图标：24 格网格 + 1.9 描边，和 Icons.tsx 里那套保持同一手感 */
function IconList() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
      <path d="M4 6.5h16M4 12h10M4 17.5h13" />
    </svg>
  );
}

function IconDoc() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6.5 3h7l4.5 4.5V21h-11.5z" />
      <path d="M13.5 3v4.5H18" />
      <path d="M9.5 12.5h5M9.5 16.5h5" />
    </svg>
  );
}

function IconSide() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3.2" y="4.5" width="17.6" height="15" rx="3" />
      <path d="M14.5 4.5v15" />
    </svg>
  );
}

/**
 * 右栏在「批注」「学习」「检索」之间切换。
 * 切换条作为 switcher 传进面板内部渲染，而不是单独占一行——
 * 右栏本来就窄（默认 340px），再砍掉一整行高度列表就更挤了。
 *
 * 「检索」和另外两页的关键区别：它不依赖当前打开的文章，
 * 所以它有自己的空态，文章没打开时也能用。
 */
function RightPane({ tab, onTab }: { tab: RightTab; onTab: (t: RightTab) => void }) {
  const switcher = (
    <div className="pane-switch">
      <button className={tab === 'notes' ? 'on' : ''} onClick={() => onTab('notes')}>
        批注
      </button>
      <button className={tab === 'study' ? 'on' : ''} onClick={() => onTab('study')}>
        学习
      </button>
      <button className={tab === 'search' ? 'on' : ''} onClick={() => onTab('search')}>
        检索
      </button>
    </div>
  );
  if (tab === 'search') return <SearchPanel switcher={switcher} />;
  return tab === 'notes' ? <NotePanel switcher={switcher} /> : <StudyPanel switcher={switcher} />;
}

function StatusBar() {
  const { state, actions } = useApp();
  const doc = state.doc;
  const orphan =
    (doc?.sidecar.notes ?? []).filter((n) => n.anchorState === 'orphan').length +
    (doc?.sidecar.highlights ?? []).filter((h) => h.anchorState === 'orphan').length;

  return (
    <footer className="statusbar">
      <span>{state.settings?.vault.name || 'notes'}</span>
      {doc ? (
        <>
          <span>·</span>
          <span>{doc.analysis.blocks.length} 块</span>
          <span>·</span>
          <span>{doc.analysis.units.length} 节</span>
          <span>·</span>
          <span>{doc.sidecar.cards.length} 张卡</span>
          {orphan > 0 ? (
            <>
              <span>·</span>
              <span style={{ color: 'var(--danger)' }}>
                <Warning width={11} height={11} style={{ verticalAlign: -1 }} /> {orphan} 条批注失效
              </span>
            </>
          ) : null}
        </>
      ) : null}
      <span className="grow" />
      {state.busy ? (
        <>
          <span className="spinner" style={{ width: 11, height: 11, borderWidth: 1.5 }} />
          <span>{state.busy}</span>
          <span>·</span>
        </>
      ) : null}
      {state.rebinding ? (
        <span style={{ color: 'var(--accent)' }}>
          正在重新绑定：在正文里选中新的位置
          <button className="btn ghost sm" style={{ marginLeft: 6 }} onClick={() => actions.startRebind(null)}>
            取消
          </button>
          <span> · </span>
        </span>
      ) : null}
      <span title="所有数据都在这台电脑上">本地运行 · 127.0.0.1</span>
    </footer>
  );
}
