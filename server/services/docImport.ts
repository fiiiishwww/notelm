/**
 * server/services/docImport.ts —— 导入产物的落盘层。
 *
 * ★ 为什么抽这一层 ★
 *   MinerU 切换后，「把解析结果变成库内文章」有两个调用方：
 *     - 手动上传（routes/doc.ts 的 /upload，文件模式）
 *     - agent 的 save_web_file（services/webTools.ts，URL 模式）
 *   落盘规则（assets 约定、永不覆盖、名字清洗）只写一份，两处行为才不会漂移。
 *
 * ★ 图片约定（全库统一，别破坏）★
 *   图片落文章**同级** assets/ 目录，markdown 里相对引用 ![](assets/xxx.jpg)。
 *   渲染层（shared/blocks.ts rewriteImageSrc）与 agent 的 extractImages 都按
 *   这个约定解析——新落盘路径必须长一样。
 *
 * ★ MinerU 结果包的官方原则（4.0 文档原话）★
 *   「跟随文档实际引用，不要自己拼文件名」——所以引用改写以 md 里真实出现的
 *   引用串为准，对照 zip 内实际存在的条目来映射，不假设 images/ 前缀格式。
 */

import { ensureDirSync, requireVaultRoot, writeFileAtomic } from '../core';
import { assertAllowedExt, assertSafeRel, resolveInVault } from '../security';
import { ensureUniqueRel } from '../vault';
import { ensureNotebook } from './sidecar';
import { unzip } from './zip';
import { MineruError } from './mineru';

/** 平移自 routes/doc.ts（原实现一行未改）：浏览器 File.name / URL 末段 → 合法文件名。 */
export function sanitizeName(raw: string): string {
  const base = raw.replace(/\\/g, '/').split('/').pop() ?? raw;
  const cleaned = base.replace(/[<>:"|?*\u0000-\u001f]/g, '_').replace(/^\.+/, '').trim();
  return cleaned || `未命名-${Date.now()}.md`;
}

const IMG_EXT = /\.(png|jpe?g|webp|gif)$/i;

export interface SaveMineruParams {
  /** MinerU 结果 zip 的原始字节 */
  zipBuf: Buffer;
  /** 期望的文章名（可含原始扩展名如 .pdf，内部统一归到 .md） */
  name: string;
  /** vault 相对目录，'' = 库根；不存在时落库根而不是报错（内容不丢） */
  dir: string;
  /** 同时保留原始文件（PDF 原件，走 /import-pdf 本地回退口的伏笔） */
  keepOriginal?: boolean;
  /** 原始文件字节（keepOriginal 时必传） */
  original?: Buffer;
}

export interface SaveMineruResult {
  /** 主产物（.md）的 vault 相对路径 */
  relPath: string;
  /** 保留的原件路径（未保留时 null） */
  savedOriginal: string | null;
  imageCount: number;
  charCount: number;
  warnings: string[];
}

/** MinerU zip 内的 markdown 成员名：v4 云 API 文档说 full.md；4.0 本地版叫 markdown.md。两个都认。 */
const MD_CANDIDATES = ['full.md', 'markdown.md'];

/**
 * 把 MinerU 结果包落成库内文章：md + 图片（assets/）+ 引用改写 + 永不覆盖。
 * 手动上传与 agent 的 save_web_file 共用。
 */
export async function saveMineruResult(p: SaveMineruParams): Promise<SaveMineruResult> {
  const root = await requireVaultRoot();
  await ensureNotebook(root);

  // ── 1. 名字归一：丢掉源文档扩展名，产物永远是 .md ──
  let base = sanitizeName(p.name).replace(/\.(pdf|docx?|pptx?|xlsx?)$/i, '');
  if (!/\.(md|markdown|txt)$/i.test(base)) base = `${base}.md`;

  // ── 2. 目标路径：永不覆盖（ensureUniqueRel 加 -2/-3），先做形态校验 ──
  const dir = (p.dir ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const wanted = dir ? `${dir}/${base}` : base;
  assertSafeRel(wanted);
  if (dir) {
    // 目录必须已存在：agent/前端都不该凭空造目录树；不存在就退到库根（内容不丢）
    const dirAbs = await resolveInVault(dir);
    const fsp = await import('node:fs/promises');
    let ok = true;
    try {
      ok = (await fsp.stat(dirAbs)).isDirectory();
    } catch {
      ok = false;
    }
    if (!ok) throw new MineruError('MINERU_API', `目标目录 ${dir} 不存在——先建目录或换一个已存在的目录`, 400);
  }
  const rel = await ensureUniqueRel(wanted);
  const abs = await resolveInVault(rel);
  assertAllowedExt(abs);

  // ── 3. 解包：找 markdown 主文件与图片条目 ──
  const zipped = unzip(p.zipBuf);
  const mdEntry =
    zipped.entries.find((e) => MD_CANDIDATES.includes(e.name.toLowerCase())) ??
    zipped.entries.find((e) => e.name.toLowerCase().endsWith('.md') && !e.name.includes('/'));
  if (!mdEntry) {
    throw new MineruError('MINERU_API', 'MinerU 的结果包里没有找到 markdown 文件（预期 full.md）');
  }
  const imgEntries = zipped.entries.filter((e) => /^images\//i.test(e.name) && IMG_EXT.test(e.name));

  // ── 4. 给每张图片分配 assets/ 新名（basename 冲突加 -2，保持扩展名小写原样）──
  const usedNames = new Set<string>();
  const byPath = new Map<string, string>(); // zip 内完整路径 → assets/xxx
  const byBase = new Map<string, string>(); // zip 内 basename  → assets/xxx（md 引用常不带目录）
  for (const e of imgEntries) {
    const orig = e.name.split('/').pop() ?? e.name;
    let target = orig;
    for (let i = 2; usedNames.has(target.toLowerCase()); i++) {
      target = orig.replace(/(\.[^.]+)$/, `-${i}$1`);
    }
    usedNames.add(target.toLowerCase());
    byPath.set(e.name, `assets/${target}`);
    if (!byBase.has(orig.toLowerCase())) byBase.set(orig.toLowerCase(), `assets/${target}`);
  }

  // ── 5. 改写 md 里的引用（跟随实际引用：完整路径与 basename 两种形态都认）──
  let md = mdEntry.data.toString('utf8');
  if (md.charCodeAt(0) === 0xfeff) md = md.slice(1);
  let unmatched = 0;
  const isExternal = (ref: string): boolean => /^(https?:)?\/\//i.test(ref) || ref.startsWith('data:');
  const mapRef = (rawRef: string): string | undefined => {
    if (isExternal(rawRef)) return undefined;
    let key = rawRef.replace(/^\.\//, '');
    try {
      key = decodeURIComponent(key);
    } catch {
      /* 编码不完整就按原样找 */
    }
    const hit = byPath.get(key) ?? byPath.get(key.replace(/^images\//i, 'images/')) ?? byBase.get(key.split('/').pop()!.toLowerCase());
    return hit;
  };
  // 外链/data URI 原样保留且不计入未命中（它们本来就不在结果包里，是文档的合法引用）
  md = md.replace(/(!\[[^\]]*\]\()([^)\s]+)((?:\s+"[^"]*")?\))/g, (whole, head, ref, tail) => {
    if (isExternal(ref)) return whole;
    const hit = mapRef(ref);
    if (!hit) {
      unmatched += 1;
      return whole;
    }
    return `${head}${hit}${tail}`;
  });
  md = md.replace(/(<img\s[^>]*?src=")([^"]+)(")/gi, (whole, head, ref, tail) => {
    if (isExternal(ref)) return whole;
    const hit = mapRef(ref);
    if (!hit) {
      unmatched += 1;
      return whole;
    }
    return `${head}${hit}${tail}`;
  });

  // ── 6. 落盘：图片进同级 assets/，md 原子写 ──
  const mdDir = rel.replace(/\/[^/]*$/, '');
  const assetsRel = mdDir ? `${mdDir}/assets` : 'assets';
  if (imgEntries.length) {
    ensureDirSync(await resolveInVault(assetsRel));
    for (const e of imgEntries) {
      const target = byPath.get(e.name)!.replace(/^assets\//, '');
      await writeFileAtomic(await resolveInVault(`${assetsRel}/${target}`), e.data);
    }
  }
  await writeFileAtomic(abs, md);

  // ── 7. 原件保留（/import-pdf 本地回退口的伏笔）──
  let savedOriginal: string | null = null;
  if (p.keepOriginal && p.original) {
    const origBase = sanitizeName(p.name);
    const origWanted = dir ? `${dir}/${origBase}` : origBase;
    const origRel = await ensureUniqueRel(origWanted);
    await writeFileAtomic(await resolveInVault(origRel), p.original);
    savedOriginal = origRel;
  }

  const warnings: string[] = [];
  if (imgEntries.length === 0) warnings.push('解析结果里没有图片');
  if (unmatched > 0) warnings.push(`${unmatched} 处图片引用在结果包里找不到对应文件（可能是外链图），引用保持原样`);
  if (rel !== wanted) warnings.push(`已经有一篇同名的文章了，这次保存成「${rel.split('/').pop()}」，没有动你原来的文件`);

  return { relPath: rel, savedOriginal, imageCount: imgEntries.length, charCount: md.length, warnings };
}

/**
 * 纯文本落盘（md/txt 直链下载、网页转 md 后都走这里）。
 * 与 saveMineruResult 同一套规则：sanitizeName → 永不覆盖 → 原子写。
 */
export async function saveTextDoc(text: string, name: string, dir: string): Promise<{ relPath: string; charCount: number; renamed: boolean }> {
  const root = await requireVaultRoot();
  await ensureNotebook(root);
  const dirNorm = (dir ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const base = sanitizeName(name);
  const wanted = dirNorm ? `${dirNorm}/${base}` : base;
  assertSafeRel(wanted);
  if (dirNorm) {
    const dirAbs = await resolveInVault(dirNorm);
    const fsp = await import('node:fs/promises');
    let ok = true;
    try {
      ok = (await fsp.stat(dirAbs)).isDirectory();
    } catch {
      ok = false;
    }
    if (!ok) throw new MineruError('MINERU_API', `目标目录 ${dirNorm} 不存在——先建目录或换一个已存在的目录`, 400);
  }
  const rel = await ensureUniqueRel(wanted);
  await writeFileAtomic(await resolveInVault(rel), text);
  return { relPath: rel, charCount: text.length, renamed: rel !== wanted };
}
