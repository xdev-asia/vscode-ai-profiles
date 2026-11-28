import { readFileSync } from 'node:fs';
import { isAbsolute, join, normalize, sep } from 'node:path';

/**
 * Variables a project's .env may not set for workers: they would change the worker's own account, model, or
 * runtime instead of configuring the project's commands.
 */
const blocked = /^(ANTHROPIC_|CLAUDE_|CLAUDECODE$|OPENAI_|PATH$|HOME$|USER$|SHELL$|NODE_OPTIONS$|LD_|DYLD_)/;
const namePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const fileLimit = 10;
const valueLimit = 32_000;

export interface EnvFile {
  repo: string;
  /** Path relative to the repository, as configured. */
  file: string;
  /** Absolute path in the main checkout. */
  path: string;
  names: string[];
  /** Names left out because they would change the worker itself. */
  skipped: string[];
  problem?: string;
}

/** Reads KEY=value lines: `export` prefixes, comments, and single or double quotes (with \n in double quotes). */
export function parseDotenv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2];
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.indexOf(quote, 1) > 0) {
      value = value.slice(1, value.indexOf(quote, 1));
      if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\"/g, '"');
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    values[match[1]] = value.slice(0, valueLimit);
  }
  return values;
}

/** A configured file must stay inside its repository: relative, without "..". */
export function validEnvFile(file: unknown): file is string {
  if (typeof file !== 'string' || !file.trim() || isAbsolute(file) || file.length > 200) return false;
  return !normalize(file).split(/[\\/]/).includes('..');
}

/** Reads `xdevAi.squad.workerEnvFiles` ({ repo: [files] }) into entries, keyed by repository path or folder name. */
export function envFilesFor(setting: unknown, folder: string, repo: string | undefined): EnvFile[] {
  if (!setting || typeof setting !== 'object' || Array.isArray(setting) || !repo) return [];
  const map = setting as Record<string, unknown>;
  const key = Object.hasOwn(map, repo) ? repo : Object.hasOwn(map, repo.split('/').at(-1)!) ? repo.split('/').at(-1)! : undefined;
  const files = key && Array.isArray(map[key]) ? (map[key] as unknown[]).filter(validEnvFile).slice(0, fileLimit) : [];
  const root = repo === '.' ? folder : join(folder, repo);
  return files.map(file => {
    const path = join(root, file);
    try {
      const values = parseDotenv(readFileSync(path, 'utf8'));
      const names = Object.keys(values);
      return { repo, file, path, names: names.filter(name => !blocked.test(name)), skipped: names.filter(name => blocked.test(name)) };
    } catch {
      return { repo, file, path, names: [], skipped: [], problem: 'File not found in your checkout.' };
    }
  });
}

/** Every repository in the setting with its files, for the Project tab. */
export function allEnvFiles(setting: unknown, folder: string): EnvFile[] {
  if (!setting || typeof setting !== 'object' || Array.isArray(setting)) return [];
  return Object.keys(setting).slice(0, 40).flatMap(repo => envFilesFor(setting, folder, repo.replace(/\/+$/, '')));
}

/** The variables to set for a worker, read fresh from the files; later files win. */
export function loadEnv(files: readonly EnvFile[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const file of files) {
    if (file.problem) continue;
    try {
      const values = parseDotenv(readFileSync(file.path, 'utf8'));
      for (const [name, value] of Object.entries(values)) if (namePattern.test(name) && !blocked.test(name)) env[name] = value;
    } catch {
      // The file disappeared since it was listed; run without it.
    }
  }
  return env;
}

/**
 * An absolute path as a Claude Code permission rule names it: "//" starts at the filesystem root, and on
 * Windows the drive is a lower-case folder, so C:\Users\a is //c/Users/a. A rule written "//C:/Users/a"
 * matches nothing there.
 */
export function rulePath(path: string, platform: NodeJS.Platform = process.platform): string {
  const posix = platform === 'win32'
    ? path.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`)
    : path;
  return `/${posix.replace(/^\/*/, '/')}`;
}

/** Claude Code permission rules that deny reading these files. */
export function envDenyRules(paths: readonly string[], platform: NodeJS.Platform = process.platform): string[] {
  return paths.map(path => `Read(${rulePath(path, platform)})`);
}
