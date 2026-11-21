const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { setImmediate: tick } = require('node:timers/promises');
const { test } = require('node:test');
const { Accounts } = require('../dist/accounts.js');
const { SquadChat } = require('../dist/squad-chat.js');
const { SquadStore } = require('../dist/squad.js');
const { Worktrees } = require('../dist/squad-worktree.js');

const roleNames = ['Lead', 'Implement', 'Review', 'Tests'];

function memento() {
  const values = new Map();
  return { get: key => values.get(key), update: async (key, value) => values.set(key, value) };
}

function report(output, extra = {}) {
  return JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.1, num_turns: 2, structured_output: output, ...extra });
}

async function setup(t, respond) {
  const storage = memento();
  const secrets = new Map();
  const accounts = new Accounts({ get: async key => secrets.get(key), store: async (key, value) => secrets.set(key, value) });
  const squad = new SquadStore(storage);
  const profiles = roleNames.map((role, index) => ({
    provider: 'claude', name: `${role} account`, configDir: `/profiles/claude/0000000${index}-0000-0000-0000-000000000000`
  }));
  for (const [index, role] of roleNames.entries()) {
    await squad.save(role, { account: `claude:0000000${index}-0000-0000-0000-000000000000`, brief: '', status: 'Ready', blocker: '' });
  }
  const runs = [];
  const worktrees = {
    created: [], committed: [], removed: [],
    async create(folder, id) {
      const tree = { repo: folder, path: `${folder}/.wt/${id.slice(0, 8)}`, branch: `xdev/squad/${id.slice(0, 8)}`, base: 'base0' };
      this.created.push(tree);
      return tree;
    },
    async commit(tree, message) { this.committed.push({ tree, message }); return { commit: 'c0ffee', stat: ' a.ts | 2 +-', files: 1 }; },
    async remove(tree) { this.removed.push(tree.branch); }
  };
  let prepared = 0;
  const host = {
    profiles: async () => profiles,
    executable: async () => '/bin/claude',
    folder: () => '/repo',
    settings: () => ({ budgetUsd: 1, allowedCommands: ['npm test'], timeoutMs: 60_000 }),
    run: async request => {
      runs.push(request);
      return respond(request);
    },
    worktrees,
    prepare: async () => { prepared++; }
  };
  const open = () => new SquadChat(storage, accounts, squad, () => {}, host);
  return { open, runs, worktrees, prepared: () => prepared };
}

async function settle(chat) {
  const end = Date.now() + 1_000;
  while (chat.snapshot().busy) {
    assert.ok(Date.now() < end, 'Chat did not settle');
    await tick();
  }
}

test('a Claude Code Lead plans and workers run headless in one worktree with shared memory', async t => {
  const { open, runs, worktrees, prepared } = await setup(t, request => {
    if (request.mode === 'plan') {
      return report({ reply: 'Two steps', tasks: [{ role: 'Review', brief: 'Review the endpoint' }, { role: 'Implement', brief: 'Add the endpoint' }] });
    }
    if (request.role === 'Implement') {
      return report({ status: 'done', summary: 'Added GET /health', files_changed: ['src/health.ts'], tests: 'npm test passed', memory: ['Health checks live in src/health.ts'] },
        { session_id: 'impl-session' });
    }
    return report({ status: 'done', summary: 'Looks correct', files_changed: [], tests: '', memory: [] }, { session_id: 'review-session' });
  });
  const chat = open();
  await chat.memory.add(['Use Fastify, not Express'], 'You');
  await chat.send('Add a health endpoint');
  await settle(chat);

  const lead = runs[0];
  assert.equal(lead.mode, 'plan');
  assert.equal(lead.cwd, '/repo');
  assert.deepEqual(JSON.parse(lead.prompt).memory, ['Use Fastify, not Express']);
  assert.match(lead.system, /Implement \(Claude Code worker/);
  const { plan } = chat.snapshot();
  assert.deepEqual(plan.jobs.map(job => [job.role, job.kind]), [['Implement', 'claude'], ['Review', 'claude']]);

  await (await chat.approve(plan.id)).finished;
  assert.equal(runs.length, 1, 'approving prepares the worktree but starts no worker');
  assert.equal(worktrees.created.length, 1);
  const runId = chat.snapshot().runs[0].id;
  await assert.rejects(chat.completeStep(runId), /only after continuing it in a terminal/);
  await (await chat.runStep(runId)).finished;
  assert.equal(runs.length, 2, 'one step per click');
  assert.equal(open().snapshot().runs[0].status, 'active');
  await (await open().runStep(runId)).finished;
  const [implement, review] = runs.slice(1);
  assert.equal(implement.cwd, worktrees.created[0].path);
  assert.equal(review.cwd, worktrees.created[0].path, 'Review sees the uncommitted Implement changes');
  assert.equal(implement.mode, 'work');
  assert.equal(implement.profile.name, 'Implement account');
  assert.deepEqual(JSON.parse(review.prompt).previous, [{ role: 'Implement', status: 'done', summary: 'Added GET /health', files: ['src/health.ts'] }]);
  assert.deepEqual(JSON.parse(review.prompt).memory, ['Health checks live in src/health.ts', 'Use Fastify, not Express']);
  assert.ok(prepared() >= 2, 'skills are synced before planning and before the run');

  const snapshot = open().snapshot();
  const [run] = snapshot.runs;
  assert.equal(run.status, 'done');
  assert.equal(run.commit, 'c0ffee');
  assert.equal(Math.round(run.costUsd * 10), 2);
  assert.deepEqual(run.sessions.map(session => [session.role, session.sessionId]), [['Implement', 'impl-session'], ['Review', 'review-session']]);
  assert.match(snapshot.entries.find(entry => entry.author === 'Implement').profile, /Claude Code · \$0\.10$/);
  assert.match(snapshot.entries.at(-1).text, /Committed 1 changed file to xdev\/squad\//);

  await chat.removeRun(run.id);
  assert.deepEqual(worktrees.removed, [run.branch]);
  assert.deepEqual(open().snapshot().runs, []);
});

test('a blocked step waits for the user, who can rerun it with a new brief or continue in a terminal', async t => {
  let answer = 'Which database version?';
  const { open, runs, worktrees } = await setup(t, request => request.mode === 'plan'
    ? report({ reply: 'Go', tasks: [{ role: 'Implement', brief: 'Change the schema' }, { role: 'Tests', brief: 'Test it' }] })
    : report(answer
      ? { status: 'blocked', summary: answer, files_changed: [], tests: '', memory: [] }
      : { status: 'done', summary: 'Changed', files_changed: ['db.sql'], tests: '', memory: [] }));
  const chat = open();
  await chat.send('Migrate');
  await settle(chat);
  await (await chat.approve(chat.snapshot().plan.id)).finished;
  const runId = chat.snapshot().runs[0].id;
  await (await chat.runStep(runId)).finished;
  let snapshot = open().snapshot();
  assert.deepEqual(snapshot.runs[0].steps.map(step => step.status), ['blocked', 'pending']);
  assert.equal(snapshot.runs[0].status, 'active');
  assert.equal(worktrees.committed.length, 0, 'nothing is committed while the run waits');
  assert.ok(snapshot.entries.some(entry => /Blocked: Which database version\?/.test(entry.text)));

  answer = '';
  await (await chat.runStep(runId, 'Change the schema for PostgreSQL 16')).finished;
  assert.equal(JSON.parse(runs.at(-1).prompt).task, 'Change the schema for PostgreSQL 16');

  const terminal = await chat.startTerminalStep(runId, 'Write migration tests');
  assert.equal(terminal.cwd, worktrees.created[0].path);
  assert.equal(terminal.profile.name, 'Tests account');
  assert.match(terminal.prompt, /Task for Tests: Write migration tests/);
  assert.match(terminal.prompt, /- Implement: Changed/);
  assert.equal(runs.length, 3, 'a terminal step does not start a headless worker');
  await assert.rejects(chat.runStep(runId), /open in a terminal/);
  await assert.rejects(chat.startTerminalStep(runId), /open in a terminal/);
  await chat.completeStep(runId, 'Added 3 migration tests, all pass');
  snapshot = open().snapshot();
  assert.equal(snapshot.runs[0].status, 'done');
  assert.equal(snapshot.runs[0].steps[1].summary, 'Added 3 migration tests, all pass');
  assert.equal(worktrees.committed.length, 1, 'the run is committed when the last step is done');
});

test('a failing worker marks the step failed and the run stays open', async t => {
  const { open } = await setup(t, request => {
    if (request.mode === 'plan') return report({ reply: 'Go', tasks: [{ role: 'Implement', brief: 'Do' }] });
    throw new Error('Claude Code exited with code 1');
  });
  const chat = open();
  await chat.send('Do something');
  await settle(chat);
  await (await chat.approve(chat.snapshot().plan.id)).finished;
  const runId = chat.snapshot().runs[0].id;
  const entries = await (await chat.runStep(runId)).finished;
  assert.ok(entries.some(entry => entry.text === 'Implement: Claude Code exited with code 1'));
  const [run] = open().snapshot().runs;
  assert.equal(run.status, 'active');
  assert.equal(run.steps[0].status, 'failed');
});

test('worktrees branch from HEAD and commit only inside the worktree', async t => {
  const root = await mkdtemp(join(tmpdir(), 'xdev-worktree-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  const run = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  run('config', 'user.email', 'dev@example.com');
  run('config', 'user.name', 'Dev');
  await writeFile(join(repo, 'a.txt'), 'one\n');
  run('add', '.');
  run('commit', '-q', '-m', 'init');

  const worktrees = new Worktrees(join(root, 'trees'));
  const tree = await worktrees.create(repo, '12345678-aaaa-bbbb-cccc-dddddddddddd');
  assert.equal(tree.branch, 'xdev/squad/12345678');
  await writeFile(join(tree.path, 'a.txt'), 'two\n');
  await writeFile(join(tree.path, 'b.txt'), 'new\n');
  const changes = await worktrees.commit(tree, 'xDev Squad: change');
  assert.equal(changes.files, 2);
  assert.ok(changes.commit);
  assert.equal(await readFile(join(repo, 'a.txt'), 'utf8'), 'one\n', 'the main checkout is untouched');
  assert.equal(run('status', '--porcelain'), '');
  assert.equal(run('log', '-1', '--format=%an', tree.branch).trim(), 'Dev');

  const empty = await worktrees.create(repo, '87654321-aaaa-bbbb-cccc-dddddddddddd');
  assert.deepEqual(await worktrees.commit(empty, 'nothing'), { commit: undefined, stat: '', files: 0 });
  await worktrees.remove(tree);
  assert.doesNotMatch(run('branch', '--list'), /12345678/);
  await assert.rejects(worktrees.create(root, 'ffffffff-0000-0000-0000-000000000000'), /git repository/);
});
