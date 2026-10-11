/**
 * src/components/NotePanel.tsx —— 右栏：批注面板。
 *
 * 面板里有两个层级的对象，必须分清：
 *   - 批注（Note）：有正文、有标签、有颜色，是用户真正写下的东西；
 *   - 纯高亮（Highlight 且 noteId 为 null）：只是把一段文字涂了色，没有正文。
 * 有批注的高亮**不单独出现在列表里**——它跟着批注卡片走（卡片左上那根竖线就是它的
 * 颜色）。否则用户会在列表里看到「一条批注 + 一条内容一模一样的高亮」，非常困惑。
 *
 * 排序按正文位置（块号、块内偏移），不是按创建时间。
 * 因为这个面板的主要用途是「对着正文往下读」，位置顺序才符合阅读直觉；
 * 想按时间找最新写的那条，用筛选框搜更快。
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useApp } from '../state/store';
import type { Highlight, HighlightColor, Note } from '../../shared/text';
import { Anchor, Check, Eye, EyeOff, Note as NoteIcon, Pencil, Refresh, Trash, Wand, Warning } from './Icons';
import { ConfirmDialog, Modal } from './Dialog';
import { scrollToAnnotation } from '../lib/dom';
import { stepText } from './AgentChatPanel';
import { COLORS, hexOf } from '../lib/colors';

// ─────────────────────────── 颜色 ───────────────────────────

/**
 * 颜色表定义在 ../lib/colors —— 正文选区工具条上那排色点用的也是它。
 * 两边各抄一份的话，迟早会出现「面板里的黄」和「正文里的黄」不是同一个黄。
 */

/** 把「标签1, 标签2 标签3」切成数组：中英文逗号、顿号、空白都当分隔符。 */
function parseTags(raw: string): string[] {
  return raw
    .split(/[,，、\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 8);
}

// ─────────────────────────── 面板 ───────────────────────────

type Filter = 'all' | 'notes' | 'marks' | 'orphan';

interface Item {
  kind: 'note' | 'mark';
  key: string;
  /** 正文位置（用于排序），块号为主、块内偏移为辅 */
  at: number;
  orphan: boolean;
  note?: Note;
  hl?: Highlight;
}

/**
 * @param switcher 右栏的「批注 / 学习」切换条，由 App 传进来渲染在标题栏里。
 *   放在这里而不是面板外面，是为了不额外占一整行高度；两个面板各自渲染它，
 *   切换时标题栏的位置和样式才不会跳。
 */
export function NotePanel({ switcher }: { switcher?: ReactNode }) {
  const { state, actions } = useApp();
  const doc = state.doc;

  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  // 「隐藏批注」只是把正文里的底色清掉，批注本身一条不少——所以状态放本地偏好就够了，
  // 不用进 sidecar（进 sidecar 会被同步到别的设备，那是别人的阅读偏好，不该被带过去）。
  const [hideMarks, setHideMarks] = useState(() => localStorage.getItem('nb-hide-marks') === '1');
  useEffect(() => {
    if (hideMarks) document.documentElement.dataset.hideMarks = '1';
    else delete document.documentElement.dataset.hideMarks;
    localStorage.setItem('nb-hide-marks', hideMarks ? '1' : '0');
  }, [hideMarks]);

  const notes = doc?.sidecar.notes ?? [];
  const highlights = doc?.sidecar.highlights ?? [];

  const noteById = useMemo(() => {
    const m = new Map<string, Note>();
    for (const n of notes) m.set(n.id, n);
    return m;
  }, [notes]);

  const orphanCount =
    notes.filter((n) => n.anchorState === 'orphan').length +
    highlights.filter((h) => h.anchorState === 'orphan').length;

  // ── 列表数据 ──
  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    for (const n of notes) {
      out.push({
        kind: 'note',
        key: `note:${n.id}`,
        at: n.selector.blockIndex * 1e6 + n.selector.textOffset,
        orphan: n.anchorState === 'orphan',
        note: n,
      });
    }
    for (const h of highlights) {
      // 已经被批注「认领」的高亮，交给那张批注卡片展示，不在列表里重复出现
      if (h.noteId && noteById.has(h.noteId)) continue;
      out.push({
        kind: 'mark',
        key: `mark:${h.id}`,
        at: h.selector.blockIndex * 1e6 + h.selector.textOffset,
        orphan: h.anchorState === 'orphan',
        hl: h,
      });
    }
    // 失效的排到最后：它们的位置已经不成立了，混在正文顺序里只会干扰阅读
    out.sort((a, b) => (a.orphan === b.orphan ? a.at - b.at : a.orphan ? 1 : -1));
    return out;
  }, [notes, highlights, noteById]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((it) => {
      if (filter === 'notes' && it.kind !== 'note') return false;
      if (filter === 'marks' && it.kind !== 'mark') return false;
      if (filter === 'orphan' && !it.orphan) return false;
      if (!q) return true;
      const hay =
        it.kind === 'note'
          ? `${it.note!.selector.quote}\n${it.note!.body}\n${it.note!.tags.join(' ')}`
          : it.hl!.selector.quote;
      return hay.toLowerCase().includes(q);
    });
  }, [items, filter, query]);

  // ── 反查章节标题（让列表里每条批注都能看出「这是哪一节的」）──
  const headingTextOf = useMemo(() => {
    const chapters = doc?.analysis.chapters ?? [];
    return (headingId?: string): string | null => {
      if (!headingId) return null;
      return chapters.find((c) => c.headingId === headingId)?.text ?? null;
    };
  }, [doc?.analysis.chapters]);

  // ── 双向联动：正文那边点了高亮/批注 → 把对应卡片滚进视野 ──
  const focusKey = state.focus ? `${state.focus.kind}:${state.focus.id}` : '';
  useEffect(() => {
    if (!focusKey) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-focus="${focusKey}"]`);
    if (el) {
      // nearest 而不是 center：卡片本来就在视野里时不滚动，避免右栏自己乱抖
      el.scrollIntoView({ block: 'nearest' });
      return;
    }
    // 卡片存在、却被当前的筛选或搜索挡在了外面——用户点了正文却什么也没发生，
    // 只会以为「这条批注丢了」。这时把筛选退回「全部」。
    // 只在真的找不到时才动手：否则后台刷一下数据就把用户的筛选悄悄重置了。
    // 故意不依赖 visible：那样每次编辑批注都会重跑一遍，把用户滚到别处的列表拽回来。
    if (filter !== 'all' || query) {
      setFilter('all');
      setQuery('');
    }
  }, [focusKey, filter, query]);

  const pending = state.pending;

  // 草稿卡置顶，但列表可能正停在半中间——手机上一切过来就是右栏全屏，
  // 不滚回顶部的话草稿卡在屏幕外，同样像「没反应」。
  useEffect(() => {
    if (pending && listRef.current) listRef.current.scrollTop = 0;
  }, [pending]);

  if (!doc) {
    return (
      <div className="pane pane-right">
        <div className="pane-head">
          <h2>批注</h2>
          {switcher}
        </div>
        <div className="pane-body">
          <div className="empty">
            <NoteIcon width={22} height={22} />
            <p>{state.docLoading ? '正在打开文章…' : '打开一篇文章后，这里的批注会跟着出现。'}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="pane pane-right">
      <div className="pane-head">
        <h2>批注</h2>
        {switcher}
        <span className="count-chip" title={`${notes.length} 条批注 · ${highlights.length} 处高亮`}>
          {notes.length}
        </span>
        {orphanCount > 0 ? (
          <span className="count-chip" style={{ color: 'var(--danger)', background: 'var(--danger-soft)' }}>
            {orphanCount} 失效
          </span>
        ) : null}
        <span style={{ flex: 1 }} />
        {orphanCount > 0 ? (
          <button className="btn ghost icon sm" title="按原文重新定位所有批注" onClick={() => void actions.runReanchor()}>
            <Refresh />
          </button>
        ) : null}
        <button
          className="btn ghost icon sm"
          title={hideMarks ? '重新显示正文里的批注与高亮' : '暂时隐藏正文里的批注与高亮（批注不会丢）'}
          onClick={() => setHideMarks((v) => !v)}
        >
          {hideMarks ? <EyeOff /> : <Eye />}
        </button>
        <button
          className="btn ghost icon sm"
          title="清空这篇文章的批注与高亮"
          disabled={!notes.length && !highlights.length}
          onClick={() => setConfirmClear(true)}
        >
          <Trash />
        </button>
      </div>

      <div className="tree-search">
        <input
          className="input"
          value={query}
          placeholder="搜批注内容或原文…"
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div style={{ display: 'flex', gap: 4, padding: '6px 8px 2px', flexWrap: 'wrap' }}>
        <FilterBtn active={filter === 'all'} onClick={() => setFilter('all')} label="全部" count={items.length} />
        <FilterBtn
          active={filter === 'notes'}
          onClick={() => setFilter('notes')}
          label="批注"
          count={notes.length}
        />
        <FilterBtn
          active={filter === 'marks'}
          onClick={() => setFilter('marks')}
          label="纯高亮"
          count={items.filter((i) => i.kind === 'mark').length}
        />
        {orphanCount > 0 ? (
          <FilterBtn active={filter === 'orphan'} onClick={() => setFilter('orphan')} label="失效" count={orphanCount} danger />
        ) : null}
      </div>

      <div className="pane-body" ref={listRef}>
        {/* 刚在正文里选了一段文字、还没决定写什么：草稿卡片置顶 */}
        {pending && !state.rebinding ? <DraftCard /> : null}

        {visible.length === 0 && !pending ? (
          items.length === 0 ? (
            <div className="empty">
              <NoteIcon width={22} height={22} />
              <h3>还没有批注</h3>
              <p>
                在正文里选中一段文字（手机长按拖选），会弹出一个小工具条；
                点「写批注」就能把这一段和你的想法绑在一起。
              </p>
              <p style={{ color: 'var(--text-3)' }}>
                只想划重点不想写字？直接点工具条上的颜色圆点就行。
              </p>
            </div>
          ) : (
            <div className="empty">
              <p>{query ? '没有匹配的批注。' : '这个筛选下没有内容。'}</p>
            </div>
          )
        ) : (
          <div className="note-list">
            {visible.map((it) =>
              it.kind === 'note' ? (
                <NoteCard
                  key={it.key}
                  note={it.note!}
                  active={state.focus?.kind === 'note' && state.focus.id === it.note!.id}
                  rebinding={state.rebinding?.kind === 'note' && state.rebinding.id === it.note!.id}
                  headingText={headingTextOf(it.note!.selector.headingId)}
                  shadowHlId={highlights.find((h) => h.noteId === it.note!.id)?.id ?? null}
                />
              ) : (
                <MarkCard
                  key={it.key}
                  hl={it.hl!}
                  active={state.focus?.kind === 'highlight' && state.focus.id === it.hl!.id}
                />
              ),
            )}
          </div>
        )}
      </div>

      {confirmClear ? (
        <ConfirmDialog
          title="清空这篇文章的批注？"
          danger
          confirmText="确认清空"
          message={
            <>
              会删掉这篇的 <b>{notes.length}</b> 条批注和 <b>{highlights.length}</b> 处高亮。
              <br />
              原文（Markdown 文件）不受影响，但批注内容不会进回收站，删了就没了。
            </>
          }
          onConfirm={() => actions.clearAnnotations('all')}
          onClose={() => setConfirmClear(false)}
        />
      ) : null}
    </div>
  );
}

function FilterBtn({
  active,
  onClick,
  label,
  count,
  danger,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
  danger?: boolean;
}) {
  return (
    <button
      className={`btn sm ${active ? 'toggle-on' : 'ghost'}`}
      style={danger && !active ? { color: 'var(--danger)' } : undefined}
      onClick={onClick}
    >
      {label}
      <span style={{ opacity: 0.65, fontVariantNumeric: 'tabular-nums' }}>{count}</span>
    </button>
  );
}

// ─────────────────────────── 草稿卡片 ───────────────────────────

/**
 * 用户在正文里选了文字，工具条上点了「写批注」之后出现的卡片。
 * 这不是一条真实存在的批注——只有点了保存（或点颜色圆点只留高亮）才会写进磁盘。
 */
function DraftCard() {
  const { state, actions } = useApp();
  const pending = state.pending!;
  const [body, setBody] = useState('');
  const [color, setColor] = useState<HighlightColor>('yellow');
  const areaRef = useRef<HTMLTextAreaElement>(null);

  // 每次在正文里重新选一段就该是全新的一张草稿，所以跟着 pending 的身份重置
  useEffect(() => {
    setBody('');
    setColor('yellow');
    // 手机上右栏要等 App 把它切到前台才可见（此前是 display:none），
    // 此刻同步 focus 会打在隐藏元素上、静默失败 —— 键盘弹不出来，
    // 用户看到的就是「点写批注没反应」。延后一帧补一次。
    areaRef.current?.focus();
    const t = window.setTimeout(() => areaRef.current?.focus(), 120);
    return () => window.clearTimeout(t);
  }, [pending]);

  const save = async () => {
    const sel = pending.selector;
    const text = body.trim();
    if (!text) {
      // 空正文 = 用户只想划个高亮，不要给他报错，直接当成高亮保存
      await actions.createHighlight({ selector: sel, color });
      actions.toast('ok', '已高亮这一段');
    } else {
      await actions.createNote({ selector: sel, body: text, color, createHighlight: true });
    }
    actions.setPending(null);
  };

  return (
    <div className="note-list" style={{ paddingBottom: 0 }}>
      <div className="note-card active" style={{ '--note-color': hexOf(color) } as CSSProperties}>
        <div className="note-quote" style={{ cursor: 'default' }} title={pending.selector.quote}>
          {pending.selector.quote}
        </div>
        <div className="note-edit">
          <textarea
            ref={areaRef}
            className="textarea"
            rows={3}
            value={body}
            placeholder="写点什么…留空就只划一个高亮"
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                actions.setPending(null);
              } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void save();
              }
            }}
          />
          <div className="row" style={{ marginTop: 7, gap: 4 }}>
            <ColorSwatches value={color} onPick={setColor} />
            <span style={{ flex: 1 }} />
            <button className="btn sm" onClick={() => actions.setPending(null)}>
              取消
            </button>
            <button className="btn sm primary" onClick={() => void save()} title="Ctrl+Enter">
              {body.trim() ? '保存批注' : '只加高亮'}
            </button>
          </div>
        </div>
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--text-3)', padding: '0 2px' }}>
        这段文字已暂时记下，还没写进磁盘。
      </div>
    </div>
  );
}

function ColorSwatches({ value, onPick }: { value: HighlightColor; onPick: (c: HighlightColor) => void }) {
  return (
    <>
      {COLORS.map((c) => (
        <button
          key={c.key}
          className="swatch"
          title={c.label}
          aria-label={c.label}
          onClick={() => onPick(c.key)}
          style={{
            width: 16,
            height: 16,
            borderRadius: '50%',
            padding: 0,
            cursor: 'pointer',
            background: c.hex,
            border: value === c.key ? '2px solid var(--accent)' : '1px solid rgba(0,0,0,.15)',
          }}
        />
      ))}
    </>
  );
}

// ─────────────────────────── 批注卡片 ───────────────────────────

function NoteCard({
  note,
  active,
  rebinding,
  headingText,
  shadowHlId,
}: {
  note: Note;
  active: boolean;
  rebinding: boolean;
  headingText: string | null;
  /** 这条批注在正文里那块颜色的高亮 id（正文里的「影子」），用来精确跳转 */
  shadowHlId: string | null;
}) {
  const { state, actions } = useApp();
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(note.body);
  const [tags, setTags] = useState(note.tags.join(', '));
  const [confirmDel, setConfirmDel] = useState(false);
  /** 本条批注是否正在被助手回答（点「让助手回答」后全局 busy + 这里局部转圈） */
  const agentLive = state.agentLive;
  const asking = (state.busy?.startsWith('助手正在读原文') ?? false) || agentLive?.noteId === note.id;

  // 正在重新绑定时不要停留在编辑态，否则用户以为「改个位置还要先退出编辑」
  useEffect(() => {
    if (rebinding) setEditing(false);
  }, [rebinding]);

  const startEdit = () => {
    setBody(note.body);
    setTags(note.tags.join(', '));
    setEditing(true);
  };

  const save = async () => {
    await actions.updateNote(note.id, { body, tags: parseTags(tags) });
    setEditing(false);
  };

  const jump = () => {
    actions.setFocus({ kind: 'note', id: note.id });
    // 批注在正文里的那块颜色是这个批注的「影子」（noteId 指回来），用它做精确定位。
    // 影子还没画出来时 scrollToAnnotation 会自动退回块级滚动，不会跳空。
    const el = scrollToAnnotation(note.selector.blockIndex, shadowHlId);
    if (!el) {
      actions.toast('warn', '正文里找不到这处位置了——原文可能被改过。可以点「重新定位」或「重新选位置」。');
    }
  };

  const orphan = note.anchorState === 'orphan';

  return (
    <div
      className={`note-card${active ? ' active' : ''}${orphan ? ' orphan' : ''}`}
      data-focus={`note:${note.id}`}
      style={{ '--note-color': hexOf(note.color) } as CSSProperties}
    >
      <button className="note-quote" onClick={jump} title="跳到正文里的位置">
        {note.selector.quote}
      </button>

      {rebinding ? (
        <div style={{ padding: '8px 10px 0' }}>
          <div className="banner info">
            <Anchor width={14} height={14} />
            <span style={{ flex: 1 }}>在正文里选中这段批注现在应该指的地方。</span>
            <button className="btn sm" onClick={() => actions.startRebind(null)}>
              取消
            </button>
          </div>
        </div>
      ) : null}

      {editing ? (
        <div className="note-edit">
          <textarea
            className="textarea"
            rows={4}
            value={body}
            autoFocus
            placeholder="写下你的理解、疑问、例子…"
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setEditing(false);
              else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void save();
              }
            }}
          />
          <input
            className="input"
            style={{ marginTop: 6 }}
            value={tags}
            placeholder="标签，用逗号分隔（例如：考点, 没懂）"
            onChange={(e) => setTags(e.target.value)}
          />
          <div className="row" style={{ marginTop: 7, gap: 4 }}>
            <ColorSwatches value={note.color} onPick={(c) => void actions.updateNote(note.id, { color: c })} />
            <span style={{ flex: 1 }} />
            <button className="btn sm" onClick={() => setEditing(false)}>
              取消
            </button>
            <button className="btn sm primary" onClick={() => void save()}>
              <Check width={12} height={12} /> 保存
            </button>
          </div>
        </div>
      ) : (
        <div
          className={`note-body${note.body ? '' : ' placeholder'}`}
          onDoubleClick={startEdit}
          title="双击编辑"
        >
          {note.body || '（只划了高亮，没有写批注）——双击补一句'}
        </div>
      )}

      {/* 回复线程（B2-2）：assistant 的条目底色不同 + 带「助手」标，视觉可分 */}
      {(note.replies?.length ?? 0) > 0 ? (
        <div className="note-replies">
          {note.replies!.map((r) => (
            <div
              key={r.id}
              className={`note-reply reply-${r.author}`}
              title={`${r.author === 'assistant' ? '助手' : '我'} · ${new Date(r.createdAt).toLocaleString()}`}
            >
              <span className="reply-who">{r.author === 'assistant' ? '助手' : '我'}</span>
              <span className="reply-body">{r.body}</span>
            </div>
          ))}
        </div>
      ) : null}

      {/* 助手回答中的实时步骤轨迹（流式）：它每干完一步这里就多一行 */}
      {agentLive?.noteId === note.id ? (
        <div className="note-replies">
          <div className="note-reply reply-assistant agent-note-live">
            <span className="reply-who">助手</span>
            <span className="agent-steps">
              {agentLive.steps.map((s, i) => (
                <span key={i} className={`agent-step${s.failed ? ' step-fail' : ''}`}>
                  {stepText(s)}
                </span>
              ))}
              <span className="agent-step step-now">正在想…</span>
            </span>
          </div>
        </div>
      ) : null}

      <div className="note-foot">
        <span className={`dot dot-${note.color}`} title="高亮颜色" />
        {headingText ? (
          // 宽度交给 CSS（见 .note-foot .tag-chip）：写死 130px 会把长章节名截成半截，
          // 而短名又白白占掉一排里最宽的位置。
          <span className="tag-chip" title={`所属章节：${headingText}`}>
            § {headingText}
          </span>
        ) : null}
        {note.tags.map((t) => (
          <span className="tag-chip" key={t}>
            #{t}
          </span>
        ))}
        {note.repairHistory.length ? (
          <span
            title={note.repairHistory.map((r) => `${r.at}：${r.reason}`).join('\n')}
            style={{ color: 'var(--text-3)' }}
          >
            已跟随移动 {note.repairHistory.length} 次
          </span>
        ) : null}
        <span className="grow" />
        {!editing && !rebinding ? (
          <>
            <button
              className="btn ghost sm"
              title="让库内助手就地回答这条批注"
              disabled={asking}
              onClick={() => void actions.askAssistant(note.id)}
            >
              <Wand width={12} height={12} /> {asking ? '助手在想…' : '让助手回答'}
            </button>
            <button className="btn ghost icon sm" title="编辑批注" onClick={startEdit}>
              <Pencil />
            </button>
            <button className="btn ghost icon sm" title="删除" onClick={() => setConfirmDel(true)}>
              <Trash />
            </button>
          </>
        ) : null}
      </div>

      {orphan && !rebinding ? (
        <div className="orphan-note">
          <Warning width={12} height={12} style={{ verticalAlign: -1 }} /> 原文改动太大，这处位置已经对不上了。
          <div style={{ marginTop: 6 }}>
            <button className="btn sm" onClick={() => actions.startRebind({ kind: 'note', id: note.id })}>
              <Anchor width={12} height={12} /> 在正文里重新选位置
            </button>
          </div>
        </div>
      ) : null}

      {confirmDel ? (
        <Modal
          title="删除这条批注？"
          onClose={() => setConfirmDel(false)}
          width={460}
          footer={
            <>
              <button className="btn" onClick={() => setConfirmDel(false)}>
                取消
              </button>
              <button
                className="btn"
                onClick={() => {
                  void actions.removeNote(note.id, true);
                  setConfirmDel(false);
                }}
              >
                只删批注，保留高亮
              </button>
              <button
                className="btn danger"
                onClick={() => {
                  void actions.removeNote(note.id, false);
                  setConfirmDel(false);
                }}
              >
                批注和高亮一起删
              </button>
            </>
          }
        >
          <div style={{ fontSize: 13.5, lineHeight: 1.7 }}>
            <div
              style={{
                borderLeft: `3px solid ${hexOf(note.color)}`,
                paddingLeft: 10,
                color: 'var(--text-2)',
                fontStyle: 'italic',
                marginBottom: 10,
              }}
            >
              {note.selector.quote}
            </div>
            这条批注的正文和标签会消失，正文里的高亮按你选的那样处理。原 Markdown 文件不受影响。
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

// ─────────────────────────── 纯高亮卡片 ───────────────────────────

function MarkCard({ hl, active }: { hl: Highlight; active: boolean }) {
  const { actions } = useApp();
  const [writing, setWriting] = useState(false);
  const [body, setBody] = useState('');
  const [confirmDel, setConfirmDel] = useState(false);
  const orphan = hl.anchorState === 'orphan';

  const jump = () => {
    actions.setFocus({ kind: 'highlight', id: hl.id });
    const el = scrollToAnnotation(hl.selector.blockIndex, hl.id);
    if (!el) actions.toast('warn', '正文里找不到这处高亮了。');
  };

  /**
   * 给一个「已经存在的纯高亮」补批注。
   * 注意这里不能直接 createNote({..., createHighlight: true})——那会新建一处高亮，
   * 于是同一段文字上叠了两个高亮。正确做法是：建批注（不建高亮）→ 把这处已有高亮
   * 的 noteId 指向它。
   */
  const promote = async () => {
    const text = body.trim();
    if (!text) return;
    const note = await actions.createNote({ selector: hl.selector, body: text, color: hl.color, createHighlight: false });
    if (note) await actions.updateHighlight(hl.id, { noteId: note.id });
    setWriting(false);
    setBody('');
  };

  return (
    <div
      className={`note-card${active ? ' active' : ''}${orphan ? ' orphan' : ''}`}
      data-focus={`highlight:${hl.id}`}
      style={{ '--note-color': hexOf(hl.color) } as CSSProperties}
    >
      <button className="note-quote" onClick={jump} title="跳到正文里的位置">
        {hl.selector.quote}
      </button>

      {writing ? (
        <div className="note-edit">
          <textarea
            className="textarea"
            rows={3}
            autoFocus
            value={body}
            placeholder="给这处高亮补一句批注…"
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setWriting(false);
              else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void promote();
              }
            }}
          />
          <div className="row" style={{ marginTop: 7 }}>
            <span style={{ flex: 1 }} />
            <button className="btn sm" onClick={() => setWriting(false)}>
              取消
            </button>
            <button className="btn sm primary" disabled={!body.trim()} onClick={() => void promote()}>
              保存
            </button>
          </div>
        </div>
      ) : (
        <div className="note-body placeholder">只划了高亮，没有批注</div>
      )}

      <div className="note-foot">
        <span className={`dot dot-${hl.color}`} title="高亮颜色" />
        <span style={{ color: 'var(--text-3)' }}>纯高亮</span>
        <span className="grow" />
        {!writing ? (
          <>
            <button className="btn ghost sm" onClick={() => setWriting(true)} title="补一句批注">
              <Pencil width={12} height={12} /> 写批注
            </button>
            <button className="btn ghost icon sm" title="删除这处高亮" onClick={() => setConfirmDel(true)}>
              <Trash />
            </button>
          </>
        ) : null}
      </div>

      {orphan ? <div className="orphan-note">原文改动太大，这处高亮已经对不上了。删掉重划一下吧。</div> : null}

      {confirmDel ? (
        <ConfirmDialog
          title="删除这处高亮？"
          danger
          confirmText="删除"
          message="只会去掉正文里的颜色，不会动原 Markdown 文件里的一个字。"
          onConfirm={() => actions.removeHighlight(hl.id)}
          onClose={() => setConfirmDel(false)}
        />
      ) : null}
    </div>
  );
}
