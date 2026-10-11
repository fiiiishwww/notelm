/**
 * src/components/ReviewRoom.tsx —— 复习界面（三型混排）。
 *
 * ★ 形态（她 2026-10-07 定的）★
 *   点击之后弹出一个窗口，其他地方变模糊 —— 全屏接管，不是在页面里划一块。
 *   一轮里混排三种题型：
 *     闪卡 card —— 认得出来（自己翻面 + 三键自评）
 *     填空 blank —— 讲得出来（**程序判对错**，填不出就是没懂，无法自欺）
 *     问答 qa —— 用得上去（自己的话，模型对着原文判）
 *   这三型对应她 09-07 定的三关，所以混排不是「随机穿插」，
 *   是**同一份计划里本来就该有三种**。
 *
 * ★ 为什么填空必须程序判 ★
 *   SM-2 最大的死锁是「全点记得」——自评不可信。而填空是
 *   「字符串包含」就能判的：填得出来就是会，填不出来骗不了自己。
 *   成本也是零：不调模型。
 *
 * ★ 为什么不给「语音」★
 *   她同意先不做（它不在这条链的瓶颈上：瓶颈是排序依据与状态回流）。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { api, errorText, type Card } from '../api';
import { Check, Close, Wand } from './Icons';

/** 与 server/services/reviewPlan.ts 的 ReviewKind 一致 */
type Kind = 'card' | 'blank' | 'qa';

interface Material {
  doc: string;
  headingId: string;
  nodeName: string;
  kind: string;
  essence: string;
  details: { kind: string; text: string; quote: string }[];
}

/** 测验管线（quizPrompt / POST /quiz/generate）出的题。字段与 shared/text.ts 的 QuizQuestion 一致。 */
interface QuizQ {
  id: string;
  type: 'single' | 'multi' | 'blank' | 'short';
  stem: string;
  options: string[];
  answer: (number | string)[];
  explain: string;
}

export interface PlanItem {
  id: string;
  kind: Kind;
  why: string;
  cardId?: string;
  conceptKey?: string;
  question?: string;
  result: { verdict: string; note?: string; at: string } | null;
  card: (Card & { docPath: string }) | null;
  material: Material | null;
  /**
   * 测验管线给**这一条**分配的那道题。
   * 服务端按条目顺序轮询：同一小节的几条不会问同一句（实测四条概念落在同一节，
   * 各自取零号题的话四条会是同一句话）。
   */
  quiz: QuizQ | null;
  /** 那一节总共有几道题 */
  quizTotal: number;
  /** 题出自哪个小节，界面上标一下来源 */
  quizFrom: string | null;
}

export interface PlanPayload {
  hasPlan: boolean;
  date?: string;
  plannedBy?: 'agent' | 'her';
  rationale?: string;
  today?: string;
  message?: string;
  items: PlanItem[];
}

const KIND_LABEL: Record<Kind, string> = {
  card: '闪卡',
  blank: '填空',
  qa: '问答',
};

const KIND_HINT: Record<Kind, string> = {
  card: '想完再翻面',
  blank: '程序判对错，填不出就是没懂',
  qa: '用自己的话说一遍',
};

export function ReviewRoom({
  plan,
  onExit,
  focusItemId,
}: {
  plan: PlanPayload;
  onExit: () => void;
  /** 今天栏点击行带来的定位 id（cardId 或 planItemId）。有值就从那一题开始，而不是第一道未答题。 */
  focusItemId?: string | null;
}) {
  /**
   * ★ 用 id 记账而不是靠数组下标 ★
   *
   *   原来只复习「还没 result 的」，然后按 setI(1) 前进。这个做法依赖
   *   `plan` 在答题过程中**不重算**——但 `plan` 是从父组件传入的 prop，
   *   父组件随时可能重拉（onExit 里就会）。一旦重算，`pending` 变短、
   *   下标错位，跳过的题会被当成已答。
   *   所以：把原始 items 冻结一份，用 `answeredIds` 自己记账。
   */
  const [answered, setAnswered] = useState<Set<string>>(new Set());
  // ★ 初始定位也用 id 而不是下标 ★ 今天栏点了某一行，就从那一题开播。
  //   `i` 记的是 **pending 数组**的下标（已答过的条目会被过滤掉），所以要在
  //   目标之前的 items 里数一遍「还没答的」换成 pending 下标；
  //   找不到（该卡不在计划里、或已答过）→ 回退第一题，保持原行为。
  const [i, setI] = useState(() => {
    if (!focusItemId) return 0;
    const idx = plan.items.findIndex(
      (x) => x.id === focusItemId || x.cardId === focusItemId,
    );
    if (idx < 0) return 0;
    return plan.items
      .slice(0, idx)
      .filter((x) => !x.result).length;
  });
  const [done, setDone] = useState(0);
  const [busy, setBusy] = useState(false);
  const [streak, setStreak] = useState<Kind[]>([]);

  // 冻结一份：进来时是什么就是什么，中途不随父组件重拉变化
  const items = useMemo(() => plan.items, []); // eslint-disable-line react-hooks/exhaustive-deps
  const pending = useMemo(() => items.filter((x) => !answered.has(x.id) && !x.result), [items, answered]);
  const total = pending.length;

  // 键盘：空格=显示答案/下一题，数字 1~3=对应档位，Esc=退出
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onExit();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onExit]);

  const submit = async (itemId: string, verdict: string, note?: string) => {
    setBusy(true);
    try {
      await api.answerReviewItem({ itemId, verdict, note });
      // ★ 先记账（同步）再前进 ★
      //   setAnswered 是同步的，pending 会立刻重算；若先 setI 再等它生效，
      //   中间那一帧 pending 可能还是旧的，`cur` 会指到已答的那题上。
      setAnswered((prev) => new Set(prev).add(itemId));
      setDone((d) => d + 1);
      setI((n) => n + 1);
    } catch (e) {
      alert(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const cur = pending[i];

  const finish = (
    <div className="rv-finish">
      <Check width={30} height={30} />
      <h2>这一轮过了</h2>
      <p>
        共 {done} 题
        {streak.length ? ` · 题型分布 ${streak.map((k) => KIND_LABEL[k]).join(' → ')}` : ''}
      </p>
      {streak.length >= 3 ? (
        <p className="rv-mix">
          这一轮三种题型都碰到了。
          <span className="rv-mix-note">只翻闪卡的话，「都记得」会让间隔越拉越长——填空和问答才测得出真会不会。</span>
        </p>
      ) : null}
      <button className="btn primary" onClick={onExit}>
        完成
      </button>
    </div>
  );

  const empty = (
    <div className="rv-finish">
      <Check width={30} height={30} />
      <h2>{plan.hasPlan ? '今天的都过完了' : '还没有复习计划'}</h2>
      <p>{plan.hasPlan ? '想再练一轮，跟小笔说「再排一份」。' : plan.message ?? '让小笔排一份（「今天复习什么」）。'}</p>
      <button className="btn primary" onClick={onExit}>
        关闭
      </button>
    </div>
  );

  return (
    // ★ 全屏接管 + 背景模糊 ★ 不是页面里划一块，是整个界面接管
    <div className="rv-room" role="dialog" aria-modal="true" aria-label="复习">
      <div className="rv-top">
        <button className="btn ghost sm" onClick={onExit}>
          <Close width={14} height={14} /> 退出
        </button>
        <span className="rv-plan-meta">
          {plan.date ? `${plan.date}` : ''}
          {plan.plannedBy === 'agent' ? ' 小笔排的' : plan.plannedBy === 'her' ? ' 你改过的' : ''}
        </span>
        <span style={{ flex: 1 }} />
        <span className="rv-progress-text">
          {Math.min(i + 1, total)} / {total}
        </span>
      </div>
      <div className="rv-progress">
        <i style={{ width: `${total ? (i / total) * 100 : 0}%` }} />
      </div>

      {!plan.hasPlan ? empty : total === 0 ? finish : !cur ? finish : (
        <>
          {/* ★ 为什么把她排这条的理由摆出来 ★
              「为什么今天复习这个」如果答案只在 agent 的上下文里，她就只能接受；
              摆出来她才能反驳——那才是她要的「小笔给我之后」。 */}
          <div className="rv-why">
            <Wand width={12} height={12} />
            <span>{cur.why}</span>
          </div>

          {cur.kind === 'card' ? (
            <CardPane
              // ★ key 强制重挂 ★
              //   不给 key 的话 React 会复用同一个组件实例，卡题切到下一题时
              //   showBack / 输入框 / judged 这些状态会**串题**——第一题翻过面之后
              //   第二题直接就是「已翻面」，等于把答案白送出去。
              //   复习的每一题必须是干净的一次开始。
              key={cur.id}
              item={cur}
              busy={busy}
              onDone={(v, note) => {
                setStreak((s) => [...s, 'card']);
                void submit(cur.id, v, note);
              }}
            />
          ) : /* ★ 有测验管线出的题就优先用它 ★ 旧的挖空路径只在还没出题时兜底 */ cur.quiz ? (
            <QuizPane
              key={cur.id}
              item={cur}
              busy={busy}
              onDone={(v, note) => {
                setStreak((s) => [...s, cur.kind]);
                void submit(cur.id, v, note);
              }}
            />
          ) : cur.kind === 'blank' ? (
            <BlankPane
              key={cur.id}
              item={cur}
              busy={busy}
              onDone={(v, note) => {
                setStreak((s) => [...s, 'blank']);
                void submit(cur.id, v, note);
              }}
            />
          ) : (
            <QaPane
              key={cur.id}
              item={cur}
              busy={busy}
              onDone={(v, note) => {
                setStreak((s) => [...s, 'qa']);
                void submit(cur.id, v, note);
              }}
            />
          )}
        </>
      )}
    </div>
  );
}

// ─────────────────────────── 闪卡 ───────────────────────────

function CardPane({ item, busy, onDone }: { item: PlanItem; busy: boolean; onDone: (v: string, note?: string) => void }) {
  const [showBack, setShowBack] = useState(false);
  const c = item.card;
  if (!c) {
    return (
      <PaneShell kind="card" warn="这张卡已经不在了（可能被停用或删了）。跳过它，继续下一题。">
        <button className="btn primary" onClick={() => onDone('skipped')}>
          跳过
        </button>
      </PaneShell>
    );
  }
  return (
    <PaneShell kind="card">
      <div className="rv-q">{c.front}</div>
      {showBack ? (
        <>
          <div className="rv-a">{c.back}</div>
          {/* 引文放在答案之后：正面就给原文等于提前泄答案 */}
          {c.source.quote ? <div className="rv-quote">原文：“{c.source.quote}”</div> : null}
          <div className="rv-grades">
            <button className="btn danger" disabled={busy} onClick={() => onDone('again')}>
              忘了
            </button>
            <button className="btn" disabled={busy} onClick={() => onDone('hard')}>
              有点难
            </button>
            <button className="btn primary" disabled={busy} onClick={() => onDone('good')}>
              记住了
            </button>
          </div>
        </>
      ) : (
        <button className="btn primary" onClick={() => setShowBack(true)}>
          显示答案
        </button>
      )}
    </PaneShell>
  );
}

// ─────────────────────────── 填空 ───────────────────────────

/** 一道填空题：挖好的空 + 标准答案。程序判，不调模型。 */
interface Blank {
  id: string;
  before: string;
  after: string;
  answer: string;
  from: string;
}

/**
 * 从节点的细节里挖空。
 *
 * ★ 挖哪几类 ★
 *   等式、数值、定义 —— 这三类天然是「一个空」。
 *   要点/清单挖空会变成「这句话该怎么说」，那是问答不是填空。
 *   所以只在这几类里挑，**挑不到就如实说没有填空**（不硬造）。
 */
function buildBlanks(m: Material): Blank[] {
  const out: Blank[] = [];
  for (const d of m.details) {
    const text = d.text.trim();
    if (!text) continue;

    if (d.kind === '等式' || text.includes('=')) {
      // 挖掉等号右边的整体：Agent = Model + ____
      const eq = text.indexOf('=');
      if (eq > 0) {
        const left = text.slice(0, eq);
        const right = text.slice(eq + 1).trim().replace(/[。；;]$/, '');
        if (right.length >= 3 && right.length <= 60) {
          out.push({ id: `eq-${out.length}`, before: `${left} =`, after: '', answer: right, from: `${m.nodeName} · ${d.kind}` });
        }
      }
    }
    if (d.kind === '定义') {
      // 「X 是……」挖掉后半段：X 是 ____
      const mdef = /^(.{2,20}?)\s*(?:是|指)\s*(.{4,})$/.exec(text);
      if (mdef) {
        out.push({
          id: `def-${out.length}`,
          before: `${mdef[1]} 是`,
          after: '',
          answer: mdef[2].replace(/[。；;]$/, ''),
          from: `${m.nodeName} · 定义`,
        });
      }
    }
    if (d.kind === '数值') {
      // ★ 单位 alternation 里 tokens 必须排在 token 前面 ★
      //   否则「12000 tokens」会先匹配到「token」、再把尾部的 s 当成裸数字，答案变成「12000 token」。
      const nums = [...text.matchAll(/\d+(?:\.\d+)?\s*(?:%|tokens|token|天|次|个|倍|万|亿|字)?/g)];
      if (nums.length === 1 && nums[0][0].trim().length >= 1) {
        const v = nums[0][0].trim();
        const t2 = text.replace(nums[0][0], '____').trim();
        if (t2.length >= 6 && t2.length <= 80) {
          out.push({ id: `num-${out.length}`, before: t2, after: '', answer: v, from: `${m.nodeName} · 数值` });
        }
      }
    }
  }
  return out.slice(0, 3);
}

/**
 * 程序判：去标点去空白后比对。
 *
 * ★ 三个坑（都是 scripts/blank-verify.ts 实测抓出来的，不是想出来的）★
 *   ① 并列答案**不能走包含判断**：问「上下文管理+工具接口+约束+验证+纠正」，
 *      答「上下文管理」时 `a.includes(b)` 为假而 `b.includes(a)` 为真 → 被判成 correct。
 *      ★ 教训和昨天「卡片大小」那条同源：**短的是长的子串，不代表答对了**。
 *      所以多项并列一律走「逐项核对」，命中比例决定 partial / wrong。
 *   ② 前缀兜底太宽会放过真错：「模型 + Harness」与「Model + Harness」
 *      的前三个字符分别是「模型」和「mod」——虽然不撞，但同样的写法会把
 *      「运行与治理层」和「运行速度」判成对。所以前缀只认**足够长的**答案（≥8 字）。
 *   ③ 标点与空格不该影响判定：中文答案常带句号、英文之间常带空格。
 */
function judgeBlank(input: string, answer: string): 'correct' | 'partial' | 'wrong' {
  const norm = (s: string) => s.replace(/[\s，。、；;：:！!？?（）()「」『』"'`]/g, '').toLowerCase();
  const a = norm(input);
  const b = norm(answer);
  if (!a) return 'wrong';
  if (a === b) return 'correct';

  // 并列答案：逐项核对（见坑①）
  const parts = b.split(/(?:\s*[+＋/、]\s*)/).filter((x) => x.length >= 2);
  if (parts.length >= 2) {
    const hitParts = parts.filter((p) => a.includes(p));
    if (hitParts.length === parts.length) return 'correct';
    // ★ 半数是按「答对的那部分占全长比例」算的，不是按项数 ★
    //   `Math.ceil(n/2)` 会被「答对 1/5 项」判成 partial —— 而她实际只答出五分之一，
    //   那是不会，不是「勉强算对」。判宽了填空就退化成自评了。
    // ★ 分母用 parts 之和、不用 b.length ★（实测踩过：`+` 号被 norm 删掉后
    //   b.length=19 而 parts 之和=15，比例从 0.733 掉到 0.579，刚好掉出阈值）。
    const total = parts.reduce((s, p) => s + p.length, 0);
    const covered = hitParts.reduce((s, p) => s + p.length, 0);
    return total > 0 && covered / total >= 0.6 ? 'partial' : 'wrong';
  }

  // 单项：她可能多写了一句解释，包含答案就算对
  if (b.length >= 2 && a.includes(b)) return 'correct';
  // 前缀兜底只在长答案时启用（见坑②）
  if (b.length >= 8 && a.length >= 2 && (a.includes(b.slice(0, 4)) || b.includes(a.slice(0, 4)))) {
    return 'partial';
  }
  return 'wrong';
}

/**
 * 测验管线出的题（single / multi / blank / short）。
 *
 * ★ 它取代了什么 ★
 *   原来 blank 这一层是 buildBlanks() 现场挖空出来的。2026-10-08 实测她当天那份计划
 *   **4 条里 3 条界面直接显示「没有可挖空的内容」**，唯一能挖的那个答案有 30 字——
 *   程序比对必判错。换成本组件后，填不出那就是真的不会，不再是「这题格式不支持」。
 *
 * ★ 判分 ★
 *   single / multi / blank 都是**程序判**（答案就在题里，不含糊）；
 *   只有 short（简答）不带标准答案，只能她自评——界面会先把评分要点翻出来再让她按按钮，
 *   不让她看着自己的答案自己给自己打分。
 */
function QuizPane({ item, busy, onDone }: { item: PlanItem; busy: boolean; onDone: (v: string, note?: string) => void }) {
  const q = item.quiz;
  const [picked, setPicked] = useState<number[]>([]);
  const [text, setText] = useState('');
  const [shown, setShown] = useState(false);
  const [auto, setAuto] = useState<'correct' | 'partial' | 'wrong' | null>(null);

  if (!q) return null;

  const idx = q.answer.filter((x): x is number => typeof x === 'number');
  const accepted = q.answer.map((x) => String(x));
  const accepting = q.type === 'single' || q.type === 'multi' || q.type === 'blank';

  const check = () => {
    if (q.type === 'single') {
      setAuto(picked.length === 1 && picked[0] === idx[0] ? 'correct' : 'wrong');
    } else if (q.type === 'multi') {
      const right = picked.filter((p) => idx.includes(p)).length;
      const extra = picked.filter((p) => !idx.includes(p)).length;
      // ★ 多选错的代价 > 漏选 ★ 多选里掺了错项就是没懂（尤其是并列要点型），不能给 partial
      setAuto(extra > 0 ? 'wrong' : right === idx.length ? 'correct' : right >= 1 ? 'partial' : 'wrong');
    } else {
      const vs = accepted.map((a) => judgeBlank(text, a));
      setAuto(vs.includes('correct') ? 'correct' : vs.includes('partial') ? 'partial' : 'wrong');
    }
    setShown(true);
  };

  const canSubmit = q.type === 'single' || q.type === 'multi' ? picked.length > 0 : text.trim().length > 0;

  const toggle = (i: number) => {
    if (shown) return;
    if (q.type === 'single') setPicked([i]);
    else setPicked((v) => (v.includes(i) ? v.filter((x) => x !== i) : [...v, i]));
  };

  const kindWord = q.type === 'single' ? '单选' : q.type === 'multi' ? '多选' : q.type === 'blank' ? '填空' : '简答';

  return (
    <div className="rv-pane">
      <div className="rv-kind">
        <span className="rv-kind-tag k-blank">{kindWord}</span>
        <span className="rv-kind-hint">{accepting ? '按测验管线出的题，程序判对错' : '先写出答案，再对着评分要点自评'}</span>
      </div>
      <div className="rv-body">
        <div className="rv-q">{q.stem}</div>
        {item.quizFrom ? <span className="rv-blank-from">出处：{item.quizFrom}</span> : null}

        {(q.type === 'single' || q.type === 'multi') && (
          <ul className="rv-opts">
            {q.options.map((o, i) => {
              const isAnswer = idx.includes(i);
              const wasPicked = picked.includes(i);
              // ★ 判完再标色 ★ 判之前高亮等于直接给答案
              let cls = 'rv-opt';
              if (shown) {
                if (isAnswer) cls += ' opt-right';
                else if (wasPicked) cls += ' opt-wrong';
              } else if (wasPicked) cls += ' opt-picked';
              return (
                <li key={i}>
                  <button className={cls} disabled={shown} onClick={() => toggle(i)}>
                    <span className="rv-opt-key">{String.fromCharCode(65 + i)}</span>
                    <span>{o}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {q.type === 'blank' && (
          <input
            className="input"
            value={text}
            disabled={shown}
            autoFocus
            placeholder="凭记忆填"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && canSubmit) {
                e.preventDefault();
                check();
              }
            }}
          />
        )}

        {q.type === 'short' && (
          <textarea
            className="input"
            rows={5}
            value={text}
            disabled={shown}
            placeholder="先自己写一遍，写完再对要点"
            onChange={(e) => setText(e.target.value)}
          />
        )}

        {!shown ? (
          <button className="btn primary" onClick={check} disabled={busy || !canSubmit}>
            {q.type === 'short' ? '我写完了，看评分要点' : '对答案'}
          </button>
        ) : (
          <>
            <div className="rv-a">
              {q.type === 'single' || q.type === 'multi'
                ? `正确答案：${idx.map((i) => `${String.fromCharCode(65 + i)}. ${q.options[i] ?? ''}`).join('  ')}`
                : q.type === 'blank'
                  ? `答案：${accepted.join(' / ')}`
                  : `评分要点：${accepted.map((a, i) => `（${i + 1}）${a}`).join(' ')}`}
            </div>
            {q.explain ? <div className="rv-hint">{q.explain}</div> : null}
            {accepting && auto ? (
              <div className="rv-hint">
                判分：
                <span className={auto === 'correct' ? 'rv-ok' : auto === 'partial' ? 'rv-mid' : 'rv-no'}>
                  {auto === 'correct' ? '全对' : auto === 'partial' ? '只答出一部分' : '答错'}
                </span>
              </div>
            ) : null}
            <div className="rv-grades">
              <button className="btn danger" disabled={busy} onClick={() => onDone('wrong', q.stem.slice(0, 60))}>
                没答出来
              </button>
              <button
                className="btn primary"
                disabled={busy}
                onClick={() =>
                  onDone(accepting ? (auto === 'correct' ? 'correct' : auto === 'partial' ? 'partial' : 'wrong') : 'partial')
                }
              >
                {accepting
                  ? auto === 'correct'
                    ? '对了，下一题'
                    : auto === 'partial'
                      ? '勉强算对，下一题'
                      : '确认没答出来，下一题'
                  : '答得上来，下一题'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function BlankPane({ item, busy, onDone }: { item: PlanItem; busy: boolean; onDone: (v: string, note?: string) => void }) {
  const blanks = useMemo(() => (item.material ? buildBlanks(item.material) : []), [item.material]);
  const [bi, setBi] = useState(0);
  const [input, setInput] = useState('');
  const [judged, setJudged] = useState<'correct' | 'partial' | 'wrong' | null>(null);

  if (!item.material) {
    return (
      <PaneShell kind="blank" warn="这个知识点在树里找不到节点了（可能树重新生成过，节点名变了）。">
        <button className="btn primary" onClick={() => onDone('skipped')}>
          跳过
        </button>
      </PaneShell>
    );
  }
  if (!blanks.length) {
    // ★ 如实说，不硬造 ★ 硬造出来的填空是「猜她想填什么」，会变成自欺。
    //   而且这句话要说到根子上：走测验管线出过题的小节不会落到这里
    //   （那条路径优先），所以这里就是「还没出题」——让她知道去找小笔补。
    return (
      <PaneShell kind="blank" warn={`「${item.material.nodeName}」走了旧的挖空路径：后端按等式/定义/数值三种格式找能挖的内容，这一節找不到。真正的原因是**这一节还没走过测验管线出题**——让小笔跑一下 quiz-bank 就有正式题目了。`}>
        <button className="btn primary" onClick={() => onDone('skipped')}>
          跳过
        </button>
      </PaneShell>
    );
  }

  const b = blanks[Math.min(bi, blanks.length - 1)];
  const remaining = blanks.length - 1 - bi;
  const check = () => {
    const v = judgeBlank(input, b.answer);
    setJudged(v);
  };

  return (
    <PaneShell kind="blank">
      <div className="rv-blank-q">
        <span className="rv-blank-text">
          {b.before} <span className="rv-hole">{judged ? '' : '＿＿＿＿'}</span>
          {judged ? <span className={judged === 'correct' ? 'rv-ok' : judged === 'partial' ? 'rv-mid' : 'rv-no'}>{input || '（空）'}</span> : null}
        </span>
        <span className="rv-blank-from">{b.from}</span>
      </div>
      {judged ? (
        <>
          <div className="rv-a">
            标准答案：{b.answer}
          </div>
          <div className="rv-grades">
            <button className="btn danger" disabled={busy} onClick={() => onDone('wrong', '标准答案是「' + b.answer + '」')}>
              没答出来
            </button>
            <button className="btn primary" disabled={busy} onClick={() => onDone(judged === 'wrong' ? 'wrong' : judged === 'partial' ? 'partial' : 'correct')}>
              {judged === 'correct' ? '对了，下一题' : '勉强算对，下一题'}
            </button>
          </div>
          {remaining > 0 ? (
            <button
              className="btn ghost sm"
              onClick={() => {
                setJudged(null);
                setInput('');
                setBi((n) => n + 1);
              }}
            >
              这条还有 {remaining} 个空
            </button>
          ) : null}
        </>
      ) : (
        <>
          <input
            className="input"
            value={input}
            autoFocus
            placeholder="凭记忆填，填不出就留空"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                check();
              }
            }}
          />
          <div className="rv-hint">
            程序直接比对，<b>填不出就是没懂</b>——这一型不靠自评，所以骗不了自己。
          </div>
          <button className="btn primary" onClick={check} disabled={busy}>
            对答案
          </button>
        </>
      )}
    </PaneShell>
  );
}

// ─────────────────────────── 问答 ───────────────────────────

function QaPane({ item, busy, onDone }: { item: PlanItem; busy: boolean; onDone: (v: string, note?: string) => void }) {
  const [text, setText] = useState('');
  const m = item.material;
  // 题面优先用 agent 写的（随计划落盘，保证这一轮和下一轮问的是同一个）
  const q = item.question ?? `用你自己的话说：${m?.nodeName ?? '这个知识点'}是什么、解决什么问题？`;

  return (
    <PaneShell kind="qa">
      <div className="rv-q">{q}</div>
      {m ? <div className="rv-hint">参考：{m.essence}</div> : null}
      <textarea
        className="input"
        rows={5}
        value={text}
        placeholder="用自己的话讲一遍，不用追求措辞准确"
        onChange={(e) => setText(e.target.value)}
      />
      <div className="rv-hint">
        这一型是「用得上去」：讲得出使用方法才算会，只记得定义不算。
      </div>
      <div className="rv-grades">
        <button className="btn danger" disabled={busy || !text.trim()} onClick={() => onDone('wrong')}>
          讲不出来
        </button>
        <button className="btn" disabled={busy || !text.trim()} onClick={() => onDone('partial')}>
          讲得不全
        </button>
        <button className="btn primary" disabled={busy || !text.trim()} onClick={() => onDone('correct', text.trim().slice(0, 300))}>
          讲得出来
        </button>
      </div>
      {/* 她的原话随结果一起存：小笔下次能拿「她上次怎么说的」对照 */}
      <div className="rv-note-hint">{text.trim() ? '你这段话会一起记下来，之后可以拿它跟原文对照。' : ''}</div>
    </PaneShell>
  );
}

// ─────────────────────────── 壳 ───────────────────────────

function PaneShell({
  kind,
  children,
  warn,
}: {
  kind: Kind;
  children: React.ReactNode;
  warn?: string;
}) {
  return (
    <div className="rv-pane">
      <div className="rv-kind">
        <span className={`rv-kind-tag k-${kind}`}>{KIND_LABEL[kind]}</span>
        <span className="rv-kind-hint">{warn ? '' : KIND_HINT[kind]}</span>
      </div>
      {warn ? <div className="rv-warn">{warn}</div> : null}
      <div className="rv-body">{children}</div>
    </div>
  );
}