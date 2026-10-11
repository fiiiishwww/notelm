/**
 * server/routes/agent.ts —— 库内 agent 的 HTTP 入口（B2-3）。
 *
 * 现在只有一个动作：回答某条批注。agent 在服务端同步跑完（几十秒量级），
 * 前端用 busy 文案 + 禁用按钮表达「正在想」。trace 落在 RunResult 里返回，
 * 需要看复盘时展开 summary.steps。
 */

import { Router } from 'express';
import { z } from 'zod';
import { h, parse, qInt } from './http';
import { answerNote, chatWithAgent } from '../services/libraryAgent';
import { loadLearning, rebuildLearning, migrateCardConcepts, strugglingTop, refreshLearning } from '../services/learning';
import { listSessions } from '../services/agentMemory';
import {
  createThread,
  listThreads,
  readThread,
  pageThread,
  renameThread,
  setArchived,
  forkThread,
  appendTurn,
  autoTitle,
} from '../services/chatThreads';
import { cacheHitRate, foldSessions } from '../services/tokenMeter';
import { computeNudge } from '../services/nudges';
import { createApproval, resolveApproval } from '../services/approvals';
import { ApiError } from '../core';
import { createMd } from '../../shared/blocks';

/**
 * agent 回答的渲染：markdown（html:false，原始 HTML 已被转义）+
 * 把 ¶块号 织成可点击引用（data-bi / 跨文档再加 data-doc）。
 *
 * ★ 为什么在这里做而不是前端 ★
 *   markdown-it 不进客户端包是既定架构（SearchPanel / 小抄都由服务端渲染 html）。
 *   正则织入跑在转义后的 html 上：¶ 只会出现在文本节点里，织入的 span
 *   属性值来自字符类受限的匹配（不含引号/尖括号），不存在注入面。
 */
const chatMd = createMd();

/**
 * 把「chapter2.md ¶20」「chapter1（¶345」「裸 ¶82」三种写法统一织成 .agent-ref。
 * data-doc 只在名字像文件名（.md 后缀或 latin slug）时才带——纯中文词
 * （「详见 ¶12」）不当地名，前端解析不到就回退当前文档，两头的假阳性都安全。
 * 替换时把前缀原样拼回，正文一个字不丢。
 */
function renderAnswerHtml(answer: string): string {
  return chatMd.render(answer).replace(
    /([\w./\u4e00-\u9fa5-]{1,60})?([（(])?\s*¶(\d+)/g,
    (_m, word: string | undefined, paren: string | undefined, n: string) => {
      const doc =
        word && (/\.(md|markdown|txt)$/i.test(word) || /^[A-Za-z0-9_-]+$/.test(word))
          ? word
          : undefined;
      return `${word ?? ''}${paren ?? ''}<span class="agent-ref" data-bi="${n}"${doc ? ` data-doc="${doc}"` : ''}>¶${n}</span>`;
    },
  );
}

export const agentRouter = Router();

agentRouter.post(
  '/agent/notes/answer',
  h(async (req, res) => {
    const body = parse(z.object({ rel: z.string().min(1).max(1024), noteId: z.string().min(1).max(64) }), req.body, '回答批注');
    const r = await answerNote(body.rel, body.noteId);
    res.json({
      ok: true,
      replyWritten: r.replyWritten,
      reply: r.reply,
      answer: r.answer,
      stop: r.run.stop,
      usage: r.run.usage,
      steps: r.run.steps.map((s) => ({ kind: s.kind, label: s.label, ms: s.ms, failed: s.failed })),
    });
  }),
);

/**
 * 流式批注回复：事件序列与 /agent/chat/stream 完全一致
 * （{type:'step',...}* → {type:'done',replyWritten,reply,answer,answerHtml,stop,usage}；出错 {type:'error'}）。
 * 前端 NotePanel 用它把「正在想」换成实时步骤轨迹。
 */
agentRouter.post('/agent/notes/answer/stream', async (req, res) => {
  let body: { rel: string; noteId: string };
  try {
    body = parse(z.object({ rel: z.string().min(1).max(1024), noteId: z.string().min(1).max(64) }), req.body, '回答批注');
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : '参数错误', code: 'bad_request' });
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
  });
  const send = (obj: unknown): void => {
    res.write(`${JSON.stringify(obj)}\n`);
  };
  try {
    const r = await answerNote(body.rel, body.noteId, {
      onStep: (s) =>
        send({
          type: 'step',
          kind: s.kind,
          label: s.label,
          ...(s.input ? { input: s.input } : {}),
          ...(s.detail ? { detail: s.detail } : {}),
          ms: s.ms,
          ...(s.failed ? { failed: true } : {}),
        }),
    });
    send({
      type: 'done',
      replyWritten: r.replyWritten,
      reply: r.reply,
      answer: r.answer,
      answerHtml: renderAnswerHtml(r.answer),
      stop: r.run.stop,
      usage: r.run.usage,
    });
  } catch (e) {
    send({ type: 'error', error: e instanceof Error ? e.message : String(e) });
  } finally {
    res.end();
  }
});

/** 对话请求体（普通版 / 流式版共用）。 */
const ChatBody = z.object({
  docRel: z.string().max(1024).optional(),
  /**
   * 会话 id。不传就**自动新建一条**（她的预期：新建 = 清空，旧的还在列表里）。
   * 前端切会话后把它带上，服务端负责把这一轮追加进那条会话。
   */
  threadId: z.string().max(64).optional(),
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().min(1).max(8000),
      }),
    )
    .min(1)
    .max(40),
});

/**
 * 把「她这句问话」和「小笔这句回答」写进会话，并在首轮给它起个标题。
 *
 * ★ 为什么在流式里做而不是前端另调一次 ★
 *   多一个往返就多一个「说了但没存下」的窗口。写库这件事必须和「回答已生成」
 *   在同一个地方发生，否则又变成「界面有、后台没有」——她这次崩溃的根因。
 */
async function persistTurn(opts: {
  threadId: string;
  docRel?: string;
  question: string;
  answer: string;
  stop?: string;
  usage?: { promptTokens?: number; completionTokens?: number };
  steps?: { kind: string; label: string; ms: number; failed?: boolean }[];
}): Promise<void> {
  try {
    await appendTurn(opts.threadId, {
      role: 'user',
      content: opts.question,
    });
    await appendTurn(opts.threadId, {
      role: 'assistant',
      content: opts.answer,
      ...(opts.stop ? { stop: opts.stop } : {}),
      ...(opts.usage ? { usage: opts.usage } : {}),
      ...(opts.steps ? { steps: opts.steps } : {}),
    });
  } catch {
    // 落盘失败不能让她这一轮白聊：回答已经出来了，只是没进历史
  }
}

/** 和库内 agent 直接聊（BottomDock「AI 助手」，2026-09-22 起 DSH 撤下）。 */
agentRouter.post(
  '/agent/chat',
  h(async (req, res) => {
    const body = parse(ChatBody, req.body, '对话');
    const r = await chatWithAgent(body.messages, { docRel: body.docRel });
    res.json({
      ok: true,
      answer: r.answer,
      answerHtml: renderAnswerHtml(r.answer),
      stop: r.run.stop,
      usage: r.run.usage,
      steps: r.run.steps.map((s) => ({ kind: s.kind, label: s.label, failed: s.failed })),
    });
  }),
);

/**
 * 流式对话：NDJSON（一行一个 JSON 事件），让她看到 agent 正在干什么。
 *
 * ★ 为什么不用 SSE ★
 *   EventSource 只能 GET，这个请求要带 body（多轮历史）；fetch + ReadableStream
 *   逐行读 NDJSON 是同样的实时性，前端代码也更直白。
 *
 * 事件序列：{type:'step',...}* → {type:'done',answer,stop,usage}；
 * 出错时 {type:'error',error} 后收流。每步完成即推（onStep 在 agentRuntime
 * 每步 push 时回调），模型思考中的间隔由前端用「正在思考…」占位。
 *
 * ★ 审批事件（2026-09-24）★
 *   写工具（edit_library）会挂起整轮等她点确认，事件对：
 *     {type:'approval', approval:{id,title,note,actions,danger}}
 *     {type:'approval_done', id, approved, by, timedOut}
 *   中间她点按钮走 POST /agent/approvals/:id；这条流在此期间保持打开不写字节。
 *   超时（默认 5 分钟）由 approvals.ts 兜底按拒绝处理——不会无声挂死。
 */
agentRouter.post('/agent/chat/stream', async (req, res) => {
  let body: z.infer<typeof ChatBody>;
  try {
    body = parse(ChatBody, req.body, '对话');
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : '参数错误', code: 'bad_request' });
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
  });
  const send = (obj: unknown): void => {
    res.write(`${JSON.stringify(obj)}\n`);
  };
  // 会话：没传就新建一条（她的「清空 = 新建」就落在这里）
  let threadId = body.threadId;
  let isNewThread = false;
  try {
    if (!threadId) {
      threadId = (await createThread(body.docRel)).id;
      isNewThread = true;
    }
    // ★ 问题先落盘：即便下面 agent 崩了/被取消，她问过什么不会丢
    const question = [...body.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    if (question) await appendTurn(threadId, { role: 'user', content: question });
  } catch {
    threadId = undefined;
  }

  try {
    const r = await chatWithAgent(body.messages, {
      docRel: body.docRel,
      onStep: (s) =>
        send({
          type: 'step',
          kind: s.kind,
          label: s.label,
          ...(s.input ? { input: s.input } : {}),
          ...(s.detail ? { detail: s.detail } : {}),
          ms: s.ms,
          ...(s.failed ? { failed: true } : {}),
        }),
      onApprovalRequest: async (draft) => {
        const { id, request, promise } = createApproval(draft);
        send({ type: 'approval', approval: request });
        const decision = await promise;
        send({ type: 'approval_done', id, approved: decision.approved, by: decision.by, timedOut: !!decision.timedOut });
        return decision;
      },
    });
    if (threadId) {
      await persistTurn({
        threadId,
        ...(body.docRel ? { docRel: body.docRel } : {}),
        question: [...body.messages].reverse().find((m) => m.role === 'user')?.content ?? '',
        answer: r.answer,
        stop: r.run.stop,
        usage: r.run.usage,
        steps: r.run.steps.map((s) => ({ kind: s.kind, label: s.label, ms: s.ms, ...(s.failed ? { failed: true } : {}) })),
      });
      // 首轮起名：不 await —— 标题是体验，不该拖住流的收尾
      if (isNewThread) {
        const q0 = [...body.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
        if (q0) void autoTitle(threadId, q0);
      }
    }
    send({
      type: 'done',
      answer: r.answer,
      answerHtml: renderAnswerHtml(r.answer),
      stop: r.run.stop,
      usage: r.run.usage,
      ...(threadId ? { threadId } : {}),
    });
  } catch (e) {
    send({ type: 'error', error: e instanceof Error ? e.message : String(e), ...(threadId ? { threadId } : {}) });
  } finally {
    res.end();
  }
});

/**
 * 她在确认卡上点了「批准 / 拒绝」。
 * 返回 false（404）的三种情况都正常：卡已超时、重复点击、旧页面残留。
 */
agentRouter.post(
  '/agent/approvals/:id',
  h(async (req, res) => {
    const body = parse(z.object({ approved: z.boolean() }), req.body, '审批');
    const id = String(req.params.id ?? '');
    const okResolved = resolveApproval(id, body.approved);
    if (!okResolved) {
      throw new ApiError(404, '这条确认请求已经不在等待了（可能超时或已处理过）', 'not_found');
    }
    res.json({ ok: true, id, approved: body.approved });
  }),
);

// ─────────────────────────── 会话层（threads，2026-10-08）───────────────────────────
//
// 结构照搬 DSH 的 session controller（create/list/page/rename/fork），
// 但存储与运行时都在 NoteLM 进程内、数据落在她的库里。
//
// ★ 命名为什么叫 thread 不叫 session ★
//   `agentMemory.ts` 里的 AgentSession 是「一次 agent run 的审计轨迹」，
//   这里的是「她和它的一串对话」。两个东西，别混。

agentRouter.post(
  '/agent/threads',
  h(async (req, res) => {
    const body = parse(z.object({ docRel: z.string().max(1024).optional() }), req.body ?? {}, '新建会话');
    res.json({ ok: true, thread: await createThread(body.docRel) });
  }),
);

agentRouter.get(
  '/agent/threads',
  h(async (req, res) => {
    const q = req.query as Record<string, unknown>;
    const limit = Math.min(Math.max(Number(q.limit) || 40, 1), 200);
    const scope = q.scope === 'all' ? 'all' : 'doc';
    const includeArchived = q.includeArchived === '1' || q.includeArchived === 'true';
    const docRel = typeof q.docRel === 'string' && q.docRel ? q.docRel : undefined;
    res.json({ ok: true, threads: await listThreads({ docRel, scope, limit, includeArchived }) });
  }),
);

agentRouter.get(
  '/agent/threads/:id',
  h(async (req, res) => {
    const d = await readThread(String(req.params.id ?? ''));
    if (!d) throw new ApiError(404, '这条会话不存在', 'not_found');
    res.json({ ok: true, ...d });
  }),
);

/** 冷读一页历史（DSH 的 page）：不激活 agent。 */
agentRouter.get(
  '/agent/threads/:id/page',
  h(async (req, res) => {
    const from = qInt(req, 'from', 0);
    const limit = Math.min(Math.max(qInt(req, 'limit', 50), 1), 500);
    const p = await pageThread({ id: String(req.params.id ?? ''), from, limit });
    res.json({ ok: true, ...p });
  }),
);

agentRouter.post(
  '/agent/threads/:id/rename',
  h(async (req, res) => {
    const body = parse(z.object({ title: z.string().min(1).max(60) }), req.body, '改名');
    res.json({ ok: true, thread: await renameThread(String(req.params.id ?? ''), body.title) });
  }),
);

agentRouter.post(
  '/agent/threads/:id/archive',
  h(async (req, res) => {
    const body = parse(z.object({ archived: z.boolean() }), req.body, '归档');
    res.json({ ok: true, thread: await setArchived(String(req.params.id ?? ''), body.archived) });
  }),
);

/** 分叉：把第 upto 轮（不含）之前的历史复制到新会话，原会话不动。 */
agentRouter.post(
  '/agent/threads/:id/fork',
  h(async (req, res) => {
    const body = parse(z.object({ upto: z.number().int().min(0) }), req.body ?? {}, '分叉');
    res.json({ ok: true, thread: await forkThread(String(req.params.id ?? ''), body.upto) });
  }),
);

// ─────────────────────────── B3：记忆层 ───────────────────────────

/** 全量重建 learning.json（幂等，零模型调用）。 */
agentRouter.post(
  '/agent/learning/rebuild',
  h(async (_req, res) => {
    const store = await rebuildLearning();
    res.json({ ok: true, rebuiltAt: store.rebuiltAt, conceptsTracked: store.entries.length, cardMigration: store.cardMigration });
  }),
);

agentRouter.get(
  '/agent/learning/summary',
  h(async (_req, res) => {
    const store = await loadLearning();
    res.json({ conceptsTracked: store.entries.length, cardMigration: store.cardMigration, rebuiltAt: store.rebuiltAt, top: strugglingTop(store, 12), unlinkedCardFb: store.unlinkedCardFb ?? [] });
  }),
);

/** 树→闪卡迁移：给没挂 conceptKey 的卡片补挂（幂等，只补挂不摘除）。 */
agentRouter.post(
  '/agent/cards/migrate',
  h(async (_req, res) => {
    const r = await migrateCardConcepts();
    refreshLearning();
    res.json({ ok: true, ...r });
  }),
);

/** M3 会话留痕（agent 可写层的只读视图）。 */
agentRouter.get(
  '/agent/sessions',
  h(async (req, res) => {
    // limit 让调用方自己定（历史面板要 40 条，概览要 30）
    const raw = (req.query as Record<string, unknown>).limit;
    const n = Math.min(Math.max(Number(raw) || 30, 1), 200);
    res.json({ sessions: await listSessions(n) });
  }),
);

/** 小笔主动开口（C）：至多一条，出过即记 7 天冷却。 */
agentRouter.get(
  '/agent/nudge',
  h(async (_req, res) => {
    res.json({ nudge: await computeNudge() });
  }),
);

/**
 * 成本总账（C 层，2026-09-23）。
 *
 * ★ 为什么是「纯回放」★
 *   直接从已落盘的会话文件折出来，不调模型、不改任何状态——所以它可以被
 *   随时调、也可以被离线脚本复算，数字必然一致（对齐 DSH token-meter 的姿势）。
 *
 * 注意三个数分开看：`instrumented` 是「带缓存字段的会话数」，
 * 只有它 > 0 时 hitRate 才有意义；老会话（2026-09-23 之前）没有缓存字段，
 * 把它们算进分母会把命中率冤枉成很低。
 */
agentRouter.get(
  '/agent/stats',
  h(async (req, res) => {
    const days = qInt(req, 'days', 7);
    const all = await listSessions(500);
    const since = Date.now() - days * 86400_000;
    const windowed = all.filter((s) => Date.parse(s.at) >= since);
    const rollup = foldSessions(windowed);
    // 命中率的分母只能用「有缓存信息的那些会话」的 promptTokens（见 tokenMeter 注释）
    const hit = cacheHitRate({
      inputTokens: rollup.instrumentedPromptTokens - rollup.cacheReadTokens,
      cacheReadTokens: rollup.instrumented > 0 ? rollup.cacheReadTokens : undefined,
    });
    res.json({
      ...rollup,
      hitRate: rollup.instrumented > 0 ? hit : null,
      days,
      /** 价目表没填就不给金额——不替厂商定价 */
      pricing: null,
    });
  }),
);
