export const providers = {
  openai: { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
  anthropic: { name: 'Claude (Anthropic)', baseUrl: 'https://api.anthropic.com/v1' },
  gemini: { name: 'Gemini (Google)', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  compatible: { name: 'OpenAI-compatible', baseUrl: undefined }
} as const;

export type Provider = keyof typeof providers;

export interface AccountConfig {
  provider: Provider;
  model: string;
  baseUrl?: string;
  apiKey?: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  signal?: AbortSignal;
}

export function normalizeBaseUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error('Nhập URL đầy đủ, ví dụ https://example.com/v1.');
  }

  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('Dùng HTTPS hoặc HTTP qua địa chỉ loopback.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('URL chỉ gồm máy chủ và đường dẫn API.');
  }
  return url.href.replace(/\/+$/, '');
}

function requestError(status: number): string {
  switch (status) {
    case 401:
    case 403:
      return 'Kiểm tra API key và quyền truy cập model.';
    case 402:
      return 'Kiểm tra số dư và thiết lập thanh toán của hồ sơ.';
    case 400:
    case 404:
      return 'Kiểm tra model ID và API endpoint của hồ sơ.';
    case 429:
      return 'Kiểm tra hạn mức hoặc thử lại sau.';
    default:
      return status >= 500 ? 'Máy chủ AI gặp lỗi. Hãy thử lại sau.' : 'Máy chủ AI từ chối yêu cầu.';
  }
}

export async function chat(
  account: AccountConfig,
  messages: readonly ChatMessage[],
  options: ChatOptions = {}
): Promise<string> {
  const model = account.model.trim();
  const apiKey = account.apiKey?.trim();
  if (!model || !messages.some(message => message.role === 'user' && message.content.trim())) {
    throw new Error('Cần model ID và ít nhất một tin nhắn người dùng.');
  }
  if (account.provider !== 'compatible' && !apiKey) {
    throw new Error('Hồ sơ này cần API key.');
  }
  if (apiKey && !/^[\x21-\x7e]+$/.test(apiKey)) {
    throw new Error('API key chứa ký tự không hợp lệ.');
  }

  const baseUrl = providers[account.provider].baseUrl ?? normalizeBaseUrl(account.baseUrl ?? '');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  let path = 'chat/completions';
  let body: unknown = { model, messages };

  if (account.provider === 'anthropic') {
    path = 'messages';
    headers['anthropic-version'] = '2023-06-01';
    headers['x-api-key'] = apiKey!;
    body = {
      model,
      max_tokens: 4096,
      system: messages.filter(message => message.role === 'system').map(message => message.content).join('\n\n') || undefined,
      messages: messages.filter(message => message.role !== 'system')
    };
  } else if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  options.signal?.throwIfAborted();
  const timeout = AbortSignal.timeout(120_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      redirect: 'manual',
      signal
    });
  } catch {
    options.signal?.throwIfAborted();
    if (timeout.aborted) {
      throw new Error('Máy chủ AI không phản hồi trong 120 giây.');
    }
    throw new Error('Không kết nối được tới máy chủ AI từ nơi extension đang chạy.');
  }

  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error(`HTTP ${response.status}. ${requestError(response.status)}`);
  }

  let data: CompletionResponse;
  try {
    data = await response.json() as CompletionResponse;
  } catch {
    options.signal?.throwIfAborted();
    if (timeout.aborted) {
      throw new Error('Máy chủ AI không phản hồi xong trong 120 giây.');
    }
    throw new Error('Máy chủ AI trả về dữ liệu không hợp lệ.');
  }

  const answer = readText(account.provider, data);
  if (typeof answer !== 'string' || !answer.trim()) {
    throw new Error('Model không trả về nội dung văn bản.');
  }
  return answer;
}

function readText(provider: Provider, data: CompletionResponse): string | undefined {
  if (provider === 'anthropic') {
    const blocks = data?.content;
    return Array.isArray(blocks)
      ? blocks.flatMap(block => block?.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('\n')
      : undefined;
  }
  const message = data?.choices?.[0]?.message;
  return message?.content ?? message?.refusal;
}

interface CompletionResponse {
  content?: { type: string; text?: string }[];
  choices?: { message?: { content?: string; refusal?: string } }[];
}
