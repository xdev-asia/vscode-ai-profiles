const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdir, mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { test } = require('node:test');
const { canCaptureClaudeQuota, claudeQuotaFile, readAccountUsage, readClaudeQuota } = require('../dist/account-usage.js');
const { TerminalProfiles } = require('../dist/terminal-profiles.js');

test('Codex reads each profile through App Server and preserves zero usage and reset times', async t => {
  const root = await mkdtemp(join(tmpdir(), 'xdev quota '));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const profiles = new TerminalProfiles(root);
  const personal = await profiles.add('codex', 'Personal');
  const work = await profiles.add('codex', 'Work');
  for (const [profile, plan, used] of [[personal, 'plus', 0], [work, 'pro', 42]]) {
    await writeFile(join(profile.configDir, 'fixture.json'), JSON.stringify({ plan, used }));
  }

  const windows = process.platform === 'win32';
  const executable = join(root, windows ? 'test-codex.cmd' : 'test-codex');
  const script = windows ? join(root, 'server.cjs') : executable;
  const reset = Math.floor(Date.now() / 1000) + 900;
  await writeFile(script, `${windows ? '' : '#!/usr/bin/env node\n'}
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createInterface } = require('node:readline');
assert.deepEqual(process.argv.slice(2), ['-c', 'cli_auth_credentials_store=file', 'app-server']);
assert.equal(process.env.CODEX_HOME.toLowerCase(), process.cwd().toLowerCase());
assert.equal(process.env.OPENAI_API_KEY, undefined);
const { plan, used } = JSON.parse(readFileSync('fixture.json', 'utf8'));
let initialized = false;
createInterface({ input: process.stdin }).on('line', line => {
  const { method, id, params } = JSON.parse(line);
  function reply(result) { console.log(JSON.stringify({ id, result })); }
  if (method === 'initialize') {
    assert.equal(params.clientInfo.version, '1.2.3-test');
    reply({});
  } else if (method === 'initialized') {
    initialized = true;
  } else if (method === 'account/read') {
    assert.ok(initialized);
    assert.equal(params.refreshToken, false);
    reply({ account: { type: 'chatgpt', planType: plan } });
  } else if (method === 'account/rateLimits/read') {
    reply({ rateLimitsByLimitId: {
      codex: { primary: { usedPercent: used, windowDurationMins: 300, resetsAt: ${reset} } },
      review: { limitName: 'Code Review', secondary: { usedPercent: 20, windowDurationMins: 10080 } }
    } });
  } else {
    assert.fail(method);
  }
});
`, { mode: 0o700 });
  if (windows) await writeFile(executable, '@echo off\r\nnode "%~dp0server.cjs" %*\r\n');

  for (const [profile, plan, used] of [[personal, 'plus', 0], [work, 'pro', 42]]) {
    const usage = await readAccountUsage(profile, executable, '1.2.3-test', new AbortController().signal);
    assert.equal(usage.plan, plan);
    assert.equal(usage.unavailable, false);
    assert.deepEqual(usage.windows, [
      { label: '5h', used, resetsAt: reset * 1000 },
      { label: 'Code Review · 7d', used: 20, resetsAt: undefined }
    ]);
  }
});

test('Claude stores numeric limits only and hides windows past reset', async t => {
  const root = await mkdtemp(join(tmpdir(), 'xdev-quota-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const reset = Math.floor(Date.now() / 1000) + 900;
  const input = {
    transcript_path: 'private',
    rate_limits: {
      five_hour: { used_percentage: 0, resets_at: reset, extra: 'private' },
      seven_day: { used_percentage: 87, resets_at: 1 },
      spend_limit: { used_percentage: 7, resets_at: 'private' }
    }
  };
  execFileSync(process.execPath, [join(__dirname, '..', 'media', 'claude-quota.cjs')], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: root }, input: JSON.stringify(input), timeout: 5000
  });
  assert.doesNotMatch(await readFile(join(root, claudeQuotaFile), 'utf8'), /private/);
  assert.deepEqual((await readClaudeQuota(root)).windows, [
    { label: '5h', used: 0, resetsAt: reset * 1000 },
    { label: 'Spend limit', used: 7, resetsAt: undefined }
  ]);

  const workspace = join(root, 'project');
  await mkdir(join(workspace, '.claude'), { recursive: true });
  assert.equal(await canCaptureClaudeQuota(root, workspace), true);
  await writeFile(join(workspace, '.claude', 'settings.local.json'), JSON.stringify({ statusLine: { type: 'command', command: 'custom' } }));
  assert.equal(await canCaptureClaudeQuota(root, workspace), false);
});
