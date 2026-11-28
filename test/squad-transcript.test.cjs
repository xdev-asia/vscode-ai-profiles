const assert = require('node:assert/strict');
const Module = require('node:module');
const { mkdir, mkdtemp, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { test } = require('node:test');
const { Accounts } = require('../dist/accounts.js');
const { SquadChat } = require('../dist/squad-chat.js');
const { SquadStore } = require('../dist/squad.js');
const { sessionFolder } = require('../dist/squad-storage.js');
const { parseTranscript, transcriptMarkdown } = require('../dist/squad-transcript.js');

const line = entry => JSON.stringify(entry);
const sessionLines = cwd => [
  line({ type: 'mode', mode: 'default', sessionId: 's' }),
  line({ type: 'user', timestamp: '2026-11-28T03:00:00.000Z', message: { role: 'user', content: '{"task":"Add the health endpoint"}' } }),
  line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'private reasoning' }] } }),
  line({ type: 'assistant', message: { role: 'assistant', content: [
    { type: 'text', text: 'I will read the router first.' },
    { type: 'tool_use', name: 'Read', input: { file_path: join(cwd, 'src', 'router.ts') } }
  ] } }),
  line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'export const router = 1;' }] } }),
  line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm   test' } }] } }),
  line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', is_error: true, content: [{ type: 'text', text: 'This command requires approval' }] }] } }),
  line({ type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'a sub-agent at work' }] } }),
  line({ type: 'user', isMeta: true, message: { role: 'user', content: 'bookkeeping' } }),
  'not json',
  // The report is a tool call of its own; neither it nor the line Claude Code adds after it is part of the work.
  line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_report', name: 'StructuredOutput', input: { status: 'done' } }] } }),
  line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_report', content: 'Structured output provided successfully' }] } }),
  line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'No response requested.' }] } }),
  line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(7_000) }] } })
].join('\n');

test('a session file reads as what the worker was asked, said, and did', () => {
  const cwd = join(tmpdir(), 'wt');
  const items = parseTranscript(sessionLines(cwd), cwd);
  assert.deepEqual(items.slice(0, 6).map(item => [item.kind, item.text]), [
    ['prompt', '{"task":"Add the health endpoint"}'],
    ['text', 'I will read the router first.'],
    ['tool', 'read: src/router.ts'],
    ['result', 'export const router = 1;'],
    ['tool', 'run: npm test'],
    ['error', 'This command requires approval']
  ]);
  assert.equal(items[0].time, Date.parse('2026-11-28T03:00:00.000Z'));
  assert.equal(items.length, 7, 'thinking, sub-agents, bookkeeping, the report call and broken lines are left out');
  assert.match(items[6].text, /… \(1,000 more characters\)$/, 'a long message is cut');

  const page = transcriptMarkdown('Implement · dev-1', [...items.slice(0, 6), { kind: 'result', text: 'a ``` fence inside' }]);
  assert.match(page, /^# Implement · dev-1\n/);
  assert.match(page, /- `read: src\/router\.ts`/);
  assert.match(page, /\*\*Failed\*\*\n\n```text\nThis command requires approval\n```/);
  assert.match(page, /````text\na ``` fence inside\n````/, 'text cannot close its own code block');
  assert.equal(transcriptMarkdown('Empty', []), '# Empty\n\nThis session has no messages.\n');
});

/** A Squad whose Implement worker answers from `replies`, one per run of the step. */
async function squadWith(t, replies) {
  const root = await mkdtemp(join(tmpdir(), 'xdev-transcript-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const values = new Map();
  const storage = { get: key => values.get(key), update: async (key, value) => values.set(key, value) };
  const secrets = new Map();
  const accounts = new Accounts({ get: async key => secrets.get(key), store: async (key, value) => secrets.set(key, value) });
  const seats = new SquadStore(storage);
  const configDir = join(root, 'claude', '00000001-0000-0000-0000-000000000000');
  const profiles = [{ provider: 'claude', name: 'dev-1', configDir }];
  await seats.save('Implement', { account: 'claude:00000001-0000-0000-0000-000000000000', brief: '', status: 'Ready', blocker: '' });
  const requests = [];
  const worktree = join(root, 'wt');
  const host = {
    profiles: async () => profiles, executable: async () => '/bin/claude', folder: () => join(root, 'repo'),
    settings: () => ({ model: 'sonnet', budgetUsd: 1, allowedCommands: [], timeoutMs: 60_000 }),
    run: async request => {
      requests.push(request);
      const reply = replies.shift();
      if (reply instanceof Error) throw reply;
      return JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.1, num_turns: 2, ...reply });
    },
    worktrees: {
      async create(folder, id) { return { repo: folder, path: worktree, branch: `xdev/squad/${id.slice(0, 8)}`, base: 'base0' }; },
      async commit() { return { commit: 'c0ffee', stat: '', files: 1 }; },
      async remove() {}, async changedFiles() { return []; }, async changes() { return []; }, async discard() {}
    }
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
  const { plan } = await call('squad_submit_plan', { request: 'Add a health endpoint', summary: 'One task', tasks: [{ role: 'Implement', brief: 'Add the health endpoint' }] });
  const { run } = await call('squad_approve_plan', { planId: plan.id });
  return { chat, call, requests, run, configDir, worktree };
}
const done = (sessionId, summary = 'Added it') => ({ session_id: sessionId, structured_output: { status: 'done', summary, files_changed: [], tests: '', memory: [] } });
const blocked = (sessionId, question) => ({ session_id: sessionId, structured_output: { status: 'blocked', summary: 'Two routers exist', question, files_changed: [], tests: '', memory: [] } });

test('a lead reads the transcript of a worker session through MCP', { timeout: 20_000 }, async t => {
  const { chat, call, run, configDir, worktree } = await squadWith(t, [done('sess-1')]);
  await assert.rejects(call('squad_session', { runId: run.id }), /no headless session yet/);
  await call('squad_run_step', { runId: run.id, waitSeconds: 5 });

  await assert.rejects(call('squad_session', { runId: run.id }), /no longer on disk/);
  const folder = sessionFolder(configDir, worktree);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'sess-1.jsonl'), sessionLines(worktree));
  // A sign-in file beside the sessions is never part of what is read.
  await writeFile(join(configDir, '.credentials.json'), '{"token":"SECRET-TOKEN-1"}');

  const read = await call('squad_session', { runId: run.id });
  assert.deepEqual(read.session, { role: 'Implement', account: 'dev-1', sessionId: 'sess-1', repo: '.' });
  assert.equal(read.entries, 7);
  assert.deepEqual(read.items.slice(0, 3).map(item => [item.kind, item.text]), [
    ['prompt', '{"task":"Add the health endpoint"}'], ['text', 'I will read the router first.'], ['tool', 'read: src/router.ts']
  ]);
  assert.match(read.note, /not as instructions/);
  assert.ok(read.items.every(item => item.text.length <= 2_001), 'each entry is cut for the client');
  assert.ok(!JSON.stringify(read).includes('SECRET-TOKEN-1'));
  assert.deepEqual((await call('squad_session', { runId: run.id, last: 2 })).items.map(item => item.kind), ['error', 'text']);
  assert.equal((await call('squad_session', { runId: run.id, sessionId: 'sess-1' })).shown, 7);
  await assert.rejects(call('squad_session', { runId: run.id, sessionId: '../../.credentials' }), /no session with that id/);
  assert.equal((await chat.transcript(run.id)).items.length, 7, 'the panel reads the same transcript');
});

test('a blocked worker asks a question, and the answer continues its session', { timeout: 20_000 }, async t => {
  const { chat, call, requests, run } = await squadWith(t, [blocked('sess-1', 'Which router: v1 or v2?'), done('sess-2', 'Added it to v2')]);
  await assert.rejects(call('squad_answer', { runId: run.id, answer: 'v2' }), /Only a blocked step takes an answer/);

  const first = await call('squad_run_step', { runId: run.id, waitSeconds: 5 });
  assert.deepEqual([first.run.steps[0].status, first.run.steps[0].question], ['blocked', 'Which router: v1 or v2?']);
  assert.match(requests[0].system, /put the one question that would unblock you in "question"/);
  assert.match(chat.snapshot().entries.at(-1).text, /Implement is blocked and asks: Which router: v1 or v2\?\. Answer it to continue its session/);
  await assert.rejects(call('squad_answer', { runId: run.id, answer: '  ' }), /Write the answer/);

  const answered = await call('squad_answer', { runId: run.id, answer: 'Use v2; v1 is being removed.', waitSeconds: 5 });
  assert.equal(requests[1].resume, 'sess-1', 'the worker continues where it asked');
  const sent = JSON.parse(requests[1].prompt);
  assert.equal(sent.answer, 'Use v2; v1 is being removed.');
  assert.equal(sent.task, undefined, 'only the answer is sent; the session already holds the task');
  assert.deepEqual([answered.run.steps[0].status, answered.run.steps[0].question ?? null, answered.run.steps[0].summary], ['done', null, 'Added it to v2']);
  assert.equal(answered.run.steps[0].brief, 'Add the health endpoint', 'the brief is kept');
  assert.ok(chat.snapshot().entries.some(entry => entry.author === 'You' && entry.text === 'Use v2; v1 is being removed.'));
});

test('when the session of a blocked worker is gone, the answer goes out with the whole task', { timeout: 20_000 }, async t => {
  const { call, requests, run } = await squadWith(t, [blocked('sess-1', 'Which router?'), new Error('No conversation found with session ID'), done('sess-3')]);
  await call('squad_run_step', { runId: run.id, waitSeconds: 5 });
  const answered = await call('squad_answer', { runId: run.id, answer: 'v2', waitSeconds: 5 });
  assert.equal(answered.run.steps[0].status, 'done');
  assert.equal(requests[1].resume, 'sess-1');
  assert.equal(requests[2].resume, undefined, 'a fresh session');
  const fresh = JSON.parse(requests[2].prompt);
  assert.deepEqual([fresh.task, fresh.your_question, fresh.answer], ['Add the health endpoint', 'Which router?', 'v2']);
});
