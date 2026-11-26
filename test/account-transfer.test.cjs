const assert = require('node:assert/strict');
const { mkdir, mkdtemp, readFile, rm, stat, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { test } = require('node:test');
const { exportAccounts, importAccounts, readAccountFile } = require('../dist/account-transfer.js');
const { TerminalProfiles } = require('../dist/terminal-profiles.js');

async function roots(t) {
  const base = await mkdtemp(join(tmpdir(), 'xdev transfer '));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 5 }));
  return [new TerminalProfiles(join(base, 'a')), new TerminalProfiles(join(base, 'b'))];
}

test('exports sign-in files sealed with a passphrase and imports them as new accounts on another machine', async t => {
  const [from, to] = await roots(t);
  const claude = await from.add('claude', 'Work');
  await writeFile(join(claude.configDir, '.credentials.json'), '{"claudeAiOauth":{"accessToken":"secret-claude"}}');
  await writeFile(join(claude.configDir, 'history.jsonl'), 'not exported');
  const codex = await from.add('codex', 'Personal');
  await writeFile(join(codex.configDir, 'auth.json'), '{"tokens":"secret-codex"}');
  const gemini = await from.add('gemini', 'Google');
  await mkdir(join(gemini.configDir, '.gemini'));
  await writeFile(join(gemini.configDir, '.gemini', 'oauth_creds.json'), '{"refresh_token":"secret-gemini"}');
  const empty = await from.add('claude', 'Keychain');

  const { content, withoutSignIn } = await exportAccounts(await from.list(), 'correct horse');
  assert.deepEqual(withoutSignIn, ['Keychain']);
  for (const secret of ['secret-claude', 'secret-codex', 'secret-gemini', 'Work']) assert.ok(!content.toString().includes(secret));

  await to.add('codex', 'Personal');
  assert.deepEqual((await readAccountFile(content, 'correct horse')).map(a => [a.provider, a.name, a.signedIn]).sort(), [
    ['claude', 'Keychain', false], ['claude', 'Work', true], ['codex', 'Personal', true], ['gemini', 'Google', true]
  ]);
  const added = await importAccounts(to, content, 'correct horse');
  assert.equal(added.length, 4);
  const byName = Object.fromEntries((await to.list()).map(p => [`${p.provider}/${p.name}`, p]));
  assert.ok(byName['codex/Personal (2)'], 'a taken name gets a number');
  assert.equal(await readFile(join(byName['claude/Work'].configDir, '.credentials.json'), 'utf8'), '{"claudeAiOauth":{"accessToken":"secret-claude"}}');
  assert.equal(await readFile(join(byName['codex/Personal (2)'].configDir, 'auth.json'), 'utf8'), '{"tokens":"secret-codex"}');
  assert.equal(await readFile(join(byName['gemini/Google'].configDir, '.gemini', 'oauth_creds.json'), 'utf8'), '{"refresh_token":"secret-gemini"}');
  await assert.rejects(stat(join(byName['claude/Work'].configDir, 'history.jsonl')), { code: 'ENOENT' });
  if (process.platform !== 'win32') assert.equal((await stat(join(byName['claude/Work'].configDir, '.credentials.json'))).mode & 0o777, 0o600);
  assert.ok(empty);
});

test('refuses a wrong passphrase, a changed file, a short passphrase and a file that is not an export', async t => {
  const [from, to] = await roots(t);
  await from.add('codex', 'One');
  const { content } = await exportAccounts(await from.list(), 'right passphrase');
  await assert.rejects(importAccounts(to, content, 'wrong passphrase'), /Wrong passphrase/);
  const file = JSON.parse(content.toString());
  file.data = Buffer.from('x' + Buffer.from(file.data, 'base64').toString('latin1').slice(1), 'latin1').toString('base64');
  await assert.rejects(importAccounts(to, Buffer.from(JSON.stringify(file)), 'right passphrase'), /Wrong passphrase|changed/);
  await assert.rejects(exportAccounts(await from.list(), 'short'), /at least 8/);
  await assert.rejects(importAccounts(to, Buffer.from('{"hello":1}'), 'right passphrase'), /not an xDev AI accounts file/);
  const greedy = { ...JSON.parse(content.toString()), kdf: { name: 'scrypt', N: 2 ** 30, r: 8, p: 1, salt: 'AA==' } };
  await assert.rejects(importAccounts(to, Buffer.from(JSON.stringify(greedy)), 'right passphrase'), /damaged/);
  assert.deepEqual(await to.list(), []);
});
