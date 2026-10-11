/**
 * 共享并发工具（2026-10-11 收编）。
 *
 * ★ 为什么收敛到这里 ★
 *   mapLimit 之前在 study.ts / cheatsheetV3.ts / embed.ts 各复制了一份，逐字等价——
 *   三份实现意味着三处调用方各自为政，谁也不知道别处正在并发。
 *   收编后 AI 闸（aiGate）才知道全局真实并发数，限流才有意义。
 */

/** 带并发上限的 map。并行跑 AI 任务时限制并发，避免把用户自己填的额度瞬间打满触发限流。 */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

// ─────────────────────────── 全局 AI 并发闸 ───────────────────────────

let active = 0;
const waiters: Array<() => void> = [];

/**
 * AI 并发上限。
 *
 * ★ 为什么默认 3 ★
 *   本机 16GB 内存常年紧张（常剩 <1GB），cheatsheetV3 的实测峰值是 2×3=6 且没出过事；
 *   取 3 是「单路由自己跑也够快、两个路由同时跑也不超过 6」的保守值。
 *   环境变量 AI_CONCURRENCY 可调；AI_PARALLEL=off 时强制 1——
 *   ★ off 档的语义是「逐字节回到串行时代的行为」，所以实现上是直通（不排队不计数），
 *   连 acquire/release 的微任务延迟都不引入。
 */
export function aiConcurrencyLimit(): number {
  if (process.env.AI_PARALLEL === 'off') return 1;
  const v = Number(process.env.AI_CONCURRENCY ?? 3);
  return v >= 1 ? Math.floor(v) : 3;
}

/**
 * 是否启用闸。off 档走直通快路径，调用方据此跳过 acquire/release。
 */
export function aiGateEnabled(): boolean {
  return process.env.AI_PARALLEL !== 'off';
}

async function acquire(): Promise<void> {
  if (active < aiConcurrencyLimit()) {
    active++;
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
  active++;
}

function release(): void {
  active--;
  const next = waiters.shift();
  if (next) next();
}

/**
 * 全局 AI 并发闸：包住每一次 LLM 调用的最外层。
 * 闸关闭（AI_PARALLEL=off）时直接执行，行为与未包闸逐字节一致。
 */
export async function withAiGate<T>(fn: () => Promise<T>): Promise<T> {
  if (!aiGateEnabled()) return fn();
  await acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}

/** 当前在闸内的请求数（探针观测用）。 */
export function aiGateActive(): number {
  return active;
}
