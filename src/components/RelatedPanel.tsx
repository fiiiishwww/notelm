/**
 * src/components/RelatedPanel.tsx —— 正文下方的「相关段落」发散圆。
 *
 * 和检索面板的区别：检索要用户输入问题，这里不用——
 * 用户在读，我们主动告诉他别处还有谁在讲同一件事。
 *
 * ★ 中心是谁 ★
 *   中心是「读者视野里当前这一块」，随滚动平滑移动，不需要点选。
 *   鼠标移进面板时会冻结跟随，否则用户正要点的那个点会因为他稍微动了一下
 *   滚轮就跑掉。
 *
 * ★ 为什么是散开的圆而不是连线图 ★
 *   用户明确说过「我不需要那么多双向链接」。发散图只有一个中心、N 个方向，
 *   每条线只表达「它和当前块有多像」，不存在节点之间互相连线的组合爆炸，
 *   也不会长成谁都看不懂的毛线球。
 */

import { useEffect, useRef, useState, type RefObject } from 'react';
import { useApp } from '../state/store';
import { api, errorText, type RelatedItem } from '../api';

const CX = 340;
const CY = 118;
/** 最相关的一点离中心最近。半径差 = 相关度差，这是最直观的编码。 */
const R_MIN = 80;
const R_MAX = 118;

interface Phys {
  x: number;
  y: number;
  vx: number;
  vy: number;
  bx: number;
  by: number;
  ph: number;
}

export function RelatedPanel({ scrollRef }: { scrollRef: RefObject<HTMLDivElement | null> }) {
  const { state, actions } = useApp();
  const docRel = state.doc?.path ?? null;

  // 收起/展开上移到了 BottomDock 的 tabs 行（2026-09-23）——这里不再有自己的 open state，
  // 收起时整个组件被卸载，原先用 open 暂停的 effect 守卫一并删除。
  const [bi, setBi] = useState(0);
  const [items, setItems] = useState<RelatedItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [center, setCenter] = useState<{ headingText: string; startBi: number } | null>(null);
  const [mode, setMode] = useState<'semantic' | 'lexical'>('semantic');
  const [hover, setHover] = useState(-1);

  /** 鼠标在面板上时冻结跟随，不然要点的那个点会跑掉 */
  const frozen = useRef(false);
  const nodeRefs = useRef<(SVGGElement | null)[]>([]);
  const lineRefs = useRef<(SVGLineElement | null)[]>([]);
  const phys = useRef<Phys[]>([]);
  const tipRef = useRef<HTMLDivElement>(null);

  // 换文章时从头开始
  useEffect(() => {
    setBi(0);
    setItems([]);
    setCenter(null);
  }, [docRel]);

  // ── 找出「读者正在看哪一块」──
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc || !docRel) return;
    let timer: number | undefined;

    const pick = () => {
      const box = sc.getBoundingClientRect();
      // 取偏上三分之一处，比正中间更接近人眼的落点
      const aim = box.top + box.height * 0.34;
      const els = sc.querySelectorAll<HTMLElement>('.article [data-bi]');
      let best = 0;
      let bestD = Infinity;
      for (const el of els) {
        const b = el.getBoundingClientRect();
        if (b.bottom < box.top || b.top > box.bottom) continue;
        const d = Math.abs(b.top + b.height / 2 - aim);
        if (d < bestD) {
          bestD = d;
          best = Number(el.dataset.bi ?? 0);
        }
      }
      return best;
    };

    const onScroll = () => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (frozen.current) return;
        setBi((prev) => {
          const next = pick();
          return next === prev ? prev : next;
        });
      }, 260);
    };

    sc.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => {
      sc.removeEventListener('scroll', onScroll);
      if (timer) window.clearTimeout(timer);
    };
  }, [scrollRef, docRel]);

  // ── 取相关段落 ──
  useEffect(() => {
    if (!docRel) return;
    const ac = new AbortController();
    setLoading(true);
    setErr(null);
    api
      .docRelated(docRel, bi, 5, ac.signal)
      .then((r) => {
        setItems(r.items);
        setCenter(r.center ? { headingText: r.center.headingText, startBi: r.center.startBi } : null);
        setMode(r.mode);
      })
      .catch((e) => {
        if (!ac.signal.aborted) setErr(errorText(e));
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false);
      });
    return () => ac.abort();
  }, [docRel, bi]);

  // 相关段落变了就重摆位置
  useEffect(() => {
    const n = items.length || 1;
    phys.current = items.map((it, i) => {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
      const base = R_MAX - it.score * (R_MAX - R_MIN);
      const bx = CX + Math.cos(a) * base;
      const by = CY + Math.sin(a) * base;
      return { x: bx, y: by, vx: 0, vy: 0, bx, by, ph: i * 1.27 };
    });
    nodeRefs.current.length = items.length;
    lineRefs.current.length = items.length;
  }, [items]);

  // ── 只做「回弹到自己的位置」，不再对鼠标起反应 ──
  useEffect(() => {
    if (!items.length) return;
    let raf = 0;
    const tick = (ts: number) => {
      const t = ts / 1000;
      for (let i = 0; i < phys.current.length; i++) {
        const p = phys.current[i];
        // 只留一点极缓的呼吸感（1.5px）。
        // 以前是 4px 呼吸 + 鼠标排斥力，节点会在指针底下飘走，点不中——
        // 「动态好看」必须让位于「点得着」，所以这里永远只朝自己的锚点收敛。
        const tx = p.bx + Math.sin(t * 0.85 + p.ph) * 1.5;
        const ty = p.by + Math.cos(t * 1.05 + p.ph) * 1.5;
        p.vx += (tx - p.x) * 0.055;
        p.vy += (ty - p.y) * 0.055;
        p.vx *= 0.86;
        p.vy *= 0.86;
        p.x += p.vx;
        p.y += p.vy;

        const g = nodeRefs.current[i];
        if (g) g.setAttribute('transform', `translate(${p.x.toFixed(1)},${p.y.toFixed(1)})`);
        const ln = lineRefs.current[i];
        if (ln) {
          ln.setAttribute('x2', p.x.toFixed(1));
          ln.setAttribute('y2', p.y.toFixed(1));
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [items, hover]);

  /**
   * 只登记「要跳到哪一篇的哪一块」。
   * 真正的滚动 + 高亮交给 ArticlePane：跨文档时 openDoc 是异步的，
   * 在这里等两帧去 querySelector 只能拿到 null（以前的写法就是这么静默失败的）。
   */
  const jump = (it: RelatedItem) => {
    actions.requestJump(it.docRel, it.startBi);
    if (it.docRel !== docRel) void actions.openDoc(it.docRel);
  };

  const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const tip = tipRef.current;
    if (tip && hover >= 0) {
      const x = e.clientX - box.left;
      const y = e.clientY - box.top;
      tip.style.left = `${x > box.width - 340 ? x - 330 : x + 16}px`;
      tip.style.top = `${y > 150 ? y - 130 : y + 14}px`;
    }
  };

  const cur = hover >= 0 ? items[hover] : null;
  const short = (s: string, n = 10) => (s.length <= n ? s : `${s.slice(0, n)}…`);

  return (
    <div
      className="related-panel"
      onMouseEnter={() => {
        frozen.current = true;
      }}
      onMouseLeave={() => {
        frozen.current = false;
        setHover(-1);
      }}
    >
      <div className="related-head">
        <strong>相关段落</strong>
        <span className="related-sub">
          {center?.headingText ? `当前：${short(center.headingText, 14)}` : '当前这一段'}
          {' · '}第 {bi} 块
        </span>
        <span style={{ flex: 1 }} />
        {loading ? <span className="related-sub">正在找…</span> : null}
      </div>

      <div className="related-body" onMouseMove={onMove}>
          {err ? (
            <p className="related-empty">{err}</p>
          ) : !items.length ? (
            <p className="related-empty">{loading ? '正在找相关的段落…' : '别的文章里还没有和这一段足够相关的段落。'}</p>
          ) : (
            <>
              <svg viewBox="0 0 680 240" style={{ width: '100%', height: 'auto', display: 'block' }}>
                <circle cx={CX} cy={CY} r={R_MAX} fill="none" stroke="var(--border)" strokeDasharray="2 5" />
                <circle cx={CX} cy={CY} r={(R_MAX + R_MIN) / 2} fill="none" stroke="var(--border)" strokeDasharray="2 5" />
                <circle cx={CX} cy={CY} r={R_MIN} fill="none" stroke="var(--border)" strokeDasharray="2 5" />

                {items.map((it, i) => (
                  <line
                    key={`l-${it.id}`}
                    ref={(el) => {
                      lineRefs.current[i] = el;
                    }}
                    x1={CX}
                    y1={CY}
                    x2={CX}
                    y2={CY}
                    stroke="var(--accent)"
                    strokeWidth={1 + it.score * 3}
                    opacity={0.22 + it.score * 0.5}
                    strokeLinecap="round"
                  />
                ))}

                <circle cx={CX} cy={CY} r={26} fill="var(--accent)" />
                <text x={CX} y={CY + 4} textAnchor="middle" fontSize={11} fontWeight={500} fill="#fff">
                  {bi}
                </text>

                {items.map((it, i) => {
                  const on = i === hover;
                  const r = (10 + it.score * 12) * (on ? 1.12 : 1);
                  return (
                    <g
                      key={it.id}
                      ref={(el) => {
                        nodeRefs.current[i] = el;
                      }}
                      style={{ cursor: 'pointer' }}
                      onMouseEnter={() => setHover(i)}
                      onMouseLeave={() => setHover(-1)}
                      onClick={() => void jump(it)}
                    >
                      {/* 透明的命中圈：指针落在圆边上也算点中，不必对准圆心 */}
                      <circle r={r + 10} fill="transparent" />
                      <circle
                        r={r}
                        fill="var(--accent)"
                        stroke={on ? 'var(--accent-strong, var(--accent))' : 'transparent'}
                        strokeWidth={on ? 2 : 0}
                      />
                      <text textAnchor="middle" dy={4} fontSize={11} fontWeight={500} fill="#fff">
                        {i + 1}
                      </text>
                      <text textAnchor="middle" y={r + 15} fontSize={11} fill="var(--text-2)">
                        {short(it.headingText || it.docTitle, 9)}
                      </text>
                    </g>
                  );
                })}
              </svg>

              <div
                ref={tipRef}
                className="related-tip"
                style={{ opacity: cur ? 1 : 0 }}
              >
                {cur ? (
                  <>
                    <div className="related-tip-title">
                      {cur.docTitle}
                      {cur.headingText ? ` · ${cur.headingText}` : ''}
                    </div>
                    <p className="related-tip-text">{cur.snippet}</p>
                    <div className="related-tip-foot">
                      <span>相关度 {Math.round(cur.score * 100)}</span>
                      {/* 有共同短语就把短语摆出来；纯语义命中（换了个说法讲同一件事）
                          就明说，别让用户以为这功能没依据 */}
                      {cur.shared.length ? (
                        <span>
                          {mode === 'semantic' ? '共同短语' : '关键词'}：{cur.shared.join('、')}
                        </span>
                      ) : mode === 'semantic' ? (
                        <span>语义相近，没有共同短语</span>
                      ) : null}
                    </div>
                  </>
                ) : null}
              </div>
            </>
          )}
      </div>
    </div>
  );
}
