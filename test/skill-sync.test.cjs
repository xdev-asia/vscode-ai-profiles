const assert = require('node:assert/strict');
const { mkdtemp, mkdir, readFile, readdir, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { test } = require('node:test');
const {
  mergeSkills, parseSkillMarkdown, readSyncFolder, skillHash, skillMarkdown, skillSlug, syncProfileSkills, writeSyncFolder
} = require('../dist/skill-sync.js');
const { SquadMemory } = require('../dist/squad-memory.js');

const skill = (name, instructions, extra = {}) => ({ id: name, name, description: '', instructions, enabled: true, ...extra });

async function temporary(t) {
  const folder = await mkdtemp(join(tmpdir(), 'xdev-skills-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  return folder;
}

test('skills round-trip through SKILL.md with a safe slug', () => {
  assert.equal(skillSlug('Kiểm thử API đầu cuối'), 'xdev-kiem-thu-api-dau-cuoi');
  const markdown = skillMarkdown(skill('Review: "API"', '# Review\nCheck status codes.', { description: 'Use for API reviews' }));
  assert.match(markdown, /^---\nname: xdev-review-api\ndescription: "Use for API reviews"\n/);
  assert.deepEqual(parseSkillMarkdown(markdown), { name: 'Review: "API"', description: 'Use for API reviews', instructions: '# Review\nCheck status codes.' });
  assert.match(skillMarkdown(skill('Plain', 'First line\nMore')), /description: "Plain. First line"/);
  assert.equal(parseSkillMarkdown('no frontmatter'), undefined);
});

test('profile sync writes managed skills and leaves user skills alone', async t => {
  const root = await temporary(t);
  const profile = { provider: 'claude', name: 'A', configDir: join(root, 'claude', 'a') };
  const userSkill = join(profile.configDir, 'skills', 'xdev-mine');
  await mkdir(userSkill, { recursive: true });
  await writeFile(join(userSkill, 'SKILL.md'), 'mine');
  await mkdir(join(profile.configDir, 'skills', 'synced'), { recursive: true });

  assert.equal(await syncProfileSkills([profile, { provider: 'codex', name: 'C', configDir: join(root, 'codex') }],
    [skill('Mine', 'would clash'), skill('Deploy', 'Use the deploy checklist.')]), 1);
  assert.equal(await readFile(join(userSkill, 'SKILL.md'), 'utf8'), 'mine', 'an unmanaged folder is not overwritten');
  assert.match(await readFile(join(profile.configDir, 'skills', 'xdev-deploy', 'SKILL.md'), 'utf8'), /Use the deploy checklist/);

  await syncProfileSkills([profile], []);
  assert.deepEqual((await readdir(join(profile.configDir, 'skills'))).sort(), ['synced', 'xdev-mine']);
});

test('three-way merge takes one-sided changes and keeps conflicts', () => {
  const base = { Alpha: skillHash(skill('Alpha', 'v1')), Beta: skillHash(skill('Beta', 'v1')), Gone: skillHash(skill('Gone', 'v1')), Old: skillHash(skill('Old', 'v1')) };
  const local = [skill('Alpha', 'v1'), skill('Beta', 'local v2'), skill('Gone', 'v1'), skill('Mine', 'new')];
  const remote = [
    { name: 'Alpha', description: '', instructions: 'remote v2' },
    { name: 'Beta', description: '', instructions: 'remote v2' },
    { name: 'Old', description: '', instructions: 'v1' },
    { name: 'Theirs', description: '', instructions: 'new' }
  ];
  const merged = mergeSkills(local, remote, base);
  const byName = Object.fromEntries(merged.skills.map(item => [item.name, item]));
  assert.equal(byName.Alpha.instructions, 'remote v2', 'unchanged local takes the remote edit');
  assert.equal(byName.Beta.instructions, 'local v2', 'both changed: local wins');
  assert.equal(byName['Beta (sync copy)'].instructions, 'remote v2');
  assert.equal(byName['Beta (sync copy)'].enabled, false);
  assert.equal(byName.Gone, undefined, 'deleted remotely and unchanged locally');
  assert.equal(byName.Old, undefined, 'deleted locally and unchanged remotely');
  assert.ok(byName.Mine && byName.Theirs);
  assert.equal(merged.pulled, 2);
  assert.equal(merged.conflicts, 1);
  assert.ok(!('Beta (sync copy)' in merged.base));
});

test('sync folder stores skills and memory that another machine can merge', async t => {
  const folder = await temporary(t);
  const storage = () => {
    const values = new Map();
    return { get: key => values.get(key), update: async (key, value) => values.set(key, value) };
  };
  const mine = new SquadMemory(storage());
  await mine.add(['Use pnpm, not npm', 'use PNPM,  not npm'], 'Implement');
  assert.equal(mine.read().length, 1, 'near-duplicate notes are skipped');
  await writeSyncFolder(folder, [skill('Deploy', 'Checklist')], mine.read());

  const snapshot = await readSyncFolder(folder);
  assert.deepEqual(snapshot.skills, [{ name: 'Deploy', description: 'Deploy. Checklist', instructions: 'Checklist' }]);
  const theirs = new SquadMemory(storage());
  await theirs.add(['Release on Fridays is frozen'], 'You');
  assert.equal(await theirs.merge(snapshot.memory), 1);
  assert.equal(await theirs.merge(snapshot.memory), 0, 'merging twice adds nothing');
  const [first] = theirs.read().filter(note => note.text === 'Release on Fridays is frozen');
  await theirs.edit(first.id, { pinned: true });
  assert.deepEqual(theirs.context(), ['Release on Fridays is frozen', 'Use pnpm, not npm']);
  assert.deepEqual(theirs.context(30), ['Release on Fridays is frozen']);
});
