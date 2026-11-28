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

test('a pushed run offers Deploy for repositories with a deploy target, and shows deploy MRs and health', () => {
  const ui = mount();
  const tree = (target, extra) => ({ target, repo: `/w/${target}`, path: `/t/${target}`, branch: 'xdev/squad/abcd1234', base: 'b', commit: 'c', files: 1, ...extra });
  const pushed = { remote: 'origin', target: 'dev', mergeRequest: true, url: 'https://gitlab.example.com/a/-/merge_requests/3', time: 1 };
  const run = {
    id: 'r1', prompt: 'p', request: 'p', time: 0, finished: 1, status: 'done', approver: 'human', costUsd: 0, sessions: [],
    steps: [{ ...job('Implement', 'services/api'), status: 'done' }],
    trees: [tree('services/api', { pushed }), tree('docs', { pushed })]
  };
  const deploy = { 'services/api': { from: 'dev', to: 'build-dev', health: 'https://api.example.com/healthz' } };
  const base = state({ runs: [run] });
  ui.post({ ...base, sync: { ...base.sync, deploy } });
  const deployButton = ui.$$('#run-list li.run .actions button').find(node => node.textContent === 'Deploy');
  assert.ok(deployButton, 'Deploy shows for a pushed repository with a target');
  assert.equal(deployButton.title, 'services/api: dev → build-dev');
  assert.ok(ui.$$('#run-list li.run .actions button').some(node => node.textContent === 'Check health'));
  ui.click(deployButton);
  assert.deepEqual(ui.last('runDeploy'), { type: 'squadChat', action: 'runDeploy', id: 'r1' });
  ui.post({ type: 'chatSettled' });

  run.trees[0].deploy = { from: 'dev', to: 'build-dev', url: 'https://gitlab.example.com/a/-/merge_requests/4', time: 2, health: { url: 'https://api.example.com/healthz', status: 503, time: 3 } };
  ui.post({ ...base, teamChat: { ...base.teamChat, runs: [run] }, sync: { ...base.sync, deploy } });
  const row = ui.$('#run-list .deployed li');
  assert.match(row.textContent, /^services\/api: deploy MR dev → build-dev · health 503 at .+Open deploy MR$/);
  assert.ok(row.classList.contains('unhealthy'));
  ui.click(row.querySelector('button'));
  assert.deepEqual(ui.last('runDeployLink'), { type: 'squadChat', action: 'runDeployLink', id: 'r1', repo: 'services/api' });
  assert.ok(ui.$$('#run-list li.run .actions button').some(node => node.textContent === 'Deploy again'));

  ui.post({ ...base, sync: { ...base.sync, deploy: {} } });
  assert.ok(!ui.$$('#run-list li.run .actions button').some(node => /Deploy/.test(node.textContent)), 'no target, no Deploy');
});

test('the Project tab lists worker .env files by variable name only, and deploy targets', () => {
  const ui = mount();
  const project = {
    name: 'p', folder: '/w', trusted: true, repositories: ['services/api'],
    settings: { baseBranch: '', mergeRequests: 'auto', mergeRequestTarget: '', budgetUsd: 1, timeoutMinutes: 20, allowedCommands: [], repositoryCommands: {}, worktreeLinks: [], codegraph: true, cleanupAfterDays: 7, minFreeDiskGb: 2 },
    scopes: { workerEnvFiles: 'project', deployTargets: 'project' }, mcp: [], mcpFile: false, mcpAvailable: [],
    envFiles: [
      { repo: 'services/api', file: '.env', names: ['DB_URL', 'REDIS_URL'], skipped: ['ANTHROPIC_API_KEY'] },
      { repo: 'web', file: '.env', names: [], skipped: [], problem: 'File not found in your checkout.' }
    ],
    deploy: { 'services/api': { from: 'dev', to: 'build-dev', health: 'https://api.example.com/healthz' }, studio: { from: 'main' } },
    disk: { free: 10 * 1024 ** 3, minimum: 2 * 1024 ** 3 }, runs: { count: 0, limit: 10 }, memory: { notes: 0, limit: 200 }, storageBusy: false
  };
  ui.post(state({}, { project }));
  const rows = Object.fromEntries(ui.$$('#project-settings dt').map((term, index) => [term.textContent, ui.$$('#project-settings dd')[index]]));
  assert.equal(rows['Env · services/api'].textContent, '.env: 2 variables, 1 skipped project');
  assert.equal(rows['Env · services/api'].title, 'DB_URL\nREDIS_URL\nANTHROPIC_API_KEY (skipped: would change the worker)');
  assert.ok(rows['Env · web'].classList.contains('problem'));
  assert.equal(rows['Deploy · services/api'].textContent, 'dev → build-dev · health https://api.example.com/healthz project');
  assert.equal(rows['Deploy · studio'].textContent, 'on main project');
});

test('runs that work at the same time each show their feed and lock only themselves', () => {
  const ui = mount();
  const tree = id => ({ target: '.', repo: '/w', path: `/t/${id}`, branch: `xdev/squad/${id}`, base: 'b' });
  const run = (id, status) => ({
    id, prompt: `Implement: task ${id}`, request: 'Three endpoints', time: 0, status: 'active', approver: 'human', costUsd: 0, sessions: [],
    steps: [{ ...job('Implement', undefined, `task ${id}`), status }], trees: [tree(id)]
  });
  const live = profile => ({ role: 'Implement', profile, since: Date.now() - 5_000, items: [{ kind: 'edit', text: `src/${profile}.ts`, time: 1 }], reads: 0, edits: 1, commands: 0 });
  const runs = [run('aaaa1111', 'running'), run('bbbb2222', 'running'), run('cccc3333', 'pending')];
  ui.post(state({
    runs, busy: true, chatBusy: false, maxParallel: 3, busyRuns: ['aaaa1111', 'bbbb2222'], live: live('dev-1'), status: '2 are working: Implement is working · Implement is working',
    working: [{ run: 'aaaa1111', status: 'Implement is working…', live: live('dev-1') }, { run: 'bbbb2222', status: 'Implement is working…', live: live('dev-2') }]
  }));

  const feeds = ui.$$('#chat-live .live-item');
  assert.equal(feeds.length, 2, 'one feed for each run that works');
  assert.deepEqual(feeds.map(feed => feed.querySelector('.live-head .subtle').textContent), ['dev-1', 'dev-2']);
  assert.deepEqual(feeds.map(feed => feed.querySelector('code').textContent), ['src/dev-1.ts', 'src/dev-2.ts']);
  assert.equal(ui.$('#stop-chat').textContent, 'Stop all');

  const cards = ui.$$('#run-list li.run');
  const buttons = card => [...card.querySelectorAll('.actions button')];
  const named = (card, text) => buttons(card).find(node => node.textContent === text);
  assert.deepEqual(cards.map(card => card.classList.contains('working')), [true, true, false]);
  assert.equal(named(cards[0], 'Finish run').disabled, true, 'a run that works is locked');
  assert.equal(named(cards[2], 'Finish run').disabled, false, 'the idle run is not');
  assert.equal(named(cards[2], 'Run headless').disabled, false, 'and its step can start while the others work');
  assert.equal(named(cards[2], 'Stop this run'), undefined);
  ui.click(named(cards[1], 'Stop this run'));
  assert.deepEqual([ui.last('stop').action, ui.last('stop').id], ['stop', 'bbbb2222'], 'one run is stopped by its id');

  // The chat stays usable while only steps of runs work.
  const message = ui.$('#chat-message');
  message.value = 'What is left?';
  message.dispatchEvent(new ui.window.Event('input'));
  assert.equal(ui.$('#send-chat').disabled, true, 'a request is on its way');
});

test('a parallel plan says that each task becomes its own run', () => {
  const ui = mount();
  ui.post(state({ maxParallel: 3, plan: { id: 'p1', parallel: true, jobs: [job('Implement', undefined, 'alpha'), job('Implement', undefined, 'beta')] } }));
  assert.match(ui.$('#plan-cost').textContent, /^Parallel plan: each task becomes its own run, with its own worktree and branch, and up to 3 work at the same time/);
  ui.post(state({ maxParallel: 3, plan: { id: 'p2', jobs: [job('Implement')] } }));
  assert.doesNotMatch(ui.$('#plan-cost').textContent, /Parallel plan/);

  // With one piece of work the feed keeps its single form, and the chat is free while a step works.
  const live = { role: 'Implement', profile: 'dev-1', since: Date.now(), items: [], reads: 0, edits: 0, commands: 0 };
  ui.post(state({ busy: true, chatBusy: false, busyRuns: ['r1'], live, working: [{ run: 'r1', status: 'Implement is working…', live }] }));
  assert.equal(ui.$$('#chat-live .live-item').length, 0);
  assert.equal(ui.$('#chat-live #live-time') !== null, true);
  assert.equal(ui.$('#stop-chat').textContent, 'Stop run');
  const message = ui.$('#chat-message');
  message.value = 'What is left?';
  message.dispatchEvent(new ui.window.Event('input'));
  assert.equal(ui.$('#send-chat').disabled, false, 'the chat is free while a step works');
  ui.post(state({ busy: true, chatBusy: true, busyRuns: [], status: 'Lead is planning…', working: [{ status: 'Lead is planning…' }] }));
  assert.equal(ui.$('#send-chat').disabled, true, 'and waits while Lead answers');
});

test('one run can be stopped on its own while a chat request is also in flight', () => {
  const ui = mount();
  const run = {
    id: 'aaaa1111', prompt: 'Rename', request: 'Rename', time: 0, status: 'active', approver: 'human', costUsd: 0, sessions: [],
    steps: [{ ...job('Implement'), status: 'running' }], trees: [{ target: '.', repo: '/w', path: '/t/a', branch: 'xdev/squad/aaaa1111', base: 'b' }]
  };
  const buttons = () => ui.$$('#run-list li.run .actions button').map(node => node.textContent);
  ui.post(state({ runs: [run], busy: true, chatBusy: true, busyRuns: ['aaaa1111'], working: [{ status: 'Lead is planning…' }, { run: 'aaaa1111', status: 'Implement is working…' }] }));
  assert.ok(buttons().includes('Stop this run'));
  assert.equal(ui.$('#stop-chat').textContent, 'Stop all');
  // Alone, the run is stopped with the one Stop button.
  ui.post(state({ runs: [run], busy: true, chatBusy: false, busyRuns: ['aaaa1111'], working: [{ run: 'aaaa1111', status: 'Implement is working…' }] }));
  assert.ok(!buttons().includes('Stop this run'));
  assert.equal(ui.$('#stop-chat').textContent, 'Stop run');
});

test('a blocked step shows the question and sends the answer; a session opens as a transcript', () => {
  const ui = mount();
  const run = {
    id: 'r1', prompt: 'Health endpoint', request: 'Health endpoint', time: 0, status: 'active', approver: 'human', costUsd: 0,
    sessions: [{ role: 'Implement', profileId: 'claude:1', profile: 'alex', sessionId: 'sess-1', repo: '.' }],
    steps: [{ ...job('Implement'), status: 'blocked', summary: 'Two routers exist', question: 'Which router: v1 or v2?' }],
    trees: [{ target: '.', repo: '/w', path: '/t/a', branch: 'xdev/squad/r1', base: 'b' }]
  };
  ui.post(state({ runs: [run], busyRuns: [], working: [] }));
  assert.equal(ui.$('#run-list .step-controls .question').textContent, 'Implement asks: Which router: v1 or v2?');
  const answer = ui.$('#run-list .step-controls textarea[aria-label="Answer to Implement"]');
  const button = ui.$$('#run-list .step-controls button').find(node => node.textContent === 'Send answer');
  assert.equal(button.disabled, true, 'an empty answer is not sent');
  answer.value = 'Use v2';
  answer.dispatchEvent(new ui.window.Event('input'));
  assert.equal(button.disabled, false);
  ui.click(button);
  assert.deepEqual([ui.last('stepAnswer').id, ui.last('stepAnswer').answer], ['r1', 'Use v2']);

  const second = mount();
  second.post(state({ runs: [run], busyRuns: [], working: [] }));
  second.click(second.$$('#run-list li.run .actions button').find(node => node.textContent === 'Transcript Implement'));
  assert.deepEqual([second.last('runTranscript').id, second.last('runTranscript').session], ['r1', 'sess-1']);

  // A step that is not blocked has no answer box.
  const third = mount();
  third.post(state({ runs: [{ ...run, steps: [{ ...job('Implement'), status: 'pending' }] }], busyRuns: [], working: [] }));
  assert.equal(third.$('#run-list .step-controls .question'), null);
  assert.ok(!third.$$('#run-list .step-controls button').some(node => node.textContent === 'Send answer'));
});

test('finished runs of one parallel plan offer to combine, and a combined run says what it merged', () => {
  const ui = mount();
  const tree = (id, extra) => ({ target: '.', repo: '/w', path: `/t/${id}`, branch: `xdev/squad/${id}`, base: 'b', commit: 'c', files: 1, ...extra });
  const part = (id, extra) => ({
    id, prompt: `Implement: task ${id}`, request: 'Three endpoints', title: `task ${id}`, batch: 'batch-1', time: 0, finished: 1, status: 'done', approver: 'human',
    costUsd: 0, sessions: [], steps: [{ ...job('Implement'), status: 'done' }], trees: [tree(id)], ...extra
  });
  const buttons = card => [...card.querySelectorAll('.actions button')].map(node => node.textContent);
  ui.post(state({ runs: [part('a'), part('b'), part('c', { status: 'active', trees: [tree('c', { commit: undefined })] })], busyRuns: [], working: [] }));
  let cards = ui.$$('#run-list li.run');
  assert.ok(buttons(cards[0]).includes('Combine 2 runs') && buttons(cards[1]).includes('Combine 2 runs'), 'the two finished runs can be combined');
  assert.ok(!buttons(cards[2]).some(text => /^Combine/.test(text)), 'a run that is still open is not part of it');
  ui.click([...cards[1].querySelectorAll('.actions button')].find(node => node.textContent === 'Combine 2 runs'));
  assert.deepEqual([ui.last('runCombine').action, ui.last('runCombine').id], ['runCombine', 'b']);

  const second = mount();
  const combined = {
    id: 'z', prompt: 'Combined: task a; task b', request: 'Combine: task a; task b; task c', title: 'Combine 2 changes', time: 2, status: 'active', approver: 'human',
    costUsd: 0, sessions: [], steps: [{ ...job('Review'), status: 'pending' }], trees: [tree('z', { commit: undefined })],
    combined: [
      { run: 'a', title: 'task a', branch: 'xdev/squad/a', merged: true }, { run: 'b', title: 'task b', branch: 'xdev/squad/b', merged: true },
      { run: 'c', title: 'task c', branch: 'xdev/squad/c', merged: false, conflicts: ['README.md'] }
    ]
  };
  second.post(state({ runs: [combined, part('a', { combinedInto: 'z' }), part('b', { combinedInto: 'z' }), part('c')], busyRuns: [], working: [] }));
  cards = second.$$('#run-list li.run');
  assert.deepEqual([...cards[0].querySelectorAll('.combined li')].map(row => [row.className, row.textContent]), [
    ['merged', 'Merged: task a'], ['merged', 'Merged: task b'], ['left-out', 'Left out: task c · conflicts in README.md']
  ]);
  assert.match(cards[1].textContent, /Merged into a combined run/);
  assert.ok(!cards.some(card => buttons(card).some(text => /^Combine/.test(text))), 'one run alone is not offered');
});

test('with several runs working each feed names its run, and a stopped step says why above its controls', () => {
  const ui = mount();
  const run = (id, title, step) => ({
    id, prompt: `Implement: ${title}`, request: 'Endpoints', title, time: 0, status: 'active', approver: 'human', costUsd: 0, sessions: [],
    steps: [{ ...job('Implement', undefined, title), ...step }], trees: [{ target: '.', repo: '/w', path: `/t/${id}`, branch: `xdev/squad/${id}`, base: 'b' }]
  });
  const live = profile => ({ role: 'Implement', profile, since: Date.now() - 5_000, items: [], reads: 0, edits: 0, commands: 0 });
  const runs = [run('a', 'Add orders', { status: 'running' }), run('b', 'Add invoices', { status: 'running' }),
    run('c', 'Add refunds', { status: 'failed', summary: 'The worker reached its budget limit.' }), run('d', 'Add carts', { status: 'pending', summary: 'An older note' })];
  const working = [{ run: 'a', status: 'Implement is working…', live: live('dev-1') }, { run: 'b', status: 'Implement is working…', live: live('dev-2') }];
  ui.post(state({ runs, busy: true, chatBusy: false, maxParallel: 3, busyRuns: ['a', 'b'], working }));
  assert.deepEqual(ui.$$('#chat-live .live-item .live-run').map(node => node.textContent), ['Add orders', 'Add invoices']);
  const cards = ui.$$('#run-list li.run');
  assert.equal(cards[2].querySelector('.step .why').textContent, 'The worker reached its budget limit.');
  assert.ok(cards[2].querySelector('.step .why').compareDocumentPosition(cards[2].querySelector('.step-controls')) & ui.window.Node.DOCUMENT_POSITION_FOLLOWING, 'the reason comes before the controls');
  assert.equal(cards[3].querySelector('.step .why'), null, 'a step that has not stopped shows no reason');

  // One run alone needs no name on its feed.
  ui.post(state({ runs, busy: true, chatBusy: false, busyRuns: ['a'], working: working.slice(0, 1) }));
  assert.equal(ui.$('#chat-live .live-run'), null);
});

test('a parallel plan under a limit of one says the runs work one at a time', () => {
  const ui = mount();
  ui.post(state({ maxParallel: 1, plan: { id: 'p1', parallel: true, repos: ['.'], jobs: [{ ...job('Implement'), repo: '.' }, { ...job('Implement'), repo: '.' }] } }));
  assert.match(ui.$('#plan-cost').textContent, /^Parallel plan: each task becomes its own run, with its own worktree and branch, and they work one at a time\. You review and merge each run on its own, or combine them when they are finished\./);
});

test('a combined run offers to resolve the conflicts of what it left out, and says what was resolved', () => {
  const tree = { target: '.', repo: '/w', path: '/t/z', branch: 'xdev/squad/z', base: 'b' };
  const combined = (steps, parts) => ({
    id: 'z', prompt: 'Combined: task a', request: 'Combine: task a; task b', title: 'Combine 1 changes', time: 2, status: 'active', approver: 'human', costUsd: 0, sessions: [], steps, trees: [tree],
    combined: [{ run: 'a', title: 'task a', branch: 'xdev/squad/a', merged: true }, ...parts]
  });
  const left = { run: 'b', title: 'task b', branch: 'xdev/squad/b', merged: false, conflicts: ['README.md'] };
  const actions = ui => ui.$$('#run-list li.run .actions button').map(node => node.textContent);

  const ui = mount();
  ui.post(state({ runs: [combined([{ ...job('Review'), status: 'pending' }], [left])], busyRuns: [], working: [] }));
  const button = ui.$$('#run-list li.run .actions button').find(node => node.textContent === 'Resolve conflicts');
  assert.match(button.title, /Implement step for each run that was left out/);
  ui.click(button);
  assert.deepEqual([ui.last('runResolve').action, ui.last('runResolve').id], ['runResolve', 'z']);

  // While a step merges the run, the offer is gone and the step is marked.
  const second = mount();
  second.post(state({ runs: [combined([{ ...job('Implement'), status: 'pending', resolves: 'b' }, { ...job('Review'), status: 'pending' }], [left])], busyRuns: [], working: [] }));
  assert.ok(!actions(second).includes('Resolve conflicts'));
  assert.match(second.$('#run-list .step').textContent, /^Implement \(merge\) · alex/);

  const third = mount();
  third.post(state({ runs: [combined([{ ...job('Implement'), status: 'done', resolves: 'b' }, { ...job('Review'), status: 'pending' }], [{ ...left, merged: true, conflicts: undefined, resolved: ['README.md'] }])], busyRuns: [], working: [] }));
  assert.ok(!actions(third).includes('Resolve conflicts'));
  assert.deepEqual(third.$$('#run-list .combined li').map(row => row.textContent), ['Merged: task a', 'Merged: task b · conflicts resolved in README.md']);
});

test('a step that merges a left-out run has no Open in terminal', () => {
  const ui = mount();
  const run = {
    id: 'z', prompt: 'Combined: task a', request: 'Combine', time: 2, status: 'active', approver: 'human', costUsd: 0, sessions: [],
    steps: [{ ...job('Implement'), status: 'pending', resolves: 'b' }], trees: [{ target: '.', repo: '/w', path: '/t/z', branch: 'xdev/squad/z', base: 'b' }],
    combined: [{ run: 'b', title: 'task b', branch: 'xdev/squad/b', merged: false, conflicts: ['README.md'] }]
  };
  ui.post(state({ runs: [run], busyRuns: [], working: [] }));
  assert.deepEqual(ui.$$('#run-list .step-controls button').map(node => node.textContent), ['Run headless', 'Skip step']);
});
