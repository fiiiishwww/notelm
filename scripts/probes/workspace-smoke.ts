/**
 * 冒烟：①write_workspace 硬边界（逃逸路径必须被拒）②agent 真实调用写工作区落盘。
 * 直接调 sharedTools / chatWithAgent，不经 HTTP。
 */
import { sharedTools } from '../../server/services/agentTools';
import { chatWithAgent } from '../../server/services/libraryAgent';

async function main() {
  const ws = sharedTools().find((t) => t.name === 'write_workspace');
  if (!ws) throw new Error('write_workspace 工具不存在');

  // ① 边界：逃逸路径必须被拒
  const escapes: [string, string][] = [
    ['../她的小抄.md', '目录逃逸'],
    ['..\\her-note.md', '反斜杠逃逸'],
    ['C:/temp/evil.md', '绝对路径'],
    ['.assistant/agent/../inbox/hack.md', '前缀内逃逸'],
  ];
  for (const [file, why] of escapes) {
    try {
      await ws.run({ file, content: 'test' });
      console.log(`FAIL [${why}] ${file} —— 竟然写进去了！`);
    } catch {
      console.log(`ok   [${why}] 已拒绝`);
    }
  }

  // ② 正常写入（append 两次 + read 回读）
  await ws.run({ file: '工作日志.md', content: '# 工作日志\n\n- 2026-09-23 凌晨：write_workspace 工具上线冒烟。' });
  await ws.run({ file: '工作日志.md', content: '- 冒烟第二次追加：append 语义验证。' });
  const { readDoc } = await import('../server/vault');
  const doc = await readDoc('.assistant/agent/工作日志.md');
  const ok = doc.markdown.includes('工具上线冒烟') && doc.markdown.includes('append 语义验证');
  console.log(ok ? 'ok   append×2 落盘且可被 read_doc 读回' : 'FAIL 内容不符');

  // ③ 真实 agent 一轮：让它自己决定写点什么（验证系统提示词 + 工具闭环）
  const r = await chatWithAgent(
    [{ role: 'user', content: '请把「今晚上线了 write_workspace」这件事记进你的工作日志，然后告诉我你记了什么。' }],
    { docRel: '知识库/AI-Agent-Book/chapter1.md' },
  );
  console.log('agent stop=' + r.run.stop + ' tools=' + r.run.steps.filter((s) => s.kind === 'tool').map((s) => s.label).join(','));
  console.log('answer=' + r.answer.slice(0, 150).replace(/\n/g, ' | '));
  const doc2 = await readDoc('.assistant/agent/工作日志.md');
  console.log('workspace-files ok: 工作日志.md 现 ' + doc2.markdown.length + ' 字');
}

void main();
