const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Accounts } = require('../dist/accounts.js');
const { SquadChat } = require('../dist/squad-chat.js');
const { SquadStore } = require('../dist/squad.js');
const { workerArguments } = require('../dist/squad-worker.js');

const roleNames = ['Lead', 'Implement', 'Review', 'Tests'];
const id = index => `0000000${index}-0000-0000-0000-000000000000`;

function memento() {
  const values = new Map();
  return { values, get: key => values.get(key), update: async (key, value) => values.set(key, value) };
}

function report(output, extra = {}) {
  return JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.1, num_turns: 2, structured_output: output, ...extra });
}

async function setup(respond, options = {}, extraHost = {}) {
  const storage = memento();
  const secrets = new Map();
  const accounts = new Accounts({ get: async key => secrets.get(key), store: async (key, value) => secrets.set(key, value) });
  const squad = new SquadStore(storage);
  const profiles = roleNames.map((role, index) => ({ provider: 'claude', name: `${role} account`, configDir: `/profiles/claude/${id(index)}` }));
  for (const [index, role] of roleNames.entries()) {
    await squad.save(role, { account: `claude:${id(index)}`, brief: '', status: 'Ready', blocker: '' });
  }
  const runs = [];
  const worktrees = {
    async create(folder, runId) { return { repo: folder, path: `${folder}/.wt/${runId.slice(0, 8)}`, branch: `xdev/squad/${runId.slice(0, 8)}`, base: 'base0' }; },
    async commit() { return { commit: 'c0ffee', stat: ' a.ts | 2 +-', files: 1 }; },
    async remove() {},
    async changedFiles() { return ['src/a.ts']; },
    async changes() { return []; },
    async discard() {}
  };
  const host = {
    profiles: async () => profiles,
    executable: async () => '/bin/claude',
    folder: () => '/repo',
    settings: () => ({ budgetUsd: 1, allowedCommands: ['npm test'], timeoutMs: 60_000 }),
    run: async request => {
      runs.push(request);
      return respond(request, runs);
    },
    worktrees,
    options: () => options,
    ...extraHost
  };
  const open = () => new SquadChat(storage, accounts, squad, () => {}, host);
  return { open, runs, squad };
}

const ask = async (chat, text) => (await chat.send(text)).finished;
const answer = (reply, sessionId, tasks = []) => report({ reply, tasks }, sessionId ? { session_id: sessionId } : {});

test('Lead resumes one session per chat and sends only what changed', async () => {
  let session = 0;
  const { open, runs } = await setup(request => answer('ok', request.resume ?? `lead-${++session}`), { leadSessionTurns: 2 });
  const chat = open();
  await chat.memory.add(['Use Fastify'], 'You');

  await ask(chat, 'First question');
  assert.equal(runs[0].resume, undefined);
  assert.equal(runs[0].persist, true, 'the first Lead session is kept for later turns');
  assert.deepEqual(JSON.parse(runs[0].prompt).memory, ['Use Fastify']);
  assert.deepEqual(chat.snapshot().leadSession, { turns: 1, max: 2 });

  await ask(chat, 'Second question');
  assert.equal(runs[1].resume, 'lead-1');
  const resumed = JSON.parse(runs[1].prompt);
  assert.equal(resumed.request, 'Second question');
  assert.equal(resumed.memory, undefined, 'unchanged memory is not sent again');
  assert.equal(resumed.history, undefined, 'Lead already holds its own replies');
  assert.equal(resumed.code, undefined);

  await chat.memory.add(['Tests use node:test'], 'You');
  await ask(chat, 'Third question');
  assert.equal(runs[2].resume, undefined, 'the session reached leadSessionTurns, so a fresh one starts');
  assert.ok(JSON.parse(runs[2].prompt).memory.includes('Tests use node:test'));
  assert.equal(JSON.parse(runs[2].prompt).history.length, 4, 'a fresh session receives the recent history');
  assert.deepEqual(chat.snapshot().leadSession, { turns: 1, max: 2 });
});

test('a resumed Lead whose session is gone starts a fresh one with the full context', async () => {
  const { open, runs } = await setup(request => {
    if (request.resume) throw new Error('No conversation found');
    return answer('ok', `lead-${runs.length}`);
  }, { leadSessionTurns: 5 });
  const chat = open();
  await ask(chat, 'One');
  await ask(chat, 'Two');
  assert.deepEqual(runs.map(run => run.resume), [undefined, 'lead-1', undefined]);
  assert.equal(JSON.parse(runs[2].prompt).history.length, 2);
  assert.deepEqual(chat.snapshot().leadSession, { turns: 1, max: 5 });
  assert.ok(!chat.snapshot().entries.some(entry => /failed|No conversation/.test(entry.text)));
});

test('without the option each Lead turn stays fresh and is not kept', async () => {
  const { open, runs } = await setup(() => answer('ok', 'lead-x'));
  const chat = open();
  await ask(chat, 'One');
  await ask(chat, 'Two');
  assert.deepEqual(runs.map(run => [run.resume, run.persist]), [[undefined, undefined], [undefined, undefined]]);
  assert.equal(chat.snapshot().leadSession, undefined);
});

test('chat sessions keep their own entries and Lead session', async () => {
  let session = 0;
  const { open, runs } = await setup(request => answer('ok', request.resume ?? `lead-${++session}`), { leadSessionTurns: 10 });
  const chat = open();
  await ask(chat, 'Billing screen');
  const first = chat.snapshot().chats[0];
  assert.equal(first.title, 'Billing screen');

  await chat.newChat();
  assert.deepEqual(chat.snapshot().entries, []);
  assert.deepEqual(chat.snapshot().chats.map(item => [item.title, item.active]), [['New chat', true], ['Billing screen', false]]);
  await ask(chat, 'Pharmacy report');
  assert.equal(runs[1].resume, undefined, 'a new chat starts a new Lead session');

  await chat.openChat(first.id);
  assert.equal(chat.snapshot().entries[0].text, 'Billing screen');
  await ask(chat, 'Add a total');
  assert.equal(runs[2].resume, 'lead-1', 'returning to a chat resumes its Lead session');

  const other = chat.snapshot().chats.find(item => !item.active);
  await chat.deleteChat(chat.snapshot().chats[0].id);
  assert.equal(chat.snapshot().chats[0].id, other.id, 'deleting the shown chat opens the next one');
  assert.equal(chat.snapshot().chats.length, 1);
  await assert.rejects(chat.openChat('missing'), /no longer available/);
});

test('a round-robin pool spreads worker steps and keeps Lead\'s account for AI review', async () => {
  const tasks = [{ role: 'Implement', brief: 'Add it' }, { role: 'Review', brief: 'Review it' }];
  const { open, runs } = await setup(request => request.mode === 'plan'
    ? answer('Plan', undefined, tasks)
    : report({ status: 'done', summary: 'Done', files_changed: [], tests: '', memory: [] }), { accountPool: 'roundRobin' });
  const chat = open();
  await ask(chat, 'Change it');
  let { plan } = chat.snapshot();
  assert.deepEqual(plan.jobs.map(job => job.profile), ['Implement account', 'Review account']);
  await chat.discard(plan.id);

  await ask(chat, 'Change it again');
  ({ plan } = chat.snapshot());
  assert.deepEqual(plan.jobs.map(job => job.profile), ['Review account', 'Tests account'], 'the next plan continues the rotation');
  await (await chat.approve(plan.id)).finished;
  const runId = chat.snapshot().runs[0].id;
  await (await chat.runStep(runId)).finished;
  assert.equal(runs.at(-1).profile.name, 'Review account', 'a pooled step runs under its own account');
});

test('a quota pool picks the accounts with the most quota left', async () => {
  const used = { 'Implement account': 90, 'Review account': 10, 'Tests account': undefined, 'Lead account': 0 };
  const { open } = await setup(request => request.mode === 'plan'
    ? answer('Plan', undefined, [{ role: 'Implement', brief: 'Add it' }, { role: 'Tests', brief: 'Test it' }])
    : report({ status: 'done', summary: 'Done', files_changed: [], tests: '', memory: [] }),
  { accountPool: 'quota', poolAccounts: ['Implement account', 'Review account', 'Tests account'] },
  { quota: async profile => used[profile.name] });
  const chat = open();
  await ask(chat, 'Change it');
  assert.deepEqual(chat.snapshot().plan.jobs.map(job => job.profile), ['Review account', 'Tests account']);
});

test('automatic approval prepares the run and starts its first step', async () => {
  const { open, runs } = await setup(request => request.mode === 'plan'
    ? answer('Plan', undefined, [{ role: 'Implement', brief: 'Add it' }, { role: 'Review', brief: 'Review it' }])
    : report({ status: 'done', summary: 'Done', files_changed: ['src/a.ts'], tests: '', memory: [] }, { session_id: 'impl-1' }),
  { planApproval: 'auto' });
  const chat = open();
  await ask(chat, 'Change it');
  const snapshot = chat.snapshot();
  assert.equal(snapshot.plan, undefined);
  assert.deepEqual(snapshot.runs[0].steps.map(step => step.status), ['done', 'pending'], 'with a human approver the next step waits');
  assert.deepEqual(runs.map(run => run.role), ['Lead', 'Implement']);
  assert.match(runs[0].system, /start as soon as you return them/);
});

test('automatic approval waits when a repository must be chosen', async () => {
  const { open } = await setup(request => request.mode === 'plan'
    ? answer('Plan', undefined, [{ role: 'Implement', brief: 'Add it' }])
    : report({ status: 'done', summary: 'Done', files_changed: [], tests: '', memory: [] }),
  { planApproval: 'auto' }, { repositories: async () => ['api', 'web'] });
  const chat = open();
  await ask(chat, 'Change it');
  assert.ok(chat.snapshot().plan, 'the plan stays for the user');
  assert.match(chat.snapshot().entries.at(-1).text, /Automatic start paused: Choose the repository/);
});

test('request changes continues Implement\'s session with only the feedback', async () => {
  const { open, runs } = await setup(request => request.mode === 'plan'
    ? answer('Plan', undefined, [{ role: 'Implement', brief: 'Add it' }])
    : report({ status: 'done', summary: 'Done', files_changed: ['src/a.ts'], tests: '', memory: [] }, { session_id: request.resume ? 'impl-2' : 'impl-1' }),
  { resumeFeedback: true });
  const chat = open();
  await ask(chat, 'Change it');
  await (await chat.approve(chat.snapshot().plan.id)).finished;
  const runId = chat.snapshot().runs[0].id;
  await (await chat.runStep(runId)).finished;
  assert.equal(chat.snapshot().runs[0].status, 'done');

  await chat.requestChanges(runId, 'Rename the helper');
  await (await chat.runStep(runId)).finished;
  const feedback = runs.at(-1);
  assert.equal(feedback.resume, 'impl-1');
  assert.equal(feedback.profile.name, 'Implement account');
  const prompt = JSON.parse(feedback.prompt);
  assert.match(prompt.task, /Rename the helper/);
  assert.equal(prompt.request, undefined, 'the session already holds the request');
});

test('worker arguments resume a session and keep it when asked', () => {
  const base = { role: 'Lead', mode: 'plan', prompt: '{}', system: 's', settings: { budgetUsd: 0, allowedCommands: [], timeoutMs: 1 } };
  assert.ok(workerArguments(base, { system: '/tmp/x/system.md' }).includes('--no-session-persistence'));
  const kept = workerArguments({ ...base, resume: 'lead-1', persist: true }, { system: '/tmp/x/system.md' });
  assert.deepEqual(kept.slice(kept.indexOf('--resume'), kept.indexOf('--resume') + 2), ['--resume', 'lead-1']);
  assert.ok(!kept.includes('--no-session-persistence'));
});
