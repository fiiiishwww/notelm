/**
 * server/services/cheatsheetRender.ts —— 小抄的呈现层。
 *
 * ★ 这一层全是纯函数，一个模型调用都没有 ★
 *
 * 三件事：
 *   1. `groupByOutline`  把条目按**原文自己的子标题**归组
 *   2. `renderMarkdown`  按分组渲染成逐级 markdown
 *   3. `parseMarkdown`   反解析旧 sidecar（那时候只存了 markdown）
 *
 * ★ 为什么分层不用 AI 聚类 ★
 *   chapter2 里 `## KV Cache 友好的上下文设计` 底下本来就有 5 个 `###` 子标题，
 *   而 Chapter 带 `bi` / `endBi`、条目带引文能定位到 `bi` —— 所以「这条属于哪个子标题」
 *   是**查表**：零 LLM、零漂移、可单测，组名还正好是原文标题（读小抄 ≈ 读目录）。
 *   让模型起主题名的方案被否掉，就是因为它每次重跑组名都会变，而且会自造抽象词。
 *
 *   实测 chapter2（402 条目 / 10 节）：有子标题的 6 节共 255 条，
 *   229 条（90.2%）明确归入某个 h3，平均每节 3.3 组。
 */

import {
  dice,
  itemKeyOf,
  termsToMerge,
  type Block,
  type Chapter,
  type CheatsheetDropped,
  type CheatsheetEntry,
  type CheatsheetItems,
  type CheatsheetProposition,
  type EntryKind,
  type RelationKind,
  type StudyUnit,
} from '../../shared/text';
import { validateQuote } from './anchor';

/** 归组结果。一个组 = 原文的一个子标题。 */
export interface CheatsheetGroup {
  /** 组标题：原文子标题的文字；两端兜底组为「导言」「补充」 */
  title: string;
  /**
   * outline = 原文子标题
   * intro   = 落在 h2 标题与首个 h3 之间的导言段
   * extra   = 引文越出本节（引用了后面章节的原文），或干脆定位不到
   */
  kind: 'outline' | 'intro' | 'extra';
  propositions: CheatsheetProposition[];
  entries: CheatsheetEntry[];
}

const MAX_BI = Number.MAX_SAFE_INTEGER;

/** 引文 → 块号。定位不到返回 null（条目保留，只是不能回跳）。 */
function locate(quote: string, blocks: Block[]): number | null {
  const q = (quote ?? '').trim();
  if (q.length < 2) return null;
  return validateQuote(q, blocks)?.blockIndex ?? null;
}

/**
 * 给还没算过块号的条目补上 bi。落盘时跑一次，之后归组/渲染/跳转都白拿。
 *
 * `recomputeTermQuote`：连术语的引文也重算。
 *   正常情况不重算 —— 模型给的引文比程序找的准。但反解析来的旧数据**没有**模型引文
 *   （老格式的术语行里没有反引号），第一遍是程序补的；这时候改了「怎么找引文」的规则，
 *   就得让它重算，否则新的规则永远套不上去。
 */
export function attachBlockIndex(
  items: CheatsheetItems,
  blocks: Block[],
  opts: { recomputeTermQuote?: boolean } = {},
): CheatsheetItems {
  return {
    ...items,
    propositions: (items.propositions ?? []).map((p) =>
      p.bi == null ? { ...p, bi: locate(p.quote, blocks) ?? undefined } : p,
    ),
    entries: (items.entries ?? []).map((e) =>
      e.bi == null ? { ...e, bi: locate(e.quote, blocks) ?? undefined } : e,
    ),
    terms: (items.terms ?? []).map((t) => {
      const name = (t.term ?? '').trim();
      if (!name) return t;
      if (t.quote && !opts.recomputeTermQuote) return t;
      return { ...t, quote: termQuote(name, t.meaning ?? '', blocks) };
    }),
  };
}

/**
 * 术语的引文：模型给不出时，回原文找它**首次出现的那一句**。
 *
 * ★ 为什么这件事可以交给程序、而不是再问一次模型 ★
 *   术语的定义就是「原文里出现过的专名」——找它的位置是确定性的。
 *   实测 chapter2 的 111 条术语**一条都没有引文**（结构里就没这个字段），
 *   于是 0% 能回跳原文。这里补上之后，术语才配留在小抄里。
 */
/** 导览句：提到了术语，但只是指路（"……是后续讨论的基础"），没有解释它。 */
const NAV_SENTENCE = /后续|后文|下文|详见|见本节|下一节|稍后|后面会|本章第|前面提到/;

/**
 * 术语的引文：回原文找「真正在讲这个术语」的那一句。
 *
 * ★ 为什么不取「术语名第一次出现的那句」★
 *   实测踩了两次：第一次取到导览句（"……是后续讨论 KV Cache 优化的基础"），
 *   第二次取到实验步骤（"KV Cache 的影响（顺带留意）：保持系统提示词不变……"）。
 *   术语名出现在哪句话、和哪句话在解释它，是两件事。
 *
 * 所以改成：把**所有**含这个术语名的句子收起来当候选，用术语自己的释义去打分
 * （字符二元组重合度），导览句额外扣分 —— 取分最高的那句。
 * 释义是模型写的，正好可以当「这句话应该长什么样」的探针。
 */
export function termQuote(term: string, meaning: string, blocks: Block[]): string {
  const t = (term ?? '').trim();
  if (t.length < 2) return '';
  const cands: string[] = [];
  for (const b of blocks) {
    let from = 0;
    for (;;) {
      const idx = b.text.indexOf(t, from);
      if (idx < 0) break;
      const s = sentenceAround(b.text, idx, t.length);
      if (s && !cands.includes(s)) cands.push(s);
      from = idx + t.length;
    }
  }
  if (!cands.length) return '';

  const m = (meaning ?? '').trim();
  const clean = cands.filter((s) => !NAV_SENTENCE.test(s));
  if (!m) return clean[0] ?? cands[0];

  let best = clean[0] ?? cands[0];
  let bestScore = -1;
  for (const s of cands) {
    // 与释义越像越可能是「在解释它」的那句；导览句再压一点
    const score = dice(s, m) - (NAV_SENTENCE.test(s) ? 0.15 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return best;
}

/** 取 text 里 [idx, idx+len) 所在的那一句（按中文句读切）。 */
function sentenceAround(text: string, idx: number, len: number): string {
  const isBreak = (ch: string) => '。！？；\n'.includes(ch);
  let s = idx;
  while (s > 0 && !isBreak(text[s - 1])) s--;
  let e = idx + len;
  while (e < text.length && !isBreak(text[e])) e++;
  const out = text.slice(s, e).trim();
  if (out.length >= 4) return out;
  return text.slice(idx, Math.min(text.length, idx + 60)).trim();
}

/**
 * 把术语层并进速查区的【定义】（2026-09-17 拍板）。
 *
 * ★ 为什么并进来 ★
 *   术语占 chapter2 条目的 27.6%（111/402），却 0% 能回跳原文；释义平均 49 字，
 *   跟命题陈述上限（60 字）几乎一样长，同节内还重名 8 个（KV Cache 出现 6 次）。
 *   它和【定义】本来就是一回事，差别只是退掉了引文和关系词 ——
 *   也就是「没有关联的关键信息」，恰好是要解决的问题。并进来之后：
 *   条目数 −27.6%、可回跳率补到 100%、术语名留在 `term` 字段上照样能查。
 *
 * 去重判据（确定性）：某个术语名已经出现在任一【定义】条目的正文里 → 不再单独出条。
 */
export function mergeTermsIntoEntries(items: CheatsheetItems, blocks: Block[]): CheatsheetEntry[] {
  const entries = items.entries ?? [];
  const out: CheatsheetEntry[] = [...entries];
  // 去重判据在 shared/text.ts 的 termsToMerge —— 前端的类型统计要用同一份
  for (const t of termsToMerge(items)) {
    const name = (t.term ?? '').trim();
    const quote = (t.quote ?? '').trim() || termQuote(name, t.meaning ?? '', blocks);
    out.push({
      kind: '定义',
      text: `${name}：${(t.meaning ?? '').trim()}`,
      quote,
      term: name,
      bi: quote ? (locate(quote, blocks) ?? undefined) : undefined,
      // ★ 标注状态要跟着条目走：标在术语层，回显也在术语层（见 /cheatsheet/feedback）
      ...(t.feedback ? { feedback: t.feedback } : {}),
    });
  }
  return out;
}

/** 待渲染的一行：命题或速查，按原文位置混排。 */
interface Row {
  bi: number;
  order: number;
  quote: string;
  p?: CheatsheetProposition;
  e?: CheatsheetEntry;
}

/** 组内按原文位置排。没有块号的排到最后（通常是引文定位不到的条目）。 */
function rowsOf(g: CheatsheetGroup): Row[] {
  const rows: Row[] = [
    ...g.propositions.map((p, i) => ({ bi: p.bi ?? MAX_BI, order: i, quote: p.quote ?? '', p })),
    ...g.entries.map((e, i) => ({ bi: e.bi ?? MAX_BI, order: i, quote: e.quote ?? '', e })),
  ];
  rows.sort((a, b) => a.bi - b.bi || a.order - b.order);
  return rows;
}

/**
 * 把条目按原文子标题归组。
 *
 * 环节没有子标题（比如「本章小结」「思考题」）时不强行分组 ——
 * 只有一组、且组名为空，渲染层会退回「命题 / 速查」两分区。
 */
export function groupByOutline(args: {
  items: CheatsheetItems;
  unit: StudyUnit;
  chapters: Chapter[];
  blocks: Block[];
}): CheatsheetGroup[] {
  const { unit, chapters, blocks } = args;
  const props = args.items.propositions ?? [];
  const entries = mergeTermsIntoEntries(args.items, blocks);

  const subs = chapters.filter(
    (c) => c.level > unit.level && c.bi >= unit.startBi && c.bi < unit.endBi,
  );

  if (!subs.length) {
    return [{ title: '', kind: 'outline', propositions: props, entries }];
  }

  const intro: CheatsheetGroup = { title: '导言', kind: 'intro', propositions: [], entries: [] };
  const extra: CheatsheetGroup = { title: '补充', kind: 'extra', propositions: [], entries: [] };
  const buckets = new Map<string, CheatsheetGroup>();
  for (const c of subs) {
    buckets.set(c.headingId, { title: c.text, kind: 'outline', propositions: [], entries: [] });
  }

  const first = subs[0];
  const put = (item: CheatsheetProposition | CheatsheetEntry, isProp: boolean) => {
    const bi = item.bi;
    let target: CheatsheetGroup;
    if (typeof bi !== 'number') {
      target = extra;
    } else if (bi < first.bi) {
      target = intro;
    } else {
      const hit = subs.find((c) => bi >= c.bi && bi < c.endBi);
      target = hit ? buckets.get(hit.headingId)! : extra;
    }
    if (isProp) target.propositions.push(item as CheatsheetProposition);
    else target.entries.push(item as CheatsheetEntry);
  };
  for (const p of props) put(p, true);
  for (const e of entries) put(e, false);

  const out: CheatsheetGroup[] = [];
  if (intro.propositions.length || intro.entries.length) out.push(intro);
  for (const c of subs) {
    const g = buckets.get(c.headingId)!;
    if (g.propositions.length || g.entries.length) out.push(g);
  }
  if (extra.propositions.length || extra.entries.length) out.push(extra);
  return out;
}

/** ★ 原文是提问的标记串 ★ 渲进 markdown 投影，解析时按前缀剥回 fromQuestion 字段。 */
const Q_MARK = '（原文提问）';

/** 剥掉 Q_MARK 前缀。渲染与反解析必须闭合，否则 markdown 绕一圈回来会污染 text。 */
function stripQMark(s: string): { text: string; q: boolean } {
  const t = (s ?? '').trim();
  const hit = t.startsWith(Q_MARK);
  return { text: hit ? t.slice(Q_MARK.length).trim() : t, q: hit };
}

/** 一层条目行 → markdown（命题带「为什么」子行）。 */
function propLines(p: CheatsheetProposition): string[] {
  const q = p.quote ? ` \`${p.quote}\`` : '';
  const lines = [
    `- **${p.subject}** —${p.rel}→ **${p.object}** —— ${p.fromQuestion ? Q_MARK : ''}${p.statement}${q}`,
  ];
  if (p.why) lines.push(`  - 为什么：${p.why}`);
  return lines;
}

function entryLine(e: CheatsheetEntry): string {
  const q = e.quote ? ` \`${e.quote}\`` : '';
  return `- 【${e.kind}】${e.fromQuestion ? Q_MARK : ''}${e.text}${q}`;
}

/**
 * 渲染成逐级 markdown。
 *
 * 有子标题 → 每个子标题一个 `###`，组内按原文位置混排命题和速查
 * （混排而不是分区，是为了保住位置感：读完一组 ≈ 读完原文那一小段）。
 * 没有子标题 → 退回「命题 / 速查」两分区，跟以前的形态一致。
 */
export function renderGroupedMarkdown(args: {
  items: CheatsheetItems;
  groups: CheatsheetGroup[];
}): string {
  const { items, groups } = args;
  const out: string[] = [];
  if (items.focus) out.push(`**焦点问题**：${items.focus}`);
  if (items.gist) out.push(`**一句话**：${items.gist}`);

  const flat = groups.length === 1 && !groups[0].title;
  if (flat) {
    const g = groups[0];
    if (g.propositions.length) {
      out.push('', '**命题**');
      for (const p of g.propositions) out.push(...propLines(p));
    }
    if (g.entries.length) {
      out.push('', '**速查**');
      for (const e of g.entries) out.push(entryLine(e));
    }
    return out.join('\n');
  }

  for (const g of groups) {
    const rows = rowsOf(g);
    if (!rows.length) continue;
    out.push('', `### ${g.title}`);
    for (const r of rows) {
      if (r.p) out.push(...propLines(r.p));
      else if (r.e) out.push(entryLine(r.e));
    }
  }
  return out.join('\n');
}

// ─────────────────────────── 专用 HTML 渲染（面板呈现用） ───────────────────────────

/** 转义：这里的内容全部来自模型输出和原文，必须当不可信文本处理。 */
function esc(s: string): string {
  return (s ?? '').replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}

/** 速查条目的徽章配色（见 theme.css 的 .k-*）。 */
const KIND_CLASS: Record<string, string> = {
  定义: 'k-def',
  等式: 'k-eq',
  数值: 'k-num',
  类比: 'k-ana',
  清单: 'k-lst',
};

/** 关系词分三族配色：因果 / 对比 / 结构。闭集外的会落到 f-warn，一眼能看出不对劲。 */
const REL_CLASS: Record<string, string> = {
  导致: 'f-cause',
  用于解决: 'f-cause',
  前提是: 'f-cause',
  区别于: 'f-contrast',
  优于: 'f-contrast',
  例外: 'f-contrast',
  属于: 'f-struct',
  等价: 'f-struct',
};

function itemLi(r: Row, hl?: Map<number, string>, binReason?: string): string {
  const loc =
    (r.bi != null ? ` data-bi="${r.bi}"` : '') + (r.quote ? ` data-q="${esc(r.quote)}"` : '');
  // ★ 「这条来自你的标注」要看得见 ★
  //   条目引文落在用户高亮块上时，给一颗对应颜色的小圆点——
  //   「小抄以你的标注为纲」是产品承诺，光写在文案里不算数。
  //   点整条本来就会跳回原文，圆点跟着走同一个 data-bi，不加新交互。
  const dot =
    hl && r.bi != null && hl.has(r.bi)
      ? `<i class="hl-dot hl-c-${esc(hl.get(r.bi) ?? '')}" title="来自你的高亮"></i>`
      : '';
  // ★ 反馈三件套：常驻，不靠 hover ★
  //   用户会连点几十条，hover 才出现等于每次多一个动作（触屏上更是根本没有 hover）。
  //   ik 是内容 hash（不落盘、渲染时现算），服务端据此把标注写回对应条目。
  const fb = r.p?.feedback ?? r.e?.feedback;
  const ik = ` data-ik="${itemKeyOf((r.p?.statement ?? r.e?.text ?? '').trim())}"`;
  const fbAttr = fb ? ` data-fb="${esc(fb.mark)}"` : '';
  const fbWhy = fb?.why ? ` data-fbwhy="${esc(fb.why)}"` : '';
  // ★ 回收站条目：裁决理由挂在条目上，样式压暗（见 theme.css 的 .ci.dropped）★
  const binCls = binReason ? ' dropped' : '';
  const binAttr = binReason ? ` data-reason="${esc(binReason)}"` : '';
  const fbHtml =
    `<span class="fb"><b data-mark="up" title="有用">▲</b>` +
    `<b data-mark="down" title="反馈（可填理由）">▽</b>` +
    `<b data-mark="dup" title="和别条重复">⧉</b></span>`;
  // ★ R2 徽章：原文在提问，这条是模型给出的表述，不是原文的结论 ★
  //   思考题节 5/5 命中这类失真；这里不替用户决定它有没有用，只把事实标出来。
  const qm =
    (r.p?.fromQuestion || r.e?.fromQuestion)
      ? `<i class="badge q" title="原文是疑问句，这条是模型给出的表述，不是原文的结论">?</i>`
      : '';
  if (r.p) {
    const p = r.p;
    const cls = REL_CLASS[p.rel] ?? 'f-warn';
    const why = p.why ? ` data-why="${esc(p.why)}"` : '';
    const stmt = p.statement ? `<span class="st">${esc(p.statement)}</span>` : '';
    return (
      `<li class="ci prop${binCls}"${loc}${why}${ik}${fbAttr}${fbWhy}${binAttr}><span class="badge rel ${cls}">${esc(p.rel)}</span>` +
      `<span class="tx"><b>${esc(p.subject)}</b><span class="arr">→</span><b>${esc(p.object)}</b>${stmt}</span>` +
      `${qm}${dot}<span class="jump" aria-hidden="true">↗</span>${fbHtml}</li>`
    );
  }
  const e = r.e!;
  const cls = KIND_CLASS[e.kind] ?? 'k-def';
  return (
    `<li class="ci${binCls}"${loc} data-kind="${esc(e.kind)}"${ik}${fbAttr}${fbWhy}${binAttr}><span class="badge ${cls}">${esc(e.kind)}</span>` +
    `<span class="tx">${esc(e.text)}</span>${qm}${dot}<span class="jump" aria-hidden="true">↗</span>${fbHtml}</li>`
  );
}

function groupHtml(g: CheatsheetGroup, hl?: Map<number, string>): string {
  const rows = rowsOf(g);
  if (!rows.length) return '';
  const lis = rows.map((r) => itemLi(r, hl)).join('');
  if (!g.title) return `<ul class="cheat-list">${lis}</ul>`;
  return (
    `<details class="cheat-grp" open><summary class="cheat-grp-h">` +
    `<span class="t">${esc(g.title)}</span><span class="n">${rows.length}</span></summary>` +
    `<ul class="cheat-list">${lis}</ul></details>`
  );
}

/**
 * 面板里真正渲染的 HTML —— 和 markdown 各干各的，别混。
 *
 * ★ 为什么不再走 markdown-it ★
 *   徽章、折叠组、悬停「为什么」、整条可点，这些都需要带语义的标签和 data 属性；
 *   markdown 的行内语法表达不了，硬塞原始 HTML 又会被 createMd 的 html:false 转义。
 *   所以小抄的 html 由这里直接产出：所有文本过 esc()，安全性等价于转义。
 *   markdown 快照保留，给探针、复制、diff 用。
 *
 * ★ 引文为什么不在正文里 ★
 *   实测 chapter3：行尾引文占可见字符的 32.5%，而内容和前面的陈述几乎一字不差。
 *   引文本来的用途是「跳回原文」，不是「再读一遍」—— 所以它变成条目上的 data-q /
 *   data-bi，整条可点；hover 右缘出现 ↗ 提示可跳。
 */
export function renderSectionHtml(args: {
  items: CheatsheetItems;
  groups: CheatsheetGroup[];
  /** 块号 → 高亮颜色；引文落在高亮块上的条目会带一颗对应颜色的小圆点 */
  hl?: Map<number, string>;
  /** ★ 被裁条目回收站 ★ 折叠区放在节末，▲ 复活 / ▽⧉ 确认裁决 */
  dropped?: CheatsheetDropped[];
}): string {
  const { items, groups, hl } = args;
  const out: string[] = ['<div class="cheat">'];
  if (items.gist || items.focus) {
    out.push('<div class="cheat-head">');
    if (items.gist) out.push(`<p class="cheat-gist">${esc(items.gist)}</p>`);
    if (items.focus) out.push(`<p class="cheat-focus">焦点：${esc(items.focus)}</p>`);
    out.push('</div>');
  }
  const flat = groups.length === 1 && !groups[0].title;
  if (flat) {
    out.push(groupHtml(groups[0], hl));
  } else {
    for (const g of groups) out.push(groupHtml(g, hl));
  }
  // ★ 回收站 ★
  //   为什么折叠：它是「合并层觉得不该记」的东西，默认不该打扰正文；
  //   为什么展示：裁得对不对以前没有裁判，现在用户标 ▲ 就复活、▽/⧉ 就是确认。
  const bin = args.dropped ?? [];
  if (bin.length) {
    const lis = bin
      .map((d) => {
        if (d.layer === '命题') {
          const p = d.item as CheatsheetProposition;
          return itemLi({ bi: MAX_BI, order: 0, quote: p.quote ?? '', p }, undefined, d.reason);
        }
        if (d.layer === '条目') {
          const e = d.item as CheatsheetEntry;
          return itemLi({ bi: MAX_BI, order: 0, quote: e.quote ?? '', e }, undefined, d.reason);
        }
        // 术语：渲染时本来会被 mergeTermsIntoEntries 并成【定义】，回收站里
        // 同样按定义条目的样子画，ik 才能和标注路由的术语匹配规则对上
        const t = d.item as { term?: string; meaning?: string; quote?: string };
        const text = `${(t.term ?? '').trim()}：${(t.meaning ?? '').trim()}`;
        return itemLi(
          { bi: MAX_BI, order: 0, quote: t.quote ?? '', e: { kind: '定义' as EntryKind, text, quote: t.quote ?? '' } },
          undefined,
          d.reason,
        );
      })
      .join('');
    out.push(
      `<details class="cheat-bin"><summary><span class="t">被裁 ${bin.length} 条</span>` +
        `<span class="h">裁错了？点 ▲ 复活</span></summary>` +
        `<ul class="cheat-list">${lis}</ul></details>`,
    );
  }
  out.push('</div>');
  return out.join('');
}


// ─────────────────────────── 反解析（旧数据迁移） ───────────────────────────

/** 拆出「行尾的行内代码」当作引文。取最后一个，因为正文里也可能出现反引号。 */
function splitQuote(body: string): { text: string; quote: string } {
  const m = /`([^`\n]+)`\s*$/.exec(body);
  if (!m) return { text: body.trim(), quote: '' };
  return { text: body.slice(0, m.index).trim(), quote: m[1].trim() };
}

/**
 * 从渲染好的小抄 markdown 反解析回结构化条目。
 *
 * ★ 为什么需要它 ★
 *   在「条目落盘」之前生成的小抄，sidecar 里只有 markdown。
 *   反解析让这批数据**零成本**享受新呈现（分层、术语合并），不用重跑模型。
 *   实测 chapter2：命题 99.4%、速查 100% 能被完整解析回来。
 *
 * 只认我们自己渲染的格式（命题 / 速查 / 术语 / 焦点问题），
 * 认不出的行直接跳过 —— 所以调用方应该拿「解析出的条数」跟原文条目数对一下，
 * 差太多就别写回（宁可保持旧样，也不要把数据弄丢）。
 */
export function parseCheatsheetMarkdown(markdown: string): CheatsheetItems {
  const items: CheatsheetItems = { focus: '', gist: '', propositions: [], entries: [], terms: [] };
  let last: CheatsheetProposition | null = null;

  for (const raw of (markdown ?? '').split('\n')) {
    const line = raw.trimEnd();

    if (/^\*\*焦点问题\*\*[：:]/.test(line)) {
      items.focus = line.replace(/^\*\*焦点问题\*\*[：:]\s*/, '').trim();
      continue;
    }
    if (/^\*\*一句话\*\*[：:]/.test(line)) {
      items.gist = line.replace(/^\*\*一句话\*\*[：:]\s*/, '').trim();
      continue;
    }
    // 分层标题与其它 markdown 结构：交给分组逻辑重算，这里忽略
    if (/^#{1,6}\s/.test(line) || /^\*\*.+\*\*$/.test(line)) continue;

    const bullet = /^-\s+(.*)$/.exec(line);
    if (!bullet) continue;
    const body = bullet[1];

    const why = /^为什么[：:]\s*(.*)$/.exec(body);
    if (why) {
      if (last) last.why = why[1].trim();
      continue;
    }

    const { text: core, quote } = splitQuote(body);

    // 命题：**A** —关系→ **B** —— 完整陈述
    const p = /^\*\*(.+?)\*\*\s*—(.{1,8}?)→\s*\*\*(.+?)\*\*\s*——\s*(.*)$/.exec(core);
    if (p) {
      const s = stripQMark(p[4]);
      const prop: CheatsheetProposition = {
        subject: p[1].trim(),
        rel: p[2].trim() as RelationKind,
        object: p[3].trim(),
        statement: s.text,
        quote,
        ...(s.q ? { fromQuestion: true as const } : {}),
      };
      items.propositions.push(prop);
      last = prop;
      continue;
    }

    // 速查：【类别】正文
    const e = /^【(.+?)】(.*)$/.exec(core);
    if (e) {
      const s = stripQMark(e[2]);
      items.entries.push({
        kind: e[1].trim() as EntryKind,
        text: s.text,
        quote,
        ...(s.q ? { fromQuestion: true as const } : {}),
      });
      last = null;
      continue;
    }

    // 术语 / 孤立事实：**X**：说明
    // 带引文的（V2 的 facts、或新版的术语）当定义收进速查；不带的才留在术语层。
    const t = /^\*\*(.+?)\*\*[：:]\s*(.*)$/.exec(core);
    if (t) {
      const name = t[1].trim();
      const meaning = t[2].trim();
      if (quote) items.entries.push({ kind: '定义', text: `${name}：${meaning}`, quote, term: name });
      else items.terms.push({ term: name, meaning });
      last = null;
    }
  }
  return items;
}

/** 小抄 markdown 里「可识别的条目行」总数，给迁移做护栏用。 */
export function countRecognizableLines(markdown: string): number {
  const items = parseCheatsheetMarkdown(markdown);
  return items.propositions.length + items.entries.length + items.terms.length;
}

/** markdown 里「看起来是条目」的行数（顶层 `- `；缩进的「为什么」不算）。 */
export function bulletCount(markdown: string): number {
  let n = 0;
  for (const line of (markdown ?? '').split('\n')) if (/^- /.test(line)) n++;
  return n;
}

/**
 * 反解析出来的 items 可不可信？
 *
 * ★ 这条护栏是防「渲染层悄悄删内容」的 ★
 *   反解析假设 markdown 是**我们自己渲染的格式**。但库里还躺着更早的小抄：
 *   V1 的 `**要点**` + 无类别前缀的条目（见 routes/study.ts 的 renderCheatsheetMarkdown）。
 *   它只能被认出一部分 —— 实测「居丽叶」那两篇 3578 字的小抄反解析后只剩 1373 字，
 *   而渲染层拿着这份残缺的 items 去渲染，界面上就真的少了 60% 的内容，且毫无提示。
 *   所以判据要和迁移脚本一致：认出 ≥90% 才敢用；否则退回原 markdown。
 *   （宁可不分层，也不能丢内容 —— 分层是呈现，内容是本体。）
 */
export function isParseFaithful(markdown: string, items: CheatsheetItems): boolean {
  const parsed = items.propositions.length + items.entries.length + items.terms.length;
  if (!parsed) return false;
  const bullets = bulletCount(markdown);
  // 没有条目行的 markdown（只有一句话 / 空壳）不适用比例判据，按「认出来了」算
  if (!bullets) return true;
  return parsed >= bullets * 0.9;
}
