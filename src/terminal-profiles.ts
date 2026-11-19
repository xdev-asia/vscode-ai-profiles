import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, readFile, readdir, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, delimiter, extname, isAbsolute, join } from 'node:path';

export const terminalProviders = {
  claude: { name: 'Claude Code', bin: 'claude', setup: 'https://code.claude.com/docs/en/setup', usage: '/usage' },
  codex: { name: 'Codex', bin: 'codex', setup: 'https://developers.openai.com/codex/cli', usage: '/status' },
  gemini: { name: 'Gemini CLI', bin: 'gemini', setup: 'https://geminicli.com/docs/get-started/', usage: '/stats model' }
} as const;

export type TerminalProvider = keyof typeof terminalProviders;
export const terminalProviderIds = Object.keys(terminalProviders) as TerminalProvider[];

export interface TerminalProfile {
  provider: TerminalProvider;
  name: string;
  configDir: string;
}

export function terminalProfileId(profile: TerminalProfile): string {
  return `${profile.provider}:${basename(profile.configDir)}`;
}

const manifestName = '.xdev-profile.json';
const profileId = /^[a-f0-9-]{36}$/;

export function validTerminalProfileName(name: unknown): name is string {
  return typeof name === 'string' && name.trim().length > 0 && name.length <= 80 &&
    !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name);
}

export class TerminalProfiles {
  constructor(private readonly root: string) {}

  async list(provider?: TerminalProvider): Promise<TerminalProfile[]> {
    const results = await Promise.all((provider ? [provider] : terminalProviderIds).map(id => this.listProvider(id)));
    return results.flat();
  }

  private async listProvider(provider: TerminalProvider): Promise<TerminalProfile[]> {
    const root = join(this.root, provider);
    const entries = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const profiles = await Promise.all(entries
      .filter(entry => entry.isDirectory() && profileId.test(entry.name))
      .map(async entry => {
        const configDir = join(root, entry.name);
        try {
          const metadata = JSON.parse(await readFile(join(configDir, manifestName), 'utf8')) as { name?: unknown } | null;
          const name = metadata?.name;
          return validTerminalProfileName(name) ? { provider, name, configDir } : undefined;
        } catch (error) {
          if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
          throw error;
        }
      }));
    return profiles.filter(profile => profile !== undefined).sort((a, b) => a.name.localeCompare(b.name, 'vi'));
  }

  async add(provider: TerminalProvider, name: string): Promise<TerminalProfile> {
    name = name.trim();
    if (!validTerminalProfileName(name)) {
      throw new Error('Tên hồ sơ cần có từ 1 đến 80 ký tự và chỉ nằm trên một dòng.');
    }
    const root = join(this.root, provider);
    const configDir = join(root, randomUUID());
    await mkdir(root, { recursive: true, mode: 0o700 });
    await mkdir(configDir, { mode: 0o700 });
    await writeFile(join(configDir, manifestName), JSON.stringify({ name }), { mode: 0o600, flag: 'wx' });
    return { provider, name, configDir };
  }

  async rename({ provider, configDir }: TerminalProfile, name: string): Promise<void> {
    name = name.trim();
    if (!validTerminalProfileName(name)) {
      throw new Error('Tên hồ sơ cần có từ 1 đến 80 ký tự và chỉ nằm trên một dòng.');
    }
    if (!(await this.list(provider)).some(profile => profile.configDir === configDir)) {
      throw new Error('Không tìm thấy hồ sơ terminal.');
    }
    const temporaryManifest = join(configDir, `${randomUUID()}.tmp`);
    try {
      await writeFile(temporaryManifest, JSON.stringify({ name }), { mode: 0o600, flag: 'wx' });
      await rename(temporaryManifest, join(configDir, manifestName));
    } catch (error) {
      await unlink(temporaryManifest).catch(() => undefined);
      throw error;
    }
  }

  async remove({ provider, configDir }: TerminalProfile): Promise<void> {
    const profile = (await this.list(provider)).find(candidate => candidate.configDir === configDir);
    if (!profile) throw new Error('This terminal profile is no longer available.');
    const root = await realpath(this.root);
    const target = await realpath(profile.configDir);
    if (target !== join(root, provider, basename(profile.configDir))) {
      throw new Error('The terminal profile points outside its account directory.');
    }
    await rm(target, { recursive: true, force: false, maxRetries: 3 });
  }
}

export async function findTerminalExecutable(provider: TerminalProvider, preferred: string): Promise<string | undefined> {
  const windows = process.platform === 'win32';
  const binary = terminalProviders[provider].bin;
  const names = windows ? [binary + '.exe', binary + '.cmd'] : [binary];
  const folders = [join(homedir(), '.local', 'bin'), ...(process.env.PATH ?? '').split(delimiter)
    .map(folder => folder.replace(/^"(.*)"$/, '$1')).filter(isAbsolute)];
  if (windows) {
    if (process.env.APPDATA) folders.push(join(process.env.APPDATA, 'npm'));
    if (provider === 'codex' && process.env.LOCALAPPDATA) {
      folders.push(join(process.env.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin'));
    }
  }
  const candidates = preferred
    ? [preferred]
    : folders.flatMap(folder => names.map(name => join(folder, name)));
  for (const candidate of new Set(candidates)) {
    if (!isAbsolute(candidate) || (windows && !['.exe', '.cmd'].includes(extname(candidate).toLowerCase()))) continue;
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

export function terminalProfileEnv({ provider, configDir }: TerminalProfile): Record<string, string | null> {
  if (provider === 'codex') return {
    CODEX_HOME: configDir,
    CODEX_API_KEY: null,
    CODEX_ACCESS_TOKEN: null,
    OPENAI_API_KEY: null,
    OPENAI_IDENTITY_TOKEN_FILE: null,
    OPENAI_BASE_URL: null
  };
  if (provider === 'gemini') return {
    GEMINI_CLI_HOME: configDir,
    GEMINI_FORCE_FILE_STORAGE: 'true',
    GEMINI_API_KEY: null,
    GOOGLE_API_KEY: null,
    GOOGLE_APPLICATION_CREDENTIALS: null,
    GOOGLE_GENAI_USE_VERTEXAI: null,
    GOOGLE_GENAI_USE_GCA: null
  };
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
