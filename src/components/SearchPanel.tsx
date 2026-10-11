/**
 * src/components/SearchPanel.tsx —— 右栏第三页：跨文章检索与问答。
 *
 * ★ 为什么它是独立一页，而不是「学习」里的第四个 Tab ★
 *   小抄 / 测验 / 闪卡全都是「当前这篇文章」的衍生物，文章没打开就什么都不存在
 *   （所以 StudyPanel 在没有 doc 时直接返回空态）。而检索面向的是**整个笔记库**，
 *   它恰恰在没有打开文章时最有用——「我记得我写过 X，在哪篇来着」。
 *   塞进学习页就得先逼用户打开一篇文章，本末倒置。
 *
 * ★ 两种模式的分工 ★
 *   找片段：只做检索，不调对话模型。没配 AI 也能用，速度是毫秒级。
 *   问一句 ：检索 + 生成，会消耗对话接口的额度，也慢得多。
 *   默认停在「找片段」——大多数时候用户要的是「那句话在哪」，不是一段总结。
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useApp } from '../state/store';
import {
  api,
  errorText,
  type ConflictScan,
  type IndexStatus,
  type ScannedConflict,
  type SearchAskResult,
  type SearchHit,
  type SearchOutcome,
} from '../api';
import { Bulb, Conflict as ConflictIcon, Refresh, Search as SearchIcon, Warning } from './Icons';

type Mode = 'find' | 'ask';

/** 判定结果的展示顺序：矛盾永远排最前 */
const VERDICT_ORDER = ['contradiction', 'complement', 'unrelated', 'unknown'] as const;

const VERDICT_LABEL: Record<string, string> = {
  contradiction: '说法不一致',
  complement: '互为补充',
  unrelated: '其实无关',
  unknown: '未判定',
};

export function SearchPanel({ switcher }: { switcher?: ReactNode }) {
  const { state, actions } = useApp();

  const [q, setQ] = useState('');
  const [mode, setMode] = useState<Mode>('find');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SearchOutcome | null>(null);
  /** 只有「问一句」模式才有；单独存是因为找片段模式压根不调对话接口 */
  const [answer, setAnswer] = useState<{ text: string; model: string; html?: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /** 矛盾检查的结果。两种模式共用一份展示，来源不同 */
  const [scan, setScan] = useState<ConflictScan | null>(null);
  const [scanning, setScanning] = useState(false);
  /** 问答时顺手查分歧：默认开，可以关。多一次判定调用，所以必须让人能关 */
  const [checkConflicts, setCheckConflicts] = useState(true);
  const [showOther, setShowOther] = useState(false);

  const [status, setStatus] = useState<IndexStatus | null>(null);
  const [rebuilding, setRebuilding] = useState(false);


  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await api.searchStatus());
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  /**
   * 跳回正文：把目标交给 store 里的 pendingJump，由 ArticlePane 在 DOM 就绪后
   * 统一执行「滚动 + 闪一下」。这里自己等两帧是等不到跨文档的 DOM 的。
   */
  const goTo = (rel: string, bi: number) => {
    actions.requestJump(rel, bi);
    if (rel !== state.doc?.path) void actions.openDoc(rel);
  };

  const run = async () => {
    const text = q.trim();
    if (!text || busy) return;
    setBusy(true);
    setErr(null);
    setScan(null);
    setShowOther(false);
    try {
      const asked: SearchAskResult | null =
        mode === 'ask' ? await api.askSearch(text, undefined, checkConflicts) : null;
      const r: SearchOutcome = asked ?? (await api.search(text));
      setResult(r);
      setAnswer(asked ? { text: asked.answer, model: asked.model, html: asked.answerHtml } : null);
      setScan(asked?.scan ?? null);
      if (!r.hits.length) setErr('没有匹配的内容。换个说法试试，或者先重建索引。');
    } catch (e) {
      setErr(errorText(e));
      setResult(null);
    } finally {
      setBusy(false);
    }
  };

  /** 找片段模式的「矛盾检查」：只查屏幕上这批命中（几毫秒 + 一次判定调用） */
  const scanNow = async () => {
    const list = result?.hits ?? [];
    if (list.length < 2 || scanning) return;
    setScanning(true);
    setErr(null);
    try {
      setScan(await api.scanConflicts(list, 6));
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setScanning(false);
    }
  };

  const rebuild = async (force: boolean) => {
    if (rebuilding) return;
    setRebuilding(true);
    setErr(null);
    try {
      const r = await api.buildSearchIndex(force);
      await refreshStatus();
      const bits = [`索引完成：${r.docs} 篇文章 / ${r.chunks} 个片段`];
      if (r.embedded) bits.push(`重新计算向量 ${r.embedded} 条`);
      if (r.removed) bits.push(`清理 ${r.removed} 条`);
      actions.toast('ok', bits.join('，'));
      if (r.notice) setErr(r.notice);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setRebuilding(false);
    }
  };

  const openHit = (hit: SearchHit) => {
    goTo(hit.docRel, hit.startBi);
  };

  const stale = status !== null && status.total === 0;
  const hits = result?.hits ?? [];
  /** 被判定为「说法不一致」的片段编号——列表里要标出来，一眼看到回答引用的哪两条打架 */
  const flagged = new Set<number>();
  for (const c of scan?.items ?? []) {
    if (c.verdict !== 'contradiction') continue;
    if (c.aN) flagged.add(c.aN);
    if (c.bN) flagged.add(c.bN);
  }

  return (
    <div className="pane pane-right">
      <div className="pane-head">
        <h2>检索</h2>
        {switcher}
        <span style={{ flex: 1 }} />
        {busy || rebuilding ? <span className="spinner" style={{ width: 12, height: 12, borderWidth: 1.5 }} /> : null}
      </div>

      <div className="search-bar">
        <textarea
          className="input search-input"
          rows={2}
          value={q}
          placeholder={mode === 'ask' ? '问一句：这几篇文章里怎么讲上下文工程？' : '在整个笔记库里找：上下文工程'}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void run();
            }
          }}
        />
        <div className="search-bar-row">
          <div className="pane-switch compact">
            <button className={mode === 'find' ? 'on' : ''} onClick={() => setMode('find')}>
              找片段
            </button>
            <button className={mode === 'ask' ? 'on' : ''} onClick={() => setMode('ask')}>
              问一句
            </button>
          </div>
          <span style={{ flex: 1 }} />
          <button className="btn primary" disabled={!q.trim() || busy} onClick={() => void run()}>
            {busy ? <span className="spinner" /> : <SearchIcon width={12} height={12} />}
            {mode === 'ask' ? ' 提问' : ' 检索'}
          </button>
        </div>
        <div className="search-bar-row" style={{ marginTop: 5 }}>
          {mode === 'ask' ? (
            <label className="check-line" title="回答前先比一遍这几段里有没有互相矛盾的说法。多一次判定调用（千把 token 量级），失败不影响回答。">
              <input type="checkbox" checked={checkConflicts} onChange={(e) => setCheckConflicts(e.target.checked)} />
              顺手查分歧
            </label>
          ) : (
            <span className="hint">只做检索，不调用对话接口。</span>
          )}
          <span style={{ flex: 1 }} />
          <span className="hint">Ctrl+Enter 执行</span>
        </div>
      </div>

      <div className="search-status">
        <span>
          索引：
          {status
            ? status.total
              ? `${status.docs} 篇 / ${status.total} 片段`
              : '还没建'
            : '读取中…'}
          {status && status.total ? ` · ${status.withVector ? '语义' : '关键词'}` : ''}
        </span>
        <span style={{ flex: 1 }} />
        <button className="btn sm" disabled={rebuilding} onClick={() => void rebuild(false)}>
          {rebuilding ? <span className="spinner" /> : <Refresh width={11} height={11} />} 重建
        </button>
        <button className="btn sm ghost" disabled={rebuilding} title="忽略缓存，全部重新计算向量" onClick={() => void rebuild(true)}>
          全量
        </button>
      </div>

      <div className="pane-body">
        {stale ? (
          <div className="empty">
            <SearchIcon width={22} height={22} />
            <p>还没有建索引。</p>
            <button className="btn primary" disabled={rebuilding} onClick={() => void rebuild(false)}>
              建一个
            </button>
            <p className="hint" style={{ marginTop: 8 }}>
              索引会把每篇文章按章节切成片段存起来。没配向量接口也能建，只是检索变成字面匹配。
            </p>
          </div>
        ) : null}

        {!stale && !result && !err ? (
          <div className="empty">
            <SearchIcon width={22} height={22} />
            <p>在整个笔记库里找点什么。</p>
          </div>
        ) : null}

        {result?.notice ? (
          <div className="banner warn">
            <Warning width={14} height={14} />
            <span>{result.notice}</span>
          </div>
        ) : null}

        {err ? (
          <div className="banner error">
            <Warning width={14} height={14} />
            <span>{err}</span>
          </div>
        ) : null}

        {answer ? (
          <div className="search-answer">
            <div className="search-answer-head">
              <Bulb width={13} height={13} /> 回答
              {answer.model ? <span className="tag-chip">{answer.model}</span> : null}
            </div>
            <div className="search-answer-body">
              {answer.html ? (
                <div className="md-mini" dangerouslySetInnerHTML={{ __html: answer.html }} />
              ) : (
                answer.text
              )}
            </div>
          </div>
        ) : null}

        {scan ? <ConflictBlock scan={scan} onGo={goTo} showOther={showOther} onToggleOther={() => setShowOther((v) => !v)} /> : null}

        {result && hits.length ? (
          <>
            <div className="search-result-head">
              {result.mode === 'vector' ? '语义' : '关键词'}匹配 · {hits.length} 条
              <span style={{ flex: 1 }} />
              {mode === 'find' ? (
                <button
                  className="btn sm ghost"
                  disabled={scanning || hits.length < 2}
                  title={
                    hits.length < 2
                      ? '至少要两条命中才能互相比'
                      : '只在这几条命中之间两两比对，看有没有互相矛盾的说法。会调用一次判定模型。'
                  }
                  onClick={() => void scanNow()}
                >
                  {scanning ? <span className="spinner" /> : <ConflictIcon width={11} height={11} />} 矛盾检查
                </button>
              ) : null}
            </div>
            {hits.map((hit, i) => (
              <HitRow key={hit.id} hit={hit} n={i + 1} flagged={flagged.has(i + 1)} onOpen={() => void openHit(hit)} />
            ))}
          </>
        ) : null}
      </div>
    </div>
  );
}

/**
 * 分歧卡片。
 *
 * 只把「矛盾」摆出来，补充和无关收在一行里——它们在检索场景下没有行动价值，
 * 全列出来会把真正要看的那一条淹掉（实测一批 6 条候选里常常只有 1 条是矛盾）。
 */
function ConflictBlock({
  scan,
  onGo,
  showOther,
  onToggleOther,
}: {
  scan: ConflictScan;
  onGo: (rel: string, bi: number) => void;
  showOther: boolean;
  onToggleOther: () => void;
}) {
  const hard = scan.items.filter((c) => c.verdict === 'contradiction');
  const soft = scan.items.filter((c) => c.verdict !== 'contradiction');

  if (!scan.candidates) {
    return (
      <div className="conflict-block">
        <div className="conflict-head">
          <ConflictIcon width={13} height={13} /> 分歧检查
          <span className="tag-chip">没有发现</span>
          <span style={{ flex: 1 }} />
          <span className="hint">
            比了 {scan.pairs} 对，{scan.ms}ms
          </span>
        </div>
        <div className="hint" style={{ padding: '0 2px 4px' }}>
          这几段里没有互相排斥的说法。
        </div>
      </div>
    );
  }

  return (
    <div className="conflict-block">
      <div className="conflict-head">
        <ConflictIcon width={13} height={13} /> 分歧检查
        <span className={`tag-chip${hard.length ? ' warn' : ''}`}>
          {hard.length ? `发现 ${hard.length} 处不一致` : '没有不一致'}
        </span>
        <span style={{ flex: 1 }} />
        <span className="hint">
          {hard.length ? '' : `${scan.counts.complement} 处互补 · `}比了 {scan.pairs} 对 · {scan.ms}ms
        </span>
      </div>

      {hard.map((c, i) => (
        <div className="conflict-card" key={i}>
          <div className="conflict-card-head">
            <span className="conflict-badge">
              [{c.aN ?? '?'}] 与 [{c.bN ?? '?'}] 不一致
            </span>
            {c.conflictAt ? <span className="conflict-at">对不上：{c.conflictAt}</span> : null}
          </div>
          <SideRow side={c.a} onGo={onGo} />
          <SideRow side={c.b} onGo={onGo} />
          <div className="conflict-foot">
            {c.shared.length ? <span className="conflict-words">比的是「{c.shared.slice(0, 3).join(' · ')}」</span> : null}
            {c.reason ? <span className="conflict-reason">{c.reason}</span> : null}
          </div>
        </div>
      ))}

      {soft.length ? (
        <div className="conflict-soft">
          <button className="link-btn" onClick={onToggleOther}>
            {showOther ? '收起' : '展开'}另外 {soft.length} 对（
            {VERDICT_ORDER.filter((v) => v !== 'contradiction')
              .map((v) => (scan.counts[v] ? `${VERDICT_LABEL[v]} ${scan.counts[v]}` : null))
              .filter(Boolean)
              .join(' · ')}
            ）
          </button>
          {showOther
            ? soft.map((c, i) => (
                <div className="conflict-card soft" key={i}>
                  <div className="conflict-card-head">
                    <span className="conflict-badge quiet">{VERDICT_LABEL[c.verdict]}</span>
                    <span className="conflict-at">
                      [{c.aN ?? '?'}] ⇄ [{c.bN ?? '?'}]
                    </span>
                  </div>
                  <div className="conflict-foot">
                    {c.shared.length ? <span className="conflict-words">比的是「{c.shared.slice(0, 3).join(' · ')}」</span> : null}
                    <span className="conflict-reason">{c.reason}</span>
                  </div>
                </div>
              ))
            : null}
        </div>
      ) : null}
    </div>
  );
}

function SideRow({ side, onGo }: { side: ScannedConflict['a']; onGo: (rel: string, bi: number) => void }) {
  return (
    <div className="conflict-side" onClick={() => onGo(side.docRel, side.startBi)} title="跳到原文这一段">
      <span className="conflict-side-doc ellipsis">
        《{side.docTitle}》{side.headingText ? ` › ${side.headingText}` : ''}
      </span>
      <span className="conflict-side-quote">{side.quote}</span>
    </div>
  );
}

function HitRow({
  hit,
  n,
  flagged,
  onOpen,
}: {
  hit: SearchHit;
  n: number;
  /** 这一条被判定为「说法不一致」的一方：列表里直接标出来 */
  flagged: boolean;
  onOpen: () => void;
}) {
  return (
    <div
      className={`search-hit${flagged ? ' flagged' : ''}`}
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && onOpen()}
    >
      <div className="search-hit-head">
        <span className={`search-hit-n${flagged ? ' flagged' : ''}`} title={flagged ? '这一条和另一条命中说法不一致' : undefined}>
          [{n}]
        </span>
        <span className="search-hit-doc ellipsis">{hit.docTitle}</span>
        {flagged ? <span className="search-hit-flag">分歧</span> : null}
        <span style={{ flex: 1 }} />
        <span className="search-hit-score" title="匹配得分">
          {hit.score.toFixed(3)}
        </span>
      </div>
      {hit.headingPath.length || hit.headingText ? (
        <div className="search-hit-path ellipsis">
          {[...hit.headingPath, hit.headingText].filter(Boolean).join(' › ')}
          {hit.part > 0 ? ` · 第 ${hit.part + 1} 片` : ''}
        </div>
      ) : null}
      {/* html 由服务端 createMd(html:false) 产出，原始 HTML 不会被解析，可以安全插入。
          没有它（老接口/降级）时退回纯文本，至少不会把 ** 和 # 直接糊在屏幕上。 */}
      {hit.html ? (
        <div className="search-hit-text md-mini" dangerouslySetInnerHTML={{ __html: hit.html }} />
      ) : (
        <div className="search-hit-text">{hit.snippet}</div>
      )}
    </div>
  );
}
