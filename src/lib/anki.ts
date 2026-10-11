/**
 * src/lib/anki.ts —— 把闪卡导出成 Anki 能直接导入的纯文本。
 *
 * ★ 为什么是「前端生成文件」而不是后端下载接口 ★
 *   所有 /api 请求都要带 `X-Local-Token` 自定义头，而浏览器对 `<a href>` 的
 *   导航请求**没有任何办法**附加自定义头（也改不了 Referer/Origin）。
 *   所以下载只能走「前端带 token 取数据 → 内存里拼文件 → Blob → a.download」这条路。
 *   以后要加别的导出格式，也照这个套路来。
 *
 * ★ 为什么只导两列 ★
 *   Anki 的「基本」笔记类型就是正面 / 背面两栏。导两列，用户在导入对话框里
 *   不用做任何字段映射，勾上「允许 HTML」就能用。多导一列（比如来源章节）
 *   反而会逼他去改笔记类型，对大多数人来说是负担。
 */

import { localDate } from '../../shared/text';

export interface ExportCard {
  front: string;
  back: string;
  /** 全库导出时带上来源文章，方便在 Anki 里区分 */
  docPath?: string;
}

export interface AnkiExport {
  text: string;
  /** 真正写进文件的卡数（空卡会被跳过） */
  count: number;
  /** 需要告诉用户的事：跳过了几张、有几张可能被 Anki 当注释吞掉 */
  warnings: string[];
}

/** Windows 文件名非法字符。 */
const ILLEGAL = /[\\/:*?"<>|]/g;

/**
 * 生成 Anki 文本。
 *
 * 逐字段清洗规则：
 *   - 真换行 → `<br>`。Anki 的纯文本导入按**行**切卡，字段里出现换行
 *     会把它劈成两张卡，这是最坑的一处。
 *   - Tab → 空格。Tab 是字段分隔符。
 *   - 首尾空白去掉。
 */
export function buildAnkiText(cards: ExportCard[]): AnkiExport {
  const rows: string[] = [];
  const warnings: string[] = [];
  let skipped = 0;
  let hashLead = 0;

  for (const c of cards) {
    const front = cleanField(c.front);
    const back = cleanField(c.back);
    if (!front || !back) {
      skipped++;
      continue;
    }
    // Anki 把以 # 开头的行当注释静默跳过。这种卡用户会以为导丢了。
    if (front.startsWith('#')) hashLead++;
    rows.push(`${front}\t${back}`);
  }

  if (skipped) warnings.push(`跳过了 ${skipped} 张正面或背面为空的卡`);
  if (hashLead) {
    warnings.push(`有 ${hashLead} 张卡的正面以 # 开头，Anki 会把它当注释跳过，建议改一下开头`);
  }

  return { text: rows.join('\n'), count: rows.length, warnings };
}

function cleanField(s: string): string {
  return (s ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n+/g, '<br>')
    .replace(/\t/g, ' ')
    .trim();
}

/** 文件名：`anki-<范围>-<日期>.txt`。 */
export function ankiFileName(scope: string): string {
  return `anki-${scope.replace(ILLEGAL, '_').slice(0, 40)}-${localDate()}.txt`;
}

/** 触发浏览器下载。用完延后回收 URL，立刻 revoke 有些浏览器会下载到空文件。 */
export function downloadText(filename: string, text: string): void {
  // BOM 不能少：Anki 在 Windows 上按本地编码猜，没 BOM 会显示成乱码
  const blob = new Blob([`\uFEFF${text}`], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 1500);
}
