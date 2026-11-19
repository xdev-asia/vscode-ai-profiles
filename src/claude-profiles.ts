import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, extname, isAbsolute, join } from 'node:path';

export interface ClaudeProfile {
  name: string;
  configDir: string;
}

const manifestName = '.xdev-profile.json';
const profileId = /^[a-f0-9-]{36}$/;

export function validClaudeProfileName(name: unknown): name is string {
  return typeof name === 'string' && name.trim().length > 0 && name.length <= 80 &&
    !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name);
}

export class ClaudeProfiles {
  constructor(private readonly root: string) {}

  async list(): Promise<ClaudeProfile[]> {
    const entries = await readdir(this.root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const profiles = await Promise.all(entries
      .filter(entry => entry.isDirectory() && profileId.test(entry.name))
      .map(async entry => {
        const configDir = join(this.root, entry.name);
        try {
          const metadata = JSON.parse(await readFile(join(configDir, manifestName), 'utf8')) as { name?: unknown } | null;
          const name = metadata?.name;
          return validClaudeProfileName(name) ? { name, configDir } : undefined;
        } catch (error) {
          if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
          throw error;
        }
      }));
    return profiles.filter(profile => profile !== undefined).sort((a, b) => a.name.localeCompare(b.name, 'vi'));
  }

  async add(name: string): Promise<ClaudeProfile> {
    name = name.trim();
    if (!validClaudeProfileName(name)) {
      throw new Error('Tên hồ sơ cần có từ 1 đến 80 ký tự và chỉ nằm trên một dòng.');
    }
    const configDir = join(this.root, randomUUID());
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await mkdir(configDir, { mode: 0o700 });
    await writeFile(join(configDir, manifestName), JSON.stringify({ name }), { mode: 0o600, flag: 'wx' });
    return { name, configDir };
  }
}

export async function findClaudeExecutable(preferred: string): Promise<string | undefined> {
  const windows = process.platform === 'win32';
  const binary = windows ? 'claude.exe' : 'claude';
  const candidates = preferred
    ? [preferred]
    : [join(homedir(), '.local', 'bin', binary), ...(process.env.PATH ?? '').split(delimiter)
      .map(folder => folder.replace(/^"(.*)"$/, '$1'))
      .filter(isAbsolute)
      .map(folder => join(folder, binary))];
  for (const candidate of new Set(candidates)) {
    if (!isAbsolute(candidate) || (windows && extname(candidate).toLowerCase() !== '.exe')) continue;
    try {
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, constants.X_OK);
      return candidate;
    } catch (error) {
      if (!['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  }
  return undefined;
}

export function claudeTerminalEnv(configDir: string): Record<string, string | null> {
  return {
    CLAUDE_CONFIG_DIR: configDir,
    ANTHROPIC_API_KEY: null,
    ANTHROPIC_AUTH_TOKEN: null,
    ANTHROPIC_BASE_URL: null,
    ANTHROPIC_PROFILE: null,
    ANTHROPIC_FEDERATION_RULE_ID: null,
    ANTHROPIC_ORGANIZATION_ID: null,
    CLAUDE_CODE_OAUTH_TOKEN: null,
    CLAUDE_CODE_OAUTH_REFRESH_TOKEN: null,
    CLAUDE_CODE_OAUTH_SCOPES: null,
    CLAUDE_CODE_USE_BEDROCK: null,
    CLAUDE_CODE_USE_VERTEX: null,
    CLAUDE_CODE_USE_FOUNDRY: null
  };
}
