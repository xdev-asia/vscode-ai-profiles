const assert = require('node:assert/strict');
const Module = require('node:module');
const { existsSync, readFileSync } = require('node:fs');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { after, test } = require('node:test');
const { JSDOM } = require('jsdom');
const { Accounts } = require('../dist/accounts.js');
const { SquadArtifacts, artifactLimit } = require('../dist/squad-artifacts.js');
const { SquadChat } = require('../dist/squad-chat.js');
const { squadPage } = require('../dist/squad-html.js');
const { SquadStore } = require('../dist/squad.js');

async function store(t) {
  const dir = await mkdtemp(join(tmpdir(), 'xdev-artifacts-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, artifacts: new SquadArtifacts(join(dir, 'shared')) };
}

test('shared artifacts are saved, replaced by name, read, and removed', async t => {
  const { artifacts } = await store(t);
  assert.deepEqual(await artifacts.list(), []);

  const first = await artifacts.save({ name: '  API   design ', content: '# Design\n', description: 'Endpoints and errors', link: 'https://claude.ai/artifact/abc' }, 'dev-1', 'run-1');
  assert.deepEqual([first.name, first.kind, first.author, first.run, first.version, first.size, first.link],
    ['API design', 'markdown', 'dev-1', 'run-1', 1, 9, 'https://claude.ai/artifact/abc']);
  assert.equal(await readFile(artifacts.file(first), 'utf8'), '# Design\n');
  assert.match(artifacts.file(first), /\.md$/);

  // The author saves again without a link: the page it can update is kept.
  const again = await artifacts.save({ name: 'API design', content: '# Design v2\n' }, 'dev-1');
  assert.deepEqual([again.version, again.link], [2, 'https://claude.ai/artifact/abc']);

  // Another account saves under the same name: one artifact, new content and author. The page belongs to the
  // first account and still shows the old document, so the link goes.
  const second = await artifacts.save({ name: 'api DESIGN', content: '<h1>Design</h1>', kind: 'html' }, 'dev-2');
  assert.deepEqual([second.id, second.kind, second.author, second.version, second.link, second.run, second.description],
    [first.id, 'html', 'dev-2', 3, undefined, 'run-1', 'Endpoints and errors']);
  assert.equal(existsSync(artifacts.file(first)), false, 'the file of the old kind is gone');
  assert.equal((await artifacts.list()).length, 1);
  assert.equal((await artifacts.read('API DESIGN')).content, '<h1>Design</h1>');
  assert.equal((await artifacts.read(first.id)).name, 'api DESIGN');

  await artifacts.save({ name: 'Test report', content: 'All pass', kind: 'text' }, 'dev-3');
  assert.deepEqual((await artifacts.list()).map(item => item.name), ['Test report', 'api DESIGN'], 'newest first');
  const context = await artifacts.context();
  assert.deepEqual(context.map(({ name, kind, by }) => [name, kind, by]), [['Test report', 'text', 'dev-3'], ['api DESIGN', 'html', 'dev-2']]);
  assert.equal(readFileSync(context[0].file, 'utf8'), 'All pass');

  await assert.rejects(artifacts.save({ name: '', content: 'x' }, 'a'), /name of 1 to 80/);
  await assert.rejects(artifacts.save({ name: 'x', content: '  ' }, 'a'), /content of up to 200,000/);
  await assert.rejects(artifacts.save({ name: 'x', content: 'y'.repeat(200_001) }, 'a'), /content of up to/);
  await assert.rejects(artifacts.save({ name: 'x', content: 'y', kind: 'exe' }, 'a'), /kind is one of/);
  for (const link of ['http://claude.ai/artifact/1', 'https://example.com/claude.ai', 'https://claude.ai.evil.example/x', 'javascript:alert(1)', 'https://user@claude.ai/x']) {
    await assert.rejects(artifacts.save({ name: 'x', content: 'y', link }, 'a'), /claude\.ai artifact address/, link);
  }
  // A worker's bad entry is skipped; the good one is kept.
  const saved = await artifacts.saveAll([{ name: 'Notes', content: 'n' }, { name: 'Bad' }, { content: 'no name' }], 'dev-1');
  assert.deepEqual(saved.map(item => item.name), ['Notes']);

  await artifacts.remove('test REPORT');
  assert.deepEqual((await artifacts.list()).map(item => item.name).sort(), ['Notes', 'api DESIGN']);
  await assert.rejects(artifacts.read('Test report'), /no artifact with that name/);
  await assert.rejects(artifacts.remove('nothing'), /no artifact with that name/);

  // Another window of the same project sees the same artifacts.
  assert.equal((await new SquadArtifacts(artifacts.dir).list()).length, 2);
});

test('a project keeps a fixed number of artifacts and refuses more', async t => {
  const { artifacts } = await store(t);
  for (let index = 0; index < artifactLimit; index++) await artifacts.save({ name: `Doc ${index}`, content: 'x' }, 'a');
  await assert.rejects(artifacts.save({ name: 'One more', content: 'x' }, 'a'), /Remove one first/);
  // Replacing an existing one still works.
  assert.equal((await artifacts.save({ name: 'Doc 0', content: 'y' }, 'b')).version, 2);
});

const roleNames = ['Lead', 'Implement', 'Review', 'Tests'];
const idOf = index => `claude:0000000${index}-0000-0000-0000-000000000000`;
function memento() {
  const values = new Map();
  return { get: key => values.get(key), update: async (key, value) => values.set(key, value) };
}
function report(output, extra = {}) {
  return JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.1, num_turns: 2, structured_output: output, ...extra });
}

async function squadWith(t, respond) {
  const { artifacts } = await store(t);
  const storage = memento();
  const secrets = new Map();
  const accounts = new Accounts({ get: async key => secrets.get(key), store: async (key, value) => secrets.set(key, value) });
  const seats = new SquadStore(storage);
  const profiles = roleNames.map((role, index) => ({ provider: 'claude', name: `${role} account`, configDir: `/profiles/claude/0000000${index}-0000-0000-0000-000000000000` }));
  for (const [index, role] of roleNames.entries()) await seats.save(role, { account: idOf(index), brief: '', status: 'Ready', blocker: '' });
  const runs = [];
  const host = {
    profiles: async () => profiles, executable: async () => '/bin/claude', folder: () => '/repo',
    settings: () => ({ budgetUsd: 1, allowedCommands: [], timeoutMs: 60_000 }),
    run: async request => { runs.push(request); return respond(request); },
    worktrees: {
      async create(folder, id) { return { repo: folder, path: `${folder}/.wt/${id.slice(0, 8)}`, branch: `xdev/squad/${id.slice(0, 8)}`, base: 'base0' }; },
      async commit() { return { commit: 'c0ffee', stat: '', files: 1 }; },
      async remove() {}, async changedFiles() { return []; }, async changes() { return []; }, async discard() {}
    }
  };
  return { chat: new SquadChat(storage, accounts, seats, () => {}, host, artifacts), accounts, profiles, runs, artifacts };
}

function loadTools(t) {
  const originalLoad = Module._load;
  t.mock.method(Module, '_load', function (name, ...args) {
    return name === 'vscode' ? { window: { showWarningMessage: async () => undefined } } : originalLoad.call(this, name, ...args);
  });
  return require('../dist/mcp.js').xdevMcpTools;
}

test('one account\'s worker saves an artifact and the next account\'s worker is told where to read it', { timeout: 20_000 }, async t => {
  const xdevMcpTools = loadTools(t);
  const { chat, accounts, profiles, runs, artifacts } = await squadWith(t, request => request.role === 'Implement'
    ? report({
      status: 'done', summary: 'Designed the endpoint', files_changed: [], tests: '', memory: [],
      artifacts: [{ name: 'Health endpoint design', kind: 'markdown', description: 'Route and response', content: '# GET /health\nReturns 204.' }, { name: 'Broken' }]
    })
    : report({ status: 'done', summary: 'Matches the design', files_changed: [], tests: '', memory: [] }));
  const tools = xdevMcpTools(chat, accounts, { list: async () => profiles }, { level: () => 'off', squadLevel: () => 'run', confirm: async () => false });
  const signal = new AbortController().signal;
  const call = async (name, args = {}) => JSON.parse(JSON.stringify(await tools.find(tool => tool.name === `xdev_${name}`).run(args, signal)));

  const { plan } = await call('squad_submit_plan', {
    request: 'Design a health endpoint', summary: 'Design, then review',
    tasks: [{ role: 'Implement', brief: 'Write the design' }, { role: 'Review', brief: 'Check the design' }]
  });
  const { run } = await call('squad_approve_plan', { planId: plan.id });
  await call('squad_run_step', { runId: run.id });

  // The first worker had nothing to read, and what it returned is now shared under its account.
  assert.equal(JSON.parse(runs[0].prompt).artifacts, undefined);
  assert.match(runs[0].system, /"artifacts" lists documents that every account of this project shares/);
  const [saved] = await artifacts.list();
  assert.deepEqual([saved.name, saved.author, saved.run, saved.description], ['Health endpoint design', 'Implement account', run.id, 'Route and response']);
  assert.match(chat.snapshot().entries.find(entry => entry.author === 'Implement').text, /Artifacts: Health endpoint design$/);

  // The second worker, under another account, gets the list with a file it can read.
  await call('squad_run_step', { runId: run.id });
  assert.equal(runs[1].profile.name, 'Review account');
  const shared = JSON.parse(runs[1].prompt).artifacts;
  assert.deepEqual(shared.map(({ name, kind, description, by }) => ({ name, kind, description, by })),
    [{ name: 'Health endpoint design', kind: 'markdown', description: 'Route and response', by: 'Implement account' }]);
  assert.equal(readFileSync(shared[0].file, 'utf8'), '# GET /health\nReturns 204.');

  // An AI client reads the same artifact through MCP, and saves its own with the page it published on claude.ai.
  const listed = await call('artifacts_list');
  assert.deepEqual(listed.artifacts.map(item => [item.name, item.by, item.characters]), [['Health endpoint design', 'Implement account', 26]]);
  assert.doesNotMatch(JSON.stringify(listed), /shared|xdev-artifacts/, 'no folder of the store is returned');
  assert.equal((await call('artifact_read', { name: 'health endpoint DESIGN' })).content, '# GET /health\nReturns 204.');
  const mine = await call('artifact_save', { name: 'Release plan', content: '<h1>Plan</h1>', kind: 'html', link: 'https://claude.ai/code/artifact/123', by: 'quynn14' });
  assert.deepEqual([mine.saved.name, mine.saved.by, mine.saved.kind, mine.saved.link], ['Release plan', 'quynn14 (MCP)', 'html', 'https://claude.ai/code/artifact/123']);
  await assert.rejects(call('artifact_save', { name: 'Bad link', content: 'x', link: 'https://example.com/x' }), /claude\.ai artifact address/);
  assert.equal((await call('artifact_save', { name: 'No author', content: 'x' })).saved.by, 'MCP client');
  assert.equal((await artifacts.list()).length, 3);
});

test('artifact tools follow the Squad control level', async t => {
  const xdevMcpTools = loadTools(t);
  const { chat, accounts, profiles } = await squadWith(t, () => report({ status: 'done', summary: 'ok', files_changed: [], tests: '', memory: [] }));
  let level = 'off';
  const names = () => xdevMcpTools(chat, accounts, { list: async () => profiles }, { level: () => 'off', squadLevel: () => level, confirm: async () => false })
    .map(tool => tool.name).filter(name => name.includes('artifact'));
  assert.deepEqual(names(), []);
  level = 'read';
  assert.deepEqual(names(), ['xdev_artifacts_list', 'xdev_artifact_read']);
  level = 'run';
  assert.deepEqual(names(), ['xdev_artifacts_list', 'xdev_artifact_read', 'xdev_artifact_save']);
});

const windows = [];
after(() => { for (const window of windows) window.close(); });

test('the panel lists shared artifacts with their author and claude.ai page', () => {
  const media = join(__dirname, '..', 'media');
  const html = squadPage({ cspSource: 'test:', nonce: 'n', script: 'squad.js', chatScript: 'squad-chat.js', workspaceScript: 'squad-workspace.js', style: 'squad.css' })
    .replace(/<script[^>]*><\/script>/g, '').replace(/<link[^>]*>/g, '');
  const { window } = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  windows.push(window);
  const sent = [];
  let saved;
  window.acquireVsCodeApi = () => ({ postMessage: message => sent.push(JSON.parse(JSON.stringify(message))), getState: () => saved, setState: value => { saved = value; } });
  for (const file of ['squad-chat.js', 'squad-workspace.js', 'squad.js']) window.eval(readFileSync(join(media, file), 'utf8'));
  const $ = selector => window.document.querySelector(selector);
  const click = node => node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const seats = Object.fromEntries(roleNames.map(role => [role, { account: '', brief: '', status: 'Ready', blocker: '' }]));
  const state = artifacts => ({
    type: 'state', seats, activity: [], accounts: [], running: [], errors: {}, nativeChatTools: [], customizations: { skills: [], disabledTools: [] }, memory: [],
    sync: { folder: '', profiles: true, approver: 'human', workers: { budgetUsd: 1, allowedCommands: [], models: {}, repositoryCommands: {} } },
    teamChat: { entries: [], runs: [], workers: true, busy: false, status: '' }, artifacts
  });

  window.dispatchEvent(new window.MessageEvent('message', { data: state([]) }));
  assert.equal($('#show-memory').textContent, 'Memory & Artifacts');
  assert.match($('#artifact-list').textContent, /No artifacts yet/);

  window.dispatchEvent(new window.MessageEvent('message', { data: state([
    { id: 'a1', name: 'Release plan', kind: 'html', description: 'Steps for 0.19', author: 'quynn14 (MCP)', updated: 1_700_000_000_000, version: 2, size: 12, link: 'https://claude.ai/code/artifact/123' },
    { id: 'a2', name: 'Health endpoint design', kind: 'markdown', description: '', author: 'dev-1', updated: 1_600_000_000_000, version: 1, size: 26 }
  ]) }));
  const rows = [...window.document.querySelectorAll('#artifact-list li')];
  assert.equal(rows.length, 2);
  assert.equal(rows[0].querySelector('strong').textContent, 'Release plan');
  assert.match(rows[0].querySelector('small').textContent, /^html · by quynn14 \(MCP\) · .* · saved 2 times$/);
  assert.equal(rows[0].querySelector('span').textContent, 'Steps for 0.19');
  assert.deepEqual([...rows[0].querySelectorAll('button')].map(button => button.textContent), ['Open', 'claude.ai page', 'Remove']);
  assert.deepEqual([...rows[1].querySelectorAll('button')].map(button => button.textContent), ['Open', 'Remove'], 'no page button without a link');

  click(rows[0].querySelectorAll('button')[1]);
  assert.deepEqual(sent.at(-1), { type: 'workspace', action: 'openArtifactLink', id: 'a1' });
  window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'workspaceSettled' } }));
  click(window.document.querySelectorAll('#artifact-list li')[1].querySelectorAll('button')[1]);
  assert.deepEqual(sent.at(-1), { type: 'workspace', action: 'removeArtifact', id: 'a2' });
  window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'workspaceSettled' } }));
  click($('#artifact-add'));
  assert.deepEqual(sent.at(-1), { type: 'workspace', action: 'addArtifact' });
});

test('two windows that save at the same time both keep their artifact', async t => {
  const { dir } = await store(t);
  const { SquadArtifacts } = require('../dist/squad-artifacts.js');
  // Each window has its own store object on the same folder.
  const windows = Array.from({ length: 4 }, () => new SquadArtifacts(join(dir, 'shared')));
  await Promise.all(windows.flatMap((window, index) => [0, 1, 2].map(round =>
    window.save({ name: `Doc ${index}-${round}`, content: `from window ${index}` }, `dev-${index}`))));
  const names = (await windows[0].list()).map(item => item.name).sort();
  assert.equal(names.length, 12, `every save is in the index: ${names.join(', ')}`);
  assert.equal(existsSync(join(dir, 'shared', 'index.lock')), false, 'the lock is released');

  // A lock left by a window that died is taken over after a while.
  const { mkdirSync, utimesSync } = require('node:fs');
  mkdirSync(join(dir, 'shared', 'index.lock'));
  const old = new Date(Date.now() - 60_000);
  utimesSync(join(dir, 'shared', 'index.lock'), old, old);
  await windows[1].save({ name: 'After a crash', content: 'still works' }, 'dev-1');
  assert.equal((await windows[2].list()).length, 13);
});
