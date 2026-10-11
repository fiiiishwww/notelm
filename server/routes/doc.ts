/**
 * server/routes/doc.ts —— 文章的读取 / 保存 / 上传 / PDF 导入 / 一键排版。
 *
 * ★ 本文件最重要的一个设计：GET /doc 顺带做「失效重锚」★
 *   用户可能在 Obsidian 里改了文章（甚至改了标题、调了段落顺序），再回到这里。
 *   打开文章时是最自然的重建锚点时机——用户此刻正要看到批注落在哪里，
 *   如果他先看到一堆「锚点失效」再手动修复，体验就崩了。
 *   所以我们把「分析 → 比对 docHash → 需要则重锚 → 持久化」做在一次请求里，
 *   并且把 anchorReport 一起返回，前端可以提示「3 条批注已自动跟随移动」。
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { Router } from 'express';
import { z } from 'zod';
import { ApiError, bad, DATA_DIR_NAME, ensureDirSync, requireVaultRoot, sha256, writeFileAtomic } from '../core';
import { renderDocument, unitText, headingPathOf } from '../../shared/blocks';
import { mapHighlightsToBlocks } from '../services/hlSignal';
import { analyzeDocument } from '../../shared/blocks';
import { planSplit, splitReasonText, type SplitReason } from '../../shared/split';
import type { Card, DocAnalysis, Highlight, Note, Sidecar } from '../../shared/text';
import { ensureUniqueRel, readDoc, writeDoc } from '../vault';
import { sanitizeName, saveMineruResult } from '../services/docImport';
import { mineruPollMs, mineruToken, pollBatchDoc, submitFileDoc } from '../services/mineru';
import {
  emptySidecar,
  ensureNotebook,
  normalizeSidecar,
  readSidecar,
  trashSidecarTree,
  updateSidecar,
  writeSidecar,
} from '../services/sidecar';
import { reanchorSidecar, type AnchorReport } from '../services/anchor';
import { withCheatsheetHtml } from '../services/cheatsheet';
import { collectImageRefs, makeImageSizer, warmImageSizes } from '../services/imageSize';
import { formatText } from '../services/typographer';
import { extractPdfToMarkdown } from '../services/pdf';
import { safeTitle } from '../services/naming';
import { relatedBlocks } from '../services/related';
import { assertAllowedExt, resolveInVault } from '../security';
import { h, parse, qBool, qInt, qStr } from './http';

export const docRouter = Router();

export interface DocPayloadResponse {
  path: string;
  markdown: string;
  docHash: string;
  html: string;
  analysis: DocAnalysis;
  sidecar: Sidecar;
  /** 这次打开时自动修复锚点的结果；没修复过就是 null */
  anchorReport: AnchorReport | null;
}

/**
 * 读取一篇文章并准备好前端渲染所需的一切。
 *
 * @param touchIndex 是否需要做「重锚 + 回写索引」。保存后立刻重新渲染时传 true。
 */
export async function loadDocument(rel: string, opts: { reanchor?: boolean } = {}): Promise<DocPayloadResponse> {
  const doc = await readDoc(rel);

  // 先把这篇文档里所有图片的真实尺寸探测一遍（异步、带缓存），渲染时才能同步查表
  // 把 width/height 写进 <img> —— 没有宽高，loading="lazy" 等于没写，详见 services/imageSize.ts
  await warmImageSizes(rel, collectImageRefs(doc.markdown));

  // 带上 docRel，渲染时才能把 ![](assets/x.png) 这类相对路径改写成
  // /asset?doc=...&ref=...（图片资源出口，见 routes/asset.ts）
  const { html, analysis } = renderDocument(doc.markdown, {
    docRel: rel,
    imageSizer: makeImageSizer(rel),
  });

  let sidecar = await readSidecar(rel);
  let anchorReport: AnchorReport | null = null;

  const hashChanged = sidecar.docHash !== doc.docHash;
  const hasAnchors = sidecar.notes.length > 0 || sidecar.highlights.length > 0;

  if (opts.reanchor !== false && (hashChanged || !hasAnchors)) {
    if (hashChanged && hasAnchors) {
      // 逐条就地修改 sidecar（reanchorSidecar 会写 anchorState / selector）
      anchorReport = reanchorSidecar(sidecar, analysis.blocks);
    }
  }

  // 章节与单元永远以本次分析为准——它们是「派生数据」，不该被历史值污染
  sidecar.chapters = analysis.chapters;
  sidecar.units = analysis.units;
  sidecar.docPath = rel;
  sidecar.indexedAt = new Date().toISOString();
  // 只有在没有因为超时被跳过的条目时，才把 docHash 记成最新版；
  // 否则下次打开还会重试一遍，避免漏修的锚点被永久遗忘。
  if (!anchorReport || anchorReport.skipped === 0) {
    sidecar.docHash = doc.docHash;
  }

  await persistSidecar(rel, sidecar);

  return {
    path: doc.path,
    markdown: doc.markdown,
    docHash: doc.docHash,
    html,
    analysis,
    // 小抄的渲染结果不落盘（渲染规则会变、存下来就会过期），只在响应里补一份。
    // ★ 这一步不能省：漏掉它会表现为「刚生成时能看到小抄，重新打开就只剩一排按钮」。
    // 传 analysis 是为了让呈现层能按**原文子标题**给小抄分层（纯查表，不调模型）。
    sidecar: {
      ...sidecar,
      cheatsheet: {
        sections: await withCheatsheetHtml(sidecar.cheatsheet.sections, {
          docRel: rel,
          blocks: analysis.blocks,
          chapters: analysis.chapters,
          // ★ units 是给「开篇」兜底的：它没有对应的 Chapter，只有合成的 unit
          units: analysis.units,
          hl: mapHighlightsToBlocks(sidecar.highlights, analysis.blocks).colorByBi,
        }),
      },
    },
    anchorReport,
  };
}

/** 直接覆盖写 sidecar（这里的数据是本次分析算出来的，不需要读-改-写语义）。 */
async function persistSidecar(rel: string, data: Sidecar): Promise<void> {
  await updateSidecar(rel, (cur) => {
    // 保留可能被并发写入的卡片/题目（AI 任务可能在后台跑），只覆盖文档结构部分
    Object.assign(cur, {
      chapters: data.chapters,
      units: data.units,
      docPath: data.docPath,
      docHash: data.docHash,
      indexedAt: data.indexedAt,
      notes: data.notes,
      highlights: data.highlights,
    });
  });
}

docRouter.get(
  '/doc',
  h(async (req, res) => {
    const rel = qStr(req, 'rel');
    const payload = await loadDocument(rel);
    res.json(payload satisfies DocPayloadResponse);
  }),
);

/** 只要结构分析，不要 HTML（用于预览面板 / 调试）。 */
// ─────────────────────── 块级相关性（发散圆用） ───────────────────────

/**
 * 给正文下方的「相关块」面板用。
 *
 * 入参是「当前文档 + 当前正在看的块下标」，不是查询词——
 * 用户没输入任何东西，是我们在他阅读时主动告诉他别处还有谁在讲同一件事。
 */
docRouter.get(
  '/doc/related',
  h(async (req, res) => {
    const rel = qStr(req, 'rel');
    const bi = Math.max(0, qInt(req, 'bi', 0));
    const topK = Math.min(Math.max(qInt(req, 'topK', 5), 1), 10);
    res.json(await relatedBlocks(rel, bi, topK));
  }),
);

docRouter.get(
  '/doc/outline',
  h(async (req, res) => {
    const rel = qStr(req, 'rel');
    const doc = await readDoc(rel);
    const a = analyzeDocument(doc.markdown);
    res.json({ path: rel, docHash: doc.docHash, chapters: a.chapters, units: a.units, blockCount: a.blocks.length });
  }),
);

/** 取某个单元的正文，用于「只重新生成这一节」。 */
docRouter.get(
  '/doc/unit',
  h(async (req, res) => {
    const rel = qStr(req, 'rel');
    const headingId = qStr(req, 'headingId');
    const doc = await readDoc(rel);
    const a = analyzeDocument(doc.markdown);
    const unit = a.units.find((u) => u.headingId === headingId);
    if (!unit) throw new ApiError(404, '找不到这个小节', 'not_found');
    res.json({ unit, text: unitText(a.blocks, unit), headingPath: headingPathOf(a.chapters, unit) });
  }),
);

// ─────────────────────────── 保存 ───────────────────────────

const putSchema = z.object({
  rel: z.string().min(1).max(1024),
  markdown: z.string().max(8 * 1024 * 1024),
  /** 前端读到的版本号；不匹配且未 force 就返回 409 */
  baseHash: z.string().max(128).optional(),
  force: z.boolean().optional(),
  /** 保存后是否顺带重新渲染并重锚（默认 true） */
  reanalyze: z.boolean().optional(),
});

docRouter.put(
  '/doc',
  h(async (req, res) => {
    const body = parse(putSchema, req.body, '保存请求');
    // 乐观锁失败会抛 409，conflict() 里已经把磁盘版本一起带出去了
    const saved = await writeDoc(body.rel, body.markdown, body.baseHash, Boolean(body.force));

    if (body.reanalyze === false) {
      res.json({ path: saved.path, docHash: saved.docHash, markdown: saved.markdown, reindexed: false });
      return;
    }
    const payload = await loadDocument(body.rel);
    res.json({ ...payload, reindexed: true });
  }),
);

// ─────────────────────────── 上传 ───────────────────────────

const uploadQuery = z.object({
  /** 目标目录（vault 相对），'' 表示根 */
  dir: z.string().max(1024).default(''),
  /** 文件名（含扩展名）；前端从 File.name 取 */
  name: z.string().min(1).max(200),
  /** PDF 导入时是否把原始 PDF 也留在笔记库里 */
  keepOriginal: z.string().optional(),
  /** 导入 md/txt 时是否跑一遍规则排版 */
  format: z.string().optional(),
});

/**
 * 上传文件。请求体是**原始二进制**（不是 multipart），文件名走 query。
 * 这样前端不需要额外的 multipart 依赖，服务端也不需要 multer。
 */
docRouter.post(
  '/upload',
  h(async (req, res) => {
    const q = parse(uploadQuery, req.query, '上传参数');
    const buf = req.body as unknown;
    if (!Buffer.isBuffer(buf) || buf.length === 0) {
      throw bad('没有收到文件内容', 'empty_upload');
    }
    if (buf.length > 100 * 1024 * 1024) throw bad('文件超过 100MB 限制', 'too_large');

    const root = await requireVaultRoot();
    await ensureNotebook(root);

    const name = sanitizeName(q.name);
    const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
    const dir = q.dir.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    // ★ 上传永远不覆盖已有文件 ★
    // 笔记库里可能已经有一篇同名文章（用户自己写的，或上次导入的），
    // 静默覆盖等于把他的内容冲掉，而且没有撤销的机会。重名就自动加 -2 / -3。
    const rel = await ensureUniqueRel(dir ? `${dir}/${name}` : name);
    const abs = await resolveInVault(rel);
    assertAllowedExt(abs);
    const baseName = rel.slice(rel.lastIndexOf('/') + 1);

    if (ext === '.pdf') {
      // ★ 配了 MinerU token → 云解析（公式/表格/扫描件质量更好，同步轮询约 1~2 分钟）；
      //   没配 → 走本地 pdfjs 管线（下面的原路径，行为与历史版本完全一致）。
      const mToken = await mineruToken();
      if (mToken) {
        // 云解析失败**不静默回退本地管线**（半路换引擎会让她困惑「为什么两次结果不一样」）：
        // 错误原样抛给前端；想留原件走 keepOriginal，或稍后用 /import-pdf 本地入口重试。
        const sub = await submitFileDoc(name, buf, mToken);
        const zipBuf = await pollBatchDoc(sub.batchId, mineruPollMs(), name, mToken);
        const saved = await saveMineruResult({
          zipBuf,
          name,
          dir: q.dir.replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''),
          keepOriginal: q.keepOriginal === '1',
          original: buf,
        });
        res.json({
          ok: true,
          type: 'pdf',
          relPath: saved.relPath,
          savedPdf: saved.savedOriginal,
          warnings: saved.warnings,
          charCount: saved.charCount,
          imageCount: saved.imageCount,
        });
        return;
      }
      const stem = baseName.replace(/\.[^.]+$/, '');
      const r = await extractPdfToMarkdown(new Uint8Array(buf), { stem });
      // PDF 抽出来的内容存成同名 .md，用户直接就能批注
      const wantedMd = rel.replace(/\.pdf$/i, '.md');
      const mdRel = await ensureUniqueRel(wantedMd);
      const mdAbs = await resolveInVault(mdRel);
      await writeFileAtomic(mdAbs, r.markdown);
      const imageCount = await writePdfAssets(mdRel, r.images);
      if (q.keepOriginal === '1') await writeFileAtomic(abs, buf);
      const warnings = [...r.warnings];
      if (mdRel !== wantedMd) {
        warnings.push(`已经有一篇同名的文章了，这次导入存成了「${mdRel.slice(mdRel.lastIndexOf('/') + 1)}」，没有动你原来的文件`);
      }
      res.json({
        ok: true,
        type: 'pdf',
        relPath: mdRel,
        savedPdf: q.keepOriginal === '1' ? rel : null,
        pageCount: r.pageCount,
        warnings,
        charCount: r.markdown.length,
        imageCount,
      });
      return;
    }

    if (ext === '.md' || ext === '.markdown' || ext === '.txt') {
      let text = buf.toString('utf8');
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      let changes: { rule: string; count: number }[] = [];
      if (q.format === '1') {
        const f = formatText(text);
        text = f.markdown;
        changes = f.changes;
      }
      await writeFileAtomic(abs, text);
      res.json({ ok: true, type: 'text', relPath: rel, charCount: text.length, changes });
      return;
    }

    await writeFileAtomic(abs, buf);
    res.json({ ok: true, type: 'binary', relPath: rel, bytes: buf.length });
  }),
);

/**
 * 把 PDF 里导出的位图写到文章同级的 assets/ 目录。
 * Markdown 里用相对路径 ![](assets/xxx.png) 引用，Obsidian 和 VSCode 都能直接显示。
 */
async function writePdfAssets(
  mdRel: string,
  images: { file: string; data: Buffer }[],
): Promise<number> {
  if (images.length === 0) return 0;
  const dir = mdRel.replace(/\/[^/]*$/, '');
  const assetsRel = dir ? `${dir}/assets` : 'assets';
  const assetsAbs = await resolveInVault(assetsRel);
  ensureDirSync(assetsAbs);
  for (const img of images) {
    await writeFileAtomic(await resolveInVault(`${assetsRel}/${img.file}`), img.data);
  }
  return images.length;
}

// sanitizeName 已上移到 services/docImport.ts（agent 的 save_web_file 与本路由共用）。

// ─────────────────────────── PDF 导入 ───────────────────────────

const pdfSchema = z.object({
  /** vault 里已存在的 PDF 相对路径 */
  rel: z.string().min(1).max(1024),
  /** 只导入这几页（1-based） */
  pages: z.array(z.number().int().min(1)).max(2000).optional(),
  /** 输出到哪个目录，默认与 PDF 同目录 */
  outDir: z.string().max(1024).optional(),
  /** 是否保留原始 PDF（导入后不删） */
  keepOriginal: z.boolean().optional(),
});

/** 把 vault 里已有的 PDF 抽成 md 文章。 */
docRouter.post(
  '/import-pdf',
  h(async (req, res) => {
    const body = parse(pdfSchema, req.body, 'PDF 导入请求');
    const abs = await resolveInVault(body.rel);
    if (!abs.toLowerCase().endsWith('.pdf')) throw bad('这个文件不是 PDF', 'bad_ext');

    const fsp = await import('node:fs/promises');
    const buf = await fsp.readFile(abs).catch((e: NodeJS.ErrnoException) => {
      throw new ApiError(404, `读取 PDF 失败：${e.message}`, 'not_found');
    });

    const stem = body.rel.replace(/^.*\//, '').replace(/\.pdf$/i, '');
    const r = await extractPdfToMarkdown(new Uint8Array(buf), { pages: body.pages, stem });
    const dir = (body.outDir ?? body.rel.replace(/\/[^/]*$/, '')).replace(/^\/+|\/+$/g, '');
    // 同上：不覆盖已有文章
    const wantedMd = dir ? `${dir}/${stem}.md` : `${stem}.md`;
    const mdRel = await ensureUniqueRel(wantedMd);
    const mdAbs = await resolveInVault(mdRel);
    await writeFileAtomic(mdAbs, r.markdown);
    const imageCount = await writePdfAssets(mdRel, r.images);

    if (body.keepOriginal === false) {
      // 明确要求「导入后删掉原 PDF」时才删（走回收站逻辑不做，这里只做文件删除，
      // 因为这是用户刚上传的中间产物，不是他的原文）
      await fsp.rm(abs, { force: true }).catch(() => undefined);
    }

    const warnings = [...r.warnings];
    if (mdRel !== wantedMd) {
      warnings.push(`已经有一篇同名的文章了，这次导入存成了「${mdRel.slice(mdRel.lastIndexOf('/') + 1)}」，没有动你原来的文件`);
    }

    res.json({
      ok: true,
      relPath: mdRel,
      pageCount: r.pageCount,
      pageLines: r.pageLines,
      warnings,
      charCount: r.markdown.length,
      imageCount,
      markdown: r.markdown,
    });
  }),
);

// ─────────────────────────── 大文档拆分 ───────────────────────────

/**
 * 单篇文档的块数超过这个值就建议拆分。
 * 实测 8819 块 ≈ 985ms 布局（52317 个 DOM 节点），近似线性；
 * 600 块 ≈ 65ms，是「点开不觉得顿」的量级。
 */
export const SPLIT_BLOCK_THRESHOLD = 600;

const splitSchema = z.object({
  rel: z.string().min(1).max(1024),
  maxBlocks: z.number().int().min(50).max(5000).optional(),
  /** 只算不写：返回会切成什么样，一个字节都不动 */
  dryRun: z.boolean().optional(),
  /** 拆完是否删掉原文档，默认 true（内容已完整分布到各分片，无损失） */
  removeOriginal: z.boolean().optional(),
});

export interface SplitOutcome {
  ok: boolean;
  reason: SplitReason;
  /** 实际采用的切分层级（1 = h1）；0 表示没切 */
  level: number;
  original: string;
  chunks: { rel: string; title: string; blockCount: number; startBi: number }[];
  /** 迁移过去的批注数量 */
  migrated: { highlights: number; notes: number; cards: number };
  /** 归属不明的批注数（正常情况下应为 0） */
  unplaced: number;
  message: string;
}

/**
 * 把原文移进 .notebook/trash，而不是直接删除。
 *
 * ★ 为什么用 rename 而不是 fs.rm ★
 *   本机 Node 的 fs.rm / fs.unlink 被安全删除 shim 接管，会走系统回收站；
 *   在这个环境里它对文件也会抛 "Some operations were aborted"。
 *   rename 不经过 shim，而且**可恢复** —— 拆分是一次改掉整篇文档结构的操作，
 *   留一份原文在回收站里，万一用户觉得切得不对还能捞回来。
 */
async function trashOriginal(rel: string): Promise<void> {
  const root = await requireVaultRoot();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = path.join(root, DATA_DIR_NAME, 'trash', stamp);

  const src = await resolveInVault(rel);
  const dst = path.join(base, 'doc', ...rel.split('/'));
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  await fsp.rename(src, dst).catch(() => undefined);

  await trashSidecarTree(root, rel, false, stamp);
}

/** 找出 bi 落在哪个分片里；找不到返回 -1。 */
function chunkOfBi(ranges: { startBi: number; blockCount: number }[], bi: number): number {
  for (let i = 0; i < ranges.length; i++) {
    const r = ranges[i];
    if (bi >= r.startBi && bi < r.startBi + r.blockCount) return i;
  }
  return -1;
}

/** 生成分片文件名：`原名 - 01 标题.md`。与原文同目录，图片相对引用才不用改。 */
function chunkFileName(stem: string, index: number, total: number, title: string): string {
  const width = Math.max(2, String(total).length);
  const nn = String(index + 1).padStart(width, '0');
  // 标题里常常带着原文末尾的冒号、顿号（「…的一些额外的知识点：」），
  // 挪到文件名尾部很难看，去掉。中间的不动，那是标题的一部分。
  const suffix = safeTitle(title).replace(/[：:、，,。.;；]+$/, '');
  const raw = suffix && suffix !== '开篇' ? `${stem} - ${nn} ${suffix}` : `${stem} - ${nn}`;
  return (raw || `${stem} - ${nn}`).slice(0, 80);
}

/**
 * 把一篇过长的文档按标题切成若干篇，并把批注一起搬过去。
 *
 * ★ 批注是怎么搬的 ★
 *   planSplit 保证每个分片都是原文档的**连续块区间** [startBi, startBi+blockCount)，
 *   所以迁移只需要 `blockIndex -= startBi`，textOffset 一个字都不动。
 *   这样下次打开分片时 reanchorSidecar 会走 S1 精确命中，一条都不会漂。
 *
 * ★ 为什么 cheatsheet / quizzes / units / chapters 不迁移 ★
 *   headingId 是按**文档**生成的，重复标题靠 order 计数区分（形如 h-xxxx-1）。
 *   拆完之后原本排第二的同名标题在自己分片里变回 order=0，headingId 就跟原文对不上了。
 *   而这四类正好是按 headingId 定位的 —— 迁过去必然错位。
 *   好在它们全是 AI 派生数据，重建比迁移更准确，所以留给分片首次打开时自己生成。
 *   规则一句话：**用户产生的数据必须迁移，AI 派生的数据就地重建**。
 *
 * ★ docHash 为什么故意留空 ★
 *   空 hash 会让下次打开时跑一遍 reanchorSidecar，正好当作 bi 平移的验收：
 *   S1 全命中就证明平移是精确的，一条都没漂。
 */
export async function splitDocument(
  rel: string,
  opts: { maxBlocks?: number; dryRun?: boolean; removeOriginal?: boolean } = {},
): Promise<SplitOutcome> {
  const maxBlocks = opts.maxBlocks ?? SPLIT_BLOCK_THRESHOLD;
  const doc = await readDoc(rel);
  const analysis = analyzeDocument(doc.markdown);

  const plan = planSplit(doc.markdown, {
    totalBlocks: analysis.blocks.length,
    countBlocks: (t) => analyzeDocument(t).blocks.length,
    maxBlocks,
  });

  const empty = { highlights: 0, notes: 0, cards: 0 };
  if (!plan.needed) {
    return {
      ok: false,
      reason: plan.reason,
      level: 0,
      original: rel,
      chunks: [],
      migrated: empty,
      unplaced: 0,
      message: splitReasonText(plan.reason),
    };
  }

  const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
  const base = rel.slice(rel.lastIndexOf('/') + 1);
  const stem = base.replace(/\.[^.]+$/, '') || base;
  const ext = base.slice(stem.length) || '.md';

  const ranges = plan.chunks.map((c) => ({ startBi: c.startBi, blockCount: c.blockCount }));
  const names = plan.chunks.map((c, i) => chunkFileName(stem, i, plan.chunks.length, c.title));

  const buildInfo = (rels: string[]) =>
    plan.chunks.map((c, i) => ({
      rel: rels[i] ?? '',
      title: c.title,
      blockCount: c.blockCount,
      startBi: c.startBi,
    }));

  if (opts.dryRun) {
    // ensureUniqueRel 只读不写，dryRun 用它是安全的
    const rels: string[] = [];
    for (const n of names) rels.push(await ensureUniqueRel(dir ? `${dir}/${n}${ext}` : `${n}${ext}`));
    return {
      ok: true,
      reason: 'ok',
      level: plan.level,
      original: rel,
      chunks: buildInfo(rels),
      migrated: empty,
      unplaced: 0,
      message: `将按 h${plan.level} 切成 ${plan.chunks.length} 篇（每篇不超过 ${maxBlocks} 块）`,
    };
  }

  // ── 批注定归属 ──
  const sc = await readSidecar(rel);
  const groups = plan.chunks.map(() => ({
    highlights: [] as Highlight[],
    notes: [] as Note[],
    cards: [] as Card[],
  }));
  const noteChunk = new Map<string, number>();
  const headingBi = new Map<string, number>();
  for (const c of analysis.chapters) headingBi.set(c.headingId, c.bi);
  let unplaced = 0;

  for (const hl of sc.highlights) {
    const i = chunkOfBi(ranges, hl.selector.blockIndex);
    if (i < 0) {
      unplaced++;
      continue;
    }
    groups[i].highlights.push({
      ...hl,
      selector: { ...hl.selector, blockIndex: hl.selector.blockIndex - ranges[i].startBi },
    });
  }

  for (const note of sc.notes) {
    const i = chunkOfBi(ranges, note.selector.blockIndex);
    if (i < 0) {
      unplaced++;
      continue;
    }
    noteChunk.set(note.id, i);
    groups[i].notes.push({
      ...note,
      selector: { ...note.selector, blockIndex: note.selector.blockIndex - ranges[i].startBi },
    });
  }

  // 卡片没有 bi，只能间接定位：先看它派生的批注落在哪，再看它的 headingId 对应哪个 bi
  for (const card of sc.cards) {
    let i = -1;
    if (card.source?.type === 'note' && noteChunk.has(card.source.refId)) {
      i = noteChunk.get(card.source.refId)!;
    }
    if (i < 0 && card.headingId) {
      const bi = headingBi.get(card.headingId);
      if (bi !== undefined) i = chunkOfBi(ranges, bi);
    }
    if (i < 0) {
      unplaced++;
      continue;
    }
    groups[i].cards.push(card);
  }

  // ── 落盘 ──
  const written: { rel: string; title: string; blockCount: number; startBi: number }[] = [];
  for (let i = 0; i < plan.chunks.length; i++) {
    const chunk = plan.chunks[i];
    const outRel = await ensureUniqueRel(dir ? `${dir}/${names[i]}${ext}` : `${names[i]}${ext}`);
    await writeFileAtomic(await resolveInVault(outRel), chunk.text);

    const sub = emptySidecar(outRel);
    sub.highlights = groups[i].highlights;
    sub.notes = groups[i].notes;
    sub.cards = groups[i].cards;
    // docHash 留空，见上面的说明
    await writeSidecar(outRel, sub);

    written.push({ rel: outRel, title: chunk.title, blockCount: chunk.blockCount, startBi: chunk.startBi });
  }

  const migrated = {
    highlights: groups.reduce((a, g) => a + g.highlights.length, 0),
    notes: groups.reduce((a, g) => a + g.notes.length, 0),
    cards: groups.reduce((a, g) => a + g.cards.length, 0),
  };

  if (opts.removeOriginal !== false) await trashOriginal(rel);

  const bits = [`已按 h${plan.level} 切成 ${written.length} 篇`];
  if (migrated.highlights || migrated.notes || migrated.cards) {
    bits.push(`迁移了 ${migrated.highlights} 条高亮、${migrated.notes} 条批注、${migrated.cards} 张卡片`);
  }
  if (unplaced) bits.push(`${unplaced} 条批注找不到归属，已跳过`);

  return {
    ok: true,
    reason: 'ok',
    level: plan.level,
    original: rel,
    chunks: written,
    migrated,
    unplaced,
    message: bits.join('，'),
  };
}

docRouter.post(
  '/doc/split',
  h(async (req, res) => {
    const body = parse(splitSchema, req.body, '拆分请求');
    const out = await splitDocument(body.rel, {
      maxBlocks: body.maxBlocks,
      dryRun: body.dryRun,
      removeOriginal: body.removeOriginal,
    });
    res.json(out satisfies SplitOutcome);
  }),
);

// ─────────────────────────── 一键排版 ───────────────────────────

const formatSchema = z.object({
  markdown: z.string().max(2 * 1024 * 1024),
  options: z
    .object({
      spaceBetweenCJKAndLatin: z.boolean().optional(),
      detectHeadings: z.boolean().optional(),
      joinHardWrappedLines: z.boolean().optional(),
      stripPageNoise: z.boolean().optional(),
    })
    .optional(),
});

/** 规则版排版：即时、零成本、不会改内容。 */
docRouter.post(
  '/format',
  h(async (req, res) => {
    const body = parse(formatSchema, req.body, '排版请求');
    const r = formatText(body.markdown, body.options ?? {});
    res.json({ markdown: r.markdown, changes: r.changes, mode: 'rules' });
  }),
);

/** 把排版结果应用到磁盘上的文章（支持乐观锁）。 */
docRouter.post(
  '/format/apply',
  h(async (req, res) => {
    const body = parse(
      z.object({ rel: z.string().min(1).max(1024), baseHash: z.string().max(128).optional(), force: z.boolean().optional() }),
      req.body,
      '应用排版请求',
    );
    const doc = await readDoc(body.rel);
    const r = formatText(doc.markdown);
    const saved = await writeDoc(body.rel, r.markdown, body.baseHash ?? doc.docHash, Boolean(body.force));
    res.json({ docHash: saved.docHash, markdown: saved.markdown, changes: r.changes });
  }),
);

/** 用 hash 确认前端手里的版本是不是磁盘版本（保存前的一次轻量探测）。 */
docRouter.get(
  '/doc/hash',
  h(async (req, res) => {
    const rel = qStr(req, 'rel');
    const doc = await readDoc(rel);
    res.json({ docHash: doc.docHash, size: doc.markdown.length });
  }),
);
