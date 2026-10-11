/**
 * src/components/ImportPanes.tsx —— 「飞书链接」和「ZIP 包」两块面板。
 *
 * ★ 为什么这块没有自己的 Modal 外壳 ★
 *   原来飞书和压缩包各自占一个「导入」弹窗，和「上传」弹窗并列，
 *   目录栏上就出现了两个图标（一个向上箭头、一个向下箭头）——用户分不清该点哪个，
 *   实际上是同一个动作：「把外面的东西拿进来」。所以合并进 UploadDialog 的三页签里，
 *   这里只留面板本体，外壳、页签、收尾（刷新树 / 打开 / 提示 / 关闭）全交给父组件。
 *
 * ★ 为什么两块面板各自管自己的 busy 和 outcome ★
 *   同一个时刻只会显示一块，让它们自己持有表单状态最简单；
 *   父组件在 busy 时锁住页签切换，就不会出现「飞书还在下图中，切去 ZIP 把状态丢了」。
 *   导入成功后统一走 onImported，由父组件决定要不要自动打开新文章。
 */

import { useEffect, useRef, useState } from 'react';
import { api, errorText, type FeishuImportResult, type FeishuPeek, type ZipImportResult } from '../api';
import { useApp } from '../state/store';
import type { DirOption } from '../hooks/useDirOptions';
import { humanSize } from './UploadDialog';
import { Check, FileText, Gear, Wand, Warning } from './Icons';

/** 后端 routes/import.ts 的硬限制，前端提前拦，别让用户传完了才报错。 */
const MAX_ZIP_BYTES = 200 * 1024 * 1024;

/** 结果页要展示的东西。两块面板各构造一次，渲染共用一套。 */
export interface Outcome {
  ok: boolean;
  rows: { text: string; detail?: string; bad?: boolean }[];
  /** 后端觉得「需要让人知道」的事：改名、图没下全、有块没转成 */
  warnings: string[];
  /** 顺利时点「打开」直接跳过去 */
  openRel: string | null;
}

interface PaneProps {
  dir: string;
  dirs: DirOption[];
  onDir: (v: string) => void;
  format: boolean;
  onFormat: (v: boolean) => void;
  /** 导入完成，交给父组件收尾 */
  onImported: (o: Outcome) => void;
  /** 让父组件知道能不能切页签 */
  onBusy: (busy: boolean) => void;
  /** 面板当前能不能提交（给父组件的按钮用） */
  onReady: (ready: boolean) => void;
  /** 触发提交——父组件的「导入」按钮调它 */
  submitRef: React.MutableRefObject<(() => void) | null>;
  /** 关掉整个弹窗（「去设置」要先关自己，否则两个遮罩互相挡） */
  onClose: () => void;
}

function baseOf(rel: string): string {
  return rel.slice(rel.lastIndexOf('/') + 1);
}

// ───────────────────────── 飞书链接 ─────────────────────────

export function FeishuPane({
  dir,
  dirs,
  onDir,
  format,
  onFormat,
  onImported,
  onBusy,
  onReady,
  submitRef,
  onClose,
}: PaneProps) {
  const { state, actions } = useApp();
  const [url, setUrl] = useState('');
  const [peek, setPeek] = useState<FeishuPeek | null>(null);
  const [peekErr, setPeekErr] = useState('');
  const [peeking, setPeeking] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const ready = Boolean(state.settings?.feishu.configured);

  /**
   * 预览只看标题，很快。用 seq 丢弃过期结果：
   * 切目录会连着发好几次请求，慢的那次后到就把新结果盖掉了。
   */
  const peekSeq = useRef(0);
  const runPeek = async (raw: string, targetDir: string) => {
    const u = raw.trim();
    if (!u) return;
    const seq = ++peekSeq.current;
    setPeeking(true);
    setPeekErr('');
    try {
      const r = await api.feishuPeek(u, targetDir);
      if (seq !== peekSeq.current) return;
      setPeek(r);
    } catch (e) {
      if (seq !== peekSeq.current) return;
      setPeek(null);
      setPeekErr(errorText(e));
    } finally {
      if (seq === peekSeq.current) setPeeking(false);
    }
  };

  // 换目录后重新算一次「会存成什么」：存成什么是后端按「不覆盖已有文件」算出来的，
  // 换个目录结论就变了。沿用旧结果会给出错误的重名提示——
  // 而这种提示存在的意义就是让人安心，错了比没有更糟。
  useEffect(() => {
    if (!peek) return;
    void runPeek(url, dir);
    // 只在 dir 变化时跑：url 或 peek 变化会各自走自己的路径，不必在这里重入
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dir]);

  const run = async () => {
    setBusy(true);
    onBusy(true);
    try {
      const r = await api.importFeishu({
        url: url.trim(),
        // 预览过就把 id 和标题一起带过去，后端能省掉两次接口调用
        documentId: peek?.documentId,
        title: peek?.title,
        dir,
        name: name.trim() || undefined,
        format,
      });
      const bits: string[] = [];
      if (r.imageCount) bits.push(`${r.imageCount} 张图`);
      bits.push(`${r.blockCount} 个块`);
      onImported({
        ok: true,
        rows: [{ text: r.relPath, detail: bits.join(' · ') }],
        warnings: r.warnings,
        openRel: r.relPath,
      });
    } catch (e) {
      onImported({
        ok: false,
        rows: [{ text: '导入失败', detail: errorText(e), bad: true }],
        warnings: [],
        openRel: null,
      });
    } finally {
      setBusy(false);
      onBusy(false);
    }
  };

  // 父组件的按钮通过 ref 拿到提交函数，避免把整个表单状态提上去
  submitRef.current = run;
  const canSubmit = ready && Boolean(url.trim()) && !busy;
  useEffect(() => onReady(canSubmit), [canSubmit, onReady]);

  if (!ready) {
    return (
      <>
        <div className="banner warn" style={{ marginBottom: 12 }}>
          <Warning width={15} height={15} />
          <span>还没配置飞书应用。配好之后粘一个链接就能把文档连图一起拿回来。</span>
        </div>
        <ol className="import-steps">
          <li>
            打开 <code>open.feishu.cn/app</code> → <b>创建企业自建应用</b>
          </li>
          <li>
            开通权限：<b>查看新版文档</b>、<b>下载图片和附件</b>、<b>查看知识库</b>
          </li>
          <li>
            <b>创建版本并发布</b>——不发布权限不生效，最常漏的就是这步
          </li>
          <li>
            文档右上角 <b>··· → 添加文档应用</b>，把这个应用加进去
          </li>
        </ol>
        <div className="row">
          <button
            className="btn primary"
            onClick={() => {
              // 先关自己再开设置：两个弹窗叠在一起，遮罩会互相挡住
              onClose();
              actions.openSettings();
            }}
          >
            <Gear width={13} height={13} /> 去设置里填 App ID
          </button>
          <span className="hint" style={{ margin: 0 }}>
            不想配就用「ZIP 包」，在飞书里导出 zip 直接导，图一样不丢。
          </span>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="field">
        <label>文档链接</label>
        <div className="row">
          <input
            className="input"
            style={{ flex: 1, minWidth: 200 }}
            value={url}
            placeholder="https://xxx.feishu.cn/docx/…（也可以直接粘 document_id）"
            onChange={(e) => {
              setUrl(e.target.value);
              setPeek(null);
              setPeekErr('');
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void runPeek(url, dir);
            }}
          />
          <button className="btn" disabled={peeking || !url.trim()} onClick={() => void runPeek(url, dir)}>
            {peeking ? <span className="spinner" /> : null} 预览
          </button>
        </div>
        <div className="hint">
          支持新版文档（<code>/docx/</code>）和知识库（<code>/wiki/</code>）；旧版文档（
          <code>/docs/</code>）要先在飞书里转成新版。
        </div>
      </div>

      {peekErr ? (
        <div className="banner error" style={{ marginBottom: 12 }}>
          <Warning width={15} height={15} />
          <span>{peekErr}</span>
        </div>
      ) : null}

      <div className="field">
        <label>存到</label>
        <select className="input" value={dir} onChange={(e) => onDir(e.target.value)} disabled={busy}>
          {dirs.map((d) => (
            <option key={d.rel} value={d.rel}>
              {d.label}
            </option>
          ))}
        </select>
      </div>

      {peek ? (
        <div className="field">
          <label>文件名</label>
          <div className="row">
            <input
              className="input"
              style={{ flex: 1, minWidth: 200 }}
              value={name}
              placeholder={peek.suggestedName}
              onChange={(e) => setName(e.target.value)}
              disabled={busy}
            />
            <span className="hint" style={{ margin: 0 }}>
              .md
            </span>
          </div>
          <div className="hint">
            原标题「{peek.title}」
            {peek.renamed ? (
              <>
                {' '}
                · 该目录已有同名文章，会存成「{baseOf(peek.suggestedRel)}」，
                <b>不会覆盖原来那篇</b>
              </>
            ) : null}
            。留空就用原标题。
          </div>
        </div>
      ) : null}

      <label className={`upload-opt${busy ? ' disabled' : ''}`}>
        <input type="checkbox" checked={format} onChange={(e) => onFormat(e.target.checked)} disabled={busy} />
        <Wand width={14} height={14} />
        <span>
          <b>导入时一键排版</b>
          <em>合并被硬换行的段落、识别标题、清掉页眉页脚噪声。</em>
        </span>
      </label>

      <div className="hint" style={{ marginTop: 10 }}>
        图片存进文章同级的 <code>assets/</code>，正文用相对路径引用——用 Obsidian、VS Code 打开也是好的。
      </div>

      {busy ? (
        <div className="banner info" style={{ marginTop: 12 }}>
          <span className="spinner" />
          <span>正在读取文档并下载图片。图多的话要等十几秒——飞书限制每秒 5 次调用，只能一张张来。</span>
        </div>
      ) : null}
    </>
  );
}

// ───────────────────────── ZIP 包 ─────────────────────────

export function ZipPane({
  dir,
  dirs,
  onDir,
  format,
  onFormat,
  onImported,
  onBusy,
  onReady,
  submitRef,
  onClose,
}: PaneProps) {
  const [zip, setZip] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const oversize = zip ? zip.size > MAX_ZIP_BYTES : false;
  const zipName = zip ? zip.name.toLowerCase() : '';
  const badZip = zip ? (!zipName.endsWith('.zip') ? '不是 .zip 文件' : oversize ? '超过 200MB' : '') : '';

  const run = async () => {
    if (!zip) return;
    setBusy(true);
    onBusy(true);
    try {
      const r: ZipImportResult = await api.importZip(zip, { dir, format });
      const rows = r.relPaths.map((p, i) => ({
        text: p,
        detail: i === 0 ? `共 ${r.count} 篇${r.imageCount ? ` · ${r.imageCount} 张图` : ''}` : undefined,
      }));
      onImported({ ok: true, rows, warnings: r.warnings, openRel: r.primaryRel });
    } catch (e) {
      onImported({
        ok: false,
        rows: [{ text: zip.name, detail: errorText(e), bad: true }],
        warnings: [],
        openRel: null,
      });
    } finally {
      setBusy(false);
      onBusy(false);
    }
  };

  submitRef.current = run;
  const canSubmit = Boolean(zip) && !badZip && !busy;
  useEffect(() => onReady(canSubmit), [canSubmit, onReady]);

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept=".zip"
        style={{ display: 'none' }}
        onChange={(e) => {
          setZip(e.target.files?.[0] ?? null);
          e.target.value = '';
        }}
      />

      <div className="field">
        <label>压缩包</label>
        <div className="row">
          <button className="btn" onClick={() => inputRef.current?.click()} disabled={busy}>
            <FileText width={13} height={13} /> {zip ? '换一个' : '选择 .zip 文件'}
          </button>
          {zip ? (
            <span className="tag-chip">
              {humanSize(zip.size)}
              {badZip ? <span style={{ color: 'var(--danger)' }}> · {badZip}</span> : null}
            </span>
          ) : null}
        </div>
        <div className="hint">
          飞书 <code>··· → 导出 → Markdown</code> 拿到的就是这种包，里面的图是真实文件，
          <b>不用配任何凭据</b>；语雀、Notion 的导出包同样能吃。
        </div>
      </div>

      {zip ? (
        <div className="upload-list">
          <div className={`upload-row${badZip ? ' blocked' : ''}`}>
            <span className="upload-icon">
              <FileText width={14} height={14} />
            </span>
            <span className="upload-name" title={zip.name}>
              {zip.name}
            </span>
            <span className="upload-size">{humanSize(zip.size)}</span>
            <span className="upload-act">{badZip || '按包内结构存'}</span>
          </div>
        </div>
      ) : null}

      <div className="field">
        <label>存到</label>
        <select className="input" value={dir} onChange={(e) => onDir(e.target.value)} disabled={busy}>
          {dirs.map((d) => (
            <option key={d.rel} value={d.rel}>
              {d.label}
            </option>
          ))}
        </select>
        <div className="hint">包最外面那层目录会被剥掉（打包时加的），只认 md / txt 和图片。</div>
      </div>

      <label className={`upload-opt${busy ? ' disabled' : ''}`}>
        <input type="checkbox" checked={format} onChange={(e) => onFormat(e.target.checked)} disabled={busy} />
        <Wand width={14} height={14} />
        <span>
          <b>导入时一键排版</b>
          <em>合并被硬换行的段落、识别标题。导出的 md 本来就很整齐的话可以关掉。</em>
        </span>
      </label>

      {busy ? (
        <div className="banner info" style={{ marginTop: 12 }}>
          <span className="spinner" />
          <span>正在解包并写入笔记库…</span>
        </div>
      ) : null}
    </>
  );
}

// ───────────────────────── 结果页（两块共用） ─────────────────────────

export function OutcomeView({ outcome }: { outcome: Outcome }) {
  return (
    <>
      <div className={`banner ${outcome.ok ? 'info' : 'error'}`} style={{ marginBottom: 12 }}>
        {outcome.ok ? <Check width={15} height={15} /> : <Warning width={15} height={15} />}
        <span>{outcome.ok ? '已导入。库里原有的文件一个都没动。' : '导入失败'}</span>
      </div>
      <div className="upload-results">
        {outcome.rows.map((r) => (
          <div key={r.text} className={`upload-result${r.bad ? ' bad' : ''}`}>
            <span className="upload-result-mark">
              {r.bad ? <Warning width={13} height={13} /> : <Check width={13} height={13} />}
            </span>
            <span className="upload-result-name" title={r.text}>
              {r.text}
            </span>
            <span className="upload-result-detail">{r.detail}</span>
          </div>
        ))}
      </div>
      {outcome.warnings.length ? (
        <div className="banner warn" style={{ marginTop: 12 }}>
          <Warning width={15} height={15} />
          <span>{outcome.warnings.join('；')}</span>
        </div>
      ) : null}
    </>
  );
}
