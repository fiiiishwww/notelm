/**
 * server/routes/sidecar.ts —— 批注、高亮、以及锚点的修复/重绑。
 *
 * 并发模型：所有写操作都走 updateSidecar（读-改-写 + 单文件串行队列），
 * 所以「一边在编辑器里保存文章、一边在右侧写批注」不会互相覆盖。
 *
 * ★ 关于 orphan（锚点失效）★
 *   服务端**永远不会**替用户猜一个位置。失效的批注会带着 anchorState='orphan'
 *   原样返回，前端把它显示成「已失效，点击重新绑定」，由用户决定绑到哪。
 *   只有用户明确点选之后，我们才会调 /anchors/rebind 覆写 selector。
 */

import { Router } from 'express';
import { z } from 'zod';
import { ApiError, bad } from '../core';
import { makeId, type Highlight, type Note, type TextQuoteSelector } from '../../shared/text';
import { analyzeDocument } from '../../shared/blocks';
import { readDoc } from '../vault';
import { readSidecar, updateSidecar } from '../services/sidecar';
import { reanchorSidecar, validateQuote } from '../services/anchor';
import { addNoteReply } from '../services/notes';
import { h, parse, pStr, qStr, z as zod } from './http';

export const sidecarRouter = Router();

const selectorSchema = z.object({
  type: z.literal('text-quote'),
  quote: z.string().min(1).max(2000),
  prefix: z.string().max(4000).default(''),
  suffix: z.string().max(4000).default(''),
  blockIndex: z.number().int().min(0),
  textOffset: z.number().int().min(0),
  headingId: z.string().max(200).optional(),
  quoteLength: z.number().int().min(0),
});

const colorSchema = z.enum(['yellow', 'green', 'blue', 'pink', 'purple']);

function asSelector(s: z.infer<typeof selectorSchema>): TextQuoteSelector {
  return {
    type: 'text-quote',
    quote: s.quote,
    prefix: s.prefix,
    suffix: s.suffix,
    blockIndex: s.blockIndex,
    textOffset: s.textOffset,
    headingId: s.headingId,
    quoteLength: s.quoteLength || s.quote.length,
  };
}

/** 校验 selector 是否落在一篇真实的文档上（防止前端传来越界的 blockIndex）。 */
async function assertSelectorFits(rel: string, sel: TextQuoteSelector, blocksLenGuard = true): Promise<void> {
  const doc = await readDoc(rel);
  const a = analyzeDocument(doc.markdown);
  if (blocksLenGuard && sel.blockIndex >= a.blocks.length) {
    throw bad(`块序号 ${sel.blockIndex} 超出范围（本文共 ${a.blocks.length} 块），可能是文章已改动`, 'selector_out_of_range');
  }
  const b = a.blocks[sel.blockIndex];
  if (b && sel.textOffset > b.text.length) {
    throw bad('批注位置超出该段落的长度，可能是文章已改动，请重新选择文本', 'selector_out_of_range');
  }
  return;
}

// ─────────────────────────── 新建批注 ───────────────────────────

const createNoteSchema = z.object({
  rel: z.string().min(1).max(1024),
  selector: selectorSchema,
  body: z.string().max(20_000).default(''),
  tags: z.array(z.string().max(50)).max(30).default([]),
  color: colorSchema.default('yellow'),
  /** 是否同时在正文里画一个高亮（默认 true） */
  createHighlight: z.boolean().default(true),
});

sidecarRouter.post(
  '/notes',
  h(async (req, res) => {
    const body = parse(createNoteSchema, req.body, '新建批注');
    const sel = asSelector(body.selector);
    await assertSelectorFits(body.rel, sel);

    const now = new Date().toISOString();
    const noteId = makeId('nt');
    const highlightId = body.createHighlight ? makeId('hl') : null;

    const created = await updateSidecar(body.rel, (s) => {
      const note: Note = {
        id: noteId,
        selector: sel,
        body: body.body,
        tags: body.tags,
        color: body.color,
        anchorState: 'ok',
        repairHistory: [],
        createdAt: now,
        updatedAt: now,
      };
      s.notes.push(note);

      let hl: Highlight | null = null;
      if (highlightId) {
        hl = {
          id: highlightId,
          selector: { ...sel },
          noteId,
          color: body.color,
          anchorState: 'ok',
          createdAt: now,
          updatedAt: now,
        };
        s.highlights.push(hl);
      }
      return { note, highlight: hl };
    });

    res.json(created);
  }),
);

const patchNoteSchema = z.object({
  rel: z.string().min(1).max(1024),
  body: z.string().max(20_000).optional(),
  tags: z.array(z.string().max(50)).max(30).optional(),
  color: colorSchema.optional(),
});

sidecarRouter.patch(
  '/notes/:id',
  h(async (req, res) => {
    const id = pStr(req, 'id');
    const body = parse(patchNoteSchema, req.body, '修改批注');
    const updated = await updateSidecar(body.rel, (s) => {
      const n = s.notes.find((x) => x.id === id);
      if (!n) throw new ApiError(404, '找不到这条批注', 'not_found');
      if (body.body !== undefined) n.body = body.body;
      if (body.tags !== undefined) n.tags = body.tags;
      if (body.color !== undefined) {
        n.color = body.color;
        // 颜色是批注和高亮共享的，改了批注就同步改掉它对应的那个高亮
        for (const hl of s.highlights) if (hl.noteId === id) hl.color = body.color;
      }
      n.updatedAt = new Date().toISOString();
      return n;
    });
    res.json(updated);
  }),
);

sidecarRouter.delete(
  '/notes/:id',
  h(async (req, res) => {
    const id = pStr(req, 'id');
    const rel = qStr(req, 'rel');
    /** 默认连高亮一起删；?keepHighlight=1 时只删批注，保留纯高亮 */
    const keepHighlight = req.query.keepHighlight === '1';
    await updateSidecar(rel, (s) => {
      const i = s.notes.findIndex((x) => x.id === id);
      if (i < 0) throw new ApiError(404, '找不到这条批注', 'not_found');
      s.notes.splice(i, 1);
      if (keepHighlight) {
        for (const hl of s.highlights) if (hl.noteId === id) hl.noteId = null;
      } else {
        s.highlights = s.highlights.filter((hl) => hl.noteId !== id);
      }
      // 由这条批注生成的闪卡也一并清掉，避免留下无源之卡
      s.cards = s.cards.filter((c) => !(c.source.type === 'note' && c.source.refId === id));
    });
    res.json({ ok: true, id });
  }),
);

// ─────────────────────────── 批注回复 ───────────────────────────

/**
 * 在一条批注下追加回复（B2-2 批注回复通道，2026-09-22 接入）。
 *
 * 落盘走 services/notes.addNoteReply（updateSidecar 串行队列）。
 * author 默认 'user'（这里是人类入口）；agent/MCP 的回复由它们各自的
 * 入口把 author 定死为 'assistant'，两侧共用同一个服务层实现。
 */
const replySchema = z.object({
  rel: z.string().min(1).max(1024),
  body: z.string().min(1).max(20_000),
  author: z.enum(['user', 'assistant']).default('user'),
  source: z.string().max(64).optional(),
});

sidecarRouter.post(
  '/notes/:id/replies',
  h(async (req, res) => {
    const id = pStr(req, 'id');
    const body = parse(replySchema, req.body, '批注回复');
    const reply = await addNoteReply(body.rel, id, body.author, body.body, body.source ?? 'web');
    res.json(reply);
  }),
);

// ─────────────────────────── 高亮 ───────────────────────────

const createHighlightSchema = z.object({
  rel: z.string().min(1).max(1024),
  selector: selectorSchema,
  color: colorSchema.default('yellow'),
  noteId: z.string().max(64).nullable().default(null),
});

sidecarRouter.post(
  '/highlights',
  h(async (req, res) => {
    const body = parse(createHighlightSchema, req.body, '新建高亮');
    const sel = asSelector(body.selector);
    await assertSelectorFits(body.rel, sel);
    const now = new Date().toISOString();
    const created = await updateSidecar(body.rel, (s) => {
      const hl: Highlight = {
        id: makeId('hl'),
        selector: sel,
        noteId: body.noteId,
        color: body.color,
        anchorState: 'ok',
        createdAt: now,
        updatedAt: now,
      };
      s.highlights.push(hl);
      return hl;
    });
    res.json(created);
  }),
);

sidecarRouter.patch(
  '/highlights/:id',
  h(async (req, res) => {
    const id = pStr(req, 'id');
    const body = parse(
      z.object({ rel: z.string().min(1).max(1024), color: colorSchema.optional(), noteId: z.string().max(64).nullable().optional() }),
      req.body,
      '修改高亮',
    );
    const updated = await updateSidecar(body.rel, (s) => {
      const hl = s.highlights.find((x) => x.id === id);
      if (!hl) throw new ApiError(404, '找不到这个高亮', 'not_found');
      if (body.color !== undefined) hl.color = body.color;
      if (body.noteId !== undefined) hl.noteId = body.noteId;
      hl.updatedAt = new Date().toISOString();
      return hl;
    });
    res.json(updated);
  }),
);

sidecarRouter.delete(
  '/highlights/:id',
  h(async (req, res) => {
    const id = pStr(req, 'id');
    const rel = qStr(req, 'rel');
    await updateSidecar(rel, (s) => {
      const i = s.highlights.findIndex((x) => x.id === id);
      if (i < 0) throw new ApiError(404, '找不到这个高亮', 'not_found');
      const hl = s.highlights[i];
      s.highlights.splice(i, 1);
      // 如果这个高亮挂着一篇批注，把批注的 noteId 反向引用也清掉（批注本身留着）
      if (hl.noteId) {
        const n = s.notes.find((x) => x.id === hl.noteId);
        if (n) n.updatedAt = new Date().toISOString();
      }
    });
    res.json({ ok: true, id });
  }),
);

// ─────────────────────────── 锚点修复 ───────────────────────────

/** 手动触发一次全量重锚（用户在「锚点失效」提示条上点「重新定位」）。 */
sidecarRouter.post(
  '/anchors/reanchor',
  h(async (req, res) => {
    const body = parse(z.object({ rel: z.string().min(1).max(1024) }), req.body, '重锚请求');
    const doc = await readDoc(body.rel);
    const a = analyzeDocument(doc.markdown);

    const report = await updateSidecar(body.rel, (s) => {
      const r = reanchorSidecar(s, a.blocks, 4000);
      // 章节/单元跟着最新分析走
      s.chapters = a.chapters;
      s.units = a.units;
      s.docHash = doc.docHash;
      s.indexedAt = new Date().toISOString();
      return r;
    });
    res.json({ report });
  }),
);

/**
 * 用户手动把一条失效批注绑到新的位置。
 * 只在用户明确操作后才走这里——服务端不会自己猜。
 */
const rebindSchema = z.object({
  rel: z.string().min(1).max(1024),
  kind: z.enum(['note', 'highlight']),
  id: z.string().min(1).max(64),
  selector: selectorSchema,
});

sidecarRouter.post(
  '/anchors/rebind',
  h(async (req, res) => {
    const body = parse(rebindSchema, req.body, '重绑请求');
    const sel = asSelector(body.selector);
    await assertSelectorFits(body.rel, sel);
    const updated = await updateSidecar(body.rel, (s) => {
      const list: (Note | Highlight)[] = body.kind === 'note' ? s.notes : s.highlights;
      const ent = list.find((x) => x.id === body.id);
      if (!ent) throw new ApiError(404, '找不到这条记录', 'not_found');
      const from = { blockIndex: ent.selector.blockIndex, textOffset: ent.selector.textOffset };
      ent.selector = sel;
      ent.anchorState = 'ok';
      if (body.kind === 'note') {
        const n = ent as Note;
        if (!Array.isArray(n.repairHistory)) n.repairHistory = [];
        n.repairHistory.push({
          at: new Date().toISOString(),
          reason: 'manual-rebind',
          from,
          to: { blockIndex: sel.blockIndex, textOffset: sel.textOffset },
        });
        if (n.repairHistory.length > 20) n.repairHistory.splice(0, n.repairHistory.length - 20);
        n.updatedAt = new Date().toISOString();
      } else {
        (ent as Highlight).updatedAt = new Date().toISOString();
      }
      // 批注和它的高亮位置保持一致
      if (body.kind === 'note') {
        for (const hl of s.highlights) if (hl.noteId === body.id) hl.selector = { ...sel };
      }
      return ent;
    });
    res.json(updated);
  }),
);

/** 用一段原文反查它在哪个块（用户从别处粘贴一句话当锚点时的辅助）。 */
sidecarRouter.post(
  '/anchors/locate',
  h(async (req, res) => {
    const body = parse(z.object({ rel: z.string().min(1).max(1024), quote: z.string().min(2).max(2000) }), req.body, '定位请求');
    const doc = await readDoc(body.rel);
    const a = analyzeDocument(doc.markdown);
    const hit = validateQuote(body.quote, a.blocks);
    if (!hit) {
      res.json({ found: false });
      return;
    }
    res.json({ found: true, blockIndex: hit.blockIndex, textOffset: hit.index, quoteLength: body.quote.trim().length });
  }),
);

/** 当前文档的锚点健康度（前端在右下角显示「2 条失效」）。 */
sidecarRouter.get(
  '/anchors/health',
  h(async (req, res) => {
    const rel = qStr(req, 'rel');
    const s = await readSidecar(rel);
    const notes = { total: s.notes.length, orphan: s.notes.filter((n) => n.anchorState === 'orphan').length };
    const highlights = { total: s.highlights.length, orphan: s.highlights.filter((x) => x.anchorState === 'orphan').length };
    res.json({ notes, highlights, indexedAt: s.indexedAt, staleHash: s.docHash !== (await readDoc(rel)).docHash });
  }),
);

/** 批量删除（清空一篇文档的全部批注与高亮）。 */
sidecarRouter.post(
  '/annotations/clear',
  h(async (req, res) => {
    const body = parse(
      z.object({ rel: z.string().min(1).max(1024), what: z.enum(['notes', 'highlights', 'all']).default('all') }),
      req.body,
      '清空请求',
    );
    await updateSidecar(body.rel, (s) => {
      if (body.what === 'notes' || body.what === 'all') s.notes = [];
      if (body.what === 'highlights' || body.what === 'all') s.highlights = [];
    });
    res.json({ ok: true });
  }),
);

export { zod };
