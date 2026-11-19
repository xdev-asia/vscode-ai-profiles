const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { basename, dirname, join } = require('node:path');
const { test } = require('node:test');
const { claudeLoginScript } = require('../dist/claude-login.js');
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

test('deleting an account only removes the selected profile directory and its data', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'xdev-delete-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const profiles = new TerminalProfiles(dir);
  const deleted = await profiles.add('claude', 'Work');
  const kept = await profiles.add('claude', 'Work');

  await writeFile(join(deleted.configDir, 'history.jsonl'), 'deleted profile');
  await writeFile(join(kept.configDir, 'history.jsonl'), 'kept profile');
  await assert.rejects(profiles.remove({ ...deleted, configDir: dir }), /no longer available/);
  await profiles.remove(deleted);

  assert.deepEqual(await new TerminalProfiles(dir).list(), [kept]);
  await assert.rejects(readFile(join(deleted.configDir, 'history.jsonl')), { code: 'ENOENT' });
  assert.equal(await readFile(join(kept.configDir, 'history.jsonl'), 'utf8'), 'kept profile');
});

test('remote Claude login opens the account only after status confirms sign-in', {
  skip: process.platform === 'win32'
}, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'xdev-login-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cli = join(dir, 'Claude Code');
  await writeFile(cli, [
    '#!/bin/sh',
    'case "$*" in',
    '  "auth login --claudeai") echo "Profile: $CLAUDE_CONFIG_DIR"; [ "$CASE" != login-fails ] || { echo "OAuth error detail" >&2; exit 1; } ;;',
    '  "auth status --text") [ "$CASE" != status-fails ] ;;',
    '  "") echo "Interactive Claude opened" ;;',
    '  *) exit 2 ;;',
    'esac',
    ''
  ].join('\n'), { mode: 0o700 });
  function launch(scenario) {
    const result = spawnSync('/bin/sh', ['-c', claudeLoginScript], {
      cwd: dir,
      env: { ...process.env, CASE: scenario, CLAUDE_CONFIG_DIR: dir, XDEV_AI_CLI_PATH: cli },
      input: 'echo "Fallback shell is still open"\nexit\n',
      encoding: 'utf8',
      timeout: 5_000
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes('Profile: ' + dir));
    return result;
  }
  const success = launch('success');
  assert.match(success.stdout, /Signed in.*\nInteractive Claude opened/);
  assert.doesNotMatch(success.stdout, /Fallback shell/);
  const failed = launch('login-fails');
  assert.match(failed.stderr, /OAuth error detail/);
  assert.match(failed.stdout, /sign-in exited with status 1/);
  assert.match(failed.stdout, /Fallback shell is still open/);
  const unconfirmed = launch('status-fails');
  assert.match(unconfirmed.stdout, /did not confirm sign-in/);
  assert.match(unconfirmed.stdout, /Fallback shell is still open/);
  assert.doesNotMatch(unconfirmed.stdout, /Interactive Claude opened/);
});
