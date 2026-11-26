import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { terminalProviderIds, validTerminalProfileName, type TerminalProfile, type TerminalProfiles, type TerminalProvider } from './terminal-profiles';

/**
 * Terminal accounts moved between machines: each account's name, provider and sign-in files, sealed with a
 * passphrase (scrypt key, AES-256-GCM). Only the files a CLI needs to stay signed in are taken, never history.
 */

export const accountFileFormat = 'xdev-ai-accounts';
const formatVersion = 1;
const minPassphrase = 8;
const maxFileBytes = 4 * 1024 * 1024;
const kdf = { N: 2 ** 15, r: 8, p: 1 };

/** Files, relative to the account directory, that hold a CLI's sign-in and its own settings. */
export const accountFiles: Record<TerminalProvider, readonly string[]> = {
  claude: ['.credentials.json', '.claude.json', 'settings.json'],
  codex: ['auth.json', 'config.toml'],
  gemini: ['.gemini/oauth_creds.json', '.gemini/google_accounts.json', '.gemini/settings.json']
};

interface SealedFile {
  format: typeof accountFileFormat;
  version: number;
  kdf: { name: 'scrypt'; N: number; r: number; p: number; salt: string };
  cipher: 'aes-256-gcm';
  iv: string;
  tag: string;
  data: string;
}

interface ExportedAccount {
  provider: TerminalProvider;
  name: string;
  files: Record<string, string>;
}

export function validPassphrase(passphrase: string): boolean {
  return passphrase.length >= minPassphrase;
}

function key(passphrase: string, salt: Buffer, params: { N: number; r: number; p: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(passphrase.normalize('NFC'), salt, 32, { ...params, maxmem: 128 * params.N * params.r * 2 }, (error, derived) =>
      error ? reject(error) : resolve(derived));
  });
}

export interface ExportResult {
  content: Buffer;
  /** Accounts exported with no sign-in file, for example a Claude login kept in the macOS keychain. */
  withoutSignIn: string[];
}

export async function exportAccounts(accounts: readonly TerminalProfile[], passphrase: string): Promise<ExportResult> {
  if (!validPassphrase(passphrase)) throw new Error(`The passphrase needs at least ${minPassphrase} characters.`);
  if (!accounts.length) throw new Error('Choose at least one account to export.');
  const withoutSignIn: string[] = [];
  const exported: ExportedAccount[] = [];
  for (const account of accounts) {
    const files: Record<string, string> = {};
    for (const file of accountFiles[account.provider]) {
      try {
        files[file] = (await readFile(join(account.configDir, file))).toString('base64');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    if (!Object.keys(files).length) withoutSignIn.push(account.name);
    exported.push({ provider: account.provider, name: account.name, files });
  }
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', await key(passphrase, salt, kdf), iv);
  cipher.setAAD(Buffer.from(`${accountFileFormat}/${formatVersion}`));
  const data = Buffer.concat([cipher.update(JSON.stringify({ accounts: exported }), 'utf8'), cipher.final()]);
  const sealed: SealedFile = {
    format: accountFileFormat,
    version: formatVersion,
    kdf: { name: 'scrypt', ...kdf, salt: salt.toString('base64') },
    cipher: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64')
  };
  const content = Buffer.from(JSON.stringify(sealed, undefined, 2));
  if (content.length > maxFileBytes) throw new Error('These accounts are too large to export together. Export fewer at a time.');
  return { content, withoutSignIn };
}

function sealedFile(content: Uint8Array): SealedFile {
  if (content.length > maxFileBytes) throw new Error('This is not an xDev AI accounts file.');
  let file: Partial<SealedFile>;
  try {
    file = JSON.parse(Buffer.from(content).toString('utf8')) as Partial<SealedFile>;
  } catch {
    throw new Error('This is not an xDev AI accounts file.');
  }
  if (file?.format !== accountFileFormat) throw new Error('This is not an xDev AI accounts file.');
  if (file.version !== formatVersion) throw new Error('This accounts file comes from a newer xDev AI. Update the extension first.');
  const { N, r, p, salt } = file.kdf ?? {};
  const strings = [salt, file.iv, file.tag, file.data].every(value => typeof value === 'string');
  // Bounds keep a crafted file from asking for an unbounded key derivation.
  const params = [N, r, p].every(Number.isSafeInteger) && N! >= 2 ** 14 && N! <= 2 ** 20 && (N! & (N! - 1)) === 0 && r! >= 1 && r! <= 16 && p! >= 1 && p! <= 4;
  if (file.kdf?.name !== 'scrypt' || file.cipher !== 'aes-256-gcm' || !strings || !params) throw new Error('This accounts file is damaged.');
  return file as SealedFile;
}

async function openSealed(file: SealedFile, passphrase: string): Promise<ExportedAccount[]> {
  let plain: string;
  try {
    const decipher = createDecipheriv('aes-256-gcm', await key(passphrase, Buffer.from(file.kdf.salt, 'base64'), file.kdf), Buffer.from(file.iv, 'base64'));
    decipher.setAAD(Buffer.from(`${accountFileFormat}/${file.version}`));
    decipher.setAuthTag(Buffer.from(file.tag, 'base64'));
    plain = Buffer.concat([decipher.update(Buffer.from(file.data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('Wrong passphrase, or the file was changed.');
  }
  const accounts = (JSON.parse(plain) as { accounts?: unknown }).accounts;
  if (!Array.isArray(accounts)) throw new Error('This accounts file is damaged.');
  return accounts.map(value => {
    const account = value as Partial<ExportedAccount>;
    const provider = account.provider as TerminalProvider;
    if (!terminalProviderIds.includes(provider) || !validTerminalProfileName(account.name) || !account.files || typeof account.files !== 'object') {
      throw new Error('This accounts file is damaged.');
    }
    const allowed = accountFiles[provider];
    for (const [name, data] of Object.entries(account.files)) {
      // Only the known files: a path from the file never chooses where a write lands.
      if (!allowed.includes(name) || typeof data !== 'string') throw new Error('This accounts file is damaged.');
    }
    return { provider, name: account.name.trim(), files: account.files };
  });
}

/** The accounts a file holds, after the passphrase opens it; nothing is written. */
export async function readAccountFile(content: Uint8Array, passphrase: string): Promise<{ provider: TerminalProvider; name: string; signedIn: boolean }[]> {
  return (await openSealed(sealedFile(content), passphrase)).map(({ provider, name, files }) => ({ provider, name, signedIn: Object.keys(files).length > 0 }));
}

function freeName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name;
  for (let n = 2; ; n++) {
    const suffix = ` (${n})`;
    const candidate = name.slice(0, 80 - suffix.length) + suffix;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Adds every account in the file as a new account; a name already used for that provider gets a number. */
export async function importAccounts(profiles: TerminalProfiles, content: Uint8Array, passphrase: string): Promise<TerminalProfile[]> {
  const accounts = await openSealed(sealedFile(content), passphrase);
  const added: TerminalProfile[] = [];
  for (const account of accounts) {
    const taken = new Set((await profiles.list(account.provider)).map(profile => profile.name));
    const profile = await profiles.add(account.provider, freeName(account.name, taken));
    try {
      for (const [name, data] of Object.entries(account.files)) {
        const target = join(profile.configDir, name);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, Buffer.from(data, 'base64'), { mode: 0o600, flag: 'wx' });
      }
    } catch (error) {
      await profiles.remove(profile).catch(() => undefined);
      throw error;
    }
    added.push(profile);
  }
  return added;
}
