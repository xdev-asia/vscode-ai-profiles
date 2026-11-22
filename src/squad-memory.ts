import { randomUUID } from 'node:crypto';
import type { Memento } from 'vscode';

export interface MemoryNote {
  id: string;
  text: string;
  source: string;
  pinned: boolean;
  time: number;
}

const storageKey = 'squadMemory.v1';
export const memoryTextLimit = 300;
const noteLimit = 200;
const contextLimit = 3_000;

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function memoryText(input: unknown): string {
  if (typeof input !== 'string') throw new Error('Enter a memory note.');
  const text = input.replace(/\s+/g, ' ').trim();
  if (!text || text.length > memoryTextLimit) throw new Error(`A memory note has 1 to ${memoryTextLimit} characters.`);
  return text;
}

/**
 * Shared Squad memory: short durable notes that every agent receives with its task.
 * Pinned notes come first; the rest are newest first, cut to a fixed character budget
 * so the memory never grows the prompt without bound.
 */
export class SquadMemory {
  private writes = Promise.resolve();

  constructor(private readonly storage: Memento) {}

  read(): MemoryNote[] {
    return this.storage.get<MemoryNote[]>(storageKey) ?? [];
  }

  context(limit = contextLimit): string[] {
    const notes = [...this.read()].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.time - a.time);
    const lines: string[] = [];
    let size = 0;
    for (const note of notes) {
      if (size + note.text.length > limit) continue;
      lines.push(note.text);
      size += note.text.length;
    }
    return lines;
  }

  add(texts: readonly string[], source: string): Promise<number> {
    let added = 0;
    return this.update(notes => {
      for (const input of texts) {
        let text: string;
        try {
          text = memoryText(input);
        } catch {
          continue;
        }
        if (notes.some(note => normalize(note.text) === normalize(text))) continue;
        notes.unshift({ id: randomUUID(), text, source, pinned: false, time: Date.now() });
        added++;
      }
    }).then(() => added);
  }

  edit(id: unknown, input: { text?: unknown; pinned?: unknown }): Promise<number> {
    return this.update(notes => {
      const note = notes.find(candidate => candidate.id === id);
      if (!note) throw new Error('This memory note is no longer available.');
      if (input.text !== undefined) note.text = memoryText(input.text);
      if (typeof input.pinned === 'boolean') note.pinned = input.pinned;
    }).then(() => 0);
  }

  remove(id: unknown): Promise<number> {
    return this.update(notes => notes.splice(0, notes.length, ...notes.filter(note => note.id !== id))).then(() => 0);
  }

  /** Merges notes from another copy (a sync folder). Notes are kept by id; nothing is deleted. */
  merge(incoming: unknown): Promise<number> {
    let added = 0;
    return this.update(notes => {
      if (!Array.isArray(incoming)) return;
      for (const item of incoming) {
        const candidate = item as Partial<MemoryNote>;
        if (typeof candidate?.id !== 'string' || typeof candidate.text !== 'string') continue;
        let text: string;
        try {
          text = memoryText(candidate.text);
        } catch {
          continue;
        }
        const existing = notes.find(note => note.id === candidate.id);
        if (existing) {
          if (candidate.pinned === true) existing.pinned = true;
          continue;
        }
        if (notes.some(note => normalize(note.text) === normalize(text))) continue;
        notes.push({
          id: candidate.id, text,
          source: typeof candidate.source === 'string' ? candidate.source.slice(0, 40) : 'Sync',
          pinned: candidate.pinned === true,
          time: typeof candidate.time === 'number' ? candidate.time : Date.now()
        });
        added++;
      }
      notes.sort((a, b) => b.time - a.time);
    }).then(() => added);
  }

  private update(change: (notes: MemoryNote[]) => void): Promise<void> {
    const pending = this.writes.then(async () => {
      const notes = structuredClone(this.read());
      change(notes);
      const pinned = notes.filter(note => note.pinned);
      const rest = notes.filter(note => !note.pinned).slice(0, Math.max(0, noteLimit - pinned.length));
      await this.storage.update(storageKey, notes.filter(note => note.pinned || rest.includes(note)));
    });
    this.writes = pending.catch(() => undefined);
    return pending;
  }
}
