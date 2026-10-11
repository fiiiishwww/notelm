/**
 * server/services/webFetch.ts —— 抓取的安全传输层（B 层，2026-09-23）。
 *
 * ★ 分层（对齐 DSH 的 dsh-web-fetch-http / dsh-tool-web）★
 *   这一层只管「安全地把一个 URL 的字节取回来」，**不管** HTML→Markdown
 *   （在 htmlToMd.ts）、也**不管**给模型看的措辞（在 agentTools 的 web_fetch 里）。
 *   分开的理由：run_code 注入、未来的 api_call 都要复用这条取回路径，
 *   混在一起就会长出第二份带安全漏洞的实现。
 *
 * ★ 防的是 SSRF，不是防模型调皮 ★
 *   一个能抓 URL 的 agent，如果不管住，最典型的翻车是被人（或网页里的提示注入）
 *   诱导去抓 `http://127.0.0.1:3000/api/...`——那是**我们自己的服务**，
 *   或者 `http://169.254.169.254/`（云元数据，能拿到实例凭据）。
 *   所以规则是硬的：**只解析一次主机名、任一解析结果不是公网单播就整条拒绝、
 *   把连接钉死在校验过的那个 IP 上**。三步缺一不可——
 *   只校验不钉定，DNS rebinding 会在第二次解析时把地址换成内网。
 *
 * ★ 非 2xx 是「结果」不是「错误」★
 *   404 / 403 是被抓资源的状态，属于信息：模型据此决定「换一个 URL 还是算了」。
 *   只有「没法安全取回」才抛 WebError（对齐 DSH 的语义）。
 */

import dns from 'node:dns';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { ApiError } from '../core';

/** 机器可路由的错误码（对齐 DSH 的 8 个）。 */
export type WebErrorCode =
  | 'WEB_INVALID_URL'
  | 'WEB_BLOCKED_URL'
  | 'WEB_FETCH_TOO_LARGE'
  | 'WEB_FETCH_TIMEOUT'
  | 'WEB_REDIRECT_BLOCKED'
  | 'WEB_UNSUPPORTED_CONTENT_TYPE'
  /** 探明是 PDF/文档直链——不是「抓不了」的错误，是「该走 MinerU 入库」的路标（save_web_file 用） */
  | 'WEB_IS_DOCUMENT'
  | 'WEB_ABORTED'
  | 'WEB_PROVIDER_ERROR';

/**
 * 抓取失败。继承 ApiError 是为了让 HTTP 层原样翻译成状态码 + 错误码，
 * 上层（工具层）再把 code 转成模型能读的 `Error: ...`。
 */
export class WebError extends ApiError {
  constructor(code: WebErrorCode, message: string, status = 400) {
    super(status, message, code);
  }
}

/** 上限属于**部署配置**，不暴露成模型参数（对齐 DSH：模型不该有改上限的能力）。 */
function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.round(v) : fallback;
}

export const WEB_LIMITS = {
  /** URL 长度上限 */
  maxUrlChars: () => envInt('NB_WEB_FETCH_MAX_URL_CHARS', 2048),
  /** 同源重定向跳数上限 */
  maxRedirects: () => envInt('NB_WEB_FETCH_MAX_REDIRECTS', 5),
  /** 响应体字节上限（硬中断，防一次抓爆内存） */
  maxResponseBytes: () => envInt('NB_WEB_FETCH_MAX_BYTES', 5_000_000),
  /** 解码后字符上限 */
  maxBodyChars: () => envInt('NB_WEB_FETCH_MAX_CHARS', 100_000),
  /** 单次抓取超时 */
  timeoutMs: () => envInt('NB_WEB_FETCH_TIMEOUT_MS', 30_000),
};

/** 匿名抓取：只带这三样，绝不带任何凭据。 */
const UA = 'NoteLM/0.1 (+local personal notebook)';
const ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,application/json;q=0.8,*/*;q=0.1';

// ─────────────────────────── 地址分类（SSRF 判据） ───────────────────────────

/** 点分十进制 → uint32；不合法返回 null。 */
export function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = (n * 256 + v) >>> 0;
  }
  return n >>> 0;
}

function intToV4(n: number): string {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

/** 明确不可去的 IPv4 段（私网 / 环回 / 链路本地 / CGNAT / 组播 / 保留 / 文档用）。 */
const V4_BLOCKED: [string, number][] = [
  ['0.0.0.0', 8], // "本网络"
  ['10.0.0.0', 8], // 私网
  ['100.64.0.0', 10], // CGNAT（Tailscale 的 100.x 就在这里）
  ['127.0.0.0', 8], // 环回
  ['169.254.0.0', 16], // 链路本地 + 云元数据 169.254.169.254
  ['172.16.0.0', 12], // 私网
  ['192.0.0.0', 24], // IETF 协议专用
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.168.0.0', 16], // 私网
  ['198.18.0.0', 15], // 基准测试
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // 组播
  ['240.0.0.0', 4], // 保留（含 255.255.255.255 广播）
];

export function isPublicV4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return false;
  for (const [base, bits] of V4_BLOCKED) {
    const b = ipv4ToInt(base);
    if (b === null) continue;
    const mask = bits >= 32 ? 0xffffffff : ((0xffffffff << (32 - bits)) >>> 0);
    if (((n & mask) >>> 0) === ((b & mask) >>> 0)) return false;
  }
  return true;
}

/** 把 IPv6 文本展开成 8 个 16 位组；内嵌的 IPv4（::ffff:1.2.3.4）会被折成两个组。 */
function expandV6(input: string): number[] | null {
  let s = input.trim();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  const pct = s.indexOf('%'); // 去 zone id（fe80::1%eth0）
  if (pct >= 0) s = s.slice(0, pct);
  // 尾部是点分 IPv4 → 换成两个十六进制组，后面的解析就统一了
  const lastColon = s.lastIndexOf(':');
  const tailRaw = s.slice(lastColon + 1);
  if (tailRaw.includes('.')) {
    const v4 = ipv4ToInt(tailRaw);
    if (v4 === null) return null;
    s = `${s.slice(0, lastColon + 1)}${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }

  const parts = s.split('::');
  if (parts.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (!part) return [];
    const out: number[] = [];
    for (const g of part.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  if (parts.length === 1) {
    const all = parse(parts[0]);
    return all && all.length === 8 ? all : null;
  }
  const l = parse(parts[0]);
  const r = parse(parts[1]);
  if (!l || !r) return null;
  const fill = 8 - l.length - r.length;
  if (fill < 0) return null;
  return [...l, ...new Array<number>(fill).fill(0), ...r];
}

export function isPublicV6(ip: string): boolean {
  const g = expandV6(ip);
  if (!g) return false;
  const isZero = (from: number, to: number): boolean => g.slice(from, to).every((v) => v === 0);
  if (isZero(0, 8)) return false; // ::
  if (isZero(0, 7) && g[7] === 1) return false; // ::1 环回
  const hi = g[0];
  if ((hi & 0xfe00) === 0xfc00) return false; // fc00::/7 唯一本地地址
  if ((hi & 0xffc0) === 0xfe80) return false; // fe80::/10 链路本地
  if ((hi & 0xff00) === 0xff00) return false; // ff00::/8 组播
  if (hi === 0x2001 && g[1] === 0x0db8) return false; // 2001:db8::/32 文档用
  // IPv4 映射 ::ffff:a.b.c.d / IPv4 兼容 ::a.b.c.d → 按里头的 v4 判
  if (isZero(0, 6) || (isZero(0, 5) && g[5] === 0xffff)) {
    const v4 = intToV4((((g[6] & 0xffff) << 16) | (g[7] & 0xffff)) >>> 0);
    return isPublicV4(v4);
  }
  // NAT64 / DNS64：64:ff9b::/96（内网 IPv4 会被转成公网 v6 地址，必须拆开看）
  if (g[0] === 0x64 && g[1] === 0xff9b && isZero(2, 6)) {
    const v4 = intToV4((((g[6] & 0xffff) << 16) | (g[7] & 0xffff)) >>> 0);
    return isPublicV4(v4);
  }
  return true;
}

/** 是不是「公网单播」。任何解析结果不是它，整条请求就拒绝。 */
export function isPublicAddress(ip: string): boolean {
  // net.isIP 返回 0/4/6（dns 模块没有这个函数）
  const family = net.isIP(ip);
  if (family === 4) return isPublicV4(ip);
  if (family === 6) return isPublicV6(ip);
  return false;
}

// ─────────────────────────── URL 校验 ───────────────────────────

export interface ParsedTarget {
  url: URL;
  origin: string;
}

/** 校验 URL：协议、内嵌凭据、长度。不做 DNS（那是取回时的事）。 */
export function validateUrl(raw: string): ParsedTarget {
  const s = (raw ?? '').trim();
  if (!s) throw new WebError('WEB_INVALID_URL', 'url 不能为空');
  if (s.length > WEB_LIMITS.maxUrlChars()) {
    throw new WebError('WEB_INVALID_URL', `url 太长（超过 ${WEB_LIMITS.maxUrlChars()} 字符）`);
  }
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new WebError('WEB_INVALID_URL', `不是合法的 URL：${s.slice(0, 120)}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new WebError('WEB_INVALID_URL', `只支持 http/https，收到的是 ${u.protocol.replace(':', '')}:`);
  }
  if (u.username || u.password) {
    throw new WebError('WEB_INVALID_URL', 'url 里不能带用户名/密码（抓取一律匿名，不带任何凭据）');
  }
  if (!u.hostname) throw new WebError('WEB_INVALID_URL', 'url 里没有主机名');

  // ★ 字面量 IP 必须在这一步拦死（实测漏洞，2026-09-23）★
  //   Node 的 net.connect 在「host 本身就是 IP」时会**跳过 dns.lookup 直接连**，
  //   我们钉在 lookup 上的那层公网校验根本不会被调用——实测
  //   `http://127.0.0.1:3000/api/notes` 真的连上了本机正在跑的这个服务。
  //   所以字面量 IP 只能在这里判死；非字面量的主机名才交给 pinnedLookup 去解析后校验。
  const hostIp = u.hostname.replace(/^\[|\]$/g, ''); // IPv6 的 hostname 带方括号
  if (net.isIP(hostIp) && !isPublicAddress(hostIp)) {
    throw new WebError('WEB_BLOCKED_URL', `${hostIp} 是内网/本机地址，已拒绝：抓取不允许指向本机或内网`);
  }
  return { url: u, origin: u.origin };
}

// ─────────────────────────── 取回 ───────────────────────────

export interface WebFetchResult {
  /** 跟随允许的重定向之后的最终 URL */
  finalUrl: string;
  /** HTTP 状态码。非 2xx 也是正常返回的结果 */
  status: number;
  contentType: string;
  /** html = 需要转换；text = 已经是纯文本 */
  kind: 'html' | 'text';
  body: string;
  truncated: boolean;
  bytes: number;
}

const HTML_TYPES = ['text/html', 'application/xhtml+xml'];
const TEXT_TYPES = [
  'text/plain',
  'text/markdown',
  'text/x-markdown',
  'application/json',
  'application/xml',
  'text/xml',
];

/** charset 只认 Content-Type 头（HTML 里的 <meta charset> 不看，对齐 DSH）。 */
function charsetOf(contentType: string): BufferEncoding {
  const m = /charset\s*=\s*"?([\w-]+)"?/i.exec(contentType);
  const cs = (m?.[1] ?? 'utf-8').toLowerCase();
  if (cs === 'utf-8' || cs === 'utf8') return 'utf8';
  if (cs === 'us-ascii' || cs === 'ascii') return 'ascii';
  if (cs === 'iso-8859-1' || cs === 'latin1' || cs === 'windows-1252') return 'latin1';
  throw new WebError(
    'WEB_UNSUPPORTED_CONTENT_TYPE',
    `页面声明了 ${cs} 编码，本机没有内置对应的解码器（支持 utf-8 / ascii / latin1）。`,
  );
}

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  truncated: boolean;
}

/**
 * 重定向是否放行。
 *
 * ★ 为什么不是「严格同源」★
 *   同源 = 协议 + 主机 + 端口全等。按这个尺度，`http://example.com` →
 *   `https://example.com`（全互联网最常见的一条重定向）会被当成跨站拒掉，
 *   报错还是「重定向到了另一个站点」——明明就是同一个站点。模型只能猜，
 *   白白多花一步。所以放行范围定为：
 *     1. 同一主机（含端口）且**协议不变** → 放行；
 *     2. 同一主机、http → https 的**升级** → 放行（更安全的那个方向）；
 *     3. 同主机但 https → http 的**降级** → 拒绝（不该因为一次重定向就把明文放行）；
 *     4. 换主机 → 拒绝（这条最关键：跨主机重定向是 SSRF 与钓鱼的常规跳板，
 *        而且它绕过了「她给的是哪个地址」这个前提）。
 */
export function isSameSiteRedirect(from: URL, to: URL): boolean {
  if (from.host !== to.host) return false;
  if (from.protocol === to.protocol) return true;
  return from.protocol === 'http:' && to.protocol === 'https:';
}

/**
 * 单跳请求。
 *
 * ★ 关键：lookup 是钉定用的 ★
 *   `http.request` 会通过 `lookup` 问「这个主机名该连哪个 IP」。我们在这里
 *   自己解析、只放行公网单播地址、并把它作为唯一答案返回——于是 socket
 *   连的就是我们校验过的那个 IP，中间没有第二次解析的机会（防 rebinding）。
 */
function requestOnce(target: ParsedTarget, timeoutMs: number, signal?: AbortSignal): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const maxBytes = WEB_LIMITS.maxResponseBytes();
    const mod = target.url.protocol === 'http:' ? http : https;

    /**
     * ★ 返回值的**形态**必须跟请求方要的一致（2026-09-23 实测踩到的坑）★
     *   Node 20+ 默认开着 Happy Eyeballs（`autoSelectFamily`），它会用
     *   `all: true` 调 lookup 并**期望一个数组** `[{address, family}]`；
     *   老路径（`all: false`）要的是标量 `(err, address, family)`。
     *   我们原来一律回标量，于是数组那条路径拿到的是字符串——
     *   节点内部逐项取 `addresses[i].address` 得到 undefined，
     *   最后抛出 `Invalid IP address: undefined`（一句和真实原因完全无关的报错，
     *   实测所有抓取 100% 失败）。所以这里按 `opts.all` 分派。
     */
    const pinnedLookup = (
      hostname: string,
      opts: unknown,
      cb: (err: NodeJS.ErrnoException | null, address: unknown, family: number) => void,
    ): void => {
      const wantAll = !!(opts as { all?: boolean } | undefined)?.all;
      dns.lookup(hostname, { all: true, verbatim: true }, (err, addrs) => {
        if (err) {
          cb(err, wantAll ? [] : '', 0);
          return;
        }
        const good = addrs.filter((a) => isPublicAddress(a.address));
        if (!good.length) {
          const e = new Error(
            `${hostname} 解析到的是内网/本机地址（${addrs.map((a) => a.address).join('、')}），已拒绝`,
          ) as NodeJS.ErrnoException;
          e.code = 'WEB_BLOCKED_URL';
          cb(e, wantAll ? [] : '', 0);
          return;
        }
        // family 在新版 Node 是数字、老版本是 'IPv4'/'IPv6'，两种都认
        const fam = (f: number | string): 4 | 6 => (f === 6 || f === 'IPv6' ? 6 : 4);
        if (wantAll) {
          cb(null, good.map((a) => ({ address: a.address, family: fam(a.family) })), 0);
          return;
        }
        cb(null, good[0].address, fam(good[0].family));
      });
    };

    const req = mod.request(
      target.url,
      {
        method: 'GET',
        headers: { 'User-Agent': UA, Accept: ACCEPT, 'Accept-Encoding': 'identity' },
        lookup: pinnedLookup as never,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        let settled = false;
        // 收尾只做一次：被字节上限打断时走的是 destroy()，'end' 可能不来、
        // 只来 'close'——所以 end/close 都挂上，靠 settled 去重。
        const done = (): void => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks), truncated });
        };
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > maxBytes) {
            truncated = true;
            res.destroy();
            return;
          }
          chunks.push(c);
        });
        res.on('end', done);
        res.on('close', done);
        res.on('error', (e) => {
          if (truncated) {
            done();
            return;
          }
          if (settled) return;
          settled = true;
          cleanup();
          reject(e);
        });
      },
    );

    req.setTimeout(timeoutMs, () => {
      const e = new WebError('WEB_FETCH_TIMEOUT', `抓取超时（${Math.round(timeoutMs / 1000)} 秒）`, 504);
      req.destroy(e);
    });
    const onAbort = (): void => {
      req.destroy(new WebError('WEB_ABORTED', '这次抓取被取消了', 499));
    };
    const cleanup = (): void => signal?.removeEventListener('abort', onAbort);
    signal?.addEventListener('abort', onAbort, { once: true });
    req.on('error', (e: Error) => {
      cleanup();
      if (e instanceof WebError) {
        reject(e);
        return;
      }
      if ((e as NodeJS.ErrnoException).code === 'WEB_BLOCKED_URL') {
        reject(new WebError('WEB_BLOCKED_URL', e.message));
        return;
      }
      if (e.name === 'AbortError') {
        reject(new WebError('WEB_FETCH_TIMEOUT', `抓取超时（${Math.round(timeoutMs / 1000)} 秒）`, 504));
        return;
      }
      // TLS 类错误单独给一句能指导下一步的话。
      // ★ 为什么值得单独写 ★ 实测（2026-09-23）本机网络对 example.com 的解析被改写
      //   到一个非官方 IP，那台服务器递回来的是一张过期证书——报错于是变成
      //   「证书已过期」，看起来像站点的问题。这类失败**重试同一个地址没有任何用**，
      //   但报错原文不会告诉模型这一点，它会一遍遍重试直到烧完步数。
      //   所以这里明确说清「换地址或换来源，别原样重试」。
      const tlsCodes = new Set([
        'CERT_HAS_EXPIRED',
        'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
        'SELF_SIGNED_CERT_IN_CHAIN',
        'DEPTH_ZERO_SELF_SIGNED_CERT',
        'ERR_TLS_CERT_ALTNAME_INVALID',
        'CERT_NOT_YET_VALID',
      ]);
      const code = (e as NodeJS.ErrnoException).code ?? '';
      if (tlsCodes.has(code)) {
        reject(
          new WebError(
            'WEB_PROVIDER_ERROR',
            `这个地址的 HTTPS 证书无法验证（${code}）。通常意味着该地址在此网络上被中间设备改写、或站点证书本身有问题——**换一个地址或换一个来源，不要重试同一个地址**。`,
            502,
          ),
        );
        return;
      }
      reject(new WebError('WEB_PROVIDER_ERROR', `取回失败：${e.message}`, 502));
    });
    req.end();
  });
}

/**
 * 抓一个 URL。
 *
 * 重定向规则（2026-09-23 改）：**同主机放行、http→https 升级放行、降级与跨主机拒绝**。
 * 原来的「严格同源」会把 `http://x` → `https://x` 这条全互联网最常见的跳转
 * 误判成跨站（报错还说「跳到了另一个站点」，明明是同一个站）。
 * 而跨主机仍然必须拒——它是 SSRF 绕过的经典路径（公网地址 302 到内网）。
 * 详见 isSameSiteRedirect。
 */
export async function webFetch(rawUrl: string, opts: { signal?: AbortSignal } = {}): Promise<WebFetchResult> {
  const timeoutMs = WEB_LIMITS.timeoutMs();
  let target = validateUrl(rawUrl);
  const maxRedirects = WEB_LIMITS.maxRedirects();

  for (let hop = 0; ; hop++) {
    const res = await requestOnce(target, timeoutMs, opts.signal);
    const status = res.status;

    if (status >= 300 && status < 400) {
      const loc = res.headers.location;
      if (!loc) throw new WebError('WEB_PROVIDER_ERROR', `服务端返回 ${status} 但没给 Location`, 502);
      if (hop >= maxRedirects) {
        throw new WebError('WEB_REDIRECT_BLOCKED', `重定向超过 ${maxRedirects} 跳，已停止`);
      }
      let next: ParsedTarget;
      try {
        next = validateUrl(new URL(loc, target.url).toString());
      } catch {
        throw new WebError('WEB_REDIRECT_BLOCKED', `重定向到一个不合法的地址：${String(loc).slice(0, 120)}`);
      }
      if (!isSameSiteRedirect(target.url, next.url)) {
        throw new WebError(
          'WEB_REDIRECT_BLOCKED',
          `重定向到了另一个站点（${target.url.host} → ${next.url.host}），已拒绝。要抓那个地址请直接给我它的 URL。`,
        );
      }
      target = next;
      continue;
    }

    const contentType = String(res.headers['content-type'] ?? '');
    const mime = contentType.split(';')[0].trim().toLowerCase();
    if (!mime) {
      throw new WebError('WEB_UNSUPPORTED_CONTENT_TYPE', '响应没带 Content-Type，无法判断内容类型');
    }
    const isHtml = HTML_TYPES.includes(mime);
    const isText =
      TEXT_TYPES.includes(mime) ||
      /^application\/[\w.+-]*\+(json|xml)$/.test(mime) ||
      /^text\/[\w.+-]+$/.test(mime);
    if (!isHtml && !isText) {
      // PDF 是一个「路标」而不是错误：save_web_file 拿到这个码就把 URL 转交 MinerU。
      // 二进制与 PDF 不在网页抓取范围内，这个设计不变。
      const code: WebErrorCode = mime === 'application/pdf' ? 'WEB_IS_DOCUMENT' : 'WEB_UNSUPPORTED_CONTENT_TYPE';
      throw new WebError(
        code,
        `这个地址返回的是 ${mime}，不是网页/文本（二进制与 PDF 不在抓取范围内）。`,
      );
    }

    const enc = charsetOf(contentType);
    const capped = res.body.subarray(0, WEB_LIMITS.maxBodyChars() * 4); // 先按字节粗截，避免 decode 巨串
    const decoded = capped.toString(enc);
    const limit = WEB_LIMITS.maxBodyChars();
    const body = decoded.length > limit ? decoded.slice(0, limit) : decoded;

    return {
      finalUrl: target.url.toString(),
      status,
      contentType: mime,
      kind: isHtml ? 'html' : 'text',
      body,
      truncated: res.truncated || decoded.length > limit,
      bytes: res.body.length,
    };
  }
}
