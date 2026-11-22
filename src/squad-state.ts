import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, statSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { basename, dirname } from 'node:path';
import type { Memento } from 'vscode';

/** A short, stable id for a workspace, used to keep its Squad state apart from other workspaces. */
export function workspaceKey(identity: string): string {
  return createHash('sha256').update(identity).digest('hex').slice(0, 16);
}

/**
 * Squad state for one workspace in a JSON file on the extension host, so every window that opens the
 * workspace (in any browser, for code-server) reads and writes the same roles, runs, memory, and skills.
 * The file is re-read when it changes, and `watch` reports changes made by other windows.
 * Values saved per window by older versions are read until the first write replaces them.
 */
export class FileMemento implements Memento {
  private data: Record<string, unknown> = {};
  private stamp = '';
  /** The file stamp after this window's last write, so its own writes do not count as outside changes. */
  private written = '';
  private watcher?: FSWatcher;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private readonly file: string, private readonly legacy?: Memento) {}

  private load(): Record<string, unknown> {
    let stamp = '';
    try {
      const stat = statSync(this.file);
      stamp = `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return this.data;
    }
    if (stamp !== this.stamp) {
      try {
        const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) this.data = parsed as Record<string, unknown>;
      } catch {
        // A partial or damaged file keeps the last good state; the next write replaces it.
      }
      this.stamp = stamp;
    }
    return this.data;
  }

  keys(): readonly string[] {
    return [...new Set([...Object.keys(this.load()), ...(this.legacy?.keys() ?? [])])];
  }

  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    const data = this.load();
    if (Object.hasOwn(data, key)) return data[key] as T;
    const legacy = this.legacy?.get<T>(key);
    return legacy !== undefined ? legacy : defaultValue;
  }

  /** Writes the whole file atomically (temporary file, then rename), so readers never see half a write. */
  update(key: string, value: unknown): Thenable<void> {
    const data = { ...this.load() };
    if (value === undefined) delete data[key];
    else data[key] = value;
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporary, JSON.stringify(data), { mode: 0o600 });
    renameSync(temporary, this.file);
    this.data = data;
    try {
      const stat = statSync(this.file);
      this.stamp = `${stat.mtimeMs}:${stat.size}`;
    } catch {
      this.stamp = '';
    }
    this.written = this.stamp;
    return Promise.resolve();
  }

  /** Calls `changed` when another window writes the file. */
  watch(changed: () => void): { dispose(): void } {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const name = basename(this.file);
    try {
      this.watcher = watch(dirname(this.file), (_event, file) => {
        if (file && file.toString() !== name) return;
        clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          this.load();
          if (this.stamp && this.stamp !== this.written) changed();
        }, 100);
      });
      this.watcher.on('error', () => undefined);
    } catch {
      // Without a watcher, the panel still re-reads the file on focus and while another window runs.
    }
    return { dispose: () => { clearTimeout(this.timer); this.watcher?.close(); } };
  }
}
