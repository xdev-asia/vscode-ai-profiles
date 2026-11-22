import { lstat, readdir, rm, statfs } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface FolderSize {
  bytes: number;
  /** True when the walk stopped at its time limit, so `bytes` is a lower bound. */
  partial: boolean;
}

/**
 * Bytes used by the files under `path`. Symbolic links are counted as links and never followed, so a
 * worktree's linked node_modules does not count twice. Stops at `deadline` (ms since epoch).
 */
export async function folderSize(path: string, deadline = Date.now() + 10_000): Promise<FolderSize> {
  let bytes = 0;
  let partial = false;
  const pending = [path];
  while (pending.length) {
    if (Date.now() > deadline) {
      partial = true;
      break;
    }
    const current = pending.pop()!;
    let info;
    try {
      info = await lstat(current);
    } catch {
      continue;
    }
    bytes += info.size;
    if (!info.isDirectory()) continue;
    const names = await readdir(current).catch(() => [] as string[]);
    for (const name of names) pending.push(join(current, name));
  }
  return { bytes, partial };
}

/** Free bytes for unprivileged users on the disk that holds `path` (or its nearest existing parent). */
export async function freeBytes(path: string): Promise<number | undefined> {
  let current = path;
  for (let depth = 0; depth < 40; depth++) {
    try {
      const info = await statfs(current);
      return info.bavail * info.bsize;
    } catch {
      const parent = dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
  }
  return undefined;
}

/** The folder where Claude Code keeps transcripts for sessions started in `cwd`: every non-alphanumeric becomes "-". */
export function sessionFolder(configDir: string, cwd: string): string {
  return join(configDir, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
}

/** Transcript folders in one Claude Code account that belong to worktrees under `root`. */
export async function sessionFolders(configDir: string, root: string): Promise<string[]> {
  const prefix = root.replace(/[^A-Za-z0-9]/g, '-') + '-';
  const names = await readdir(join(configDir, 'projects')).catch(() => [] as string[]);
  return names.filter(name => name.startsWith(prefix)).map(name => join(configDir, 'projects', name));
}

/** Deletes folders, ignoring ones already gone. */
export async function removeFolders(paths: readonly string[]): Promise<void> {
  await Promise.all(paths.map(path => rm(path, { recursive: true, force: true }).catch(() => undefined)));
}

export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
