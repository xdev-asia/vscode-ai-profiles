const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { test } = require('node:test');
const { Accounts } = require('../dist/accounts.js');
const { chat, normalizeBaseUrl } = require('../dist/core.js');

const sample = [{ role: 'user', content: 'Xin chào' }];

test('each account uses its own model and credentials', async t => {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push({ url: request.url, authorization: request.headers.authorization, body });
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ choices: [{ message: { content: `Hello from ${body.model}` } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1/`;

  const storage = new Map();
  const accounts = new Accounts({
    get: async key => storage.get(key),
    store: async (key, value) => { storage.set(key, value); }
  });
  await Promise.all([
    accounts.add({ name: 'Cá nhân', provider: 'compatible', model: 'a', baseUrl, apiKey: 'key-a' }),
    accounts.add({ name: 'Công việc', provider: 'compatible', model: 'b', baseUrl, apiKey: 'key-b' })
  ]);
  const before = await accounts.read();
  assert.equal(before.accounts.length, 2);
  assert.equal(before.activeId, before.accounts[1].id);
  for (const account of before.accounts) {
    await accounts.select(account.id);
    const current = await accounts.read();
    const selected = current.accounts.find(entry => entry.id === current.activeId);
    assert.equal(await chat(selected, sample), `Hello from ${account.model}`);
  }
  await accounts.remove(before.accounts[1].id);
  assert.equal((await accounts.read()).activeId, before.accounts[0].id);
  assert.deepEqual(requests, [
    { url: '/v1/chat/completions', authorization: 'Bearer key-a', body: { model: 'a', messages: sample } },
    { url: '/v1/chat/completions', authorization: 'Bearer key-b', body: { model: 'b', messages: sample } }
  ]);
});

test('provider adapters use the documented routes and authentication', async t => {
  const mockedFetch = t.mock.method(global, 'fetch', async url =>
    Response.json(url.endsWith('/messages')
      ? { content: [{ type: 'text', text: 'Claude' }] }
      : { choices: [{ message: { content: 'OpenAI-compatible response' } }] }));

  for (const [provider, url] of [
    ['openai', 'https://api.openai.com/v1/chat/completions'],
    ['gemini', 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions']
  ]) {
    assert.equal(await chat({ provider, model: 'model', apiKey: 'key' }, sample), 'OpenAI-compatible response');
    const args = mockedFetch.mock.calls.at(-1).arguments;
    assert.equal(args[0], url);
    assert.equal(args[1].headers.Authorization, 'Bearer key');
    assert.equal(args[1].redirect, 'manual');
  }

  const system = { role: 'system', content: 'Trả lời ngắn gọn.' };
  assert.equal(await chat({ provider: 'anthropic', model: 'model', apiKey: 'claude-key' }, [system, ...sample]), 'Claude');
  const [url, options] = mockedFetch.mock.calls.at(-1).arguments;
  assert.equal(url, 'https://api.anthropic.com/v1/messages');
  assert.equal(options.headers['x-api-key'], 'claude-key');
  assert.equal(options.headers['anthropic-version'], '2023-06-01');
  assert.deepEqual(JSON.parse(options.body), { model: 'model', max_tokens: 4096, system: system.content, messages: sample });
});

test('invalid endpoints and provider errors keep credentials out of displayed errors', async t => {
  assert.throws(() => normalizeBaseUrl('http://example.com/v1'), /HTTPS/);
  assert.throws(() => normalizeBaseUrl('https://user:pass@example.com/v1'), /đường dẫn/);
  const mockedFetch = t.mock.method(global, 'fetch', async () =>
    Response.json({ message: 'Invalid key: private-key' }, { status: 401 }));

  const account = { provider: 'openai', model: 'test', apiKey: 'private-key' };
  await assert.rejects(chat(account, sample), { message: 'HTTP 401. Kiểm tra API key và quyền truy cập model.' });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(chat(account, sample, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(mockedFetch.mock.callCount(), 1);
});
