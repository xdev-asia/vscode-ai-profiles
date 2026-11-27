const vscode = acquireVsCodeApi();
const byId = id => document.getElementById(id);
const roles = byId('roles').dataset.roles.split(',');
const chatUi = mountSquadChat(vscode, roles);
const workspaceUi = mountSquadWorkspace(vscode);
const tabs = ['chat', 'roles', 'workflow', 'customizations', 'memory', 'project', 'mcp'];
const summary = byId('summary');
const fields = byId('fields');
const account = byId('account');
const status = byId('status');
const brief = byId('brief');
const blocker = byId('blocker');
const notice = byId('notice');
const handoff = byId('handoff');
const recipient = byId('recipient');
const note = byId('note');
const reply = byId('reply');
const response = byId('response');
const drafts = new Map();
const buttons = new Map();
const clock = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const previousRole = vscode.getState()?.role;
let role = roles.includes(previousRole) ? previousRole : 'Lead';
let state;
let pending;

function showTab(tab) {
  if (!tabs.includes(tab)) tab = 'chat';
  for (const name of tabs) {
    byId(`${name}-panel`).hidden = name !== tab;
    byId(`show-${name}`).setAttribute('aria-pressed', String(name === tab));
  }
  vscode.setState({ ...vscode.getState(), view: tab });
}

for (const tab of tabs) byId(`show-${tab}`).addEventListener('click', () => showTab(tab));
showTab(vscode.getState()?.view);

for (const item of roles) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'seat-card';
  button.dataset.role = item.toLowerCase();
  const title = document.createElement('strong');
  const profile = document.createElement('span');
  const label = document.createElement('span');
  title.textContent = item;
  profile.className = 'profile';
  label.className = 'seat-state';
  button.append(title, profile, label);
  button.addEventListener('click', () => selectRole(item));
  byId('roles').append(button);
  buttons.set(item, { button, profile, label });
}

function savedTask(item) {
  return state.seats[item] ?? { account: '', brief: '', status: 'Ready', blocker: '' };
}

function findProfile(id) {
  return state.accounts.find(profile => profile.id === id);
}

function selectRole(item) {
  if (item === role || !state || pending) return;
  role = item;
  vscode.setState({ ...vscode.getState(), role });
  reply.open = false;
  handoff.open = false;
  note.value = '';
  recipient.replaceChildren(...roles.filter(other => other !== role).map(other => new Option(other, other)));
  if (role !== 'Lead') recipient.value = 'Lead';
  notice.textContent = '';
  render();
}

function render() {
  let assigned = 0;
  const blockers = [];
  for (const [item, { button, profile, label }] of buttons) {
    const task = savedTask(item);
    const profileData = findProfile(task.account);
    if (profileData) assigned++;
    button.setAttribute('aria-pressed', String(item === role));
    button.disabled = Boolean(pending);
    button.dataset.status = task.status.toLowerCase().replace(' ', '-');
    button.classList.toggle('vacant', !profileData);
    profile.textContent = profileData ? `${profileData.name} · ${profileData.detail}` :
      task.account ? 'Profile unavailable' : 'Vacant';
    label.textContent = state.running.includes(item) ? 'Awaiting API response' : task.brief ? task.status : 'No task';
    if (task.status === 'Blocked') {
      const row = document.createElement('li');
      const link = document.createElement('button');
      link.type = 'button';
      link.textContent = item === 'Lead' ? 'Lead' : `${item} → Lead`;
      link.addEventListener('click', () => selectRole(item));
      row.append(link, document.createTextNode(` ${task.blocker}`));
      blockers.push(row);
    }
  }
  summary.textContent = `${assigned} assigned · ${roles.length - assigned} vacant · ${blockers.length} blocked`;
  byId('blockers').replaceChildren(...blockers);
  byId('escalations').hidden = !blockers.length;

  byId('seat-title').textContent = role;
  const task = savedTask(role);
  const draft = drafts.get(role) ?? task;
  const options = [new Option('Unassigned', '')];
  for (const profile of state.accounts) options.push(new Option(`${profile.name} · ${profile.detail}`, profile.id));
  if (draft.account && !findProfile(draft.account)) options.push(new Option('Profile unavailable', draft.account));
  account.replaceChildren(...options);
  account.value = draft.account;
  status.value = draft.status;
  if (brief.value !== draft.brief) brief.value = draft.brief;
  if (blocker.value !== draft.blocker) blocker.value = draft.blocker;
  if (!recipient.options.length) {
    recipient.replaceChildren(...roles.filter(other => other !== role).map(other => new Option(other, other)));
  }
  reply.hidden = !task.response;
  if (response.textContent !== (task.response ?? '')) {
    response.textContent = task.response ?? '';
    if (task.response) reply.open = true;
  }
  handoff.hidden = false;
  byId('request-error').textContent = state.errors[role] ?? '';
  renderActivity();
  updateControls();
}

function renderActivity() {
  const events = state.activity.map(event => {
    const row = document.createElement('li');
    const route = document.createElement('strong');
    const time = document.createElement('time');
    route.textContent = event.to ? `${event.from} → ${event.to}` : event.from;
    time.dateTime = new Date(event.time).toISOString();
    time.textContent = clock.format(event.time);
    const message = document.createElement('span');
    message.textContent = event.message;
    row.append(route, time, message);
    return row;
  });
  if (!events.length) {
    const empty = document.createElement('li');
    empty.textContent = 'No activity yet.';
    events.push(empty);
  }
  byId('events').replaceChildren(...events);
}

function updateControls() {
  const task = savedTask(role);
  const profile = findProfile(task.account);
  const running = state.running.includes(role);
  const dirty = drafts.has(role);
  fields.disabled = Boolean(pending) || running;
  byId('blocker-field').hidden = status.value !== 'Blocked';
  blocker.required = status.value === 'Blocked';
  byId('save').disabled = !dirty;
  // Offer to reuse the chosen profile for every role when the roles do not all use it yet.
  byId('assign-all').hidden = !account.value || roles.every(item => (drafts.get(item)?.account ?? savedTask(item).account) === account.value);
  byId('copy').hidden = !task.brief || dirty;
  byId('terminal').hidden = profile?.kind !== 'terminal' || dirty;
  byId('usage').hidden = profile?.kind !== 'terminal' || dirty;
  byId('run').hidden = profile?.kind !== 'api' || !task.brief || dirty || running;
  byId('stop').hidden = !running;
  byId('stop').disabled = Boolean(pending);
  byId('send-note').disabled = Boolean(pending);
}

function send(type, input = {}) {
  if (!state || pending) return;
  notice.textContent = '';
  pending = { type, role };
  for (const { button } of buttons.values()) button.disabled = true;
  updateControls();
  vscode.postMessage({ type, role, ...input });
}

window.addEventListener('message', ({ data }) => {
  if (data.type === 'state') {
    state = data;
    render();
    chatUi.render(state);
    workspaceUi.render(state);
  }
  if (data.type === 'loadError') {
    summary.textContent = data.error;
    chatUi.loadError(data.error);
    workspaceUi.loadError(data.error);
  }
  if (data.type === 'selectTab') showTab(data.tab);
  if (data.type === 'workspaceSettled') workspaceUi.settle(data);
  if (data.type === 'chatSettled') chatUi.settle(data);
  if (data.type === 'settled' && pending) {
    const { type, role: target } = pending;
    pending = undefined;
    if (data.error) notice.textContent = data.error;
    else if (type === 'save') {
      drafts.delete(target);
      notice.textContent = 'Task saved.';
    } else if (type === 'handoff') {
      note.value = '';
      handoff.open = false;
      byId('activity').open = true;
      notice.textContent = 'Handoff recorded.';
    } else if (type === 'copy') {
      notice.textContent = 'Brief copied.';
    } else if (type === 'assignAll') {
      for (const [item, draft] of drafts) {
        draft.account = account.value;
        const task = savedTask(item);
        if (Object.keys(draft).every(key => draft[key] === task[key])) drafts.delete(item);
      }
      notice.textContent = 'Every role now uses this profile.';
    }
    render();
  }
});

byId('seat').addEventListener('input', () => {
  const task = savedTask(role);
  const draft = { account: account.value, status: status.value, brief: brief.value, blocker: blocker.value };
  const changed = Object.keys(draft).some(key => draft[key] !== task[key]);
  if (changed) drafts.set(role, draft);
  else drafts.delete(role);
  updateControls();
});
byId('seat').addEventListener('submit', event => {
  event.preventDefault();
  if (drafts.has(role)) send('save', drafts.get(role));
});
byId('handoff-form').addEventListener('submit', event => {
  event.preventDefault();
  if (note.value.trim()) send('handoff', { to: recipient.value, note: note.value });
});
byId('assign-all').addEventListener('click', () => send('assignAll', { account: account.value }));
for (const action of ['copy', 'terminal', 'usage', 'run', 'stop']) {
  byId(action).addEventListener('click', () => send(action));
}
vscode.postMessage({ type: 'ready' });
