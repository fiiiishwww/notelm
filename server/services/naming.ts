/**
 * server/services/naming.ts —— 把文章标题变成能落盘的文件名。
 *
 * ★ 为什么要单独一个文件 ★
 *   它同时被 routes/import.ts 和 routes/doc.ts 用到。放在任一个 route 里，
 *   另一个就得反向 import 它 —— 而 doc.ts 也需要 import.ts 里的东西时
 *   就成环了。route 之间互相 import 是脆弱的，抽出来最省事。
 */

/**
 * 飞书标题里什么都可能有什么：斜杠、冒号、问号、表情、一整句话。
 * Windows 不允许 <>:"|?*，结尾的点/空格会被系统悄悄吃掉，
 * 保留设备名（con / nul / com1）会写到系统设备上去——都得处理掉。
 */
export function safeTitle(title: string): string {
  let s = (title ?? '')
    .replace(/[\\/]+/g, '、') // 路径分隔符变成顿号，避免莫名多出一层目录
    .replace(/[<>:"|?*\u0000-\u001f]/g, '')
    .replace(/^\.+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  if (!s) s = '飞书文档';
  if (/^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i.test(s)) s = `${s}-文档`;
  // 文件系统一般限 255 字节，中文一个字 3 字节，取 80 字足够且不会截断得太难看
  if (s.length > 80) s = s.slice(0, 80).replace(/[. ]+$/, '');
  return s;
}
