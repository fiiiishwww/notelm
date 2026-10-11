/**
 * src/state/store.tsx —— 全局状态容器。
 *
 * 为什么不用 useState 堆在 App 里：三栏之间共享的东西太多了
 * （当前文章、批注列表、选中的批注、锚点状态、编辑器草稿、冲突版本），
 * 用 props 一层层传会把组件签名搞得没法看。
 *
 * 为什么不用 zustand / redux：这个应用的状态机就是「一份文档 + 一组批注 +
 * 几个面板开关」，useReducer + Context 完全够，不值得多一个依赖。
 *
 * ★ 一条重要约定：写操作**不做全量刷新**。
 *   新建/修改/删除一条批注后，服务端只返回那条记录，我们就地更新本地 sidecar，
 *   而不是重新拉整篇文档。原因：重新拉会重建正文 DOM，滚动位置、高亮层、
 *   正在编辑的输入框全都会被重置，用户会以为界面「闪了一下」。
 *   只有「保存正文」和「手动重锚」这两种真正改变文档结构的情况才整篇替换。
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from 'react';
import {
  api,
  ApiError,
  errorText,
  type AnchorReport,
  type AttemptResult,
  type AgentChatStepEvent,
  type DocPayload,
  type SettingsState,
  type TreeNode,
} from '../api';
import { applyThemeColor, DEFAULT_THEME_COLOR } from '../lib/themeColor';
import { usageLine } from '../lib/agentUsage';
import type { Card, CheatsheetSection, Highlight, Note, Quiz, Sidecar, TextQuoteSelector } from '../../shared/text';

// ─────────────────────────── 状态 ───────────────────────────

export type ToastKind = 'ok' | 'info' | 'warn' | 'error';

export interface Toast {
  id: string;
  kind: ToastKind;
  text: string;
}

/** 用户在正文里选中的一段文字，等待被写成批注或高亮。 */
export interface PendingSelection {
  selector: TextQuoteSelector;
  /** 选区在视口里的位置，用来定位浮动工具条 */
  rect: { x: number; y: number; bottom: number; width: number };
}

export interface FocusTarget {
  kind: 'note' | 'highlight';
  id: string;
}

export interface ConflictState {
  diskMarkdown: string;
  diskHash: string;
}

export type EditorMode = 'edit' | 'preview';

/** 右栏停在「批注」「学习」还是「检索」。放在 store 里是为了让正文也能切过去——
 *  否则用户在正文点了「生成小抄」，结果却生成到右栏看不见的那个页签上。 */
export type RightTab = 'notes' | 'study' | 'search';

export interface AppState {
  booted: boolean;
  bootError: string | null;
  settings: SettingsState | null;

  tree: TreeNode | null;
  treeLoading: boolean;
  expanded: Record<string, boolean>;

  activeRel: string | null;
  doc: DocPayload | null;
  docLoading: boolean;
  docError: string | null;
  anchorReport: AnchorReport | null;

  /**
   * 目录树里「选中的节点」——新建 / 上传 / 拖拽的落点，可以是文件夹也可以是文档。
   *
   * 和 `activeRel` 分工明确，别混用：
   * - `activeRel`   = 中间栏正在处理的那篇文章（只能是文档）
   * - `selectedRel` = 用户在左栏点选的落点（可以是文件夹）
   *
   * 缺了这个字段，「新建」只能猜落点（以前是猜当前文章所在目录），
   * 于是每次新建都落回同一个文件夹。
   */
  selectedRel: string | null;

  editorOpen: boolean;
  editorMode: EditorMode;
  draft: string;
  conflict: ConflictState | null;

  settingsOpen: boolean;
  rightTab: RightTab;
  focus: FocusTarget | null;
  pending: PendingSelection | null;
  /** 「正在重新绑定」模式下等待用户点选新位置的批注 */
  rebinding: FocusTarget | null;
  /**
   * 等文章渲染出来之后再跳过去并闪一下的那个块。
   *
   * 为什么需要它：从检索结果 / 相关段落跳到**别的**文章时，openDoc 是异步的
   * （发请求拿 HTML），调用方没法知道正文 DOM 什么时候才在页面上。
   * 以前的做法是「等两帧再找元素」，跨文档时两帧根本不够，元素还是 null，
   * 于是跳转静默失败——用户看到的就是「跳过去了但没高亮」。
   * 存成状态之后，由渲染正文的那个组件在 DOM 真正提交后消费它。
   */
  pendingJump: { rel: string; bi: number } | null;

  busy: string | null;
  /** 正在被助手流式回答的批注（noteId）+ 实时步骤轨迹；回答结束即清空。 */
  agentLive: { noteId: string; steps: AgentChatStepEvent[] } | null;
  toasts: Toast[];
}

const STORAGE_LAST_DOC = 'nb.lastDoc';
const STORAGE_EXPANDED = 'nb.expanded';
const STORAGE_RIGHT_TAB = 'nb.rightTab';

function loadExpanded(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(STORAGE_EXPANDED);
    return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

function loadRightTab(): RightTab {
  try {
    const v = localStorage.getItem(STORAGE_RIGHT_TAB);
    return v === 'study' || v === 'search' ? v : 'notes';
  } catch {
    return 'notes';
  }
}

const initialState: AppState = {
  booted: false,
  bootError: null,
  settings: null,
  tree: null,
  treeLoading: false,
  expanded: loadExpanded(),
  activeRel: null,
  selectedRel: null,
  doc: null,
  docLoading: false,
  docError: null,
  anchorReport: null,
  editorOpen: false,
  editorMode: 'preview',
  draft: '',
  conflict: null,
  settingsOpen: false,
  rightTab: loadRightTab(),
  focus: null,
  pending: null,
  rebinding: null,
  pendingJump: null,
  busy: null,
  agentLive: null,
  toasts: [],
};

// ─────────────────────────── Actions ───────────────────────────

type Action =
  | { type: 'boot/fail'; message: string }
  | { type: 'boot/done'; settings: SettingsState; tree: TreeNode }
  | { type: 'settings/replace'; settings: SettingsState }
  | { type: 'settings/open' }
  | { type: 'settings/close' }
  | { type: 'rightTab/set'; tab: RightTab }
  | { type: 'prefs/set'; theme?: 'light' | 'dark'; themeColor?: string; panelWidths?: { left: number; right: number } }
  | { type: 'tree/loading' }
  | { type: 'tree/set'; tree: TreeNode }
  | { type: 'tree/expand'; rel: string; open: boolean }
  | { type: 'tree/expandMany'; rels: string[] }
  | { type: 'tree/select'; rel: string | null }
  /** 移动/重命名后，把 expanded / selectedRel / activeRel 里的旧前缀整棵搬过去 */
  | { type: 'tree/remapPrefix'; from: string; to: string }
  | { type: 'doc/loading'; rel: string }
  | { type: 'doc/loaded'; doc: DocPayload }
  | { type: 'doc/error'; message: string }
  | { type: 'sidecar/replace'; sidecar: Sidecar }
  | { type: 'note/upsert'; note: Note }
  | { type: 'note/remove'; id: string; keepHighlight: boolean }
  | { type: 'highlight/upsert'; highlight: Highlight }
  | { type: 'highlight/remove'; id: string }
  | { type: 'cards/upsertMany'; cards: Card[] }
  | { type: 'cards/remove'; id: string }
  | { type: 'quiz/upsert'; quiz: Quiz }
  | { type: 'cheatsheet/set'; sections: CheatsheetSection[] }
  | { type: 'editor/open'; mode: EditorMode }
  | { type: 'editor/mode'; mode: EditorMode }
  | { type: 'editor/close' }
  | { type: 'editor/draft'; text: string }
  | { type: 'editor/conflict'; conflict: ConflictState | null }
  | { type: 'focus/set'; focus: FocusTarget | null }
  | { type: 'pending/set'; pending: PendingSelection | null }
  | { type: 'rebind/set'; target: FocusTarget | null }
  | { type: 'jump/pending'; jump: { rel: string; bi: number } | null }
  | { type: 'busy/set'; text: string | null }
  | { type: 'agentLive/set'; live: { noteId: string; steps: AgentChatStepEvent[] } | null }
  | { type: 'toast/push'; toast: Toast }
  | { type: 'toast/dismiss'; id: string }
  | { type: 'anchor/report'; report: AnchorReport | null };

function patchSidecar(state: AppState, fn: (s: Sidecar) => Sidecar): AppState {
  if (!state.doc) return state;
  return { ...state, doc: { ...state.doc, sidecar: fn(state.doc.sidecar) } };
}

/** 就地把某个 id 的元素替换/追加进数组。 */
function upsertById<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  if (i < 0) return [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
}

// ─────────────────────────── 路径工具 ───────────────────────────

function parentOf(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i < 0 ? '' : rel.slice(0, i);
}

/**
 * 把 `rel` 里的前缀 `from` 换成 `to`（用于移动/重命名后修状态）。
 * `rel === from` 或 `rel` 是 `from` 的子孙都会搬；否则原样返回。
 */
function remapPath(rel: string, from: string, to: string): string {
  if (!rel || !from) return rel;
  if (rel === from) return to;
  if (rel.startsWith(`${from}/`)) return to + rel.slice(from.length);
  return rel;
}

function reducer(state: AppState, a: Action): AppState {
  switch (a.type) {
    case 'boot/fail':
      return { ...state, booted: true, bootError: a.message };
    case 'boot/done':
      return { ...state, booted: true, bootError: null, settings: a.settings, tree: a.tree, treeLoading: false };
    case 'settings/replace':
      return { ...state, settings: a.settings };
    case 'settings/open':
      return { ...state, settingsOpen: true };
    case 'settings/close':
      return { ...state, settingsOpen: false };
    case 'rightTab/set':
      return { ...state, rightTab: a.tab };
    case 'prefs/set':
      if (!state.settings) return state;
      return {
        ...state,
        settings: {
          ...state.settings,
          theme: a.theme ?? state.settings.theme,
          themeColor: a.themeColor ?? state.settings.themeColor,
          panelWidths: a.panelWidths ?? state.settings.panelWidths,
        },
      };
    case 'tree/loading':
      return { ...state, treeLoading: true };
    case 'tree/set':
      return { ...state, tree: a.tree, treeLoading: false };
    case 'tree/expand': {
      const expanded = { ...state.expanded, [a.rel]: a.open };
      return { ...state, expanded };
    }
    case 'tree/expandMany': {
      const expanded = { ...state.expanded };
      for (const r of a.rels) expanded[r] = true;
      return { ...state, expanded };
    }
    case 'tree/select':
      return state.selectedRel === a.rel ? state : { ...state, selectedRel: a.rel };
    case 'tree/remapPrefix': {
      // 移动目录后，它的子目录在 expanded 里的 key 全变了，不搬的话展开态会丢
      const expanded: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(state.expanded)) {
        if (!v) continue;
        expanded[remapPath(k, a.from, a.to)] = true;
      }
      return {
        ...state,
        expanded,
        selectedRel: state.selectedRel ? remapPath(state.selectedRel, a.from, a.to) : state.selectedRel,
        activeRel: state.activeRel ? remapPath(state.activeRel, a.from, a.to) : state.activeRel,
      };
    }
    case 'doc/loading':
      // 换文章时把上一篇文章的批注、选区、焦点、报告全部清掉，
      // 否则会看到「新文章的正文 + 旧文章的批注」这种串台画面
      return {
        ...state,
        activeRel: a.rel,
        // rel 为空是「文章被删了，清空文档」的分支，这时候别动选中态，
        // 否则用户刚删完一篇，落点就跳回根目录了
        selectedRel: a.rel || state.selectedRel,
        docLoading: true,
        docError: null,
        doc: null,
        anchorReport: null,
        focus: null,
        pending: null,
        rebinding: null,
        editorOpen: false,
        conflict: null,
        draft: '',
      };
    case 'doc/loaded':
      return {
        ...state,
        doc: a.doc,
        activeRel: a.doc.path,
        // 打开一篇文章 = 把落点选到它身上，这样紧接着「新建」会建在同级目录
        selectedRel: a.doc.path,
        docLoading: false,
        docError: null,
        anchorReport: a.doc.anchorReport,
        focus: null,
        pending: null,
        rebinding: null,
        conflict: null,
      };
    case 'doc/error':
      return { ...state, docLoading: false, docError: a.message };
    case 'sidecar/replace':
      if (!state.doc) return state;
      return { ...state, doc: { ...state.doc, sidecar: a.sidecar } };
    case 'note/upsert':
      return patchSidecar(state, (s) => ({ ...s, notes: upsertById(s.notes, a.note) }));
    case 'note/remove':
      return patchSidecar(state, (s) => ({
        ...s,
        notes: s.notes.filter((n) => n.id !== a.id),
        highlights: a.keepHighlight
          ? s.highlights.map((h) => (h.noteId === a.id ? { ...h, noteId: null } : h))
          : s.highlights.filter((h) => h.noteId !== a.id),
        cards: s.cards.filter((c) => !(c.source.type === 'note' && c.source.refId === a.id)),
      }));
    case 'highlight/upsert':
      return patchSidecar(state, (s) => ({ ...s, highlights: upsertById(s.highlights, a.highlight) }));
    case 'highlight/remove':
      return patchSidecar(state, (s) => ({ ...s, highlights: s.highlights.filter((h) => h.id !== a.id) }));
    /**
     * 按 id 合并，不是无脑追加。
     * 闪卡复习完要拿服务端返回的新卡更新本地（SM-2 的到期日变了），
     * 追加会在列表里出现两张一样的卡。
     */
    case 'cards/upsertMany':
      return patchSidecar(state, (s) => ({ ...s, cards: a.cards.reduce((acc, c) => upsertById(acc, c), s.cards) }));
    case 'cards/remove':
      return patchSidecar(state, (s) => ({ ...s, cards: s.cards.filter((c) => c.id !== a.id) }));
    case 'quiz/upsert':
      return patchSidecar(state, (s) => ({ ...s, quizzes: upsertById(s.quizzes, a.quiz) }));
    case 'cheatsheet/set':
      return patchSidecar(state, (s) => ({ ...s, cheatsheet: { sections: a.sections } }));
    case 'editor/open':
      return { ...state, editorOpen: true, editorMode: a.mode, draft: state.doc?.markdown ?? '', conflict: null };
    case 'editor/mode':
      return { ...state, editorMode: a.mode };
    case 'editor/close':
      return { ...state, editorOpen: false, conflict: null, draft: '' };
    case 'editor/draft':
      return { ...state, draft: a.text };
    case 'editor/conflict':
      return { ...state, conflict: a.conflict };
    case 'focus/set':
      return { ...state, focus: a.focus };
    case 'pending/set':
      return { ...state, pending: a.pending };
    case 'rebind/set':
      return { ...state, rebinding: a.target, pending: null };
    case 'jump/pending':
      return { ...state, pendingJump: a.jump };
    case 'busy/set':
      return { ...state, busy: a.text };
    case 'agentLive/set':
      return { ...state, agentLive: a.live };
    case 'toast/push':
      return { ...state, toasts: [...state.toasts, a.toast] };
    case 'toast/dismiss':
      return { ...state, toasts: state.toasts.filter((t) => t.id !== a.id) };
    case 'anchor/report':
      return { ...state, anchorReport: a.report };
    default:
      return state;
  }
}

// ─────────────────────────── Context ───────────────────────────

export interface AppActions {
  boot(): Promise<void>;
  reloadTree(): Promise<void>;
  openDoc(rel: string): Promise<void>;
  reloadDoc(): Promise<void>;
  dismissAnchorReport(): void;
  toast(kind: ToastKind, text: string): void;
  dismissToast(id: string): void;
  setBusy(text: string | null): void;

  toggleDir(rel: string, open: boolean): void;

  setVault(patch: { root?: string; useDefault?: boolean }): Promise<void>;
  saveAi(patch: { baseURL?: string; model?: string; temperature?: number; apiKey?: string }): Promise<void>;
  clearAiKey(): Promise<void>;
  /** 检索用的向量接口，独立的一套地址 / 模型 / Key */
  saveEmbedding(patch: { baseURL?: string; model?: string; dimensions?: number; apiKey?: string }): Promise<void>;
  clearEmbeddingKey(): Promise<void>;
  /**
   * 飞书导入用的第三套凭据（app_id + app_secret）。
   * 和前两套不共用：它不是接口地址 + 模型名 + Key，而是换 tenant_access_token 的一对凭据。
   */
  saveFeishu(patch: { appId?: string; appSecret?: string }): Promise<void>;
  clearFeishuSecret(): Promise<void>;
  /** 只重新拉一次服务端设置（设置页自己直接调了 api，需要把结果同步回全局状态） */
  refreshSettings(): Promise<void>;
  setTheme(theme: 'light' | 'dark'): void;
  /** 设置里的「主题颜色」：存 #RRGGBB，派生值由 lib/themeColor 算 */
  setThemeColor(hex: string): void;
  savePanelWidths(w: { left: number; right: number }): void;

  openSettings(): void;
  closeSettings(): void;
  setRightTab(tab: RightTab): void;

  createEntry(type: 'doc' | 'dir', parent: string, name: string): Promise<string | null>;
  renameEntry(from: string, to: string): Promise<void>;
  removeEntry(rel: string): Promise<void>;
  reveal(rel: string): Promise<void>;
  /** 在系统文件管理器里打开笔记库根目录（rel 为空时用它，不要用 reveal('')） */
  openVault(): Promise<void>;
  /** 左栏点选节点：决定新建/上传/拖拽的落点，可以是文件夹 */
  selectNode(rel: string | null): void;
  /** 拖拽移动条目，目标路径给完整的 rel */
  moveEntry(from: string, to: string): Promise<void>;

  openEditor(mode?: EditorMode): void;
  setEditorMode(mode: EditorMode): void;
  closeEditor(): void;
  setDraft(text: string): void;
  saveDoc(opts?: { force?: boolean }): Promise<void>;
  resolveConflictWithDisk(): Promise<void>;
  /** 用一段新的 markdown 覆盖正文（一键排版 / AI 排版的结果走这里进编辑器预览） */
  openEditorWith(markdown: string): void;

  setPending(p: PendingSelection | null): void;
  setFocus(f: FocusTarget | null): void;
  startRebind(target: FocusTarget | null): void;
  /** 请求跳到某篇文章的第 bi 块：正文 DOM 就绪后由 ArticlePane 真正执行滚动 + 高亮 */
  requestJump(rel: string, bi: number): void;
  clearJump(): void;

  createNote(patch: { selector: TextQuoteSelector; body: string; tags?: string[]; color?: string; createHighlight?: boolean }): Promise<Note | null>;
  updateNote(id: string, patch: { body?: string; tags?: string[]; color?: string }): Promise<void>;
  removeNote(id: string, keepHighlight?: boolean): Promise<void>;
  /** 让库内 agent 就地回答一条批注（B2-3，agent 自己经 reply_note 工具落盘）。 */
  askAssistant(noteId: string): Promise<boolean>;
  createHighlight(patch: { selector: TextQuoteSelector; color?: string; noteId?: string | null }): Promise<Highlight | null>;
  updateHighlight(id: string, patch: { color?: string; noteId?: string | null }): Promise<void>;
  removeHighlight(id: string): Promise<void>;
  rebindTo(selector: TextQuoteSelector): Promise<void>;
  runReanchor(): Promise<void>;
  /** 把当前这篇过长的文档按标题切成若干篇；切完自动打开第一篇。 */
  splitDoc(opts?: { maxBlocks?: number }): Promise<void>;
  clearAnnotations(what?: 'notes' | 'highlights' | 'all'): Promise<void>;

  generateCheatsheet(opts?: { headingIds?: string[]; force?: boolean; strict?: boolean }): Promise<void>;
  /** 为一节生成知识树（2026-09-20 接入，chapter1 先试点）。 */
  generateTree(headingId: string, force?: boolean): Promise<void>;
  /**
   * 批量：为整篇文章逐节生成知识树（小抄下岗后的「生成全部」）。
   * 串行走单节端点，端点自己会复用没变的树（reused），所以重复点不浪费额度。
   */
  generateAllTrees(): Promise<void>;
  generateQuiz(headingId: string, count?: number): Promise<Quiz | null>;
  cardsFromCheatsheet(headingId: string): Promise<void>;
  /** 知识树 → 闪卡。现在的主路径：只有树能出卡，所以这一条覆盖了实际能用的场景。 */
  cardsFromTree(headingId: string): Promise<void>;
  cardsFromNotes(noteIds?: string[]): Promise<void>;
  createCard(patch: { front: string; back: string; headingId?: string; quote?: string }): Promise<void>;
  deleteCard(id: string): Promise<void>;
  deleteQuiz(quizId: string): Promise<void>;
  deleteCheatsheet(headingId?: string): Promise<void>;

  /** 交卷。返回判分结果；失败返回 null（错误提示已经在 action 里 toast 过了）。 */
  submitQuiz(patch: { quizId: string; answers: Record<string, (number | string)[]>; durationMs?: number }): Promise<AttemptResult | null>;
  /** 给一张闪卡打分（SM-2）。 grade: 忘了 / 有点难 / 记住了 */
  reviewCard(cardId: string, grade: 'forgot' | 'hard' | 'good'): Promise<void>;
  /** 闪卡反馈三件套（▲有用/▽反馈/⧉重复）。fb=null 取消标注；fbWhy 只在 fb='down' 时有意义。 */
  cardFeedback(cardId: string, fb: 'up' | 'down' | 'dup' | null, fbWhy?: string): Promise<void>;
}

interface Ctx {
  state: AppState;
  actions: AppActions;
}

const AppCtx = createContext<Ctx | null>(null);

export function useApp(): Ctx {
  const c = useContext(AppCtx);
  if (!c) throw new Error('useApp 必须在 <AppProvider> 内部使用');
  return c;
}

/** 只取状态的便捷 hook。 */
export function useAppState(): AppState {
  return useApp().state;
}

// ─────────────────────────── Provider ───────────────────────────

/** 从相对路径推出所有祖先目录（用于自动展开目录树）。 */
function ancestorsOf(rel: string): string[] {
  const parts = rel.split('/');
  parts.pop();
  const out: string[] = [];
  let cur = '';
  for (const p of parts) {
    cur = cur ? `${cur}/${p}` : p;
    out.push(cur);
  }
  return out;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const stateRef = useRef(state);
  stateRef.current = state;

  // ── 主题：写到 <html data-theme>，CSS 变量跟着切换 ──
  useEffect(() => {
    const theme = state.settings?.theme ?? 'light';
    document.documentElement.dataset.theme = theme;
  }, [state.settings?.theme]);

  const toast = useCallback((kind: ToastKind, text: string) => {
    const id = `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    dispatch({ type: 'toast/push', toast: { id, kind, text } });
    // 自动消失由 Toasts 组件负责（那里才知道用户是不是正按着这条在读），
    // 这里只管入队——两边都设定时器会出现「不到时间就消失」。
  }, []);

  const setBusy = useCallback((text: string | null) => dispatch({ type: 'busy/set', text }), []);

  const reloadTree = useCallback(async () => {
    dispatch({ type: 'tree/loading' });
    try {
      const { tree } = await api.tree();
      dispatch({ type: 'tree/set', tree });
    } catch (e) {
      dispatch({ type: 'tree/set', tree: { type: 'dir', name: 'notes', relPath: '', mtime: 0, size: 0, children: [] } });
      if (e instanceof ApiError && e.isVaultMissing) {
        // 笔记库还没设置，交给设置页处理，不弹错
        return;
      }
      toast('error', errorText(e));
    }
  }, [toast]);

  const openDoc = useCallback(
    async (rel: string) => {
      if (!rel) return;
      dispatch({ type: 'doc/loading', rel });
      dispatch({ type: 'tree/expandMany', rels: ancestorsOf(rel) });
      try {
        const doc = await api.doc(rel);
        dispatch({ type: 'doc/loaded', doc });
        try {
          localStorage.setItem(STORAGE_LAST_DOC, rel);
        } catch {
          /* 隐私模式下 localStorage 可能不可用，无所谓 */
        }
        const rep = doc.anchorReport;
        if (rep && rep.repaired > 0) {
          toast('info', `这篇文章在外部被改过：${rep.repaired} 条批注已自动跟随移动` + (rep.orphan ? `，${rep.orphan} 条失效` : ''));
        }
      } catch (e) {
        dispatch({ type: 'doc/error', message: errorText(e) });
        toast('error', errorText(e));
      }
    },
    [toast],
  );

  const boot = useCallback(async () => {
    try {
      const settings = await api.settingsState();
      dispatch({ type: 'settings/replace', settings });
      if (!settings.vault.configured) {
        dispatch({ type: 'boot/done', settings, tree: { type: 'dir', name: 'notes', relPath: '', mtime: 0, size: 0, children: [] } });
        return;
      }
      const { tree } = await api.tree();
      dispatch({ type: 'boot/done', settings, tree });

      // 恢复上次打开的文章；它可能已被删掉，所以要确认还在树里
      const docs = new Set<string>();
      const collect = (n: TreeNode) => {
        if (n.type === 'doc') docs.add(n.relPath);
        for (const c of n.children ?? []) collect(c);
      };
      collect(tree);

      let last: string | null = null;
      try {
        last = localStorage.getItem(STORAGE_LAST_DOC);
      } catch {
        /* ignore */
      }
      const pick = last && docs.has(last) ? last : [...docs][0] ?? null;
      if (pick) await openDoc(pick);
    } catch (e) {
      dispatch({ type: 'boot/fail', message: errorText(e) });
    }
  }, [openDoc]);

  // 启动时只跑一次
  useEffect(() => {
    void boot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── 目录树展开状态持久化 ──
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_EXPANDED, JSON.stringify(state.expanded));
    } catch {
      /* ignore */
    }
  }, [state.expanded]);

  const selectNode = useCallback((rel: string | null) => dispatch({ type: 'tree/select', rel }), []);

  const toggleDir = useCallback((rel: string, open: boolean) => {
    // 点文件夹 = 选中 + 展开。选中决定「新建」落到哪，展开是顺带的手感；
    // 只做展开的话，新建就只能去猜落点（这正是以前只能建到某个固定文件夹的原因）。
    dispatch({ type: 'tree/select', rel });
    dispatch({ type: 'tree/expand', rel, open });
  }, []);

  const savePanelWidths = useCallback((w: { left: number; right: number }) => {
    dispatch({ type: 'prefs/set', panelWidths: w });
    // 面板宽度属于「顺手改一下」的偏好，不值得为每次拖动都发请求；
    // 300ms 内的连续拖动合并成一次。
    void api.setPrefs({ panelWidths: w }).catch(() => undefined);
  }, []);

  const setTheme = useCallback((theme: 'light' | 'dark') => {
    dispatch({ type: 'prefs/set', theme });
    void api.setPrefs({ theme }).catch(() => undefined);
  }, []);

  const setThemeColor = useCallback((hex: string) => {
    dispatch({ type: 'prefs/set', themeColor: hex });
    void api.setPrefs({ themeColor: hex }).catch(() => undefined);
  }, []);

  // ── 主题色：设置里存的 #RRGGBB → CSS 变量。启动（boot/done 灌入 settings）和
  // 用户改色都会走到这里；派生值在 lib/themeColor 里算，这里只负责落地。
  useEffect(() => {
    applyThemeColor(state.settings?.themeColor ?? DEFAULT_THEME_COLOR);
  }, [state.settings?.themeColor]);

  const refreshSettings = useCallback(async () => {
    try {
      const settings = await api.settingsState();
      dispatch({ type: 'settings/replace', settings });
    } catch (e) {
      toast('error', errorText(e));
    }
  }, [toast]);

  const setVault = useCallback(
    async (patch: { root?: string; useDefault?: boolean }) => {
      setBusy('正在设置笔记库…');
      try {
        const { vault } = await api.setVault(patch);
        await refreshSettings();
        await reloadTree();
        if (vault.configured) {
          toast('ok', `笔记库已设置为 ${vault.name || vault.root}`);
          // 首次设置后自动打开第一篇文章，否则用户会看到一个空界面不知所措
          const cur = stateRef.current;
          const first = cur.tree?.children?.find((c) => c.type === 'doc');
          if (first) await openDoc(first.relPath);
        }
      } catch (e) {
        toast('error', errorText(e));
      } finally {
        setBusy(null);
      }
    },
    [openDoc, refreshSettings, reloadTree, setBusy, toast],
  );

  const saveAi = useCallback(
    async (patch: { baseURL?: string; model?: string; temperature?: number; apiKey?: string }) => {
      try {
        await api.setAi(patch);
        await refreshSettings();
        toast('ok', 'AI 配置已保存');
      } catch (e) {
        toast('error', errorText(e));
      }
    },
    [refreshSettings, toast],
  );

  const clearAiKey = useCallback(async () => {
    try {
      await api.clearAiKey();
      await refreshSettings();
      toast('ok', 'API Key 已清空');
    } catch (e) {
      toast('error', errorText(e));
    }
  }, [refreshSettings, toast]);

  /** 向量接口：和对话接口分开保存，互不覆盖 */
  const saveEmbedding = useCallback(
    async (patch: { baseURL?: string; model?: string; dimensions?: number; apiKey?: string }) => {
      try {
        await api.setEmbedding(patch);
        await refreshSettings();
        toast('ok', '向量接口配置已保存');
      } catch (e) {
        toast('error', errorText(e));
      }
    },
    [refreshSettings, toast],
  );

  const clearEmbeddingKey = useCallback(async () => {
    try {
      await api.clearEmbeddingKey();
      await refreshSettings();
      toast('ok', '向量接口 Key 已清空');
    } catch (e) {
      toast('error', errorText(e));
    }
  }, [refreshSettings, toast]);

  /** 飞书导入：保存后立刻让服务端丢掉旧的 tenant_access_token 缓存 */
  const saveFeishu = useCallback(
    async (patch: { appId?: string; appSecret?: string }) => {
      try {
        await api.setFeishu(patch);
        await refreshSettings();
        toast('ok', '飞书配置已保存');
      } catch (e) {
        toast('error', errorText(e));
      }
    },
    [refreshSettings, toast],
  );

  const clearFeishuSecret = useCallback(async () => {
    try {
      await api.clearFeishuSecret();
      await refreshSettings();
      toast('ok', '飞书 App Secret 已清空');
    } catch (e) {
      toast('error', errorText(e));
    }
  }, [refreshSettings, toast]);

  const createEntry = useCallback(
    async (type: 'doc' | 'dir', parent: string, name: string) => {
      try {
        const r = await api.createEntry({ type, parent, name });
        if (parent) dispatch({ type: 'tree/expand', rel: parent, open: true });
        await reloadTree();
        // 选中刚建的条目。建文档时 openDoc 也会顺带选中它，但建文件夹没人选，
        // 少了这行新建文件夹后落点就丢了。
        dispatch({ type: 'tree/select', rel: r.relPath });
        if (type === 'doc') await openDoc(r.relPath);
        toast('ok', type === 'doc' ? `已新建文章「${name}」` : `已新建文件夹「${name}」`);
        return r.relPath;
      } catch (e) {
        toast('error', errorText(e));
        return null;
      }
    },
    [openDoc, reloadTree, toast],
  );

  const renameEntry = useCallback(
    async (from: string, to: string) => {
      try {
        await api.renameEntry(from, to);
        await reloadTree();
        dispatch({ type: 'tree/remapPrefix', from, to });
        const cur = stateRef.current;
        if (cur.activeRel === from) await openDoc(to);
        toast('ok', '已重命名');
      } catch (e) {
        toast('error', errorText(e));
      }
    },
    [openDoc, reloadTree, toast],
  );

  const removeEntry = useCallback(
    async (rel: string) => {
      try {
        const r = await api.deleteEntry(rel);
        await reloadTree();
        const cur = stateRef.current;
        // 选中的是它自己或它的子孙 → 退到父目录，否则落点会指向一个已经不存在的路径
        if (cur.selectedRel && (cur.selectedRel === rel || cur.selectedRel.startsWith(`${rel}/`))) {
          dispatch({ type: 'tree/select', rel: parentOf(rel) || null });
        }
        if (cur.activeRel && (cur.activeRel === rel || cur.activeRel.startsWith(`${rel}/`))) {
          dispatch({ type: 'doc/error', message: '这篇文章已被移到回收站' });
          dispatch({ type: 'doc/loading', rel: '' });
        }
        toast('ok', `已移到回收站（${r.trashedTo}）`);
      } catch (e) {
        toast('error', errorText(e));
      }
    },
    [reloadTree, toast],
  );

  const reveal = useCallback(
    async (rel: string) => {
      try {
        await api.reveal(rel);
      } catch (e) {
        toast('error', errorText(e));
      }
    },
    [toast],
  );

  /**
   * 在系统文件管理器里打开笔记库根目录。
   *
   * 不能拿 `reveal('')` 顶替：`/reveal` 的 schema 要求 rel 至少 1 个字符，
   * 空串会被拒（这就是以前那个按钮必定报错的原因）。后端本来就有专门的
   * `/open-vault`，设置页一直在用它。
   */
  const openVault = useCallback(async () => {
    try {
      await api.openVault();
    } catch (e) {
      toast('error', errorText(e));
    }
  }, [toast]);

  /**
   * 拖拽移动（也用于「移动到…」）。后端 `PATCH /entry` 用 rename 实现，
   * 跨目录移动时 sidecar 批注/小抄/闪卡会跟着迁移，所以这里不用重新拉文档。
   */
  const moveEntry = useCallback(
    async (from: string, to: string) => {
      if (!from || !to || from === to) return;
      const before = stateRef.current;
      try {
        await api.renameEntry(from, to);
        await reloadTree();
        dispatch({ type: 'tree/remapPrefix', from, to });
        // 移动的是包含当前文章的目录时，activeRel 已经变了，必须重新打开
        if (before.activeRel && (before.activeRel === from || before.activeRel.startsWith(`${from}/`))) {
          await openDoc(remapPath(before.activeRel, from, to));
        }
        const dir = parentOf(to);
        toast('ok', `已移动到「${dir || '笔记库根目录'}」`);
      } catch (e) {
        const msg = errorText(e);
        toast('error', /已存在/.test(msg) ? `那边已经有一个同名文件了：${msg}` : msg);
      }
    },
    [openDoc, reloadTree, toast],
  );

  // ── 编辑器 ──

  const openEditor = useCallback((mode: EditorMode = 'edit') => dispatch({ type: 'editor/open', mode }), []);
  const setEditorMode = useCallback((mode: EditorMode) => dispatch({ type: 'editor/mode', mode }), []);
  const closeEditor = useCallback(() => dispatch({ type: 'editor/close' }), []);
  const setDraft = useCallback((text: string) => dispatch({ type: 'editor/draft', text }), []);
  const openEditorWith = useCallback((markdown: string) => {
    dispatch({ type: 'editor/open', mode: 'edit' });
    dispatch({ type: 'editor/draft', text: markdown });
  }, []);

  const saveDoc = useCallback(
    async (opts: { force?: boolean } = {}) => {
      const cur = stateRef.current;
      if (!cur.activeRel || !cur.doc) return;
      setBusy('正在保存…');
      try {
        const payload = await api.saveDoc({
          rel: cur.activeRel,
          markdown: cur.draft,
          baseHash: opts.force ? undefined : cur.doc.docHash,
          force: opts.force,
        });
        dispatch({ type: 'doc/loaded', doc: payload });
        dispatch({ type: 'editor/close' });
        await reloadTree();
        toast('ok', '已保存到磁盘');
      } catch (e) {
        if (e instanceof ApiError && e.isConflict) {
          // 不弹 toast：接下来要展示一个并排比较面板，那本身就是最清楚的提示
          dispatch({
            type: 'editor/conflict',
            conflict: {
              diskMarkdown: String(e.extra.diskMarkdown ?? ''),
              diskHash: String(e.extra.diskHash ?? ''),
            },
          });
          return;
        }
        toast('error', errorText(e));
      } finally {
        setBusy(null);
      }
    },
    [reloadTree, setBusy, toast],
  );

  const resolveConflictWithDisk = useCallback(async () => {
    const cur = stateRef.current;
    if (!cur.activeRel || !cur.conflict) return;
    // 采纳磁盘版本：重新拉一次文档，草稿丢掉（用户明确选择了「以磁盘为准」）
    dispatch({ type: 'editor/conflict', conflict: null });
    await openDoc(cur.activeRel);
    dispatch({ type: 'editor/close' });
    toast('info', '已采用磁盘上的版本，你的未保存修改已丢弃');
  }, [openDoc, toast]);

  const reloadDoc = useCallback(async () => {
    const cur = stateRef.current;
    if (cur.activeRel) await openDoc(cur.activeRel);
  }, [openDoc]);

  // ── 选区与焦点 ──

  const setPending = useCallback((p: PendingSelection | null) => dispatch({ type: 'pending/set', pending: p }), []);
  const setFocus = useCallback((focus: FocusTarget | null) => dispatch({ type: 'focus/set', focus }), []);
  const startRebind = useCallback((target: FocusTarget | null) => {
    dispatch({ type: 'rebind/set', target });
    if (target) dispatch({ type: 'focus/set', focus: target });
  }, []);
  /** 只登记「要跳到哪儿」，真正的滚动和高亮由 ArticlePane 在 DOM 就绪后做。 */
  const requestJump = useCallback((rel: string, bi: number) => {
    dispatch({ type: 'jump/pending', jump: { rel, bi } });
  }, []);
  const clearJump = useCallback(() => dispatch({ type: 'jump/pending', jump: null }), []);

  // ── 批注 / 高亮 ──

  const createNote = useCallback<AppActions['createNote']>(
    async (patch) => {
      const cur = stateRef.current;
      if (!cur.activeRel) return null;
      try {
        const r = await api.createNote({ rel: cur.activeRel, ...patch });
        dispatch({ type: 'note/upsert', note: r.note });
        if (r.highlight) dispatch({ type: 'highlight/upsert', highlight: r.highlight });
        dispatch({ type: 'pending/set', pending: null });
        dispatch({ type: 'rebind/set', target: null });
        dispatch({ type: 'focus/set', focus: { kind: 'note', id: r.note.id } });
        return r.note;
      } catch (e) {
        toast('error', errorText(e));
        return null;
      }
    },
    [toast],
  );

  const updateNote = useCallback<AppActions['updateNote']>(
    async (id, patch) => {
      const cur = stateRef.current;
      if (!cur.activeRel) return;
      try {
        const note = await api.patchNote(id, { rel: cur.activeRel, ...patch });
        dispatch({ type: 'note/upsert', note });
        // 颜色变了要同步它对应的高亮，否则正文里那块还是旧颜色
        if (patch.color) {
          const hl = cur.doc?.sidecar.highlights.find((h) => h.noteId === id);
          if (hl) dispatch({ type: 'highlight/upsert', highlight: { ...hl, color: patch.color as Highlight['color'] } });
        }
      } catch (e) {
        toast('error', errorText(e));
      }
    },
    [toast],
  );

  const removeNote = useCallback<AppActions['removeNote']>(
    async (id, keepHighlight = false) => {
      const cur = stateRef.current;
      if (!cur.activeRel) return;
      try {
        await api.deleteNote(id, cur.activeRel, keepHighlight);
        dispatch({ type: 'note/remove', id, keepHighlight });
        if (cur.focus?.kind === 'note' && cur.focus.id === id) dispatch({ type: 'focus/set', focus: null });
      } catch (e) {
        toast('error', errorText(e));
      }
    },
    [toast],
  );

  /**
   * 让库内 agent 回答一条批注（B2-3，流式化）。agent 走 NDJSON 流，
   * 每步完成即把轨迹推进 agentLive——批注卡里实时显示它在干什么；
   * 回复由它自己经 reply_note 工具落盘，这里只把返回的回复合进本地状态。
   */
  const askAssistant = useCallback<AppActions['askAssistant']>(
    async (id) => {
      const cur = stateRef.current;
      if (!cur.activeRel) return false;
      setBusy('助手正在读原文、想怎么回答…（约半分钟到一分钟）');
      const steps: AgentChatStepEvent[] = [];
      dispatch({ type: 'agentLive/set', live: { noteId: id, steps } });
      try {
        const r = await api.answerNoteStream(cur.activeRel, id, (s) => {
          steps.push(s);
          dispatch({ type: 'agentLive/set', live: { noteId: id, steps: [...steps] } });
        });
        if (r.reply) {
          const note = cur.doc?.sidecar.notes.find((n) => n.id === id);
          if (note) {
            dispatch({ type: 'note/upsert', note: { ...note, replies: [...(note.replies ?? []), r.reply] } });
          }
          // 账单跟着提示走：批注卡不留这一轮的成本，就地告诉她花在哪了（C 层）
          toast('ok', `助手已回复这条批注 · ${usageLine(r.usage)}`);
        } else {
          toast('warn', `助手想好了但没写成功：${r.answer.slice(0, 120)}`);
        }
        return r.replyWritten;
      } catch (e) {
        if (e instanceof ApiError && e.isAiMissing) {
          toast('warn', '还没有配置 AI 接口，请先在「设置 → AI 接口」里填好接口地址和 Key');
        } else {
          toast('error', errorText(e));
        }
        return false;
      } finally {
        dispatch({ type: 'agentLive/set', live: null });
        setBusy(null);
      }
    },
    [setBusy, toast],
  );

  const createHighlight = useCallback<AppActions['createHighlight']>(
    async (patch) => {
      const cur = stateRef.current;
      if (!cur.activeRel) return null;
      try {
        const hl = await api.createHighlight({ rel: cur.activeRel, ...patch });
        dispatch({ type: 'highlight/upsert', highlight: hl });
        dispatch({ type: 'pending/set', pending: null });
        dispatch({ type: 'rebind/set', target: null });
        return hl;
      } catch (e) {
        toast('error', errorText(e));
        return null;
      }
    },
    [toast],
  );

  const updateHighlight = useCallback<AppActions['updateHighlight']>(
    async (id, patch) => {
      const cur = stateRef.current;
      if (!cur.activeRel) return;
      try {
        const hl = await api.patchHighlight(id, { rel: cur.activeRel, ...patch });
        dispatch({ type: 'highlight/upsert', highlight: hl });
      } catch (e) {
        toast('error', errorText(e));
      }
    },
    [toast],
  );

  const removeHighlight = useCallback<AppActions['removeHighlight']>(
    async (id) => {
      const cur = stateRef.current;
      if (!cur.activeRel) return;
      try {
        await api.deleteHighlight(id, cur.activeRel);
        dispatch({ type: 'highlight/remove', id });
      } catch (e) {
        toast('error', errorText(e));
      }
    },
    [toast],
  );

  const rebindTo = useCallback<AppActions['rebindTo']>(
    async (selector) => {
      const cur = stateRef.current;
      if (!cur.activeRel || !cur.rebinding) return;
      try {
        const updated = await api.rebind({ rel: cur.activeRel, kind: cur.rebinding.kind, id: cur.rebinding.id, selector });
        if (cur.rebinding.kind === 'note') dispatch({ type: 'note/upsert', note: updated as Note });
        else dispatch({ type: 'highlight/upsert', highlight: updated as Highlight });
        dispatch({ type: 'rebind/set', target: null });
        dispatch({ type: 'focus/set', focus: { kind: cur.rebinding.kind, id: cur.rebinding.id } });
        toast('ok', '已重新绑定到新的位置');
      } catch (e) {
        toast('error', errorText(e));
      }
    },
    [toast],
  );

  const runReanchor = useCallback<AppActions['runReanchor']>(async () => {
    const cur = stateRef.current;
    if (!cur.activeRel) return;
    setBusy('正在重新定位批注…');
    try {
      const { report } = await api.reanchor(cur.activeRel);
      // 重锚会改写很多条 selector，本地没有全量信息，整篇重拉最稳
      await openDoc(cur.activeRel);
      dispatch({ type: 'anchor/report', report });
      toast(
        report.repaired + report.orphan > 0 ? 'info' : 'ok',
        `重新定位完成：${report.repaired} 条移动、${report.orphan} 条失效、${report.ok} 条原位`,
      );
    } catch (e) {
      toast('error', errorText(e));
    } finally {
      setBusy(null);
    }
  }, [openDoc, setBusy, toast]);

  const splitDoc = useCallback<AppActions['splitDoc']>(
    async (opts = {}) => {
      const cur = stateRef.current;
      if (!cur.activeRel) return;
      setBusy('正在拆分…');
      try {
        const out = await api.splitDoc({ rel: cur.activeRel, maxBlocks: opts.maxBlocks });
        if (!out.ok) {
          toast('info', out.message || '这篇不需要拆分');
          return;
        }
        await reloadTree();
        // 原文已经进回收站了，当前 activeRel 指向的是不存在的文件，直接跳到第一篇
        const first = out.chunks[0]?.rel;
        if (first) await openDoc(first);
        toast('ok', out.message + '，原文已移入回收站');
      } catch (e) {
        toast('error', errorText(e));
      } finally {
        setBusy(null);
      }
    },
    [openDoc, reloadTree, setBusy, toast],
  );

  const clearAnnotations = useCallback<AppActions['clearAnnotations']>(
    async (what = 'all') => {
      const cur = stateRef.current;
      if (!cur.activeRel) return;
      try {
        await api.clearAnnotations(cur.activeRel, what);
        await openDoc(cur.activeRel);
        toast('ok', '已清空');
      } catch (e) {
        toast('error', errorText(e));
      }
    },
    [openDoc, toast],
  );

  // ── AI ──

  const generateCheatsheet = useCallback<AppActions['generateCheatsheet']>(
    async (opts = {}) => {
      const cur = stateRef.current;
      if (!cur.activeRel) return;
      setBusy('AI 正在整理小抄…（长小节会拆成几段分别整理再合并，可能要几分钟）');
      try {
        const r = await api.generateCheatsheet({ rel: cur.activeRel, ...opts });
        dispatch({ type: 'cheatsheet/set', sections: r.sections });
        const parts = [`已生成 ${r.generated} 节小抄`];
        if (r.skipped) parts.push(`跳过 ${r.skipped} 节（内容没变）`);
        if (r.droppedQuotes) parts.push(`${r.droppedQuotes} 条引用没能在原文中定位，已丢弃引用但保留内容`);
        toast(r.generated ? 'ok' : 'info', parts.join('；'));
      } catch (e) {
        if (e instanceof ApiError && e.isAiMissing) {
          toast('warn', '还没有配置 AI 接口，请先在「设置 → AI 接口」里填好接口地址和 Key');
        } else {
          toast('error', errorText(e));
        }
      } finally {
        setBusy(null);
      }
    },
    [setBusy, toast],
  );

  const generateTree = useCallback<AppActions['generateTree']>(
    async (headingId, force = false) => {
      const cur = stateRef.current;
      if (!cur.activeRel) return;
      setBusy('AI 正在把这节整理成知识树…（读原文重新组织，约一两分钟）');
      try {
        const r = await api.generateTree(cur.activeRel, headingId, force);
        // 用返回的完整 section（带 html/treeHtml）替换本地那一份——
        // 与 /cheatsheet/generate 的更新方式同构，不整篇重拉。
        const st = stateRef.current;
        if (st.doc) {
          const sections = (st.doc.sidecar.cheatsheet.sections ?? []).map((x) =>
            x.headingId === headingId ? r.section : x,
          );
          dispatch({ type: 'cheatsheet/set', sections });
        }
        const loc = r.total ? `，引文定位 ${r.located}/${r.total}` : '';
        toast('ok', r.reused ? `这节的知识树已经是最新，直接复用（要重跑请用「重新生成」）` : `知识树已生成${loc}`);
      } catch (e) {
        if (e instanceof ApiError && e.isAiMissing) {
          toast('warn', '还没有配置 AI 接口，请先在「设置 → AI 接口」里填好接口地址和 Key');
        } else {
          toast('error', errorText(e));
        }
      } finally {
        setBusy(null);
      }
    },
    [setBusy, toast],
  );

  /**
   * 「生成全部知识树」：并发 3 节调单节端点，不新建批量接口（2026-10-11 S3.3）。
   *
   * ★ 为什么从串行改并发 3 ★ 树生成 5~35s/节，串行是批量感知最慢的场景；
   *   并发 3 × 单节一次调用，内存增量可忽略，服务端全局 AI 闸（AI_CONCURRENCY=3）兜底限流。
   * ★ 保留的旧语义 ★ 逐节落盘 = 断点续跑（每完成一节就 dispatch 进 sidecar 视图）；
   *   一节失败就停（不再发新任务），已完成的都保存了，重新点继续。
   * ★ 回退 ★ URL 带 ?serialBatch=1 回到逐节串行（旧行为逐字节）。
   *
   * 复用语义在端点里：已有树且正文没变 → reused，秒回零成本，
   * 所以「全量重跑一遍」和「只补缺的」是同一个动作。
   */
  const generateAllTrees = useCallback<AppActions['generateAllTrees']>(
    async () => {
      const cur = stateRef.current;
      if (!cur.activeRel) return;
      const units = cur.doc?.analysis.units ?? [];
      if (units.length === 0) return;
      const serial = new URLSearchParams(window.location.search).has('serialBatch');
      const conc = serial ? 1 : 3;
      let done = 0;
      let failed = false;
      const runUnit = async (unit: (typeof units)[number], seq: number): Promise<void> => {
        if (failed) return;
        try {
          const r = await api.generateTree(cur.activeRel!, unit.headingId, false);
          done += 1;
          setBusy(`AI 正在生成知识树 ${done}/${units.length}：${unit.headingText}…（每完成一节就保存一节）`);
          const st = stateRef.current;
          if (st.doc) {
            const sections = (st.doc.sidecar.cheatsheet.sections ?? []).map((x) =>
              x.headingId === unit.headingId ? r.section : x,
            );
            dispatch({ type: 'cheatsheet/set', sections });
          }
        } catch (e) {
          failed = true;
          done += 1;
          if (e instanceof ApiError && e.isAiMissing) {
            toast('warn', '还没有配置 AI 接口，请先在「设置 → AI 接口」里填好接口地址和 Key');
          } else {
            toast('error', `第 ${done}/${units.length} 节（${unit.headingText}）失败：${errorText(e)}；已完成的 ${done - 1} 节已保存，可重新点继续`);
          }
        }
      };
      if (conc <= 1) {
        for (let i = 0; i < units.length; i++) {
          if (failed) break;
          await runUnit(units[i], i);
        }
      } else {
        let next = 0;
        const workers = Array.from({ length: Math.min(conc, units.length) }, async () => {
          for (;;) {
            if (failed) return;
            const i = next++;
            if (i >= units.length) return;
            await runUnit(units[i], i);
          }
        });
        await Promise.all(workers);
      }
      if (!failed) toast('ok', `全部 ${units.length} 节知识树已就绪`);
    },
    [setBusy, toast],
  );

  const generateQuiz = useCallback<AppActions['generateQuiz']>(
    async (headingId, count = 3) => {
      const cur = stateRef.current;
      if (!cur.activeRel) return null;
      setBusy('AI 正在出题…');
      try {
        const r = await api.generateQuiz({ rel: cur.activeRel, headingId, count, force: true });
        dispatch({ type: 'quiz/upsert', quiz: r.quiz });
        if (r.droppedCitations) toast('info', `${r.droppedCitations} 条题目引用没能在原文中定位，已丢弃引用`);
        return r.quiz;
      } catch (e) {
        if (e instanceof ApiError && e.isAiMissing) {
          toast('warn', '还没有配置 AI 接口，请先在「设置 → AI 接口」里填好接口地址和 Key');
        } else {
          toast('error', errorText(e));
        }
        return null;
      } finally {
        setBusy(null);
      }
    },
    [setBusy, toast],
  );

  const cardsFromCheatsheet = useCallback<AppActions['cardsFromCheatsheet']>(
    async (headingId) => {
      const cur = stateRef.current;
      if (!cur.activeRel) return;
      setBusy('正在把小抄变成闪卡…');
      try {
        const r = await api.cardsFromCheatsheet({ rel: cur.activeRel, headingId });
        dispatch({ type: 'cards/upsertMany', cards: r.cards });
        toast(r.created ? 'ok' : 'info', r.created ? `新增 ${r.created} 张闪卡` : '这一节的卡片已经有了，没有新增');
      } catch (e) {
        toast('error', errorText(e));
      } finally {
        setBusy(null);
      }
    },
    [setBusy, toast],
  );

  const cardsFromTree = useCallback<AppActions['cardsFromTree']>(
    async (headingId) => {
      const cur = stateRef.current;
      if (!cur.activeRel) return;
      setBusy('正在把知识树变成闪卡…');
      try {
        const r = await api.cardsFromTree({ rel: cur.activeRel, headingId });
        dispatch({ type: 'cards/upsertMany', cards: r.cards });
        // ★ 覆盖与自筛都要说出来 ★
        //   只报「新增 N 张」的话，卡被自筛掉和清单没人认领都会被藏起来——
        //   而这两件事正是「覆盖率达标」要看的。
        const bits = [r.created ? `新增 ${r.created} 张闪卡` : '没有新增卡片'];
        if (r.coverage) {
          const pct = Math.round(r.coverage.rate * 100);
          bits.push(`取卡清单覆盖 ${r.coverage.covered}/${r.coverage.slots}（${pct}%）`);
          if (r.coverage.uncovered.length) {
            bits.push(
              `${r.coverage.uncovered.length} 条无人认领：` +
                r.coverage.uncovered
                  .slice(0, 6)
                  .map((u) => u.label)
                  .join('、') +
                (r.coverage.uncovered.length > 6 ? ' 等' : ''),
            );
          }
        }
        if (r.rejected?.length) {
          bits.push(`自筛淘汰 ${r.rejected.length} 张（${[...new Set(r.rejected.flatMap((x) => x.blocked))].join('/')}）`);
        }
        if (r.droppedQuotes) bits.push(`${r.droppedQuotes} 张引文回不到原文`);
        toast(r.created ? 'ok' : 'info', bits.join('；'));
      } catch (e) {
        toast('error', errorText(e));
      } finally {
        setBusy(null);
      }
    },
    [setBusy, toast],
  );

  const cardsFromNotes = useCallback<AppActions['cardsFromNotes']>(
    async (noteIds) => {
      const cur = stateRef.current;
      if (!cur.activeRel) return;
      setBusy('正在把批注变成闪卡…');
      try {
        const r = await api.cardsFromNotes({ rel: cur.activeRel, noteIds });
        dispatch({ type: 'cards/upsertMany', cards: r.cards });
        toast(r.created ? 'ok' : 'info', r.created ? `新增 ${r.created} 张闪卡` : '没有可新增的卡片');
      } catch (e) {
        toast('error', errorText(e));
      } finally {
        setBusy(null);
      }
    },
    [setBusy, toast],
  );

  const createCard = useCallback<AppActions['createCard']>(
    async (patch) => {
      const cur = stateRef.current;
      if (!cur.activeRel) return;
      try {
        const card = await api.createCard({ rel: cur.activeRel, ...patch });
        dispatch({ type: 'cards/upsertMany', cards: [card] });
        toast('ok', '已新建卡片');
      } catch (e) {
        toast('error', errorText(e));
      }
    },
    [toast],
  );

  const deleteCard = useCallback<AppActions['deleteCard']>(
    async (id) => {
      const cur = stateRef.current;
      if (!cur.activeRel) return;
      try {
        await api.deleteCard(id, cur.activeRel);
        dispatch({ type: 'cards/remove', id });
      } catch (e) {
        toast('error', errorText(e));
      }
    },
    [toast],
  );

  const deleteQuiz = useCallback<AppActions['deleteQuiz']>(
    async (quizId) => {
      const cur = stateRef.current;
      if (!cur.activeRel) return;
      try {
        await api.deleteQuiz(cur.activeRel, quizId);
        await openDoc(cur.activeRel);
      } catch (e) {
        toast('error', errorText(e));
      }
    },
    [openDoc, toast],
  );

  const deleteCheatsheet = useCallback<AppActions['deleteCheatsheet']>(
    async (headingId) => {
      const cur = stateRef.current;
      if (!cur.activeRel) return;
      try {
        await api.deleteCheatsheet(cur.activeRel, headingId);
        await openDoc(cur.activeRel);
      } catch (e) {
        toast('error', errorText(e));
      }
    },
    [openDoc, toast],
  );

  /**
   * 交卷。
   * 判完分后重新拉一次 quizzes 同步「历史得分」——这里**不**用 openDoc，
   * 那会重建整篇正文 DOM，用户刚看完的解析和滚动位置全没了。
   */
  const submitQuiz = useCallback<AppActions['submitQuiz']>(
    async (patch) => {
      const cur = stateRef.current;
      if (!cur.activeRel) return null;
      try {
        const r = await api.submitAttempt({ rel: cur.activeRel, ...patch });
        const { quizzes } = await api.getQuiz(cur.activeRel);
        const q = quizzes.find((x) => x.id === patch.quizId);
        if (q) dispatch({ type: 'quiz/upsert', quiz: q });
        return r;
      } catch (e) {
        toast('error', errorText(e));
        return null;
      }
    },
    [toast],
  );

  /** 闪卡打分。服务端算好新的 SM-2 状态返回，本地直接替换这一张。 */
  const reviewCard = useCallback<AppActions['reviewCard']>(
    async (cardId, grade) => {
      const cur = stateRef.current;
      if (!cur.activeRel) return;
      try {
        const r = await api.review({ rel: cur.activeRel, cardId, grade });
        dispatch({ type: 'cards/upsertMany', cards: [r.card] });
      } catch (e) {
        toast('error', errorText(e));
      }
    },
    [toast],
  );

  /** 闪卡反馈三件套：写回 sidecar 的卡上，乐观更新同 reviewCard。 */
  const cardFeedback = useCallback<AppActions['cardFeedback']>(
    async (cardId, fb, fbWhy) => {
      const cur = stateRef.current;
      if (!cur.activeRel) return;
      try {
        const r = await api.patchCard(cardId, { rel: cur.activeRel, fb, fbWhy });
        dispatch({ type: 'cards/upsertMany', cards: [r] });
      } catch (e) {
        toast('error', errorText(e));
      }
    },
    [toast],
  );

  /** 右栏切到「批注」或「学习」。选择会被记住，下次打开还在同一页。 */
  const setRightTab = useCallback<AppActions['setRightTab']>((tab) => {
    dispatch({ type: 'rightTab/set', tab });
    try {
      localStorage.setItem(STORAGE_RIGHT_TAB, tab);
    } catch {
      /* 隐私模式写不了就算了，只是下次打开回到批注页 */
    }
  }, []);

  const actions = useMemo<AppActions>(
    () => ({
      boot,
      reloadTree,
      openDoc,
      reloadDoc,
      dismissAnchorReport: () => dispatch({ type: 'anchor/report', report: null }),
      toast,
      dismissToast: (id) => dispatch({ type: 'toast/dismiss', id }),
      setBusy,
      toggleDir,
      setVault,
      saveAi,
      clearAiKey,
      saveEmbedding,
      clearEmbeddingKey,
      saveFeishu,
      clearFeishuSecret,
      refreshSettings,
      setTheme,
      setThemeColor,
      savePanelWidths,
      openSettings: () => dispatch({ type: 'settings/open' }),
      closeSettings: () => dispatch({ type: 'settings/close' }),
      setRightTab,
      createEntry,
      renameEntry,
      removeEntry,
      reveal,
      openVault,
      selectNode,
      moveEntry,
      openEditor,
      setEditorMode,
      closeEditor,
      setDraft,
      saveDoc,
      resolveConflictWithDisk,
      openEditorWith,
      setPending,
      setFocus,
      startRebind,
      requestJump,
      clearJump,
      createNote,
      updateNote,
      removeNote,
      askAssistant,
      createHighlight,
      updateHighlight,
      removeHighlight,
      rebindTo,
      runReanchor,
      splitDoc,
      clearAnnotations,
      generateCheatsheet,
      generateTree,
      generateAllTrees,
      generateQuiz,
      cardsFromCheatsheet,
      cardsFromTree,
      cardsFromNotes,
      createCard,
      deleteCard,
      deleteQuiz,
      deleteCheatsheet,
      submitQuiz,
      reviewCard,
      cardFeedback,
    }),
    [
      boot,
      reloadTree,
      openDoc,
      reloadDoc,
      toast,
      setBusy,
      toggleDir,
      setVault,
      saveAi,
      clearAiKey,
      saveEmbedding,
      clearEmbeddingKey,
      saveFeishu,
      clearFeishuSecret,
      refreshSettings,
      setTheme,
      setThemeColor,
      savePanelWidths,
      setRightTab,
      createEntry,
      renameEntry,
      removeEntry,
      reveal,
      openVault,
      selectNode,
      moveEntry,
      openEditor,
      setEditorMode,
      closeEditor,
      setDraft,
      saveDoc,
      resolveConflictWithDisk,
      openEditorWith,
      setPending,
      setFocus,
      startRebind,
      requestJump,
      clearJump,
      createNote,
      updateNote,
      removeNote,
      askAssistant,
      createHighlight,
      updateHighlight,
      removeHighlight,
      rebindTo,
      runReanchor,
      splitDoc,
      clearAnnotations,
      generateCheatsheet,
      generateTree,
      generateAllTrees,
      generateQuiz,
      cardsFromCheatsheet,
      cardsFromTree,
      cardsFromNotes,
      createCard,
      deleteCard,
      deleteQuiz,
      deleteCheatsheet,
      submitQuiz,
      reviewCard,
      cardFeedback,
    ],
  );

  const value = useMemo(() => ({ state, actions }), [state, actions]);
  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}
