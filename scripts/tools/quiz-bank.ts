/**
 * 题库生成器 —— 照 /quiz/generate 的同一条管线跑，只是不经 HTTP
 * ------------------------------------------------------------------
 * ★ 为什么这个脚本存在 ★
 *   复习里的「填空/问答」过去是前端 `buildBlanks()` 按 等式/定义/数值 三条硬规则
 *   从树节点里现场挖出来的。2026-10-08 实测她今天那份计划：**4 条填空 3 条直接报废**
 *   （界面显示「没有可挖空的内容」，她只能点跳过），唯一能出的那条答案是 30 字长句，
 *   程序比对必判错。而同一批材料走测验管线（`quizPrompt`）出的题是好的。
 *   ⇒ 差的不是模型能力，是**出题的位置不对**。所以补题一律走 quizPrompt。
 *
 * ★ 用法 ★
 *   npx tsx scripts/tools/quiz-bank.ts --rel=知识库/AI-Agent-Book/chapter1 --headingId=h-xxx
 *   npx tsx scripts/tools/quiz-bank.ts --from-plan          # 今天计划里非闪卡项涉及的小节
 *   npx tsx scripts/tools/quiz-bank.ts --all --count=3      # 全库有树的小节
 *   npx tsx scripts/tools/quiz-bank.ts --all --dry          # 只列出要跑哪些，不调模型
 *
 * ★ 幂等 ★ 已经有题的小节默认跳过（--force 才重出）。题目一旦落盘就永久复用——补一次，以后零成本。
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { analyzeDocument, headingPathOf, unitText } from '../../shared/blocks';
import { localDate, makeId, type Quiz, type QuizQuestion, type StudyUnit } from '../../shared/text';
import { readDoc } from '../../server/vault';
import { updateSidecar, listAllSidecars } from '../../server/services/sidecar';
import { validateQuote } from '../../server/services/anchor';
import { chatJson, getAiSettings } from '../../server/services/aiClient';
import { blockIndexHint, quizPrompt, type QuizShape } from '../../server/services/prompts';
import { PROBE_OUT } from '../../server/core';

const args = process.argv.slice(2);
const arg = (k: string, def = '') => {
  const hit = args.find((a) => a === `--${k}` || a.startsWith(`--${k}=`));
  if (!hit) return def;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : '1';
};
const has = (k: string) => args.includes(`--${k}`);

interface Job {
  rel: string;
  headingId: string;
  headingText: string;
  reason: string;
}

async function collectJobs(): Promise<Job[]> {
  if (has('from-plan')) {
    // 今天计划里的非闪卡项 → conceptKey → concepts.json → 小节
    const plan = JSON.parse(
      await readFile(join(process.cwd(), 'notes', '.notebook', 'review-plan.json'), 'utf8'),
    ) as { current: { items: { kind: string; conceptKey?: string }[] } | null };
    const concepts = (
      JSON.parse(await readFile(join(process.cwd(), 'notes', '.notebook', 'concepts.json'), 'utf8')) as {
        concepts: { key: string; name: string; sources: { docRel: string; headingId: string }[] }[];
      }
    ).concepts;
    const ko = (s: string) => String(s ?? '').trim().toLowerCase();
    const out: Job[] = [];
    const seen = new Set<string>();
    for (const it of plan.current?.items ?? []) {
      if (it.kind === 'card') continue;
      const hit = concepts.find((c) => c.key === ko(it.conceptKey));
      if (!hit) continue;
      for (const s of hit.sources) {
        const k = `${s.docRel}#${s.headingId}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ rel: s.docRel.replace(/\.md$/, ''), headingId: s.headingId, headingText: hit.name, reason: it.conceptKey ?? '' });
      }
    }
    return out;
  }
  if (has('all')) {
    const all = await listAllSidecars();
    const out: Job[] = [];
    const seen = new Set<string>();
    for (const { docRel, sidecar } of all) {
      for (const sec of sidecar.cheatsheet?.sections ?? []) {
        if (!(sec.tree?.nodes ?? []).length) continue;
        const k = `${docRel}#${sec.headingId}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ rel: docRel.replace(/\.md$/, ''), headingId: sec.headingId, headingText: sec.headingText ?? '', reason: '有树' });
      }
    }
    return out;
  }
  if (arg('rel') && arg('headingId')) {
    return [{ rel: arg('rel'), headingId: arg('headingId'), headingText: arg('headingText', arg('headingId')), reason: '手动指定' }];
  }
  return [];
}

async function main() {
  const dry = has('dry');
  const force = has('force');
  const count = Number(arg('count', '3')) || 3;
  const jobs = await collectJobs();
  if (!jobs.length) {
    console.log('没有要跑的小节。用法见文件头注释。');
    return;
  }

  console.log(`待处理 ${jobs.length} 个小节（count=${count}${force ? ' force' : ''}${dry ? ' dry' : ''}）`);

  // 已有题的跳过
  const all = await listAllSidecars();
  const covered = new Set<string>();
  for (const { docRel, sidecar } of all) {
    for (const q of sidecar.quizzes ?? []) covered.add(`${docRel.replace(/\.md$/, '')}#${q.headingId}`);
  }

  const todo = force ? jobs : jobs.filter((j) => !covered.has(`${j.rel}#${j.headingId}`));
  console.log(`其中 ${jobs.length - todo.length} 个已有题（跳过），实际要出 ${todo.length} 个\n`);

  const lines: string[] = [];
  const say = (s = '') => {
    lines.push(s);
    console.log(s);
  };
  say(`题库生成 · ${localDate()}`);
  say('='.repeat(60));

  let ok = 0;
  let skipped = 0;
  let failed = 0;
  const failures: string[] = [];

  for (let i = 0; i < todo.length; i++) {
    const j = todo[i];
    const tag = `[${i + 1}/${todo.length}] ${j.rel.split('/').pop()} · ${j.headingText || j.headingId}`;
    if (dry) {
      console.log(`  dry ${tag}`);
      continue;
    }
    try {
      const doc = await readDoc(`${j.rel}.md`);
      const a = analyzeDocument(doc.markdown);
      const unit = a.units.find((u) => u.headingId === j.headingId);
      if (!unit) {
        skipped++;
        failures.push(`${tag} —— 这段不是 unit（多半是开篇 __preamble__），测验管线按小节出题，够不到它`);
        console.log(`  ✗ ${tag}：不是 unit，跳过`);
        continue;
      }
      const docTitle = j.rel.replace(/^.*\//, '');
      const text = unitText(a.blocks, unit);
      const p = quizPrompt(
        { unit, text, headingPath: headingPathOf(a.chapters, unit), docTitle },
        count,
        blockIndexHint(a.blocks, unit),
      );
      const shape = await chatJson<QuizShape>(
        [
          { role: 'system', content: p.system },
          { role: 'user', content: p.user },
        ],
        { label: `「${unit.headingText}」出题`, temperature: 0.5, maxTokens: 12000, timeoutMs: 180_000 },
      );

      let dropped = 0;
      const questions: QuizQuestion[] = (shape.questions ?? [])
        .map((raw): QuizQuestion | null => {
          const stem = (raw.stem ?? '').trim();
          if (!stem) return null;
          const type = (['single', 'multi', 'blank', 'short'] as const).includes(raw.type as QuizQuestion['type'])
            ? (raw.type as QuizQuestion['type'])
            : 'single';
          const options = Array.isArray(raw.options)
            ? raw.options.filter((o) => typeof o === 'string' && o.trim())
            : [];
          if ((type === 'single' || type === 'multi') && options.length < 2) return null;
          let answer: (number | string)[] = [];
          if (type === 'single' || type === 'multi') {
            answer = (Array.isArray(raw.answer) ? raw.answer : [])
              .map((x) => (typeof x === 'number' ? x : Number.parseInt(String(x), 10)))
              .filter((n) => Number.isInteger(n) && n >= 0 && n < options.length);
            if (!answer.length) return null;
            if (type === 'single') answer = [answer[0]];
            answer = [...new Set(answer)].sort((x, y) => (x as number) - (y as number));
          } else {
            answer = (Array.isArray(raw.answer) ? raw.answer : []).map((x) => String(x).trim()).filter(Boolean);
            if (!answer.length) return null;
          }
          const citations: { quote: string; blockIndex: number }[] = [];
          for (const c of raw.citations ?? []) {
            const hit = validateQuote(String(c?.quote ?? ''), a.blocks);
            if (hit) citations.push({ quote: String(c.quote).trim(), blockIndex: hit.blockIndex });
            else dropped++;
          }
          return { id: makeId('q'), type, stem, options: type === 'single' || type === 'multi' ? options : [], answer, explain: (raw.explain ?? '').trim(), citations };
        })
        .filter((q): q is QuizQuestion => q !== null);

      if (!questions.length) throw new Error('模型没产出有效题目');

      const ai = await getAiSettings();
      const quiz: Quiz = {
        id: makeId('qz'),
        headingId: unit.headingId,
        headingText: unit.headingText,
        model: ai.model,
        generatedAt: new Date().toISOString(),
        questions,
        attempts: [],
      };
      await updateSidecar(j.rel, (s) => {
        const idx = s.quizzes.findIndex((q) => q.headingId === unit.headingId);
        if (idx >= 0) {
          quiz.attempts = s.quizzes[idx].attempts ?? [];
          s.quizzes[idx] = quiz;
        } else {
          s.quizzes.push(quiz);
        }
      });
      ok++;
      console.log(`  ✓ ${tag} → ${questions.length} 题（丢弃无效引用 ${dropped} 条）`);
      say('');
      say(`${tag} → ${questions.length} 题`);
      for (const q of questions) {
        say(`  [${q.type}] ${q.stem}`);
        if (q.options.length) say(`     选项: ${q.options.join(' | ')}`);
        say(`     答案: ${JSON.stringify(q.answer)}`);
        say(`     解析: ${q.explain.slice(0, 100)}`);
      }
    } catch (e) {
      failed++;
      const msg = e instanceof Error ? e.message : String(e);
      failures.push(`${tag} —— ${msg}`);
      console.log(`  ✗ ${tag}：${msg.slice(0, 90)}`);
    }
  }

  say('');
  say('── 结果 ──');
  say(`成功 ${ok} 个小节 / 跳过 ${skipped} 个 / 失败 ${failed} 个`);
  if (failures.length) {
    say('');
    say('失败与跳过明细：');
    for (const f of failures) say(`  · ${f}`);
  }

  const out = join(PROBE_OUT, 'quiz-bank-report.txt');
  await writeFile(out, lines.join('\n'), 'utf8');
  console.log(`\n→ ${out}`);
}

void main();
