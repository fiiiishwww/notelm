/**
 * scripts/split-probe.ts —— 大文档拆分的离线验证。
 *
 * 全程只在 冒烟测试/__split-probe/ 下操作，不碰用户的真实笔记。
 * 会自己造一批高亮 / 批注 / 卡片，切完再逐条验证它们有没有漂。
 *
 * 用法：npx tsx scripts/split-probe.ts
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { analyzeDocument } from '../../shared/blocks';
import { planSplit, scanHeadings } from '../../shared/split';
import { splitDocument } from '../../server/routes/doc';
import { requireVaultRoot } from '../../server/core';
import { emptySidecar, readSidecar, writeSidecar } from '../../server/services/sidecar';
import type { Highlight, Note, Card } from '../../shared/text';

const SRC = '测试/居丽叶LLM体系知识搭建.md';
const DIR = '冒烟测试/__split-probe';
const MAX_BLOCKS = 600;

let failures = 0;
function check(label: string, ok: boolean, extra = '') {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!ok) failures++;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

/** 把上一次跑留下的目录改名丢进回收站（本机 fs.rm 被安全删除 shim 接管，会失败）。 */
async function clearProbeDir(root: string) {
  const abs = path.join(root, DIR);
  if (!(await exists(abs))) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dst = path.join(root, '.notebook', 'trash', `split-probe-${stamp}`);
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  await fsp.rename(abs, dst);
}

async function main() {
  const root = await requireVaultRoot();
  console.log('vault root:', root);

  await clearProbeDir(root);
  await fsp.mkdir(path.join(root, DIR), { recursive: true });

  const copyRel = `${DIR}/原文.md`;
  const copyAbs = path.join(root, copyRel);
  await fsp.copyFile(path.join(root, SRC), copyAbs);

  const raw = await fsp.readFile(copyAbs, 'utf8');
  const analysis = analyzeDocument(raw);
  console.log(`\n原文：${analysis.blocks.length} 个块，${raw.length} 字符`);

  const hs = scanHeadings(raw);
  console.log(
    '标题（已排除代码块内的）：',
    [1, 2, 3, 4, 5, 6].map((l) => `h${l}=${hs.filter((h) => h.level === l).length}`).join(' '),
  );

  // ── 1. 规划 ──
  const plan = planSplit(raw, {
    totalBlocks: analysis.blocks.length,
    countBlocks: (t) => analyzeDocument(t).blocks.length,
    maxBlocks: MAX_BLOCKS,
  });
  console.log(`\n规划：needed=${plan.needed} level=h${plan.level} reason=${plan.reason} chunks=${plan.chunks.length}`);
  check('需要拆分', plan.needed === true);
  check('切分层级在 h1~h3 之间', plan.level >= 1 && plan.level <= 3);
  check('块总数守恒', plan.chunks.reduce((a, c) => a + c.blockCount, 0) === analysis.blocks.length);
  check('每个分片都不超阈值', plan.chunks.every((c) => c.blockCount <= MAX_BLOCKS),
    `最大 ${Math.max(...plan.chunks.map((c) => c.blockCount))} 块`);
  let acc = 0;
  check('startBi 连续无重叠', plan.chunks.every((c) => {
    const ok = c.startBi === acc;
    acc += c.blockCount;
    return ok;
  }));

  // ── 2. 造批注，分布在不同的分片里 ──
  const now = new Date().toISOString();
  const probeBis = [5, Math.floor(analysis.blocks.length / 3), analysis.blocks.length - 5];
  const highlights: Highlight[] = [];
  const notes: Note[] = [];
  probeBis.forEach((bi, i) => {
    const b = analysis.blocks[bi];
    const quote = b.text.slice(0, Math.min(24, b.text.length));
    if (!quote) return;
    const sel = {
      type: 'text-quote' as const,
      quote,
      prefix: '',
      suffix: b.text.slice(quote.length, quote.length + 20),
      blockIndex: bi,
      textOffset: 0,
      quoteLength: quote.length,
    };
    highlights.push({
      id: `hl-${i}`, selector: sel, noteId: i === 1 ? 'note-1' : null,
      color: 'yellow', anchorState: 'ok', createdAt: now, updatedAt: now,
    });
    if (i === 1) {
      notes.push({
        id: 'note-1', selector: { ...sel }, body: '这是一条测试批注', tags: [],
        color: 'yellow', anchorState: 'ok', repairHistory: [], createdAt: now, updatedAt: now,
      });
    }
  });
  const cards: Card[] = [
    {
      id: 'card-1', front: '正面', back: '背面',
      source: { type: 'note', refId: 'note-1', quote: '' },
      headingId: '', sm2: { ef: 2.5, interval: 0, repetitions: 0, lapses: 0, dueAt: '2026-01-01', lastReviewedAt: null },
      suspended: false, createdAt: now,
    },
  ];

  const sc = emptySidecar(copyRel);
  sc.highlights = highlights;
  sc.notes = notes;
  sc.cards = cards;
  await writeSidecar(copyRel, sc);
  console.log(`\n预埋：${highlights.length} 条高亮（bi=${probeBis.join(', ')}）、${notes.length} 条批注、${cards.length} 张卡片`);

  // ── 3. 真的切一次 ──
  const out = await splitDocument(copyRel, { maxBlocks: MAX_BLOCKS, removeOriginal: true });
  console.log(`\n执行：ok=${out.ok} message=${out.message}`);
  check('切分成功', out.ok === true);
  check('没有无处安放的批注', out.unplaced === 0, `unplaced=${out.unplaced}`);
  check('高亮全部迁移', out.migrated.highlights === highlights.length);
  check('批注全部迁移', out.migrated.notes === notes.length);
  check('卡片全部迁移', out.migrated.cards === cards.length);

  // ── 4. 校验落盘 ──
  let totalBlocks = 0;
  const texts: string[] = [];
  for (const c of out.chunks) {
    const text = await fsp.readFile(path.join(root, c.rel), 'utf8');
    texts.push(text);
    const a = analyzeDocument(text);
    totalBlocks += a.blocks.length;
    if (a.blocks.length !== c.blockCount) {
      check(`${path.basename(c.rel)} 块数与规划一致`, false, `${a.blocks.length} vs ${c.blockCount}`);
    }
  }
  check('分片块数之和守恒', totalBlocks === analysis.blocks.length, `${totalBlocks} vs ${analysis.blocks.length}`);
  check('分片拼接后与原文逐字符相同（零注入）', texts.join('\n') === raw);
  check('原文已移出', !(await exists(copyAbs)));

  // ── 5. 逐条验证批注没漂：在分片里重放 S1 判定 ──
  let anchorOk = 0;
  let anchorBad = 0;
  for (const c of out.chunks) {
    const sub = await readSidecar(c.rel);
    const a = analyzeDocument(await fsp.readFile(path.join(root, c.rel), 'utf8'));
    for (const hl of sub.highlights) {
      const b = a.blocks[hl.selector.blockIndex];
      const hit = b && b.text.slice(hl.selector.textOffset, hl.selector.textOffset + hl.selector.quoteLength) === hl.selector.quote;
      if (hit) anchorOk++;
      else {
        anchorBad++;
        console.log(`    漂移: ${hl.id} 在 ${path.basename(c.rel)} bi=${hl.selector.blockIndex} quote="${hl.selector.quote.slice(0, 16)}"`);
      }
    }
  }
  check('所有高亮在新分片里 S1 精确命中（一条都没漂）', anchorBad === 0, `${anchorOk} 条命中 / ${anchorBad} 条漂移`);

  console.log(`\n分片清单（共 ${out.chunks.length} 篇）：`);
  for (const c of out.chunks.slice(0, 6)) console.log(`  ${String(c.blockCount).padStart(4)} 块  ${path.basename(c.rel)}`);
  if (out.chunks.length > 6) console.log(`  …（还有 ${out.chunks.length - 6} 篇）`);

  console.log(`\n${failures === 0 ? '全部通过' : failures + ' 项失败'}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
