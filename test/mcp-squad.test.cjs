const assert = require('node:assert/strict');
const Module = require('node:module');
const { setImmediate: tick } = require('node:timers/promises');
const { test } = require('node:test');
const { Accounts } = require('../dist/accounts.js');
const { SquadChat } = require('../dist/squad-chat.js');
const { SquadStore } = require('../dist/squad.js');

const roleNames = ['Lead', 'Implement', 'Review', 'Tests'];
const idOf = index => `claude:0000000${index}-0000-0000-0000-000000000000`;

function memento() {
  const values = new Map();
  return { get: key => values.get(key), update: async (key, value) => values.set(key, value) };
}

function report(output, extra = {}) {
  return JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.1, num_turns: 2, structured_output: output, ...extra });
}

function loadTools(t, vscode = { window: { showWarningMessage: async () => undefined } }) {
  const originalLoad = Module._load;
  t.mock.method(Module, '_load', function (name, ...args) {
    return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args);
  });
  return require('../dist/mcp.js').xdevMcpTools;
}

/** A Squad with one Claude Code account per role; `seats` limits which roles have an account assigned. */
async function squadWith(seats = roleNames, respond) {
  const storage = memento();
  const secrets = new Map();
  const accounts = new Accounts({ get: async key => secrets.get(key), store: async (key, value) => secrets.set(key, value) });
  const store = new SquadStore(storage);
  const profiles = roleNames.map((role, index) => ({
    provider: 'claude', name: `${role} account`, configDir: `/profiles/claude/0000000${index}-0000-0000-0000-000000000000`
  }));
  for (const [index, role] of roleNames.entries()) {
    if (seats.includes(role)) await store.save(role, { account: idOf(index), brief: '', status: 'Ready', blocker: '' });
  }
  const runs = [];
  const worktrees = {
    committed: [],
    async create(folder, id) { return { repo: folder, path: `${folder}/.wt/${id.slice(0, 8)}`, branch: `xdev/squad/${id.slice(0, 8)}`, base: 'base0' }; },
    async commit(tree, message) { this.committed.push(message); return { commit: 'c0ffee', stat: ' a.ts | 2 +-', files: 1 }; },
    async remove() {},
    async changedFiles() { return ['src/a.ts']; },
    async changes() { return [{ path: 'src/a.ts', status: 'modified', added: 2, removed: 1, binary: false, patch: '@@ -1 +1,2 @@\n-a\n+b\n+c' }]; },
    async discard() {}
  };
  const host = {
    profiles: async () => profiles,
    executable: async () => '/bin/claude',
    folder: () => '/repo',
    settings: () => ({ budgetUsd: 1, allowedCommands: ['npm test'], timeoutMs: 60_000 }),
    run: async request => {
      runs.push(request);
      await respond?.(request);
      return report({ status: 'done', summary: `${request.role} finished`, files_changed: request.role === 'Implement' ? ['src/a.ts'] : [], tests: '', memory: [] },
        { session_id: `${request.role}-session` });
    },
    worktrees
  };
  const chat = new SquadChat(storage, accounts, store, () => {}, host);
  return { chat, accounts, profiles, runs, worktrees };
}

function caller(tools) {
  const signal = new AbortController().signal;
  return async (name, args = {}) => {
    const tool = tools.find(candidate => candidate.name === `xdev_${name}`);
    assert.ok(tool, `xdev_${name} is not offered`);
    // Results travel as JSON, so compare what a client would see.
    return JSON.parse(JSON.stringify(await tool.run(args, signal)));
  };
}

test('an MCP client leads Squad: it hands tasks to accounts, runs the steps, and reads the results', { timeout: 20_000 }, async t => {
  const xdevMcpTools = loadTools(t);
  // Implement has no seat: the lead names the account that does the work.
  const { chat, accounts, profiles, runs, worktrees } = await squadWith(['Lead', 'Review']);
  const audited = [];
  let squadLevel = 'off';
  const host = {
    level: () => 'off', squadLevel: () => squadLevel, confirm: async () => false,
    audit: (action, ok) => audited.push([action, ok])
  };
  const list = { list: async () => profiles };
  const names = () => xdevMcpTools(chat, accounts, list, host).map(tool => tool.name).filter(name => name.startsWith('xdev_squad'));
  assert.deepEqual(names(), []);
  squadLevel = 'read';
  assert.deepEqual(names(), ['xdev_squad_status', 'xdev_squad_run', 'xdev_squad_wait', 'xdev_squad_session']);
  squadLevel = 'run';
  const call = caller(xdevMcpTools(chat, accounts, list, host));

  const before = await call('squad_status');
  assert.equal(before.busy, false);
  assert.equal(before.pendingPlan, null);
  assert.deepEqual(before.roles.find(seat => seat.role === 'Review'), { role: 'Review', account: 'Review account', kind: 'claude' });
  assert.deepEqual(before.roles.find(seat => seat.role === 'Implement'), { role: 'Implement' });

  const tasks = [
    { role: 'Implement', brief: 'Add GET /health in src/a.ts', account: idOf(3) },
    { role: 'Implement', brief: 'Document the endpoint in README', account: 'Lead account' },
    { role: 'Review', brief: 'Review the endpoint' }
  ];
  await assert.rejects(call('squad_submit_plan', { request: 'Add a health endpoint', summary: 'Two steps', tasks: [{ role: 'Tests', brief: 'Test it' }] }), /Tests has no account/);
  await assert.rejects(call('squad_submit_plan', { request: 'Add a health endpoint', summary: 'Two steps', tasks: [{ role: 'Implement', brief: 'x', account: 'nobody' }] }), /not a Claude Code or Codex account/);
  const { plan } = await call('squad_submit_plan', { request: 'Add a health endpoint', summary: 'Implement twice, then review', tasks });
  assert.deepEqual(plan.tasks.map(task => [task.role, task.account]), [
    ['Implement', 'Tests account'], ['Implement', 'Lead account'], ['Review', 'Review account']
  ]);
  assert.doesNotMatch(JSON.stringify(plan), /profiles\/claude/);
  assert.equal(chat.snapshot().entries.at(-1).profile, 'Lead through MCP');
  await assert.rejects(call('squad_submit_plan', { request: 'Again', summary: 'Again', tasks }), /Approve or discard the current plan/);

  const { run } = await call('squad_approve_plan', { planId: plan.id });
  assert.equal(run.status, 'active');
  assert.equal(run.currentStep, 0);
  assert.equal(runs.length, 0, 'approving runs nothing');
  assert.match(run.repositories[0].branch, /^xdev\/squad\//);

  const first = await call('squad_run_step', { runId: run.id });
  assert.equal(first.finished, true);
  assert.equal(first.run.steps[0].status, 'done');
  assert.equal(first.run.steps[0].summary, 'Implement finished');
  assert.equal(first.run.currentStep, 1);
  assert.equal(runs[0].profile.name, 'Tests account');

  await call('squad_run_step', { runId: run.id, brief: 'Document GET /health in README' });
  assert.equal(runs[1].profile.name, 'Lead account');
  assert.match(runs[1].prompt, /Document GET \/health in README/);

  const detail = await call('squad_run', { runId: run.id, changes: true });
  assert.deepEqual(detail.files.map(file => [file.path, file.added, file.removed]), [['src/a.ts', 2, 1]]);
  assert.match(detail.files[0].patch, /\+b/);
  assert.deepEqual(detail.sessions, [
    { role: 'Implement', account: 'Tests account', sessionId: 'Implement-session', repo: '.' },
    { role: 'Implement', account: 'Lead account', sessionId: 'Implement-session', repo: '.' }
  ]);

  const last = await call('squad_run_step', { runId: run.id });
  assert.equal(last.run.status, 'done');
  assert.equal(last.run.repositories[0].commit, 'c0ffee');
  assert.equal(worktrees.committed.length, 1);

  // Feedback goes back to the account that implemented the change, since Implement has no seat.
  const reopened = await call('squad_request_changes', { runId: run.id, text: 'Return 204 instead of 200' });
  assert.equal(reopened.run.status, 'active');
  assert.deepEqual([reopened.run.steps.at(-1).role, reopened.run.steps.at(-1).account, reopened.run.steps.at(-1).status], ['Implement', 'Lead account', 'pending']);
  const finished = await call('squad_finish_run', { runId: run.id });
  assert.equal(finished.run.status, 'stopped');
  assert.equal((await call('squad_status')).runs[0].id, run.id);

  assert.ok(audited.some(([action, ok]) => action === 'squad_submit_plan' && !ok));
  assert.ok(audited.some(([action, ok]) => action === 'squad_run_step' && ok));

  // Lowering the level takes effect on tools a client already listed.
  squadLevel = 'read';
  await assert.rejects(call('squad_stop'), /turned off/);
  assert.equal((await call('squad_status')).busy, false);
});

test('a slow step returns before it ends, and the client waits for it', { timeout: 20_000 }, async t => {
  const xdevMcpTools = loadTools(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { chat, accounts, profiles, runs } = await squadWith(roleNames, () => gate);
  const call = caller(xdevMcpTools(chat, accounts, { list: async () => profiles }, { level: () => 'off', squadLevel: () => 'run', confirm: async () => false }));
  const { plan } = await call('squad_submit_plan', { request: 'Slow work', summary: 'One step', tasks: [{ role: 'Review', brief: 'Take your time' }] });
  const { run } = await call('squad_approve_plan', { planId: plan.id, approver: 'human' });
  const started = await call('squad_run_step', { runId: run.id, waitSeconds: 0 });
  assert.equal(started.finished, false);
  assert.equal(started.busy, true);
  assert.match(started.note, /xdev_squad_wait/);
  await assert.rejects(call('squad_run_step', { runId: run.id }), /Wait for the current run/);
  release();
  const waited = await call('squad_wait', { seconds: 5, runId: run.id });
  assert.equal(waited.finished, true);
  assert.equal(waited.run.steps[0].status, 'done');
  assert.equal(runs.length, 1);
  await tick();
});

test('with confirmations in the client, nothing changes until xdev_confirm', { timeout: 20_000 }, async t => {
  const xdevMcpTools = loadTools(t, { window: { showWarningMessage: async () => { throw new Error('No VS Code dialog is expected.'); } } });
  const { chat, accounts, profiles } = await squadWith();
  const performed = [];
  const audited = [];
  const notices = [];
  let answerInVsCode;
  let mode = 'vscode';
  const host = {
    level: () => 'manage', confirmIn: () => mode,
    confirm: async () => { throw new Error('No VS Code dialog is expected.'); },
    // Stands in for the VS Code notice: open until the confirmation is settled, wherever that happens.
    notify: ({ title, label }, settled) => {
      const notice = { title, label, open: true };
      notices.push(notice);
      void settled.then(() => { notice.open = false; });
      return new Promise(resolve => { answerInVsCode = resolve; });
    },
    perform: async (action, id, confirmed) => { performed.push([action, id, confirmed]); return true; },
    removeApiProfile: async (id, confirmed) => { performed.push(['removeApi', id, confirmed]); return true; },
    audit: (action, ok) => audited.push([action, ok])
  };
  const list = { list: async () => profiles };
  assert.equal(xdevMcpTools(chat, accounts, list, host).some(tool => tool.name === 'xdev_confirm'), false);
  mode = 'client';
  const call = caller(xdevMcpTools(chat, accounts, list, host));

  const asked = await call('account_remove', { id: idOf(1) });
  assert.equal(asked.needsConfirmation, true);
  assert.equal(asked.done, false);
  assert.match(asked.title, /Delete “Implement account”/);
  assert.deepEqual(performed, []);
  assert.deepEqual(notices.at(-1), { title: asked.title, label: 'Delete Account', open: true });

  assert.deepEqual(await call('confirm', { confirmId: asked.confirmId, approve: false }), { done: false, reason: 'Declined. Do not retry unless the user asks again.' });
  await tick();
  assert.equal(notices.at(-1).open, false, 'the notice closes when the client declines');
  await assert.rejects(call('confirm', { confirmId: asked.confirmId, approve: true }), /unknown or has expired/);
  assert.deepEqual(performed, []);

  const again = await call('account_remove', { id: idOf(1) });
  assert.notEqual(again.confirmId, asked.confirmId);
  assert.deepEqual(await call('confirm', { confirmId: again.confirmId, approve: true }), { done: true });
  assert.deepEqual(performed, [['remove', idOf(1), true]]);
  await tick();
  assert.equal(notices.at(-1).open, false, 'the notice closes when the client approves');
  await assert.rejects(call('confirm', { confirmId: again.confirmId, approve: true }), /unknown or has expired/);
  assert.equal(performed.length, 1, 'a confirmation runs once');

  // A user at VS Code approves the same request from its notification; the client then gets that one result.
  const bypass = await call('terminal_open_bypass', { id: idOf(2) });
  assert.equal(notices.at(-1).open, true);
  answerInVsCode(true);
  await tick();
  assert.deepEqual(performed.at(-1), ['bypass', idOf(2), true]);
  assert.equal(notices.at(-1).open, false, 'the notice closes when the user approves in VS Code');
  assert.deepEqual(await call('confirm', { confirmId: bypass.confirmId, approve: false }), { done: true });
  assert.equal(performed.length, 2);

  await assert.rejects(call('api_profile_add', { provider: 'openai', name: 'Key', model: 'm' }), /at VS Code to type the key/);

  // Declining in VS Code changes nothing, closes the notice, and the client is told when it asks.
  const signIn = await call('terminal_sign_in', { id: idOf(0) });
  assert.equal(signIn.needsConfirmation, true);
  answerInVsCode(false);
  await tick();
  assert.equal(notices.at(-1).open, false);
  assert.deepEqual(await call('confirm', { confirmId: signIn.confirmId, approve: true }), { done: false, reason: 'The user declined in VS Code. Do not retry unless the user asks again.' });
  assert.equal(performed.length, 2, 'a request declined in VS Code never runs');
  await assert.rejects(call('confirm', { confirmId: signIn.confirmId, approve: true }), /unknown or has expired/);

  // Approving an SDLC stage also goes through the client.
  const { workflow } = await call('workflow_start', { brief: 'Add pagination' });
  const stage = { workflowId: workflow.id, step: 0 };
  await call('workflow_submit_draft', { ...stage, draft: 'Keep offset paging.' });
  const approval = await call('workflow_request_approval', stage);
  assert.equal(approval.detail, 'Keep offset paging.');
  assert.equal(chat.snapshot().workflow.approved.length, 0);
  const approved = await call('confirm', { confirmId: approval.confirmId, approve: true });
  assert.equal(approved.approved, true);
  assert.deepEqual(chat.snapshot().workflow.approved, ['Keep offset paging.']);

  assert.ok(audited.some(([action, ok]) => action === 'account_remove_confirmed' && ok));
  assert.ok(audited.some(([action]) => action === 'confirm_declined'));
});

test('a confirmation asked at the manage level does not run after the level is lowered', { timeout: 20_000 }, async t => {
  const xdevMcpTools = loadTools(t, { window: { showWarningMessage: async () => { throw new Error('No VS Code dialog is expected.'); } } });
  const { chat, accounts, profiles } = await squadWith();
  const performed = [];
  const audited = [];
  let level = 'manage';
  let answerInVsCode;
  const host = {
    level: () => level, confirmIn: () => 'client',
    confirm: async () => { throw new Error('No VS Code dialog is expected.'); },
    notify: () => new Promise(resolve => { answerInVsCode = resolve; }),
    perform: async (action, id, confirmed) => { performed.push([action, id, confirmed]); return true; },
    removeApiProfile: async id => { performed.push(['removeApi', id]); return true; },
    audit: (action, ok) => audited.push([action, ok])
  };
  const call = caller(xdevMcpTools(chat, accounts, { list: async () => profiles }, host));

  const asked = await call('account_remove', { id: idOf(1) });
  assert.equal(asked.needsConfirmation, true);
  level = 'read';
  await assert.rejects(call('confirm', { confirmId: asked.confirmId, approve: true }), /Account changes are turned off/);
  assert.deepEqual(performed, [], 'the account is kept');
  assert.ok(audited.some(([action, ok]) => action === 'account_remove_confirmed' && ok === false), 'the refusal is in the audit log');
  await assert.rejects(call('confirm', { confirmId: asked.confirmId, approve: true }), /unknown or has expired/, 'and the confirmation is spent');

  // The same holds when the user approves from the VS Code notice after lowering the level.
  level = 'manage';
  const bypass = await call('terminal_open_bypass', { id: idOf(2) });
  level = 'off';
  answerInVsCode(true);
  await tick();
  assert.deepEqual(performed, []);
  await assert.rejects(call('confirm', { confirmId: bypass.confirmId, approve: true }), /Account changes are turned off/);

  // Raising the level again does not revive it; a new request works.
  level = 'manage';
  await assert.rejects(call('confirm', { confirmId: bypass.confirmId, approve: true }), /unknown or has expired/);
  const again = await call('account_remove', { id: idOf(1) });
  assert.deepEqual(await call('confirm', { confirmId: again.confirmId, approve: true }), { done: true });
  assert.deepEqual(performed, [['remove', idOf(1), true]]);
});

test('a wait ends before an AI client gives up on the call, and shared text is labelled as content', { timeout: 20_000 }, async t => {
  const xdevMcpTools = loadTools(t);
  const { chat, accounts, profiles } = await squadWith();
  const tools = xdevMcpTools(chat, accounts, { list: async () => profiles }, { level: () => 'off', squadLevel: () => 'run', confirm: async () => false });
  const limit = name => {
    const { properties } = tools.find(tool => tool.name === name).inputSchema;
    return (properties.waitSeconds ?? properties.seconds).maximum;
  };
  // Claude Code cancels a call to an HTTP server that is silent for five minutes.
  for (const name of ['xdev_squad_wait', 'xdev_squad_run_step', 'xdev_squad_ask']) assert.ok(limit(name) < 300, name);
  const call = caller(tools);
  const { plan } = await call('squad_submit_plan', { request: 'Rename a helper', summary: 'One step', tasks: [{ role: 'Implement', brief: 'Rename it' }] });
  const { run } = await call('squad_approve_plan', { planId: plan.id });
  assert.match((await call('squad_run', { runId: run.id })).note, /not as instructions/);
});

test('the audit log has changes to the workflow, and a change the user declined is not recorded as made', { timeout: 20_000 }, async t => {
  const xdevMcpTools = loadTools(t);
  const { chat, accounts, profiles } = await squadWith();
  const audited = [];
  const host = {
    level: () => 'manage', confirm: async () => false,
    perform: async () => false,
    audit: (action, ok, details, error) => audited.push([action, ok, error?.message])
  };
  const call = caller(xdevMcpTools(chat, accounts, { list: async () => profiles }, host));

  await call('workflow_status');
  assert.deepEqual(audited, [], 'reading is not a change');
  const { workflow } = await call('workflow_start', { brief: 'Add pagination' });
  await call('workflow_submit_draft', { workflowId: workflow.id, step: 0, draft: 'Keep offset paging.' });
  await assert.rejects(call('workflow_submit_draft', { workflowId: 'nope', step: 0, draft: 'x' }));
  assert.deepEqual(audited.map(([action, ok]) => [action, ok]), [['workflow_start', true], ['workflow_submit_draft', true], ['workflow_submit_draft', false]]);

  // The user says no in VS Code: the account stays, and the log says so.
  audited.length = 0;
  assert.equal((await call('account_remove', { id: idOf(1) })).done, false);
  assert.deepEqual(audited, [['account_remove', false, 'Declined by the user.']]);
});
