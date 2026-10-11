/**
 * server/services/notes.ts —— 批注与回复的服务层（B2-2 批注回复通道）。
 *
 * ★ 为什么必须有这一层 ★
 *   DSH 施工图（《批注回复通道》tool-request）立的规矩：外部写入**不许直写
 *   sidecar JSON**，必须走服务层才能享受 updateSidecar 的串行队列与校验。
 *   MCP 的 reply_note 工具、HTTP 路由、应用内 agent 三处入口都调这里，
 *   保证「一条回复只有一个合法的写法」。
 *
 * ★ 查找语义（施工图第 3 条）：noteId 优先，bi + quote 只作降级匹配 ★
 *   bi 会随原文编辑漂移；note 自带 selector + anchorState 修复记录。
 *   降级匹配时宁可找不到（报错让模型改参数），不做模糊猜测。
 */

import { ApiError } from '../core';
import { makeId, dice, type Note, type NoteReply } from '../../shared/text';
import { listAllSidecars, readSidecar, updateSidecar } from './sidecar';

/** 写一条回复。author 由调用方定死：HTTP 用户入口传 'user'，agent/MCP 传 'assistant'。 */
export async function addNoteReply(
  docRel: string,
  noteId: string,
  author: 'user' | 'assistant',
  body: string,
  source?: string,
): Promise<NoteReply> {
  const text = body.trim();
  if (!text) throw new ApiError(400, '回复内容不能为空', 'bad_request');
  if (text.length > 20_000) throw new ApiError(400, '回复太长了（上限 2 万字符）', 'bad_request');

  return updateSidecar(docRel, (s) => {
    const note = s.notes.find((n) => n.id === noteId);
    if (!note) throw new ApiError(404, `找不到批注 ${noteId}（文档 ${docRel}）`, 'not_found');
    if (!Array.isArray(note.replies)) note.replies = [];
    const reply: NoteReply = {
      id: makeId('rp'),
      author,
      body: text,
      createdAt: new Date().toISOString(),
      ...(source ? { source } : {}),
    };
    note.replies.push(reply);
    note.updatedAt = new Date().toISOString();
    return reply;
  });
}

export interface NoteRef {
  docRel: string;
  note: Note;
}

/**
 * 找一条批注。
 *  - noteId 给了就全库按 id 精确找（id 全局唯一，docRel 只是加速）；
 *  - 否则用 bi + quote 降级：先按块号筛，再用题面相似度挑最像的那条；
 *    对不上或对出多条歧义时返回明确错误，让 agent 自己换参数。
 */
export async function findNote(q: {
  noteId?: string;
  docRel?: string;
  bi?: number;
  quote?: string;
}): Promise<NoteRef> {
  if (q.noteId) {
    const all = await listAllSidecars();
    for (const { docRel, sidecar } of all) {
      if (q.docRel && docRel !== q.docRel) continue;
      const note = (sidecar.notes ?? []).find((n) => n.id === q.noteId);
      if (note) return { docRel, note };
    }
    throw new ApiError(404, `全库找不到批注 id=${q.noteId}`, 'not_found');
  }

  if (typeof q.bi === 'number' && q.docRel) {
    const s = await readSidecar(q.docRel).catch(() => null);
    const notes = (s?.notes ?? []).filter((n) => n.selector.blockIndex === q.bi);
    if (notes.length === 0) {
      throw new ApiError(
        404,
        `${q.docRel} 的块 ${q.bi} 上没有批注。请先用 annotations 工具拿到批注的 noteId 再调用。`,
        'not_found',
      );
    }
    if (notes.length === 1 || !q.quote) return { docRel: q.docRel, note: notes[0] };
    // 同一块上有多条批注：用 quote 相似度挑最像的；差距不明显就报歧义
    const target = q.quote.replace(/\s+/g, '');
    let best: Note | null = null;
    let bestScore = 0;
    for (const n of notes) {
      const score = dice(n.selector.quote.replace(/\s+/g, ''), target);
      if (score > bestScore) {
        bestScore = score;
        best = n;
      }
    }
    if (best && bestScore >= 0.3) return { docRel: q.docRel, note: best };
    throw new ApiError(
      404,
      `块 ${q.bi} 上有 ${notes.length} 条批注、quote 对不上（最高相似度 ${bestScore.toFixed(2)}）。请改用 noteId。`,
      'ambiguous',
    );
  }

  throw new ApiError(400, '需要 noteId，或 docRel + bi（quote 建议附上）', 'bad_request');
}
