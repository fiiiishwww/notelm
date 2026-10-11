/**
 * server/services/hlSignal.ts —— 把「用户高亮」变成小抄管道的输入信号。
 *
 * ★ 为什么是独立的信号层，而不是把高亮写进 items ★
 *   高亮是用户资产（highlight 侧已经按 quote 锚定、可自愈），小抄是派生数据。
 *   生成时把高亮喂给模型当优先级信号，条目落盘时只留 bi —— 两边各自演进，
 *   重新生成小抄不会破坏高亮，删除高亮也不需要改小抄。
 *
 * ★ 高亮是权重，不是范围 ★
 *   用户没有高亮的地方照常采集（提示词里写明），判据层只做一件事：
 *   高亮块**必须被覆盖** —— 它是用户亲手划的重点，漏了就是缺陷，
 *   兜底手段是 V3 的补采窗口（见 cheatsheetV3.runCheatsheetV3）。
 *
 * ★ 覆盖记账不在这里 ★
 *   「哪些块被条目的引文盖住了」是通用质量判据（高亮覆盖只是它的一个用法），
 *   已经抽到 services/coverage.ts —— 生成时的覆盖率质量门和离线探针共用那一份，
 *   避免出现「探针说 60%、管道说 80%」。
 */

import { type Block, type Highlight, type HighlightColor } from '../../shared/text';
import { validateQuote } from './anchor';

export interface HlMap {
  /** 高亮落到的块号 → 高亮颜色。一个块被多种颜色高亮时，保留先解析到的那次。 */
  colorByBi: Map<number, HighlightColor>;
  /** 成功定位回正文的高亮条数 */
  resolved: number;
  /** 定位不到的高亮条数（正文改过、锚失效）——跳过，不参与任何逻辑 */
  unresolved: number;
}

/**
 * 把高亮列表解析成「块号 → 颜色」。
 *
 * 一个高亮可能跨多个块（用户划了一整段）：从定位到的起始块开始，
 * 按 quote 长度往后吃，吃满为止——这样跨块高亮的中间块也能拿到信号。
 */
export function mapHighlightsToBlocks(
  highlights: Highlight[] | undefined | null,
  blocks: Block[],
): HlMap {
  const colorByBi = new Map<number, HighlightColor>();
  let resolved = 0;
  let unresolved = 0;

  for (const hl of highlights ?? []) {
    const q = (hl?.selector?.quote ?? '').trim();
    if (q.length < 4) {
      unresolved++;
      continue;
    }
    const v = validateQuote(q, blocks);
    if (!v) {
      unresolved++;
      continue;
    }
    resolved++;
    colorByBi.set(v.blockIndex, hl.color);
    let remaining = q.length - (blocks[v.blockIndex]?.text.length ?? 0) + v.index;
    for (let i = blocks.findIndex((b) => b.bi === v.blockIndex) + 1; remaining > 0 && i < blocks.length; i++) {
      colorByBi.set(blocks[i].bi, hl.color);
      remaining -= blocks[i].text.length + 1;
    }
  }

  return { colorByBi, resolved, unresolved };
}
