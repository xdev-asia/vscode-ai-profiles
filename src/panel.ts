import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { Accounts, summarize } from './accounts';
import { chat, providers, type ChatMessage } from './core';

const maxPromptLength = 40_000;
const maxHistoryMessages = 24;

interface Conversation {
  revision: string;
  messages: ChatMessage[];
  pending?: { controller: AbortController; prompt: string };
  error?: string;
}

export class ChatPanel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private readonly conversations = new Map<string, Conversation>();
  private refreshId = 0;

  constructor(private readonly extensionUri: vscode.Uri, private readonly accounts: Accounts) {}

  show(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }

    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    const panel = vscode.window.createWebviewPanel('xdevAi.chat', 'xDev AI', vscode.ViewColumn.Beside, {
      enableScripts: true,
      localResourceRoots: [media]
    });
    this.panel = panel;
    const receiver = panel.webview.onDidReceiveMessage(message => {
      void this.receive(panel, message).catch(() => {
        if (this.panel === panel) {
          this.post({ type: 'error', message: 'Không thể hoàn tất thao tác với hồ sơ AI.' });
          void this.refresh();
        }
      });
    });
    panel.onDidDispose(() => {
      receiver.dispose();
      this.panel = undefined;
      for (const conversation of this.conversations.values()) conversation.pending?.controller.abort();
      this.conversations.clear();
    });
    panel.webview.html = this.html(panel.webview, media);
  }

  dispose(): void {
    this.panel?.dispose();
  }

  private post(message: unknown): void {
    void this.panel?.webview.postMessage(message);
  }

  async refresh(): Promise<void> {
    const panel = this.panel;
    if (!panel) return;
    const refreshId = ++this.refreshId;
    try {
      const { accounts, activeId } = await this.accounts.read();
      if (this.panel !== panel || this.refreshId !== refreshId) return;

      for (const [id, conversation] of this.conversations) {
        if (!accounts.some(account => account.id === id && account.revision === conversation.revision)) {
          conversation.pending?.controller.abort();
          this.conversations.delete(id);
        }
      }
      const conversation = activeId ? this.conversations.get(activeId) : undefined;
      this.post({
        type: 'state',
        accounts: accounts.map(account => ({ ...summarize(account), providerName: providers[account.provider].name })),
        activeId,
        messages: conversation?.messages ?? [],
        pending: conversation?.pending?.prompt,
        error: conversation?.error
      });
    } catch {
      if (this.panel === panel && this.refreshId === refreshId) {
        this.post({ type: 'error', message: 'Không thể đọc hồ sơ từ SecretStorage của VS Code.' });
      }
    }
  }

  private async receive(panel: vscode.WebviewPanel, input: unknown): Promise<void> {
    if (!input || typeof input !== 'object' || this.panel !== panel) return;
    const { type, id, text } = input as { type?: unknown; id?: unknown; text?: unknown };
    switch (type) {
      case 'ready':
        await this.refresh();
        return;
      case 'add':
        await vscode.commands.executeCommand('xdevAi.addAccount');
        return;
      case 'manage':
        await vscode.commands.executeCommand('xdevAi.manageAccounts');
        return;
      case 'claude':
        await vscode.commands.executeCommand('xdevAi.claude.openTerminal');
        return;
      case 'select':
        if (typeof id === 'string') await this.accounts.select(id);
        return;
      case 'clear':
      case 'stop':
        if (typeof id === 'string') {
          const conversation = this.conversations.get(id);
          conversation?.pending?.controller.abort();
          if (type === 'clear') this.conversations.delete(id);
          await this.refresh();
        }
        return;
      case 'send':
        if (typeof id === 'string' && typeof text === 'string' && text.trim() && text.length <= maxPromptLength) {
          await this.send(panel, id, text.trim());
        }
    }
  }

  private async send(panel: vscode.WebviewPanel, id: string, prompt: string): Promise<void> {
    const { accounts, activeId } = await this.accounts.read();
    if (this.panel !== panel) return;
    const account = accounts.find(candidate => candidate.id === id && id === activeId);
    if (!account) {
      await this.refresh();
      return;
    }

    let conversation = this.conversations.get(id);
    if (conversation?.revision !== account.revision) {
      conversation?.pending?.controller.abort();
      conversation = { revision: account.revision, messages: [] };
      this.conversations.set(id, conversation);
    }
    if (conversation.pending) {
      await this.refresh();
      return;
    }

    const controller = new AbortController();
    conversation.pending = { controller, prompt };
    conversation.error = undefined;
    void this.refresh();
    const messages: ChatMessage[] = [...conversation.messages, { role: 'user', content: prompt }];
    try {
      const answer = await chat(account, messages, { signal: controller.signal });
      controller.signal.throwIfAborted();
      messages.push({ role: 'assistant', content: answer });
      conversation.messages = messages.slice(-maxHistoryMessages);
      if (this.panel === panel) this.post({ type: 'sent', id, prompt });
    } catch (error) {
      if (!controller.signal.aborted) {
        conversation.error = error instanceof Error ? error.message : 'Yêu cầu thất bại.';
      }
    } finally {
      conversation.pending = undefined;
      if (this.panel === panel) await this.refresh();
    }
  }

  private html(webview: vscode.Webview, media: vscode.Uri): string {
    const nonce = randomBytes(16).toString('base64');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(media, 'chat.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(media, 'chat.css'));
    return `<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${style}">
  <title>xDev AI</title>
</head>
<body>
  <header class="toolbar">
    <div class="account">
      <label for="account">Hồ sơ AI</label>
      <select id="account" disabled></select>
    </div>
    <button type="button" id="add">Thêm hồ sơ</button>
    <button type="button" id="manage" class="secondary" disabled>Quản lý</button>
    <button type="button" id="claude" class="secondary">Claude Code</button>
  </header>
  <main>
    <div class="conversation-heading">
      <h1>Trò chuyện</h1>
      <button type="button" id="clear" class="secondary" disabled>Đoạn chat mới</button>
    </div>
    <div id="messages" class="messages" role="log" aria-label="Tin nhắn"></div>
    <form id="composer">
      <label for="prompt">Tin nhắn</label>
      <textarea id="prompt" rows="3" maxlength="${maxPromptLength}" placeholder="Nhập câu hỏi hoặc dán đoạn mã…" disabled></textarea>
      <div class="compose-actions">
        <span id="status" role="status"></span>
        <button type="button" id="stop" class="secondary" hidden>Dừng</button>
        <button type="submit" id="send" disabled>Gửi</button>
      </div>
    </form>
  </main>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}
