/**
 * src/components/TreePanel.tsx —— 左栏：多层级目录树。
 *
 * 几个刻意的设计：
 *   1. **展开状态持久化**（存在 store 里 → localStorage）。用户写到第三章，
 *      关掉软件再打开，树应该还是那个样子，不要让他重新点开三层目录。
 *   2. **搜索时临时全展开**。一旦有过滤词，就把匹配路径上的目录全部展开——
 *      否则搜索结果藏在折叠的目录里，等于没搜到。
 *   3. **右键菜单而不是常驻按钮**。常驻的「…」按钮会在窄面板里挤占文件名空间，
 *      而且每行都要渲染一个按钮，几百个文件时白搭一堆 DOM。
 *   4. 重命名文档时**保留扩展名**：用户改了名字却把 .md 弄丢，
 *      在 Obsidian 那边就变成一个不认识的文件了。
 */

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { useApp } from '../state/store';
import { api, type TreeNode, type TodayActionRow, type TodayResult, type ReviewPlanResult } from '../api';
import {
  Activate,
  Cards as CardsIcon,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  Plus,
  Search,
  Trash,
  Pencil,
  External,
  Upload,
  Dedupe as DedupeIcon,
  Anchor as AnchorIcon,
  Graph as GraphIcon,
} from './Icons';
import { ConfirmDialog, PromptDialog } from './Dialog';
import { UploadDialog } from './UploadDialog';
import { DedupeDialog } from './DedupeDialog';
import { GraphDialog } from './GraphDialog';
import { ReviewRoom } from './ReviewRoom';
import { HistoryPanel } from './HistoryPanel';

type PromptSpec =
  | { kind: 'new-doc'; parent: string }
  | { kind: 'new-dir'; parent: string }
  | { kind: 'rename'; node: TreeNode };

/** 行尾的类型小标签（卡 / 填空 / 问答 / 读）。 */
const KIND_LABEL: Record<TodayActionRow['kind'], string> = {
  card: '卡',
  blank: '填空',
  qa: '问答',
  jump: '读',
};

/** 统一行动清单的一行：图标 + 标题 + 常驻理由（不再藏 tooltip）。 */
function TodayRow({ row, onClick }: { row: TodayActionRow; onClick: () => void }) {
  const Icon = row.kind === 'card' ? CardsIcon : row.kind === 'jump' ? FileText : AnchorIcon;
  const isAction = row.action !== 'jump-section';
  return (
    <button
      className={`today-row${isAction ? ' today-row-review' : ''}${row.priority <= 1 ? ' has-count' : ''}`}
      onClick={onClick}
      title={row.doc ? row.doc : undefined}
    >
      <span className="today-row-main">
        <Icon width={13} height={13} />
        <span className="today-name">{row.title}</span>
        <span className="today-doc">{KIND_LABEL[row.kind]}</span>
      </span>
      {row.why ? <span className="today-why">{row.why}</span> : null}
    </button>
  );
}

/** 取相对路径的父目录（'' 表示根）。 */
function parentOf(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i < 0 ? '' : rel.slice(0, i);
}

function baseName(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i < 0 ? rel : rel.slice(i + 1);
}

/**
 * 内部拖拽用的自定义 MIME。
 *
 * 必须和「外部文件拖进来上传」区分开：外部拖文件的 `types` 里含 `'Files'`，
 * 内部拖拽不放 `'Files'`，所以 `isFileDrag()` 不会被误触发，两套逻辑互不干扰。
 */
const DND_MIME = 'application/x-nb-entry';

const isEntryDrag = (e: DragEvent) => e.dataTransfer.types.includes(DND_MIME);

/**
 * 在**完整树**里找节点。
 *
 * 注意不能拿过滤后的 `visible` 来找：搜索时树被裁过，选中项可能不在里面，
 * 落点会静默退回根目录，用户会以为「点了没反应」。
 */
function findNode(node: TreeNode | null, rel: string): TreeNode | null {
  if (!node) return null;
  for (const c of node.children ?? []) {
    if (c.relPath === rel) return c;
    const hit = findNode(c, rel);
    if (hit) return hit;
  }
  return null;
}

/** 拖到这一行上时，实际要放进哪个目录（拖到文档上 = 放进它所在的目录）。 */
function dropTargetOf(node: TreeNode): string {
  return node.type === 'dir' ? node.relPath : parentOf(node.relPath);
}

/** 能不能放：原地不动 / 自己 / 自己的子孙，都不行。 */
function canDrop(from: string | null, dir: string | null): boolean {
  if (!from || dir === null) return false;
  if (dir === from) return false; // 拖到自己身上
  if (dir.startsWith(`${from}/`)) return false; // 拖进自己的子孙（会把目录移进自己内部）
  if (`${dir}/${baseName(from)}` === from) return false; // 原地不动
  return true;
}

/** 按关键词过滤树：目录只要「自己匹配或后代有匹配」就保留。 */
function filterTree(node: TreeNode, q: string): TreeNode | null {
  if (!q) return node;
  const lower = q.toLowerCase();
  if (node.type === 'doc') return node.name.toLowerCase().includes(lower) ? node : null;
  const kids = (node.children ?? []).map((c) => filterTree(c, q)).filter((c): c is TreeNode => c !== null);
  const selfHit = node.name.toLowerCase().includes(lower);
  if (!selfHit && kids.length === 0) return null;
  return { ...node, children: kids };
}

export function TreePanel() {
  const { state, actions } = useApp();
  const [filter, setFilter] = useState('');
  const [ctx, setCtx] = useState<{ x: number; y: number; node: TreeNode } | null>(null);
  const [prompt, setPrompt] = useState<PromptSpec | null>(null);
  const [pendingDelete, setPendingDelete] = useState<TreeNode | null>(null);
  const [uploadFiles, setUploadFiles] = useState<File[] | null>(null);
  const [dedupeOpen, setDedupeOpen] = useState(false);
  const [graphOpen, setGraphOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  /** ★「今天」★ 统一行动清单（2026-10-11 S2）。
   *  以前这里有三个口径各说各话：考频行（节级）、小笔计划（plan）、SM-2 到期（右栏），
   *  数字可能互相矛盾。现在一份 GET /study/today 合并三者，每行带 why。 */
  const [todayData, setTodayData] = useState<TodayResult | null>(null);
  const [actionsState, setActionsState] = useState<'loading' | 'ready' | 'empty'>('loading');
  /** 复习计划（小笔排的）。ReviewRoom 打开时要它；平时计数走 actions.meta。 */
  const [plan, setPlan] = useState<ReviewPlanResult | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  /** 点今天栏某行时带来的定位 id（cardId 或 planItemId）。ReviewRoom 进场要它对准那一行，否则会从第一道未答题开始播。 */
  const [reviewFocus, setReviewFocus] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const ctxRef = useRef<HTMLDivElement>(null);
  /** 拖进子元素的次数。enter/leave 会在每个子元素上冒泡，靠计数才不会闪。 */
  const dragDepth = useRef(0);

  const searching = filter.trim().length > 0;

  // ★「今天」的数据 ★ 依赖 state.tree 做刷新触发：面经文件增删会改目录树，顺带重读清单。
  //   服务端合并三口径（SM-2 到期 + 小笔计划 + 考频），一份数据一个口径，不再各算各的。
  const refreshToday = useCallback(() => {
    void api
      .today()
      .then((r) => {
        setTodayData(r);
        setActionsState(r.rows.length ? 'ready' : 'empty');
      })
      .catch(() => setActionsState('empty'));
  }, []);

  useEffect(() => {
    if (!state.tree) return;
    setActionsState('loading');
    refreshToday();
  }, [state.tree, refreshToday]);

  const openReview = async (focusId?: string | null) => {
    setReviewFocus(focusId ?? null);
    setPlanLoading(true);
    try {
      // 打开时现读一次，保证不是上次的残留（她可能刚跟小笔改过计划）
      const r = await api.reviewPlan();
      setPlan(r);
      setReviewOpen(true);
    } catch {
      setPlan(null);
      setReviewOpen(true);
    } finally {
      setPlanLoading(false);
    }
  };

  /**
   * 点「今天」的一行 → 打开那篇文章，并滚到对应小节。
   * 右栏每节容器带 `data-hid`（StudyPanel 渲染时写上的），所以滚过去是精确定位。
   */
  const jumpToSection = async (doc: string, headingId: string) => {
    await actions.openDoc(`${doc}.md`);
    // openDoc 是异步的，右栏还没渲染完，所以等一帧再找节点。
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(`[data-hid="${headingId}"]`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };
  const visible = useMemo(() => {
    const t = state.tree;
    if (!t) return null;
    return filterTree(t, filter.trim());
  }, [state.tree, filter]);

  const docCount = useMemo(() => {
    let n = 0;
    const walk = (node?: TreeNode) => {
      for (const c of node?.children ?? []) {
        if (c.type === 'doc') n++;
        else walk(c);
      }
    };
    walk(state.tree ?? undefined);
    return n;
  }, [state.tree]);

  // 点空白处 / 按 Esc 关掉右键菜单
  useEffect(() => {
    if (!ctx) return;
    const onDown = (e: MouseEvent) => {
      if (ctxRef.current && !ctxRef.current.contains(e.target as Node)) setCtx(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCtx(null);
    };
    const onBlur = () => setCtx(null);
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', onBlur);
    };
  }, [ctx]);

  /**
   * 新建 / 上传的落点。优先级：
   *   1. 左栏选中的节点（文件夹 = 它自己，文档 = 它所在的目录）
   *   2. 退回当前打开文章所在的目录
   *
   * 以前只有第 2 条，而「选中」这个状态根本不存在，于是落点永远是当前文章
   * 所在目录 —— 库里只有那一个文件夹有文档时，就表现为「只能建到冒烟测试」。
   */
  const defaultParent = useMemo(() => {
    const sel = state.selectedRel;
    if (sel) {
      const node = findNode(state.tree, sel);
      if (node) return node.type === 'dir' ? node.relPath : parentOf(node.relPath);
      // 选中项已经不在树里（被移动或删除了），退回按路径猜
      return parentOf(sel);
    }
    return state.activeRel ? parentOf(state.activeRel) : '';
  }, [state.selectedRel, state.activeRel, state.tree]);

  /** 给按钮的提示文案，让用户在点之前就知道会建到哪。 */
  const where = defaultParent || '笔记库根目录';

  const askNewDoc = (parent: string) => setPrompt({ kind: 'new-doc', parent });
  const askNewDir = (parent: string) => setPrompt({ kind: 'new-dir', parent });

  // ── 上传：按钮只负责打开对话框，选文件在对话框里做；拖文件直接带进来 ──
  const pickFiles = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    setUploadFiles(Array.from(list));
  };

  /** 只认「拖的是文件」；拖文字、拖链接进来一律不拦，交给浏览器默认行为。 */
  const isFileDrag = (e: DragEvent) => e.dataTransfer.types.includes('Files');

  const onDragEnter = (e: DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth.current += 1;
    setDragOver(true);
  };
  const onDragOver = (e: DragEvent) => {
    if (!isFileDrag(e)) return;
    // 不 preventDefault 的话浏览器会直接打开这个文件，drop 根本不会触发
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };
  const onDragLeave = (e: DragEvent) => {
    if (!isFileDrag(e)) return;
    dragDepth.current -= 1;
    if (dragDepth.current <= 0) {
      dragDepth.current = 0;
      setDragOver(false);
    }
  };
  const onDrop = (e: DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDragOver(false);
    pickFiles(e.dataTransfer.files);
  };

  // ── 内部拖拽：把文件/文件夹拖到别的位置 ──
  const [dragRel, setDragRel] = useState<string | null>(null);
  /** 当前高亮的放置目录。`null` = 没在拖，`''` = 根目录。 */
  const [dropRel, setDropRel] = useState<string | null>(null);

  const endEntryDrag = () => {
    setDragRel(null);
    setDropRel(null);
  };

  /**
   * 松手时真正执行移动。
   *
   * `getData` 在 dragover 阶段恒返回空串（浏览器的保护模式），所以判断一律
   * 用 `dragRel` state，`getData` 只在 drop 这一刻当兜底。
   */
  const dropInto = (dir: string) => {
    const from = dragRel;
    endEntryDrag();
    if (!from || !canDrop(from, dir)) return;
    const to = dir ? `${dir}/${baseName(from)}` : baseName(from);
    void actions.moveEntry(from, to);
  };

  const entryDragOver = (e: DragEvent, dir: string) => {
    // 不 stopPropagation 的话，事件冒到 pane-body，根目录兜底会把高亮清成 ''
    e.stopPropagation();
    e.preventDefault();
    e.dataTransfer.dropEffect = canDrop(dragRel, dir) ? 'move' : 'none';
  };

  const renderRow = (node: TreeNode, depth: number, forceOpen: boolean) => {
    const open = forceOpen || !!state.expanded[node.relPath];
    const active = state.activeRel === node.relPath;
    const selected = state.selectedRel === node.relPath;
    const dropDir = dropTargetOf(node);
    const isDropTarget = dropRel === node.relPath && canDrop(dragRel, dropDir);

    const rows: React.ReactNode[] = [
      <div
        key={node.relPath}
        className={`tree-row${active ? ' active' : ''}${selected ? ' selected' : ''}${
          dragRel === node.relPath ? ' dragging' : ''
        }${isDropTarget ? ' drop-into' : ''}`}
        style={{ paddingLeft: 6 + depth * 12 }}
        draggable
        onClick={() => {
          // 选中决定「新建」落点。文件夹的选中在 toggleDir 里也做了一份，
          // 这里再写一次是为了文档行也能立刻生效（openDoc 会异步回来）。
          actions.selectNode(node.relPath);
          if (node.type === 'dir') actions.toggleDir(node.relPath, !open);
          else void actions.openDoc(node.relPath);
        }}
        onDoubleClick={(e) => {
          // 双击文档在系统文件管理器里定位：写笔记时经常要把原文件拖给别人
          if (node.type === 'doc') {
            e.preventDefault();
            void actions.reveal(node.relPath);
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          // 右键也选中：这样菜单里的「在这里新建」和顶部按钮的落点是一致的
          actions.selectNode(node.relPath);
          setCtx({ x: e.clientX, y: e.clientY, node });
        }}
        onDragStart={(e) => {
          e.dataTransfer.setData(DND_MIME, node.relPath);
          e.dataTransfer.effectAllowed = 'move';
          setDragRel(node.relPath);
        }}
        onDragEnd={endEntryDrag}
        onDragEnter={(e) => {
          if (!isEntryDrag(e)) return;
          entryDragOver(e, dropDir);
          if (canDrop(dragRel, dropDir)) setDropRel(node.relPath);
        }}
        onDragOver={(e) => {
          if (!isEntryDrag(e)) return;
          entryDragOver(e, dropDir);
        }}
        onDragLeave={(e) => {
          if (!isEntryDrag(e)) return;
          e.stopPropagation();
          if (dropRel === node.relPath) setDropRel(null);
        }}
        onDrop={(e) => {
          if (!isEntryDrag(e)) return;
          e.stopPropagation();
          e.preventDefault();
          dropInto(dropDir);
        }}
        title={node.relPath}
      >
        <span className={`tree-chevron${open ? ' open' : ''}`}>{node.type === 'dir' ? <ChevronRight width={11} height={11} /> : null}</span>
        <span className="tree-icon">{node.type === 'dir' ? open ? <FolderOpen /> : <Folder /> : <FileText />}</span>
        <span className="tree-name">{node.name}</span>
      </div>,
    ];

    if (node.type === 'dir' && (open || forceOpen)) {
      for (const child of node.children ?? []) rows.push(...renderRow(child, depth + 1, forceOpen));
    }
    return rows;
  };

  const nameError = (v: string) => {
    if (/[\\/]/.test(v)) return '名字里不能包含斜杠';
    return null;
  };

  return (
    <div
      className={`pane pane-left${dragOver ? ' drag-over' : ''}`}
      style={{ width: '100%' }}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="pane-head">
        <h2>目录</h2>
        <span className="count-chip">{docCount}</span>
        <span className="grow" style={{ flex: 1 }} />
        <button
          className="btn ghost icon sm"
          title="上传（PDF / MD、飞书链接、ZIP 包；也可以直接把文件拖到这一栏）"
          onClick={() => setUploadFiles([])}
        >
          <Upload />
        </button>
        <button
          className="btn ghost icon sm"
          title="一键去重：扫描整个笔记库，列出重复的文章，你确认后再移入回收站"
          onClick={() => setDedupeOpen(true)}
        >
          <DedupeIcon />
        </button>
        <button
          className="btn ghost icon sm"
          title="知识地图：看看整个笔记库实际分成了几个主题团（本地计算，不调用模型）"
          onClick={() => setGraphOpen(true)}
        >
          <GraphIcon />
        </button>
        <button className="btn ghost icon sm" title={`新建文章到：${where}`} onClick={() => askNewDoc(defaultParent)}>
          <Plus />
        </button>
        <button className="btn ghost icon sm" title={`新建文件夹到：${where}`} onClick={() => askNewDir(defaultParent)}>
          <Folder />
        </button>
        <button
          className="btn ghost icon sm"
          title="在文件管理器中打开笔记库"
          onClick={() => void actions.openVault()}
          disabled={!state.settings?.vault.configured}
        >
          <External />
        </button>
      </div>

      <div className="tree-search">
        <div style={{ position: 'relative' }}>
          <Search
            width={13}
            height={13}
            style={{ position: 'absolute', left: 8, top: 7, color: 'var(--text-3)' }}
          />
          <input
            className="input"
            style={{ paddingLeft: 25 }}
            placeholder="筛选文件…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
      </div>

      <div
        className={`pane-body${dropRel === '' ? ' drop-root' : ''}`}
        onDragOver={(e) => {
          // 拖到树的空白处 = 移动到根目录。行上的 stopPropagation 保证
          // 悬停在具体某一行时不会走到这里（否则高亮会乱闪）。
          if (!isEntryDrag(e)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = canDrop(dragRel, '') ? 'move' : 'none';
          if (dropRel !== '') setDropRel('');
        }}
        onDrop={(e) => {
          if (!isEntryDrag(e)) return;
          e.preventDefault();
          dropInto('');
        }}
      >
        {state.treeLoading && !state.tree ? (
          <div className="empty">
            <div className="spinner" />
            <p>正在读取目录…</p>
          </div>
        ) : !visible || (visible.children ?? []).length === 0 ? (
          <div className="empty">
            <div className="empty-emoji">📁</div>
            {searching ? (
              <>
                <h3>没有匹配的文件</h3>
                <p>换个关键词试试，或者清空筛选框。</p>
              </>
            ) : (
              <>
                <h3>笔记库还是空的</h3>
                <p>
                  点左上角的 <Plus width={12} height={12} style={{ verticalAlign: -1 }} /> 新建一篇文章，
                  或者把已有的 md / txt / PDF 拖进来——PDF 会自动抽成可批注的 Markdown。
                </p>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
                  <button className="btn primary" onClick={() => askNewDoc('')}>
                    <Plus /> 新建文章
                  </button>
                  <button className="btn" onClick={() => setUploadFiles([])}>
                    <Upload /> 上传文件
                  </button>
                </div>
              </>
            )}
          </div>
        ) : (
          <div className="tree">
            {/* 根节点不显示成一行：树的第一层就是根目录里的内容，少一层点击 */}
            {(visible.children ?? []).map((c) => renderRow(c, 0, searching))}
          </div>
        )}
      </div>

      {/* ★「今天」★ 左栏最后一个分区 —— 统一行动清单（2026-10-11 S2）。
          以前这里两种行式（复习行 + 考频行）各说各话，理由全藏在 tooltip；
          现在 = GET /study/today 的 ActionRow 列表：错题 > 到期 > 计划 > 考频，
          每行常驻一句「为什么在这」。默认只铺 8 行（一屏能扫完），全量在复习界面。
          布局：树是 `flex:1 1 auto`，这里 `flex:none`，所以两者互不挤压。 */}
      <div className="today-zone">
        <div className="today-head">
          <h3>今天</h3>
          <span style={{ flex: 1 }} />
          {actionsState === 'ready' && todayData ? (
            <span className="count-chip">{todayData.rows.length}</span>
          ) : null}
          <button
            className="btn ghost icon sm"
            title="历史：复习计划 / 和小笔的对话"
            onClick={() => setHistoryOpen(true)}
          >
            <Activate width={14} height={14} />
          </button>
        </div>

        <ul className="today-list">
          {actionsState === 'loading' ? (
            <li>
              <div className="today-empty">正在读今天的清单…</div>
            </li>
          ) : actionsState === 'empty' || !todayData ? (
            <li>
              <div className="today-empty">
                今天没有可行动的复习项——跟小笔说「今天复习什么」排一份
              </div>
            </li>
          ) : (
            <>
              {todayData.rows.slice(0, 8).map((row) => (
                <li key={row.id}>
                  <TodayRow
                    row={row}
                    onClick={() => {
                      if (row.action === 'jump-section' && row.doc && row.headingId) {
                        void jumpToSection(row.doc, row.headingId);
                      } else {
                        // ★ 把这行的定位 id 带进去：ReviewRoom 才能从这张卡/这条开始，而不是永远第一题
                        void openReview(row.cardId ?? row.planItemId ?? null);
                      }
                    }}
                  />
                </li>
              ))}
              <li className="today-more">
                <span className="today-more-text">
                  共 {todayData.rows.length} 条 · 到期 {todayData.meta.dueCount} 张卡
                </span>
                <button className="btn ghost sm" disabled={planLoading} onClick={() => void openReview()}>
                  开始复习
                </button>
              </li>
            </>
          )}
        </ul>
      </div>

      {dragOver ? (
        <div className="drop-hint">
          <Upload width={22} height={22} />
          <span>松手即导入</span>
          <em>md / txt 会排好版，PDF 抽成 Markdown</em>
        </div>
      ) : null}

      {uploadFiles ? (
        <UploadDialog files={uploadFiles} defaultDir={defaultParent} onClose={() => setUploadFiles(null)} />
      ) : null}

      {dedupeOpen ? <DedupeDialog onClose={() => setDedupeOpen(false)} /> : null}

      {/* 历史（会话 + 复习计划）——之前数据都在盘上但没地方翻 */}
      {historyOpen ? <HistoryPanel onClose={() => setHistoryOpen(false)} /> : null}

      {/* ★ 复习界面 ★ 全屏接管（不是页面里划一块）：点开之后其他部分被遮罩压住。 */}
      {reviewOpen ? (
        <ReviewRoom
          plan={plan ?? { hasPlan: false, items: [] }}
          focusItemId={reviewFocus}
          onExit={() => {
            setReviewOpen(false);
            // 退出后重读：她可能刚过完一轮，清单上的数字和行要变（统一口径）
            void api.reviewPlan().then(setPlan).catch(() => undefined);
            refreshToday();
          }}
        />
      ) : null}

      {graphOpen ? <GraphDialog onClose={() => setGraphOpen(false)} /> : null}

      {ctx ? (
        <div
          className="ctx-menu"
          ref={ctxRef}
          style={{
            left: Math.min(ctx.x, window.innerWidth - 190),
            top: Math.min(ctx.y, window.innerHeight - 200),
          }}
        >
          {ctx.node.type === 'dir' ? (
            <>
              <button
                onClick={() => {
                  askNewDoc(ctx.node.relPath);
                  setCtx(null);
                }}
              >
                <FileText /> 在这里新建文章
              </button>
              <button
                onClick={() => {
                  askNewDir(ctx.node.relPath);
                  setCtx(null);
                }}
              >
                <Folder /> 在这里新建文件夹
              </button>
              <hr />
            </>
          ) : null}
          <button
            onClick={() => {
              setPrompt({ kind: 'rename', node: ctx.node });
              setCtx(null);
            }}
          >
            <Pencil /> 重命名
          </button>
          <button
            onClick={() => {
              void actions.reveal(ctx.node.relPath);
              setCtx(null);
            }}
          >
            <External /> 在文件管理器中显示
          </button>
          <hr />
          <button
            className="danger"
            onClick={() => {
              setPendingDelete(ctx.node);
              setCtx(null);
            }}
          >
            <Trash /> 删除
          </button>
        </div>
      ) : null}

      {prompt ? (
        <PromptDialog
          title={prompt.kind === 'new-doc' ? '新建文章' : prompt.kind === 'new-dir' ? '新建文件夹' : '重命名'}
          label={prompt.kind === 'new-doc' ? '文件名（可省略 .md）' : '名称'}
          defaultValue={prompt.kind === 'rename' ? prompt.node.name : ''}
          placeholder={prompt.kind === 'new-doc' ? '例如：第三章 动态规划' : '例如：读书笔记'}
          hint={
            prompt.kind === 'new-doc'
              ? `将创建在：${prompt.parent || '笔记库根目录'}`
              : prompt.kind === 'new-dir'
                ? `将创建在：${prompt.parent || '笔记库根目录'}`
                : `原路径：${prompt.node.relPath}`
          }
          validate={nameError}
          onSubmit={async (value) => {
            if (prompt.kind === 'new-doc') {
              await actions.createEntry('doc', prompt.parent, value);
            } else if (prompt.kind === 'new-dir') {
              await actions.createEntry('dir', prompt.parent, value);
            } else {
              const node = prompt.node;
              let name = value;
              if (node.type === 'doc') {
                // 保留原扩展名：用户改名时几乎不会记得带上 .md
                const ext = node.name.match(/\.[^.]+$/)?.[0] ?? '';
                if (ext && !name.toLowerCase().endsWith(ext.toLowerCase())) name += ext;
              }
              const parent = parentOf(node.relPath);
              await actions.renameEntry(node.relPath, parent ? `${parent}/${name}` : name);
            }
          }}
          onClose={() => setPrompt(null)}
        />
      ) : null}

      {pendingDelete ? (
        <ConfirmDialog
          title={pendingDelete.type === 'doc' ? '删除这篇文章？' : '删除这个文件夹？'}
          danger
          confirmText="移到回收站"
          message={
            <>
              <div style={{ marginBottom: 10 }}>
                <code>{pendingDelete.relPath}</code>
              </div>
              <div>
                {pendingDelete.type === 'doc'
                  ? '文件会被移到笔记库里的 .notebook/trash 目录，批注和小抄跟着一起走，不会真的从磁盘上抹掉。'
                  : '整个文件夹（含里面的所有文章和批注）都会被移到 .notebook/trash，不会真的从磁盘上抹掉。'}
              </div>
              <div style={{ marginTop: 10, color: 'var(--text-3)', fontSize: 12.5 }}>
                <AnchorIcon width={12} height={12} style={{ verticalAlign: -2 }} /> 想撤销的话，去笔记库里把
                <code>.notebook/trash</code> 下的内容移回来即可。
              </div>
            </>
          }
          onConfirm={() => actions.removeEntry(pendingDelete.relPath)}
          onClose={() => setPendingDelete(null)}
        />
      ) : null}
    </div>
  );
}
