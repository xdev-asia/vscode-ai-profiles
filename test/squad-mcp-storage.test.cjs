const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { existsSync, readFileSync } = require('node:fs');
const { mkdir, mkdtemp, rm, symlink, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { PassThrough } = require('node:stream');
const { setImmediate: tick } = require('node:timers/promises');
const { test } = require('node:test');
const { Accounts } = require('../dist/accounts.js');
const { disposableRun, settledAt, SquadChat } = require('../dist/squad-chat.js');
const { mcpRule, readMcpGrants, readProjectMcp, readServer, workerMcp } = require('../dist/squad-mcp.js');
const { folderSize, formatBytes, freeBytes, sessionFolder, sessionFolders } = require('../dist/squad-storage.js');
const { SquadStore } = require('../dist/squad.js');
const { describeTool, runClaude, workerArguments } = require('../dist/squad-worker.js');

const day = 86_400_000;

test('MCP grants come from the project settings, with servers from .mcp.json or defined inline', async t => {
  const project = {
    db: { command: 'pg-mcp', args: ['--readonly'], env: { PGPASSWORD: 'secret' }, extra: 'dropped' },
    docs: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer x' } }
  };
  const grants = readMcpGrants({
    db: { tools: ['query', 'list_tables', 'query', 'bad tool'] },
    docs: { tools: ['*'], roles: ['Lead', 'Nobody'] },
    local: { command: 'node', args: ['server.js'], tools: ['search'], roles: ['Implement'] },
    missing: { tools: ['x'] },
    empty: { command: 'x' },
    'bad name': { tools: ['x'] }
  }, project);
  assert.deepEqual(grants.find(grant => grant.name === 'db'), {
    name: 'db', tools: ['query', 'list_tables'], roles: ['Lead', 'Implement', 'Tests'], source: '.mcp.json',
    server: { type: 'stdio', command: 'pg-mcp', args: ['--readonly'], env: { PGPASSWORD: 'secret' } }
  });
  assert.deepEqual(grants.find(grant => grant.name === 'docs').roles, ['Lead']);
  assert.equal(grants.find(grant => grant.name === 'local').source, 'settings');
  assert.match(grants.find(grant => grant.name === 'missing').problem, /No server with this name in \.mcp\.json/);
  assert.match(grants.find(grant => grant.name === 'empty').problem, /tools/);
  assert.match(grants.find(grant => grant.name === 'bad name').problem, /server name/);
  assert.equal(readServer({ command: 'x', url: 'https://y' }), undefined, 'a server is either a command or a url');
  assert.equal(readServer({ url: 'file:///etc/passwd' }), undefined);
  assert.deepEqual(readMcpGrants(undefined), []);

  assert.equal(mcpRule('db', 'query'), 'mcp__db__query');
  assert.equal(mcpRule('docs', '*'), 'mcp__docs');
  assert.deepEqual(workerMcp(grants, 'Implement'), {
    servers: { db: grants[0].server, local: { type: 'stdio', command: 'node', args: ['server.js'] } },
    allowed: ['mcp__db__query', 'mcp__db__list_tables', 'mcp__local__search']
  });
  assert.deepEqual(Object.keys(workerMcp(grants, 'Lead').servers), ['db', 'docs']);
  assert.equal(workerMcp(grants, 'Review'), undefined, 'roles without a grant get no servers');

  const folder = await mkdtemp(join(tmpdir(), 'squad-mcp-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  assert.deepEqual(readProjectMcp(folder), {});
  await writeFile(join(folder, '.mcp.json'), JSON.stringify({ mcpServers: { codegraph: { type: 'stdio', command: 'codegraph', args: ['serve', '--mcp'] } } }));
  assert.deepEqual(Object.keys(readProjectMcp(folder)), ['codegraph']);
});

function fakeSpawn() {
  const calls = [];
  const spawn = (command, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.kill = () => true;
    const at = args.indexOf('--mcp-config');
    calls.push({ args, config: at >= 0 ? JSON.parse(readFileSync(args[at + 1], 'utf8')) : undefined, path: at >= 0 ? args[at + 1] : undefined });
    setImmediate(() => {
      child.stdout.end(JSON.stringify({ type: 'result', subtype: 'success', structured_output: { status: 'done', summary: 'ok', files_changed: [], tests: '', memory: [] } }));
      child.emit('close', 0);
    });
    return child;
  };
  return { spawn, calls };
}

test('workers start only the granted servers from a private file, and AI gates get none', async () => {
  const mcp = { servers: { db: { type: 'stdio', command: 'pg-mcp', env: { PGPASSWORD: 'secret' } } }, allowed: ['mcp__db__query'] };
  const settings = { budgetUsd: 1, allowedCommands: ['npm test'], timeoutMs: 60_000, mcp };
  const base = { role: 'Implement', mode: 'work', prompt: 'p', system: 's', settings };

  const args = workerArguments(base, { system: '/tmp/x/system.md', mcp: '/tmp/x/mcp.json' });
  assert.ok(args.includes('--strict-mcp-config'), 'the user and project servers are never loaded');
  assert.equal(args[args.indexOf('--mcp-config') + 1], '/tmp/x/mcp.json');
  assert.match(args[args.indexOf('--allowedTools') + 1], /,mcp__db__query$/);
  assert.ok(!workerArguments(base, { system: '/tmp/x/system.md' }).includes('--mcp-config'), 'no config file, no servers');
  assert.ok(!workerArguments({ ...base, mode: 'gate' }, { system: '/tmp/x/system.md', mcp: '/tmp/x/mcp.json' }).includes('--mcp-config'));
  assert.ok(!workerArguments({ ...base, mode: 'gate' }, { system: '/tmp/x/system.md', mcp: '/tmp/x/mcp.json' }).join(' ').includes('mcp__db'));

  const profile = { provider: 'claude', name: 'W', configDir: '/profiles/claude/1' };
  const work = fakeSpawn();
  await runClaude({ ...base, executable: '/bin/claude', profile, cwd: '/repo' }, work.spawn);
  assert.deepEqual(work.calls[0].config, { mcpServers: mcp.servers });
  assert.ok(!work.calls[0].args.join(' ').includes('secret'), 'tokens stay off the command line');
  assert.equal(existsSync(work.calls[0].path), false, 'the config file is deleted after the run');

  assert.deepEqual(describeTool('mcp__ward__lookup_ward', {}, '/repo'), { kind: 'tool', text: 'ward · lookup_ward' });
  assert.deepEqual(describeTool('mcp__my_db__run_query', {}, '/repo'), { kind: 'tool', text: 'my_db · run_query' });

  const gate = fakeSpawn();
  await runClaude({ ...base, mode: 'gate', executable: '/bin/claude', profile, cwd: '/repo' }, gate.spawn);
  assert.equal(gate.calls[0].path, undefined);
});

test('storage helpers count files without following links and find worker transcripts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'squad-storage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'tree', 'src'), { recursive: true });
  await mkdir(join(root, 'big'));
  await writeFile(join(root, 'tree', 'src', 'a.txt'), 'x'.repeat(5000));
  await writeFile(join(root, 'big', 'blob'), 'y'.repeat(200_000));
  await symlink(join(root, 'big'), join(root, 'tree', 'node_modules'));
  const size = await folderSize(join(root, 'tree'));
  assert.equal(size.partial, false);
  assert.ok(size.bytes >= 5000 && size.bytes < 100_000, `linked folder not counted: ${size.bytes}`);
  assert.equal((await folderSize(join(root, 'tree'), Date.now() - 1)).partial, true);
  assert.ok((await freeBytes(join(root, 'not', 'yet'))) > 0);

  const worktrees = '/home/u/.local/share/code-server/User/globalStorage/x.y/squad-worktrees/a1b2c3d4e5f60718';
  assert.equal(sessionFolder('/c', `${worktrees}/5e6f7a8b/1-billing-api`),
    '/c/projects/-home-u--local-share-code-server-User-globalStorage-x-y-squad-worktrees-a1b2c3d4e5f60718-5e6f7a8b-1-billing-api');
  const config = join(root, 'claude');
  await mkdir(sessionFolder(config, `${worktrees}/5e6f7a8b/1-api`), { recursive: true });
  await mkdir(sessionFolder(config, `${worktrees}0/5e6f7a8b/1-api`), { recursive: true });
  await mkdir(sessionFolder(config, '/home/u/work/app'), { recursive: true });
  assert.deepEqual(await sessionFolders(config, worktrees), [sessionFolder(config, `${worktrees}/5e6f7a8b/1-api`)]);
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(285 * 1024 ** 2), '285 MB');
});

function memento() {
  const values = new Map();
  return { get: key => values.get(key), update: async (key, value) => values.set(key, value) };
}

async function setup(extraHost = {}) {
  const storage = memento();
  const secrets = new Map();
  const accounts = new Accounts({ get: async key => secrets.get(key), store: async (key, value) => secrets.set(key, value) });
  const squad = new SquadStore(storage);
  const roles = ['Lead', 'Implement', 'Review', 'Tests'];
  const profiles = roles.map((role, index) => ({ provider: 'claude', name: `${role} account`, configDir: `/profiles/claude/0000000${index}-0000-0000-0000-000000000000` }));
  for (const [index, role] of roles.entries()) {
    await squad.save(role, { account: `claude:0000000${index}-0000-0000-0000-000000000000`, brief: '', status: 'Ready', blocker: '' });
  }
  const removed = [];
  const forgotten = [];
  const host = {
    profiles: async () => profiles,
    executable: async () => '/bin/claude',
    folder: () => '/repo',
    settings: () => ({ budgetUsd: 1, allowedCommands: [], timeoutMs: 60_000 }),
    run: async () => JSON.stringify({ type: 'result', subtype: 'success', total_cost_usd: 0, structured_output: { reply: 'One step', tasks: [{ role: 'Implement', brief: 'Do it' }] } }),
    worktrees: {
      async create(folder, id) { return { repo: folder, path: `/wt/${id.slice(0, 8)}`, branch: `xdev/squad/${id.slice(0, 8)}`, base: 'b' }; },
      async remove(tree) { removed.push(tree.branch); },
      async commit() { return { commit: 'c', stat: '', files: 0 }; },
      async changes() { return []; }, async changedFiles() { return []; }, async discard() {}
    },
    forgetSessions: async paths => { forgotten.push(...paths); },
    ...extraHost
  };
  const chat = new SquadChat(storage, accounts, squad, () => {}, host);
  return { chat, removed, forgotten };
}

function run(id, { status = 'done', pushed, merged, finished = 1_000, time = 500 } = {}) {
  return {
    id, request: `Request ${id}`, prompt: 'p', time, status, costUsd: 0, sessions: [], finished,
    steps: [{ role: 'Implement', brief: 'b', profile: 'p', kind: 'claude', accountId: 'a', revision: 'r', status: 'done' }],
    trees: [{ target: '.', repo: '/repo', path: `/wt/${id}`, branch: `xdev/squad/${id}`, base: 'b',
      ...(pushed ? { pushed: { remote: 'origin', target: 'dev', mergeRequest: true, time: pushed } } : {}), ...(merged ? { merged } : {}) }]
  };
}

async function plan(chat) {
  await chat.send('Do something');
  const end = Date.now() + 1_000;
  while (chat.snapshot().busy) {
    assert.ok(Date.now() < end);
    await tick();
  }
  return chat.snapshot().plan;
}

test('a run is disposable only when finished and merged or pushed with nothing committed since', () => {
  assert.equal(disposableRun(run('a', { pushed: 2_000 })), true);
  assert.equal(disposableRun(run('a', { merged: 2_000 })), true);
  assert.equal(disposableRun(run('a')), false, 'local commits only');
  assert.equal(disposableRun(run('a', { pushed: 900 })), false, 'committed again after the push');
  assert.equal(disposableRun(run('a', { pushed: 2_000, status: 'active' })), false);
  assert.equal(settledAt(run('a', { pushed: 2_000 })), 2_000);
});

test('the tenth run makes room only by cleaning up a merged or pushed run', async () => {
  const { chat, removed, forgotten } = await setup();
  const keep = Array.from({ length: 9 }, (_, index) => run(`k${index}`, { pushed: 5_000 }));
  await chat.storage.update('squadChat.v1', { entries: [], runs: [...keep, run('oldest')] });
  let current = await plan(chat);
  await assert.rejects(chat.approve(current.id), /keeps 10 runs per project/);
  assert.deepEqual(removed, [], 'nothing is deleted when the oldest run has unpushed work');

  await chat.storage.update('squadChat.v1', { ...chat.read(), runs: [...keep, run('oldest', { pushed: 5_000 })] });
  await (await chat.approve(current.id)).finished;
  assert.deepEqual(removed, ['xdev/squad/oldest']);
  assert.deepEqual(forgotten, ['/wt/oldest'], 'worker transcripts of the removed run are deleted');
  const runs = chat.snapshot().runs;
  assert.equal(runs.length, 10);
  assert.ok(!runs.some(item => item.id === 'oldest'));
  assert.match(chat.snapshot().entries.map(entry => entry.text).join('\n'), /Cleaned up the run “Request oldest” \(xdev\/squad\/oldest\) to make room/);
});

test('runs merged or pushed long ago are pruned, and a full disk blocks new runs', async () => {
  const now = 100 * day;
  const { chat, removed } = await setup();
  await chat.storage.update('squadChat.v1', { entries: [], runs: [
    run('fresh', { pushed: now - day }), run('stale', { pushed: now - 10 * day }), run('local', { finished: now - 30 * day }),
    run('merged', { merged: now - 8 * day })
  ] });
  assert.deepEqual(chat.staleRuns(7, now).map(item => item.id), ['stale', 'merged']);
  assert.deepEqual(chat.staleRuns(0, now), [], '0 turns cleanup off');
  assert.equal(await chat.pruneRuns(7, now), 2);
  assert.deepEqual(removed.sort(), ['xdev/squad/merged', 'xdev/squad/stale']);
  assert.deepEqual(chat.snapshot().runs.map(item => item.id), ['fresh', 'local']);
  await assert.rejects(chat.cleanRun('local'), /not merged or pushed/);
  await chat.cleanRun('fresh');
  assert.deepEqual(chat.snapshot().runs.map(item => item.id), ['local']);

  const full = await setup({ checkDisk: async () => { throw new Error('Only 1 GB is free'); } });
  const current = await plan(full.chat);
  await assert.rejects(full.chat.approve(current.id), /Only 1 GB is free/);
  assert.equal(full.chat.snapshot().plan.id, current.id, 'the plan stays for later');
});
