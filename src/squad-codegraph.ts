import { execFile } from 'node:child_process';
import { access, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

export const codeContextLimit = 6_000;
const exploreTimeoutMs = 20_000;

type Exec = (file: string, args: readonly string[], options: { cwd: string; timeoutMs: number; signal?: AbortSignal }) => Promise<string>;

const exec: Exec = (file, args, { cwd, timeoutMs, signal }) => new Promise((resolve, reject) => {
  execFile(file, [...args], {
    cwd, timeout: timeoutMs, killSignal: 'SIGTERM', maxBuffer: 4_000_000, windowsHide: true, signal,
    env: { ...process.env, NO_COLOR: '1' }
  }, (error, stdout) => error ? reject(error) : resolve(stdout));
});

/** True when the folder holds a CodeGraph index. */
export async function hasCodegraph(folder: string): Promise<boolean> {
  return access(join(folder, '.codegraph')).then(() => true, () => false);
}

/** Keeps the query to plain words so it cannot be read as options. */
export function exploreQuery(request: string): string {
  return request.replace(/[^\p{L}\p{N}_./ -]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
}

/**
 * Asks CodeGraph for the symbols and call paths relevant to a request. Returns undefined when the index
 * is missing, busy, or slow, so planning never waits on it for long.
 */
export async function exploreCode(
  folder: string, request: string, options: { signal?: AbortSignal; timeoutMs?: number; executable?: string; run?: Exec } = {}
): Promise<string | undefined> {
  const query = exploreQuery(request);
  if (!query || !(await hasCodegraph(folder))) return undefined;
  try {
    const output = await (options.run ?? exec)(options.executable ?? 'codegraph', ['explore', '--max-files', '6', '-p', folder, '--', query], {
      cwd: folder, timeoutMs: options.timeoutMs ?? exploreTimeoutMs, signal: options.signal
    });
    // eslint-disable-next-line no-control-regex
    const text = output.replace(/\u001b\[[0-9;]*m/g, '').trim();
    if (!text) return undefined;
    return text.length <= codeContextLimit ? text : `${text.slice(0, codeContextLimit)}\n[Truncated]`;
  } catch {
    options.signal?.throwIfAborted();
    return undefined;
  }
}

const skipped = new Set(['node_modules', 'bin', 'obj', 'dist', 'build', 'out', 'target', 'vendor', 'packages']);

/**
 * Git repositories a run can target: the folder itself when it is a repository, otherwise repositories
 * nested up to `depth` levels below it, as paths relative to the folder.
 */
export async function findRepositories(folder: string, isRepository: (path: string) => Promise<boolean>, depth = 4, limit = 100): Promise<string[]> {
  if (await isRepository(folder)) return ['.'];
  const found: string[] = [];
  const walk = async (path: string, level: number): Promise<void> => {
    if (found.length >= limit || level > depth) return;
    const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
    if (entries.some(entry => entry.name === '.git')) found.push(relative(folder, path).split(sep).join('/'));
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || skipped.has(entry.name)) continue;
      await walk(join(path, entry.name), level + 1);
    }
  };
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.name.startsWith('.') && !skipped.has(entry.name)) await walk(join(folder, entry.name), 1);
  }
  return found.sort();
}

/** Picks the repository a plan most likely targets from the paths its text mentions. */
export function suggestRepository(repositories: readonly string[], texts: readonly string[]): string | undefined {
  if (repositories.length === 1) return repositories[0];
  const text = texts.join('\n').replace(/\\/g, '/');
  let best: { repo: string; score: number } | undefined;
  for (const repo of repositories) {
    if (repo === '.') continue;
    const name = repo.split('/').at(-1)!;
    const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const score = (text.match(new RegExp(`(^|[^\\w-])${escaped(repo)}(?![\\w-])`, 'g'))?.length ?? 0) * 3
      + (text.match(new RegExp(`(^|[^\\w-])${escaped(name)}(?![\\w-])`, 'g'))?.length ?? 0);
    if (score > 0 && (!best || score > best.score || (score === best.score && repo.length > best.repo.length))) best = { repo, score };
  }
  return best?.repo;
}
