/**
 * src/components/StudyPanel.tsx —— 右栏：学习面板（Step 2 的 AI 增强）。
 *
 * 三个子页共用一套「按章节组织」的结构，和正文的学习单元（StudyUnit）一一对应：
 *   知识树 —— 把一节原文按知识点关系组织成树（小抄下岗后的唯一生成形态），
 *             细节条附可点击的原文引用
 *   测验 —— 按节出题，做完判分，错了能看解析并跳回原文
 *   闪卡 —— 批注和存量条目都能转成卡片，用 SM-2 安排复习
 *
 * ★ 一条贯穿三个子页的纪律：AI 产出的所有引用都必须能定位回原文 ★
 *   后端已经在生成时逐条校验过（validateQuote），定位不到的引用会被丢掉、
 *   但内容保留。所以这里看到的行内代码引用**理论上**都是能跳的；
 *   仍然做兜底是因为正文可能在生成之后被改过，此时提示用户而不是假装跳成功。
 *
 * 为什么小抄用 dangerouslySetInnerHTML：小抄是 Markdown，而渲染需要的 markdown-it
 * 在 shared/blocks.ts（服务端模块，前端 import 它会把整个库打进客户端包）。
 * 所以由服务端在响应里带一份渲染好的 html。安全上没问题：createMd() 的 html
 * 选项是 false，原始 HTML 会被转义而不是执行。
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useApp } from '../state/store';
import { api, errorText, fontUrl, type AttemptResult, type FontInfo } from '../api';
import type { Block, Card, CheatsheetSection, CheatsheetStats, Quiz, QuizQuestion, StudyUnit } from '../../shared/text';
import { ENTRY_KINDS, localDate, termsToMerge } from '../../shared/text';
import { scrollToBlock, biOfHeading } from '../lib/dom';
import { ankiFileName, buildAnkiText, downloadText } from '../lib/anki';
import { buildGroups, type CardGroup } from '../lib/cardgroups';
import {
  ArrowLeft,
  Bulb,
  Cards,
  Check,
  ChevronRight,
  Download,
  Plus,
  Quiz as QuizIcon,
  Refresh,
  Trash,
  Wand,
  Warning,
} from './Icons';
import { Modal } from './Dialog';

type Tab = 'cheat' | 'quiz' | 'cards';

// ─────────────────────────── 面板外壳 ───────────────────────────

export function StudyPanel({ switcher }: { switcher?: ReactNode }) {
  const { state, actions } = useApp();
  const doc = state.doc;
  const [tab, setTab] = useState<Tab>('cheat');

  const units = doc?.analysis.units ?? [];
  const sections = doc?.sidecar.cheatsheet.sections ?? [];
  const quizzes = doc?.sidecar.quizzes ?? [];
  const cards = doc?.sidecar.cards ?? [];

  if (!doc) {
    return (
      <div className="pane pane-right">
        <div className="pane-head">
          <h2>学习</h2>
          {switcher}
        </div>
        <div className="pane-body">
          <div className="empty">
            <Bulb width={22} height={22} />
            <p>{state.docLoading ? '正在打开文章…' : '打开一篇文章后，这里可以生成知识树、出题和背卡片。'}</p>
          </div>
        </div>
      </div>
    );
  }

  const busy = Boolean(state.busy);

  return (
    <div className="pane pane-right">
      <div className="pane-head">
        <h2>学习</h2>
        {switcher}
        <span className="count-chip" title={`${sections.length} 节知识树 · ${quizzes.length} 份测验 · ${cards.length} 张卡`}>
          {sections.length}/{units.length}
        </span>
        <span style={{ flex: 1 }} />
        {state.busy ? <span className="spinner" style={{ width: 12, height: 12, borderWidth: 1.5 }} /> : null}
      </div>

      <div className="study-tabs">
        <TabBtn active={tab === 'cheat'} onClick={() => setTab('cheat')} icon={<Bulb />} label="知识树" count={sections.length} />
        <TabBtn active={tab === 'quiz'} onClick={() => setTab('quiz')} icon={<QuizIcon />} label="测验" count={quizzes.length} />
        <TabBtn active={tab === 'cards'} onClick={() => setTab('cards')} icon={<Cards />} label="闪卡" count={cards.length} />
      </div>

      <div className="pane-body">
        {tab === 'cheat' ? (
          <CheatTab units={units} sections={sections} blocks={doc.analysis.blocks} rel={state.activeRel ?? ''} busy={busy} />
        ) : null}
        {tab === 'quiz' ? <QuizTab units={units} quizzes={quizzes} blocks={doc.analysis.blocks} busy={busy} /> : null}
        {tab === 'cards' ? (
          <CardsTab cards={cards} units={units} busy={busy} docTitle={docTitleOf(doc)} docRel={doc.path} />
        ) : null}
      </div>
    </div>
  );
}

/** 文章标题（去掉路径和扩展名），用于导出文件名。 */
function docTitleOf(doc: { path: string }): string {
  const name = doc.path.slice(doc.path.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');
  return name || '未命名';
}

function TabBtn({
  active,
  onClick,
  icon,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  count: number;
}) {
  return (
    <button className={`study-tab${active ? ' on' : ''}`} onClick={onClick}>
      {icon}
      <span>{label}</span>
      {count > 0 ? <span className="study-tab-count">{count}</span> : null}
    </button>
  );
}

// ─────────────────────────── 小抄 ───────────────────────────

function CheatTab({
  units,
  sections,
  blocks,
  rel,
  busy,
}: {
  units: StudyUnit[];
  sections: CheatsheetSection[];
  blocks: Block[];
  rel: string;
  busy: boolean;
}) {
  // state 只为「答案见」的跨文档跳转用：判断目标文档是否就是当前打开的这篇
  const { state, actions } = useApp();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [confirmClear, setConfirmClear] = useState(false);

  /** 回收站少了一条就更新计数；空了整个折叠区收走（空的「被裁 0 条」是噪音）。 */
  const collapseBinIfEmpty = (li: HTMLElement | null) => {
    const bin = li?.closest<HTMLElement>('details.cheat-bin');
    if (!bin) return;
    const rest = bin.querySelectorAll('li[data-ik]').length;
    const t = bin.querySelector<HTMLElement>('summary .t');
    if (t) t.textContent = `被裁 ${rest} 条`;
    if (!rest) bin.remove();
  };

  // ── 知识树字体（呈现偏好，存本地 + 字体文件存在 .local/fonts） ──
  // 默认字体就是应用自己的字体栈；「我的字体」是用户传上来的（可多个）。
  const [fonts, setFonts] = useState<FontInfo[]>([]);
  const [fontFile, setFontFile] = useState<string>(() => localStorage.getItem('nb-cheat-font') ?? '');
  const [fontBusy, setFontBusy] = useState(false);
  const [confirmDelFont, setConfirmDelFont] = useState<FontInfo | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let alive = true;
    void api
      .fonts()
      .then((r) => {
        if (alive) setFonts(r.fonts);
      })
      .catch((err) => {
        // ★ 不能静默 ★：列表拿不到 → family 拿不到 → @font-face 注入不了，
        //   表现就是「选了字体但没变化，刷新一下才好」。以前这里吞掉了错误，
        //   于是这个 bug 只能靠「刷新试试」绕过。
        actions.toast('warn', `字体列表没取到：${errorText(err)}`);
      });
    return () => {
      alive = false;
    };
  }, [actions]);

  const picked = fonts.find((f) => f.file === fontFile) ?? null;

  /**
   * 本地派生 CSS family 名。
   *
   * family 只是 @font-face 的内部标识，唯一且 CSS 安全就够了，**不必和服务端一致**
   * （服务端那份是给自己的列表用的）。这样即便列表请求失败，只要知道文件名
   * 就能把字体加载出来——「选了就生效」不该依赖一次额外的网络请求。
   */
  const fontFamily = useMemo(() => {
    if (!fontFile) return '';
    let h = 0;
    for (let i = 0; i < fontFile.length; i++) h = (h * 31 + fontFile.charCodeAt(i)) | 0;
    const ascii = fontFile
      .replace(/\.[^.]+$/, '')
      .replace(/[^A-Za-z0-9]+/g, '')
      .slice(0, 24);
    return `nbl-${ascii || 'font'}-${(h >>> 0).toString(36)}`;
  }, [fontFile]);

  // 换了字体就主动让它开始加载：否则要等下一次重排才去取文件，
  // 中间那一两秒看起来就是「点了没反应」。
  useEffect(() => {
    if (!fontFamily || !document.fonts) return;
    void document.fonts.load(`16px "${fontFamily}"`).catch(() => {
      /* 加载失败会回退到字体栈里的 --font，不影响别的 */
    });
  }, [fontFamily]);

  const chooseFont = (file: string) => {
    setFontFile(file);
    if (file) localStorage.setItem('nb-cheat-font', file);
    else localStorage.removeItem('nb-cheat-font');
  };

  const uploadFont = async (file: File | undefined) => {
    if (!file) return;
    setFontBusy(true);
    try {
      const r = await api.uploadFont(file);
      const list = await api.fonts();
      setFonts(list.fonts);
      chooseFont(r.font.file); // 传完就切过去，不用再点一次
      actions.toast('ok', `已添加字体「${r.font.label}」`);
    } catch (err) {
      actions.toast('error', errorText(err));
    } finally {
      setFontBusy(false);
    }
  };

  // ── 类型显隐开关（用户偏好，存本地） ──
  // 数值/清单这类要不要看是个人偏好，所以做成「显示层过滤」而不是删内容：
  // 数据全保留，关掉的只是显示。
  const [offKinds, setOffKinds] = useState<string[]>(() => {
    try {
      const v = JSON.parse(localStorage.getItem('nb-cheat-off-kinds') ?? '[]');
      return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
    } catch {
      return [];
    }
  });
  const toggleKind = (k: string) =>
    setOffKinds((cur) => {
      const next = cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k];
      localStorage.setItem('nb-cheat-off-kinds', JSON.stringify(next));
      return next;
    });

  /** 各类条目的数量（术语并入【定义】，口径与渲染层一致，见 shared/text.termsToMerge）。 */
  const kindCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const s of sections) {
      const it = s.items;
      if (!it) continue;
      for (const e of it.entries ?? []) c[e.kind] = (c[e.kind] ?? 0) + 1;
      for (const t of termsToMerge(it)) c['定义'] = (c['定义'] ?? 0) + 1;
    }
    return c;
  }, [sections]);

  const byId = useMemo(() => {
    const m = new Map<string, CheatsheetSection>();
    for (const s of sections) m.set(s.headingId, s);
    return m;
  }, [sections]);

  /**
   * 点小抄条目 → 跳回原文。
   * 新版条目自带 data-bi（生成时算好的块号），直接滚过去；
   * 老格式没有块号，退回「拿引文文本问服务端」的老路子。
   */
  const jumpToQuote = async (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const li = target.closest<HTMLElement>('[data-bi],[data-q]');
    if (li) {
      const bi = li.getAttribute('data-bi');
      if (bi != null && bi !== '') {
        scrollToBlock(Number(bi));
        return;
      }
      const quote = (li.getAttribute('data-q') ?? '').trim();
      if (quote) {
        try {
          const r = await api.locate(rel, quote);
          if (r.found && typeof r.blockIndex === 'number') scrollToBlock(r.blockIndex);
          else actions.toast('warn', '这句引用在正文里找不到了——正文可能改过了，重新生成一次小抄吧。');
        } catch (err) {
          actions.toast('error', errorText(err));
        }
      }
      return;
    }
    // 老格式（markdown 渲染）的行内代码
    const code = target.closest('code');
    if (!code) return;
    const quote = (code.textContent ?? '').trim();
    if (!quote) return;
    try {
      const r = await api.locate(rel, quote);
      if (r.found && typeof r.blockIndex === 'number') {
        scrollToBlock(r.blockIndex);
      } else {
        actions.toast('warn', '这句引用在正文里找不到了——正文可能改过了，重新生成一次小抄吧。');
      }
    } catch (err) {
      actions.toast('error', errorText(err));
    }
  };

  /**
   * ★ 点反馈图标：把「你觉得这条怎么样」写回 sidecar ★
   *
   * 为什么走事件委托而不是给每条挂 React 组件：条目 html 是服务端渲染的
   * （markdown-it 不该打进客户端包），所以按钮只能以字符串形式出现在 html 里，
   * 前端认 `.fb b[data-mark]` 拦截即可。
   *
   * 为什么乐观更新：用户会连点几十条，等服务端往返再变色会明显卡顿。
   * 失败就回滚到原状态并报错。
   */
  const onCheatClick = async (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const btn = target.closest<HTMLElement>('.fb b[data-mark]');
    if (!btn) return jumpToQuote(e);
    const li = btn.closest<HTMLElement>('li[data-ik]');
    if (!li) return jumpToQuote(e);
    const hid = btn.closest<HTMLElement>('[data-hid]')?.getAttribute('data-hid') ?? '';
    const ik = li.getAttribute('data-ik') ?? '';
    const mark = btn.getAttribute('data-mark') as 'up' | 'down' | 'dup';
    const cur = li.getAttribute('data-fb');
    const next = cur === mark ? null : mark; // 再点一次同一个图标 = 取消

    if (next) li.setAttribute('data-fb', next);
    else li.removeAttribute('data-fb');
    try {
      const r = await api.cheatsheetFeedback(rel, hid, ik, next);
      // ★ 回收站的两种裁决要动 DOM，普通标注的变色乐观更新在前面已经做了 ★
      if (r.bin === 'resurrected') {
        li.remove();
        collapseBinIfEmpty(li);
        actions.toast('ok', '已复活，回到正文末尾');
        void actions.reloadDoc(); // 正文列表由服务端重新渲染，整节刷新才看得见
        return;
      }
      if (r.bin === 'removed') {
        li.remove();
        collapseBinIfEmpty(li);
      }
    } catch (err) {
      if (cur) li.setAttribute('data-fb', cur);
      else li.removeAttribute('data-fb');
      actions.toast('error', errorText(err));
      return;
    }

    // ▽ 的理由框：插进去但不抢焦点 —— 连点几十条时不能被弹窗打断，
    // 想填就点一下，回车保存；不填直接点别处，它自己消失。
    if (next === 'down' && !li.querySelector('.fb-why-in')) {
      const box = document.createElement('input');
      box.className = 'fb-why-in';
      box.placeholder = '有什么反馈？（回车保存，不填可直接继续点）';
      box.onblur = () => {
        if (!box.value.trim()) box.remove();
      };
      box.onkeydown = (ev: KeyboardEvent) => {
        if (ev.key !== 'Enter') return;
        const why = box.value.trim();
        box.remove();
        if (!why) return;
        li.setAttribute('data-fbwhy', why);
        void api.cheatsheetFeedback(rel, hid, ik, 'down', why).catch(() => undefined);
      };
      li.appendChild(box);
    }
  };

  /**
   * ★ 知识树视图的点击委托（2026-09-20 接入；2026-09-22 拆开点击语义）★
   *
   * 优先级：答案见 > 另见徽章 > 标注按钮/细节条跳原文 > 三角（只展开/收起）
   *         > 名字（有块号跳原文，没有当展开用）> 行空白（展开/收起）。
   * 之前整行点击都是展开，导致「定位原文」没有落点——名字和 ¶块号都点不动。
   */
  const onTreeClick = async (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    // ★「答案见」：跳到参考答案文件对应块（跨文档，走 requestJump + openDoc 的统一定位，
    //   由 ArticlePane 在 DOM 就绪后执行滚动+闪烁——同 SearchPanel.goTo 的正解）
    const ans = target.closest<HTMLElement>('.kt-answer');
    if (ans) {
      const rel = ans.dataset.jumpRel;
      const bi = Number(ans.dataset.jumpBi);
      if (rel && Number.isFinite(bi)) {
        if (state.doc?.path !== rel) {
          actions.requestJump(rel, bi);
          void actions.openDoc(rel);
        } else {
          scrollToBlock(bi);
        }
      }
      return;
    }
    // ★ L3 跨节「另见」：点徽章 → 展开目标节并滚过去（篇内跳转，复用现有滚动基建）
    const xr = target.closest<HTMLElement>('.kt-xref');
    if (xr) {
      const hid = xr.dataset.jumpHid;
      if (hid) {
        setOpen((s) => ({ ...s, [hid]: true }));
        const bi = biOfHeading(blocks, hid);
        if (bi !== null) scrollToBlock(bi);
      }
      return;
    }
    if (target.closest('.fb b[data-mark]') || target.closest('li.kt-d[data-bi]')) {
      return onCheatClick(e);
    }
    const toggleNode = (el: HTMLElement) => el.closest('.kt-node')?.classList.toggle('open');
    // ★ 三角只管展开/收起（叶子节点没有子级，点了也无妨）
    if (target.closest('.kt-tw')) {
      toggleNode(target);
      return;
    }
    // ★ 名字：有块号 → 跳原文（失败给提示，之前树路径没有任何兜底）；没有 → 当展开用
    const name = target.closest<HTMLElement>('.kt-name');
    if (name) {
      const bi = name.dataset.bi ? Number(name.dataset.bi) : NaN;
      if (Number.isFinite(bi)) {
        if (!scrollToBlock(bi)) {
          actions.toast('warn', '这段原文找不到了——正文可能改过，重新生成一次知识树吧。');
        }
        return;
      }
      toggleNode(name);
      return;
    }
    // 行空白：仍是展开/收起（保留大点击面，习惯不变）
    if (target.closest('.kt-row')) toggleNode(target);
  };

  if (units.length === 0) {
    return (
      <div className="empty">
        <Bulb width={22} height={22} />
        <h3>这篇文章还没有可分的小节</h3>
        <p>
          知识树是按「## 标题」切分小节生成的。给文章加上二级标题，
          就能一节一节地生成；也可以先读一遍、写完批注再回来。
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="study-bar">
        <button className="btn primary sm" disabled={busy} onClick={() => void actions.generateAllTrees()}>
          <Wand /> 生成全部知识树
        </button>
        <span style={{ flex: 1 }} />
        {sections.length > 0 ? (
          <button className="btn ghost icon sm" title="清空本文所有知识树" disabled={busy} onClick={() => setConfirmClear(true)}>
            <Trash />
          </button>
        ) : null}
      </div>

      {/* 字体偏好：只影响知识树的呈现，内容/生成完全不变 */}
      <div className="cheat-fontbar">
        <span className="hint">知识树字体</span>
        <select
          // 直接用 fontFile：以前写的是 picked ? fontFile : ''，
          // 列表一空（请求失败或还没回来）选中的值就回弹成「默认」，
          // 于是用户看到的是「我明明选了，它却显示默认」。
          value={fontFile}
          disabled={fontBusy}
          title="只改变知识树的显示字体，不影响生成内容"
          onChange={(e) => {
            if (e.target.value === '__upload') {
              fileInput.current?.click();
              return;
            }
            chooseFont(e.target.value);
          }}
        >
          <option value="">默认</option>
          {fonts.map((f) => (
            <option key={f.file} value={f.file}>
              {f.label}
            </option>
          ))}
          <option value="__upload">＋ 上传字体…</option>
        </select>
        {picked ? (
          <span className="hint">{Math.round(picked.size / 1024 / 1024 * 10) / 10} MB</span>
        ) : null}
        {picked ? (
          <button className="btn ghost icon sm" title="删除这个字体" onClick={() => setConfirmDelFont(picked)}>
            <Trash />
          </button>
        ) : null}
        <input
          ref={fileInput}
          type="file"
          accept=".ttf,.otf,.ttc,.woff,.woff2"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = ''; // 允许连续传同一个文件（换字体时想重传）
            void uploadFont(f);
          }}
        />
      </div>

      {sections.length === 0 ? (
        <div className="empty">
          <Bulb width={22} height={22} />
          <h3>还没有知识树</h3>
          <p>
            点上面的「生成全部知识树」，AI 会读每一节的原文，把知识点按关系
            组织成一棵树（而不是照着目录压缩），细节条都附原文引用。
          </p>
          <p style={{ color: 'var(--text-3)' }}>
            需要在「设置 → AI 接口」里填好接口地址、模型名和 Key。
          </p>
        </div>
      ) : null}

      {Object.keys(kindCounts).length > 0 ? (
        <div className="cheat-toolbar">
          <span className="hint">显示：</span>
          {ENTRY_KINDS.filter((k) => (kindCounts[k] ?? 0) > 0).map((k) => (
            <button
              key={k}
              className={offKinds.includes(k) ? 'off' : ''}
              title={offKinds.includes(k) ? '点一下重新显示' : '点一下隐藏这类条目'}
              onClick={() => toggleKind(k)}
            >
              {k} {kindCounts[k]}
            </button>
          ))}
          <span className="hint" style={{ marginLeft: 'auto' }}>
            只影响显示，内容都在
          </span>
        </div>
      ) : null}

      {/* 隐藏选中的类型：用注入规则而不是遍历 DOM，一次生效于所有小节 */}
      {offKinds.length > 0 ? (
        <style>{offKinds.map((k) => `.cheat-md li.ci[data-kind="${k}"]{display:none}`).join('')}</style>
      ) : null}

      {/*
        自备字体：只给**选中的那个**注入 @font-face。
        family 在前端本地派生（见 fontFamily），服务端那份只用于列表显示——
        这样「字体列表还没拉回来 / 拉失败」也不会挡住字体生效。
        字体栈里后面挂着 --font：字体缺字形（自制字体的生僻字）时自动回退系统字体，
        不会出现豆腐块。
      */}
      {fontFile && fontFamily ? (
        <style>
          {`@font-face{font-family:"${fontFamily}";src:url("${fontUrl(
            fontFile,
            picked?.addedAt,
          )}");font-display:swap;}
.cheat-md{font-family:"${fontFamily}",var(--font);}`}
        </style>
      ) : null}

      {units.map((u) => (
        <UnitCheat
          key={u.headingId}
          unit={u}
          section={byId.get(u.headingId)}
          open={Boolean(open[u.headingId])}
          onToggle={() => setOpen((s) => ({ ...s, [u.headingId]: !s[u.headingId] }))}
          onJumpToQuote={onCheatClick}
          onTreeClick={onTreeClick}
          onJumpSection={() => {
            const bi = biOfHeading(blocks, u.headingId);
            if (bi !== null) scrollToBlock(bi);
          }}
          busy={busy}
        />
      ))}

      {confirmDelFont ? (
        <Modal title="删除字体" onClose={() => setConfirmDelFont(null)}>
          <p>
            会从字体库里移除「{confirmDelFont.label}」（{Math.round(confirmDelFont.size / 1024 / 1024 * 10) / 10} MB）。
            知识树会自动回到默认字体，内容不受影响。想要的话可以再传一次。
          </p>
          <div className="modal-foot">
            <button className="btn" onClick={() => setConfirmDelFont(null)}>
              取消
            </button>
            <button
              className="btn danger"
              onClick={() => {
                const f = confirmDelFont;
                setConfirmDelFont(null);
                void (async () => {
                  try {
                    const r = await api.deleteFont(f.file);
                    setFonts(r.fonts);
                    if (fontFile === f.file) chooseFont('');
                  } catch (err) {
                    actions.toast('error', errorText(err));
                  }
                })();
              }}
            >
              删除
            </button>
          </div>
        </Modal>
      ) : null}

      {confirmClear ? (
        <Modal title="清空知识树" onClose={() => setConfirmClear(false)}>
          <p>会删掉这篇文章的 {sections.length} 节知识树，闪卡和批注不受影响。</p>
          <div className="modal-foot">
            <button className="btn" onClick={() => setConfirmClear(false)}>
              取消
            </button>
            <button
              className="btn danger"
              onClick={() => {
                setConfirmClear(false);
                void actions.deleteCheatsheet();
              }}
            >
              清空
            </button>
          </div>
        </Modal>
      ) : null}
    </>
  );
}

/**
 * 覆盖率标签：小抄的引文碰到了这一节多少内容块。
 *
 * ★ 为什么要显示这个 ★
 *   「这一节小抄质量如何」以前只能凭感觉说 —— 生成完数据就丢了，
 *   离线探针也只读得到 markdown。把覆盖率落盘并显示出来之后，
 *   哪一节漏得厉害一眼可见，也能直接对着它决定该重跑哪节。
 */
function CoverTag({ stats }: { stats: CheatsheetStats }) {
  const rate = Math.round((stats.covered / stats.blocks) * 100);
  const level = rate >= 70 ? 'high' : rate >= 50 ? 'mid' : 'low';
  const parts = [`小抄的引文覆盖了原文 ${stats.covered}/${stats.blocks} 个内容块`];
  if (stats.gateBackfill) parts.push(`覆盖率质量门已补采 ${stats.gateBackfill} 次`);
  if (stats.collected) parts.push(`采集到 ${stats.collected} 条（含重复），判据丢掉 ${stats.dropped ?? 0} 条`);
  if (stats.windows && stats.windows > 1) parts.push(`拆成 ${stats.windows} 个采集窗口`);
  if (stats.mergeRounds) {
    parts.push(`这一节太长，合并时分 ${stats.mergeRounds} 轮批内归并再收口（实测比一次收口覆盖率高）`);
  }
  if (stats.calls) parts.push(`共 ${stats.calls} 次模型调用`);
  if (stats.hl) parts.push(`你的高亮覆盖 ${stats.hl.covered}/${stats.hl.total} 处`);
  return (
    <span className={`study-tag cov-${level}`} title={parts.join('；')}>
      覆盖 {rate}%
    </span>
  );
}

/** 知识树/条目两套呈现的切换条。有树的节默认展示知识树（多鱼拍板的方向）。 */
function UnitCheat({
  unit,
  section,
  open,
  onToggle,
  onJumpToQuote,
  onTreeClick,
  onJumpSection,
  busy,
}: {
  unit: StudyUnit;
  section: CheatsheetSection | undefined;
  open: boolean;
  onToggle: () => void;
  onJumpToQuote: (e: React.MouseEvent<HTMLDivElement>) => void;
  onTreeClick: (e: React.MouseEvent<HTMLDivElement>) => void;
  onJumpSection: () => void;
  busy: boolean;
}) {
  const { actions } = useApp();
  // ★ 小抄下岗（多鱼 09-20 晚拍板）★ 树是唯一呈现形态，条目/md 视图已退场。
  //   没有树的旧节回退显示旧 html（存量数据只读，不再提供条目生成入口）。
  const [mode, setMode] = useState<'tree' | 'mm'>('tree');
  const hasTree = Boolean(section?.treeHtml);
  const hostCls = hasTree ? `kt-host${mode === 'mm' ? ' kt-as-mm' : ''}` : '';

  return (
    <div className={`study-card${open ? ' open' : ''}`}>
      <div className="study-card-head">
        <button className="study-caret" onClick={onToggle} title={open ? '收起' : '展开'}>
          <ChevronRight />
        </button>
        <button className="study-card-title" onClick={onJumpSection} title="跳到正文这一节">
          {unit.headingText}
        </button>
        {section ? (
          <>
            {section.tree ? <span className="study-tag ok" title="这一节有知识树（按知识点关系组织）">树</span> : null}
            <span className="study-tag ok" title={`由 ${section.model} 生成于 ${new Date(section.generatedAt).toLocaleString('zh-CN')}`}>
              已生成
            </span>
          </>
        ) : (
          <span className="study-tag">未生成</span>
        )}
      </div>

      {open ? (
        <div className="study-card-body">
          {section ? (
            <>
              {hasTree ? (
                <div className="cheat-viewbar">
                  <span className="cheat-seg">
                    <button className={mode === 'tree' ? 'on' : ''} onClick={() => setMode('tree')} title="按知识点关系组织的展开树">
                      知识树
                    </button>
                    <button className={mode === 'mm' ? 'on' : ''} onClick={() => setMode('mm')} title="结构总览（不含细节）">
                      导图
                    </button>
                  </span>
                  {section.tree?.locate ? (
                    <span className="study-note" style={{ marginLeft: 'auto' }}>
                      引文定位 {section.tree.locate.located}/{section.tree.locate.total}
                    </span>
                  ) : null}
                </div>
              ) : null}
              <div
                className={`cheat-md ${hostCls}`.trim()}
                data-hid={section.headingId}
                onClick={hasTree ? onTreeClick : onJumpToQuote}
                dangerouslySetInnerHTML={{ __html: hasTree ? (section.treeHtml ?? '') : (section.html ?? '') }}
              />
              <div className="study-actions">
                <button className="btn sm" disabled={busy} onClick={() => void actions.generateTree(unit.headingId, Boolean(section.tree))}>
                  <Wand /> {section.tree ? '重新生成知识树' : '生成知识树'}
                </button>
                {/*
                  ★ 转闪卡挂的是 tree，不是 items ★
                  旧条件是 `section.items`——小抄退役后全库 items 非空的节 = 0，
                  那个按钮一个都按不出来。现在只有知识树是持续产出的东西，所以改挂它。
                */}
                {section.tree?.nodes?.length ? (
                  <button className="btn sm" disabled={busy} onClick={() => void actions.cardsFromTree(unit.headingId)}>
                    <Cards /> 转闪卡
                  </button>
                ) : null}
                <span style={{ flex: 1 }} />
                <button className="btn ghost icon sm" title="删掉这一节知识树" onClick={() => void actions.deleteCheatsheet(unit.headingId)}>
                  <Trash />
                </button>
              </div>
            </>
          ) : (
            // ★ 小抄下岗 ★ 未生成的节直接生成知识树，不再引导先跑条目管线。
            <div className="study-actions">
              <button className="btn primary sm" disabled={busy} onClick={() => void actions.generateTree(unit.headingId, false)}>
                <Wand /> 生成知识树
              </button>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

// ─────────────────────────── 测验 ───────────────────────────

function QuizTab({
  units,
  quizzes,
  blocks,
  busy,
}: {
  units: StudyUnit[];
  quizzes: Quiz[];
  blocks: Block[];
  busy: boolean;
}) {
  const { actions } = useApp();
  const [count, setCount] = useState(3);
  const [active, setActive] = useState<Quiz | null>(null);

  const byHeading = useMemo(() => {
    const m = new Map<string, Quiz>();
    for (const q of quizzes) m.set(q.headingId, q);
    return m;
  }, [quizzes]);

  if (active) {
    return <QuizRunner quiz={active} blocks={blocks} onExit={() => setActive(null)} />;
  }

  return (
    <>
      <div className="study-bar">
        <span className="study-label">每题出题数</span>
        {[1, 2, 3].map((n) => (
          <button key={n} className={`study-chip${count === n ? ' on' : ''}`} onClick={() => setCount(n)}>
            {n}
          </button>
        ))}
      </div>

      {quizzes.length === 0 ? (
        <div className="empty">
          <QuizIcon width={22} height={22} />
          <h3>还没有测验</h3>
          <p>选一节点「出题」，AI 会按这一节的原文出 {count} 道题，做完立刻判分。</p>
        </div>
      ) : null}

      {units.map((u) => {
        const qz = byHeading.get(u.headingId);
        const last = qz?.attempts?.[qz.attempts.length - 1];
        return (
          <div className="study-card" key={u.headingId}>
            <div className="study-card-head">
              <button
                className="study-card-title"
                onClick={() => {
                  const bi = biOfHeading(blocks, u.headingId);
                  if (bi !== null) scrollToBlock(bi);
                }}
                title="跳到正文这一节"
              >
                {u.headingText}
              </button>
              {qz ? <span className="study-tag ok">{qz.questions.length} 题</span> : <span className="study-tag">未出题</span>}
            </div>
            <div className="study-card-body">
              {last ? <div className="study-note">上次得分 {last.score} 分（{last.total} 题）</div> : null}
              <div className="study-actions">
                {qz ? (
                  <button className="btn primary sm" onClick={() => setActive(qz)}>
                    <QuizIcon /> 开始答题
                  </button>
                ) : null}
                <button className="btn sm" disabled={busy} onClick={() => void actions.generateQuiz(u.headingId, count)}>
                  {qz ? <Refresh /> : <Wand />} {qz ? '重新出题' : '出题'}
                </button>
                {qz ? (
                  <>
                    <span style={{ flex: 1 }} />
                    <button className="btn ghost icon sm" title="删掉这份测验" onClick={() => void actions.deleteQuiz(qz.id)}>
                      <Trash />
                    </button>
                  </>
                ) : null}
              </div>
            </div>
          </div>
        );
      })}
    </>
  );
}

const TYPE_LABEL: Record<QuizQuestion['type'], string> = {
  single: '单选',
  multi: '多选',
  blank: '填空',
  short: '简答',
};

/** 答题 + 判分。答完不重拉整篇文档，只把判分结果和新的历史成绩同步回来。 */
function QuizRunner({ quiz, blocks, onExit }: { quiz: Quiz; blocks: Block[]; onExit: () => void }) {
  const { actions } = useApp();
  const [answers, setAnswers] = useState<Record<string, (number | string)[]>>({});
  const [result, setResult] = useState<AttemptResult | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const startedAt = useRef(Date.now());

  useEffect(() => {
    startedAt.current = Date.now();
  }, [quiz.id]);

  const setChoice = (qid: string, idx: number, multi: boolean) => {
    setAnswers((a) => {
      const cur = (a[qid] ?? []).map(Number);
      if (!multi) return { ...a, [qid]: [idx] };
      const next = cur.includes(idx) ? cur.filter((x) => x !== idx) : [...cur, idx];
      return { ...a, [qid]: next.sort((x, y) => x - y) };
    });
  };

  const setText = (qid: string, v: string) => setAnswers((a) => ({ ...a, [qid]: [v] }));

  const submit = async () => {
    setSubmitting(true);
    const r = await actions.submitQuiz({
      quizId: quiz.id,
      answers,
      durationMs: Date.now() - startedAt.current,
    });
    setSubmitting(false);
    if (r) setResult(r);
  };

  const answeredCount = quiz.questions.filter((q) => (answers[q.id] ?? []).length > 0).length;

  return (
    <>
      <div className="study-bar">
        <button className="btn ghost sm" onClick={onExit}>
          ← 返回
        </button>
        <span className="study-label">{quiz.headingText}</span>
        <span style={{ flex: 1 }} />
        <span className="study-note">
          {answeredCount}/{quiz.questions.length} 已答
        </span>
      </div>

      {result ? (
        <div className={`quiz-score${result.score >= 80 ? ' good' : result.score >= 60 ? '' : ' bad'}`}>
          <b>{result.score}</b>
          <span>分 · 共 {result.total} 题</span>
          <button className="btn sm" onClick={() => setResult(null)}>
            再看一遍题目
          </button>
        </div>
      ) : null}

      {quiz.questions.map((q, qi) => {
        const given = answers[q.id] ?? [];
        const res = result?.perQuestion.find((p) => p.id === q.id);
        const locked = Boolean(result);
        const expectText = res
          ? q.type === 'single' || q.type === 'multi'
            ? res.expected.map((i) => q.options[Number(i)] ?? String(i)).join('、')
            : res.expected.join(' / ')
          : '';

        return (
          <div className={`quiz-q${res ? (res.correct ? ' right' : ' wrong') : ''}`} key={q.id}>
            <div className="quiz-q-head">
              <span className="study-tag">{TYPE_LABEL[q.type]}</span>
              <span className="quiz-q-i">{qi + 1}</span>
              <span className="quiz-q-stem">{q.stem}</span>
            </div>

            {q.type === 'single' || q.type === 'multi' ? (
              <div className="quiz-options">
                {q.options.map((opt, oi) => {
                  const picked = given.map(Number).includes(oi);
                  const isAnswer = res ? res.expected.map(Number).includes(oi) : false;
                  return (
                    <label key={oi} className={`quiz-opt${picked ? ' picked' : ''}${res && isAnswer ? ' answer' : ''}`}>
                      <input
                        type={q.type === 'single' ? 'radio' : 'checkbox'}
                        name={q.id}
                        checked={picked}
                        disabled={locked}
                        onChange={() => setChoice(q.id, oi, q.type === 'multi')}
                      />
                      <span>{opt}</span>
                    </label>
                  );
                })}
              </div>
            ) : (
              <input
                className="input"
                value={String(given[0] ?? '')}
                disabled={locked}
                placeholder={q.type === 'blank' ? '填入答案' : '用自己的话回答'}
                onChange={(e) => setText(q.id, e.target.value)}
              />
            )}

            {res ? (
              <div className="quiz-explain">
                <div className={res.correct ? 'ok' : 'bad'}>
                  {res.correct ? '答对了' : res.partial > 0 ? `部分正确（${Math.round(res.partial * 100)}%）` : '答错了'}
                  {res.correct ? null : <> · 正确答案：{expectText}</>}
                </div>
                {q.explain ? <div className="quiz-explain-text">{q.explain}</div> : null}
                {q.citations.length ? (
                  <div className="quiz-cites">
                    {q.citations.map((c, ci) => (
                      <button
                        key={ci}
                        className="cite-link"
                        title="跳到正文"
                        onClick={() => scrollToBlock(c.blockIndex >= 0 ? c.blockIndex : biOfHeading(blocks, quiz.headingId) ?? 0)}
                      >
                        “{c.quote}”
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}

      {!result ? (
        <div className="study-bar">
          <button className="btn primary" disabled={submitting || answeredCount === 0} onClick={() => void submit()}>
            {submitting ? '判分中…' : '交卷'}
          </button>
          {answeredCount < quiz.questions.length ? <span className="study-note">还有 {quiz.questions.length - answeredCount} 题没答</span> : null}
        </div>
      ) : (
        <div className="study-bar">
          <button className="btn" onClick={() => void actions.generateQuiz(quiz.headingId, quiz.questions.length)}>
            <Refresh /> 换一批题
          </button>
        </div>
      )}
    </>
  );
}

// ─────────────────────────── 闪卡 ───────────────────────────


function CardsTab({
  cards,
  units,
  busy,
  docTitle,
  docRel,
}: {
  cards: Card[];
  units: StudyUnit[];
  busy: boolean;
  docTitle: string;
  docRel: string;
}) {
  const { actions } = useApp();
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  /**
   * 复习队列的**快照**。
   *
   * 以前直接把 `due` 这个活数组传给 Reviewer：复习一张 → sidecar 更新 →
   * `due` 重算把这张剔掉、数组短一格，而 Reviewer 里的下标同时 +1 →
   * 隔一张跳一张。分组之后「复习某个组」会更频繁，这个坑必须填掉。
   */
  const [session, setSession] = useState<Card[] | null>(null);
  const [sessionTitle, setSessionTitle] = useState('');
  const [adding, setAdding] = useState(false);
  const [exportingAll, setExportingAll] = useState(false);
  /**
   * ★ 节级考频（挂组徽章用）★
   * 与树上的徽章、左栏「今天」是同一份 service、同一份签名缓存，不会两处算出不同。
   * 拉不到就退化成「不显示徽章」，复习功能不受影响。
   */
  const [freq, setFreq] = useState<Map<string, { level: number; marks: number; companies: number }>>(new Map());
  useEffect(() => {
    let alive = true;
    if (!docRel) return;
    void api
      .frequencyTop(6, docRel)
      .then((r) => {
        if (!alive) return;
        setFreq(new Map(r.sections.map((s) => [s.headingId, { level: s.level, marks: s.marks, companies: s.companies }])));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [docRel]);
  const today = localDate();

  const groups = useMemo(
    () => buildGroups(cards, units, today, freq),
    [cards, units, today, freq],
  );
  const dueAll = useMemo(() => cards.filter((c) => !c.suspended && c.sm2.dueAt <= today), [cards, today]);
  const fresh = useMemo(() => cards.filter((c) => c.sm2.repetitions === 0), [cards]);

  // 只有一个组时不再多套一层：直接进组内，也不显示返回按钮
  const single = groups.length === 1;
  const activeKey = single ? groups[0]?.key : openGroup;
  const active = activeKey == null ? null : groups.find((g) => g.key === activeKey) ?? null;

  const startReview = (list: Card[], title: string) => {
    if (!list.length) return;
    setSession(list.slice());
    setSessionTitle(title);
  };

  const exportThis = () => {
    const { text, count, warnings } = buildAnkiText(cards);
    if (!count) {
      actions.toast('error', '这篇文章还没有可导出的卡片');
      return;
    }
    downloadText(ankiFileName(docTitle || '本文'), text);
    actions.toast('ok', `已导出 ${count} 张卡。Anki 导入时选「基本」笔记类型、分隔符用制表符、勾上「允许 HTML」。`);
    for (const w of warnings) actions.toast('error', w);
  };

  const exportAll = async () => {
    setExportingAll(true);
    try {
      const { cards: all, total } = await api.allCards();
      if (!all.length) {
        actions.toast('error', '笔记库里还没有任何卡片');
        return;
      }
      const { text, count, warnings } = buildAnkiText(all);
      downloadText(ankiFileName('整个笔记库'), text);
      actions.toast(
        'ok',
        `已导出全库 ${count} 张卡${total > 5000 ? '（卡很多，建议分批导入）' : ''}。` +
          'Anki 导入时选「基本」笔记类型、分隔符用制表符、勾上「允许 HTML」。',
      );
      for (const w of warnings) actions.toast('error', w);
    } catch (e) {
      actions.toast('error', errorText(e));
    } finally {
      setExportingAll(false);
    }
  };

  if (session) return <Reviewer queue={session} title={sessionTitle} onExit={() => setSession(null)} />;

  if (active) {
    return (
      <CardGroupView
        group={active}
        canBack={!single}
        onBack={() => setOpenGroup(null)}
        onReview={() => startReview(dueOf(active, today), `${docTitle} · ${active.title}`)}
      />
    );
  }

  return (
    <>
      <div className="study-stats">
        <Stat n={cards.length} label="本篇卡" />
        {/* ★ 口径标注（2026-10-11 统一行动清单）★ 左栏「今天」是全库统一口径；
            这里只数本篇——以前两边都叫「今日到期」，她分不清哪个是哪个。 */}
        <Stat n={dueAll.length} label="本篇到期" accent={dueAll.length > 0} />
        <Stat n={fresh.length} label="未学过" />
      </div>

      <div className="study-bar">
        <button
          className="btn primary sm"
          disabled={dueAll.length === 0}
          onClick={() => startReview(dueAll, docTitle)}
        >
          <Cards /> 复习本篇{dueAll.length ? `（${dueAll.length}）` : ''}
        </button>
        <button className="btn sm" disabled={busy} onClick={() => void actions.cardsFromNotes()}>
          <Wand /> 批注转闪卡
        </button>
        <button className="btn ghost icon sm" title="手写一张卡片" onClick={() => setAdding(true)}>
          <Plus />
        </button>
      </div>

      <div className="study-bar">
        <button className="btn sm" disabled={cards.length === 0} onClick={exportThis} title="导出成 Anki 能直接导入的文本">
          <Download /> 导出本文（{cards.length}）
        </button>
        <button
          className="btn sm"
          disabled={exportingAll}
          onClick={() => void exportAll()}
          title="导出笔记库里所有文章的卡片"
        >
          <Download /> {exportingAll ? '正在导出…' : '导出整个笔记库'}
        </button>
      </div>

      {cards.length === 0 ? (
        <div className="empty">
          <Cards width={22} height={22} />
          <h3>还没有闪卡</h3>
          <p>
            两条路子：在「知识树」页找到有树的节，点那节的「转闪卡」（整棵树会拆成卡片）；
            或者在正文里写下你的批注，然后点上面的「批注转闪卡」。
          </p>
          <p style={{ color: 'var(--text-3)' }}>也可以直接手写一张。</p>
        </div>
      ) : (
        <div className="card-groups">
          {groups.map((g) => (
            <button key={g.key} className="card-group" onClick={() => setOpenGroup(g.key)}>
              <div className="card-group-main">
                <span className="card-group-title">{g.title}</span>
                {/* 考频徽章：与树上的徽章同一套档位。挂组不挂卡——考频是节的属性。 */}
                {g.freqLevel > 0 ? (
                  <span
                    className="kt-freq"
                    data-lv={g.freqLevel}
                    title={`这一节的内容在面经里被问过 ${g.freqMarks} 次，涉及 ${g.freqCompanies} 家公司`}
                  >
                    {'●'.repeat(g.freqLevel)}
                    {'○'.repeat(3 - g.freqLevel)}
                  </span>
                ) : null}
                <span className="study-note">
                  {g.cards.length} 张 · {g.due > 0 ? `${g.due} 张到期` : '无到期'}
                </span>
              </div>
              <div className="group-progress" title={`已学过 ${g.learned} / ${g.cards.length}`}>
                <i style={{ width: `${g.cards.length ? (g.learned / g.cards.length) * 100 : 0}%` }} />
              </div>
              <ChevronRight width={14} height={14} />
            </button>
          ))}
        </div>
      )}

      {adding ? <AddCardDialog onClose={() => setAdding(false)} /> : null}
    </>
  );
}

function dueOf(g: CardGroup, today: string): Card[] {
  const d = g.cards.filter((c) => !c.suspended && c.sm2.dueAt <= today);
  // 没有到期卡时也能「提前过一遍」，否则点进组就是个死胡同
  return d.length ? d : g.cards.filter((c) => !c.suspended);
}

/** 组内视图：一张一张的卡片（原平铺列表搬到这里，逐字未改）。 */
function CardGroupView({
  group,
  canBack,
  onBack,
  onReview,
}: {
  group: CardGroup;
  canBack: boolean;
  onBack: () => void;
  onReview: () => void;
}) {
  const { actions } = useApp();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  /** ▽ 反馈理由框的显隐（点 ▽ 选中时出现；保存/取消后收起） */
  const [whyVisible, setWhyVisible] = useState<Record<string, boolean>>({});
  const today = localDate();
  const queue = dueOf(group, today);
  // 一组里没有到期卡时不要做成死胡同，允许「提前过一遍」
  const inAdvance = group.cards.every((c) => c.suspended || c.sm2.dueAt > today);

  /** 三件套标注：再点同一个 = 取消。信号写回卡上，供后续生成闪卡对齐偏好。 */
  const markFb = (c: Card, mark: 'up' | 'down' | 'dup') => {
    const next = c.fb === mark ? null : mark;
    setWhyVisible((s) => ({ ...s, [c.id]: mark === 'down' && next !== null }));
    void actions.cardFeedback(c.id, next);
  };

  return (
    <>
      <div className="study-bar">
        {canBack ? (
          <button className="btn ghost sm" onClick={onBack}>
            <ArrowLeft /> 全部章节
          </button>
        ) : null}
        <span style={{ flex: 1 }} />
        <span className="study-note">{group.cards.length} 张</span>
      </div>

      <div className="study-bar">
        <button className="btn primary sm" disabled={queue.length === 0} onClick={onReview}>
          <Cards /> {inAdvance ? '提前过一遍' : '开始复习'}（{queue.length || group.cards.length}）
        </button>
      </div>

      {group.cards.map((c) => (
        <div className={`study-card${open[c.id] ? ' open' : ''}`} key={c.id}>
          <div className="study-card-head">
            <button className="study-caret" onClick={() => setOpen((s) => ({ ...s, [c.id]: !s[c.id] }))}>
              <ChevronRight />
            </button>
            <span className="study-card-title plain">{c.front}</span>
            <span className={`study-tag${c.suspended ? '' : c.sm2.dueAt <= today ? ' ok' : ''}`}>
              {c.suspended ? '已暂停' : c.sm2.repetitions === 0 ? '新卡' : c.sm2.dueAt <= today ? '今日到期' : c.sm2.dueAt.slice(5)}
            </span>
          </div>
          {open[c.id] ? (
            <div className="study-card-body">
              <div className="card-back">{c.back}</div>
              <div className="study-note">
                {group.title} · 学过 {c.sm2.repetitions} 次 · 间隔 {c.sm2.interval} 天
              </div>
              <div className="study-actions">
                <button className="btn sm" onClick={() => void actions.reviewCard(c.id, 'forgot')}>
                  忘了
                </button>
                <button className="btn sm" onClick={() => void actions.reviewCard(c.id, 'good')}>
                  记住了
                </button>
                <span style={{ flex: 1 }} />
                <span className={`card-fb${c.fb ? ' marked' : ''}`}>
                  <button data-mark="up" className={c.fb === 'up' ? 'on' : ''} title="有用（这张卡帮我记住了）" onClick={() => markFb(c, 'up')}>
                    ▲
                  </button>
                  <button data-mark="down" className={c.fb === 'down' ? 'on' : ''} title="反馈（这张卡有什么问题，可填理由）" onClick={() => markFb(c, 'down')}>
                    ▽
                  </button>
                  <button data-mark="dup" className={c.fb === 'dup' ? 'on' : ''} title="重复（和其他卡意思撞了）" onClick={() => markFb(c, 'dup')}>
                    ⧉
                  </button>
                </span>
                <button className="btn ghost icon sm" title="删除这张卡" onClick={() => void actions.deleteCard(c.id)}>
                  <Trash />
                </button>
              </div>
              {c.fb === 'down' && whyVisible[c.id] ? (
                <input
                  className="fb-why-in"
                  defaultValue={c.fbWhy ?? ''}
                  placeholder="有什么反馈？（回车保存，不填可直接继续点）"
                  onBlur={(e) => {
                    // 空着点别处 = 只是关掉框，down 标记保留
                    if (!e.currentTarget.value.trim() && !c.fbWhy) setWhyVisible((s) => ({ ...s, [c.id]: false }));
                  }}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter') return;
                    const why = e.currentTarget.value.trim();
                    setWhyVisible((s) => ({ ...s, [c.id]: false }));
                    void actions.cardFeedback(c.id, 'down', why || undefined);
                  }}
                />
              ) : null}
            </div>
          ) : null}
        </div>
      ))}
    </>
  );
}

function Stat({ n, label, accent }: { n: number; label: string; accent?: boolean }) {
  return (
    <div className="study-stat">
      <b style={accent ? { color: 'var(--accent)' } : undefined}>{n}</b>
      <span>{label}</span>
    </div>
  );
}

/** 复习模式：一次一张，先看正面，自己想完再翻面打分。 */
function Reviewer({ queue, title, onExit }: { queue: Card[]; title?: string; onExit: () => void }) {
  const { actions } = useApp();
  const [i, setI] = useState(0);
  const [showBack, setShowBack] = useState(false);
  const [done, setDone] = useState(0);
  const [grading, setGrading] = useState(false);

  if (queue.length === 0) {
    return (
      <div className="empty">
        <Check width={22} height={22} />
        <h3>今天没有要复习的卡</h3>
        <p>到期的卡都过完了，明天再来。</p>
        <button className="btn" onClick={onExit}>
          返回
        </button>
      </div>
    );
  }

  if (i >= queue.length) {
    return (
      <div className="empty">
        <Check width={22} height={22} />
        <h3>这一轮复习完了</h3>
        <p>共过了 {done} 张。系统已按你的掌握程度安排下次出现的时间。</p>
        <button className="btn primary" onClick={onExit}>
          完成
        </button>
      </div>
    );
  }

  const card = queue[i];

  const grade = async (g: 'forgot' | 'hard' | 'good') => {
    if (grading) return;
    setGrading(true);
    await actions.reviewCard(card.id, g);
    setGrading(false);
    setShowBack(false);
    setDone((d) => d + 1);
    setI((n) => n + 1);
  };

  return (
    <div className="reviewer">
      <div className="study-bar">
        <button className="btn ghost sm" onClick={onExit}>
          退出
        </button>
        {title ? <span className="study-note ellipsis">{title}</span> : null}
        <span style={{ flex: 1 }} />
        <span className="study-note">
          {i + 1} / {queue.length}
        </span>
      </div>

      <div className="review-card">
        <div className="review-side">
          <span className="study-tag">正面</span>
          <div className="review-text">{card.front}</div>
        </div>
        {showBack ? (
          <div className="review-side back">
            <span className="study-tag ok">背面</span>
            <div className="review-text">{card.back}</div>
          </div>
        ) : null}
      </div>

      {/* 原文引文在翻面后才出现——正面就给原文等于提前泄答案 */}
      {showBack && card.source.quote ? (
        <div className="study-note cite">原文：“{card.source.quote}”</div>
      ) : null}

      {!showBack ? (
        <button className="btn primary" onClick={() => setShowBack(true)}>
          显示答案
        </button>
      ) : (
        <div className="review-grades">
          <button className="btn danger" disabled={grading} onClick={() => void grade('forgot')}>
            忘了
          </button>
          <button className="btn" disabled={grading} onClick={() => void grade('hard')}>
            有点难
          </button>
          <button className="btn primary" disabled={grading} onClick={() => void grade('good')}>
            记住了
          </button>
        </div>
      )}
    </div>
  );
}

function AddCardDialog({ onClose }: { onClose: () => void }) {
  const { actions } = useApp();
  const [front, setFront] = useState('');
  const [back, setBack] = useState('');
  const ok = front.trim() && back.trim();

  return (
    <Modal title="手写一张闪卡" onClose={onClose}>
      <div className="field">
        <label>正面（问题）</label>
        <input className="input" value={front} onChange={(e) => setFront(e.target.value)} placeholder="动态规划的两个前提是什么？" />
      </div>
      <div className="field">
        <label>背面（答案）</label>
        <textarea className="input" rows={4} value={back} onChange={(e) => setBack(e.target.value)} placeholder="最优子结构 与 重叠子问题" />
      </div>
      <div className="modal-foot">
        <button className="btn" onClick={onClose}>
          取消
        </button>
        <button
          className="btn primary"
          disabled={!ok}
          onClick={() => {
            void actions.createCard({ front: front.trim(), back: back.trim() });
            onClose();
          }}
        >
          添加
        </button>
      </div>
    </Modal>
  );
}
