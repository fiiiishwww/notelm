/**
 * server/services/sm2.ts —— 间隔重复（SM-2 简化版）。
 *
 * 为什么用简化版而不是原版：
 *   原版 SM-2 的 quality 是 0~5 分，需要用户在一个 6 档量表上做判断，
 *   实际用起来非常啰嗦。这里把界面收敛成三档（忘了 / 有点难 / 记得），
 *   映射到 q = 1 / 3 / 5，保留了原算法「答错就重来、答对逐渐拉长间隔」的核心行为。
 *
 * ★ 重要 ★
 * 日期一律用「本地日期字符串 YYYY-MM-DD」而不是 Date 对象或 ISO 时间戳。
 * 原因是复习的「今天」应该按用户所在时区算；用 toISOString 会在晚上把日期推错一天，
 * 导致卡片要么提前一天出现、要么推迟一天。
 */

import { addDays, localDate, type Card, type Sm2State } from '../../shared/text';

/** 三档评分：映射到 SM-2 的 0~5 分制。 */
export type Grade = 'forgot' | 'hard' | 'good';

const QUALITY: Record<Grade, number> = {
  forgot: 1,
  hard: 3,
  good: 5,
};

export function newSm2State(today = localDate()): Sm2State {
  return {
    ef: 2.5,
    interval: 0,
    repetitions: 0,
    lapses: 0,
    dueAt: today,
    lastReviewedAt: null,
  };
}

/**
 * 按一次作答更新卡片状态，返回新的 Sm2State（不改原对象）。
 *
 * @param today 允许注入，方便测试与「补记昨天的复习」
 */
export function schedule(state: Sm2State, grade: Grade, today = localDate()): Sm2State {
  const q = QUALITY[grade];
  const next: Sm2State = { ...state };
  next.lastReviewedAt = today;

  if (q < 3) {
    // 忘了：连续正确次数清零，间隔打回 1 天，但 EF 保留大部分（不惩罚过狠，
    // 否则一次手滑会让这张卡在很长一段时间里都很难受）
    next.repetitions = 0;
    next.lapses = state.lapses + 1;
    next.interval = 1;
    next.ef = clampEf(state.ef - 0.2);
    next.dueAt = addDays(today, 1);
    return next;
  }

  next.repetitions = state.repetitions + 1;

  if (next.repetitions === 1) {
    next.interval = 1;
  } else if (next.repetitions === 2) {
    next.interval = 6;
  } else {
    next.interval = Math.round(state.interval * state.ef);
  }

  // "有点难" 不涨 EF，只按原间隔推进；"记得" 才涨
  const efDelta = grade === 'good' ? 0.1 : grade === 'hard' ? 0 : -0.15;
  next.ef = clampEf(state.ef + efDelta);

  // 上界保护：间隔封顶 365 天，避免 EF 累积成大得离谱的数字
  next.interval = Math.min(next.interval, 365);
  next.dueAt = addDays(today, next.interval);
  return next;
}

function clampEf(ef: number): number {
  return Math.max(1.3, Math.min(2.8, Math.round(ef * 100) / 100));
}

/** 卡片是否到期（dueAt <= today）。 */
export function isDue(card: Card, today = localDate()): boolean {
  if (card.suspended) return false;
  return card.sm2.dueAt <= today;
}

/** 待复习队列：先按到期日，再按 EF 从低到高（难的先出）。 */
export function dueQueue(cards: Card[], today = localDate()): Card[] {
  return cards
    .filter((c) => isDue(c, today))
    .sort((a, b) => {
      const d = a.sm2.dueAt.localeCompare(b.sm2.dueAt);
      return d !== 0 ? d : a.sm2.ef - b.sm2.ef;
    });
}

export interface DeckStats {
  total: number;
  due: number;
  suspended: number;
  /** 未来 7 天的到期数量，下标 0 = 今天 */
  forecast: number[];
  reviewedToday: number;
}

export function deckStats(cards: Card[], today = localDate()): DeckStats {
  const forecast = new Array<number>(7).fill(0);
  let due = 0;
  let suspended = 0;
  let reviewedToday = 0;

  for (const c of cards) {
    if (c.suspended) {
      suspended++;
      continue;
    }
    if (c.sm2.lastReviewedAt === today) reviewedToday++;
    if (c.sm2.dueAt <= today) {
      due++;
      forecast[0]++;
      continue;
    }
    for (let i = 1; i < 7; i++) {
      if (c.sm2.dueAt === addDays(today, i)) {
        forecast[i]++;
        break;
      }
    }
  }
  return { total: cards.length, due, suspended, forecast, reviewedToday };
}
