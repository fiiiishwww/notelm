/**
 * src/components/DedupeDialog.tsx —— 一键去重的确认界面。
 *
 * ★ 为什么必须有一个「列清单」的中间步骤 ★
 *   去重是唯一一种「删错了要过很久才发现」的操作：被删的那篇还有另一份一模一样的，
 *   用户当下什么都感觉不到，等到某天发现批注没了、引用跳不过去了，已经想不起是哪一次点的。
 *   所以这里打开就扫描、列出每一组、标明留谁删谁，且**默认只勾零风险的那几档**。
 *
 * ★ 三档的默认勾选 ★
 *   - 完全相同 / 高度相似 → 默认勾选（删掉的是真副本）
 *   - 子集（一篇是另一篇的一部分）→ 默认不勾。看着重合度高，但很可能是
 *     「整章 vs 拆出来的单节」这种关系，删掉整章就只剩单节了。
 */

import { useCallback, useEffect, useState } from 'react';
import { api, errorText, type DedupeReport, type DupDoc, type DupKind } from '../api';
import { useApp } from '../state/store';
import { Modal } from './Dialog';

const KIND_TEXT: Record<DupKind, string> = {
  exact: '完全相同',
  similar: '高度相似',
  subset: '包含关系（谨慎）',
};

function fmtDate(ms: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function Meta({ d }: { d: DupDoc }) {
  const marks = d.notes + d.highlights + d.cards;
  return (
    <span className="dedupe-meta">
      {d.chars.toLocaleString()} 字
      {d.mtime ? ` · ${fmtDate(d.mtime)}` : ''}
      {marks ? ` · 批注 ${marks}` : ''}
    </span>
  );
}

export function DedupeDialog({ onClose }: { onClose: () => void }) {
  const { actions } = useApp();
  const [report, setReport] = useState<DedupeReport | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());

  const scan = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.dedupeScan();
      setReport(r);
      // 只预选零风险的两档；「包含关系」留给用户自己判断
      const next = new Set<string>();
      for (const g of r.groups) for (const d of g.dups) if (d.kind !== 'subset') next.add(d.rel);
      setSel(next);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void scan();
  }, [scan]);

  const toggle = (rel: string) => {
    setSel((prev) => {
      const next = new Set(prev);
      if (next.has(rel)) next.delete(rel);
      else next.add(rel);
      return next;
    });
  };

  const apply = async () => {
    const rels = [...sel];
    if (!rels.length) return;
    setBusy(true);
    try {
      const r = await api.dedupeApply(rels);
      await actions.reloadTree();
      actions.toast('ok', `${r.removed} 篇已移入回收站，可随时从 ${r.trashed[0] ?? '回收站'} 找回`);
      if (r.failed.length) {
        actions.toast('error', `${r.failed.length} 篇没能移动：${r.failed[0]?.message ?? ''}`);
      }
      onClose();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const groups = report?.groups ?? [];
  const picked = [...sel].length;

  return (
    <Modal
      title="一键去重"
      onClose={onClose}
      width={780}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn" onClick={() => void scan()} disabled={busy}>
            重新扫描
          </button>
          <button className="btn danger" onClick={() => void apply()} disabled={busy || picked === 0}>
            {busy ? '处理中…' : `移入回收站（${picked} 篇）`}
          </button>
        </>
      }
    >
      {err ? <p className="dedupe-err">{err}</p> : null}

      {!report ? (
        <p className="dedupe-empty">{busy ? '正在扫描整个笔记库…' : '扫描失败'}</p>
      ) : !groups.length ? (
        <p className="dedupe-empty">扫了 {report.scanned} 篇，没有发现重复的文章。</p>
      ) : (
        <>
          <p className="dedupe-summary">
            扫了 {report.scanned} 篇，发现 <strong>{groups.length}</strong> 组重复
            {report.removable ? `，已默认勾选 ${report.removable} 篇（约 ${(report.saveChars / 1024).toFixed(1)} KB）` : ''}
            。保留的是批注最多的那一篇；「包含关系」没有替你勾选，请自己看一眼。
          </p>

          <div className="dedupe-list">
            {groups.map((g) => (
              <section key={g.id} className="dedupe-group">
                <header>
                  <span className={`dedupe-kind k-${g.kind}`}>{KIND_TEXT[g.kind]}</span>
                  <span className="dedupe-keep-tag">保留</span>
                  <span className="dedupe-keep" title={g.keeper.rel}>
                    {g.keeper.title}
                  </span>
                  <span className="dedupe-path">{g.keeper.rel}</span>
                  <span className="grow" style={{ flex: 1 }} />
                  <Meta d={g.keeper} />
                </header>

                {g.dups.map((d) => (
                  <label key={d.rel} className={`dedupe-dup${sel.has(d.rel) ? ' on' : ''}`}>
                    <input type="checkbox" checked={sel.has(d.rel)} onChange={() => toggle(d.rel)} />
                    <span className="dedupe-dup-main">
                      <span className="dedupe-dup-title" title={d.rel}>
                        {d.title}
                      </span>
                      <span className="dedupe-path">{d.rel}</span>
                    </span>
                    {d.kind === 'subset' ? (
                      <span className="dedupe-sim" title="这一篇的内容几乎都在保留者里，但保留者还多得多——它多半是对方的一部分">
                        {Math.round(d.containment * 100)}% 内容在保留者中
                      </span>
                    ) : (
                      <span className="dedupe-sim">重合 {Math.round(d.similarity * 100)}%</span>
                    )}
                    <Meta d={d} />
                  </label>
                ))}
              </section>
            ))}
          </div>
        </>
      )}
    </Modal>
  );
}
