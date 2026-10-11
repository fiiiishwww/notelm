/**
 * src/lib/cardgroups.ts —— 把闪卡按章节分组。
 *
 * ★ 为什么单独拎出来 ★
 *   分组规则里有三条不那么直观的约定，值得被单独测到：
 *     1. `headingId` 查不到对应章节 → 显示「已删除的章节」（卡片还在，章节没了）
 *     2. `headingId` 是空串（手写卡）  → 「未归类」，并且**永远排在最后**
 *     3. 其余按章节在文章里的先后顺序排
 *   放在组件文件里就只能用肉眼在界面上验，抽成纯函数可以直接跑断言。
 *
 * 这里刻意不 import 任何 React / DOM 相关的东西，保证能在 Node 里直接跑。
 */

import type { Card, StudyUnit } from '../../shared/text';

export interface CardGroup {
  /** headingId，'' 表示未归类 */
  key: string;
  title: string;
  cards: Card[];
  /** 今天到期的张数（暂停中的不算） */
  due: number;
  /** 学过的张数（repetitions > 0） */
  learned: number;
  /**
   * 所属节的考频档位（0 = 无考频，不显示）。
   *
   * ★ 为什么挂在组上而不是卡上 ★
   *   考频是「这一节在面经里被问过多少次」，是节的属性——树上的徽章也是这么挂的。
   *   挂在卡上会让同一节的 30 张卡各画一个徽章，纯噪声。
   *   复习时看到的是「这批卡对应的内容有多常被问」，那才是有用的信息。
   */
  freqLevel: number;
  /** 标注次数（tooltip 用；0 时不显示） */
  freqMarks: number;
  /** 涉及公司数（tooltip 用） */
  freqCompanies: number;
}

/** 章节被删掉之后，卡片还在，标题只能这么显示。 */
export const GONE_TITLE = '已删除的章节';
/** 手写卡的 headingId 是空串，统一落到这里。 */
export const LOOSE_TITLE = '未归类';

export function buildGroups(
  cards: Card[],
  units: StudyUnit[],
  today: string,
  /** headingId → 考频（节级，来源同树上的徽章；缺这一项就全是不显示） */
  freq?: Map<string, { level: number; marks: number; companies: number }>,
): CardGroup[] {
  const order = new Map(units.map((u, i) => [u.headingId, i]));
  const byKey = new Map<string, Card[]>();
  for (const c of cards) {
    const k = c.headingId || '';
    const list = byKey.get(k);
    if (list) list.push(c);
    else byKey.set(k, [c]);
  }

  const groups: CardGroup[] = [];
  for (const [key, list] of byKey) {
    const u = units.find((x) => x.headingId === key);
    const title = u ? u.headingText : key ? GONE_TITLE : LOOSE_TITLE;
    const f = key ? freq?.get(key) : undefined;
    groups.push({
      key,
      title,
      cards: list,
      due: list.filter((c) => !c.suspended && c.sm2.dueAt <= today).length,
      learned: list.filter((c) => c.sm2.repetitions > 0).length,
      freqLevel: f?.level ?? 0,
      freqMarks: f?.marks ?? 0,
      freqCompanies: f?.companies ?? 0,
    });
  }

  // 按文章里的章节顺序排；查不到章节的（已删除）排后面；「未归类」永远垫底。
  groups.sort((a, b) => {
    if (!a.key) return 1;
    if (!b.key) return -1;
    const ia = order.get(a.key) ?? Number.MAX_SAFE_INTEGER;
    const ib = order.get(b.key) ?? Number.MAX_SAFE_INTEGER;
    return ia - ib;
  });
  return groups;
}
