import * as vscode from 'vscode';
import { join } from 'node:path';
import { ClaudeProfiles, claudeTerminalEnv, findClaudeExecutable, validClaudeProfileName } from './claude-profiles';

type Action = 'add' | 'open' | 'signIn';

export function registerClaudeTerminals(context: vscode.ExtensionContext): void {
  const profiles = new ClaudeProfiles(join(context.globalStorageUri.fsPath, 'claude'));

  async function terminalOptions(action: Action, token?: vscode.CancellationToken): Promise<vscode.TerminalOptions | undefined> {
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

    let signIn = action !== 'open';
    let profile;
    if (action !== 'add') {
      const accounts = await profiles.list();
      const choices = accounts.map(account => ({ label: account.name, account }));
      const add = { label: '$(add) Thêm tài khoản Claude', account: undefined };
      const choice = await vscode.window.showQuickPick([...choices, add], {
        title: signIn ? 'Chọn tài khoản để đăng nhập Claude Code' : 'Chọn tài khoản cho terminal Claude Code'
      }, token);
      if (!choice) return;
      profile = choice.account;
    }
    if (!profile) {
      const name = await vscode.window.showInputBox({
        title: 'Đặt tên tài khoản Claude',
        placeHolder: 'Ví dụ Cá nhân hoặc Công việc',
        validateInput(value) {
          return validClaudeProfileName(value.trim()) ? undefined : 'Nhập tên từ 1 đến 80 ký tự trên một dòng.';
        }
      }, token);
      if (name === undefined || token?.isCancellationRequested) return;
      profile = await profiles.add(name);
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

  async function prepareTerminal(action: Action, token?: vscode.CancellationToken) {
    try {
      return await terminalOptions(action, token);
    } catch (error) {
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : 'Không thể chuẩn bị terminal Claude Code.');
      return undefined;
    }
  }

  const command = (id: string, action: Action) => vscode.commands.registerCommand(id, async () => {
    const options = await prepareTerminal(action);
    if (options) vscode.window.createTerminal(options).show();
  });

  context.subscriptions.push(
    command('xdevAi.claude.addAccount', 'add'),
    command('xdevAi.claude.openTerminal', 'open'),
    command('xdevAi.claude.signIn', 'signIn'),
    vscode.window.registerTerminalProfileProvider('xdevAi.claude.terminal', {
      async provideTerminalProfile(token) {
        const options = await prepareTerminal('open', token);
        return options ? new vscode.TerminalProfile(options) : undefined;
      }
    })
  );
}
