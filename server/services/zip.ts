/**
 * server/services/zip.ts —— 极简 ZIP 解包（零依赖）。
 *
 * ★ 为什么不装一个 unzip 库 ★
 *   项目只依赖 express / markdown-it / pdfjs-dist / react / zod 五样，
 *   为了一个「用户几个月才点一次」的导入功能往里塞一个压缩库不划算。
 *   而 ZIP 的读取其实很规矩：文件末尾有中央目录，顺着它就能找到每个条目。
 *   Node 自带的 zlib 负责真正的 inflate，我们要写的只是格式解析那几十行。
 *
 * 只支持最常见的两种压缩方式：
 *   - 0 (stored)   原样存放，直接切片
 *   - 8 (deflate)  zlib.inflateRawSync
 * 其它方式（LZMA、bzip2 等）明确报错，不猜。
 *
 * ★ 安全边界（解包是公认的高危操作）★
 *   1. **Zip Slip**：条目名里的 `..` 和绝对路径一律丢弃，绝不允许逃出目标目录；
 *   2. **解压炸弹**：限制解压后总体积、单个条目体积、以及压缩比；
 *   3. 条目数量上限，防止构造一个含几十万条目的包把内存打爆。
 */

import zlib from 'node:zlib';
import { ApiError } from '../core';

export interface ZipEntry {
  /** 包内相对路径，分隔符统一成 / */
  name: string;
  data: Buffer;
}

export interface UnzipResult {
  entries: ZipEntry[];
  /** 因为名字不安全或类型不支持而被跳过的条目名 */
  skipped: string[];
}

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

const DEFAULTS = {
  maxEntries: 2000,
  maxTotalBytes: 200 * 1024 * 1024,
  maxEntryBytes: 60 * 1024 * 1024,
  /** 压缩比上限：1 字节压出 1MB 就是典型的解压炸弹 */
  maxRatio: 200,
};

export function unzip(buf: Buffer, opts: Partial<typeof DEFAULTS> = {}): UnzipResult {
  const o = { ...DEFAULTS, ...opts };

  // ── 1. 找中央目录 ──
  // EOCD 在文件末尾（后面最多跟 64KB 注释），所以从尾部往前扫。
  let eocd = -1;
  const scanEnd = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= scanEnd; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new ApiError(400, '这不是一个有效的 zip 文件（找不到结尾标记）', 'bad_zip');
  }

  const total = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff || total === 0xffff) {
    throw new ApiError(400, '这个 zip 用了 ZIP64 格式，暂不支持（一般是超过 4GB 的包）', 'zip64');
  }
  if (cdOffset < 0 || cdOffset >= buf.length) {
    throw new ApiError(400, '这个 zip 文件已损坏（中央目录位置不对）', 'bad_zip');
  }

  const entries: ZipEntry[] = [];
  const skipped: string[] = [];
  let totalBytes = 0;
  let p = cdOffset;

  for (let i = 0; i < total; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CD_SIG) break;
    if (entries.length >= o.maxEntries) {
      skipped.push(`…（超过 ${o.maxEntries} 个条目，后面的不再处理）`);
      break;
    }

    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    let compSize = buf.readUInt32LE(p + 20);
    let rawSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const rawName = buf.subarray(p + 46, p + 46 + nameLen);
    const name = decodeName(rawName, flags);

    p += 46 + nameLen + extraLen + commentLen;

    // 目录条目：名字以 / 结尾，没有数据，跳过但也不算「被丢弃」
    const isDir = name.endsWith('/');
    if (!isDir) {
      const safe = safeName(name);
      if (!safe) {
        skipped.push(name);
        continue;
      }
      if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LOCAL_SIG) {
        skipped.push(`${name}（条目头损坏）`);
        continue;
      }

      const localNameLen = buf.readUInt16LE(localOffset + 26);
      const localExtraLen = buf.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLen + localExtraLen;

      // 有些打包器在 local header 里把大小写成 0（用了 data descriptor），
      // 这时以中央目录里的值为准
      if (compSize === 0) compSize = buf.readUInt32LE(localOffset + 18);
      if (rawSize === 0) rawSize = buf.readUInt32LE(localOffset + 22);
      if (compSize === 0 && rawSize === 0) {
        skipped.push(`${name}（无法确定大小）`);
        continue;
      }
      if (dataStart + compSize > buf.length) {
        skipped.push(`${name}（数据越界，包可能被截断）`);
        continue;
      }

      // 解压炸弹检查要在真正解压**之前**做，否则内存已经炸了
      if (rawSize > o.maxEntryBytes) {
        skipped.push(`${name}（单个文件超过 ${Math.round(o.maxEntryBytes / 1024 / 1024)}MB）`);
        continue;
      }
      if (compSize > 0 && rawSize / compSize > o.maxRatio && rawSize > 1024 * 1024) {
        skipped.push(`${name}（压缩比异常，疑似压缩包炸弹）`);
        continue;
      }

      const chunk = buf.subarray(dataStart, dataStart + compSize);
      let data: Buffer;
      try {
        if (method === 0) {
          data = Buffer.from(chunk);
        } else if (method === 8) {
          data = zlib.inflateRawSync(chunk, { maxOutputLength: o.maxEntryBytes });
        } else {
          skipped.push(`${name}（压缩方式 ${method} 不支持）`);
          continue;
        }
      } catch {
        skipped.push(`${name}（解压失败，数据可能已损坏）`);
        continue;
      }

      totalBytes += data.length;
      if (totalBytes > o.maxTotalBytes) {
        throw new ApiError(400, `解压后内容超过 ${Math.round(o.maxTotalBytes / 1024 / 1024)}MB，已中止`, 'zip_too_large');
      }

      entries.push({ name: safe, data });
    }
  }

  if (entries.length === 0) {
    throw new ApiError(
      400,
      skipped.length ? `这个 zip 里没有能用的文件：${skipped.slice(0, 3).join('、')}` : '这个 zip 是空的',
      'zip_empty',
    );
  }

  return { entries, skipped };
}

/**
 * 文件名编码。
 * 通用标志位第 11 位（0x800）表示「名字是 UTF-8」；没设这个位的包通常来自
 * Windows 上的老工具，名字是 GBK。先按 UTF-8 解，如果出现替换字符就改试 GBK——
 * 中文文件名全是问号的话用户根本对不上号是哪个文件。
 */
function decodeName(raw: Buffer, flags: number): string {
  if ((flags & 0x800) !== 0) return raw.toString('utf8');
  const utf8 = raw.toString('utf8');
  if (!utf8.includes('\ufffd')) return utf8;
  try {
    return new TextDecoder('gbk').decode(raw);
  } catch {
    // 这个 Node 没编译 GBK 支持，退回 UTF-8，至少不会崩
    return utf8;
  }
}

/**
 * 把包内路径清洗成安全相对路径；不安全则返回 null。
 * 这一步是 Zip Slip 的唯一防线，宁可错杀也不放过。
 */
export function safeName(raw: string): string | null {
  const n = raw.replace(/\\/g, '/');
  if (!n) return null;
  // 绝对路径 / 盘符 / UNC
  if (n.startsWith('/') || /^[a-zA-Z]:/.test(n) || n.startsWith('//')) return null;
  if (n.includes('\0')) return null;

  const parts = n.split('/').filter((s) => s.length > 0 && s !== '.');
  if (parts.length === 0) return null;
  if (parts.some((s) => s === '..')) return null;

  const cleaned = parts.map((s) => s.replace(/[\u0000-\u001f]/g, '').trim());
  if (cleaned.some((s) => s.length === 0)) return null;
  // Windows 保留设备名
  if (cleaned.some((s) => /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i.test(s))) return null;

  return cleaned.join('/');
}

/** macOS 打的包会塞一堆没用的东西，直接过滤掉，别污染笔记库。 */
export function isJunkEntry(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower.startsWith('__macosx/')) return true;
  if (lower === '.ds_store' || lower.endsWith('/.ds_store')) return true;
  if (lower === 'thumbs.db' || lower.endsWith('/thumbs.db')) return true;
  const last = name.split('/').pop() ?? '';
  return last.startsWith('._');
}
