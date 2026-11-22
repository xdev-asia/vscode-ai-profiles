const assert = require('node:assert/strict');
const Module = require('node:module');
const { test } = require('node:test');

test('a rejected Copilot tool registration leaves Squad commands available', async t => {
  const handlers = new Map();
  const attempted = [];
  const executed = [];
  const disposable = { dispose() {} };
  let provider;
  const api = {
    commands: {
      registerCommand(id, handler) {
        handlers.set(id, handler);
        return disposable;
      },
      async executeCommand(id) { executed.push(id); }
    },
    window: {
      registerWebviewViewProvider(_id, view) { provider = view; return disposable; },
      onDidChangeWindowState() { return disposable; }
    },
    workspace: {
      onDidChangeConfiguration() { return disposable; }
    },
    lm: {
      registerTool(name) {
        attempted.push(name);
        if (name === 'xdev_sdlc') throw new Error('Tool was rejected by this host');
        return disposable;
      }
    }
  };
  const originalLoad = Module._load;
  t.mock.method(Module, '_load', function (name, ...args) {
    return name === 'vscode' ? api : originalLoad.call(this, name, ...args);
  });
  const warn = t.mock.method(console, 'warn', () => {});
  const { registerSquad } = require('../dist/squad-view.js');
  registerSquad({
    subscriptions: [], workspaceState: { get() {} }, globalStorageUri: { fsPath: '/tmp/xdev-test' },
    secrets: { onDidChange() { return disposable; } }
  }, {}, {}, () => disposable);

  assert.ok(provider);
  assert.deepEqual(attempted, ['xdev_squad_ask', 'xdev_squad_plan', 'xdev_sdlc']);
  assert.match(warn.mock.calls[0].arguments[0], /xdev_sdlc/);
  await handlers.get('xdevAi.squad.workflow')();
  await handlers.get('xdevAi.squad.customizations')();
  assert.deepEqual(executed, ['xdevAi.squad.focus', 'xdevAi.squad.focus']);
});
