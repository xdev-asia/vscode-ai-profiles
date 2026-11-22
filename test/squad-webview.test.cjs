// Renders the real Squad webview page and scripts in jsdom, feeds it state, and checks what the user sees and sends.
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { after, test } = require('node:test');
const { JSDOM } = require('jsdom');
const { squadPage } = require('../dist/squad-html.js');

const media = join(__dirname, '..', 'media');
const windows = [];
after(() => { for (const window of windows) window.close(); });

function mount() {
  const html = squadPage({ cspSource: 'test:', nonce: 'n', script: 'squad.js', chatScript: 'squad-chat.js', workspaceScript: 'squad-workspace.js', style: 'squad.css' })
    .replace(/<script[^>]*><\/script>/g, '').replace(/<link[^>]*>/g, '');
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  windows.push(window);
  const sent = [];
  let saved;
  window.acquireVsCodeApi = () => ({ postMessage: message => sent.push(JSON.parse(JSON.stringify(message))), getState: () => saved, setState: value => { saved = value; } });
  for (const file of ['squad-chat.js', 'squad-workspace.js', 'squad.js']) window.eval(readFileSync(join(media, file), 'utf8'));
  const post = data => window.dispatchEvent(new window.MessageEvent('message', { data }));
  const $ = selector => window.document.querySelector(selector);
  const $$ = selector => [...window.document.querySelectorAll(selector)];
  const click = node => node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const last = action => sent.filter(message => message.action === action || message.type === action).at(-1);
  return { window, sent, post, $, $$, click, last };
}

const accounts = [
  { id: 'claude:1', kind: 'terminal', name: 'alex', detail: 'Claude Code' },
  { id: 'api:2', kind: 'api', name: 'router', detail: 'OpenAI compatible' }
];
const assigned = Object.fromEntries(['Lead', 'Implement', 'Review', 'Tests'].map(role => [role, { account: 'claude:1', brief: '', status: 'Ready', blocker: '' }]));

function state(teamChat, extra = {}) {
  return {
    type: 'state', seats: assigned, activity: [], accounts, running: [], errors: {}, nativeChatTools: [],
    customizations: { skills: [], disabledTools: [] }, memory: [],
    sync: { folder: '', profiles: true, approver: 'human', workers: { budgetUsd: 1, allowedCommands: ['npm test'], models: {}, repositoryCommands: {} } },
    teamChat: { entries: [], runs: [], workers: true, busy: false, status: '', ...teamChat },
    ...extra
  };
}

const job = (role, repo, brief = `${role} task`) => ({ role, brief, profile: 'alex', kind: 'claude', ...(repo ? { repo } : {}) });

test('each Claude Code task gets a repository picker, and Approve waits until every task has one', () => {
  const ui = mount();
  ui.post(state({ plan: { id: 'p1', repos: ['api', 'web'], jobs: [job('Implement', 'api'), job('Implement', 'web'), job('Review')] } }));
  const pickers = ui.$$('#chat-jobs select');
  assert.equal(pickers.length, 3);
  assert.deepEqual(pickers.map(select => select.value), ['api', 'web', '']);
  assert.equal(ui.$$('#chat-jobs .job-repo small')[0].textContent, 'suggested');
  assert.equal(ui.$('#approve-plan').disabled, true, 'Review has no repository yet');
  pickers[2].value = 'web';
  pickers[2].dispatchEvent(new ui.window.Event('change'));
  assert.equal(ui.$('#approve-plan').disabled, false);
  ui.click(ui.$('#approve-plan'));
  assert.deepEqual(ui.last('approve').repos, ['api', 'web', 'web']);
});

test('a run across repositories shows each repository, push state, and grouped changes with review feedback', () => {
  const ui = mount();
  const tree = (target, extra) => ({ target, repo: `/w/${target}`, path: `/t/${target}`, branch: 'xdev/squad/abcd1234', base: 'b', commit: 'c', files: 2, stat: `${target} | 2 +-`, ...extra });
  const run = {
    id: 'r1', prompt: 'Bills end to end', request: 'Bills end to end', time: 0, finished: 7 * 60_000, status: 'done', approver: 'human', costUsd: 0.42, sessions: [],
    steps: [
      { ...job('Implement', 'api'), status: 'done', ms: 120_000, attempts: 1, costUsd: 0.2 },
      { ...job('Implement', 'web'), status: 'done', ms: 200_000, attempts: 2, costUsd: 0.22 }
    ],
    trees: [tree('api'), tree('web', { pushed: { remote: 'origin', target: 'dev', mergeRequest: true, url: 'https://gitlab.example/w/-/merge_requests/9', time: 1 } })]
  };
  const metrics = { runs: 3, medianMs: 9 * 60_000, costUsd: 1.5, firstPass: 0.75, files: 12 };
  ui.post(state({ runs: [run], metrics }));
  const card = ui.$('#run-list li.run');
  assert.match(card.querySelector('small').textContent, /^api \+ web · xdev\/squad\/abcd1234 · done · you approve · 4 files · 7m · \$0\.42$/);
  assert.match(card.querySelectorAll('.step')[1].textContent, /Implement · web · alex · done · 3m · 2 tries · \$0\.22/);
  assert.match(card.querySelector('.pushed').textContent, /web: pushed to origin · MR into dev/);
  assert.equal(card.querySelector('.pushed button').textContent, 'Open MR');
  const buttons = Object.fromEntries([...card.querySelectorAll(':scope > .actions button')].map(button => [button.textContent, button]));
  assert.ok(buttons['Push again'] && !buttons['Push again'].disabled);
  assert.equal(buttons.Merge.disabled, false);
  assert.equal(ui.$('#runs-metrics').textContent, 'Last 30 days: 3 runs · median 9m to commit · 75% of steps passed first time · 12 files · $1.50');

  ui.click(card.querySelector('.pushed button'));
  assert.deepEqual(ui.last('runLink'), { type: 'squadChat', action: 'runLink', id: 'r1', repo: 'web' });
  ui.click(buttons.Changes);
  ui.post({
    type: 'chatSettled', action: 'runChanges', data: {
      id: 'r1', files: [
        { repo: 'api', path: 'src/bills.ts', status: 'added', added: 10, removed: 0, binary: false, patch: '@@ -0,0 +1 @@\n+x' },
        { repo: 'web', path: 'src/Bills.tsx', status: 'modified', added: 3, removed: 1, binary: false, patch: '@@ -1 +1 @@\n-a\n+b' }
      ]
    }
  });
  assert.deepEqual(ui.$$('.changes .repo-head').map(node => node.textContent), ['api', 'web']);
  const files = ui.$$('.changes details.file');
  const comment = [...files[1].querySelectorAll('button')].find(button => button.textContent === 'Comment');
  ui.click(comment);
  const box = ui.$('.feedback textarea');
  assert.equal(box.value, 'src/Bills.tsx: ');
  assert.equal(ui.$('.feedback select').value, 'web');
  box.value += 'sort by date';
  box.dispatchEvent(new ui.window.Event('input'));
  const submit = [...ui.$$('.feedback button')].find(button => button.textContent === 'Request changes');
  assert.equal(submit.disabled, false);
  ui.click(submit);
  assert.deepEqual(ui.last('runRequestChanges'), { type: 'squadChat', action: 'runRequestChanges', id: 'r1', text: 'src/Bills.tsx: sort by date', repo: 'web' });
  ui.click([...files[0].querySelectorAll('button')].find(button => button.textContent === 'Discard'));
  assert.equal(ui.last('runDiscard'), undefined, 'one action at a time');
});

test('a first run offers one account for every role, and another window\'s run hides Stop', () => {
  const ui = mount();
  ui.post(state({}, { seats: {} }));
  const button = ui.$('#chat-assign-all');
  assert.equal(button.hidden, false);
  assert.equal(button.textContent, 'Use alex for all roles');
  ui.click(button);
  assert.deepEqual(ui.last('assignAll'), { type: 'squadChat', action: 'assignAll', account: 'claude:1' });

  const other = mount();
  other.post(state({ busy: true, remote: true, status: 'Another window is running: Implement is working…' }));
  assert.equal(other.$('#chat-assign-all').hidden, true);
  assert.equal(other.$('#stop-chat').hidden, true);
  assert.match(other.$('#chat-status').textContent, /Another window/);
  assert.equal(other.$('#send-chat').disabled, true);
});

test('the board shows the current step when a role has several', () => {
  const ui = mount();
  const run = {
    id: 'r2', prompt: 'p', request: 'p', time: 0, status: 'active', approver: 'human', costUsd: 0, sessions: [], trees: [],
    steps: [{ ...job('Implement', 'api'), status: 'done' }, { ...job('Implement', 'web'), status: 'pending' }, { ...job('Review', 'web'), status: 'pending' }]
  };
  ui.post(state({ runs: [run] }));
  const states = Object.fromEntries(ui.$$('#squad-board .member').map(node => [node.dataset.role, node.dataset.state]));
  assert.deepEqual(states, { lead: 'idle', implement: 'pending', review: 'queued', tests: 'idle' });
});

test('the Project tab shows where settings come from, the workers\' MCP servers, and storage', () => {
  const ui = mount();
  const project = {
    name: 'clinic-suite', folder: '/w', trusted: true, repositories: ['services/billing-api', 'apps/web-portal'],
    settings: {
      baseBranch: 'origin/dev', mergeRequests: 'auto', mergeRequestTarget: 'dev', budgetUsd: 1, timeoutMinutes: 20, allowedCommands: [],
      repositoryCommands: { 'apps/web-portal': ['npx vitest run'] }, worktreeLinks: ['node_modules'], codegraph: false, cleanupAfterDays: 7, minFreeDiskGb: 2
    },
    scopes: { baseBranch: 'project', mergeRequestTarget: 'project', workerBudgetUsd: 'project', repositoryAllowedCommands: 'project', codegraph: 'project', cleanupAfterDays: 'default' },
    mcp: [
      { name: 'postgres', source: '.mcp.json', tools: ['query'], roles: ['Lead', 'Implement'], server: 'stdio · pg-mcp' },
      { name: 'jira', source: '.mcp.json', tools: ['x'], roles: ['Lead'], problem: 'No server with this name in .mcp.json.', server: '' }
    ],
    mcpFile: true, mcpAvailable: ['codegraph'],
    disk: { free: 1024 ** 3, minimum: 2 * 1024 ** 3 }, runs: { count: 3, limit: 10 }, memory: { notes: 12, limit: 200 },
    storage: {
      time: 0, partial: false, stateBytes: 25_000, leftovers: [{ path: '/wt/9c8d7e6f/1-api', bytes: 60_000 }],
      transcripts: { paths: ['/c/projects/x'], bytes: 2 * 1024 ** 2, keptBytes: 1024 ** 2 },
      runs: [{ id: 'r1', title: 'test: add date parser tests', bytes: 285 * 1024 ** 2, disposable: true, settled: 0 }]
    },
    storageBusy: false
  };
  ui.post(state({}, { project }));
  ui.click(ui.$('#show-project'));
  assert.equal(ui.$('#project-panel').hidden, false);
  assert.equal(ui.$('#project-name').textContent, 'clinic-suite');
  const settings = ui.$$('#project-settings dt').map((term, index) => [term.textContent, ui.$$('#project-settings dd')[index].textContent]);
  assert.deepEqual(settings.find(([label]) => label === 'Worktrees start from'), ['Worktrees start from', 'origin/dev project']);
  assert.deepEqual(settings.find(([label]) => label.trim() === 'apps/web-portal'), ['  apps/web-portal', 'npx vitest run project']);
  assert.deepEqual(settings.find(([label]) => label.startsWith('Clean up')), ['Clean up merged or pushed runs', 'after 7 days']);

  const servers = ui.$$('#project-mcp li');
  assert.match(servers[0].textContent, /postgres · stdio · pg-mcpquery · Lead, Implement · from \.mcp\.json/);
  assert.match(servers[1].querySelector('small.problem').textContent, /No server with this name/);
  assert.equal(ui.$('#project-mcp-file').hidden, false);
  ui.click(servers[0].querySelector('button'));
  assert.deepEqual(ui.last('removeMcp'), { type: 'project', action: 'removeMcp', name: 'postgres' });
  ui.post({ type: 'workspaceSettled' });

  assert.match(ui.$('#project-disk').textContent, /^1\.0 GB free — below the 2\.0 GB Squad needs; new runs and steps are refused · 3\/10 runs · 12\/200 memory notes$/);
  assert.ok(ui.$('#project-disk').classList.contains('problem'));
  const storage = ui.$$('#project-storage li').map(item => item.textContent);
  assert.match(storage[0], /^Total 288 MB/);
  assert.equal(storage[1], 'test: add date parser tests285 MB · merged or pushed, can be cleaned up');
  assert.match(storage.join('\n'), /Unused worktree folders: 1 · 59 KB/);
  assert.match(storage.join('\n'), /Worker transcripts: 1\.0 MB for current runs, 2\.0 MB from removed runs/);
  ui.click(ui.$('#project-clean'));
  assert.deepEqual(ui.last('cleanStorage'), { type: 'project', action: 'cleanStorage' });
  ui.post({ type: 'workspaceSettled' });
  ui.click(ui.$('#project-add-mcp'));
  assert.deepEqual(ui.last('addMcp'), { type: 'project', action: 'addMcp' });

  ui.post({ type: 'workspaceSettled' });
  const many = Array.from({ length: 10 }, (_, index) => `repo-${index}`);
  ui.post(state({}, { project: { ...project, repositories: many, trusted: false, mcp: [], storage: undefined, storageBusy: true } }));
  assert.equal(ui.$('#project-settings dd').textContent, '10: repo-0, repo-1, repo-2, repo-3, and 6 more');
  assert.equal(ui.$('#project-settings dd').title, many.join('\n'));
  assert.match(ui.$('#project-mcp').textContent, /Trust this workspace/);
  assert.equal(ui.$('#project-add-mcp').disabled, true);
  assert.equal(ui.$('#project-storage').textContent, 'Measuring…');
});
