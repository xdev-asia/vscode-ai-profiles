function mountSquadChat(vscode, roles) {
  const byId = id => document.getElementById(id);
  const log = byId('chat-messages');
  const message = byId('chat-message');
  const error = byId('chat-error');
  const terminalRole = byId('chat-terminal-role');
  let snapshot;
  let pending;
  let transcript;

  let lastState;
  function render(state) {
    lastState = state;
    snapshot = state.teamChat;
    const entries = JSON.stringify(snapshot.entries);
    if (entries !== transcript) {
      const follow = !transcript || log.scrollHeight - log.scrollTop - log.clientHeight < 50;
      const previousCount = transcript ? JSON.parse(transcript).length : snapshot.entries.length;
      const items = snapshot.entries.map((entry, position) => {
        const item = document.createElement('article');
        if (position >= previousCount) item.className = 'fresh';
        item.dataset.author = entry.author;
        const label = document.createElement('strong');
        label.textContent = entry.to ? `${entry.author} → ${entry.to}` : entry.author;
        const profile = document.createElement('small');
        profile.textContent = entry.profile ?? '';
        const text = document.createElement('p');
        text.textContent = entry.text;
        item.append(label, profile, text);
        return item;
      });
      if (!items.length) {
        const empty = document.createElement('p');
        empty.className = 'chat-hint';
        empty.textContent = 'Send a request to Lead or use @Implement, @Review, or @Tests.';
        items.push(empty);
      }
      log.replaceChildren(...items);
      if (follow) log.scrollTop = log.scrollHeight;
      transcript = entries;
    }

    const { plan, status, busy } = snapshot;
    byId('chat-plan').hidden = !plan;
    byId('chat-jobs').replaceChildren(...(plan?.jobs ?? []).map(job => {
      const row = document.createElement('li');
      const label = document.createElement('strong');
      label.textContent = `${job.role} · ${job.profile}`;
      const badge = document.createElement('span');
      badge.className = `badge ${job.kind}`;
      badge.textContent = job.kind === 'claude'
        ? (job.role === 'Review' ? 'Claude Code · reads the repo' : 'Claude Code · edits the worktree')
        : 'Text API · no file access';
      const brief = document.createElement('p');
      brief.textContent = job.brief;
      row.append(label, badge, brief);
      return row;
    }));
    const headless = (plan?.jobs ?? []).filter(job => job.kind === 'claude').length;
    const workers = state.sync?.workers;
    const commands = workers?.allowedCommands?.length ? workers.allowedCommands.join(', ') : 'read-only git only';
    const approver = byId('plan-approver');
    if (!plan) approver.dataset.touched = '';
    if (!approver.dataset.touched && state.sync?.approver) approver.value = state.sync.approver;
    const approverText = {
      human: 'Approving runs nothing yet: you start, edit, or skip each step yourself.',
      'ai+human': 'Approving runs nothing yet. After each step, Lead\'s account reviews it; you still start every step.',
      ai: 'You start the first step. Each passing AI review then starts the next step; a review asking for changes, a blocked step, or an error stops and waits for you. Merging always waits for you.'
    }[approver.value] ?? '';
    renderRepo(plan, headless);
    byId('plan-cost').textContent = `${approverText}${headless
      ? ` Claude Code steps use a new git worktree${workers?.budgetUsd ? `, each headless step capped at $${workers.budgetUsd}` : ''}. Allowed commands: ${commands}.` : ''}`;
    renderRuns(snapshot.runs ?? []);
    renderBoard(state);
    renderLive(snapshot.live, busy);
    const profileFor = role => state.accounts.find(profile => profile.id === state.seats[role]?.account);
    const lead = profileFor('Lead');
    const leadUsable = lead?.kind === 'api' || (lead?.detail === 'Claude Code' && snapshot.workers);
    byId('chat-status').textContent = status || (plan ? 'Review the roles and briefs before running.' :
      leadUsable ? `Lead uses ${lead.name} · ${lead.detail}` : 'Assign an API profile or a Claude Code account to Lead under Roles to start planning.');
    byId('stop-chat').hidden = !busy;
    const terminals = roles.filter(role => profileFor(role)?.kind === 'terminal');
    const selected = terminalRole.value;
    terminalRole.replaceChildren(...terminals.map(role => {
      const profile = profileFor(role);
      return new Option(`${role} · ${profile.name} · ${profile.detail}`, role);
    }));
    if (terminals.includes(selected)) terminalRole.value = selected;
    byId('chat-terminal').hidden = !terminals.length;
    updateControls();
  }

  const repoSelect = byId('plan-repo');
  function renderRepo(plan, headless) {
    const repos = plan?.repos ?? [];
    const field = byId('plan-repo-field');
    field.hidden = !headless || repos.length < 2;
    if (!plan) { repoSelect.dataset.touched = ''; repoSelect.dataset.plan = ''; }
    if (field.hidden) return;
    if (repoSelect.dataset.plan !== plan.id) {
      repoSelect.dataset.plan = plan.id;
      repoSelect.dataset.touched = '';
      const choose = new Option('Choose a repository…', '');
      choose.disabled = true;
      repoSelect.replaceChildren(choose, ...repos.map(repo => new Option(repo, repo)));
    }
    if (!repoSelect.dataset.touched) repoSelect.value = plan.repo ?? '';
    byId('plan-repo-hint').textContent = plan.repo && !repoSelect.dataset.touched ? 'Suggested from the plan.' : '';
  }
  function repoMissing() {
    return !byId('plan-repo-field').hidden && !repoSelect.value;
  }

  const boardRoles = ['Lead', 'Implement', 'Review', 'Tests'];
  const stateText = {
    vacant: 'no account', idle: 'idle', planning: 'planning', working: 'working', reviewing: 'reviewing', proposed: 'proposed',
    pending: 'up next', queued: 'queued', terminal: 'in terminal', done: 'done', blocked: 'blocked', failed: 'failed', skipped: 'skipped'
  };
  let boardKey;
  function renderBoard(state) {
    const live = snapshot.live;
    const active = (snapshot.runs ?? []).find(run => run.status === 'active');
    const current = active ? active.steps.findIndex(step => step.status !== 'done' && step.status !== 'skipped') : -1;
    const members = boardRoles.filter(role => roles.includes(role)).map(role => {
      const profile = state.accounts.find(item => item.id === state.seats[role]?.account);
      const index = active ? active.steps.findIndex(step => step.role === role) : -1;
      const step = index >= 0 ? active.steps[index] : undefined;
      let status = profile ? 'idle' : 'vacant';
      if (snapshot.plan?.jobs.some(job => job.role === role)) status = 'proposed';
      if (step) status = step.status === 'pending' ? (index === current ? 'pending' : 'queued') : step.status;
      if (snapshot.busy && live?.role === role) status = role === 'Lead' && active ? 'reviewing' : 'working';
      else if (snapshot.busy && role === 'Lead' && /^Lead/.test(snapshot.status)) status = /review/i.test(snapshot.status) ? 'reviewing' : 'planning';
      return { role, status, profile: profile ? `${profile.name} · ${profile.detail}` : 'Assign under Roles' };
    });
    const key = JSON.stringify(members);
    if (key === boardKey) return;
    boardKey = key;
    byId('squad-board').replaceChildren(...members.map(member => {
      const item = element('div', undefined, 'member');
      item.dataset.role = member.role.toLowerCase();
      item.dataset.state = member.status;
      item.title = `${member.role} · ${member.profile}`;
      const avatar = element('span', member.role[0], 'avatar');
      avatar.setAttribute('aria-hidden', 'true');
      item.append(avatar, element('span', member.role, 'name'), element('span', stateText[member.status] ?? member.status, 'state'));
      return item;
    }));
  }

  const kindLabel = { read: 'Read', search: 'Search', edit: 'Edit', run: 'Run', tool: 'Tool' };
  let liveKey;
  let liveSince;
  function elapsed(since) {
    const seconds = Math.max(0, Math.round((Date.now() - since) / 1000));
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
  }
  function renderLive(live, busy) {
    const box = byId('chat-live');
    box.hidden = !busy || !live;
    liveSince = box.hidden ? undefined : live.since;
    if (box.hidden) { liveKey = undefined; return; }
    const key = JSON.stringify(live);
    if (key === liveKey) return;
    liveKey = key;
    const head = element('div', undefined, 'live-head');
    const dot = element('span', undefined, 'pulse');
    dot.setAttribute('aria-hidden', 'true');
    const timer = element('span', elapsed(live.since), 'live-time');
    timer.id = 'live-time';
    head.append(dot, element('strong', live.role), element('span', live.profile, 'subtle'), timer);
    const counts = [
      live.reads && `${live.reads} read${live.reads === 1 ? '' : 's'}`,
      live.edits && `${live.edits} edit${live.edits === 1 ? '' : 's'}`,
      live.commands && `${live.commands} command${live.commands === 1 ? '' : 's'}`
    ].filter(Boolean).join(' · ');
    const list = element('ol', undefined, 'live-list');
    for (const [position, item] of live.items.entries()) {
      const row = element('li', undefined, position === live.items.length - 1 ? 'latest' : undefined);
      row.append(element('span', kindLabel[item.kind] ?? item.kind, `kind ${item.kind}`), element('code', item.text || '…'));
      list.append(row);
    }
    if (!live.items.length) list.append(element('li', 'Starting…', 'subtle'));
    box.replaceChildren(head, ...(counts ? [element('p', counts, 'subtle live-counts')] : []), list);
  }
  // Keep the team board just below the tab bar, which is sticky in a narrow side bar.
  const header = document.querySelector('.top');
  const placeBoard = () => {
    const sticky = header && getComputedStyle(header).position === 'sticky';
    document.documentElement.style.setProperty('--board-top', sticky ? `${header.getBoundingClientRect().height}px` : '0px');
  };
  if (header && typeof ResizeObserver === 'function') new ResizeObserver(placeBoard).observe(header);
  window.addEventListener('resize', placeBoard);
  placeBoard();

  setInterval(() => {
    const timer = byId('live-time');
    if (timer && liveSince) timer.textContent = elapsed(liveSince);
  }, 1000);

  let toastTimer;
  function toast(text, tone) {
    const node = byId('squad-toast');
    node.textContent = text;
    node.dataset.tone = tone;
    node.hidden = false;
    node.classList.remove('show');
    void node.offsetWidth;
    node.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { node.hidden = true; }, 4000);
  }
  let stepStatuses;
  function announce(runs) {
    const next = new Map();
    for (const run of runs) {
      run.steps.forEach((step, index) => next.set(`${run.id}:${index}`, step.status));
      next.set(run.id, run.status);
    }
    if (stepStatuses) {
      for (const run of runs) {
        run.steps.forEach((step, index) => {
          const before = stepStatuses.get(`${run.id}:${index}`);
          if (before === step.status || !before) return;
          if (step.status === 'done') toast(`✓ ${step.role} done${step.files?.length ? ` · ${step.files.length} file${step.files.length === 1 ? '' : 's'}` : ''}`, 'good');
          else if (step.status === 'blocked' || step.status === 'failed') toast(`! ${step.role} ${step.status}`, 'warn');
        });
        const before = stepStatuses.get(run.id);
        if (before === 'active' && run.status !== 'active' && run.commit) toast(`Committed ${run.files ?? 0} file${run.files === 1 ? '' : 's'} to ${run.branch}`, 'good');
      }
    }
    stepStatuses = next;
  }

  const diffs = new Map();
  const openFiles = new Map();
  function patchView(patch) {
    const pre = element('pre', undefined, 'patch');
    for (const line of patch.split('\n')) {
      const kind = line.startsWith('@@') ? 'hunk' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : undefined;
      pre.append(element('span', `${line}\n`, kind));
    }
    return pre;
  }
  function changesView(run, busy) {
    const files = diffs.get(run.id);
    const box = element('div', undefined, 'changes');
    if (!files) return box;
    const added = files.reduce((sum, file) => sum + file.added, 0);
    const removed = files.reduce((sum, file) => sum + file.removed, 0);
    const head = element('div', undefined, 'changes-head');
    head.append(element('strong', `${files.length} file${files.length === 1 ? '' : 's'}`), element('span', `+${added}`, 'plus'), element('span', `−${removed}`, 'minus'));
    const refresh = element('button', 'Refresh');
    refresh.type = 'button';
    refresh.disabled = busy;
    refresh.addEventListener('click', () => send('runChanges', { id: run.id }));
    head.append(refresh);
    box.append(head);
    if (!files.length) box.append(element('p', 'No changes yet.', 'subtle'));
    const open = openFiles.get(run.id) ?? new Set();
    openFiles.set(run.id, open);
    for (const file of files) {
      const details = element('details', undefined, 'file');
      details.open = open.has(file.path);
      details.addEventListener('toggle', () => { if (details.open) open.add(file.path); else open.delete(file.path); });
      const summary = element('summary');
      const total = Math.max(1, file.added + file.removed);
      const bar = element('span', undefined, 'bar');
      bar.style.setProperty('--add', `${Math.round(file.added / total * 100)}%`);
      summary.append(element('span', file.status[0].toUpperCase(), `fstatus ${file.status}`), element('span', file.path, 'fpath'),
        element('span', `+${file.added} −${file.removed}`, 'delta'), bar);
      details.append(summary);
      details.append(file.binary ? element('p', 'Binary file.', 'subtle') : patchView(file.patch || '(no textual changes)'));
      const actions = element('div', undefined, 'actions');
      const openButton = element('button', 'Open diff');
      openButton.type = 'button';
      openButton.addEventListener('click', () => send('runOpenFile', { id: run.id, file: file.path }));
      const discard = element('button', 'Discard');
      discard.type = 'button';
      discard.disabled = busy;
      discard.addEventListener('click', () => send('runDiscard', { id: run.id, file: file.path }));
      actions.append(openButton, discard);
      details.append(actions);
      box.append(details);
    }
    return box;
  }

  let runsKey;
  const stepDrafts = new Map();
  const stepLabels = {
    pending: 'waiting for you', running: 'running', terminal: 'in terminal', done: 'done',
    blocked: 'blocked', failed: 'failed', skipped: 'skipped'
  };

  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function renderRuns(runs) {
    byId('chat-runs').hidden = !runs.length;
    announce(runs);
    const busy = Boolean(pending) || snapshot.busy;
    for (const id of diffs.keys()) if (!runs.some(run => run.id === id)) diffs.delete(id);
    const key = JSON.stringify(runs) + String(busy) + JSON.stringify([...diffs]);
    if (key === runsKey) return;
    runsKey = key;
    byId('run-list').replaceChildren(...runs.map(run => {
      const item = element('li', undefined, `run ${run.status}`);
      const cost = run.costUsd ? ` · $${run.costUsd.toFixed(run.costUsd < 0.1 ? 3 : 2)}` : '';
      const files = run.status === 'active' ? '' : ` · ${run.files ?? 0} file${run.files === 1 ? '' : 's'}`;
      const approvedBy = { human: 'you approve', 'ai+human': 'AI reviews, you approve', ai: 'AI approves' }[run.approver ?? 'human'];
      item.append(element('strong', run.prompt.split('\n', 1)[0]),
        element('small', `${run.target && run.target !== '.' ? `${run.target} · ` : ''}${run.branch ?? 'text only'} · ${run.status} · ${approvedBy}${files}${cost}`));

      const steps = element('ol', undefined, 'steps');
      const current = run.status === 'active'
        ? run.steps.findIndex(step => step.status !== 'done' && step.status !== 'skipped') : -1;
      run.steps.forEach((step, index) => {
        const row = element('li', undefined, `step ${step.status}${index === current ? ' current' : ''}`);
        row.append(element('span', `${step.role} · ${step.profile} · ${stepLabels[step.status] ?? step.status}`));
        if (step.gate) {
          row.append(element('p', `AI review (${step.gate.by}): ${step.gate.verdict === 'pass' ? 'pass' : 'changes requested'}. ${step.gate.reason}`,
            `gate ${step.gate.verdict}`));
        }
        if (index === current) row.append(stepControls(run, step, index, busy));
        else if (step.summary) row.append(element('p', step.summary.length > 240 ? step.summary.slice(0, 240) + '…' : step.summary, 'subtle'));
        steps.append(row);
      });
      item.append(steps);

      if (run.stat) {
        const stat = element('details');
        stat.append(element('summary', 'Changed files'), element('pre', run.stat));
        item.append(stat);
      }
      const actions = element('div', undefined, 'actions');
      const button = (text, action, args, disabled) => {
        const control = element('button', text);
        control.type = 'button';
        control.disabled = disabled;
        control.addEventListener('click', () => send(action, { id: run.id, ...args }));
        actions.append(control);
      };
      const active = run.status === 'active';
      if (active) button('Finish run', 'runFinish', {}, busy);
      if (run.branch) {
        const shown = diffs.has(run.id);
        const changes = element('button', shown ? 'Hide changes' : 'Changes', shown ? undefined : 'accent');
        changes.type = 'button';
        changes.addEventListener('click', () => {
          if (diffs.has(run.id)) { diffs.delete(run.id); runsKey = undefined; renderRuns(snapshot.runs ?? []); }
          else send('runChanges', { id: run.id });
        });
        actions.append(changes);
        button('Full diff', 'runDiff', {}, active || !run.commit);
        button('Merge', 'runMerge', {}, active || busy || !run.commit);
        button('Open folder', 'runOpen', {}, false);
        for (const session of run.sessions) {
          button(`Resume ${session.role} session`, 'runResume', { session: session.sessionId }, busy);
        }
      }
      button('Remove', 'runRemove', {}, busy);
      item.append(actions);
      if (diffs.has(run.id)) item.append(changesView(run, busy));
      return item;
    }));
  }

  function stepControls(run, step, index, busy) {
    const box = element('div', undefined, 'step-controls');
    const draftKey = `${run.id}:${index}`;
    const brief = element('textarea');
    brief.rows = 3;
    brief.maxLength = 4000;
    brief.setAttribute('aria-label', `${step.role} brief`);
    brief.value = stepDrafts.get(draftKey) ?? step.brief;
    brief.disabled = busy || step.status === 'terminal' || step.status === 'running';
    brief.addEventListener('input', () => stepDrafts.set(draftKey, brief.value));
    const label = element('label', 'Brief for this step');
    label.append(brief);
    box.append(label);
    const actions = element('div', undefined, 'actions');
    const add = (text, action, args, primary) => {
      const control = element('button', text, primary ? 'primary' : undefined);
      control.type = 'button';
      control.disabled = busy;
      control.addEventListener('click', () => {
        stepDrafts.delete(draftKey);
        send(action, { id: run.id, ...args() });
      });
      actions.append(control);
    };
    if (step.status === 'terminal') {
      const summary = element('textarea');
      summary.rows = 2;
      summary.maxLength = 2000;
      summary.placeholder = 'What was done (optional). Later steps receive this summary.';
      summary.setAttribute('aria-label', `${step.role} summary`);
      box.append(summary);
      add('Mark step done', 'stepDone', () => ({ summary: summary.value }), true);
    } else if (step.status !== 'running') {
      const again = step.status === 'blocked' || step.status === 'failed';
      add(step.kind === 'claude' ? (again ? 'Run again' : 'Run headless') : (again ? 'Ask again' : 'Ask API'), 'stepRun',
        () => ({ brief: brief.value }), true);
      if (step.kind === 'claude') add('Open in terminal', 'stepTerminal', () => ({ brief: brief.value }));
    }
    if (step.status !== 'running') add('Skip step', 'stepSkip', () => ({}));
    box.append(actions);
    return box;
  }

  function updateControls() {
    message.disabled = !snapshot;
    byId('send-chat').disabled = !snapshot || snapshot.busy || Boolean(snapshot.plan || pending) || !message.value.trim();
    for (const id of ['stop-chat', 'open-chat-terminal', 'chat-add-profile']) {
      byId(id).disabled = !snapshot || Boolean(pending);
    }
    byId('approve-plan').disabled = Boolean(pending || snapshot?.busy) || repoMissing();
    byId('discard-plan').disabled = Boolean(pending || snapshot?.busy);
  }

  function send(action, args = {}) {
    if (!snapshot || pending) return;
    pending = { action, text: args.text };
    error.textContent = '';
    updateControls();
    vscode.postMessage({ type: 'squadChat', action, ...args });
  }

  function settle(data) {
    if (!pending) return;
    if (!data.error && data.data?.files && data.data.id) {
      diffs.set(data.data.id, data.data.files);
      runsKey = undefined;
    }
    if (data.error) error.textContent = data.error;
    else if (pending.action === 'send' && pending.text === message.value) message.value = '';
    pending = undefined;
    updateControls();
    if (snapshot && runsKey === undefined) renderRuns(snapshot.runs ?? []);
  }

  const form = byId('chat-composer');
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!byId('send-chat').disabled) send('send', { text: message.value });
  });
  message.addEventListener('input', updateControls);
  message.addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  byId('approve-plan').addEventListener('click', () => send('approve', {
    id: snapshot.plan.id, approver: byId('plan-approver').value, repo: byId('plan-repo-field').hidden ? undefined : repoSelect.value
  }));
  repoSelect.addEventListener('change', () => { repoSelect.dataset.touched = '1'; byId('plan-repo-hint').textContent = ''; updateControls(); });
  byId('plan-approver').addEventListener('change', () => { byId('plan-approver').dataset.touched = '1'; render(lastState); });
  byId('discard-plan').addEventListener('click', () => send('discard', { id: snapshot.plan.id }));
  byId('stop-chat').addEventListener('click', () => send('stop'));
  byId('chat-add-profile').addEventListener('click', () => send('addProfile'));
  byId('open-chat-terminal').addEventListener('click', () => send('terminal', { role: terminalRole.value }));
  return { render, settle, loadError: text => { byId('chat-status').textContent = text; } };
}
