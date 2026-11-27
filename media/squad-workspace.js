function mountSquadWorkspace(vscode) {
  const byId = id => document.getElementById(id);
  const steps = [...byId('workflow-stages').children];
  const output = byId('workflow-output');
  const skills = byId('skills');
  const skillForm = byId('skill-form');
  const tools = [...byId('squad-tools').querySelectorAll('input')];
  let state;
  let pending;
  let stageKey;
  let savedDraft;
  let skillId;
  let memoryId;

  function renderWorkflow() {
    const { workflow, busy, plan, status, workflowIssue } = state.teamChat;
    const step = workflow?.approved.length ?? 0;
    const stage = steps[step]?.dataset;
    const key = workflow ? `${workflow.id}:${step}` : '';
    if (key !== stageKey || (workflow?.draft !== savedDraft && output.value === (savedDraft ?? ''))) {
      output.value = workflow?.draft ?? '';
    }
    savedDraft = workflow?.draft;
    steps.forEach((element, index) => {
      element.classList.toggle('approved', index < step);
      element.setAttribute('aria-label', index < step ? `${element.dataset.stage} (approved)` : element.dataset.stage);
      if (workflow && index === step) element.setAttribute('aria-current', 'step');
      else element.removeAttribute('aria-current');
    });
    byId('workflow-start').hidden = Boolean(workflow);
    byId('workflow-start').querySelector('button').disabled = busy || Boolean(pending);
    byId('workflow-current').hidden = !workflow;
    byId('workflow-results').hidden = step === 0;
    if (stageKey !== key) {
      stageKey = key;
      byId('workflow-artifacts').replaceChildren(...(workflow?.approved ?? []).map((result, index) => {
        const item = document.createElement('details');
        const title = document.createElement('summary');
        const text = document.createElement('p');
        title.textContent = steps[index].dataset.stage;
        text.textContent = result;
        text.className = 'preserve-lines';
        item.append(title, text);
        return item;
      }));
    }
    byId('workflow-title').textContent = stage ? `${stage.stage} · ${stage.role}` : 'Workflow complete';
    byId('workflow-instruction').textContent = stage?.instruction ?? '';
    byId('workflow-project').textContent = workflow?.brief ?? '';
    byId('workflow-actions').hidden = !stage;
    byId('workflow-approve').hidden = !stage;
    byId('workflow-reset').disabled = busy || Boolean(pending);
    byId('workflow-copy').disabled = Boolean(pending);
    byId('workflow-stop').hidden = !busy;
    byId('workflow-stop').disabled = Boolean(pending);
    const profile = state.accounts.find(candidate => candidate.id === state.seats[stage?.role]?.account);
    byId('workflow-draft').disabled = busy || Boolean(plan || pending) || profile?.kind !== 'api';
    byId('workflow-draft').textContent = workflow?.draft ? 'Draft again with AI' : 'Draft with AI';
    output.readOnly = busy || Boolean(pending);
    byId('workflow-status').textContent = status || (stage ? workflowIssue || (plan
      ? 'Approve or discard the pending plan in Chat before drafting.'
      : profile?.kind === 'api' ? `Drafts use ${profile.name} · ${profile.detail}`
        : `Assign an API profile to ${stage.role} under Roles, or copy the brief to a terminal.`) : '');
    updateApprove();
  }

  function updateApprove() {
    byId('workflow-approve-button').disabled = !state?.teamChat.workflow || output.readOnly || !output.value.trim();
  }

  function renderCustomizations() {
    const { skills: savedSkills, disabledTools } = state.customizations;
    const nativeTools = state.nativeChatTools;
    skills.replaceChildren(...savedSkills.map(skill => {
      const row = document.createElement('li');
      const label = document.createElement('span');
      label.textContent = `${skill.name} · ${skill.enabled ? 'Enabled' : 'Disabled'}`;
      if (skill.description) label.title = skill.description;
      const actions = document.createElement('div');
      actions.className = 'actions';
      for (const [text, handler] of [
        ['Edit', () => editSkill(skill)],
        ['Delete', () => send('removeSkill', { id: skill.id })]
      ]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = text;
        button.setAttribute('aria-label', `${text} ${skill.name}`);
        button.disabled = Boolean(pending);
        button.addEventListener('click', handler);
        actions.append(button);
      }
      row.append(label, actions);
      return row;
    }));
    byId('add-skill').disabled = Boolean(pending);
    for (const control of skillForm.elements) control.disabled = Boolean(pending);
    byId('tool-hint').textContent = nativeTools.length
      ? 'Set which xDev tools Copilot can call. The SDLC switch also controls the MCP workflow tools.'
      : 'The SDLC switch controls MCP workflow access. Copilot tools require a supported chat session.';
    byId('native-customizations').hidden = !nativeTools.length;
    byId('native-tools').disabled = byId('native-skills').disabled = Boolean(pending);
    byId('manage-mcp').disabled = Boolean(pending);
    const sync = state.sync ?? {};
    const claudeAccounts = state.accounts.filter(profile => profile.detail === 'Claude Code').length;
    byId('sync-profiles').textContent = sync.profiles
      ? `Enabled skills are copied to ${claudeAccounts} Claude Code account${claudeAccounts === 1 ? '' : 's'} as xdev-* skills when you save them and before each run.`
      : 'Copying skills to Claude Code accounts is off (xdevAi.squad.syncSkillsToProfiles).';
    byId('sync-folder').textContent = sync.folder
      ? `Sync folder: ${sync.folder}. Skills go to skills/<name>/SKILL.md and memory to memory/squad-memory.json. In a git folder xDev pulls, commits, and asks before pushing.`
      : 'Choose a sync folder, such as a clone of your team docs repository, to share skills and memory across machines and teammates.';
    const last = state.customizations.lastSync;
    byId('sync-last').textContent = last ? `Last sync ${new Date(last.time).toLocaleString()}: ${last.summary}` : '';
    byId('sync-now').textContent = sync.folder ? 'Sync with folder' : 'Choose sync folder…';
    for (const id of ['sync-now', 'sync-accounts', 'squad-settings']) byId(id).disabled = Boolean(pending);
    for (const tool of tools) {
      const available = tool.id === 'xdev_sdlc' || nativeTools.includes(tool.id);
      tool.disabled = !available || Boolean(pending);
      tool.checked = available && !disabledTools.includes(tool.id);
    }
  }

  const mcpHints = {
    accountControl: {
      off: 'Clients get no account tools.',
      read: 'Clients list accounts, sign-in state, and quota, and ask which account has the most quota left.',
      manage: 'Clients also rename, tag, disable, and open accounts and set the Squad pool. Sign-in, bypass sessions, and deletion ask you first.'
    },
    squadControl: {
      off: 'Clients get no Squad tools.',
      read: 'Clients see the plan, runs, results, and diffs.',
      run: 'Clients act as the lead: they hand tasks to your Claude Code accounts and run worker steps. Merging, pushing, and deploying stay in VS Code.'
    },
    confirmIn: {
      vscode: 'A dialog in VS Code asks you. A client cannot answer it, so choose this when you sit here.',
      client: 'The AI client asks you, and a notification in VS Code also works. Keep permission prompts on in that client.'
    }
  };

  function renderMcp() {
    const mcp = state.mcp;
    const busy = Boolean(pending);
    const usable = Boolean(mcp?.ready);
    byId('mcp-status').textContent = !mcp ? '' : mcp.running ? 'Running' : 'Stopped';
    byId('mcp-status').classList.toggle('on', Boolean(mcp?.running));
    byId('mcp-summary').textContent = !mcp ? 'xDev AI MCP is not available in this window.'
      : !mcp.ready ? 'Open a trusted workspace folder to use xDev AI MCP.'
        : mcp.running ? `Running at ${mcp.url}. ${mcp.tools.length} tools are available to connected clients.`
          : 'Stopped. AI clients cannot reach xDev AI.';
    byId('mcp-folder').textContent = !usable ? ''
      : mcp.folderSetUp ? `.mcp.json in ${mcp.folder} has the xDev AI server. Claude Code sessions that xDev AI opens in this folder connect by themselves; the file holds no token.`
        : `Not set up for ${mcp.folder} yet. Set up asks what clients may do, keeps a fixed port, starts the server, and adds it to .mcp.json without the token.`;
    byId('mcp-setup').textContent = mcp?.folderSetUp ? 'Set up again' : 'Set up for this folder';
    byId('mcp-toggle').textContent = mcp?.running ? 'Stop' : 'Start';
    byId('mcp-setup').disabled = byId('mcp-toggle').disabled = byId('mcp-restart').disabled = busy || !usable;
    byId('mcp-restart').hidden = !mcp?.running;
    byId('mcp-copy').disabled = busy || !mcp?.running;
    for (const key of Object.keys(mcpHints)) {
      const select = byId(`mcp-${key}`);
      if (mcp && document.activeElement !== select) select.value = mcp[key];
      select.disabled = busy || !mcp;
      byId(`mcp-${key}-hint`).textContent = mcpHints[key][select.value] ?? '';
    }
    byId('mcp-autoStart').checked = Boolean(mcp?.autoStart);
    byId('mcp-autoStart').disabled = busy || !mcp;
    const actual = mcp?.url ? new URL(mcp.url).port : '';
    const portInput = byId('mcp-port-input');
    if (mcp && document.activeElement !== portInput) portInput.value = String(mcp.port);
    portInput.disabled = byId('mcp-port-save').disabled = busy || !mcp;
    byId('mcp-port').textContent = !mcp ? '' : mcp.portBusy
      ? `Port ${mcp.port} is used by another window, so this window uses ${actual} until it restarts. AI terminals opened here connect to this window. Configuration copied with port ${mcp.port} reaches the other window.`
      : mcp.port ? `Port ${mcp.port} is kept across restarts, so client configuration keeps working.`
      : '0 takes a free port on every start, so copied configuration stops working after a restart. Enter a port such as 7788 to keep it.';
    for (const id of ['mcp-rotate', 'mcp-audit']) byId(id).disabled = busy || !mcp;
    const tools = mcp?.tools ?? [];
    byId('mcp-tools-title').textContent = `Tools (${tools.length})`;
    byId('mcp-tools').replaceChildren(...tools.map(tool => {
      const row = document.createElement('li');
      const name = document.createElement('code');
      const summary = document.createElement('span');
      const kind = document.createElement('small');
      name.textContent = tool.name;
      summary.textContent = tool.summary;
      kind.textContent = tool.kind === 'read' ? 'read' : 'change';
      kind.className = tool.kind;
      row.append(name, kind, summary);
      return row;
    }));
  }

  function editSkill(skill) {
    skillId = skill?.id;
    byId('skill-name').value = skill?.name ?? '';
    byId('skill-description').value = skill?.description ?? '';
    byId('skill-instructions').value = skill?.instructions ?? '';
    byId('skill-enabled').checked = skill?.enabled ?? true;
    skillForm.hidden = false;
    byId('skill-name').focus();
  }

  function renderArtifacts() {
    const artifacts = state.artifacts ?? [];
    const list = byId('artifact-list');
    const key = JSON.stringify(artifacts) + String(Boolean(pending));
    byId('artifact-add').disabled = Boolean(pending);
    if (key === list.dataset.key) return;
    list.dataset.key = key;
    if (!artifacts.length) {
      const empty = document.createElement('li');
      empty.textContent = 'No artifacts yet. Ask a worker for a design or a report, save one from an AI client with xdev_artifact_save, or add a file.';
      list.replaceChildren(empty);
      return;
    }
    list.replaceChildren(...artifacts.map(artifact => {
      const row = document.createElement('li');
      const text = document.createElement('div');
      const title = document.createElement('strong');
      const meta = document.createElement('small');
      const actions = document.createElement('div');
      title.textContent = artifact.name;
      meta.textContent = [artifact.kind, `by ${artifact.author}`, new Date(artifact.updated).toLocaleString(), artifact.version > 1 ? `saved ${artifact.version} times` : '']
        .filter(Boolean).join(' · ');
      text.className = 'artifact-text';
      text.append(title, meta);
      if (artifact.description) {
        const description = document.createElement('span');
        description.textContent = artifact.description;
        text.append(description);
      }
      actions.className = 'actions';
      for (const [label, action, shown] of [['Open', 'openArtifact', true], ['claude.ai page', 'openArtifactLink', Boolean(artifact.link)], ['Remove', 'removeArtifact', true]]) {
        if (!shown) continue;
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.setAttribute('aria-label', `${label} ${artifact.name}`);
        button.disabled = Boolean(pending);
        button.addEventListener('click', () => send(action, { id: artifact.id }, 'memory'));
        actions.append(button);
      }
      row.append(text, actions);
      return row;
    }));
  }

  function renderMemory() {
    const notes = state.memory ?? [];
    const list = byId('memory-list');
    const key = JSON.stringify(notes) + String(Boolean(pending));
    if (key === list.dataset.key) return;
    list.dataset.key = key;
    if (!notes.length) {
      const empty = document.createElement('li');
      empty.className = 'subtle';
      empty.textContent = 'No notes yet. Workers add notes after runs, or add one above.';
      list.replaceChildren(empty);
      return;
    }
    list.replaceChildren(...notes.map(note => {
      const row = document.createElement('li');
      const text = document.createElement('span');
      text.textContent = `${note.pinned ? '📌 ' : ''}${note.text}`;
      text.title = `${note.source} · ${new Date(note.time).toLocaleString()}`;
      const source = document.createElement('small');
      source.textContent = note.source;
      const actions = document.createElement('div');
      actions.className = 'actions';
      for (const [label, handler] of [
        [note.pinned ? 'Unpin' : 'Pin', () => send('pinMemory', { id: note.id, pinned: !note.pinned }, 'memory')],
        ['Edit', () => {
          memoryId = note.id;
          byId('memory-text').value = note.text;
          byId('memory-submit').textContent = 'Save';
          byId('memory-text').focus();
        }],
        ['Delete', () => send('removeMemory', { id: note.id }, 'memory')]
      ]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.disabled = Boolean(pending);
        button.setAttribute('aria-label', `${label} memory note`);
        button.addEventListener('click', handler);
        actions.append(button);
      }
      row.append(text, source, actions);
      return row;
    }));
  }

  function bytes(value) {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = value ?? 0;
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++; }
    return `${size >= 10 || unit === 0 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`;
  }

  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function renderProject() {
    const project = state.project;
    if (!project) return;
    const key = JSON.stringify(project) + String(Boolean(pending));
    const panel = byId('project-panel');
    if (key === panel.dataset.key) return;
    panel.dataset.key = key;
    const { settings, scopes } = project;
    byId('project-name').textContent = project.name || 'Project';
    const commands = Object.entries(settings.repositoryCommands ?? {});
    const repos = project.repositories;
    // A large workspace can hold dozens of repositories; show a few and keep the full list in the tooltip.
    const repoText = !repos.length ? 'none found'
      : repos.length <= 6 ? repos.join(', ') : `${repos.length}: ${repos.slice(0, 4).join(', ')}, and ${repos.length - 4} more`;
    const rows = [
      ['Repositories', repoText, ''],
      ['Worktrees start from', settings.baseBranch || 'the branch your checkout is on', 'baseBranch'],
      ...Object.entries(settings.repositoryBases ?? {}).map(([repo, branch]) => [`  ${repo}`, branch, 'repositoryBaseBranches']),
      ['Merge requests', `${settings.mergeRequests} → ${settings.mergeRequestTarget || 'remote default branch'}`, settings.mergeRequestTarget ? 'mergeRequestTarget' : 'mergeRequests'],
      ['Worker budget', `$${settings.budgetUsd} per step · ${settings.timeoutMinutes} min`, 'workerBudgetUsd'],
      ['Allowed commands', settings.allowedCommands.length ? settings.allowedCommands.join(', ') : 'read-only git only', 'workerAllowedCommands'],
      ...commands.map(([repo, list]) => [`  ${repo}`, list.join(', ') || '—', 'repositoryAllowedCommands']),
      ['Linked into worktrees', settings.worktreeLinks.join(', ') || 'nothing', 'worktreeLinks'],
      ['CodeGraph', settings.codegraph ? 'on' : 'off', 'codegraph'],
      ['Clean up merged or pushed runs', settings.cleanupAfterDays ? `after ${settings.cleanupAfterDays} days` : 'off', 'cleanupAfterDays'],
      ['Minimum free disk', settings.minFreeDiskGb ? `${settings.minFreeDiskGb} GB` : 'not checked', 'minFreeDiskGb'],
      ...(project.envFiles ?? []).map(file => [`Env · ${file.repo}`, file.problem
        ? `${file.file}: ${file.problem}`
        : `${file.file}: ${file.names.length} variable${file.names.length === 1 ? '' : 's'}${file.skipped.length ? `, ${file.skipped.length} skipped` : ''}`, 'workerEnvFiles', file]),
      ...Object.entries(project.deploy ?? {}).map(([repo, target]) => [`Deploy · ${repo}`,
        `${target.to ? `${target.from} → ${target.to}` : `on ${target.from}`}${target.health ? ` · health ${target.health}` : ''}`, 'deployTargets'])
    ];
    byId('project-settings').replaceChildren(...rows.flatMap(([label, value, setting, file]) => {
      const term = element('dt', label);
      const detail = element('dd', value);
      if (file?.problem) detail.classList.add('problem');
      // Names only: values stay on the extension host.
      if (file && !file.problem) detail.title = [...file.names, ...file.skipped.map(name => `${name} (skipped: would change the worker)`)].join('\n');
      if (label === 'Repositories' && repos.length > 6) detail.title = repos.join('\n');
      const scope = setting && scopes[setting];
      if (scope && scope !== 'default') detail.append(' ', element('small', scope, `scope ${scope}`));
      return [term, detail];
    }));

    const list = byId('project-mcp');
    if (!project.trusted) list.replaceChildren(element('li', 'Trust this workspace to give workers MCP servers.', 'subtle'));
    else if (!project.mcp.length) {
      list.replaceChildren(element('li', project.mcpAvailable.length
        ? `None yet. Servers in .mcp.json you can add: ${project.mcpAvailable.join(', ')}.`
        : 'None yet. Add a server from .mcp.json or define one in the project settings.', 'subtle'));
    } else {
      list.replaceChildren(...project.mcp.map(server => {
        const row = element('li');
        const title = element('span');
        title.append(element('strong', server.name), ` ${server.server ? `· ${server.server}` : ''}`);
        const detail = element('small', server.problem
          ? server.problem
          : `${server.tools.includes('*') ? 'all tools' : server.tools.join(', ')} · ${server.roles.join(', ')} · from ${server.source}`, server.problem ? 'problem' : '');
        const remove = element('button', 'Remove');
        remove.type = 'button';
        remove.disabled = Boolean(pending);
        remove.setAttribute('aria-label', `Remove MCP server ${server.name}`);
        remove.addEventListener('click', () => send('removeMcp', { name: server.name }, 'mcp', 'project'));
        const actions = element('div', undefined, 'actions');
        actions.append(remove);
        row.append(title, detail, actions);
        return row;
      }));
    }
    byId('project-mcp-file').hidden = !project.mcpFile;
    byId('project-add-mcp').disabled = Boolean(pending) || !project.trusted;

    const { disk, storage, runs, memory } = project;
    const low = disk.free !== undefined && disk.minimum && disk.free < disk.minimum;
    byId('project-disk').textContent = `${disk.free === undefined ? 'Free disk unknown' : `${bytes(disk.free)} free`}${low ? ` — below the ${bytes(disk.minimum)} Squad needs; new runs and steps are refused` : ''} · ${runs.count}/${runs.limit} runs · ${memory.notes}/${memory.limit} memory notes`;
    byId('project-disk').classList.toggle('problem', Boolean(low));
    const items = [];
    if (project.storageBusy) items.push(element('li', 'Measuring…', 'subtle'));
    else if (!storage) items.push(element('li', 'Check storage to see what Squad keeps on disk for this project.', 'subtle'));
    else {
      const total = storage.runs.reduce((sum, run) => sum + run.bytes, 0) + storage.leftovers.reduce((sum, item) => sum + item.bytes, 0)
        + storage.transcripts.bytes + storage.transcripts.keptBytes + storage.stateBytes;
      items.push(element('li', `Total ${bytes(total)}${storage.partial ? ' or more (measuring stopped after a minute)' : ''} · checked ${new Date(storage.time).toLocaleTimeString()}`));
      for (const run of storage.runs) {
        const row = element('li');
        row.append(element('span', run.title), element('small', `${bytes(run.bytes)}${run.disposable ? ' · merged or pushed, can be cleaned up' : ''}`));
        items.push(row);
      }
      if (storage.leftovers.length) items.push(element('li', `Unused worktree folders: ${storage.leftovers.length} · ${bytes(storage.leftovers.reduce((sum, item) => sum + item.bytes, 0))}`, 'problem'));
      items.push(element('li', `Worker transcripts: ${bytes(storage.transcripts.keptBytes)} for current runs${storage.transcripts.paths.length ? `, ${bytes(storage.transcripts.bytes)} from removed runs` : ''}`));
      items.push(element('li', `Squad state: ${bytes(storage.stateBytes)}`));
    }
    byId('project-storage').replaceChildren(...items);
    byId('project-check').disabled = Boolean(pending) || project.storageBusy;
    byId('project-clean').disabled = Boolean(pending) || project.storageBusy;
    byId('project-edit').disabled = Boolean(pending);
  }

  function render(data) {
    if (!state && !pending) byId('workflow-notice').textContent = '';
    state = data;
    renderWorkflow();
    renderCustomizations();
    renderMemory();
    renderArtifacts();
    renderProject();
    renderMcp();
  }

  function send(action, args, notice = 'customizations', type = 'workspace') {
    if (!state || pending) return;
    pending = { action, notice };
    byId(`${notice}-notice`).textContent = '';
    vscode.postMessage({ type, action, ...args });
    render(state);
  }

  function stepAction(action, args = {}) {
    const workflow = state?.teamChat.workflow;
    send(action, { id: workflow?.id, step: workflow?.approved.length, ...args }, 'workflow');
  }

  function settle({ error }) {
    if (!pending) return;
    const { action, notice } = pending;
    pending = undefined;
    byId(`${notice}-notice`).textContent = error ?? (action === 'copy' && notice === 'workflow' ? 'Stage brief copied.' : '');
    if (!error && action === 'saveSkill') skillForm.hidden = true;
    if (!error && (action === 'addMemory' || action === 'editMemory')) {
      byId('memory-text').value = '';
      byId('memory-submit').textContent = 'Add';
      memoryId = undefined;
    }
    if (!error && action === 'start') byId('workflow-brief').value = '';
    render(state);
  }

  byId('workflow-start').addEventListener('submit', event => {
    event.preventDefault();
    stepAction('start', { brief: byId('workflow-brief').value });
  });
  for (const action of ['draft', 'copy', 'reset', 'stop']) {
    byId(`workflow-${action}`).addEventListener('click', () => stepAction(action));
  }
  output.addEventListener('input', updateApprove);
  byId('workflow-approve').addEventListener('submit', event => {
    event.preventDefault();
    stepAction('approve', { output: output.value });
  });
  byId('add-skill').addEventListener('click', () => editSkill());
  byId('cancel-skill').addEventListener('click', () => { skillForm.hidden = true; });
  skillForm.addEventListener('submit', event => {
    event.preventDefault();
    send('saveSkill', { id: skillId, name: byId('skill-name').value, description: byId('skill-description').value,
      instructions: byId('skill-instructions').value, enabled: byId('skill-enabled').checked });
  });
  byId('sync-now').addEventListener('click', () => send('syncFolder'));
  byId('sync-accounts').addEventListener('click', () => send('syncProfiles'));
  byId('squad-settings').addEventListener('click', () => vscode.postMessage({ type: 'squadChat', action: 'settings' }));
  byId('memory-form').addEventListener('submit', event => {
    event.preventDefault();
    const text = byId('memory-text').value;
    if (memoryId) send('editMemory', { id: memoryId, text }, 'memory');
    else send('addMemory', { text }, 'memory');
  });
  for (const tool of tools) {
    tool.addEventListener('change', () => send('setTool', { id: tool.id, enabled: tool.checked }));
  }
  byId('artifact-add').addEventListener('click', () => send('addArtifact', {}, 'memory'));
  byId('native-tools').addEventListener('click', () => send('nativeTools'));
  byId('manage-mcp').addEventListener('click', () => byId('show-mcp').click());
  const sendMcp = (action, args = {}) => send(action, args, 'mcp', 'mcp');
  byId('mcp-setup').addEventListener('click', () => sendMcp('setup'));
  byId('mcp-toggle').addEventListener('click', () => sendMcp(state?.mcp?.running ? 'stop' : 'start'));
  byId('mcp-copy').addEventListener('click', () => sendMcp('copy'));
  byId('mcp-rotate').addEventListener('click', () => sendMcp('rotate'));
  byId('mcp-audit').addEventListener('click', () => sendMcp('audit'));
  byId('mcp-restart').addEventListener('click', () => sendMcp('restart'));
  byId('mcp-port-form').addEventListener('submit', event => {
    event.preventDefault();
    sendMcp('set', { key: 'port', value: Number(byId('mcp-port-input').value) });
  });
  byId('project-open-mcp').addEventListener('click', () => byId('show-mcp').click());
  for (const key of Object.keys(mcpHints)) {
    byId(`mcp-${key}`).addEventListener('change', event => sendMcp('set', { key, value: event.target.value }));
  }
  byId('mcp-autoStart').addEventListener('change', event => sendMcp('set', { key: 'autoStart', value: event.target.checked }));
  byId('native-skills').addEventListener('click', () => send('nativeSkills'));
  for (const [id, action] of [['project-edit', 'editSettings'], ['project-check', 'checkStorage'], ['project-clean', 'cleanStorage']]) {
    byId(id).addEventListener('click', () => send(action, {}, 'project', 'project'));
  }
  for (const [id, action] of [['project-add-mcp', 'addMcp'], ['project-mcp-file', 'openMcpFile']]) {
    byId(id).addEventListener('click', () => send(action, {}, 'mcp', 'project'));
  }
  return { render, settle, loadError(error) {
    byId('workflow-notice').textContent = error;
    byId('customizations-notice').textContent = error;
    byId('memory-notice').textContent = error;
    byId('project-notice').textContent = error;
    byId('mcp-notice').textContent = error;
  } };
}
