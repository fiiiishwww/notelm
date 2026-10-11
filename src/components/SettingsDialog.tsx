/**
 * src/components/SettingsDialog.tsx —— 设置：笔记库 / AI 接口 / 外观。
 *
 * 两条产品决策：
 *   1. API Key 只写不读。服务端从不返回明文，前端也永远不回显，
 *      输入框留空 = 不改动已保存的 Key。这样即使用户在咖啡馆被人瞄到屏幕，
 *      也看不到完整的 key。
 *   2. 「更换笔记库」不会搬文件。它只是把指针指到另一个目录。
 *      这一点必须写清楚，否则用户会以为自己的文件被搬走了——
 *      这是这类「选择目录」功能最常见的误解。
 */

import { useEffect, useState } from 'react';
import { useApp } from '../state/store';
import { api, errorText } from '../api';
import { contrastOnWhite, DEFAULT_THEME_COLOR } from '../lib/themeColor';
import { Modal } from './Dialog';
import { Check, External, Warning } from './Icons';

type Tab = 'vault' | 'ai' | 'embedding' | 'feishu' | 'appearance';

/** 预设糖果色。第一个就是默认主色；想加新色直接往这里塞 hex。 */
const THEME_PRESETS: { hex: string; name: string }[] = [
  { hex: '#35c47f', name: '糖果绿' },
  { hex: '#4ecdc4', name: '湖蓝' },
  { hex: '#38bdf8', name: '晴空蓝' },
  { hex: '#7c9cf5', name: '风信紫' },
  { hex: '#a78bfa', name: '薰衣草' },
  { hex: '#f472b6', name: '蜜桃粉' },
  { hex: '#ff8fab', name: '樱粉' },
  { hex: '#ffc94d', name: '奶油黄' },
  { hex: '#f59e0b', name: '蜜橘' },
  { hex: '#ff6b6b', name: '珊瑚红' },
];

export function SettingsDialog() {
  const { state, actions } = useApp();
  const [tab, setTab] = useState<Tab>('vault');
  const s = state.settings;

  // ── 笔记库表单 ──
  const [vaultPath, setVaultPath] = useState('');
  const [openingVault, setOpeningVault] = useState(false);

  // ── AI 表单 ──
  const [baseURL, setBaseURL] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [temperature, setTemperature] = useState(0.3);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  // ── 向量接口表单（和对话接口完全独立的一套凭据） ──
  const [embBaseURL, setEmbBaseURL] = useState('');
  const [embModel, setEmbModel] = useState('');
  const [embKey, setEmbKey] = useState('');
  const [embDim, setEmbDim] = useState(0);
  const [embTesting, setEmbTesting] = useState(false);
  const [embTestResult, setEmbTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  // ── 飞书导入（第三套凭据：app_id + app_secret，走 tenant_access_token）──
  const [fsAppId, setFsAppId] = useState('');
  const [fsSecret, setFsSecret] = useState('');
  const [fsTesting, setFsTesting] = useState(false);
  const [fsTestResult, setFsTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  // 打开弹窗时把服务端状态灌进表单
  useEffect(() => {
    if (!s) return;
    setVaultPath(s.vault.root ?? '');
    setBaseURL(s.ai.baseURL);
    setModel(s.ai.model);
    setTemperature(s.ai.temperature);
    setApiKey('');
    setTestResult(null);
    setEmbBaseURL(s.embedding.baseURL);
    setEmbModel(s.embedding.model);
    setEmbDim(s.embedding.dimensions);
    setEmbKey('');
    setEmbTestResult(null);
    setFsAppId(s.feishu.appId);
    setFsSecret('');
    setFsTestResult(null);
  }, [s]);

  if (!s) return null;

  const close = () => actions.closeSettings();

  return (
    <Modal
      title="设置"
      onClose={close}
      width={640}
      headerExtra={
        <div className="tabs">
          <button className={tab === 'vault' ? 'active' : ''} onClick={() => setTab('vault')}>
            笔记库
          </button>
          <button className={tab === 'ai' ? 'active' : ''} onClick={() => setTab('ai')}>
            AI 接口
          </button>
          <button className={tab === 'embedding' ? 'active' : ''} onClick={() => setTab('embedding')}>
            检索（向量）
          </button>
          <button className={tab === 'feishu' ? 'active' : ''} onClick={() => setTab('feishu')}>
            飞书导入
          </button>
          <button className={tab === 'appearance' ? 'active' : ''} onClick={() => setTab('appearance')}>
            外观
          </button>
        </div>
      }
      footer={
        <>
          <span className="grow" />
          <button className="btn" onClick={close}>
            关闭
          </button>
          {tab === 'vault' ? (
            <button
              className="btn primary"
              disabled={!vaultPath.trim() || vaultPath.trim() === s.vault.root}
              onClick={() => void actions.setVault({ root: vaultPath.trim() })}
            >
              切换到这个目录
            </button>
          ) : null}
          {tab === 'ai' ? (
            <button
              className="btn primary"
              onClick={() =>
                void actions.saveAi({
                  baseURL,
                  model,
                  temperature,
                  // 空串表示「不改 Key」，服务端会保留原来那个
                  apiKey: apiKey.trim() || undefined,
                })
              }
            >
              保存
            </button>
          ) : null}
          {tab === 'embedding' ? (
            <button
              className="btn primary"
              onClick={() =>
                void actions.saveEmbedding({
                  baseURL: embBaseURL,
                  model: embModel,
                  dimensions: embDim,
                  apiKey: embKey.trim() || undefined,
                })
              }
            >
              保存
            </button>
          ) : null}
          {tab === 'feishu' ? (
            <button
              className="btn primary"
              onClick={() =>
                void actions.saveFeishu({
                  appId: fsAppId,
                  // 空串表示「不改 Secret」，和 AI / 向量那两页一个规矩
                  appSecret: fsSecret.trim() || undefined,
                })
              }
            >
              保存
            </button>
          ) : null}
        </>
      }
    >
      {tab === 'vault' ? (
        <>
          <div className="field">
            <label>当前笔记库</label>
            <div className="path-box">{s.vault.root ?? '（未设置）'}</div>
            <div className="hint">
              共 {s.vault.docCount} 篇文章。所有内容都是这个目录下的普通 Markdown 文件，
              可以直接用 Obsidian、VS Code 或任何编辑器打开，两侧改动都能互相看到。
            </div>
          </div>

          <div className="field">
            <label>换成别的目录</label>
            <div className="row">
              <input
                className="input"
                style={{ flex: 1, minWidth: 260 }}
                value={vaultPath}
                placeholder="例如 D:\我的笔记"
                onChange={(e) => setVaultPath(e.target.value)}
              />
              <button className="btn" onClick={() => setVaultPath(s.defaultVault)}>
                用默认目录
              </button>
            </div>
            <div className="hint">
              填目录的绝对路径。目录不存在会自动创建。
              <b>切换笔记库不会搬动任何文件</b>，只是换个目录来读写。
            </div>
          </div>

          <div className="field">
            <label>默认目录</label>
            <div className="path-box">{s.defaultVault}</div>
            <div className="hint">
              这是装在本软件目录下的 notes/，不改配置就能直接用。想让它随便放一个地方，
              就把上面的路径改成你要的位置。
            </div>
          </div>

          <div className="row" style={{ marginBottom: 14 }}>
            <button
              className="btn"
              disabled={!s.vault.configured || openingVault}
              onClick={async () => {
                setOpeningVault(true);
                try {
                  await api.openVault();
                } catch (e) {
                  actions.toast('error', errorText(e));
                } finally {
                  setOpeningVault(false);
                }
              }}
            >
              <External /> 在文件管理器中打开
            </button>
            <button className="btn" onClick={() => void actions.reloadTree()}>
              重新扫描目录
            </button>
          </div>

          <div className="banner info" style={{ marginBottom: 14 }}>
            <Warning width={14} height={14} />
            <span>
              批注、小抄、闪卡都存在笔记库里的 <code>.notebook</code> 目录，和 Markdown 文件一一对应。
              分享笔记时把这个目录排除掉，就只剩干净的正文。
            </span>
          </div>
        </>
      ) : null}

      {tab === 'ai' ? (
        <>
          <div className="field">
            <label>接口地址（OpenAI 兼容）</label>
            <input
              className="input"
              value={baseURL}
              placeholder="https://api.deepseek.com/v1"
              onChange={(e) => setBaseURL(e.target.value)}
            />
            <div className="hint">
              填到 <code>/v1</code> 为止即可，路径会自动补全。常见填法：
              <br />
              DeepSeek <code>https://api.deepseek.com/v1</code> · OpenAI{' '}
              <code>https://api.openai.com/v1</code> · 本地 Ollama <code>http://localhost:11434/v1</code>
            </div>
          </div>

          <div className="field">
            <label>模型名</label>
            <input
              className="input"
              value={model}
              placeholder="deepseek-chat"
              onChange={(e) => setModel(e.target.value)}
            />
          </div>

          <div className="field">
            <label>API Key</label>
            <div className="row">
              <input
                className="input"
                style={{ flex: 1, minWidth: 240 }}
                type="password"
                value={apiKey}
                placeholder={s.ai.hasApiKey ? '已保存（留空表示不修改）' : '粘贴你的 API Key'}
                onChange={(e) => setApiKey(e.target.value)}
              />
              {s.ai.hasApiKey ? (
                <span className="tag-chip" style={{ color: 'var(--ok)' }}>
                  <Check width={11} height={11} /> 已保存
                </span>
              ) : null}
            </div>
            <div className="hint">
              Key 只保存在本机的 .local/secrets.json 里，不会上传到任何地方，
              界面上也永远不会再显示出来。想清空就点下面的按钮。
            </div>
          </div>

          <div className="field">
            <label>温度（{temperature.toFixed(1)}）</label>
            <input
              type="range"
              min={0}
              max={1}
              step={0.1}
              value={temperature}
              onChange={(e) => setTemperature(Number(e.target.value))}
              style={{ width: 240 }}
            />
            <div className="hint">
              越低越忠于原文。归纳小抄和出题建议 0.1~0.3，太高会开始「自由发挥」。
            </div>
          </div>

          <div className="row" style={{ marginBottom: 12 }}>
            <button
              className="btn"
              disabled={testing}
              onClick={async () => {
                setTesting(true);
                setTestResult(null);
                try {
                  // 先存再测：如果拿未保存的地址去测，测的是旧配置，很容易误判成「连不上」
                  await api.setAi({ baseURL, model, temperature, apiKey: apiKey.trim() || undefined });
                  const r = await api.testAi();
                  setTestResult(
                    r.ok
                      ? { ok: true, text: `连接成功：${r.model ?? model}${r.ms ? `，${r.ms}ms` : ''}` }
                      : { ok: false, text: r.error ?? '接口返回了异常，请检查地址和模型名' },
                  );
                  setApiKey('');
                  await actions.refreshSettings();
                } catch (e) {
                  setTestResult({ ok: false, text: errorText(e) });
                } finally {
                  setTesting(false);
                }
              }}
            >
              {testing ? <span className="spinner" /> : null} 测试连接
            </button>
            <button
              className="btn danger"
              disabled={!s.ai.hasApiKey}
              onClick={() => void actions.clearAiKey()}
            >
              清空 API Key
            </button>
          </div>

          {testResult ? (
            <div className={`banner ${testResult.ok ? 'info' : 'error'}`} style={{ marginBottom: 14 }}>
              <Warning width={14} height={14} />
              <span>{testResult.text}</span>
            </div>
          ) : null}

          <div className={`banner ${s.ai.configured ? 'info' : 'warn'}`} style={{ marginBottom: 14 }}>
            <Warning width={14} height={14} />
            <span>
              {s.ai.configured
                ? 'AI 已就绪：一键生成小抄、出题、批注转闪卡都可用。'
                : '三项（地址 / 模型 / Key）都填好之后，AI 功能才会打开。没配置也不影响阅读和批注。'}
            </span>
          </div>
        </>
      ) : null}

      {tab === 'embedding' ? (
        <>
          <div className="banner info" style={{ marginBottom: 14 }}>
            <Warning width={14} height={14} />
            <span>
              这是<b>独立的一套凭据</b>，和「AI 接口」那页的地址、模型、Key 都不共用。
              对话可以走 DeepSeek，向量走另一家——因为它们本来就是两件事，价格也差很多。
              <br />
              不配置也能用检索，只是退化成关键词匹配（按字面找，不做语义联想）。
            </span>
          </div>

          <div className="field">
            <label>向量接口地址（OpenAI 兼容）</label>
            <input
              className="input"
              value={embBaseURL}
              placeholder="https://api.siliconflow.cn/v1"
              onChange={(e) => setEmbBaseURL(e.target.value)}
            />
            <div className="hint">
              填到 <code>/v1</code> 为止，路径会自动补成 <code>/embeddings</code>。
              <br />
              硅基流动 <code>https://api.siliconflow.cn/v1</code> · OpenAI{' '}
              <code>https://api.openai.com/v1</code> · 本地 Ollama <code>http://localhost:11434/v1</code>
            </div>
          </div>

          <div className="field">
            <label>Embedding 模型名</label>
            <input
              className="input"
              value={embModel}
              placeholder="BAAI/bge-m3"
              onChange={(e) => setEmbModel(e.target.value)}
            />
            <div className="hint">
              必须是专门做向量的模型，<b>对话模型不能当 embedding 用</b>（接口会返回 422）。
              常见的有 <code>BAAI/bge-m3</code>、<code>text-embedding-3-small</code>、
              <code>nomic-embed-text</code>（Ollama）。
            </div>
          </div>

          <div className="field">
            <label>API Key</label>
            <div className="row">
              <input
                className="input"
                style={{ flex: 1, minWidth: 240 }}
                type="password"
                value={embKey}
                placeholder={s.embedding.hasApiKey ? '已保存（留空表示不修改）' : '粘贴这个接口的 API Key'}
                onChange={(e) => setEmbKey(e.target.value)}
              />
              {s.embedding.hasApiKey ? (
                <span className="tag-chip" style={{ color: 'var(--ok)' }}>
                  <Check width={11} height={11} /> 已保存
                </span>
              ) : null}
            </div>
            <div className="hint">和对话接口的 Key 分开存，同样只写不读。</div>
          </div>

          <div className="field">
            <label>向量维度（可选）</label>
            <div className="row">
              <input
                className="input"
                type="number"
                min={0}
                max={8192}
                style={{ width: 120 }}
                value={embDim || ''}
                placeholder="自动"
                onChange={(e) => setEmbDim(Math.max(0, Number(e.target.value) || 0))}
              />
              <span className="hint" style={{ margin: 0 }}>
                填 0 或留空 = 用接口返回的原生维度。
              </span>
            </div>
            <div className="hint">
              只有少数模型支持自定义维度（例如 <code>text-embedding-3</code> 系列）。
              填了不支持的模型会被接口拒绝——报错时把它改回自动即可。
            </div>
          </div>

          <div className="row" style={{ marginBottom: 12 }}>
            <button
              className="btn"
              disabled={embTesting}
              onClick={async () => {
                setEmbTesting(true);
                setEmbTestResult(null);
                try {
                  // 先存再测，理由和对话接口一样：别拿未保存的地址去测旧配置
                  await api.setEmbedding({
                    baseURL: embBaseURL,
                    model: embModel,
                    dimensions: embDim,
                    apiKey: embKey.trim() || undefined,
                  });
                  const r = await api.testEmbedding();
                  setEmbTestResult(
                    r.ok
                      ? { ok: true, text: `连接成功：${r.model ?? embModel}，${r.dim ?? '?'} 维${r.ms ? `，${r.ms}ms` : ''}` }
                      : { ok: false, text: r.error ?? '接口返回了异常，请检查地址和模型名' },
                  );
                  setEmbKey('');
                  await actions.refreshSettings();
                } catch (e) {
                  setEmbTestResult({ ok: false, text: errorText(e) });
                } finally {
                  setEmbTesting(false);
                }
              }}
            >
              {embTesting ? <span className="spinner" /> : null} 测试连接
            </button>
            <button
              className="btn danger"
              disabled={!s.embedding.hasApiKey}
              onClick={() => void actions.clearEmbeddingKey()}
            >
              清空 Key
            </button>
          </div>

          {embTestResult ? (
            <div className={`banner ${embTestResult.ok ? 'info' : 'error'}`} style={{ marginBottom: 14 }}>
              <Warning width={14} height={14} />
              <span>{embTestResult.text}</span>
            </div>
          ) : null}

          <div className={`banner ${s.embedding.configured ? 'info' : 'warn'}`} style={{ marginBottom: 14 }}>
            <Warning width={14} height={14} />
            <span>
              {s.embedding.configured
                ? '向量接口已就绪。到「检索」页点一次「重建」，之后检索就是语义匹配了。'
                : '三项（地址 / 模型 / Key）都填好之后才是语义检索。不填也能在「检索」页用关键词找。'}
            </span>
          </div>
        </>
      ) : null}

      {tab === 'feishu' ? (
        <>
          <div className="banner info" style={{ marginBottom: 14 }}>
            <Warning width={14} height={14} />
            <span>
              配好之后，在左栏点 <code>导入</code>、粘一个飞书文档链接，就能把正文
              <b>连图一起</b>拿回来。
              <br />
              为什么不直接复制粘贴：飞书的图存在云空间里，剪贴板拿到的是带一次性鉴权参数的地址，
              粘出来就是死链。要保住图只能走官方接口。
              <br />
              不想配也能用：在飞书里 <code>··· → 导出/下载 → Markdown</code> 拿到 zip，
              用「导入」里的压缩包页签导进来，图一样不丢。
            </span>
          </div>

          <div className="field">
            <label>App ID</label>
            <input
              className="input"
              value={fsAppId}
              placeholder="cli_ 开头，例如 cli_a1b2c3d4e5f6g7h8"
              onChange={(e) => setFsAppId(e.target.value)}
            />
            <div className="hint">
              它不算机密（飞书的报错信息里也会带上），所以明文存在配置里，界面上也看得见。
            </div>
          </div>

          <div className="field">
            <label>App Secret</label>
            <div className="row">
              <input
                className="input"
                style={{ flex: 1, minWidth: 240 }}
                type="password"
                value={fsSecret}
                placeholder={s.feishu.hasAppSecret ? '已保存（留空表示不修改）' : '粘贴 App Secret'}
                onChange={(e) => setFsSecret(e.target.value)}
              />
              {s.feishu.hasAppSecret ? (
                <span className="tag-chip" style={{ color: 'var(--ok)' }}>
                  <Check width={11} height={11} /> 已保存
                </span>
              ) : null}
            </div>
            <div className="hint">和 AI Key 一样只写不读，只存在本机，界面上永远不会再显示出来。</div>
          </div>

          <div className="row" style={{ marginBottom: 12 }}>
            <button
              className="btn"
              disabled={fsTesting}
              onClick={async () => {
                setFsTesting(true);
                setFsTestResult(null);
                try {
                  // 先存再测：拿还没保存的凭据去测，测的是旧配置，很容易误判成「连不上」
                  await api.setFeishu({ appId: fsAppId, appSecret: fsSecret.trim() || undefined });
                  const r = await api.testFeishu();
                  setFsTestResult({ ok: r.ok, text: r.message });
                  setFsSecret('');
                  await actions.refreshSettings();
                } catch (e) {
                  setFsTestResult({ ok: false, text: errorText(e) });
                } finally {
                  setFsTesting(false);
                }
              }}
            >
              {fsTesting ? <span className="spinner" /> : null} 测试连接
            </button>
            <button
              className="btn danger"
              disabled={!s.feishu.hasAppSecret}
              onClick={() => void actions.clearFeishuSecret()}
            >
              清空 Secret
            </button>
          </div>

          {fsTestResult ? (
            <div className={`banner ${fsTestResult.ok ? 'info' : 'error'}`} style={{ marginBottom: 14 }}>
              <Warning width={14} height={14} />
              <span>{fsTestResult.text}</span>
            </div>
          ) : null}

          <div className="field">
            <label>还没有应用？按这五步开通</label>
            <ol className="import-steps">
              <li>
                打开 <code>open.feishu.cn/app</code>，用飞书账号登录，点
                <b>创建企业自建应用</b>（名字随便填，比如「笔记导入器」）。
              </li>
              <li>
                左侧<b>权限管理</b>，按中文名搜这三项开通（scope 名可能随版本调整，中文名更稳）：
                <br />
                <code>查看新版文档</code> 读正文 · <code>下载云文档中的图片和附件</code>{' '}
                <b>把图拿回来，没有它就丢图</b> · <code>查看知识库</code> 只在用 wiki 链接时需要
              </li>
              <li>
                顶部<b>创建版本 → 申请发布</b>。<b>不发布权限不生效</b>——这是最常漏的一步，
                填完凭据却一直报 403，多半卡在这里。
              </li>
              <li>
                <b>凭证与基础信息</b> 页复制 App ID 和 App Secret，粘到上面两个框里。
              </li>
              <li>
                对<b>每一篇</b>要导入的文档：右上角 <b>··· → 添加文档应用</b>，把应用加进去。
                应用只能读授权给它的文档，没加就是 403。
              </li>
            </ol>
            <div className="hint">
              只用到读接口，不会改动你在飞书里的任何内容；权限也不会超出你本人的可见范围。
              5 QPS 的限制意味着一篇 50 张图的文档要等十几秒，这是飞书侧的硬限制。
            </div>
          </div>

          <div className={`banner ${s.feishu.configured ? 'info' : 'warn'}`} style={{ marginBottom: 14 }}>
            <Warning width={14} height={14} />
            <span>
              {s.feishu.configured
                ? '飞书导入已就绪。到左栏点「导入」，粘链接即可。'
                : '两项都填好之后，左栏「导入」里的飞书页签才可用。'}
            </span>
          </div>
        </>
      ) : null}

      {tab === 'appearance' ? (
        <>
          <div className="field">
            <label>主题</label>
            <div className="row">
              <button
                className={`btn${s.theme === 'light' ? ' toggle-on' : ''}`}
                onClick={() => actions.setTheme('light')}
              >
                浅色
              </button>
              <button className={`btn${s.theme === 'dark' ? ' toggle-on' : ''}`} onClick={() => actions.setTheme('dark')}>
                深色
              </button>
            </div>
            <div className="hint">深色更适合晚上长时间读，浅色更接近纸质书。</div>
          </div>

          <div className="field">
            <label>主题颜色</label>
            <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
              {THEME_PRESETS.map((p) => {
                const active = (s.themeColor ?? DEFAULT_THEME_COLOR).toLowerCase() === p.hex.toLowerCase();
                return (
                  <button
                    key={p.hex}
                    title={`${p.name} ${p.hex}`}
                    aria-label={`主题颜色：${p.name}`}
                    onClick={() => actions.setThemeColor(p.hex)}
                    style={{
                      width: 32,
                      height: 32,
                      borderRadius: 999,
                      border: active ? '2px solid var(--text)' : '1px solid var(--border-strong)',
                      background: p.hex,
                      cursor: 'pointer',
                      padding: 0,
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    {active ? <Check width={14} height={14} color="#fff" /> : null}
                  </button>
                );
              })}
              {/* 自定义：native color input，选择过程实时生效 */}
              <input
                type="color"
                aria-label="自定义主题颜色"
                value={s.themeColor ?? DEFAULT_THEME_COLOR}
                onChange={(e) => actions.setThemeColor(e.target.value)}
                style={{
                  width: 44,
                  height: 32,
                  padding: 0,
                  border: '1px solid var(--border-strong)',
                  borderRadius: 999,
                  background: 'none',
                  cursor: 'pointer',
                }}
              />
            </div>
            <div className="hint">
              点色块立即生效并保存。选中色的对比度
              {contrastOnWhite(s.themeColor ?? DEFAULT_THEME_COLOR) < 3 ? (
                <b style={{ color: 'var(--warn)' }}>不足 3:1 —— 主按钮上的白字会看不清，建议再深一点</b>
              ) : (
                '正常（主按钮白字可读）'
              )}
              。改动只影响主色和强调处；错误红 / 成功绿这些语义色不受影响。
            </div>
          </div>

          <div className="field">
            <label>面板宽度</label>
            <div className="hint" style={{ marginBottom: 8 }}>
              左 {Math.round(s.panelWidths.left)}px · 右 {Math.round(s.panelWidths.right)}px
              。也可以直接拖面板之间的那条线，双击分隔条恢复默认。
            </div>
            <button
              className="btn"
              onClick={() => actions.savePanelWidths({ left: 280, right: 340 })}
              disabled={s.panelWidths.left === 280 && s.panelWidths.right === 340}
            >
              恢复默认宽度
            </button>
          </div>

          <div className="field">
            <label>快捷键</label>
            <div className="hint" style={{ lineHeight: 2 }}>
              <span className="kbd">Ctrl</span> + <span className="kbd">S</span> 保存文章 ·{' '}
              <span className="kbd">Ctrl</span> + <span className="kbd">E</span> 进入/退出编辑 ·{' '}
              <span className="kbd">Esc</span> 取消当前选中
            </div>
          </div>
        </>
      ) : null}
    </Modal>
  );
}
