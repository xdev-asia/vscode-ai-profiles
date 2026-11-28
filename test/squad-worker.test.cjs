const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { existsSync, readFileSync } = require('node:fs');
const { PassThrough } = require('node:stream');
const { test } = require('node:test');
const {
  describeTool, launch, parsePlanOutput, parseWorkerOutput, runClaude, streamActivities, terminalArguments, workerArguments, workerEnvironment,
  workerSummary, workerTools
} = require('../dist/squad-worker.js');

const settings = { budgetUsd: 1, allowedCommands: ['npm test', 'rm -rf /; echo', 'dotnet test'], timeoutMs: 60_000 };
const profile = { provider: 'claude', name: 'Work', configDir: '/profiles/claude/11111111-1111-1111-1111-111111111111' };

function result(extra) {
  return JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, session_id: 'session-1', total_cost_usd: 0.25, num_turns: 4,
    permission_denials: [{ tool_name: 'Bash', tool_input: { command: 'curl https://example.com' } }],
    ...extra
  });
}

test('worker arguments restrict tools by role and cap spending', () => {
  const args = workerArguments({ role: 'Implement', mode: 'work', prompt: 'Do it', system: 'You are Implement', settings: { ...settings, model: 'sonnet' } }, { system: '/tmp/x/system.md' });
  const value = flag => args[args.indexOf(flag) + 1];
  assert.ok(args.includes('-p'));
  assert.ok(!args.includes('Do it'), 'the prompt goes to stdin, not the command line');
  assert.ok(!args.includes('You are Implement') && !args.includes('--append-system-prompt'), 'the system text goes in a file');
  assert.equal(value('--append-system-prompt-file'), '/tmp/x/system.md');
  assert.equal(value('--output-format'), 'stream-json');
  assert.ok(args.includes('--verbose'), 'print mode needs --verbose for stream-json');
  assert.doesNotMatch(value('--allowedTools'), /codegraph/, 'CodeGraph stays off unless enabled');
  const graph = workerTools('Implement', 'work', [], true);
  assert.ok(graph.allowed.includes('Bash(codegraph explore:*)'));
  assert.ok(workerTools('Review', 'gate', [], true).allowed.includes('Bash(codegraph node:*)'));
  assert.equal(value('--tools'), 'Read,Glob,Grep,Edit,Write,Bash');
  assert.match(value('--allowedTools'), /Bash\(npm test:\*\)/);
  assert.match(value('--allowedTools'), /Bash\(dotnet test:\*\)/);
  assert.doesNotMatch(value('--allowedTools'), /rm -rf/, 'unsafe command strings are dropped');
  assert.equal(value('--max-budget-usd'), '1');
  assert.equal(value('--model'), 'sonnet');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.ok(!args.includes('--bare'), 'bare mode would skip OAuth sign-in');
  assert.ok(!args.includes('--dangerously-skip-permissions'));
  assert.ok(!args.includes('--no-session-persistence'), 'work sessions stay resumable');
  assert.equal(JSON.parse(value('--json-schema')).required.includes('memory'), true);

  const any = workerTools('Implement', 'work', ['*']);
  assert.ok(any.allowed.includes('Bash'), '"*" allows every shell command');
  assert.ok(!workerTools('Review', 'work', ['*']).allowed.includes('Bash'), 'Review stays read-only');

  const review = workerTools('Review', 'work', ['npm test']);
  assert.deepEqual(review.tools, ['Read', 'Glob', 'Grep', 'Bash']);
  assert.ok(!review.allowed.some(tool => tool === 'Edit' || tool.includes('npm test')));
  const plan = workerArguments({ role: 'Lead', mode: 'plan', prompt: 'Plan', system: 'Lead', settings }, { system: '/tmp/x/system.md' });
  assert.equal(plan[plan.indexOf('--tools') + 1], 'Read,Glob,Grep,Bash', 'Lead reads the repository to plan or answer');
  assert.doesNotMatch(plan[plan.indexOf('--allowedTools') + 1], /Edit|Write|npm/);
  assert.ok(plan.includes('--no-session-persistence'));
});

test('the worker settings shown in the Squad view carry no MCP server, environment, or .env path', () => {
  const shown = workerSummary({
    model: 'sonnet', budgetUsd: 2, allowedCommands: ['npm test'], timeoutMs: 60_000, codegraph: true,
    mcp: {
      servers: {
        db: { type: 'stdio', command: 'pg-mcp', env: { PGPASSWORD: 'mcp-env-secret' } },
        docs: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer mcp-header-secret' } }
      },
      allowed: ['mcp__db__query']
    },
    env: { API_TOKEN: 'dotenv-secret' },
    denyRead: ['/repo/private/.env']
  });
  assert.deepEqual(shown, { budgetUsd: 2, allowedCommands: ['npm test'] });
  assert.doesNotMatch(JSON.stringify(shown), /secret|pg-mcp|mcp\.example\.com|\.env/);
});

test('worker environment points at the profile and drops other credentials', () => {
  const env = workerEnvironment(profile, { PATH: '/bin', ANTHROPIC_API_KEY: 'secret', CLAUDECODE: '1', CLAUDE_CONFIG_DIR: '/other' });
  assert.equal(env.CLAUDE_CONFIG_DIR, profile.configDir);
  assert.equal(env.PATH, '/bin');
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.CLAUDECODE, undefined);
});

test('worker output is parsed from the structured result', () => {
  const parsed = parseWorkerOutput(result({
    structured_output: {
      status: 'done', summary: ' Added the endpoint ', files_changed: ['src/a.ts', 3], tests: 'npm test passed', memory: ['Use zod for input', ''],
      artifacts: [{ name: 'API design', content: '# Design' }, 'not an object', null]
    }
  }));
  assert.deepEqual(parsed, {
    status: 'done', summary: 'Added the endpoint', filesChanged: ['src/a.ts'], tests: 'npm test passed', memory: ['Use zod for input'],
    artifacts: [{ name: 'API design', content: '# Design' }],
    sessionId: 'session-1', costUsd: 0.25, turns: 4, denied: ['Bash: curl https://example.com']
  });
  assert.throws(() => parseWorkerOutput(result({ subtype: 'error_max_budget_usd', is_error: true })), /budget limit/);
  assert.throws(() => parseWorkerOutput(result({ structured_output: { status: 'maybe', summary: 'x' } })), /structured report/);
  assert.throws(() => parseWorkerOutput('not json'), /JSON result/);
  assert.deepEqual(parsePlanOutput(result({ structured_output: { reply: 'Plan', tasks: [{ role: 'Implement', brief: 'Build' }] } })),
    { reply: 'Plan', tasks: [{ role: 'Implement', brief: 'Build' }], costUsd: 0.25, sessionId: 'session-1' });
});

function fakeSpawn(behave) {
  const calls = [];
  const spawn = (command, args, options) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.killed = false;
    child.kill = signal => { child.killed = signal; setImmediate(() => child.emit('close', null)); return true; };
    const at = args.indexOf('--append-system-prompt-file');
    const call = { command, args, options, child, input: '', systemFile: at >= 0 ? args[at + 1] : undefined };
    call.system = call.systemFile && readFileSync(call.systemFile, 'utf8');
    child.stdin.setEncoding('utf8').on('data', chunk => { call.input += chunk; });
    calls.push(call);
    setImmediate(() => behave(child));
    return child;
  };
  return { spawn, calls };
}

test('runClaude spawns the CLI in the worktree and can be stopped', async () => {
  const done = fakeSpawn(child => {
    child.stdout.end(result({ structured_output: { status: 'done', summary: 'ok', files_changed: [], tests: '', memory: [] } }));
    child.emit('close', 0);
  });
  const request = { executable: '/bin/claude', profile, cwd: '/repo/wt', role: 'Tests', mode: 'work', prompt: 'p', system: 's', settings };
  const stdout = await runClaude(request, done.spawn);
  assert.equal(parseWorkerOutput(stdout).summary, 'ok');
  assert.equal(done.calls[0].command, '/bin/claude');
  assert.equal(done.calls[0].options.cwd, '/repo/wt');
  assert.equal(done.calls[0].options.env.CLAUDE_CONFIG_DIR, profile.configDir);

  const hanging = fakeSpawn(() => {});
  const controller = new AbortController();
  const pending = runClaude({ ...request, signal: controller.signal }, hanging.spawn);
  await new Promise(resolve => setTimeout(resolve, 10));
  controller.abort();
  await assert.rejects(pending);
  assert.equal(hanging.calls[0].child.killed, 'SIGTERM');

  // The stop is reported once the CLI has ended, so nothing still writes to the worktree when the caller goes on.
  const slow = fakeSpawn(child => { child.kill = signal => { child.killed = signal; return true; }; });
  const stopper = new AbortController();
  let settled = false;
  const stopping = runClaude({ ...request, signal: stopper.signal }, slow.spawn).catch(error => { settled = true; return error; });
  await new Promise(resolve => setTimeout(resolve, 10));
  stopper.abort();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(slow.calls[0].child.killed, 'SIGTERM');
  assert.equal(settled, false, 'still waiting for the CLI to end');
  slow.calls[0].child.emit('close', null);
  assert.match((await stopping).message, /stopped|aborted/i);

  const failed = fakeSpawn(child => {
    child.stderr.end('Invalid API key · Please run /login\n');
    child.emit('close', 1);
  });
  await assert.rejects(runClaude(request, failed.spawn), /code 1: Invalid API key.*Sign in/);
  await assert.rejects(runClaude({ ...request, profile: { ...profile, provider: 'codex' } }, done.spawn), /Claude Code terminal account/);
});

test('stream events become activity, and the result line is returned', async () => {
  assert.deepEqual(describeTool('Read', { file_path: '/repo/wt/src/a.ts' }, '/repo/wt'), { kind: 'read', text: 'src/a.ts' });
  assert.deepEqual(describeTool('Edit', { file_path: '/elsewhere/b.ts' }, '/repo/wt'), { kind: 'edit', text: '/elsewhere/b.ts' });
  assert.deepEqual(describeTool('Bash', { command: 'npm   test\n -- a' }, '/repo/wt'), { kind: 'run', text: 'npm test -- a' });
  assert.deepEqual(describeTool('Grep', { pattern: 'buildNoiDung', path: '/repo/wt/src' }, '/repo/wt'), { kind: 'search', text: 'buildNoiDung in src' });
  assert.equal(describeTool('StructuredOutput', {}, '/repo/wt'), undefined);
  assert.deepEqual(streamActivities({ type: 'user', message: { content: [] } }, '/'), []);
  const calls = new Map();
  streamActivities({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'curl x' } }, { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm test' } }] } }, '/', calls);
  assert.deepEqual(streamActivities({ type: 'user', message: { content: [
    { type: 'tool_result', tool_use_id: 't1', is_error: true, content: "Claude requested permissions to use Bash, but you haven't granted it yet." },
    { type: 'tool_result', tool_use_id: 't2', is_error: true, content: 'Exit code 1' },
    { type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'This Bash command contains multiple operations. The following part requires approval: ls -la /tmp' },
    { type: 'tool_result', tool_use_id: 't3', is_error: true, content: 'unknown call' }
  ] } }, '/', calls), [{ kind: 'denied', text: 'curl x' }, { kind: 'failed', text: 'npm test' }, { kind: 'denied', text: 'curl x' }]);

  const events = [
    { type: 'system', subtype: 'init' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Looking' }, { type: 'tool_use', name: 'Read', input: { file_path: '/repo/wt/a.js' } }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'StructuredOutput', input: {} }] } }
  ];
  const streamed = fakeSpawn(child => {
    // Split a line across chunks to exercise buffering.
    const text = events.map(event => JSON.stringify(event)).join('\n') + '\n' + result({ structured_output: { status: 'done', summary: 'ok', files_changed: [], tests: '', memory: [] } });
    child.stdout.write(text.slice(0, 50));
    child.stdout.end(text.slice(50));
    setImmediate(() => child.emit('close', 0));
  });
  const seen = [];
  const request = { executable: '/bin/claude', profile, cwd: '/repo/wt', role: 'Implement', mode: 'work', prompt: 'p', system: 's', settings, onActivity: item => seen.push(item) };
  const stdout = await runClaude(request, streamed.spawn);
  assert.deepEqual(seen, [{ kind: 'read', text: 'a.js' }]);
  assert.equal(parseWorkerOutput(stdout).summary, 'ok');

  const empty = fakeSpawn(child => { child.stdout.end(JSON.stringify(events[0]) + '\n'); setImmediate(() => child.emit('close', 0)); });
  await assert.rejects(runClaude(request, empty.spawn).then(parseWorkerOutput), /JSON result/);
});

test('the prompt and the system text reach Claude Code through stdin and a private file, never the command line', async () => {
  const done = fakeSpawn(child => {
    child.stdout.end(result({ structured_output: { status: 'done', summary: 'ok', files_changed: [], tests: '', memory: [] } }));
    child.emit('close', 0);
  });
  const prompt = 'Fix "it" & echo PWNED %PATH%\nsecond line';
  const system = 'You are Tests\n"quoted" & calc';
  await runClaude({ executable: '/bin/claude', profile, cwd: '/repo/wt', role: 'Tests', mode: 'work', prompt, system, settings }, done.spawn);
  await new Promise(resolve => setTimeout(resolve, 10));
  const [call] = done.calls;
  assert.ok(!call.args.some(arg => /PWNED|calc|second line|You are Tests/.test(arg)), 'no prompt or system text on the command line');
  assert.equal(call.options.stdio[0], 'pipe');
  assert.equal(call.input, prompt, 'the whole prompt arrives on stdin, newlines and quotes included');
  assert.equal(call.system, system, 'the system text is in the file when the CLI starts');
  assert.equal(existsSync(call.systemFile), false, 'the file is deleted after the run');
});

test('a .cmd install starts through cmd.exe only with arguments cmd.exe cannot reinterpret', () => {
  assert.deepEqual(launch('/bin/claude', ['-p', 'a & b'], 'linux'), { command: '/bin/claude', args: ['-p', 'a & b'] });
  assert.deepEqual(launch('C:/bin/claude.exe', ['-p', 'a & b'], 'win32', 'cmd.exe'), { command: 'C:/bin/claude.exe', args: ['-p', 'a & b'] });
  const script = 'C:/npm/claude.cmd';
  assert.deepEqual(launch(script, ['-p', '--model', 'sonnet'], 'win32', 'C:/Windows/cmd.exe'),
    { command: 'C:/Windows/cmd.exe', args: ['/d', '/s', '/c', script, '-p', '--model', 'sonnet'] });
  for (const bad of ['a & calc', '%PATH%', 'x | y', 'a > b', 'a < b', 'a ^ b', 'one\ntwo', 'one\rtwo']) {
    assert.throws(() => launch(script, ['--model', bad], 'win32', 'cmd.exe'), /\.cmd script.*claudeExecutable/s, bad);
  }
  assert.throws(() => launch('C:/R&D/claude.cmd', ['-p'], 'win32', 'cmd.exe'), /\.cmd script/);
  const mcp = { servers: { db: { type: 'stdio', command: 'pg-mcp' } }, allowed: ['mcp__db__query'] };
  for (const mode of ['work', 'plan', 'gate']) {
    const args = workerArguments(
      { role: 'Implement', mode, prompt: 'p & q', system: 's | t', settings: { ...settings, model: 'sonnet', mcp, denyRead: ['C:/repo/.env'] }, resume: 'session-1' },
      { system: 'C:/Temp/xdev-squad-1/system.md', mcp: 'C:/Temp/xdev-squad-1/mcp.json' });
    assert.doesNotThrow(() => launch(script, args, 'win32', 'cmd.exe'), `the extension's own ${mode} arguments are safe`);
  }
});

test('a terminal step keeps its task off a cmd.exe command line', () => {
  const step = { system: 'You are Tests', prompt: 'Task for Tests: add "x"\n& echo PWNED %PATH%' };
  assert.deepEqual(terminalArguments(step, '/tmp/x/system.md', false),
    { args: ['--append-system-prompt-file', '/tmp/x/system.md', step.prompt], system: step.system });
  const script = terminalArguments(step, 'C:/Temp/x/system.md', true);
  assert.deepEqual(script.args.slice(0, 2), ['--append-system-prompt-file', 'C:/Temp/x/system.md']);
  assert.equal(script.args.length, 3);
  assert.ok(!script.args[2].includes('PWNED'), 'the task is not an argument');
  assert.ok(script.system.startsWith(step.system) && script.system.includes(step.prompt), 'the task travels in the file');
  assert.doesNotThrow(() => launch('C:/npm/claude.cmd', script.args, 'win32', 'cmd.exe'));
});
