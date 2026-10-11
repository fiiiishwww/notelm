/**
 * src/lib/colors.ts —— 高亮配色的唯一定义处。
 *
 * 这些色值同时在三个地方被用到：正文里的 .hl-* 背景（写在 theme.css）、
 * 批注面板的颜色圆点、正文选区浮动工具条上的色板。
 * 三处各自抄一份色值，迟早会出现「面板里的黄」和「正文里的黄」不是同一个黄，
 * 所以集中放在这里，theme.css 里的注释也指向本文件。
 * ★ 改色值必须同步 theme.css 的 .hl-* 与 .dot-*，否则三处又对不上。
 * 2026-09-17 换成浓彩糖果档（更饱和），colors.ts / .hl-* / .dot-* 已三处同步。
 */

import type { HighlightColor } from '../../shared/text';

export const COLORS: { key: HighlightColor; hex: string; label: string }[] = [
  { key: 'yellow', hex: '#ffd93d', label: '黄' },
  { key: 'green', hex: '#8ce0ac', label: '绿' },
  { key: 'blue', hex: '#93c5fd', label: '蓝' },
  { key: 'pink', hex: '#ffa6cd', label: '粉' },
  { key: 'purple', hex: '#cbb2ff', label: '紫' },
];

export function hexOf(c: HighlightColor): string {
  return COLORS.find((x) => x.key === c)?.hex ?? COLORS[0].hex;
}

/** 按颜色键取中文名，用于气泡提示。 */
export function labelOf(c: HighlightColor): string {
  return COLORS.find((x) => x.key === c)?.label ?? '黄';
}
