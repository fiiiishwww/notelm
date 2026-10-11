/**
 * server/services/anchor.ts —— 五步降级锚点解析。
 *
 * ★ 本项目的可靠性红线 ★
 * 当所有证据都不足时，宁可把批注标成「锚点失效」，也**绝不猜一个位置**。
 * 高亮画到错误的句子上，比高亮消失严重得多——它会让人记错东西。
 *
 * 五步降级（命中即返回）：
 *   S1 块内精确      block.text.slice(offset, offset+len) === quote
 *   S2 块内唯一搜索  同一块内 quote 只出现一次（说明是块内偏移漂移了）
 *   S3 全局搜索      在全文找所有 quote 的出现位置，用 prefix/suffix 双向 bigram
 *                    Dice 打分为每个候选消歧，≥0.85 采纳；0.60~0.85 采纳但提示需要确认
 *   S4 模糊匹配      在旧块 ±3 块范围内用模糊子串搜索（用户把那句话改了但还认得出来）
 *   S5 兜底          标 orphan，保留原始 selector，让用户手动重新绑定
 */

import {
  type Block,
  type Highlight,
  type Note,
  type Sidecar,
  type TextQuoteSelector,
  bestFuzzySubstring,
  dice,
} from '../../shared/text';

export type AnchorStatus = 'ok' | 'repaired' | 'orphan';

export interface ResolvedAnchor {
  status: AnchorStatus;
  reason: string;
  score: number;
  blockIndex: number;
  startInBlock: number;
  endInBlock: number;
  quote: string;
  prefix: string;
  suffix: string;
  /** selector 的字段是否变了（变了就要写回 sidecar） */
  changed: boolean;
  /** 是否建议用户确认一下（S3 低分命中） */
  needConfirm: boolean;
}

const CTX = 40; // 上下文窗口长度
const S3_ACCEPT = 0.85;
const S3_WEAK = 0.6;
const S4_ACCEPT = 0.8;
const MAX_CANDIDATES = 200;

/** 从 context 与候选位置周围的真实文本算一个 0~1 的匹配分。 */
function contextScore(text: string, index: number, len: number, prefix: string, suffix: string): number {
  const pre = text.slice(Math.max(0, index - CTX), index);
  const post = text.slice(index + len, index + len + CTX);
  const sp = prefix.slice(-CTX);
  const ss = suffix.slice(0, CTX);
  const parts: number[] = [];
  if (sp) parts.push(dice(pre, sp));
  if (ss) parts.push(dice(post, ss));
  if (parts.length === 0) return 0;
  return parts.reduce((a, b) => a + b, 0) / parts.length;
}

function orphan(reason: string, sel: TextQuoteSelector): ResolvedAnchor {
  return {
    status: 'orphan',
    reason,
    score: 0,
    blockIndex: sel.blockIndex,
    startInBlock: sel.textOffset,
    endInBlock: sel.textOffset + (sel.quoteLength || sel.quote.length || 0),
    quote: sel.quote,
    prefix: sel.prefix,
    suffix: sel.suffix,
    changed: false,
    needConfirm: false,
  };
}

/**
 * 解析单条 selector。
 * @param normalize 归一化函数（默认用共享的 normalizeText，测试时可注入）
 */
export function resolveSelector(
  sel: TextQuoteSelector,
  blocks: Block[],
  normalize: (s: string) => string = (s) => s.replace(/\s+/g, ' ').trim(),
): ResolvedAnchor {
  const quote = normalize(sel.quote ?? '');
  if (!quote) return orphan('空引用', sel);
  const len = quote.length;
  const bi = sel.blockIndex;
  const offset = sel.textOffset;

  // ── S1：块内精确命中（最常见、最便宜）
  const b = blocks[bi];
  if (b && offset >= 0 && offset + len <= b.text.length && b.text.slice(offset, offset + len) === quote) {
    return {
      status: 'ok',
      reason: 'S1-exact',
      score: 1,
      blockIndex: bi,
      startInBlock: offset,
      endInBlock: offset + len,
      quote,
      prefix: sel.prefix,
      suffix: sel.suffix,
      changed: false,
      needConfirm: false,
    };
  }

  // ── S2：同一块内只出现一次 → 只是块内偏移漂了
  if (b) {
    const first = b.text.indexOf(quote);
    if (first >= 0 && b.text.indexOf(quote, first + 1) === -1) {
      return {
        status: 'ok',
        reason: 'S2-block-search',
        score: 1,
        blockIndex: bi,
        startInBlock: first,
        endInBlock: first + len,
        quote,
        prefix: b.text.slice(Math.max(0, first - CTX), first),
        suffix: b.text.slice(first + len, first + len + CTX),
        changed: true,
        needConfirm: false,
      };
    }
  }

  // ── S3：全文搜索 + 上下文双向打分消歧
  // 太短的 quote（<4 字）在长文里会命中几十上百次，用上下文也压不住，跳过
  if (len >= 4) {
    const candidates: { bi: number; index: number }[] = [];
    for (const blk of blocks) {
      let idx = blk.text.indexOf(quote);
      while (idx >= 0) {
        candidates.push({ bi: blk.bi, index: idx });
        if (candidates.length >= MAX_CANDIDATES) break;
        idx = blk.text.indexOf(quote, idx + 1);
      }
      if (candidates.length >= MAX_CANDIDATES) break;
    }

    if (candidates.length > 0) {
      const scored = candidates
        .filter((c) => !(c.bi === bi && c.index === offset))
        .map((c) => ({ ...c, score: contextScore(blocks[c.bi].text, c.index, len, sel.prefix, sel.suffix) }))
        .sort((a, z) => z.score - a.score);

      const best = scored[0];
      const second = scored[1];
      if (best) {
        // 两个候选分数太接近 = 无法消歧，不敢猜，交给 S4 / orphan
        const unambiguous = !second || best.score - second.score >= 0.03;
        if (best.score >= S3_ACCEPT && unambiguous) {
          return {
            status: 'repaired',
            reason: 'S3-context-match',
            score: best.score,
            blockIndex: best.bi,
            startInBlock: best.index,
            endInBlock: best.index + len,
            quote,
            prefix: blocks[best.bi].text.slice(Math.max(0, best.index - CTX), best.index),
            suffix: blocks[best.bi].text.slice(best.index + len, best.index + len + CTX),
            changed: true,
            needConfirm: false,
          };
        }
        if (best.score >= S3_WEAK && unambiguous) {
          return {
            status: 'repaired',
            reason: 'S3-weak-match',
            score: best.score,
            blockIndex: best.bi,
            startInBlock: best.index,
            endInBlock: best.index + len,
            quote,
            prefix: blocks[best.bi].text.slice(Math.max(0, best.index - CTX), best.index),
            suffix: blocks[best.bi].text.slice(best.index + len, best.index + len + CTX),
            changed: true,
            needConfirm: true,
          };
        }
      }
    }
  }

  // ── S4：旧位置附近做模糊匹配（用户把那句话改写了）
  const lo = Math.max(0, bi - 3);
  const hi = Math.min(blocks.length - 1, bi + 3);
  let best: { bi: number; index: number; length: number; score: number } | null = null;
  for (let i = lo; i <= hi; i++) {
    const blk = blocks[i];
    if (!blk || !blk.text) continue;
    const r = bestFuzzySubstring(blk.text, quote);
    if (r && (!best || r.score > best.score)) {
      best = { bi: i, index: r.index, length: r.length, score: r.score };
    }
  }
  if (best && best.score >= S4_ACCEPT) {
    const blk = blocks[best.bi];
    const newQuote = blk.text.slice(best.index, best.index + best.length);
    return {
      status: 'repaired',
      reason: 'S4-fuzzy-quote',
      score: best.score,
      blockIndex: best.bi,
      startInBlock: best.index,
      endInBlock: best.index + best.length,
      quote: newQuote,
      prefix: blk.text.slice(Math.max(0, best.index - CTX), best.index),
      suffix: blk.text.slice(best.index + best.length, best.index + best.length + CTX),
      changed: true,
      needConfirm: true,
    };
  }

  return orphan('所有匹配策略均未达到置信阈值', sel);
}

/** 把解析结果写回 selector。 */
export function applyResolved(sel: TextQuoteSelector, r: ResolvedAnchor, headingId?: string): void {
  if (r.status === 'orphan') return; // orphan 保留原 selector，用户手动重绑时再改
  sel.blockIndex = r.blockIndex;
  sel.textOffset = r.startInBlock;
  sel.quote = r.quote;
  sel.quoteLength = r.quote.length;
  sel.prefix = r.prefix;
  sel.suffix = r.suffix;
  if (headingId) sel.headingId = headingId;
}

// ─────────────────────── 批量 reanchor ───────────────────────

export interface AnchorDetail {
  id: string;
  kind: 'note' | 'highlight';
  status: AnchorStatus;
  reason: string;
  score: number;
  needConfirm: boolean;
  from: { blockIndex: number; textOffset: number };
  to: { blockIndex: number; textOffset: number };
  preview: string;
}

export interface AnchorReport {
  ok: number;
  repaired: number;
  orphan: number;
  /** 因为超出时间预算而没能处理完的（保持原状） */
  skipped: number;
  tookMs: number;
  details: AnchorDetail[];
}

/** 找出块所属的章节 headingId。 */
function headingOf(blocks: Block[], bi: number): string | undefined {
  for (let i = Math.min(bi, blocks.length - 1); i >= 0; i--) {
    const h = blocks[i]?.headingId;
    if (h) return h;
  }
  return undefined;
}

/**
 * 对一个 sidecar 里的全部批注与高亮跑一遍解析，并**就地修改** sidecar。
 *
 * 两个阶段：
 *   阶段一 对全部条目跑 S1/S2（极便宜），成功即定案；
 *   阶段二 只对阶段一失败的那些跑 S3/S4，受时间预算约束。
 * 预算耗尽后剩下的条目**保持原状**（不标 orphan），避免因为超时误伤正常锚点。
 */
export function reanchorSidecar(sidecar: Sidecar, blocks: Block[], budgetMs = 1500): AnchorReport {
  const t0 = Date.now();
  const details: AnchorDetail[] = [];
  let ok = 0;
  let repaired = 0;
  let orphan = 0;
  let skipped = 0;

  interface Pending {
    kind: 'note' | 'highlight';
    id: string;
    sel: TextQuoteSelector;
    entity: Note | Highlight;
  }

  const pending: Pending[] = [];
  for (const h of sidecar.highlights) pending.push({ kind: 'highlight', id: h.id, sel: h.selector, entity: h });
  for (const n of sidecar.notes) pending.push({ kind: 'note', id: n.id, sel: n.selector, entity: n });

  // 阶段一：S1 / S2
  const stage2: Pending[] = [];
  for (const p of pending) {
    const before = { blockIndex: p.sel.blockIndex, textOffset: p.sel.textOffset };
    // 只跑前两步：把 quote 临时缩到空以跳过 S3/S4 不现实，这里用一个轻量判断
    const quick = tryQuick(p.sel, blocks);
    if (quick) {
      applyResolved(p.sel, quick, headingOf(blocks, quick.blockIndex));
      p.entity.anchorState = quick.status;
      if (quick.status === 'repaired') repaired++;
      else ok++;
      details.push({
        id: p.id,
        kind: p.kind,
        status: quick.status,
        reason: quick.reason,
        score: quick.score,
        needConfirm: quick.needConfirm,
        from: before,
        to: { blockIndex: quick.blockIndex, textOffset: quick.startInBlock },
        preview: blocks[quick.blockIndex]?.text.slice(quick.startInBlock, quick.endInBlock) ?? '',
      });
      if (quick.status === 'repaired') {
        pushHistory(p.entity, quick.reason, before, {
          blockIndex: quick.blockIndex,
          textOffset: quick.startInBlock,
        });
      }
    } else {
      stage2.push(p);
    }
  }

  // 阶段二：S3 / S4，带时间预算
  for (const p of stage2) {
    if (Date.now() - t0 > budgetMs) {
      skipped++;
      continue;
    }
    const before = { blockIndex: p.sel.blockIndex, textOffset: p.sel.textOffset };
    const r = resolveSelector(p.sel, blocks);
    applyResolved(p.sel, r, headingOf(blocks, r.blockIndex));
    p.entity.anchorState = r.status;
    if (r.status === 'orphan') orphan++;
    else if (r.status === 'repaired') repaired++;
    else ok++;
    details.push({
      id: p.id,
      kind: p.kind,
      status: r.status,
      reason: r.reason,
      score: r.score,
      needConfirm: r.needConfirm,
      from: before,
      to: { blockIndex: r.blockIndex, textOffset: r.startInBlock },
      preview: r.status === 'orphan' ? p.sel.quote : blocks[r.blockIndex]?.text.slice(r.startInBlock, r.endInBlock) ?? '',
    });
    if (r.status === 'repaired') {
      pushHistory(p.entity, r.reason, before, { blockIndex: r.blockIndex, textOffset: r.startInBlock });
    }
  }

  return { ok, repaired, orphan, skipped, tookMs: Date.now() - t0, details };
}

/** 只跑 S1/S2 的快路径，命中返回结果，未命中返回 null。 */
function tryQuick(sel: TextQuoteSelector, blocks: Block[]): ResolvedAnchor | null {
  const quote = sel.quote ?? '';
  if (!quote) return null;
  const len = quote.length;
  const bi = sel.blockIndex;
  const offset = sel.textOffset;
  const b = blocks[bi];
  if (!b) return null;

  if (offset >= 0 && offset + len <= b.text.length && b.text.slice(offset, offset + len) === quote) {
    return {
      status: 'ok',
      reason: 'S1-exact',
      score: 1,
      blockIndex: bi,
      startInBlock: offset,
      endInBlock: offset + len,
      quote,
      prefix: sel.prefix,
      suffix: sel.suffix,
      changed: false,
      needConfirm: false,
    };
  }
  const first = b.text.indexOf(quote);
  if (first >= 0 && b.text.indexOf(quote, first + 1) === -1) {
    return {
      status: 'ok',
      reason: 'S2-block-search',
      score: 1,
      blockIndex: bi,
      startInBlock: first,
      endInBlock: first + len,
      quote,
      prefix: b.text.slice(Math.max(0, first - 40), first),
      suffix: b.text.slice(first + len, first + len + 40),
      changed: true,
      needConfirm: false,
    };
  }
  return null;
}

function pushHistory(
  entity: Note | Highlight,
  reason: string,
  from: { blockIndex: number; textOffset: number },
  to: { blockIndex: number; textOffset: number },
): void {
  if (!('repairHistory' in entity)) return; // 高亮不记录历史，批注才记
  const note = entity as Note;
  if (!Array.isArray(note.repairHistory)) note.repairHistory = [];
  note.repairHistory.push({ at: new Date().toISOString(), reason, from, to });
  // 只保留最近 20 条，避免无限增长
  if (note.repairHistory.length > 20) note.repairHistory.splice(0, note.repairHistory.length - 20);
}

/**
 * 校验一段 AI 给出的引用是否真的存在于正文里。
 * 幻觉引用必须被丢弃，不能污染锚点体系。
 */
export function validateQuote(quote: string, blocks: Block[]): { blockIndex: number; index: number } | null {
  const q = (quote ?? '').trim();
  if (q.length < 2) return null;
  for (const blk of blocks) {
    const idx = blk.text.indexOf(q);
    if (idx >= 0) return { blockIndex: blk.bi, index: idx };
  }
  // 退一步：允许 AI 在引用里加了省略号，取前 12 个字再试
  const head = q.slice(0, 12);
  if (head.length >= 4) {
    for (const blk of blocks) {
      const idx = blk.text.indexOf(head);
      if (idx >= 0) return { blockIndex: blk.bi, index: idx };
    }
  }
  return null;
}
