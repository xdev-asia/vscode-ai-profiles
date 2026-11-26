import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

export type AuditSource = 'mcp' | 'user';

export interface AuditEntry {
  at: string;
  source: AuditSource;
  action: string;
  ok: boolean;
  details?: Record<string, unknown>;
  error?: string;
}

const maxFileBytes = 1024 * 1024;
const maxValueLength = 200;

function clip(value: unknown): unknown {
  if (typeof value === 'string') return value.length > maxValueLength ? `${value.slice(0, maxValueLength)}…` : value;
  if (Array.isArray(value)) return value.slice(0, 20).map(clip);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 20).map(([key, item]) => [key, clip(item)]));
  return value;
}

/**
 * An append-only JSON Lines record of account changes and MCP calls. It never holds API keys or sign-in data:
 * callers pass only ids, names, and the arguments of xDev tools, which take no secrets. The file rolls over to
 * `<file>.1` at 1 MB.
 */
export class AuditLog {
  private writes: Promise<unknown> = Promise.resolve();

  constructor(readonly file: string, private readonly output?: { appendLine(line: string): void }) {}

  record(source: AuditSource, action: string, ok: boolean, details?: Record<string, unknown>, error?: unknown): Promise<void> {
    const entry: AuditEntry = { at: new Date().toISOString(), source, action, ok };
    if (details && Object.keys(details).length) entry.details = clip(details) as Record<string, unknown>;
    if (error !== undefined) entry.error = String(clip(error instanceof Error ? error.message : String(error)));
    const line = JSON.stringify(entry);
    this.output?.appendLine(`${entry.at} ${source.toUpperCase()} ${action} ${ok ? 'ok' : 'failed'}${entry.details ? ` ${JSON.stringify(entry.details)}` : ''}${entry.error ? ` – ${entry.error}` : ''}`);
    const pending = this.writes.then(async () => {
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      const size = await stat(this.file).then(info => info.size, () => 0);
      if (size + line.length > maxFileBytes) await rename(this.file, `${this.file}.1`).catch(() => undefined);
      await appendFile(this.file, `${line}\n`, { mode: 0o600 });
    });
    this.writes = pending.catch(() => undefined);
    return pending.catch(() => undefined);
  }
}
