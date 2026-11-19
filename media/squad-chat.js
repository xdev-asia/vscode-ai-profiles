function mountSquadChat(vscode, roles) {
  const byId = id => document.getElementById(id);
  const chatPanel = byId('chat-panel');
  const rolesPanel = byId('roles-panel');
  const showChat = byId('show-chat');
  const showRoles = byId('show-roles');
  const log = byId('chat-messages');
  const message = byId('chat-message');
  const error = byId('chat-error');
  const terminalRole = byId('chat-terminal-role');
  let snapshot;
  let pending;
  let transcript;

  function show(view) {
    chatPanel.hidden = view !== 'chat';
    rolesPanel.hidden = view === 'chat';
    showChat.setAttribute('aria-pressed', String(view === 'chat'));
    showRoles.setAttribute('aria-pressed', String(view !== 'chat'));
    vscode.setState({ ...vscode.getState(), view });
  }

  show(vscode.getState()?.view === 'roles' ? 'roles' : 'chat');
  showChat.addEventListener('click', () => show('chat'));
  showRoles.addEventListener('click', () => show('roles'));

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
      const brief = document.createElement('p');
      brief.textContent = job.brief;
      row.append(label, brief);
      return row;
    }));
    const profileFor = role => state.accounts.find(profile => profile.id === state.seats[role]?.account);
    const lead = profileFor('Lead');
    byId('chat-status').textContent = status || (plan ? 'Review the roles and briefs before running.' :
      lead?.kind === 'api' ? `Lead uses ${lead.name} · ${lead.detail}` : 'Assign an API profile to Lead under Roles to start planning.');
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
