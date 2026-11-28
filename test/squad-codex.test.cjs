// Codex as a headless Squad worker: its arguments, its sandbox rules, its event stream, and a step run through SquadChat.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { existsSync, readFileSync } = require('node:fs');
const Module = require('node:module');
const { join } = require('node:path');
const { PassThrough } = require('node:stream');
const { test } = require('node:test');
const { Accounts } = require('../dist/accounts.js');
const { SquadChat, workerCli } = require('../dist/squad-chat.js');
const { SquadStore } = require('../dist/squad.js');
const {
  CodexOutcome, codexActivities, codexArguments, codexCommand, codexDenied, codexEnvironment, codexInput, runCodex, runWorker, strictSchema, withoutNulls
} = require('../dist/squad-codex.js');
const { parseGateOutput, parsePlanOutput, parseWorkerOutput, workerSchema } = require('../dist/squad-worker.js');

const own = join('/accounts', 'codex', 'aaaa');
const profile = { provider: 'codex', name: 'codex-main', configDir: own };
const settings = { model: 'sonnet', budgetUsd: 1, allowedCommands: ['npm test'], timeoutMs: 60_000 };
const request = { profile, cwd: join('/work', 'tree'), role: 'Implement', mode: 'work', prompt: '{"task":"x"}', system: 'Be "careful" & brief.\nSecond line.', settings };
const value = (args, key) => args[args.findIndex((arg, index) => args[index - 1] === '-c' && arg.startsWith(`${key}=`))]?.slice(key.length + 1);

test('a schema becomes strict for Codex, and nulls in the answer mean "not given"', () => {
  const strict = strictSchema(workerSchema('work'));
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'object' && node.properties) {
      assert.equal(node.additionalProperties, false);
      assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort(), 'every property is required');
    }
    for (const child of Object.values(node)) walk(child);
  };
  walk(strict);
  assert.deepEqual(strict.properties.status, { type: 'string', enum: ['done', 'blocked'] }, 'a required property is unchanged');
  assert.deepEqual(strict.properties.question.type, ['string', 'null']);
  assert.deepEqual(strict.properties.artifacts.type, ['array', 'null']);
  const artifact = strict.properties.artifacts.items;
  assert.deepEqual(artifact.properties.name.type, 'string');
  assert.deepEqual(artifact.properties.kind, { type: ['string', 'null'], enum: ['markdown', 'html', 'text', 'json', null] });
  assert.deepEqual(strictSchema(workerSchema('plan')).properties.tasks.items.properties.model.type, ['string', 'null']);
  assert.deepEqual(workerSchema('work').required, ['status', 'summary', 'files_changed', 'tests', 'memory'], 'the schema Claude Code gets is not changed');

  assert.deepEqual(withoutNulls({ status: 'done', question: null, artifacts: [{ name: 'a', kind: null, content: 'c' }, null], memory: [] }),
    { status: 'done', artifacts: [{ name: 'a', content: 'c' }], memory: [] });
});

test('no command of a Codex worker reads an account folder, a .env file, or the usual places of credentials', () => {
  const home = join('/home', 'dev');
  const other = join('/accounts', 'claude', 'bbbb');
  const denied = codexDenied({ ...request, accounts: [own, other], settings: { ...settings, denyRead: [join('/work', 'repo', '.env')] } }, home, 'linux');
  assert.ok(denied.includes(other), 'another account is denied as a whole');
  assert.ok(!denied.includes(own), 'its own folder is not, or Codex could not work');
  assert.ok(denied.includes(join(own, 'auth.json')), 'but its sign-in file is');
  assert.ok(denied.includes(join('/work', 'repo', '.env')));
  for (const place of ['.ssh', '.aws', '.claude', '.codex', '.gemini', join('.config', 'gh')]) assert.ok(denied.includes(join(home, place)), place);
  assert.ok(!denied.some(path => /\.npmrc|\.gitconfig/.test(path)), 'files that building and testing read stay readable');

  // A place that holds the worktree or the account itself is not denied.
  const inside = codexDenied({ ...request, cwd: join(home, '.codex', 'trees', 'a'), accounts: [] }, home, 'linux');
  assert.ok(!inside.includes(join(home, '.codex')));
  const defaultHome = { ...profile, configDir: join(home, '.codex') };
  const mine = codexDenied({ ...request, profile: defaultHome, accounts: [join(home, '.codex')] }, home, 'linux');
  assert.ok(!mine.includes(join(home, '.codex')) && mine.includes(join(home, '.codex', 'auth.json')));
  // Windows paths compare without case.
  assert.ok(!codexDenied({ ...request, cwd: 'C:\\Users\\Dev\\.codex\\tree', accounts: [] }, 'c:\\users\\dev', 'win32').includes(join('c:\\users\\dev', '.codex')));
});

test('Codex arguments confine a run by role, keep the user\'s config out, and never carry the prompt', () => {
  const files = { schema: join('/tmp', 'schema.json') };
  const work = codexArguments({ ...request, accounts: [join('/accounts', 'claude', 'bbbb')] }, files, { platform: 'linux', home: '/home/dev' });
  assert.deepEqual(work.slice(0, 7), ['exec', '--json', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '--output-schema', files.schema]);
  assert.equal(value(work, 'default_permissions'), '"xdev"');
  assert.equal(value(work, 'permissions.xdev.extends'), '":workspace"');
  assert.match(value(work, 'permissions.xdev.filesystem'), /^\{ ".+" = "deny"(, ".+" = "deny")+ \}$/);
  assert.ok(value(work, 'permissions.xdev.filesystem').includes(`${JSON.stringify(join('/accounts', 'claude', 'bbbb'))} = "deny"`));
  assert.equal(JSON.parse(value(work, 'developer_instructions')), request.system, 'the instructions are one TOML string');
  assert.equal(value(work, 'cli_auth_credentials_store'), '"file"');
  assert.equal(work.at(-1), '-', 'the prompt comes from standard input');
  assert.ok(!work.includes(request.prompt) && !work.includes('-m') && !work.includes('--ephemeral'));
  assert.ok(!work.some(arg => /windows|sonnet|danger|bypass/.test(arg)), 'no Windows setting elsewhere, no Claude model, no way around the sandbox');

  // Reading roles and every plan, question and gate are read-only.
  for (const [role, mode] of [['Review', 'work'], ['Lead', 'plan'], ['Implement', 'ask'], ['Lead', 'gate']]) {
    const args = codexArguments({ ...request, role, mode }, files, { platform: 'linux' });
    assert.equal(value(args, 'permissions.xdev.extends'), '":read-only"', `${role} ${mode}`);
    assert.equal(args.includes('--ephemeral'), mode !== 'work');
  }
  assert.equal(value(codexArguments({ ...request, role: 'Tests' }, files, { platform: 'linux' }), 'permissions.xdev.extends'), '":workspace"');
  assert.ok(!codexArguments({ ...request, role: 'Lead', mode: 'plan', persist: true }, files, { platform: 'linux' }).includes('--ephemeral'), 'a kept Lead session is saved');

  // Windows needs a sandbox that can deny reads; the model is Codex's own setting.
  const windows = codexArguments({ ...request, settings: { ...settings, codexModel: 'gpt-5.5-codex' } }, files, { platform: 'win32', home: 'C:\\Users\\dev' });
  assert.equal(value(windows, 'windows.sandbox'), '"mxc"');
  assert.equal(value(windows, 'features.prefer_mxc'), 'true');
  assert.deepEqual(windows.slice(windows.indexOf('-m'), windows.indexOf('-m') + 2), ['-m', 'gpt-5.5-codex']);
  const elevated = codexArguments({ ...request, settings: { ...settings, codexWindowsSandbox: 'elevated' } }, files, { platform: 'win32' });
  assert.equal(value(elevated, 'windows.sandbox'), '"elevated"');
  assert.equal(value(elevated, 'features.prefer_mxc'), undefined);
  assert.ok(!codexArguments({ ...request, settings: { ...settings, codexModel: 'bad model; rm' } }, files, { platform: 'linux' }).includes('-m'));

  // A resumed session: the options first, then the session, then the prompt marker.
  const resumed = codexArguments({ ...request, resume: '01a2-b3' }, files, { platform: 'linux' });
  assert.deepEqual(resumed.slice(-3), ['resume', '01a2-b3', '-']);
  assert.ok(resumed.indexOf('--output-schema') < resumed.indexOf('resume'));

  // Through cmd.exe the instructions cannot be an argument: they lead the input instead.
  const script = codexArguments(request, files, { platform: 'win32', systemInPrompt: true });
  assert.equal(value(script, 'developer_instructions'), undefined);
  assert.match(codexInput(request, true), /^Instructions for this session\..*\nBe "careful" & brief\.\nSecond line\.\n\nTask data:\n\{"task":"x"\}$/s);
  assert.equal(codexInput(request, false), request.prompt);
});

test('Codex events become activity, with the command the model asked for', () => {
  assert.equal(codexCommand('"C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe" -NoProfile -Command \'git status --short\''), 'git status --short');
  assert.equal(codexCommand('"C:\\\\Program Files\\\\PowerShell\\\\7\\\\pwsh.exe" -Command "npm test"'), 'npm test');
  assert.equal(codexCommand('/bin/bash -lc "npm  run\n build"'), 'npm run build');
  assert.equal(codexCommand('zsh -lc \'ls -la\''), 'ls -la');
  assert.equal(codexCommand('git diff'), 'git diff');
  assert.equal(codexCommand(undefined), '');

  const cwd = join('/work', 'tree');
  const command = (type, extra) => ({ type, item: { id: 'i', type: 'command_execution', command: '/bin/bash -lc "npm test"', ...extra } });
  assert.deepEqual(codexActivities(command('item.started', { status: 'in_progress' }), cwd), [{ kind: 'run', text: 'npm test' }]);
  assert.deepEqual(codexActivities(command('item.completed', { status: 'completed', exit_code: 0 }), cwd), [], 'a command is listed once');
  assert.deepEqual(codexActivities(command('item.completed', { status: 'completed', exit_code: 1 }), cwd), [{ kind: 'failed', text: 'npm test' }]);
  assert.deepEqual(codexActivities(command('item.completed', { status: 'declined' }), cwd), [{ kind: 'denied', text: 'npm test' }]);
  const change = { type: 'item.completed', item: { type: 'file_change', status: 'completed', changes: [{ path: join(cwd, 'src', 'a.ts'), kind: 'update' }, { path: join(cwd, 'b.md'), kind: 'add' }] } };
  assert.deepEqual(codexActivities(change, cwd), [{ kind: 'edit', text: 'src/a.ts' }, { kind: 'edit', text: 'b.md' }]);
  assert.deepEqual(codexActivities({ ...change, type: 'item.started' }, cwd), []);
  assert.deepEqual(codexActivities({ type: 'item.completed', item: { type: 'web_search', query: 'toml inline table' } }, cwd), [{ kind: 'search', text: 'toml inline table' }]);
  assert.deepEqual(codexActivities({ type: 'item.started', item: { type: 'mcp_tool_call', server: 'docs', tool: 'search' } }, cwd), [{ kind: 'tool', text: 'docs · search' }]);
  assert.deepEqual(codexActivities({ type: 'item.completed', item: { type: 'agent_message', text: 'hi' } }, cwd), []);
  assert.deepEqual(codexActivities({ type: 'turn.started' }, cwd), []);
});

const report = { status: 'done', summary: 'Changed the status.', question: null, files_changed: ['README.md'], tests: 'none', memory: [], artifacts: null };
const lines = (...events) => events.map(event => JSON.stringify(event)).join('\n') + '\n';
const message = text => ({ type: 'item.completed', item: { id: 'm', type: 'agent_message', text } });

test('a Codex run comes back as the result the Squad reads', () => {
  const outcome = new CodexOutcome();
  for (const event of [
    { type: 'thread.started', thread_id: '01a2-thread' },
    { type: 'item.completed', item: { type: 'error', message: 'Under-development features enabled: prefer_mxc.' } },
    { type: 'turn.started' }, message('I will change the file.'),
    { type: 'item.completed', item: { type: 'command_execution', command: 'bash -lc "curl example.com"', status: 'declined' } },
    message(JSON.stringify(report)), { type: 'turn.completed', usage: { input_tokens: 10 } }
  ]) outcome.read(event);
  assert.equal(outcome.failed, undefined, 'a notice item is not a failure');
  assert.equal(outcome.finished, true);
  const result = parseWorkerOutput(outcome.result());
  assert.deepEqual([result.status, result.summary, result.filesChanged, result.sessionId, result.costUsd, result.turns], ['done', 'Changed the status.', ['README.md'], '01a2-thread', 0, 1]);
  assert.deepEqual(result.denied, ['Bash: curl example.com']);
  assert.equal(result.question, undefined);
  assert.deepEqual(result.artifacts, []);

  const plan = new CodexOutcome();
  plan.read(message(JSON.stringify({ reply: 'Plan', parallel: null, tasks: [{ role: 'Implement', brief: 'Build', repo: null, model: null }] })));
  plan.read({ type: 'turn.completed' });
  assert.deepEqual(parsePlanOutput(plan.result()), { reply: 'Plan', tasks: [{ role: 'Implement', brief: 'Build' }], costUsd: 0 });
  const gate = new CodexOutcome();
  gate.read(message('{"verdict":"changes","reason":"No test."}'));
  gate.read({ type: 'turn.completed' });
  assert.deepEqual(parseGateOutput(gate.result()), { verdict: 'changes', reason: 'No test.', costUsd: 0 });

  const failed = new CodexOutcome();
  failed.read({ type: 'turn.failed', error: { message: 'You have hit your usage limit.' } });
  assert.equal(failed.failed, 'You have hit your usage limit.');
  const prose = new CodexOutcome();
  prose.read(message('Sorry, I cannot.'));
  prose.read({ type: 'turn.completed' });
  assert.throws(() => parseWorkerOutput(prose.result()), /did not return a structured report/);
});

function fakeSpawn(behave) {
  const calls = [];
  const spawn = (command, args, options) => {
    const child = new EventEmitter();
    Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, killed: false });
    child.kill = signal => { child.killed = signal; setImmediate(() => child.emit('close', null)); return true; };
    const schemaFile = args[args.indexOf('--output-schema') + 1];
    const call = { command, args, options, child, input: '', schemaFile, schema: JSON.parse(readFileSync(schemaFile, 'utf8')) };
    child.stdin.setEncoding('utf8').on('data', chunk => { call.input += chunk; });
    calls.push(call);
    setImmediate(() => behave(child));
    return child;
  };
  return { spawn, calls };
}

test('runCodex starts the CLI under the account, streams activity, and cleans up', async () => {
  const activity = [];
  const done = fakeSpawn(child => {
    child.stdout.end(lines(
      { type: 'thread.started', thread_id: 'thread-1' }, { type: 'turn.started' },
      { type: 'item.started', item: { type: 'command_execution', command: 'bash -lc "git status"', status: 'in_progress' } },
      message(JSON.stringify(report)), { type: 'turn.completed', usage: {} }
    ));
    child.emit('close', 0);
  });
  const base = { ...request, executable: join('/bin', 'codex'), accounts: [own], onActivity: item => activity.push(item) };
  const result = parseWorkerOutput(await runCodex({ ...base, settings: { ...settings, env: { API_URL: 'http://localhost' } } }, done.spawn));
  assert.deepEqual([result.status, result.sessionId], ['done', 'thread-1']);
  assert.deepEqual(activity, [{ kind: 'run', text: 'git status' }]);
  const [call] = done.calls;
  assert.equal(call.command, join('/bin', 'codex'));
  assert.equal(call.args[0], 'exec');
  assert.equal(call.options.cwd, request.cwd);
  assert.equal(call.options.env.CODEX_HOME, own);
  assert.equal(call.options.env.API_URL, 'http://localhost', 'the project\'s variables reach the commands');
  assert.equal(call.options.env.OPENAI_API_KEY, undefined);
  assert.equal(call.input, request.prompt);
  assert.equal(call.schema.additionalProperties, false);
  assert.equal(existsSync(call.schemaFile), false, 'the schema file is removed after the run');

  // The same entry point runs either CLI by the account's provider.
  assert.equal(parseWorkerOutput(await runWorker(base, done.spawn)).sessionId, 'thread-1');
  await assert.rejects(runCodex({ ...base, profile: { ...profile, provider: 'claude' } }, done.spawn), /Codex terminal account/);

  const limit = fakeSpawn(child => {
    child.stdout.end(lines({ type: 'thread.started', thread_id: 't' }, { type: 'turn.failed', error: { message: 'You have hit your usage limit.' } }));
    child.emit('close', 1);
  });
  await assert.rejects(runCodex(base, limit.spawn), /^Error: Codex stopped: You have hit your usage limit\.$/);
  const signedOut = fakeSpawn(child => {
    child.stderr.end('Not logged in\n');
    child.emit('close', 1);
  });
  await assert.rejects(runCodex(base, signedOut.spawn), /Codex exited with code 1: Not logged in\. Sign in to the Codex account again/);
  const silent = fakeSpawn(child => child.emit('close', 0));
  await assert.rejects(runCodex(base, silent.spawn), /ended without an answer/);

  const hanging = fakeSpawn(() => {});
  const controller = new AbortController();
  const pending = runCodex({ ...base, signal: controller.signal }, hanging.spawn);
  await new Promise(resolve => setTimeout(resolve, 10));
  controller.abort();
  await assert.rejects(pending);
  assert.equal(hanging.calls[0].child.killed, 'SIGTERM');

  const env = codexEnvironment(base, { PATH: '/bin', CODEX_THREAD_ID: 'outer', CODEX_SANDBOX: 'seatbelt', OPENAI_API_KEY: 'k' });
  assert.deepEqual([env.PATH, env.CODEX_HOME, env.CODEX_THREAD_ID, env.CODEX_SANDBOX, env.OPENAI_API_KEY], ['/bin', own, undefined, undefined, undefined]);
});

test('a role with a Codex account works through Squad like one with Claude Code', { timeout: 60_000 }, async t => {
  const values = new Map();
  const storage = { get: key => values.get(key), update: async (key, value) => values.set(key, value) };
  const secrets = new Map();
  const accounts = new Accounts({ get: async key => secrets.get(key), store: async (key, value) => secrets.set(key, value) });
  const seats = new SquadStore(storage);
  const uuid = index => `0000000${index}-0000-0000-0000-000000000000`;
  const profiles = [
    { provider: 'claude', name: 'claude-lead', configDir: `/profiles/claude/${uuid(0)}` },
    { provider: 'codex', name: 'codex-dev', configDir: `/profiles/codex/${uuid(1)}` },
    { provider: 'gemini', name: 'gemini-x', configDir: `/profiles/gemini/${uuid(2)}` }
  ];
  await seats.save('Lead', { account: `claude:${uuid(0)}`, brief: '', status: 'Ready', blocker: '' });
  await seats.save('Implement', { account: `codex:${uuid(1)}`, brief: '', status: 'Ready', blocker: '' });
  await seats.save('Review', { account: `gemini:${uuid(2)}`, brief: '', status: 'Ready', blocker: '' });
  const requests = [];
  const providers = [];
  const tree = { repo: '/repo', path: '/trees/a', branch: 'xdev/squad/a', base: 'b' };
  const host = {
    profiles: async () => profiles, folder: () => '/repo',
    executable: async provider => { providers.push(provider); return `/bin/${provider}`; },
    settings: () => ({ model: 'sonnet', budgetUsd: 1, allowedCommands: ['npm test'], timeoutMs: 60_000 }),
    run: async request => {
      requests.push(request);
      return JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0, num_turns: 1, session_id: 'thread-9',
        structured_output: { status: 'done', summary: 'Built it.', files_changed: ['a.ts'], tests: '', memory: [] } });
    },
    worktrees: { create: async () => tree, commit: async () => ({ commit: 'c1', stat: 'a.ts | 1 +', files: 1 }), remove: async () => undefined, changes: async () => [], changedFiles: async () => ['a.ts'], discard: async () => undefined },
    repositories: async () => ['.']
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

  // The roster knows the Codex account as a worker; a Gemini account is not one.
  assert.deepEqual((await chat.roster()).map(seat => [seat.role, seat.account ?? null, seat.kind ?? null]),
    [['Lead', 'claude-lead', 'claude'], ['Implement', 'codex-dev', 'claude'], ['Review', null, null], ['Tests', null, null]]);
  assert.equal(workerCli({ kind: 'claude', accountId: `codex:${uuid(1)}` }), 'codex');
  assert.equal(workerCli({ kind: 'claude', accountId: `claude:${uuid(0)}` }), 'claude');
  assert.equal(workerCli({ kind: 'api', accountId: 'x' }), undefined);

  const task = { role: 'Implement', brief: 'Build the thing' };
  await assert.rejects(call('squad_submit_plan', { request: 'r', summary: 's', tasks: [{ ...task, model: 'haiku' }] }), /haiku is a Claude Code model, and codex-dev is a Codex account/);
  await assert.rejects(call('squad_submit_plan', { request: 'r', summary: 's', tasks: [{ ...task, account: `gemini:${uuid(2)}` }] }), /not a Claude Code or Codex account/);
  const { plan } = await call('squad_submit_plan', { request: 'Build it', summary: 'One task', tasks: [{ ...task, model: 'gpt-5.5-codex' }] });
  assert.deepEqual(plan.tasks.map(item => [item.role, item.account, item.kind, item.cli, item.model]), [['Implement', 'codex-dev', 'claude', 'codex', 'gpt-5.5-codex']]);
  assert.equal(chat.snapshot().plan.jobs[0].cli, 'codex', 'the panel is told which CLI runs the task');
  const approved = await call('squad_approve_plan', { planId: plan.id });
  const runId = approved.run.id;
  await assert.rejects(chat.startTerminalStep(runId), /Only Claude Code steps can continue in a terminal/);

  const outcome = await call('squad_run_step', { runId, waitSeconds: 20 });
  assert.deepEqual([outcome.run.steps[0].status, outcome.run.steps[0].cli, outcome.run.steps[0].summary], ['done', 'codex', 'Built it.']);
  const [worker] = requests;
  assert.deepEqual(providers, ['codex']);
  assert.equal(worker.executable, '/bin/codex');
  assert.equal(worker.profile.provider, 'codex');
  assert.match(worker.system, /^You are a headless Codex worker in xDev Squad\..*Your commands run in a sandbox/s);
  assert.doesNotMatch(worker.system, /allowed list|Write and Edit tools/);
  assert.deepEqual([worker.settings.codexModel, worker.settings.model], ['gpt-5.5-codex', 'sonnet'], 'the task\'s model is Codex\'s, not Claude Code\'s');
  assert.equal(JSON.parse(worker.prompt).allowed_commands, undefined, 'a Codex worker has a sandbox, not an allowed list');
  assert.deepEqual(worker.accounts, profiles.map(item => item.configDir), 'it is kept out of every account, of every provider');
  assert.match(chat.snapshot().entries.find(entry => entry.author === 'Implement').profile, /^codex-dev · Codex/);
  assert.deepEqual(chat.run(runId).sessions.map(session => [session.profileId, session.sessionId]), [[`codex:${uuid(1)}`, 'thread-9']]);
  await assert.rejects(chat.transcript(runId), /A transcript can be shown for Claude Code sessions only\. Resume this Codex session in a terminal/);
});
