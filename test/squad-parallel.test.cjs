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
function report(output) {
  return JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.1, num_turns: 2, structured_output: output, session_id: 's' });
}

/**
 * A Squad whose workers do not finish until the test lets them: `release(text)` ends the work whose brief holds
 * `text`. `plan` is what Squad's own Lead answers, at once or, with `holdPlan`, on `release('LEAD')`.
 */
async function squadWith({ options = {}, plan, holdPlan = false } = {}) {
  const storage = memento();
  const secrets = new Map();
  const accounts = new Accounts({ get: async key => secrets.get(key), store: async (key, value) => secrets.set(key, value) });
  const seats = new SquadStore(storage);
  const profiles = roleNames.map((role, index) => ({ provider: 'claude', name: `${role} account`, configDir: `/profiles/claude/0000000${index}-0000-0000-0000-000000000000` }));
  for (const [index, role] of roleNames.entries()) await seats.save(role, { account: idOf(index), brief: '', status: 'Ready', blocker: '' });
  const waiting = new Map();
  const started = [];
  const worktrees = {
    created: [], committed: [], removed: [], titles: [],
    async create(folder, id) {
      const tree = { repo: folder, path: `${folder}/.wt/${id.slice(0, 8)}`, branch: `xdev/squad/${id.slice(0, 8)}`, base: 'base0' };
      this.created.push(tree);
      return tree;
    },
    async commit(tree, title) { this.committed.push(tree.branch); this.titles.push(title); return { commit: 'c0ffee', stat: '', files: 1 }; },
    async remove(tree) { this.removed.push(tree.branch); },
    async changedFiles() { return []; }, async changes() { return []; }, async discard() {}
  };
  const host = {
    profiles: async () => profiles, executable: async () => '/bin/claude', folder: () => '/repo',
    options: () => options,
    settings: () => ({ model: 'sonnet', budgetUsd: 1, allowedCommands: [], timeoutMs: 60_000 }),
    run: request => {
      if (request.mode === 'plan') {
        // With holdPlan, Lead answers when the test releases 'LEAD'.
        return holdPlan ? new Promise(resolve => waiting.set('LEAD', () => resolve(report(plan)))) : Promise.resolve(report(plan));
      }
      const { task } = JSON.parse(request.prompt);
      started.push(task);
      return new Promise((resolve, reject) => {
        waiting.set(task, () => resolve(report({ status: 'done', summary: `${task}: done`, files_changed: [], tests: '', memory: [] })));
        request.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    },
    worktrees
  };
  const chat = new SquadChat(storage, accounts, seats, () => {}, host);
  const until = async (check, what) => {
    const end = Date.now() + 3_000;
    while (!check()) {
      assert.ok(Date.now() < end, what);
      await tick();
    }
  };
  const release = async text => {
    await until(() => [...waiting.keys()].some(task => task.includes(text)), `no worker holds "${text}"`);
    const task = [...waiting.keys()].find(item => item.includes(text));
    waiting.get(task)();
    waiting.delete(task);
  };
  return { chat, accounts, profiles, started, worktrees, release, until };
}

function leadTools(t, chat, accounts, profiles) {
  const originalLoad = Module._load;
  t.mock.method(Module, '_load', function (name, ...args) {
    return name === 'vscode' ? { window: { showWarningMessage: async () => undefined } } : originalLoad.call(this, name, ...args);
  });
  const { xdevMcpTools } = require('../dist/mcp.js');
  const tools = xdevMcpTools(chat, accounts, { list: async () => profiles }, { level: () => 'off', squadLevel: () => 'run', confirm: async () => false });
  const signal = new AbortController().signal;
  return async (name, args = {}) => JSON.parse(JSON.stringify(await tools.find(tool => tool.name === `xdev_${name}`).run(args, signal)));
}

const tickTwice = async () => { await tick(); await tick(); };

const threeTasks = [
  { role: 'Implement', brief: 'Add the alpha endpoint', account: idOf(1) },
  { role: 'Implement', brief: 'Add the beta endpoint', account: idOf(2) },
  { role: 'Implement', brief: 'Add the gamma endpoint', account: idOf(3) }
];

test('a parallel plan becomes one run per task, and their steps work at the same time under different accounts', { timeout: 20_000 }, async t => {
  const { chat, accounts, profiles, started, worktrees, release, until } = await squadWith();
  const call = leadTools(t, chat, accounts, profiles);

  await assert.rejects(call('squad_submit_plan', { request: 'r', summary: 's', tasks: threeTasks, parallel: 'yes' }), /"parallel" is true or false/);
  const { plan } = await call('squad_submit_plan', { request: 'Add three endpoints', summary: 'Three independent endpoints', tasks: threeTasks, parallel: true });
  assert.equal(plan.parallel, true);
  assert.equal(chat.snapshot().plan.parallel, true, 'the panel shows that the plan is parallel');

  const approved = await call('squad_approve_plan', { planId: plan.id });
  assert.equal(approved.runs.length, 3);
  assert.match(approved.note, /3 runs are ready/);
  const ids = approved.runs.map(run => run.id);
  assert.equal(new Set(approved.runs.map(run => run.repositories[0].branch)).size, 3, 'each run has its own branch');
  assert.equal(new Set(worktrees.created.map(tree => tree.path)).size, 3, 'and its own worktree');
  assert.deepEqual(approved.runs.map(run => [run.steps.length, run.steps[0].account]), [[1, 'Implement account'], [1, 'Review account'], [1, 'Tests account']]);
  assert.match(chat.snapshot().entries.at(-1).text, /3 runs are ready, one for each task/);

  // The lead starts every run without waiting.
  for (const runId of ids) assert.equal((await call('squad_run_step', { runId, waitSeconds: 0 })).finished, false);
  await until(() => started.length === 3, 'three workers start');
  const during = chat.snapshot();
  assert.deepEqual([...during.busyRuns].sort(), [...ids].sort());
  assert.equal(during.working.length, 3);
  assert.equal(during.chatBusy, false, 'the chat itself is free');
  assert.match(during.status, /^3 are working/);
  const status = await call('squad_status');
  assert.equal(status.workingRuns.length, 3);
  await assert.rejects(call('squad_run_step', { runId: ids[0], waitSeconds: 0 }), /Wait for the current run/, 'one run works on one step at a time');

  // Waiting without a run returns each time one of them ends; the others keep working.
  const waitAny = call('squad_wait', { seconds: 5 });
  await release('beta');
  assert.equal((await waitAny).finished, true);
  const afterOne = chat.snapshot();
  assert.deepEqual([...afterOne.busyRuns].sort(), [ids[0], ids[2]].sort());
  assert.equal(chat.run(ids[1]).status, 'done', 'a run with one step commits when the step is done');
  assert.deepEqual(worktrees.committed, [chat.run(ids[1]).trees[0].branch]);
  assert.deepEqual(worktrees.titles, ['Add the beta endpoint'], 'the commit is named after the task of its run');
  assert.equal(chat.run(ids[0]).steps[0].status, 'running', 'a run that ends does not close the steps of the others');

  // Waiting with a run id waits for that run only.
  const waitAlpha = call('squad_wait', { seconds: 5, runId: ids[0] });
  await release('alpha');
  const alpha = await waitAlpha;
  assert.equal(alpha.finished, true);
  assert.equal(alpha.run.steps[0].status, 'done');
  assert.equal(alpha.busy, true, 'gamma is still working');

  // Stopping one run leaves nothing else touched.
  await call('squad_stop', { runId: ids[2] });
  await until(() => !chat.snapshot().busy, 'the stopped run ends');
  assert.equal(chat.run(ids[2]).steps[0].status, 'failed');
  assert.equal(chat.run(ids[2]).status, 'active', 'a stopped step leaves its run open');
  assert.equal(chat.run(ids[0]).status, 'done');
  assert.equal(worktrees.committed.length, 2);
});

test('the number of runs that work at once has a limit, and work on other runs goes on meanwhile', { timeout: 20_000 }, async t => {
  const { chat, accounts, profiles, started, release, until } = await squadWith({ options: { maxParallel: 2 } });
  const call = leadTools(t, chat, accounts, profiles);
  const { plan } = await call('squad_submit_plan', { request: 'Add three endpoints', summary: 'Three', tasks: threeTasks, parallel: true });
  const { runs } = await call('squad_approve_plan', { planId: plan.id });
  const [first, second, third] = runs.map(run => run.id);

  await call('squad_run_step', { runId: first, waitSeconds: 0 });
  await call('squad_run_step', { runId: second, waitSeconds: 0 });
  await until(() => started.length === 2, 'two workers start');
  await assert.rejects(call('squad_run_step', { runId: third, waitSeconds: 0 }), /2 runs are working, which is the most allowed at once \(xdevAi\.squad\.maxParallelRuns\)/);

  // While two runs work, the lead may still end an idle run and hand out a new plan.
  await call('squad_finish_run', { runId: third });
  assert.equal(chat.run(third).status, 'stopped');
  const next = await call('squad_submit_plan', { request: 'Write the changelog', summary: 'One more task', tasks: [{ role: 'Tests', brief: 'Write the changelog entry' }] });
  assert.equal(next.plan.parallel, undefined, 'one task is never parallel');
  const { run: fourth } = await call('squad_approve_plan', { planId: next.plan.id });
  assert.equal(chat.snapshot().runs.filter(run => run.status === 'active').length, 3, 'several runs are open at once');

  await release('alpha');
  await until(() => !chat.busyRun(first), 'the first run ends');
  await call('squad_run_step', { runId: fourth.id, waitSeconds: 0 });
  await until(() => started.length === 3, 'a freed place is taken');
  await release('beta');
  await release('changelog');
  await until(() => !chat.snapshot().busy, 'all work ends');
});

test('with a limit of one, Squad runs one step at a time as before', { timeout: 20_000 }, async t => {
  const { chat, accounts, profiles, started, release, until } = await squadWith({ options: { maxParallel: 1 } });
  const call = leadTools(t, chat, accounts, profiles);
  const { plan } = await call('squad_submit_plan', { request: 'Add two endpoints', summary: 'Two', tasks: threeTasks.slice(0, 2), parallel: true });
  const { runs } = await call('squad_approve_plan', { planId: plan.id });
  await call('squad_run_step', { runId: runs[0].id, waitSeconds: 0 });
  await until(() => started.length === 1, 'one worker starts');
  await assert.rejects(call('squad_run_step', { runId: runs[1].id, waitSeconds: 0 }), /Wait for the current run or stop it first/);
  await release('alpha');
  await until(() => !chat.snapshot().busy, 'the work ends');
  await call('squad_run_step', { runId: runs[1].id, waitSeconds: 0 });
  await release('beta');
  await until(() => !chat.snapshot().busy, 'the work ends');
});

test('Squad\'s own Lead may plan independent tasks in parallel, and automatic approval starts them together', { timeout: 20_000 }, async () => {
  const parallelPlan = {
    reply: 'Two independent endpoints', parallel: true,
    tasks: [{ role: 'Implement', brief: 'Add the alpha endpoint' }, { role: 'Implement', brief: 'Add the beta endpoint' }]
  };
  const manual = await squadWith({ plan: parallelPlan });
  await (await manual.chat.send('Add two endpoints')).finished;
  const pending = manual.chat.pendingPlan();
  assert.equal(pending.parallel, true);
  assert.deepEqual(pending.jobs.map(job => job.role), ['Implement', 'Implement'], 'a role may take several parallel tasks');

  // Without "parallel", a role still takes one task per repository.
  const sequential = await squadWith({ plan: { ...parallelPlan, parallel: false } });
  await (await sequential.chat.send('Add two endpoints')).finished;
  assert.equal(sequential.chat.pendingPlan(), undefined);
  assert.match(sequential.chat.snapshot().entries.at(-1).text, /did not return a valid plan/);

  const auto = await squadWith({ plan: parallelPlan, options: { planApproval: 'auto' } });
  const sent = await auto.chat.send('Add two endpoints');
  await auto.until(() => auto.started.length === 2, 'both runs start their step');
  assert.equal(auto.chat.snapshot().working.filter(job => job.run).length, 2);
  await auto.release('alpha');
  await auto.release('beta');
  await sent.finished;
  assert.deepEqual(auto.chat.snapshot().runs.map(run => run.status), ['done', 'done']);
  assert.equal(auto.worktrees.committed.length, 2);
});

const threePlan = {
  reply: 'Three independent endpoints', parallel: true,
  tasks: ['alpha', 'beta', 'gamma'].map(name => ({ role: 'Implement', brief: `Add the ${name} endpoint` }))
};

test('an automatic start takes the places that are free, and stopping another run does not cancel it', { timeout: 20_000 }, async () => {
  const { chat, started, release, until } = await squadWith({ plan: threePlan, holdPlan: true, options: { planApproval: 'auto', maxParallel: 3 } });
  // Two runs are already working.
  const earlier = await chat.submitPlan({
    request: 'Two chores', summary: 'Two chores', parallel: true,
    tasks: [{ role: 'Tests', brief: 'Chore one' }, { role: 'Tests', brief: 'Chore two' }]
  });
  await (await chat.approve(earlier.id)).finished;
  const [one, two] = chat.snapshot().runs.map(run => run.id);
  await chat.runStep(one);
  await chat.runStep(two);
  await until(() => started.length === 2, 'the chores start');

  // The user asks for more, then stops one chore while Lead still plans.
  const sent = await chat.send('Add three endpoints');
  chat.cancel(one);
  await until(() => !chat.busyRun(one), 'the stopped chore ends');
  assert.equal(chat.snapshot().chatBusy, true, 'Lead is still planning');
  assert.ok(!chat.snapshot().entries.some(entry => /interrupted/.test(entry.text)), 'work of this window is not an interrupted run');
  await release('LEAD');

  // Three runs are made; one chore still works, so two of the three places are free.
  await until(() => started.length === 4, 'two of the three new runs start');
  await tickTwice();
  assert.deepEqual(started.slice(2).sort(), ['Add the alpha endpoint', 'Add the beta endpoint']);
  assert.equal(chat.snapshot().working.length, 3);
  assert.equal(chat.snapshot().chatBusy, false);
  await release('alpha');
  await release('beta');
  const entries = await sent.finished;
  assert.ok(!entries.some(entry => /Automatic start paused/.test(entry.text)), 'the start was not cancelled or refused');
  const gamma = chat.snapshot().runs.find(run => run.steps[0].brief === 'Add the gamma endpoint');
  assert.deepEqual([gamma.status, gamma.steps[0].status], ['active', 'pending'], 'the run without a place waits in the panel');
  await release('Chore two');
  await until(() => !chat.snapshot().busy, 'all work ends');
});

test('a message through MCP returns with the answer of Lead and does not wait for the steps it started', { timeout: 20_000 }, async t => {
  const { chat, accounts, profiles, started, release, until } = await squadWith({ plan: threePlan, options: { planApproval: 'auto', maxParallel: 2 } });
  const call = leadTools(t, chat, accounts, profiles);
  const answer = await call('squad_ask', { message: 'Add three endpoints', waitSeconds: 5 });
  assert.equal(answer.finished, true);
  assert.ok(answer.replies.some(reply => reply.author === 'Lead' && /Three independent endpoints/.test(reply.text)), JSON.stringify(answer.replies));
  await until(() => started.length === 2, 'the automatic start goes on');
  assert.equal(chat.snapshot().busy, true, 'the steps are still working after the call returned');
  await release('alpha');
  await release('beta');
  await until(() => !chat.snapshot().busy, 'all work ends');
});
