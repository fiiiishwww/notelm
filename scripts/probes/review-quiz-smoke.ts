/**
 * 复习 × 测验管线 接入 · 端到端校验
 * ------------------------------------------------------------------
 * 跑完 plumbing 后要回答一件事：**她今天那份计划，现在有几条是真能考她的。**
 * 复现 /review/plan 的解析链路（概念 → 小节 → 那节的 quiz），逐条报结果。
 *
 * ★ 只读库房 + 只写 .local/probe-out，不改任何数据 ★
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PROBE_OUT } from '../../server/core';

interface Node {
  name: string;
  kind?: string;
  essence?: string;
  details?: { kind: string; text: string }[];
}
interface Side {
  docPath?: string;
  cards?: { id: string; sm2?: { repetitions?: number } }[];
  cheatsheet?: { sections?: { headingId: string; headingText?: string; tree?: { nodes?: Node[] } }[] };
  quizzes?: {
    headingId: string;
    headingText?: string;
    questions: { id: string; type: string; stem: string; options?: string[]; answer: (number | string)[]; explain: string }[];
  }[];
}

async function walk(root: string, out: string[] = []): Promise<string[]> {
  let es;
  try {
    es = await readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of es) {
    const p = join(root, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (e.name.endsWith('.json')) out.push(p);
  }
  return out;
}

async function main() {
  const L: string[] = [];
  const say = (s = '') => L.push(s);
  const files = await walk(join(process.cwd(), 'notes', '.notebook', 'doc'));
  const all: Side[] = [];
  for (const f of files) {
    try {
      all.push(JSON.parse(await readFile(f, 'utf8')) as Side);
    } catch {
      /* 忽略 */
    }
  }

  const cStore = JSON.parse(await readFile(join(process.cwd(), 'notes', '.notebook', 'concepts.json'), 'utf8')) as {
    concepts: { key: string; name: string; sources: { docRel: string; headingId: string }[] }[];
  };
  const plan = JSON.parse(
    await readFile(join(process.cwd(), 'notes', '.notebook', 'review-plan.json'), 'utf8'),
  ) as { current: { date: string; items: { id: string; kind: string; conceptKey?: string; cardId?: string }[] } | null };

  const ko = (s: string) => String(s ?? '').trim().toLowerCase();
  const conceptByKey = (k: string) => {
    const n = ko(k);
    return cStore.concepts.find((c) => c.key === n) ?? null;
  };

  say('复习 × 测验管线 · 端到端校验');
  say('='.repeat(60));
  const cur = plan.current;
  if (!cur) {
    say('没有计划');
    return;
  }
  say(`计划 ${cur.date} / ${cur.items.length} 条`);
  say('');

  let live = 0;
  let dead = 0;
  const deadWhy: string[] = [];

  // ★ 与服务端同制式：同一组小题（同 quiz.id）按条目顺序轮询 ★
  const used = new Map<string, number>();
  const askedStern = new Map<string, string[]>();

  for (const it of cur.items) {
    if (it.kind === 'card') {
      const found = all.some((s) => (s.cards ?? []).some((c) => c.id === it.cardId));
      if (found) live++;
      else {
        dead++;
        deadWhy.push(`${it.id}：找不到那张卡`);
      }
      continue;
    }
    const concept = it.conceptKey ? conceptByKey(it.conceptKey) : null;
    const cands = (concept?.sources ?? [])
      .map((src) => {
        const hit = all.find((x) => (x.docPath ?? '').replace(/\.md$/, '') === src.docRel.replace(/\.md$/, ''));
        const quiz = hit?.quizzes?.find((q) => q.headingId === src.headingId);
        const nodes =
          hit?.cheatsheet?.sections?.find((s) => s.headingId === src.headingId)?.tree?.nodes ?? [];
        return quiz && quiz.questions?.length ? { quiz, n: nodes.length } : null;
      })
      .filter((x): x is { quiz: NonNullable<Side['quizzes']>[number]; n: number } => x !== null)
      .sort((a, b) => b.n - a.n);

    if (!cands.length) {
      dead++;
      deadWhy.push(`${it.id}（${it.conceptKey}）：这一节还没出题 → 界面会让她跳过`);
      continue;
    }
    live++;
    const best = cands[0].quiz;
    const rounds = used.get(best.headingId) ?? 0;
    used.set(best.headingId, rounds + 1);
    const picked = best.questions[rounds % best.questions.length];
    const seen = askedStern.get(best.headingId) ?? [];
    askedStern.set(best.headingId, [...seen, picked.stem]);
    say(`✓ ${it.kind} ${it.conceptKey} → 第 ${rounds + 1}/${best.questions.length} 道`);
    say(`   [${picked.type}] ${picked.stem.slice(0, 70)}`);
  }

  say('');
  say('── 撞题检查（同一小节的几条不能问同一句）──');
  let dup = 0;
  for (const [kid, stems] of askedStern) {
    const uniq = new Set(stems);
    if (uniq.size < stems.length) {
      dup++;
      say(`  ✗ ${kid}: ${stems.length} 条里只有 ${uniq.size} 道不同的题`);
    }
  }
  if (!dup) say('  ✓ 没有撞题');

  say('');
  say('── 结果 ──');
  say(`能真的拿来考她：${live} 条`);
  say(`会变成「跳过」 ：${dead} 条`);
  if (deadWhy.length) {
    say('');
    say('跳过的都是这些：');
    for (const d of deadWhy) say(`  · ${d}`);
  }
  const rate = cur.items.length ? (live / cur.items.length) * 100 : 0;
  say('');
  say(`可用率 ${rate.toFixed(0)}%`);

  const out = join(PROBE_OUT, 'review-quiz-smoke.txt');
  await writeFile(out, L.join('\n'), 'utf8');
  console.log(L.join('\n'));
  console.log(`\n→ ${out}`);
}

void main();
