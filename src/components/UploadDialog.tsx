/**
 * src/components/UploadDialog.tsx —— 「把外面的东西拿进来」的唯一入口。
 *
 * ★ 为什么三种方式挤在一个弹窗里 ★
 *   它们本质是同一个动作：从笔记库外面取内容进来。
 *   之前「上传」和「导入」是两个按钮（一个向上箭头、一个向下箭头），
 *   用户分不清该点哪个，而且飞书和压缩包藏在「导入」里更没人找得到。
 *   现在目录栏只留一个入口，进来再选走哪条路。
 *
 *   三种方式：
 *     1. 文件 —— md / txt / PDF / 图片，本地选或拖进来
 *     2. 飞书 —— 粘贴链接走官方接口，图能保住（复制粘贴必丢图，见 ImportPanes）
 *     3. ZIP —— 飞书 / 语雀 / Notion 导出的压缩包，不用配任何凭据
 *
 * ★ 为什么不「选中即上传」★
 *   1. **同名覆盖是会丢东西的操作**。后端写入用 writeFileAtomic 直接覆盖，
 *      而 sidecar 里的批注是按原文锚定的——一旦同名文章被覆盖，那些批注全部
 *      变成孤儿。所以必须在上传前查一次 existsRel，把「会覆盖」明确摆出来。
 *   2. **PDF 的处理方式需要用户拍板**。抽成 md 之后要不要留着原件，不同人习惯不同，
 *      而且原件留在库里会让目录树多一个打不开的条目。
 *   3. **一键排版不是无损的**。它会重新切段、合并硬换行，用户应该知道自己在按这个按钮。
 *
 * 所以流程是：选文件 → 先看清楚会发生什么 → 再上传。多一次点击，换不掉东西。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { api, errorText, type UploadResult } from '../api';
import { useDirOptions } from '../hooks/useDirOptions';
import { useApp } from '../state/store';
import { FeishuPane, OutcomeView, ZipPane, type Outcome as ImportOutcome } from './ImportPanes';
import { Check, FileText, Folder, Upload, Warning, Wand } from './Icons';
import { Modal } from './Dialog';

/** 后端 security.ts 的 ALLOWED_EXT，前端必须同步维护一份用于提前拦截。 */
const TEXT_EXT = new Set(['.md', '.markdown', '.txt']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.bmp', '.avif']);

/** 后端硬限制 100MB（doc.ts 的 too_large），前端提前拦，别让用户等半天才报错。 */
const MAX_BYTES = 100 * 1024 * 1024;

type Kind = 'pdf' | 'text' | 'image' | 'unsupported' | 'too-large';

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  // 注意：没扩展名时 lastIndexOf 返回 -1，直接 slice(-1) 会取到最后一个字符
  return i < 0 ? '' : name.slice(i).toLowerCase();
}

function kindOf(name: string, size: number): Kind {
  if (size > MAX_BYTES) return 'too-large';
  const ext = extOf(name);
  if (ext === '.pdf') return 'pdf';
  if (TEXT_EXT.has(ext)) return 'text';
  if (IMAGE_EXT.has(ext)) return 'image';
  return 'unsupported';
}

interface Plan {
  file: File;
  kind: Kind;
  /** 落库之后叫什么（PDF 会换成 .md） */
  target: string;
}

interface Outcome {
  name: string;
  ok: boolean;
  relPath?: string;
  detail?: string;
  error?: string;
}

/** 三条路：本地文件 / 飞书接口 / 导出的压缩包。 */
type Tab = 'file' | 'feishu' | 'zip';

export function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 同一个 File 在多次渲染间的稳定 key。
 * 不能用数组下标——usable 过滤掉不支持的文件后，下标和 plans 就对不上了。
 */
function fileKey(f: File): string {
  return `${f.name}|${f.size}|${f.lastModified}`;
}

export function UploadDialog({
  files,
  defaultDir,
  onClose,
}: {
  /** 拖进来的文件。点按钮进来时是空数组，文件在对话框里现选。 */
  files: File[];
  defaultDir: string;
  onClose: () => void;
}) {
  const { actions } = useApp();
  const [tab, setTab] = useState<Tab>('file');
  const [picked, setPicked] = useState<File[]>(files);
  const [dir, setDir] = useState(defaultDir);
  const [format, setFormat] = useState(true);
  const [keepPdf, setKeepPdf] = useState(false);
  const [phase, setPhase] = useState<'confirm' | 'uploading' | 'done'>('confirm');
  const [cur, setCur] = useState(0);
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const aliveRef = useRef(true);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── 飞书 / 压缩包两块面板的共用状态 ──
  const [importOutcome, setImportOutcome] = useState<ImportOutcome | null>(null);
  const [paneBusy, setPaneBusy] = useState(false);
  const [paneReady, setPaneReady] = useState(false);
  // 面板把「怎么提交」挂到 ref 上，底栏那个按钮只管调它，
  // 不必把两个面板各自的表单状态都提到这一层来。
  const paneSubmit = useRef<(() => void) | null>(null);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // 切走再切回来要重置：否则上一块面板的进度条和结果会跟着跑到新面板上
  useEffect(() => {
    setPaneReady(false);
    setPaneBusy(false);
  }, [tab]);

  // ── 目录下拉：规则见 hooks/useDirOptions（摊平树、跳过 .notebook）──
  const dirs = useDirOptions();
  const plans = useMemo<Plan[]>(
    () =>
      picked.map((f) => {
        const kind = kindOf(f.name, f.size);
        return {
          file: f,
          kind,
          target: kind === 'pdf' ? f.name.replace(/\.pdf$/i, '.md') : f.name,
        };
      }),
    [picked],
  );

  const usable = useMemo(() => plans.filter((p) => p.kind !== 'unsupported' && p.kind !== 'too-large'), [plans]);
  const hasText = usable.some((p) => p.kind === 'text');
  const hasPdf = usable.some((p) => p.kind === 'pdf');
  const blocked = plans.filter((p) => p.kind === 'unsupported' || p.kind === 'too-large');

  // ── 打开后先查一遍同名，让用户知道会不会覆盖 ──
  // exists 用 state 而不是往 plan 上挂字段：切目录时要重新查，写字段不会触发重渲染
  const [exists, setExists] = useState<Record<string, boolean>>({});
  const [checked, setChecked] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setChecked(false);
    (async () => {
      const pairs = await Promise.all(
        usable.map(async (p) => {
          const rel = dir ? `${dir}/${p.target}` : p.target;
          try {
            const r = await api.existsRel(rel);
            return [fileKey(p.file), r.exists] as const;
          } catch {
            // 查不到就当不存在，真正的错误会在上传时冒出来
            return [fileKey(p.file), false] as const;
          }
        }),
      );
      if (cancelled) return;
      setExists(Object.fromEntries(pairs));
      setChecked(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [dir, usable]);

  const overwriteCount = Object.values(exists).filter(Boolean).length;

  const run = async () => {
    setPhase('uploading');
    const results: Outcome[] = [];

    for (let i = 0; i < usable.length; i++) {
      const p = usable[i];
      setCur(i);
      try {
        const r: UploadResult = await api.upload(p.file, {
          dir,
          // 排版只对文本有意义；图片和 PDF 走各自的分支
          format: format && p.kind === 'text',
          keepOriginal: keepPdf && p.kind === 'pdf',
        });
        const bits: string[] = [];
        if (r.type === 'pdf') {
          bits.push(`${r.pageCount ?? '?'} 页`);
          if (r.savedPdf) bits.push('原件已保留');
        } else if (r.type === 'text') {
          const n = r.changes?.reduce((s, c) => s + c.count, 0) ?? 0;
          if (n) bits.push(`排版 ${n} 处`);
        } else if (r.bytes) {
          bits.push(humanSize(r.bytes));
        }
        if (r.warnings?.length) bits.push(...r.warnings);
        results.push({ name: p.file.name, ok: true, relPath: r.relPath, detail: bits.join(' · ') });
      } catch (e) {
        results.push({ name: p.file.name, ok: false, error: errorText(e) });
      }
    }

    if (!aliveRef.current) return;
    setOutcomes(results);
    setPhase('done');

    await actions.reloadTree();

    const okCount = results.filter((r) => r.ok).length;
    // 打开第一篇成功导入的文章。PDF 抽出来的也是 .md，能直接读
    const firstDoc = results.find((r) => r.ok && r.relPath && /\.(md|markdown|txt)$/i.test(r.relPath));
    if (firstDoc?.relPath) await actions.openDoc(firstDoc.relPath);

    if (okCount === results.length) {
      // 全成功就不用让用户再点一次「完成」
      actions.toast('ok', okCount === 1 ? '已导入 1 个文件' : `已导入 ${okCount} 个文件`);
      onClose();
    } else {
      actions.toast('warn', `${okCount} 个成功，${results.length - okCount} 个失败`);
    }
  };

  /** 飞书 / 压缩包两块面板导入完成后的收尾，和文件上传保持一致的手感。 */
  const handleImported = async (o: ImportOutcome) => {
    await actions.reloadTree();
    // 改名、图没下全这类事要让人看见，所以有警告就留在结果页不自动跳转
    if (!o.ok || o.warnings.length) {
      setImportOutcome(o);
      return;
    }
    if (o.openRel) await actions.openDoc(o.openRel);
    actions.toast('ok', '已导入');
    onClose();
  };

  const paneProps = {
    dir,
    dirs,
    onDir: setDir,
    format,
    onFormat: setFormat,
    onImported: (o: ImportOutcome) => void handleImported(o),
    onBusy: setPaneBusy,
    onReady: setPaneReady,
    submitRef: paneSubmit,
    onClose,
  };

  const tabHint: Record<Tab, string> = {
    file: '本地 md / txt / PDF / 图片。PDF 会自动抽成可批注的 Markdown。',
    feishu: '粘贴链接导入，图片能保住——直接复制粘贴一定会丢图。',
    zip: '飞书 / 语雀 / Notion 导出的压缩包，不用配任何凭据。',
  };

  const locked = phase === 'uploading' || paneBusy;

  return (
    <Modal
      title={
        <>
          <Upload width={15} height={15} style={{ verticalAlign: -2, marginRight: 6 }} />
          上传
        </>
      }
      onClose={locked ? () => undefined : onClose}
      width={580}
      headerExtra={
        <div className="tabs">
          <button className={tab === 'file' ? 'active' : ''} disabled={locked} onClick={() => setTab('file')}>
            PDF / MD
          </button>
          <button className={tab === 'feishu' ? 'active' : ''} disabled={locked} onClick={() => setTab('feishu')}>
            飞书
          </button>
          <button className={tab === 'zip' ? 'active' : ''} disabled={locked} onClick={() => setTab('zip')}>
            ZIP 包
          </button>
        </div>
      }
      footer={
        // 结果页：文件上传和飞书 / 压缩包各有一套结果，谁有值显示谁
        importOutcome ? (
          <>
            <button className="btn" onClick={onClose}>
              完成
            </button>
            {importOutcome.openRel ? (
              <button
                className="btn primary"
                onClick={() => {
                  void actions.openDoc(importOutcome.openRel!);
                  onClose();
                }}
              >
                打开这篇文章
              </button>
            ) : null}
          </>
        ) : tab === 'file' ? (
          phase === 'done' ? (
            <button className="btn primary" onClick={onClose}>
              完成
            </button>
          ) : (
            <>
              <button className="btn" onClick={onClose} disabled={phase === 'uploading'}>
                取消
              </button>
              <button
                className={overwriteCount ? 'btn danger' : 'btn primary'}
                onClick={() => void run()}
                disabled={phase === 'uploading' || usable.length === 0}
              >
                {phase === 'uploading'
                  ? `上传中 ${cur + 1}/${usable.length}…`
                  : overwriteCount
                    ? `覆盖 ${overwriteCount} 个同名文件并上传`
                    : `上传 ${usable.length} 个文件`}
              </button>
            </>
          )
        ) : (
          <>
            <button className="btn" onClick={onClose} disabled={paneBusy}>
              取消
            </button>
            <button className="btn primary" disabled={!paneReady || paneBusy} onClick={() => paneSubmit.current?.()}>
              {paneBusy ? '正在导入…' : '导入'}
            </button>
          </>
        )
      }
    >
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept=".md,.markdown,.txt,.pdf,.png,.jpg,.jpeg,.webp,.gif,.svg,.bmp,.avif"
        style={{ display: 'none' }}
        onChange={(e) => {
          const list = Array.from(e.target.files ?? []);
          // 追加而不是替换：先拖进来两个、再点按钮选三个，用户要的是五个
          if (list.length) setPicked((prev) => [...prev, ...list]);
          // 清空 value，否则连着选同一个文件不会再触发 change
          e.target.value = '';
        }}
      />

      <div className="hint" style={{ margin: '0 0 12px' }}>
        {tabHint[tab]}
      </div>

      {/* ════════════ 飞书 / 压缩包的结果页 ════════════ */}
      {importOutcome ? <OutcomeView outcome={importOutcome} /> : null}

      {/* ════════════ PDF / MD ════════════ */}
      {!importOutcome && tab === 'file' ? (
        <>
          {/* 不支持的类型：说清楚为什么，别让用户以为是坏了 */}
          {blocked.length ? (
            <div className="banner warn" style={{ marginBottom: 12 }}>
              <Warning width={15} height={15} />
              <span>
                {blocked.length} 个文件不会上传：
                {blocked.map((p) => (
                  <code key={p.file.name} style={{ margin: '0 3px' }}>
                    {p.file.name}
                  </code>
                ))}
                （{blocked.some((p) => p.kind === 'too-large') ? '超过 100MB 或' : ''}只支持 md / txt / pdf 和图片）
              </span>
            </div>
          ) : null}

          {/* 同名覆盖：这是会丢批注的操作，必须说透 */}
          {checked && overwriteCount ? (
            <div className="banner warn" style={{ marginBottom: 12 }}>
              <Warning width={15} height={15} />
              <span>
                库里已经有 {overwriteCount} 个同名文件，上传会整篇替换——
                原来那篇文章上写的批注和高亮会全部指到新内容上（系统会标为失效，但不会帮你搬家）。
              </span>
            </div>
          ) : null}

          {phase === 'done' ? (
            <div className="upload-results">
              {outcomes.map((o) => (
                <div key={o.name} className={`upload-result${o.ok ? '' : ' bad'}`}>
                  <span className="upload-result-mark">
                    {o.ok ? <Check width={13} height={13} /> : <Warning width={13} height={13} />}
                  </span>
                  <span className="upload-result-name" title={o.relPath ?? o.name}>
                    {o.relPath ?? o.name}
                  </span>
                  <span className="upload-result-detail">{o.ok ? o.detail : o.error}</span>
                </div>
              ))}
            </div>
          ) : (
            <>
              <div className="field">
                <label>上传到</label>
                <select className="input" value={dir} onChange={(e) => setDir(e.target.value)} disabled={phase === 'uploading'}>
                  {dirs.map((d) => (
                    <option key={d.rel} value={d.rel}>
                      {d.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="field">
                <label>选择文件</label>
                <div className="row">
                  <button className="btn" onClick={() => fileInputRef.current?.click()} disabled={phase === 'uploading'}>
                    <FileText width={13} height={13} /> {picked.length ? '再选一些' : '选择文件'}
                  </button>
                  {picked.length ? (
                    <span className="hint" style={{ margin: 0 }}>
                      已选 {picked.length} 个
                    </span>
                  ) : (
                    <span className="hint" style={{ margin: 0 }}>
                      也可以直接把文件拖到左栏
                    </span>
                  )}
                </div>
              </div>

              {plans.length ? (
                <>
                  {hasText ? (
                    <label className={`upload-opt${phase === 'uploading' ? ' disabled' : ''}`}>
                      <input
                        type="checkbox"
                        checked={format}
                        onChange={(e) => setFormat(e.target.checked)}
                        disabled={phase === 'uploading'}
                      />
                      <Wand width={14} height={14} />
                      <span>
                        <b>导入时一键排版</b>
                        <em>合并被硬换行的段落、识别标题、清掉页眉页脚噪声。文本本来就很整齐的话可以关掉。</em>
                      </span>
                    </label>
                  ) : null}

                  {hasPdf ? (
                    <label className={`upload-opt${phase === 'uploading' ? ' disabled' : ''}`}>
                      <input
                        type="checkbox"
                        checked={keepPdf}
                        onChange={(e) => setKeepPdf(e.target.checked)}
                        disabled={phase === 'uploading'}
                      />
                      <Folder width={14} height={14} />
                      <span>
                        <b>同时保留原始 PDF</b>
                        <em>不勾选的话只留下解析出的 Markdown，PDF 本身不进笔记库。解析交由 MinerU 云端完成（公式/表格/扫描件效果更好），高峰期约 1~2 分钟。</em>
                      </span>
                    </label>
                  ) : null}

                  <div className="upload-list">
                    {plans.map((p) => (
                      <div
                        key={fileKey(p.file)}
                        className={`upload-row${p.kind === 'unsupported' || p.kind === 'too-large' ? ' blocked' : ''}`}
                      >
                        <span className="upload-icon">
                          {p.kind === 'pdf' ? (
                            <span className="upload-badge pdf">PDF</span>
                          ) : p.kind === 'image' ? (
                            <span className="upload-badge img">图</span>
                          ) : (
                            <FileText width={14} height={14} />
                          )}
                        </span>
                        <span className="upload-name" title={p.file.name}>
                          {p.file.name}
                        </span>
                        <span className="upload-size">{humanSize(p.file.size)}</span>
                        <span className="upload-act">
                          {p.kind === 'pdf' ? (
                            <>→ {p.target}</>
                          ) : p.kind === 'text' ? (
                            format ? '排版后存为 md' : '原样存为 md'
                          ) : p.kind === 'image' ? (
                            '原样保存'
                          ) : p.kind === 'too-large' ? (
                            '超过 100MB'
                          ) : (
                            '不支持的类型'
                          )}
                        </span>
                        {exists[fileKey(p.file)] ? (
                          <span className="upload-overwrite" title="库里已有同名文件">
                            覆盖
                          </span>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </>
              ) : null}

              {phase === 'uploading' ? (
                <div className="upload-progress">
                  <div
                    className="upload-progress-bar"
                    style={{ width: `${((cur + 1) / Math.max(1, usable.length)) * 100}%` }}
                  />
                </div>
              ) : null}
            </>
          )}
        </>
      ) : null}

      {/* ════════════ 飞书 ════════════ */}
      {!importOutcome && tab === 'feishu' ? <FeishuPane {...paneProps} /> : null}

      {/* ════════════ 压缩包 ════════════ */}
      {!importOutcome && tab === 'zip' ? <ZipPane {...paneProps} /> : null}
    </Modal>
  );
}
