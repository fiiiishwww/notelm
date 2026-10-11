/**
 * src/lib/themeColor.ts —— 把用户在设置里挑的主色落到 CSS 变量上。
 *
 * 设计决策：**只让用户挑一个 hex**。--accent-hover / --accent-soft /
 * --accent-border / 夜色版这四个派生值都由代码算出来 ——
 * 让用户手动调五个变量等于让他们做配色师，几乎必然配崩。
 *
 * 落地方式：往 <head> 追加一个 <style id="nb-theme-color">。它天然排在
 * theme.css 之后，同特异性下后者赢，所以能覆盖样式表默认值；
 * 清空 textContent 就回到默认，不需要重启或改样式表。
 * 浅色和夜色各写一条规则（夜色 = 主色提亮一档，深底上才跳得出来），
 * 深浅切换时两条规则都在，html[data-theme] 自己选。
 */

export const DEFAULT_THEME_COLOR = '#35c47f';

type RGB = [number, number, number];

function parse(hex: string): RGB {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex(rgb: RGB): string {
  return '#' + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}

function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** t<0 向黑靠（变深），t>0 向白靠（变亮） */
function shift(rgb: RGB, t: number): RGB {
  return t < 0 ? mix(rgb, [0, 0, 0], -t) : mix(rgb, [255, 255, 255], t);
}

/** 主色上的白字对比度够不够（< 3:1 说明主按钮文字会看不清） */
export function contrastOnWhite(hex: string): number {
  const f = parse(hex).map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }) as RGB;
  const lum = 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2];
  return 1.05 / (lum + 0.05);
}

export function isHexColor(s: string | undefined | null): boolean {
  return typeof s === 'string' && /^#[0-9a-fA-F]{6}$/.test(s);
}

/** 生成覆盖用的 CSS 文本（浅色 :root + 夜色 html[data-theme='dark'] 两段） */
export function themeColorCss(hex: string): string {
  if (!isHexColor(hex)) return '';
  const rgb = parse(hex);
  const dark = shift(rgb, 0.16);
  return `
:root {
  --accent: ${toHex(rgb)};
  --accent-hover: ${toHex(shift(rgb, -0.14))};
  --accent-soft: rgba(${rgb.map((v) => Math.round(v)).join(', ')}, 0.15);
  --accent-border: rgba(${rgb.map((v) => Math.round(v)).join(', ')}, 0.42);
  /* c1 = 五色轮转的第一色，必须跟主色同色 */
  --c1: ${toHex(rgb)};
}

html[data-theme='dark'] {
  --accent: ${toHex(dark)};
  --accent-hover: ${toHex(shift(dark, 0.12))};
  --accent-soft: rgba(${dark.map((v) => Math.round(v)).join(', ')}, 0.2);
  --accent-border: rgba(${dark.map((v) => Math.round(v)).join(', ')}, 0.45);
  --c1: ${toHex(dark)};
}`.trim();
}

/** 把主色写进页面；hex 非法时静默回落到默认（坏值不该让界面变黑） */
export function applyThemeColor(hex: string | undefined | null): void {
  if (typeof document === 'undefined') return;
  let el = document.getElementById('nb-theme-color') as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement('style');
    el.id = 'nb-theme-color';
    document.head.appendChild(el);
  }
  el.textContent = themeColorCss(hex ?? DEFAULT_THEME_COLOR);
}
