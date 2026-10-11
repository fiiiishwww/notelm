/**
 * src/lib/dom.ts —— 正文 DOM 的定位工具。
 *
 * 这里只做一件事：把「块号 bi / 高亮 id」翻译成正文里那个 DOM 元素，并把它滚到视野中。
 *
 * 为什么不在这里做「归一化偏移 → TextNode 偏移」的换算？
 * 因为那是高亮叠加层的活，需要先把整篇正文的文本节点扫一遍建索引（见
 * src/hooks/buildBlockMap.ts）。批注面板只需要「跳到这段文字」，不需要自己算偏移，
 * 把两件事混在一起会让这个模块同时依赖 DOM 和块模型，反而更难维护。
 * 于是这里的做法是：问叠加层「这处高亮画出来了吗」，画好了就用它，
 * 没画好才退回块级定位。
 *
 * 注意：块元素带 data-bi 属性，这个属性是服务端渲染时由 markdown-it token 带上来的
 * （shared/blocks.ts 的 annotateBlocks）。**不要**试图用块序号去数 DOM 子节点来
 * 猜位置——正文里有 h1、ul、blockquote 这些不产出块的容器，数出来的序号一定是错的。
 */

/** 正文根元素（渲染后的 article）。 */
export function articleEl(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.article');
}

/** 按块号取正文里的对应元素；块号无效或元素不存在时返回 null。 */
export function blockEl(bi: number): HTMLElement | null {
  if (!Number.isFinite(bi) || bi < 0) return null;
  return document.querySelector<HTMLElement>(`.article [data-bi="${bi}"]`);
}

/** 让某个块闪一下（用于「点了批注之后确认到底跳到了哪」）。 */
export function flash(el: HTMLElement, ms = 1100): void {
  el.classList.remove('nb-flash');
  // 读一次 offsetWidth 强制重排：连续两次点同一条批注时，如果 class 还没被移除，
  // 浏览器不会重新播放动画，用户会以为「点了没反应」。
  void el.offsetWidth;
  el.classList.add('nb-flash');
  window.setTimeout(() => el.classList.remove('nb-flash'), ms);
}

/**
 * 把某个块滚到视野中央并闪一下。
 * @returns 找到的元素；找不到时返回 null（调用方据此提示用户「位置没了」）
 */
export function scrollToBlock(bi: number, opts: { smooth?: boolean } = {}): HTMLElement | null {
  const el = blockEl(bi);
  if (!el) return null;
  el.scrollIntoView({ block: 'center', behavior: opts.smooth === false ? 'auto' : 'smooth' });
  flash(el);
  return el;
}

/** 把 id 安全地放进带引号的属性选择器里（id 由 makeId 生成，理论上不含引号，仍然转义）。 */
function attrValue(v: string): string {
  return v.replace(/["\\]/g, '\\$&');
}

/**
 * 找某一处高亮已经画出来的 <mark>。
 * 一处高亮跨行内元素时会被叠加层拆成多个 mark，这里返回文档顺序的第一个——
 * 也就是「这处高亮从哪儿开始」，正是跳转时该对齐的那个。
 */
export function markOf(hlId: string): HTMLElement | null {
  if (!hlId) return null;
  return document.querySelector<HTMLElement>(`.article mark.hl[data-hl-ids~="${attrValue(hlId)}"]`);
}

/**
 * 「从右栏跳到正文」的一步到位定位。
 *
 * 优先把高亮本身滚到视野中央，而不是它所在的块。理由很实际：块级滚动只会落在段首，
 * 一个八百字的段落里可能有五处批注，只滚到段首等于没跳——用户还得自己在整段里找。
 *
 * 高亮还没有画出来时（刚打开文章、索引还没建，或者这条已经失效画不出来）
 * 退回块级滚动，至少让用户看到「大概在这一段」。
 */
export function scrollToAnnotation(bi: number, hlId?: string | null): HTMLElement | null {
  const mark = hlId ? markOf(hlId) : null;
  if (mark) {
    // 中心对齐：高亮在段尾时，块首对齐会让它落在视口外
    mark.scrollIntoView({ block: 'center', behavior: 'smooth' });
    flash(mark, 1200);
    return mark;
  }
  return scrollToBlock(bi);
}

/**
 * 等正文里第 bi 块真的出现在 DOM 里，再滚过去并闪一下。
 *
 * 为什么必须「等」：跨文档跳转时 openDoc 要先发请求拿 HTML，
 * 调用方此刻去 querySelector 只能拿到 null。以前的做法是「等两帧」，
 * 同文档时碰巧够用，跨文档时必然落空——用户看到的就是「换了文章但没高亮」。
 * 这里改成轮询到元素出现为止（最多 2 秒），一出现就滚动 + 高亮。
 *
 * @returns 是否成功定位；false 表示这一段没找到（文章可能已被改动）
 */
export function revealBlockWhenReady(bi: number, timeoutMs = 2000): Promise<boolean> {
  const deadline = performance.now() + Math.max(0, timeoutMs);
  return new Promise((resolve) => {
    const step = () => {
      if (blockEl(bi)) {
        scrollToBlock(bi);
        resolve(true);
        return;
      }
      if (performance.now() >= deadline) {
        resolve(false);
        return;
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

/** 按 headingId 找标题块（headingId 只存在于分析结果里，DOM 上并没有它）。 */
export function biOfHeading(
  blocks: { bi: number; headingId?: string }[],
  headingId: string,
): number | null {
  const b = blocks.find((x) => x.headingId === headingId);
  return b ? b.bi : null;
}
