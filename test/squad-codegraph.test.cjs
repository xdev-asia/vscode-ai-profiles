const assert = require('node:assert/strict');
const { mkdtemp, mkdir, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { test } = require('node:test');
const { exploreCode, exploreQuery, findRepositories, suggestRepository } = require('../dist/squad-codegraph.js');

test('explore queries keep plain words only', () => {
  assert.equal(exploreQuery('--path /etc; rm -rf $(x) thêm màn bil40 giống bil32'), '--path /etc rm -rf x thêm màn bil40 giống bil32');
  assert.equal(exploreQuery('`$`'), '');
});

test('CodeGraph context is optional, bounded, and never blocks planning', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'xdev-cg-'));
  try {
    const calls = [];
    const run = async (file, args, options) => { calls.push({ file, args, options }); return '\u001b[1mbil32Rules.ts\u001b[0m\n' + 'x'.repeat(7000); };
    assert.equal(await exploreCode(folder, 'bil32', { run }), undefined, 'no index, no call');
    assert.equal(calls.length, 0);
    await mkdir(join(folder, '.codegraph'));
    const text = await exploreCode(folder, 'giống bil32', { run });
    assert.match(text, /^bil32Rules\.ts\n/);
    assert.match(text, /\[Truncated\]$/);
    assert.deepEqual(calls[0].args, ['explore', '--max-files', '6', '-p', folder, '--', 'giống bil32']);
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
    for (const path of ['his/frontend/his-portal/.git', 'his/backend/his-service/.git', 'emr/.git', 'emr/emr-fe/.git', 'web/node_modules/pkg/.git']) {
      await mkdir(join(folder, path), { recursive: true });
    }
    const repos = await findRepositories(folder, async () => false);
    assert.deepEqual(repos, ['emr', 'emr/emr-fe', 'his/backend/his-service', 'his/frontend/his-portal']);
    assert.deepEqual(await findRepositories(folder, async path => path === folder), ['.']);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
  const repos = ['emr', 'emr/emr-fe', 'his/backend/his-service', 'his/frontend/his-portal'];
  assert.equal(suggestRepository(repos, ['Implement in his/frontend/his-portal: add src/domains/bil/pages/bil40']), 'his/frontend/his-portal');
  assert.equal(suggestRepository(repos, ['Sửa emr-fe để hiển thị', 'emr-fe']), 'emr/emr-fe');
  assert.equal(suggestRepository(repos, ['No repository here']), undefined);
  assert.equal(suggestRepository(['.'], ['anything']), '.');
});
