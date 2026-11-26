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

const bypassArguments: Record<TerminalProvider, readonly string[]> = {
  claude: ['--dangerously-skip-permissions'],
  codex: ['--dangerously-bypass-approvals-and-sandbox'],
  gemini: ['--approval-mode=yolo']
};

export function terminalArguments(provider: TerminalProvider, launch: 'open' | 'signIn' | 'bypass', remote: boolean): string[] {
  const args = provider === 'codex' ? ['-c', 'cli_auth_credentials_store=file'] : [];
  if (launch === 'bypass') args.push(...bypassArguments[provider]);
  if (launch === 'signIn' && provider === 'codex') {
    args.push('login');
    if (remote) args.push('--device-auth');
  }
  if (launch === 'signIn' && provider === 'claude') args.push('auth', 'login', '--claudeai');
  return args;
}

/** Management details kept in each account's manifest next to its name. */
export interface TerminalProfileMetadata {
  /** Short labels for grouping and filtering, for example `work` or `team-a`. */
  tags?: string[];
  note?: string;
  /** A disabled account keeps its sign-in but is left out of the Squad pool and of MCP account picks. */
  disabled?: boolean;
  createdAt?: number;
  lastUsedAt?: number;
}

export interface TerminalProfile extends TerminalProfileMetadata {
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

export const maxTags = 10;
export const maxNoteLength = 500;
const tagPattern = /^[\p{L}\p{N}._-]{1,32}$/u;

export function validTag(tag: unknown): tag is string {
  return typeof tag === 'string' && tagPattern.test(tag);
}

/** Trims, lowercases, and de-duplicates tags. Throws on a tag that is not 1 to 32 letters, digits, `.`, `_`, or `-`. */
export function normalizeTags(tags: readonly unknown[]): string[] {
  const result = [...new Set(tags.map(tag => typeof tag === 'string' ? tag.trim().toLowerCase() : tag))].filter(tag => tag !== '');
  if (!result.every(validTag)) throw new Error('Use tags of 1 to 32 letters, digits, dots, underscores, or hyphens.');
  if (result.length > maxTags) throw new Error(`Use at most ${maxTags} tags.`);
  return result;
}

export function normalizeNote(note: unknown): string {
  if (typeof note !== 'string') throw new Error('The note must be text.');
  const text = note.trim();
  if (text.length > maxNoteLength) throw new Error(`Keep the note to ${maxNoteLength} characters.`);
  if (/[\p{Cf}\p{Zl}\p{Zp}]|[^\P{Cc}\n\t]/u.test(text)) throw new Error('The note contains characters that are not allowed.');
  return text;
}

interface Manifest extends TerminalProfileMetadata {
  name: string;
}

function readMetadata(value: Record<string, unknown>): TerminalProfileMetadata {
  const metadata: TerminalProfileMetadata = {};
  if (Array.isArray(value.tags)) {
    const tags = value.tags.filter(validTag).slice(0, maxTags);
    if (tags.length) metadata.tags = tags;
  }
  if (typeof value.note === 'string' && value.note && value.note.length <= maxNoteLength) metadata.note = value.note;
  if (value.disabled === true) metadata.disabled = true;
  for (const key of ['createdAt', 'lastUsedAt'] as const) {
    const time = value[key];
    if (typeof time === 'number' && Number.isSafeInteger(time) && time > 0) metadata[key] = time;
  }
  return metadata;
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
          const parsed = JSON.parse(await readFile(join(configDir, manifestName), 'utf8')) as unknown;
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
          const value = parsed as Record<string, unknown>;
          const name = value.name;
          return validTerminalProfileName(name) ? { ...readMetadata(value), provider, name, configDir } : undefined;
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
    const createdAt = Date.now();
    await writeFile(join(configDir, manifestName), JSON.stringify({ name, createdAt }), { mode: 0o600, flag: 'wx' });
    return { provider, name, configDir, createdAt };
  }

  async rename(profile: TerminalProfile, name: string): Promise<void> {
    name = name.trim();
    if (!validTerminalProfileName(name)) {
      throw new Error('Tên hồ sơ cần có từ 1 đến 80 ký tự và chỉ nằm trên một dòng.');
    }
    await this.update(profile, current => ({ ...current, name }));
  }

  /** Changes tags, note, or the disabled flag. `undefined` keeps a field; an empty list or note clears it. */
  async setMetadata(
    profile: TerminalProfile, change: { tags?: readonly unknown[]; note?: unknown; disabled?: boolean }
  ): Promise<TerminalProfile> {
    const tags = change.tags === undefined ? undefined : normalizeTags(change.tags);
    const note = change.note === undefined ? undefined : normalizeNote(change.note);
    return this.update(profile, current => {
      const next = { ...current };
      if (tags !== undefined) { if (tags.length) next.tags = tags; else delete next.tags; }
      if (note !== undefined) { if (note) next.note = note; else delete next.note; }
      if (change.disabled !== undefined) { if (change.disabled) next.disabled = true; else delete next.disabled; }
      return next;
    });
  }

  /** Records when the account was last opened. Failures are ignored because the time is informational. */
  async touch(profile: TerminalProfile): Promise<void> {
    await this.update(profile, current => ({ ...current, lastUsedAt: Date.now() })).catch(() => undefined);
  }

  private async update({ provider, configDir }: TerminalProfile, change: (current: Manifest) => Manifest): Promise<TerminalProfile> {
    const current = (await this.list(provider)).find(profile => profile.configDir === configDir);
    if (!current) {
      throw new Error('Không tìm thấy hồ sơ terminal.');
    }
    const { provider: _provider, configDir: _configDir, ...manifest } = current;
    const next = change(manifest);
    const temporaryManifest = join(configDir, `${randomUUID()}.tmp`);
    try {
      await writeFile(temporaryManifest, JSON.stringify(next), { mode: 0o600, flag: 'wx' });
      await rename(temporaryManifest, join(configDir, manifestName));
    } catch (error) {
      await unlink(temporaryManifest).catch(() => undefined);
      throw error;
    }
    return { ...readMetadata(next as unknown as Record<string, unknown>), name: next.name, provider, configDir };
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
