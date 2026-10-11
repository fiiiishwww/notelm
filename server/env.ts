/**
 * server/env.ts —— 极简 .env 加载（零依赖，模块顶层执行一次）。
 *
 * ★ 为什么不用 dotenv ★
 *   这个项目的后端是刻意的零依赖（express / markdown-it / pdfjs 之外不引运行时包）。
 *   为了读一个 KEY=VALUE 文件多装一个包不划算，而这个格式本身只有三十行解析量。
 *
 * ★ 为什么加载放在 core 的 import 链上 ★
 *   所有服务都直接或间接 import core（readConfig / LOCAL_DIR …），
 *   所以 core 里 `import './env'` 一句就能覆盖「服务器启动」和「所有脚本」两条路径，
 *   不用在每个入口各写一遍 —— 漏写一处就会出现「命令行跑得通、服务里读不到」。
 *
 * ★ 规则刻意保守 ★
 *   · 只读项目根下的 .env，不存在就安静跳过（.env 是可选的）
 *   · **已存在于 process.env 的键不覆盖** —— 命令行/系统环境变量优先，
 *     否则会出现「我明明用 FOO=bar 跑，结果被 .env 里的旧值盖掉」这种最难查的问题
 *   · 支持 # 注释、`export ` 前缀、成对单/双引号包裹的值
 *   · 值是空串时视为**未设置**（模板里留空的项不该把已有配置顶掉）
 *
 * ★ 它和 secrets.json 的分工 ★
 *   secrets.json —— 应用内填写的凭据（设置页写入，界面可回显「是否已配置」）
 *   .env        —— 命令行/脚本用的凭据，不进版本库，手工编辑
 *   两处都读，环境变量优先（getAiSettings 里 profileKeys 先查 secrets，再查环境变量）。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 与 core.ts 的 PROJECT_ROOT 同一个口径（core 依赖本模块，所以这里不能反过来 import）。 */
export const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
export const ENV_FILE = path.join(PROJECT_ROOT, '.env');

/** 解析 .env 文本。拆出来是为了能单测，不用真的写文件。 */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim();
    // 成对引号：双引号里允许 \n，单引号里原样保留
    if (val.length >= 2 && val[0] === '"' && val.endsWith('"')) {
      val = val.slice(1, -1).replace(/\\n/g, '\n').replace(/\\t/g, '\t');
    } else if (val.length >= 2 && val[0] === "'" && val.endsWith("'")) {
      val = val.slice(1, -1);
    } else {
      // 裸值：行内 # 之后算注释（前面得有空白，避免把 URL 里的 # 当注释切掉）
      val = val.replace(/\s+#.*$/, '').trim();
    }
    out[key] = val;
  }
  return out;
}

let loaded: { file: string; count: number } | null = null;

/** 加载结果（给自检脚本用，让「到底读到了没有」可查）。 */
export function loadDotEnv(file: string = ENV_FILE): { file: string; count: number; found: boolean } {
  if (loaded) return { ...loaded, found: loaded.count > 0 };
  let text = '';
  let found = false;
  try {
    text = readFileSync(file, 'utf8');
    found = true;
  } catch {
    loaded = { file, count: 0 };
    return { file, count: 0, found: false };
  }
  const vars = parseEnv(text);
  let count = 0;
  for (const [k, v] of Object.entries(vars)) {
    // 空值 = 模板里留空的项，不算设置；已有的环境变量一律不覆盖
    if (!v) continue;
    if ((process.env[k] ?? '') !== '') continue;
    process.env[k] = v;
    count++;
  }
  loaded = { file, count };
  return { file, count, found };
}

loadDotEnv();
