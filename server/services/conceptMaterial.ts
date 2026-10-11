/**
 * 概念 → 学习素材（2026-10-11 从 routes/study.ts GET /review/plan 原样抽出）。
 *
 * ★ 为什么抽 ★
 *   material（概念→树节点素材）和 quizPick（概念→那节的测验题）这两段组装逻辑
 *   原本困在 HTTP 路由里，agent 工具层用不到——这是「agent 看得到坐标摸不到内容」
 *   的根因之一。抽成共享 service 后 /review/plan 与 conceptAssets 共用一份实现。
 *
 * ★ 搬家纪律 ★
 *   逻辑与注释逐字保留，行为逐字节不变；/review/plan 改调这两个函数即验收。
 */
import type { Card, Quiz, Sidecar } from '../../shared/text';
import { conceptByKey } from './concepts';

export interface Material {
  doc: string;
  headingId: string;
  nodeName: string;
  kind: string;
  essence: string;
  details: { kind: string; text: string; quote: string }[];
}

type SidecarRef = { docRel: string; sidecar: Sidecar };

/** 填空/问答按 conceptKey 找同节的树节点：概念库里有 sources 记录它在哪几节 */
export async function materialForConcepts(
  keys: string[],
  all: SidecarRef[],
): Promise<Record<string, Material>> {
  const material: Record<string, Material> = {};
  if (!keys.length) return material;
  for (const key of keys) {
    const concept = await conceptByKey(key).catch(() => null);
    if (!concept) continue;
    for (const src of concept.sources.slice(0, 3)) {
      const { sidecar } = all.find((x) => x.docRel === src.docRel) ?? { sidecar: null };
      const sec = sidecar?.cheatsheet?.sections?.find((x) => x.headingId === src.headingId);
      const node = sec?.tree?.nodes?.find((n) => n.name === concept.name);
      if (node) {
        material[key] = {
          doc: src.docRel,
          headingId: src.headingId,
          nodeName: node.name,
          kind: node.kind,
          essence: node.essence,
          details: (node.details ?? []).map((d) => ({ kind: d.kind, text: d.text, quote: d.quote ?? '' })),
        };
        break;
      }
    }
  }
  return material;
}

/** 概念 → 卡片反查（把概念挂着的卡找出来，供复习行直接取用） */
export async function cardsForConcepts(
  keys: string[],
  all: SidecarRef[],
): Promise<Record<string, (Card & { docPath: string })[]>> {
  const out: Record<string, (Card & { docPath: string })[]> = {};
  if (!keys.length) return out;
  for (const key of keys) {
    const cards: (Card & { docPath: string })[] = [];
    for (const { docRel, sidecar } of all) {
      for (const c of sidecar.cards ?? []) {
        if (c.conceptKey === key) cards.push({ ...c, docPath: docRel });
      }
    }
    if (cards.length) out[key] = cards;
  }
  return out;
}

/**
 * ★ 测验题：概念 → 小节 → 那节的 quiz ★
 *
 *   ★ 为什么有这一段（2026-10-08 实测换掉的做法）★
 *     复习里的 blank 过去是前端 buildBlanks() 按 等式/定义/数值 三规则从树节点
 *     现场挖空出来的。实测她当天那份计划：**4 条填空 3 条界面直接显示
 *     「没有可挖空的内容」**，唯一挖得动的答案有 30 字（程序比对必判错）。
 *     根因是结构性不匹配：树节点的 details 主要是「要点/清单/例子」，
 *     三种硬规则碰都碰不到。
 *     同一批材料走测验管线（quizPrompt）出的题，6/7 小节是真问题。
 *     ⇒ 所以哪一节有题，就用题；没出题的那节才退回旧路径（前端如实说「还没出题」）。
 * ★ 每个 plan item 分一道题，按条目顺序轮询 ★
 *   ★ 为什么不交给前端自己挑 ★
 *     实测（2026-10-08）：她那份计划里有 4 条概念都落在 chapter5 的同一小节，
 *     前端各自挑零号题的话，四条会见同一道题 —— 「复习代码生成」和「复习文件系统」
 *     问的是同一句，那就不是四条，是一条。轮询保证一轮之内不重复
 *     （题不够时才回头复用），且顺序稳定：刷新页面还是同样的题。
 */
export async function quizPickForItems(
  items: { id: string; conceptKey?: string | null }[],
  all: SidecarRef[],
): Promise<Record<string, { question: Quiz['questions'][number]; total: number; from: string }>> {
  const quizPick: Record<string, { question: Quiz['questions'][number]; total: number; from: string }> = {};
  const wanted = new Set(items.map((x) => x.conceptKey).filter(Boolean) as string[]);
  if (!wanted.size) return quizPick;
  const used = new Map<string, number>();
  for (const it of items) {
    const key = it.conceptKey;
    if (!key || !wanted.has(key)) continue;
    const concept = await conceptByKey(key).catch(() => null);
    if (!concept) continue;
    // 概念可能挂在多节上：挑「有题」的那节，题都一样时挑树更大的（信息更完整）
    const cands = concept.sources
      .map((src) => {
        const allHit = all.find((x) => x.docRel === src.docRel);
        const quiz = allHit?.sidecar?.quizzes?.find((q) => q.headingId === src.headingId);
        const nodes =
          allHit?.sidecar?.cheatsheet?.sections?.find((s) => s.headingId === src.headingId)?.tree?.nodes ?? [];
        return quiz && (quiz.questions ?? []).length ? { quiz, n: nodes.length } : null;
      })
      .filter((x): x is { quiz: Quiz; n: number } => x !== null)
      .sort((a, b) => b.n - a.n);
    if (!cands.length) continue;
    const best = cands[0].quiz;
    const rounds = used.get(best.id) ?? 0;
    used.set(best.id, rounds + 1);
    quizPick[it.id] = {
      question: best.questions[rounds % best.questions.length],
      total: best.questions.length,
      from: best.headingText ?? '',
    };
  }
  return quizPick;
}
