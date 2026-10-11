/**
 * scripts/cheatsheet-coverage.ts —— 小抄到底漏了多少原文？
 *
 * ★ 为什么要有这个探针 ★
 *   小抄 V2 用「最多 7 条命题」卡条数，好处是精炼，坏处可能是
 *   **漏掉整块有效信息**。压缩比只能说明「短了多少」，说明不了「漏了什么」。
 *   所以要按块统计覆盖率：原文有几块内容、小抄的引文碰到了哪几块。
 *   V3 起不再卡条数（长节拆窗口各自采集），但「漏没漏」这个问题依然要靠本探针回答。
 *
 * 用法：
 *   npx tsx scripts/cheatsheet-coverage.ts                  # 默认看 02 那篇
 *   npx tsx scripts/cheatsheet-coverage.ts --rel=知识库/xx.md
 *   npx tsx scripts/cheatsheet-coverage.ts --miss=8         # 每节打印 8 条漏掉的块
 *   npx tsx scripts/cheatsheet-coverage.ts --all            # 全库所有有 sidecar 的文档
 *
 * 判据全是确定性的，不调模型、不花钱。
 */

import { writeFileSync } from 'node:fs';
import { analyzeDocument, unitText } from '../../shared/blocks';
import { dice, type Block, type CheatsheetSection, type StudyUnit } from '../../shared/text';
import { readDoc } from '../../server/vault';
import { readSidecar, listAllSidecars } from '../../server/services/sidecar';
import { extractQuotes, informativeBlock, isFormulaHeavy, isImageRef, quoteTouches } from '../../server/services/cheatsheet';

const args = process.argv.slice(2);
const arg = (k: string, d = ''): string => {
  const hit = args.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};
const flag = (k: string): boolean => args.includes(`--${k}`);
const num = (k: string, d: number): number => {
  const v = arg(k);
  return v ? Number(v) : d;
};

const REL_DEFAULT = '知识库/jly大模型知识学习/居丽叶LLM体系知识搭建 - 02 采用方法：利用 SVD 分解.md';

/**
 * ★ 为什么要自己写文件而不是 console.log ★
 *   Windows 控制台默认代码页是 GBK，node 往 stdout 写中文时按代码页编码，
 *   外面重定向抓到的就是乱码。报告直接以 utf8 落盘最省事。
 */
const LINES: string[] = [];
function log(line = ''): void {
  LINES.push(line);
  process.stdout.write(line + '\n');
}
function dump(out: string): void {
  if (!out) return;
  writeFileSync(out, LINES.join('\n'), 'utf8');
}

/** 看起来「有信息量」的块：带数字、带英文专名/缩写、或者讲因果/对比。 */
function informative(b: Block): boolean {
  return informativeBlock(b.text);
}

interface UnitRow {
  rel: string;
  unit: StudyUnit;
  version: number;
  blocks: number;
  covered: number;
  chars: number;
  cheatChars: number;
  props: number;
  missedInfo: Block[];
  missedAll: Block[];
  /** 每个内容块在自己节里的相对位置（0~1）以及是否被引文命中 */
  positions: { rel: number; covered: boolean }[];
  /** 未覆盖里的公式块 / 图片块（这两类不该算进「漏掉的有效信息」） */
  missedFormula: number;
  missedImage: number;
}

function analyzeUnit(
  rel: string,
  blocks: Block[],
  unit: StudyUnit,
  section: CheatsheetSection | undefined,
): UnitRow {
  const inUnit = blocks.filter((b) => b.bi >= unit.startBi && b.bi <= unit.endBi);
  // 只算「内容块」：标题不算，空白不算
  const content = inUnit.filter((b) => !/^h[1-6]$/.test(b.type) && b.text.trim().length >= 8);
  const text = unitText(blocks, unit);
  const md = section?.markdown ?? '';
  const quotes = extractQuotes(md);
  const covered = content.filter((b) => quotes.some((q) => quoteTouches(q, b.text)));
  const coveredSet = new Set(covered.map((b) => b.bi));
  const missedAll = content.filter((b) => !coveredSet.has(b.bi));
  const props = (section?.markdown.match(/—[^→]{1,6}→/g) || []).length;

  return {
    rel,
    unit,
    version: section?.version ?? (section ? 1 : 0),
    blocks: content.length,
    covered: covered.length,
    chars: text.length,
    cheatChars: md.length,
    props,
    missedInfo: missedAll.filter(informative),
    missedAll,
    positions: content.map((b, i) => ({
      rel: content.length > 1 ? i / (content.length - 1) : 0,
      covered: coveredSet.has(b.bi),
    })),
    missedFormula: missedAll.filter((b) => isFormulaHeavy(b.text)).length,
    missedImage: missedAll.filter((b) => isImageRef(b.text)).length,
  };
}

async function runOne(rel: string, missN: number): Promise<UnitRow[]> {
  const doc = await readDoc(rel);
  const a = analyzeDocument(doc.markdown);
  const sc = await readSidecar(rel);
  const byId = new Map(sc.cheatsheet.sections.map((s) => [s.headingId, s]));

  const rows: UnitRow[] = [];
  for (const u of a.units) {
    const sec = byId.get(u.headingId);
    const row = analyzeUnit(rel, a.blocks, u, sec);
    if (row.blocks === 0) continue;
    rows.push(row);

    const pct = row.blocks ? ((row.covered / row.blocks) * 100).toFixed(0) : '-';
    const ratio = row.chars ? (row.cheatChars / row.chars).toFixed(2) : '-';
    const tag = sec ? `v${row.version}` : '未生成';
    const doc = (rel.split('/').pop() ?? '').replace(/\.md$/, '').slice(0, 14);
    log(
      `${tag.padEnd(4)} ${doc.padEnd(16)} ${u.headingText.slice(0, 22).padEnd(24)} ` +
        `块 ${String(row.covered).padStart(3)}/${String(row.blocks).padStart(3)}（${String(pct).padStart(3)}%）` +
        ` 字 ${String(row.chars).padStart(5)} → 小抄 ${String(row.cheatChars).padStart(4)}（${ratio}×）` +
        ` 命题 ${String(row.props).padStart(2)}`,
    );
    if (missN > 0 && row.missedInfo.length) {
      const show = row.missedInfo.slice(0, missN);
      log(`     ↳ 未覆盖且有信息量的块 ${row.missedInfo.length} 个，例如：`);
      for (const b of show) log(`       · ${b.text.replace(/\s+/g, ' ').slice(0, 88)}`);
    }
  }
  return rows;
}

function summarize(title: string, rows: UnitRow[]): void {
  const gen = rows.filter((r) => r.version > 0);
  if (!gen.length) {
    log(`\n${title}：没有已生成的小抄`);
    return;
  }
  const avg = (f: (r: UnitRow) => number) => gen.reduce((s, r) => s + f(r), 0) / gen.length;
  log(`\n═══════ ${title} ═══════`);
  log(`已生成小节 ${gen.length} 节`);
  log(`平均覆盖率（引文碰到的内容块占比）  ${(avg((r) => (r.blocks ? r.covered / r.blocks : 0)) * 100).toFixed(1)}%`);
  log(`平均压缩比（小抄字数 / 原文字数）    ${avg((r) => (r.chars ? r.cheatChars / r.chars : 0)).toFixed(2)}×`);
  log(`平均未覆盖块                        ${avg((r) => r.blocks - r.covered).toFixed(1)} 个/节`);
  log(`其中「有信息量」的未覆盖块          ${avg((r) => r.missedInfo.length).toFixed(1)} 个/节`);
  const totInfo = gen.reduce((s, r) => s + r.missedInfo.length, 0);
  const totMiss = gen.reduce((s, r) => s + (r.blocks - r.covered), 0);
  const totFormula = gen.reduce((s, r) => s + r.missedFormula, 0);
  const totImage = gen.reduce((s, r) => s + r.missedImage, 0);
  log(`合计：未覆盖 ${totMiss} 块，其中 ${totInfo} 块含数字/专名/因果词`);
  log(`（另有公式块 ${totFormula} 个、图片引用 ${totImage} 个，未计入上面的「有信息量」）`);

  // ── 关键推算：条数上限是常数，内容量却是变量 ──
  const v2 = gen.filter((r) => r.version >= 2 && r.blocks >= 10 && r.props > 0);
  if (v2.length) {
    log(`\n【V2 长节（≥10 块）${v2.length} 个】`);
    for (const r of v2) {
      log(
        `  ${String(r.blocks).padStart(3)} 块 / ${r.props} 条命题 = 一条命题要代表 ${((r.blocks / r.props)).toFixed(1)} 块` +
          `，实测覆盖 ${((r.covered / r.blocks) * 100).toFixed(0)}%`,
      );
    }
    const perProp = v2.reduce((s, r) => s + r.blocks / r.props, 0) / v2.length;
    log(`  平均：一条命题代表 ${perProp.toFixed(1)} 个内容块`);
    for (const r of v2.slice(0, 3)) {
      // 反推：若维持当前的「每条命题覆盖多少块」不改善，要做到 80% 得堆到多少条。
      // V3 已改用「拆窗口采集」而非「堆条数」，这个数字只用来说明平铺采集的规模代价。
      const need = Math.round(r.blocks * 0.8 * (r.props / r.covered));
      const per = need > 0 ? r.blocks / need : 0;
      log(`    ${r.blocks} 块（实测 ${r.props} 条覆盖 ${((r.covered / r.blocks) * 100).toFixed(0)}%）`);
      log(
        `      若不换策略、只堆条数，做到 80% 覆盖需约 ${need} 条` +
          `，即一条命题平均只代表 ${per.toFixed(1)} 块 —— 那是缩写，不是整理。`,
      );
    }
  }

  const longUnits = gen.filter((r) => r.blocks >= 30);
  const shortUnits = gen.filter((r) => r.blocks < 30 && r.blocks > 0);
  if (longUnits.length) {
    const pctOf = (rs: UnitRow[]) => ((rs.reduce((s, r) => s + r.covered / r.blocks, 0) / rs.length) * 100).toFixed(1);
    log(`\n≥30 块的长节 ${longUnits.length} 个，平均覆盖率 ${pctOf(longUnits)}%`);
    log(`<30 块的短节 ${shortUnits.length} 个，平均覆盖率 ${pctOf(shortUnits)}%`);
    log(`→ 同一个条数上限在短节够用、在长节必然漏。`);
    log(`  V3 起不再设「一节最多 N 条」：长节按块拆窗口各自采集，再合并（见 services/cheatsheetV3.ts）。`);
  }

  // ── 位置分布：漏掉的块是均匀漏，还是集中在中段？ ──
  // 如果是「两头覆盖、中间空」，那就不是取舍问题，是长输入的中段注意力问题
  // （lost in the middle），只能靠切窗口解决，放宽条数治不了。
  for (const [label, set] of [
    ['长节', longUnits],
    ['短节', shortUnits],
  ] as const) {
    const usable = set.filter((r) => r.positions.length >= 8);
    if (usable.length < 2) continue;
    const N = 5;
    const bk = Array.from({ length: N }, () => ({ tot: 0, cov: 0 }));
    for (const r of usable) {
      for (const p of r.positions) {
        const i = Math.min(N - 1, Math.floor(p.rel * N));
        bk[i].tot++;
        if (p.covered) bk[i].cov++;
      }
    }
    log(
      `${label}按位置分成 5 段的覆盖率：  ` +
        bk.map((x, i) => `${i + 1}/5 ${x.tot ? ((x.cov / x.tot) * 100).toFixed(0) : '-'}%`).join('　'),
    );
  }
}

function median(xs: number[]): number {
  const a = [...xs].sort((p, q) => p - q);
  if (!a.length) return 0;
  const h = Math.floor(a.length / 2);
  return a.length % 2 ? a[h] : (a[h - 1] + a[h]) / 2;
}

async function main() {
  if (flag('all')) {
    const all = await listAllSidecars();
    const rows: UnitRow[] = [];
    for (const { docRel, sidecar } of all) {
      if (!sidecar.cheatsheet?.sections?.length) continue;
      try {
        rows.push(...(await runOne(docRel, num('miss', 0))));
      } catch {
        /* 跳过读不到的文件 */
      }
    }
    summarize('全库', rows);
    return;
  }

  const rel = arg('rel') || REL_DEFAULT;
  const rows = await runOne(rel, num('miss', 0));
  summarize(rel.split('/').pop() ?? rel, rows);
}

void main().then(() => dump(arg('out')));
