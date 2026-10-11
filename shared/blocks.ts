/**
 * shared/blocks.ts —— 把 Markdown 变成「块序列」。
 *
 * 这是服务端模块（import 了 markdown-it），前端**不要**直接 import 这个文件，
 * 只 import 它的类型和 ./text 里的东西。原因：前端不需要自己渲染 markdown
 * （服务端已经把 html 一起返回了），没必要把 markdown-it 打进客户端包。
 *
 * ★ 维护红线 ★
 * 1. 只允许通过 createMd() 创建 markdown-it 实例，且**严禁**注册任何会改变
 *    「可见文本」的插件（emoji、typographer、脚注重排、外链图标、CRLF 转换……）。
 *    一旦引入，前端 buildBlockMap 重建出来的归一化文本就会和后端 blocks.text
 *    差几个字符，整套锚点体系会静默漂移。
 * 2. blocks.text 的抽取与归一化规则必须与 src/hooks/buildBlockMap.ts 逐字符对齐。
 * 3. 每个 inline token 都会在其「最近的未被隐藏的容器 token」上写 data-bi 属性，
 *    渲染后即成为 DOM 上的 data-bi，前端靠它把 TextQuoteSelector 反查回 DOM。
 */

import MarkdownIt from 'markdown-it';
import katex from 'katex';
import {
  type Block,
  type BlockType,
  type Chapter,
  type DocAnalysis,
  type StudyUnit,
  normalizeText,
  shortHash,
} from './text';

/** markdown-it Token 的最小结构描述，避免依赖它内部模块的路径。 */
interface Tok {
  type: string;
  tag: string;
  nesting: number;
  content: string;
  children: Tok[] | null;
  hidden: boolean;
  attrs: [string, string][] | null;
  attrSet(name: string, value: string): void;
}

/**
 * 全项目唯一的 markdown-it 实例工厂。
 * 配置一旦改动，所有已存在的锚点都需要重跑一遍（不改可见文本的配置除外）。
 */

// ─────────────────────── 公式渲染（2026-10-10） ───────────────────────

/**
 * 开关：`NB_MATH=1` 时注册公式插件；**默认 off**——行为与没有这个功能逐字节相同。
 *
 * ★ 为什么默认关（2026-10-10 对账探针的结论，不是拍脑袋）★
 *   全库 5 份既有文档（jly/ReAct 等）存在「半吞半漏」的 $ 序列：`$ π(a∣s) $` 带空格
 *   被拒收、`$ μ(a∣s)$` 被吞成公式 → 相邻 `**` 的配对关系改变 → em/strong 边界移动
 *   → 既有块的可见文本变化 → 锚点漂移。在她的重度标注库上不能接受，等文档级开关
 *   方案拍板后再逐文档开启。
 *
 * ★ 为什么用环境变量 ★ 同 NB_UNIT_REPLAN：shared/blocks.ts 是纯服务端模块，
 * 前后端 flag 不会不一致；且 tsx watch 的环境变量在父进程启动时定死，
 * 改开关必须彻底重启服务（scripts/unit-flag-check.ts 同款约束）。
 */
export function mathOn(): boolean {
  return process.env.NB_MATH === '1';
}

/** HTML 属性转义（data-tex 要把公式源码原样放进属性里）。 */
function escapeAttr(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

/** KaTeX 渲染；失败时降级成 code，绝不抛出（一篇文档里一条坏公式不能炸全篇渲染）。 */
function katexHtml(tex: string, display: boolean): string {
  try {
    return katex.renderToString(tex, {
      displayMode: display,
      throwOnError: false,
      strict: false,
      trust: false,
      output: 'htmlAndMathml',
    });
  } catch {
    const shown = escapeAttr(display ? `$$${tex}$$` : `$${tex}$`);
    return `<code class="ktx-fail">${shown}</code>`;
  }
}

/**
 * 公式可见文本的**唯一规范**（服务端与前端 buildBlockMap 必须一致）：
 *   行内公式 → `$tex$`；行间公式块 → `$$tex$$`（多行 tex 的空白按 normalizeText 规则折叠）。
 * 服务端 extractInlineText / annotateBlocks 和前端 collectItems 都按这个字符串记账，
 * 高亮/批注的偏移才能在公式两侧不漂移。
 */
const CANON = {
  inline: (tex: string): string => `$${tex}$`,
  block: (tex: string): string => `$$${tex}$$`,
};

/**
 * 极简数学插件（不引第三方 markdown 扩展）。
 *
 * ★ 为什么必须注册在 'escape' 之前 ★
 *   markdown-it 的 escape 规则会把 `\{` → `{`、行尾 `\\` → `\` 吃掉，`&` 会渲染成 `&amp;`。
 *   公式必须在转义之前整段被抢走，否则 KaTeX 拿到的源码就已经错了。
 *
 * ★ 锚点契约 ★
 *   渲染出的 `.ktx` 元素带 data-tex（dollar 包裹的规范文本）；前端 buildBlockMap
 *   遇到 .ktx 取 data-tex、跳过 KaTeX 内部 DOM。两边的文本贡献严格相等。
 */
function mathPlugin(md: MarkdownIt): void {
  md.inline.ruler.before('escape', 'math_inline', (state, silent) => {
    const start = state.pos;
    if (state.src.charCodeAt(start) !== 0x24) return false; // $
    if (state.src.charCodeAt(start + 1) === 0x24) return false; // $$ 交给块级
    let end = start + 1;
    while (end < state.posMax) {
      const ch = state.src.charCodeAt(end);
      if (ch === 0x5c) {
        end += 2; // 跳过 \{ \} 这类转义，别把 \} 里的 } 当正文
        continue;
      }
      if (ch === 0x0a) return false; // 行内公式不跨行
      if (ch === 0x24) break;
      end++;
    }
    if (end >= state.posMax || state.src.charCodeAt(end) !== 0x24) return false;
    const content = state.src.slice(start + 1, end);
    if (!content.trim()) return false;
    if (/^\s|\s$/.test(content)) return false; // `$ 5` 这种当普通文本，别误吞成公式
    if (!silent) {
      const token = state.push('math_inline', 'math', 0);
      token.content = content;
      token.markup = '$';
    }
    state.pos = end + 1;
    return true;
  });

  md.block.ruler.before('fence', 'math_block', (state, startLine, endLine, silent) => {
    const start = state.bMarks[startLine] + state.tShift[startLine];
    const max = state.eMarks[startLine];
    if (state.src.slice(start, start + 2) !== '$$') return false;
    if (silent) return true;
    let content = state.src.slice(start + 2, max);
    let nextLine = startLine;
    if (content.trim().endsWith('$$') && content.trim().length > 2) {
      // 单行 $$...$$
      content = content.trim().replace(/\$\$$/, '');
      nextLine += 1;
    } else {
      const lines: string[] = [];
      if (content.trim()) lines.push(content);
      for (nextLine = startLine + 1; nextLine < endLine; nextLine++) {
        const s = state.bMarks[nextLine] + state.tShift[nextLine];
        const e = state.eMarks[nextLine];
        const line = state.src.slice(s, e);
        if (line.trim() === '$$') {
          nextLine += 1;
          break;
        }
        lines.push(line);
      }
      content = lines.join('\n');
    }
    const token = state.push('math_block', 'math', 0);
    token.content = content.trim();
    token.markup = '$$';
    token.map = [startLine, nextLine];
    state.line = nextLine;
    return true;
  });

  md.renderer.rules.math_inline = (tokens, idx) => {
    const tex = tokens[idx].content;
    return `<span class="ktx" data-tex="${escapeAttr(CANON.inline(tex))}">${katexHtml(tex, false)}</span>`;
  };
  md.renderer.rules.math_block = (tokens, idx) => {
    const tex = tokens[idx].content;
    // ★ annotateBlocks 把 data-bi 写在 math_block token 上，自定义渲染必须把它带出来
    //   （默认渲染器靠 renderAttrs 输出 token.attrs，自定义规则漏了它行间公式就不再是块）
    const attrs = md.renderer.renderAttrs(tokens[idx]);
    return `<div class="ktx ktx-block" data-tex="${escapeAttr(CANON.block(tex))}"${attrs ? ` ${attrs}` : ''}>${katexHtml(tex, true)}</div>\n`;
  };
}

export function createMd(): MarkdownIt {
  const md = new MarkdownIt({
    html: false, // 不解析原始 HTML：避免可见文本出现两种来源，也避免 XSS
    linkify: true, // 裸 URL 变链接，不改变可见文本
    breaks: false, // 单换行不产生 <br>，渲染成 \n → 归一化成空格
    typographer: false, // ★ 会改可见文本（引号、省略号），必须关
    xhtmlOut: false,
    langPrefix: 'language-',
  });
  if (mathOn()) md.use(mathPlugin);
  return md;
}

// ─────────────────────── inline 文本抽取 ───────────────────────

/**
 * 从一个 inline token 里抽出「渲染后看得见的文字」。
 *
 * 规则（与 buildBlockMap 的预期一致）：
 *   text / code_inline → 原样
 *   math_inline → `$tex$`（公式规范文本，与前端 buildBlockMap 对 .ktx[data-tex] 的
 *     记账一致——KaTeX 渲染出的内部 DOM 不算可见文本）
 *   softbreak / hardbreak → 一个空格
 *   image → alt 文本（内容），不含图片路径
 *   link_open / link_close / strong / em → 只是标记，本身不出文字
 *   html_inline → 丢弃
 */
function extractInlineText(tok: Tok): string {
  let out = '';
  const kids = tok.children ?? [];
  for (const c of kids) {
    switch (c.type) {
      case 'text':
      case 'code_inline':
        out += c.content;
        break;
      case 'math_inline':
        out += CANON.inline(c.content);
        break;
      case 'softbreak':
      case 'hardbreak':
        out += ' ';
        break;
      case 'image':
        out += c.content ?? '';
        break;
      default:
        break;
    }
  }
  return out;
}

// ─────────────────────── 主流程 ───────────────────────

/** 容器 token 的 tag → 块类型。返回 null 表示这个容器不产出块。 */
function containerBlockType(tag: string): BlockType | null {
  switch (tag) {
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return tag as BlockType;
    case 'p':
      return 'p';
    case 'li':
      return 'li';
    case 'td':
      return 'td';
    case 'th':
      return 'th';
    default:
      return null; // blockquote / ul / ol / table 等纯容器，块由它们内部产出
  }
}

/**
 * 遍历 token 流，产出 blocks，并**就地**给容器 token 写上 data-bi 属性。
 * @param tokens md.parse() 的结果（会被修改）
 */
function annotateBlocks(tokens: Tok[]): {
  blocks: Block[];
  chapters: Chapter[];
} {
  const blocks: Block[] = [];
  const chapters: Chapter[] = [];
  const stack: Tok[] = [];
  /** 当前生效的标题链 */
  const headingStack: { level: number; text: string; headingId: string; bi: number }[] = [];
  /** 同名同层级标题的出现计数，用于生成唯一 headingId */
  const headingSeen = new Map<string, number>();
  let cursor = 0; // docPlain 偏移累加器

  const emit = (type: BlockType, raw: string, container: Tok | null, extra: Partial<Block>) => {
    const text = normalizeText(raw);
    if (!text) {
      // 空块（纯空白段落、只有图片没 alt 等）：不产出块，也不写 data-bi
      return -1;
    }
    const bi = blocks.length;
    const blk: Block = {
      bi,
      type,
      depth: extra.depth ?? 0,
      text,
      offset: cursor,
      ...extra,
    };
    cursor += text.length + 1; // join('\n')
    blocks.push(blk);
    if (container) container.attrSet('data-bi', String(bi));
    return bi;
  };

  const depthOf = (st: Tok[]): number => {
    let d = 0;
    for (const t of st) {
      if (t.type === 'bullet_list_open' || t.type === 'ordered_list_open') d++;
    }
    return d;
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];

    // 折叠掉的紧凑列表段落：不参与栈，块归属到外层的 <li>
    if (t.hidden) continue;

    if (t.nesting === 1) {
      stack.push(t);
      continue;
    }
    if (t.nesting === -1) {
      stack.pop();
      continue;
    }

    // ── 行间公式块：整块算一个，可见文本 = `$$tex$$`（规范见 CANON 注释）
    if (t.type === 'math_block') {
      emit('p', CANON.block(t.content), t, { depth: depthOf(stack) });
      continue;
    }

    // ── 代码块：整块算一个，内部不再细分偏移
    if (t.type === 'fence' || t.type === 'code_block') {
      emit('code', t.content, t, { depth: depthOf(stack) });
      continue;
    }

    // ── inline：由最近的容器决定块类型
    if (t.type === 'inline') {
      const parent = stack[stack.length - 1];
      if (!parent) continue;
      const btype = containerBlockType(parent.tag);
      if (!btype) continue;

      const depth = depthOf(stack);

      if (btype === 'h1' || btype === 'h2' || btype === 'h3' || btype === 'h4' || btype === 'h5' || btype === 'h6') {
        const level = Number(btype[1]);
        const text = normalizeText(extractInlineText(t));
        if (!text) continue;

        while (headingStack.length && headingStack[headingStack.length - 1].level >= level) {
          headingStack.pop();
        }
        const key = `${level}:${text}`;
        const order = headingSeen.get(key) ?? 0;
        headingSeen.set(key, order + 1);
        const headingId = `h-${shortHash(key)}${order > 0 ? `-${order}` : ''}`;
        const headingPath = headingStack.map((h) => h.text);

        const bi = emit(btype, text, parent, { depth, headingId, headingPath, order });
        if (bi < 0) continue;

        headingStack.push({ level, text, headingId, bi });
        chapters.push({ headingId, level, text, headingPath, order, bi, endBi: -1 });
        continue;
      }

      emit(btype, extractInlineText(t), parent, { depth });
      continue;
    }
  }

  // 补齐每个标题的管辖范围：到下一个「同级或更高级」标题为止
  for (let i = 0; i < chapters.length; i++) {
    let end = blocks.length;
    for (let j = i + 1; j < chapters.length; j++) {
      if (chapters[j].level <= chapters[i].level) {
        end = chapters[j].bi;
        break;
      }
    }
    chapters[i].endBi = end;
  }

  return { blocks, chapters };
}

/**
 * 学习单元重划（2026-09-20，多鱼第 1 问）。
 *
 * ★ 要解决什么 ★
 *   原来「一个 h2 = 一个学习单元」。实测全库 65 节里 43 节不足 5 分钟
 *   （`加载检查点`、`优点：` 这种原文小标题机械切出来的碎片）、6 节超过 15 分钟
 *   （chapter3「超越扁平文本」32.5 分钟、chapter1「Harness 工程」27.9 分钟）。
 *   多鱼给的复习预算是 **5–15 分钟/节** —— 旧划分几乎一节都对不上。
 *
 * ★ 怎么重划 ★
 *   太长 → 按原文**自己的下一层标题**切（她说「按内部逻辑关系拆」，原文的组织方式
 *          比模型自己想的可靠），仍超目标的再按块贪心切。
 *   太短 → 相邻单元合并（切和并必须成对：只切不并会把「不足 5 分钟」从 39 个
 *          推到 50 个，切分自己在制造碎片）。
 *
 * ★ 为什么不会破坏原文定位 ★
 *   切分点、合并点**永远落在块边界（bi）上**，startBi/endBi 语义不变 →
 *   引文回跳、高亮定位、检索分片全部照旧。
 *
 * ★ 代价（为什么默认关闭）★
 *   切分出的第 2+ 段、被合并单元的非首节，id 与存量 sidecar 的 section.headingId
 *   对不上 → 开了必须配合重生成。所以默认关，行为与改动前逐字节相同。
 */
const READING_CPM = 300; // 中文默读字/分钟（含思考停顿），与 scripts/section-budget.ts 同口径
const UNIT_MAX_MIN = 15; // 多鱼给的预算上限（分钟）
const UNIT_MIN_MIN = 5; // 预算下限：低于此时长的相邻单元尝试合并
const UNIT_TARGET_CHARS = UNIT_MAX_MIN * READING_CPM;
const UNIT_MIN_CHARS = UNIT_MIN_MIN * READING_CPM;
/** 贪心下限：子标题段累不到目标的 0.7 就接着吃下一段 */
const UNIT_GREEDY_FLOOR = UNIT_TARGET_CHARS * 0.7;

/**
 * 重划开关。★ 为什么用环境变量 ★ 它同时要影响服务端全部调用点和 scripts 探针，
 * 显式传参会有 20+ 处容易漏。shared/blocks.ts 是纯服务端模块
 * （前端 import 它会把 markdown-it 打进客户端包，见 src/components/StudyPanel.tsx），
 * 不存在前后端 flag 不一致的问题。
 */
function unitReplanOn(): boolean {
  return process.env.NB_UNIT_REPLAN === '1';
}

/** 一段区间的正文字数（标题块不算正文）。 */
function bodyCharsOf(blocks: Block[], from: number, to: number): number {
  let n = 0;
  for (const b of blocks) if (b.bi >= from && b.bi < to && !b.headingId) n += b.text.length;
  return n;
}

interface UnitSeg extends StudyUnit {
  chars: number;
}

/** 把一个超长单元按内部子标题切开；不超目标就原样返回（一段）。 */
function splitLongUnit(u: StudyUnit, chapters: Chapter[], blocks: Block[]): UnitSeg[] {
  const total = bodyCharsOf(blocks, u.startBi, u.endBi);
  const whole: UnitSeg = {
    headingId: u.headingId,
    headingText: u.headingText,
    level: u.level,
    startBi: u.startBi,
    endBi: u.endBi,
    headingIds: u.headingIds ?? [u.headingId],
    path: u.path ?? unitHeadingPath(chapters, u.headingId),
    chars: total,
  };
  // ★ 只在超目标时才切（v1 的教训）★
  //   曾经无论大小都切到所有子标题，结果 65 节 → 1487 段，全是 2 分钟的碎片。
  //   切分要解决的是「一段读 28 分钟」，不是「越细越好」。
  if (total <= UNIT_TARGET_CHARS) return [whole];

  // 候选边界优先用**下一层**标题（h3 之于 h2）；没有才退到更深的
  let subs = chapters.filter((c) => c.level === u.level + 1 && c.bi > u.startBi && c.bi < u.endBi);
  if (!subs.length) subs = chapters.filter((c) => c.level > u.level && c.bi > u.startBi && c.bi < u.endBi);
  // 一个子标题都没有 → 没法按逻辑切，退到按块切（下面的循环会处理）
  const bounds = [u.startBi, ...subs.map((c) => c.bi), u.endBi];

  const segs: UnitSeg[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const from = bounds[i];
    const to = bounds[i + 1];
    if (to <= from) continue;
    const chars = bodyCharsOf(blocks, from, to);
    if (!chars) continue; // 纯标题区间，没有正文

    const head = i === 0 ? null : subs[i - 1];
    const seg: UnitSeg = {
      // 段 0 从单元起点开始 → 沿用原 id（存量 section 靠它还能认回来）
      // 段 k 从某个子标题开始 → 用那个子标题的 id（unitHeadingPath 直接可用）
      headingId: head ? head.headingId : u.headingId,
      headingText: head ? `${u.headingText} · ${head.text}` : u.headingText,
      level: head ? head.level : u.level,
      startBi: from,
      endBi: to,
      // ★ 每一段都保留原单元 id ★
      //   h2 后面直接跟 h3 时，「段 0」的正文是空的会被跳过（if (!chars) continue），
      //   那时若段 k 不带原 id，存量的那个 h2 section 就彻底失联了。
      //   `unitForHeadingId` 是按数组顺序 find，所以原 id 仍会优先命中段 0 —— 行为确定。
      headingIds: head ? [u.headingId, head.headingId] : [u.headingId],
      path: head ? [...head.headingPath, head.text] : whole.path,
      chars,
    };
    const last = segs[segs.length - 1];
    if (last && last.chars < UNIT_GREEDY_FLOOR) {
      // 太短 → 并进前一段（「导言 + 第一个子标题」本来就是一回事）
      last.endBi = to;
      last.chars += chars;
      last.headingIds = [...(last.headingIds ?? []), ...(seg.headingIds ?? [])];
      continue;
    }
    segs.push(seg);
  }

  // 单段仍超目标（某个子标题下本身就是一大段）→ 按块贪心切
  const out: UnitSeg[] = [];
  for (const s of segs) {
    if (s.chars <= UNIT_TARGET_CHARS) {
      out.push(s);
      continue;
    }
    let part = 1;
    let cur: UnitSeg = { ...s, headingText: `${s.headingText}（${part}）`, endBi: s.startBi, chars: 0 };
    for (const b of blocks) {
      if (b.bi < s.startBi || b.bi >= s.endBi || b.headingId) continue;
      if (cur.chars > 0 && cur.chars + b.text.length > UNIT_TARGET_CHARS) {
        cur.endBi = b.bi;
        out.push(cur);
        part++;
        cur = {
          ...s,
          headingId: `${s.headingId}~${part}`,
          headingText: `${s.headingText}（${part}）`,
          startBi: b.bi,
          endBi: s.endBi,
          chars: 0,
        };
      }
      cur.chars += b.text.length;
    }
    if (cur.chars > 0) out.push(cur);
  }
  return out;
}

/** 把相邻的碎片单元合并：任一段不足下限、合起来不超上限、且区间相接。 */
function mergeShortUnits(units: UnitSeg[], blocks: Block[]): StudyUnit[] {
  const out: UnitSeg[] = [];
  for (const u of units) {
    const last = out[out.length - 1];
    if (last && last.endBi === u.startBi) {
      const lc = bodyCharsOf(blocks, last.startBi, last.endBi);
      const uc = bodyCharsOf(blocks, u.startBi, u.endBi);
      // ★ 开篇不参与合并 ★ 渲染层靠 headingId === '__preamble__' 识别它
      const preamble = last.headingId === '__preamble__' || u.headingId === '__preamble__';
      if (!preamble && (lc < UNIT_MIN_CHARS || uc < UNIT_MIN_CHARS) && lc + uc <= UNIT_TARGET_CHARS) {
        last.endBi = u.endBi;
        last.chars = lc + uc;
        last.headingIds = [...(last.headingIds ?? [last.headingId]), ...(u.headingIds ?? [u.headingId])];
        continue;
      }
    }
    out.push({ ...u, headingIds: u.headingIds ?? [u.headingId] });
  }
  // UnitSeg 的 chars 是内部量，不落进 StudyUnit；headingIds 去重（段与段之间会重叠保留祖先 id）
  return out.map(({ chars: _chars, ...u }) => ({
    ...u,
    headingIds: [...new Set(u.headingIds ?? [u.headingId])],
  }));
}

/**
 * 一个 section 属于哪个学习单元。
 * 先按主 id 找；找不到再按「覆盖的标题 id」找 —— 合并单元的非首节
 * （存量 section 是那个旧的 h2 id）靠这一步才能认回来。
 */
export function unitForHeadingId(units: StudyUnit[], headingId: string): StudyUnit | undefined {
  return units.find((u) => u.headingId === headingId) ?? units.find((u) => u.headingIds?.includes(headingId));
}

/** 依 chapters 推导出小抄 / quiz 的生成单位（基线划分，不含重划）。 */
function deriveBaseUnits(chapters: Chapter[], blocks: Block[]): StudyUnit[] {
  const deep = chapters.filter((c) => c.level >= 2);
  if (deep.length === 0) {
    return [
      {
        headingId: '__root__',
        headingText: '全文',
        level: 0,
        startBi: 0,
        endBi: blocks.length,
      },
    ];
  }
  const unitLevel = Math.min(...deep.map((c) => c.level));
  const units: StudyUnit[] = deep
    .filter((c) => c.level === unitLevel)
    .map((c) => ({
      headingId: c.headingId,
      headingText: c.text,
      level: c.level,
      startBi: c.bi,
      endBi: c.endBi,
    }));

  // 第一个单元之前的正文（文章开头的引言）单独成一个小节。
  //
  // 但要注意：光有一个 h1 文档标题也算「第一个单元之前」，如果为此生成一个
  // 只含标题的「开篇」单元，用户会看到一个内容为空的小抄，纯属噪音。
  // 所以只在前面确实有**成段的正文**时才加这个单元。
  if (units.length && units[0].startBi > 0) {
    const preambleText = blocks
      .slice(0, units[0].startBi)
      .filter((b) => !b.headingId)
      .map((b) => b.text)
      .join('');
    if (preambleText.length >= 20) {
      units.unshift({
        headingId: '__preamble__',
        headingText: '开篇',
        level: 0,
        startBi: 0,
        endBi: units[0].startBi,
      });
    }
  }
  return units;
}

/** 小抄 / quiz 的生成单位。默认走基线划分；`NB_UNIT_REPLAN=1` 时按内容量重划。 */
function deriveUnits(chapters: Chapter[], blocks: Block[]): StudyUnit[] {
  const base = deriveBaseUnits(chapters, blocks);
  if (!unitReplanOn()) return base;
  const segs = base.flatMap((u) => splitLongUnit(u, chapters, blocks));
  return mergeShortUnits(segs, blocks);
}

/** 只要结构分析，不要 HTML。 */
export function analyzeDocument(markdown: string): DocAnalysis {
  const md = createMd();
  const tokens = md.parse(markdown, {}) as unknown as Tok[];
  const { blocks, chapters } = annotateBlocks(tokens);
  return {
    blocks,
    chapters,
    units: deriveUnits(chapters, blocks),
    docPlain: blocks.map((b) => b.text).join('\n'),
  };
}

/**
 * 把图片 token 的相对路径换成应用内的资源地址，并顺带补上真实像素尺寸。
 *
 * 必须在 **token 层** 改，不能用正则替换渲染后的 HTML：这本书里有 103 段代码围栏，
 * 围栏里全是 `![](...)` 这类 markdown 示例文本，正则会把它们一并改成真图片。
 * token 层只动真正会被渲染成 `<img>` 的那个 token。
 *
 * ⚠️ 只允许改 src / loading / decoding / width / height，
 * **alt 一个字都不许动**：`block.text` 取的就是 alt，动一下整篇文档的锚点都会漂。
 *
 * ★ width / height 为什么必须由这里补 ★
 *   CSS 是 `max-width:100%; height:auto`。没有宽高属性时，图片下载完成前占位高度为 0，
 *   几百张图全挤在视口顶部 → 全部落进 lazy 的阈值 → 一次性把整个目录下下来
 *   （实测一篇 769 张图 = 177MB）。有了宽高，浏览器才知道每张图落在第几屏，
 *   `loading="lazy"` 才真的开始工作。
 */
function rewriteImageSrc(
  tokens: Tok[],
  docRel: string,
  sizer?: (ref: string) => { width: number; height: number } | null,
): void {
  const walk = (list: Tok[] | null) => {
    for (const t of list ?? []) {
      if (t.type === 'image') {
        const raw = t.attrs?.find(([k]) => k === 'src')?.[1] ?? '';
        if (raw && !isRemoteSrc(raw)) {
          // ★ 必须用改写**前**的 raw 去查表：缓存的 key 就是原始引用
          const size = sizer?.(raw) ?? null;
          t.attrSet('src', `/asset?doc=${encodeURIComponent(docRel)}&ref=${encodeURIComponent(raw)}`);
          // 这几个属性都不产生文本节点，不影响锚点
          t.attrSet('loading', 'lazy');
          t.attrSet('decoding', 'async');
          if (size && size.width > 0 && size.height > 0) {
            t.attrSet('width', String(size.width));
            t.attrSet('height', String(size.height));
          }
        }
      }
      // 图片可能嵌在链接里：[![alt](img)](url)，必须走 children
      walk(t.children);
    }
  };
  walk(tokens);
}

function isRemoteSrc(src: string): boolean {
  return (
    /^(https?:)?\/\//i.test(src) || // http(s) 与协议相对
    /^data:/i.test(src) ||
    /^mailto:/i.test(src) ||
    /^#/.test(src) ||
    /^\//.test(src) // 已经是站内绝对路径
  );
}

/** 分析 + 渲染成 HTML（HTML 里已经带好 data-bi）。 */
export function renderDocument(
  markdown: string,
  opts: {
    docRel?: string;
    /**
     * 由服务端注入：按**改写前的原始引用**同步查尺寸缓存，查不到返回 null。
     * 为什么是注入而不是 import：本文件是共享层，前端也会用到它的类型，
     * 直接 import 服务端模块会把 node:fs 拖进依赖图。
     */
    imageSizer?: (ref: string) => { width: number; height: number } | null;
  } = {},
): { html: string; analysis: DocAnalysis } {
  const md = createMd();
  const tokens = md.parse(markdown, {}) as unknown as Tok[];
  const { blocks, chapters } = annotateBlocks(tokens);
  // docRel 为空（比如预览一段还没落盘的文本）就保持原样，不去拼资源地址
  if (opts.docRel) rewriteImageSrc(tokens, opts.docRel, opts.imageSizer);
  const html = md.renderer.render(tokens as never, md.options, {});
  return {
    html,
    analysis: {
      blocks,
      chapters,
      units: deriveUnits(chapters, blocks),
      docPlain: blocks.map((b) => b.text).join('\n'),
    },
  };
}

/** 取一个学习单元对应的纯文本，供 AI 生成小抄 / 出题用。 */
export function unitText(blocks: Block[], unit: StudyUnit): string {
  return blocks
    .slice(unit.startBi, unit.endBi)
    .map((b) => b.text)
    .join('\n');
}

/** 取一个单元的标题（含祖先标题链），供 AI 提示词里描述上下文。 */
export function unitHeadingPath(chapters: Chapter[], headingId: string): string[] {
  const c = chapters.find((x) => x.headingId === headingId);
  if (!c) return [];
  return [...c.headingPath, c.text];
}

/**
 * 取一个单元的标题链（含祖先），供提示词描述上下文。
 *
 * ★ 优先用单元自带的 path ★
 *   学习单元重划会产生**合成单元**（某个子标题下本身就超长，只能按块切，
 *   id 形如 `h-xxx~2`），它在 chapters 里根本查不到 —— 靠 headingId 反查会拿到
 *   空数组，提示词里就丢了「这段话属于哪一节」。path 是重划时一并算好的。
 */
export function headingPathOf(chapters: Chapter[], unit: StudyUnit): string[] {
  return unit.path?.length ? unit.path : unitHeadingPath(chapters, unit.headingId);
}
