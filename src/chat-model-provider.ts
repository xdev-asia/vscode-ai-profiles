import * as vscode from 'vscode';
import type { Accounts } from './accounts';
import { accountModels, chatModelVendor, estimateTokens, messageText, toChatMessages } from './chat-models';
import { chat } from './core';

/**
 * Lists every API profile as a model of the built-in chat. Requests run in the
 * extension host through `chat()`, so an API key never reaches a webview.
 */
export function registerChatModels(accounts: Accounts, changed: vscode.Event<void>): vscode.Disposable {
  return vscode.lm.registerLanguageModelChatProvider(chatModelVendor, {
    onDidChangeLanguageModelChatInformation: changed,

    async provideLanguageModelChatInformation() {
      const maxInputTokens = vscode.workspace.getConfiguration('xdevAi.chatModels').get('maxInputTokens', 128000);
      return accountModels((await accounts.read()).accounts, maxInputTokens);
    },

    async provideLanguageModelChatResponse(model, messages, _options, progress, token) {
      const account = (await accounts.read()).accounts.find(candidate => candidate.id === model.id);
      if (!account) throw new Error('This xDev AI API profile is no longer available.');

      const abort = new AbortController();
      const cancelled = token.onCancellationRequested(() => abort.abort());
      try {
        // `chat()` returns the whole answer, so the answer arrives as one part.
        const answer = await chat(account, toChatMessages(messages), { signal: abort.signal });
        progress.report(new vscode.LanguageModelTextPart(answer));
      } catch (error) {
        if (token.isCancellationRequested) throw new vscode.CancellationError();
        throw error;
      } finally {
        cancelled.dispose();
      }
    },

    async provideTokenCount(_model, text) {
      return estimateTokens(typeof text === 'string' ? text : messageText(text));
    }
  });
}
