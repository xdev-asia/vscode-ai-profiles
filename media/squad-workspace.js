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
    skills.replaceChildren(...savedSkills.map(skill => {
      const row = document.createElement('li');
      const label = document.createElement('span');
      label.textContent = `${skill.name} · ${skill.enabled ? 'Enabled' : 'Disabled'}`;
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
    byId('tool-hint').textContent = state.nativeChatTools
      ? 'Set which xDev tools Copilot can call in this workspace.'
      : 'Copilot tools require a supported VS Code chat session. Use the Squad tabs in this workspace.';
    byId('native-customizations').hidden = !state.nativeChatTools;
    byId('native-tools').disabled = byId('native-skills').disabled = Boolean(pending);
    for (const tool of tools) {
      tool.disabled = !state.nativeChatTools || Boolean(pending);
      tool.checked = !disabledTools.includes(tool.id);
    }
  }

  function editSkill(skill) {
    skillId = skill?.id;
    byId('skill-name').value = skill?.name ?? '';
    byId('skill-instructions').value = skill?.instructions ?? '';
    byId('skill-enabled').checked = skill?.enabled ?? true;
    skillForm.hidden = false;
    byId('skill-name').focus();
  }

  function render(data) {
    if (!state && !pending) byId('workflow-notice').textContent = '';
    state = data;
    renderWorkflow();
    renderCustomizations();
  }

  function send(action, args, notice = 'customizations') {
    if (!state || pending) return;
    pending = { action, notice };
    byId(`${notice}-notice`).textContent = '';
    vscode.postMessage({ type: 'workspace', action, ...args });
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
    byId(`${notice}-notice`).textContent = error ?? (action === 'copy' ? 'Stage brief copied.' : '');
    if (!error && action === 'saveSkill') skillForm.hidden = true;
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
    send('saveSkill', { id: skillId, name: byId('skill-name').value,
      instructions: byId('skill-instructions').value, enabled: byId('skill-enabled').checked });
  });
  for (const tool of tools) {
    tool.addEventListener('change', () => send('setTool', { id: tool.id, enabled: tool.checked }));
  }
  byId('native-tools').addEventListener('click', () => send('nativeTools'));
  byId('native-skills').addEventListener('click', () => send('nativeSkills'));
  return { render, settle, loadError(error) {
    byId('workflow-notice').textContent = error;
    byId('customizations-notice').textContent = error;
  } };
}
