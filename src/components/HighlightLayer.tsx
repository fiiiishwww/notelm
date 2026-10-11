/**
 * src/components/HighlightLayer.tsx —— 正文的「渲染 + 叠加 + 选区捕获」三合一。
 *
 * 为什么把 <article> 放在这个组件里渲染，而不是让 ArticlePane 渲染、这里只挂副作用：
 *   服务端给的 html 一旦变化，React 会重写 article 的 innerHTML，我们手动画上去的
 *   <mark> 会被整片抹掉。只有让「写 html」和「画高亮」在同一个组件的同一次提交里发生，
 *   才能保证它们在同一个 commit 里一前一后完成、中间不会被浏览器画一帧没高亮的正文。
 *
 * 三个副作用职责分明、互不重叠：
 *   useLayoutEffect(重绘)   —— 内容变了才跑：拆旧 mark → 建索引 → 重新上色
 *   useLayoutEffect(激活)   —— 只切 class：点批注时闪一下，不动 DOM 结构
 *   useEffect(选区监听)     —— 用户松手/按键才跑：把选区翻译成选择器，弹工具条
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { useApp } from '../state/store';
import type { Block, HighlightColor, TextQuoteSelector } from '../../shared/text';
import {
  PENDING_KEY,
  buildBlockMap,
  driftBlocks,
  markKeys,
  rangeRect,
  rebuildOverlay,
  selectorFromRange,
  syncActiveClass,
  type OverlayItem,
} from '../hooks/buildBlockMap';
import { COLORS, labelOf } from '../lib/colors';
import { Anchor, ChevronRight, Note as NoteIcon } from './Icons';

interface Rect {
  x: number;
  y: number;
  bottom: number;
  width: number;
}

/** 正文里刚被选中的一段（还没决定拿它干嘛）。 */
interface Picked {
  rect: Rect;
  /** 跨块选择时没有 selector：这时只在工具条上给一句提示 */
  selector?: TextQuoteSelector;
  crossBlock?: boolean;
}

export function HighlightLayer({
  html,
  blocks,
  docPlain,
}: {
  html: string;
  blocks: Block[];
  /** 后端算好的全篇纯文本。传给 buildBlockMap，省掉前端现拼百万字符那一刀。 */
  docPlain: string;
}) {
  const { state, actions } = useApp();
  const artRef = useRef<HTMLElement | null>(null);
  const [picked, setPicked] = useState<Picked | null>(null);

  const highlights = state.doc?.sidecar.highlights ?? [];
  const notes = state.doc?.sidecar.notes ?? [];
  const pending = state.pending;
  const focus = state.focus;
  const rebinding = state.rebinding;

  // 选区捕获要用到最新的 blocks（它在 doc 变化时才换引用，但监听器的闭包可能过期）
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;
  const docPlainRef = useRef(docPlain);
  docPlainRef.current = docPlain;

  /**
   * 重绘签名。只要这些字段没变，屏幕上的高亮就不可能变，不必动 DOM——
   * 否则「在右栏编辑器里敲一个字」都会触发整篇正文重绘。
   *
   * noteId 必须在签名里：给一处已有高亮补批注时，位置和颜色一个都没变，
   * 只有 noteId 从 null 变成了某个 id。漏掉它，正文里那块就不会长出新加的
   * 「这里写过批注」标记，用户以为没保存上。
   */
  const sig = useMemo(() => {
    const hs = highlights
      .map(
        (h) =>
          `${h.id}:${h.color}:${h.anchorState}:${h.noteId ?? ''}:${h.selector.blockIndex}:${h.selector.textOffset}:${h.selector.quoteLength}`,
      )
      .join('|');
    const ps = pending
      ? `P:${pending.selector.blockIndex}:${pending.selector.textOffset}:${pending.selector.quoteLength}`
      : '';
    // 批注 id 列表也要算进去：has-note 标记取决于「这处高亮的 noteId 是不是一条真实存在的批注」，
    // 删掉批注但保留高亮时，highlights 的 noteId 没变，只有这条列表变了。
    return `${hs}##${ps}##${notes.map((n) => n.id).join(',')}`;
  }, [highlights, pending, notes]);

  // ── ① 重绘叠加层 ──
  useLayoutEffect(() => {
    const root = artRef.current;
    if (!root) return;

    const items: OverlayItem[] = [];
    for (const h of highlights) {
      items.push({
        key: h.id,
        selector: h.selector,
        color: h.color,
        orphan: h.anchorState === 'orphan',
        hasNote: !!h.noteId && notes.some((n) => n.id === h.noteId),
      });
    }
    // 正在写批注的那处选区也画出来：用户的注意力已经跑到右栏的输入框上了，
    // 正文里不给个颜色，他会不确定自己刚才圈的是哪一句。
    if (pending) items.push({ key: PENDING_KEY, selector: pending.selector, color: 'yellow' });

    const { index } = rebuildOverlay(root, blocks, items);

    // 开发期自检：DOM 重建出来的文字与后端 blocks[].text 对不上，说明
    // shared/blocks.ts 和本文件的归一化规则已经漂移了，锚点会静默错位。
    // 这类问题不会抛异常、界面也不会报错，只会在某天突然「批注都跑偏了」，
    // 所以留一条显式的告警。
    // 注意索引现在是惰性的，这里只校验「这次真正用到的块」——正好就是会出事的那几个。
    if (import.meta.env.DEV) {
      const bad = driftBlocks(index);
      if (bad.length) {
        console.warn(
          '[anchor] 有块的 DOM 文本与后端 blocks[].text 不一致，锚点可能漂移：',
          bad.slice(0, 5).map((b) => ({ bi: b.bi, dom: b.text.slice(0, 60) })),
        );
      }
    }
  }, [html, sig, blocks, highlights, pending, notes]);

  // ── ② 激活态（只切 class）──
  useLayoutEffect(() => {
    const root = artRef.current;
    if (!root) return;
    const keys: string[] = [];
    if (focus) {
      if (focus.kind === 'highlight') keys.push(focus.id);
      else {
        // 批注的高亮是这个批注的「影子」，点批注时它应该一起亮起来
        const hl = highlights.find((h) => h.noteId === focus.id);
        if (hl) keys.push(hl.id);
      }
    }
    syncActiveClass(root, keys);
  }, [focus, highlights, sig]);

  // ── ③ 点正文里的高亮 → 跳到对应批注 ──
  const onArticleClick = useCallback(
    (e: ReactMouseEvent) => {
      const target = e.target as HTMLElement | null;
      const mark = target?.closest?.('mark.hl');
      if (!mark) return;
      const keys = markKeys(mark).filter((k) => k !== PENDING_KEY);
      if (!keys.length) return;
      // 重叠处挂着多条高亮：优先给「已经写了批注」的那条，用户点高亮多半是想看文字，
      // 而不是想看到一句「只划了高亮，没有批注」。
      const withNote = keys.find((k) => {
        const h = highlights.find((x) => x.id === k);
        return h?.noteId && notes.some((n) => n.id === h.noteId);
      });
      const pickId = withNote ?? keys[keys.length - 1];
      const hl = highlights.find((h) => h.id === pickId);
      if (!hl) return;
      if (hl.noteId && notes.some((n) => n.id === hl.noteId)) {
        actions.setFocus({ kind: 'note', id: hl.noteId });
      } else {
        actions.setFocus({ kind: 'highlight', id: hl.id });
      }
    },
    [actions, highlights, notes],
  );

  // ── ④ 选区监听 ──
  /**
   * 点工具条按钮的一瞬间，浏览器会先清掉选区。那不是「用户重新选了一段」，
   * 但清选区同样会触发 selectionchange / pointerup，于是工具条会在按钮的 click
   * 到达之前先把自己卸载掉 —— 表现为「点了没反应」。
   * 所以工具条按下时盖一个时间窗，窗口内的自动采集一律跳过。
   */
  const suppressUntil = useRef(0);
  const holdToolbar = useCallback(() => {
    suppressUntil.current = Date.now() + 900;
  }, []);

  const pick = useCallback(() => {
    if (Date.now() < suppressUntil.current) return;
    const root = artRef.current;
    if (!root) return;
    const s = window.getSelection();
    if (!s || s.rangeCount === 0 || s.isCollapsed) {
      setPicked(null);
      return;
    }
    const range = s.getRangeAt(0);
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) {
      setPicked(null);
      return;
    }
    const rect = rangeRect(range);
    // 每次都**现建**一次索引：正文里已经画满了 <mark>，上一轮建索引时记下的
    // 文本节点早被替换掉了。松手是一次低频的用户动作，重建一遍完全承受得起，
    // 而缓存一份「看起来能用其实指向废弃节点」的索引只会制造偶发的定位失败。
    const index = buildBlockMap(root, blocksRef.current, docPlainRef.current);
    const r = selectorFromRange(index, range);
    if (!r.ok) {
      setPicked(r.reason === 'cross-block' ? { rect, crossBlock: true } : null);
      return;
    }
    setPicked({ rect, selector: r.selector });
  }, []);

  useEffect(() => {
    /**
     * 松手才采集：拖动选择手柄的过程中选区每帧都在变，那期间算出来的选择器没意义。
     * 鼠标用 mouseup；触摸端（手机长按选词）走 pointerup / touchend —— 兼容性鼠标事件
     * 在很多安卓浏览器上是被抑制的，只听 mouseup 就等于手机上永远不弹工具条。
     */
    const schedule = (e?: Event) => {
      const t = e?.target as HTMLElement | null;
      // 工具条上的点击会先把选区清掉，那不是「重新选了一段」，不能跟着关掉工具条。
      // （工具条本身还压了一层 pointerdown 的 preventDefault，这里是第二道保险。）
      if (t?.closest?.('.sel-toolbar')) return;
      window.setTimeout(pick, 0);
    };
    const onMouseUp = (e: MouseEvent) => schedule(e);
    const onPointerUp = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') schedule(e);
    };
    const onTouchEnd = (e: TouchEvent) => schedule(e);
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setPicked(null);
        return;
      }
      if (e.shiftKey && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) {
        window.setTimeout(pick, 0);
      }
    };
    /**
     * 滚动：工具条是 position:fixed，不跟着文字走，停在原地会指着别处。
     * 早先是直接收起来，但手机上「长按选中」本身就会带一点自动滚动、
     * 松手后还常有惯性滚动 —— 工具条刚弹出来就被自己收掉了，等于没有。
     * 改成跟着选区更新坐标（只读 getBoundingClientRect，比重新建索引便宜得多），
     * 选区真没了才收。
     */
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        if (Date.now() < suppressUntil.current) return;
        setPicked((p) => {
          if (!p) return p;
          const s = window.getSelection();
          if (!s || s.rangeCount === 0 || s.isCollapsed) return null;
          return { ...p, rect: rangeRect(s.getRangeAt(0)) };
        });
      });
    };

    /**
     * 兜底：某些浏览器（尤其 iOS 长按选词后）压根不发 pointerup/touchend，
     * 全靠 selectionchange。它在拖动过程中狂触发，所以等它安静下来 400ms 再采集。
     */
    let selTimer = 0;
    const onSelChange = () => {
      window.clearTimeout(selTimer);
      selTimer = window.setTimeout(pick, 400);
    };

    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('pointerup', onPointerUp);
    document.addEventListener('touchend', onTouchEnd);
    document.addEventListener('keyup', onKeyUp);
    document.addEventListener('selectionchange', onSelChange);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('pointerup', onPointerUp);
      document.removeEventListener('touchend', onTouchEnd);
      document.removeEventListener('keyup', onKeyUp);
      document.removeEventListener('selectionchange', onSelChange);
      window.removeEventListener('scroll', onScroll, true);
      window.clearTimeout(selTimer);
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [pick]);

  // 换文章时把工具条收掉，免得它指着上一篇文章的坐标
  useEffect(() => {
    setPicked(null);
  }, [state.activeRel]);

  const clearSelection = () => {
    window.getSelection()?.removeAllRanges();
    setPicked(null);
  };

  /**
   * 图片加载完 / 加载失败 → 正文被顶下去 → 需要按新位置更新的东西。
   *
   * ★ 这里只动浮动工具条的坐标，绝不再触发一次全篇重绘 ★
   * 早先这里是一个 imgTick state，被放进 ① 号重绘 effect 的依赖数组，于是每张图
   * load 一次就把整篇拆一遍 mark、重建一遍索引、重新上一次色。一篇引用 769 张图的
   * 文档 = 769 次全篇重建，每次上百万次对象分配 —— 这才是「打开文档卡死」的主因，
   * 而不是图片本身的下载。
   *
   * 而那次重建从原理上讲是多余的：<mark> 是行内元素，它裹着的文本节点在图片
   * 加载前后没有任何变化，浏览器重排时会连同高亮一起把文字挪到新位置。
   * 全篇唯一真正用「绝对坐标」的东西是 position:fixed 的选区工具条，所以只重算它。
   */
  const onImgSettle = () => {
    setPicked((p) => {
      // 工具条没开着就什么也不做：返回同一个引用，React 直接跳过这次重渲染
      if (!p) return p;
      const s = window.getSelection();
      if (!s || s.rangeCount === 0 || s.isCollapsed) return p;
      return { ...p, rect: rangeRect(s.getRangeAt(0)) };
    });
  };

  const quickHighlight = async (color: HighlightColor) => {
    const sel = picked?.selector;
    clearSelection();
    if (!sel) return;
    await actions.createHighlight({ selector: sel, color });
    actions.toast('ok', `已标为${labelOf(color)}色`);
  };

  const writeNote = () => {
    const sel = picked?.selector;
    const rect = picked?.rect;
    if (!sel || !rect) return;
    actions.setPending({ selector: sel, rect });
    setPicked(null);
  };

  const applyRebind = async () => {
    const sel = picked?.selector;
    clearSelection();
    if (!sel) return;
    await actions.rebindTo(sel);
  };

  return (
    <>
      <article
        className="article"
        ref={artRef}
        onClick={onArticleClick}
        // load / error 不冒泡，但**捕获**阶段能拿到，所以这里必须用 Capture 版本。
        //
        // 只用来给坏图补个占位样式、以及把浮动工具条挪到新坐标（见 onImgSettle）。
        // 不要在这里 bump 任何会进 ① 号重绘 effect 的状态：那等于每张图都全篇重建一次。
        onLoadCapture={(e) => {
          if ((e.target as HTMLElement).tagName === 'IMG') onImgSettle();
        }}
        onErrorCapture={(e) => {
          const el = e.target as HTMLElement;
          // 坏图：加 class 显示占位和 alt 文字，别留一个破图图标戳在那
          if (el.tagName === 'IMG') {
            el.classList.add('img-broken');
            onImgSettle();
          }
        }}
        // 服务端用 markdown-it（html:false）渲染，且已给每个块写好 data-bi。
        // 不在前端重新渲染：那会让「块序号」出现第二个真相源。
        dangerouslySetInnerHTML={{ __html: html }}
      />

      {picked ? (
        <SelectionToolbar
          picked={picked}
          rebinding={!!rebinding}
          onHold={holdToolbar}
          onHighlight={(c) => void quickHighlight(c)}
          onWriteNote={writeNote}
          onRebind={() => void applyRebind()}
          onCancel={() => {
            actions.startRebind(null);
            clearSelection();
          }}
          onDismiss={() => setPicked(null)}
        />
      ) : null}
    </>
  );
}

// ─────────────────────────── 浮动工具条 ───────────────────────────

function SelectionToolbar({
  picked,
  rebinding,
  onHold,
  onHighlight,
  onWriteNote,
  onRebind,
  onCancel,
  onDismiss,
}: {
  picked: Picked;
  rebinding: boolean;
  onHold: () => void;
  onHighlight: (c: HighlightColor) => void;
  onWriteNote: () => void;
  onRebind: () => void;
  onCancel: () => void;
  onDismiss: () => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  // 窄屏（手机/竖屏平板）：不飘在选区上方，改成吸在底部。
  // 飘着有两个硬伤——选区贴着屏幕顶/底时会算到屏幕外；iOS 长按弹出的原生
  // 「拷贝/查询」菜单正好压在同一片区域，按钮根本点不到。
  const [docked, setDocked] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 859px)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 859px)');
    const on = (e: MediaQueryListEvent) => setDocked(e.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  // 工具条宽度取决于内容（跨块提示那句话比色板宽得多），所以先渲染再量、量完再摆。
  // 量的时候它是 visibility:hidden，不会闪。
  useLayoutEffect(() => {
    if (docked) return;
    const el = boxRef.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const r = picked.rect;
    let left = r.x + r.width / 2 - w / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    // 默认飘在选区上方；顶部放不下（选区贴着屏幕顶）就翻到下方
    let top = r.y - h - 10;
    if (top < 8) top = r.bottom + 10;
    setPos({ left, top });
  }, [picked, docked]);

  /**
   * 按下就盖住「自动采集」的时间窗：不盖的话，手指/鼠标一按下浏览器先清选区，
   * 于是 selectionchange 兜底在按钮的 click 到达之前就把工具条卸载了 ——
   * 「点了没反应」。清选区这事拦不住（在触摸端拦默认行为会连 click 一起拦掉），
   * 那就让采集在窗口内保持安静，动作仍用已经存下来的 selector 执行。
   * 桌面的 mousedown 照旧 preventDefault，行为与改动前一致。
   */
  const onPointerDown = () => onHold();
  const onMouseDown = (e: ReactMouseEvent) => {
    onHold();
    e.preventDefault();
  };

  return (
    <div
      ref={boxRef}
      className={docked ? 'sel-toolbar dock' : 'sel-toolbar'}
      style={
        docked
          ? undefined
          : { left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }
      }
      onPointerDown={onPointerDown}
      onMouseDown={onMouseDown}
    >
      {picked.crossBlock ? (
        <>
          <span className="sel-hint">批注只能标在同一段文字里，请重新选一段</span>
          <button className="btn sm" onClick={onDismiss}>
            知道了
          </button>
        </>
      ) : rebinding ? (
        <>
          <Anchor width={14} height={14} />
          <span className="sel-hint">把这条批注绑到这段文字上？</span>
          <button className="btn sm primary" onClick={onRebind}>
            就绑到这段
          </button>
          <button className="btn sm" onClick={onCancel}>
            取消
          </button>
        </>
      ) : (
        <>
          {COLORS.map((c) => (
            <button
              key={c.key}
              className="swatch"
              title={`标为${c.label}色`}
              aria-label={`标为${c.label}色`}
              style={{ background: c.hex }}
              onClick={() => onHighlight(c.key)}
            />
          ))}
          <span className="sep" />
          <button
            className={docked ? 'btn sm primary' : 'btn sm'}
            onClick={onWriteNote}
            title="写一段批注绑在这段文字上"
          >
            <NoteIcon width={12} height={12} /> 写批注
          </button>
        </>
      )}
    </div>
  );
}

// ─────────────────────────── 章节导航 ───────────────────────────

/**
 * 正文顶部的吸顶章节条。
 *
 * 为什么不做成右侧的悬浮大纲：右栏已经是批注面板了，再往正文边上塞一列窄条，
 * 在 1200px 宽的窗口里正文会被挤到 600px 以下，读起来很难受。
 * 一条 30px 高的吸顶条解决「我在哪一节」和「跳到哪一节」两个问题，
 * 代价几乎为零。
 */
export function ChapterBar() {
  const { state } = useApp();
  const doc = state.doc;
  const [open, setOpen] = useState(false);
  const [cur, setCur] = useState(-1);
  const chapters = doc?.analysis.chapters ?? [];

  useEffect(() => {
    if (!chapters.length) {
      setCur(-1);
      return;
    }
    let raf = 0;

    // 章节元素缓存。文章不换，这些元素就不会变，没必要每帧 querySelector 一遍：
    // 每个 querySelector 都要把正文（上万节点）扫一遍，而滚动时这是「章节数 × 每帧」，
    // 光这一项就够把滚动拖垮。
    let cached: (HTMLElement | null)[] | null = null;
    const elAt = (i: number): HTMLElement | null => {
      if (!cached) cached = new Array(chapters.length).fill(null);
      const el = cached[i];
      if (el && el.isConnected) return el;
      // 命不中（首次、或正文被重渲染过）才真的查一次
      cached[i] = document.querySelector<HTMLElement>(`.article [data-bi="${chapters[i].bi}"]`);
      return cached[i];
    };

    const update = () => {
      raf = 0;
      // 找「最后一个已经滚过吸顶线」的标题。比遍历一遍所有元素算 intersection 简单得多，
      // 而且对「正文被外部改过、某个标题元素不存在」也天然容错。
      let hit = -1;
      for (let i = 0; i < chapters.length; i++) {
        const el = elAt(i);
        if (!el) continue;
        if (el.getBoundingClientRect().top <= 104) hit = i;
        else break;
      }
      setCur(hit);
    };
    const onScroll = () => {
      if (!raf) raf = window.requestAnimationFrame(update);
    };
    update();
    const scroller = document.querySelector('.article-scroll');
    scroller?.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      scroller?.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [chapters, doc?.path]);

  useEffect(() => setOpen(false), [doc?.path]);

  if (!chapters.length) return null;
  const current = cur >= 0 ? chapters[cur] : null;

  return (
    <div className="chapter-bar">
      <button className="chapter-cur" onClick={() => setOpen((v) => !v)} title="跳到某一节">
        <span className="chapter-lv">{current ? `H${current.level}` : '·'}</span>
        <span className="chapter-name">{current ? current.text : '（文章开头）'}</span>
        <ChevronRight width={12} height={12} className={`chapter-caret${open ? ' open' : ''}`} />
      </button>
      <span style={{ flex: 1 }} />
      <span className="chapter-progress">
        {cur + 1 > 0 ? cur + 1 : 0}/{chapters.length}
      </span>

      {open ? (
        <>
          <div className="chapter-scrim" onClick={() => setOpen(false)} />
          <div className="chapter-menu">
            {chapters.map((c, i) => (
              <button
                key={c.headingId}
                className={`chapter-item${i === cur ? ' on' : ''}`}
                style={{ paddingLeft: 10 + (c.level - 1) * 14 }}
                onClick={() => {
                  setOpen(false);
                  const el = document.querySelector<HTMLElement>(`.article [data-bi="${c.bi}"]`);
                  if (!el) return;
                  el.scrollIntoView({ block: 'start', behavior: 'smooth' });
                  el.classList.remove('nb-flash');
                  void el.offsetWidth;
                  el.classList.add('nb-flash');
                  window.setTimeout(() => el.classList.remove('nb-flash'), 1100);
                }}
              >
                <span className="chapter-lv">H{c.level}</span>
                <span className="chapter-name">{c.text}</span>
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
