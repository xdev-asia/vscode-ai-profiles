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

export type Git = (args: readonly string[], cwd: string) => Promise<string>;

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

  async remove(worktree: Pick<RunWorktree, 'repo' | 'path' | 'branch'>): Promise<void> {
    await this.run(['worktree', 'remove', '--force', worktree.path], worktree.repo).catch(() => undefined);
    await this.run(['worktree', 'prune'], worktree.repo).catch(() => undefined);
    await this.run(['branch', '-D', worktree.branch], worktree.repo).catch(() => undefined);
  }
}
