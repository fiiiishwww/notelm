/**
 * scripts/tree-batch.mjs —— B0 试点：批量给若干文档生成知识树。
 *
 * 用法：
 *   node scripts/tree-batch.mjs                     # 跑下面的试点清单（跳过已有树）
 *   node scripts/tree-batch.mjs --only chapter2     # 只跑文件名含 chapter2 的
 *   node scripts/tree-batch.mjs --force             # 已有树也重跑
 *   node scripts/tree-batch.mjs --all --existing --force --conc 3
 *                                                   # 全库：只重跑「已经有树」的节（不动还没树的节）
 *   node scripts/tree-batch.mjs --limit 3           # 每篇最多跑 3 节（试水用）
 *   node scripts/tree-batch.mjs --dry               # 只列出会跑哪些节，不调模型
 *   node scripts/tree-batch.mjs --port 3000
 *
 * 断点续跑：已生成的节默认跳过（重跑即续）。失败不中断，最后汇总。
 * 依赖：dev server 已启动（启动.bat）。
 */
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const argv = process.argv.slice(2);
const argOf = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const hasFlag = (name) => argv.includes(`--${name}`);
const port = argOf('port', '3000');
const only = argOf('only', null);
const limit = Number(argOf('limit', '0')) || 0;
const force = hasFlag('force');
const dry = hasFlag('dry');
const base = `http://127.0.0.1:${port}`;
/** 并发节数（2026-10-11 默认 3：树生成 5~35s/节，串行是批量感知最慢的场景；
 *  全局 AI 闸 AI_CONCURRENCY=3 兜底限流。要回串行就显式传 --conc 1） */
const conc = Number(argOf('conc', '3')) || 3;
/** --all：自动发现「已有树」的全部文档（用于规则改动后的全库重跑） */
const all = hasFlag('all');
/**
 * --existing：只处理「已经有树」的节。
 * 用于「改了生成规则、想重刷一遍现有树」——不会顺手给还没树的节新建树，
 * 改动范围严格锁在现有树内。（多鱼 2026-10-07：46 个没树的节先不管）
 */
const existing = hasFlag('existing');

/** B0 试点清单（多鱼 2026-09-22 拍板：两个文件夹各选几篇，先看效果） */
const DOCS = [
  '知识库/AI-Agent-Book/chapter2.md',
  '知识库/AI-Agent-Book/chapter3.md',
  '知识库/AI-Agent-Book/chapter5.md', // 已有 5 棵树：验证「正文没变 → 复用秒回、不覆盖」
  '知识库/jly大模型知识学习/居丽叶LLM体系知识搭建 - 01 居丽叶 LLM 体系知识搭建.md',
  '知识库/jly大模型知识学习/居丽叶LLM体系知识搭建 - 02 采用方法：利用 SVD 分解.md',
];

/** --all 时自动扫描 sidecar 目录 */
function discoverDocs() {
  const dir = 'notes/.notebook/doc';
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.json')) out.push(relative(dir, p).replace(/\\/g, '/').replace(/\.json$/, ''));
    }
  };
  walk(dir);
  return out;
}
const DOC_LIST = all ? discoverDocs() : DOCS;

// ── 取 local token（与 tree-multi.mjs 同一套路）──
const home = await fetch(`${base}/`);
const html = await home.text();
const m = html.match(/name="x-local-token" content="([^"]+)"/) || html.match(/content="([^"]+)" name="x-local-token"/);
if (!m) throw new Error('首页 meta 里没有 local-token——dev server 没起？');
const headers = { 'content-type': 'application/json', 'x-local-token': m[1] };

let planned = 0;
let ok = 0;
let reused = 0;
let failed = 0;
const failures = [];
const t0 = Date.now();

for (const rel of DOC_LIST) {
  if (only && !rel.includes(only)) continue;
  const short = rel.split('/').pop();
  const cr = await fetch(`${base}/api/cheatsheet?rel=${encodeURIComponent(rel)}`, { headers });
  if (!cr.ok) {
    console.log(`SKIP ${short}：/cheatsheet 返回 ${cr.status}（可能未索引）`);
    continue;
  }
  const cd = await cr.json();
  const allSections = cd.sections ?? [];
  // --existing：只要「已经有树」的节；否则沿用旧语义（--force=全部，无 force=只补没树的）
  const sections = existing
    ? allSections.filter((s) => !!s.tree)
    : allSections.filter((s) => force || !s.tree);
  const todo = limit ? sections.slice(0, limit) : sections;
  console.log(`\n=== ${short}：${allSections.length} 节，本次跑 ${todo.length} 节（并发 ${conc}）===`);
  if (dry) {
    for (const s of todo) {
      planned += 1;
      console.log(`  DRY ${s.headingText}`);
    }
    continue;
  }
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= todo.length) return;
      const s = todo[i];
      planned += 1;
      const ts = Date.now();
      try {
        const r = await fetch(`${base}/api/cheatsheet/tree`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ rel, headingId: s.headingId, force }),
        });
        const d = await r.json().catch(() => null);
        if (!r.ok || !d?.section) {
          failed += 1;
          failures.push(`${short} · ${s.headingText}: HTTP ${r.status} ${JSON.stringify(d).slice(0, 120)}`);
          console.log(`  FAIL ${s.headingText} (${Date.now() - ts}ms)`);
          continue;
        }
        if (d.reused) reused += 1;
        else ok += 1;
        const loc = d.section.tree?.locate ? `引文定位 ${d.section.tree.locate.located}/${d.section.tree.locate.total}` : '';
        console.log(
          `  ${d.reused ? 'REUSE' : 'OK   '} ${s.headingText} | ${((Date.now() - ts) / 1000).toFixed(1)}s | ` +
            `nodes=${d.section.tree?.nodes?.length ?? 0} | ${loc}`,
        );
      } catch (e) {
        failed += 1;
        failures.push(`${short} · ${s.headingText}: ${e.message}`);
        console.log(`  FAIL ${s.headingText}: ${e.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(conc, todo.length) }, worker));
}

console.log(`\n─── 汇总 ───`);
console.log(`计划 ${planned} 节 | 新生成 ${ok} | 复用 ${reused} | 失败 ${failed} | 用时 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
if (failures.length) {
  console.log('失败清单：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exitCode = 1;
}
