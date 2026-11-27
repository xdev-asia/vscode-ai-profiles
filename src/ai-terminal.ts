import { unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';
import * as vscode from 'vscode';
import { exportAccounts, importAccounts, readAccountFile, validPassphrase } from './account-transfer';
import { canCaptureClaudeQuota, claudeQuotaFile, type AccountUsage, type UsageWindow } from './account-usage';
import { claudeLoginScript } from './claude-login';
import {
  findTerminalExecutable, normalizeNote, normalizeTags, terminalArguments, terminalProfileEnv, terminalProfileId, terminalProviderIds, terminalProviders,
  validTerminalProfileName, type TerminalProfile, type TerminalProfiles, type TerminalProvider
} from './terminal-profiles';
import { highestUse, planLabel, registerUsageStatus, type UsageStatus } from './usage-status';
import type { AuditLog } from './audit';
import { mcpControl } from './mcp-control';

type Action = 'add' | 'open' | 'bypass' | 'signIn' | 'usage' | 'rename' | 'remove' | 'edit';

/** What other parts of xDev AI, such as MCP, can do with terminal accounts. */
export interface TerminalAccounts {
  onDidChange: vscode.Event<void>;
  usage: UsageStatus;
  /** Notifies views that an account changed outside this module. */
  changed(): void;
  /**
   * Runs an account action for the account id without asking which account. `remove` and `bypass` still ask the
   * user to confirm, unless `confirmed` says the user already did so elsewhere. Resolves false when the user
   * cancels; throws when the action fails.
   */
  perform(action: 'open' | 'bypass' | 'signIn' | 'remove', id: string, confirmed?: boolean): Promise<boolean>;
}
type AccountTarget = TerminalAccountItem | string;
type AccountTreeItem = TerminalAccountItem | UsageWindowItem;
const accountsViewId = 'xdevAi.claude.accounts';

class TerminalAccountItem extends vscode.TreeItem {
  constructor(readonly profile: TerminalProfile, usageStatus?: UsageStatus) {
    super(profile.name);
    this.id = terminalProfileId(profile);
    const provider = terminalProviders[profile.provider].name;
    const usage = usageStatus?.usage(this.id);
    const plan = usage?.signedOut ? 'Sign-in required' : planLabel(usage?.plan, usage?.seat);
    const tags = profile.tags?.map(tag => `#${tag}`).join(' ');
    this.description = [profile.disabled ? 'Disabled' : '', provider, plan, tags].filter(Boolean).join(' · ');
    this.tooltip = [
      profile.name, provider,
      `Plan: ${plan ?? (profile.provider === 'gemini' || usage ? 'Not reported' : 'Checking…')}`,
      profile.disabled ? 'Disabled: left out of the Squad pool and MCP account picks' : '',
      tags ? `Tags: ${tags}` : '',
      profile.lastUsedAt ? `Last opened ${new Date(profile.lastUsedAt).toLocaleString()}` : '',
      profile.note ? `\n${profile.note}` : ''
    ].filter(Boolean).join('\n');
    this.contextValue = 'aiTerminalAccount';
    this.iconPath = profile.disabled ? new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('disabledForeground'))
      : usage?.signedOut ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.yellow'))
        : new vscode.ThemeIcon('account');
    this.command = { command: 'xdevAi.openTerminal', title: 'Open AI Terminal', arguments: [this.id] };
    this.windows = usageRows(profile, usage);
    this.collapsibleState = this.windows.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None;
  }

  readonly windows: UsageRow[];
}

/**
 * Every Claude and Codex account shows its own 5h and weekly rows. A window missing from the latest sample has
 * reset (or not started yet), so it shows 0% until the next sample. A Codex Premium seat has no 5h window.
 */
type UsageRow = UsageWindow & { idle?: boolean };

function usageRows(profile: TerminalProfile, usage: AccountUsage | undefined): UsageRow[] {
  if (!usage || usage.signedOut || profile.provider === 'gemini') return [];
  const windows = usage.windows.filter(window => !window.resetsAt || window.resetsAt > Date.now());
  if (!windows.length && usage.observedAt === undefined && profile.provider === 'claude') return [];
  const required = profile.provider === 'codex' && usage.seat === 'premium' ? ['7d'] : ['5h', '7d'];
  const missing = required.filter(label => !windows.some(window => window.label === label));
  return [...missing.map(label => ({ label, used: 0, idle: true })), ...windows]
    .sort((a, b) => rank(a.label) - rank(b.label));
}

function rank(label: string): number {
  return label === '5h' ? 0 : label === '7d' ? 1 : 2;
}

function resetLabel(resetsAt: number): string {
  const reset = new Date(resetsAt);
  const time = reset.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return reset.toDateString() === new Date().toDateString() ? time : `${reset.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
}

class UsageWindowItem extends vscode.TreeItem {
  constructor(accountId: string, window: UsageRow) {
    super(window.label === '7d' ? 'Week' : window.label);
    this.id = `${accountId}:usage:${window.label}`;
    const used = Math.min(100, Math.max(0, window.used));
    const filled = Math.round(used / 10);
    const percent = `${Number(window.used.toFixed(1))}%`;
    const full = window.used >= 100;
    const reset = window.resetsAt
      ? `${full ? 'available again' : 'resets'} ${resetLabel(window.resetsAt)}`
      : window.idle ? 'reset · starts with next use' : '';
    this.description = `${'█'.repeat(filled)}${'░'.repeat(10 - filled)} ${full ? 'Full' : percent}${reset ? ` · ${reset}` : ''}`;
    this.tooltip = `${window.label} · ${percent} used${window.resetsAt ? `\n${full ? 'Available again' : 'Resets'} ${new Date(window.resetsAt).toLocaleString()}` : window.idle ? '\nThis window has reset. The timer starts with the next request.' : ''}`;
    this.contextValue = 'aiTerminalUsage';
    this.iconPath = new vscode.ThemeIcon(used >= 90 ? 'error' : used >= 70 ? 'warning' : 'pulse',
      used >= 90 ? new vscode.ThemeColor('charts.red') : used >= 70 ? new vscode.ThemeColor('charts.yellow') : undefined);
  }
}

export function registerAiTerminals(context: vscode.ExtensionContext, profiles: TerminalProfiles, audit?: AuditLog): TerminalAccounts {
  const accountsChanged = new vscode.EventEmitter<void>();
  const treeChanged = new vscode.EventEmitter<void>();
  let usageStatus: UsageStatus | undefined;
  const view = vscode.window.createTreeView<AccountTreeItem>(accountsViewId, {
    treeDataProvider: {
      onDidChangeTreeData: treeChanged.event,
      getTreeItem: item => item,
      async getChildren(element) {
        if (element instanceof TerminalAccountItem) return element.windows.map(window => new UsageWindowItem(element.id!, window));
        if (element) return [];
        return (await profiles.list()).map(profile => new TerminalAccountItem(profile, usageStatus));
      }
    }
  });
  const shortcut = vscode.window.createStatusBarItem('xdevAi.accounts', vscode.StatusBarAlignment.Right, 35);
  shortcut.name = 'xDev AI Accounts';
  shortcut.text = '$(account) xDev AI';
  shortcut.tooltip = 'Loading account quota…';
  shortcut.command = 'xdevAi.openTerminal';
  shortcut.show();

  function askProfileName(title: string, token?: vscode.CancellationToken, value?: string) {
    return vscode.window.showInputBox({
      title,
      value,
      placeHolder: 'Personal or Work',
      validateInput(input) {
        return validTerminalProfileName(input.trim()) ? undefined : 'Enter a name of 1 to 80 characters on one line.';
      }
    }, token);
  }

  async function selectProfile(
    action: Action,
    provider?: TerminalProvider,
    target?: AccountTarget,
    token?: vscode.CancellationToken
  ): Promise<{ profile?: TerminalProfile } | undefined> {
    const accounts = await profiles.list(provider);
    const id = target instanceof TerminalAccountItem ? target.id : target;
    if (typeof id === 'string') {
      const profile = accounts.find(account => terminalProfileId(account) === id || account.configDir === id);
      if (!profile) throw new Error('This AI terminal profile is no longer available.');
      return { profile };
    }
    const title = {
      add: 'Add AI Account', open: 'Choose an AI terminal account', signIn: 'Choose an account to sign in',
      bypass: 'Choose an account for a bypass session', usage: 'Choose an account to check usage', rename: 'Choose an account to rename',
      remove: 'Choose a terminal account to delete', edit: 'Choose a terminal account to edit'
    }[action];
    const choices: (vscode.QuickPickItem & { profile?: TerminalProfile })[] = accounts.map(profile => ({
      label: profile.name,
      description: terminalProviders[profile.provider].name,
      profile
    }));
    if (action === 'open' || action === 'signIn') choices.push({ label: '$(add) Add AI Account' });
    if (!choices.length) {
      void vscode.window.showInformationMessage('Add an AI terminal account first.');
      return;
    }
    return vscode.window.showQuickPick(choices, { title, matchOnDescription: true }, token);
  }

  async function selectProvider(token?: vscode.CancellationToken) {
    const choices: (vscode.QuickPickItem & { provider?: TerminalProvider })[] = terminalProviderIds.map(provider => ({
      label: terminalProviders[provider].name, description: 'Sign in for a terminal', provider
    }));
    choices.push({ label: 'API Profile', description: 'OpenAI, Anthropic, Gemini, or a compatible API for Squad Chat' });
    const choice = await vscode.window.showQuickPick(choices, { title: 'Add AI Account', matchOnDescription: true }, token);
    if (choice && !choice.provider && !token?.isCancellationRequested) {
      await vscode.commands.executeCommand('xdevAi.addAccount');
    }
    return choice?.provider;
  }

  async function prepareTerminal(
    action: Exclude<Action, 'rename' | 'remove' | 'edit'>,
    target?: AccountTarget,
    token?: vscode.CancellationToken,
    provider?: TerminalProvider,
    confirmed = false
  ): Promise<{ options: vscode.TerminalOptions; provider: TerminalProvider; signIn: boolean } | undefined> {
    const bypass = action === 'bypass';
    if (bypass && !vscode.workspace.isTrusted) throw new Error('Trust this workspace before opening a bypass session.');
    let profile: TerminalProfile | undefined;
    if (action !== 'add') {
      const choice = await selectProfile(action, provider, target, token);
      if (!choice) return;
      profile = choice.profile;
    }
    provider = profile?.provider ?? provider ?? await selectProvider(token);
    if (!provider || token?.isCancellationRequested) return;

    const { name, setup } = terminalProviders[provider];
    const key = `${provider}Executable`;
    const preferred = vscode.workspace.getConfiguration('xdevAi').get<string>(key, '').trim();
    const cli = await findTerminalExecutable(provider, preferred);
    if (!cli) {
      const help = 'Installation instructions';
      const message = preferred
        ? `Set xdevAi.${key} to an absolute executable path on the workspace host.`
        : `${name} was not found on the workspace host.`;
      if (await vscode.window.showErrorMessage(message, help) === help) {
        await vscode.env.openExternal(vscode.Uri.parse(setup));
      }
      return;
    }
    if (token?.isCancellationRequested) return;

    const signIn = !profile || action === 'signIn';
    if (!profile) {
      const label = await askProfileName(`Name the ${name} account`, token);
      if (label === undefined || token?.isCancellationRequested) return;
      profile = await profiles.add(provider, label);
      accountsChanged.fire();
    }
    if (token?.isCancellationRequested) return;

    if (bypass && !confirmed) {
      const open = 'Open with Bypass';
      if (await vscode.window.showWarningMessage(`Open ${name} for “${profile.name}” with bypass permissions?`, {
        modal: true,
        detail: provider === 'codex'
          ? 'This session skips approval prompts and disables the Codex sandbox on the workspace host.'
          : 'This session enables the CLI’s automatic tool approvals on the workspace host.'
      }, open) !== open || token?.isCancellationRequested) return;
    }
    const remote = Boolean(vscode.env.remoteName) || vscode.env.uiKind === vscode.UIKind.Web;
    const args = terminalArguments(provider, signIn ? 'signIn' : bypass ? 'bypass' : 'open', remote);
    const env = terminalProfileEnv(profile);
    // The address and token of xDev AI MCP, which a .mcp.json written by "Set up for this folder" refers to.
    Object.assign(env, await mcpControl()?.environment().catch(() => ({})));
    const document = vscode.window.activeTextEditor?.document.uri;
    const folder = (document && vscode.workspace.getWorkspaceFolder(document)) ?? vscode.workspace.workspaceFolders?.[0];
    if (provider === 'claude' && signIn) await unlink(join(profile.configDir, claudeQuotaFile)).catch(() => undefined);
    if (provider === 'claude' && vscode.workspace.isTrusted && await canCaptureClaudeQuota(profile.configDir, folder?.uri.fsPath ?? homedir())) {
      const settings = context.asAbsolutePath('media/claude-quota-settings.json');
      env.XDEV_AI_QUOTA_HOOK = context.asAbsolutePath('media/claude-quota.cjs');
      if (!signIn) args.push('--settings', settings);
      if (signIn && process.platform !== 'win32') env.XDEV_AI_CLAUDE_QUOTA_SETTINGS = settings;
    }
    let shellPath = cli;
    let shellArgs = args;
    if (process.platform === 'win32' && extname(cli).toLowerCase() === '.cmd') {
      shellPath = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      env.XDEV_AI_CLI_PATH = cli;
      const argumentsLiteral = args.map(argument => `'${argument.replace(/'/g, "''")}'`).join(' ');
      shellArgs = ['-NoLogo', '-NoProfile', '-Command', `& $env:XDEV_AI_CLI_PATH ${argumentsLiteral}; exit $LASTEXITCODE`];
    }
    if (provider === 'claude' && signIn && process.platform !== 'win32') {
      env.XDEV_AI_CLI_PATH = cli;
      shellPath = '/bin/sh';
      shellArgs = ['-c', claudeLoginScript];
    }
    void profiles.touch(profile);
    return {
      provider,
      signIn,
      options: {
        name: [name, signIn ? 'Sign in' : bypass ? 'Bypass' : '', profile.name].filter(Boolean).join(' · '),
        shellPath,
        shellArgs,
        cwd: folder?.uri,
        env,
        isTransient: true
      }
    };
  }

  /** Runs an action and resolves false when the user cancels. Errors are thrown to the caller. */
  async function perform(
    action: Action, provider?: TerminalProvider, target?: AccountTarget, source: 'user' | 'mcp' = 'user', confirmed = false
  ): Promise<boolean> {
    if (action === 'remove') {
      const profile = (await selectProfile(action, provider, target))?.profile;
      if (!profile) return false;
      const choice = 'Delete Account';
      if (!confirmed && await vscode.window.showWarningMessage(`Delete “${profile.name}” (${terminalProviders[profile.provider].name})?`, {
        modal: true,
        detail: `${source === 'mcp' ? 'An AI client connected through xDev AI MCP asked for this. ' : ''}This closes its terminals and deletes the local profile, sign-in data, and CLI history stored in its directory.`
      }, choice) !== choice) return false;
      const profileEnvironment = terminalProfileEnv(profile);
      for (const terminal of vscode.window.terminals) {
        const options = terminal.creationOptions;
        if ('env' in options && options.env && Object.entries(profileEnvironment).some(([key, value]) =>
          value === profile.configDir && options.env?.[key] === value)) terminal.dispose();
      }
      try {
        await profiles.remove(profile);
        if (source === 'user') void audit?.record('user', 'terminal_remove', true, { id: terminalProfileId(profile), name: profile.name });
      } finally {
        accountsChanged.fire();
      }
      return true;
    }
    if (action === 'rename') {
      const profile = (await selectProfile(action, provider, target))?.profile;
      if (!profile) return false;
      const name = await askProfileName('Rename AI terminal account', undefined, profile.name);
      if (name === undefined || name.trim() === profile.name) return false;
      await profiles.rename(profile, name);
      accountsChanged.fire();
      return true;
    }
    if (action === 'edit') return false;
    const terminal = await prepareTerminal(action, target, undefined, provider, confirmed);
    if (!terminal) return false;
    vscode.window.createTerminal(terminal.options).show();
    return true;
  }

  async function run(action: Action, provider?: TerminalProvider, target?: AccountTarget): Promise<void> {
    try {
      if (action === 'remove' || action === 'rename' || action === 'edit') {
        await perform(action, provider, target);
        return;
      }
      const terminal = await prepareTerminal(action, target, undefined, provider);
      if (!terminal) return;
      vscode.window.createTerminal(terminal.options).show();
      if (action === 'usage') {
        const { name, usage } = terminalProviders[terminal.provider];
        void vscode.window.showInformationMessage(`Enter ${usage} in the ${name} terminal to check usage.`);
      }
      if (terminal.provider === 'gemini' && terminal.signIn) {
        void vscode.window.showInformationMessage('Choose Sign in with Google in Gemini CLI. For an existing session, enter /auth to switch accounts.');
      }
      if (terminal.provider === 'claude' && terminal.signIn && (vscode.env.remoteName || vscode.env.uiKind === vscode.UIKind.Web)) {
        void vscode.window.showInformationMessage('Open the URL from the Claude terminal in your browser, then paste the code in that same terminal if prompted.');
      }
    } catch (error) {
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : 'Unable to open the AI terminal.');
    }
  }

  async function askPassphrase(title: string, prompt: string, confirm: boolean): Promise<string | undefined> {
    const passphrase = await vscode.window.showInputBox({
      title, prompt, password: true, ignoreFocusOut: true,
      validateInput: input => validPassphrase(input) ? undefined : 'Use at least 8 characters.'
    });
    if (passphrase === undefined || !confirm) return passphrase;
    const again = await vscode.window.showInputBox({
      title, prompt: 'Enter the passphrase again.', password: true, ignoreFocusOut: true,
      validateInput: input => input === passphrase ? undefined : 'The passphrases do not match.'
    });
    return again === undefined ? undefined : passphrase;
  }

  async function exportCommand(target?: AccountTarget): Promise<void> {
    try {
      const accounts = await profiles.list();
      if (!accounts.length) {
        void vscode.window.showInformationMessage('Add an AI terminal account first.');
        return;
      }
      const preselected = target instanceof TerminalAccountItem ? target.id : undefined;
      const picked = await vscode.window.showQuickPick(accounts.map(profile => ({
        label: profile.name, description: terminalProviders[profile.provider].name, profile,
        picked: preselected ? terminalProfileId(profile) === preselected : true
      })), { title: 'Export AI Accounts', placeHolder: 'Choose the accounts to export', canPickMany: true, matchOnDescription: true });
      if (!picked?.length) return;
      const proceed = 'Continue';
      if (await vscode.window.showWarningMessage('The file holds these accounts’ sign-in tokens.', {
        modal: true,
        detail: 'Anyone with the file and its passphrase can use the accounts. Signing in to the same account on two machines can sign one of them out when its token renews.'
      }, proceed) !== proceed) return;
      const passphrase = await askPassphrase('Export AI Accounts', 'A passphrase to encrypt the file (at least 8 characters). You need it to import.', true);
      if (passphrase === undefined) return;
      const uri = await vscode.window.showSaveDialog({
        title: 'Export AI Accounts',
        defaultUri: vscode.Uri.joinPath(vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(homedir()), 'xdev-ai-accounts.xdevai'),
        filters: { 'xDev AI accounts': ['xdevai'] }
      });
      if (!uri) return;
      const result = await exportAccounts(picked.map(item => item.profile), passphrase);
      await vscode.workspace.fs.writeFile(uri, result.content);
      void audit?.record('user', 'terminal_export', true, { accounts: picked.map(item => terminalProfileId(item.profile)) });
      const missing = result.withoutSignIn.length ? ` No sign-in file for ${result.withoutSignIn.join(', ')}: sign in again after importing.` : '';
      void vscode.window.showInformationMessage(`Exported ${picked.length} account${picked.length === 1 ? '' : 's'}.${missing}`);
    } catch (error) {
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : 'Unable to export the accounts.');
    }
  }

  async function importCommand(): Promise<void> {
    try {
      const [uri] = await vscode.window.showOpenDialog({
        title: 'Import AI Accounts', canSelectMany: false, openLabel: 'Import',
        filters: { 'xDev AI accounts': ['xdevai'], 'All files': ['*'] }
      }) ?? [];
      if (!uri) return;
      const content = await vscode.workspace.fs.readFile(uri);
      const passphrase = await askPassphrase('Import AI Accounts', 'The passphrase used to export this file.', false);
      if (passphrase === undefined) return;
      const accounts = await readAccountFile(content, passphrase);
      const list = accounts.map(account => `${account.name} (${terminalProviders[account.provider].name})${account.signedIn ? '' : ' – sign in again'}`).join('\n');
      const add = 'Import';
      if (await vscode.window.showInformationMessage(`Import ${accounts.length} account${accounts.length === 1 ? '' : 's'}?`, {
        modal: true, detail: `${list}\n\nEach one is added as a new account; a name already in use gets a number.`
      }, add) !== add) return;
      try {
        const imported = await importAccounts(profiles, content, passphrase);
        void audit?.record('user', 'terminal_import', true, { accounts: imported.map(terminalProfileId) });
      } finally {
        accountsChanged.fire();
      }
      void vscode.window.showInformationMessage(`Imported ${accounts.length} account${accounts.length === 1 ? '' : 's'}.`);
    } catch (error) {
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : 'Unable to import the accounts.');
    }
  }

  async function editMetadata(field: 'tags' | 'note' | 'disabled', target?: AccountTarget): Promise<void> {
    try {
      const profile = (await selectProfile('edit', undefined, target))?.profile;
      if (!profile) return;
      if (field === 'disabled') {
        await profiles.setMetadata(profile, { disabled: !profile.disabled });
      } else if (field === 'tags') {
        const input = await vscode.window.showInputBox({
          title: `Tags for “${profile.name}”`, value: profile.tags?.join(', ') ?? '', placeHolder: 'work, team-a, backup',
          prompt: 'Separate tags with commas. Leave empty to clear them.',
          validateInput(value) {
            try { normalizeTags(value.split(',')); return undefined; } catch (error) { return (error as Error).message; }
          }
        });
        if (input === undefined) return;
        await profiles.setMetadata(profile, { tags: input.split(',') });
      } else {
        const input = await vscode.window.showInputBox({
          title: `Note for “${profile.name}”`, value: profile.note ?? '', prompt: 'Owner, purpose, or renewal date. Leave empty to clear it.',
          validateInput(value) {
            try { normalizeNote(value); return undefined; } catch (error) { return (error as Error).message; }
          }
        });
        if (input === undefined) return;
        await profiles.setMetadata(profile, { note: input });
      }
      accountsChanged.fire();
    } catch (error) {
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : 'Unable to update the account.');
    }
  }

  async function checkHealth(): Promise<void> {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Checking AI accounts…' },
      () => usageStatus!.refresh(true));
    const accounts = await profiles.list();
    if (!accounts.length) {
      void vscode.window.showInformationMessage('Add an AI terminal account first.');
      return;
    }
    const threshold = vscode.workspace.getConfiguration('xdevAi').get<number>('quotaAlertPercent', 90) || 90;
    const items = accounts.map(profile => {
      const usage = usageStatus!.usage(terminalProfileId(profile));
      const used = highestUse(usage);
      const state = profile.disabled ? 0 : usage?.signedOut ? 3 : used !== undefined && used >= threshold ? 2 : 1;
      const icon = ['$(circle-slash)', '$(pass)', '$(warning)', '$(error)'][state];
      const detail = profile.disabled ? 'Disabled' : usage?.signedOut ? 'Sign-in required'
        : used !== undefined ? `Highest window ${Number(used.toFixed(1))}% used` : 'No quota reading';
      return {
        label: `${icon} ${profile.name}`, state, profile,
        description: [terminalProviders[profile.provider].name, planLabel(usage?.plan, usage?.seat), ...(profile.tags ?? []).map(tag => `#${tag}`)].filter(Boolean).join(' · '),
        detail
      };
    }).sort((a, b) => b.state - a.state || a.profile.name.localeCompare(b.profile.name, 'vi'));
    const problems = items.filter(item => item.state >= 2).length;
    const choice = await vscode.window.showQuickPick(items, {
      title: `AI account health · ${problems ? `${problems} need attention` : 'All good'}`,
      placeHolder: 'Choose an account to open its terminal, or to sign in when it needs to', matchOnDescription: true, matchOnDetail: true
    });
    if (choice) await run(choice.state === 3 ? 'signIn' : 'open', undefined, terminalProfileId(choice.profile));
  }

  const command = (id: string, action: Action, provider?: TerminalProvider) =>
    vscode.commands.registerCommand(id, (target?: AccountTarget) => run(action, provider, target));
  const focus = () => vscode.commands.executeCommand(`${accountsViewId}.focus`);
  const terminalProvider = (provider?: TerminalProvider, action: 'open' | 'bypass' = 'open'): vscode.TerminalProfileProvider => ({
    async provideTerminalProfile(token) {
      try {
        const terminal = await prepareTerminal(action, undefined, token, provider);
        return terminal ? new vscode.TerminalProfile(terminal.options) : undefined;
      } catch (error) {
        void vscode.window.showErrorMessage(error instanceof Error ? error.message : 'Unable to open the AI terminal.');
        return;
      }
    }
  });
  context.subscriptions.push(
    accountsChanged,
    treeChanged,
    accountsChanged.event(() => treeChanged.fire()),
    view,
    shortcut,
    view.onDidChangeVisibility(event => {
      if (event.visible) accountsChanged.fire();
    }),
    vscode.window.onDidChangeWindowState(state => {
      if (state.focused && view.visible) accountsChanged.fire();
    }),
    vscode.commands.registerCommand('xdevAi.manageTerminalAccounts', focus),
    command('xdevAi.addAiAccount', 'add'),
    command('xdevAi.openTerminal', 'open'),
    command('xdevAi.openTerminalBypass', 'bypass'),
    command('xdevAi.signInTerminal', 'signIn'),
    command('xdevAi.checkUsage', 'usage'),
    command('xdevAi.renameTerminalAccount', 'rename'),
    command('xdevAi.removeTerminalAccount', 'remove'),
    vscode.commands.registerCommand('xdevAi.exportTerminalAccounts', (target?: AccountTarget) => exportCommand(target)),
    vscode.commands.registerCommand('xdevAi.importTerminalAccounts', () => importCommand()),
    vscode.commands.registerCommand('xdevAi.editTerminalAccountTags', (target?: AccountTarget) => editMetadata('tags', target)),
    vscode.commands.registerCommand('xdevAi.editTerminalAccountNote', (target?: AccountTarget) => editMetadata('note', target)),
    vscode.commands.registerCommand('xdevAi.toggleTerminalAccount', (target?: AccountTarget) => editMetadata('disabled', target)),
    vscode.commands.registerCommand('xdevAi.checkAccountHealth', () => checkHealth()),
    vscode.window.registerTerminalProfileProvider('xdevAi.terminal', terminalProvider()),
    vscode.window.registerTerminalProfileProvider('xdevAi.terminal.bypass', terminalProvider(undefined, 'bypass')),
    // Keep the commands and profile used by older VS Code settings and workflows.
    vscode.commands.registerCommand('xdevAi.claude.manageAccounts', focus),
    command('xdevAi.claude.addAccount', 'add', 'claude'),
    command('xdevAi.claude.openTerminal', 'open', 'claude'),
    command('xdevAi.claude.signIn', 'signIn', 'claude'),
    command('xdevAi.claude.usage', 'usage', 'claude'),
    command('xdevAi.claude.renameAccount', 'rename', 'claude'),
    vscode.window.registerTerminalProfileProvider('xdevAi.claude.terminal', terminalProvider('claude'))
  );
  usageStatus = registerUsageStatus(context, shortcut, profiles, accountsChanged.event);
  context.subscriptions.push(usageStatus.onDidChange(() => treeChanged.fire()));
  return {
    onDidChange: accountsChanged.event,
    usage: usageStatus,
    changed: () => accountsChanged.fire(),
    perform: (action, id, confirmed) => perform(action, undefined, id, 'mcp', confirmed === true)
  };
}
