import * as vscode from 'vscode';
import { join } from 'node:path';
import { Accounts, accountStorageKey, summarize, type Account, type AccountSummary } from './accounts';
import { TerminalProfiles } from './terminal-profiles';
import { registerAiTerminals } from './ai-terminal';
import { ChatPanel } from './panel';
import { registerChatModels } from './chat-model-provider';
import { registerSquad } from './squad-view';
import { registerXdevMcp } from './mcp';
import { AuditLog } from './audit';
import { chat, normalizeBaseUrl, providers, type ChatMessage, type ChatOptions, type Provider } from './core';

export interface XDevAI {
  listAccounts(): Promise<AccountSummary[]>;
  chat(messages: readonly ChatMessage[], options?: ChatOptions & { accountId?: string }): Promise<string>;
}

class ApiAccountItem extends vscode.TreeItem {
  constructor(account: Account, active: boolean) {
    super(account.name);
    this.id = account.id;
    this.description = `${providers[account.provider].name} · ${account.model}`;
    this.tooltip = `${account.name} · ${this.description}${active ? ' (active)' : ''}`;
    this.iconPath = new vscode.ThemeIcon(active ? 'pass-filled' : 'key');
    this.contextValue = 'aiApiAccount';
    this.command = { command: 'xdevAi.openAccountChat', title: 'Open API Chat with this Profile', arguments: [account.id] };
  }
}

type ApiAccountTarget = ApiAccountItem | string;

const required = (value: string) => value.trim() ? undefined : 'Trường này cần được điền.';
const validKey = (value: string) =>
  !value.trim() || /^[\x21-\x7e]+$/.test(value.trim()) ? undefined : 'API key chứa ký tự không hợp lệ.';

/** Details an MCP client may fill in. The API key is always entered by the user in VS Code. */
export interface ApiProfilePreset {
  provider: Provider;
  name: string;
  model: string;
  baseUrl?: string;
}

async function addAccount(accounts: Accounts, preset?: ApiProfilePreset): Promise<boolean> {
  let provider: Provider;
  let name: string | undefined;
  let baseUrl: string | undefined;
  let model: string | undefined;
  if (preset) {
    ({ provider, name, model } = preset);
    if (provider === 'compatible') baseUrl = normalizeBaseUrl(preset.baseUrl ?? '');
  } else {
    const choices = (Object.keys(providers) as Provider[]).map(provider => ({
      label: providers[provider].name,
      provider
    }));
    const choice = await vscode.window.showQuickPick(choices, { title: 'Chọn nhà cung cấp AI' });
    if (!choice) return false;
    provider = choice.provider;
    name = await vscode.window.showInputBox({
      title: 'Đặt tên hồ sơ', value: choice.label, validateInput: required
    });
    if (name === undefined) return false;
  }

  if (provider === 'compatible' && !baseUrl) {
    const url = await vscode.window.showInputBox({
      title: 'API base URL',
      placeHolder: 'http://127.0.0.1:11434/v1',
      validateInput(value) {
        try {
          normalizeBaseUrl(value);
          return undefined;
        } catch (error) {
          return (error as Error).message;
        }
      }
    });
    if (url === undefined) return false;
    baseUrl = normalizeBaseUrl(url);
  }

  model ??= await vscode.window.showInputBox({
    title: 'Nhập model ID', prompt: 'Dùng ID model mà hồ sơ này có quyền truy cập.', validateInput: required
  });
  if (model === undefined) return false;

  const apiKey = await vscode.window.showInputBox({
    title: preset ? `Nhập API key cho “${name}”` : 'Nhập API key',
    prompt: [
      preset ? `Yêu cầu từ AI client qua xDev AI MCP: ${providers[provider].name} · ${model}. Khóa không được gửi cho AI client.` : '',
      baseUrl ? `Khóa sẽ được gửi đến ${baseUrl}. Để trống nếu endpoint không cần khóa.` : ''
    ].filter(Boolean).join(' ') || undefined,
    password: true,
    ignoreFocusOut: true,
    validateInput: value => (provider === 'compatible' ? undefined : required(value)) ?? validKey(value)
  });
  if (apiKey === undefined) return false;

  await accounts.add({ name: name.trim(), provider, model: model.trim(), baseUrl, apiKey: apiKey.trim() || undefined });
  return true;
}

async function pickAccount(accounts: Accounts, title: string, target?: ApiAccountTarget): Promise<Account | undefined> {
  const { accounts: available, activeId } = await accounts.read();
  const id = target instanceof ApiAccountItem ? target.id : target;
  if (typeof id === 'string') {
    const account = available.find(candidate => candidate.id === id);
    if (!account) throw new Error('This API profile is no longer available.');
    return account;
  }
  if (!available.length) {
    const add = 'Thêm hồ sơ';
    if (await vscode.window.showInformationMessage('Chưa có hồ sơ AI.', add) === add) {
      await addAccount(accounts);
    }
    return;
  }
  const choice = await vscode.window.showQuickPick(available.map(account => ({
    label: account.name,
    description: `${providers[account.provider].name} · ${account.model}`,
    detail: account.id === activeId ? 'Đang sử dụng' : account.baseUrl,
    account
  })), { title, matchOnDescription: true });
  return choice?.account;
}

async function manageAccounts(accounts: Accounts, item?: ApiAccountTarget): Promise<void> {
  const account = await pickAccount(accounts, 'Chọn hồ sơ cần quản lý', item);
  if (!account) return;
  const edit = 'Sửa tên, model hoặc API key';
  const remove = 'Xóa hồ sơ';
  const action = await vscode.window.showQuickPick([edit, remove], { title: account.name });
  if (action === remove) await removeAccount(accounts, account);
  if (action === edit) {
    const name = await vscode.window.showInputBox({
      title: 'Tên hồ sơ', value: account.name, validateInput: required
    });
    if (name === undefined) return;
    const model = await vscode.window.showInputBox({
      title: 'Model ID', value: account.model, validateInput: required
    });
    if (model === undefined) return;
    const apiKey = await vscode.window.showInputBox({
      title: 'API key mới', prompt: 'Để trống để giữ API key hiện tại.',
      password: true, ignoreFocusOut: true, validateInput: validKey
    });
    if (apiKey === undefined) return;
    await accounts.edit(account.id, { name: name.trim(), model: model.trim(), apiKey: apiKey.trim() || undefined });
  }
}

async function removeAccount(accounts: Accounts, account: Account, fromMcp = false): Promise<boolean> {
  const remove = 'Delete Profile';
  if (await vscode.window.showWarningMessage(`Delete “${account.name}”?`, {
    modal: true,
    detail: `${fromMcp ? 'An AI client connected through xDev AI MCP asked for this. ' : ''}This removes the API profile and its saved key from xDev AI.`
  }, remove) === remove) {
    await accounts.remove(account.id);
    return true;
  }
  return false;
}

export function activate(context: vscode.ExtensionContext): XDevAI {
  const accounts = new Accounts(context.secrets);
  const panel = new ChatPanel(context.extensionUri, accounts);
  const profiles = new TerminalProfiles(context.globalStorageUri.fsPath);
  const auditOutput = vscode.window.createOutputChannel('xDev AI Audit');
  const audit = new AuditLog(join(context.globalStorageUri.fsPath, 'audit', 'audit.jsonl'), auditOutput);
  const terminals = registerAiTerminals(context, profiles, audit);
  const squad = registerSquad(context, accounts, profiles, terminals.onDidChange);
  const apiProfilesChanged = new vscode.EventEmitter<void>();
  const apiProfiles = vscode.window.createTreeView<ApiAccountItem>('xdevAi.apiAccounts', {
    treeDataProvider: {
      onDidChangeTreeData: apiProfilesChanged.event,
      getTreeItem: item => item,
      async getChildren() {
        const { accounts: available, activeId } = await accounts.read();
        return available.map(account => new ApiAccountItem(account, account.id === activeId));
      }
    }
  });
  const command = (id: string, run: (item?: ApiAccountTarget) => void | Promise<void>) =>
    vscode.commands.registerCommand(id, async (item?: ApiAccountTarget) => {
      try {
        await run(item);
      } catch {
        void vscode.window.showErrorMessage('xDev AI không thể hoàn tất thao tác với hồ sơ. Hãy thử lại.');
      }
    });

  context.subscriptions.push(
    auditOutput,
    vscode.commands.registerCommand('xdevAi.showAuditLog', async () => {
      auditOutput.show(true);
      const open = 'Open Log File';
      if (await vscode.window.showInformationMessage('The xDev AI audit log lists account changes and MCP calls, without keys or sign-in data.', open) === open) {
        await vscode.window.showTextDocument(vscode.Uri.file(audit.file)).then(undefined, () =>
          vscode.window.showInformationMessage('Nothing has been recorded yet.'));
      }
    }),
    panel,
    apiProfilesChanged,
    apiProfiles,
    registerChatModels(accounts, apiProfilesChanged.event),
    context.secrets.onDidChange(({ key }) => {
      if (key === accountStorageKey) {
        apiProfilesChanged.fire();
        void panel.refresh();
      }
    }),
    command('xdevAi.chat', () => panel.show()),
    command('xdevAi.addAccount', async () => { await addAccount(accounts); }),
    command('xdevAi.switchAccount', async item => {
      const account = await pickAccount(accounts, 'Chọn hồ sơ đang dùng', item);
      if (account) await accounts.select(account.id);
    }),
    command('xdevAi.openAccountChat', async item => {
      const account = await pickAccount(accounts, 'Chọn hồ sơ cho chat', item);
      if (!account) return;
      await accounts.select(account.id);
      panel.show();
    }),
    command('xdevAi.manageAccounts', item => manageAccounts(accounts, item)),
    command('xdevAi.removeAccount', async item => {
      const account = await pickAccount(accounts, 'Choose an API profile to delete', item);
      if (account && await removeAccount(accounts, account)) {
        void audit.record('user', 'api_profile_remove', true, { id: account.id, name: account.name });
      }
    })
  );

  registerXdevMcp(context, squad, accounts, profiles, {
    audit,
    terminals,
    addApiProfile: preset => addAccount(accounts, preset),
    async removeApiProfile(id) {
      const account = (await accounts.read()).accounts.find(candidate => candidate.id === id);
      if (!account) throw new Error('Unknown API profile id. Call xdev_accounts_list.');
      return removeAccount(accounts, account, true);
    }
  });

  return {
    async listAccounts() {
      return (await accounts.read()).accounts.map(summarize);
    },
    async chat(messages, { accountId, signal } = {}) {
      const { accounts: available, activeId } = await accounts.read();
      const account = available.find(candidate => candidate.id === (accountId ?? activeId));
      if (!account) throw new Error('Không tìm thấy hồ sơ AI. Hãy thêm hoặc chọn một hồ sơ.');
      return chat(account, messages, { signal });
    }
  };
}
