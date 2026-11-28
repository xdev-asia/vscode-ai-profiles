const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdir, mkdtemp, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { test } = require('node:test');
const { allEnvFiles, envDenyRules, envFilesFor, loadEnv, parseDotenv, validEnvFile } = require('../dist/squad-env.js');
const { workerArguments } = require('../dist/squad-worker.js');
const { Worktrees } = require('../dist/squad-worktree.js');

test('.env files are parsed, kept inside the repository, and never change the worker itself', async t => {
  assert.deepEqual(parseDotenv([
    '# comment', 'export DB_URL="postgres://u:p@db/app"', "TOKEN='a b # c'", 'PLAIN=value # note', 'MULTI="one\\ntwo"', 'bad line', '  SPACED = x  '
  ].join('\n')), { DB_URL: 'postgres://u:p@db/app', TOKEN: 'a b # c', PLAIN: 'value', MULTI: 'one\ntwo', SPACED: 'x' });
  assert.equal(validEnvFile('.env'), true);
  assert.equal(validEnvFile('api/.env.local'), true);
  assert.equal(validEnvFile('../other/.env'), false);
  assert.equal(validEnvFile('/etc/passwd'), false);

  const folder = await mkdtemp(join(tmpdir(), 'squad-env-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  await mkdir(join(folder, 'services', 'api'), { recursive: true });
  await writeFile(join(folder, 'services', 'api', '.env'), 'DB_URL=postgres://x\nANTHROPIC_API_KEY=k\nCLAUDE_CONFIG_DIR=/x\nCODEX_HOME=/y\nPATH=/evil\nFLAG=1\n');
  await writeFile(join(folder, 'services', 'api', '.env.test'), 'FLAG=2\n');
  const setting = { 'services/api': ['.env', '.env.test', '../escape'], web: ['.env'] };
  const files = envFilesFor(setting, folder, 'services/api');
  assert.deepEqual(files.map(file => [file.file, file.names, file.skipped]), [
    ['.env', ['DB_URL', 'FLAG'], ['ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'PATH']],
    ['.env.test', ['FLAG'], []]
  ]);
  assert.deepEqual(loadEnv(files), { DB_URL: 'postgres://x', FLAG: '2' }, 'later files win; blocked names are left out');
  assert.equal(envFilesFor({ api: ['.env'] }, folder, 'services/api').length, 1, 'a repository can be keyed by its folder name');
  assert.match(allEnvFiles(setting, folder).find(file => file.repo === 'web').problem, /not found/);
  assert.deepEqual(envDenyRules(['/home/u/app/.env']), ['Read(//home/u/app/.env)']);

  const base = { role: 'Tests', mode: 'work', prompt: 'p', system: 's' };
  const args = workerArguments({ ...base, settings: { budgetUsd: 1, allowedCommands: [], timeoutMs: 1, env: { DB_URL: 'postgres://x' }, denyRead: ['/home/u/app/.env'] } }, { system: '/tmp/x/system.md' });
  assert.equal(args[args.indexOf('--disallowedTools') + 1], 'Read(//home/u/app/.env)');
  assert.ok(!args.join(' ').includes('postgres://x'), 'values never reach the command line');
});

test('a deploy pushes the remote source branch to a new branch and asks GitLab for a merge request into the deploy branch', async t => {
  const root = await mkdtemp(join(tmpdir(), 'xdev-deploy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  const remote = join(root, 'remote.git');
  const run = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '-q', '--bare', '-b', 'dev', remote]);
  run(remote, 'config', 'receive.advertisePushOptions', 'true');
  execFileSync('git', ['init', '-q', '-b', 'dev', repo]);
  run(repo, 'config', 'user.email', 'dev@example.com');
  run(repo, 'config', 'user.name', 'Dev');
  await writeFile(join(repo, 'a.txt'), 'one\n');
  run(repo, 'add', '.');
  run(repo, 'commit', '-q', '-m', 'init');
  run(repo, 'remote', 'add', 'origin', remote);
  run(repo, 'push', '-q', 'origin', 'dev', 'dev:build-dev');
  await writeFile(join(repo, 'a.txt'), 'two\n');
  run(repo, 'commit', '-q', '-am', 'feature');
  const feature = run(repo, 'rev-parse', 'HEAD');
  run(repo, 'push', '-q', 'origin', 'dev');

  const worktrees = new Worktrees(join(root, 'trees'));
  assert.equal(await worktrees.fetchBranch(repo, 'origin', 'build-dev'), true);
  assert.equal(await worktrees.fetchBranch(repo, 'origin', 'missing'), false);
  assert.equal(await worktrees.fetchBranch(repo, 'origin', '--upload-pack=x'), false);
  await worktrees.fetchBranch(repo, 'origin', 'dev');
  assert.equal(await worktrees.contains(repo, 'origin', 'dev', feature), true);
  assert.equal(await worktrees.contains(repo, 'origin', 'build-dev', feature), false);
  assert.equal(await worktrees.behind(repo, 'origin', 'dev', 'build-dev'), 1);

  await assert.rejects(worktrees.deploy(repo, { from: 'dev', to: 'build-dev', branch: 'xdev/deploy/1', title: 't', mode: 'push' }), /GitLab remote/);
  const result = await worktrees.deploy(repo, { from: 'dev', to: 'build-dev', branch: 'xdev/deploy/12345678', title: 'Deploy dev → build-dev', mode: 'gitlab' });
  assert.deepEqual(result, { remote: 'origin', target: 'build-dev', url: undefined, mergeRequest: true });
  assert.equal(run(remote, 'rev-parse', 'xdev/deploy/12345678'), feature, 'the deploy branch is the remote dev, not the local checkout');
  assert.notEqual(run(remote, 'rev-parse', 'build-dev'), feature, 'nothing is merged');
});

test('a worker step is told which variables are set, never their values', async () => {
  const { setImmediate: tick } = require('node:timers/promises');
  const { Accounts } = require('../dist/accounts.js');
  const { SquadChat } = require('../dist/squad-chat.js');
  const { SquadStore } = require('../dist/squad.js');
  const values = new Map();
  const storage = { get: key => values.get(key), update: async (key, value) => values.set(key, value) };
  const secrets = new Map();
  const accounts = new Accounts({ get: async key => secrets.get(key), store: async (key, value) => secrets.set(key, value) });
  const squad = new SquadStore(storage);
  const roles = ['Lead', 'Implement', 'Review', 'Tests'];
  const profiles = roles.map((role, index) => ({ provider: 'claude', name: role, configDir: `/profiles/claude/0000000${index}-0000-0000-0000-000000000000` }));
  for (const [index, role] of roles.entries()) await squad.save(role, { account: `claude:0000000${index}-0000-0000-0000-000000000000`, brief: '', status: 'Ready', blocker: '' });
  const requests = [];
  const ok = output => JSON.stringify({ type: 'result', subtype: 'success', total_cost_usd: 0, structured_output: output });
  const host = {
    profiles: async () => profiles, executable: async () => '/bin/claude', folder: () => '/repo',
    settings: role => ({ budgetUsd: 1, allowedCommands: ['npm test'], timeoutMs: 60_000, ...(role === 'Implement' ? { env: { DB_URL: 'postgres://secret' } } : {}) }),
    run: async request => {
      requests.push(request);
      return request.mode === 'plan' ? ok({ reply: 'One step', tasks: [{ role: 'Implement', brief: 'Do it' }] })
        : ok({ status: 'done', summary: 'ok', files_changed: [], tests: '', memory: [] });
    },
    worktrees: {
      async create(folder, id) { return { repo: folder, path: `/wt/${id.slice(0, 8)}`, branch: `xdev/squad/${id.slice(0, 8)}`, base: 'b' }; },
      async remove() {}, async commit() { return { commit: 'c', stat: '', files: 0 }; },
      async changes() { return []; }, async changedFiles() { return []; }, async discard() {}
    }
  };
  const chat = new SquadChat(storage, accounts, squad, () => {}, host);
  await chat.send('Do something');
  while (chat.snapshot().busy) await tick();
  await (await chat.approve(chat.snapshot().plan.id)).finished;
  await (await chat.runStep(chat.snapshot().runs[0].id)).finished;
  const step = requests.find(request => request.mode === 'work');
  assert.deepEqual(JSON.parse(step.prompt).environment_variables.names, ['DB_URL']);
  assert.ok(!step.prompt.includes('postgres://secret'));
  assert.equal(step.settings.env.DB_URL, 'postgres://secret', 'the value reaches the process environment through settings');
});

test('a repository without the configured base branch starts from its remote default branch and says so', async t => {
  const root = await mkdtemp(join(tmpdir(), 'xdev-base-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'ops');
  const remote = join(root, 'ops.git');
  const run = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  execFileSync('git', ['clone', '-q', remote, repo], { stdio: 'ignore' });
  run(repo, 'config', 'user.email', 'dev@example.com');
  run(repo, 'config', 'user.name', 'Dev');
  await writeFile(join(repo, 'a.txt'), 'one\n');
  run(repo, 'add', '.');
  run(repo, 'commit', '-q', '-m', 'init');
  run(repo, 'push', '-q', 'origin', 'main');
  run(repo, 'remote', 'set-head', 'origin', 'main');
  run(repo, 'checkout', '-q', '-b', 'feature');

  const worktrees = new Worktrees(join(root, 'trees'));
  const tree = await worktrees.create(repo, 'abcdef12-0000', undefined, 'origin/dev');
  assert.equal(tree.source, 'main');
  assert.equal(tree.fallbackFrom, 'origin/dev');
  assert.equal(tree.base, run(repo, 'rev-parse', 'origin/main'));
  const exact = await worktrees.create(repo, 'abcdef13-0000', undefined, 'origin/main');
  assert.equal(exact.fallbackFrom, undefined);
  assert.equal(await worktrees.hasRemoteBranch(repo, 'origin', 'main'), true);
  assert.equal(await worktrees.hasRemoteBranch(repo, 'origin', 'dev'), false);
  run(repo, 'remote', 'remove', 'origin');
  await assert.rejects(worktrees.create(repo, 'abcdef14-0000', undefined, 'origin/dev'), /not a valid base branch|does not exist/);
});
