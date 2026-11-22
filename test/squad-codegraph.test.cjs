const assert = require('node:assert/strict');
const { mkdtemp, mkdir, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { test } = require('node:test');
const { exploreCode, exploreQuery, findRepositories, suggestRepository } = require('../dist/squad-codegraph.js');

test('explore queries keep plain words only', () => {
  assert.equal(exploreQuery('--path /etc; rm -rf $(x) thêm màn monthly giống daily'), '--path /etc rm -rf x thêm màn monthly giống daily');
  assert.equal(exploreQuery('`$`'), '');
});

test('CodeGraph context is optional, bounded, and never blocks planning', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'xdev-cg-'));
  try {
    const calls = [];
    const run = async (file, args, options) => { calls.push({ file, args, options }); return '\u001b[1mdailyRules.ts\u001b[0m\n' + 'x'.repeat(7000); };
    assert.equal(await exploreCode(folder, 'daily', { run }), undefined, 'no index, no call');
    assert.equal(calls.length, 0);
    await mkdir(join(folder, '.codegraph'));
    const text = await exploreCode(folder, 'giống daily', { run });
    assert.match(text, /^dailyRules\.ts\n/);
    assert.match(text, /\[Truncated\]$/);
    assert.deepEqual(calls[0].args, ['explore', '--max-files', '6', '-p', folder, '--', 'giống daily']);
    assert.equal(calls[0].options.timeoutMs, 20000);
    assert.equal(await exploreCode(folder, 'x', { run: async () => { throw new Error('timeout'); } }), undefined);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(exploreCode(folder, 'x', { signal: controller.signal, run: async () => { throw new Error('aborted'); } }));
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test('nested repositories are found and the plan suggests one', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'xdev-repos-'));
  try {
    for (const path of ['apps/web-portal/.git', 'services/billing-api/.git', 'clinic/.git', 'clinic/clinic-web/.git', 'web/node_modules/pkg/.git']) {
      await mkdir(join(folder, path), { recursive: true });
    }
    const repos = await findRepositories(folder, async () => false);
    assert.deepEqual(repos, ['apps/web-portal', 'clinic', 'clinic/clinic-web', 'services/billing-api']);
    assert.deepEqual(await findRepositories(folder, async path => path === folder), ['.']);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
  const repos = ['clinic', 'clinic/clinic-web', 'services/billing-api', 'apps/web-portal'];
  assert.equal(suggestRepository(repos, ['Implement in apps/web-portal: add src/pages/invoices/monthly']), 'apps/web-portal');
  assert.equal(suggestRepository(repos, ['Sửa clinic-web để hiển thị', 'clinic-web']), 'clinic/clinic-web');
  assert.equal(suggestRepository(repos, ['No repository here']), undefined);
  assert.equal(suggestRepository(['.'], ['anything']), '.');
});
