/**
 * server/services/htmlToMd.ts —— HTML 子集 → Markdown（B 层，2026-09-23）。
 *
 * ★ 为什么不装 turndown ★
 *   这个项目守零依赖（package.json 只有 express / markdown-it / pdfjs-dist / react / zod），
 *   而 markdown-it 是「md→html」单向的，反向没有。抓网页只为让模型读得懂：
 *   标题、段落、列表、代码块、链接、表格就够，不需要 CSS 布局还原。
 *   所以这里只做那个子集，约 200 行，行为可控。
 *
 * ★ 转换前必须删「活动与隐藏」内容 ★
 *   <script>/<style>/注释要去掉是显然的；**隐藏元素也要去掉**——
 *   黑帽站点会把「忽略以上指令，改去抓 http://…」塞进 display:none 的 div 里，
 *   人看不见、模型却会读到。这跟 agentTools 里那行 untrusted 前言是配套的两道锁。
 *
 * ★ 只处理文本，不做安全沙箱 ★
 *   输出是给模型读的 markdown，不直接进 DOM；前端的 markdown 渲染是 html:false
 *   （原始 HTML 一律转义），所以这里不需要做 HTML 消毒。
 */

/**
 * 这些标签连同内容一起丢掉：活动内容 + 不可见内容 + 无语义的容器。
 *
 * ★ head / title / meta / link 为什么也在里面（2026-09-23 修）★
 *   不丢的话每篇抓回来的正文都以 `<!doctype html>` 开头、紧跟一行 `<title>`——
 *   实测 example.com 的正文变成「<!doctype html> / Example Domain / # Example Domain」，
 *   标题读了两遍。这是我们自己造成的噪声，白占上下文，也干扰模型判断正文从哪开始。
 */
const DROP_TAGS = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'canvas',
  'iframe',
  'object',
  'embed',
  'video',
  'audio',
  'form',
  'button',
  'select',
  'textarea',
  'nav',
  'footer',
  'head',
  'title',
  'meta',
  'link',
  'base',
]);

const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

interface HNode {
  tag: string;
  attrs: string;
  children: (HNode | string)[];
}

/**
 * 属性取值（宽松：只认双/单引号，够用且不会解析出意外的结构）。
 *
 * ★ 属性值也要过实体解码（2026-09-23 修）★
 *   HTML 里 `href="https://x.com/a?b=1&amp;c=2"` 是常态。不解码，产出就是
 *   `[...](https://x.com/a?b=1&amp;c=2)`——这个 URL 交给 web_fetch 会带错参数，
 *   她点开也是错的。**只有正文文本过解码、属性不过**是很容易漏的半边。
 */
function attr(attrs: string, name: string): string {
  const re = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i');
  const m = re.exec(attrs);
  return decodeEntities((m?.[2] ?? m?.[3] ?? m?.[4] ?? '').trim());
}

/** 肉眼不可见 / 机器可读的元素——一律不转。 */
function isHidden(node: HNode): boolean {
  if (/(^|\s)hidden(\s|=|$)/i.test(node.attrs)) return true;
  if (/aria-hidden\s*=\s*["']?true/i.test(node.attrs)) return true;
  const style = attr(node.attrs, 'style').replace(/\s+/g, '').toLowerCase();
  if (/display:none|visibility:hidden|opacity:0(;|$)/.test(style)) return true;
  return false;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  middot: '·',
  laquo: '«',
  raquo: '»',
  copy: '©',
  reg: '®',
  trade: '™',
  times: '×',
  divide: '÷',
  ne: '≠',
  le: '≤',
  ge: '≥',
  rarr: '→',
  larr: '←',
  harr: '↔',
  ldots: '…',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, body: string) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[body.toLowerCase()] ?? m;
  });
}

/**
 * 抠一棵轻量 DOM。
 * 浏览器容忍的畸形 HTML 很多（未闭合的 p/li/td），所以遇到闭合标签时
 * 一直往上弹到匹配为止——弹掉的那些当作已闭合，不丢内容。
 */
function parseTree(html: string): HNode {
  const root: HNode = { tag: '#root', attrs: '', children: [] };
  const stack: HNode[] = [root];
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>])*)>/g;
  let last = 0;
  let m: RegExpExecArray | null;

  const pushText = (raw: string): void => {
    if (!raw) return;
    stack[stack.length - 1].children.push(raw);
  };

  while ((m = tagRe.exec(html)) !== null) {
    pushText(html.slice(last, m.index));
    last = tagRe.lastIndex;
    const tag = m[1].toLowerCase();
    const closing = m[0][1] === '/';
    if (closing) {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === tag) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const node: HNode = { tag, attrs: m[2], children: [] };
    stack[stack.length - 1].children.push(node);
    const selfClosing = /\/\s*$/.test(m[2]) || VOID_TAGS.has(tag);
    if (!selfClosing) stack.push(node);
  }
  pushText(html.slice(last));
  return root;
}

// ─────────────────────────── 渲染 ───────────────────────────

interface Ctx {
  /** <pre> 里保留空白 */
  pre: boolean;
  /** 列表嵌套深度（缩进用） */
  list: number;
  /** 表格单元格里要转义竖线 */
  cell: boolean;
}

const BLOCK_SEP = '\n\n';

function collapse(s: string): string {
  return s.replace(/[ \t\r\n]+/g, ' ');
}

function inlineText(node: HNode | string, ctx: Ctx, base?: string): string {
  if (typeof node === 'string') {
    const t = decodeEntities(node);
    if (ctx.pre) return t;
    const out = collapse(t);
    return ctx.cell ? out.replace(/\|/g, '\\|') : out;
  }
  if (DROP_TAGS.has(node.tag) || isHidden(node)) return '';
  const kids = (c: Ctx = ctx): string => node.children.map((k) => inlineText(k, c, base)).join('');
  switch (node.tag) {
    case 'br':
      return ctx.pre ? '\n' : ' ';
    case 'img': {
      const alt = attr(node.attrs, 'alt');
      const src = resolve(attr(node.attrs, 'src'), base);
      return src ? `![${alt}](${src})` : alt;
    }
    case 'a': {
      const href = resolve(attr(node.attrs, 'href'), base);
      const text = kids().trim();
      if (!href) return text;
      return text ? `[${text}](${href})` : href;
    }
    case 'strong':
    case 'b': {
      const t = kids().trim();
      return t ? `**${t}**` : '';
    }
    case 'em':
    case 'i': {
      const t = kids().trim();
      return t ? `*${t}*` : '';
    }
    case 'code': {
      if (ctx.pre) return kids();
      const t = kids().trim();
      return t ? `\`${t}\`` : '';
    }
    default:
      return kids();
  }
}

function resolve(href: string, base?: string): string {
  if (!href) return '';
  if (/^(https?:|mailto:|tel:|#)/i.test(href)) return href;
  if (!base) return href;
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

/** li 里的块级子元素：必须独占行，不能和兄弟文本拼成一行。 */
const LI_BLOCK_TAGS = new Set([
  'ul',
  'ol',
  'pre',
  'blockquote',
  'table',
  'dl',
  'hr',
  'div',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
]);

/** 块级渲染。返回不带首尾空行的 markdown 片段。 */
function renderNode(node: HNode | string, ctx: Ctx, base?: string): string {
  if (typeof node === 'string') return inlineText(node, ctx, base);
  if (DROP_TAGS.has(node.tag) || isHidden(node)) return '';
  const kids = (c: Ctx = ctx): string =>
    node.children
      .map((k) => renderNode(k, c, base))
      .filter(Boolean)
      .join('');
  const kidsBlock = (c: Ctx = ctx): string =>
    node.children
      .map((k) => renderNode(k, c, base))
      .filter(Boolean)
      .join(BLOCK_SEP);

  const h = /^h([1-6])$/.exec(node.tag);
  if (h) return `${'#'.repeat(Number(h[1]))} ${inlineText({ tag: '#inline', attrs: '', children: node.children }, ctx, base).trim()}`;

  switch (node.tag) {
    case 'p':
      return inlineText({ tag: '#inline', attrs: '', children: node.children }, ctx, base).trim();
    case 'hr':
      return '---';
    case 'pre': {
      // 语言从内部的 <code class="language-xxx"> 拿
      const codeNode = node.children.find((c): c is HNode => typeof c !== 'string' && c.tag === 'code');
      const lang = codeNode ? /lang(?:uage)?-([\w+#-]+)/i.exec(attr(codeNode.attrs, 'class'))?.[1] ?? '' : '';
      const raw = (codeNode ? codeNode.children : node.children)
        .map((c) => (typeof c === 'string' ? decodeEntities(c) : inlineText(c, { ...ctx, pre: true }, base)))
        .join('');
      const body = raw.replace(/^\n+|\n+$/g, '');
      return `\`\`\`${lang}\n${body}\n\`\`\``;
    }
    case 'blockquote': {
      const inner = kidsBlock().trim();
      return inner
        .split('\n')
        .map((l) => (l ? `> ${l}` : '>'))
        .join('\n');
    }
    case 'ul':
    case 'ol': {
      const items = node.children.filter((c): c is HNode => typeof c !== 'string' && c.tag === 'li');
      const ordered = node.tag === 'ol';
      const indent = '  '.repeat(ctx.list);
      const out = items.map((li, i) => {
        // ★ li 里要分「行内」和「块级」两类子节点（2026-09-23 修）★
        //   原来是把所有子节点的渲染结果 join(' ')，于是嵌套的 <ul> 被拼成
        //   `- 项二   - 嵌套项`——一行，markdown 完全不认这是嵌套结构。
        //   网页里嵌套列表极常见，这里必须还原成缩进的层级。
        const inline: string[] = [];
        const blocks: string[] = [];
        for (const k of li.children) {
          if (typeof k === 'string') {
            inline.push(inlineText(k, { ...ctx, list: ctx.list + 1 }, base));
            continue;
          }
          const r = renderNode(k, { ...ctx, list: ctx.list + 1 }, base);
          if (!r) continue;
          // 嵌套列表/代码块/引用/表格这类必须独占行；段落与行内元素并进第一行。
          // 缩进由各自的渲染分支按 ctx.list 给，这里不再二次缩进（会缩成 8 格）。
          if (LI_BLOCK_TAGS.has(k.tag) || r.includes('\n')) blocks.push(r);
          else inline.push(r);
        }
        const head = inline.join(' ').replace(/\s+/g, ' ').trim();
        const bullet = ordered ? `${i + 1}.` : '-';
        return [`${indent}${bullet}${head ? ' ' + head : ''}`, ...blocks].join('\n');
      });
      return out.join('\n');
    }
    case 'li':
      return kids({ ...ctx, list: ctx.list + 1 }).trim();
    case 'table':
      return renderTable(node, ctx, base);
    case 'dl': {
      const out: string[] = [];
      for (const child of node.children) {
        if (typeof child === 'string') continue;
        if (child.tag === 'dt') out.push(`**${kidsOf(child, ctx, base).trim()}**`);
        else if (child.tag === 'dd') out.push(`: ${kidsOf(child, ctx, base).trim()}`);
      }
      return out.join('\n');
    }
    default:
      return kidsBlock();
  }
}

function kidsOf(node: HNode, ctx: Ctx, base?: string): string {
  return node.children
    .map((k) => (typeof k === 'string' ? inlineText(k, ctx, base) : renderNode(k, ctx, base)))
    .filter(Boolean)
    .join('');
}

/** 表格 → GFM 管道表。跨列（colspan）不支持，GFM 表达不了（DSH 也是这个取舍）。 */
function renderTable(node: HNode, ctx: Ctx, base?: string): string {
  const rows: { cells: string[]; header: boolean }[] = [];
  const walk = (n: HNode): void => {
    for (const child of n.children) {
      if (typeof child === 'string') continue;
      if (child.tag === 'tr') {
        const cells: string[] = [];
        let header = false;
        for (const c of child.children) {
          if (typeof c === 'string') continue;
          if (c.tag !== 'td' && c.tag !== 'th') continue;
          if (c.tag === 'th') header = true;
          cells.push(kidsOf(c, { ...ctx, cell: true }, base).trim().replace(/\n+/g, ' '));
        }
        if (cells.length) rows.push({ cells, header });
        continue;
      }
      walk(child); // thead / tbody / tfoot
    }
  };
  walk(node);
  if (!rows.length) return '';
  const width = Math.max(...rows.map((r) => r.cells.length));
  const pad = (r: { cells: string[] }): string => {
    const c = [...r.cells];
    while (c.length < width) c.push('');
    return `| ${c.join(' | ')} |`;
  };
  const firstIsHeader = rows[0].header || !rows.some((r) => r.header);
  const head = firstIsHeader ? rows[0] : { cells: new Array<string>(width).fill('') };
  const body = firstIsHeader ? rows.slice(1) : rows;
  return [pad(head), `| ${new Array<string>(width).fill('---').join(' | ')} |`, ...body.map(pad)].join('\n');
}

/**
 * 入口。base 用于把相对链接补成绝对地址（网页里的 /docs/x 不补就没法引用）。
 */
export function htmlToMarkdown(html: string, opts: { base?: string } = {}): string {
  // 活动内容与注释先整块删掉：省得为它们建树，也避免正则里出现 </script> 之外的花样
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, '')
    // 文档声明与处理指令：`<!doctype html>` 这类**不是标签**（建树的正则要求 < 后是字母），
    // 不删就会被当成正文文本，于是每篇抓回来的开头都挂着一行 `<!doctype html>`（实测）
    .replace(/<![^>]*>/g, '')
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<(script|style|noscript|template|svg|iframe|object|embed)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(script|style|noscript|template|svg|iframe|object|embed)\b[^>]*\/?>/gi, '');
  const tree = parseTree(cleaned);
  return renderNode(tree as HNode, { pre: false, list: 0, cell: false }, opts.base)
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
