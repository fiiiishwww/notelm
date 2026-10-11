/**
 * server/routes/import.ts —— 把外部的文章拿进笔记库：飞书云文档 / 导出的压缩包。
 *
 * ★ 为什么要有这两条路 ★
 *   从飞书里复制粘贴到别处，图片一定会丢——飞书的图存在云空间里，不是普通外链，
 *   剪贴板那份 HTML 拿到的是带鉴权参数的一次性地址，粘出来就是死链。
 *   所以保住图只有两条路：
 *     1. 走官方接口（需要 app_id / app_secret，图片一张张下载回来）；
 *     2. 用飞书自己导出的压缩包（里面的图是真实文件，什么都不用配）。
 *   第 1 条是主力，第 2 条是兜底——也顺带能吃下语雀、Notion 的导出包。
 *
 * ★ 三条贯穿全文件的规矩 ★
 *   1. **永远不覆盖已有文件**。重名就自动加 -2 / -3（ensureUniqueRel），
 *      笔记库里可能已经有用户自己写的同名文章，静默覆盖等于毁掉他的内容。
 *   2. **图片名带文档前缀**。同一个目录里很可能有两篇同标题的文档，
 *      如果图都叫 image-1.png，后导入的那篇会把前一篇的图悄悄盖掉。
 *   3. **图片一律写进文章同级的 assets/，正文用相对路径引用**。
 *      和 PDF 导入保持一致（见 routes/doc.ts 的 writePdfAssets），
 *      这样 Obsidian / VSCode 打开也是好的，不依赖我们的后端。
 */

import path from 'node:path';
import fsp from 'node:fs/promises';
import { Router } from 'express';
import { z } from 'zod';
import { ApiError, bad, requireVaultRoot, writeFileAtomic } from '../core';
import { resolveInVault } from '../security';
import { ensureUniqueRel } from '../vault';
import { ensureNotebook } from '../services/sidecar';
import { fetchFeishuDoc, peekFeishuDoc, type FeishuImage } from '../services/feishu';
import { unzip, isJunkEntry } from '../services/zip';
import { formatText } from '../services/typographer';
import { safeTitle } from '../services/naming';
import { splitDocument, SPLIT_BLOCK_THRESHOLD } from './doc';
import { h, parse } from './http';

export const importRouter = Router();

// ─────────────────────────── 公共小工具 ───────────────────────────

const MD_EXT = new Set(['.md', '.markdown', '.txt']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.avif', '.ico']);

/** 把用户选的目录统一成「vault 相对、无首尾斜杠」的形态。 */
function normDir(raw: string | undefined): string {
  return (raw ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

function joinRel(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

/** 取文件名主干（去掉目录和扩展名），用作图片前缀。 */
function stemOf(rel: string): string {
  const base = rel.slice(rel.lastIndexOf('/') + 1);
  return base.replace(/\.[^.]+$/, '');
}

/**
 * 定一个「不覆盖已有文件」的目标路径。
 * 返回 renamed 是为了让上层能给用户一句明确的话——
 * 「已经有一篇同名的了，这篇存成了 xxx-2.md」比默默改名让人安心得多。
 */
async function planTarget(rel: string): Promise<{ rel: string; renamed: boolean }> {
  const final = await ensureUniqueRel(rel);
  return { rel: final, renamed: final !== rel };
}

// ─────────────────────────── 飞书：预览 ───────────────────────────

const peekSchema = z.object({
  /** 用户粘进来的链接（也可以直接是 document_id） */
  url: z.string().min(1).max(2048),
  /** 打算放到哪个目录（vault 相对），'' 表示根 */
  dir: z.string().max(1024).optional(),
});

/**
 * 只看标题，不下载图片。
 * 这一步存在的理由：文件名要先定下来，图片前缀才算得出来（见本文件开头的规矩 2）。
 * 少了这一步，就会出现文章叫「会议纪要-2.md」而图片还叫「会议纪要-image-1.png」的错配。
 */
importRouter.post(
  '/import/feishu/peek',
  h(async (req, res) => {
    const body = parse(peekSchema, req.body, '飞书预览请求');
    const dir = normDir(body.dir);
    const info = await peekFeishuDoc(body.url);

    const name = safeTitle(info.title);
    const wanted = joinRel(dir, `${name}.md`);
    const planned = await planTarget(wanted);
    res.json({
      title: info.title,
      documentId: info.documentId,
      kind: info.kind,
      suggestedName: name,
      suggestedRel: planned.rel,
      /** 前端据此提示「这个目录下已经有一篇同名的了，会存成 xxx-2.md」 */
      renamed: planned.renamed,
    });
  }),
);

// ─────────────────────────── 飞书：导入 ───────────────────────────

const feishuSchema = z.object({
  url: z.string().min(1).max(2048),
  /** 预览阶段已经解析出来的 document_id；传了就跳过链接解析（省一次接口调用） */
  documentId: z.string().max(128).optional(),
  /** 预览阶段已经查到的标题；传了就跳过「读取文档信息」这一次调用 */
  title: z.string().max(500).optional(),
  dir: z.string().max(1024).optional(),
  /** 自定义文件名（不含扩展名）；不传就用文档标题 */
  name: z.string().max(200).optional(),
  /** 是否顺带跑一遍规则排版（中英文之间加空格等） */
  format: z.boolean().optional(),
});

importRouter.post(
  '/import/feishu',
  h(async (req, res) => {
    const body = parse(feishuSchema, req.body, '飞书导入请求');
    const root = await requireVaultRoot();
    await ensureNotebook(root);
    const dir = normDir(body.dir);

    // 1) 先定文件名（标题 → 安全文件名 → 重名加后缀）。
    //    用户自己填了名字就不必再去问飞书标题，省一次接口调用。
    let name = body.name?.trim() ? safeTitle(body.name) : '';
    let documentId = body.documentId;
    // 用户改了文件名也照样带上原标题：文件名是给人看的，正文的一级标题应该还是文档本来的名字
    let realTitle = body.title?.trim() ?? '';
    if (!name) {
      const info = await peekFeishuDoc(body.url);
      name = safeTitle(info.title);
      documentId = info.documentId;
      realTitle = info.title;
    }

    const wanted = joinRel(dir, `${name}.md`);
    const planned = await planTarget(wanted);

    // 2) 用**最终**文件名算图片前缀——这一步是「两篇同名文档互相盖图」的唯一防线
    const imagePrefix = `${stemOf(planned.rel)}-`;

    // 3) 拉内容 + 下载图片（串行 + 节流，飞书 5 QPS 的硬限制）
    const doc = await fetchFeishuDoc(body.url, {
      documentId,
      imagePrefix,
      // 预览时已经拿到过标题就别再取一次（一次调用 = 一次 200ms 的节流等待）
      title: realTitle,
    });

    let markdown = doc.markdown;
    const changes: { rule: string; count: number }[] = [];
    if (body.format) {
      const f = formatText(markdown);
      markdown = f.markdown;
      changes.push(...f.changes);
    }

    const mdAbs = await resolveInVault(planned.rel);
    await writeFileAtomic(mdAbs, markdown);

    const imageCount = await writeAssets(planned.rel, doc.images);

    const warnings = [...doc.warnings];
    if (planned.renamed) {
      warnings.push(
        `这个目录下已经有一篇同名的文章了，这一篇存成了「${planned.rel.slice(planned.rel.lastIndexOf('/') + 1)}」，没有动你原来的文件`,
      );
    }
    if (doc.unsupported.length) {
      warnings.push(`飞书里有些内容转不成 Markdown（块类型 ${doc.unsupported.join('、')}），已跳过`);
    }

    res.json({
      ok: true,
      relPath: planned.rel,
      title: doc.title,
      renamed: planned.renamed,
      imageCount,
      charCount: markdown.length,
      blockCount: doc.stats.blocks,
      changes,
      warnings,
    });
  }),
);

/**
 * 把图片写进文章同级的 assets/。
 * 与 PDF 导入共用同一个约定（routes/doc.ts 的 writePdfAssets），
 * 这样不管内容从哪来，用户打开笔记库看到的结构都是一致的。
 */
async function writeAssets(mdRel: string, images: FeishuImage[]): Promise<number> {
  if (!images.length) return 0;
  const dir = mdRel.replace(/\/[^/]*$/, '');
  const assetsRel = dir ? `${dir}/assets` : 'assets';
  for (const img of images) {
    await writeFileAtomic(await resolveInVault(`${assetsRel}/${img.file}`), img.data);
  }
  return images.length;
}

// ─────────────────────────── 压缩包导入 ───────────────────────────

const zipQuery = z.object({
  dir: z.string().max(1024).default(''),
  /** 是否对导进来的 md 跑一遍规则排版 */
  format: z.string().optional(),
});

/**
 * 导入一个 zip。请求体是原始二进制（和 /upload 一样，前端不需要 multipart 依赖）。
 *
 * 处理顺序：解包 → 剥掉顶层目录 → 分类 → 定目标路径（不覆盖）→ 修正引用 → 落盘。
 * 「修正引用」只在真的发生过重命名时才做，绝大多数情况下整棵树原样照搬。
 */
importRouter.post(
  '/import/zip',
  h(async (req, res) => {
    const q = parse(zipQuery, req.query, '压缩包导入参数');
    const buf = req.body as unknown;
    if (!Buffer.isBuffer(buf) || buf.length === 0) throw bad('没有收到压缩包内容', 'empty_upload');
    if (buf.length > 200 * 1024 * 1024) throw bad('压缩包超过 200MB 限制', 'too_large');

    const root = await requireVaultRoot();
    await ensureNotebook(root);
    const dir = normDir(q.dir);

    const { entries, skipped } = unzip(buf);
    const usable = entries.filter((e) => !isJunkEntry(e.name));

    // ── 1. 剥掉顶层目录 ──
    // 几乎所有导出包都是「一个文件夹装着 md + images」，这层文件夹是打包时加的，
    // 用户已经选了目标目录，再套一层就成了 dir/文档名/文档名.md，没必要。
    const prefix = commonRootPrefix(usable.map((e) => e.name));
    const files = usable.map((e) => ({
      inner: prefix ? e.name.slice(prefix.length) : e.name,
      data: e.data,
    })).filter((f) => f.inner.length > 0);

    if (files.length === 0) {
      throw new ApiError(400, '这个压缩包里没有可以导入的文件（只认 md / txt 和图片）', 'zip_empty');
    }

    // ── 2. 分类 ──
    const mdFiles: typeof files = [];
    const assets: typeof files = [];
    const skippedFiles: string[] = [...skipped];
    for (const f of files) {
      const ext = path.extname(f.inner).toLowerCase();
      if (MD_EXT.has(ext)) mdFiles.push(f);
      else if (IMAGE_EXT.has(ext)) assets.push(f);
      else skippedFiles.push(f.inner);
    }
    if (mdFiles.length === 0) {
      throw new ApiError(400, '这个压缩包里没有 md / txt 文件，没法当文章导入', 'zip_no_markdown');
    }

    // ── 3. 定目标路径：一个都不覆盖 ──
    //    资源文件如果和已有文件**内容完全一致**，就沿用原名、不再写一遍
    //    （重复导入同一个包是最常见的操作，这样第二次导入不会变成 xxx-2 + 一堆 -2 的图）。
    const plan = new Map<string, { rel: string; renamed: boolean; write: boolean }>();
    for (const f of mdFiles) {
      const wanted = joinRel(dir, f.inner);
      const p = await planTarget(wanted);
      plan.set(f.inner, { rel: p.rel, renamed: p.renamed, write: true });
    }
    for (const f of assets) {
      const wanted = joinRel(dir, f.inner);
      // 内容完全一致就沿用原名、不再写一遍：重复导入同一个包是最常见的操作，
      // 这样做第二次导入不会变成「文章 -2 + 一堆图片 -2」的烂摊子。
      if (await sameFileExists(wanted, f.data)) {
        plan.set(f.inner, { rel: wanted, renamed: false, write: false });
        continue;
      }
      const p = await planTarget(wanted);
      plan.set(f.inner, { rel: p.rel, renamed: p.renamed, write: true });
    }

    // ── 4. 修正 md 里的图片引用 ──
    //    只有真重命名过才需要改。按文件名替换（不是整条路径）——
    //    导出包里的引用形态五花八门（images/a.png、./images/a.png、URL 编码过的），
    //    而同一份包里同名文件本来就罕见，按名字替换既够用又不会改坏正文。
    const renames: { from: string; to: string }[] = [];
    for (const [inner, p] of plan) {
      if (!p.renamed) continue;
      renames.push({ from: inner.slice(inner.lastIndexOf('/') + 1), to: p.rel.slice(p.rel.lastIndexOf('/') + 1) });
    }

    // ── 5. 落盘 ──
    const relPaths: string[] = [];
    const warnings: string[] = [];
    const changes: { rule: string; count: number }[] = [];

    for (const f of assets) {
      const p = plan.get(f.inner)!;
      if (!p.write) continue;
      await writeFileAtomic(await resolveInVault(p.rel), f.data);
    }

    for (const f of mdFiles) {
      const p = plan.get(f.inner)!;
      let text = f.data.toString('utf8');
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      if (renames.length) text = applyRenames(text, renames);
      if (q.format === '1') {
        const r = formatText(text);
        text = r.markdown;
        changes.push(...r.changes);
      }
      await writeFileAtomic(await resolveInVault(p.rel), text);
      relPaths.push(p.rel);
      if (p.renamed) {
        warnings.push(`已经有一个「${f.inner}」了，这次存成了「${p.rel.slice(p.rel.lastIndexOf('/') + 1)}」`);
      }
    }

    if (skippedFiles.length) {
      warnings.push(`有 ${skippedFiles.length} 个文件不是文章或图片，没有导入`);
    }

    // ── 5b. 导入进来的超大文档，落盘后立刻按标题切开 ──
    //
    // 飞书 / 语雀的一整本导出经常被打包成**单个** md。实测一篇 833 张图、
    // 8819 块的导出，浏览器打开时布局要 985ms。与其等用户点开时卡一下，
    // 不如导入的时候就切好。
    //
    // 这里是最好下手的地方：刚导入的文章不可能有任何批注，
    // 拆分只需搬内容，不存在锚点迁移的问题。
    // 切不动（没有标题 / 切开会弄坏代码块）就原样留着，不影响本次导入。
    let primaryRel = pickPrimary(mdFiles.map((f) => f.inner), plan, prefix);
    const splitInto = new Map<string, string[]>();
    for (const rel of relPaths) {
      try {
        const out = await splitDocument(rel, { maxBlocks: SPLIT_BLOCK_THRESHOLD });
        if (out.ok && out.chunks.length > 0) splitInto.set(rel, out.chunks.map((c) => c.rel));
      } catch {
        /* 切不动就保持原样 */
      }
    }
    if (splitInto.size > 0) {
      const next: string[] = [];
      for (const rel of relPaths) {
        const parts = splitInto.get(rel);
        if (parts) next.push(...parts);
        else next.push(rel);
      }
      relPaths.length = 0;
      relPaths.push(...next);
      // 主文档如果恰好被切了，改成打开它的第一篇
      if (primaryRel && splitInto.has(primaryRel)) primaryRel = splitInto.get(primaryRel)![0];
      warnings.push(`有 ${splitInto.size} 篇太长，已按标题拆成了小文档`);
    }

    res.json({
      ok: true,
      count: relPaths.length,
      imageCount: assets.filter((f) => plan.get(f.inner)!.write).length,
      relPaths,
      /** 导入后自动打开这一篇（挑最像主文档的那一篇） */
      primaryRel,
      changes,
      warnings,
      skipped: skippedFiles.slice(0, 20),
    });
  }),
);

/** 目标路径上是否已经有一个**字节完全相同**的文件。 */
async function sameFileExists(rel: string, data: Buffer): Promise<boolean> {
  try {
    const abs = await resolveInVault(rel);
    const old = await fsp.readFile(abs);
    return old.equals(data);
  } catch {
    // 不存在 / 名字不合法 / 读不了，都当成「需要新写一份」
    return false;
  }
}

/** 所有条目共用的顶层目录名（带结尾斜杠）；没有就返回 ''。 */
function commonRootPrefix(names: string[]): string {
  if (names.length === 0) return '';
  const first = names[0]!.split('/')[0]!;
  if (!first) return '';
  for (const n of names) {
    if (n.split('/')[0] !== first) return '';
  }
  // 只有一个条目且它就是个文件（没有子路径）时，剥掉它反而会丢名字
  if (names.length === 1 && !names[0]!.includes('/')) return '';
  return `${first}/`;
}

/** 把正文里对旧文件名的引用换成新文件名（原文和 URL 编码两种写法都换）。 */
function applyRenames(text: string, renames: { from: string; to: string }[]): string {
  let out = text;
  for (const r of renames) {
    if (!r.from || r.from === r.to) continue;
    out = out.split(r.from).join(r.to);
    const enc = encodeURIComponent(r.from);
    if (enc !== r.from) out = out.split(enc).join(encodeURIComponent(r.to));
  }
  return out;
}

/**
 * 挑一篇作为「导入后打开」的文档。
 * 优先选名字跟剥掉的顶层目录同名的那篇（那通常是主文档），
 * 否则选层级最浅、内容最长的——短文件多半是目录索引或附件说明。
 */
function pickPrimary(
  inners: string[],
  plan: Map<string, { rel: string }>,
  prefix: string,
): string | null {
  if (inners.length === 0) return null;
  const rootName = prefix ? prefix.slice(0, -1) : '';
  const scored = inners.map((inner) => {
    const base = inner.slice(inner.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');
    const depth = inner.split('/').length - 1;
    const nameMatch = rootName && base === rootName ? 0 : 1;
    return { inner, score: nameMatch * 1000 + depth * 10 };
  });
  scored.sort((a, b) => a.score - b.score || a.inner.localeCompare(b.inner));
  return plan.get(scored[0]!.inner)?.rel ?? null;
}
