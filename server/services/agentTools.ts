/**
 * server/services/agentTools.ts —— 库级 agent 工具层：一份实现，两处暴露。
 *
 * ★ 为什么抽这一层（B2-2，2026-09-22）★
 *   以前工具实现写在 server/mcp.ts 里，只有外部 agent（DSH）能用；
 *   应用内 agent（server/services/libraryAgent.ts）要用就得抄一遍——
 *   抄出来的两份必然漂移。现在实现只在这里写一次：
 *     - MCP（server/mcp.ts）把它们包成 ToolDef 走 JSON-RPC；
 *     - 应用内 agent 把它们包成 agentRuntime 的 Tool 走 function-calling。
 *   两处拿到的是同一个 run，行为、错误、边界条件天然一致。
 *
 * ★ 写边界 ★
 *   写工具 4 个，分三档：
 *     ① reply_note（批注回复，走 services/notes，author 硬编码隔离，只能追加）
 *     ② save_web_file（网络文件经 MinerU 存进库，走 services/docImport——只准新增、
 *        永不覆盖，扩展名/目录校验在代码里）
 *     ③ feedback_apply / edit_library（改库内**生成物**：条目/闪卡/树节点）。
 *        ★ 这两个必须过「她当场点头」：feedback_apply 要 confirmedBy（她看过的计划）；
 *        edit_library 经 ctx.requestApproval 挂起，等她点界面上的确认卡。
 *        没有审批通道（MCP / 脚本）→ 直接拒绝，不许静默改。
 *   她的**笔记原文 md** 永远不在工具层权限内。
 */

import fs from 'fs';
import path from 'path';
import { spawn } from 'node:child_process';
import { ApiError, DATA_DIR_NAME, PROJECT_ROOT, requireVaultRoot } from '../core';
import { resolveInVault } from '../security';
import { readDoc } from '../vault';
import { analyzeDocument } from '../../shared/blocks';
import { localDate, itemKeyOf } from '../../shared/text';
import { search } from './vectorstore';
import type { ApprovalAction } from './approvals';
import { listAllSidecars, readSidecar } from './sidecar';
import { writeFeedbackDigest, appendFeedbackActions } from './feedback';
import { addNoteReply, findNote } from './notes';
import { loadLearning, strugglingTop } from './learning';
import { listSessions, type AgentSession } from './agentMemory';
import { addMemory, updateMemory, supersedeMemory, revokeMemory, listActive, type MemoryKind, type MemorySourceType, type MemorySource } from './memoryStore';
import { conceptByKey, searchConcepts } from './concepts';
import { collectConceptAssets, toManifest } from './conceptAssets';
import { writeSpill } from './spill';
import { graphNeighbors } from './conceptGraph';
import { webTools } from './webTools';
import type { ReviewItem } from './reviewPlan';

export interface SharedToolSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
}

export interface SharedTool {
  name: string;
  description: string;
  parameters: SharedToolSchema;
  /**
   * ctx 只在需要「当场问她」的写工具上有意义（edit_library）。
   * 其余工具忽略第二参；MCP 侧调用不传 ctx，写工具会据此拒绝执行。
   */
  run: (args: Record<string, unknown>, ctx?: { requestApproval?: (req: import('./approvals').ApprovalRequestDraft) => Promise<import('./approvals').ApprovalDecision> }) => Promise<unknown>;
}

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;
const bool = (v: unknown, fallback = false): boolean => (typeof v === 'boolean' ? v : fallback);

/** recall_sessions 开 full 时的总字符预算（≈6~7K token），超出按会话条数裁掉较早的。 */
const RECALL_FULL_BUDGET = 12_000;

/** 会话记录 → 给模型看的形状。full=false 时答案截到 120 字，且不带步骤明细。 */
function serialize(s: AgentSession, full: boolean): Record<string, unknown> {
  return {
    id: s.id,
    at: s.at,
    task: s.task,
    ref: s.ref,
    question: s.question,
    answer: full ? s.answer : s.answer?.slice(0, 120),
    resolved: s.resolved,
    status: s.status,
    tools: s.tools.map((t) => t.name),
    ...(full && s.steps?.length ? { steps: s.steps } : {}),
  };
}

// ─────────────────────────── run_code：代码执行（轻量执行档位，2026-09-23） ───────────────────────────
// 业界档位选择（Claude Code 安全文档 / Docker sbx 同款结论）：本地单用户场景 = L1~L2 之间，
// 不上容器。三道防线：①代码内破坏性黑名单（PreToolUse hook 标准——规则在代码里，提示注入绕不过）
// ②30s 硬超时 + 输出截断 ③全轨迹实时可见 + 脚本留档 .assistant/agent/runs/ 可审计。
// 真兜底是备份（server/services/backup.ts）：恢复不了就不叫备份。

/** 破坏性操作黑名单：命中即拒跑。规则在代码里，不进提示词。
 *  ★ rm 类按「行」扫：subprocess.run(["rm", "-rf", "/"]) 这种数组写法会把 flag 和命令隔开，
 *    单个正则抓不住（冒烟真抓到过），所以只要同一行里出现 rm + 递归/强制 flag 就拒。 */
const DESTRUCTIVE_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /[^\n]*\brm\b[^\n]*[^\w-]-{1,2}[a-z]*[rf]\b/i, label: 'rm 递归/强制删除' },
  { re: /\b(del|rd|rmdir|deltree)\b[^;\n]*\/s(\s|\/|$)/i, label: 'Windows 递归删除（del|rd /s）' },
  { re: /remove-item\b[^;\n]*-recurse/i, label: 'Remove-Item -Recurse' },
  { re: /\bformat\s+[a-z]:/i, label: '格式化磁盘' },
  { re: /\b(diskpart|mkfs|vssadmin|bcdedit|wipefs)\b/i, label: '磁盘/系统级操作' },
  { re: /\bcipher\s+\/w\b/i, label: 'cipher /w 擦写' },
  { re: /\breg(\.exe)?\s+delete\b/i, label: '注册表删除' },
  { re: /\bdd\b[^;\n]*of=\/dev\//i, label: 'dd 写设备' },
  { re: /fs\.(rmSync|rmdirSync)\s*\([^)]*(recursive\s*:\s*true)/i, label: 'fs 递归删除 API' },
  { re: /shutil\.rmtree\s*\(/i, label: 'shutil.rmtree' },
  { re: /send2trash\s*\(\s*['"]\.\./i, label: 'Send2Trash 越界' },
];

const RUN_TIMEOUT_MS = 30_000;
const RUN_OUTPUT_CAP = 20_000;
const RUN_CODE_CAP = 100_000;

interface RunResultCode {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  ms: number;
}

function runScript(cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }): Promise<RunResultCode> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const cap = (s: string): string => (s.length > RUN_OUTPUT_CAP ? s.slice(0, RUN_OUTPUT_CAP) : s);
    child.stdout?.on('data', (d) => {
      if (stdout.length < RUN_OUTPUT_CAP * 2) stdout += String(d);
    });
    child.stderr?.on('data', (d) => {
      if (stderr.length < RUN_OUTPUT_CAP * 2) stderr += String(d);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, RUN_TIMEOUT_MS);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ exitCode: null, stdout: '', stderr: `${e.message}（如果提示找不到命令，说明这台机器没有该运行时）`, timedOut: false, ms: Date.now() - t0 });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, stdout: cap(stdout), stderr: cap(stderr), timedOut, ms: Date.now() - t0 });
    });
  });
}

/** 从原始 markdown 抽图片引用，解析成磁盘绝对路径（复用 /asset 路由的候选规则）。 */
async function extractImages(
  docRel: string,
  markdown: string,
): Promise<{ ref: string; alt: string; path: string | null }[]> {
  const docDir = docRel.includes('/') ? docRel.slice(0, docRel.lastIndexOf('/')) : '';
  const seen = new Set<string>();
  const out: { ref: string; alt: string; path: string | null }[] = [];
  const re = /!\[([^\]]*)\]\(([^)\s]+)/g;
  for (const m of markdown.matchAll(re)) {
    const alt = m[1];
    let ref = m[2].replace(/\\/g, '/');
    if (/^(https?:)?\/\//i.test(ref)) continue; // 外链图不归本地管
    // 和 /asset 同款：引用被编码过两层，先试解码、再试原样
    let decoded = ref;
    try {
      decoded = decodeURIComponent(ref);
    } catch {
      /* 引用里真有 % 字符，解码失败就用原样 */
    }
    const key = decoded;
    if (seen.has(key)) continue;
    seen.add(key);
    let abs: string | null = null;
    for (const v of decoded === ref ? [ref] : [decoded, ref]) {
      for (const c of docDir ? [`${docDir}/${v}`, v] : [v]) {
        try {
          const p = await resolveInVault(c);
          if (fs.existsSync(p) && fs.statSync(p).isFile()) {
            abs = p;
            break;
          }
        } catch {
          /* 候选不合法就试下一个 */
        }
      }
      if (abs) break;
    }
    out.push({ ref, alt, path: abs });
  }
  return out;
}

/** 全库工具集。调用方（MCP / 应用内 agent）不要改 run，有新需求改这里。 */
export function sharedTools(): SharedTool[] {
  return [
    {
      name: 'search',
      description:
        '语义检索整个笔记库（向量 + 关键词回退）。返回相关片段及所在文档/章节/块位置。想读某片段的上下文，用 read_doc 配合 docRel + startBi。',
      parameters: {
        type: 'object',
        properties: {
          q: { type: 'string', description: '检索词，支持中文自然语言' },
          topK: { type: 'number', description: '返回条数，默认 8' },
        },
        required: ['q'],
      },
      run: async (args) => {
        const r = await search(str(args.q), num(args.topK, 8));
        return {
          mode: r.mode,
          notice: r.notice,
          hits: r.hits.map((h) => ({
            doc: h.docRel,
            title: h.docTitle,
            heading: h.headingText,
            headingId: h.headingId,
            part: h.part,
            startBi: h.startBi,
            score: h.score,
            snippet: h.snippet,
            text: h.text,
          })),
        };
      },
    },
    {
      name: 'read_doc',
      description:
        '读一篇文档的分块原文。块号 bi 与前端批注/小抄锚点(data-bi)同源。image 段落 text 只含 alt 文本，图片磁盘路径见 images 字段（可直接用视觉模型读图）。文档很大时用 from/to 取块区间。',
      parameters: {
        type: 'object',
        properties: {
          rel: { type: 'string', description: '文档相对路径，如 知识库/AI-Agent-Book/chapter1.md' },
          from: { type: 'number', description: '起始块号（含），默认 0' },
          to: { type: 'number', description: '结束块号（不含），默认到末尾' },
        },
        required: ['rel'],
      },
      run: async (args) => {
        const rel = str(args.rel);
        if (!rel) throw new ApiError(400, 'rel 不能为空', 'bad_request');
        const doc = await readDoc(rel);
        const a = analyzeDocument(doc.markdown);
        const from = Math.max(0, num(args.from, 0));
        const to = num(args.to, a.blocks.length);
        const blocks = a.blocks
          .filter((b) => b.bi >= from && b.bi < to)
          .map((b) => ({
            bi: b.bi,
            type: b.type,
            depth: b.depth,
            text: b.text,
            ...(b.headingPath?.length ? { path: b.headingPath } : {}),
          }));
        return {
          doc: rel,
          title: a.blocks.find((b) => b.type === 'h1')?.text ?? path.basename(rel).replace(/\.(md|markdown|txt)$/i, ''),
          totalBlocks: a.blocks.length,
          range: [from, Math.min(to, a.blocks.length)],
          blocks,
          images: await extractImages(rel, doc.markdown),
        };
      },
    },
    {
      name: 'annotations',
      description:
        '按时间取批注（用户写在原文旁的想法），按时间倒序。每条带 id / answered / replies：answered=false 的是她还没得到回答的批注，**优先回答这些**——先 read_doc 看批注锚的原文（doc+bi），想清楚后用 reply_note 写回复。高亮默认不返回：withHighlights=true 时才附带，且仅作上下文、不需要对其回复。',
      parameters: {
        type: 'object',
        properties: {
          since: { type: 'string', description: '本地日期 YYYY-MM-DD，只返回该日（含）之后的' },
          doc: { type: 'string', description: '按文档路径过滤（子串匹配）' },
          limit: { type: 'number', description: '最多返回条数，默认 100' },
          unansweredOnly: { type: 'boolean', description: '只看还没有助手回复的批注，默认 false' },
          withHighlights: { type: 'boolean', description: '是否附带高亮（仅作上下文）。默认 false' },
        },
      },
      run: async (args) => {
        const since = str(args.since);
        const docFilter = str(args.doc);
        const limit = num(args.limit, 100);
        const unansweredOnly = bool(args.unansweredOnly, false);
        const all = await listAllSidecars();
        const notes: Record<string, unknown>[] = [];
        const highlights: Record<string, unknown>[] = [];
        const wantHl = bool(args.withHighlights, false);
        for (const { docRel, sidecar } of all) {
          if (docFilter && !docRel.includes(docFilter)) continue;
          for (const n of sidecar.notes ?? []) {
            const replies = n.replies ?? [];
            const answered = replies.some((r) => r.author === 'assistant');
            if (unansweredOnly && answered) continue;
            const day = localDate(new Date(n.createdAt));
            if (since && day < since) continue;
            notes.push({
              id: n.id,
              doc: docRel,
              bi: n.selector.blockIndex,
              quote: n.selector.quote,
              body: n.body,
              answered,
              repliesTotal: replies.length,
              ...(n.tags?.length ? { tags: n.tags } : {}),
              day,
              at: n.createdAt,
            });
          }
          if (wantHl) {
            for (const h of sidecar.highlights ?? []) {
              const day = localDate(new Date(h.createdAt));
              if (since && day < since) continue;
              highlights.push({ doc: docRel, bi: h.selector.blockIndex, quote: h.selector.quote, day });
            }
          }
        }
        notes.sort((x, y) => String(y.at).localeCompare(String(x.at)));
        highlights.sort((x, y) => String(y.day).localeCompare(String(x.day)));
        const result: Record<string, unknown> = {
          total: notes.length,
          notes: notes.slice(0, limit),
        };
        if (wantHl) {
          result.highlights = highlights.slice(0, limit);
          result.highlightNote = '以下高亮仅作上下文，不需要回复，只需回复 notes 里的批注';
        }
        return result;
      },
    },
    {
      name: 'cheatsheet',
      description:
        '取一篇文档的知识树/小抄数据（树节点与条目：命题/定义/等式/数值/类比/清单 + 术语）。条目带 bi 可跳回原文；带 feedback 的是用户已给出评价的条目（▲有用 ▽反馈 ⧉重复），参考这些评价来对齐她的偏好。',
      parameters: {
        type: 'object',
        properties: {
          rel: { type: 'string', description: '文档相对路径' },
        },
        required: ['rel'],
      },
      run: async (args) => {
        const rel = str(args.rel);
        if (!rel) throw new ApiError(400, 'rel 不能为空', 'bad_request');
        const sidecar = await readSidecar(rel);
        const sections = (sidecar.cheatsheet?.sections ?? []).map((s) => ({
          headingId: s.headingId,
          heading: s.headingText,
          ...(s.tree ? { tree: { nodes: s.tree.nodes.length, relations: s.tree.nodes.reduce((n, x) => n + (x.relations?.length ?? 0), 0) } } : {}),
          items: s.items ?? null,
        }));
        return { doc: rel, sections };
      },
    },
    {
      name: 'feedback_digest',
      description:
        '取用户的偏好标注汇总（她觉得哪些条目有用/需要反馈/重复，含理由）。回答质量类问题或改进产出前先读它。注意：里面只有她自己写的内容。',
      parameters: { type: 'object', properties: {} },
      run: async () => {
        const digest = await writeFeedbackDigest();
        const md = await fs.promises.readFile(digest.file, 'utf8');
        return { total: digest.total, up: digest.up, down: digest.down, dup: digest.dup, markdown: md };
      },
    },
    {
      name: 'concepts',
      description:
        '查概念库（M1 语义记忆）：按关键词找知识点，返回它的出处（哪些文档哪些节哪块）。回答「X 是什么/在哪讲过」先用它定位，再 read_doc 看原文——名字可以是生成的，出处不会骗人。',
      parameters: {
        type: 'object',
        properties: {
          q: { type: 'string', description: '概念名或关键词（中英均可）' },
          limit: { type: 'number', description: '最多返回条数，默认 10' },
        },
        required: ['q'],
      },
      run: async (args) => {
        const q = str(args.q);
        if (!q) throw new ApiError(400, 'q 不能为空', 'bad_request');
        const hits = await searchConcepts(q, num(args.limit, 10));
        return {
          total: hits.length,
          concepts: hits.map((c) => ({
            key: c.key,
            name: c.name,
            ...(c.aliases.length ? { aliases: c.aliases } : {}),
            sources: c.sources.slice(0, 6),
            sourcesTotal: c.sources.length,
          })),
        };
      },
    },
    {
      name: 'concept_assets',
      description:
        '一次拿全一个概念的所有学习资产：知识树节点细节（essence+全部 details）、该节全部测验题、'
        + '面经/思考题题库命中题、全部挂卡（含 SM-2 到期/遗忘次数）、她的掌握状态（learning.json）。'
        + '★ 用法 ★ 先 view=manifest（默认）看清单和计数，再按需要 view=tree/quiz/pool/cards + offset/limit 拉明细。'
        + '★ 什么时候用 ★ 排复习计划、回答「这个概念我掌握得怎样/有哪些题/给我讲讲」——'
        + '替代 concepts+cheatsheet+flashcard_pool 的多步组合（旧路径 5+ 步且读不到树内容和测验题）。'
        + '★ 缺口如实呈现 ★ gaps 数组会告诉你哪类资产没有（没出过题/没挂卡），不要编。'
        + '★ 面经题是节级定位（同节概念共享），说的时候别说成这个概念专属。',
      parameters: {
        type: 'object',
        properties: {
          q: { type: 'string', description: '概念名或关键词' },
          view: {
            type: 'string',
            enum: ['manifest', 'tree', 'quiz', 'pool', 'cards'],
            description: 'manifest=清单+计数（默认，先看这个）；tree/quiz/pool/cards=对应明细（支持 offset/limit 分页）',
          },
          offset: { type: 'number', description: '明细分页起点，默认 0' },
          limit: { type: 'number', description: '明细每页条数，默认 20' },
        },
        required: ['q'],
      },
      run: async (args) => {
        const q = str(args.q);
        if (!q) throw new ApiError(400, 'q 不能为空', 'bad_request');
        const view = str(args.view) || 'manifest';
        const offset = num(args.offset, 0);
        const limit = num(args.limit, 20);

        const bundle = await collectConceptAssets(q);
        if (view === 'manifest') {
          // 全量 bundle 落盘留档（审计用）；manifest（计数+全量 id 清单）进上下文
          const spillPath = await writeSpill('concept_assets', JSON.stringify(bundle, null, 2));
          return { view, spillPath: spillPath ?? undefined, manifest: toManifest(bundle) };
        }
        const arr =
          view === 'tree'
            ? bundle.tree
            : view === 'quiz'
              ? bundle.quizzes
              : view === 'pool'
                ? bundle.pool
                : bundle.cards;
        return {
          view,
          total: arr.length,
          offset,
          returned: Math.max(0, Math.min(limit, arr.length - offset)),
          items: arr.slice(offset, offset + limit),
          gaps: bundle.gaps,
          hint: arr.length > offset + limit ? `还有 ${arr.length - offset - limit} 条，offset=${offset + limit} 继续` : '已到末尾',
        };
      },
    },
    {
      name: 'graph_neighbors',
      description:
        '查概念图谱（B4）：一个知识点和谁有关系（关系边 + 人工确认的合并），每条边带原文证据。回答「X 和 Y 什么关系」「围绕 X 还有哪些概念」用它；边是现查现算的，以这里的结果为准。',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: '概念名或 conceptKey（concepts 工具返回的）' },
        },
        required: ['key'],
      },
      run: async (args) => {
        const key = str(args.key);
        if (!key) throw new ApiError(400, 'key 不能为空', 'bad_request');
        const g = await graphNeighbors(key);
        if (!g) return { found: false, key, hint: '概念库里没有这个名字，先用 concepts 搜' };
        const edge = (e: { key: string; name: string; rel: string; toNode: boolean; note?: string; evidence: { docRel: string; headingId: string; headingText?: string; bi?: number }[] }) => ({
          to: e.name,
          key: e.key,
          rel: e.rel,
          inGraph: e.toNode,
          ...(e.note ? { note: e.note } : {}),
          evidence: e.evidence.slice(0, 3),
        });
        return {
          found: true,
          key: g.key,
          name: g.name,
          ...(g.aliases.length ? { aliases: g.aliases } : {}),
          sources: g.sources.slice(0, 6),
          out: g.out.map(edge),
          in: g.in.map(edge),
        };
      },
    },
    {
      name: 'learning_status',
      description:
        '查学习者状态（M2 记忆）：她标过 ▲▽ 的知识点、闪卡遗忘多的概念、最近在哪些地方停留。回答「我学到哪了」「我哪里比较弱」「接下来该复习什么」用它。数据只来自她本人的标注/评分，不含助手产出。',
      parameters: {
        type: 'object',
        properties: {
          top: { type: 'number', description: '返回最需要关注的前几个概念，默认 12' },
        },
      },
      run: async (args) => {
        const store = await loadLearning();
        const top = strugglingTop(store, num(args.top, 12));
        return {
          conceptsTracked: store.entries.length,
          cardMigration: store.cardMigration,
          rebuiltAt: store.rebuiltAt,
          top,
          unlinkedCardFb: store.unlinkedCardFb ?? [],
          note: 'down=正文▽反馈次数 cardFbDown=她对相关闪卡打的▽反馈（理由在 cardFbWhy） up=▲有用次数 lapses=闪卡遗忘次数；lastTouchedAt 是最近接触时间。unlinkedCardFb 是挂不上具体概念的卡的反馈（如开篇导览卡），同样认真对待。她抱怨某概念学不会/卡片不对时，先看这里的反馈理由再回应。',
        };
      },
    },
    {
      name: 'plan_review',
      description:
        '排今天（或某一天）的复习计划，落到左栏「今天」——她点一下就能按计划开始复习。'
        + '★ 什么时候该用 ★ 她说「今天复习什么」「安排一下」「帮我排今天的」→ 用本工具。'
        + '★ 三型混排 ★ 每条计划项是 flashcard（认得出来）/ recall（讲得出来，用填空）/ apply（用得上去，用问答）之一，'
        + '三型要混着排不要只排一种——只有 flashcard 她会点「记得」，复述和问答才测得出真会不会。'
        + '★ 怎么挑题 ★ 先用 learning_status 看她的标注（▽=她说不对劲，优先级最高）、'
        + '用 flashcard_pool 看有哪些卡可用（它默认只返回 30 条，要全量就传大一点的 limit）；'
        + '**没有卡的知识点不要排**（排了她也没材料复习）。'
        + '★ 每条都要写 why ★ 她会问「为什么今天是这个」，why 是给人看的理由，用她的语气，别写「根据考频」。'
        + '★ 要遵守的 ★ items 里每条的对象（cardId 或 doc+nodeName）必须是你从 flashcard_pool / cheatsheet / learning_status '
        + '实际读到的，不许自己编 id；一条都排不出来时如实说「今天没有可复习的材料」，不要硬凑。'
        + '★ 这会覆盖当天已有计划 ★ 已经在复习中的话先用 review_plan 读一下，'
        + '要改就用 patch 而不是整体覆盖（覆盖会把已作答的记录清掉）。',
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'YYYY-MM-DD，默认今天' },
          rationale: { type: 'string', description: '今天的复习思路（一句到三句，她会读）' },
          items: {
            type: 'array',
            description:
              '今天的复习项。★ 条数不设上限 ★ 到期/该复习的材料有多少就排多少，'
              + '不许为了让数字好看而砍条目，也不许够不到材料就硬凑。',
            items: {
              type: 'object',
              properties: {
                type: {
                  type: 'string',
                  enum: ['flashcard', 'recall', 'apply'],
                  description: 'flashcard=闪卡翻面 / recall=填空复述（程序判对错）/ apply=场景问答（模型判）',
                },
                cardId: { type: 'string', description: 'type=flashcard 必填：卡的 id（从 flashcard_pool 拿）' },
                conceptKey: { type: 'string', description: 'type=recall/apply 必填：概念的 key（从 learning_status 或 concept_assets 拿）' },
                doc: { type: 'string', description: 'type=recall/apply 建议带：内容所在文档 rel（去 .md），用于取素材' },
                headingId: { type: 'string', description: 'type=recall/apply 建议带：那一节的 headingId（concept_assets 的 tree/quiz 明细里有）——补了它复习界面才能直接取到那节的树素材和测验题' },
                nodeName: { type: 'string', description: 'type=recall/apply 建议带：树节点名（concept_assets 的 tree 明细里有）——补了它素材定位才准' },
                question: { type: 'string', description: 'type=apply 建议带：这个概念上最该问她自己的一句话问题' },
                why: { type: 'string', description: '为什么排它（她会读，要具体）' },
              },
              required: ['type', 'why'],
            },
          },
        },
        required: ['rationale', 'items'],
      },
      run: async (args) => {
        const { saveTodayPlan, planItemId } = await import('./reviewPlan');
        const date = str(args.date) || localDate();
        const rationale = str(args.rationale).trim();
        if (rationale.length < 2) return { error: '缺 rationale：她会问「为什么今天是这个」，这一句是给人看的' };

        const raw = Array.isArray(args.items) ? args.items : [];
        if (!raw.length) return { error: 'items 为空：没有要复习的内容' };
        // ★ 这里曾经 hard-reject > 20 条，2026-10-08 多鱼要求「不要固定上限」后删掉 ★
        //   理由：上限是拿「一天排多了太累」当借口，掩盖真正该解决的问题——
        //   到期材料多就该让她看见多，砍条目只会让 SM-2 永远转不到那批卡（全库 200 张、171 张从未碰过）。
        //   条数由材料决定，不由工具决定。

        const items: ReviewItem[] = [];
        const bad: string[] = [];
        for (let i = 0; i < raw.length; i++) {
          const r = raw[i] as Record<string, unknown>;
          const type = str(r.type);
          const why = str(r.why).trim();
          if (!['flashcard', 'recall', 'apply'].includes(type)) {
            bad.push(`第${i + 1}条：type 只能是 flashcard / recall / apply`);
            continue;
          }
          if (why.length < 2) {
            bad.push(`第${i + 1}条：缺 why`);
            continue;
          }
          const kind = type === 'flashcard' ? 'card' : type === 'recall' ? 'blank' : 'qa';
          if (kind === 'card') {
            const cardId = str(r.cardId);
            if (!cardId) {
              bad.push(`第${i + 1}条：flashcard 必须带 cardId`);
              continue;
            }
            items.push({ id: planItemId('card', cardId), kind, why, cardId });
          } else {
            const conceptKey = str(r.conceptKey);
            if (!conceptKey) {
              bad.push(`第${i + 1}条：${type} 必须带 conceptKey`);
              continue;
            }
            const item: ReviewItem = {
              id: planItemId(kind, conceptKey),
              kind,
              why,
              conceptKey,
            };
            const doc = str(r.doc);
            if (doc) item.doc = doc;
            const hid = str(r.headingId);
            if (hid) item.headingId = hid;
            const nn = str(r.nodeName);
            if (nn) item.nodeName = nn;
            const q = str(r.question);
            if (q) item.question = q;
            items.push(item);
          }
        }
        if (!items.length) return { error: `全部条目都不合法：${bad.join(' | ')}` };

        // 去重：同一张卡/同一个概念排两次就只留第一条（按卡 id 或 concept key）
        const seen = new Set<string>();
        const dedup = items.filter((x) => {
          const k = x.cardId ?? x.conceptKey ?? '';
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });

        const plan = await saveTodayPlan({ date, plannedBy: 'agent', rationale, items: dedup });
        const mix: Record<string, number> = { flashcard: 0, recall: 0, apply: 0 };
        for (const x of plan.items) mix[x.kind === 'card' ? 'flashcard' : x.kind === 'blank' ? 'recall' : 'apply']++;
        return {
          ok: true,
          date: plan.date,
          plannedBy: plan.plannedBy,
          count: plan.items.length,
          mix,
          rationale: plan.rationale,
          droppedDuplicate: items.length - dedup.length,
          rejected: bad,
          items: plan.items.map((x) => ({ id: x.id, kind: x.kind, why: x.why, cardId: x.cardId, conceptKey: x.conceptKey })),
          note:
            '已落到左栏「今天」，她点一下就能开始。'
            + (bad.length ? ` 有 ${bad.length} 条不合法被丢掉。` : '')
            + '★ 三型里 recall（填空）优先给多一点：程序能判对错，她填不出就是没懂，不自欺。'
            + '★ 只有 flashcard 的话她会发现「都记得」——那正是 SM-2 死锁的来源，别只排那一种。',
        };
      },
    },
    {
      name: 'review_plan',
      description:
        '读今天的复习计划（她问「今天要复习什么」「为什么是这个」时用它），或记一条作答结果。'
        + '★ 两种用法 ★ action=read 只读；action=answer 记作答（recall/apply 会判、flashcard 是她自评），'
        + '记完这一轮的掌握度才有依据，后面才能排得更准。'
        + '★ 什么时候该记 ★ 她在复习界面答完一题、或你给她讲完一道题她认可时。'
        + '★ 别改计划本身 ★ 要增删改用 plan_review / patch_review_plan。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['read', 'answer'], description: '默认 read' },
          itemId: { type: 'string', description: 'action=answer 必填：计划里那一条的 id' },
          verdict: {
            type: 'string',
            enum: ['again', 'hard', 'good', 'correct', 'partial', 'wrong', 'skipped'],
            description:
              'flashcard 用 again/hard/good（她自评）；recall 用 correct/wrong；apply 用 correct/partial/wrong。skipped = 她跳过了这题',
          },
          note: { type: 'string', description: 'action=answer 可选：一句为什么错/对（她后来追问时用得上）' },
        },
      },
      run: async (args) => {
        const { readTodayPlan, readLastPlan, recordPlanResult, ApiPlanError } = await import('./reviewPlan');
        const action = str(args.action) || 'read';
        if (action === 'read') {
          const plan = (await readTodayPlan()) ?? (await readLastPlan());
          if (!plan) return { hasPlan: false, note: '还没有排过计划。她问「今天复习什么」就用 plan_review 排一份。' };
          const done = plan.items.filter((x) => x.result).length;
          return {
            hasPlan: true,
            date: plan.date,
            plannedBy: plan.plannedBy,
            rationale: plan.rationale,
            total: plan.items.length,
            answered: done,
            items: plan.items.map((x) => ({
              id: x.id,
              kind: x.kind,
              why: x.why,
              cardId: x.cardId,
              conceptKey: x.conceptKey,
              question: x.question,
              result: x.result ?? null,
            })),
            note:
              plan.date !== localDate()
                ? `★ 这是 ${plan.date} 的计划，不是今天的（今天 ${localDate()}）。要今天的就重新排。`
                : done === plan.items.length
                  ? '今天的都过完了。她还想继续就再排一份。'
                  : `还有 ${plan.items.length - done} 条没过。`,
          };
        }
        const itemId = str(args.itemId);
        const verdict = str(args.verdict);
        if (!itemId || !verdict) return { error: 'action=answer 需要 itemId + verdict' };
        try {
          const plan = await recordPlanResult(itemId, { verdict: verdict as never, note: str(args.note) || undefined, at: new Date().toISOString() });
          const done = plan.items.filter((x) => x.result).length;
          const wrong = plan.items.filter((x) => x.result?.verdict === 'wrong' || x.result?.verdict === 'again').length;
          return {
            ok: true,
            answered: done,
            total: plan.items.length,
            struggling: wrong,
            note: `已记。这一轮 ${done}/${plan.items.length} 条里有 ${wrong} 条没答对——这些是下次优先排的。`,
          };
        } catch (e) {
          return { error: e instanceof ApiPlanError ? e.message : String(e) };
        }
      },
    },
    {
      name: 'patch_review_plan',
      description:
        '在今天已有计划上增删改（她当场说「今天换个别的」「这条太简单了」「加一个 MCP 的」时用它）。'
        + '★ 用它而不用 plan_review ★ plan_review 会覆盖当天计划，把已作答的记录清掉；'
        + '只改一部分就用本工具。'
        + '★ 要对象真实 ★ add 里每条的 cardId / conceptKey 必须是你从 flashcard_pool / learning_status 读到的。'
        + '★ 改完 plannedBy 会变成 her ★ 因为这是她改的——她要能一眼看出哪些是小笔排的、哪些是自己动的。',
      parameters: {
        type: 'object',
        properties: {
          add: {
            type: 'array',
            description: '要加的条目（结构同 plan_review 的 items，含可选 headingId/nodeName）',
            items: { type: 'object' },
          },
          removeIds: { type: 'array', items: { type: 'string' }, description: '要去掉的条目 id（从 review_plan read 拿）' },
          rationale: { type: 'string', description: '改了之后的一句话说明，会覆盖原思路' },
        },
      },
      run: async (args) => {
        const { patchPlan, planItemId, ApiPlanError } = await import('./reviewPlan');
        const removeIds = Array.isArray(args.removeIds) ? args.removeIds.map((x) => str(x)).filter(Boolean) : [];
        const raw = Array.isArray(args.add) ? args.add : [];

        const add: ReviewItem[] = [];
        const bad: string[] = [];
        for (let i = 0; i < raw.length; i++) {
          const r = raw[i] as Record<string, unknown>;
          const type = str(r.type);
          const why = str(r.why).trim();
          const kind = type === 'flashcard' ? 'card' : type === 'recall' ? 'blank' : type === 'apply' ? 'qa' : null;
          if (!kind || !why) {
            bad.push(`第${i + 1}条：type 不合法或缺 why`);
            continue;
          }
          if (kind === 'card') {
            const cardId = str(r.cardId);
            if (!cardId) {
              bad.push(`第${i + 1}条：flashcard 缺 cardId`);
              continue;
            }
            add.push({ id: planItemId('card', cardId), kind, why, cardId });
          } else {
            const ck = str(r.conceptKey);
            if (!ck) {
              bad.push(`第${i + 1}条：缺 conceptKey`);
              continue;
            }
            const item: ReviewItem = { id: planItemId(kind, ck), kind, why, conceptKey: ck };
            const doc = str(r.doc);
            if (doc) item.doc = doc;
            const hid = str(r.headingId);
            if (hid) item.headingId = hid;
            const nn = str(r.nodeName);
            if (nn) item.nodeName = nn;
            const q = str(r.question);
            if (q) item.question = q;
            add.push(item);
          }
        }

        try {
          const plan = await patchPlan(
            { add, removeIds, rationale: str(args.rationale) || undefined },
            { plannedBy: 'her' },
          );
          return {
            ok: true,
            count: plan.items.length,
            rationale: plan.rationale,
            removed: removeIds.length,
            added: add.length,
            rejected: bad,
            items: plan.items.map((x) => ({ id: x.id, kind: x.kind, why: x.why })),
            note: '已改。plannedBy 记成 her 了——她要能看出哪些是小笔排的、哪些是自己动的。',
          };
        } catch (e) {
          return { error: e instanceof ApiPlanError ? e.message : String(e) };
        }
      },
    },
    {
      name: 'flashcard_pool',
      description:
        '查闪卡栏：有哪些卡、卡挂在哪个知识点、复习过没有、哪些内容**还没有卡**。'
        + '★ 什么时候用 ★ 排复习计划前先调它确认「有材料」；她问「我有哪些卡」「XX 有没有卡」「怎么没有卡的」用它。'
        + '★ 先看 gap ★ 它会告诉你哪些高频/高频概念的卡是 0 —— '
        + '**那里最该生成卡**（她说「这里复习不了」，十有八九是 gap 里有它）。'
        + '★ 排计划的用法 ★ concept=xxx 过滤某个概念的卡；byDoc 给一篇文章的卡；'
        + 'includeConcept=false 只看还没挂上知识点的卡（那些 she 复习不到该复习的地方）。'
        + '★ 字段约定 ★ id 是排计划时要用的 cardId，不许自己编。',
      parameters: {
        type: 'object',
        properties: {
          concept: { type: 'string', description: '只看某个概念的卡（conceptKey 或名字片段）' },
          byDoc: { type: 'string', description: '只看某篇文章的卡（rel，去 .md）' },
          includeConcept: { type: 'boolean', description: 'false = 只看还没挂上知识点的卡' },
          limit: { type: 'number', description: '最多返回条数，默认 30。★ 排计划的场景要传大值（如 500）★ 默认 30 是为了省 token，但它会变成事实上的计划上限——你会以为只有 30 张卡可排。' },
        },
      },
      run: async (args) => {
        const all = await listAllSidecars();
        const conceptFilter = str(args.concept).trim().toLowerCase();
        const docFilter = str(args.byDoc).replace(/\.md$/, '');
        const wantUnlinked = args.includeConcept === false;
        const limit = num(args.limit, 30);

        const out: {
          id: string;
          doc: string;
          headingId: string;
          front: string;
          back: string;
          conceptKey: string | null;
          suspended: boolean;
          repetitions: number;
          dueAt: string;
          lapses: number;
        }[] = [];
        // ★ concept 过滤两级（2026-10-11）：conceptKey 精确匹配优先，没有精确命中才退回子串。
        //   旧的一刀切子串会把「上下文工程」的卡混进「上下文」（front/back 里含字面就命中），
        //   排计划时误配的卡她一翻就知道不对——精确命中存在时子串命中一律让位。
        const exactMatching = conceptFilter
          ? (all.some(({ sidecar }) => (sidecar.cards ?? []).some((c) => c.conceptKey === conceptFilter)))
          : false;
        for (const { docRel, sidecar } of all) {
          if (docFilter && docRel.replace(/\.md$/, '') !== docFilter) continue;
          for (const c of sidecar.cards ?? []) {
            if (wantUnlinked && c.conceptKey) continue;
            if (conceptFilter) {
              if (exactMatching) {
                if (c.conceptKey !== conceptFilter) continue;
              } else {
                const hay = `${c.conceptKey ?? ''} ${c.front} ${c.back}`.toLowerCase();
                if (!hay.includes(conceptFilter)) continue;
              }
            }
            out.push({
              id: c.id,
              doc: docRel.replace(/\.md$/, ''),
              headingId: c.headingId,
              front: c.front.slice(0, 90),
              back: c.back.slice(0, 140),
              conceptKey: c.conceptKey ?? null,
              suspended: c.suspended,
              repetitions: c.sm2.repetitions,
              dueAt: c.sm2.dueAt,
              lapses: c.sm2.lapses ?? 0,
            });
          }
        }

        // gap：考频高的节里，一个卡都没有的（最该生成卡的地方）
        const { computeSectionFrequency } = await import('./sectionFrequency');
        const freq = await computeSectionFrequency();
        const cardSecs = new Set<string>();
        for (const { docRel, sidecar } of all) {
          for (const c of sidecar.cards ?? []) cardSecs.add(`${docRel.replace(/\.md$/, '')}#${c.headingId}`);
        }
        const gaps = freq.sections
          .filter((s) => s.marks > 0)
          .map((s) => ({ doc: s.rel, headingId: s.headingId, title: s.headingText, marks: s.marks, cards: 0 }))
          .filter((s) => {
            for (const { docRel, sidecar } of all) {
              if (docRel.replace(/\.md$/, '') !== s.doc) continue;
              if ((sidecar.cards ?? []).some((c) => c.headingId === s.headingId)) return false;
            }
            return true;
          })
          .sort((a, b) => b.marks - a.marks);

        const total = out.length;
        return {
          total,
          returned: out.slice(0, limit).length,
          cards: out.slice(0, limit),
          gap: gaps,
          stats: {
            withConcept: out.filter((x) => x.conceptKey).length,
            unlinked: out.filter((x) => !x.conceptKey).length,
            neverReviewed: out.filter((x) => x.repetitions === 0).length,
            suspended: out.filter((x) => x.suspended).length,
          },
          note:
            '★ 卡挂不上知识点（conceptKey=null）的话，复习时没法按概念组织，'
            + '这些多半是树生成之前的那批。要修得重跑那一节的「转闪卡」。'
            + (gaps.length ? `★ gap 里有 ${gaps.length} 个高频节一张卡都没有——要补卡从这里下手。` : ''),
        };
      },
    },
    {
      name: 'feedback_review',
      description:
        '发起一次「反馈审查」（只出计划不执行）：调一个独立的审查 agent 读学习状态与她的全部反馈，产出结构化修订计划（哪些卡/条目该改写、暂停或进回收站，每条带她的反馈原文作依据）。很贵（约 10 万 token、1 分钟）且结果就是给她看的——只有她明确要求「审一遍我的反馈/清理一下反馈/把没用的收拾掉」时才调；平时了解她的状态用 learning_status / feedback_digest 就够。返回计划清单和落盘路径；执行必须由她本人确认后走 scripts/feedback-review.ts --apply-file，你没有执行权限。',
      parameters: {
        type: 'object',
        properties: {
          top: { type: 'number', description: '重点审查最薄弱的前几个概念，默认 5' },
        },
      },
      run: async (args) => {
        // ★ 动态 import 破环：feedbackAgent 依赖本模块的 sharedTools 组装工具子集，
        //   若本模块顶层反向 import 它会形成初始化环。
        const { runFeedbackReview } = await import('./feedbackAgent');
        const top = typeof args.top === 'number' && args.top > 0 ? Math.min(args.top, 10) : 5;
        const r = await runFeedbackReview({ topN: top, apply: false });
        let planFile: string | null = null;
        if (r.plan && r.plan.ops.length) {
          // 计划落盘，给 --apply-file 用——她确认后一条命令执行，不会「口头执行」
          const root = await requireVaultRoot();
          const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
          planFile = path.join(root, DATA_DIR_NAME, `feedback-plan-${stamp}.json`);
          await fs.promises.writeFile(planFile, JSON.stringify({ at: new Date().toISOString(), apply: false, stop: r.run.stop, plan: r.plan, parseWarnings: r.parseWarnings ?? [], usage: r.run.usage }, null, 2), 'utf8');
        }
        const t = (o: NonNullable<typeof r.plan>['ops'][number]) => {
          const tg = o.target as { targetType: string; doc: string; cardId?: string; ik?: string; layer?: string };
          return { op: o.operation, type: tg.targetType, doc: tg.doc, id: tg.cardId ?? tg.ik ?? null, layer: tg.layer ?? null, reason: o.reason, quote: o.basedOn.quote };
        };
        return {
          stop: r.run.stop,
          parseError: r.parseError ?? null,
          parseWarnings: r.parseWarnings ?? [],
          opsCount: r.plan?.ops.length ?? 0,
          summary: r.plan?.summary ?? '',
          ops: r.plan?.ops.map(t) ?? [],
          planFile,
          note: '把计划完整摆给她看。她下一句话明确确认（如「确认执行」「可以，执行吧」）后，调 feedback_apply 执行，confirmedBy 逐字引用她的确认原话；她没确认就只是计划，别催、别自作主张执行。',
        };
      },
    },
    {
      name: 'feedback_apply',
      description:
        '执行一份已确认的反馈修订计划（feedback_review 产出的 planFile）。**硬前置：她本人看过计划并明确确认**——你必须先在上一轮把计划完整摆给她、她的下一句话明确同意，才能调这个工具；confirmedBy 逐字引用她的确认原话（会写进审计账本，她没确认就执行是严重违规）。执行前自动备份；卡片走暂停、条目进回收站，全部可恢复。',
      parameters: {
        type: 'object',
        properties: {
          planFile: { type: 'string', description: 'feedback_review 返回的计划文件路径' },
          confirmedBy: { type: 'string', description: '她确认执行的那句话，逐字引用，不许可编造' },
        },
        required: ['planFile', 'confirmedBy'],
      },
      run: async (args) => {
        const { applyFeedbackPlan } = await import('./feedbackApplier');
        const { backupOnce } = await import('./backup');
        const { rebuildLearning } = await import('./learning');
        const planFile = str(args.planFile);
        const confirmedBy = str(args.confirmedBy)?.trim() ?? '';
        if (!planFile) return { error: '缺 planFile（feedback_review 返回的计划文件路径）' };
        if (confirmedBy.length < 4) return { error: '缺她的确认原话（confirmedBy）——没有她的确认不能执行，先问、等她点头' };
        // 计划文件必须在 .notebook 数据目录里，防拿任意路径当输入。
        // ★ 相对路径以库根为基准解析（不是进程 cwd=项目根）：实测模型会把
        //   绝对 planFile 缩写成 `.notebook/xxx.json` 传回来，按 cwd 解析必被拒，
        //   白烧一步再重试（2026-09-24 08:50 轮实测）。
        const root = await requireVaultRoot();
        const resolved = path.resolve(root, planFile);
        if (!resolved.startsWith(path.join(root, DATA_DIR_NAME) + path.sep)) {
          return { error: 'planFile 必须是 .notebook 下的计划文件（请原样传 feedback_review 返回的 planFile，不要改写路径）' };
        }
        let raw: { plan?: unknown; appliedAt?: string };
        try {
          raw = JSON.parse(await fs.promises.readFile(resolved, 'utf8'));
        } catch {
          return { error: `计划文件读不了：${resolved}` };
        }
        const plan = raw.plan as { ops?: unknown[]; summary?: string } | undefined;
        if (!plan || !Array.isArray(plan.ops) || plan.ops.length === 0) {
          return { error: '该文件里没有可执行的 plan.ops（可能是解析失败的计划）' };
        }
        if (raw.appliedAt) {
          return { error: `这份计划已于 ${raw.appliedAt} 执行过，不重复执行`, appliedAt: raw.appliedAt };
        }
        const backup = await backupOnce('feedback_apply（她已确认）');
        const rep = await applyFeedbackPlan(plan as never, { dry: false });
        // 她的确认原话单独入审计——谁在什么时候点头了，账上必须有
        await appendFeedbackActions([
          {
            at: new Date().toISOString(),
            op: 'plan.confirm',
            doc: path.basename(resolved),
            target: { planFile: resolved, ops: plan.ops.length },
            reason: `计划共 ${plan.ops.length} 条，applied=${rep.applied} skipped=${rep.skipped} rejected=${rep.rejected}；备份=${backup ?? '无'}`,
            basedOn: { confirmedBy },
            result: 'applied',
          },
        ]);
        if (rep.applied > 0) {
          await rebuildLearning().catch(() => undefined);
          await writeFeedbackDigest().catch(() => undefined);
          // 标记已执行（幂等防重放），确认原话一起落
          raw.appliedAt = new Date().toISOString();
          (raw as Record<string, unknown>).confirmedBy = confirmedBy;
          await fs.promises.writeFile(resolved, JSON.stringify(raw, null, 2), 'utf8');
        }
        return {
          applied: rep.applied,
          skipped: rep.skipped,
          rejected: rep.rejected,
          fatal: rep.fatal ?? null,
          rows: rep.rows.map((r) => ({ op: r.op, doc: r.doc, result: r.result, why: r.rejectedWhy ?? null })),
          confirmedBy,
          note: '结果如上。被 rejected 的条目说明闸门拦住了（目标已不在/依据没命中），如实转述，别粉饰。',
        };
      },
    },
    {
      name: 'edit_library',
      description:
        '她**指名**要改库里生成物时用它（改条目文字 / 新建或停用闪卡 / 改知识树节点）。流程：你把改动整理成清单 → 界面弹确认卡 → 她点「批准」才真的动手。★ 规矩：她没点批准就不许换说法重试；一次最多 5 条；她的**笔记原文（md）不在本工具权限内**（她要求改原文时如实说这条边界）；按反馈标记成批清理走 feedback_review，别用本工具。'
        + ' ops 每条结构（字段一字不差）：{"operation":"item.revise","target":{"targetType":"item","doc":"<relPath>","headingId":"<id>","ik":"<8位>","layer":"命题|条目|术语"},"newContent":"<新文本>","reason":"<为什么改，≥4字>","basedOn":{"channel":"userInstruction","doc":"<relPath>","quote":"<她本次原话的逐字片段>"}}。'
        + ' operation 可选：item.revise（要 newContent）/ item.remove / card.create（新建，要 newContent:{front,back,quote?,conceptKey?}，target 用 {"targetType":"newCard","doc":…,"headingId":…}）/ card.revise（要 newContent:{front?,back?}）/ card.suspend / treeNode.revise（要 field:"name"|"essence" + newContent）。'
        + ' ★ card.create 的正面必须是完整问句 ★ 服务端有硬门挡「Harness 工程 · 概念」这种标签形状，会直接拒——写的时候就把问题写全。'
        + ' target 定位字段：card 用 {targetType:"card",doc,cardId}；item 用 {targetType:"item",doc,headingId,ik,layer}；treeNode 用 {targetType:"treeNode",doc,headingId,ik,name}。'
        + ' ik 与 cardId 必须是你从 cheatsheet / feedback_digest / flashcard_pool 等工具实际读到的，不许自己编。',
      parameters: {
        type: 'object',
        properties: {
          instruction: { type: 'string', description: '她的原话（逐字引用她要求改什么），写进审计' },
          ops: {
            type: 'array',
            description: '变更清单，最多 5 条（结构见工具描述）',
            items: { type: 'object' },
          },
        },
        required: ['instruction', 'ops'],
      },
      run: async (args, ctx) => {
        const { changeOpSchema, applyFeedbackPlan, buildEvidencePool, textOf } = await import('./feedbackApplier');
        const { backupOnce } = await import('./backup');
        const { rebuildLearning } = await import('./learning');
        const { readSidecar } = await import('./sidecar');

        const instruction = str(args.instruction).trim();
        if (instruction.length < 2) return { error: '缺 instruction（她的原话）——没有她的话做依据，我不能改' };
        const rawOps = Array.isArray(args.ops) ? args.ops : [];
        if (!rawOps.length) return { error: 'ops 为空：没有要改的对象' };
        if (rawOps.length > 5) {
          return { error: `ops ${rawOps.length} 条超上限 5，整体拒绝（不截断）——拆成几次、分次问她，别一次堆太多` };
        }
        // 逐条 schema 校验：合法的留下，非法的剔除并说明（与 feedback 计划同款 per-op 过滤）
        const ops: import('./feedbackApplier').ChangeOp[] = [];
        const bad: string[] = [];
        for (let i = 0; i < rawOps.length; i++) {
          const r = changeOpSchema.safeParse(rawOps[i]);
          if (r.success) ops.push(r.data);
          else bad.push(`第${i + 1}条：${r.error.issues.slice(0, 2).map((x) => `${x.path.join('.')} ${x.message}`).join('；')}`);
        }
        if (!ops.length) return { error: `全部变更都不合法：${bad.join(' | ')}` };

        // ★ 没有人工通道就不许动 ★（MCP / 脚本场景没人在界面上点批准）
        if (!ctx?.requestApproval) {
          return {
            error: 'NO_APPROVAL_CHANNEL',
            message: '现在没有确认通道（她不在这条对话流里），所以我不能改库。把你想改的讲清楚，请她到对话界面来确认。',
          };
        }

        // 构造影响面清单：人话定位 + 改前内容（她看不懂 ik，卡上必须给标题和原文）
        const cache = new Map<string, Awaited<ReturnType<typeof readSidecar>> | null>();
        const actions: ApprovalAction[] = [];
        const kept: typeof ops = [];
        for (const op of ops) {
          const doc = op.target.doc;
          if (!cache.has(doc)) {
            cache.set(doc, await readSidecar(doc).catch(() => null));
          }
          const s = cache.get(doc) ?? null;
          if (!s) {
            bad.push(`读不到文档 ${doc}`);
            continue;
          }
          const t = op.target as Record<string, string>;
          if (op.operation.startsWith('card.')) {
            // ★ card.create 先分支 ★ 它没有 cardId（卡还不存在），
            //   落到下面的 find(x => x.id === undefined) 会报「cardId 不存在」而整个丢掉。
            if (op.operation === 'card.create') {
              const nc = (op as { newContent: { front: string; back: string } }).newContent;
              const secTitle = (s.cheatsheet?.sections ?? []).find((x) => x.headingId === t.headingId)?.headingText;
              actions.push({
                op: op.operation,
                opLabel: '新建闪卡',
                doc,
                where: `《${doc.split('/').pop()?.replace(/\.md$/, '')}》· ${secTitle ?? '未归类'}`,
                before: '（这张卡还不存在）',
                after: nc.front.slice(0, 120),
                danger: false,
              });
              kept.push(op);
              continue;
            }
            const c = (s.cards ?? []).find((x) => x.id === t.cardId);
            if (!c) {
              bad.push(`cardId ${t.cardId} 不存在`);
              continue;
            }
            const isRevise = op.operation === 'card.revise';
            actions.push({
              op: op.operation,
              opLabel: isRevise ? '改闪卡' : op.operation === 'card.suspend' ? '暂停闪卡' : '停用闪卡',
              doc,
              where: `闪卡「${(c.front ?? '').slice(0, 26)}${(c.front ?? '').length > 26 ? '…' : ''}」`,
              before: (c.front ?? '').slice(0, 120),
              ...(isRevise ? { after: String((op as { newContent?: { front?: string; back?: string } }).newContent?.front ?? '').slice(0, 120) } : {}),
              danger: !isRevise,
            });
            kept.push(op);
            continue;
          }
          const sec = (s.cheatsheet?.sections ?? []).find((x) => x.headingId === t.headingId);
          if (!sec) {
            bad.push(`headingId ${t.headingId} 在 ${doc} 里不存在`);
            continue;
          }
          if (op.operation === 'item.revise' || op.operation === 'item.remove') {
            const layer = t.layer as '命题' | '条目' | '术语';
            const arr = layer === '命题' ? sec.items?.propositions ?? [] : layer === '术语' ? sec.items?.terms ?? [] : sec.items?.entries ?? [];
            const idx = arr.findIndex((it) => itemKeyOf(textOf(layer, it)) === t.ik);
            if (idx < 0) {
              bad.push(`ik ${t.ik} 在「${sec.headingText}」${layer}层匹配不到`);
              continue;
            }
            const cur = textOf(layer, arr[idx]);
            const isRevise = op.operation === 'item.revise';
            actions.push({
              op: op.operation,
              opLabel: isRevise ? '改条目文字' : '移入回收站',
              doc,
              where: `《${doc.split('/').pop()?.replace(/\.md$/, '')}》· ${sec.headingText} · ${layer}第 ${idx + 1} 条`,
              before: cur.slice(0, 120),
              ...(isRevise ? { after: String((op as { newContent?: string }).newContent ?? '').slice(0, 120) } : {}),
              danger: !isRevise,
            });
            kept.push(op);
            continue;
          }
          if (op.operation === 'treeNode.revise' || op.operation === 'treeNode.essenceRevise') {
            const node = (sec.tree?.nodes ?? []).find((n) => n.name === t.name && itemKeyOf(n.essence ?? '') === t.ik);
            if (!node) {
              bad.push(`树节点「${t.name}」在「${sec.headingText}」定位不到`);
              continue;
            }
            const field = op.operation === 'treeNode.revise' ? (op as { field: 'name' | 'essence' }).field : 'essence';
            actions.push({
              op: op.operation,
              opLabel: field === 'name' ? '改节点名' : '改节点要点',
              doc,
              where: `《${doc.split('/').pop()?.replace(/\.md$/, '')}》· ${sec.headingText} · 节点「${node.name}」`,
              before: String(field === 'name' ? node.name : node.essence ?? '').slice(0, 120),
              after: String((op as { newContent?: string }).newContent ?? '').slice(0, 120),
              danger: false,
            });
            kept.push(op);
            continue;
          }
          bad.push(`不支持的操作 ${op.operation}`);
        }
        if (!kept.length) return { error: `没有可执行的目标：${bad.join(' | ')}` };

        // ★ 挂起等她点批准 ★（超时/拒绝都在 approvals.ts 里处理）
        const decision = await ctx.requestApproval({
          title: `小笔想改 ${kept.length} 处`,
          note: instruction,
          actions,
        });

        if (!decision.approved) {
          await appendFeedbackActions([
            {
              at: new Date().toISOString(),
              op: decision.timedOut ? 'edit.timeout' : 'edit.reject',
              doc: actions[0]?.doc ?? '-',
              target: { actionCount: kept.length },
              reason: instruction,
              basedOn: { channel: 'userInstruction', quote: instruction },
              result: 'rejected',
              rejectedWhy: decision.by,
            },
          ]).catch(() => undefined);
          return {
            approved: false,
            by: decision.by,
            timedOut: !!decision.timedOut,
            note: decision.timedOut
              ? '她这段时间没在，改动**没有执行**（一个字都没动）。如实告诉她这件事，让她回来再决定。'
              : '她**拒绝了**这批改动，库没有任何变化。不要换个说法重试同一批；她若有新说法，按新要求重新构造清单。',
          };
        }

        const backup = await backupOnce('edit_library（她已确认）');
        const docs = [...new Set(kept.map((o) => o.target.doc))];
        const pool = [instruction, ...(await buildEvidencePool(docs))];
        const rep = await applyFeedbackPlan(
          { planVersion: 1, ops: kept, summary: instruction },
          { dry: false, evidencePool: pool },
        );
        await appendFeedbackActions([
          {
            at: new Date().toISOString(),
            op: 'edit.approve',
            doc: actions[0]?.doc ?? '-',
            target: { actionCount: kept.length, actions },
            reason: instruction,
            basedOn: { channel: 'userInstruction', quote: instruction, by: decision.by },
            result: 'applied',
            ...(backup ? { before: { backup } } : {}),
          },
        ]).catch(() => undefined);
        if (rep.applied > 0) {
          await rebuildLearning().catch(() => undefined);
          const { writeFeedbackDigest } = await import('./feedback');
          await writeFeedbackDigest().catch(() => undefined);
        }
        return {
          approved: true,
          by: decision.by,
          applied: rep.applied,
          skipped: rep.skipped,
          rejected: rep.rejected,
          fatal: rep.fatal ?? null,
          rows: rep.rows.map((r) => ({ op: r.op, doc: r.doc, result: r.result, why: r.rejectedWhy ?? null })),
          backup: backup ?? null,
          ...(bad.length ? { skippedInvalid: bad } : {}),
          note: '结果如上。被 rejected 的说明闸门拦住了（目标已变/依据没命中），如实转述不要粉饰。改动都可恢复（条目在回收站、卡片是软删）。',
        };
      },
    },
    {
      name: 'recall_sessions',
      description:
        '回忆你（助手）自己过去几轮干了什么（M3 情景记忆）：回答过哪些批注、有没有没做完的事。继续之前的任务或保持前后一致时用它。默认给紧凑摘要；需要回放某轮的具体过程（她说了什么全文、你调工具的入参和返回）就传 full=true。这里只有你自己的会话记录，她的偏好要看 learning_status / feedback_digest。',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: '最近几轮，默认 10' },
          full: { type: 'boolean', description: 'true = 返回完整问答和逐步轨迹（工具入参/返回）；默认只给摘要' },
          sessionId: {
            type: 'string',
            description: '只想看某一轮的全部过程时，直接给它的 id（annotations / 摘要里带）——比开 full 拉一堆省得多',
          },
        },
      },
      run: async (args) => {
        const wantId = str(args.sessionId);
        if (wantId) {
          const hit = (await listSessions(200)).find((s) => s.id === wantId);
          if (!hit) return { error: `没有 id 为 ${wantId} 的会话记录` };
          return { session: serialize(hit, true) };
        }
        const full = args.full === true;
        const sessions = await listSessions(num(args.limit, 10));
        if (!full) {
          return { total: sessions.length, sessions: sessions.map((s) => serialize(s, false)) };
        }
        // ★ full 的总量预算（2026-09-23）★
        //   实测：full 拉 15 轮会到 4~5 万字符（steps 明细占 77~81%，
        //   那是审计数据，本该躺在磁盘里），而这工具被 spill 豁免 →
        //   整段原样进上下文，一轮就烧掉 8 万 prompt token。
        //   这里按总字符裁剪（保留最近的、即最相关的），并明说被截断了。
        const out: Record<string, unknown>[] = [];
        let used = 0;
        let dropped = 0;
        for (const s of sessions) {
          const rec = serialize(s, true);
          const size = JSON.stringify(rec).length;
          if (out.length && used + size > RECALL_FULL_BUDGET) {
            dropped++;
            continue;
          }
          out.push(rec);
          used += size;
        }
        return {
          total: sessions.length,
          sessions: out,
          ...(dropped
            ? {
                notice:
                  `已按 ${RECALL_FULL_BUDGET} 字符预算裁掉 ${dropped} 轮较早的记录。` +
                  '要看某一轮的完整过程，用 sessionId 参数单独取它的 id，别用 full 再拉一遍。',
              }
            : {}),
        };
      },
    },
    {
      name: 'reply_note',
      description:
        '把你的回复写到她的一条批注下面（就地回答，她会直接看到）。必须先有内容依据：回答提问前先 read_doc 看批注锚的原文、必要时 search 查证；不确定的事明说不确定。回复会以「助手」身份展示，且不会混进任何她的偏好数据。',
      parameters: {
        type: 'object',
        properties: {
          noteId: { type: 'string', description: '批注 id（annotations 返回的 id）。**优先用它**' },
          doc: { type: 'string', description: '降级匹配用：文档相对路径' },
          bi: { type: 'number', description: '降级匹配用：批注所在块号' },
          quote: { type: 'string', description: '降级匹配用：批注锚的原文片段（提高匹配准确性）' },
          body: { type: 'string', description: '回复正文。直接回答 + 依据（可引用块号），不要寒暄' },
        },
        required: ['body'],
      },
      run: async (args) => {
        const body = str(args.body).trim();
        if (!body) throw new ApiError(400, 'body 不能为空', 'bad_request');
        const noteId = str(args.noteId) || undefined;
        const doc = str(args.doc) || undefined;
        const bi = typeof args.bi === 'number' ? args.bi : undefined;
        const quote = str(args.quote) || undefined;
        if (!noteId && !(doc && typeof bi === 'number')) {
          throw new ApiError(400, '需要 noteId，或 doc + bi（annotations 的返回里都有）', 'bad_request');
        }
        // ★ author 在这里定死为 'assistant'，入参无法改写（硬隔离落在服务层之外再保一道）★
        const ref = await findNote({ noteId, docRel: doc, bi, quote });
        const before = ref.note.replies?.length ?? 0;
        const reply = await addNoteReply(ref.docRel, ref.note.id, 'assistant', body, 'agent:reply_note');
        return {
          ok: true,
          doc: ref.docRel,
          noteId: ref.note.id,
          bi: ref.note.selector.blockIndex,
          quote: ref.note.selector.quote,
          repliesTotal: before + 1,
          replyId: reply.id,
        };
      },
    },
    {
      name: 'run_code',
      description:
        '执行你写的 node 或 python 脚本（单文件、标准库+项目 node_modules）。用途：库内数据统计分析（该算的用代码算，别口算）、批量检查、格式转换。硬规则：①工作目录是笔记库根，你能 fs 读全库（含 .notebook）；②写/删只准发生在 .assistant/agent/ 下，她的笔记与 .notebook 对脚本同样是禁写区（提示词铁律 9）；③递归强删类操作被黑名单直接拒绝；④单次 30 秒超时、输出截断 2 万字符。她会实时看到你的每一段代码——写干净点，带注释。',
      parameters: {
        type: 'object',
        properties: {
          lang: { type: 'string', enum: ['node', 'python'], description: '运行时。node 用当前服务同款 Node（ESM 环境，require 已自动兼容可直接用，也可用 import；可加载项目 node_modules）；python 用系统 PATH 里的 python（Anaconda，自带 pypdf 等常用库）' },
          code: { type: 'string', description: '完整脚本代码。不要 markdown 围栏；中文输出无需自己设编码（已处理）。需要结果就用 console.log/print 输出' },
        },
        required: ['lang', 'code'],
      },
      run: async (args) => {
        const lang = str(args.lang, 'node') === 'python' ? 'python' : 'node';
        let code = str(args.code).replace(/^\s*```[a-z]*\s*\n?/i, '').replace(/\n?```\s*$/, '');
        if (!code.trim()) throw new ApiError(400, 'code 不能为空', 'bad_request');
        if (code.length > RUN_CODE_CAP) throw new ApiError(400, `代码超过 ${RUN_CODE_CAP} 字符，拆开跑`, 'too_large');
        for (const p of DESTRUCTIVE_PATTERNS) {
          if (p.re.test(code)) {
            throw new ApiError(400, `代码被拒绝：命中破坏性操作黑名单「${p.label}」。递归/强制删除一律不允许；要清理只准清 .assistant/agent/ 内的个别文件（unlink 单文件）`, 'blocked');
          }
        }
        const runDir = await resolveInVault('.assistant/agent/runs');
        await fs.promises.mkdir(runDir, { recursive: true });
        // ★ ESM 兜底（2026-09-24 中断事故治本）：脚本落盘是 .mjs（ESM），
        //   模型十次有八次手滑写 require —— 实测 8 轮会话 6 轮踩坑，每轮白烧
        //   1~3 步修编译错，最多的一次直接把 20 步预算烧穿（08:50/08:51 连环中断）。
        //   注入 createRequire 让 CommonJS 写法直接能跑，能力等价于 CJS，无新增权限。
        if (lang === 'node' && /\brequire\s*\(/.test(code) && !code.includes('createRequire')) {
          code =
            "import { createRequire } from 'node:module';\n" +
            'const require = createRequire(import.meta.url);\n' +
            code;
        }
        const file = path.join(runDir, `run-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${lang === 'python' ? 'py' : 'mjs'}`);
        await fs.promises.writeFile(file, code, 'utf8');
        const cwd = await requireVaultRoot();
        const env: NodeJS.ProcessEnv = { ...process.env, PYTHONIOENCODING: 'utf-8' };
        let result: RunResultCode;
        if (lang === 'python') {
          result = await runScript('python', [file], { cwd, env });
        } else {
          env.NODE_PATH = path.join(PROJECT_ROOT, 'node_modules');
          result = await runScript(process.execPath, [file], { cwd, env });
        }
        return {
          ok: !result.timedOut && result.exitCode === 0,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          ms: result.ms,
          stdout: result.stdout,
          stderr: result.stderr,
          file: path.relative(await requireVaultRoot(), file).replace(/\\/g, '/'),
          note: '脚本已留档在你的 .assistant/agent/runs/ 下，可随时复查。',
        };
      },
    },
    {
      name: 'remember',
      description:
        '长期记忆条目库（语义层，memory.json）的进出。list=看活跃记忆；add=记新条；update=微调某条；supersede=她推翻旧认知时用新条取代旧条；revoke=作废记错的。铁律：她的原话（type=her-words）必须 quote 照录、拿不准就先 recall_sessions 查全文，禁止凭印象补全——你记错话她是要抽查对账的。涉及「记住/偏好/习惯」的长期内容用这个，别再往 write_workspace 的 markdown 里手搓记忆条目（那里只留工作日志和长备忘）。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'add', 'update', 'supersede', 'revoke'], description: '操作' },
          id: { type: 'string', description: 'update/supersede/revoke 的目标条目 id（list 结果里有）' },
          kind: { type: 'string', enum: ['preference', 'habit', 'fact', 'understanding'], description: 'add 必填：偏好/习惯/事实/我对其的理解' },
          content: { type: 'string', description: 'add/update/supersede 必填：一句话，≤500 字，一条只记一件事' },
          quote: { type: 'string', description: '她的原话照录（type=her-words 必填）' },
          sessionId: { type: 'string', description: '来源会话 id（recall_sessions 里有）' },
          sourceType: { type: 'string', enum: ['her-words', 'inferred', 'observed'], description: 'add 必填：她亲口说的/我推断的/我从数据观察到的' },
          reason: { type: 'string', description: 'revoke 的原因' },
        },
        required: ['action'],
      },
      run: async (args) => {
        const action = str(args.action, 'list');
        const hasSource = Boolean(args.sourceType || args.quote || args.sessionId);
        const source: MemorySource = {
          type: (str(args.sourceType, 'inferred') as MemorySourceType),
          ...(args.quote ? { quote: str(args.quote) } : {}),
          ...(args.sessionId ? { sessionId: str(args.sessionId) } : {}),
        };
        switch (action) {
          case 'list': {
            const entries = await listActive(30);
            return { count: entries.length, entries };
          }
          case 'add': {
            if (!args.kind || !args.content) throw new ApiError(400, 'add 需要 kind + content', 'bad_request');
            const entry = await addMemory({
              kind: str(args.kind) as MemoryKind,
              content: str(args.content),
              source: source,
            });
            return { ok: true, entry, note: '已入长期记忆。她说的话以后要改，用 update/supersede，别 add 一条新的就完事。' };
          }
          case 'update': {
            if (!args.id || !args.content) throw new ApiError(400, 'update 需要 id + content', 'bad_request');
            const entry = await updateMemory(str(args.id), str(args.content));
            return { ok: true, entry };
          }
          case 'supersede': {
            if (!args.id || !args.content) throw new ApiError(400, 'supersede 需要 id + content', 'bad_request');
            const entry = await supersedeMemory(str(args.id), {
              ...(args.kind ? { kind: str(args.kind) as MemoryKind } : {}),
              content: str(args.content),
              ...(hasSource ? { source } : {}),
            });
            return { ok: true, entry, note: '旧条已标记 superseded（历史保留）。' };
          }
          case 'revoke': {
            if (!args.id) throw new ApiError(400, 'revoke 需要 id', 'bad_request');
            const entry = await revokeMemory(str(args.id), args.reason ? str(args.reason) : undefined);
            return { ok: true, entry };
          }
          default:
            throw new ApiError(400, `未知 action: ${action}`, 'bad_request');
        }
      },
    },
    {
      name: 'write_workspace',
      description:
        '往你自己的工作区写文件（notes/.assistant/agent/ 下，AGENTS.md 授权的唯一写区）。用途：工作日志、长备忘（会话摘要只存 120 字，长内容写这里）、给维护者 AI 递话（她和你都看得到）。**这是你在全库唯一能写的地方**——除 .assistant/agent/ 外一切路径都会被拒绝，也永远不要试图写她的笔记或 .notebook/。默认用 append（追加），换新主题就换新文件。',
      parameters: {
        type: 'object',
        properties: {
          file: {
            type: 'string',
            description: '文件名，如 工作日志.md 或 记忆/她常问什么.md。只用相对 .assistant/agent/ 的路径，不要带 .assistant/agent/ 前缀',
          },
          content: { type: 'string', description: '要写入的内容（markdown）' },
          mode: {
            type: 'string',
            description: 'append=追加到文件末尾（默认，推荐）；write=覆盖整个文件（只用于你完全拥有、需要整体重写的文件）',
            enum: ['append', 'write'],
          },
        },
        required: ['file', 'content'],
      },
      run: async (args) => {
        const file = str(args.file).trim().replace(/\\/g, '/');
        const content = str(args.content);
        const mode = str(args.mode, 'append') === 'write' ? 'write' : 'append';
        if (!file) throw new ApiError(400, 'file 不能为空', 'bad_request');
        if (!content) throw new ApiError(400, 'content 不能为空', 'bad_request');
        if (content.length > 100_000) throw new ApiError(400, '单次写入超过 10 万字符，拆成几次', 'bad_request');
        // 只允许「自己的文件名」：拒绝绝对路径、目录逃逸、.md/.txt 外的扩展名
        const name = file.replace(/^\.\/+/, '');
        if (name.startsWith('/') || name.includes('../') || name.includes('..\\') || /[:*?"<>|]/.test(name)) {
          throw new ApiError(400, '路径不合法：只允许 agent/ 目录内的相对文件名', 'bad_path');
        }
        const rel = `.assistant/agent/${name}`;
        const agentRoot = await resolveInVault('.assistant/agent');
        const abs = await resolveInVault(rel); // 再过一道库内解析，防任何逃逸
        if (!abs.startsWith(agentRoot + path.sep)) {
          throw new ApiError(400, '落点越界：只能写 .assistant/agent/ 下', 'bad_path');
        }
        await fs.promises.mkdir(path.dirname(abs), { recursive: true });
        let sizeBefore = 0;
        try {
          sizeBefore = (await fs.promises.stat(abs)).size;
        } catch {
          /* 新文件 */
        }
        if (sizeBefore + Buffer.byteLength(content, 'utf8') > 512 * 1024) {
          throw new ApiError(400, '文件超过 512KB 上限，换新文件存', 'too_large');
        }
        if (mode === 'append' && sizeBefore > 0) {
          await fs.promises.appendFile(abs, '\n\n' + content, 'utf8');
        } else {
          await fs.promises.writeFile(abs, content, 'utf8');
        }
        return {
          ok: true,
          file: rel,
          mode,
          bytesBefore: sizeBefore,
          bytesAfter: sizeBefore + Buffer.byteLength(content, 'utf8'),
          note: '已落盘。你和多鱼、维护者 AI 都能通过 read_doc 读这个文件。',
        };
      },
    },
    // 联网工具（web_fetch / web_search）按配置启用状态注册，默认全开。
    // 放在最后：它们是「库外」能力，库内工具永远优先（查得到就不用联网）。
    ...webTools(),
  ];
}
