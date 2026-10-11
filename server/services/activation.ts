/**
 * server/services/activation.ts —— 「记忆激活」的会话存储 + 卡片判据。
 *
 * 为什么判据和 store 放在同一个文件：
 *   这两件事被同一套数据绑死——判据结果要写进 candidate.checks，
 *   而 candidate.accepted（人的最终判定）又反过来用于调判据。
 *   拆开会出现循环依赖，也会让「改一条判据」要同时动两个地方。
 *
 * ★ 贯穿全文件的纪律：六条判据必须全是确定性的 ★
 *   不调模型、不需要人工标注、纯字符串运算。这带来两个直接好处：
 *   1. 它们同时就是 agent 自检循环用的判据 —— 评测标准与自我修正标准是同一套代码；
 *   2. 坏卡率能被自动测量，不需要 LLM-as-judge，也不需要人先标一遍。
 *
 * ★ 为什么判据分 block / warn 两级 ★
 *   全设成硬淘汰会误杀：模型漏填引文是可修复的瑕疵，编造引文才是致命的。
 *   只有 block 级不过才淘汰，warn 级不过照常进待确认清单但打标。
 *   留着 accepted 字段记录人的最终判定，就能反推判据是漏了还是太严：
 *     机器判过、人否掉  → 判据有漏
 *     机器判不过、人勾了 → 判据太严
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  DATA_DIR_NAME,
  ensureDirSync,
  readJson,
  requireVaultRoot,
  sha256,
  writeFileAtomic,
} from '../core';
import { validateQuote } from './anchor';
import { plain, sharedSpans } from './related';
import { makeId, type Block } from '../../shared/text';

// ─────────────────────────── 判据 ───────────────────────────

export type CheckId = 'quote' | 'grounded' | 'selfContained' | 'noDuplicate' | 'atomic' | 'notCopy';

/**
 * 判据阈值。想调效果就改这里；改完必须重跑 `scripts/activation-probe.ts`，
 * 看坏卡率和「机器判过但人否掉」的比例有没有真的变好，别凭感觉改。
 */
export const THRESHOLDS = {
  /**
   * front 的 bigram 有多大比例出现在 back 里。
   *
   * ★ 0.10 这个数是实测出来的，不是拍的 ★
   *   `scripts/activation-probe.ts --selftest` 跑出来的实际分布：
   *     好卡 0.20 / 编造卡 0.20 / 照抄卡 0.27 / 双问题卡 0.32 / 完全跑题 0.00
   *   好卡和编造卡**完全重合**，说明这条在中文上几乎没有区分度——
   *   原因是中文闪卡的答案普遍省略主语（问「阈值是多少」答「12000 tokens」，
   *   不会把「阈值」再说一遍）。所以它抓不住"答非所问"，
   *   只能用来兜住「问题和答案字面毫无关系」这种极端情况（0.00）。
   *   因此阈值压到 0.10，且只能是 warn 级。
   */
  selfContained: 0.1,
  /**
   * back 的 bigram 有多大比例能在原文里找到出处。
   * 实测：好卡 0.74 / 同义改写的好卡 0.50 / 编造卡 0.32。
   * 取 0.45 把 0.50 和 0.32 分开——间距只有 0.18，是这个判据的能力上限，
   * 再往上调就会开始误杀正常的同义改写。
   */
  grounded: 0.45,
  /** 与已有卡 front 的 bigram Jaccard 超过多少算重复 */
  duplicate: 0.55,
  /**
   * back 被原文整段覆盖的比例超过多少算照抄。
   * 实测：好卡 0.48，整句照搬 1.00，中间留了很大余量，所以这条安全。
   */
  copy: 0.85,
};

export interface CheckResult {
  id: CheckId;
  pass: boolean;
  severity: 'block' | 'warn';
  /** 给人看的一句话理由，会直接显示在待确认清单上 */
  detail: string;
  /** 判据算出来的原始数值。调阈值时靠它，别拍脑袋 */
  value?: number;
}

export interface DraftCard {
  front: string;
  back: string;
  quote: string;
}

export interface ValidateCtx {
  /** 卡片依据的原文块（同一篇文档） */
  blocks: Block[];
  /** 已有卡片的正面，用于查重 */
  existingFronts?: string[];
}

export interface CardJudgement {
  /** 没有任何 block 级判据失败 */
  ok: boolean;
  blocked: CheckId[];
  warned: CheckId[];
  checks: CheckResult[];
}

/**
 * 字符级 bigram 集合。
 *
 * 为什么不分词：中文没有分词器，而 bigram 对「这两句话在讲同一件事吗」
 * 已经足够稳，也不依赖任何外部依赖。相关段落、去重里用的都是同一套思路。
 */
export function bigrams(s: string): Set<string> {
  const t = plain(s).replace(/\s+/g, '');
  const out = new Set<string>();
  for (let i = 0; i + 2 <= t.length; i++) out.add(t.slice(i, i + 2));
  return out;
}

function coverage(a: Set<string>, b: Set<string>): number {
  if (a.size === 0) return 0;
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n / a.size;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n / (a.size + b.size - n);
}

/** 列举/并列信号：一张卡问两件事就没法复习了。 */
const JOINERS = /(?:和|与|以及|或者|还是|、|；|;)/;

/** back 里出现的连续最长共享片段占 back 的比例——用来抓「整段照抄原文」。 */
function copyRatio(back: string, blocks: Block[], blockFlat: string[]): number {
  const fb = plain(back).replace(/\s+/g, '');
  if (fb.length < 8) return 0;
  // 先用一个 bigram 快速筛出候选块，避免对整篇文档逐块跑 sharedSpans
  const key = fb.slice(0, 2);
  let best = 0;
  for (let i = 0; i < blockFlat.length; i++) {
    if (!blockFlat[i].includes(key)) continue;
    if (blockFlat[i].includes(fb)) return 1;
    const spans = sharedSpans(fb, blockFlat[i], 8);
    for (const s of spans) if (s.text.length > best) best = s.text.length;
  }
  void blocks;
  return best / fb.length;
}

/**
 * 六条判据。
 *
 * 顺序是有讲究的：先查最便宜也最致命的（引文能不能定位），
 * 再查语义类的（答非所问、编造、重复），最后两条是质量提示（不原子、照抄）。
 */
export function validateCard(draft: DraftCard, ctx: ValidateCtx): CardJudgement {
  const checks: CheckResult[] = [];
  const blocks = ctx.blocks ?? [];
  const blockFlat = blocks.map((b) => plain(b.text ?? '').replace(/\s+/g, ''));
  const sourceFlat = blockFlat.join('');

  // ① 引文
  const q = (draft.quote ?? '').trim();
  if (!q) {
    checks.push({ id: 'quote', pass: false, severity: 'warn', detail: '没有引文，跳不回原文' });
  } else if (!validateQuote(q, blocks)) {
    checks.push({ id: 'quote', pass: false, severity: 'block', detail: '引文在原文里找不到，多半是编的' });
  } else {
    checks.push({ id: 'quote', pass: true, severity: 'block', detail: '引文可定位' });
  }

  const bgFront = bigrams(draft.front);
  const bgBack = bigrams(draft.back);

  // ② 答非所问：front 问的东西 back 里得出现
  //
  // ★ 为什么这条只能当 warn，不能当硬淘汰 ★
  //   中文闪卡的答案普遍省略主语——问「上下文压缩的阈值是多少」，
  //   答「12000 tokens」就够了，不会把「上下文压缩」再说一遍。
  //   实测好卡的字面覆盖率也能低到 0.14，和真跑题的 0.20 几乎分不开。
  //   字面覆盖率区分不了「省略」和「跑题」，作硬淘汰会成片误杀好卡。
  const sc = coverage(bgFront, bgBack);
  checks.push({
    id: 'selfContained',
    pass: sc >= THRESHOLDS.selfContained,
    severity: 'warn',
    value: sc,
    detail:
      sc >= THRESHOLDS.selfContained
        ? '答案对得上问题'
        : `答案没复现问题用词（只有 ${Math.round(sc * 100)}%），建议人工看一眼`,
  });

  // ③ 编造：back 里的说法得能在原文找到出处
  if (sourceFlat) {
    const g = coverage(bgBack, bigrams(sourceFlat));
    checks.push({
      id: 'grounded',
      pass: g >= THRESHOLDS.grounded,
      severity: 'block',
      value: g,
      detail:
        g >= THRESHOLDS.grounded
          ? '说法有出处'
          : `可能有编造（答案只有 ${Math.round(g * 100)}% 的字面依据在原文里）`,
    });
  } else {
    checks.push({ id: 'grounded', pass: false, severity: 'block', value: 0, detail: '没有原文可供核对' });
  }

  // ④ 重复
  let dup = 0;
  let dupWith = '';
  for (const f of ctx.existingFronts ?? []) {
    const j = jaccard(bigrams(f), bgFront);
    if (j > dup) {
      dup = j;
      dupWith = f;
    }
  }
  checks.push({
    id: 'noDuplicate',
    pass: dup < THRESHOLDS.duplicate,
    severity: 'block',
    value: dup,
    detail:
      dup < THRESHOLDS.duplicate
        ? '和已有卡片不重复'
        : `和已有卡片重复 ${Math.round(dup * 100)}%：${dupWith.slice(0, 24)}`,
  });

  // ⑤ 原子性
  const joined = JOINERS.test(draft.front);
  checks.push({
    id: 'atomic',
    pass: !joined,
    severity: 'warn',
    detail: joined ? '一句话里问了不止一件事，复习时会卡住' : '一张卡只问一件事',
  });

  // ⑥ 照抄
  const cr = copyRatio(draft.back, blocks, blockFlat);
  checks.push({
    id: 'notCopy',
    pass: cr < THRESHOLDS.copy,
    severity: 'warn',
    value: cr,
    detail:
      cr < THRESHOLDS.copy
        ? '不是原文照搬'
        : `答案 ${Math.round(cr * 100)}% 是原文原句，考不到理解`,
  });

  const blocked = checks.filter((c) => !c.pass && c.severity === 'block').map((c) => c.id);
  const warned = checks.filter((c) => !c.pass && c.severity === 'warn').map((c) => c.id);
  return { ok: blocked.length === 0, blocked, warned, checks };
}

/** 把判据结果压成 Record，存进会话（前端按 id 取用）。 */
export function checksRecord(j: CardJudgement): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const c of j.checks) out[c.id] = c.pass;
  return out;
}

// ─────────────────────────── 会话存储 ───────────────────────────

export type ActivationStatus = 'running' | 'pending_review' | 'applied' | 'abandoned';

export interface ActivationScope {
  kind: 'community';
  communityId: number;
  docRels: string[];
}

export interface ActivationConcept {
  name: string;
  /** 1~3，3 最重要。用于 Top-N 排序 */
  importance: number;
  /** 已有覆盖来源：卡片 id / 批注 id / 小抄 headingId */
  coveredBy: string[];
  gap: boolean;
  reason?: string;
}

export interface ActivationCandidate {
  id: string;
  /** 对应哪个概念（ActivationConcept.name） */
  concept: string;
  front: string;
  back: string;
  quote: string;
  docRel: string;
  headingId: string;
  /** 六条判据逐条结果 */
  checks: Record<string, boolean>;
  blocked: CheckId[];
  warned: CheckId[];
  /** 被判不过后重生成了几次 */
  attempts: number;
  /** 人的最终判定：null = 还没看 */
  accepted: boolean | null;
}

export interface ActivationStep {
  at: string;
  kind: string;
  summary: string;
  ms: number;
}

export interface ActivationSession {
  id: string;
  version: number;
  scope: ActivationScope;
  createdAt: string;
  updatedAt: string;
  status: ActivationStatus;
  concepts: ActivationConcept[];
  candidates: ActivationCandidate[];
  /** agent 每一步干了什么，出问题时靠它复盘 */
  steps: ActivationStep[];
  /**
   * 用量。2026-09-23 起带四类拆分（缓存命中/推理 token），
   * 缺失字段保持 undefined——旧会话文件照旧可读。
   */
  usage: {
    promptTokens: number;
    completionTokens: number;
    model: string;
    ms: number;
    cacheReadTokens?: number;
    reasoningTokens?: number;
  } | null;
}

const SESSION_VERSION = 1;
const ACTIVATION_DIR = 'activation';

function activationDir(root: string): string {
  return path.join(root, DATA_DIR_NAME, ACTIVATION_DIR);
}

function sessionFile(root: string, id: string): string {
  return path.join(activationDir(root), `${id}.json`);
}

export async function createSession(scope: ActivationScope): Promise<ActivationSession> {
  const root = await requireVaultRoot();
  ensureDirSync(activationDir(root));
  const now = new Date().toISOString();
  const s: ActivationSession = {
    id: makeId('ac'),
    version: SESSION_VERSION,
    scope,
    createdAt: now,
    updatedAt: now,
    status: 'running',
    concepts: [],
    candidates: [],
    steps: [],
    usage: null,
  };
  await writeFileAtomic(sessionFile(root, s.id), JSON.stringify(s, null, 2));
  return s;
}

export async function readSession(id: string): Promise<ActivationSession | null> {
  const root = await requireVaultRoot();
  const s = await readJson<ActivationSession | null>(sessionFile(root, id), null);
  if (!s || s.version !== SESSION_VERSION) return null;
  return s;
}

/** 唯一推荐的修改方式：读 → 改 → 整体写回。 */
export async function updateSession<T>(
  id: string,
  fn: (s: ActivationSession) => T,
): Promise<{ session: ActivationSession; result: T }> {
  const root = await requireVaultRoot();
  const cur = await readSession(id);
  if (!cur) throw new Error(`找不到激活会话 ${id}`);
  const result = fn(cur);
  cur.updatedAt = new Date().toISOString();
  await writeFileAtomic(sessionFile(root, id), JSON.stringify(cur, null, 2));
  return { session: cur, result };
}

export async function listSessions(): Promise<ActivationSession[]> {
  const root = await requireVaultRoot();
  const dir = activationDir(root);
  let names: string[] = [];
  try {
    names = (await fsp.readdir(dir)).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const out: ActivationSession[] = [];
  for (const n of names) {
    const s = await readJson<ActivationSession | null>(path.join(dir, n), null);
    if (s && s.version === SESSION_VERSION) out.push(s);
  }
  out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return out;
}

/** 某个主题团最近一次会话（前端「记忆激活」按钮打开时要接着上次的看）。 */
export async function latestSession(communityId: number): Promise<ActivationSession | null> {
  const all = await listSessions();
  return all.find((s) => s.scope.communityId === communityId) ?? null;
}

/**
 * 丢弃会话。
 * 不用 fs.rm：这个项目里 fs.rm 被 shim 接管了，一律 rename 进 trash。
 */
export async function dropSession(id: string): Promise<void> {
  const root = await requireVaultRoot();
  const from = sessionFile(root, id);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(root, DATA_DIR_NAME, 'trash', stamp, ACTIVATION_DIR);
  ensureDirSync(dest);
  try {
    await fsp.rename(from, path.join(dest, `${id}.json`));
  } catch {
    /* 已经不存在就算了 */
  }
}

/**
 * 把引文里的 markdown 痕迹洗掉。
 *
 * 模型倾向于从它看到的原文里连 `**` 一起抄（实测出过
 * 「在这篇论文里它最初被称为 **Iteration Batching 。**」）。
 * 这种引文能过校验、也能定位，但直接显示在卡片上很脏。
 *
 * 只在清洗后仍能定位时才替换——否则宁可保留原样，别为了好看把锚点弄坏。
 */
export function tidyQuote(quote: string, blocks: Block[]): string {
  const raw = (quote ?? '').trim();
  if (!raw) return raw;
  const clean = raw
    .replace(/\*\*|__/g, '')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean || clean === raw) return raw;
  return validateQuote(clean, blocks) ? clean : raw;
}

/** 候选卡的稳定指纹：同一张卡重生成时不该被当成两张。 */
export function cardFingerprint(front: string, back: string): string {
  return sha256(`${plain(front).replace(/\s+/g, '')}|${plain(back).replace(/\s+/g, '')}`).slice(0, 16);
}
