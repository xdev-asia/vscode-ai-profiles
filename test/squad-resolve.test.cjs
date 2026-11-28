// A combined run merges the runs it left out: a worker resolves the conflicts, with real git.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const Module = require('node:module');
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
const status = (status, value) => `title\nstatus: ${status}\n${value ? `owner: ${value}\n` : ''}end\n`;

async function repository(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xdev-resolve-')));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const repo = join(root, 'repo');
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  git('config', 'user.email', 'dev@example.com');
  git('config', 'user.name', 'Dev');
  await writeFile(join(repo, 'README.md'), status('draft'));
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  return { root, repo, git, worktrees: new Worktrees(join(root, 'trees')) };
}

test('an open merge is committed once its conflicts are resolved, and undone otherwise', async t => {
  const { repo, git, worktrees } = await repository(t);
  const one = await worktrees.create(repo, 'aaaaaaaa-0000');
  const two = await worktrees.create(repo, 'bbbbbbbb-0000');
  await writeFile(join(one.path, 'README.md'), status('beta'));
  await writeFile(join(two.path, 'README.md'), status('gamma'));
  await writeFile(join(two.path, 'g.txt'), 'gamma\n');
  for (const tree of [one, two]) await worktrees.commit(tree, `work on ${tree.branch}`);
  const combined = await worktrees.create(repo, 'cccccccc-0000', undefined, one.base);
  const inside = (...args) => execFileSync('git', args, { cwd: combined.path, encoding: 'utf8' });
  assert.deepEqual(await worktrees.mergeBranch(combined, one.branch, 'Merge beta'), { merged: true, conflicts: [] });
  assert.equal(await worktrees.mergedInto(combined, one.branch), true);
  assert.equal(await worktrees.mergedInto(combined, two.branch), false);

  // Work that is not committed yet is kept as a commit before the merge opens.
  await writeFile(join(combined.path, 'notes.txt'), 'from an earlier step\n');
  assert.deepEqual(await worktrees.startMerge(combined, two.branch, 'Merge gamma', 'Changes before merging gamma'), { conflicts: ['README.md'] });
  assert.match(await readFile(join(combined.path, 'README.md'), 'utf8'), /^<<<<<<< /m);
  assert.equal(inside('log', '-1', '--format=%s').trim(), 'Changes before merging gamma');

  // Markers left in the file: nothing is committed.
  assert.deepEqual(await worktrees.finishMerge(combined, ['README.md']), ['README.md']);
  await worktrees.abortMerge(combined);
  assert.equal(inside('status', '--porcelain'), '', 'undoing the merge leaves the worktree clean');
  assert.equal(await readFile(join(combined.path, 'README.md'), 'utf8'), status('beta'));
  assert.equal(await readFile(join(combined.path, 'notes.txt'), 'utf8'), 'from an earlier step\n', 'earlier work survives the undo');
  await worktrees.abortMerge(combined);
  await assert.rejects(worktrees.finishMerge(combined, ['README.md']), /no longer open/);

  // A merge an interrupted step left open is undone when the next one starts; resolved, it is committed.
  await worktrees.startMerge(combined, two.branch, 'Merge gamma', 'keep');
  assert.deepEqual(await worktrees.startMerge(combined, two.branch, 'Merge gamma', 'keep'), { conflicts: ['README.md'] });
  await writeFile(join(combined.path, 'README.md'), status('beta and gamma'));
  assert.deepEqual(await worktrees.finishMerge(combined, ['README.md']), []);
  assert.equal(inside('log', '-1', '--format=%s').trim(), 'Merge gamma');
  assert.equal(inside('rev-list', '--parents', '-1', 'HEAD').trim().split(' ').length, 3, 'a merge commit with both parents');
  assert.equal(await worktrees.mergedInto(combined, two.branch), true);
  assert.equal(await readFile(join(combined.path, 'g.txt'), 'utf8'), 'gamma\n');
  assert.equal(inside('status', '--porcelain'), '');
  // A branch that is merged already opens nothing.
  assert.deepEqual(await worktrees.startMerge(combined, two.branch, 'Merge gamma', 'keep'), { conflicts: [] });
  assert.equal(git('status', '--porcelain'), '', 'the main checkout is not touched');
  await assert.rejects(worktrees.startMerge(combined, '--upload-pack=x', 'm', 'k'), /not a valid branch name/);
});

test('Implement merges a run that was left out of a combined run by resolving its conflicts', { timeout: 60_000 }, async t => {
  const { repo, git, worktrees } = await repository(t);
  const values = new Map();
  const storage = { get: key => values.get(key), update: async (key, value) => values.set(key, value) };
  const secrets = new Map();
  const accounts = new Accounts({ get: async key => secrets.get(key), store: async (key, value) => secrets.set(key, value) });
  const seats = new SquadStore(storage);
  const profiles = roleNames.map((role, index) => ({ provider: 'claude', name: `${role} account`, configDir: `/profiles/claude/0000000${index}-0000-0000-0000-000000000000` }));
  for (const [index, role] of roleNames.entries()) await seats.save(role, { account: idOf(index), brief: '', status: 'Ready', blocker: '' });
  const prompts = [];
  /** How the worker treats an open merge: 'resolve', 'leave' the markers, or report 'blocked'. */
  let merge = 'leave';
  const host = {
    profiles: async () => profiles, executable: async () => '/bin/claude', folder: () => repo,
    settings: () => ({ model: 'sonnet', budgetUsd: 1, allowedCommands: [], timeoutMs: 60_000 }),
    run: async request => {
      const prompt = JSON.parse(request.prompt);
      prompts.push(prompt);
      const task = prompt.task ?? '';
      let report = { status: 'done', summary: `${request.role} did: ${task.slice(0, 40)}` };
      if (prompt.merge) {
        const text = await readFile(join(request.cwd, 'README.md'), 'utf8');
        assert.match(text, /^<<<<<<< /m, 'the worker starts on the open merge');
        if (merge === 'resolve') await writeFile(join(request.cwd, 'README.md'), status('beta and gamma'));
        if (merge === 'blocked') report = { status: 'blocked', summary: 'Both set the status.', question: 'Which status wins?' };
        if (merge === 'leave') report = { status: 'done', summary: 'Resolved.' };
      } else if (request.role === 'Implement') {
        if (/beta/.test(task)) await writeFile(join(request.cwd, 'README.md'), status('beta'));
        if (/gamma/.test(task)) await writeFile(join(request.cwd, 'README.md'), status('gamma'));
        if (/notes/.test(task)) await writeFile(join(request.cwd, 'notes.txt'), 'notes\n');
      }
      return JSON.stringify({
        type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.1, num_turns: 2, session_id: `s-${prompts.length}`,
        structured_output: { files_changed: [], tests: '', memory: [], ...report }
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
    request: 'Two statuses', summary: 'Two statuses', parallel: true,
    tasks: ['Set the status to beta', 'Set the status to gamma'].map(brief => ({ role: 'Implement', brief }))
  });
  const ids = (await call('squad_approve_plan', { planId: plan.id })).runs.map(run => run.id);
  for (const runId of ids) await call('squad_run_step', { runId, waitSeconds: 20 });
  await assert.rejects(call('squad_resolve', { runId: ids[0] }), /Only a combined run/);
  const { run, note } = await call('squad_combine', { runIds: ids });
  assert.match(note, /Use Resolve conflicts on the combined run/);
  assert.deepEqual(run.combined.map(part => [part.merged, part.conflicts ?? null]), [[true, null], [false, ['README.md']]]);
  const tree = run.repositories[0];
  const inside = (...args) => execFileSync('git', args, { cwd: tree.worktree, encoding: 'utf8' });

  // The new step goes before the checks that are still to run.
  const added = await call('squad_resolve', { runId: run.id });
  assert.deepEqual(added.run.steps.map(step => [step.role, step.status, step.resolvesRunId ?? null]), [['Implement', 'pending', ids[1]], ['Review', 'pending', null], ['Tests', 'pending', null]]);
  assert.match(added.run.steps[0].brief, /Merge the change “Set the status to gamma” into this branch.*\(README\.md\)/);
  await assert.rejects(call('squad_resolve', { runId: run.id }), /steps already merge them/);

  // A worker that leaves the markers in: the merge is undone, and the run stays left out.
  let outcome = await call('squad_run_step', { runId: run.id, waitSeconds: 20 });
  let step = outcome.run.steps[0];
  assert.equal(step.status, 'blocked');
  assert.match(step.summary, /^Conflict markers remain in README\.md, so the merge was undone\. Resolved\./);
  assert.equal(inside('status', '--porcelain'), '', 'the worktree is back to before the merge');
  assert.equal(await readFile(join(tree.worktree, 'README.md'), 'utf8'), status('beta'));
  assert.deepEqual(outcome.run.combined[1].merged, false);
  assert.deepEqual(prompts.at(-1).merge.conflicting_files, ['README.md']);
  assert.match(prompts.at(-1).merge.note, /Do not run git merge, commit/);

  // A worker that asks: the merge is undone, and the answer opens it again in the same session.
  merge = 'blocked';
  outcome = await call('squad_run_step', { runId: run.id, waitSeconds: 20 });
  assert.equal(outcome.run.steps[0].question, 'Which status wins?');
  assert.equal(inside('status', '--porcelain'), '');
  merge = 'resolve';
  outcome = await call('squad_answer', { runId: run.id, answer: 'Keep both.', waitSeconds: 20 });
  assert.equal(prompts.at(-1).answer, 'Keep both.');
  assert.deepEqual(prompts.at(-1).merge.conflicting_files, ['README.md'], 'the reopened merge is described again');
  step = outcome.run.steps[0];
  assert.equal(step.status, 'done');
  assert.deepEqual(outcome.run.combined.map(part => [part.merged, part.conflicts ?? null, part.resolved ?? null]), [[true, null, null], [true, null, ['README.md']]]);
  assert.equal(await readFile(join(tree.worktree, 'README.md'), 'utf8'), status('beta and gamma'));
  assert.equal(inside('log', '-1', '--format=%s').trim(), 'Merge Set the status to gamma');
  assert.equal(inside('status', '--porcelain'), '');
  assert.equal(chat.run(ids[1]).combinedInto, run.id);
  assert.match(outcome.run.request, /Combined: Set the status to beta; Set the status to gamma/);
  assert.match(chat.snapshot().entries.at(-1).text, /Merged “Set the status to gamma”: Implement resolved the conflicts in README\.md/);
  await assert.rejects(call('squad_resolve', { runId: run.id }), /No run is left out/);

  // The checks then see both changes, and the finished branch holds the merge.
  await call('squad_run_step', { runId: run.id, waitSeconds: 20 });
  assert.deepEqual(prompts.at(-1).changed_files, ['README.md']);
  const finished = await call('squad_finish_run', { runId: run.id });
  assert.ok(finished.run.repositories[0].commit);
  assert.equal(git('show', `${tree.branch}:README.md`), status('beta and gamma'));
  assert.equal(git('status', '--porcelain'), '', 'the main checkout is not touched');
});
