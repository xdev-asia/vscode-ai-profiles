import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const artifactKinds = ['markdown', 'html', 'text', 'json'] as const;
export type ArtifactKind = typeof artifactKinds[number];

export const artifactNameLimit = 80;
export const artifactDescriptionLimit = 300;
export const artifactContentLimit = 200_000;
export const artifactLimit = 100;
const linkLimit = 500;
/** How long a change waits for another window's change, and when a lock is taken to be left behind. */
const lockWaitMs = 10_000;
const lockStaleMs = 30_000;
const extensions: Record<ArtifactKind, string> = { markdown: 'md', html: 'html', text: 'txt', json: 'json' };

export interface SquadArtifact {
  id: string;
  name: string;
  kind: ArtifactKind;
  description: string;
  /** The page on claude.ai this artifact was published as, if any. Only people it is shared with there can open it. */
  link?: string;
  /** The account, role, or person that saved it last. */
  author: string;
  /** The Squad run it came from, if any. */
  run?: string;
  time: number;
  updated: number;
  /** How many times it was saved. */
  version: number;
  size: number;
}

export interface ArtifactInput {
  name?: unknown;
  kind?: unknown;
  description?: unknown;
  content?: unknown;
  link?: unknown;
}

function nameOf(input: unknown): string {
  const name = typeof input === 'string' ? input.replace(/\s+/g, ' ').trim() : '';
  if (!name || name.length > artifactNameLimit) throw new Error(`Give the artifact a name of 1 to ${artifactNameLimit} characters.`);
  return name;
}

/** A claude.ai artifact link, or nothing. Other addresses are refused so the panel never shows an arbitrary link. */
export function artifactLink(input: unknown): string | undefined {
  if (input === undefined || input === null || input === '') return undefined;
  if (typeof input !== 'string' || input.length > linkLimit) throw new Error('The link must be a claude.ai artifact address.');
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error('The link must be a claude.ai artifact address.');
  }
  if (url.protocol !== 'https:' || url.hostname !== 'claude.ai' || url.username || url.password) throw new Error('The link must be a claude.ai artifact address.');
  return url.toString();
}

/**
 * Documents every account of a project can read and write: a design, a report, a spec. A page published on
 * claude.ai belongs to the account that made it, so the content is kept here and the page is only linked.
 * Each artifact is one file next to an index, in a folder shared by every window that opens the project.
 */
export class SquadArtifacts {
  private writes = Promise.resolve();

  constructor(readonly dir: string) {}

  /** Newest first. */
  async list(): Promise<SquadArtifact[]> {
    try {
      const parsed = JSON.parse(await readFile(join(this.dir, 'index.json'), 'utf8')) as unknown;
      if (!Array.isArray(parsed)) return [];
      return (parsed as SquadArtifact[])
        .filter(item => item && typeof item.id === 'string' && /^[a-f0-9-]{36}$/.test(item.id) && typeof item.name === 'string' && artifactKinds.includes(item.kind))
        .sort((a, b) => b.updated - a.updated);
    } catch {
      return [];
    }
  }

  /** The file that holds an artifact's content, for a worker to read. */
  file(artifact: Pick<SquadArtifact, 'id' | 'kind'>): string {
    return join(this.dir, `${artifact.id}.${extensions[artifact.kind]}`);
  }

  private async find(key: unknown): Promise<SquadArtifact> {
    const wanted = typeof key === 'string' ? key.trim().toLowerCase() : '';
    const artifact = wanted ? (await this.list()).find(item => item.id === wanted || item.name.toLowerCase() === wanted) : undefined;
    if (!artifact) throw new Error('There is no artifact with that name or id.');
    return artifact;
  }

  async read(key: unknown): Promise<SquadArtifact & { content: string }> {
    const artifact = await this.find(key);
    try {
      return { ...artifact, content: await readFile(this.file(artifact), 'utf8') };
    } catch {
      throw new Error(`The content of “${artifact.name}” is missing.`);
    }
  }

  /** Adds an artifact, or replaces the one with the same name. */
  async save(input: ArtifactInput, author: string, run?: string): Promise<SquadArtifact> {
    const name = nameOf(input?.name);
    const content = typeof input?.content === 'string' ? input.content : '';
    if (!content.trim() || content.length > artifactContentLimit) throw new Error(`Give the artifact content of up to ${artifactContentLimit.toLocaleString('en-US')} characters.`);
    const description = typeof input?.description === 'string' ? input.description.replace(/\s+/g, ' ').trim().slice(0, artifactDescriptionLimit) : '';
    const kind = artifactKinds.find(candidate => candidate === input?.kind);
    if (input?.kind !== undefined && input.kind !== null && input.kind !== '' && !kind) throw new Error(`The kind is one of ${artifactKinds.join(', ')}.`);
    const link = artifactLink(input?.link);
    const by = author.replace(/\s+/g, ' ').trim().slice(0, 60) || 'Unknown';
    return this.update(async artifacts => {
      const existing = artifacts.find(item => item.name.toLowerCase() === name.toLowerCase());
      if (!existing && artifacts.length >= artifactLimit) throw new Error(`A project keeps ${artifactLimit} artifacts. Remove one first.`);
      const now = Date.now();
      const next: SquadArtifact = {
        id: existing?.id ?? randomUUID(), name, kind: kind ?? existing?.kind ?? 'markdown',
        description: description || existing?.description || '', author: by, time: existing?.time ?? now, updated: now,
        version: (existing?.version ?? 0) + 1, size: content.length,
        // A save without a link keeps the page only for its own author, who can update that page. When another
        // account replaces the content, the page still shows the old document, so the link is dropped.
        ...(link ?? (existing?.author === by ? existing.link : undefined) ? { link: link ?? existing?.link } : {}),
        ...(run ?? existing?.run ? { run: run ?? existing?.run } : {})
      };
      if (existing && existing.kind !== next.kind) await rm(this.file(existing), { force: true });
      await writeFile(this.file(next), content, 'utf8');
      if (existing) artifacts.splice(artifacts.indexOf(existing), 1, next);
      else artifacts.push(next);
      return next;
    });
  }

  /** Saves what a worker returned. One that is not valid is skipped, so a bad entry never fails the step. */
  async saveAll(inputs: readonly ArtifactInput[], author: string, run?: string): Promise<SquadArtifact[]> {
    const saved: SquadArtifact[] = [];
    for (const input of inputs) {
      try {
        saved.push(await this.save(input, author, run));
      } catch {
        // Skipped.
      }
    }
    return saved;
  }

  async remove(key: unknown): Promise<void> {
    const artifact = await this.find(key);
    await this.update(async artifacts => {
      const index = artifacts.findIndex(item => item.id === artifact.id);
      if (index >= 0) artifacts.splice(index, 1);
      await rm(this.file(artifact), { force: true });
    });
  }

  /** What a worker is told: the newest artifacts and the file each one can be read from. */
  async context(limit = 20): Promise<{ name: string; kind: ArtifactKind; description?: string; by: string; file: string }[]> {
    return (await this.list()).slice(0, limit).map(artifact => ({
      name: artifact.name, kind: artifact.kind, ...(artifact.description ? { description: artifact.description } : {}),
      by: artifact.author, file: this.file(artifact)
    }));
  }

  /**
   * Holds the index for one change. Every VS Code window that opens the project writes the same index, and
   * each reads it before it writes, so two windows must not do that at the same time. The lock is a folder,
   * which the file system creates for one caller only; a lock left by a window that died is taken over.
   */
  private async lock(): Promise<() => Promise<void>> {
    const path = join(this.dir, 'index.lock');
    const end = Date.now() + lockWaitMs;
    for (;;) {
      try {
        await mkdir(path);
        return () => rmdir(path).catch(() => undefined);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const age = await stat(path).then(info => Date.now() - info.mtimeMs, () => 0);
      if (age > lockStaleMs) await rmdir(path).catch(() => undefined);
      else if (Date.now() > end) throw new Error('The shared artifacts are being changed by another window. Try again.');
      else await new Promise(resolve => setTimeout(resolve, 25));
    }
  }

  private update<T>(change: (artifacts: SquadArtifact[]) => Promise<T>): Promise<T> {
    const pending = this.writes.then(async () => {
      await mkdir(this.dir, { recursive: true });
      const unlock = await this.lock();
      try {
        const artifacts = await this.list();
        const result = await change(artifacts);
        // Written beside the index and renamed, so a reader never sees half a file.
        const draft = join(this.dir, `index.${randomUUID()}.tmp`);
        await writeFile(draft, JSON.stringify(artifacts, null, 1), 'utf8');
        await rename(draft, join(this.dir, 'index.json'));
        return result;
      } finally {
        await unlock();
      }
    });
    this.writes = pending.then(() => undefined, () => undefined);
    return pending;
  }
}
