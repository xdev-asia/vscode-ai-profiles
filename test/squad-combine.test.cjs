const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const Module = require('node:module');
const { existsSync } = require('node:fs');
const { mkdtemp, readFile, realpath, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { test } = require('node:test');
const { Accounts } = require('../dist/accounts.js');
const { SquadChat } = require('../dist/squad-chat.js');
const { SquadStore } = require('../dist/squad.js');
const { Worktrees } = require('../dist/squad-worktree.js');

// Keep line endings as the tests write them: git on a Windows machine may convert them on checkout.
Object.assign(process.env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.autocrlf', GIT_CONFIG_VALUE_0: 'false' });

const roleNames = ['Lead', 'Implement', 'Review', 'Tests'];
const idOf = index => `claude:0000000${index}-0000-0000-0000-000000000000`;

async function repository(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xdev-combine-')));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const repo = join(root, 'repo');
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  git('config', 'user.email', 'dev@example.com');
  git('config', 'user.name', 'Dev');
  await writeFile(join(repo, 'README.md'), 'title\nstatus: draft\nend\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  return { root, repo, git, worktrees: new Worktrees(join(root, 'trees')) };
}

test('a branch merges into a worktree, and a conflicting branch is left out with its files named', async t => {
  const { repo, git, worktrees } = await repository(t);
  const one = await worktrees.create(repo, 'aaaaaaaa-0000');
  const two = await worktrees.create(repo, 'bbbbbbbb-0000');
  const three = await worktrees.create(repo, 'cccccccc-0000');
  await writeFile(join(one.path, 'a.txt'), 'alpha\n');
  await writeFile(join(two.path, 'README.md'), 'title\nstatus: beta\nend\n');
  await writeFile(join(three.path, 'README.md'), 'title\nstatus: gamma\nend\n');
  for (const tree of [one, two, three]) await worktrees.commit(tree, `work on ${tree.branch}`);

  const combined = await worktrees.create(repo, 'dddddddd-0000', undefined, one.base);
  assert.deepEqual(await worktrees.mergeBranch(combined, one.branch, 'Merge alpha'), { merged: true, conflicts: [] });
  assert.deepEqual(await worktrees.mergeBranch(combined, two.branch, 'Merge beta'), { merged: true, conflicts: [] });
  assert.deepEqual(await worktrees.mergeBranch(combined, three.branch, 'Merge gamma'), { merged: false, conflicts: ['README.md'] });

  const inside = (...args) => execFileSync('git', args, { cwd: combined.path, encoding: 'utf8' });
  assert.equal(inside('status', '--porcelain'), '', 'the undone merge leaves nothing behind');
  assert.equal(await readFile(join(combined.path, 'README.md'), 'utf8'), 'title\nstatus: beta\nend\n');
  assert.equal(await readFile(join(combined.path, 'a.txt'), 'utf8'), 'alpha\n');
  assert.deepEqual(inside('log', '--merges', '--format=%s').trim().split('\n'), ['Merge beta', 'Merge alpha']);
  assert.equal(git('status', '--porcelain'), '', 'the main checkout is not touched');
  await assert.rejects(worktrees.mergeBranch(combined, '--upload-pack=x', 'm'), /not a valid branch name/);
  await assert.rejects(worktrees.mergeBranch(combined, 'no-such-branch', 'm'), 'a failure that is not a conflict is an error');
});

test('the finished runs of a parallel plan combine into one run that is checked as a whole', { timeout: 60_000 }, async t => {
  const { repo, git, worktrees } = await repository(t);
  const values = new Map();
  const storage = { get: key => values.get(key), update: async (key, value) => values.set(key, value) };
  const secrets = new Map();
  const accounts = new Accounts({ get: async key => secrets.get(key), store: async (key, value) => secrets.set(key, value) });
  const seats = new SquadStore(storage);
  const profiles = roleNames.map((role, index) => ({ provider: 'claude', name: `${role} account`, configDir: `/profiles/claude/0000000${index}-0000-0000-0000-000000000000` }));
  for (const [index, role] of roleNames.entries()) await seats.save(role, { account: idOf(index), brief: '', status: 'Ready', blocker: '' });
  const worked = [];
  const host = {
    profiles: async () => profiles, executable: async () => '/bin/claude', folder: () => repo,
    settings: () => ({ model: 'sonnet', budgetUsd: 1, allowedCommands: [], timeoutMs: 60_000 }),
    // Each worker does its task in the worktree it is given.
    run: async request => {
      const { task } = JSON.parse(request.prompt);
      worked.push([request.role, request.cwd]);
      if (/alpha/.test(task)) await writeFile(join(request.cwd, 'a.txt'), 'alpha\n');
      if (/beta/.test(task)) await writeFile(join(request.cwd, 'README.md'), 'title\nstatus: beta\nend\n');
      if (/gamma/.test(task)) await writeFile(join(request.cwd, 'README.md'), 'title\nstatus: gamma\nend\n');
      return JSON.stringify({
        type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.1, num_turns: 2, session_id: `s-${worked.length}`,
        structured_output: { status: 'done', summary: `${request.role} did: ${task.slice(0, 40)}`, files_changed: [], tests: '', memory: [] }
      });
    },
    worktrees, repositories: async () => ['.']
  };
  const chat = new SquadChat(storage, accounts, seats, () => {}, host);
  const originalLoad = Module._load;
  t.mock.method(Module, '_load', function (name, ...args) {
    return name === 'vscode' ? { window: { showWarningMessage: async () => undefined } } : originalLoad.call(this, name, ...args);
  });
  const { xdevMcpTools } = require('../dist/mcp.js');
  const tools = xdevMcpTools(chat, accounts, { list: async () => profiles }, { level: () => 'off', squadLevel: () => 'run', confirm: async () => false });
  const signal = new AbortController().signal;
  const call = async (name, args = {}) => JSON.parse(JSON.stringify(await tools.find(tool => tool.name === `xdev_${name}`).run(args, signal)));

  const { plan } = await call('squad_submit_plan', {
    request: 'Three changes', summary: 'Three changes', parallel: true,
    tasks: ['Add the alpha file', 'Set the status to beta', 'Set the status to gamma'].map(brief => ({ role: 'Implement', brief }))
  });
  const approved = await call('squad_approve_plan', { planId: plan.id });
  const ids = approved.runs.map(run => run.id);
  assert.equal(new Set(approved.runs.map(run => run.batch)).size, 1, 'the runs of one plan share a batch');
  await assert.rejects(call('squad_combine', { runIds: ids }), /Finish the run “Add the alpha file” before combining it/);
  for (const runId of ids) await call('squad_run_step', { runId, waitSeconds: 20 });
  assert.deepEqual(chat.combinable(ids[0]).map(record => record.id), ids, 'the panel offers the three finished runs, in plan order');
  await assert.rejects(call('squad_combine', { runIds: [ids[0]] }), /at least two/);

  const { run, note } = await call('squad_combine', { runIds: ids });
  assert.deepEqual(run.combined.map(part => [part.task, part.merged, part.conflicts ?? null]), [
    ['Add the alpha file', true, null], ['Set the status to beta', true, null], ['Set the status to gamma', false, ['README.md']]
  ]);
  assert.match(note, /Combined 2 of 3 runs on branch xdev\/squad\/\w+.*Left out because they change the same lines.*“Set the status to gamma” \(README\.md\).*Run Review and Tests/s);
  const tree = run.repositories[0];
  assert.equal(await readFile(join(tree.worktree, 'README.md'), 'utf8'), 'title\nstatus: beta\nend\n');
  assert.ok(existsSync(join(tree.worktree, 'a.txt')));
  assert.deepEqual(run.steps.map(step => [step.role, step.account, step.status]), [['Review', 'Review account', 'pending'], ['Tests', 'Tests account', 'pending']]);
  assert.match(run.steps[0].brief, /Add the alpha file; Set the status to beta/);
  assert.doesNotMatch(run.steps[0].brief, /gamma/, 'a run that was left out is not part of what is reviewed');
  assert.deepEqual(ids.map(id => chat.run(id).combinedInto ?? null), [run.id, run.id, null]);
  assert.deepEqual(chat.combinable(ids[2]), [], 'one run alone is not offered again');

  // The checks run in the combined worktree, and finishing keeps the merged work on the new branch.
  await call('squad_run_step', { runId: run.id, waitSeconds: 20 });
  assert.deepEqual(worked.at(-1), ['Review', tree.worktree]);
  const finished = await call('squad_finish_run', { runId: run.id });
  assert.equal(finished.run.repositories[0].filesChanged, 2);
  assert.deepEqual(git('show', '--name-only', '--format=', `${tree.branch}~1..${tree.branch}`).trim().split('\n').sort(), ['README.md']);
  assert.equal(git('show', `${tree.branch}:a.txt`).trim(), 'alpha');
  assert.equal(git('status', '--porcelain'), '', 'the main checkout is not touched');
  assert.match((await call('squad_run', { runId: ids[2] })).status, /done/);
});
