const vscode = acquireVsCodeApi();
const select = document.getElementById('account');
const add = document.getElementById('add');
const manage = document.getElementById('manage');
const claude = document.getElementById('claude');
const clear = document.getElementById('clear');
const messages = document.getElementById('messages');
const composer = document.getElementById('composer');
const prompt = document.getElementById('prompt');
const status = document.getElementById('status');
const stop = document.getElementById('stop');
const send = document.getElementById('send');
const drafts = new Map();
let activeId;
let busy = false;
let switching = false;
let lastTranscript;

function updateControls() {
  select.disabled = select.options.length < 2 || switching;
  manage.disabled = !activeId;
  clear.disabled = !activeId || switching;
  prompt.disabled = !activeId || switching;
  send.disabled = prompt.disabled || busy || !prompt.value.trim();
  stop.hidden = !busy || switching;
}

function messageElement({ role, content }) {
  const item = document.createElement('article');
  const author = document.createElement('h2');
  author.textContent = role === 'user' ? 'Bạn' : 'AI';
  const text = document.createElement('p');
  text.textContent = content;
  item.append(author, text);
  return item;
}

function render(state) {
  if (activeId) drafts.set(activeId, prompt.value);
  if (state.activeId !== activeId) prompt.value = drafts.get(state.activeId) ?? '';
  activeId = state.activeId;
  switching = false;
  busy = Boolean(state.pending);

  const options = state.accounts.map(account =>
    new Option(`${account.name} · ${account.providerName} · ${account.model}`, account.id));
  select.replaceChildren(...(options.length ? options : [new Option('Chưa có hồ sơ')]));
  if (activeId) select.value = activeId;
  for (const id of drafts.keys()) {
    if (!state.accounts.some(account => account.id === id)) drafts.delete(id);
  }

  const transcript = JSON.stringify([activeId, state.messages, state.pending]);
  if (lastTranscript !== transcript) {
    const items = state.messages.map(messageElement);
    if (state.pending) items.push(messageElement({ role: 'user', content: state.pending }));
    if (!items.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = activeId ? 'Nhập câu hỏi để bắt đầu.' : 'Thêm hồ sơ AI để bắt đầu trò chuyện.';
      items.push(empty);
    }
    messages.replaceChildren(...items);
    messages.scrollTop = messages.scrollHeight;
    lastTranscript = transcript;
  }
  status.textContent = state.error ?? (busy ? 'Đang chờ phản hồi…' : '');
  status.classList.toggle('error', Boolean(state.error));
  updateControls();
}

window.addEventListener('message', ({ data }) => {
  if (data.type === 'state') render(data);
  if (data.type === 'error') {
    busy = false;
    switching = false;
    status.textContent = data.message;
    status.classList.add('error');
    updateControls();
  }
  if (data.type === 'sent') {
    if (data.id === activeId && prompt.value.trim() === data.prompt) {
      prompt.value = '';
      updateControls();
    }
    if (drafts.get(data.id)?.trim() === data.prompt) drafts.delete(data.id);
  }
});

add.addEventListener('click', () => vscode.postMessage({ type: 'add' }));
manage.addEventListener('click', () => vscode.postMessage({ type: 'manage' }));
claude.addEventListener('click', () => vscode.postMessage({ type: 'claude' }));
clear.addEventListener('click', () => {
  prompt.value = '';
  vscode.postMessage({ type: 'clear', id: activeId });
  updateControls();
});
stop.addEventListener('click', () => vscode.postMessage({ type: 'stop', id: activeId }));
select.addEventListener('change', () => {
  switching = true;
  vscode.postMessage({ type: 'select', id: select.value });
  updateControls();
});
prompt.addEventListener('input', updateControls);
prompt.addEventListener('keydown', event => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) {
    event.preventDefault();
    composer.requestSubmit();
  }
});
composer.addEventListener('submit', event => {
  event.preventDefault();
  if (send.disabled) return;
  busy = true;
  status.textContent = 'Đang gửi…';
  status.classList.remove('error');
  vscode.postMessage({ type: 'send', id: activeId, text: prompt.value });
  updateControls();
});

vscode.postMessage({ type: 'ready' });
