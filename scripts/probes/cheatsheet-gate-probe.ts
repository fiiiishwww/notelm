/**
 * scripts/cheatsheet-gate-probe.ts —— 覆盖率质量门的离线预演（零模型成本）。
 *
 * ★ 这个探针要回答什么 ★
 *   生成时接了覆盖率质量门（漏得离谱就定向补采）。但门槛定多少、补采量会不会
 *   失控，不能拍脑袋：补多了就是把小抄退回「逐句缩写」（V3 拼命避免的那件事），
 *   补少了等于没接。所以先用落盘数据把分布和成本量出来。
 *
 * ★ 判据和生成管道是同一份 ★
 *   覆盖率、候选收严、段聚类全部调 services/coverage.measureCoverage ——
 *   探针自己再写一遍规则就会出现「探针说 60%、管道说 80%」的自欺。
 *
 * 用法：
 *   tsx scripts/cheatsheet-gate-probe.ts                 # 全库 V3 节
 *   tsx scripts/cheatsheet-gate-probe.ts --miss=5        # 每节打印 5 条候选补采块
 *   tsx scripts/cheatsheet-gate-probe.ts --rel=知识库/xx.md
 *   tsx scripts/cheatsheet-gate-probe.ts --out=.local/tmp/gate.txt
 */

import { writeFileSync } from 'node:fs';
import { analyzeDocument } from '../../shared/blocks';
import { type Block, type CheatsheetSection, type StudyUnit } from '../../shared/text';
import { readDoc } from '../../server/vault';
import { listAllSidecars, readSidecar } from '../../server/services/sidecar';
import { measureCoverage, type CoverageReport } from '../../server/services/coverage';
import { validateQuote } from '../../server/services/anchor';

const args = process.argv.slice(2);
const arg = (k: string, d = ''): string => {
  const hit = args.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};
const num = (k: string, d: number): number => {
  const v = arg(k);
  return v ? Number(v) : d;
};

const LINES: string[] = [];
function log(line = ''): void {
  LINES.push(line);
  process.stdout.write(line + '\n');
}

const pct = (x: number): string => (x * 100).toFixed(0) + '%';

interface GateRow {
  rel: string;
  unit: StudyUnit;
  /** 收严后的报告（管道实际用的） */
  r: CoverageReport;
  /** 不收严的候选字数（对照，用来说明「只补孤立漏块」省了多少） */
  wideChars: number;
}

function analyze(rel: string, blocks: Block[], unit: StudyUnit, section: CheatsheetSection): GateRow | null {
  const items = section.items;
  if (!items) return null;
  const all = [...(items.propositions ?? []), ...(items.entries ?? []), ...(items.terms ?? [])];
  const locate = (q: string) => validateQuote(q, blocks)?.blockIndex ?? null;
  const r = measureCoverage({ blocks, unit, items: all, locate });
  if (!r.total) return null;
  const wide = measureCoverage({ blocks, unit, items: all, locate, isolatedOnly: false, maxSegments: 99 });
  return { rel, unit, r, wideChars: wide.candidateChars };
}

async function main() {
  const onlyRel = arg('rel');
  const missN = num('miss', 0);
  const targets = onlyRel
    ? [{ docRel: onlyRel, sidecar: await readSidecar(onlyRel) }]
    : await listAllSidecars();

  const rows: GateRow[] = [];
  for (const { docRel, sidecar } of targets) {
    const secs = sidecar.cheatsheet?.sections ?? [];
    if (!secs.some((s) => s.version === 3 && s.items)) continue;
    let doc;
    try {
      doc = await readDoc(docRel);
    } catch {
      continue;
    }
    const a = analyzeDocument(doc.markdown);
    const byId = new Map(secs.map((s) => [s.headingId, s]));
    for (const u of a.units) {
      const sec = byId.get(u.headingId);
      if (!sec || sec.version !== 3 || !sec.items) continue;
      const row = analyze(docRel, a.blocks, u, sec);
      if (row) rows.push(row);
    }
  }

  log('═══ 覆盖率质量门 · 离线预演（判据与生成管道共用 measureCoverage）═══');
  log(`参与统计：${rows.length} 个 V3 节`);
  log();
  log('节（按覆盖率升序，前 25 个）');
  log(
    '  ' +
      '节名'.padEnd(24) +
      '块'.padStart(4) +
      '覆盖'.padStart(6) +
      '率'.padStart(6) +
      '漏'.padStart(5) +
      '孤立'.padStart(6) +
      '候选'.padStart(6) +
      '候选字'.padStart(7) +
      '段'.padStart(4) +
      '已落盘率'.padStart(9),
  );
  for (const { unit, r, ...rest } of [...rows].sort((a, b) => a.r.rate - b.r.rate).slice(0, 25)) {
    void rest;
    log(
      '  ' +
        unit.headingText.slice(0, 22).padEnd(24) +
        String(r.total).padStart(4) +
        String(r.covered).padStart(6) +
        pct(r.rate).padStart(6) +
        String(r.missing.length).padStart(5) +
        String(r.missing.length - r.candidates.length).padStart(6) +
        String(r.candidates.length).padStart(6) +
        String(r.candidateChars).padStart(7) +
        String(r.segments.length).padStart(4),
    );
    if (missN > 0) {
      for (const b of r.candidates.slice(0, missN)) {
        log(`       · ${b.text.replace(/\s+/g, ' ').slice(0, 86)}`);
      }
    }
  }

  const rates = rows.map((x) => x.r.rate).sort((a, b) => a - b);
  const q = (p: number) => rates[Math.min(rates.length - 1, Math.floor(rates.length * p))] ?? 0;
  log();
  log(
    `覆盖率分布：最低 ${pct(rates[0])}　p25 ${pct(q(0.25))}　中位 ${pct(q(0.5))}　p75 ${pct(q(0.75))}　最高 ${pct(rates[rates.length - 1])}`,
  );
  log(`平均 ${pct(rows.reduce((s, x) => s + x.r.rate, 0) / rows.length)}`);
  log(
    `平均每节：漏 ${(rows.reduce((s, x) => s + x.r.missing.length, 0) / rows.length).toFixed(1)} 块，` +
      `其中可补候选 ${(rows.reduce((s, x) => s + x.r.candidates.length, 0) / rows.length).toFixed(1)} 块`,
  );

  log();
  log('门槛模拟（rate < 门槛 才触发；候选 = 孤立漏 且（≥60 字 或 有信息量））');
  log('  门槛   触发节数   触发占比   总补采次数   总候选块   总候选字   平均每节次数   补采后预估率');
  for (const gate of [0.5, 0.6, 0.7, 0.8, 0.9]) {
    const hit = rows.filter((x) => x.r.rate < gate);
    const calls = hit.reduce((s, x) => s + Math.min(2, x.r.segments.length), 0);
    const blk = hit.reduce((s, x) => s + x.r.candidates.length, 0);
    const ch = hit.reduce((s, x) => s + x.r.candidateChars, 0);
    log(
      '  ' +
        pct(gate).padStart(5) +
        String(hit.length).padStart(10) +
        (rows.length ? pct(hit.length / rows.length) : '-').padStart(11) +
        String(calls).padStart(12) +
        String(blk).padStart(11) +
        String(ch).padStart(11) +
        (hit.length ? (calls / hit.length).toFixed(2) : '0').padStart(13),
    );
  }

  log();
  log('对照：不做「孤立」收严，直接拿全部漏块当候选（说明收严省了多少补采）');
  for (const gate of [0.6, 0.7, 0.8]) {
    const hit = rows.filter((x) => x.r.rate < gate);
    const wide = hit.reduce((s, x) => s + x.wideChars, 0);
    const narrow = hit.reduce((s, x) => s + x.r.candidateChars, 0);
    log(`  门槛 ${pct(gate)}：全量候选 ${wide} 字 → 收严后 ${narrow} 字（省 ${wide ? pct(1 - narrow / wide) : '-'}）`);
  }
}

void main().then(() => {
  if (arg('out')) writeFileSync(arg('out'), LINES.join('\n'), 'utf8');
});
