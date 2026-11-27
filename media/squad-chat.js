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
  const openBriefs = new Set();
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

    renderSessions(snapshot);
    const { plan, status, busy } = snapshot;
    byId('chat-plan').hidden = !plan;
    if (!plan) openBriefs.clear();
    if ((plan?.id ?? '') !== jobPlan) { jobRepos.clear(); jobPlan = plan?.id ?? ''; }
    const repos = plan?.repos ?? [];
    byId('chat-jobs').replaceChildren(...(plan?.jobs ?? []).map((job, index) => {
      const row = document.createElement('li');
      const label = document.createElement('strong');
      label.textContent = `${job.role} · ${job.profile}${job.model ? ` · ${job.model}` : ''}`;
      const badge = document.createElement('span');
      badge.className = `badge ${job.kind}`;
      badge.textContent = job.kind === 'claude'
        ? (job.role === 'Review' ? 'Claude Code · reads the repo' : 'Claude Code · edits the worktree')
        : 'Text API · no file access';
      const brief = document.createElement('p');
      brief.textContent = job.brief;
      brief.className = openBriefs.has(index) ? 'brief open' : 'brief';
      brief.title = 'Click to show or hide the full brief';
      brief.addEventListener('click', () => {
        if (openBriefs.has(index)) openBriefs.delete(index); else openBriefs.add(index);
        brief.classList.toggle('open');
      });
      row.append(label, badge);
      if (job.kind === 'claude' && repos.length > 1) row.append(repoPicker(job, index, repos));
      row.append(brief);
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
    byId('plan-cost').textContent = `${approverText}${headless
      ? ` Claude Code steps use a new git worktree from ${workers?.baseBranch || 'your current branch'}${workers?.budgetUsd ? `, each headless step capped at $${workers.budgetUsd}` : ''}. Allowed commands: ${commands}.` : ''}`;
    renderRuns(snapshot.runs ?? []);
    renderBoard(state);
    renderLive(snapshot.live, busy);
    const profileFor = role => state.accounts.find(profile => profile.id === state.seats[role]?.account);
    const lead = profileFor('Lead');
    const leadUsable = lead?.kind === 'api' || (lead?.detail === 'Claude Code' && snapshot.workers);
    byId('chat-status').textContent = status || (plan ? 'Review the roles and briefs before running.' :
      leadUsable ? `Lead uses ${lead.name} · ${lead.detail}` : 'Assign an API profile or a Claude Code account to Lead under Roles to start planning.');
    byId('stop-chat').hidden = !busy || snapshot.remote;
    renderAssignAll(state, lead);
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

  // The repository each Claude Code task works in, as the user changed it; otherwise Lead's or the suggested one.
  const jobRepos = new Map();
  let jobPlan = '';
  function jobRepo(job, index) {
    return jobRepos.get(index) ?? job.repo ?? '';
  }
  function repoPicker(job, index, repos) {
    const field = element('label', undefined, 'job-repo');
    field.append(element('span', 'Repository'));
    const select = element('select');
    select.setAttribute('aria-label', `${job.role} repository`);
    const choose = new Option('Choose a repository…', '');
    choose.disabled = true;
    select.append(choose, ...repos.map(repo => new Option(repo, repo)));
    select.value = jobRepo(job, index);
    const hint = element('small', job.repo && !jobRepos.has(index) ? 'suggested' : '', 'subtle');
    select.addEventListener('change', () => { jobRepos.set(index, select.value); hint.textContent = ''; updateControls(); });
    field.append(select, hint);
    return field;
  }
  function repoMissing() {
    const plan = snapshot?.plan;
    if (!plan || (plan.repos ?? []).length < 2) return false;
    return plan.jobs.some((job, index) => job.kind === 'claude' && !jobRepo(job, index));
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
      // A run can have several steps for one role (one per repository, or feedback rounds): show the current or latest one.
      const indexes = active ? active.steps.flatMap((step, position) => step.role === role ? [position] : []) : [];
      const index = indexes.includes(current) ? current
        : indexes.find(position => active.steps[position].status === 'running') ?? indexes.filter(position => active.steps[position].status !== 'pending').at(-1) ?? indexes[0] ?? -1;
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

  const kindLabel = { read: 'Read', search: 'Search', edit: 'Edit', run: 'Run', tool: 'Tool', denied: 'Blocked', failed: 'Failed' };
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
      live.commands && `${live.commands} command${live.commands === 1 ? '' : 's'}`,
      live.problems && `${live.problems} blocked or failed`
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
        const files = (run.trees ?? []).reduce((sum, tree) => sum + (tree.files ?? 0), 0);
        if (before === 'active' && run.status !== 'active' && (run.trees ?? []).some(tree => tree.commit)) toast(`Committed ${files} file${files === 1 ? '' : 's'} to ${run.trees[0].branch}`, 'good');
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
  function duration(ms) {
    const seconds = Math.max(0, Math.round(ms / 1000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.round(seconds / 60);
    return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
  }
  function money(cost) {
    return `$${cost.toFixed(cost < 0.1 ? 3 : 2)}`;
  }

  const feedbackDrafts = new Map();
  function changesView(run, busy) {
    const files = diffs.get(run.id);
    const box = element('div', undefined, 'changes');
    if (!files) return box;
    const trees = run.trees ?? [];
    const multiple = trees.length > 1;
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
    const draft = feedbackDrafts.get(run.id) ?? { text: '', repo: trees[0]?.target ?? '' };
    feedbackDrafts.set(run.id, draft);
    const comment = element('textarea');
    let lastRepo;
    for (const file of files) {
      if (multiple && file.repo !== lastRepo) {
        lastRepo = file.repo;
        box.append(element('p', file.repo === '.' ? 'workspace' : file.repo, 'repo-head'));
      }
      const key = `${file.repo}:${file.path}`;
      const details = element('details', undefined, 'file');
      details.open = open.has(key);
      details.addEventListener('toggle', () => { if (details.open) open.add(key); else open.delete(key); });
      const summary = element('summary');
      const total = Math.max(1, file.added + file.removed);
      const bar = element('span', undefined, 'bar');
      bar.style.setProperty('--add', `${Math.round(file.added / total * 100)}%`);
      summary.append(element('span', file.status[0].toUpperCase(), `fstatus ${file.status}`), element('span', file.path, 'fpath'),
        element('span', `+${file.added} −${file.removed}`, 'delta'), bar);
      details.append(summary);
      details.append(file.binary ? element('p', 'Binary file.', 'subtle') : patchView(file.patch || '(no textual changes)'));
      const actions = element('div', undefined, 'actions');
      const action = (text, handler, disabled) => {
        const control = element('button', text);
        control.type = 'button';
        control.disabled = Boolean(disabled);
        control.addEventListener('click', handler);
        actions.append(control);
      };
      action('Open diff', () => send('runOpenFile', { id: run.id, file: file.path, repo: file.repo }));
      action('Comment', () => {
        draft.repo = file.repo;
        draft.text = `${draft.text ? `${draft.text.trimEnd()}\n` : ''}${file.path}: `;
        comment.value = draft.text;
        comment.dispatchEvent(new Event('input'));
        if (repoSelect) repoSelect.value = draft.repo;
        comment.focus();
        comment.setSelectionRange(comment.value.length, comment.value.length);
      }, busy || run.trees?.find(tree => tree.target === file.repo)?.merged);
      action('Discard', () => send('runDiscard', { id: run.id, file: file.path, repo: file.repo }), busy);
      details.append(actions);
      box.append(details);
    }
    // Review feedback goes back to Implement as a new step in the same worktree.
    const form = element('div', undefined, 'feedback');
    comment.rows = 3;
    comment.maxLength = 4000;
    comment.placeholder = 'Ask Implement for changes, e.g. "src/api.ts: validate the date range". Use Comment on a file to start a line.';
    comment.setAttribute('aria-label', 'Requested changes');
    comment.value = draft.text;
    comment.disabled = busy;
    const label = element('label', 'Request changes');
    label.append(comment);
    form.append(label);
    let repoSelect;
    const controls = element('div', undefined, 'actions');
    if (multiple) {
      repoSelect = element('select');
      repoSelect.setAttribute('aria-label', 'Repository for the requested changes');
      repoSelect.append(...trees.filter(tree => !tree.merged).map(tree => new Option(tree.target === '.' ? 'workspace' : tree.target, tree.target)));
      repoSelect.value = draft.repo;
      repoSelect.disabled = busy;
      repoSelect.addEventListener('change', () => { draft.repo = repoSelect.value; });
      controls.append(repoSelect);
    }
    const submit = element('button', 'Request changes', 'primary');
    submit.type = 'button';
    const sync = () => { submit.disabled = busy || !comment.value.trim(); };
    comment.addEventListener('input', () => { draft.text = comment.value; sync(); });
    sync();
    submit.addEventListener('click', () => send('runRequestChanges', { id: run.id, text: comment.value, repo: multiple ? repoSelect.value : undefined }));
    controls.append(submit);
    form.append(controls);
    if (trees.some(tree => !tree.merged)) box.append(form);
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

  function renderMetrics(metrics) {
    const node = byId('runs-metrics');
    node.hidden = !metrics;
    if (!metrics) return;
    node.textContent = [
      `Last 30 days: ${metrics.runs} run${metrics.runs === 1 ? '' : 's'}`,
      `median ${duration(metrics.medianMs)} to commit`,
      `${Math.round(metrics.firstPass * 100)}% of steps passed first time`,
      `${metrics.files} file${metrics.files === 1 ? '' : 's'}`,
      metrics.costUsd ? money(metrics.costUsd) : ''
    ].filter(Boolean).join(' · ');
  }

  function renderRuns(runs) {
    byId('chat-runs').hidden = !runs.length;
    announce(runs);
    renderMetrics(snapshot.metrics);
    const busy = Boolean(pending) || snapshot.busy;
    for (const id of diffs.keys()) if (!runs.some(run => run.id === id)) diffs.delete(id);
    const deployTargets = lastState?.sync?.deploy ?? {};
    const deployFor = target => deployTargets[target] ?? deployTargets[target.split('/').at(-1)];
    const key = JSON.stringify(runs) + String(busy) + JSON.stringify([...diffs]) + JSON.stringify(deployTargets);
    if (key === runsKey) return;
    runsKey = key;
    byId('run-list').replaceChildren(...runs.map(run => {
      const item = element('li', undefined, `run ${run.status}`);
      const trees = run.trees ?? [];
      const multiple = trees.length > 1;
      const branch = trees[0]?.branch;
      const fileCount = trees.reduce((sum, tree) => sum + (tree.files ?? 0), 0);
      const cost = run.costUsd ? ` · ${money(run.costUsd)}` : '';
      const files = run.status === 'active' ? '' : ` · ${fileCount} file${fileCount === 1 ? '' : 's'}`;
      const took = run.finished ? ` · ${duration(run.finished - run.time)}` : '';
      const approvedBy = { human: 'you approve', 'ai+human': 'AI reviews, you approve', ai: 'AI approves' }[run.approver ?? 'human'];
      const where = trees.filter(tree => tree.target !== '.').map(tree => tree.target).join(' + ');
      item.append(element('strong', run.prompt.split('\n', 1)[0]),
        element('small', `${where ? `${where} · ` : ''}${branch ?? 'text only'} · ${run.status} · ${approvedBy}${files}${took}${cost}`));

      const steps = element('ol', undefined, 'steps');
      const current = run.status === 'active'
        ? run.steps.findIndex(step => step.status !== 'done' && step.status !== 'skipped') : -1;
      run.steps.forEach((step, index) => {
        const row = element('li', undefined, `step ${step.status}${index === current ? ' current' : ''}`);
        const facts = [
          step.role + (step.feedback ? ' (feedback)' : ''), multiple && step.repo ? step.repo : '', step.profile, step.model ?? '', stepLabels[step.status] ?? step.status,
          step.ms ? duration(step.ms) : '', step.attempts > 1 ? `${step.attempts} tries` : '', step.costUsd ? money(step.costUsd) : ''
        ].filter(Boolean);
        row.append(element('span', facts.join(' · ')));
        if (step.gate) {
          row.append(element('p', `AI review (${step.gate.by}): ${step.gate.verdict === 'pass' ? 'pass' : 'changes requested'}. ${step.gate.reason}`,
            `gate ${step.gate.verdict}`));
        }
        if (index === current) row.append(stepControls(run, step, index, busy));
        else if (step.summary) row.append(element('p', step.summary.length > 240 ? step.summary.slice(0, 240) + '…' : step.summary, 'subtle'));
        steps.append(row);
      });
      item.append(steps);

      const stats = trees.filter(tree => tree.stat);
      if (stats.length) {
        const stat = element('details');
        stat.append(element('summary', 'Changed files'), element('pre', stats.map(tree => `${multiple ? `# ${tree.target}\n` : ''}${tree.stat}`).join('\n\n')));
        item.append(stat);
      }
      const pushed = trees.filter(tree => tree.pushed);
      if (pushed.length) {
        const links = element('ul', undefined, 'pushed');
        for (const tree of pushed) {
          const row = element('li');
          row.append(element('span', `${multiple ? `${tree.target}: ` : ''}pushed to ${tree.pushed.remote}${tree.pushed.mergeRequest ? ` · MR into ${tree.pushed.target}` : ''}${tree.merged ? ' · merged locally' : ''}`));
          if (tree.pushed.url) {
            const link = element('button', /merge_requests\/\d+|pull\/\d+/.test(tree.pushed.url) ? 'Open MR' : 'Create MR', 'link');
            link.type = 'button';
            link.title = tree.pushed.url;
            link.addEventListener('click', () => send('runLink', { id: run.id, repo: tree.target }));
            row.append(link);
          }
          links.append(row);
        }
        item.append(links);
      }
      const deployed = trees.filter(tree => tree.deploy);
      if (deployed.length) {
        const list = element('ul', undefined, 'pushed deployed');
        for (const tree of deployed) {
          const row = element('li');
          const { deploy } = tree;
          const health = deploy.health
            ? ` · health ${deploy.health.status || 'no answer'} at ${new Date(deploy.health.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '';
          row.append(element('span', `${multiple ? `${tree.target}: ` : ''}${deploy.to ? `deploy MR ${deploy.from} → ${deploy.to}` : `deploys from ${deploy.from}`}${health}`));
          if (deploy.health) row.classList.add(deploy.health.status >= 200 && deploy.health.status < 400 ? 'healthy' : 'unhealthy');
          if (deploy.url) {
            const link = element('button', 'Open deploy MR', 'link');
            link.type = 'button';
            link.title = deploy.url;
            link.addEventListener('click', () => send('runDeployLink', { id: run.id, repo: tree.target }));
            row.append(link);
          }
          list.append(row);
        }
        item.append(list);
      }
      const actions = element('div', undefined, 'actions');
      const button = (text, action, args, disabled, className) => {
        const control = element('button', text, className);
        control.type = 'button';
        control.disabled = disabled;
        control.addEventListener('click', () => send(action, { id: run.id, ...args }));
        actions.append(control);
      };
      const active = run.status === 'active';
      if (active) button('Finish run', 'runFinish', {}, busy);
      if (branch) {
        const committed = trees.some(tree => tree.commit);
        const shown = diffs.has(run.id);
        const changes = element('button', shown ? 'Hide changes' : 'Changes', shown ? undefined : 'accent');
        changes.type = 'button';
        changes.addEventListener('click', () => {
          if (diffs.has(run.id)) { diffs.delete(run.id); runsKey = undefined; renderRuns(snapshot.runs ?? []); }
          else send('runChanges', { id: run.id });
        });
        actions.append(changes);
        button('Full diff', 'runDiff', {}, active || !committed);
        button(trees.every(tree => !tree.commit || tree.merged) && trees.some(tree => tree.merged) ? 'Merged' : 'Merge', 'runMerge', {},
          active || busy || !trees.some(tree => tree.commit && !tree.merged));
        button(trees.some(tree => tree.pushed) ? 'Push again' : 'Push & MR', 'runPush', {}, active || busy || !committed, committed && !active && !pushed.length ? 'accent' : undefined);
        const deployable = trees.filter(tree => tree.pushed && deployFor(tree.target));
        if (deployable.length) {
          const control = element('button', deployed.length ? 'Deploy again' : 'Deploy', !deployed.length ? 'accent' : undefined);
          control.type = 'button';
          control.disabled = active || busy;
          control.title = deployable.map(tree => {
            const target = deployFor(tree.target);
            return `${tree.target}: ${target.to ? `${target.from} → ${target.to}` : `deploys from ${target.from}`}`;
          }).join('\n');
          control.addEventListener('click', () => send('runDeploy', { id: run.id }));
          actions.append(control);
          if (deployable.some(tree => deployFor(tree.target).health)) button('Check health', 'runHealth', {}, busy);
        }
        button('Open folder', 'runOpen', {}, false);
        for (const session of run.sessions) {
          button(`Resume ${session.role}${multiple && session.repo ? ` (${session.repo})` : ''}`, 'runResume', { session: session.sessionId }, busy);
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

  // First run: one click gives every role the same account instead of four trips to Roles.
  let assignAccount;
  function renderAssignAll(state, lead) {
    const node = byId('chat-assign-all');
    const assigned = roles.some(role => state.seats[role]?.account);
    const candidate = state.accounts.find(profile => profile.detail === 'Claude Code') ?? state.accounts[0];
    node.hidden = Boolean(lead) || assigned || !candidate;
    assignAccount = node.hidden ? undefined : candidate.id;
    if (!node.hidden) node.textContent = `Use ${candidate.name} for all roles`;
  }

  function renderSessions(state) {
    const select = byId('chat-session');
    const chats = state.chats ?? [];
    const key = JSON.stringify(chats.map(chat => [chat.id, chat.title]));
    if (select.dataset.key !== key) {
      select.replaceChildren(...chats.map(chat => {
        const option = document.createElement('option');
        option.value = chat.id;
        option.textContent = chat.title;
        option.selected = chat.active;
        return option;
      }));
      select.dataset.key = key;
    }
    const mode = [
      state.leadSession ? `Lead session ${state.leadSession.turns}/${state.leadSession.max}` : '',
      state.planApproval === 'auto' ? 'auto start' : '',
      state.accountPool && state.accountPool !== 'role' ? `pool: ${state.accountPool === 'quota' ? 'most quota left' : 'round robin'}` : ''
    ].filter(Boolean).join(' · ');
    byId('chat-mode').textContent = mode;
  }

  function updateControls() {
    message.disabled = !snapshot;
    byId('send-chat').disabled = !snapshot || snapshot.busy || Boolean(snapshot.plan || pending) || !message.value.trim();
    for (const id of ['stop-chat', 'open-chat-terminal', 'chat-add-profile', 'chat-assign-all']) {
      byId(id).disabled = !snapshot || Boolean(pending);
    }
    byId('approve-plan').disabled = Boolean(pending || snapshot?.busy) || repoMissing();
    byId('discard-plan').disabled = Boolean(pending || snapshot?.busy);
    const locked = !snapshot || Boolean(pending || snapshot.busy || snapshot.plan);
    byId('chat-session').disabled = locked || (snapshot.chats ?? []).length < 2;
    byId('new-chat').disabled = locked || !snapshot.entries.length;
    byId('delete-chat').disabled = locked || (!snapshot.entries.length && (snapshot.chats ?? []).length < 2);
  }

  function send(action, args = {}) {
    if (!snapshot || pending) return;
    pending = { action, text: args.text, id: args.id };
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
    else if (pending.action === 'runRequestChanges') { feedbackDrafts.delete(pending.id); diffs.delete(pending.id); runsKey = undefined; }
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
    id: snapshot.plan.id, approver: byId('plan-approver').value,
    repos: (snapshot.plan.repos ?? []).length > 1 ? snapshot.plan.jobs.map((job, index) => job.kind === 'claude' ? jobRepo(job, index) : '') : undefined
  }));
  byId('chat-assign-all').addEventListener('click', () => { if (assignAccount) send('assignAll', { account: assignAccount }); });
  byId('plan-approver').addEventListener('change', () => { byId('plan-approver').dataset.touched = '1'; render(lastState); });
  byId('discard-plan').addEventListener('click', () => send('discard', { id: snapshot.plan.id }));
  byId('stop-chat').addEventListener('click', () => send('stop'));
  byId('new-chat').addEventListener('click', () => send('newChat'));
  byId('chat-session').addEventListener('change', event => send('openChat', { id: event.target.value }));
  byId('delete-chat').addEventListener('click', () => {
    const active = (snapshot.chats ?? []).find(chat => chat.active);
    if (active) send('deleteChat', { id: active.id });
  });
  byId('chat-add-profile').addEventListener('click', () => send('addProfile'));
  byId('open-chat-terminal').addEventListener('click', () => send('terminal', { role: terminalRole.value }));
  return { render, settle, loadError: text => { byId('chat-status').textContent = text; } };
}
