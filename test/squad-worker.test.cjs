const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { test } = require('node:test');
const {
  describeTool, parsePlanOutput, parseWorkerOutput, runClaude, streamActivities, workerArguments, workerEnvironment, workerTools
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
  const args = workerArguments({ role: 'Implement', mode: 'work', prompt: 'Do it', system: 'You are Implement', settings: { ...settings, model: 'sonnet' } });
  const value = flag => args[args.indexOf(flag) + 1];
  assert.equal(value('-p'), 'Do it');
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

  const review = workerTools('Review', 'work', ['npm test']);
  assert.deepEqual(review.tools, ['Read', 'Glob', 'Grep', 'Bash']);
  assert.ok(!review.allowed.some(tool => tool === 'Edit' || tool.includes('npm test')));
  const plan = workerArguments({ role: 'Lead', mode: 'plan', prompt: 'Plan', system: 'Lead', settings });
  assert.equal(plan[plan.indexOf('--tools') + 1], '');
  assert.ok(!plan.includes('--allowedTools'));
  assert.ok(plan.includes('--no-session-persistence'));
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
    structured_output: { status: 'done', summary: ' Added the endpoint ', files_changed: ['src/a.ts', 3], tests: 'npm test passed', memory: ['Use zod for input', ''] }
  }));
  assert.deepEqual(parsed, {
    status: 'done', summary: 'Added the endpoint', filesChanged: ['src/a.ts'], tests: 'npm test passed', memory: ['Use zod for input'],
    sessionId: 'session-1', costUsd: 0.25, turns: 4, denied: ['Bash: curl https://example.com']
  });
  assert.throws(() => parseWorkerOutput(result({ subtype: 'error_max_budget_usd', is_error: true })), /budget limit/);
  assert.throws(() => parseWorkerOutput(result({ structured_output: { status: 'maybe', summary: 'x' } })), /structured report/);
  assert.throws(() => parseWorkerOutput('not json'), /JSON result/);
  assert.deepEqual(parsePlanOutput(result({ structured_output: { reply: 'Plan', tasks: [{ role: 'Implement', brief: 'Build' }] } })),
    { reply: 'Plan', tasks: [{ role: 'Implement', brief: 'Build' }], costUsd: 0.25 });
});

function fakeSpawn(behave) {
  const calls = [];
  const spawn = (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.killed = false;
    child.kill = signal => { child.killed = signal; setImmediate(() => child.emit('close', null)); return true; };
    calls.push({ command, args, options, child });
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
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending);
  assert.equal(hanging.calls[0].child.killed, 'SIGTERM');

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
