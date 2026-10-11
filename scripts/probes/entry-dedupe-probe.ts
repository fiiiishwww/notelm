/**
 * scripts/entry-dedupe-probe.ts —— 条目间去重会删掉什么？
 *
 * ★ 为什么先跑预览 ★
 *   去重是**删数据**。判据松一点就误删（公式骨架相同 dice 高达 0.90），
 *   紧一点就等于没做。所以先看清楚要删的是哪些，再决定要不要 --apply。
 *   这个探针不写任何文件。
 *
 * 用法：npx tsx scripts/entry-dedupe-probe.ts
 */

import { listAllSidecars } from '../../server/services/sidecar';
import { dedupeEntriesAgainstEntries } from '../../server/services/cheatsheet';
import { dice } from '../../shared/text';

async function main() {
  const all = await listAllSidecars();
  let total = 0;
  let dropped = 0;
  let merged = 0;
  const samples: string[] = [];
  let formulaDropped = 0;

  for (const { docRel, sidecar } of all) {
    for (const s of sidecar.cheatsheet?.sections ?? []) {
      const entries = s.items?.entries ?? [];
      if (entries.length < 2) continue;
      total += entries.length;
      const r = dedupeEntriesAgainstEntries(entries);
      dropped += r.dropped.length;
      merged += r.merged;
      for (const e of r.dropped) {
        const isFormula = e.kind === '等式' || e.kind === '数值';
        if (isFormula) formulaDropped++;
        if (samples.length < 25) {
          // 找出它和谁撞了，便于人工核对判据对不对
          let partner = '';
          let best = 0;
          for (const k of r.entries) {
            const d = dice(e.text, k.text);
            if (d > best) {
              best = d;
              partner = k.text;
            }
          }
          samples.push(
            `【${e.kind}】删：${e.text.slice(0, 60)}\n` +
              `     撞（dice ${best.toFixed(2)}）：${partner.slice(0, 60)}\n` +
              `     @ ${docRel} · ${s.headingText}`,
          );
        }
      }
    }
  }

  console.log(samples.join('\n'));
  console.log('');
  console.log('════════ 汇总 ════════');
  console.log(`条目总数 ${total} · 拟删 ${dropped}（${((dropped / Math.max(total, 1)) * 100).toFixed(2)}%）· 独有片段并入 ${merged}`);
  console.log(`其中等式/数值被删 ${formulaDropped} 条 ${formulaDropped ? '  <<< 检查是否误删' : '（0 = 豁免生效）'}`);
}

void main();
