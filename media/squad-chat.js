function mountSquadChat(vscode, roles) {
  const byId = id => document.getElementById(id);
  const log = byId('chat-messages');
  const message = byId('chat-message');
  const error = byId('chat-error');
  const terminalRole = byId('chat-terminal-role');
  let snapshot;
  let pending;
  let transcript;

  function render(state) {
    snapshot = state.teamChat;
    const entries = JSON.stringify(snapshot.entries);
    if (entries !== transcript) {
      const follow = !transcript || log.scrollHeight - log.scrollTop - log.clientHeight < 50;
      const items = snapshot.entries.map(entry => {
        const item = document.createElement('article');
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
    byId('plan-cost').textContent = headless
      ? `${headless} Claude Code worker${headless > 1 ? 's' : ''} will run in a new git worktree${workers?.budgetUsd ? `, each capped at $${workers.budgetUsd}` : ''}. Allowed commands: ${commands}.`
      : '';
    renderRuns(snapshot.runs ?? []);
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

  let runsKey;
  function renderRuns(runs) {
    byId('chat-runs').hidden = !runs.length;
    const busy = Boolean(pending) || snapshot.busy;
    const key = JSON.stringify(runs) + String(busy);
    if (key === runsKey) return;
    runsKey = key;
    byId('run-list').replaceChildren(...runs.map(run => {
      const item = document.createElement('li');
      item.className = `run ${run.status}`;
      const title = document.createElement('strong');
      title.textContent = run.prompt.split('\n', 1)[0];
      const meta = document.createElement('small');
      const cost = run.costUsd ? ` · $${run.costUsd.toFixed(2)}` : '';
      const files = run.status === 'running' ? 'working' : `${run.files ?? 0} file${run.files === 1 ? '' : 's'}`;
      meta.textContent = `${run.branch} · ${run.status} · ${files}${cost}`;
      item.append(title, meta);
      if (run.stat) {
        const stat = document.createElement('details');
        const summary = document.createElement('summary');
        summary.textContent = 'Changed files';
        const pre = document.createElement('pre');
        pre.textContent = run.stat;
        stat.append(summary, pre);
        item.append(stat);
      }
      const actions = document.createElement('div');
      actions.className = 'actions';
      const running = run.status === 'running';
      const button = (text, action, args, disabled) => {
        const element = document.createElement('button');
        element.type = 'button';
        element.textContent = text;
        element.disabled = disabled;
        element.addEventListener('click', () => send(action, { id: run.id, ...args }));
        actions.append(element);
      };
      button('View diff', 'runDiff', {}, running || !run.commit);
      button('Merge', 'runMerge', {}, running || busy || !run.commit);
      button('Open folder', 'runOpen', {}, running);
      for (const session of run.sessions) {
        button(`Continue ${session.role} in terminal`, 'runResume', { session: session.sessionId }, running);
      }
      button('Remove', 'runRemove', {}, running || busy);
      item.append(actions);
      return item;
    }));
  }

  function updateControls() {
    message.disabled = !snapshot;
    byId('send-chat').disabled = !snapshot || snapshot.busy || Boolean(snapshot.plan || pending) || !message.value.trim();
    for (const id of ['stop-chat', 'open-chat-terminal', 'chat-add-profile']) {
      byId(id).disabled = !snapshot || Boolean(pending);
    }
    byId('approve-plan').disabled = Boolean(pending || snapshot?.busy);
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
    if (data.error) error.textContent = data.error;
    else if (pending.action === 'send' && pending.text === message.value) message.value = '';
    pending = undefined;
    updateControls();
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
  byId('approve-plan').addEventListener('click', () => send('approve', { id: snapshot.plan.id }));
  byId('discard-plan').addEventListener('click', () => send('discard', { id: snapshot.plan.id }));
  byId('stop-chat').addEventListener('click', () => send('stop'));
  byId('chat-add-profile').addEventListener('click', () => send('addProfile'));
  byId('open-chat-terminal').addEventListener('click', () => send('terminal', { role: terminalRole.value }));
  return { render, settle, loadError: text => { byId('chat-status').textContent = text; } };
}
