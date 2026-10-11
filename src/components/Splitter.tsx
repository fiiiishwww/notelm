/**
 * src/components/Splitter.tsx —— 手写的可拖拽分隔条。
 *
 * 为什么不用 react-resizable-panels 之类的库：
 *   需求只有「拖一条线改变左右面板宽度」，用 Pointer Events 三十行就能写完，
 *   而且能顺手做两件库不一定给的事：
 *     1. 双击恢复默认宽度；
 *     2. 拖拽期间给拖拽元素自己加 .dragging（方便做悬停高亮），
 *        并锁住 body 的 user-select —— 否则快速拖动时会选中正文文字，
 *        松手后留下一片蓝色的选区，看起来像 bug。
 *
 * 用 setPointerCapture 而不是监听 window 的 mousemove：
 *   指针移出元素甚至移出窗口时，事件仍然会送到这个元素，不会丢拖拽。
 */

import { useRef, useState } from 'react';

interface SplitterProps {
  /** 分隔条在面板的哪一侧：left 表示「它右边是分隔对象」，用于决定拖动方向 */
  side: 'left' | 'right';
  width: number;
  min: number;
  max: number;
  defaultWidth: number;
  /** 拖动过程中持续回调 */
  onChange: (width: number) => void;
  /** 松手时回调一次（用来持久化） */
  onCommit?: (width: number) => void;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function Splitter({ side, width, min, max, defaultWidth, onChange, onCommit }: SplitterProps) {
  const start = useRef<{ x: number; w: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // 只响应主键；右键拖拽分隔条是没有意义的
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { x: e.clientX, w: width };
    setDragging(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    const dx = e.clientX - start.current.x;
    // 左边的面板：往右拖变宽；右边的面板：往左拖变宽，所以符号相反
    const next = clamp(side === 'left' ? start.current.w + dx : start.current.w - dx, min, max);
    onChange(next);
  };

  const finish = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    start.current = null;
    setDragging(false);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    onCommit?.(width);
  };

  return (
    <div
      className={`splitter${dragging ? ' dragging' : ''}`}
      role="separator"
      aria-orientation="vertical"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      onDoubleClick={() => {
        onChange(defaultWidth);
        onCommit?.(defaultWidth);
      }}
      title="拖动调整宽度，双击恢复默认"
    />
  );
}
