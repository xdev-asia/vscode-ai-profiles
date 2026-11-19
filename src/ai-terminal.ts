import { extname, join } from 'node:path';
import * as vscode from 'vscode';
import { claudeLoginScript } from './claude-login';
import {
  findTerminalExecutable, terminalArguments, terminalProfileEnv, terminalProfileId, terminalProviderIds, terminalProviders,
  validTerminalProfileName, type TerminalProfile, type TerminalProfiles, type TerminalProvider
} from './terminal-profiles';

type Action = 'add' | 'open' | 'bypass' | 'signIn' | 'usage' | 'rename' | 'remove';
type AccountTarget = TerminalAccountItem | string;
const accountsViewId = 'xdevAi.claude.accounts';

class TerminalAccountItem extends vscode.TreeItem {
  constructor(readonly profile: TerminalProfile) {
    super(profile.name);
    this.id = terminalProfileId(profile);
    this.description = terminalProviders[profile.provider].name;
    this.contextValue = 'aiTerminalAccount';
    this.iconPath = new vscode.ThemeIcon('account');
    this.command = { command: 'xdevAi.openTerminal', title: 'Open AI Terminal', arguments: [this.id] };
  }
}

export function registerAiTerminals(context: vscode.ExtensionContext, profiles: TerminalProfiles): vscode.Event<void> {
  const accountsChanged = new vscode.EventEmitter<void>();
  const view = vscode.window.createTreeView<TerminalAccountItem>(accountsViewId, {
    treeDataProvider: {
      onDidChangeTreeData: accountsChanged.event,
      getTreeItem: item => item,
      async getChildren() {
        return (await profiles.list()).map(profile => new TerminalAccountItem(profile));
      }
    }
  });
  const shortcut = vscode.window.createStatusBarItem('xdevAi.accounts', vscode.StatusBarAlignment.Right, 35);
  shortcut.name = 'xDev AI Accounts';
  shortcut.text = '$(account) xDev AI';
  shortcut.tooltip = 'Choose an AI terminal account or add a profile';
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
      remove: 'Choose a terminal account to delete'
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
    action: Exclude<Action, 'rename' | 'remove'>,
    target?: AccountTarget,
    token?: vscode.CancellationToken,
    provider?: TerminalProvider
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

    if (bypass) {
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
    let shellPath = cli;
    let shellArgs = args;
    if (process.platform === 'win32' && extname(cli).toLowerCase() === '.cmd') {
      shellPath = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      env.XDEV_AI_CLI_PATH = cli;
      // Only fixed provider arguments reach this PowerShell command.
      const argumentsLiteral = args.map(argument => `'${argument}'`).join(' ');
      shellArgs = ['-NoLogo', '-NoProfile', '-Command', `& $env:XDEV_AI_CLI_PATH ${argumentsLiteral}; exit $LASTEXITCODE`];
    }
    if (provider === 'claude' && signIn && process.platform !== 'win32') {
      env.XDEV_AI_CLI_PATH = cli;
      shellPath = '/bin/sh';
      shellArgs = ['-c', claudeLoginScript];
    }
    const document = vscode.window.activeTextEditor?.document.uri;
    const folder = (document && vscode.workspace.getWorkspaceFolder(document)) ?? vscode.workspace.workspaceFolders?.[0];
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

  async function run(action: Action, provider?: TerminalProvider, target?: AccountTarget): Promise<void> {
    try {
      if (action === 'remove') {
        const profile = (await selectProfile(action, provider, target))?.profile;
        if (!profile) return;
        const choice = 'Delete Account';
        if (await vscode.window.showWarningMessage(`Delete “${profile.name}” (${terminalProviders[profile.provider].name})?`, {
          modal: true,
          detail: 'This closes its terminals and deletes the local profile, sign-in data, and CLI history stored in its directory.'
        }, choice) !== choice) return;
        const profileEnvironment = terminalProfileEnv(profile);
        for (const terminal of vscode.window.terminals) {
          const options = terminal.creationOptions;
          if ('env' in options && options.env && Object.entries(profileEnvironment).some(([key, value]) =>
            value === profile.configDir && options.env?.[key] === value)) terminal.dispose();
        }
        try {
          await profiles.remove(profile);
        } finally {
          accountsChanged.fire();
        }
        return;
      }
      if (action === 'rename') {
        const profile = (await selectProfile(action, provider, target))?.profile;
        if (!profile) return;
        const name = await askProfileName('Rename AI terminal account', undefined, profile.name);
        if (name === undefined || name.trim() === profile.name) return;
        await profiles.rename(profile, name);
        accountsChanged.fire();
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
  return accountsChanged.event;
}
