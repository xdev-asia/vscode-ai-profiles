import { execFile, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { findTerminalExecutable, terminalArguments, terminalProfileEnv, type TerminalProfile } from './terminal-profiles';

export interface UsageWindow {
  label: string;
  used: number;
  resetsAt?: number;
}

export interface AccountUsage {
  plan?: string;
  /** ChatGPT Business (plan team/business): a Standard seat has a 5-hour window, a Premium seat only a weekly one. */
  seat?: 'standard' | 'premium';
  windows: UsageWindow[];
  observedAt?: number;
  signedOut?: boolean;
  unavailable?: boolean;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function label(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 60 && /^[\p{L}\p{N} ._+-]+$/u.test(value) ? value : undefined;
}

function windowUsage(label: string, value: unknown, reset: unknown): UsageWindow[] {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1000) return [];
  const resetsAt = typeof reset === 'number' && reset > 0 && reset < 253402300800 ? reset * 1000 : undefined;
  return [{ label, used: value, resetsAt }];
}

function durationLabel(minutes: unknown, fallback: string): string {
  if (typeof minutes !== 'number' || !Number.isSafeInteger(minutes) || minutes <= 0) return fallback;
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

const businessPlans = new Set(['team', 'business', 'self_serve_business', 'self_serve_business_prolite', 'self_serve_business_usage_based']);

/** The rate-limit answer has no seat field: both seats report plan team, so the seat is read from the main windows' lengths. */
export function businessSeat(plan: string | undefined, rateLimits: unknown): AccountUsage['seat'] {
  if (!plan || !businessPlans.has(plan.toLowerCase())) return undefined;
  const limits = object(rateLimits);
  const minutes = (['primary', 'secondary'] as const).filter(key => limits[key] != null).map(key => object(limits[key]).windowDurationMins);
  if (!minutes.length || minutes.some(m => typeof m !== 'number' || !Number.isFinite(m) || m <= 0)) return undefined;
  return (minutes as number[]).some(m => m <= 360) ? 'standard' : 'premium';
}

export function codexUsage(accountResponse: unknown, limitsResponse: unknown): AccountUsage {
  const auth = object(accountResponse);
  const account = object(auth.account);
  const limits = object(limitsResponse);
  const buckets = Object.entries(object(limits.rateLimitsByLimitId));
  if (!buckets.length) buckets.push(['codex', limits.rateLimits]);
  const windows = buckets.flatMap(([id, value]) => {
    const bucket = object(value);
    const name = id === 'codex' ? '' : label(bucket.limitName) ?? label(id) ?? 'Additional limit';
    return (['primary', 'secondary'] as const).flatMap(key => {
      const limit = object(bucket[key]);
      const duration = durationLabel(limit.windowDurationMins, key === 'primary' ? 'Primary' : 'Secondary');
      return windowUsage(name ? `${name} · ${duration}` : duration, limit.usedPercent, limit.resetsAt);
    });
  });
  const plan = label(account.planType) ?? label(object(limits.rateLimits).planType);
  const main = object(limits.rateLimitsByLimitId).codex ?? limits.rateLimits;
  return {
    plan,
    seat: businessSeat(plan, main),
    windows,
    signedOut: auth.account === null && auth.requiresOpenaiAuth === true,
    observedAt: windows.length ? Date.now() : undefined
  };
}

function commandLine(executable: string, args: readonly string[], env: NodeJS.ProcessEnv) {
  if (process.platform !== 'win32' || extname(executable).toLowerCase() !== '.cmd') return { executable, args, env };
  return {
    executable: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      `& $env:XDEV_AI_QUOTA_CLI ${args.map(arg => `'${arg.replace(/'/g, "''")}'`).join(' ')}; exit $LASTEXITCODE`],
    env: { ...env, XDEV_AI_QUOTA_CLI: executable }
  };
}

async function readCodex(executable: string, env: NodeJS.ProcessEnv, cwd: string, version: string, signal: AbortSignal): Promise<AccountUsage> {
  const cli = commandLine(executable, [...terminalArguments('codex', 'open', false), 'app-server'], env);
  const child = spawn(cli.executable, cli.args, { env: cli.env, cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], signal });
  const lines = createInterface({ input: child.stdout });
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await new Promise((resolve, reject) => {
      let size = 0;
      child.stdout.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 256 * 1024) reject(new Error('Codex quota response exceeded the size limit.'));
      });
      function send(method: string, id?: number, params?: object) {
        child.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
      }
      let account: unknown;
      child.on('error', reject);
      child.stdin.on('error', reject);
      child.on('close', () => reject(new Error('Codex quota process exited.')));
      timeout = setTimeout(() => reject(new Error('Codex quota request timed out.')), 10_000);
      lines.on('line', line => {
        let reply: Record<string, unknown>;
        try { reply = object(JSON.parse(line)); } catch { return; }
        if (reply.id === 3) {
          resolve({ ...codexUsage(account, reply.result), unavailable: Boolean(reply.error) });
        } else if ((reply.id === 1 || reply.id === 2) && reply.error) {
          reject(new Error('Codex quota protocol is unavailable.'));
        } else if (reply.id === 1 && reply.result) {
          send('initialized');
          send('account/read', 2, { refreshToken: false });
        } else if (reply.id === 2) {
          account = reply.result;
          if (object(object(account).account).type === 'chatgpt') send('account/rateLimits/read', 3);
          else resolve(codexUsage(account, undefined));
        }
      });
      child.on('spawn', () => send('initialize', 1, { clientInfo: { name: 'xdev_ai', version } }));
    });
  } finally {
    clearTimeout(timeout);
    lines.close();
    child.stdin.end();
    const kill = setTimeout(() => child.kill(), 1000).unref();
    child.once('close', () => clearTimeout(kill));
  }
}

export const claudeQuotaFile = '.xdev-quota.json';

/**
 * A Claude Team seat reports subscriptionType team either way; a Premium seat carries a Max rate-limit tier
 * (default_claude_max_5x or _20x). Reads only rateLimitTier from the profile's .credentials.json (absent where the
 * login is in the OS keychain), never a token.
 */
export async function claudeTeamSeat(configDir: string, subscription: string | undefined): Promise<AccountUsage['seat']> {
  if (subscription?.toLowerCase() !== 'team') return undefined;
  try {
    const tier = object(object(JSON.parse(await readFile(join(configDir, '.credentials.json'), 'utf8'))).claudeAiOauth).rateLimitTier;
    if (typeof tier !== 'string' || !tier) return undefined;
    return /max_(5|20)x/i.test(tier) ? 'premium' : 'standard';
  } catch {
    return undefined;
  }
}

export async function readClaudeQuota(configDir: string): Promise<AccountUsage> {
  try {
    const snapshot = object(JSON.parse(await readFile(join(configDir, claudeQuotaFile), 'utf8')));
    const windows = object(snapshot.rate_limits);
    const observedAt = snapshot.observedAt;
    if (typeof observedAt !== 'number' || observedAt <= 0 || observedAt > Date.now() + 60_000) return { windows: [] };
    return {
      observedAt,
      windows: [['five_hour', '5h'], ['seven_day', '7d'], ['spend_limit', 'Spend limit']].flatMap(([id, name]) => {
        const limit = object(windows[id]);
        const view = windowUsage(name, limit.used_percentage, limit.resets_at);
        return view.filter(window => window.resetsAt === undefined || window.resetsAt > Date.now());
      })
    };
  } catch {
    return { windows: [] };
  }
}

export async function canCaptureClaudeQuota(configDir: string, cwd?: string): Promise<boolean> {
  const files = [join(configDir, 'settings.json')];
  const home = join(homedir(), '.claude');
  for (let folder = cwd; folder; folder = dirname(folder)) {
    const settings = join(folder, '.claude');
    const isUserSettings = process.platform === 'win32' ? settings.toLowerCase() === home.toLowerCase() : settings === home;
    if (!isUserSettings) files.push(join(settings, 'settings.json'), join(settings, 'settings.local.json'));
    if (folder === dirname(folder)) break;
  }
  const conflicts = await Promise.all(files.map(async file => {
    try {
      return 'statusLine' in object(JSON.parse(await readFile(file, 'utf8')));
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ENOENT';
    }
  }));
  return !conflicts.includes(true);
}

export async function readAccountUsage(profile: TerminalProfile, preferred: string, version: string, signal: AbortSignal): Promise<AccountUsage> {
  if (profile.provider === 'gemini') return { windows: [] };
  try {
    const executable = await findTerminalExecutable(profile.provider, preferred);
    if (!executable) return { windows: [], unavailable: true };
    const env = { ...process.env };
    for (const [key, value] of Object.entries(terminalProfileEnv(profile))) {
      if (value === null) delete env[key];
      else env[key] = value;
    }
    const cwd = profile.configDir;
    signal.throwIfAborted();
    if (profile.provider === 'codex') return await readCodex(executable, env, cwd, version, signal);
    const cli = commandLine(executable, ['auth', 'status'], env);
    const status = await new Promise<unknown>(resolve => {
      execFile(cli.executable, cli.args, { cwd, env: cli.env, windowsHide: true, signal, timeout: 8_000, maxBuffer: 64 * 1024 }, (_, stdout) => {
        try { resolve(JSON.parse(stdout)); } catch { resolve(undefined); }
      });
    });
    const auth = object(status);
    const plan = label(auth.subscriptionType);
    return { plan, seat: await claudeTeamSeat(cwd, plan), windows: [], signedOut: auth.loggedIn === false, unavailable: !status };
  } catch {
    return { windows: [], unavailable: true };
  }
}
