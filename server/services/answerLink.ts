/**
 * server/services/answerLink.ts —— 思考题「答案见」的程序配对（2026-09-22，B1-2）。
 *
 * ★ 为什么必须是程序、不能是模型 ★
 *   树是**单节调用**：模型只看得到这一节的正文，看不到同一文档的其它节、
 *   更看不到隔壁的参考答案文件。它根本无从知道「这道题的答案在哪一块」。
 *   所以这个关系只能由程序建立——符合「凡结构硬要求必须程序收编」的铁律。
 *
 * 配对策略（宁缺勿错）：
 *   1. 在同目录找参考答案文件（reference-answers / 参考答案 / 答案 前缀的 .md）；
 *   2. 用与正文**同一套切块器**（analyzeDocument）切答案文件——保证块号与前端
 *      data-bi 一致，跳过去才能真的落在答案上；
 *   3. 主键 = 章号 + 题号（确定性）；题干做**宽容的**前缀/相似度校验——
 *      书里答案文件的题面与正文偶有措辞微调，校验只用于拦截「题号对不上位」的
 *      粗心错位，不追求完全一致；
 *   4. 任何一步不确定就不连。错连比不连糟得多：不连是少一条边（看得见、能补），
 *      错连是把人送到错误的答案面前。
 *
 * 落点：**渲染侧**（同 ctx.xrefs 的 L3 模式）。不写进 tree JSON——零重跑、
 * 不引入第二事实源、答案文件更新后重开页面即生效。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { analyzeDocument } from '../../shared/blocks';
import { dice, type Block } from '../../shared/text';
import { requireVaultRoot } from '../core';

/** 一条可跳转的配对：题目块号 → 参考答案文件里的答案块。 */
export interface AnswerRow {
  chapter: number;
  no: number;
  /** 答案文件里的题面（校验与提示用） */
  stem: string;
  answerRel: string;
  answerBi: number;
}

// ─────────────────────── 中文数字 ───────────────────────

const CN_DIGIT: Record<string, number> = {
  零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

/** 「第一章」「第十章」「第十二章」「第二十一章」 → 1 / 10 / 12 / 21。解析失败返回 null。 */
export function cnChapterNum(s: string): number | null {
  const m = s.replace(/\s+/g, '').match(/^第([一二三四五六七八九十零]+)章/);
  if (!m) return null;
  const cn = m[1];
  if (cn === '十') return 10;
  const ten = cn.indexOf('十');
  if (ten === -1) return CN_DIGIT[cn] ?? null;
  const head = cn.slice(0, ten);
  const tail = cn.slice(ten + 1);
  const tens = head ? CN_DIGIT[head] ?? 0 : 1;
  const ones = tail ? CN_DIGIT[tail] ?? 0 : 0;
  return tens * 10 + ones || null;
}

// ─────────────────────── 找参考答案文件 ───────────────────────

/** 同目录下文件名以 reference-answers / 参考答案 / 答案 开头的 .md。找不到返回 null。 */
export async function findAnswersDoc(docRel: string): Promise<string | null> {
  const root = await requireVaultRoot();
  const dir = path.dirname(path.join(root, docRel));
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  const hit = names.find(
    (n) => n.toLowerCase().endsWith('.md') && /^(reference-answers|参考答案|答案)/i.test(n),
  );
  if (!hit) return null;
  const abs = path.join(dir, hit);
  return path.relative(root, abs).replace(/\\/g, '/');
}

// ─────────────────────── 解析答案文件 ───────────────────────

interface ParsedAnswers {
  rows: AnswerRow[];
  /** 解析时的文件指纹，用于缓存失效 */
  stamp: string;
  /** 解析过程中发现的结构问题（探针用） */
  warnings: string[];
}

const parseCache = new Map<string, ParsedAnswers>();

const QUESTION_RE = /^(\d{1,2})\s*[.、．]\s*[(（]?\s*★/;

/** 文本里的题面（去掉题号/星级后），用于与正文侧的题干做校验。 */
function stemOf(text: string): string {
  return stemText(text);
}

/**
 * 解析参考答案文档。结构约定（reference-answers.md 实测）：
 *   `## 第N章 XXX` → 章号；`N. (★★★) 题干` → 题号；紧随其后的引用块 → 答案。
 * 块号来自 analyzeDocument——与正文同一套切块器，前端打开该文件时 data-bi 一致。
 */
export async function parseAnswersDoc(rel: string): Promise<ParsedAnswers> {
  const root = await requireVaultRoot();
  const abs = path.join(root, rel);
  const st = statSync(abs);
  const stamp = `${st.mtimeMs}:${st.size}`;
  const cached = parseCache.get(rel);
  if (cached && cached.stamp === stamp) return cached;

  const markdown = readFileSync(abs, 'utf8');
  const { blocks } = analyzeDocument(markdown);
  const rows: AnswerRow[] = [];
  const warnings: string[] = [];

  let chapter: number | null = null;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    // 章标题：`## 第一章 AI Agent 入门`（text 是归一化后的标题文本）
    if (/^h[1-6]$/.test(b.type)) {
      const cn = cnChapterNum(b.text);
      if (cn != null) chapter = cn;
      continue;
    }
    const qm = b.text.match(QUESTION_RE);
    if (!qm || chapter == null) continue;
    const no = Number(qm[1]);
    // 答案块 = 题面之后、下一个题面/标题之前的第一个非空块（引用块切出来是 p/depth≥1）
    let answerBi: number | null = null;
    for (let j = i + 1; j < blocks.length; j++) {
      const nb = blocks[j];
      if (/^h[1-6]$/.test(nb.type) || QUESTION_RE.test(nb.text)) break;
      if (nb.text.trim().length >= 10) {
        answerBi = nb.bi;
        break;
      }
    }
    if (answerBi == null) {
      warnings.push(`第${chapter}章第${no}题：题面后面没找到答案块`);
      continue;
    }
    rows.push({ chapter, no, stem: stemOf(b.text), answerRel: rel, answerBi });
  }

  const parsed: ParsedAnswers = { rows, stamp, warnings };
  parseCache.set(rel, parsed);
  return parsed;
}

// ─────────────────────── 当前文档侧 ───────────────────────

/** 当前文档是第几章：优先文件名（chapter1.md），其次第一个「第N章」标题。 */
export function chapterNoOfDoc(docRel: string, blocks: Block[]): number | null {
  const base = docRel.replace(/^.*\//, '');
  const fm = base.match(/chapter(\d+)/i);
  if (fm) return Number(fm[1]);
  for (const b of blocks) {
    if (/^h[1-6]$/.test(b.type)) {
      const cn = cnChapterNum(b.text);
      if (cn != null) return cn;
    }
  }
  return null;
}

/** 题目所在的节：标题链里出现这些词才算（防止正文里偶尔的 ★ 列表被误当题目）。 */
const QUESTION_SECTION_RE = /思考题|习题|练习|讨论/;

/** 题面清洗：去题号、星级、括号、引号、空白——两边各洗一遍再比。 */
function stemText(text: string): string {
  return text
    .replace(/^\s*[(（]?/, '')
    .replace(/^(\d{1,2})\s*[.、．]\s*/, '')
    .replace(/^[(（]?/, '')
    .replace(/[★()\s"“”「」]+/g, '')
    .replace(/^[)）]/, '')
    .trim();
}

/** 宽容校验：前 10 字相同，或 bigram dice ≥ 0.4。只拦「题号错位」的粗心错，不求逐字一致。 */
function stemsMatch(a: string, b: string): boolean {
  const x = a.replace(/[，。；：？！、?!;:,.]/g, '');
  const y = b.replace(/[，。；：？！、?!;:,.]/g, '');
  if (!x || !y) return false;
  const k = Math.min(10, x.length, y.length);
  if (x.slice(0, k) === y.slice(0, k)) return true;
  return dice(x.slice(0, 40), y.slice(0, 40)) >= 0.4;
}

export interface DocQuestion {
  bi: number;
  /** 题号：块文本里带编号就用显式的；列表切块会剥掉序号，就用节内顺序还原 */
  no: number;
  stem: string;
  section: string;
}

/**
 * 找出文档里的思考题块。
 *
 * ★ 为什么题号要用节内顺序还原 ★ 实测 chapter1：思考题是有序列表，切块后每个
 * `li` 的 text **不带序号**（`1. ` 是列表标记，被剥掉了），文本直接以 ★ 开头。
 * 所以题号 = 该节内第几个以 ★ 开头的块（0 模型调用、确定性）。
 * 显式写了编号的格式（如答案文件的 `**1. (★★) …**`）优先用显式编号。
 */
export function listDocQuestions(blocks: Block[]): DocQuestion[] {
  const out: DocQuestion[] = [];
  let inQuestionSection = false;
  let ordinal = 0;
  for (const b of blocks) {
    if (/^h[1-6]$/.test(b.type)) {
      const pathHit = (b.headingPath ?? []).some((h) => QUESTION_SECTION_RE.test(h));
      inQuestionSection = pathHit || QUESTION_SECTION_RE.test(b.text);
      ordinal = 0;
      continue;
    }
    if (!inQuestionSection) continue;
    if (!/^\s*[(（]?★/.test(b.text)) continue;
    ordinal += 1;
    const explicit = b.text.match(/^(\d{1,2})\s*[.、．]\s*[(（]?\s*★/);
    const no = explicit ? Number(explicit[1]) : ordinal;
    out.push({ bi: b.bi, no, stem: stemText(b.text), section: (b.headingPath ?? []).join(' > ') });
  }
  return out;
}

/**
 * 为一篇文档构建「题目块号 → 答案」索引。
 *
 * 只连同时满足三件事的题：① 当前文档能确定章号 ② 答案文件里有同章同号的题
 * ③ 两边题面宽容校验通过。任何一步不满足就不连（宁可少一条边）。
 */
export async function buildAnswerIndexForDoc(
  docRel: string,
  blocks: Block[],
): Promise<Map<number, AnswerRow>> {
  const map = new Map<number, AnswerRow>();
  const answersRel = await findAnswersDoc(docRel);
  if (!answersRel || answersRel === docRel) return map;
  const myChapter = chapterNoOfDoc(docRel, blocks);
  if (myChapter == null) return map;

  let rows: AnswerRow[];
  try {
    rows = (await parseAnswersDoc(answersRel)).rows;
  } catch {
    return map;
  }
  const byNo = new Map(rows.filter((r) => r.chapter === myChapter).map((r) => [r.no, r]));
  if (byNo.size === 0) return map;

  for (const q of listDocQuestions(blocks)) {
    const row = byNo.get(q.no);
    if (!row) continue;
    if (!stemsMatch(q.stem, row.stem)) continue;
    map.set(q.bi, row);
  }
  return map;
}
