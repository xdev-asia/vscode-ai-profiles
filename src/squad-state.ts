import { createHash } from 'node:crypto';
import type { Memento } from 'vscode';

/** A short, stable id for a workspace, used to keep its Squad state apart from other workspaces. */
export function workspaceKey(identity: string): string {
  return createHash('sha256').update(identity).digest('hex').slice(0, 16);
}

/**
 * Squad state for one workspace kept in global state, so every VS Code window that opens the workspace
 * sees the same roles, runs, memory, and skills. Values saved per window before are read until the
 * first write replaces them.
 */
export class SharedMemento implements Memento {
  private readonly prefix: string;

  constructor(private readonly global: Memento, key: string, private readonly legacy?: Memento) {
    this.prefix = `squad:${key}:`;
  }

  keys(): readonly string[] {
    const own = this.global.keys().filter(key => key.startsWith(this.prefix)).map(key => key.slice(this.prefix.length));
    return [...new Set([...own, ...(this.legacy?.keys() ?? [])])];
  }

  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    const value = this.global.get<T>(this.prefix + key);
    if (value !== undefined) return value;
    const legacy = this.legacy?.get<T>(key);
    return legacy !== undefined ? legacy : defaultValue;
  }

  update(key: string, value: unknown): Thenable<void> {
    return this.global.update(this.prefix + key, value);
  }
}
