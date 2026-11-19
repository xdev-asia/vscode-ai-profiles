const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { basename, dirname, join } = require('node:path');
const { test } = require('node:test');
const { TerminalProfiles, terminalProfileId, terminalProfileEnv, findTerminalExecutable } = require('../dist/terminal-profiles.js');

test('Claude profiles remain independent across VS Code windows', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'xdev-claude-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const firstWindow = new TerminalProfiles(dir);
  const secondWindow = new TerminalProfiles(dir);
  assert.deepEqual(await firstWindow.list(), []);

  const [personal, work] = await Promise.all([
    firstWindow.add('claude', '  Cá nhân  '),
    secondWindow.add('claude', 'Công việc')
  ]);
  assert.notEqual(personal.configDir, work.configDir);
  await writeFile(join(personal.configDir, 'settings.json'), '{"account":"personal"}');
  await writeFile(join(work.configDir, 'settings.json'), '{"account":"work"}');
  assert.deepEqual(await secondWindow.list(), [personal, work]);
  assert.equal(dirname(personal.configDir), join(dir, 'claude'));
  assert.equal(terminalProfileId(personal), `claude:${basename(personal.configDir)}`);
  assert.equal(terminalProfileEnv(personal).CLAUDE_CONFIG_DIR, personal.configDir);
  assert.equal(terminalProfileEnv(work).CLAUDE_CONFIG_DIR, work.configDir);
  await secondWindow.rename(work, '  Work  ');
  assert.deepEqual(await firstWindow.list(), [personal, { ...work, name: 'Work' }]);
  assert.equal(await readFile(join(work.configDir, 'settings.json'), 'utf8'), '{"account":"work"}');
  await assert.rejects(firstWindow.rename({ ...work, configDir: dir }, 'Outside the store'), /Không tìm thấy/);
  await assert.rejects(firstWindow.add('claude', 'bad\nname'), /một dòng/);
});

test('terminal launches clear inherited overrides and reject non-executable paths', async () => {
  const env = terminalProfileEnv({ provider: 'claude', configDir: 'config' });
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
    'ANTHROPIC_PROFILE', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
    'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) {
    assert.equal(env[key], null);
  }
  assert.equal(await findTerminalExecutable('claude', tmpdir()), undefined);
  assert.equal(await findTerminalExecutable('claude', process.execPath), process.execPath);
  assert.equal(await findTerminalExecutable('claude', './claude'), undefined);
});

test('terminal accounts with identical labels use provider-specific home directories and IDs', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'xdev-terminal-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const profiles = new TerminalProfiles(dir);
  const claude = await profiles.add('claude', 'Work');
  const codex = await profiles.add('codex', 'Work');
  const gemini = await profiles.add('gemini', 'Work');
  assert.deepEqual(await profiles.list(), [claude, codex, gemini]);
  assert.deepEqual(await profiles.list('codex'), [codex]);
  assert.equal(new Set([claude, codex, gemini].map(terminalProfileId)).size, 3);
  const codexEnv = terminalProfileEnv(codex);
  assert.equal(codexEnv.CODEX_HOME, codex.configDir);
  assert.equal(codexEnv.CODEX_ACCESS_TOKEN, null);
  assert.equal(codexEnv.OPENAI_API_KEY, null);
  const geminiEnv = terminalProfileEnv(gemini);
  assert.equal(geminiEnv.GEMINI_CLI_HOME, gemini.configDir);
  assert.equal(geminiEnv.GEMINI_FORCE_FILE_STORAGE, 'true');
  assert.equal(geminiEnv.GEMINI_API_KEY, null);
});
