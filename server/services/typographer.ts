/**
 * server/services/typographer.ts —— 规则版「一键排版」。
 *
 * 目标：把从网页 / PDF / 微信里复制出来的乱糟糟的纯文本，整理成结构清晰的 Markdown。
 *
 * ★ 设计取舍：先用规则，不先上 AI ★
 *   规则版的优点是**可预测、零成本、即时、不会瞎编内容**。用户按一下就应该立刻看到结果，
 *   而不是等 10 秒然后担心 AI 改动了原意。
 *   AI 排版作为「规则版不够好」时的可选加强，走另一个接口。
 *
 * 规则清单（按顺序执行）：
 *   1. 统一换行符、清掉行尾空白
 *   2. 去掉 PDF 常见的页眉页脚噪音（纯页码行、重复的页眉）
 *   3. 中文段落里的硬换行合并成一段（避免每行都断成一段）
 *   4. 全角 / 半角空格、制表符规整
 *   5. 中英文之间补空格（可选）
 *   6. 识别疑似标题：短行、无句末标点、前后有空行、编号开头 → 加 ## / ###
 *   7. 识别列表：- / * / • / 1. / 一、/ （1） 统一成标准 Markdown 列表
 *   8. 识别引用：> 开头保持
 *   9. 代码块原样保留（``` 围栏内的内容一律不动）
 *  10. 段落之间保证恰好一个空行
 */

export interface FormatOptions {
  /** 中英文之间插入空格，默认 true */
  spaceBetweenCJKAndLatin?: boolean;
  /** 智能识别标题层级，默认 true */
  detectHeadings?: boolean;
  /** 合并中文段落的硬换行，默认 true */
  joinHardWrappedLines?: boolean;
  /** 去掉疑似页眉页脚，默认 true */
  stripPageNoise?: boolean;
}

const DEFAULTS: Required<FormatOptions> = {
  spaceBetweenCJKAndLatin: true,
  detectHeadings: true,
  joinHardWrappedLines: true,
  stripPageNoise: true,
};

/** 中文标点 + 常用符号。 */
const CJK = '\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\u3000-\\u303f\\uff00-\\uffef';
const CJK_RE = new RegExp(`[${CJK}]`);
const CJK_CHAR = new RegExp(`[${CJK}]`);
const LATIN_CHAR = /[A-Za-z0-9]/;

const sentenceEnd = /[。！？；：.!?;:”"』」）)]\s*$/;
/** 列表项前缀：-, *, •, ·, 1., 1), （1）, 一、, ① */
const listPrefix = /^(\s*)(?:[-*•·]\s+|\d+[.)、]\s*|[（(]\s*\d+\s*[)）]\s*|第[一二三四五六七八九十百]+[条章节]\s*|[一二三四五六七八九十]+[、.]\s*|[①-⑳]\s*)/;
/** 疑似编号标题：1. 2.3 4.1.2 一、 二、 */
const numberedHeading = /^\s*(?:\d+(?:\.\d+)*[.、]?\s+|[第][一二三四五六七八九十百]+[章节部分]\s*|[一二三四五六七八九十]+[、.]\s*)/;
/** 纯页码行 / 页眉页脚特征 */
const pageNumberOnly = /^\s*(?:[-—–\s]*\d{1,4}[-—–\s]*|第\s*\d+\s*页(?:\s*[/共]\s*\d+\s*页)?|Page\s*\d+(?:\s*of\s*\d+)?)\s*$/i;

export interface FormatReport {
  markdown: string;
  changes: { rule: string; count: number }[];
}

export function formatText(input: string, options: FormatOptions = {}): FormatReport {
  const opt = { ...DEFAULTS, ...options };
  const changes: { rule: string; count: number }[] = [];
  const record = (rule: string, count: number) => {
    if (count > 0) changes.push({ rule, count });
  };

  // ── 1. 换行与行尾空白
  let text = input.replace(/\r\n?/g, '\n').replace(/[ \t\u00a0\u3000]+$/gm, '');

  // ── 2. 代码围栏要保护起来：里面的内容一个字都不能动
  const fences: string[] = [];
  text = text.replace(/^```[\s\S]*?^```[ \t]*$/gm, (m) => {
    fences.push(m);
    return `\u0000FENCE${fences.length - 1}\u0000`;
  });

  const lines = text.split('\n');

  // ── 3. 页眉页脚噪音
  let noise = 0;
  let kept: string[] = [];
  // 统计频繁重复的短行（页眉的典型特征：同一行在文中出现很多次）
  const freq = new Map<string, number>();
  for (const l of lines) {
    const t = l.trim();
    if (t && t.length <= 40 && !CJK_RE.test(t.slice(0, 1))) freq.set(t, (freq.get(t) ?? 0) + 1);
  }
  for (const l of lines) {
    const t = l.trim();
    if (opt.stripPageNoise && pageNumberOnly.test(l) && t !== '') {
      noise++;
      continue;
    }
    if (opt.stripPageNoise && t && t.length <= 40 && (freq.get(t) ?? 0) >= 4 && !listPrefix.test(l) && !sentenceEnd.test(t)) {
      noise++;
      continue;
    }
    kept.push(l);
  }
  record('去除页眉页脚/页码', noise);
  const body = kept;

  // ── 4/5. 逐行规整
  let spaced = 0;
  const step1 = body.map((raw) => {
    let l = raw;
    // 制表符 → 四空格（Markdown 里缩进 4 空格是代码块，但正文里的 tab 通常只是排版残留）
    l = l.replace(/\t/g, '    ');
    if (opt.spaceBetweenCJKAndLatin) {
      const before = l;
      // 中文与英文/数字之间补一个空格
      l = l.replace(new RegExp(`([${CJK}])([A-Za-z0-9])`, 'g'), '$1 $2');
      l = l.replace(new RegExp(`([A-Za-z0-9])([${CJK}])`, 'g'), '$1 $2');
      if (l !== before) spaced++;
    }
    return l;
  });
  record('中英文之间补空格', spaced);

  // ── 6. 合并中文段落的硬换行
  let joined = 0;
  let step2: string[] = [];
  if (opt.joinHardWrappedLines) {
    for (let i = 0; i < step1.length; i++) {
      const cur = step1[i];
      const prev = step2[step2.length - 1];
      const curT = cur.trim();
      const prevT = prev === undefined ? '' : prev.trim();
      const canMerge =
        prevT !== '' &&
        curT !== '' &&
        !sentenceEnd.test(prevT) &&
        !isBlockStart(cur) &&
        !isBlockStart(prev) &&
        prevT.length > 12; // 太短的行（标题、列表项）不合并
      if (canMerge) {
        step2[step2.length - 1] = prevT + curT;
        joined++;
      } else {
        step2.push(cur);
      }
    }
  } else {
    step2 = step1;
  }
  record('合并被硬换行截断的中文段落', joined);

  // ── 7. 统一列表标记
  let listFixed = 0;
  let step3 = step2.map((l) => {
    const m = listPrefix.exec(l);
    if (!m) return l;
    const indent = m[1] ?? '';
    const rest = l.slice(m[0].length).trim();
    if (!rest) return l;
    // 已经是标准 markdown 列表就不动
    if (/^\s*[-*+]\s+/.test(l) || /^\s*\d+\.\s+/.test(l)) return l;
    // 转成无序列表（保留缩进层级，2 空格代表一级）
    const level = Math.min(2, Math.floor(indent.replace(/\t/g, '  ').length / 2));
    if (/^\s*\d+[.)]\s/.test(l)) {
      listFixed++;
      return `${'  '.repeat(level)}${l.trim()}`;
    }
    listFixed++;
    return `${'  '.repeat(level)}- ${rest}`;
  });
  record('统一列表标记', listFixed);

  // ── 8. 标题识别
  let heads = 0;
  if (opt.detectHeadings) {
    step3 = step3.map((l, i) => {
      const t = l.trim();
      if (!t || isBlockStart(l)) return l;
      if (t.length > 40) return l;
      if (sentenceEnd.test(t)) return l;
      const prevBlank = i === 0 || (step3[i - 1] ?? '').trim() === '';
      const nextBlank = i === step3.length - 1 || (step3[i + 1] ?? '').trim() === '';
      if (!prevBlank && !nextBlank) return l;
      // 已经是标题
      if (/^#{1,6}\s/.test(t)) return l;

      const isNum = numberedHeading.test(t);
      const looksLikeTitle =
        isNum || /[:：]$/.test(t) || (prevBlank && nextBlank && t.length <= 24 && !/[，,。.]/.test(t));
      if (!looksLikeTitle) return l;
      heads++;
      // 有编号的短行当二级，其余当三级
      return isNum ? `## ${t.replace(numberedHeading, '').trim() || t}` : `### ${t}`;
    });
  }
  record('识别标题', heads);

  // ── 9. 还原代码围栏，并统一空行
  let out = step3.join('\n');
  out = out.replace(/\u0000FENCE(\d+)\u0000/g, (_, i) => fences[Number(i)] ?? '');

  // 段落之间恰好一个空行：3 个以上连续空行压成 1 个
  const blanks = (out.match(/\n{3,}/g) ?? []).length;
  out = out.replace(/\n{3,}/g, '\n\n');
  record('规整段落空行', blanks);

  out = out.trim() + '\n';
  return { markdown: out, changes };
}

/** 判断一行是不是「块的开头」（列表、引用、标题、代码围栏、空行）。 */
function isBlockStart(line: string): boolean {
  const t = line.trim();
  if (t === '') return true;
  return /^(#{1,6}\s|[-*+]\s|\d+\.\s|>\s|```|\|\s|\u0000FENCE)/.test(t);
}

/** 中文文本里「。！？」后面接行的常见情况：用于判断是否是一个完整句子。 */
export function looksLikeCompleteSentence(s: string): boolean {
  return sentenceEnd.test(s.trim());
}

export { CJK_CHAR, LATIN_CHAR };
