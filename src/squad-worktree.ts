import { execFile } from 'node:child_process';
import { access, lstat, mkdir, symlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, sep } from 'node:path';

export interface RunWorktree {
  repo: string;
  path: string;
  branch: string;
  base: string;
  /** The branch the repository's checkout was on when the run started, if any. */
  source?: string;
  /** Paths linked from the main checkout; never staged or committed. */
  linked?: string[];
  /** Set when the configured base branch did not exist and the run started from the remote's default branch. */
  fallbackFrom?: string;
}

export type MergeRequestMode = 'auto' | 'gitlab' | 'push';

export interface RemoteInfo {
  name: string;
  /** The remote URL without any user name or password. */
  url: string;
  host: 'gitlab' | 'github' | 'other';
}

export interface PushResult {
  remote: string;
  target: string;
  /** The merge request or pull request link the remote printed, if any. */
  url?: string;
  mergeRequest: boolean;
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
/** Runs git and returns stdout and stderr together, for commands such as push that report on stderr. */
export type GitAll = (args: readonly string[], cwd: string) => Promise<string>;

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

export const gitAll: GitAll = (args, cwd) => new Promise((resolve, reject) => {
  execFile('git', [...args], { cwd, maxBuffer: 8_000_000, windowsHide: true, timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
    (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim().split('\n').filter(line => !/^remote:\s*$/.test(line)).slice(-3).join('\n') || error.message));
      else resolve(`${stdout}\n${stderr}`);
    });
});

/** Removes credentials from a remote URL so it can be shown. */
export function safeRemoteUrl(url: string): string {
  return url.trim().replace(/^([a-z][\w+.-]*:\/\/)[^@/]*@/i, '$1');
}

/** The merge request or pull request link in git push output, preferring an existing request over a "new" link. */
export function mergeRequestUrl(output: string): string | undefined {
  const links = [...output.matchAll(/https?:\/\/[^\s'"<>]+/g)].map(match => match[0].replace(/[.,;)]+$/, ''));
  const requests = links.filter(link => /\/(merge_requests|pull)(\/|$)|\/compare\//.test(link));
  return requests.find(link => /\/(merge_requests|pull)\/\d+/.test(link)) ?? requests[0];
}

/** Stages every change in a worktree except the folders linked from the main checkout. */
function stageAll(worktree: Pick<RunWorktree, 'linked'>): string[] {
  return ['add', '-A', '--', '.', ...(worktree.linked ?? []).map(path => `:(exclude)${path}`)];
}

/** A branch name safe to pass to git as a value. */
export function validBranch(name: unknown): name is string {
  return typeof name === 'string' && name.length <= 200 && /^[\w./-]+$/.test(name) && !name.startsWith('-') && !name.includes('..') && !name.endsWith('/') && !name.endsWith('.lock');
}

/**
 * Each approved Squad run works in its own git worktree on a new local branch, so headless workers
 * never touch the user's checkout. Nothing is pushed; merging stays with the user.
 */
export class Worktrees {
  constructor(private readonly root: string, private readonly run: Git = git, private readonly runAll: GitAll = gitAll) {}

  async repository(folder: string): Promise<string> {
    try {
      return (await this.run(['rev-parse', '--show-toplevel'], folder)).trim();
    } catch {
      throw new Error('Headless workers need a git repository. Open a folder that is a git repository.');
    }
  }

  /**
   * Creates the run's worktree from `start` (for example `origin/dev`, fetched first) or from HEAD.
   * A run across several repositories passes a label so each gets its own folder.
   */
  async create(folder: string, id: string, label?: string, start?: string): Promise<RunWorktree> {
    const repo = await this.repository(folder);
    let base: string;
    let source: string;
    let fallback: string | undefined;
    if (start) {
      if (!validBranch(start)) throw new Error(`"${start}" is not a valid base branch. Check xdevAi.squad.baseBranch.`);
      const remotes = (await this.run(['remote'], repo).catch(() => '')).split('\n').map(name => name.trim()).filter(Boolean);
      const remote = remotes.find(name => start.startsWith(`${name}/`));
      // Fetch so the run starts from the remote branch as it is now; work offline from the last fetch if this fails.
      if (remote) await this.runAll(['fetch', '-q', remote, start.slice(remote.length + 1)], repo).catch(() => undefined);
      let from = start;
      let found = (await this.run(['rev-parse', '--verify', `${start}^{commit}`], repo).catch(() => '')).trim();
      if (!found && remote) {
        // A workspace often mixes repositories whose main line differs (dev here, main there): fall back to the
        // remote's default branch instead of failing, and say so.
        const head = (await this.run(['symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`], repo).catch(() => '')).trim();
        found = head ? (await this.run(['rev-parse', '--verify', `${head}^{commit}`], repo).catch(() => '')).trim() : '';
        if (found) from = head;
      }
      if (!found) throw new Error(`The base branch ${start} does not exist in ${repo}. Check xdevAi.squad.baseBranch.`);
      base = found;
      source = remote ? from.slice(remote.length + 1) : from;
      if (from !== start) fallback = start;
    } else {
      base = (await this.run(['rev-parse', 'HEAD'], repo).catch(() => {
        throw new Error('The repository has no commits yet. Make a first commit before running workers.');
      })).trim();
      source = (await this.run(['rev-parse', '--abbrev-ref', 'HEAD'], repo).catch(() => '')).trim();
    }
    const name = id.slice(0, 8);
    const branch = `xdev/squad/${name}`;
    const path = label ? join(this.root, name, label.replace(/[^\w.-]+/g, '-').slice(0, 60)) : join(this.root, name);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await this.run(['worktree', 'add', '-b', branch, path, base], repo);
    return { repo, path, branch, base, ...(source && source !== 'HEAD' ? { source } : {}), ...(fallback ? { fallbackFrom: fallback } : {}) };
  }

  /**
   * Makes a fresh worktree usable for builds and tests: initializes submodules and links folders such as
   * node_modules from the main checkout, which a new checkout lacks. Returns notes for anything that failed.
   */
  async setup(worktree: RunWorktree, links: readonly string[]): Promise<{ notes: string[]; linked: string[] }> {
    const notes: string[] = [];
    const linked: string[] = [];
    const modules = await access(join(worktree.path, '.gitmodules')).then(() => true, () => false);
    if (modules) {
      await this.runAll(['submodule', 'update', '--init', '--recursive', '--quiet'], worktree.path)
        .catch((error: Error) => notes.push(`Submodules were not initialized: ${error.message}`));
    }
    for (const link of links) {
      const relative = normalize(link.trim()).replace(/[\\/]+$/, '');
      if (!relative || relative === '.' || isAbsolute(relative) || relative.split(sep).includes('..')) continue;
      const source = join(worktree.repo, relative);
      const target = join(worktree.path, relative);
      if (!(await access(source).then(() => true, () => false))) continue;
      if (await lstat(target).then(() => true, () => false)) continue;
      try {
        await mkdir(dirname(target), { recursive: true });
        await symlink(source, target, process.platform === 'win32' ? 'junction' : undefined);
        linked.push(relative.split(sep).join('/'));
      } catch (error) {
        notes.push(`Could not link ${relative}: ${error instanceof Error ? error.message : 'unknown error'}`);
      }
    }
    return { notes, linked };
  }

  /** The remote a run's branch is pushed to: origin, or the only remote. */
  async remote(worktree: Pick<RunWorktree, 'repo'>): Promise<RemoteInfo> {
    const names = (await this.run(['remote'], worktree.repo)).split('\n').map(name => name.trim()).filter(Boolean);
    const name = names.includes('origin') ? 'origin' : names[0];
    if (!name) throw new Error('This repository has no git remote to push to.');
    const url = safeRemoteUrl(await this.run(['remote', 'get-url', name], worktree.repo));
    return { name, url, host: /gitlab/i.test(url) ? 'gitlab' : /github\.com/i.test(url) ? 'github' : 'other' };
  }

  /** The branch a merge request should target by default: the remote's default branch, else the run's source branch. */
  async defaultTarget(worktree: RunWorktree, remote: string): Promise<string> {
    const head = (await this.run(['symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`], worktree.repo).catch(() => '')).trim();
    const fromRemote = head.startsWith(`${remote}/`) ? head.slice(remote.length + 1) : '';
    return fromRemote || worktree.source || 'main';
  }

  /** Whether the remote branch is known locally (after a fetch). */
  async hasRemoteBranch(repo: string, remote: string, branch: string): Promise<boolean> {
    if (!validBranch(branch)) return false;
    return this.run(['rev-parse', '--verify', '-q', `refs/remotes/${remote}/${branch}`], repo).then(() => true, () => false);
  }

  /** Commits on the run's branch that the remote target branch does not have yet, when the remote branch is known locally. */
  async ahead(worktree: RunWorktree, remote: string, target: string): Promise<number | undefined> {
    const count = await this.run(['rev-list', '--count', `refs/remotes/${remote}/${target}..${worktree.branch}`], worktree.repo).catch(() => '');
    return count.trim() ? Number(count.trim()) : undefined;
  }

  /**
   * Pushes the run's branch. On GitLab, push options ask the server to open (or update) a merge request into
   * `target`, so no API token is needed; other hosts print a link to open a pull request.
   */
  async push(worktree: RunWorktree, options: { target: string; title: string; mode: MergeRequestMode }): Promise<PushResult> {
    if (!validBranch(options.target)) throw new Error('Enter a valid target branch.');
    const remote = await this.remote(worktree);
    const mergeRequest = options.mode === 'gitlab' || (options.mode === 'auto' && remote.host === 'gitlab');
    const title = options.title.replace(/\s+/g, ' ').trim().slice(0, 120) || 'xDev Squad changes';
    const pushOptions = mergeRequest ? [
      '-o', 'merge_request.create', '-o', `merge_request.target=${options.target}`, '-o', `merge_request.title=${title}`,
      '-o', 'merge_request.remove_source_branch'
    ] : [];
    const output = await this.runAll(['push', '-u', ...pushOptions, remote.name, `${worktree.branch}:refs/heads/${worktree.branch}`], worktree.path);
    return { remote: remote.name, target: options.target, url: mergeRequestUrl(output), mergeRequest };
  }

  /** Fetches one branch from the remote. False when the remote has no such branch. */
  async fetchBranch(repo: string, remote: string, branch: string): Promise<boolean> {
    if (!validBranch(branch)) return false;
    return this.runAll(['fetch', '-q', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`], repo).then(() => true, () => false);
  }

  /** Whether a commit is on the fetched remote branch (merged with a merge commit or fast-forward; not after a squash). */
  async contains(repo: string, remote: string, branch: string, commit: string): Promise<boolean> {
    return this.run(['merge-base', '--is-ancestor', commit, `refs/remotes/${remote}/${branch}`], repo).then(() => true, () => false);
  }

  /** Commits on remote/from that remote/to does not have: what a deploy would bring. */
  async behind(repo: string, remote: string, from: string, to: string): Promise<number | undefined> {
    const count = await this.run(['rev-list', '--count', `refs/remotes/${remote}/${to}..refs/remotes/${remote}/${from}`], repo).catch(() => '');
    return count.trim() ? Number(count.trim()) : undefined;
  }

  /**
   * Asks for a deploy: pushes the fetched remote/from to a new branch and, on GitLab, opens a merge request from it
   * into `to` with push options. Nothing is merged; merging the request starts the deploy pipeline.
   */
  async deploy(repo: string, options: { from: string; to: string; branch: string; title: string; mode: MergeRequestMode }): Promise<PushResult> {
    if (![options.from, options.to, options.branch].every(validBranch)) throw new Error('Enter valid branch names for the deploy.');
    const remote = await this.remote({ repo });
    const mergeRequest = options.mode === 'gitlab' || (options.mode === 'auto' && remote.host === 'gitlab');
    if (!mergeRequest) throw new Error('Deploy merge requests need a GitLab remote (xdevAi.squad.mergeRequests).');
    const title = options.title.replace(/\s+/g, ' ').trim().slice(0, 120) || `Deploy ${options.from} to ${options.to}`;
    const output = await this.runAll(['push', '-o', 'merge_request.create', '-o', `merge_request.target=${options.to}`, '-o', `merge_request.title=${title}`,
      '-o', 'merge_request.remove_source_branch', remote.name, `refs/remotes/${remote.name}/${options.from}:refs/heads/${options.branch}`], repo);
    return { remote: remote.name, target: options.to, url: mergeRequestUrl(output), mergeRequest };
  }

  /** Commits whatever the workers left in the worktree to its branch, locally. */
  async commit(worktree: RunWorktree, message: string): Promise<WorktreeChanges> {
    await this.run(stageAll(worktree), worktree.path);
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
    await this.run(stageAll(worktree), worktree.path);
    return parseDiff(await this.run(['diff', '--cached', '--no-renames', '--no-color', worktree.base], worktree.path));
  }

  async changedFiles(worktree: RunWorktree): Promise<string[]> {
    await this.run(stageAll(worktree), worktree.path);
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
