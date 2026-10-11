/**
 * server/routes/search.ts —— 跨文章检索与问答。
 *
 * 这是全项目第一个「看得到整库」的功能：小抄 / 测验 / 闪卡都只作用于当前
 * 打开的那一篇文章的那一节，而这里能一次性检索所有文章。
 *
 * 两条设计约束：
 *   1. **检索和生成用两套不同的 API。** embedding 走独立配置（见 services/embed.ts），
 *      生成回答走已经在用的对话接口。任何一边没配好，另一边照常工作。
 *   2. **结果必须能跳回原文。** 每条命中都带 docRel + startBi，前端点一下就打开文章
 *      并滚到对应块。检索不能回答、只能导航的话，价值就少了一半。
 */

import { Router } from 'express';
import { ApiError } from '../core';
import { chat, getAiSettings } from '../services/aiClient';
import { passagesFromHits, scanPassages, type ConflictScan, type ScanPassage } from '../services/conflict';
import { ragAnswerPrompt, type RagConflict, type RagPassage } from '../services/prompts';
import { buildIndex, clearIndex, indexStatus, renderMdInline, search, type SearchHit } from '../services/vectorstore';
import { h, parse, qInt, qStr, z } from './http';

export const searchRouter = Router();

// ─────────────────────────── 索引管理 ───────────────────────────

searchRouter.get(
  '/search/status',
  h(async (_req, res) => {
    res.json(await indexStatus());
  }),
);

const buildSchema = z.object({ force: z.boolean().optional() });

searchRouter.post(
  '/search/index',
  h(async (req, res) => {
    const body = parse(buildSchema, req.body ?? {}, '重建索引');
    const report = await buildIndex({ force: body.force });
    res.json(report);
  }),
);

searchRouter.delete(
  '/search/index',
  h(async (_req, res) => {
    await clearIndex();
    res.json({ ok: true as const });
  }),
);

// ─────────────────────────── 检索 ───────────────────────────

searchRouter.get(
  '/search',
  h(async (req, res) => {
    const q = qStr(req, 'q');
    const topK = Math.min(Math.max(qInt(req, 'topK', 8), 1), 30);
    const r = await search(q, topK);
    res.json(r);
  }),
);

const askSchema = z.object({
  question: z.string().min(1, '问题不能为空').max(2000),
  topK: z.number().int().min(1).max(20).optional(),
  /** 要不要在回答前先查一遍「这几段里有没有互相打架的说法」 */
  conflicts: z.boolean().optional(),
});

/**
 * 问答：先检索，再把命中的片段连同问题一起交给对话模型。
 *
 * 为什么不让模型自己决定看哪些文章：整库正文塞进提示词会瞬间超限，
 * 而且「跨文章」正是这个功能存在的理由。先检索出 6~8 段再生成，
 * 既省钱又能保证答案确实来自笔记而不是模型的记忆。
 *
 * ★ 冲突检查为什么要放在这里 ★
 *   检索是用户**真的在关心一个话题**的时刻，这时候顺带告诉他
 *   「你笔记里有两处说法对不上」才有意义。全库体检没人会主动点。
 *   代价是多一次判定调用（几条候选、千把 token），所以做成可关的开关。
 *   而且它失败绝不影响回答：查矛盾出问题就静默降级，只给回答和命中列表。
 */
searchRouter.post(
  '/search/ask',
  h(async (req, res) => {
    const body = parse(askSchema, req.body, '提问');
    const topK = body.topK ?? 6;

    const ai = await getAiSettings();
    if (!ai.configured) {
      throw new ApiError(
        409,
        '还没有配置对话接口，无法生成回答。可以在「设置 → AI 接口」里配好，或者只用「找片段」模式。',
        'ai_not_configured',
      );
    }

    const r = await search(body.question, topK);
    if (!r.hits.length) {
      res.json({
        answer: '笔记库里没有找到相关内容。',
        answerHtml: '<p>笔记库里没有找到相关内容。</p>',
        hits: [],
        mode: r.mode,
        notice: r.notice,
        model: ai.model,
      });
      return;
    }

    let scan: ConflictScan | null = null;
    if (body.conflicts) {
      try {
        scan = await scanPassages(passagesFromHits(r.hits), { max: 6 });
      } catch {
        /* 查矛盾失败绝不能让人问不出问题：当成「没查到分歧」继续 */
        scan = null;
      }
    }
    const conflicts: RagConflict[] = (scan?.items ?? [])
      .filter((c) => c.verdict === 'contradiction')
      .map((c) => ({
        aN: c.aN,
        bN: c.bN,
        aClaim: c.aClaim,
        bClaim: c.bClaim,
        conflictAt: c.conflictAt,
        reason: c.reason,
      }));

    const passages: RagPassage[] = r.hits.map((hit: SearchHit, i) => ({
      n: i + 1,
      docTitle: hit.docTitle,
      headingPath: hit.headingPath,
      text: hit.text,
    }));

    const { system, user } = ragAnswerPrompt(body.question, passages, conflicts);
    const answer = await chat(
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      { temperature: 0.2, maxTokens: 2000, timeoutMs: 90_000 },
    );

    const answerText = answer.trim();
    res.json({
      answer: answerText,
      // 模型回答是 markdown，前端直接显示会把 ** 一起显示出来，所以这里渲染好再给
      answerHtml: renderMdInline(answerText),
      hits: r.hits,
      mode: r.mode,
      notice: r.notice,
      model: ai.model,
      scan,
    });
  }),
);

// ─────────────────────── 检索结果里的矛盾检查 ───────────────────────

const scanSchema = z.object({
  /** 直接带上前端已经拿到的命中，保证「检查的就是屏幕上这几条」 */
  hits: z
    .array(
      z.object({
        id: z.string(),
        docRel: z.string(),
        docTitle: z.string(),
        headingText: z.string().optional().default(''),
        headingPath: z.array(z.string()).optional().default([]),
        startBi: z.number(),
        text: z.string(),
      }),
    )
    .min(2)
    .max(20),
  max: z.number().int().min(1).max(20).optional(),
});

/**
 * 在「这一批命中」内部查矛盾（找片段模式的按钮走这里）。
 *
 * 只在 k 条命中里两两比（8 条 = 28 对），不建全库图，毫秒级。
 * 会调一次判定模型，所以是 POST —— 让「花不花这笔钱」由用户点不点决定。
 */
searchRouter.post(
  '/search/conflicts',
  h(async (req, res) => {
    const body = parse(scanSchema, req.body, '矛盾检查');
    const ai = await getAiSettings();
    if (!ai.configured) {
      throw new ApiError(
        409,
        '「矛盾检查」需要模型来判断两段话是不是真的互相排斥。请先在「设置 → AI 接口」里配好。',
        'ai_not_configured',
      );
    }
    const passages: ScanPassage[] = body.hits.map((hit, i) => ({
      n: i + 1,
      id: hit.id,
      docRel: hit.docRel,
      docTitle: hit.docTitle,
      headingText: hit.headingText,
      headingPath: hit.headingPath,
      startBi: hit.startBi,
      text: hit.text,
    }));
    res.json(await scanPassages(passages, { max: body.max ?? 6 }));
  }),
);
