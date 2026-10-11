/**
 * scripts/api-smoke.ts —— 后端端到端冒烟测试。
 *
 * 需要先启动服务，然后：
 *   NB_TOKEN=xxx NB_BASE=http://127.0.0.1:3111 node ./node_modules/tsx/dist/cli.mjs scripts/api-smoke.ts
 *
 * 重点验证「批注在文章被外部修改后还能不能跟住」这条主链路，
 * 因为它是整个产品最核心的承诺，也是唯一一处「猜错了会让用户记错东西」的地方。
 */

const BASE = process.env.NB_BASE ?? 'http://127.0.0.1:3113';
const TOKEN = process.env.NB_TOKEN ?? 'testtoken';

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

interface Res<T> {
  status: number;
  body: T;
}

async function req<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  opts: { raw?: Buffer; contentType?: string } = {},
): Promise<Res<T>> {
  const headers: Record<string, string> = { 'x-local-token': TOKEN };
  let payload: BodyInit | undefined;
  if (opts.raw) {
    payload = new Uint8Array(opts.raw);
    headers['content-type'] = opts.contentType ?? 'application/octet-stream';
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    headers['content-type'] = 'application/json';
  }
  const res = await fetch(`${BASE}${path}`, { method, headers, body: payload });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* 非 JSON 就原样返回 */
  }
  return { status: res.status, body: parsed as T };
}

const DOC = '冒烟测试/动态规划.md';

/**
 * 用原始 TCP 发一个 HTTP 请求，这样可以任意伪造 Host 头。
 * fetch / undici 会把 Host 当成禁止头忽略掉，测不了 DNS rebinding 防护。
 */
function rawRequest(hostHeader: string, path = '/api/settings/state'): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE);
    const port = Number(url.port || 80);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    void import('node:net').then(({ connect }) => {
      const sock = connect({ host: url.hostname, port }, () => {
        sock.write(
          `GET ${path} HTTP/1.1\r\nHost: ${hostHeader}\r\nx-local-token: ${TOKEN}\r\nConnection: close\r\n\r\n`,
        );
      });
      let buf = '';
      sock.setEncoding('utf8');
      sock.on('data', (d: string) => {
        buf += d;
      });
      sock.on('end', () => {
        const m = /^HTTP\/1\.[01] (\d{3})/.exec(buf);
        resolve({ status: m ? Number(m[1]) : 0 });
      });
      sock.on('error', reject);
      sock.setTimeout(5000, () => {
        sock.destroy();
        reject(new Error('rawRequest 超时'));
      });
    });
  });
}

const ORIGINAL = [
  '# 动态规划入门',
  '',
  '## 状态转移方程',
  '',
  '动态规划的核心是写出状态转移方程，它描述了状态之间的递推关系。',
  '',
  '好的状态定义能让方程变得简单。',
  '',
  '## 边界条件',
  '',
  '边界条件决定递推的起点，必须单独处理，否则结果会错。',
  '',
  '## 复杂度',
  '',
  '时间复杂度等于状态数乘以每个状态的转移代价。',
  '',
].join('\n');

async function main(): Promise<void> {
  console.log(`\n══════ API 冒烟测试 @ ${BASE} ══════\n`);

  // ── 0. 安全边界
  console.log('▸ 安全边界');
  {
    // 注意：不能用 req()，它会自动带上 token
    const noToken = await fetch(`${BASE}/api/settings/state`);
    check('无 token 被拒（403）', noToken.status === 403, `实际 ${noToken.status}`);
    const wrongToken = await fetch(`${BASE}/api/settings/state`, { headers: { 'x-local-token': 'wrong' } });
    check('错误 token 被拒（403）', wrongToken.status === 403, `实际 ${wrongToken.status}`);
    const badOrigin = await fetch(`${BASE}/api/settings/state`, {
      headers: { 'x-local-token': TOKEN, origin: 'https://evil.example.com' },
    });
    check('跨站 Origin 被拒（403）', badOrigin.status === 403, `实际 ${badOrigin.status}`);

    // Host 头是 fetch 的「禁止头」，改不了，只能用原始 TCP 发一个伪造请求，
    // 这样才能真正验证 DNS rebinding 防护（恶意域名解析到 127.0.0.1 的场景）。
    const forgedHost = await rawRequest('evil.example.com');
    check('伪造 Host 被拒（403）', forgedHost.status === 403, `实际 ${forgedHost.status}`);
    const goodHost = await rawRequest(new URL(BASE).host);
    check('正常 Host 放行（非 403）', goodHost.status !== 403, `实际 ${goodHost.status}`);
  }

  // ── 1. 笔记库
  console.log('\n▸ 笔记库');
  {
    const s = await req<{ vault: { configured: boolean } }>('GET', '/api/settings/state');
    check('state 可读', s.status === 200 && typeof s.body.vault?.configured === 'boolean');
    const v = await req('POST', '/api/settings/vault', { useDefault: true });
    check('设置默认笔记库成功', v.status === 200, JSON.stringify(v.body).slice(0, 160));

    const bad = await req('POST', '/api/settings/vault', { root: 'relative/path' });
    check('相对路径被拒（400）', bad.status === 400);
  }

  // ── 2. 新建并写入文章
  console.log('\n▸ 新建文章');
  {
    const c = await req<{ relPath: string }>('POST', '/api/entry', { type: 'dir', parent: '', name: '冒烟测试' });
    check('建目录（已存在也算通过）', c.status === 200 || c.status === 409, `实际 ${c.status}`);

    const d = await req<{ relPath: string; docHash: string }>('POST', '/api/entry', {
      type: 'doc',
      parent: '冒烟测试',
      name: '动态规划',
    });
    check('建文章成功', d.status === 200, JSON.stringify(d.body).slice(0, 160));
    const created = d.body.relPath;
    check('文章路径带 .md', created?.endsWith('.md') === true, created);

    // 全新文章 → 写入正文
    const w = await req<{ docHash: string }>('PUT', '/api/doc', {
      rel: created,
      markdown: ORIGINAL,
      baseHash: d.body.docHash,
      reanalyze: false,
    });
    check('写入正文成功', w.status === 200, JSON.stringify(w.body).slice(0, 200));

    // 乐观锁：用过期 hash 保存必须 409
    const stale = await req('PUT', '/api/doc', {
      rel: created,
      markdown: ORIGINAL + '\n多余内容',
      baseHash: 'deadbeef',
    });
    check('过期 baseHash 触发 409', stale.status === 409, `实际 ${stale.status}`);

    // 打开文章
    interface OpenResp {
      html: string;
      docHash: string;
      analysis: { blocks: { bi: number; text: string }[]; units: { headingId: string; headingText: string }[] };
      sidecar: { notes: unknown[]; highlights: unknown[] };
    }
    const o = await req<OpenResp>('GET', `/api/doc?rel=${encodeURIComponent(created)}`);
    check('打开文章成功', o.status === 200);
    check('HTML 里带 data-bi', o.body.html.includes('data-bi='), '没找到 data-bi');
    check('块数 >= 7', o.body.analysis.blocks.length >= 7, `实际 ${o.body.analysis.blocks.length}`);
    check('识别出单元（h2 为主）', o.body.analysis.units.length >= 2, `实际 ${o.body.analysis.units.length}`);
    check('h1 生效（降级逻辑正常）', o.body.analysis.units[0]?.headingText === '状态转移方程', o.body.analysis.units[0]?.headingText);

    // 找到目标块
    const target = o.body.analysis.blocks.find((b) => b.text.includes('动态规划的核心'));
    check('找到目标块', Boolean(target));
    if (!target) return;

    const quote = '它描述了状态之间的递推关系';
    const idx = target.text.indexOf(quote);
    check('目标文本在块内可定位', idx >= 0);

    // ── 3. 建批注 + 高亮
    console.log('\n▸ 批注与高亮');
    const selector = {
      type: 'text-quote',
      quote,
      prefix: target.text.slice(0, idx),
      suffix: target.text.slice(idx + quote.length),
      blockIndex: target.bi,
      textOffset: idx,
      quoteLength: quote.length,
    };
    const n = await req<{ note: { id: string; anchorState: string }; highlight: { id: string } | null }>(
      'POST',
      '/api/notes',
      { rel: created, selector, body: '这条批注用来验证锚点跟随', tags: ['测试'], color: 'yellow' },
    );
    check('建批注成功', n.status === 200, JSON.stringify(n.body).slice(0, 200));
    check('同时建了高亮', n.body.highlight !== null);
    const noteId = n.body.note?.id;
    const hlId = n.body.highlight?.id;

    const h = await req<{ notes: { total: number; orphan: number } }>('GET', `/api/anchors/health?rel=${encodeURIComponent(created)}`);
    check('健康度：1 条批注 0 条失效', h.body.notes?.total === 1 && h.body.notes?.orphan === 0, JSON.stringify(h.body));

    // 越界 selector 必须被拒
    const badSel = await req('POST', '/api/notes', {
      rel: created,
      selector: { ...selector, blockIndex: 9999 },
      body: '越界',
    });
    check('越界 blockIndex 被拒（400）', badSel.status === 400, `实际 ${badSel.status}`);

    // ── 4. 外部修改文章 → 批注应自动跟随
    console.log('\n▸ 外部改文后批注跟随');
    const edited = ORIGINAL.replace(
      '## 状态转移方程',
      '## 状态转移方程\n\n这是新增的一段，用来把后面的块整体挤下去。\n\n> 这是新增的引用块。',
    );
    const w2 = await req<{ docHash: string }>('PUT', '/api/doc', {
      rel: created,
      markdown: edited,
      baseHash: o.body.docHash,
      reanalyze: false,
    });
    check('写入修改版成功', w2.status === 200);

    const o2 = await req<OpenResp & { anchorReport: { repaired: number; orphan: number } | null }>(
      'GET',
      `/api/doc?rel=${encodeURIComponent(created)}`,
    );
    const nt = o2.body.sidecar.notes[0] as unknown as {
      anchorState: string;
      selector: { blockIndex: number; textOffset: number };
    };
    check('批注仍然有效（未失效）', nt?.anchorState !== 'orphan', `实际 ${nt?.anchorState}`);
    const blk2 = o2.body.analysis.blocks[nt.selector.blockIndex];
    check(
      '批注指向的原文仍然正确',
      blk2?.text.slice(nt.selector.textOffset, nt.selector.textOffset + quote.length) === quote,
      `实际命中 ${JSON.stringify(blk2?.text.slice(nt.selector.textOffset, nt.selector.textOffset + quote.length))}`,
    );
    check('块序号确实变了（说明真的发生了重定位）', nt.selector.blockIndex !== target.bi, `原 ${target.bi} → 现 ${nt.selector.blockIndex}`);

    // ── 5. 删掉被批注的整句 → 必须 orphan
    console.log('\n▸ 删掉被批注的句子');
    const deleted = edited.replace('，它描述了状态之间的递推关系', '');
    await req('PUT', '/api/doc', { rel: created, markdown: deleted, baseHash: o2.body.docHash, reanalyze: false });
    const o3 = await req<OpenResp>('GET', `/api/doc?rel=${encodeURIComponent(created)}`);
    const nt3 = o3.body.sidecar.notes[0] as unknown as { anchorState: string; selector: { quote: string } };
    check('批注被标为 orphan（绝不猜位置）', nt3.anchorState === 'orphan', `实际 ${nt3.anchorState}`);
    check('orphan 时原始 selector 被保留', nt3.selector.quote === quote, nt3.selector.quote);

    // ── 6. 手动重绑
    console.log('\n▸ 手动重绑');
    const other = o3.body.analysis.blocks.find((b) => b.text.includes('好的状态定义'));
    if (other) {
      const q2 = '好的状态定义能让方程变得简单';
      const i2 = other.text.indexOf(q2);
      const rb = await req('POST', '/api/anchors/rebind', {
        rel: created,
        kind: 'note',
        id: noteId,
        selector: {
          type: 'text-quote',
          quote: q2,
          prefix: '',
          suffix: '',
          blockIndex: other.bi,
          textOffset: i2,
          quoteLength: q2.length,
        },
      });
      check('重绑成功', rb.status === 200, JSON.stringify(rb.body).slice(0, 200));
      const o4 = await req<OpenResp>('GET', `/api/doc?rel=${encodeURIComponent(created)}`);
      const nt4 = o4.body.sidecar.notes[0] as unknown as { anchorState: string };
      check('重绑后状态回到 ok', nt4.anchorState === 'ok', `实际 ${nt4.anchorState}`);
    }

    // ── 7. 一键排版
    console.log('\n▸ 一键排版');
    const messy = '第一章绪论\n\n本文研究  了  一个  问题\n这个问题的核心在于\n如何把长文本变整齐。\n\n1、第一条\n2、第二条\n\n\n\n\n结束。';
    const f = await req<{ markdown: string; changes: { rule: string; count: number }[] }>('POST', '/api/format', {
      markdown: messy,
    });
    check('排版返回 200', f.status === 200);
    check('合并了硬换行', f.body.markdown.includes('如何把长文本变整齐'), f.body.markdown.slice(0, 120));
    check('把编号行识别成标题或列表', /##|^-\s/m.test(f.body.markdown), f.body.markdown.slice(0, 120));
    check('压缩了多余空行', !/\n{3,}/.test(f.body.markdown));

    // ── 8. 上传 md
    console.log('\n▸ 上传');
    const up = await req<{ relPath: string }>(
      'POST',
      `/api/upload?dir=${encodeURIComponent('冒烟测试')}&name=${encodeURIComponent('上传测试.md')}&format=1`,
      undefined,
      { raw: Buffer.from('上传的小文件\n\n\n第二段', 'utf8'), contentType: 'text/markdown' },
    );
    check('上传 md 成功', up.status === 200, JSON.stringify(up.body).slice(0, 160));

    const upBad = await req(
      'POST',
      `/api/upload?dir=${encodeURIComponent('冒烟测试')}&name=${encodeURIComponent('坏文件.exe')}`,
      undefined,
      { raw: Buffer.from('MZ'), contentType: 'application/octet-stream' },
    );
    check('非法扩展名被拒（400）', upBad.status === 400, `实际 ${upBad.status}`);

    // 路径越界
    const escape = await req('GET', `/api/doc?rel=${encodeURIComponent('../../etc/passwd')}`);
    check('路径越界被拒（400）', escape.status === 400, `实际 ${escape.status}`);

    // ── 9. 闪卡与复习（不依赖 AI 的部分）
    console.log('\n▸ 闪卡与复习');
    const card = await req<{ id: string }>('POST', '/api/cards', {
      rel: created,
      front: '状态转移方程的作用是什么？',
      back: '描述状态之间的递推关系。',
    });
    check('手写卡片成功', card.status === 200);
    const q = await req<{ queue: unknown[]; stats: { total: number } }>('GET', '/api/review/queue?limit=20');
    check('复习队列可读', q.status === 200 && q.body.stats.total >= 1, JSON.stringify(q.body.stats));
    const rv = await req<{ card: { sm2: { interval: number; dueAt: string } } }>('POST', '/api/review', {
      rel: created,
      cardId: card.body.id,
      grade: 'good',
    });
    check('复习评分成功', rv.status === 200);
    check('SM-2 把间隔推到 1 天', rv.body.card?.sm2?.interval === 1, JSON.stringify(rv.body.card?.sm2));

    // ── 10. 清理与错误处理
    console.log('\n▸ 错误处理');
    const noAi = await req('POST', '/api/cheatsheet/generate', { rel: created });
    check('未配置 AI 时返回 409 + 可读提示', noAi.status === 409, `实际 ${noAi.status}`);
    check('提示指向设置页', JSON.stringify(noAi.body).includes('设置'), JSON.stringify(noAi.body).slice(0, 160));

    const del = await req<{ trashedTo: string }>('DELETE', `/api/entry?rel=${encodeURIComponent(created)}`);
    check('删除进回收站（不是真删）', del.status === 200, JSON.stringify(del.body).slice(0, 160));
    check('返回回收站路径', typeof del.body.trashedTo === 'string' && del.body.trashedTo.includes('trash'), JSON.stringify(del.body).slice(0, 160));
    const gone = await req('GET', `/api/doc?rel=${encodeURIComponent(created)}`);
    check('删除后文章不可读了（404）', gone.status === 404, `实际 ${gone.status}`);
    void hlId;
  }

  console.log(`\n══════ 结果：通过 ${pass}，失败 ${fail} ══════\n`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error('测试崩溃：', e);
  process.exit(1);
});
