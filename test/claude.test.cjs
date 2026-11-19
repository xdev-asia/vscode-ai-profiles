const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { test } = require('node:test');
const { ClaudeProfiles, claudeTerminalEnv, findClaudeExecutable } = require('../dist/claude-profiles.js');

test('Claude profiles remain independent across VS Code windows', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'xdev-claude-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, 'claude');
  const firstWindow = new ClaudeProfiles(root);
  const secondWindow = new ClaudeProfiles(root);
  assert.deepEqual(await firstWindow.list(), []);

  const [personal, work] = await Promise.all([
    firstWindow.add('  Cá nhân  '),
    secondWindow.add('Công việc')
  ]);
  assert.notEqual(personal.configDir, work.configDir);
  await writeFile(join(personal.configDir, 'settings.json'), '{"account":"personal"}');
  await writeFile(join(work.configDir, 'settings.json'), '{"account":"work"}');
  assert.deepEqual(await secondWindow.list(), [personal, work]);
  assert.equal(claudeTerminalEnv(personal.configDir).CLAUDE_CONFIG_DIR, personal.configDir);
  assert.equal(claudeTerminalEnv(work.configDir).CLAUDE_CONFIG_DIR, work.configDir);
  await secondWindow.rename(work.configDir, '  Work  ');
  assert.deepEqual(await firstWindow.list(), [personal, { name: 'Work', configDir: work.configDir }]);
  assert.equal(await readFile(join(work.configDir, 'settings.json'), 'utf8'), '{"account":"work"}');
  await assert.rejects(firstWindow.rename(dir, 'Outside the store'), /Không tìm thấy/);
  await assert.rejects(firstWindow.add('bad\nname'), /một dòng/);
});

test('terminal launches clear inherited overrides and reject non-executable paths', async () => {
  const env = claudeTerminalEnv('config');
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
    'ANTHROPIC_PROFILE', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
    'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) {
    assert.equal(env[key], null);
  }
  assert.equal(await findClaudeExecutable(tmpdir()), undefined);
  assert.equal(await findClaudeExecutable(process.execPath), process.execPath);
  assert.equal(await findClaudeExecutable('./claude'), undefined);
});
