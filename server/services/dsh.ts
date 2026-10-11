/**
 * server/services/dsh.ts —— 把外部 AI 助手（DSH / DeepSeek Harness）托管起来。
 *
 * ★ 为什么由 NoteLM 托管，而不是让用户自己开 ★
 *   DSH 的 Web UI 每次启动都换一个随机访问 token，用户手动复制粘贴一次还能忍，
 *   每次都粘就是折磨。NoteLM 拉起它时能从 stdout 抓到 token，缓存下来，
 *   前端要 URL 就给 URL——用户永远不需要知道 token 的存在。
 *
 * ★ 边界（这是「嵌入」不是「内建」）★
 *   NoteLM 只负责进程生命周期和 URL 分发；agent 循环、会话、工具调用全在 DSH 里，
 *   数据仍然只从本库被读取，NoteLM 不新增任何 AI 写路径。
 *
 * 生命周期设计：
 *   - DSH 以 detached + unref 启动，独立于 NoteLM 存活（tsx watch 重启也不杀它）；
 *   - token 缓存在 .local/dsh-session.json，NoteLM 重启后直接复用；
 *   - 已有 DSH 在跑（端口活着且 token 有效）就不再起新的；
 *   - 端口被别的进程占了且 token 对不上 → 明确报错，不猜。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { LOCAL_DIR, readConfig, writeFileAtomic } from '../core';

const SESSION_FILE = path.join(LOCAL_DIR, 'dsh-session.json');

export interface DshConfig {
  /** DSH 的 npm 安装目录（含 node_modules/@deepseek-ai/dsh）。默认 D:\AI\dsh */
  dir?: string;
  /** DSH web 端口。默认 3080 */
  port?: number;
  /** 设为 false 则 NoteLM 不拉起 DSH，只做健康检查 */
  autoStart?: boolean;
}

interface DshSession {
  port: number;
  token: string;
  /** 缓存时间，仅诊断用 */
  at: string;
}

function sessionFile(): DshSession | null {
  try {
    const raw = fs.readFileSync(SESSION_FILE, 'utf8');
    const s = JSON.parse(raw) as DshSession;
    return s?.token && s?.port ? s : null;
  } catch {
    return null;
  }
}

async function writeSession(s: DshSession): Promise<void> {
  await writeFileAtomic(SESSION_FILE, JSON.stringify(s, null, 2));
}

/**
 * 探测 DSH 是否活着且 token 有效。401 = 活着但 token 过期。
 * ★ 必须禁止跟随重定向 ★ DSH 验完 token 是 302 回 / 并靠 Set-Cookie 记住会话；
 * fetch 不存 cookie，跟着跳到 / 只会拿到 401，把有效 token 误判成过期。
 * （浏览器 iframe 不受影响：会正常收下 cookie。）
 */
async function probe(port: number, token: string): Promise<'ok' | 'stale' | 'down'> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(2500),
    });
    await res.arrayBuffer().catch(() => undefined);
    return res.ok || (res.status >= 300 && res.status < 400) ? 'ok' : 'stale';
  } catch {
    return 'down';
  }
}

/**
 * 从 DSH 的输出里抓访问 URL。它启动后打印一行：
 *   dsh web: http://127.0.0.1:3080/?token=xxxx
 */
function extractToken(text: string): string | null {
  const m = text.match(/dsh web: (https?:\/\/\S*token=\S+)/);
  return m ? m[1] : null;
}

/** 等待 DSH 打印出 token。行可能跨 chunk，按累计文本匹配。 */
function waitForUrl(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.off('data', onData);
      child.stderr?.off('data', onData);
      child.off('exit', onExit);
      fn();
    };
    const onData = (d: Buffer) => {
      buf += d.toString('utf8');
      const url = extractToken(buf);
      if (url) done(() => resolve(url));
    };
    const onExit = (code: number | null) => {
      done(() => reject(new Error(code == null ? 'DSH 进程意外退出' : `DSH 启动失败（退出码 ${code}）`)));
    };
    const timer = setTimeout(() => {
      done(() => reject(new Error('DSH 启动超时（60 秒内没有打印访问地址）')));
    }, timeoutMs);
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('exit', onExit);
  });
}

export interface AssistantInfo {
  available: boolean;
  /** 可直接放进 iframe 的完整 URL */
  url?: string;
  /** 不可用时的原因（给人看的话） */
  reason?: string;
}

let inflight: Promise<AssistantInfo> | null = null;

/** 前端「打开助手」时调用：能复用就复用，不能就拉起。 */
export async function getAssistantUrl(): Promise<AssistantInfo> {
  if (inflight) return inflight;
  inflight = doIt().finally(() => {
    inflight = null;
  });
  return inflight;
}

async function doIt(): Promise<AssistantInfo> {
  const cfg = await readConfig();
  const dsh: DshConfig = cfg.dsh ?? {};
  const dir = dsh.dir ?? 'D:\\AI\\dsh';
  const port = dsh.port ?? 3080;

  // 1) 缓存的 token 还活着 → 直接用
  const cached = sessionFile();
  if (cached?.token) {
    const state = await probe(port, cached.token);
    if (state === 'ok') {
      return { available: true, url: `http://127.0.0.1:${port}/?token=${cached.token}` };
    }
  }

  // 2) 端口上有没有一个「别人的」DSH（token 对不上 / 没有缓存）
  if (cached?.token || sessionFile()) {
    // probe 过了：不是 down 就说明端口活着但 token 对不上
    const state = cached ? await probe(port, cached.token) : 'down';
    if (state === 'stale') {
      return {
        available: false,
        reason: `检测到端口 ${port} 上有 DSH 在运行，但访问令牌对不上（多半是它被单独重启过）。关掉那个 DSH 再点一次，由笔记库接管启动即可。`,
      };
    }
  } else {
    // 没有任何缓存，先看看端口是不是已被占用（避免起第二个实例）
    const blind = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) })
      .then((r) => r.status)
      .catch(() => 0);
    if (blind === 401 || blind === 200) {
      return {
        available: false,
        reason: `端口 ${port} 已被一个 DSH 实例占用，但笔记库没有它的访问令牌。关掉它再点一次，由笔记库接管启动即可。`,
      };
    }
  }

  // 3) 拉起 DSH（detached：NoteLM 重启不影响它）
  if (dsh.autoStart === false) {
    return { available: false, reason: '助手未启动（配置里关闭了自动拉起）。' };
  }
  const bin = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  if (!fs.existsSync(bin)) {
    return {
      available: false,
      reason: `找不到 DSH（${bin}）。先安装：cd ${dir} && npm install @deepseek-ai/dsh，或在设置里把 dsh.dir 指到安装目录。`,
    };
  }
  const child = spawn(process.execPath, [bin, 'web', '--no-open'], {
    cwd: dir,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  try {
    const url = await waitForUrl(child, 60_000);
    const token = new URL(url).searchParams.get('token') ?? '';
    await writeSession({ port, token, at: new Date().toISOString() });
    child.stdout?.resume();
    child.stderr?.resume();
    child.unref();
    return { available: true, url };
  } catch (e) {
    // 拉起失败：如果其实是「已被占用」的竞态，给出对得上的解释
    const blind = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) })
      .then((r) => r.status)
      .catch(() => 0);
    if (blind === 401 || blind === 200) {
      return {
        available: false,
        reason: `端口 ${port} 已被一个 DSH 实例占用，笔记库无法接管。关掉它再点一次即可。`,
      };
    }
    return { available: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
