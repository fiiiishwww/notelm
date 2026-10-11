/**
 * server/services/backup.ts —— 笔记库自动备份（2026-09-23，随 run_code 上线一起加）。
 *
 * ★ 为什么有这个 ★
 *   业界共识（Anthropic/Docker 沙箱文档同款结论）：沙箱防概率事件，
 *   「恢复不了就不叫备份」——可恢复性才是灾难兜底。小笔拿到代码执行能力后，
 *   这层从「值得做」升级为「必须有」。
 *
 * 做法（零依赖）：
 *   - 用 Windows 自带 bsdtar（C:\Windows\System32\tar.exe）打 tar.gz——
 *     UTF-8 存中文文件名不乱码（Compress-Archive 在 PS5.1 下中文条目名会烂，不用它）。
 *   - 目标目录 PROJECT_ROOT/.backups/（库外、agent 写不到的地方）。
 *   - 触发：服务启动时检查，距上次备份超过 24h 就打一份；之后每 6h 自查一次。
 *   - 保留最近 7 份，旧的自动清。
 */

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PROJECT_ROOT } from '../core';

const BACKUP_DIR = path.join(PROJECT_ROOT, '.backups');
const INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h 打一份
const KEEP = 7;

const markerFile = path.join(BACKUP_DIR, 'last-backup.txt');

async function lastBackupAgeMs(): Promise<number> {
  try {
    const t = Number((await fs.readFile(markerFile, 'utf8')).trim());
    return Number.isFinite(t) ? Date.now() - t : Infinity;
  } catch {
    return Infinity;
  }
}

function runTar(dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // ★ 必须显式用 System32 的 bsdtar：裸 'tar' 会命中 Git 自带的 GNU tar，
    //   它把 `c:\...` 的盘符冒号当「远程主机:路径」语法 → "Cannot connect to c:"
    //   （实测 2026-09-24，备份一直在静默失败）。System32 tar 对盘符路径无此问题。
    const tarBin = process.platform === 'win32' && fsSync.existsSync('C:\\Windows\\System32\\tar.exe')
      ? 'C:\\Windows\\System32\\tar.exe'
      : 'tar';
    const child = spawn(tarBin, ['-czf', dest, '-C', PROJECT_ROOT, 'notes'], {
      windowsHide: true,
    });
    let stderr = '';
    child.stderr?.on('data', (d) => (stderr += String(d)));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`tar 退出码 ${code}: ${stderr.slice(0, 300)}`))));
    setTimeout(() => {
      child.kill();
      reject(new Error('tar 备份超时（120s）'));
    }, 120_000).unref();
  });
}

async function pruneOld(): Promise<void> {
  const files = (await fs.readdir(BACKUP_DIR)).filter((f) => f.startsWith('notelm-') && f.endsWith('.tar.gz')).sort();
  for (const f of files.slice(0, Math.max(0, files.length - KEEP))) {
    await fs.rm(path.join(BACKUP_DIR, f), { force: true }).catch(() => {});
  }
}

/** 打一份备份（失败只打日志，绝不影响主服务）。 */
export async function backupOnce(reason: string): Promise<string | null> {
  try {
    await fs.mkdir(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dest = path.join(BACKUP_DIR, `notelm-${stamp}.tar.gz`);
    await runTar(dest);
    await fs.writeFile(markerFile, String(Date.now()), 'utf8');
    await pruneOld();
    console.log(`  ▸ 笔记库已备份（${reason}）：${path.basename(dest)}`);
    return dest;
  } catch (e) {
    console.warn(`  ▸ 备份失败（不影响服务）：${e instanceof Error ? e.message : e}`);
    return null;
  }
}

/** 启动时调用：距上次备份超过 24h 就补一份。 */
export async function maybeBackupOnBoot(): Promise<void> {
  if ((await lastBackupAgeMs()) < INTERVAL_MS) return;
  await backupOnce('定时');
}

/** 启动备份循环：每 6h 自查一次是否该备份。 */
export function startBackupLoop(): void {
  void maybeBackupOnBoot();
  setInterval(() => void maybeBackupOnBoot(), 6 * 60 * 60 * 1000).unref();
}
