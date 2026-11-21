import { randomBytes } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import * as vscode from 'vscode';
import { Accounts, accountStorageKey } from './accounts';
import {
  findTerminalExecutable, terminalProfileEnv, terminalProfileId, terminalProviders, type TerminalProfile, type TerminalProfiles
} from './terminal-profiles';
import { chat, providers } from './core';
import { isRole, noteLimit, readTask, roles, SquadStore, taskLimit, taskStatuses, type Role } from './squad';
import { chatPromptLimit, SquadChat, type WorkerHost } from './squad-chat';
import { registerSquadTools } from './squad-tools';
import { skillDescriptionLimit, skillInstructionsLimit, skillNameLimit, squadTools } from './squad-customizations';
import { memoryTextLimit } from './squad-memory';
import { runClaude, validCommand, type WorkerSettings } from './squad-worker';
import { git, Worktrees } from './squad-worktree';
import { mergeSkills, readSyncFolder, syncProfileSkills, writeSyncFolder } from './skill-sync';
import { workflowBriefLimit, workflowOutputLimit, workflowStages } from './workflow';

const viewId = 'xdevAi.squad';
type SquadTab = 'workflow' | 'customizations' | 'memory';

function squadSetting<T>(key: string, fallback: T): T {
  return vscode.workspace.getConfiguration('xdevAi.squad').get<T>(key) ?? fallback;
}

function workspaceFolder(): string | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  return folder?.scheme === 'file' ? folder.fsPath : undefined;
}

function workerSettings(role: Role): WorkerSettings {
  const models = squadSetting<Record<string, unknown>>('workerModels', {});
  const model = typeof models[role] === 'string' && /^[\w.:[\]-]{1,80}$/.test(models[role] as string) ? models[role] as string : undefined;
  const budget = Number(squadSetting<number>('workerBudgetUsd', 1));
  const minutes = Number(squadSetting<number>('workerTimeoutMinutes', 20));
  return {
    model,
    budgetUsd: Number.isFinite(budget) && budget >= 0 ? Math.min(budget, 50) : 1,
    allowedCommands: squadSetting<unknown[]>('workerAllowedCommands', []).filter(validCommand),
    timeoutMs: (Number.isFinite(minutes) ? Math.min(Math.max(minutes, 1), 120) : 20) * 60_000
  };
}

export function registerSquad(
  context: vscode.ExtensionContext, accounts: Accounts, profiles: TerminalProfiles, onProfilesChanged: vscode.Event<void>
): SquadChat {
  const view = new SquadView(context, accounts, profiles);
  context.subscriptions.push(
    view,
    vscode.window.registerWebviewViewProvider(viewId, view),
    vscode.commands.registerCommand('xdevAi.squad.open', () => vscode.commands.executeCommand(`${viewId}.focus`)),
    vscode.commands.registerCommand('xdevAi.squad.workflow', () => view.open('workflow')),
    vscode.commands.registerCommand('xdevAi.squad.customizations', () => view.open('customizations')),
    vscode.commands.registerCommand('xdevAi.squad.memory', () => view.open('memory')),
    vscode.commands.registerCommand('xdevAi.squad.syncSkills', () => view.syncFolder()),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('xdevAi.squad')) void view.refresh();
    }),
    context.secrets.onDidChange(({ key }) => {
      if (key === accountStorageKey) void view.refresh();
    }),
    onProfilesChanged(() => void view.refresh()),
    vscode.window.onDidChangeWindowState(({ focused }) => {
      if (focused) void view.refresh();
    })
  );
  view.registerChatTools();
  return view.teamChat;
}

class SquadView implements vscode.WebviewViewProvider, vscode.Disposable {
  private readonly store: SquadStore;
  readonly teamChat: SquadChat;
  private readonly running = new Map<Role, AbortController>();
  private readonly errors = new Map<Role, string>();
  private view?: vscode.WebviewView;
  private requestedTab?: SquadTab;
  private chatTools: string[] = [];
  private ready = false;
  private refreshId = 0;
  private actions = Promise.resolve();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly accounts: Accounts,
    private readonly profiles: TerminalProfiles
  ) {
    this.store = new SquadStore(context.workspaceState);
    const storage = context.storageUri ?? context.globalStorageUri;
    const host: WorkerHost = {
      profiles: () => profiles.list('claude'),
      executable: async () => {
        const executable = await findTerminalExecutable('claude', vscode.workspace.getConfiguration('xdevAi').get<string>('claudeExecutable') ?? '');
        if (!executable) throw new Error('Claude Code was not found on the workspace host. Set xdevAi.claudeExecutable.');
        return executable;
      },
      folder: workspaceFolder,
      settings: workerSettings,
      run: request => runClaude(request),
      worktrees: new Worktrees(join(storage.fsPath, 'squad-worktrees')),
      prepare: async () => { await this.syncProfiles(); }
    };
    this.teamChat = new SquadChat(context.workspaceState, accounts, this.store, () => void this.refresh(), host);
  }

  /** Copies enabled skills into every Claude Code account so headless workers load them on demand. */
  async syncProfiles(): Promise<number> {
    if (!squadSetting('syncSkillsToProfiles', true)) return 0;
    return syncProfileSkills(await this.profiles.list('claude'), this.teamChat.customizations.enabledSkills());
  }

  private syncFolderPath(): string | undefined {
    const configured = squadSetting<string>('syncFolder', '').trim();
    if (!configured) return undefined;
    if (isAbsolute(configured)) return configured;
    const folder = workspaceFolder();
    return folder ? join(folder, configured) : undefined;
  }

  /**
   * Two-way sync of skills and Squad memory with a folder, normally a clone of the team's docs repository.
   * Git pull and a local commit happen automatically; pushing always asks first.
   */
  async syncFolder(): Promise<void> {
    let folder = this.syncFolderPath();
    if (!folder) {
      const picked = await vscode.window.showOpenDialog({
        canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
        openLabel: 'Use for skill sync', title: 'Choose a folder (for example a clone of your docs repository) to sync skills and memory'
      });
      if (!picked?.[0]) return;
      folder = picked[0].fsPath;
      await vscode.workspace.getConfiguration('xdevAi.squad').update('syncFolder', folder,
        vscode.workspace.workspaceFolders ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global);
    }
    const repository = await git(['rev-parse', '--show-toplevel'], folder).then(() => true, () => false);
    const notes: string[] = [];
    if (repository) {
      const upstream = await git(['rev-parse', '--abbrev-ref', '@{u}'], folder).then(() => true, () => false);
      if (upstream) {
        await git(['pull', '--ff-only', '-q'], folder).catch((error: Error) => notes.push(`Pull skipped: ${error.message}`));
      }
    }
    const customizations = this.teamChat.customizations;
    const remote = await readSyncFolder(folder);
    const state = customizations.read();
    const merge = mergeSkills(state.skills, remote.skills, state.syncBase ?? {});
    const memoryAdded = await this.teamChat.memory.merge(remote.memory);
    await writeSyncFolder(folder, merge.skills.filter(skill => !skill.name.endsWith('(sync copy)')), this.teamChat.memory.read());
    let committed = false;
    if (repository) {
      await git(['add', '--', 'skills', 'memory'], folder);
      const staged = (await git(['diff', '--cached', '--name-only'], folder)).trim();
      if (staged) {
        await git(['commit', '-q', '-m', 'xDev: sync skills and memory'], folder)
          .then(() => { committed = true; }, (error: Error) => notes.push(`Commit failed: ${error.message}`));
      }
    }
    const summary = [
      `${merge.skills.length} skills`, merge.pulled ? `${merge.pulled} updated from folder` : '',
      merge.conflicts ? `${merge.conflicts} conflict${merge.conflicts === 1 ? '' : 's'} kept as “(sync copy)”` : '',
      memoryAdded ? `${memoryAdded} memory notes added` : '', committed ? 'committed locally' : '', ...notes
    ].filter(Boolean).join(' · ');
    await customizations.applySync(merge.skills, merge.base, { time: Date.now(), folder, summary });
    await this.syncProfiles();
    if (committed) {
      const push = 'Push';
      const choice = await vscode.window.showInformationMessage('Skills and memory were committed in the sync folder. Push them to the remote?', {
        modal: true, detail: `${folder}\nTeammates receive the change on their next sync.`
      }, push);
      if (choice === push) {
        await git(['push', '-q'], folder);
        await customizations.applySync(merge.skills, merge.base, { time: Date.now(), folder, summary: `${summary} · pushed` });
      }
    }
  }

  registerChatTools(): void {
    this.chatTools = registerSquadTools(this.context, this.teamChat);
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.ready = false;
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    const receiver = view.webview.onDidReceiveMessage(message => {
      if (message?.type === 'ready') {
        this.ready = true;
        this.showRequestedTab();
        void this.refresh();
        return;
      }
      this.actions = this.actions.then(async () => {
        if (this.view !== view) return;
        const type = message?.type === 'squadChat' ? 'chatSettled' :
          message?.type === 'workspace' ? 'workspaceSettled' : 'settled';
        try {
          await this.receive(message);
          await this.refresh();
          void view.webview.postMessage({ type });
        } catch (error) {
          void view.webview.postMessage({
            type,
            error: error instanceof Error ? error.message : 'Unable to update the squad.'
          });
        }
      });
    });
    const visibility = view.onDidChangeVisibility(() => {
      if (view.visible) void this.refresh();
    });
    view.onDidDispose(() => {
      receiver.dispose();
      visibility.dispose();
      if (this.view === view) this.view = undefined;
    });
    view.webview.html = squadHtml(view.webview, media);
  }

  async open(tab: SquadTab): Promise<void> {
    this.requestedTab = tab;
    await vscode.commands.executeCommand(`${viewId}.focus`);
    this.showRequestedTab();
  }

  private showRequestedTab(): void {
    if (!this.ready || !this.view?.visible || !this.requestedTab) return;
    void this.view.webview.postMessage({ type: 'selectTab', tab: this.requestedTab });
    this.requestedTab = undefined;
  }

  dispose(): void {
    this.view = undefined;
    this.teamChat.cancel();
    for (const controller of this.running.values()) controller.abort();
  }

  async refresh(): Promise<void> {
    const view = this.view;
    if (!view?.visible) return;
    const id = ++this.refreshId;
    try {
      const accounts = await this.profilesForBoard();
      if (view !== this.view || id !== this.refreshId) return;
      void view.webview.postMessage({
        type: 'state',
        ...this.store.read(),
        teamChat: this.teamChat.snapshot(),
        customizations: this.teamChat.customizations.read(),
        memory: this.teamChat.memory.read(),
        sync: {
          folder: this.syncFolderPath() ?? '',
          profiles: squadSetting('syncSkillsToProfiles', true),
          workers: { ...workerSettings('Implement'), models: squadSetting('workerModels', {}) }
        },
        nativeChatTools: this.chatTools,
        accounts,
        running: [...this.running.keys()],
        errors: Object.fromEntries(this.errors)
      });
    } catch {
      if (view === this.view && id === this.refreshId) {
        void view.webview.postMessage({ type: 'loadError', error: 'Unable to load squad profiles.' });
      }
    }
  }

  private async profilesForBoard() {
    const [api, terminals] = await Promise.all([this.accounts.read(), this.profiles.list()]);
    return [
      ...api.accounts.map(account => ({
        id: `api:${account.id}`, kind: 'api', name: account.name, detail: providers[account.provider].name
      })),
      ...terminals.map(profile => ({
        id: terminalProfileId(profile), kind: 'terminal', name: profile.name, detail: terminalProviders[profile.provider].name
      }))
    ];
  }

  private async receive(input: unknown): Promise<void> {
    if (!input || typeof input !== 'object') return;
    const message = input as Record<string, unknown>;
    if (message.type === 'workspace') return this.updateWorkflowOrCustomizations(message);
    if (message.type === 'squadChat') {
      switch (message.action) {
        case 'send':
          await this.teamChat.send(message.text);
          return;
        case 'approve':
          await this.teamChat.approve(message.id);
          return;
        case 'discard': return this.teamChat.discard(message.id);
        case 'stop': return this.teamChat.cancel();
        case 'runDiff': return this.showRunDiff(message.id);
        case 'runOpen': {
          const run = this.requireRun(message.id);
          await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(run.path), { forceNewWindow: true });
          return;
        }
        case 'runResume': return this.resumeSession(message.id, message.session);
        case 'runMerge': return this.mergeRun(message.id);
        case 'runRemove': {
          const run = this.requireRun(message.id);
          const remove = 'Remove worktree';
          if (await vscode.window.showWarningMessage(`Remove the worktree and branch ${run.branch}?`, {
            modal: true, detail: 'Unmerged changes on this branch are deleted.'
          }, remove) === remove) await this.teamChat.removeRun(run.id);
          return;
        }
        case 'settings':
          await vscode.commands.executeCommand('workbench.action.openSettings', 'xdevAi.squad');
          return;
        case 'terminal': return this.receive({ type: 'terminal', role: message.role });
        case 'addProfile':
          await vscode.commands.executeCommand('xdevAi.addAiAccount');
          return;
      }
      return;
    }
    if (!isRole(message.role)) return;
    const role = message.role;
    const seat = this.store.seat(role);

    switch (message.type) {
      case 'save': {
        if (this.running.has(role)) throw new Error('Wait for the API response or cancel the request.');
        const task = readTask(message);
        if (task.account && task.account !== seat.account) {
          const profiles = await this.profilesForBoard();
          if (!profiles.some(profile => profile.id === task.account)) throw new Error('That profile is no longer available.');
        }
        await this.store.save(role, task);
        this.errors.delete(role);
        break;
      }
      case 'handoff': {
        const { to, note } = message;
        if (!isRole(to) || to === role || typeof note !== 'string' || !note.trim() || note.length > noteLimit) {
          throw new Error('Choose a recipient and enter a handoff note.');
        }
        await this.store.handoff(role, to, note.trim());
        break;
      }
      case 'copy':
        if (seat.brief) await vscode.env.clipboard.writeText(seat.brief);
        break;
      case 'terminal':
      case 'usage': {
        const profile = (await this.profiles.list()).find(candidate => terminalProfileId(candidate) === seat.account);
        if (!profile) throw new Error('Assign an AI terminal profile first.');
        await vscode.commands.executeCommand(message.type === 'usage' ? 'xdevAi.checkUsage' : 'xdevAi.openTerminal', seat.account);
        break;
      }
      case 'run':
        if (!seat.brief || this.running.has(role)) return;
        await this.startRequest(role, seat.account, seat.brief);
        break;
      case 'stop':
        this.running.get(role)?.abort();
        break;
    }
  }

  private async updateWorkflowOrCustomizations(message: Record<string, unknown>): Promise<void> {
    const squad = this.teamChat;
    const { id, step } = message;
    switch (message.action) {
      case 'start': return squad.startWorkflow(message.brief);
      case 'approve': return squad.approveStage(id, step, message.output);
      case 'draft':
        await squad.draftStage(id, step);
        return;
      case 'stop': return squad.cancel();
      case 'copy': {
        const { instruction, brief, approved, skills } = squad.stageRequest(id, step);
        const text = [instruction, `Project brief\n${brief}`,
          ...approved.map(result => `${result.stage} · approved\n${result.result}`),
          ...skills.map(skill => `${skill.name}\n${skill.instructions}`)].join('\n\n');
        return vscode.env.clipboard.writeText(text);
      }
      case 'reset': {
        const reset = 'Reset Workflow';
        if (await vscode.window.showWarningMessage('Reset the current SDLC workflow?', {
          modal: true,
          detail: 'The brief and stage results will be removed. Messages already in Squad Chat remain there.'
        }, reset) === reset) await squad.resetWorkflow(id);
        return;
      }
      case 'saveSkill':
        await squad.customizations.saveSkill(message);
        await this.syncProfiles();
        return;
      case 'removeSkill': {
        const skill = squad.customizations.read().skills.find(candidate => candidate.id === id);
        const remove = 'Delete Skill';
        if (skill && await vscode.window.showWarningMessage(`Delete the skill “${skill.name}”?`, { modal: true }, remove) === remove) {
          await squad.customizations.removeSkill(id);
          await this.syncProfiles();
        }
        return;
      }
      case 'syncFolder': return this.syncFolder();
      case 'syncProfiles': {
        const count = await this.syncProfiles();
        void vscode.window.showInformationMessage(count
          ? `Enabled skills are available to ${count} Claude Code account${count === 1 ? '' : 's'}.`
          : 'Turn on xdevAi.squad.syncSkillsToProfiles and add a Claude Code account to share skills with workers.');
        return;
      }
      case 'addMemory': {
        const added = typeof message.text === 'string' ? await squad.memory.add([message.text], 'You') : 0;
        if (!added) throw new Error(`Enter a new memory note up to ${memoryTextLimit} characters.`);
        return;
      }
      case 'pinMemory':
        await squad.memory.edit(id, { pinned: message.pinned });
        return;
      case 'editMemory':
        await squad.memory.edit(id, { text: message.text });
        return;
      case 'removeMemory':
        await squad.memory.remove(id);
        return;
      case 'setTool': return squad.customizations.setTool(id, message.enabled);
      case 'manageMcp': return vscode.commands.executeCommand('xdevAi.manageMcp');
      case 'nativeTools':
      case 'nativeSkills': {
        const page = message.action === 'nativeTools' ? 'tools' : 'skills';
        const uri = vscode.Uri.parse(`${vscode.env.uriScheme}://chat-customizations/open?page=${page}`);
        if (!await vscode.env.openExternal(uri)) {
          throw new Error('Open Chat: Open Customizations in a supported VS Code session.');
        }
        return;
      }
    }
  }

  private requireRun(id: unknown) {
    const run = this.teamChat.run(id);
    if (!run) throw new Error('This run is no longer available.');
    return run;
  }

  private async showRunDiff(id: unknown): Promise<void> {
    const run = this.requireRun(id);
    const diff = await git(['diff', `${run.base}..${run.branch}`], run.repo);
    const document = await vscode.workspace.openTextDocument({ language: 'diff', content: diff || `No changes on ${run.branch}.` });
    await vscode.window.showTextDocument(document, { preview: true });
  }

  private async mergeRun(id: unknown): Promise<void> {
    const run = this.requireRun(id);
    if (!run.commit) throw new Error('This run has no committed changes to merge.');
    const current = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], run.repo)).trim();
    const merge = 'Merge';
    if (await vscode.window.showWarningMessage(`Merge ${run.branch} into ${current}?`, {
      modal: true, detail: `${run.files ?? 0} changed files. Nothing is pushed. Commit or stash local changes first.\n\n${run.stat ?? ''}`
    }, merge) !== merge) return;
    await git(['merge', '--no-ff', '--no-edit', run.branch], run.repo);
    void vscode.window.showInformationMessage(`Merged ${run.branch} into ${current}. Remove the run when you no longer need its worktree.`);
  }

  private async resumeSession(id: unknown, sessionId: unknown): Promise<void> {
    const run = this.requireRun(id);
    const session = run.sessions.find(candidate => candidate.sessionId === sessionId);
    if (!session) throw new Error('This worker session is no longer available.');
    const profile: TerminalProfile | undefined = (await this.profiles.list('claude')).find(candidate => terminalProfileId(candidate) === session.profileId);
    if (!profile) throw new Error('The Claude Code account for this session was removed.');
    const executable = await findTerminalExecutable('claude', vscode.workspace.getConfiguration('xdevAi').get<string>('claudeExecutable') ?? '');
    if (!executable) throw new Error('Claude Code was not found on the workspace host. Set xdevAi.claudeExecutable.');
    const script = process.platform === 'win32' && /\.cmd$/i.test(executable);
    vscode.window.createTerminal({
      name: `${session.role} · ${session.profile}`,
      shellPath: script ? process.env.ComSpec ?? 'cmd.exe' : executable,
      shellArgs: script ? ['/d', '/s', '/c', executable, '--resume', session.sessionId] : ['--resume', session.sessionId],
      cwd: run.path,
      env: terminalProfileEnv(profile)
    }).show();
  }

  private async startRequest(role: Role, profileId: string, brief: string): Promise<void> {
    const { accounts } = await this.accounts.read();
    const account = accounts.find(candidate => `api:${candidate.id}` === profileId);
    if (!account) throw new Error('Assign an API profile first.');
    const controller = new AbortController();
    this.errors.delete(role);
    this.running.set(role, controller);
    void (async () => {
      try {
        const response = await chat(account, [{ role: 'user', content: brief }], { signal: controller.signal });
        controller.signal.throwIfAborted();
        const limit = 32_000;
        await this.store.recordResponse(role, response.length <= limit ? response : response.slice(0, limit) + '\n[Response truncated]');
      } catch (error) {
        if (!controller.signal.aborted) {
          this.errors.set(role, error instanceof Error ? error.message : 'The API request failed.');
        }
      } finally {
        this.running.delete(role);
        await this.refresh();
      }
    })();
  }
}

function squadHtml(webview: vscode.Webview, media: vscode.Uri): string {
  const nonce = randomBytes(16).toString('base64');
  const script = webview.asWebviewUri(vscode.Uri.joinPath(media, 'squad.js'));
  const chatScript = webview.asWebviewUri(vscode.Uri.joinPath(media, 'squad-chat.js'));
  const workspaceScript = webview.asWebviewUri(vscode.Uri.joinPath(media, 'squad-workspace.js'));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(media, 'squad.css'));
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'">
  <link rel="stylesheet" href="${style}">
  <title>Squad</title>
</head>
<body>
  <header class="top">
    <h1>Workspace squad</h1>
    <nav aria-label="Squad views">
      <button type="button" id="show-chat" aria-pressed="true">Chat</button>
      <button type="button" id="show-roles" aria-pressed="false">Roles</button>
      <button type="button" id="show-workflow" aria-pressed="false">Workflow</button>
      <button type="button" id="show-customizations" aria-pressed="false">Skills &amp; Tools</button>
      <button type="button" id="show-memory" aria-pressed="false">Memory</button>
    </nav>
  </header>
  <main id="chat-panel">
    <div id="chat-messages" role="log" aria-label="Squad conversation"></div>
    <section id="chat-plan" aria-labelledby="plan-title" hidden>
      <h2 id="plan-title">Lead's proposed tasks</h2>
      <ol id="chat-jobs"></ol>
      <p id="plan-cost" class="subtle"></p>
      <div class="actions">
        <button type="button" id="approve-plan">Approve and run</button>
        <button type="button" id="discard-plan">Discard plan</button>
      </div>
    </section>
    <section id="chat-runs" aria-labelledby="runs-title" hidden>
      <h2 id="runs-title">Worker runs</h2>
      <ol id="run-list" class="run-list"></ol>
    </section>
    <p id="chat-status" role="status">Loading squad…</p>
    <p id="chat-error" role="alert"></p>
    <div class="actions">
      <button type="button" id="chat-add-profile" disabled>Add AI account</button>
      <div id="chat-terminal" class="actions" hidden>
        <select id="chat-terminal-role" aria-label="AI terminal role"></select>
        <button type="button" id="open-chat-terminal">Open terminal</button>
      </div>
      <button type="button" id="stop-chat" hidden>Stop run</button>
    </div>
    <form id="chat-composer">
      <label>Message <textarea id="chat-message" rows="2" maxlength="${chatPromptLimit}"
        placeholder="Ask Lead or address a role with @Review" required disabled></textarea></label>
      <button type="submit" id="send-chat" disabled>Send</button>
    </form>
  </main>
  <main id="roles-panel" hidden>
    <p id="summary" aria-live="polite">Loading squad…</p>
    <section aria-label="Squad roles" class="board">
      <div id="roles" class="roles" data-roles="${roles.join(',')}"></div>
      <section id="escalations" class="escalations" hidden>
        <h2>Needs attention</h2>
        <ul id="blockers"></ul>
      </section>
    </section>
    <section class="detail" aria-labelledby="seat-title">
      <h2 id="seat-title">Lead</h2>
      <p id="notice" role="status"></p>
      <form id="seat">
        <fieldset id="fields" disabled>
          <div class="assignment">
            <label>Profile <select id="account"></select></label>
            <label>Status <select id="status">${taskStatuses.map(status => `<option>${status}</option>`).join('')}</select></label>
          </div>
          <label>Task brief <textarea id="brief" rows="3" maxlength="${taskLimit}" placeholder="Describe the work and expected result"></textarea></label>
          <label id="blocker-field" hidden>Blocker <textarea id="blocker" rows="2" maxlength="${noteLimit}"></textarea></label>
          <div class="actions">
            <button type="submit" id="save" disabled>Save task</button>
            <button type="button" id="copy" hidden>Copy brief</button>
            <button type="button" id="terminal" hidden>Open terminal</button>
            <button type="button" id="usage" hidden>Check usage</button>
            <button type="button" id="run" hidden>Send to API</button>
          </div>
        </fieldset>
      </form>
      <button id="stop" type="button" hidden>Cancel API request</button>
      <p id="request-error" role="alert"></p>
      <details id="reply" hidden>
        <summary>Latest API response</summary>
        <pre id="response"></pre>
      </details>
      <details id="handoff" hidden>
        <summary>Hand off to another role</summary>
        <form id="handoff-form">
          <label>Recipient <select id="recipient"></select></label>
          <label>Note <textarea id="note" rows="2" maxlength="${noteLimit}" required></textarea></label>
          <button type="submit" id="send-note">Send handoff</button>
        </form>
      </details>
    </section>
    <details id="activity" class="activity">
      <summary>Recent activity</summary>
      <ol id="events"></ol>
    </details>
  </main>
  <main id="workflow-panel" class="workspace-panel" hidden>
    <ol id="workflow-stages" class="workflow-stages" aria-label="SDLC stages">${workflowStages.map(stage =>
      `<li data-stage="${stage.name}" data-role="${stage.role}" data-instruction="${stage.instruction}"><strong>${stage.name}</strong><small>${stage.role}</small></li>`
    ).join('')}</ol>
    <form id="workflow-start" class="detail" hidden>
      <label>Project brief <textarea id="workflow-brief" maxlength="${workflowBriefLimit}" rows="4" required
        placeholder="What should ship? Include scope and acceptance criteria."></textarea></label>
      <button type="submit" class="primary">Start workflow</button>
    </form>
    <section id="workflow-current" class="detail" hidden>
      <div class="workspace-heading"><h2 id="workflow-title"></h2><button type="button" id="workflow-reset">Reset workflow</button></div>
      <p id="workflow-instruction" class="subtle"></p>
      <details><summary>Project brief</summary><p id="workflow-project" class="preserve-lines"></p></details>
      <div class="actions" id="workflow-actions">
        <button type="button" id="workflow-draft" class="primary">Draft with AI</button>
        <button type="button" id="workflow-copy">Copy stage brief</button>
        <button type="button" id="workflow-stop" hidden>Stop run</button>
      </div>
      <form id="workflow-approve">
        <label>Stage result <textarea id="workflow-output" rows="5" maxlength="${workflowOutputLimit}" required
          placeholder="Review the AI draft or enter the result from your terminal."></textarea></label>
        <button type="submit" id="workflow-approve-button" class="primary">Approve stage</button>
      </form>
      <p id="workflow-status" class="subtle" role="status"></p>
    </section>
    <section id="workflow-results" class="detail" hidden><h2>Approved results</h2><div id="workflow-artifacts"></div></section>
    <p id="workflow-notice" class="workspace-notice" role="status">Loading workflow…</p>
  </main>
  <main id="customizations-panel" class="workspace-panel" hidden>
    <section class="detail">
      <div class="workspace-heading"><h2>Workspace skills</h2><button type="button" id="add-skill" class="primary" disabled>Add skill</button></div>
      <p class="subtle">Enabled skills go into AI SDLC drafts and, as Claude Code skills, into every Claude Code account. Workers load a skill only when its description matches the task.</p>
      <ul class="workspace-list" id="skills"></ul>
      <form id="skill-form" hidden>
        <label>Name <input id="skill-name" maxlength="${skillNameLimit}" required></label>
        <label>When to use <input id="skill-description" maxlength="${skillDescriptionLimit}"
          placeholder="One line. Claude reads this to decide when to load the skill."></label>
        <label>Instructions <textarea id="skill-instructions" rows="6" maxlength="${skillInstructionsLimit}" required></textarea></label>
        <label class="checkbox"><input id="skill-enabled" type="checkbox"> Enabled</label>
        <div class="actions"><button type="submit" class="primary">Save skill</button><button type="button" id="cancel-skill">Cancel</button></div>
      </form>
    </section>
    <section class="detail">
      <h2>Sync</h2>
      <p id="sync-profiles" class="subtle"></p>
      <p id="sync-folder" class="subtle"></p>
      <p id="sync-last" class="subtle"></p>
      <div class="actions">
        <button type="button" id="sync-now" class="primary">Sync with folder</button>
        <button type="button" id="sync-accounts">Copy skills to Claude accounts</button>
        <button type="button" id="squad-settings">Worker settings</button>
      </div>
    </section>
    <section class="detail">
      <h2>Copilot and MCP tools</h2>
      <p id="tool-hint" class="subtle"></p>
      <ul id="squad-tools" class="workspace-list">${Object.entries(squadTools).map(([id, tool]) =>
        `<li><label class="checkbox"><input type="checkbox" id="${id}" disabled> ${tool.name}</label><code>#${tool.reference}</code></li>`
      ).join('')}</ul>
      <div id="native-customizations" class="actions" hidden>
        <button type="button" id="native-skills">VS Code Skills</button>
        <button type="button" id="native-tools">VS Code Tools and MCP</button>
      </div>
    </section>
    <section class="detail">
      <h2>xDev AI MCP</h2>
      <div class="actions"><button type="button" id="manage-mcp">Manage MCP</button></div>
    </section>
    <p id="customizations-notice" class="workspace-notice" role="status"></p>
  </main>
  <main id="memory-panel" class="workspace-panel" hidden>
    <section class="detail">
      <h2>Shared memory</h2>
      <p class="subtle">Short facts every agent receives with its task: conventions, decisions, pitfalls. Workers add notes when they learn something durable. Pinned notes always fit in the prompt; others are newest first within a fixed budget.</p>
      <form id="memory-form" class="memory-form">
        <label>New note <input id="memory-text" maxlength="${memoryTextLimit}" required placeholder="e.g. API errors use the Problem Details format"></label>
        <button type="submit" id="memory-submit" class="primary">Add</button>
      </form>
      <ul id="memory-list" class="workspace-list"></ul>
    </section>
    <p id="memory-notice" class="workspace-notice" role="status"></p>
  </main>
  <script nonce="${nonce}" src="${chatScript}"></script>
  <script nonce="${nonce}" src="${workspaceScript}"></script>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}
