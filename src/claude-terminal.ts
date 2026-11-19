import * as vscode from 'vscode';
import { join } from 'node:path';
import { ClaudeProfile, ClaudeProfiles, claudeTerminalEnv, findClaudeExecutable, validClaudeProfileName } from './claude-profiles';

type Action = 'add' | 'open' | 'signIn' | 'usage';
type AccountTarget = ClaudeAccountItem | string;

const accountsViewId = 'xdevAi.claude.accounts';

class ClaudeAccountItem extends vscode.TreeItem {
  constructor(readonly profile: ClaudeProfile) {
    super(profile.name);
    this.id = profile.configDir;
    this.contextValue = 'claudeAccount';
    this.iconPath = new vscode.ThemeIcon('account');
    this.command = { command: 'xdevAi.claude.openTerminal', title: 'Open Claude Terminal', arguments: [profile.configDir] };
  }
}

export function registerClaudeTerminals(context: vscode.ExtensionContext): void {
  const profiles = new ClaudeProfiles(join(context.globalStorageUri.fsPath, 'claude'));
  const accountsChanged = new vscode.EventEmitter<void>();
  const view = vscode.window.createTreeView<ClaudeAccountItem>(accountsViewId, {
    treeDataProvider: {
      onDidChangeTreeData: accountsChanged.event,
      getTreeItem: item => item,
      async getChildren() {
        return (await profiles.list()).map(profile => new ClaudeAccountItem(profile));
      }
    }
  });

  function askProfileName(title: string, value?: string, token?: vscode.CancellationToken) {
    return vscode.window.showInputBox({
      title,
      value,
      placeHolder: 'Ví dụ Cá nhân hoặc Công việc',
      validateInput(input) {
        return validClaudeProfileName(input.trim()) ? undefined : 'Nhập tên từ 1 đến 80 ký tự trên một dòng.';
      }
    }, token);
  }

  async function selectProfile(title: string, target?: AccountTarget, token?: vscode.CancellationToken, allowAdd = false) {
    const accounts = await profiles.list();
    const configDir = target instanceof ClaudeAccountItem ? target.profile.configDir : target;
    if (typeof configDir === 'string') {
      const profile = accounts.find(account => account.configDir === configDir);
      if (!profile) throw new Error('Không tìm thấy hồ sơ Claude.');
      return { profile };
    }
    const choices: { label: string; profile?: ClaudeProfile }[] = accounts.map(profile => ({ label: profile.name, profile }));
    if (allowAdd) choices.push({ label: '$(add) Thêm tài khoản Claude' });
    if (choices.length === 0) {
      void vscode.window.showInformationMessage('Hãy thêm tài khoản Claude trước.');
      return undefined;
    }
    return vscode.window.showQuickPick(choices, { title }, token);
  }

  async function terminalOptions(action: Action, target?: AccountTarget, token?: vscode.CancellationToken): Promise<vscode.TerminalOptions | undefined> {
    const preferred = vscode.workspace.getConfiguration('xdevAi').get<string>('claudeExecutable', '').trim();
    const cli = await findClaudeExecutable(preferred);
    if (!cli) {
      const help = 'Hướng dẫn cài Claude Code';
      const message = preferred
        ? 'Kiểm tra xdevAi.claudeExecutable. Hãy dùng đường dẫn tuyệt đối tới Claude Code trên máy chứa workspace.'
        : 'Chưa tìm thấy Claude Code trên máy chứa workspace.';
      if (await vscode.window.showErrorMessage(message, help) === help) {
        await vscode.env.openExternal(vscode.Uri.parse('https://code.claude.com/docs/en/setup'));
      }
      return;
    }
    if (token?.isCancellationRequested) return;

    let signIn = action === 'add' || action === 'signIn';
    let profile;
    if (action !== 'add') {
      const title = action === 'usage' ? 'Chọn tài khoản để xem hạn mức Claude Code' :
        signIn ? 'Chọn tài khoản để đăng nhập Claude Code' : 'Chọn tài khoản cho terminal Claude Code';
      const choice = await selectProfile(title, target, token, action !== 'usage');
      if (!choice) return;
      profile = choice.profile;
    }
    if (!profile) {
      const name = await askProfileName('Đặt tên tài khoản Claude', undefined, token);
      if (name === undefined || token?.isCancellationRequested) return;
      profile = await profiles.add(name);
      accountsChanged.fire();
      signIn = true;
    }
    if (token?.isCancellationRequested) return;

    const document = vscode.window.activeTextEditor?.document.uri;
    const folder = (document && vscode.workspace.getWorkspaceFolder(document)) ?? vscode.workspace.workspaceFolders?.[0];
    return {
      name: signIn ? `Claude · Đăng nhập · ${profile.name}` : `Claude · ${profile.name}`,
      shellPath: cli,
      shellArgs: signIn ? ['auth', 'login', '--claudeai'] : [],
      cwd: folder?.uri,
      env: claudeTerminalEnv(profile.configDir),
      isTransient: true
    };
  }

  async function prepareTerminal(action: Action, target?: AccountTarget, token?: vscode.CancellationToken) {
    try {
      return await terminalOptions(action, target, token);
    } catch (error) {
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : 'Không thể chuẩn bị terminal Claude Code.');
      return undefined;
    }
  }

  const command = (id: string, action: Action) => vscode.commands.registerCommand(id, async (target?: AccountTarget) => {
    const options = await prepareTerminal(action, target);
    if (!options) return;
    vscode.window.createTerminal(options).show();
    if (action === 'usage') {
      void vscode.window.showInformationMessage('Nhập /usage trong terminal Claude Code vừa mở để xem hạn mức tài khoản.');
    }
  });

  context.subscriptions.push(
    accountsChanged,
    view,
    view.onDidChangeVisibility(event => {
      if (event.visible) accountsChanged.fire();
    }),
    vscode.window.onDidChangeWindowState(state => {
      if (state.focused && view.visible) accountsChanged.fire();
    }),
    vscode.commands.registerCommand('xdevAi.claude.manageAccounts', () => vscode.commands.executeCommand(`${accountsViewId}.focus`)),
    command('xdevAi.claude.addAccount', 'add'),
    command('xdevAi.claude.openTerminal', 'open'),
    command('xdevAi.claude.signIn', 'signIn'),
    command('xdevAi.claude.usage', 'usage'),
    vscode.commands.registerCommand('xdevAi.claude.renameAccount', async (item?: ClaudeAccountItem) => {
      try {
        const choice = await selectProfile('Chọn tài khoản Claude để đổi tên', item);
        if (!choice?.profile) return;
        const { name, configDir } = choice.profile;
        const newName = await askProfileName('Đổi tên tài khoản Claude', name);
        if (newName === undefined || newName.trim() === name) return;
        await profiles.rename(configDir, newName);
        accountsChanged.fire();
      } catch (error) {
        void vscode.window.showErrorMessage(error instanceof Error ? error.message : 'Không thể đổi tên tài khoản Claude.');
      }
    }),
    vscode.window.registerTerminalProfileProvider('xdevAi.claude.terminal', {
      async provideTerminalProfile(token) {
        const options = await prepareTerminal('open', undefined, token);
        return options ? new vscode.TerminalProfile(options) : undefined;
      }
    })
  );
}
