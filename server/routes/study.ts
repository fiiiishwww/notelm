/**
 * server/routes/study.ts —— AI 增强：小抄 / 测验 / 闪卡 / 复习队列。
 *
 * ★ 一条贯穿全文件的纪律：AI 给的引用必须先过 validateQuote ★
 *   模型经常会「顺手改写」引文（把「它描述了」写成「它刻画了」），
 *   或者编一句听起来很像但正文里没有的话。这些引用会被用来在正文里定位、
 *   跳转、画高亮，一旦放进去就是坏锚点。
 *   所以这里的原则是：**引用校验不过就丢弃引用，但保留 AI 产出的内容本身**
 *   （内容仍然有用，只是不能定位），并在响应里告诉前端丢了几条。
 */

import { Router } from 'express';
import { z } from 'zod';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ApiError, sha256, DATA_DIR_NAME, requireVaultRoot } from '../core';
import { analyzeDocument, headingPathOf, unitText } from '../../shared/blocks';
import { makeId, itemKeyOf, localDate, type Card, type CheatsheetSection, type Quiz, type QuizQuestion, type StudyUnit } from '../../shared/text';
import { readDoc } from '../vault';
import { readSidecar, updateSidecar, listAllSidecars, appendReviewLog } from '../services/sidecar';
import { refreshLearning, refreshCardMigration } from '../services/learning';
import { validateQuote } from '../services/anchor';
import { validateCard } from '../services/activation';
import { chatJson, chat, getAiSettings } from '../services/aiClient';
import {
  blockIndexHint,
  cardsFromCheatsheetPrompt,
  cardsFromNotesPrompt,
  cardsFromTreePrompt,
  cheatsheetPrompt,
  cheatsheetV2Prompt,
  renderCheatsheetV2Markdown,
  renderCheatsheetV3Markdown,
  formatPrompt,
  quizPrompt,
  type CardShape,
  type CheatsheetProposition,
  type CheatsheetShape,
  type CheatsheetV2Shape,
  type QuizShape,
} from '../services/prompts';
import {
  isDuplicateQuote,
  renderSectionMarkdown,
  scoreProposition,
  withCheatsheetHtml,
} from '../services/cheatsheet';
import { computeSectionFrequency } from '../services/sectionFrequency';
import { attachBlockIndex } from '../services/cheatsheetRender';
import { runCheatsheetV3 } from '../services/cheatsheetV3';
import { rebuildConcepts, docXrefs, conceptKeyOf } from '../services/concepts';
import { knowledgeTreePrompt, locateTree, normalizeTree } from '../services/knowledgeTree';
import { mapLimit } from '../services/concurrency';
import { mapHighlightsToBlocks } from '../services/hlSignal';
import {
  writeFeedbackDigest,
  carryFeedback,
  archiveOrphanedFeedback,
  applyBinFeedback,
  appendEvalEvents,
  type OrphanedFeedbackRow,
  type EvalEvent,
} from '../services/feedback';
import { newSm2State, schedule, deckStats, dueQueue, type Grade } from '../services/sm2';
import { h, parse, qInt, qOptStr, qStr } from './http';

export const studyRouter = Router();

// ★ mapLimit 已收编到共享并发模块（2026-10-11）：三份逐字等价的复制合一，
//   并让全局 AI 闸能看见真实并发数。此处只 import，行为不变。
// ─────────────────────────── 小抄 ───────────────────────────

const genCheatSchema = z.object({
  rel: z.string().min(1).max(1024),
  /** 只生成这几个小节；不传表示整篇 */
  headingIds: z.array(z.string().max(200)).max(200).optional(),
  /** 已有小抄时是否覆盖 */
  force: z.boolean().default(false),
  /** 严格模式：只依据原文，温度更低 */
  strict: z.boolean().default(true),
  /**
   * 小抄版本。
   *   1 = 旧版原句压缩列表
   *   2 = 命题式（概念 + 关系 + 概念，带焦点问题）
   *   3 = 窗口化采集（长节拆窗口各自整理再合并；见 services/cheatsheetV3.ts）
   *
   * 实测（scripts/cheatsheet-probe.ts / cheatsheet-v3-probe.ts，
   * 拿 chapter1「Harness 工程」那节，162 个内容块、14312 字）：
   *   V1：41.7 条/节，条目之间零关系
   *   V2：覆盖 6%（10/162），小抄 2045 字，7 条命题
   *   V3：覆盖 28%（46/162），小抄 10435 字，27 命题 + 32 速查 + 31 术语
   *   V3 唯一的代价是调用次数（一节 10 次 vs 1 次）和长度。
   */
  version: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(3),
});

studyRouter.post(
  '/cheatsheet/generate',
  h(async (req, res) => {
    const body = parse(genCheatSchema, req.body, '生成小抄请求');
    const doc = await readDoc(body.rel);
    const a = analyzeDocument(doc.markdown);
    const docTitle = body.rel.replace(/^.*\//, '').replace(/\.[^.]+$/, '');

    const existing = await readSidecar(body.rel);
    const done = new Map(existing.cheatsheet.sections.map((s) => [s.headingId, s]));
    /**
     * 一个学习单元对应的已有 section。
     * ★ 为什么不能只查主 id ★ 重划后单元可能合并 / 覆盖了多个旧节，
     *   而存量 section 是按**被并入的那个旧 headingId** 存的 —— 只查主 id 会认不出来，
     *   于是每次生成都把它当新单元重跑一遍（额度白花，旧 section 还留着不走）。
     *   开关关闭时 headingIds 恒为 undefined，这里等价于原来的 `done.get(u.headingId)`。
     */
    const secForUnit = (u: StudyUnit) =>
      done.get(u.headingId) ?? existing.cheatsheet.sections.find((s) => u.headingIds?.includes(s.headingId));
    // ★ 用户高亮 → 块号信号。它是采集的优先级输入（不是范围）；
    //   没有高亮时是空 map，管道行为和没有这层时完全一样。
    const hlMap = mapHighlightsToBlocks(existing.highlights, a.blocks).colorByBi;

    let targets = a.units.filter((u) => !body.headingIds || body.headingIds.includes(u.headingId));
    if (!body.force) {
      targets = targets.filter((u) => {
      const sec = secForUnit(u);
      if (!sec) return true;
      // 正文变了、或者小抄版本变了，都要重新生成（版本变了内容没变，sourceHash 是看不出来的）
      if ((sec.version ?? 1) !== body.version) return true;
      // 否则跳过（省额度、也避免覆盖用户看过的内容）
      return sec.sourceHash !== sha256(unitText(a.blocks, u));
      });
    }
    if (targets.length === 0) {
      res.json({
        sections: await withCheatsheetHtml([...done.values()], {
          docRel: body.rel,
          blocks: a.blocks,
          chapters: a.chapters,
          units: a.units,
          hl: hlMap,
        }),
        generated: 0,
        skipped: a.units.length,
        droppedQuotes: 0,
      });
      return;
    }

    let droppedQuotes = 0;
    /** 被判据拦下的命题（同义反复 / 引文没信息量）。 */
    let droppedProps = 0;
    const aiModel = (await getAiSettings()).model;
    // 并发为什么是 2 而不是 3：V3 的每一节内部还会再并发 3 个窗口，
    // 整篇生成时峰值并发 = 2 × 3 = 6 个请求，再高容易撞上接口限流。
    const results = await mapLimit(targets, 2, async (unit) => {
      const text = unitText(a.blocks, unit);
      const ctx = { unit, text, headingPath: headingPathOf(a.chapters, unit), docTitle };

      const keep = (q: string): string => {
        const v = validateQuote(q, a.blocks);
        if (!v) {
          droppedQuotes++;
          return '';
        }
        return q.trim();
      };

      // ── V2 命题式 ──
      if (body.version === 2) {
        const p = cheatsheetV2Prompt(ctx);
        const shape = await chatJson<CheatsheetV2Shape>(
          [
            { role: 'system', content: p.system },
            { role: 'user', content: p.user },
          ],
          {
            label: `「${unit.headingText}」命题小抄`,
            temperature: body.strict ? 0.1 : 0.4,
            maxTokens: 12000,
            timeoutMs: 180_000,
            // ★ 关思考：思维链与正文共享 max_tokens，长结构化输出会被挤成 0 字（见 /cheatsheet/tree 的注释）
            thinking: false,
            validate: (v) => {
              const o = v as Partial<CheatsheetV2Shape> | null;
              if (!o || typeof o !== 'object') return '返回的不是对象';
              if (!Array.isArray(o.propositions)) return 'propositions 不是数组';
              return null;
            },
          },
        );

        // 落盘前先过一遍确定性判据：废话命题、没信息量的引文、拿同一句原文重复出的
        // 第二条命题，全部丢掉——实测模型会把「clip 操作 —用于解决→ 策略突变」和
        // 「clip 操作 —导致→ 高稳定性」写成两条，引的是同一句，等于同一件事说两遍。
        const props: CheatsheetProposition[] = [];
        const seenQuotes: string[] = [];
        for (const x of shape.propositions ?? []) {
          if (!x || !x.subject || !x.object) continue;
          const s = scoreProposition(x, text);
          if (s.tautology || s.shortQuote) {
            droppedProps++;
            continue;
          }
          if (seenQuotes.some((q) => isDuplicateQuote(q, x.quote ?? ''))) {
            droppedProps++;
            continue;
          }
          seenQuotes.push(x.quote ?? '');
          props.push({ ...x, quote: keep(x.quote ?? '') });
        }
        const facts = (shape.facts ?? [])
          .filter((x) => x && x.concept)
          .map((x) => ({ concept: x.concept, claim: x.claim ?? '', quote: keep(x.quote ?? '') }));

        const section: CheatsheetSection = {
          headingId: unit.headingId,
          headingText: unit.headingText,
          markdown: renderCheatsheetV2Markdown({
            focus: shape.focus ?? '',
            gist: shape.gist ?? '',
            propositions: props,
            facts,
            terms: (shape.terms ?? []).filter((x) => x && x.term),
          }),
          model: aiModel,
          generatedAt: new Date().toISOString(),
          sourceHash: sha256(text),
          version: 2,
        };
        return section;
      }

      // ── V3 窗口化采集 ──
      // 长节拆成若干窗口各自整理，再合并。为什么要有这一版、以及它和 V2 的
      // 实测差别，见 services/cheatsheetV3.ts 顶部的说明。
      if (body.version === 3) {
        const out = await runCheatsheetV3({
          blocks: a.blocks,
          unit,
          headingPath: headingPathOf(a.chapters, unit),
          docTitle,
          hitQuote: (q) => Boolean(validateQuote(q, a.blocks)),
          locateQuote: (q) => validateQuote(q, a.blocks)?.blockIndex ?? null,
          hlBlocks: hlMap.size ? hlMap : undefined,
          temperature: body.strict ? 0.1 : 0.4,
        });
        droppedProps += out.stats.dropped ?? 0;

        // ★ 落盘存**结构化条目**，markdown 只是快照 ★
        // 以前这里只存 markdown，结果是「想换个呈现方式就得重跑一遍模型」——
        // 而换呈现本来一分钱都不该花。块号也在这里一次算好。
        const items = attachBlockIndex(
          {
            focus: out.focus,
            gist: out.gist,
            propositions: out.propositions,
            entries: out.entries,
            terms: out.terms,
          },
          a.blocks,
        );
        const section: CheatsheetSection = {
          headingId: unit.headingId,
          headingText: unit.headingText,
          items,
          markdown: '',
          model: aiModel,
          generatedAt: new Date().toISOString(),
          sourceHash: sha256(text),
          version: 3,
          // ★ 体检数据落盘 ★ 覆盖率、补采次数、各阶段调用数都存下来，
          //   否则「这一节质量如何」跑完就丢，只能凭感觉评估。
          stats: { ...out.stats },
          // ★ 被裁条目回收站 ★ 裁决理由 + 全尸一起存，前端可 ▲ 复活 / ▽⧉ 确认
          dropped: out.dropped.length ? out.dropped : undefined,
        };
        // 快照也按分层渲染，保证「落盘的」和「响应里的」长得一样
        section.markdown =
          renderSectionMarkdown(section, { blocks: a.blocks, chapters: a.chapters, units: a.units }) ??
          renderCheatsheetV3Markdown(items);
        return section;
      }

      // ── V1 原句压缩 ──
      const p = cheatsheetPrompt(ctx);
      const shape = await chatJson<CheatsheetShape>(
        [
          { role: 'system', content: p.system },
          { role: 'user', content: p.user },
        ],
        // 额度给足：推理模型（deepseek-flash 等）的思考过程也占这份额度，
        // 给少了会出现「思考用完、正文一个字都没输出」。没用完的额度不计费。
        {
          label: `「${unit.headingText}」小抄`,
          temperature: body.strict ? 0.1 : 0.4,
          maxTokens: 12000,
          timeoutMs: 180_000,
          thinking: false,
          validate: (v) => {
            const o = v as Partial<CheatsheetShape> | null;
            if (!o || typeof o !== 'object') return '返回的不是对象';
            if (typeof o.gist !== 'string' || !o.gist.trim()) return '缺少 gist 字段（一句话总结）';
            if (!Array.isArray(o.points)) return 'points 不是数组';
            return null;
          },
        },
      );

      const md = renderCheatsheetMarkdown({
        gist: shape.gist ?? '',
        points: (shape.points ?? []).map((x) => ({ text: x.text ?? '', quote: keep(x.quote ?? '') })).filter((x) => x.text),
        pitfalls: (shape.pitfalls ?? []).map((x) => ({ text: x.text ?? '', quote: keep(x.quote ?? '') })).filter((x) => x.text),
        terms: (shape.terms ?? [])
          .map((x) => ({ term: x.term ?? '', meaning: x.meaning ?? '', quote: keep(x.quote ?? '') }))
          .filter((x) => x.term),
      });

      const section: CheatsheetSection = {
        headingId: unit.headingId,
        headingText: unit.headingText,
        markdown: md,
        model: aiModel,
        generatedAt: new Date().toISOString(),
        sourceHash: sha256(text),
      };
      return section;
    });

    // ★ 标注随行 ★ 旧条目上的 ▲▽⧉ 是「人的判断」，重生成本该让产出变好，
    //   不能把用户标过的东西一起冲掉。替换前按内容重锚：精确 hash → 相似度
    //   （判据与阈值复用条目去重那套，等式/数值豁免），认不出的落孤儿存档。
    const fbOrphans: Omit<OrphanedFeedbackRow, 'archivedAt'>[] = [];
    const fbEval: EvalEvent[] = [];
    let fbCarried = 0;

    await updateSidecar(body.rel, (s) => {
      const byId = new Map(s.cheatsheet.sections.map((x) => [x.headingId, x]));
      for (const sec of results) {
        const old = byId.get(sec.headingId);
        if (old?.items && sec.items) {
          const r = carryFeedback(old.items, sec.items);
          fbCarried += r.carried;
          for (const o of r.orphans) {
            fbOrphans.push({ ...o, doc: body.rel, headingId: sec.headingId, headingText: sec.headingText });
            // 孤儿也是评测数据：被判过的旧文本 + 判了什么，正是「错的长什么样」
            fbEval.push({
              at: new Date().toISOString(),
              source: 'orphan',
              doc: body.rel,
              headingId: sec.headingId,
              headingText: sec.headingText,
              layer: o.layer,
              kind: o.kind,
              text: o.text,
              quote: o.quote,
              mark: o.feedback.mark,
              why: o.feedback.why,
            });
          }
          for (const cr of r.carriedRows) {
            fbEval.push({
              at: new Date().toISOString(),
              source: 'carried',
              doc: body.rel,
              headingId: sec.headingId,
              headingText: sec.headingText,
              layer: cr.layer,
              kind: cr.kind,
              text: cr.text,
              was: cr.was,
              mark: cr.feedback.mark,
              why: cr.feedback.why,
            });
          }
        }
        byId.set(sec.headingId, sec);
      }
      // 按 units 的顺序排好，保证界面顺序和正文一致
      const order = new Map(a.units.map((u, i) => [u.headingId, i]));
      s.cheatsheet.sections = [...byId.values()].sort(
        (x, y) => (order.get(x.headingId) ?? 999) - (order.get(y.headingId) ?? 999),
      );
    });

    const after = await readSidecar(body.rel);
    // 重生成动了标注 → 汇总投影/孤儿存档刷新，搬运与孤儿快照进评测集（只追加）
    await Promise.all([writeFeedbackDigest(), archiveOrphanedFeedback(fbOrphans), appendEvalEvents(fbEval)]);
    res.json({
      sections: await withCheatsheetHtml(after.cheatsheet.sections, {
        docRel: body.rel,
        blocks: a.blocks,
        chapters: a.chapters,
        units: a.units,
        hl: mapHighlightsToBlocks(after.highlights, a.blocks).colorByBi,
      }),
      generated: results.length,
      skipped: a.units.length - targets.length,
      droppedQuotes,
      droppedProps,
      feedback: { carried: fbCarried, orphaned: fbOrphans.length },
    });
  }),
);

interface CheatShape {
  gist: string;
  points: { text: string; quote: string }[];
  pitfalls: { text: string; quote: string }[];
  terms: { term: string; meaning: string; quote: string }[];
}

/**
 * 把结构化小抄渲染成 Markdown。
 * 为什么不直接让模型输出 Markdown：结构化数据更容易校验（引用能否定位）、
 * 也更容易在界面上做交互（点击某条要点跳回原文）。
 */
export function renderCheatsheetMarkdown(s: CheatShape): string {
  const lines: string[] = [];
  if (s.gist) lines.push(`**一句话**：${s.gist}`, '');
  if (s.points.length) {
    lines.push('**要点**');
    for (const p of s.points) lines.push(`- ${p.text}${p.quote ? ` ${cite(p.quote)}` : ''}`);
    lines.push('');
  }
  if (s.terms.length) {
    lines.push('**术语**');
    for (const t of s.terms) lines.push(`- **${t.term}**：${t.meaning}${t.quote ? ` ${cite(t.quote)}` : ''}`);
    lines.push('');
  }
  if (s.pitfalls.length) {
    lines.push('**易错点**');
    for (const p of s.pitfalls) lines.push(`- ${p.text}${p.quote ? ` ${cite(p.quote)}` : ''}`);
    lines.push('');
  }
  return lines.join('\n').trim();
}

/** 用行内代码包住引用，前端可以识别并做成可点击的跳转。 */
function cite(quote: string): string {
  const q = quote.replace(/`/g, '').trim();
  return q ? `\`${q}\`` : '';
}

studyRouter.get(
  '/cheatsheet',
  h(async (req, res) => {
    const rel = qStr(req, 'rel');
    const s = await readSidecar(rel);
    // 分层呈现要知道这一节的子标题落在哪几块上。章节是**派生数据**（随正文重建），
    // 所以这里现分析一次；读不到文档就退回平铺渲染，不影响功能。
    let ctx: Parameters<typeof withCheatsheetHtml>[1];
    try {
      const d = await readDoc(rel);
      const an = analyzeDocument(d.markdown);
      ctx = {
        docRel: rel,
        blocks: an.blocks,
        chapters: an.chapters,
        units: an.units,
        hl: mapHighlightsToBlocks(s.highlights, an.blocks).colorByBi,
        // L3 跨节出处：概念库现查（派生缓存），失败不打断渲染（退化为无「另见」）
        xrefs: await docXrefs(rel).catch(() => undefined),
      };
    } catch {
      ctx = undefined;
    }
    res.json({ sections: await withCheatsheetHtml(s.cheatsheet.sections, ctx) });
  }),
);

// ─────────────────────────── 知识树 ───────────────────────────

const genTreeSchema = z.object({
  rel: z.string().min(1).max(1024),
  headingId: z.string().min(1).max(200),
  /** 已有树时是否重新生成 */
  force: z.boolean().default(false),
});

/**
 * 为一节生成知识树（2026-09-20 接入，chapter1 先试点）。
 *
 * ★ 组织主轴从「原文目录」换成「知识点关系」——这是多鱼拍板的方向 ★
 *   现役条目视图原样保留作对比（改动范围 = 新增，不动现有字段与行为）：
 *   树存进 section.tree，与 items 并存；覆盖率/去重/回收站/闪卡仍然全部基于 items。
 *
 * ★ 生成后必须经 withCheatsheetHtml 再回 ★ 前端拿到的是带 html/treeHtml 的完整
 *   section，直接替换进自己的 sections 数组即可——和 /cheatsheet/generate 同一约定。
 */
studyRouter.post(
  '/cheatsheet/tree',
  h(async (req, res) => {
    const body = parse(genTreeSchema, req.body, '生成知识树请求');
    const doc = await readDoc(body.rel);
    const a = analyzeDocument(doc.markdown);
    const unit = a.units.find((u) => u.headingId === body.headingId);
    if (!unit) throw new ApiError(404, '找不到这个小节', 'not_found');
    const docTitle = body.rel.replace(/^.*\//, '').replace(/\.[^.]+$/, '');
    const text = unitText(a.blocks, unit);
    const sourceHash = sha256(text);

    const cur = await readSidecar(body.rel);
    const existing = cur.cheatsheet.sections.find((x) => x.headingId === body.headingId);
    // 内容没变、树已在 → 直接复用（省额度）。force=true 才重跑。
    if (existing?.tree && !body.force && existing.tree.sourceHash === sourceHash) {
      const hl = mapHighlightsToBlocks(cur.highlights, a.blocks).colorByBi;
      const [section] = await withCheatsheetHtml([existing], {
        docRel: body.rel,
        blocks: a.blocks,
        chapters: a.chapters,
        units: a.units,
        hl,
        xrefs: await docXrefs(body.rel).catch(() => undefined),
      });
      res.json({ section, reused: true, issues: [] });
      return;
    }

    const p = knowledgeTreePrompt({
      docTitle,
      headingPath: headingPathOf(a.chapters, unit),
      unitTitle: unit.headingText,
      text,
    });
    const raw = await chatJson<unknown>(
      [
        { role: 'system', content: p.system },
        { role: 'user', content: p.user },
      ],
      {
        label: `「${unit.headingText}」知识树`,
        temperature: 0.2,
        maxTokens: 12000,
        timeoutMs: 240_000,
        // ★ 关掉思考模式（多鱼 2026-10-10）★
        //   实测：deepseek-flash 默认开思考，思维链与正文**共享 max_tokens**。
        //   同一节 1200 字输入、max_tokens=8000：21 次调用里 17 次 finish_reason=length，
        //   其中 14 次推理吃满 8000、**正文 0 字**（整棵树报废）。
        //   关掉之后 21/21 成功，节点 177 个，耗时 30~35s → 5~6s。
        //   知识树是纯结构化抽取任务（照原文归类），不需要长思维链。
        thinking: false,
        validate: (v) => {
          const o = v as { nodes?: unknown } | null;
          if (!o || typeof o !== 'object') return '返回的不是对象';
          if (!Array.isArray(o.nodes) || o.nodes.length === 0) return 'nodes 不是非空数组';
          return null;
        },
      },
    );
    const { tree, issues } = normalizeTree(raw, { maxRoots: 3 });
    const locate = locateTree(tree, a.blocks);
    tree.model = (await getAiSettings()).model;
    tree.generatedAt = new Date().toISOString();
    tree.sourceHash = sourceHash;
    tree.locate = locate;

    await updateSidecar(body.rel, (s) => {
      let sec = s.cheatsheet.sections.find((x) => x.headingId === body.headingId);
      if (!sec) {
        // ★ 树先行（多鱼 09-20 晚：小抄下岗，树成为节的唯一生成形态）★
        //   旧约束「必须先有小抄」防的是树/条目两形态的节集合分叉；
        //   树成为唯一形态后顾虑消失，缺节就地建节，不再强制先跑条目管线。
        sec = {
          headingId: body.headingId,
          headingText: unit.headingText,
          markdown: '',
          model: tree.model ?? '',
          generatedAt: new Date().toISOString(),
          sourceHash,
          tree,
        };
        s.cheatsheet.sections.push(sec);
        return;
      }
      sec.tree = tree;
    });

    const after = await readSidecar(body.rel);
    const updated = after.cheatsheet.sections.find((x) => x.headingId === body.headingId);
    if (!updated) throw new ApiError(500, '树已写入但读回失败', 'internal');
    // ★ L2 概念注册 ★ 树落盘后立刻重建概念索引（派生数据，全库重算，秒级）。
    //   必须在渲染前完成——响应里的树要带上「另见」就得有最新的跨节出处。
    const xrefs = await rebuildConcepts()
      .then(() => docXrefs(body.rel))
      .catch(() => undefined);
    const hl = mapHighlightsToBlocks(after.highlights, a.blocks).colorByBi;
    const [section] = await withCheatsheetHtml([updated], {
      docRel: body.rel,
      blocks: a.blocks,
      chapters: a.chapters,
      units: a.units,
      hl,
      xrefs,
    });
    res.json({ section, reused: false, located: locate.located, total: locate.total, issues });
  }),
);

studyRouter.delete(
  '/cheatsheet',
  h(async (req, res) => {
    const rel = qStr(req, 'rel');
    const headingId = qOptStr(req, 'headingId');
    await updateSidecar(rel, (s) => {
      s.cheatsheet.sections = headingId
        ? s.cheatsheet.sections.filter((x) => x.headingId !== headingId)
        : [];
    });
    res.json({ ok: true });
  }),
);

// ─────────────────────────── 测验 ───────────────────────────

const genQuizSchema = z.object({
  rel: z.string().min(1).max(1024),
  headingId: z.string().min(1).max(200),
  /** 每个小节 1~3 条，默认 3 */
  count: z.number().int().min(1).max(10).default(3),
  force: z.boolean().default(true),
});

studyRouter.post(
  '/quiz/generate',
  h(async (req, res) => {
    const body = parse(genQuizSchema, req.body, '出题请求');
    const doc = await readDoc(body.rel);
    const a = analyzeDocument(doc.markdown);
    const unit = a.units.find((u) => u.headingId === body.headingId);
    if (!unit) throw new ApiError(404, '找不到这个小节', 'not_found');

    const docTitle = body.rel.replace(/^.*\//, '').replace(/\.[^.]+$/, '');
    const text = unitText(a.blocks, unit);
    const p = quizPrompt(
      { unit, text, headingPath: headingPathOf(a.chapters, unit), docTitle },
      body.count,
      blockIndexHint(a.blocks, unit),
    );

    const shape = await chatJson<QuizShape>(
      [
        { role: 'system', content: p.system },
        { role: 'user', content: p.user },
      ],
      { label: `「${unit.headingText}」出题`, temperature: 0.5, maxTokens: 12000, timeoutMs: 180_000, thinking: false },
    );

    let droppedCitations = 0;
    const questions: QuizQuestion[] = (shape.questions ?? [])
      .map((raw): QuizQuestion | null => {
        const stem = (raw.stem ?? '').trim();
        if (!stem) return null;
        const type: QuizQuestion['type'] = (['single', 'multi', 'blank', 'short'] as const).includes(
          raw.type as QuizQuestion['type'],
        )
          ? (raw.type as QuizQuestion['type'])
          : 'single';
        const options = Array.isArray(raw.options) ? raw.options.filter((o) => typeof o === 'string' && o.trim()) : [];
        if ((type === 'single' || type === 'multi') && options.length < 2) return null;

        let answer: (number | string)[] = [];
        if (type === 'single' || type === 'multi') {
          answer = (Array.isArray(raw.answer) ? raw.answer : [])
            .map((x) => (typeof x === 'number' ? x : Number.parseInt(String(x), 10)))
            .filter((n) => Number.isInteger(n) && n >= 0 && n < options.length);
          if (answer.length === 0) return null;
          if (type === 'single') answer = [answer[0]];
          answer = [...new Set(answer)].sort((x, y) => (x as number) - (y as number));
        } else {
          answer = (Array.isArray(raw.answer) ? raw.answer : [])
            .map((x) => String(x).trim())
            .filter(Boolean);
          if (answer.length === 0) return null;
        }

        // 引用逐条校验：定位不到的丢掉，但题目本身保留
        const citations: { quote: string; blockIndex: number }[] = [];
        for (const c of raw.citations ?? []) {
          const hit = validateQuote(String(c?.quote ?? ''), a.blocks);
          if (hit) citations.push({ quote: String(c.quote).trim(), blockIndex: hit.blockIndex });
          else droppedCitations++;
        }

        return {
          id: makeId('q'),
          type,
          stem,
          options: type === 'single' || type === 'multi' ? options : [],
          answer,
          explain: (raw.explain ?? '').trim(),
          citations,
        };
      })
      .filter((q): q is QuizQuestion => q !== null);

    if (questions.length === 0) {
      throw new ApiError(502, 'AI 没有产出有效题目，请重试或换一个模型', 'ai_empty_quiz');
    }

    const aiSettings = await getAiSettings();
    const quiz: Quiz = {
      id: makeId('qz'),
      headingId: unit.headingId,
      headingText: unit.headingText,
      model: aiSettings.model,
      generatedAt: new Date().toISOString(),
      questions,
      attempts: [],
    };

    await updateSidecar(body.rel, (s) => {
      const i = s.quizzes.findIndex((q) => q.headingId === unit.headingId);
      if (i >= 0 && body.force) {
        // 保留历史作答记录：题目换了，但「练过几次」这件事有价值
        quiz.attempts = s.quizzes[i].attempts ?? [];
        s.quizzes[i] = quiz;
      } else if (i < 0) {
        s.quizzes.push(quiz);
      }
    });

    res.json({ quiz, droppedCitations });
  }),
);

studyRouter.get(
  '/quiz',
  h(async (req, res) => {
    const rel = qStr(req, 'rel');
    const s = await readSidecar(rel);
    res.json({ quizzes: s.quizzes });
  }),
);

studyRouter.delete(
  '/quiz',
  h(async (req, res) => {
    const rel = qStr(req, 'rel');
    const quizId = qOptStr(req, 'quizId');
    await updateSidecar(rel, (s) => {
      if (quizId) s.quizzes = s.quizzes.filter((q) => q.id !== quizId);
      else s.quizzes = [];
    });
    res.json({ ok: true });
  }),
);

const attemptSchema = z.object({
  rel: z.string().min(1).max(1024),
  quizId: z.string().min(1).max(64),
  answers: z.record(z.string().max(64), z.array(z.union([z.number(), z.string()])).max(50)),
  durationMs: z.number().int().min(0).max(24 * 3600 * 1000).default(0),
});

/**
 * 提交答卷。
 *
 * 判分规则：
 *   single —— 单选必须完全一致
 *   multi  —— 集合相等才满分，选了部分正确项给一半分（不做扣分，鼓励多选）
 *   blank  —— 与任一可接受答案归一化后相等
 *   short  —— 命中「评分要点」的比例即为得分（部分给分）
 */
studyRouter.post(
  '/quiz/attempt',
  h(async (req, res) => {
    const body = parse(attemptSchema, req.body, '提交答卷');
    const s = await readSidecar(body.rel);
    const quiz = s.quizzes.find((q) => q.id === body.quizId);
    if (!quiz) throw new ApiError(404, '找不到这份测验', 'not_found');

    const perQuestion: { id: string; correct: boolean; partial: number; expected: (number | string)[] }[] = [];
    let total = 0;
    for (const q of quiz.questions) {
      const given = body.answers[q.id] ?? [];
      const g = gradeAnswer(q, given);
      total += g.partial;
      perQuestion.push({ id: q.id, correct: g.correct, partial: g.partial, expected: q.answer });
    }
    const score = Math.round((total / Math.max(1, quiz.questions.length)) * 100);

    const attempt = {
      at: new Date().toISOString(),
      answers: body.answers,
      score,
      total: quiz.questions.length,
      durationMs: body.durationMs,
    };

    await updateSidecar(body.rel, (cur) => {
      const q = cur.quizzes.find((x) => x.id === body.quizId);
      if (!q) throw new ApiError(404, '找不到这份测验', 'not_found');
      q.attempts.push(attempt);
      if (q.attempts.length > 50) q.attempts.splice(0, q.attempts.length - 50);
    });

    await appendReviewLog({
      at: attempt.at,
      kind: 'quiz',
      docPath: body.rel,
      headingId: quiz.headingId,
      quizId: quiz.id,
      score,
      total: quiz.questions.length,
      durationMs: body.durationMs,
    });

    res.json({ score, total: quiz.questions.length, perQuestion, attempt });
  }),
);

export function gradeAnswer(q: QuizQuestion, given: (number | string)[]): { correct: boolean; partial: number } {
  const norm = (x: unknown) => String(x).trim().toLowerCase().replace(/\s+/g, '');
  switch (q.type) {
    case 'single': {
      const ok = given.length === 1 && q.answer.length === 1 && Number(given[0]) === Number(q.answer[0]);
      return { correct: ok, partial: ok ? 1 : 0 };
    }
    case 'multi': {
      const want = new Set(q.answer.map((x) => Number(x)));
      const got = new Set(given.map((x) => Number(x)));
      if (want.size === 0) return { correct: false, partial: 0 };
      let hit = 0;
      for (const g of got) if (want.has(g)) hit++;
      const exact = hit === want.size && got.size === want.size;
      // 全对 1 分；漏选按命中比例给分（封顶 0.9，避免漏选反而接近满分）；多选错项再打折
      if (exact) return { correct: true, partial: 1 };
      const falsePositive = got.size - hit;
      const partial = Math.max(0, Math.min(0.9, (hit / want.size) * (falsePositive > 0 ? 0.5 : 1)));
      return { correct: false, partial };
    }
    case 'blank': {
      const ok = q.answer.some((a) => given.some((g) => norm(g) === norm(a)));
      return { correct: ok, partial: ok ? 1 : 0 };
    }
    case 'short': {
      const text = given.map(norm).join(' ');
      if (!text) return { correct: false, partial: 0 };
      let hit = 0;
      for (const point of q.answer) {
        const key = norm(point);
        if (!key) continue;
        // 简答题的「要点」通常是一句话，允许只命中其中较长的片段
        if (text.includes(key)) {
          hit++;
          continue;
        }
        const frags = key.split(/[，,。；;、]/).filter((f) => f.length >= 4);
        if (frags.some((f) => text.includes(f))) hit++;
      }
      const ratio = q.answer.length ? hit / q.answer.length : 0;
      return { correct: ratio >= 0.8, partial: Math.min(1, ratio) };
    }
    default:
      return { correct: false, partial: 0 };
  }
}

// ─────────────────────────── 闪卡 ───────────────────────────

const fromCheatSchema = z.object({
  rel: z.string().min(1).max(1024),
  headingId: z.string().min(1).max(200),
  /** 是否跳过已有卡片（按 source.refId 去重） */
  skipExisting: z.boolean().default(true),
  /** 自筛时把 warn 级也判掉（默认只挡 block 级，符合「自筛但别误杀好卡」） */
  strict: z.boolean().default(false),
});

/**
 * 知识树 → 闪卡。
 *
 * ★ 这一条取代了 `/cards/from-cheatsheet` ★
 *   旧端点的输入是 `section.markdown`（小抄的 markdown）。小抄退役后，
 *   那个字段只是历史快照——**新节永远拿不到它**，所以旧端点在管线上是死的
 *   （UI 入口挂在 `section.items` 上，而全库 items 非空的节 = 0）。
 *   知识树是这一节真正持续产出的东西，所以换它当源。
 *
 * ★ 两处新增（都只在这一条端点上，不动旧端点）★
 *   ① 逐条核销：卡片带 slot 编号，交上来后统计「清单里哪几条没人认领」，
 *      连同判定结果一起返回——**覆盖这件事因此是可核对的，而不是靠模型自觉**。
 *   ② 自筛：每张卡跑 `validateCard` 的六条判据，block 级不过就不落盘。
 *      判据是 activation 那套（阈值是实测出来的，不重写第二套）。
 */
studyRouter.post(
  '/cards/from-tree',
  h(async (req, res) => {
    const body = parse(fromCheatSchema, req.body, '生成闪卡请求');
    const doc = await readDoc(body.rel);
    const a = analyzeDocument(doc.markdown);
    const unit = a.units.find((u) => u.headingId === body.headingId);
    if (!unit) throw new ApiError(404, '找不到这个小节', 'not_found');

    const s = await readSidecar(body.rel);
    const section = s.cheatsheet.sections.find((x) => x.headingId === body.headingId);
    if (!section?.tree?.nodes?.length) {
      throw new ApiError(400, '这一节还没有知识树，请先生成知识树', 'no_tree');
    }

    const docTitle = body.rel.replace(/^.*\//, '').replace(/\.[^.]+$/, '');
    const p = cardsFromTreePrompt(
      { unit, text: unitText(a.blocks, unit), headingPath: headingPathOf(a.chapters, unit), docTitle },
      section.tree as Parameters<typeof cardsFromTreePrompt>[1],
    );

    /**
     * slot 编号 → 该知识点（节点）的 conceptKey。
     *
     * ★ 为什么能直接算 ★
     *   清单是 `cardSlotsOf` 按 `tree.nodes` 顺序摊出来的，`N<n>` 就是第 n 个节点
     *   （`D<n>.<k>` 也归属第 n 个节点）。所以 slot 反查节点名是 O(1) 的精确映射，
     *   不像 quote 相似度那样是「猜」。slot 缺失或越界就返回 undefined，
     *   交给 `refreshCardMigration` 那条老路兜底。
     */
    const treeNodes = (section.tree as { nodes: { name: string }[] }).nodes;
    const slotKeyOf = (slot?: string): string | undefined => {
      const m = /^[ND](\d+)/.exec(slot ?? '');
      if (!m) return undefined;
      const node = treeNodes[Number(m[1]) - 1];
      return node ? conceptKeyOf(node.name) : undefined;
    };

    // slot = 卡片自称出自清单的哪一条，用来核销覆盖率（模型可能不填，填了才核）
    type TreeCard = { slot?: string; front: string; back: string; quote: string };
    const shape = await chatJson<{ cards: TreeCard[] }>(
      [
        { role: 'system', content: p.system },
        { role: 'user', content: p.user },
      ],
      { label: '树转闪卡', temperature: 0.3, maxTokens: 8000, timeoutMs: 240_000, thinking: false },
    );

    const refPrefix = `tree:${body.headingId}`;
    const existingRefs = new Set(s.cards.map((c) => c.source.refId));
    const now = new Date().toISOString();
    const fresh: Card[] = [];
    const rejected: { front: string; blocked: string[]; detail: string[] }[] = [];

    // 查重要带上「这一节已有的」+「全文已有的」——批内逐张累积，避免同一批自己撞自己
    const seenFronts = s.cards.map((c) => c.front);
    let droppedQuotes = 0;
    const covered = new Set<string>();
    /**
     * 「正面必须是完整问句」的程序硬门。
     *
     * ★ 为什么提示词说了还要再加一道 ★
     *   提示词里已经点名禁掉「Agent 产品形态 · 例子」这类形状，也给了自查四条，
     *   但模型不听提示词是常态（与「顶层 ≤3」那条教训同源）。正面写成什么样
     * 直接决定这张卡能不能用，所以它必须是硬门而不是建议。
     *   这四条机械判据在 `scripts/card-front-probe.ts` 里先跑过（100% 通过），
     *   阈值来自那份实测，不是拍脑袋。
     */
    const isQuestion = (front: string): string | null => {
      const f = front.trim();
      if (f.length < 8) return `正面太短（${f.length} 字），不构成问题`;
      if (f.length > 60) return '正面太长（>60 字），复习时读不完';
      if (!/[？?]|是什么|为什么|怎么|哪些|哪个|如何|写出|说说|多少|能不能|会不会|差别|区别|前提|条件/.test(f)) {
        return '正面不是问句（没有问号也没有疑问词）';
      }
      if (/·\s*(例子|要点|定义|等式|数值|类比|清单|原则|事实|机制|做法|概念)\s*$/.test(f)) {
        return '正面是「名词 · 类型」标签形状，不是问题';
      }
      if (/^(它|这个|这些|那个|上述|前面)[^，。]{0,8}(是什么|做什么|怎么|如何|的作用)/.test(f)) {
        return '正面无主语（不知道在问谁）';
      }
      if (/[：:]\s*$/.test(f)) return '正面以冒号结尾（那是线索，不是问句）';
      return null;
    };

    (shape.cards ?? []).forEach((c, idx) => {
      const front = (c.front ?? '').trim();
      const back = (c.back ?? '').trim();
      if (!front || !back) return;
      // ★ slot 落进 refId（不是新字段）★
      //   `tree:<headingId>#<序号>@<slot>` —— 卡上带着它出自哪一条槽位，
      //   事后回填 conceptKey / 核对覆盖都有据可查。
      //   旧格式（没有 @slot）仍然能读，只是不带槽位信息。
      const ref = c.slot ? `${refPrefix}#${idx}@${c.slot}` : `${refPrefix}#${idx}`;
      if (body.skipExisting && existingRefs.has(ref)) return;
      if (c.slot) covered.add(c.slot);

      const shapeFail = isQuestion(front);
      if (shapeFail) {
        rejected.push({ front, blocked: ['notQuestion'], detail: [shapeFail] });
        return;
      }

      // ★ 自筛：六条判据。block 级不过直接不落盘，warn 级放过（阈值是实测的，
      //   硬卡 warn 会成片误杀中文好卡——activation.ts 里记着这个教训）。
      const judgement = validateCard({ front, back, quote: (c.quote ?? '').trim() }, {
        blocks: a.blocks,
        existingFronts: seenFronts,
      });
      const hardFail = body.strict ? [...judgement.blocked, ...judgement.warned] : judgement.blocked;
      if (hardFail.length) {
        rejected.push({
          front,
          blocked: hardFail,
          detail: judgement.checks.filter((x) => hardFail.includes(x.id)).map((x) => x.detail),
        });
        return;
      }

      let quote = (c.quote ?? '').trim();
      if (quote && !validateQuote(quote, a.blocks)) {
        droppedQuotes++;
        quote = '';
      }
      seenFronts.push(front);
      fresh.push({
        id: makeId('cd'),
        front,
        back,
        source: { type: 'cheatsheet', refId: ref, quote },
        headingId: body.headingId,
        // ★ 卡片归属的知识点在生成那一刻就是确定的：slot 指向清单里的第几个节点 ★
        //   以前要靠 `migrateCardConcepts` 事后拿 quote 去猜相似度，实测挂不上 63%
        //   （今天这批 85 张：空引文的 27 张 **挂上 0 张**，有引文的 58 张挂上 72.4%）。
        //   而 slot 是精确坐标 —— 它就是从哪个节点拆出来的。
        conceptKey: slotKeyOf(c.slot),
        sm2: newSm2State(),
        suspended: false,
        createdAt: now,
      });
    });

    if (fresh.length) {
      await updateSidecar(body.rel, (cur) => {
        cur.cards.push(...fresh);
      });
      // 新卡不知道自己属于哪个知识点，后台补挂 conceptKey 并刷新学习状态
      refreshCardMigration();
    }

    // ★ 覆盖核销：清单里没人认领的编号。一个都不漏地报出来，覆盖率因此可核对。
    const uncovered = p.slots.filter((sl) => !covered.has(sl.id));
    res.json({
      cards: fresh,
      created: fresh.length,
      droppedQuotes,
      rejected,
      coverage: {
        slots: p.slots.length,
        covered: p.slots.length - uncovered.length,
        rate: p.slots.length ? (p.slots.length - uncovered.length) / p.slots.length : 1,
        uncovered: uncovered.map((sl) => ({ id: sl.id, label: sl.label })),
      },
    });
  }),
);

studyRouter.post(
  '/cards/from-cheatsheet',
  h(async (req, res) => {
    const body = parse(fromCheatSchema, req.body, '生成闪卡请求');
    const doc = await readDoc(body.rel);
    const a = analyzeDocument(doc.markdown);
    const unit = a.units.find((u) => u.headingId === body.headingId);
    if (!unit) throw new ApiError(404, '找不到这个小节', 'not_found');

    const s = await readSidecar(body.rel);
    const section = s.cheatsheet.sections.find((x) => x.headingId === body.headingId);
    if (!section) throw new ApiError(400, '这一节还没有生成小抄，请先生成小抄再转闪卡', 'no_cheatsheet');

    const docTitle = body.rel.replace(/^.*\//, '').replace(/\.[^.]+$/, '');
    const p = cardsFromCheatsheetPrompt(
      { unit, text: unitText(a.blocks, unit), headingPath: headingPathOf(a.chapters, unit), docTitle },
      section.markdown,
    );
    const shape = await chatJson<CardShape>(
      [
        { role: 'system', content: p.system },
        { role: 'user', content: p.user },
      ],
      { label: '生成闪卡', temperature: 0.3, maxTokens: 8000, timeoutMs: 180_000, thinking: false },
    );

    const refPrefix = `cheatsheet:${body.headingId}`;
    const existingRefs = new Set(s.cards.map((c) => c.source.refId));
    let droppedQuotes = 0;
    const now = new Date().toISOString();
    const fresh: Card[] = [];

    (shape.cards ?? []).forEach((c, idx) => {
      const front = (c.front ?? '').trim();
      const back = (c.back ?? '').trim();
      if (!front || !back) return;
      const refId = `${refPrefix}#${idx}`;
      if (body.skipExisting && existingRefs.has(refId)) return;
      let quote = String(c.quote ?? '').trim();
      if (quote && !validateQuote(quote, a.blocks)) {
        droppedQuotes++;
        quote = '';
      }
      fresh.push({
        id: makeId('cd'),
        front,
        back,
        source: { type: 'cheatsheet', refId, quote },
        headingId: body.headingId,
        sm2: newSm2State(),
        suspended: false,
        createdAt: now,
      });
    });

    await updateSidecar(body.rel, (cur) => {
      cur.cards.push(...fresh);
    });
    // 新卡不知道自己属于哪个知识点，后台补挂 conceptKey 并刷新学习状态
    if (fresh.length) refreshCardMigration();
    res.json({ cards: fresh, created: fresh.length, droppedQuotes });
  }),
);

const fromNotesSchema = z.object({
  rel: z.string().min(1).max(1024),
  noteIds: z.array(z.string().max(64)).max(500).optional(),
  /** 是否保留没有信息量的批注（如「同意」）；默认由 AI 决策 */
  skipExisting: z.boolean().default(true),
});

studyRouter.post(
  '/cards/from-notes',
  h(async (req, res) => {
    const body = parse(fromNotesSchema, req.body, '批注转闪卡请求');
    const s = await readSidecar(body.rel);
    const notes = s.notes.filter((n) => !body.noteIds || body.noteIds.includes(n.id));
    if (notes.length === 0) throw new ApiError(400, '没有任何批注可以转成闪卡', 'no_notes');

    const docTitle = body.rel.replace(/^.*\//, '').replace(/\.[^.]+$/, '');
    const p = cardsFromNotesPrompt(
      docTitle,
      notes.map((n) => ({ body: n.body || '（未写内容）', quote: n.selector.quote })),
    );
    const shape = await chatJson<CardShape>(
      [
        { role: 'system', content: p.system },
        { role: 'user', content: p.user },
      ],
      { label: '批注转闪卡', temperature: 0.3, maxTokens: 8000, timeoutMs: 180_000, thinking: false },
    );

    const a = analyzeDocument((await readDoc(body.rel)).markdown);
    const existingRefs = new Set(s.cards.map((c) => c.source.refId));
    const now = new Date().toISOString();
    const fresh: Card[] = [];
    let droppedQuotes = 0;

    (shape.cards ?? []).forEach((c, idx) => {
      const front = (c.front ?? '').trim();
      const back = (c.back ?? '').trim();
      if (!front || !back) return;
      const refId = `notes:${idx}`;
      if (body.skipExisting && existingRefs.has(refId)) return;
      let quote = String(c.quote ?? '').trim();
      if (quote && !validateQuote(quote, a.blocks)) {
        droppedQuotes++;
        quote = '';
      }
      // 卡片归属到引用所在的章节
      const hit = quote ? validateQuote(quote, a.blocks) : null;
      const headingId = hit ? (a.blocks[hit.blockIndex]?.headingId ?? findHeadingOf(a.blocks, hit.blockIndex)) : '';
      fresh.push({
        id: makeId('cd'),
        front,
        back,
        source: { type: 'note', refId, quote },
        headingId: headingId ?? '',
        sm2: newSm2State(),
        suspended: false,
        createdAt: now,
      });
    });

    await updateSidecar(body.rel, (cur) => {
      cur.cards.push(...fresh);
    });
    if (fresh.length) refreshCardMigration();
    res.json({ cards: fresh, created: fresh.length, droppedQuotes });
  }),
);

/** 从块向上找它所属的标题 id。 */
function findHeadingOf(blocks: { bi: number; headingId?: string }[], bi: number): string {
  for (let i = Math.min(bi, blocks.length - 1); i >= 0; i--) {
    const h = blocks[i]?.headingId;
    if (h) return h;
  }
  return '';
}

/** 新建 / 编辑一张手写卡片。 */
studyRouter.post(
  '/cards',
  h(async (req, res) => {
    const body = parse(
      z.object({
        rel: z.string().min(1).max(1024),
        front: z.string().min(1).max(1000),
        back: z.string().min(1).max(4000),
        headingId: z.string().max(200).default(''),
        quote: z.string().max(2000).default(''),
      }),
      req.body,
      '新建卡片',
    );
    const card: Card = {
      id: makeId('cd'),
      front: body.front.trim(),
      back: body.back.trim(),
      source: { type: 'note', refId: `manual:${Date.now()}`, quote: body.quote },
      headingId: body.headingId,
      sm2: newSm2State(),
      suspended: false,
      createdAt: new Date().toISOString(),
    };
    await updateSidecar(body.rel, (s) => {
      s.cards.push(card);
    });
    refreshCardMigration();
    res.json(card);
  }),
);

studyRouter.patch(
  '/cards/:id',
  h(async (req, res) => {
    const id = (req.params as Record<string, string>).id;
    const body = parse(
      z.object({
        rel: z.string().min(1).max(1024),
        front: z.string().min(1).max(1000).optional(),
        back: z.string().min(1).max(4000).optional(),
        suspended: z.boolean().optional(),
        /** 重置进度 */
        reset: z.boolean().optional(),
        /** 闪卡反馈三件套：null = 取消标注（再点一次同一个图标） */
        fb: z.enum(['up', 'down', 'dup']).nullable().optional(),
        /** ▽ 反馈的理由（随 fb=down 一起写；取消标注时一并清空） */
        fbWhy: z.string().max(300).optional(),
      }),
      req.body,
      '修改卡片',
    );
    const updated = await updateSidecar(body.rel, (s) => {
      const c = s.cards.find((x) => x.id === id);
      if (!c) throw new ApiError(404, '找不到这张卡片', 'not_found');
      if (body.front !== undefined) c.front = body.front;
      if (body.back !== undefined) c.back = body.back;
      if (body.suspended !== undefined) c.suspended = body.suspended;
      if (body.reset) c.sm2 = newSm2State();
      if (body.fb !== undefined) {
        if (body.fb) {
          c.fb = body.fb;
          // 理由只属于 ▽ 反馈：切到其他标注时一并清掉，别留孤儿 fbWhy
          if (body.fb !== 'down') delete c.fbWhy;
        } else {
          // 取消标注：fb 与理由一起清
          delete c.fb;
          delete c.fbWhy;
        }
      }
      if (body.fbWhy !== undefined) {
        if (body.fbWhy) c.fbWhy = body.fbWhy;
        else delete c.fbWhy;
      }
      return c;
    });
    // 反馈写进 learning.json，小笔的 learning_status 才能看到（防并发懒重建）
    if (body.fb !== undefined || body.fbWhy !== undefined) refreshLearning();
    res.json(updated);
  }),
);

studyRouter.delete(
  '/cards/:id',
  h(async (req, res) => {
    const id = (req.params as Record<string, string>).id;
    const rel = qStr(req, 'rel');
    await updateSidecar(rel, (s) => {
      s.cards = s.cards.filter((c) => c.id !== id);
    });
    res.json({ ok: true, id });
  }),
);

// ─────────────────────────── 复习 ───────────────────────────

/** 某篇文章的卡片 + 统计。 */
studyRouter.get(
  '/cards',
  h(async (req, res) => {
    const rel = qStr(req, 'rel');
    const s = await readSidecar(rel);
    const today = qOptStr(req, 'today');
    res.json({ cards: s.cards, stats: deckStats(s.cards, today) });
  }),
);

/**
 * 全库待复习队列。
 * 注意这里跨所有文档聚合，所以每张卡都带上 docPath，前端据此跳回原文。
 */
studyRouter.get(
  '/review/queue',
  h(async (req, res) => {
    const limit = qInt(req, 'limit', 50);
    const today = qOptStr(req, 'today');
    const all = await listAllSidecars();
    const withDoc: (Card & { docPath: string })[] = [];
    let total = 0;
    let dueTotal = 0;
    const forecast = new Array<number>(7).fill(0);

    for (const { docRel, sidecar } of all) {
      total += sidecar.cards.length;
      const st = deckStats(sidecar.cards, today);
      dueTotal += st.due;
      for (let i = 0; i < 7; i++) forecast[i] += st.forecast[i];
      for (const c of dueQueue(sidecar.cards, today)) withDoc.push({ ...c, docPath: docRel });
    }
    // 全局再按到期日 / EF 排一次（跨文档）
    withDoc.sort((a, b) => a.sm2.dueAt.localeCompare(b.sm2.dueAt) || a.sm2.ef - b.sm2.ef);

    res.json({
      queue: withDoc.slice(0, limit),
      stats: { total, due: dueTotal, forecast, returned: Math.min(limit, withDoc.length) },
    });
  }),
);

/**
 * 全库闪卡存量（左栏「今天」那一行用）。
 *
 * ★ 为什么单独一个端点而不是复用 /review/queue ★
 *   queue 只回「到期的」，而她问的是「闪卡是不是太少了」——
 *   那是**存量**问题（总共多少张、多少张挂得上知识点、多少张来自新源），
 *   与今天到期的不是一回事。
 */
studyRouter.get(
  '/cards/stock',
  h(async (_req, res) => {
    const all = await listAllSidecars();
    let total = 0;
    let linked = 0;
    let treeSourced = 0;
    let suspended = 0;
    const perDoc: { doc: string; count: number; linked: number }[] = [];
    for (const { docRel, sidecar } of all) {
      const cards = sidecar.cards ?? [];
      if (!cards.length) continue;
      total += cards.length;
      const l = cards.filter((c) => c.conceptKey).length;
      linked += l;
      suspended += cards.filter((c) => c.suspended).length;
      treeSourced += cards.filter((c) => String(c.source?.refId ?? '').startsWith('tree:')).length;
      perDoc.push({ doc: docRel.replace(/\.md$/, ''), count: cards.length, linked: l });
    }
    perDoc.sort((a, b) => b.count - a.count);
    res.json({
      total,
      linked,
      unlinked: total - linked,
      treeSourced,
      suspended,
      docs: perDoc,
      note: 'linked = 挂了 conceptKey 的（挂不上就没法按概念组织复习）。treeSourced = 知识树换源之后生成的。',
    });
  }),
);

/**
 * 复习计划历史（她问「上次排的是什么」「之前的计划呢」时翻这里）。
 *
 * ★ 为什么要单独一个端点 ★
 *   `saveTodayPlan` 每天覆盖一次 `current`，但同时往 `history` 追加一条。
 *   只给 current 的话她就没法回看——「小笔昨天给我排了什么」是必然会问的问题，
 *   而计划是她唯一能问出「为什么今天是这个」的地方，丢了就没法讨论。
 */
studyRouter.get(
  '/review/plan/history',
  h(async (_req, res) => {
    const root = await requireVaultRoot();
    const p = join(root, DATA_DIR_NAME, 'review-plan.json');
    if (!existsSync(p)) {
      res.json({ history: [], note: '还没有排过计划' });
      return;
    }
    let raw: { history?: unknown };
    try {
      raw = JSON.parse(readFileSync(p, 'utf8'));
    } catch {
      res.json({ history: [], note: '计划文件读不出来' });
      return;
    }
    const history = Array.isArray(raw.history) ? raw.history : [];
    const rows = history
      .slice()
      .reverse()
      .map((x, i) => {
        const o = x as { date?: unknown; plannedBy?: unknown; rationale?: unknown; count?: unknown; at?: unknown };
        return {
          seq: history.length - i,
          date: String(o.date ?? ''),
          plannedBy: o.plannedBy === 'agent' ? '小笔' : '你改的',
          rationale: String(o.rationale ?? ''),
          count: Number(o.count ?? 0),
          at: String(o.at ?? ''),
          isCurrent: i === 0,
        };
      });
    res.json({
      history: rows,
      note: `共 ${rows.length} 版计划。「你改的」说明那次是你现场调整的，不是小笔排的。`,
    });
  }),
);

/**
 * 复习计划（今天栏的数据源）。
 *
 * ★ 为什么单独一套端点而不是复用 /review/queue ★
 *   `/review/queue` 是「到期的卡」（按 SM-2 排），而计划是**三型混排**
 *   （闪卡 / 填空 / 问答），其中填空和问答**根本不是卡**。
 *   两者坐标系不同、生命周期也不同（计划按天覆盖，队列是滚动窗口），硬合并会互相拖累。
 *
 * ★ 三型各自的取材 ★
 *   · card：按 cardId 取卡（前端已有卡片数据）
 *   · blank / qa：按 conceptKey 去**树**里挖料（等式/定义挖空、做法类出问答）——
 *     所以这一段依赖知识树，而不是依赖卡。
 */
studyRouter.get(
  '/review/plan',
  h(async (req, res) => {
    const { readTodayPlan, readLastPlan } = await import('../services/reviewPlan');
    const plan = (await readTodayPlan()) ?? (await readLastPlan());
    if (!plan) {
      res.json({ hasPlan: false, items: [], message: '还没有排过计划。让小笔排一份（「今天复习什么」）。' });
      return;
    }

    // 把三种类型的素材一起给前端：界面一次拿全，不必再逐项请求
    const all = await listAllSidecars();
    const cardsById = new Map<string, (Card & { docPath: string })>();
    for (const { docRel, sidecar } of all) {
      for (const c of sidecar.cards ?? []) cardsById.set(c.id, { ...c, docPath: docRel });
    }

    // 填空/问答按 conceptKey 找同节的树节点：概念库里有 sources 记录它在哪几节
    // ★ material/quizPick 已抽到 services/conceptMaterial.ts（2026-10-11），逻辑逐字搬入，行为不变。
    //   抽出来是为了让 agent 工具层（concept_assets）与 conceptAssets service 复用同一份实现。
    const wanted = new Set(plan.items.map((x) => x.conceptKey).filter(Boolean) as string[]);
    const { materialForConcepts, quizPickForItems } = await import('../services/conceptMaterial');
    const material = await materialForConcepts([...wanted], all);

    const quizPick = await quizPickForItems(plan.items, all);

    // ★ 计划没覆盖到的到期卡补进队列（2026-10-11 修「点今天栏的卡弹出别的概念」）★
    //   今天栏的每一行点击后都会打开 ReviewRoom；此前到期卡不在计划里时，
    //   ReviewRoom 只能回退到第一道未答题——点了 GRPO 却弹出 kvcache。
    //   多鱼拍板：今天的队列 = 计划没覆盖的到期卡 + 计划条目，**补进来的排前面**
    //   （计划外的到期卡本来就更"欠复习"；计划条目在她眼里是已排好的存量）。
    //   打分路径：adhoc 条目走 SM-2 直接打分（见 /review/plan/answer 的 adhoc 分支），不写计划文件。
    const today = localDate();
    const plannedCardIds = new Set(plan.items.map((x) => x.cardId).filter(Boolean) as string[]);
    const adhoc = dueQueue([...cardsById.values()], today)
      .filter((c) => !plannedCardIds.has(c.id))
      .map((c) => ({
        id: `adhoc-${c.id}`,
        kind: 'card' as const,
        why: '今天到期，计划里没排到，补进来的卡',
        cardId: c.id,
        conceptKey: c.conceptKey ?? undefined,
        question: undefined,
        result: null,
        card: c,
        material: null,
        quiz: null,
        quizTotal: 0,
        quizFrom: null,
      }));

    res.json({
      hasPlan: true,
      date: plan.date,
      plannedBy: plan.plannedBy,
      rationale: plan.rationale,
      today: localDate(),
      items: [
        // ★ 补进来的到期卡排前面（2026-10-11 她定）★
        ...adhoc,
        ...plan.items.map((x) => ({
        id: x.id,
        kind: x.kind,
        why: x.why,
        cardId: x.cardId,
        conceptKey: x.conceptKey,
        question: x.question,
        result: x.result ?? null,
        card: x.cardId ? cardsById.get(x.cardId) ?? null : null,
        material: x.conceptKey ? material[x.conceptKey] ?? null : null,
        quiz: quizPick[x.id]?.question ?? null,
        quizTotal: quizPick[x.id]?.total ?? 0,
        quizFrom: quizPick[x.id]?.from ?? null,
      })),
      ],
    });
  }),
);

/** 记一条作答结果（写回计划；agent 后续据此排得更准）。 */
studyRouter.post(
  '/review/plan/answer',
  h(async (req, res) => {
    const body = parse(
      z.object({
        itemId: z.string().min(1).max(200),
        verdict: z.enum(['again', 'hard', 'good', 'correct', 'partial', 'wrong', 'skipped']),
        note: z.string().max(500).optional(),
      }),
      req.body,
      '记作答',
    );
    const { recordPlanResult, ApiPlanError } = await import('../services/reviewPlan');
    try {
      // ★ adhoc 条目（计划外补进来的到期卡）★ 不写计划文件，直接按 SM-2 打分——
      //   它们的 id 形如 `adhoc-<cardId>`，本来就不在计划里，recordPlanResult 会 404。
      if (body.itemId.startsWith('adhoc-')) {
        const cardId = body.itemId.slice('adhoc-'.length);
        if (body.verdict !== 'again' && body.verdict !== 'hard' && body.verdict !== 'good') {
          throw new ApiError(400, `到期卡只接受 again/hard/good，收到 ${body.verdict}`, 'bad_verdict');
        }
        const all = await listAllSidecars();
        const hit = all.find(({ sidecar }) => (sidecar.cards ?? []).some((c) => c.id === cardId));
        if (!hit) throw new ApiError(404, `找不到 cardId=${cardId} 所在文档`, 'not_found');
        const next = await updateSidecar(hit.docRel, (s) => {
          const c = s.cards.find((x) => x.id === cardId);
          if (!c) throw new ApiError(404, '找不到这张卡片', 'not_found');
          c.sm2 = schedule(c.sm2, body.verdict as Grade);
          return { card: c };
        });
        await appendReviewLog({
          at: new Date().toISOString(),
          kind: 'card',
          docPath: hit.docRel,
          cardId,
          grade: body.verdict,
          dueAt: next.card.sm2.dueAt,
          durationMs: 0,
        });
        res.json({ ok: true, answered: 0, total: 0, adhoc: { cardId, doc: hit.docRel, dueAt: next.card.sm2.dueAt } });
        return;
      }
      const plan = await recordPlanResult(body.itemId, {
        verdict: body.verdict,
        note: body.note,
        at: new Date().toISOString(),
      });
      // ★ verdict 写回 SM-2（S2b）：计划里答错的卡要让 SM-2 队列知道，不然它明天照旧不排。
      //   开关 NB_PLAN_SM2_WRITE 默认关（关闭时本行无副作用，行为与旧版逐字节一致）。
      const { applyVerdictToSm2 } = await import('../services/todayActions');
      const writeBack = await applyVerdictToSm2(plan, body.itemId, body.verdict);
      const done = plan.items.filter((x) => x.result).length;
      res.json({ ok: true, answered: done, total: plan.items.length, sm2WriteBack: writeBack });
    } catch (e) {
      if (e instanceof ApiPlanError) throw new ApiError(409, e.message, 'no_plan');
      throw e;
    }
  }),
);

/**
 * 今天的统一行动清单（2026-10-11，S2b）。
 *
 * ★ 三口径合一 ★ SM-2 到期 + 小笔计划 + 考频合并成一份 ActionRow 列表，
 *   每行 reasons 结构化写清「为什么在这」——前端常驻展示，不再藏 tooltip。
 *   旧端点 /frequency/top 与 /review/plan 保留（本端点内部消费同一批 service；
 *   StudyPanel/TreePanel 的旧口径前端直调将逐步切到这里）。
 */
studyRouter.get(
  '/today',
  h(async (_req, res) => {
    const { collectTodayActions } = await import('../services/todayActions');
    const { rows, meta } = await collectTodayActions();
    res.json({ today: meta.date, rows, meta });
  }),
);

/**
 * 节级考频 top-N（左栏「今天」用）。
 *
 * ★ 为什么现算不落盘 ★
 *   考频是**派生值**：markdown（面经文件）是唯一事实源，signature 变了就重算。
 *   徽章那一侧走 cheatsheet.ts 的现算路径，这里是同一个 service，缓存共享。
 */
studyRouter.get(
  '/frequency/top',
  h(async (req, res) => {
    const n = qInt(req, 'n', 6);
    const relRaw = qOptStr(req, 'rel');
    // ★ 坐标系对齐 ★ `rel` 与 sidecar / 树节同一个坐标系（去 .md），
    //   而前端拿到的 doc.path 是带 .md 的——在这里对齐，别让每个调用方各 strip 一次。
    const rel = relRaw ? relRaw.replace(/\.md$/i, '') : undefined;
    const all = await computeSectionFrequency();
    // 有 rel 时给这一篇的全部（有考频的节），供闪卡分组挂徽章——
    // 前端不该自己去截 topN，截了就拿不到自己那几节。
    const rows = all.sections.filter((s) => s.marks > 0 && (!rel || s.rel === rel));
    res.json({
      signature: all.signature,
      computedAt: all.computedAt,
      unresolved: all.unresolved,
      sections: rel ? rows : rows.slice(0, n),
    });
  }),
);

/**
 * 全库所有卡片（用于导出）。
 *
 * 不能复用 /review/queue：那个接口只返回**到期**的卡、还带 limit，
 * 拿它导出会静默丢掉绝大多数卡。这里要的是全量、不过滤、不截断。
 */
studyRouter.get(
  '/cards/all',
  h(async (_req, res) => {
    const all = await listAllSidecars();
    const cards: (Card & { docPath: string })[] = [];
    for (const { docRel, sidecar } of all) {
      for (const c of sidecar.cards) cards.push({ ...c, docPath: docRel });
    }
    // 按文章 + 创建时间排序：导出顺序稳定，用户每次导出的文件才好对比
    cards.sort((a, b) => a.docPath.localeCompare(b.docPath, 'zh') || a.createdAt.localeCompare(b.createdAt));
    res.json({ cards, total: cards.length });
  }),
);

const reviewSchema = z.object({
  rel: z.string().min(1).max(1024),
  cardId: z.string().min(1).max(64),
  grade: z.enum(['forgot', 'hard', 'good']),
  /** 复习耗时，用于统计 */
  durationMs: z.number().int().min(0).max(3600_000).default(0),
});

studyRouter.post(
  '/review',
  h(async (req, res) => {
    const body = parse(reviewSchema, req.body, '复习请求');
    const next = await updateSidecar(body.rel, (s) => {
      const c = s.cards.find((x) => x.id === body.cardId);
      if (!c) throw new ApiError(404, '找不到这张卡片', 'not_found');
      c.sm2 = schedule(c.sm2, body.grade as Grade);
      return { card: c };
    });
    await appendReviewLog({
      at: new Date().toISOString(),
      kind: 'card',
      docPath: body.rel,
      cardId: body.cardId,
      grade: body.grade,
      dueAt: next.card.sm2.dueAt,
      durationMs: body.durationMs,
    });
    res.json(next);
  }),
);

/**
 * ★ 小抄条目的偏好标注 —— 系统里唯一「人的判断」入口 ★
 *
 * 为什么走 ik（内容 hash）而不是下标：条目顺序会随去重、合并、重新生成而变，
 * 下标一变就标错人。内容 hash 天然稳定，同一句话不管排第几都是同一个 key。
 *
 * mark 传 null 表示取消标注（再点一次同一个图标就取消）。
 */
const feedbackSchema = z.object({
  rel: z.string().min(1).max(1024),
  headingId: z.string().min(1).max(64),
  ik: z.string().min(1).max(32),
  mark: z.enum(['up', 'down', 'dup']).nullable(),
  why: z.string().max(300).optional(),
});

studyRouter.post(
  '/cheatsheet/feedback',
  h(async (req, res) => {
    const body = parse(feedbackSchema, req.body, '偏好标注');
    const at = new Date().toISOString();
    /** 评测集快照：标注那一刻把条目原文+引文+标注拍下来（只追加，重生成毁不掉）。 */
    const evalEvents: EvalEvent[] = [];
    /** 回收站裁决结果（回调里产生，响应里带回给前端决定刷不刷面板） */
    let binAction: 'resurrected' | 'removed' | null = null;
    await updateSidecar(body.rel, (s) => {
      const sec = (s.cheatsheet?.sections ?? []).find((x) => x.headingId === body.headingId);
      if (!sec?.items) throw new ApiError(404, '找不到这一节', 'not_found');
      const hit = (text: string) => itemKeyOf((text ?? '').trim()) === body.ik;
      const snap = (layer: EvalEvent['layer'], kind: string | undefined, text: string, quote: string | undefined) => {
        evalEvents.push({
          at,
          source: body.mark ? 'user' : 'cancel',
          doc: body.rel,
          headingId: body.headingId,
          headingText: sec.headingText,
          layer,
          kind,
          text: text.trim(),
          quote: (quote ?? '').trim() || undefined,
          mark: body.mark ?? undefined,
          why: body.why,
        });
      };
      let found = false;
      for (const p of sec.items.propositions ?? []) {
        if (!hit(p.statement ?? '')) continue;
        if (body.mark) p.feedback = { mark: body.mark, why: body.why, at };
        else delete p.feedback;
        snap('命题', undefined, p.statement ?? '', p.quote);
        found = true;
      }
      for (const e of sec.items.entries ?? []) {
        if (!hit(e.text ?? '')) continue;
        if (body.mark) e.feedback = { mark: body.mark, why: body.why, at };
        else delete e.feedback;
        snap('条目', e.kind, e.text ?? '', e.quote);
        found = true;
      }
      // ★ 术语在渲染时被 mergeTermsIntoEntries 并成了【定义】，但落盘在 items.terms 里 ★
      //   不匹配这一层，就会出现「界面上看得见、服务端说不在库里」的报错。
      for (const t of sec.items.terms ?? []) {
        const text = `${(t.term ?? '').trim()}：${(t.meaning ?? '').trim()}`;
        if (!hit(text)) continue;
        if (body.mark) t.feedback = { mark: body.mark, why: body.why, at };
        else delete t.feedback;
        snap('术语', undefined, text, t.quote);
        found = true;
      }
      // ★ 知识树的标注（2026-09-20）：essence 与细节条和小抄条目**同构**（ik 都是内容
      //   hash），走同一个通道、进同一份评测集——不另起一套「树的反馈接口」。
      //   layer 用 树节点/树条 区分，digest 与评测分析按层分桶时不会混。
      const tree = sec.tree;
      if (tree) {
        for (const n of tree.nodes ?? []) {
          if (n.essence && hit(n.essence)) {
            if (body.mark) n.feedback = { mark: body.mark, why: body.why, at };
            else delete n.feedback;
            snap('树节点', n.kind, n.essence, undefined);
            found = true;
          }
          for (const d of n.details ?? []) {
            if (!d.text || !hit(d.text)) continue;
            if (body.mark) d.feedback = { mark: body.mark, why: body.why, at };
            else delete d.feedback;
            snap('树条', d.kind, d.text, d.quote);
            found = true;
          }
        }
      }
      if (!found) {
        // ★ 回收站：合并层裁掉的条目也有三件套 ★
        //   ▲ = 复活回正文（用户判断优先于模型取舍）；▽/⧉ = 确认裁决并移除。
        //   裁决质量以前没有反馈通道，现在每一次 ▲/▽ 都是评测数据。
        const binHit = sec.dropped?.length ? applyBinFeedback({ items: sec.items, dropped: sec.dropped }, body.ik, body.mark) : null;
        if (binHit?.found) {
          found = true;
          binAction = binHit.action;
          if (binHit.action && binHit.event) {
            evalEvents.push({
              at,
              source: 'user',
              doc: body.rel,
              headingId: body.headingId,
              headingText: sec.headingText,
              layer: binHit.event.layer,
              kind: binHit.event.kind,
              text: binHit.event.text,
              quote: binHit.event.quote,
              mark: body.mark ?? undefined,
              why: body.why,
              bin: true,
            });
          }
        }
      }
      if (!found) throw new ApiError(404, '这条小抄不在库里（可能已重新生成）', 'not_found');
    });
    const digest = await writeFeedbackDigest();
    await appendEvalEvents(evalEvents);
    res.json({ ok: true, bin: binAction, digest: { total: digest.total, up: digest.up, down: digest.down, dup: digest.dup } });
  }),
);

/** 复习热力/统计（来自 review-log）。 */
studyRouter.get(
  '/review/stats',
  h(async (_req, res) => {
    const { readReviewLog } = await import('../services/sidecar');
    const log = await readReviewLog(2000);
    const byDay = new Map<string, { cards: number; quizzes: number; quizScoreSum: number }>();
    for (const e of log) {
      const at = typeof e.at === 'string' ? e.at.slice(0, 10) : '';
      if (!at) continue;
      const cur = byDay.get(at) ?? { cards: 0, quizzes: 0, quizScoreSum: 0 };
      if (e.kind === 'card') cur.cards++;
      if (e.kind === 'quiz') {
        cur.quizzes++;
        cur.quizScoreSum += typeof e.score === 'number' ? e.score : 0;
      }
      byDay.set(at, cur);
    }
    const days = [...byDay.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, v]) => ({ date, ...v, avgScore: v.quizzes ? Math.round(v.quizScoreSum / v.quizzes) : null }));
    res.json({ days, events: log.length });
  }),
);

// ─────────────────────────── AI 排版 ───────────────────────────

const aiFormatSchema = z.object({
  markdown: z.string().min(1).max(2 * 1024 * 1024),
});

/**
 * AI 版一键排版：规则版做不好的情况（结构极其混乱、来源是 OCR 结果）才用它。
 * 提示词里反复强调「只排版不改内容」，但模型仍可能微调措辞，
 * 所以前端必须把结果放进**可编辑的预览**里让用户确认，不要直接落盘。
 */
studyRouter.post(
  '/format/ai',
  h(async (req, res) => {
    const body = parse(aiFormatSchema, req.body, 'AI 排版请求');
    const p = formatPrompt(body.markdown);
    const out = await chat(
      [
        { role: 'system', content: p.system },
        { role: 'user', content: p.user },
      ],
      // 排版是「重写整篇文档」，输出很长；再加上推理模型的思考也占这份额度，
      // 给少了会直接返回空字符串。给足——没用完的额度不计费。
      // ★ 现已关掉思考模式（10-10）：不再靠堆额度绕开「思考吃光正文」，
      //   32000 保留是为了容纳「重写整篇」本身的长输出。
      { temperature: 0, maxTokens: 32000, timeoutMs: 300_000, thinking: false },
    );
    // 模型经常仍然套一层 ```markdown 围栏，剥掉
    const cleaned = out
      .replace(/^\s*```(?:markdown|md)?\s*\n?/i, '')
      .replace(/\n?```\s*$/, '')
      .trim();
    // 空结果多半是「思考把额度用完了」。明确报错，别让用户拿到一篇空白文档。
    if (!cleaned) {
      throw new ApiError(
        502,
        'AI 排版没有返回任何内容。多半是输出额度被模型的思考过程占满了——请稍后重试，或对长文档分段处理。',
        'ai_empty_output',
      );
    }
    res.json({ markdown: cleaned + '\n', mode: 'ai' });
  }),
);
