const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { after, test } = require('node:test');
const { JSDOM } = require('jsdom');
const { hasXdevServer, withXdevServer } = require('../dist/mcp-control.js');
const { squadPage } = require('../dist/squad-html.js');

test('setting up a folder adds the xDev AI server to .mcp.json without the token and keeps the rest', () => {
  const created = JSON.parse(withXdevServer(undefined, 7788));
  assert.deepEqual(created, {
    mcpServers: {
      xdev_ai: {
        type: 'http',
        url: '${XDEV_AI_MCP_URL:-http://127.0.0.1:7788/mcp}',
        headers: { Authorization: 'Bearer ${XDEV_AI_MCP_TOKEN:-open-a-terminal-from-xdev-ai}' }
      }
    }
  });

  const existing = JSON.stringify({
    $schema: 'x', mcpServers: { docs: { type: 'http', url: 'https://mcp.example.com/mcp' }, xdev_ai: { type: 'http', url: 'http://127.0.0.1:1/mcp' } }
  });
  const merged = JSON.parse(withXdevServer(existing, 7789));
  assert.equal(merged.$schema, 'x');
  assert.deepEqual(merged.mcpServers.docs, { type: 'http', url: 'https://mcp.example.com/mcp' });
  assert.match(merged.mcpServers.xdev_ai.url, /7789/);
  assert.equal(withXdevServer('  \n', 7788), withXdevServer(undefined, 7788));

  // A file xDev AI cannot read safely is left alone.
  assert.throws(() => withXdevServer('{ not json', 7788), /not valid JSON/);
  assert.throws(() => withXdevServer('[]', 7788), /JSON object/);
  assert.throws(() => withXdevServer('{"mcpServers": []}', 7788), /must be an object/);

  assert.equal(hasXdevServer(withXdevServer(existing, 7788)), true);
  assert.equal(hasXdevServer('{"mcpServers":{"docs":{}}}'), false);
  assert.equal(hasXdevServer(undefined), false);
  assert.equal(hasXdevServer('{ not json'), false);
});

const media = join(__dirname, '..', 'media');
const windows = [];
after(() => { for (const window of windows) window.close(); });

function mount() {
  const html = squadPage({ cspSource: 'test:', nonce: 'n', script: 'squad.js', chatScript: 'squad-chat.js', workspaceScript: 'squad-workspace.js', style: 'squad.css' })
    .replace(/<script[^>]*><\/script>/g, '').replace(/<link[^>]*>/g, '');
  const { window } = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  windows.push(window);
  const sent = [];
  let saved;
  window.acquireVsCodeApi = () => ({ postMessage: message => sent.push(JSON.parse(JSON.stringify(message))), getState: () => saved, setState: value => { saved = value; } });
  for (const file of ['squad-chat.js', 'squad-workspace.js', 'squad.js']) window.eval(readFileSync(join(media, file), 'utf8'));
  const $ = selector => window.document.querySelector(selector);
  return {
    window, sent, $,
    post: data => window.dispatchEvent(new window.MessageEvent('message', { data })),
    click: node => node.dispatchEvent(new window.MouseEvent('click', { bubbles: true })),
    settle: () => window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'workspaceSettled' } }))
  };
}

const seats = Object.fromEntries(['Lead', 'Implement', 'Review', 'Tests'].map(role => [role, { account: '', brief: '', status: 'Ready', blocker: '' }]));
function state(mcp) {
  return {
    type: 'state', seats, activity: [], accounts: [], running: [], errors: {}, nativeChatTools: [],
    customizations: { skills: [], disabledTools: [] }, memory: [],
    sync: { folder: '', profiles: true, approver: 'human', workers: { budgetUsd: 1, allowedCommands: [], models: {}, repositoryCommands: {} } },
    teamChat: { entries: [], runs: [], workers: true, busy: false, status: '' },
    ...(mcp ? { mcp } : {})
  };
}

test('the MCP tab shows the server, sets what clients may do, and sets up the folder', () => {
  const ui = mount();
  const stopped = {
    ready: true, running: false, port: 0, autoStart: false, accountControl: 'read', squadControl: 'off', confirmIn: 'vscode',
    folder: 'shop', folderSetUp: false, tools: [{ name: 'xdev_accounts_list', summary: 'List accounts.', kind: 'read' }]
  };
  ui.post(state(stopped));
  ui.click(ui.$('#show-mcp'));
  assert.equal(ui.$('#mcp-panel').hidden, false);
  assert.equal(ui.$('#mcp-status').textContent, 'Stopped');
  assert.match(ui.$('#mcp-summary').textContent, /cannot reach xDev AI/);
  assert.match(ui.$('#mcp-folder').textContent, /Not set up for shop yet/);
  assert.equal(ui.$('#mcp-setup').textContent, 'Set up for this folder');
  assert.equal(ui.$('#mcp-toggle').textContent, 'Start');
  assert.equal(ui.$('#mcp-copy').disabled, true, 'nothing to copy while stopped');
  assert.equal(ui.$('#mcp-squadControl').value, 'off');
  assert.match(ui.$('#mcp-squadControl-hint').textContent, /no Squad tools/);
  assert.match(ui.$('#mcp-port').textContent, /free one on every start/);
  assert.equal(ui.$('#mcp-tools-title').textContent, 'Tools (1)');

  ui.click(ui.$('#mcp-setup'));
  assert.deepEqual(ui.sent.at(-1), { type: 'mcp', action: 'setup' });
  assert.equal(ui.$('#mcp-toggle').disabled, true, 'one action at a time');
  ui.settle();

  const running = {
    ...stopped, running: true, url: 'http://127.0.0.1:7788/mcp', port: 7788, autoStart: true, accountControl: 'manage', squadControl: 'run',
    confirmIn: 'client', folderSetUp: true, tools: [
      { name: 'xdev_accounts_list', summary: 'List accounts.', kind: 'read' },
      { name: 'xdev_squad_submit_plan', summary: 'Hand out work as the lead.', kind: 'change' }
    ]
  };
  ui.post(state(running));
  assert.equal(ui.$('#mcp-status').textContent, 'Running');
  assert.match(ui.$('#mcp-summary').textContent, /Running at http:\/\/127\.0\.0\.1:7788\/mcp\. 2 tools/);
  assert.match(ui.$('#mcp-folder').textContent, /holds no token/);
  assert.equal(ui.$('#mcp-setup').textContent, 'Set up again');
  assert.equal(ui.$('#mcp-toggle').textContent, 'Stop');
  assert.equal(ui.$('#mcp-copy').disabled, false);
  assert.equal(ui.$('#mcp-squadControl').value, 'run');
  assert.match(ui.$('#mcp-squadControl-hint').textContent, /act as the lead/);
  assert.match(ui.$('#mcp-confirmIn-hint').textContent, /Keep permission prompts on/);
  assert.equal(ui.$('#mcp-autoStart').checked, true);
  assert.deepEqual([...ui.$('#mcp-tools').querySelectorAll('small')].map(node => node.textContent), ['read', 'change']);

  assert.match(ui.$('#mcp-port').textContent, /^Port 7788, kept across restarts/);

  // A second window cannot have the fixed port; it says which port it uses instead.
  ui.post(state({ ...running, url: 'http://127.0.0.1:51234/mcp', portBusy: true }));
  assert.match(ui.$('#mcp-port').textContent, /Port 7788 is used by another window, so this window uses 51234/);
  assert.match(ui.$('#mcp-summary').textContent, /Running at http:\/\/127\.0\.0\.1:51234\/mcp/);
  ui.post(state(running));

  ui.$('#mcp-squadControl').value = 'read';
  ui.$('#mcp-squadControl').dispatchEvent(new ui.window.Event('change'));
  assert.deepEqual(ui.sent.at(-1), { type: 'mcp', action: 'set', key: 'squadControl', value: 'read' });
  ui.settle();
  ui.click(ui.$('#mcp-toggle'));
  assert.deepEqual(ui.sent.at(-1), { type: 'mcp', action: 'stop' });
  ui.settle();
  ui.click(ui.$('#mcp-copy'));
  assert.deepEqual(ui.sent.at(-1), { type: 'mcp', action: 'copy' });
  ui.settle();
  assert.equal(ui.$('#mcp-notice').textContent, '', 'copying the configuration is not the workflow brief');

  // The button on Skills & Tools leads here.
  ui.click(ui.$('#show-customizations'));
  ui.click(ui.$('#manage-mcp'));
  assert.equal(ui.$('#mcp-panel').hidden, false);
});

test('the MCP tab explains itself when the window has no MCP or no trusted folder', () => {
  const ui = mount();
  ui.post(state());
  assert.match(ui.$('#mcp-summary').textContent, /not available in this window/);
  assert.equal(ui.$('#mcp-setup').disabled, true);
  ui.post(state({ ready: false, running: false, port: 0, autoStart: false, accountControl: 'read', squadControl: 'off', confirmIn: 'vscode', folderSetUp: false, tools: [] }));
  assert.match(ui.$('#mcp-summary').textContent, /trusted workspace folder/);
  assert.equal(ui.$('#mcp-setup').disabled, true);
  assert.equal(ui.$('#mcp-accountControl').disabled, false, 'levels are user settings and can be set before a folder opens');
});
