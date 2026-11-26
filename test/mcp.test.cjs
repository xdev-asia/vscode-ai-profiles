const assert = require('node:assert/strict');
const Module = require('node:module');
const { test } = require('node:test');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { startMcp } = require('../dist/mcp-transport.js');
const { SquadChat } = require('../dist/squad-chat.js');
const { SquadStore } = require('../dist/squad.js');

test('MCP controls the shared workflow and requires approval for the current draft', { timeout: 10_000 }, async t => {
  let confirm;
  let prompt;
  const vscode = { window: { showWarningMessage(title, options, label) {
    prompt = { title, ...options, label };
    return new Promise(resolve => { confirm = resolve; });
  } } };
  const originalLoad = Module._load;
  t.mock.method(Module, '_load', function (name, ...args) {
    return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args);
  });
  const { xdevMcpTools } = require('../dist/mcp.js');
  const persisted = new Map();
  const storage = { get: key => persisted.get(key), update: async (key, value) => persisted.set(key, value) };
  const accounts = { read: async () => ({ accounts: [
    { id: 'api1', name: 'Work', provider: 'openai', model: 'example', apiKey: 'secret-key' }
  ] }) };
  const profiles = { list: async () => [{ provider: 'claude', name: 'Personal', configDir: '/secret-location/id' }] };
  const squad = new SquadChat(storage, accounts, new SquadStore(storage), () => {});
  const connection = await startMcp('0.0.0', xdevMcpTools(squad, accounts, profiles));
  t.after(() => connection.dispose());
  assert.equal((await fetch(connection.url, { method: 'POST' })).status, 401);
  assert.equal((await fetch(connection.url, { method: 'POST', headers: { ...connection.headers, Origin: 'https://example.com' } })).status, 403);
  assert.equal((await fetch(connection.url, {
    method: 'POST', headers: { ...connection.headers, 'Content-Type': 'application/json' }, body: 'a'.repeat(65_537)
  })).status, 413);

  const client = new Client({ name: 'xdev-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(connection.url), {
    requestInit: { headers: connection.headers }
  }));
  const { tools } = await client.listTools();
  assert.equal(tools.length, 8);
  const invoke = (name, args = {}) => client.callTool({ name: `xdev_${name}`, arguments: args });
  const call = async (name, args) => {
    const result = await invoke(name, args);
    assert.equal(result.isError, undefined, result.content[0].text);
    return JSON.parse(result.content[0].text);
  };
  assert.deepEqual(await call('accounts_list'), {
    api: [{ id: 'api1', name: 'Work', provider: 'openai', model: 'example', active: false }],
    terminals: [{ id: 'claude:id', name: 'Personal', provider: 'claude', signedIn: null }]
  });
  assert.equal((await call('workflow_status')).workflow, null);
  const { workflow } = await call('workflow_start', { brief: 'Add pagination' });
  const stage = { workflowId: workflow.id, step: 0 };
  assert.equal((await call('workflow_stage_context', stage)).brief, 'Add pagination');
  await call('workflow_submit_draft', { ...stage, draft: 'Keep offset paging and add cursors.' });
  assert.equal(squad.snapshot().workflow.draft, 'Keep offset paging and add cursors.');
  assert.equal((await invoke('workflow_submit_draft', { ...stage, draft: 'Overwrite' })).isError, true);

  let request = call('workflow_request_approval', stage);
  const waitForDialog = async () => {
    for (let tries = 0; tries < 100 && !confirm; tries++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(typeof confirm, 'function');
  };
  await waitForDialog();
  assert.equal(prompt.detail, squad.snapshot().workflow.draft);
  assert.equal(prompt.modal, true);
  confirm(undefined);
  confirm = undefined;
  assert.deepEqual(await request, { approved: false });
  assert.equal((await call('workflow_status')).workflow.stage, 'Plan');

  request = call('workflow_request_approval', stage);
  await waitForDialog();
  confirm(prompt.label);
  assert.equal((await request).workflow.stage, 'Implement');
  assert.deepEqual(squad.snapshot().workflow.approved, ['Keep offset paging and add cursors.']);
  assert.equal((await invoke('workflow_request_approval', stage)).isError, true);
  await squad.customizations.setTool('xdev_sdlc', false);
  assert.equal((await invoke('workflow_status')).isError, true);
});

test('MCP account tools follow the access level, confirm risky changes, and never expose account directories', { timeout: 20_000 }, async t => {
  const vscode = { window: { showWarningMessage: async () => undefined } };
  const originalLoad = Module._load;
  t.mock.method(Module, '_load', function (name, ...args) {
    return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args);
  });
  const { xdevMcpTools } = require('../dist/mcp.js');
  const { TerminalProfiles, terminalProfileId } = require('../dist/terminal-profiles.js');
  const { newMcpToken } = require('../dist/mcp-transport.js');
  const { mkdtemp, rm } = require('node:fs/promises');
  const { tmpdir } = require('node:os');
  const { join } = require('node:path');

  const dir = await mkdtemp(join(tmpdir(), 'xdev-mcp-accounts-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const profiles = new TerminalProfiles(dir);
  const busy = await profiles.add('claude', 'Busy');
  const free = await profiles.add('claude', 'Free');
  const out = await profiles.add('claude', 'Signed out');
  const codex = await profiles.add('codex', 'Codex');
  const ids = Object.fromEntries([busy, free, out, codex].map(profile => [profile.name, terminalProfileId(profile)]));
  const future = Date.now() + 3_600_000;
  const usage = {
    [ids.Busy]: { plan: 'max', windows: [{ label: '5h', used: 80, resetsAt: future }] },
    [ids.Free]: { plan: 'pro', windows: [{ label: '5h', used: 10, resetsAt: future }, { label: '7d', used: 30, resetsAt: future }] },
    [ids['Signed out']]: { windows: [], signedOut: true }
  };

  let level = 'off';
  let answer = false;
  const confirmations = [];
  const performed = [];
  const audited = [];
  let pool;
  const host = {
    level: () => level,
    usage: id => usage[id],
    refreshUsage: async () => {},
    perform: async (action, id) => { performed.push([action, id]); return action !== 'remove' || answer; },
    changed: () => {},
    confirm: async (title, detail) => { confirmations.push({ title, detail }); return answer; },
    audit: (action, ok, details) => audited.push({ action, ok, details }),
    addApiProfile: async () => true,
    removeApiProfile: async () => answer,
    setPool: async (mode, accounts) => { pool = { mode, accounts }; }
  };
  let selected;
  const accounts = {
    read: async () => ({ accounts: [{ id: 'api1', name: 'Key', provider: 'openai', model: 'm', apiKey: 'secret-key' }], activeId: 'api1' }),
    select: async id => { selected = id; }
  };
  const persisted = new Map();
  const storage = { get: key => persisted.get(key), update: async (key, value) => persisted.set(key, value) };
  const squad = new SquadChat(storage, accounts, new SquadStore(storage), () => {});

  const connect = async () => {
    const connection = await startMcp('0.0.0', xdevMcpTools(squad, accounts, profiles, host), { token: newMcpToken() });
    const client = new Client({ name: 'xdev-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(connection.url), { requestInit: { headers: connection.headers } }));
    t.after(async () => { await client.close(); connection.dispose(); });
    const invoke = (name, args = {}) => client.callTool({ name: `xdev_${name}`, arguments: args });
    const call = async (name, args) => {
      const result = await invoke(name, args);
      assert.equal(result.isError, undefined, result.content[0].text);
      return JSON.parse(result.content[0].text);
    };
    return { client, invoke, call, names: (await client.listTools()).tools.map(tool => tool.name) };
  };

  let session = await connect();
  assert.ok(!session.names.some(name => name.startsWith('xdev_account')));

  level = 'read';
  session = await connect();
  assert.ok(session.names.includes('xdev_accounts_pick'));
  assert.ok(!session.names.includes('xdev_account_remove'));
  const listing = await session.call('accounts_list');
  assert.doesNotMatch(JSON.stringify(listing), /secret-key|xdev-mcp-accounts|configDir/);
  assert.equal(listing.api[0].active, true);
  const free5h = listing.terminals.find(account => account.id === ids.Free);
  assert.deepEqual(free5h.quota.map(window => window.usedPercent), [10, 30]);
  assert.equal(listing.terminals.find(account => account.id === ids['Signed out']).signedIn, false);
  assert.equal((await session.call('accounts_pick', { provider: 'claude' })).account.id, ids.Free);

  level = 'manage';
  session = await connect();
  const { call, invoke, names } = session;
  assert.ok(names.includes('xdev_account_remove'));
  const removeTool = (await session.client.listTools()).tools.find(tool => tool.name === 'xdev_account_remove');
  assert.equal(removeTool.annotations.destructiveHint, true);

  const tagged = await call('account_set_tags', { id: ids.Free, tags: ['Team-A', 'backup'] });
  assert.deepEqual(tagged.tags, ['team-a', 'backup']);
  await call('account_set_note', { id: ids.Free, note: 'Owner: Lan' });
  await call('account_rename', { id: ids.Free, name: 'Free seat' });
  assert.equal((await call('account_usage', { id: ids.Free })).name, 'Free seat');
  assert.equal((await call('accounts_pick', { tag: 'backup' })).account.id, ids.Free);
  await call('account_set_disabled', { id: ids.Free, disabled: true });
  assert.equal((await call('accounts_pick', { provider: 'claude' })).account.id, ids.Busy);
  assert.equal((await invoke('terminal_open', { id: ids.Free })).isError, true);
  assert.equal((await invoke('account_set_tags', { id: ids.Free, tags: ['bad tag'] })).isError, true);
  assert.equal((await invoke('account_rename', { id: 'claude:missing', name: 'x' })).isError, true);

  assert.deepEqual(await call('terminal_open', { id: ids.Busy }), { done: true });
  assert.equal((await call('terminal_sign_in', { id: ids['Signed out'] })).done, false);
  assert.equal(confirmations.at(-1).detail.includes('xDev AI MCP'), true);
  answer = true;
  assert.deepEqual(await call('terminal_sign_in', { id: ids['Signed out'] }), { done: true });
  assert.deepEqual(performed, [['open', ids.Busy], ['signIn', ids['Signed out']]]);

  answer = false;
  assert.equal((await call('account_remove', { id: ids.Codex })).done, false);
  assert.equal((await call('api_profile_add', { provider: 'openai', name: 'New', model: 'gpt' })).done, false);
  answer = true;
  assert.deepEqual(await call('api_profile_add', { provider: 'openai', name: 'New', model: 'gpt' }), { done: true });
  assert.equal((await invoke('api_profile_add', { provider: 'openai', name: 'New', model: 'gpt', apiKey: 'x' })).isError, true);

  await call('api_profile_select', { id: 'api1' });
  assert.equal(selected, 'api1');
  await call('squad_set_pool', { mode: 'quota', accounts: [ids.Busy, ids.Free] });
  assert.deepEqual(pool, { mode: 'quota', accounts: [ids.Busy, ids.Free] });
  assert.equal((await invoke('squad_set_pool', { mode: 'quota', accounts: [ids.Codex] })).isError, true);

  assert.ok(audited.some(entry => entry.action === 'account_set_tags' && entry.ok));
  assert.ok(audited.some(entry => entry.action === 'squad_set_pool' && !entry.ok));
  assert.doesNotMatch(JSON.stringify(audited), /secret-key/);

  level = 'read';
  assert.equal((await invoke('account_set_disabled', { id: ids.Free, disabled: false })).isError, true);
});

test('MCP keeps a saved token and port, and reports a port in use', { timeout: 10_000 }, async t => {
  const { newMcpToken, validMcpToken } = require('../dist/mcp-transport.js');
  const token = newMcpToken();
  assert.equal(validMcpToken(token), true);
  const first = await startMcp('0.0.0', [], { token });
  t.after(() => first.dispose());
  assert.equal(first.headers.Authorization, `Bearer ${token}`);
  const port = Number(new URL(first.url).port);
  await assert.rejects(startMcp('0.0.0', [], { port, token }), /in use/);
  await assert.rejects(startMcp('0.0.0', [], { token: 'short' }), /not valid/);
});

test('the audit log records JSON lines and clips long values', async t => {
  const { AuditLog } = require('../dist/audit.js');
  const { mkdtemp, readFile, rm } = require('node:fs/promises');
  const { tmpdir } = require('node:os');
  const { join } = require('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'xdev-audit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const lines = [];
  const log = new AuditLog(join(dir, 'nested', 'audit.jsonl'), { appendLine: line => lines.push(line) });
  await log.record('mcp', 'account_set_note', true, { id: 'claude:x', note: 'n'.repeat(500) });
  await log.record('user', 'terminal_remove', false, { id: 'claude:y' }, new Error('gone'));
  const entries = (await readFile(log.file, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(entries.length, 2);
  assert.equal(entries[0].details.note.length, 201);
  assert.equal(entries[1].error, 'gone');
  assert.equal(lines.length, 2);
});
