const assert = require('node:assert/strict');
const Module = require('node:module');
const { setImmediate: tick } = require('node:timers/promises');
const { test } = require('node:test');
const { Accounts } = require('../dist/accounts.js');
const { SquadChat } = require('../dist/squad-chat.js');
const { SquadStore } = require('../dist/squad.js');
const { workerModel } = require('../dist/squad-worker.js');

const roleNames = ['Lead', 'Implement', 'Review', 'Tests'];
const idOf = index => `claude:0000000${index}-0000-0000-0000-000000000000`;
function memento() {
  const values = new Map();
  return { get: key => values.get(key), update: async (key, value) => values.set(key, value) };
}
function report(output) {
  return JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.1, num_turns: 2, structured_output: output, session_id: 's' });
}

/** A Squad with a Claude Code account on every role; `sonnet` is the model configured for each role. */
async function squadWith(plan) {
  const storage = memento();
  const secrets = new Map();
  const accounts = new Accounts({ get: async key => secrets.get(key), store: async (key, value) => secrets.set(key, value) });
  const seats = new SquadStore(storage);
  const profiles = roleNames.map((role, index) => ({ provider: 'claude', name: `${role} account`, configDir: `/profiles/claude/0000000${index}-0000-0000-0000-000000000000` }));
  for (const [index, role] of roleNames.entries()) await seats.save(role, { account: idOf(index), brief: '', status: 'Ready', blocker: '' });
  const runs = [];
  const host = {
    profiles: async () => profiles, executable: async () => '/bin/claude', folder: () => '/repo',
    settings: () => ({ model: 'sonnet', budgetUsd: 1, allowedCommands: [], timeoutMs: 60_000 }),
    run: async request => {
      runs.push(request);
      return request.mode === 'plan' ? report(plan) : report({ status: 'done', summary: `${request.role} finished`, files_changed: [], tests: '', memory: [] });
    },
    worktrees: {
      async create(folder, id) { return { repo: folder, path: `${folder}/.wt/${id.slice(0, 8)}`, branch: `xdev/squad/${id.slice(0, 8)}`, base: 'base0' }; },
      async commit() { return { commit: 'c0ffee', stat: '', files: 1 }; },
      async remove() {}, async changedFiles() { return []; }, async changes() { return []; }, async discard() {}
    }
  };
  return { chat: new SquadChat(storage, accounts, seats, () => {}, host), accounts, profiles, runs };
}

async function settle(chat) {
  const end = Date.now() + 2_000;
  while (chat.snapshot().busy) {
    assert.ok(Date.now() < end, 'Squad did not settle');
    await tick();
  }
}

test('a model name is an alias or an id, nothing else', () => {
  assert.equal(workerModel(' haiku '), 'haiku');
  assert.equal(workerModel('claude-sonnet-5-5'), 'claude-sonnet-5-5');
  assert.equal(workerModel('opus[1m]'), 'opus[1m]');
  for (const bad of ['', 'haiku --dangerously-skip-permissions', 'a b', 'x'.repeat(81), 'model;rm', 7, null, undefined]) {
    assert.equal(workerModel(bad), undefined, String(bad));
  }
});

test('a lead through MCP chooses the model for each task, and the rest use the configured one', { timeout: 20_000 }, async t => {
  const originalLoad = Module._load;
  t.mock.method(Module, '_load', function (name, ...args) {
    return name === 'vscode' ? { window: { showWarningMessage: async () => undefined } } : originalLoad.call(this, name, ...args);
  });
  const { xdevMcpTools } = require('../dist/mcp.js');
  const { chat, accounts, profiles, runs } = await squadWith();
  const tools = xdevMcpTools(chat, accounts, { list: async () => profiles }, { level: () => 'off', squadLevel: () => 'run', confirm: async () => false });
  const signal = new AbortController().signal;
  const call = async (name, args = {}) => JSON.parse(JSON.stringify(await tools.find(tool => tool.name === `xdev_${name}`).run(args, signal)));
  const submit = tasks => call('squad_submit_plan', { request: 'Rename a helper and review it', summary: 'Cheap rename, careful review', tasks });

  await assert.rejects(submit([{ role: 'Implement', brief: 'Rename it', model: 'haiku --dangerously-skip-permissions' }]), /alias such as haiku, sonnet, or opus/);

  const { plan } = await submit([
    { role: 'Implement', brief: 'Rename the helper', model: 'haiku' },
    { role: 'Tests', brief: 'Run the tests' },
    { role: 'Review', brief: 'Review the design', model: 'opus' }
  ]);
  assert.deepEqual(plan.tasks.map(task => [task.role, task.model ?? null]), [['Implement', 'haiku'], ['Tests', null], ['Review', 'opus']]);
  assert.deepEqual(chat.snapshot().plan.jobs.map(job => job.model ?? null), ['haiku', null, 'opus'], 'the panel shows the choice');

  const { run } = await call('squad_approve_plan', { planId: plan.id });
  assert.deepEqual(run.steps.map(step => step.model ?? null), ['haiku', null, 'opus']);
  for (let step = 0; step < 3; step++) await call('squad_run_step', { runId: run.id });
  assert.deepEqual(runs.map(request => [request.role, request.settings.model]), [['Implement', 'haiku'], ['Tests', 'sonnet'], ['Review', 'opus']]);
  assert.equal(runs[0].settings.budgetUsd, 1, 'the other settings of the role are kept');
});

test('Squad\'s own Lead may set a model per task; a value that is not a model is dropped', { timeout: 20_000 }, async () => {
  const { chat, runs } = await squadWith({
    reply: 'Two steps',
    tasks: [
      { role: 'Implement', brief: 'Rename the helper', model: 'haiku' },
      { role: 'Review', brief: 'Review it', model: 'the best one please' }
    ]
  });
  await chat.send('Rename the helper');
  await settle(chat);
  assert.match(runs[0].system, /may set "model": "haiku" for simple mechanical work/);
  const plan = chat.pendingPlan();
  assert.deepEqual(plan.jobs.map(job => [job.role, job.model ?? null]), [['Implement', 'haiku'], ['Review', null]]);

  await (await chat.approve(plan.id)).finished;
  const record = chat.snapshot().runs[0];
  await (await chat.runStep(record.id)).finished;
  await (await chat.runStep(record.id)).finished;
  assert.deepEqual(runs.filter(request => request.mode === 'work').map(request => request.settings.model), ['haiku', 'sonnet']);
});
