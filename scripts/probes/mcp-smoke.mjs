/**
 * .local/tmp/mcp-smoke.mjs —— 模拟 MCP 客户端冒烟测试 server/mcp.ts。
 * 覆盖：initialize / tools/list / 核心工具各一次真实调用。
 * （工具数量随能力演进变化，tools/list 打印全集，不写死数量。）
 */
import { spawn } from 'node:child_process';

const child = spawn('npx', ['tsx', 'server/mcp.ts'], { cwd: process.cwd(), shell: true });
let buf = '';
const pending = new Map();
let nextId = 1;

child.stdout.setEncoding('utf8');
child.stdout.on('data', (d) => {
  buf += d;
  let at;
  while ((at = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, at).trim();
    buf = buf.slice(at + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch {
      console.error('UNPARSEABLE:', line.slice(0, 200));
    }
  }
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', (d) => process.stderr.write('[srv] ' + d));

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
const text = (resp) => {
  const c = resp.result?.content?.[0];
  if (resp.result?.isError) throw new Error('tool error: ' + c?.text);
  return JSON.parse(c.text);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(2500); // 等 tsx 编译启动

const init = await request('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'smoke', version: '0' },
});
console.log('initialize:', JSON.stringify(init.result?.serverInfo), 'proto', init.result?.protocolVersion);
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

const list = await request('tools/list', {});
console.log('tools:', (list.result?.tools ?? []).map((t) => t.name).join(', '));

// 1) search
const s = text(await request('tools/call', { name: 'search', arguments: { q: '什么是 AI Agent', topK: 3 } }));
console.log(`search: mode=${s.mode} hits=${s.hits.length} top1=「${(s.hits[0]?.title ?? '?')}·${s.hits[0]?.heading ?? '?'}」score=${s.hits[0]?.score?.toFixed(3)}`);

// 2) read_doc
const rd = text(await request('tools/call', { name: 'read_doc', arguments: { rel: '知识库/AI-Agent-Book/chapter1.md', from: 0, to: 12 } }));
console.log(`read_doc: title=「${rd.title}」total=${rd.totalBlocks} 返回 ${rd.blocks.length} 块, bi=${rd.blocks.map((b) => b.bi).join(',')}, images=${rd.images.length} (有路径 ${rd.images.filter((i) => i.path).length})`);
if (rd.images[0]) console.log('  image[0]:', JSON.stringify(rd.images[0]).slice(0, 160));

// 3) annotations（默认无高亮）
const an = text(await request('tools/call', { name: 'annotations', arguments: { since: '2026-09-18' } }));
console.log(`annotations: total=${an.total} 返回=${an.notes.length} 高亮字段=${an.highlights === undefined ? '无(正确)' : '有(错误!)'}`);
console.log('  最新一条:', JSON.stringify(an.notes[0]).slice(0, 180));

// 3b) withHighlights=true
const anh = text(await request('tools/call', { name: 'annotations', arguments: { since: '2026-09-18', withHighlights: true, limit: 5 } }));
console.log(`annotations+hl: notes=${anh.notes.length} highlights=${anh.highlights?.length} note=「${anh.highlightNote}」`);

// 4) cheatsheet
const cs = text(await request('tools/call', { name: 'cheatsheet', arguments: { rel: '知识库/AI-Agent-Book/chapter1.md' } }));
const sec0 = cs.sections.find((x) => x.items);
console.log(`cheatsheet: sections=${cs.sections.length} 首节「${sec0?.heading}」命题${sec0?.items?.propositions?.length ?? 0} 条目${sec0?.items?.entries?.length ?? 0} 术语${sec0?.items?.terms?.length ?? 0}`);

// 5) feedback_digest
const fb = text(await request('tools/call', { name: 'feedback_digest', arguments: {} }));
console.log(`feedback_digest: total=${fb.total} up=${fb.up} down=${fb.down} dup=${fb.dup} md ${fb.markdown.length} 字`);

console.log('SMOKE OK');
child.stdin.end();
setTimeout(() => process.exit(0), 800);
