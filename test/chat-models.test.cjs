const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const { accountModels, chatModelVendor, estimateTokens, messageText, toChatMessages } = require('../dist/chat-models.js');

const accounts = [
  { id: 'id-1', revision: 'rev-1', name: 'Work', provider: 'openai', model: 'gpt-x', apiKey: 'sk-secret-openai' },
  {
    id: 'id-2', revision: 'rev-2', name: 'Local', provider: 'compatible', model: 'llama',
    baseUrl: 'http://127.0.0.1:11434/v1', apiKey: 'sk-secret-local'
  },
  { id: 'id-3', revision: 'rev-3', name: 'Work', provider: 'anthropic', model: 'claude-x', apiKey: 'sk-secret-anthropic' }
];

const User = 1;
const Assistant = 2;
const System = 3;
const text = value => ({ value });

test('each API profile becomes one chat model without its key or endpoint', () => {
  const models = accountModels(accounts, 32000);

  assert.deepEqual(models.map(model => model.id), ['id-1', 'id-2', 'id-3']);
  assert.deepEqual(models[0], {
    id: 'id-1',
    name: 'Work',
    family: 'gpt-x',
    version: 'rev-1',
    detail: 'OpenAI · gpt-x',
    tooltip: 'xDev AI API profile “Work” · OpenAI · gpt-x',
    maxInputTokens: 32000,
    maxOutputTokens: 4096,
    capabilities: { imageInput: false, toolCalling: false }
  });
  assert.equal(models[1].detail, 'OpenAI-compatible · llama');
  assert.equal(models[2].detail, 'Claude (Anthropic) · claude-x');
  assert.doesNotMatch(JSON.stringify(models), /sk-secret|127\.0\.0\.1|apiKey|baseUrl/);
  assert.deepEqual(accountModels([], 32000), []);
});

test('editor messages become chat messages with the text of each part', () => {
  const messages = toChatMessages([
    { role: System, content: [text('Be brief.')], name: undefined },
    { role: User, content: [text('Hello '), text('there')], name: undefined },
    { role: Assistant, content: [text('Hi.'), { callId: 'call-1', name: 'lookup', input: { q: 'x' } }], name: undefined },
    { role: User, content: [{ callId: 'call-1', content: [text('42'), { value: { node: 1 } }] }, text('Thanks')], name: undefined },
    { role: User, content: [{ mimeType: 'image/png', data: new Uint8Array(2) }], name: undefined },
    { role: Assistant, content: [text('   ')], name: undefined },
    { role: 99, content: [text('Unknown role')], name: undefined }
  ]);

  assert.deepEqual(messages, [
    { role: 'system', content: 'Be brief.' },
    { role: 'user', content: 'Hello there' },
    { role: 'assistant', content: 'Hi.' },
    { role: 'user', content: '42\nThanks' },
    { role: 'user', content: 'Unknown role' }
  ]);
});

test('token counts are estimated from text length', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('abcde'), 2);
  const message = { role: User, content: [text('abcd'), text('efgh')], name: undefined };
  assert.equal(messageText(message), 'abcdefgh');
  assert.equal(estimateTokens(messageText(message)), 2);
});

test('the manifest declares the provider that the extension registers', () => {
  const manifest = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
  const [provider, ...others] = manifest.contributes.languageModelChatProviders;

  assert.deepEqual(others, []);
  assert.equal(provider.vendor, chatModelVendor);
  assert.ok(provider.displayName);
  assert.ok(manifest.contributes.commands.some(command => command.command === provider.managementCommand));

  const [, major, minor] = /^\^(\d+)\.(\d+)\./.exec(manifest.engines.vscode).map(Number);
  assert.ok(major > 1 || minor >= 104, 'the provider API needs VS Code 1.104');
  assert.equal(manifest.devDependencies['@types/vscode'], `${major}.${minor}.0`);
  assert.equal(manifest.contributes.configuration.properties['xdevAi.chatModels.maxInputTokens'].default, 128000);
});
