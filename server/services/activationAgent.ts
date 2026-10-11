/**
 * server/services/activationAgent.ts —— 任务 B「记忆激活」的工具集 + 编排。
 *
 * ★ 为什么工具分成「确定性」和「调模型」两类，且尽量让前者多干 ★
 *   沿用 conflict.ts 里已经验证过的路子：机械信号先把范围收窄，
 *   模型只负责它擅长的判断。这里具体是——
 *     - 概念有没有被覆盖 → get_coverage 纯查 sidecar，零模型调用
 *     - 卡片合不合格 → validate_card 跑六条判据，零模型调用
 *   模型只做两件事：决定接下来读哪篇、把概念写成卡。
 *   这样一次激活的成本几乎全部花在「生成」上，不会浪费在「反复确认已知信息」上。
 *
 * ★ 为什么 draft_cards 内部就跑一次判据并把结果一起返回 ★
 *   如果拆成「生成 → 再调一次校验」，模型多半会忘了校验直接提交。
 *   合成一步后，模型看到的是「卡 + 判据结论」，不合格它会自己重写——
 *   这个「自我修正」正是 agent 区别于一次性流水线的关键行为。
 */

import { analyzeDocument } from '../../shared/blocks';
import { makeId, type Block } from '../../shared/text';
import { chatJson } from './aiClient';
import { runAgent, type Tool, type ToolOutcome } from './agentRuntime';
import {
  cardFingerprint,
  checksRecord,
  updateSession,
  tidyQuote,
  validateCard,
  type ActivationSession,
  type DraftCard,
} from './activation';
import { readGraph } from './graph';
import { listAllSidecars } from './sidecar';
import { readDoc } from '../vault';
import { search } from './vectorstore';

/** 一次激活最多提交多少张卡。没有它，27 篇零卡的文档会让 agent 吐出几百张。 */
const MAX_CARDS = 12;
/** draft_cards 单次最多出几张 */
const MAX_PER_DRAFT = 3;
/**
 * 给模型看的原文片段长度上限。
 *
 * ★ 2500 这个数是被真实成本逼出来的 ★
 *   第一版给 6000：agent 读了 9 篇文档后累计 **16.7 万 prompt token** 直接撞破预算，
 *   一张卡都没来得及提交。原因不是单篇多贵，而是这些正文会一直留在上下文里
 *   被每一轮请求重复发送。2500 字足够提炼一节的概念，多给的部分纯属浪费。
 */
const CONTEXT_CHARS = 1200;
/** 单篇最多给模型看多少字（长文档会被截断，避免撑爆上下文） */
const DOC_CHARS = 2500;
/** 一次激活最多读几篇。超过就提醒它收手——11 篇全读完既没必要也付不起。 */
const MAX_READS = 5;

// ───────────────────────── 文档读取缓存 ─────────────────────────

/**
 * 一次激活里同一篇文档会被反复读（validate 要 blocks、draft 要原文片段）。
 * 每读一次都要 analyzeDocument（对长文档不便宜），所以按 docRel 缓存。
 */
class DocCache {
  private blocks = new Map<string, Block[]>();
  private markdown = new Map<string, string>();

  async blocksOf(docRel: string): Promise<Block[]> {
    const hit = this.blocks.get(docRel);
    if (hit) return hit;
    const md = await this.markdownOf(docRel);
    const b = analyzeDocument(md).blocks;
    this.blocks.set(docRel, b);
    return b;
  }

  async markdownOf(docRel: string): Promise<string> {
    const hit = this.markdown.get(docRel);
    if (hit !== undefined) return hit;
    let md = '';
    try {
      md = (await readDoc(docRel)).markdown;
    } catch {
      md = '';
    }
    this.markdown.set(docRel, md);
    return md;
  }

  /** 取某个位置附近的原文，给模型当生成依据。 */
  async excerpt(docRel: string, startBi: number, chars = CONTEXT_CHARS): Promise<string> {
    const blocks = await this.blocksOf(docRel);
    if (!blocks.length) return '';
    const from = Math.max(0, Math.min(startBi, blocks.length - 1));
    const out: string[] = [];
    let n = 0;
    for (let i = from; i < blocks.length && n < chars; i++) {
      const t = (blocks[i].text ?? '').trim();
      if (!t) continue;
      out.push(t);
      n += t.length;
    }
    return out.join('\n');
  }
}

// ───────────────────────── 工具 ─────────────────────────

export interface ActivationToolDeps {
  sessionId: string;
  cache: DocCache;
  /** 已被 submit 接受的卡数，用于卡死 MAX_CARDS */
  submitted: { n: number };
  /** 已读过的文档数，超过 MAX_READS 就劝它别再读了 */
  reads: { n: number };
}

function ok(text: string, data?: unknown): ToolOutcome {
  return { text, data };
}

function fail(text: string): ToolOutcome {
  return { text, failed: true };
}

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function asNumber(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clip(s: string, n: number): string {
  const t = (s ?? '').trim();
  return t.length > n ? `${t.slice(0, n)}…（已截断）` : t;
}

/** 主题团成员清单。团的边界是 Louvain 算的，不依赖模型猜。 */
function toolListCommunity(): Tool {
  return {
    spec: {
      type: 'function',
      function: {
        name: 'list_community_docs',
        description:
          '列出指定主题团包含哪些文档。当你需要知道「这次要覆盖哪些笔记」时用它。' +
          '如果你已经拿到了文档列表，就不要重复调用。',
        parameters: {
          type: 'object',
          properties: {
            communityId: { type: 'integer', description: '主题团编号，从 0 开始' },
          },
          required: ['communityId'],
        },
      },
    },
    async run(input) {
      const id = asNumber(input.communityId, -1);
      const shot = await readGraph({});
      const g = shot.graph;
      if (!g) return fail('知识地图还没建好，请先打开一次知识地图或稍后重试。');
      if (id < 0 || id >= g.communities.length) {
        return fail(`主题团编号 ${id} 不存在，当前有 ${g.communities.length} 个团（编号 0 到 ${g.communities.length - 1}）。`);
      }
      const c = g.communities[id];
      const lines = c.members.map((idx) => {
        const n = g.nodes[idx];
        return n ? `${n.rel}（${n.chars} 字，团内连接 ${n.degree} 条）` : `#${idx}`;
      });
      // 顺手把团内最强的几条共享短语给出来，帮模型判断这个团在讲什么
      const ev = g.edges
        .filter((e) => c.members.includes(e.a) && c.members.includes(e.b))
        .flatMap((e) => e.evidence)
        .slice(0, 8);
      return ok(
        [
          `主题团 ${id} 共 ${c.members.length} 篇：`,
          ...lines.map((l) => `  - ${l}`),
          ev.length ? `\n团内常见说法：${ev.join('、')}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
        { docRels: c.members.map((i) => g.nodes[i]?.rel).filter(Boolean) },
      );
    },
  };
}

/** 检索。用于「这个团是不是还漏了相关文档」的边界探索。 */
function toolSearch(): Tool {
  return {
    spec: {
      type: 'function',
      function: {
        name: 'search_notes',
        description:
          '在笔记库里检索与某个说法相关的片段。用于确认主题团的边界：' +
          '如果检索到的文档不在团里，说明这个主题还涉及别的笔记。' +
          '每次换一个更有针对性的词去搜，比重复搜同一个词有用。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '检索词，用笔记里可能出现的原话效果最好' },
            topK: { type: 'integer', description: '返回几条，默认 6，最多 10' },
          },
          required: ['query'],
        },
      },
    },
    async run(input) {
      const q = asString(input.query).trim();
      if (!q) return fail('query 不能为空。');
      const k = Math.max(1, Math.min(10, asNumber(input.topK, 6)));
      const r = await search(q, k);
      if (!r.hits.length) return ok(`没有检索到与「${q}」相关的内容。可以换个更口语或更书面的说法再试。`);
      const lines = r.hits.map(
        (h, i) =>
          `  ${i + 1}. [${h.docTitle}] ${h.headingText}\n     ${clip(h.snippet || h.text, 160)}`,
      );
      return ok(`检索「${q}」命中 ${r.hits.length} 条：\n${lines.join('\n')}`, { hits: r.hits });
    },
  };
}

/** 读原文。返回的是纯文本，长文档会被截断。 */
function toolReadDoc(deps: ActivationToolDeps): Tool {
  return {
    spec: {
      type: 'function',
      function: {
        name: 'read_doc',
        description:
          '读取一篇笔记的正文，用来提炼概念。长文只会给你开头部分；' +
          '如果需要的概念在后面，配合 startBi 直接定位到某一段附近。',
        parameters: {
          type: 'object',
          properties: {
            docRel: { type: 'string', description: '文档相对路径，例如 知识库/AI-Agent-Book/chapter5.md' },
            startBi: { type: 'integer', description: '从第几个块开始读，默认 0' },
          },
          required: ['docRel'],
        },
      },
    },
    async run(input) {
      const rel = asString(input.docRel).trim();
      if (!rel) return fail('docRel 不能为空。');
      deps.reads.n++;
      // 读太多篇既没必要也付不起——每读一篇，这篇正文就会留在上下文里被每轮重发
      if (deps.reads.n > MAX_READS) {
        return ok(
          `已经读过 ${MAX_READS} 篇了，别再读新的。请基于已有内容提炼概念，` +
            '接下来应该调用 get_coverage 或直接 draft_cards。',
        );
      }
      const md = await deps.cache.markdownOf(rel);
      if (!md) return fail(`读不到「${rel}」。路径可能写错了，先用 list_community_docs 或 search_notes 确认。`);
      const startBi = Math.max(0, asNumber(input.startBi, 0));
      let text = md;
      if (startBi > 0) {
        const blocks = await deps.cache.blocksOf(rel);
        text = blocks.slice(startBi).map((b) => b.text ?? '').join('\n');
      }
      return ok(`《${rel}》正文（最长 ${DOC_CHARS} 字）：\n${clip(text, DOC_CHARS)}`);
    },
  };
}

/** 覆盖检查：这个概念我到底有没有记过。零模型调用。 */
function toolCoverage(): Tool {
  return {
    spec: {
      type: 'function',
      function: {
        name: 'get_coverage',
        description:
          '检查一批概念在库里是否已经有卡片、批注或小抄覆盖。' +
          '返回未覆盖的概念——这些才是真正需要补卡的知识缺口。' +
          '一次可以传多个概念，不要一个个单独查。',
        parameters: {
          type: 'object',
          properties: {
            concepts: {
              type: 'array',
              items: { type: 'string' },
              description: '要检查的概念名，3 到 10 个最合适',
            },
          },
          required: ['concepts'],
        },
      },
    },
    async run(input) {
      const raw = input.concepts;
      const names = (Array.isArray(raw) ? raw : [raw])
        .map((x) => asString(x).trim())
        .filter(Boolean)
        .slice(0, 20);
      if (!names.length) return fail('concepts 至少要给一个概念名。');

      // 全库扫一遍已有的卡/批注/小抄，构建「已被记下来的文本」池
      const all = await listAllSidecars();
      const pool: { text: string; kind: string; ref: string }[] = [];
      for (const { docRel, sidecar } of all) {
        for (const c of sidecar.cards ?? []) {
          pool.push({ text: `${c.front} ${c.back}`, kind: '卡片', ref: `${docRel}#${c.id}` });
        }
        for (const n of sidecar.notes ?? []) {
          pool.push({ text: n.body ?? '', kind: '批注', ref: `${docRel}#${n.id}` });
        }
        for (const s of sidecar.cheatsheet?.sections ?? []) {
          pool.push({ text: s.markdown ?? '', kind: '小抄', ref: `${docRel}#${s.headingId}` });
        }
      }

      const out: string[] = [];
      const gaps: string[] = [];
      for (const name of names) {
        const key = name.replace(/\s+/g, '');
        // 用最长公共子串的比例判断「是不是在讲同一个概念」：
        // bigram Jaccard 对短概念（2~4 字）区分度不够，而概念名是否字面出现最可靠
        let best = 0;
        let bestRef = '';
        let bestKind = '';
        for (const p of pool) {
          const flat = p.text.replace(/\s+/g, '');
          if (!flat.includes(key)) continue;
          const r = key.length / Math.max(1, flat.length);
          if (r > best) {
            best = r;
            bestRef = p.ref;
            bestKind = p.kind;
          }
        }
        if (best > 0) out.push(`  - ${name}：已覆盖（${bestKind} ${bestRef}）`);
        else {
          out.push(`  - ${name}：未覆盖 ← 缺口`);
          gaps.push(name);
        }
      }
      return ok(
        `库里已有 ${pool.length} 条记录（卡片/批注/小抄）。检查结果：\n${out.join('\n')}` +
          (gaps.length ? `\n\n未覆盖 ${gaps.length} 个：${gaps.join('、')}` : '\n\n这些概念都已经有记录，考虑换一批更细的概念。'),
        { gaps },
      );
    },
  };
}

interface DraftItem extends DraftCard {
  docRel: string;
  headingId: string;
  startBi: number;
}

/** 出卡 + 立刻自检。这两件事合成一步，模型才会真的去改不合格的卡。 */
function toolDraftCards(deps: ActivationToolDeps): Tool {
  return {
    spec: {
      type: 'function',
      function: {
        name: 'draft_cards',
        description:
          '针对一个概念生成候选闪卡，并立即用六条判据自检。' +
          '返回的每张卡都带 pass/fail 和失败原因：如果不合格，请**根据原因改一改再调一次**，' +
          '不要原样重复调用。合格后再用 submit_cards 提交。',
        parameters: {
          type: 'object',
          properties: {
            concept: { type: 'string', description: '要为哪个概念出卡' },
            docRel: { type: 'string', description: '依据哪篇文档' },
            startBi: { type: 'integer', description: '依据原文的第几个块（来自检索结果或你的定位）' },
            count: { type: 'integer', description: '出几张，1 到 3 张' },
          },
          required: ['concept', 'docRel'],
        },
      },
    },
    async run(input) {
      const concept = asString(input.concept).trim();
      const docRel = asString(input.docRel).trim();
      if (!concept) return fail('concept 不能为空。');
      if (!docRel) return fail('docRel 不能为空。');
      const count = Math.max(1, Math.min(MAX_PER_DRAFT, asNumber(input.count, 2)));
      const startBi = Math.max(0, asNumber(input.startBi, 0));

      const source = await deps.cache.excerpt(docRel, startBi);
      if (!source) return fail(`读不到「${docRel}」在块 ${startBi} 附近的原文，换个位置或换个文档。`);
      const blocks = await deps.cache.blocksOf(docRel);
      const headingId = blocks[startBi]?.headingId ?? blocks[0]?.headingId ?? '';

      const system = [
        '你是一个严格的闪卡设计者。任务：针对给定概念，依据原文写出可以长期复习的卡片。',
        '',
        '规则：',
        '1. front 是一个**完整的问题**，只问一件事，不要出现「和」「以及」这类并列。',
        '2. back 是**自足的答案**：脱离原文也能看懂，不要写「见上文」「如上所述」。',
        '3. 答案必须**完全来自原文**，不允许补充原文没说的知识。',
        '4. quote 必须是原文里**逐字出现**的一句话（10~60 字），用来跳回原文。不要改写，不要拼接。',
        '5. 不要出「某某是什么」这种空泛题，要出复述后能验证对错的题。',
        '',
        `输出 JSON：{"cards":[{"front":"","back":"","quote":"","startBi":0}]}，最多 ${count} 张。`,
      ].join('\n');

      let items: DraftItem[] = [];
      try {
        const r = await chatJson<{ cards?: DraftCard[] }>(
          [
            { role: 'system', content: system },
            {
              role: 'user',
              content: `概念：${concept}\n\n原文（出自 ${docRel}）：\n---\n${source}\n---\n\n请出 ${count} 张卡。`,
            },
          ],
          {
            label: 'draft_cards',
            temperature: 0.4,
            maxTokens: 2000,
            validate: (v) => {
              const cards = (v as { cards?: unknown })?.cards;
              if (!Array.isArray(cards) || !cards.length) return 'cards 必须是非空数组';
              for (const c of cards) {
                const cc = c as Record<string, unknown>;
                if (typeof cc.front !== 'string' || !cc.front.trim()) return '每张卡都要有 front';
                if (typeof cc.back !== 'string' || !cc.back.trim()) return '每张卡都要有 back';
                if (typeof cc.quote !== 'string' || !cc.quote.trim()) return '每张卡都要有 quote';
              }
              return null;
            },
          },
        );
        items = (r.cards ?? []).slice(0, count).map((c) => ({
          front: c.front.trim(),
          back: c.back.trim(),
          quote: c.quote.trim(),
          docRel,
          headingId,
          startBi,
        }));
      } catch (e) {
        return fail(`生成卡片失败：${e instanceof Error ? e.message : String(e)}`);
      }
      if (!items.length) return fail('模型没有返回任何卡片。换个更具体的概念再试。');

      // 已有的卡（含本次会话已提交的）用来查重
      const { session } = await updateSession(deps.sessionId, (s) => s);
      const existing = session.candidates.map((c) => c.front);

      const lines: string[] = [];
      const results: { item: DraftItem; ok: boolean }[] = [];
      for (const [i, it] of items.entries()) {
        // 先把引文里的 markdown 痕迹洗掉，再判——否则模型会拿带 ** 的句子去定位
        it.quote = tidyQuote(it.quote, blocks);
        const j = validateCard(it, { blocks, existingFronts: existing });
        if (j.ok) existing.push(it.front); // 同一批里也算重复
        results.push({ item: it, ok: j.ok });
        const failedChecks = j.checks.filter((c) => !c.pass);
        lines.push(
          [
            `  卡 ${i + 1}：${j.ok ? '✓ 合格' : '✗ 不合格'}`,
            `    front：${it.front}`,
            `    back ：${it.back}`,
            `    quote：${clip(it.quote, 60)}`,
            ...(failedChecks.length
              ? failedChecks.map((c) => `    ! ${c.id}：${c.detail}`)
              : ['    六条判据全部通过']),
          ].join('\n'),
        );
      }

      const bad = results.filter((r) => !r.ok).length;
      return ok(
        [
          `为「${concept}」生成 ${items.length} 张，${items.length - bad} 张合格：`,
          ...lines,
          bad
            ? `\n有 ${bad} 张不合格。请根据上面的原因重写这几张（尤其是 quote 必须是原文逐字出现的句子），` +
              '然后重新调用 draft_cards。'
            : `\n全部合格。可以调用 submit_cards 提交（已提交 ${deps.submitted.n}/${MAX_CARDS}）。`,
        ].join('\n'),
        { items: results.map((r) => ({ ...r.item, ok: r.ok })) },
      );
    },
  };
}

/** 单独校验一张手写的卡。多数时候 draft_cards 已经跑过，这里是给模型改完后再查一次。 */
function toolValidateCard(deps: ActivationToolDeps): Tool {
  return {
    spec: {
      type: 'function',
      function: {
        name: 'validate_card',
        description:
          '对一张卡跑六条判据，返回逐条结果与失败原因。改完卡之后用它确认是否合格。',
        parameters: {
          type: 'object',
          properties: {
            front: { type: 'string', description: '卡片正面（问题）' },
            back: { type: 'string', description: '卡片背面（答案）' },
            quote: { type: 'string', description: '原文引文' },
            docRel: { type: 'string', description: '依据的文档路径' },
          },
          required: ['front', 'back', 'quote', 'docRel'],
        },
      },
    },
    async run(input) {
      const draft: DraftCard = {
        front: asString(input.front),
        back: asString(input.back),
        quote: asString(input.quote),
      };
      const docRel = asString(input.docRel).trim();
      if (!draft.front || !draft.back) return fail('front 和 back 都不能为空。');
      if (!docRel) return fail('docRel 不能为空。');
      const blocks = await deps.cache.blocksOf(docRel);
      if (!blocks.length) return fail(`读不到「${docRel}」，无法核对引文。`);
      draft.quote = tidyQuote(draft.quote, blocks);
      const { session } = await updateSession(deps.sessionId, (s) => s);
      const j = validateCard(draft, {
        blocks,
        existingFronts: session.candidates.map((c) => c.front),
      });
      const lines = j.checks.map(
        (c) => `    ${c.pass ? '✓' : '✗'} ${c.id}（${c.severity === 'block' ? '硬' : '软'}）：${c.detail}`,
      );
      return ok(
        `${j.ok ? '✓ 合格，可以提交' : '✗ 不合格'}：\n${lines.join('\n')}` +
          (j.blocked.length ? `\n\n硬判据未过：${j.blocked.join('、')}。必须改到全过才能提交。` : ''),
        { blocked: j.blocked, warned: j.warned },
      );
    },
  };
}

/** 唯一入库通道。没有它，前面所有工作都不会被保存。 */
function toolSubmitCards(deps: ActivationToolDeps): Tool {
  return {
    spec: {
      type: 'function',
      function: {
        name: 'submit_cards',
        description:
          '把合格的卡片提交到待确认清单。这是**唯一能让卡片被保存下来**的方式，' +
          '没有调用它就等于白做。只提交判据全过的卡。全部提交完后，' +
          '用一句普通文本总结这次发现了什么缺口、出了几张卡。',
        parameters: {
          type: 'object',
          properties: {
            cards: {
              type: 'array',
              description: '要提交的卡片',
              items: {
                type: 'object',
                properties: {
                  concept: { type: 'string', description: '这张卡对应哪个概念' },
                  front: { type: 'string' },
                  back: { type: 'string' },
                  quote: { type: 'string' },
                  docRel: { type: 'string' },
                  startBi: { type: 'integer' },
                },
                required: ['concept', 'front', 'back', 'quote', 'docRel'],
              },
            },
          },
          required: ['cards'],
        },
      },
    },
    async run(input) {
      const raw = input.cards;
      const list = Array.isArray(raw) ? raw : [raw];
      if (!list.length) return fail('cards 不能为空。');

      const room = MAX_CARDS - deps.submitted.n;
      if (room <= 0) {
        return ok(`已经提交满 ${MAX_CARDS} 张了，本次预算用尽。请直接用文本总结这次的发现。`);
      }

      const accepted: string[] = [];
      const rejected: string[] = [];
      const fingerprints = new Set<string>();

      for (const c of list) {
        const rec = c as Record<string, unknown>;
        const front = asString(rec.front).trim();
        const back = asString(rec.back).trim();
        const quote = asString(rec.quote).trim();
        const docRel = asString(rec.docRel).trim();
        const concept = asString(rec.concept).trim() || '未命名概念';
        if (!front || !back || !docRel) {
          rejected.push(`${concept}：front / back / docRel 有缺失`);
          continue;
        }
        if (deps.submitted.n + accepted.length >= MAX_CARDS) break;

        // 提交前再跑一次判据——模型可能在改写过程中把引文改坏了
        const blocks = await deps.cache.blocksOf(docRel);
        const { session: cur } = await updateSession(deps.sessionId, (s) => s);
        const cleanQuote = tidyQuote(quote, blocks);
        const j = validateCard(
          { front, back, quote: cleanQuote },
          {
            blocks,
            existingFronts: cur.candidates.map((x) => x.front),
          },
        );
        if (!j.ok) {
          rejected.push(`${concept}：${j.blocked.join('/')} 未过 —— ${j.checks.find((x) => !x.pass)?.detail ?? ''}`);
          continue;
        }
        const fp = cardFingerprint(front, back);
        if (fingerprints.has(fp)) continue;
        fingerprints.add(fp);

        const startBi = Math.max(0, asNumber(rec.startBi, 0));
        const headingId = blocks[startBi]?.headingId ?? blocks[0]?.headingId ?? '';
        await updateSession(deps.sessionId, (s: ActivationSession) => {
          s.candidates.push({
            id: makeId('cd'),
            concept,
            front,
            back,
            quote: cleanQuote,
            docRel,
            headingId,
            checks: checksRecord(j),
            blocked: j.blocked,
            warned: j.warned,
            attempts: 1,
            accepted: null,
          });
        });
        accepted.push(concept);
      }

      deps.submitted.n += accepted.length;
      return ok(
        [
          `已提交 ${accepted.length} 张：${accepted.join('、') || '（无）'}`,
          rejected.length ? `被判据挡下 ${rejected.length} 张：\n${rejected.map((r) => `  - ${r}`).join('\n')}` : '',
          `预算：已提交 ${deps.submitted.n}/${MAX_CARDS}。` +
            (deps.submitted.n >= MAX_CARDS ? '已用尽，请用文本总结。' : '还可以继续为其它概念出卡。'),
        ]
          .filter(Boolean)
          .join('\n'),
      );
    },
  };
}

export function activationTools(deps: ActivationToolDeps): Tool[] {
  return [
    toolListCommunity(),
    toolSearch(),
    toolReadDoc(deps),
    toolCoverage(),
    toolDraftCards(deps),
    toolValidateCard(deps),
    toolSubmitCards(deps),
  ];
}

// ───────────────────────── 编排 ─────────────────────────

export interface RunActivationOpts {
  sessionId: string;
  communityId: number;
  /** 已经知道的成员文档，省得模型再查一次 */
  docRels?: string[];
  signal?: AbortSignal;
  onStep?: (s: { label: string; kind: string; detail?: string; ms: number }) => void | Promise<void>;
}

const SYSTEM = [
  '你是一个个人知识库的「记忆激活」助手。用户记了很多笔记，但不知道哪些概念自己其实没真正掌握。',
  '你的任务是：在这个主题团里找出**真正重要的概念**，挑出**还没有被记下来的那些**，为它们生成可长期复习的闪卡。',
  '',
  '工作流程：',
  '1. 先用 list_community_docs 看清这个团有哪些文档；如果想知道这个主题是否还涉及团外的笔记，用 search_notes 探索。',
  `2. 读文档提炼概念（read_doc）。**最多读 ${MAX_READS} 篇**——读够提炼就停，不必读完整个团，` +
    '每多读一篇都会让后面的每句话变得更贵。概念要具体——「上下文压缩」算具体，「AI」不算。',
  '3. 用 get_coverage 一次查多个概念，找出未被覆盖的缺口。',
  `4. 对缺口里最重要的概念用 draft_cards 出卡。**最多提交 ${MAX_CARDS} 张**，所以先想清楚哪些概念最值得考。`,
  '5. 不合格的卡按失败原因改，不要原样重试。**每凑够 2~3 张合格的就立刻 submit_cards 提交**，' +
    '不要攒到最后一起交——攒着很容易因为预算用完而一张都留不下。',
  '6. 最后用一段普通文本总结：发现了哪些缺口、出了几张卡、哪些概念你判断最重要。',
  '',
  '纪律：',
  '- 引文必须是原文逐字出现的一句话。自己造句会导致判据不过，也会让卡片跳不回原文。',
  '- 不要为了凑数出空泛的卡。宁可出 5 张扎实的，也不要 12 张水的。',
  '- 同一个工具、同样的参数不要重复调用，那说明你在原地打转。',
  '- 收到预算提醒后立刻停止探索，把手上合格的卡提交掉。',
].join('\n');

export async function runActivation(opts: RunActivationOpts): Promise<{
  session: ActivationSession;
  stop: string;
  error?: string;
  usage: { promptTokens: number; completionTokens: number; calls: number; toolCalls: number; ms: number };
}> {
  const deps: ActivationToolDeps = {
    sessionId: opts.sessionId,
    cache: new DocCache(),
    submitted: { n: 0 },
    reads: { n: 0 },
  };
  const tools = activationTools(deps);

  const context = opts.docRels?.length
    ? `主题团 ${opts.communityId} 已知包含这些文档：\n${opts.docRels.map((r) => `  - ${r}`).join('\n')}`
    : undefined;

  const r = await runAgent({
    tools,
    system: SYSTEM,
    task: `请对主题团 ${opts.communityId} 做一次记忆激活：找出这个主题下最重要、但用户还没记下来的概念，并为它们出卡。`,
    context,
    maxSteps: 16,
    tokenBudget: 150_000,
    signal: opts.signal,
    onStep: opts.onStep
      ? async (s) => {
          await opts.onStep?.({ label: s.label, kind: s.kind, detail: s.detail, ms: s.ms });
        }
      : undefined,
  });

  const { session } = await updateSession(opts.sessionId, (s: ActivationSession) => {
    s.status = s.candidates.length ? 'pending_review' : 'abandoned';
    s.usage = {
      promptTokens: r.usage.promptTokens,
      completionTokens: r.usage.completionTokens,
      model: '',
      ms: r.usage.ms,
      // 四类拆分：缺就不写（「没报」≠「是 0」）
      ...(r.usage.cacheReadTokens !== undefined ? { cacheReadTokens: r.usage.cacheReadTokens } : {}),
      ...(r.usage.reasoningTokens !== undefined ? { reasoningTokens: r.usage.reasoningTokens } : {}),
    };
  });

  return { session, stop: r.stop, error: r.error, usage: r.usage };
}
