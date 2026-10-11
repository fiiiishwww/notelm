/**
 * server/services/questionPool.ts —— 题库派生层（**纯解析，零模型成本**）。
 *
 * ★ 她要的两条（2026-10-07 21:36）★
 *   1. 考频口径 = **标注次数**（不是 distinct 公司数）
 *   2. ★「根据**包含面经的文件**动态变化」⇒ **不能硬编码 `AI-Agent-面经/` 目录**，
 *      必须**按格式识别**：任何 markdown 里长得像面经的节，都会被算进去。
 *      这样她以后把面经放进别的目录、或新增一个面经文件，都自动生效。
 *
 * ★ 为什么是派生而不是落盘事实 ★
 *   题库的唯一事实源是 markdown。`vault.scanTree()` 每次请求实时 readdir（无缓存无 watcher），
 *   所以只要**每次现抽**，面经文件增/删/改都会自动反映到考频上。
 *   落盘的 `questions.json` 只作**带 hash 的缓存**（hash 变即失效），
 *   绝不能变成第二事实源 —— 这条是本项目反复吃过的坑（concepts.json / items 的教训）。
 *
 * ★ 两种题型的判据（都是结构判据，不是路径判据）★
 *   面经型：某个 h2/h1 分节里，`- ` 列表行中**≥60% 带公司标注**
 *          （密度判据，避免把普通笔记里带括号的列表误当面经）
 *   思考题型：h2 标题含「思考题」+ 节内 `N. ★★ 题面` 编号行
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { requireVaultRoot } from '../core';
import { scanTree, type TreeNode } from '../vault';

export type QuestionKind = '面经' | '思考题';

export interface PoolQuestion {
  id: string;
  kind: QuestionKind;
  /** 题面（已剥掉公司括号） */
  q: string;
  /** 公司标注（可能是 0 家，那道题就是通用题） */
  comps: string[];
  /** 面经 = 主题（所属 h2/h1 标题）；思考题 = 所属文件名 */
  topic: string;
  /** 原始文件（相对 notes/，去 .md） */
  rel: string;
  /** 思考题的 ★（只展示，不参与排序 —— 多鱼 2026-10-07 拍过「放弃难度维度」） */
  stars?: number;
}

export interface PoolFile {
  rel: string;
  /** 内容 hash：用于缓存失效判定 */
    hash: string;
    /** 从这个文件里抽出的题数 */
    count: number;
    kind: QuestionKind | '混合' | '无题';
}

export interface QuestionPool {
  questions: PoolQuestion[];
  files: PoolFile[];
  /** 全部来源文件 hash 汇总；变了就说明题库该重算 */
  signature: string;
  computedAt: string;
}

/**
 * ★ 一行是不是「一道面试题」★ —— 这是识别面经节的**主判据**。
 *
 * ★ 为什么不用「带公司标注的比例」★（第一版就是这么写的，错了）
 *   实测 152 道面经题里 **30 道（20%）本来就没有公司标注** ——「08 Agent 手撕代码」
 *   9 道里只有 2 道有。按密度判，那个整节被误判成「不是面经」，直接丢掉 20% 的题。
 *   公司标注是**可选附加信息**，不能当识别特征。
 *
 * 判据只看「像不像一道问句」：`- ` 开头、长度够、结尾是问号。
 * 这样普通笔记的列表项（`- 上下文工程`）不会命中，而无标注的真题会命中。
 */
const QUESTION_LINE = /^\s*-\s+.{10,}?[？?]/;
/** 尾部可有补充说明或公司标注：圆括号 / 全角方括号 / 半角方括号都收 */
const TRAILER = /[（(][^（）()]*[）)]|[［\[][^［］[\]]*[］\]]\s*$/;

/**
 * 从题面尾部剥出公司标注。
 *
 * ★ 为什么要额外判「这是不是公司」★
 *   尾部括号有两种用途：**公司名**（`（字节跳动）`）和**题目补充说明**
 *   （`[给定消息列表和 token 上限，决定保留、摘要还是卸载]`）。
 *   区分靠形态而不是关键词：说明通常**长、带逗号**；公司名是**短名词短语**。
 */
function companyOf(q: string): { q: string; comps: string[] } {
  const m = /^(.*?)\s*[（(]([^（）()]*)[）)]\s*$/.exec(q) ?? /^(.*?)\s*[［\[]([^［］[\]]*)[］\]]\s*$/.exec(q);
  if (!m) return { q, comps: [] };
  const inner = m[2].trim();
  // 形态判据：≤14 字、无句读、无「给定/如下/请/要求/说明」这类说明词
  const looksLikeCompany = inner.length <= 14 && !/[，。；、,;]/.test(inner) && !/^(给定|如下|要求|请|说明|注|例如)/.test(inner);
  if (!looksLikeCompany) return { q, comps: [] };
  const comps = inner
    .split(/[/／]/)
    .map((s) => s.trim())
    .filter(Boolean);
  return { q: m[1].trim(), comps };
}
/** 思考题的编号行：`1. ★★ 题面` */
const NUMBERED_LINE = /^\s*(\d+)\.\s*(★+)?\s*(.+)$/;
/** 一个节至少要有这么多道题才认（防一两行巧合） */
const MIN_PER_SECTION = 3;

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/**
 * 从一个 markdown 文件里抽题。
 *
 * 拆成两步而不是一遍扫完：
 *   ① 先按标题切成「节」，② 再按密度判每节是面经型还是思考题型。
 * 因为面经的判据是**节内密度**，不是单行特征。
 */
export function extractFromMarkdown(
  rel: string,
  markdown: string,
): { questions: PoolQuestion[]; kind: QuestionPool['files'][number]['kind'] } {
  const lines = markdown.split(/\r?\n/);
  interface Section {
    title: string;
    from: number;
  }
  const sections: Section[] = [];
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    const m = /^(#{1,2})\s+(.+)$/.exec(lines[i]);
    if (m) sections.push({ title: m[2].trim(), from: i });
  }
  sections.push({ title: '', from: lines.length });

  const questions: PoolQuestion[] = [];
  const kinds = new Set<QuestionKind>();

  for (let si = 0; si < sections.length - 1; si++) {
    const sec = sections[si];
    const body = lines.slice(sec.from + 1, sections[si + 1].from);
    const topic = sec.title || rel.split('/').pop() || rel;

    // ① 思考题型：标题含「思考题」
    if (/思考题|复习题|自测题/.test(sec.title)) {
      let n = 0;
      for (const L of body) {
        const m = NUMBERED_LINE.exec(L);
        if (!m || !m[3]) continue;
        n++;
        questions.push({
          id: `bk-${rel}-${si}-${m[1]}`,
          kind: '思考题',
          q: m[3].trim(),
          comps: [],
          topic,
          rel,
          stars: m[2] ? m[2].length : 0,
        });
      }
      if (n) kinds.add('思考题');
      continue;
    }

    // ② 面经型：`- ` 列表行里**像面试问句**的条数 ≥ MIN_PER_SECTION
    //    （主判据是「像不像一道问句」，公司标注只作附加信息 —— 见 QUESTION_LINE 的注释）
    const bullets = body.filter((L) => QUESTION_LINE.test(L));
    if (bullets.length < MIN_PER_SECTION) continue;

    for (const L of body) {
      if (!QUESTION_LINE.test(L)) continue;
      // ★ 公司标注要从**整行**剥，不能从 QUESTION_LINE 的捕获组剥 ——
      //   第一版把尾部括号写进正则的捕获组里，结果 group(1) 不含括号，公司全丢了（标注次数全 0）。
      const { q, comps } = companyOf(L.replace(/^\s*-\s+/, '').trim());
      questions.push({
        id: `mj-${rel}-${si}-${questions.length}`,
        kind: '面经',
        q,
        comps,
        topic,
        rel,
      });
    }
    if (questions.some((q) => q.rel === rel && q.topic === topic)) kinds.add('面经');
  }

  const kind: QuestionPool['files'][number]['kind'] = kinds.size === 0 ? '无题' : kinds.size > 1 ? '混合' : [...kinds][0];
  return { questions, kind };
}

/**
 * 扫全库抽题。**每次现抽** —— 面经文件变了，下一次调用就变。
 *
 * 扫描范围 = vault 里全部 markdown（`scanTree` 实时 readdir），
 * 但只抽「命中题型判据」的节，所以普通笔记不会进来。
 */
export async function scanQuestionPool(opts?: { root?: string }): Promise<QuestionPool> {
  const root = opts?.root ?? (await requireVaultRoot());
  const tree = await scanTree();

  // `scanTree` 每次请求实时 readdir（无缓存无 watcher）⇒ 新增/删除面经文件这里就自动看得到
  const rels: string[] = [];
  const walk = (n: TreeNode) => {
    for (const c of n.children ?? []) {
      if (c.type === 'dir') walk(c);
      else if (c.relPath.endsWith('.md')) rels.push(c.relPath);
    }
  };
  walk(tree);

  const questions: PoolQuestion[] = [];
  const files: PoolFile[] = [];
  const hashes: string[] = [];

  for (const rel of rels) {
    let md: string;
    try {
      md = readFileSync(join(root, rel), 'utf8');
    } catch {
      continue;
    }
    const hash = sha256(md);
    hashes.push(`${rel}:${hash.slice(0, 12)}`);
    // 先判一下这个文件有没有可能含题，省掉无题文件的解析开销
    if (!/^\s*-\s+.{10,}?[？?]/m.test(md) && !/^#{1,2}\s+.*(?:思考题|复习题|自测题)/m.test(md)) {
      files.push({ rel, hash, count: 0, kind: '无题' });
      continue;
    }
    const r = extractFromMarkdown(rel, md);
    if (!r.questions.length) {
      files.push({ rel, hash, count: 0, kind: '无题' });
      continue;
    }
    questions.push(...r.questions);
    files.push({ rel, hash, count: r.questions.length, kind: r.kind });
  }

  return {
    questions,
    files: files.filter((f) => f.count > 0),
    signature: sha256(hashes.sort().join('\n')),
    computedAt: new Date().toISOString(),
  };
}
