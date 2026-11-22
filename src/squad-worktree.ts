import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface RunWorktree {
  repo: string;
  path: string;
  branch: string;
  base: string;
}

export interface WorktreeChanges {
  commit?: string;
  stat: string;
  files: number;
}

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  added: number;
  removed: number;
  binary: boolean;
  patch: string;
}

export interface LeftoverWorktree {
  repo: string;
  path: string;
  branch: string;
  merged: boolean;
  /** Last commit time on the branch, in milliseconds. */
  changed: number;
}

export type Git = (args: readonly string[], cwd: string) => Promise<string>;

const patchLimit = 12_000;
const changeLimit = 60;

/** Splits a unified diff into one entry per file. */
export function parseDiff(diff: string): FileChange[] {
  const files: FileChange[] = [];
  for (const chunk of diff.split(/^(?=diff --git )/m)) {
    if (!chunk.startsWith('diff --git ')) continue;
    const lines = chunk.split('\n');
    const target = lines.find(line => line.startsWith('+++ b/'))?.slice(6)
      ?? lines.find(line => line.startsWith('rename to '))?.slice(10)
      ?? lines.find(line => line.startsWith('--- a/'))?.slice(6)
      ?? /^diff --git a\/.+ b\/(.+)$/.exec(lines[0])?.[1] ?? '';
    const status = lines.some(line => line.startsWith('new file mode')) ? 'added'
      : lines.some(line => line.startsWith('deleted file mode')) ? 'deleted'
        : lines.some(line => line.startsWith('rename from')) ? 'renamed' : 'modified';
    let added = 0;
    let removed = 0;
    const start = lines.findIndex(line => line.startsWith('@@'));
    for (const line of start < 0 ? [] : lines.slice(start)) {
      if (line.startsWith('+')) added++;
      else if (line.startsWith('-')) removed++;
    }
    const body = start < 0 ? '' : lines.slice(start).join('\n').trimEnd();
    files.push({
      path: target, status, added, removed, binary: lines.some(line => /^Binary files /.test(line)),
      patch: body.length <= patchLimit ? body : `${body.slice(0, patchLimit)}\n[Truncated]`
    });
    if (files.length >= changeLimit) break;
  }
  return files;
}

export const git: Git = (args, cwd) => new Promise((resolve, reject) => {
  execFile('git', [...args], { cwd, maxBuffer: 8_000_000, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
    (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim().split('\n').at(-1) || error.message));
      else resolve(stdout);
    });
});

/**
 * Each approved Squad run works in its own git worktree on a new local branch, so headless workers
 * never touch the user's checkout. Nothing is pushed; merging stays with the user.
 */
export class Worktrees {
  constructor(private readonly root: string, private readonly run: Git = git) {}

  async repository(folder: string): Promise<string> {
    try {
      return (await this.run(['rev-parse', '--show-toplevel'], folder)).trim();
    } catch {
      throw new Error('Headless workers need a git repository. Open a folder that is a git repository.');
    }
  }

  async create(folder: string, id: string): Promise<RunWorktree> {
    const repo = await this.repository(folder);
    const base = (await this.run(['rev-parse', 'HEAD'], repo).catch(() => {
      throw new Error('The repository has no commits yet. Make a first commit before running workers.');
    })).trim();
    const name = id.slice(0, 8);
    const branch = `xdev/squad/${name}`;
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const path = join(this.root, name);
    await this.run(['worktree', 'add', '-b', branch, path, base], repo);
    return { repo, path, branch, base };
  }

  /** Commits whatever the workers left in the worktree to its branch, locally. */
  async commit(worktree: RunWorktree, message: string): Promise<WorktreeChanges> {
    await this.run(['add', '-A'], worktree.path);
    const staged = (await this.run(['diff', '--cached', '--name-only'], worktree.path)).split('\n').filter(Boolean);
    if (staged.length) {
      const email = (await this.run(['config', 'user.email'], worktree.path).catch(() => '')).trim();
      const identity = email ? [] : ['-c', 'user.name=xDev Squad', '-c', 'user.email=squad@xdev.invalid'];
      await this.run([...identity, 'commit', '--no-verify', '-q', '-m', message.slice(0, 200)], worktree.path);
    }
    const stat = (await this.run(['diff', '--stat', worktree.base, 'HEAD'], worktree.path)).trim();
    const files = (await this.run(['diff', '--name-only', worktree.base, 'HEAD'], worktree.path)).split('\n').filter(Boolean).length;
    const head = (await this.run(['rev-parse', 'HEAD'], worktree.path)).trim();
    return { commit: head === worktree.base ? undefined : head, stat: stat.slice(-4_000), files };
  }

  /** Stages everything so new files show up, then lists the run's changes against its base commit. */
  async changes(worktree: RunWorktree): Promise<FileChange[]> {
    await this.run(['add', '-A'], worktree.path);
    return parseDiff(await this.run(['diff', '--cached', '--no-renames', '--no-color', worktree.base], worktree.path));
  }

  async changedFiles(worktree: RunWorktree): Promise<string[]> {
    await this.run(['add', '-A'], worktree.path);
    return (await this.run(['diff', '--cached', '--no-renames', '--name-only', worktree.base], worktree.path)).split('\n').filter(Boolean).slice(0, 200);
  }

  /** Restores one file to the base commit, or deletes it when the run added it. */
  async discard(worktree: RunWorktree, file: string): Promise<void> {
    const changed = await this.changedFiles(worktree);
    if (!changed.includes(file)) throw new Error('That file has no changes in this run.');
    const existed = await this.run(['cat-file', '-e', `${worktree.base}:${file}`], worktree.path).then(() => true, () => false);
    if (existed) await this.run(['checkout', worktree.base, '--', file], worktree.path);
    else await this.run(['rm', '-f', '-q', '--', file], worktree.path);
  }

  /**
   * Squad worktrees of a repository that no run in this window knows about, for example from another
   * window or a cleared workspace state. Each entry says whether its branch is merged into HEAD.
   */
  async leftovers(repo: string, known: ReadonlySet<string>): Promise<LeftoverWorktree[]> {
    const listing = await this.run(['worktree', 'list', '--porcelain'], repo).catch(() => '');
    const found: LeftoverWorktree[] = [];
    for (const block of listing.split(/\n\n+/)) {
      const path = /^worktree (.+)$/m.exec(block)?.[1];
      const branch = /^branch refs\/heads\/(xdev\/squad\/[\w-]+)$/m.exec(block)?.[1];
      if (!path || !branch || known.has(path)) continue;
      const merged = await this.run(['merge-base', '--is-ancestor', branch, 'HEAD'], repo).then(() => true, () => false);
      const changed = Number((await this.run(['log', '-1', '--format=%ct', branch], repo).catch(() => '0')).trim()) * 1000;
      found.push({ repo, path, branch, merged, changed });
    }
    return found;
  }

  /** Removes a leftover worktree. Its branch is deleted only when merged; otherwise it is kept and reported. */
  async clean(worktree: LeftoverWorktree): Promise<{ branchKept: boolean }> {
    await this.run(['worktree', 'remove', '--force', worktree.path], worktree.repo).catch(() => undefined);
    await this.run(['worktree', 'prune'], worktree.repo).catch(() => undefined);
    const deleted = await this.run(['branch', '-d', worktree.branch], worktree.repo).then(() => true, () => false);
    return { branchKept: !deleted };
  }

  async remove(worktree: Pick<RunWorktree, 'repo' | 'path' | 'branch'>): Promise<void> {
    await this.run(['worktree', 'remove', '--force', worktree.path], worktree.repo).catch(() => undefined);
    await this.run(['worktree', 'prune'], worktree.repo).catch(() => undefined);
    await this.run(['branch', '-D', worktree.branch], worktree.repo).catch(() => undefined);
  }
}
