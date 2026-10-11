/**
 * server/services/nudges.ts —— 小笔的「主动开口」通道（C，2026-09-22）。
 *
 * ★ 它是什么 ★
 *   纯计算、零模型调用：从 learning.json + M3 会话里算出**至多一条**
 *   此刻最值得说的话。她打开应用时 GET /agent/nudge，有就冒一句，没有就安静。
 *
 * ★ 判据来源（探针 scripts/nudge-probe.ts，2026-09-22）★
 *   - ▽ 标注**不是**卡壳信号：▽ 是她对条目质量的反馈（探针 35/97 全命中，
 *     毫无区分度）——当初差点把它当判据，被探针拦下。
 *   - 复习到期信号失效（43 卡 41 due = 她不用复习功能），砍掉。
 *   - 真信号按优先级：
 *       1. 断点续读（≥2 天没会话）：欢迎回来 + 上次停在哪
 *       2. 卡壳概念（批注≥2 但 0 卡）：有想法没落成卡——最像「想说的话」
 *   宁可没话说，不可变成骚扰通知。
 *
 * ★ 防骚扰三件套 ★
 *   1. 一次只出 1 条；
 *   2. history（ADD-only）记录出过的话，同类同对象 7 天冷却；
 *   3. 只建议、不代写：nudge 的 question 是给她的预填话头，说不说由她。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR_NAME, requireVaultRoot } from '../core';
import { loadLearning } from './learning';
import { listSessions } from './agentMemory';

const COOLDOWN_MS = 7 * 86_400_000;

export interface Nudge {
  kind: 'resume' | 'stuck';
  /** 点击「继续聊」直接发出的预填问题 */
  question: string;
  /** 气泡里那句话 */
  text: string;
  /** 去重键（history 用） */
  dedupKey: string;
}

interface HistoryItem {
  dedupKey: string;
  at: string;
}

const historyPath = async (): Promise<string> =>
  path.join(await requireVaultRoot(), DATA_DIR_NAME, 'nudges-history.json');

/** history 读不到就当空（首次运行），写失败不挡主流程。 */
async function loadHistory(): Promise<HistoryItem[]> {
  try {
    const raw = await fs.readFile(await historyPath(), 'utf8');
    const parsed = JSON.parse(raw) as { items?: HistoryItem[] };
    return Array.isArray(parsed.items) ? parsed.items : [];
  } catch {
    return [];
  }
}

async function recordHistory(dedupKey: string): Promise<void> {
  try {
    const p = await historyPath();
    const items = (await loadHistory()).filter((h) => Date.now() - new Date(h.at).getTime() < COOLDOWN_MS);
    items.push({ dedupKey, at: new Date().toISOString() });
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, JSON.stringify({ items }, null, 2), 'utf8');
  } catch {
    /* history 写失败 = 重复风险，好过整个 nudge 通道挂掉 */
  }
}

const fresh = (items: HistoryItem[]): Set<string> => {
  const now = Date.now();
  return new Set(items.filter((h) => now - new Date(h.at).getTime() < COOLDOWN_MS).map((h) => h.dedupKey));
};

/**
 * 算出至多一条主动提示。优先级：断点续读 > 卡壳概念。
 * shown = 出过即记（GET 有副作用，但她侧语义是「说过了」——重复开口比少开口更伤）。
 */
export async function computeNudge(): Promise<Nudge | null> {
  const history = fresh(await loadHistory());

  // 1) 断点续读：≥2 天没有任何会话
  const sessions = await listSessions(10).catch(() => []);
  const lastAt = sessions[0]?.at ?? null;
  const gapDays = lastAt ? Math.floor((Date.now() - new Date(lastAt).getTime()) / 86_400_000) : null;
  if (gapDays != null && gapDays >= 2) {
    // ref 是按任务类型异构的 Record，chat/answer_note 里 doc 是字符串
    const lastDocRaw = sessions.find((s) => typeof s.ref?.doc === 'string')?.ref?.doc;
    const lastDoc = typeof lastDocRaw === 'string' ? lastDocRaw : null;
    const key = 'resume';
    if (!history.has(key)) {
      await recordHistory(key);
      return {
        kind: 'resume',
        dedupKey: key,
        text: `你 ${gapDays} 天没来了${lastDoc ? `，上次停在「${lastDoc.split('/').pop()}」` : ''}。回来接着学？`,
        question: lastDoc
          ? `我上次在「${lastDoc.split('/').pop()}」停下了，带我接着上次继续，先帮我把上次的进度和接下来该做什么讲清楚。`
          : '帮我规划一下今天的学习，从我停下的地方继续。',
      };
    }
  }

  // 2) 卡壳概念：批注≥2 但 0 卡，取最近碰过的第一条（7 天内说过的跳过）
  const store = await loadLearning();
  const stuck = store.entries
    .filter((e) => e.state.noteCount >= 2 && e.state.cardStats.total === 0)
    .sort((a, b) => (b.state.lastTouchedAt ?? '').localeCompare(a.state.lastTouchedAt ?? ''));
  for (const e of stuck) {
    const key = `stuck:${e.key}`;
    if (history.has(key)) continue;
    await recordHistory(key);
    return {
      kind: 'stuck',
      dedupKey: key,
      text: `你在「${e.name}」上写了 ${e.state.noteCount} 条批注，但一直没落成卡片。这些想法想不想变成要记的东西？`,
      question: `我在「${e.name}」上写了几条批注但一直没落成卡，帮我看看这些想法里哪些值得做成闪卡、该怎么出。`,
    };
  }

  return null;
}
