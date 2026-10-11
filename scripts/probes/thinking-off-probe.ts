/**
 * thinking-off-probe.ts —— 最小验证：**关掉推理模式能不能救回输出**。
 *
 * ★ 背景（刚实测）★
 *   用分块方案跑第一节：21 块 × 1200 字，**17 次 finish_reason=length，14 次推理吃满 8000、正文 0 字**。
 *   输入只有 1200 字（远在模型轻松区间内）⇒ 问题与输入长度无关，是**推理烧光额度**。
 *
 * ★ 本探针只回答一个问题 ★
 *   给请求体加 `thinking: {type: "disabled"}`（DeepSeek 官方参数），
 *   同一块文本，正文能不能正常产出？
 *
 * ★ 三组对照（同一段文本）★
 *   A. 现状：不传 thinking（默认 enabled）
 *   B. 关推理：thinking.disabled
 *   C. 关推理 + 低额度：thinking.disabled + max_tokens=4000（验证额度真省下来了）
 *
 * ★ 用法 ★
 *   npx tsx scripts/probes/thinking-off-probe.ts --rel=知识库/AI-Agent-Book/chapter1.md --headingId=h-12mo5tv1c2 --from=1 --to=3
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { analyzeDocument, unitText } from '../../shared/blocks';
import { knowledgeTreePrompt } from '../../server/services/knowledgeTree';
import { getAiSettings, completionsUrl } from '../../server/services/aiClient';
import { PROBE_OUT } from '../../server/core';

const REL = process.argv.find((a) => a.startsWith('--rel='))?.slice(6) ?? '知识库/AI-Agent-Book/chapter1.md';
const HID = process.argv.find((a) => a.startsWith('--headingId='))?.slice(12) ?? '';
const FROM = Number(process.argv.find((a) => a.startsWith('--from='))?.slice(7) ?? '1');
const TO = Number(process.argv.find((a) => a.startsWith('--to='))?.slice(5) ?? '3');
const CHUNK = Number(process.argv.find((a) => a.startsWith('--chunk='))?.slice(8) ?? '1200');

interface RawCall {
  label: string;
  thinking: boolean;
  maxTokens: number;
}

/** 直接发原始 HTTP（绕过 aiClient），以便自由加参数 */
async function rawCall(body: Record<string, unknown>, baseURL: string, apiKey: string, timeoutMs: number) {
  const url = completionsUrl(baseURL);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    const text = await res.text();
    const ms = Date.now() - t0;
    if (!res.ok) return { ok: false, status: res.status, raw: text.slice(0, 400), ms, parsed: null as any };
    return { ok: true, status: res.status, raw: text, ms, parsed: JSON.parse(text) };
  } catch (e) {
    return { ok: false, status: 0, raw: String(e), ms: Date.now() - t0, parsed: null as any };
  } finally {
    clearTimeout(timer);
  }
}

function chunkByBlocks(blocks: { bi: number; text: string }[], target: number): { from: number; to: number; text: string }[] {
  const chunks: { from: number; to: number; text: string }[] = [];
  let i = 0;
  while (i < blocks.length) {
    let chars = 0;
    let j = i;
    while (j < blocks.length && (chars < target || j === i)) {
      chars += blocks[j].text.length;
      j++;
    }
    chunks.push({ from: blocks[i].bi, to: blocks[j - 1].bi, text: blocks.slice(i, j).map((b) => b.text).join('\n') });
    if (j >= blocks.length) break;
    i = j; // 本探针不需要 overlap（只看能否产出）
  }
  return chunks;
}

async function main(): Promise<void> {
  const log: string[] = [];
  const say = (s: string) => {
    log.push(s);
    console.log(s);
  };

  const md = await readFile(join(process.cwd(), 'notes', REL), 'utf8');
  const a = analyzeDocument(md);
  const unit = a.units.find((u) => u.headingId === HID);
  if (!unit) throw new Error(`找不到节 ${HID}`);
  const blocks = a.blocks.slice(unit.startBi, unit.endBi + 1);
  const chunks = chunkByBlocks(blocks, CHUNK);
  const docTitle = REL.split('/').pop()?.replace(/\.md$/, '') ?? REL;
  const s = await getAiSettings();
  if (!s.apiKey) throw new Error('没有 API Key');

  say(`关推理探针：节 ${unit.headingId}「${unit.headingText}」`);
  say(`模型：${s.model}  网关：${s.baseURL}`);
  say(`取块 ${FROM}~${TO}（共 ${chunks.length} 块）`);
  say('');

  const targets = chunks.slice(FROM - 1, TO);
  const calls: RawCall[] = [
    { label: 'A 现状(默认思考)', thinking: false, maxTokens: 8000 },
    { label: 'B 关推理 8000', thinking: true, maxTokens: 8000 },
    { label: 'C 关推理 4000', thinking: true, maxTokens: 4000 },
  ];

  say('  组别                    finish     补全tok  推理tok  正文tok  正文节点');
  say('  ──────────────────────────────────────────────────────────────────');
  for (const c of targets) {
    const p = knowledgeTreePrompt({ docTitle, headingPath: [unit.headingText ?? ''], unitTitle: unit.headingText ?? '', text: c.text });
    for (const call of calls) {
      const body: Record<string, unknown> = {
        model: s.model,
        messages: [
          { role: 'system', content: p.system },
          { role: 'user', content: p.user },
        ],
        temperature: 0.2,
        max_tokens: call.maxTokens,
        response_format: { type: 'json_object' },
      };
      if (call.thinking) body.thinking = { type: 'disabled' };

      const r = await rawCall(body, s.baseURL, s.apiKey, 240_000);
      if (!r.ok) {
        say(`  块${c.from} ${call.label.padEnd(20)} HTTP ${r.status} ${r.raw.slice(0, 140)}`);
        continue;
      }
      const ch = r.parsed?.choices?.[0];
      const finish = ch?.finish_reason ?? '?';
      const usage = r.parsed?.usage ?? {};
      const content: string = ch?.message?.content ?? '';
      const reasoning = ch?.message?.reasoning_content;
      let nodes = 0;
      try {
        const j = JSON.parse(content);
        nodes = Array.isArray(j?.nodes) ? j.nodes.length : 0;
      } catch {
        const m = content.match(/"name"\s*:/g);
        nodes = m ? m.length : 0;
      }
      say(
        `  块${String(c.from).padStart(3)} ${call.label.padEnd(20)} ${String(finish).padEnd(9)} ${String(usage.completion_tokens ?? '-').padStart(7)}  ${String(usage.completion_tokens_details?.reasoning_tokens ?? '-').padStart(7)}  ${String(content.length).padStart(7)}  ${String(nodes).padStart(8)}   ${r.ms}ms${reasoning ? '  [有reasoning_content]' : ''}`,
      );
    }
    say('');
  }

  say('判读：');
  say('  · 若 B 组 finish=stop 且节点明显多于 A ⇒ **关推理直接解决**，这是主刀。');
  say('  · 若 B 组仍 length ⇒ 该网关的 thinking 参数无效或参数名不同，需换 reasoning_effort。');
  say('  · 若 C 组仍能出节点 ⇒ 额度确实被推理浪费了（省一半额度还够用）。');

  await mkdir(PROBE_OUT, { recursive: true });
  const out = join(PROBE_OUT, `thinking-off-${unit.headingId}.txt`);
  await writeFile(out, log.join('\n'), 'utf8');
  console.log(`\n报告：${out}`);
}

main().catch((e) => {
  console.error('塌了:', e);
  process.exit(1);
});
