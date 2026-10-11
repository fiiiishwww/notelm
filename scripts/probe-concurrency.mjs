#!/usr/bin/env node
/**
 * 并发探针（S3.1/S3.2 验收）：mapLimit 正确性 + 全局 AI 闸 + 429 退避。
 * 用法：node scripts/probe-concurrency.mjs
 * 开头先落盘（本机内存紧张铁律）。
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const OUT_DIR = '.notebook/probes';
mkdirSync(OUT_DIR, { recursive: true });
const startedAt = new Date().toISOString();
const results = [];
const note = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
};

try {
  // ── 1. mapLimit：结果保序 + 并发峰值受控 ──
  const { mapLimit } = await import('../server/services/concurrency.ts').catch(() => ({}));
  if (!mapLimit) {
    // tsx 直跑 ts 模块
    const { execSync } = await import('node:child_process');
    console.log('请用 npx tsx 运行本探针：npx tsx scripts/probe-concurrency.mjs');
    process.exit(2);
  }

  let inFlight = 0;
  let peak = 0;
  const out = await mapLimit(Array.from({ length: 12 }, (_, i) => i), 3, async (x) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 10 + Math.random() * 20));
    inFlight--;
    return x * 2;
  });
  note('mapLimit 保序', JSON.stringify(out) === JSON.stringify(Array.from({ length: 12 }, (_, i) => i * 2)), `out[0..2]=${out.slice(0, 3)}`);
  note('mapLimit 峰值≤limit', peak <= 3, `peak=${peak}`);
  note('mapLimit 空数组不炸', JSON.stringify(await mapLimit([], 3, async () => 1)) === '[]', 'ok');

  // ── 2. 全局 AI 闸 ──
  const conc = await import('../server/services/concurrency.ts');
  let gateIn = 0;
  let gatePeak = 0;
  const tasks = Array.from({ length: 8 }, () =>
    conc.withAiGate(async () => {
      gateIn++;
      gatePeak = Math.max(gatePeak, gateIn);
      await new Promise((r) => setTimeout(r, 15));
      gateIn--;
    }),
  );
  await Promise.all(tasks);
  const limit = conc.aiConcurrencyLimit();
  note('AI 闸峰值≤上限', gatePeak <= limit, `peak=${gatePeak} limit=${limit}`);
  note('闸计数归零', conc.aiGateActive() === 0, `active=${conc.aiGateActive()}`);

  // off 档直通
  process.env.AI_PARALLEL = 'off';
  const offLimit = conc.aiConcurrencyLimit();
  let offPeak = 0;
  let offIn = 0;
  await Promise.all(
    Array.from({ length: 6 }, () =>
      conc.withAiGate(async () => {
        offIn++;
        offPeak = Math.max(offPeak, offIn);
        await new Promise((r) => setTimeout(r, 10));
        offIn--;
      }),
    ),
  );
  process.env.AI_PARALLEL = '';
  note('AI_PARALLEL=off 时 limit=1', offLimit === 1, `offLimit=${offLimit}`);
  note('off 档直通不排队', offPeak === 6, `offPeak=${offPeak}`);

  // ── 3. 429 退避 ──
  const ai = await import('../server/services/aiClient.ts');
  process.env.AI_RETRY_429 = '';
  let calls429 = 0;
  const t0 = Date.now();
  const ok = await ai.withBackoff429(async () => {
    calls429++;
    if (calls429 < 3) {
      const e = new (await import('../server/core.ts')).ApiError(502, 'rate limited', 'ai_http_error', { status: 429 });
      throw e;
    }
    return 'done';
  });
  const dt = Date.now() - t0;
  note('429 两次后重试成功', ok === 'done' && calls429 === 3, `calls=${calls429} 耗时=${dt}ms（约 2s+4s=6s 量级）`);
  note('退避耗时在下界之上', dt >= 5500, `dt=${dt}ms`);

  // 429 不消失 → 重试 3 次后抛出
  let calls429b = 0;
  let threw = false;
  try {
    await ai.withBackoff429(async () => {
      calls429b++;
      const e = new (await import('../server/core.ts')).ApiError(502, 'rate limited', 'ai_http_error', { status: 429 });
      throw e;
    });
  } catch {
    threw = true;
  }
  note('429 持续时 4 次后抛出', threw && calls429b === 4, `calls=${calls429b}`);

  // 开关 off：直接抛不重试
  process.env.AI_RETRY_429 = 'off';
  let calls429c = 0;
  threw = false;
  try {
    await ai.withBackoff429(async () => {
      calls429c++;
      const e = new (await import('../server/core.ts')).ApiError(502, 'rate limited', 'ai_http_error', { status: 429 });
      throw e;
    });
  } catch {
    threw = true;
  }
  process.env.AI_RETRY_429 = '';
  note('AI_RETRY_429=off 不重试', threw && calls429c === 1, `calls=${calls429c}`);

  // 非 429 错误不重试
  let callsOther = 0;
  threw = false;
  try {
    await ai.withBackoff429(async () => {
      callsOther++;
      throw new Error('plain error');
    });
  } catch {
    threw = true;
  }
  note('非 429 错误直抛不重试', threw && callsOther === 1, `calls=${callsOther}`);
} catch (e) {
  note('探针异常', false, String(e?.stack ?? e));
}

const summary = { startedAt, finishedAt: new Date().toISOString(), passed: results.filter((r) => r.ok).length, total: results.length, results };
writeFileSync(`${OUT_DIR}/probe-concurrency-${Date.now()}.json`, JSON.stringify(summary, null, 2), 'utf8');
console.log(`\n${summary.passed}/${summary.total} 通过，结果已落盘 ${OUT_DIR}/`);
process.exit(summary.passed === summary.total ? 0 : 1);
