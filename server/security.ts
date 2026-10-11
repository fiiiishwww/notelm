/**
 * server/security.ts —— 本机服务的安全边界。
 *
 * 一个跑在 localhost 的 HTTP 服务，默认是所有网页都能打的。所以我们做四层：
 *   1. 只绑 127.0.0.1（在 index.ts 里），局域网打不进来；
 *   2. Host 头校验 —— 防 DNS rebinding（恶意域名解析到 127.0.0.1）；
 *   3. Origin / Sec-Fetch-Site 校验 —— 防其它网页发起跨站请求；
 *   4. X-Local-Token —— 启动时随机生成，注入到 index.html，外部网页读不到。
 *
 * 另外提供全项目唯一的路径入口 resolveInVault()：所有来自前端的路径参数
 * 都必须经过它，任何绕过都是漏洞。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import { ApiError, DATA_DIR_NAME, bad, existsSync, requireVaultRoot } from './core';

/** 启动时由 index.ts 写入 process.env.NB_LOCAL_TOKEN */
export function getLocalToken(): string {
  return process.env.NB_LOCAL_TOKEN ?? '';
}

const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * 公网部署（云主机）时额外放行的 Host / Origin，逗号分隔的主机名或 IP（不带端口、不带协议）。
 * 例：NB_PUBLIC_HOST=47.98.1.2   或   NB_PUBLIC_HOST=note.example.com,www.example.com
 * ★ 为什么必须显式配置 ★：Host 白名单是防 DNS rebinding 的核心，不能为了上云就整个放开，
 *   所以「允许哪些外网名字」必须由部署者自己声明。
 */
function extraHosts(): Set<string> {
  const raw = process.env.NB_PUBLIC_HOST ?? '';
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * 局域网模式（index.ts 在 NB_HOST 不是本机回环时置 NB_LAN=1）额外放行的私有网段：
 * 192.168.x.x / 10.x.x.x / 172.16-31.x.x / 100.64-127.x.x（CGNAT，Tailscale 用）。
 * 放行网段而不是枚举本机网卡地址，是为了手机换热点、换路由器后不用改代码。
 * ★ 四段都要写全 ★：写成 192\.168\.\d{1,3} 只匹配三段，整个判据会静默失效（踩过）。
 */
const PRIVATE_IPV4 =
  /^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3})$/;

function lanMode(): boolean {
  return process.env.NB_LAN === '1';
}

/** Host / Origin 里的主机名是否放行。 */
function hostAllowed(host: string): boolean {
  if (!host) return false;
  const h = host.toLowerCase();
  return ALLOWED_HOSTS.has(h) || extraHosts().has(h) || (lanMode() && PRIVATE_IPV4.test(h));
}

/** 从 Origin（形如 http://host:port）里取主机名；取不到返回空串。 */
function originHostname(origin: string): string {
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * 可选的 Basic Auth 登录门——公网部署的必补项。
 *
 * 为什么必须有：本地 token 是写进 index.html 的，设计前提是「只有你能打开本机」。
 * 一旦放到公网，链接即密码，任何人拿到地址就能读写你的全部笔记。
 *
 * 只有同时设了 NB_AUTH_USER 和 NB_AUTH_PASS 才启用；都不设时原样放行，
 * 本机 / 局域网的用法完全不受影响。
 */
export function basicAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  const user = process.env.NB_AUTH_USER;
  const pass = process.env.NB_AUTH_PASS;
  if (!user || !pass) {
    next();
    return;
  }

  let ok = false;
  const header = req.get('authorization') ?? '';
  if (header.toLowerCase().startsWith('basic ')) {
    let decoded = '';
    try {
      decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    } catch {
      decoded = '';
    }
    const i = decoded.indexOf(':');
    const u = i < 0 ? '' : decoded.slice(0, i);
    const p = i < 0 ? '' : decoded.slice(i + 1);
    ok = timingSafeEqualStr(u, user) && timingSafeEqualStr(p, pass);
  }

  if (!ok) {
    // 没这个头浏览器不会弹登录框，只会一直 401
    res.setHeader('WWW-Authenticate', 'Basic realm="NoteLM", charset="UTF-8"');
    res.status(401).type('text/plain; charset=utf-8').send('需要登录');
    return;
  }
  next();
}

/** 长度也参与比较前先补齐，避免用「比较耗时」泄露长度（timingSafeEqual 要求等长）。 */
function timingSafeEqualStr(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function hostnameOf(hostHeader: string | undefined): string {
  if (!hostHeader) return '';
  // host 形如 "127.0.0.1:3000" / "[::1]:3000"
  const m = /^(\[[^\]]+\]|[^:]+)/.exec(hostHeader);
  return m ? m[1] : '';
}

/** 所有请求都要过的安全中间件。 */
export function securityMiddleware(req: Request, res: Response, next: NextFunction): void {
  // 1) Host 头必须放行：本机 / NB_PUBLIC_HOST 声明的外网名字 / 局域网模式下的私有网段
  if (!hostAllowed(hostnameOf(req.headers.host))) {
    res.status(403).json({ error: '非法 Host', code: 'bad_host' });
    return;
  }

  // 2) 跨站来源直接拒绝（浏览器会自动带 Origin / Sec-Fetch-Site）
  const origin = req.headers.origin;
  if (origin && !hostAllowed(originHostname(origin))) {
    res.status(403).json({ error: '非法来源', code: 'bad_origin' });
    return;
  }
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') {
    res.status(403).json({ error: '跨站请求被拒绝', code: 'cross_site' });
    return;
  }

  // 3) API 必须带本地 token
  if (req.path.startsWith('/api/')) {
    const token = req.get('x-local-token') ?? '';
    const expected = getLocalToken();
    if (!expected || token !== expected) {
      res.status(403).json({ error: '缺少或错误的本地令牌', code: 'bad_token' });
      return;
    }
  }

  // 4) 安全响应头
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (process.env.NODE_ENV === 'production') {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; " +
        "font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
  }

  next();
}

// ─────────────────────────── 路径校验 ───────────────────────────

/** vault 内部保留、不允许通过普通 API 访问的目录名。 */
const RESERVED_SEGMENTS = new Set([DATA_DIR_NAME, '.git', '.svn', 'node_modules', '.obsidian', '.trash']);

/** Windows 保留设备名——这些名字在 Windows 上会打到设备而不是文件。 */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

const ALLOWED_EXT = new Set([
  '.md',
  '.markdown',
  '.txt',
  '.pdf',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.svg',
  '.bmp',
  '.avif',
]);

/**
 * 校验一个来自前端的相对路径。
 * 注意：这里只做「字符串形态」的检查，真正的越界判定在 resolveInVault 里用 realpath 做。
 */
export function assertSafeRel(rel: string, opts: { allowDataDir?: boolean } = {}): void {
  if (typeof rel !== 'string' || rel.length === 0) throw bad('路径不能为空', 'bad_path');
  if (rel.includes('\0')) throw bad('路径含非法字符', 'bad_path');
  if (rel.length > 1024) throw bad('路径过长', 'bad_path');

  // 绝对路径 / 盘符 / UNC 一律拒绝
  if (/^([a-zA-Z]:|[\\/])/.test(rel) || rel.startsWith('\\\\')) {
    throw bad('不支持绝对路径', 'bad_path');
  }
  // 反斜杠统一成正斜杠后再判断
  const norm = rel.replace(/\\/g, '/');
  if (norm.split('/').some((seg) => seg === '..')) {
    throw bad('路径越界', 'bad_path');
  }

  for (const seg of norm.split('/')) {
    if (!seg) continue;
    if (seg === '.' || seg === '..') throw bad('路径越界', 'bad_path');
    if (/[<>:"|?*\u0000-\u001f]/.test(seg)) {
      // Windows 文件名不允许这些字符；顺带挡掉控制字符
      throw bad(`路径段含非法字符: ${seg}`, 'bad_path');
    }
    if (seg !== seg.replace(/[. ]+$/, '')) {
      // Windows 会自动去掉结尾的点和空格，导致「校验的名字」和「真正的名字」不一致
      throw bad(`路径段不能以点或空格结尾: ${seg}`, 'bad_path');
    }
    if (WINDOWS_RESERVED.test(seg)) {
      throw bad(`路径段是系统保留名: ${seg}`, 'bad_path');
    }
    if (seg.startsWith('.') && seg !== DATA_DIR_NAME && seg !== '.assistant') {
      // .assistant 是 AGENTS.md 授权的 agent 协作区（inbox/进化/agent 工作区），
      // 与 .notebook 同等待遇放行；其余点开头目录仍然隐藏。
      throw bad(`不允许访问隐藏项: ${seg}`, 'bad_path');
    }
    if (RESERVED_SEGMENTS.has(seg) && !(opts.allowDataDir && seg === DATA_DIR_NAME)) {
      throw bad(`不允许访问保留目录: ${seg}`, 'bad_path');
    }
  }
}

/**
 * 把相对路径解析成绝对路径，并确认它确实落在 vault 内。
 *
 * realpath 的用法：不能只对最终路径做 realpath（文件可能还不存在），
 * 也不能只做字符串前缀比较（符号链接可以绕过）。这里对「已存在的最深祖先」
 * 做 realpath，再把剩下的尾巴拼回去比较——既支持新建文件，也挡得住 symlink 逃逸。
 */
export async function resolveInVault(rel: string, opts: { allowDataDir?: boolean } = {}): Promise<string> {
  assertSafeRel(rel, opts);
  const root = await requireVaultRoot();
  const realRoot = await fsp.realpath(root);
  const abs = path.resolve(realRoot, ...rel.replace(/\\/g, '/').split('/'));

  let probe = abs;
  const tail: string[] = [];
  // 最多往上找 64 层，防御异常输入
  for (let i = 0; i < 64 && !existsSync(probe); i++) {
    tail.unshift(path.basename(probe));
    const parent = path.dirname(probe);
    if (parent === probe) throw bad('路径无效', 'bad_path');
    probe = parent;
  }
  if (!existsSync(probe)) throw bad('路径无效', 'bad_path');

  const realProbe = await fsp.realpath(probe);
  const realAbs = tail.length ? path.join(realProbe, ...tail) : realProbe;

  if (realAbs !== realRoot && !realAbs.startsWith(realRoot + path.sep)) {
    throw bad('路径越界', 'bad_path');
  }
  return abs;
}

/** 校验扩展名白名单。 */
export function assertAllowedExt(abs: string): void {
  const ext = path.extname(abs).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) {
    throw bad(`不支持的文件类型: ${ext || '(无扩展名)'}`, 'bad_ext');
  }
}

/** 目录可读写检查。 */
export async function assertWritableDir(abs: string): Promise<void> {
  try {
    const st = await fsp.stat(abs);
    if (!st.isDirectory()) throw bad('不是一个目录', 'not_a_dir');
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err?.code === 'ENOENT') throw new ApiError(404, '目录不存在', 'not_found');
    if (e instanceof ApiError) throw e;
    throw new ApiError(500, `检查目录失败：${err?.message ?? String(e)}`, 'fs_error');
  }

  // 真的写一个文件试试 —— 只看权限位是不够的（Windows 上尤其不可靠）
  const probe = path.join(abs, `.nb-write-test-${Date.now()}`);
  let fh: Awaited<ReturnType<typeof fsp.open>> | null = null;
  try {
    fh = await fsp.open(probe, 'wx');
    await fh.writeFile('ok');
  } catch {
    throw new ApiError(403, '目录不可写，请换一个目录或检查权限', 'not_writable');
  } finally {
    await fh?.close().catch(() => undefined);
  }
  // 清理探测文件失败**不算**目录不可写（某些环境会把删除重定向，
  // 判定标准应该是「能不能写」，不是「能不能删」）
  await fsp.unlink(probe).catch(() => undefined);
  void fs;
}
