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
  assert.equal(tools.length, 6);
  const invoke = (name, args = {}) => client.callTool({ name: `xdev_${name}`, arguments: args });
  const call = async (name, args) => {
    const result = await invoke(name, args);
    assert.equal(result.isError, undefined, result.content[0].text);
    return JSON.parse(result.content[0].text);
  };
  assert.deepEqual(await call('accounts_list'), {
    api: [{ id: 'api1', name: 'Work', provider: 'openai', model: 'example' }],
    terminals: [{ id: 'claude:id', name: 'Personal', provider: 'claude' }]
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
