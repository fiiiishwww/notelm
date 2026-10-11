/**
 * server/services/agentRuntime.ts —— 最小的 function-calling 循环。
 *
 * ★ 为什么单独抽一层，而不是在 activation 里直接写 while ★
 *   循环本身有几个和业务无关的难点，各自解决一次就够：
 *     1. 步数/预算/重复调用的停止条件；
 *     2. 工具报错要变成「模型看得懂的话」喂回去，而不是把整个任务炸掉；
 *     3. 每一步留痕（trace）——出问题时靠它复盘，评测算成本也靠它。
 *   业务代码只该关心「有哪些工具、系统提示词是什么」。
 *
 * ★ 三条停止条件分别防什么 ★
 *   - maxSteps：模型在两三个工具之间来回打转，永远不收敛
 *   - tokenBudget：成本失控。一次激活花多少钱必须可控
 *   - 重复调用：同一个工具、同样的入参连着调两次，说明它卡住了。
 *     这一条最关键——实测没有它时，模型会反复用同一个词 search_notes
 *     直到撞上 maxSteps，白白烧掉几十次调用。
 *
 * ★ 工具失败为什么不抛出去 ★
 *   这是 agent 和普通代码最大的区别：普通代码里失败了就报错；
 *   agent 里失败是一种信息——参数写错、文档不存在、检索没结果，
 *   这些都是模型能自己修正的。所以错误要转成文本喂回给它，
 *   并在文本里说清「该怎么改」，它才知道下一步往哪走。
 */

import { chatWithTools, type ChatMessage, type ToolSpec } from './aiClient';
import type { ApprovalRequestDraft, ApprovalDecision } from './approvals';
import {
  addUsage,
  estimateBreakdown,
  newUsageAccumulator,
  type UsageAccumulator,
} from './tokenMeter';

/** 工具执行结果。既可以正常返回，也可以主动说明「这次没找到」。 */
export interface ToolOutcome {
  /** 给模型看的文本。必须紧凑，塞整篇文档进来会把上下文撑爆 */
  text: string;
  /** 是否算失败。失败会触发「同一工具连续失败」计数 */
  failed?: boolean;
  /** 额外结构化数据，给上层落盘用，不进模型上下文 */
  data?: unknown;
}

/**
 * 工具执行时的运行时上下文。给「需要当场问她」的写工具用：
 * 工具 awaut ctx.requestApproval(...) 会挂起整轮，等她在界面上点批准/拒绝。
 * 没有这个通道（MCP / 脚本场景）时，写工具必须**直接拒绝执行**，不许静默改。
 */
export interface ToolCtx {
  requestApproval?: (req: ApprovalRequestDraft) => Promise<ApprovalDecision>;
}

export interface Tool {
  spec: ToolSpec;
  run: (input: Record<string, unknown>, ctx?: ToolCtx) => Promise<ToolOutcome>;
}

export type RunStepKind = 'model' | 'tool' | 'error' | 'stop';

export interface RunStep {
  at: string;
  kind: RunStepKind;
  /** model：文本摘要；tool：工具名；stop：停止原因 */
  label: string;
  detail?: string;
  ms: number;
  /** tool 步骤的入参（已截断） */
  input?: string;
  /** tool 步骤给模型看的返回（已截断） */
  output?: string;
  failed?: boolean;
}

export type StopReason = 'answer' | 'max_steps' | 'budget' | 'repeat' | 'aborted' | 'error' | 'empty_reply';

export interface RunResult {
  /** 模型最后一次给出的纯文本（没有工具调用的那次） */
  answer: string;
  steps: RunStep[];
  stop: StopReason;
  error?: string;
  /**
   * 用量。`promptTokens`/`completionTokens` 是**线上原值**（promptTokens 含缓存命中），
   * 预算判定与旧会话文件的语义都依赖它，**不许改**；四类拆分为 2026-09-23 新增，
   * 网关不报的字段保持 undefined（「没报」≠「是 0」）。
   */
  usage: UsageAccumulator;
  /**
   * 上下文压力（估算，仅供展示与压缩决策；**不进会话落盘**）。
   * 对齐 DSH `dsh-token-meter` 的 contextPressure / contextBreakdown 两个投影面。
   */
  contextPressure?: {
    /** 最后一次请求真实报出来的 prompt 规模（没有报数时为 0） */
    pressureTokens: number;
    /** 下一次请求的 prompt 规模估算（system + tools + 全部消息） */
    projectedTokens: number;
    breakdown: { systemTokens: number; toolsTokens: number; messageTokens: number };
  };
}

export interface RunOptions {
  tools: Tool[];
  system: string;
  /** 第一轮用户消息 */
  task: string;
  /** 每轮模型调用允许的最大步数（一次模型调用 + 它要求的所有工具调用算一步） */
  maxSteps?: number;
  /** 累计 token 上限（prompt + completion），超过就停 */
  tokenBudget?: number;
  /** 单步超时，毫秒 */
  stepTimeoutMs?: number;
  /**
   * 单步 completion 上限。默认 4000 对聊天轮够用，但 reasoning 模型的思考
   * token 也计在这里面——要求模型最后输出长结构化 JSON 的任务轮
   * （reasoning 4000+ + JSON 2000+）会被截断成空正文（empty_reply 实测，
   * 2026-09-24 反馈审查轮），这类调用方应传 8000。
   */
  maxTokens?: number;
  signal?: AbortSignal;
  /** 每一步都会回调，用于实时落盘 / 前端进度 */
  onStep?: (s: RunStep) => void | Promise<void>;
  /**
   * 审批通道：写工具调它 → 挂起整轮 → 她在界面上点批准/拒绝后 resolve。
   * 不传 = 没有人工通道（MCP / 脚本），写工具会拒绝执行而不是静默改。
   */
  onApprovalRequest?: (req: ApprovalRequestDraft) => Promise<ApprovalDecision>;
  /** 额外塞进首轮的上下文（比如「这些文档已读过」） */
  context?: string;
  /**
   * 工具结果进上下文前的统一变换（溢出/压缩策略在此插入，对标 DSH 的可插拔策略层）。
   * 返回替换后的文本；抛错则退回原文。传 spillIfLarge 即启用溢出落盘。
   */
  transformToolResult?: (toolName: string, text: string) => Promise<string>;
}

const DEFAULTS = {
  maxSteps: 12,
  tokenBudget: 200_000,
  stepTimeoutMs: 90_000,
  /** 历史里保留完整原文的 tool 结果条数，更早的会被压成一行摘要 */
  keepFullResults: 6,
};

/** 单条 trace 里最多留多少字符。trace 是给人看的，留太长反而找不出问题。 */
const TRACE_MAX = 300;

function clip(s: string, n = TRACE_MAX): string {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/**
 * 把历史里较早的工具返回压成「头 + 尾 + 省略标记」。
 *
 * ★ 为什么必须有这一步 ★
 *   一次真实激活实测：8 轮模型调用烧掉 **16.7 万 prompt token**，其中绝大部分是
 *   同一段 read_doc 正文被反复重发。原因是每轮请求都要把全部历史原样发给模型，
 *   而模型到第 3 轮之后根本不再看第 1 轮读过的文档。
 *
 *   ★ v2（对齐 DSH compaction）：旧版砍到 110 字符，结论几乎必丢；现在保头 500
 *   （JSON 元数据/开头结论通常在这里）+ 尾 200（统计/链接/收尾在这里），中间省略。
 *   提示语不写「请重新调用」——原样重复调用会撞重复检测直接停轮，这是老版埋的陷阱。
 *
 *   ★ v3（2026-09-23）：幂等 + 攒批。旧实现每步都把新增的那一条就地压掉，
 *   而它位置靠前 → 之后整个前缀失效，轮内缓存被逐步骤毁掉，还会反复重压、
 *   嵌套劣化（压完约 773 字符 > 跳过阈值 600，所以每步都被再压一遍）。
 *   现在：压过的打标记永不再碰，且攒够 COMPACT_BATCH 条才一起压。
 *
 *   角色和 tool_call_id 必须保持原样，否则接口会报「tool 结果对不上调用」。
 */
const COMPACT_MIN = 600;
const COMPACT_HEAD = 500;
const COMPACT_TAIL = 200;

/**
 * 压缩标记。**幂等与缓存都靠它**：
 *   带这个标记的结果说明已经压过，绝不再动第二遍。
 * 用带数字的中文句式当标记（而不是一个字母），是因为真实工具结果不会长这样——
 * 拿它当判据不会误伤；同时模型读起来也自然。
 */
const COMPACT_RE = /（中间省略 \d+ 字符，已压缩）/;

/**
 * 攒够几条待压的再一起压（离散事件，而不是每步压一条）。
 *
 * ★ 为什么 ★
 *   DeepSeek 的前缀缓存要求**前缀逐字节一致**。旧实现每步都把「新增的那一条」
 *   就地压掉，而它位置很靠前 → 该位置之后的整个前缀当场失效，
 *   于是 8 步的轮次里缓存被逐步骤毁掉。改成攒批：批与批之间前缀保持稳定，
 *   压缩只发生在离散的几次上（DSH 的 dsh-compaction 就是这个姿势）。
 */
const COMPACT_BATCH = 4;

export function trimHistory(messages: ChatMessage[], keep: number): void {
  const idx: number[] = [];
  for (let i = 0; i < messages.length; i++) if (messages[i].role === 'tool') idx.push(i);
  const old = idx.slice(0, Math.max(0, idx.length - keep));

  const pending: number[] = [];
  for (const i of old) {
    const m = messages[i];
    // ★ 幂等第一关：压过的绝不再碰 ★
    if (COMPACT_RE.test(m.content)) continue;
    if (m.content.length <= COMPACT_MIN) continue;
    pending.push(i);
  }
  if (pending.length < COMPACT_BATCH) return; // 还没攒够，这一步不破坏前缀

  for (const i of pending) {
    const m = messages[i];
    const omitted = m.content.length - COMPACT_HEAD - COMPACT_TAIL;
    m.content =
      `${m.content.slice(0, COMPACT_HEAD)}\n…（中间省略 ${omitted} 字符，已压缩）…\n` +
      `${m.content.slice(-COMPACT_TAIL)}\n（需要细节：用更窄的参数重新查询，或用 run_code 读原始文件；不要原样重复上一次调用）`;
  }
}

/** 工具流水摘要：`search、run_code×6、read_doc×2`。给兜底文本用。 */
function toolDigest(steps: RunStep[]): string {
  const tools = steps.filter((s) => s.kind === 'tool');
  if (!tools.length) return '还没开始查任何东西';
  const counts = new Map<string, number>();
  for (const t of tools) counts.set(t.label, (counts.get(t.label) ?? 0) + 1);
  return [...counts].map(([name, n]) => (n > 1 ? `${name}×${n}` : name)).join('、');
}

const STOP_NOTE: Record<StopReason, string> = {
  answer: '',
  max_steps: '这轮我跑到了步数上限，还没把结论收口',
  budget: '这轮的 token 预算用完了，我还没收口',
  repeat: '我卡在重复调用同一个工具上，自己停下来了',
  aborted: '这一轮被中断了',
  error: '这一轮出错了',
  empty_reply: '我这次没能组织出回答——模型返回了空内容',
};

/**
 * 空答案兜底（2026-09-23 加）。
 *
 * ★ 为什么必须有 ★
 *   停止原因不是「正常作答」时，answer 为空——此前路由原样把空字符串发给前端，
 *   她看到的是一个空气泡，体感就是「卡死了」。实测已发生 4 次
 *   （昨晚 03:04 的误标 + 今天三轮 max_steps）。
 *   这里按停止原因合成一句人话：干了什么、停在哪、要不要继续。**answer 永不为空。**
 */
export function fallbackText(stop: StopReason, steps: RunStep[], error?: string): string {
  if (stop === 'answer') return '';
  const lastTool = [...steps].reverse().find((s) => s.kind === 'tool');
  const where = lastTool ? `，最后一步在调 ${lastTool.label}${lastTool.failed ? '（失败了）' : ''}` : '';
  const did = `已经查过：${toolDigest(steps)}${where}。`;
  const ask = stop === 'max_steps' || stop === 'budget' ? '你说一句「继续」，我就接着往下做。' : '';
  const why = stop === 'error' && error ? `——${clip(error, 160)}` : '';
  return `（${STOP_NOTE[stop]}${why}。）${did}${ask}`;
}

/** 解析模型给的工具入参。模型写非法 JSON 是常态，不能让它把整个任务搞崩。 */
function parseArgs(raw: string): { ok: true; value: Record<string, unknown> } | { ok: false; why: string } {
  if (!raw || !raw.trim()) return { ok: true, value: {} };
  try {
    const v = JSON.parse(raw);
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      return { ok: false, why: '参数必须是一个 JSON 对象' };
    }
    return { ok: true, value: v as Record<string, unknown> };
  } catch {
    // 常见：外层写了单引号、多了一个尾随逗号、或者包在 ```json 里
    const trimmed = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    try {
      const v = JSON.parse(trimmed);
      if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
        return { ok: true, value: v as Record<string, unknown> };
      }
    } catch {
      /* 落到下面统一报错 */
    }
    return { ok: false, why: `参数不是合法 JSON：${clip(raw, 120)}` };
  }
}

/**
 * 跑一个最小的 ReAct 循环。
 *
 * 流程：模型 →（要调工具？执行并把结果拼回消息 → 回到模型）：（给文本？结束）
 */
export async function runAgent(opts: RunOptions): Promise<RunResult> {
  const maxSteps = opts.maxSteps ?? DEFAULTS.maxSteps;
  const budget = opts.tokenBudget ?? DEFAULTS.tokenBudget;
  const byName = new Map(opts.tools.map((t) => [t.spec.function.name, t]));
  const specs = opts.tools.map((t) => t.spec);

  const messages: ChatMessage[] = [{ role: 'system', content: opts.system }];
  if (opts.context) {
    messages.push({
      role: 'user',
      content: `以下是这次任务的已知上下文，不用再查：\n\n${opts.context}`,
    });
    messages.push({ role: 'assistant', content: '好的，我记下了。' });
  }
  messages.push({ role: 'user', content: opts.task });

  const steps: RunStep[] = [];
  const usage = newUsageAccumulator();
  /** 最后一次模型调用报出来的 prompt 规模，用于 contextPressure.pressureTokens */
  let lastPromptTokens = 0;
  const t0 = Date.now();
  // 重复调用检测：name + 规范化的入参
  const seenCalls = new Set<string>();
  const failStreak = new Map<string, number>();
  let warned = false;

  const push = async (s: RunStep): Promise<void> => {
    steps.push(s);
    await opts.onStep?.(s);
  };

  let answer = '';
  let stop: StopReason = 'answer';
  let error: string | undefined;

  for (let step = 1; step <= maxSteps; step++) {
    if (opts.signal?.aborted) {
      stop = 'aborted';
      break;
    }

    // 每轮开始前压一次历史。放在这里而不是每步之后，保证模型看到的
    // 「最近 keep 条」始终是它刚拿到的那几条。
    trimHistory(messages, DEFAULTS.keepFullResults);

    // ★ 预算警戒线 ★
    //   实测第一次跑就是撞上预算才停的，那时 draft 好的卡一张都没提交——
    //   钱花了、产出为零。所以剩 30% 时硬塞一条提醒，让它先把成果落袋。
    //   （文案必须与任务无关：这里是通用 runtime，别再写死 submit_cards。）
    const spentNow = usage.promptTokens + usage.completionTokens;
    if (spentNow >= budget * 0.7 && !warned) {
      warned = true;
      messages.push({
        role: 'user',
        content:
          `注意：本次任务的 token 预算已用掉 ${Math.round((spentNow / budget) * 100)}%。` +
          '请立即停止探索，不要再读新内容、不要再开新调查，' +
          '把已经拿到的结论整理成最终回答输出。没查完的部分在回答里说明即可。',
      });
      await push({ at: new Date().toISOString(), kind: 'stop', label: '预算警戒：提醒模型收口', ms: 0 });
    }

    // ★ 步数警戒（2026-09-24 中断事故）★
    //   只有 token 警戒没有步数警戒：实测连环两轮 20 步用满（stop=max_steps），
    //   模型到最后一刻还在调工具。剩 2 步时文字提醒；最后一步直接摘掉工具——
    //   物理上只能输出文本，stop 必然是 answer 而不是 max_steps。
    if (step === maxSteps - 1) {
      messages.push({
        role: 'user',
        content: '注意：下一轮是最后一步。不要再调用任何工具，直接把你目前的结论整理成最终回答输出；没完成的部分如实说明。',
      });
      await push({ at: new Date().toISOString(), kind: 'stop', label: '步数警戒：最后一步，只许收口', ms: 0 });
    }

    let res: Awaited<ReturnType<typeof chatWithTools>>;
    const msStart = Date.now();
    try {
      // 最后一步摘掉工具：物理强制收口（见上方步数警戒注释）
      res = await chatWithTools(messages, step === maxSteps ? [] : specs, {
        temperature: 0.2,
        maxTokens: opts.maxTokens ?? 4000,
        timeoutMs: opts.stepTimeoutMs ?? DEFAULTS.stepTimeoutMs,
        signal: opts.signal,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      usage.calls++;
      await push({ at: new Date().toISOString(), kind: 'error', label: '模型调用失败', detail: clip(msg), ms: Date.now() - msStart });
      stop = 'error';
      error = msg;
      break;
    }

    usage.calls++;
    // ★ 用量一律走 tokenMeter.addUsage ★
    //   它会做「互斥」换算（DeepSeek 的 prompt_tokens 含缓存命中，必须先减掉），
    //   并且只在字段真的出现时才累加——别在这里手写 += ，那是算重计费的来源。
    addUsage(usage, res.usage);
    lastPromptTokens = res.usage?.promptTokens ?? lastPromptTokens;

    // 模型要求调工具：必须把 assistant 这条带 tool_calls 的消息原样存回去，
    // 否则下一轮它不知道自己刚才干了什么，会陷入死循环。
    messages.push({
      role: 'assistant',
      content: res.content || '',
      ...(res.toolCalls.length ? { tool_calls: res.toolCalls } : {}),
    });

    if (res.toolCalls.length === 0) {
      const text = res.content.trim();
      if (text) {
        answer = text;
        await push({
          at: new Date().toISOString(),
          kind: 'model',
          label: '模型给出结论',
          detail: clip(res.content, 200),
          ms: Date.now() - msStart,
        });
        stop = 'answer';
      } else {
        // ★ 空回复：模型既没要工具、也没给内容（模型抽风/被截断）。
        //   以前这里会 fall through 到末尾的兜底判断、被误标成「跑满 N 步」，
        //   复盘时完全看不出真因。现在单独立一个停止原因。
        await push({
          at: new Date().toISOString(),
          kind: 'error',
          label: '模型返回空内容',
          detail: '既没有工具调用也没有文本',
          ms: Date.now() - msStart,
          failed: true,
        });
        stop = 'empty_reply';
        error = '模型返回空内容';
      }
      break;
    }

    await push({
      at: new Date().toISOString(),
      kind: 'model',
      label: `要求调用 ${res.toolCalls.map((c) => c.function.name).join('、')}`,
      detail: clip(res.content, 120) || undefined,
      ms: Date.now() - msStart,
    });

    for (const call of res.toolCalls) {
      usage.toolCalls++;
      const name = call.function.name;
      const tool = byName.get(name);
      const argStr = call.function.arguments;

      if (!tool) {
        // 模型幻觉出一个不存在的工具。把可用列表回给它，它通常下轮就改对了。
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          name: 'unknown',
          content: `没有叫「${name}」的工具。可用的有：${opts.tools.map((t) => t.spec.function.name).join('、')}。请改用其中一个。`,
        });
        await push({ at: new Date().toISOString(), kind: 'error', label: `工具不存在：${name}`, ms: 0, failed: true });
        continue;
      }

      // ── 重复调用检测 ──
      const key = `${name}|${argStr.replace(/\s+/g, '')}`;
      if (seenCalls.has(key)) {
        await push({
          at: new Date().toISOString(),
          kind: 'stop',
          label: `重复调用 ${name}（参数相同）`,
          detail: '判定为卡住，停止',
          ms: 0,
        });
        stop = 'repeat';
        break;
      }
      seenCalls.add(key);

      const parsed = parseArgs(argStr);
      if (!parsed.ok) {
        failStreak.set(name, (failStreak.get(name) ?? 0) + 1);
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          name,
          content: `${parsed.why}。请重新调用 ${name}，参数写成合法 JSON 对象。`,
        });
        await push({ at: new Date().toISOString(), kind: 'error', label: `${name} 参数解析失败`, detail: parsed.why, ms: 0, failed: true });
        continue;
      }

      const tStart = Date.now();
      let text: string;
      let data: unknown;
      let failed = false;
      try {
        const out = await tool.run(parsed.value, { requestApproval: opts.onApprovalRequest });
        text = out.text;
        data = out.data;
        failed = out.failed === true;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        failed = true;
        text = `调用 ${name} 出错：${msg}。可以换个参数再试，或者改用别的工具。`;
      }

      // 溢出/压缩策略层：大结果在这里被替换成「预览+落盘路径」（spillIfLarge）。
      // 变换失败退回原文——省 token 的策略不能反过来炸掉主流程。
      if (opts.transformToolResult) {
        try {
          text = await opts.transformToolResult(name, text);
        } catch {
          /* 保持原 text */
        }
      }
      const tms = Date.now() - tStart;

      if (failed) failStreak.set(name, (failStreak.get(name) ?? 0) + 1);
      else failStreak.set(name, 0);

      messages.push({ role: 'tool', tool_call_id: call.id, name, content: text });
      await push({
        at: new Date().toISOString(),
        kind: 'tool',
        label: name,
        input: clip(argStr, 200),
        output: clip(text, 400),
        ms: tms,
        failed,
      });
      void data; // data 留给上层通过 onStep 收集，不进上下文

      // 同一工具连着失败 3 次：多半是它不会用，别再耗下去
      if ((failStreak.get(name) ?? 0) >= 3) {
        await push({
          at: new Date().toISOString(),
          kind: 'stop',
          label: `${name} 连续失败 3 次`,
          detail: '停止，避免继续空转',
          ms: 0,
        });
        stop = 'error';
        error = `${name} 连续失败 3 次`;
        break;
      }
    }

    if (stop !== 'answer') break;

    const spent = usage.promptTokens + usage.completionTokens;
    if (spent >= budget) {
      await push({
        at: new Date().toISOString(),
        kind: 'stop',
        label: 'token 预算用尽',
        detail: `已用 ${spent} / 上限 ${budget}`,
        ms: 0,
      });
      stop = 'budget';
      break;
    }
  }

  // 循环跑满 maxSteps 还没结论：for 正常结束（而非 break）时 stop 仍是初始值，
  // 这里补判一次。有 answer 就说明是正常给出结论后 break 出来的。
  if (stop === 'answer' && !answer) {
    stop = 'max_steps';
    error = `跑满 ${maxSteps} 步也没给出结论`;
  }

  // ★ 空答案兜底（见 fallbackText 注释）：任何非正常停止都要给她一句能看的话，
  //   而不是让前端渲染一个空气泡。
  if (!answer) answer = fallbackText(stop, steps, error);

  usage.ms = Date.now() - t0;

  // 上下文构成（估算）：回答「钱花在哪一段」。system 与 tools 是每轮重发的固定成本，
  // messages 才是随步数增长的那部分——三者分开看才知道该压哪一段。
  const breakdown = estimateBreakdown({
    system: opts.system,
    tools: JSON.stringify(specs),
    messages: JSON.stringify(messages),
  });

  return {
    answer,
    steps,
    stop,
    error,
    usage,
    contextPressure: {
      pressureTokens: lastPromptTokens,
      projectedTokens: breakdown.systemTokens + breakdown.toolsTokens + breakdown.messageTokens,
      breakdown,
    },
  };
}
