import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MemoryNote } from './squad-memory';
import type { Skill } from './squad-customizations';
import type { TerminalProfile } from './terminal-profiles';

const managedMarker = '.xdev-managed';
const prefix = 'xdev-';

export function skillSlug(name: string): string {
  const slug = name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
  return prefix + (slug || createHash('sha256').update(name).digest('hex').slice(0, 8));
}

export function skillDescription(skill: Pick<Skill, 'name' | 'description' | 'instructions'>): string {
  const first = skill.instructions.split('\n').map(line => line.replace(/^#+\s*/, '').trim()).find(Boolean) ?? '';
  return (skill.description?.trim() || `${skill.name}. ${first}`).replace(/\s+/g, ' ').slice(0, 200);
}

/** SKILL.md in Claude Code's format. Only the frontmatter stays in context until the skill is used. */
export function skillMarkdown(skill: Pick<Skill, 'name' | 'description' | 'instructions'>): string {
  return [
    '---',
    `name: ${skillSlug(skill.name)}`,
    `description: ${JSON.stringify(skillDescription(skill))}`,
    `x-xdev-name: ${JSON.stringify(skill.name)}`,
    '---',
    '',
    skill.instructions.trim(),
    ''
  ].join('\n');
}

export function parseSkillMarkdown(text: string): Pick<Skill, 'name' | 'description' | 'instructions'> | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return undefined;
  const fields = new Map<string, string>();
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^([\w-]+):\s*(.*)$/.exec(line);
    if (!field) continue;
    let value = field[2].trim();
    if (value.startsWith('"')) {
      try {
        value = JSON.parse(value) as string;
      } catch {
        // Leave a malformed quoted value as written.
      }
    }
    fields.set(field[1], value);
  }
  const name = (fields.get('x-xdev-name') || fields.get('name') || '').replace(/[\r\n]/g, ' ').trim().slice(0, 80);
  const instructions = match[2].trim();
  if (!name || !instructions) return undefined;
  return { name, description: (fields.get('description') ?? '').slice(0, 200), instructions };
}

export function skillHash(skill: Pick<Skill, 'name' | 'description' | 'instructions'>): string {
  return createHash('sha256').update(skillMarkdown(skill)).digest('hex').slice(0, 16);
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

async function writeAtomic(path: string, text: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, text, { mode: 0o600 });
  await rename(temporary, path);
}

/**
 * Writes enabled skills into each Claude Code profile as user skills
 * (`$CLAUDE_CONFIG_DIR/skills/xdev-<name>/SKILL.md`). Only folders marked as managed by xDev
 * are replaced or removed, so skills the user or Claude installed stay untouched.
 */
export async function syncProfileSkills(profiles: readonly TerminalProfile[], skills: readonly Skill[]): Promise<number> {
  const wanted = new Map(skills.map(skill => [skillSlug(skill.name), skill]));
  let synced = 0;
  for (const profile of profiles) {
    if (profile.provider !== 'claude') continue;
    const root = join(profile.configDir, 'skills');
    await mkdir(root, { recursive: true, mode: 0o700 });
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith(prefix) || wanted.has(entry.name)) continue;
      if (await exists(join(root, entry.name, managedMarker))) await rm(join(root, entry.name), { recursive: true, force: true });
    }
    for (const [slug, skill] of wanted) {
      const folder = join(root, slug);
      if (await exists(folder) && !await exists(join(folder, managedMarker))) continue;
      await mkdir(folder, { recursive: true, mode: 0o700 });
      await writeFile(join(folder, managedMarker), 'Managed by xDev AI. Edit this skill in xDev Squad → Skills & Tools.\n', { mode: 0o600 });
      await writeAtomic(join(folder, 'SKILL.md'), skillMarkdown(skill));
    }
    synced++;
  }
  return synced;
}

export interface FolderSnapshot {
  skills: Pick<Skill, 'name' | 'description' | 'instructions'>[];
  memory: unknown;
}

export async function readSyncFolder(folder: string): Promise<FolderSnapshot> {
  const skills: FolderSnapshot['skills'] = [];
  const root = join(folder, 'skills');
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const text = await readFile(join(root, entry.name, 'SKILL.md'), 'utf8').catch(() => undefined);
    const skill = text === undefined ? undefined : parseSkillMarkdown(text);
    if (skill) skills.push(skill);
  }
  let memory: unknown = [];
  const raw = await readFile(join(folder, 'memory', 'squad-memory.json'), 'utf8').catch(() => undefined);
  if (raw !== undefined) {
    try {
      memory = JSON.parse(raw);
    } catch {
      throw new Error('memory/squad-memory.json in the sync folder is not valid JSON.');
    }
  }
  return { skills, memory };
}

export async function writeSyncFolder(folder: string, skills: readonly Skill[], memory: readonly MemoryNote[]): Promise<void> {
  const root = join(folder, 'skills');
  await mkdir(root, { recursive: true });
  const wanted = new Set(skills.map(skill => skillSlug(skill.name)));
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith(prefix) && !wanted.has(entry.name)) {
      await rm(join(root, entry.name), { recursive: true, force: true });
    }
  }
  for (const skill of skills) {
    const target = join(root, skillSlug(skill.name));
    await mkdir(target, { recursive: true });
    await writeAtomic(join(target, 'SKILL.md'), skillMarkdown(skill));
  }
  await mkdir(join(folder, 'memory'), { recursive: true });
  await writeAtomic(join(folder, 'memory', 'squad-memory.json'), JSON.stringify(memory, null, 2) + '\n');
}

export interface SkillMerge {
  skills: Skill[];
  base: Record<string, string>;
  pulled: number;
  conflicts: number;
}

/**
 * Three-way merge by skill name. The base is each skill's hash at the last sync:
 * a side that still matches the base takes the other side's change. When both sides changed,
 * the local skill wins and the folder copy is kept as a disabled "(sync copy)" skill.
 * A skill missing on one side is deleted only if the other side has not changed it since the base.
 */
export function mergeSkills(local: readonly Skill[], remote: FolderSnapshot['skills'], base: Readonly<Record<string, string>>): SkillMerge {
  const key = (name: string) => name.toLowerCase();
  const remoteByName = new Map(remote.map(skill => [key(skill.name), skill]));
  const localByName = new Map(local.map(skill => [key(skill.name), skill]));
  const merged: Skill[] = [];
  let pulled = 0;
  let conflicts = 0;

  for (const skill of local) {
    const theirs = remoteByName.get(key(skill.name));
    const baseHash = base[skill.name];
    const mine = skillHash(skill);
    if (!theirs) {
      if (baseHash && baseHash === mine) continue;
      merged.push(skill);
      continue;
    }
    const theirHash = skillHash(theirs);
    if (theirHash === mine || theirHash === baseHash) merged.push(skill);
    else if (mine === baseHash) {
      merged.push({ ...skill, description: theirs.description, instructions: theirs.instructions });
      pulled++;
    } else {
      merged.push(skill);
      const copyName = `${skill.name} (sync copy)`.slice(0, 80);
      if (!localByName.has(key(copyName))) {
        merged.push({ id: randomUUID(), ...theirs, name: copyName, enabled: false });
        conflicts++;
      }
    }
  }
  for (const theirs of remote) {
    if (localByName.has(key(theirs.name)) || merged.some(skill => key(skill.name) === key(theirs.name))) continue;
    const baseHash = base[theirs.name];
    if (baseHash && baseHash === skillHash(theirs)) continue;
    merged.push({ id: randomUUID(), ...theirs, enabled: true });
    pulled++;
  }
  return {
    skills: merged,
    base: Object.fromEntries(merged.filter(skill => !skill.name.endsWith('(sync copy)')).map(skill => [skill.name, skillHash(skill)])),
    pulled,
    conflicts
  };
}
