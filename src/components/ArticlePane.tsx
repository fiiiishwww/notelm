/**
 * src/components/ArticlePane.tsx —— 中栏：正文 / 编辑器 / 保存冲突。
 *
 * 三种形态互斥：
 *   - 阅读态：渲染服务端给回来的 HTML（已带 data-bi）
 *   - 编辑态：纯 textarea 编辑 Markdown 源码
 *   - 冲突态：并排展示「磁盘上的版本」和「我的版本」，让用户选一个
 *
 * 为什么编辑不用富文本编辑器：用户的文件是 Markdown，而且他很可能同时在
 * Obsidian 里改。所见即所得的编辑器会把 `**加粗**` 变成 `<strong>`、
 * 把表格重排成对齐的样子，一来一回 diff 就炸了。直接编辑源码反而是最安全的。
 */

import { useEffect, useRef, useState } from 'react';
import { useApp } from '../state/store';
import { api, errorText } from '../api';
import { revealBlockWhenReady } from '../lib/dom';
import { Anchor, Bulb, Refresh, Save, Wand, Warning } from './Icons';
import { ChapterBar, HighlightLayer } from './HighlightLayer';
import { BottomDock } from './BottomDock';

/**
 * className 由 App 传入，只用于窄屏下标记「这一栏当前要不要显示」（'on'）。
 * 三个 return 分支都要带上——漏一个，冲突视图 / 编辑器在手机上就是一片空白。
 */
export function ArticlePane({ className = '' }: { className?: string } = {}) {
  const cls = `pane pane-center${className ? ` ${className}` : ''}`;
  const { state, actions } = useApp();
  const { doc, docLoading, docError, editorOpen, editorMode, conflict } = state;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [formatting, setFormatting] = useState(false);
  const [aiFormatting, setAiFormatting] = useState(false);
  const aiAbort = useRef<AbortController | null>(null);

  /**
   * 快速清洗（规则版）：只做机械清理——清页眉页脚、补中英空格、整理列表符号。
   * 不动措辞、不重排结构，所以秒出、零成本。
   */
  const runFormat = async () => {
    if (formatting || !state.draft.trim()) return;
    setFormatting(true);
    try {
      const r = await api.format(state.draft);
      if (r.markdown === state.draft) {
        actions.toast('info', '没找到需要排版的地方');
        return;
      }
      actions.setDraft(r.markdown);
      const total = r.changes.reduce((s, c) => s + c.count, 0);
      const names = r.changes.map((c) => c.rule).join('、');
      actions.toast('ok', `清洗完成：${total} 处改动（${names}）。还没保存，看看对不对再存。`);
    } catch (e) {
      actions.toast('error', errorText(e));
    } finally {
      setFormatting(false);
    }
  };

  /**
   * AI 排版：让模型把整篇重写成规范的 Markdown（标题层级、列表、代码块都归位）。
   *
   * ★ 结果只进草稿，不自动落盘 ★
   *   AI 会顺手改措辞，直接写进文件等于把「改坏了」变成既定事实。
   *   停在编辑框里让用户看一眼再存，是唯一安全的做法。
   *
   * 要花十几秒到几十秒、要花 token，所以：按钮上写明、给 loading、给取消。
   */
  const AI_FORMAT_LIMIT = 20000;
  const runAiFormat = async () => {
    if (aiFormatting || !state.draft.trim()) return;
    const src = state.draft;
    if (src.length > AI_FORMAT_LIMIT) {
      actions.toast(
        'warn',
        `这篇有 ${src.length} 字，超过 AI 一次能处理的 ${AI_FORMAT_LIMIT} 字，超出部分会原样保留。`,
      );
    }
    const ctl = new AbortController();
    aiAbort.current = ctl;
    setAiFormatting(true);
    try {
      const r = await api.formatAi(src, ctl.signal);
      if (r.markdown === src) {
        actions.toast('info', 'AI 认为这篇已经是规范的 Markdown，没有改动');
        return;
      }
      actions.setDraft(r.markdown);
      actions.toast('ok', 'AI 排版完成，结果已经在编辑框里。还没保存，看一眼再存。');
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        actions.toast('info', '已取消 AI 排版');
        return;
      }
      actions.toast('error', errorText(e));
    } finally {
      aiAbort.current = null;
      setAiFormatting(false);
    }
  };

  // ── 阅读位置记忆 ──
  // 换文章时：有记忆就回到上次的位置，没有就归零。
  //
  // 存在 localStorage 而不是 sidecar：**读到哪儿是这台设备的事**。
  // 写进笔记库会污染笔记本身，同步到别的设备还会互相打架（手机上读到第三章，
  // 回头电脑上被拽到第三章）。丢了也无所谓，重读就是了。
  const rel = doc?.path ?? '';
  // 跳转请求要用 ref 读：把它放进依赖会让「跳到某一段」变成一次额外的恢复滚动
  const jumpRef = useRef(state.pendingJump);
  jumpRef.current = state.pendingJump;

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (jumpRef.current) return; // 正要跳到某一块，别抢它的滚动位置
    const saved = readScrollPos(rel);
    if (!saved) {
      el.scrollTop = 0;
      return;
    }
    restoreScroll(el, saved);
  }, [rel, editorOpen, conflict]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !rel) return;
    let t: number | undefined;
    const onScroll = () => {
      if (t) window.clearTimeout(t);
      t = window.setTimeout(() => writeScrollPos(rel, el.scrollTop), 300);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (t) window.clearTimeout(t);
    };
  }, [rel, editorOpen, conflict]);

  /**
   * 消费「跳转请求」。
   *
   * 相关段落 / 检索结果只要说一句「我要跳到 X 的第 N 块」，剩下的交给这里：
   * 等到正文确实是那篇文章、DOM 也提交完了，才真正滚动 + 高亮。
   * 于是跨文档跳转和同文档跳转走同一条路，不会再出现「跳过去了但没高亮」。
   */
  const pendingJump = state.pendingJump;
  useEffect(() => {
    if (!pendingJump) return;
    if (doc?.path !== pendingJump.rel) return; // 目标文章还没加载完，等下一次
    let alive = true;
    void revealBlockWhenReady(pendingJump.bi).then((ok) => {
      if (alive && !ok) actions.toast('info', '没能在正文里定位到这一段，它可能已经被改动过');
    });
    actions.clearJump();
    return () => {
      alive = false;
    };
  }, [pendingJump, doc?.path]);

  // Ctrl+S 保存 / Ctrl+E 切换编辑
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key === 's') {
        e.preventDefault();
        if (editorOpen) void actions.saveDoc();
      } else if (e.key === 'e') {
        e.preventDefault();
        if (!doc) return;
        if (editorOpen) actions.closeEditor();
        else actions.openEditor('edit');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [actions, doc, editorOpen]);

  if (conflict) {
    return (
      <div className={cls}>
        <ConflictView
          diskMarkdown={conflict.diskMarkdown}
          mineMarkdown={state.draft}
          onTakeDisk={() => void actions.resolveConflictWithDisk()}
          onKeepMine={() => void actions.saveDoc({ force: true })}
          onCancel={() => actions.closeEditor()}
        />
      </div>
    );
  }

  if (editorOpen) {
    return (
      <div className={cls}>
        <div className="editor-wrap">
          <textarea
            className="editor-area"
            value={state.draft}
            spellCheck={false}
            onChange={(e) => actions.setDraft(e.target.value)}
            placeholder="# 标题&#10;&#10;正文…"
            autoFocus
          />
          <div className="editor-bar">
            <span className="dirty-dot" />
            <span>正在编辑（还没保存到磁盘）</span>
            <span className="grow" style={{ flex: 1 }} />
            <span>{state.draft.length} 字</span>
            <span className="topbar-sep" />
            <button
              className="btn sm"
              onClick={() => void runAiFormat()}
              disabled={aiFormatting || formatting || !state.draft.trim()}
              title="让 AI 把整篇重写成规范的 Markdown（标题层级、列表、代码块）。要调用模型，十几秒左右，会花 token"
            >
              {aiFormatting ? <span className="spinner" /> : <Wand width={13} height={13} />}
              {aiFormatting ? ' AI 排版中…' : ' AI 排版'}
            </button>
            {aiFormatting ? (
              <button className="btn sm" onClick={() => aiAbort.current?.abort()} title="取消这一次排版">
                取消
              </button>
            ) : (
              <button
                className="btn sm ghost"
                onClick={() => void runFormat()}
                disabled={formatting || !state.draft.trim()}
                title="不改措辞，只做机械清理：清页眉页脚、补中英空格、整理列表符号。秒出、不花 token"
              >
                {formatting ? <span className="spinner" /> : null}
                {formatting ? ' 清洗中…' : ' 快速清洗'}
              </button>
            )}
            <button className="btn sm" onClick={() => actions.closeEditor()}>
              取消
            </button>
            <button className="btn sm primary" onClick={() => void actions.saveDoc()}>
              <Save width={13} height={13} /> 保存
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={cls}>
      {docError ? (
        <div className="empty">
          <div className="empty-emoji">⚠️</div>
          <h3>这篇打不开</h3>
          <p>{docError}</p>
          <button className="btn" onClick={() => void actions.reloadDoc()}>
            <Refresh /> 重试
          </button>
        </div>
      ) : docLoading || !doc ? (
        <div className="empty">
          <div className="spinner" />
          <p>{docLoading ? '正在读取并分析文章…' : '还没有打开文章'}</p>
        </div>
      ) : (
        <>
          <div className="article-scroll" ref={scrollRef}>
            <ChapterBar />

          {state.anchorReport && state.anchorReport.repaired + state.anchorReport.orphan > 0 ? (
            <div className="article-wrap" style={{ paddingBottom: 0 }}>
              <div className="banner info">
                <Anchor width={15} height={15} />
                <span style={{ flex: 1 }}>
                  这篇文章在外部被改过，批注已自动重新定位：
                  {state.anchorReport.repaired} 条跟随移动
                  {state.anchorReport.orphan ? `，${state.anchorReport.orphan} 条实在找不到位置，已标为失效` : ''}。
                </span>
                <button className="btn sm" onClick={actions.dismissAnchorReport}>
                  知道了
                </button>
              </div>
            </div>
          ) : null}

          <div className="article-wrap">
            {/* 正文、高亮叠加层、选区工具条都在 HighlightLayer 里。
                三者必须同一次提交完成，否则会出现「正文已经换了、高亮还停在旧位置」的一帧。 */}
            <HighlightLayer
              html={doc.html}
              blocks={doc.analysis.blocks}
              docPlain={doc.analysis.docPlain}
            />

            <DocMeta />
            </div>
          </div>

          {/* 正文下方的常驻板块（相关段落 / AI 助手双 tab）。放在滚动区**外面**，
              这样滚到哪儿都看得见，不用滚到底才能用。 */}
          <BottomDock scrollRef={scrollRef} />
        </>
      )}
    </div>
  );
}

/** 正文底部的一行小信息：让用户知道这篇文章被切成了多少块、属于哪几节。 */
function DocMeta() {
  const { state } = useApp();
  const doc = state.doc;
  if (!doc) return null;
  const units = doc.analysis.units;
  return (
    <div
      style={{
        marginTop: 36,
        paddingTop: 12,
        borderTop: '1px solid var(--border)',
        fontSize: 12,
        color: 'var(--text-3)',
        display: 'flex',
        gap: 12,
        flexWrap: 'wrap',
        alignItems: 'center',
      }}
    >
      <span>共 {doc.analysis.blocks.length} 个段落块</span>
      <span>·</span>
      <span>
        {units.length} 个学习单元
        {units.length && units[0].level === 0 && units[0].headingId === '__root__' ? '（全文，因为没找到二级标题）' : ''}
      </span>
      <span>·</span>
      <span className="tag-chip" style={{ fontFamily: 'var(--mono)' }} title="内容指纹，用于检测外部改动">
        {doc.docHash.slice(0, 10)}
      </span>

      {/* 读完正文正好在这里，给个最顺手的入口。
          生成完把右栏切到「学习」，否则结果生成在一个看不见的页签里，等于没反应。 */}
      <span style={{ flex: 1 }} />
      <DocMetaActions units={units} />
    </div>
  );
}

function DocMetaActions({ units }: { units: { headingId: string }[] }) {
  const { state, actions } = useApp();
  const done = state.doc?.sidecar.cheatsheet.sections.length ?? 0;
  const busy = Boolean(state.busy);

  return (
    <>
      {units.length > 1 ? <span>{done}/{units.length} 节有小抄</span> : null}
      <button
        className="btn sm"
        disabled={busy || units.length === 0}
        title="让 AI 给每一节写一份要点摘要"
        onClick={() => {
          void actions.generateCheatsheet();
          actions.setRightTab('study');
        }}
      >
        <Wand width={13} height={13} /> {done ? '重新生成小抄' : '生成小抄'}
      </button>
      <button
        className="btn sm"
        disabled={busy || units.length === 0}
        title="按这一篇出一套题并判分"
        onClick={() => actions.setRightTab('study')}
      >
        <Bulb width={13} height={13} /> 去学习
      </button>
    </>
  );
}

/**
 * 保存冲突：磁盘上的版本被别的程序改过了。
 *
 * 这里**不自动合并**。Markdown 的合并没有可靠算法（两边都改了同一段的相邻行时，
 * 任何自动合并都可能悄悄吞掉一句话），而这个软件里面放的是用户的学习笔记，
 * 吞掉一句话的代价远大于多点一次鼠标。
 */
function ConflictView({
  diskMarkdown,
  mineMarkdown,
  onTakeDisk,
  onKeepMine,
  onCancel,
}: {
  diskMarkdown: string;
  mineMarkdown: string;
  onTakeDisk: () => void;
  onKeepMine: () => void;
  onCancel: () => void;
}) {
  return (
    <>
      <div className="pane-head" style={{ height: 'auto', padding: '10px 12px' }}>
        <div className="banner warn" style={{ flex: 1 }}>
          <Warning width={15} height={15} />
          <span>
            磁盘上的内容在别处被改过（可能是 Obsidian），直接覆盖会丢掉那边的改动。请先比一比，再决定保留哪个。
          </span>
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0, padding: '0 12px 8px' }}>
        <div className="diff-grid" style={{ height: '100%' }}>
          <div className="diff-col">
            <header>磁盘上的版本（其他程序刚改的）</header>
            <pre>{diskMarkdown || '（空）'}</pre>
          </div>
          <div className="diff-col">
            <header>你正在编辑的版本</header>
            <pre>{mineMarkdown || '（空）'}</pre>
          </div>
        </div>
      </div>
      <div className="editor-bar">
        <Bulb width={14} height={14} />
        <span>建议：如果磁盘上的改动是你在别处新写的，选左边；如果那只是旧文件，选右边覆盖它。</span>
        <span className="grow" style={{ flex: 1 }} />
        <button className="btn sm" onClick={onCancel}>
          先不管，回去看看
        </button>
        <button className="btn sm" onClick={onTakeDisk}>
          采用磁盘版本（丢弃我的修改）
        </button>
        <button className="btn sm primary" onClick={onKeepMine}>
          用我的版本覆盖磁盘
        </button>
      </div>
    </>
  );
}

// ─────────────────────── 阅读位置记忆 ───────────────────────

const SCROLL_KEY = 'nb.scroll.pos';
/** 最多记 400 篇，再多就把最早的忘掉——这是缓存，不是档案 */
const SCROLL_MAX = 400;

function readScrollMap(): Record<string, number> {
  try {
    const raw = localStorage.getItem(SCROLL_KEY);
    const m = raw ? JSON.parse(raw) : null;
    return m && typeof m === 'object' ? (m as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function readScrollPos(rel: string): number {
  if (!rel) return 0;
  const v = readScrollMap()[rel];
  return typeof v === 'number' && v > 0 ? v : 0;
}

function writeScrollPos(rel: string, top: number): void {
  if (!rel) return;
  const m = readScrollMap();
  m[rel] = Math.round(top);
  const keys = Object.keys(m);
  if (keys.length > SCROLL_MAX) {
    for (const k of keys.slice(0, keys.length - SCROLL_MAX)) delete m[k];
  }
  try {
    localStorage.setItem(SCROLL_KEY, JSON.stringify(m));
  } catch {
    /* 隐私模式下写不进去，记不住位置而已，不影响别的 */
  }
}

/**
 * 把滚动容器恢复到指定位置。
 *
 * ★ 不能只设一次 ★
 *   图片的真实尺寸要等加载完才知道，加载过程中下面的内容会被一路往下顶，
 *   设好的 scrollTop 对应的内容早就不是刚才那一屏了。所以要连续几帧把它按回去，
 *   直到文档高度不再变化（说明图片都到位了）或超时。
 */
function restoreScroll(el: HTMLElement, target: number): void {
  const t0 = Date.now();
  let lastH = -1;
  const step = () => {
    el.scrollTop = target;
    const h = el.scrollHeight;
    if (h !== lastH && Date.now() - t0 < 800) {
      lastH = h;
      requestAnimationFrame(step);
    }
  };
  requestAnimationFrame(step);
}
