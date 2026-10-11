/**
 * src/components/GraphDialog.tsx —— 知识地图：把整个库按「谁和谁总在一起被讲到」分成几个主题团。
 *
 * ★ 为什么是分组列表，不是力导向毛球图 ★
 *   27 篇文档画成节点连线，得到的就是一团线——力导向图能表达「有关系」，
 *   但它表达不了「有多紧」，而分组列表一眼就能读完：几个团、每团几篇、团内最紧的边靠什么连。
 *   而且这个功能要回答的问题是「我的笔记实际分成了几块」，不是「谁和谁有连线」。
 *
 * ★ 这里没有一句话是模型写的 ★
 *   节点 = 你写下的文档，边 = 相似度算出来的，团 = Louvain 在边上跑出来的。
 *   全部是派生物：删掉重算即可，不需要维护，也不存在「AI 编出来的第二份真相」。
 *   团的名字就是「N 篇」——不让模型起名，因为名字一改就废，而且会开始骗人。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '../state/store';
import { api, errorText, type DocGraph, type GraphCommunity, type GraphResponse } from '../api';
import { Modal } from './Dialog';
import { Activate, Refresh, Warning } from './Icons';
import { ActivationDialog } from './ActivationDialog';

export function GraphDialog({ onClose }: { onClose: () => void }) {
  const { state, actions } = useApp();
  const [shot, setShot] = useState<GraphResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 正在对哪个主题团做记忆激活；null = 面板没开 */
  const [actFor, setActFor] = useState<number | null>(null);
  const timer = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      setShot(await api.graph());
      setErr(null);
    } catch (e) {
      setErr(errorText(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 首次打开时后台正在算 kNN（十几秒），界面不能干等着——轮询到出结果为止
  useEffect(() => {
    const building = shot?.building ?? false;
    if (!building) {
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = null;
      return;
    }
    timer.current = window.setTimeout(() => void load(), 2500);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = null;
    };
  }, [shot, load]);

  const rebuild = async (force: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.rebuildGraph(force);
      setShot({ graph: r.graph, stale: false, building: false, indexed: r.stat });
      actions.toast('ok', `知识地图已重建：${r.graph.stat.docs} 篇 / ${r.graph.communities.length} 个主题团`);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const open = (rel: string) => {
    void actions.openDoc(rel);
    onClose();
  };

  const g = shot?.graph ?? null;

  return (
    <Modal
      title="知识地图"
      onClose={onClose}
      width={720}
      footer={
        <>
          <span className="hint" style={{ flex: 1, textAlign: 'left' }}>
            按相似度的连接结构分组，零模型调用，不生成任何内容。
          </span>
          <button className="btn" disabled={busy || shot?.building} onClick={() => void rebuild(false)}>
            {busy ? <span className="spinner" /> : <Refresh width={11} height={11} />} 重建
          </button>
          <button className="btn ghost" disabled={busy || shot?.building} title="忽略缓存，全部重算（首次要十几秒）" onClick={() => void rebuild(true)}>
            全量
          </button>
        </>
      }
    >
      {!g ? (
        <div className="empty" style={{ padding: '40px 0' }}>
          {err ? (
            <div className="banner error">
              <Warning width={14} height={14} />
              <span>{err}</span>
            </div>
          ) : (
            <>
              <span className="spinner" style={{ width: 18, height: 18 }} />
              <p>正在建立知识地图…</p>
              <p className="hint">
                第一次需要算全库片段之间的相似度（27 篇约十几秒），之后会缓存下来，再打开就是瞬间的。
              </p>
            </>
          )}
        </div>
      ) : (
        <>
          {shot?.stale ? (
            <div className="banner warn">
              <Warning width={14} height={14} />
              <span>笔记库改过了，下面这份图是上一次算的，正在后台更新。</span>
            </div>
          ) : null}
          {g.notice ? (
            <div className="banner warn">
              <Warning width={14} height={14} />
              <span>{g.notice}</span>
            </div>
          ) : null}
          <div className="graph-sum">
            {g.stat.docs} 篇 · {g.communities.length} 个主题团 · {g.edges.length} 条连接 ·{' '}
            {g.mode === 'semantic' ? '语义相似度' : '词面相似度'} · 建于 {g.builtAt.slice(0, 16).replace('T', ' ')}
          </div>
          <GraphBody g={g} onOpen={open} onActivate={setActFor} />
        </>
      )}
      {actFor !== null ? (
        <ActivationDialog communityId={actFor} onClose={() => setActFor(null)} />
      ) : null}
    </Modal>
  );
}

function GraphBody({
  g,
  onOpen,
  onActivate,
}: {
  g: DocGraph;
  onOpen: (rel: string) => void;
  onActivate: (communityId: number) => void;
}) {
  const node = (i: number) => g.nodes[i];
  // 桥接边：团与团之间的连接。谁在桥接，就看这些边的两端
  const bridgeEdges = g.bridges.map((i) => ({ i, e: g.edges[i] })).sort((x, y) => Number(y.e.sole) - Number(x.e.sole));
  const bridgeDocs = new Map<number, number>();
  for (const { e } of bridgeEdges) {
    bridgeDocs.set(e.a, (bridgeDocs.get(e.a) ?? 0) + 1);
    bridgeDocs.set(e.b, (bridgeDocs.get(e.b) ?? 0) + 1);
  }
  const isolated = g.isolates.map(node);

  return (
    <>
      {/* ★ 按 id 排序，不要按 Louvain 的输出顺序 ★
          Louvain 返回团的顺序是算法内部的，实测是 2、0、1、3——
          照原样渲染出来，用户看到的就是「主题团 2、主题团 0、主题团 1」，
          既莫名其妙，也会让人以为编号有意义（其实只是分组编号）。 */}
      {[...g.communities]
        .sort((a, b) => a.id - b.id)
        .map((c) => (
          <CommunityCard
            key={c.id}
            c={c}
            g={g}
            bridge={{ docs: bridgeDocs, edges: bridgeEdges }}
            onOpen={onOpen}
            onActivate={onActivate}
          />
        ))}

      {isolated.length ? (
        <div className="graph-block">
          <div className="graph-block-head">
            还没连上任何文档的 <span className="tag-chip">{isolated.length} 篇</span>
            <span className="hint" style={{ marginLeft: 8 }}>
              和库里其它文档没有明显的共同话题
            </span>
          </div>
          <div className="graph-members">
            {isolated.map((n) => (
              <DocChip key={n.rel} title={n.title} meta={`${n.chunks} 片`} onClick={() => onOpen(n.rel)} />
            ))}
          </div>
        </div>
      ) : null}
    </>
  );
}

function CommunityCard({
  c,
  g,
  bridge,
  onOpen,
  onActivate,
}: {
  c: GraphCommunity;
  g: DocGraph;
  bridge: { docs: Map<number, number>; edges: { i: number; e: DocGraph['edges'][number] }[] };
  onOpen: (rel: string) => void;
  onActivate: (communityId: number) => void;
}) {
  const members = [...c.members].sort((x, y) => g.nodes[y].degree - g.nodes[x].degree);
  // 团内最强的几条边——「为什么这几篇会被分到一起」的证据就在这里
  const inner = g.edges
    .filter((e) => c.members.includes(e.a) && c.members.includes(e.b))
    .sort((x, y) => y.w - x.w)
    .slice(0, 3);
  const out = bridge.edges.filter(({ e }) => c.members.includes(e.a) || c.members.includes(e.b));
  const n = c.members.length;
  // 至少 2 篇才谈得上「团内紧密」。单篇的团内聚度必然是 0，显示出来只会让人误会
  const cohesion = n > 1 ? c.cohesion : null;

  return (
    <div className="graph-block">
      <div className="graph-block-head">
        <span className="graph-block-name">主题团 {c.id}</span>
        <span className="tag-chip">{n} 篇</span>
        {cohesion !== null ? (
          <span className="graph-cohesion" title="团内连接权重 ÷ 这个团涉及的总权重。越高说明这几篇越自成一体">
            <span className="graph-cohesion-bar">
              <span style={{ width: `${Math.round(cohesion * 100)}%` }} />
            </span>
            内聚 {cohesion.toFixed(2)}
          </span>
        ) : null}
        <span style={{ flex: 1 }} />
        <button
          className="btn tiny"
          title="让 agent 通读这个团，找出重要但你还没记下来的概念并出卡"
          onClick={() => onActivate(c.id)}
        >
          <Activate width={11} height={11} /> 记忆激活
        </button>
        {out.length ? <span className="hint">连着其它团 {out.length} 处</span> : <span className="hint">不和其他团来往</span>}
      </div>

      <div className="graph-members">
        {members.map((i) => {
          const nd = g.nodes[i];
          const link = bridge.docs.get(i) ?? 0;
          return (
            <DocChip
              key={nd.rel}
              title={nd.title}
              meta={`${nd.chunks} 片 · ${Math.round(nd.chars / 100) / 10}k 字`}
              badge={link ? `桥接 ${link}` : undefined}
              onClick={() => onOpen(nd.rel)}
            />
          );
        })}
      </div>

      {inner.length ? (
        <div className="graph-evidence">
          {inner.map((e, k) => (
            <div className="graph-ev" key={k}>
              <span className="graph-ev-pair">
                {short(g.nodes[e.a].title, 16)} ⇄ {short(g.nodes[e.b].title, 16)}
              </span>
              <span className="graph-ev-words">{e.evidence.length ? e.evidence.join(' · ') : '（没有能读出来的共享说法）'}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function DocChip({ title, meta, badge, onClick }: { title: string; meta: string; badge?: string; onClick: () => void }) {
  return (
    <button className="graph-doc" onClick={onClick} title={title}>
      <span className="graph-doc-title ellipsis">{title}</span>
      <span className="graph-doc-meta">
        {badge ? <span className="graph-doc-badge">{badge}</span> : null}
        {meta}
      </span>
    </button>
  );
}

function short(s: string, n: number): string {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}
