const assert = require('node:assert/strict');
const { setImmediate: tick } = require('node:timers/promises');
const { test } = require('node:test');
const { Accounts } = require('../dist/accounts.js');
const { SquadChat } = require('../dist/squad-chat.js');
const { SquadStore } = require('../dist/squad.js');

async function setup(t, answerTask) {
  const persisted = new Map();
  const storage = { get: key => persisted.get(key), update: async (key, value) => persisted.set(key, value) };
  const secrets = new Map();
  const accounts = new Accounts({ get: async key => secrets.get(key), store: async (key, value) => secrets.set(key, value) });
  const squad = new SquadStore(storage);
  for (const role of ['Lead', 'Implement', 'Review', 'Tests']) {
    await accounts.add({
      name: role + ' profile', provider: 'compatible', baseUrl: 'http://localhost:3000/v1',
      model: role.toLowerCase(), apiKey: role + '-key'
    });
  }

  const { accounts: profiles } = await accounts.read();
  for (const profile of profiles) {
    await squad.save(profile.name.split(' ')[0], { account: 'api:' + profile.id, brief: '', status: 'Ready', blocker: '' });
  }
  const requests = [];
  t.mock.method(global, 'fetch', async (_url, options) => {
    const { model, messages } = JSON.parse(options.body);
    const request = JSON.parse(messages.at(-1).content);
    requests.push({ model, auth: new Headers(options.headers).get('authorization'), request });
    const content = model === 'lead'
      ? JSON.stringify({
        reply: 'Proposed release validation',
        tasks: [{ role: 'Tests', brief: 'Draft smoke cases' }, { role: 'Review', brief: 'Review compatibility' },
          { role: 'Implement', brief: 'Propose a schema change' }]
      })
      : await (answerTask ? answerTask(model, options.signal) : model + ' result');
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  const openChat = () => new SquadChat(storage, accounts, squad, () => {});
  return { openChat, accounts, profiles, requests };
}

async function until(condition) {
  const end = Date.now() + 1_000;
  while (!condition()) {
    assert.ok(Date.now() < end, 'Chat did not reach expected state');
    await tick();
  }
}

test('a persisted plan only dispatches when approved and uses each assigned account', async t => {
  const { openChat, requests } = await setup(t);
  let chat = openChat();
  await chat.send('Plan a migration');
  await until(() => !chat.snapshot().busy);
  assert.deepEqual(requests.map(request => request.model), ['lead']);

  chat = openChat();
  const plan = chat.snapshot().plan;
  assert.deepEqual(plan.jobs, [
    { role: 'Implement', brief: 'Propose a schema change', profile: 'Implement profile' },
    { role: 'Review', brief: 'Review compatibility', profile: 'Review profile' },
    { role: 'Tests', brief: 'Draft smoke cases', profile: 'Tests profile' }
  ]);
  await assert.rejects(chat.approve('another-plan'), /no longer available/);
  assert.equal(requests.length, 1);
  const approved = await chat.approve(plan.id);
  assert.deepEqual((await approved.finished).map(entry => entry.author), ['Implement', 'Review', 'Tests', 'Squad']);
  assert.deepEqual(requests.slice(1), [
    { model: 'implement', auth: 'Bearer Implement-key',
      request: { request: 'Plan a migration', task: 'Propose a schema change' } },
    { model: 'review', auth: 'Bearer Review-key',
      request: { request: 'Plan a migration', task: 'Review compatibility', implementation: 'implement result' } },
    { model: 'tests', auth: 'Bearer Tests-key',
      request: { request: 'Plan a migration', task: 'Draft smoke cases', implementation: 'implement result' } }
  ]);
  chat = openChat();
  assert.deepEqual(chat.snapshot().entries.map(entry => entry.author), ['You', 'Lead', 'Squad', 'Implement', 'Review', 'Tests', 'Squad']);
  await chat.send('@review Summarize the risks');
  await until(() => !chat.snapshot().busy);
  assert.deepEqual(requests.at(-1).request, {
    history: [{ author: 'Review', text: 'review result' }],
    request: 'Summarize the risks'
  });
  assert.equal(requests.at(-1).model, 'review');
  assert.equal(chat.snapshot().plan, undefined);
});

test('changing an API key invalidates approval and discarding the plan makes no calls', async t => {
  const { openChat, accounts, profiles, requests } = await setup(t);
  const chat = openChat();
  await chat.send('Plan this');
  await until(() => !chat.snapshot().busy);
  const { id } = chat.snapshot().plan;
  const profile = profiles.find(profile => profile.model === 'review');
  await accounts.edit(profile.id, { name: profile.name, model: profile.model, apiKey: 'replaced-key' });
  await assert.rejects(chat.approve(id), /profile for Review changed/);
  await chat.discard(id);
  assert.equal(chat.snapshot().plan, undefined);
  assert.equal(requests.length, 1);
});

test('stopping an approved run skips the remaining roles', async t => {
  const { openChat, requests } = await setup(t, (_model, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  const chat = openChat();
  await chat.send('Plan this');
  await until(() => !chat.snapshot().busy);
  await chat.approve(chat.snapshot().plan.id);
  await until(() => requests.length === 2);
  chat.cancel();
  await until(() => !chat.snapshot().busy);
  assert.deepEqual(requests.map(request => request.model), ['lead', 'implement']);
  assert.equal(openChat().snapshot().entries.at(-1).text, 'Run stopped.');
});

test('cancelling a tool invocation stops its run without affecting the shared chat', async t => {
  const { openChat, requests } = await setup(t, (_model, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  const chat = openChat();
  await (await chat.send('Plan this')).finished;
  const controller = new AbortController();
  const running = await chat.approve(chat.snapshot().plan.id, controller.signal);
  await until(() => requests.length === 2);
  controller.abort();
  assert.deepEqual(await running.finished, [{ author: 'Squad', text: 'Run stopped.' }]);
  assert.equal(chat.snapshot().busy, false);
  assert.equal(requests.length, 2);
});
