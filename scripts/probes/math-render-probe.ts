/**
 * scripts/probes/math-render-probe.ts —— 公式渲染现状探针（2026-10-09）
 *
 * 背景：MinerU 把高数教材转成了带 `$...$` / `$$...$$` 的 markdown，
 *   但项目从未处理过数学公式（依赖里没有 katex/mathjax）。
 *
 * 本探针只回答一个问题：**现在把这份 md 交给 createMd().render() 会怎样？**
 *   三种可能，性质完全不同：
 *     A. 公式原样保留成纯文本（难看，但不损坏数据）
 *     B. markdown-it 的 emphasis 规则把 `_` / `*` 当斜体定界符吃掉（**内容被破坏**）
 *     C. 反斜杠被当转义符吃掉（`\frac` → `frac`）
 *
 * 为什么这很重要：如果是 B/C，那不只是「显示不出来」，
 *   而是「渲染一次内容就错一次」——必须先修渲染，再谈知识树。
 *
 * 用法：npx tsx scripts/probes/math-render-probe.ts [文件路径...]
 * 产物：.local/probe-out/math-render-probe.txt
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createMd } from '../../shared/blocks';
import { PROBE_OUT } from '../../server/core';

const FILES = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const TARGETS = FILES.length ? FILES : ['notes/math/tongji-ch1.md', 'notes/math/zhangyu-ch1.md'];

const log: string[] = [];
const say = (s = '') => {
  log.push(s);
  console.log(s);
};

/** 取每份材料里最典型的三类片段：行内公式密集行、行间公式块、带下标的公式 */
function sampleLines(md: string): { kind: string; text: string }[] {
  const out: { kind: string; text: string }[] = [];
  const lines = md.split('\n');

  const inlineRich = lines.find((l) => (l.match(/\$/g) ?? []).length >= 6 && l.length < 400);
  if (inlineRich) out.push({ kind: '行内公式密集行', text: inlineRich });

  const sub = lines.find((l) => /_[{0-9a-zA-Z]/.test(l) && l.includes('$') && l.length < 300);
  if (sub) out.push({ kind: '带下标公式', text: sub });

  const frac = lines.find((l) => l.includes('\\frac') && l.length < 300);
  if (frac) out.push({ kind: '带分式公式', text: frac });

  const i = lines.findIndex((l) => l.trim() === '$$');
  if (i >= 0) out.push({ kind: '行间公式块', text: `${lines[i]}\n${lines[i + 1] ?? ''}\n${lines[i + 2] ?? ''}` });

  return out;
}

/** 统计正文里“渲染会出事”的规模：$ 数量、下划线数量、反斜杠命令数量 */
function census(md: string) {
  return {
    dollars: (md.match(/\$/g) ?? []).length,
    underscores: (md.match(/_/g) ?? []).length,
    backslash: (md.match(/\\[a-zA-Z]+/g) ?? []).length,
    inlineMath: (md.match(/\$[^$\n]{1,200}\$/g) ?? []).length,
    displayMath: (md.match(/\$\$/g) ?? []).length / 2,
  };
}

/** ★ 对抗样本（人工构造）★
 *  真实 md 里 MinerU 输出的是 `D _ { f }`（下标前带空格），那些不触发 markdown-it 的
 *  emphasis 规则，所以「正文没出事」不等于「安全」。这里把最危险的四类写法摆出来：
 *  下划线紧贴字符、星号乘以、行尾 `\\`、`\{` 转义——只有它们全过了才算真安全。
 */
const ADVERSARIAL: { kind: string; text: string }[] = [
  { kind: '下标紧贴(无空格)', text: '数列 $a_1 , a_2 , \\cdots , a_n$ 收敛' },
  { kind: '下标嵌套', text: '子列 $\\{ x_{n_k} \\}$ 也收敛于 $a$' },
  { kind: '星号当乘号', text: '面积 $S = \\pi * r * r$ 与 $x_1*x_2$ 无关' },
  { kind: '行尾双反斜杠', text: '$f ( x ) = \\left\\{ \\begin{array} { l l } { x , } & { x \\geqslant 0 , } \\\\ { 1 } & { x < 0 } \\end{array} \\right.$' },
  { kind: '花括号转义', text: '集合 $\\{ x \\mid x > 0 \\}$ 与 $\\left\\{ y \\right\\}$' },
  { kind: '下划线与星号同现', text: '若 $x_1 > 0$ 则 $a_1 * b_1 > 0$' },
];

async function main(): Promise<void> {
  const md = createMd();
  say('公式渲染现状探针');
  say('='.repeat(64));

  say('\n【对抗样本】人工构造，验证 markdown 语法是否会吃掉公式内容');
  say('-'.repeat(64));
  let broken = 0;
  for (const s of ADVERSARIAL) {
    const html = md.render(s.text).trim();
    const emBroken = /<em>|<\/em>/.test(html);
    const strongBroken = /<strong>|<\/strong>/.test(html);
    const backslashLost = s.text.includes('\\\\') !== html.includes('\\\\');
    const braceLost = /\\\{/.test(s.text) && !/\\\{/.test(html);
    const ampEscaped = /&amp;/.test(html);
    const bad = emBroken || strongBroken || backslashLost || braceLost;
    if (bad) broken++;
    say(`\n  [${s.kind}] ${bad ? '★ 有损坏' : '完好'}`);
    say(`    原文：${s.text}`);
    say(`    渲染：${html.replace(/<\/?p>/g, '')}`);
    const flags = [
      emBroken ? '被当斜体吃掉' : '',
      strongBroken ? '被当加粗吃掉' : '',
      backslashLost ? '行尾\\\\丢失' : '',
      braceLost ? '\\{ 转义丢失' : '',
      ampEscaped ? '& 被转义成 &amp;' : '',
    ].filter(Boolean);
    if (flags.length) say(`    → ${flags.join(' / ')}`);
  }
  say(`\n  小结：${ADVERSARIAL.length} 个样本中 ${broken} 个被 markdown 语法破坏`);
  say('-'.repeat(64));

  for (const f of TARGETS) {
    let src: string;
    try {
      src = await readFile(f, 'utf8');
    } catch {
      say(`\n── ${f}（读不到，跳过）`);
      continue;
    }

    const c = census(src);
    say(`\n── ${f}`);
    say(`   $ 符号 ${c.dollars} 个（行内公式约 ${c.inlineMath}，行间公式 ${c.displayMath} 块）`);
    say(`   下划线 ${c.underscores} 个，反斜杠命令 ${c.backslash} 个`);
    say('');

    for (const s of sampleLines(src)) {
      const html = md.render(s.text).trim();
      const noDollar = !html.includes('$');
      const emBroken = /<em>|<\/em>/.test(html);
      const slashEaten = /<(?:em|strong)>[a-z]+/.test(html) || (/\\[a-zA-Z]+/.test(s.text) && !/\\[a-zA-Z]+/.test(html));

      say(`   [${s.kind}]`);
      say(`     原文：${s.text.replace(/\n/g, ' ⏎ ').slice(0, 130)}`);
      say(`     渲染：${html.replace(/\n/g, ' ').slice(0, 130)}`);
      say(`     → $ 消失=${noDollar ? '是' : '否'} / 被当斜体吃=${emBroken ? '是' : '否'} / 反斜杠命令丢失=${slashEaten ? '是' : '否'}`);
      say('');
    }
  }

  say('='.repeat(64));
  say('结论口径：');
  say('  · 「被当斜体吃=是」⇒ 渲染一次内容就错一次，属于必须修的数据损坏级问题');
  say('  · 「$ 消失」但内容完好 ⇒ 只是难看，靠加数学渲染器解决');

  await mkdir(PROBE_OUT, { recursive: true });
  await writeFile(join(PROBE_OUT, 'math-render-probe.txt'), log.join('\n'), 'utf8');
  say(`\n已写入 ${join(PROBE_OUT, 'math-render-probe.txt')}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
