import type { Account } from './accounts';
import { providers, type ChatMessage } from './core';

/** Vendor ID shared by `contributes.languageModelChatProviders` and the registration call. */
export const chatModelVendor = 'xdev-ai';

/** `chat()` asks Anthropic for at most this many output tokens. */
const maxOutputTokens = 4096;

export interface ChatModelEntry {
  id: string;
  name: string;
  family: string;
  version: string;
  detail: string;
  tooltip: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  capabilities: { imageInput: false; toolCalling: false };
}

/** Shape of `vscode.LanguageModelChatRequestMessage`, without importing `vscode`. */
export interface EditorChatMessage {
  readonly role: number;
  readonly content: ReadonlyArray<unknown>;
}

/** One model per API profile. The entry carries no API key and no endpoint. */
export function accountModels(accounts: readonly Account[], maxInputTokens: number): ChatModelEntry[] {
  return accounts.map(account => {
    const detail = `${providers[account.provider].name} · ${account.model}`;
    return {
      id: account.id,
      name: account.name,
      family: account.model,
      version: account.revision,
      detail,
      tooltip: `xDev AI API profile “${account.name}” · ${detail}`,
      maxInputTokens,
      maxOutputTokens,
      capabilities: { imageInput: false, toolCalling: false }
    };
  });
}

function partText(part: unknown): string | undefined {
  if (!part || typeof part !== 'object') return undefined;
  const { value, callId, content } = part as { value?: unknown; callId?: unknown; content?: unknown };
  // Tool result: keep its text. Tool calls and binary data have no text for `chat()`.
  if (callId !== undefined) {
    return Array.isArray(content) ? content.map(partText).filter(text => text !== undefined).join('') : undefined;
  }
  return typeof value === 'string' ? value : undefined;
}

export function messageText(message: EditorChatMessage): string {
  let result = '';
  for (const part of message.content) {
    const text = partText(part);
    if (text === undefined) continue;
    const toolResult = (part as { callId?: unknown }).callId !== undefined;
    result += toolResult && result ? `\n${text}` : text;
    if (toolResult) result += '\n';
  }
  return result.trim();
}

/** `LanguageModelChatMessageRole`: User = 1, Assistant = 2; 3 is the proposed System role. */
function role(value: number): ChatMessage['role'] {
  return value === 2 ? 'assistant' : value === 3 ? 'system' : 'user';
}

export function toChatMessages(messages: readonly EditorChatMessage[]): ChatMessage[] {
  return messages
    .map(message => ({ role: role(message.role), content: messageText(message) }))
    .filter(message => message.content);
}

/** The accounts' APIs expose no tokenizer, so this is an estimate: four characters per token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
