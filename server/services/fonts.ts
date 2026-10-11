/**
 * server/services/fonts.ts —— 用户自备字体（小抄的呈现偏好）。
 *
 * ★ 为什么放 `.local/fonts/` 而不是笔记库里 ★
 *   字体是**这台机器上的呈现偏好**，不是知识内容：4MB 的二进制塞进 notes/
 *   会被同步、被扫描逻辑白扫一遍，而它和「换一个库」这件事没关系。
 *   （对比：检索索引是跟着库走的，因为它是**那批知识**的派生数据。）
 *
 * ★ 为什么自己解析 name 表 ★
 *   @font-face 需要一个稳定、唯一、CSS 安全的 family 名。直接用用户文件名会
 *   撞上引号/中文/重名；用内部 name 表又可能两个文件同名。所以：
 *     family = `nb-` + 文件名的安全化形式（唯一且可预测）
 *     label  = 内部 family 名（给人看）
 *   解析不出来（woff/woff2 的表是压缩的、或名字缺失）就退回文件名当 label。
 *
 * ★ 删除走 rename 不是 rm ★
 *   和 sidecar 那边同一条规矩：fs.rm 在本项目被 shim 接管，
 *   一律 rename 进 trash 目录，留后悔药。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { ApiError, LOCAL_DIR, ensureDirSync } from '../core';

export const FONTS_DIR = path.join(LOCAL_DIR, 'fonts');
const TRASH_DIR = path.join(LOCAL_DIR, 'trash');

export interface FontInfo {
  /** 文件名，前端用它当唯一标识（也是 URL 里的值） */
  file: string;
  /** CSS font-family 值（稳定、唯一、无引号歧义） */
  family: string;
  /** 界面上显示的名字（尽量用字体内部名字） */
  label: string;
  size: number;
  format: 'truetype' | 'opentype' | 'collection' | 'woff' | 'woff2';
  addedAt: string;
}

const EXT_FORMAT: Record<string, FontInfo['format']> = {
  '.ttf': 'truetype',
  '.otf': 'opentype',
  '.ttc': 'collection',
  '.woff': 'woff',
  '.woff2': 'woff2',
};

const FORMAT_MIME: Record<FontInfo['format'], string> = {
  truetype: 'font/ttf',
  opentype: 'font/otf',
  collection: 'font/collection',
  woff: 'font/woff',
  woff2: 'font/woff2',
};

/** 允许上传的扩展名（也用于服务时的白名单）。 */
export const FONT_EXTENSIONS = Object.keys(EXT_FORMAT);

/** 按表头判断格式。改扩展名的图片/压缩包在这里被拦下。 */
export function sniffFont(buf: Buffer): FontInfo['format'] | null {
  if (buf.length < 16) return null;
  const v = buf.readUInt32BE(0);
  if (v === 0x00010000 || v === 0x74727565 /* 'true' */) return 'truetype';
  if (v === 0x4f54544f /* 'OTTO' */) return 'opentype';
  if (v === 0x74746366 /* 'ttcf' */) return 'collection';
  const tag = buf.slice(0, 4).toString('latin1');
  if (tag === 'wOFF') return 'woff';
  if (tag === 'wOF2') return 'woff2';
  return null;
}

/**
 * 内部名值不值得当界面标签用。
 *
 * ★ 实测过的一个坑 ★
 *   这份「多鱼1123体」的 name 表里写的是 `duoyu1123ti_4_3659945`——
 *   明显是生成器/下载站塞进去的机器名，给用户看毫无意义。
 *   所以机器名一律不采信，退回文件名（用户自己起的名字反而更清楚）。
 */
function isMachineName(name: string): boolean {
  return /_\d{3,}$/.test(name) || /\d{6,}/.test(name) || (name.length > 32 && !/\s/.test(name));
}

/** 读 sfnt name 表里的人类可读名字。解析不了返回 null（woff/woff2 的表是压缩的）。 */
function readInternalName(buf: Buffer): string | null {
  try {
    const numTables = buf.readUInt16BE(4);
    if (numTables > 128) return null;
    let nameOff = -1;
    let nameLen = 0;
    for (let i = 0; i < numTables; i++) {
      const o = 12 + i * 16;
      if (o + 16 > buf.length) return null;
      if (buf.slice(o, o + 4).toString('latin1') === 'name') {
        nameOff = buf.readUInt32BE(o + 8);
        nameLen = buf.readUInt32BE(o + 12);
        break;
      }
    }
    if (nameOff < 0 || nameOff + 6 > buf.length) return null;
    const count = buf.readUInt16BE(nameOff + 2);
    if (count > 4096 || nameOff + 6 + count * 12 > buf.length + 2048) return null;
    const strOff = nameOff + buf.readUInt16BE(nameOff + 4);
    // 优先 nameID 4（完整名）→ 1（家族名）→ 16（排版家族名）
    const wanted = [4, 1, 16];
    for (const want of wanted) {
      for (let i = 0; i < count; i++) {
        const r = nameOff + 6 + i * 12;
        if (r + 12 > buf.length) break;
        const pid = buf.readUInt16BE(r);
        const eid = buf.readUInt16BE(r + 2);
        const nid = buf.readUInt16BE(r + 6);
        if (nid !== want) continue;
        const len = buf.readUInt16BE(r + 8);
        const off = buf.readUInt16BE(r + 10);
        if (strOff + off + len > buf.length || len === 0 || len > 512) continue;
        const raw = buf.subarray(strOff + off, strOff + off + len);
        const text =
          pid === 3
            ? raw.swap16().toString('utf16le')
            : raw.toString('latin1');
        const clean = text.replace(/[\u0000-\u001f]/g, '').trim();
        // 有些生成器把内部名写成 duoyu1123ti_4_3659945 这种机器名，
        // 含有下划线+一长串数字时对人不友好 —— 还是让调用方决定，这里原样返回。
        if (clean) return clean;
      }
    }
  } catch {
    // 字体文件千奇百怪，解析失败不是错误，有文件名兜底
  }
  return null;
}

/**
 * 文件名 → CSS family。稳定、唯一（同名文件在保存时就已去重）、CSS 安全。
 *
 * ★ 为什么要带一段哈希 ★
 *   中文文件名里的汉字会被过滤成下划线：`多鱼1123体` → `___1123_`，
 *   而 `我的字体A` / `我的字体B` 都会变成 `__A` / `__B`…… 极端情况下
 *   `字体A` 和 `体字A` 会撞成同一个 family，两个字体互相顶掉。
 *   所以拼一段文件名的哈希：ASCII 部分只是给人看的可读性，唯一性靠哈希。
 */
function familyOf(file: string): string {
  const base = file.replace(/\.[^.]+$/, '');
  const ascii = base.replace(/[^A-Za-z0-9]+/g, '').slice(0, 24);
  const hash = createHash('sha1').update(file).digest('hex').slice(0, 6);
  return `nb-${ascii || 'font'}-${hash}`;
}

/** 文件绝对路径。只接受**单个文件名**，任何路径分隔符都拒绝（防目录穿越）。 */
export function fontAbsPath(file: string): string | null {
  const name = path.basename(file ?? '');
  if (!name || name !== file) return null;
  const ext = path.extname(name).toLowerCase();
  if (!EXT_FORMAT[ext]) return null;
  return path.join(FONTS_DIR, name);
}

export function fontMime(format: FontInfo['format']): string {
  return FORMAT_MIME[format] ?? 'application/octet-stream';
}

/** 列目录内容时用的缓存：4MB 文件不必每次请求都重新解析 name 表。 */
const infoCache = new Map<string, { size: number; mtimeMs: number; info: FontInfo }>();

export async function listFonts(): Promise<FontInfo[]> {
  ensureDirSync(FONTS_DIR);
  const names = await fsp.readdir(FONTS_DIR);
  const out: FontInfo[] = [];
  for (const file of names) {
    const ext = path.extname(file).toLowerCase();
    if (!EXT_FORMAT[ext]) continue;
    const abs = path.join(FONTS_DIR, file);
    let st;
    try {
      st = await fsp.stat(abs);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    const cached = infoCache.get(file);
    if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) {
      out.push(cached.info);
      continue;
    }
    // 只读头部 + name 表所在的窗口：ttf/otf 的 name 表一般在文件前部，
    // 8MB 足够覆盖；读不到就退回文件名。
    const head = await readHead(abs, Math.min(st.size, 8 * 1024 * 1024));
    const format = sniffFont(head) ?? EXT_FORMAT[ext];
    const internal = readInternalName(head);
    const base = file.replace(/\.[^.]+$/, '');
    // 内部名优先，但机器名不采信（见 isMachineName）；都没有就用文件名
    const label = internal && !isMachineName(internal) ? internal : base;
    const info: FontInfo = {
      file,
      family: familyOf(file),
      label,
      size: st.size,
      format,
      addedAt: st.mtime.toISOString(),
    };
    infoCache.set(file, { size: st.size, mtimeMs: st.mtimeMs, info });
    out.push(info);
  }
  out.sort((a, b) => (a.addedAt < b.addedAt ? 1 : -1));
  return out;
}

async function readHead(abs: string, bytes: number): Promise<Buffer> {
  const fh = await fsp.open(abs, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    await fh.read(buf, 0, bytes, 0);
    return buf;
  } finally {
    await fh.close();
  }
}

/** 上传保存。返回落盘后的信息（含 family / label）。 */
export async function saveFont(originalName: string, buf: Buffer): Promise<FontInfo> {
  if (!buf?.length) throw new ApiError(400, '没有收到字体内容', 'empty_body');
  if (buf.length < 1024) throw new ApiError(400, '这个文件太小，不像字体', 'too_small');
  if (buf.length > 60 * 1024 * 1024) throw new ApiError(413, '字体文件太大（上限 60MB）', 'too_large');

  const ext = path.extname(originalName ?? '').toLowerCase();
  if (!EXT_FORMAT[ext]) {
    throw new ApiError(
      415,
      `不支持的字体格式：${ext || '(无扩展名)'}（支持 ${FONT_EXTENSIONS.join(' / ')}）`,
      'bad_ext',
    );
  }
  const format = sniffFont(buf);
  if (!format) {
    throw new ApiError(415, '这个文件不是字体（改了扩展名也能认出来）', 'bad_font');
  }

  ensureDirSync(FONTS_DIR);
  const base = path
    .basename(originalName)
    .replace(/\.[^.]+$/, '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .trim()
    .slice(0, 80) || 'font';

  // 重名就加序号，绝不覆盖：用户可能同时留着「我的字体 v1 / v2」
  let file = `${base}${ext}`;
  for (let i = 2; fs.existsSync(path.join(FONTS_DIR, file)); i++) {
    file = `${base}-${i}${ext}`;
    if (i > 99) throw new ApiError(409, '同名文件太多了，换个名字再传', 'too_many_dups');
  }

  const abs = path.join(FONTS_DIR, file);
  await fsp.writeFile(abs, buf);
  infoCache.delete(file);
  const fonts = await listFonts();
  const info = fonts.find((f) => f.file === file);
  if (!info) throw new ApiError(500, '字体写入后读不出来', 'write_failed');
  return info;
}

/** 删除：rename 进 trash，不做真删除（本项目 fs.rm 被 shim 接管的统一规避方式）。 */
export async function deleteFont(file: string): Promise<void> {
  const abs = fontAbsPath(file);
  if (!abs) throw new ApiError(400, '字体文件名不合法', 'bad_name');
  if (!fs.existsSync(abs)) throw new ApiError(404, '没有这个字体', 'not_found');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(TRASH_DIR, `${stamp}-font`);
  ensureDirSync(dest);
  await fsp.rename(abs, path.join(dest, path.basename(abs)));
  infoCache.delete(file);
}

/** 把用户给的这个字体收进字体库（首次接入内置一份）。 */
export async function importFontFile(srcAbs: string, displayName?: string): Promise<FontInfo> {
  const buf = await fsp.readFile(srcAbs);
  const name = displayName ?? path.basename(srcAbs);
  return saveFont(name, buf);
}
