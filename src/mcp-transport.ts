import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';

const host = '127.0.0.1';
// Large enough for a shared artifact (a design or a report) sent in one tool call. The token is checked before the body is read.
const maxRequestBytes = 1024 * 1024;

export interface McpTool extends Tool {
  run(args: Record<string, unknown>, signal: AbortSignal): unknown | Promise<unknown>;
}

export interface McpConnection {
  url: string;
  headers: Record<string, string>;
  dispose(): void;
}

async function readRequest(request: IncomingMessage, response: ServerResponse): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) {
    response.writeHead(415).end();
    return;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > maxRequestBytes) {
      response.writeHead(413, { Connection: 'close' }).end();
      return;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    response.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({
      jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON.' }
    }));
  }
}

export interface McpOptions {
  /** A fixed loopback port so client configuration survives restarts. 0 or absent picks a free port. */
  port?: number;
  /** A saved 64-character hex token. Absent creates a new token for this session. */
  token?: string;
}

export function newMcpToken(): string {
  return randomBytes(32).toString('hex');
}

export function validMcpToken(token: unknown): token is string {
  return typeof token === 'string' && /^[a-f0-9]{64}$/.test(token);
}

export async function startMcp(version: string, tools: readonly McpTool[], options: McpOptions = {}): Promise<McpConnection> {
  const port = options.port ?? 0;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('Use an MCP port from 0 to 65535.');
  if (options.token !== undefined && !validMcpToken(options.token)) throw new Error('The saved MCP token is not valid. Rotate it.');
  const lifecycle = new AbortController();
  const authorization = `Bearer ${options.token ?? newMcpToken()}`;
  const credential = Buffer.from(authorization);
  const definitions = tools.map(({ run, ...definition }) => definition);
  let authority: string;

  const listener = createServer({ requestTimeout: 15_000, headersTimeout: 10_000 }, (request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500).end();
      else response.destroy();
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader('Cache-Control', 'no-store');
    if (request.headers.host !== authority || request.headers.origin !== undefined) {
      response.writeHead(403).end();
      return;
    }
    if (request.url !== '/mcp') {
      response.writeHead(404).end();
      return;
    }
    const supplied = Buffer.from(request.headers.authorization ?? '');
    if (supplied.length !== credential.length || !timingSafeEqual(supplied, credential)) {
      response.writeHead(401, { 'WWW-Authenticate': 'Bearer realm="xDev AI"' }).end();
      return;
    }
    if (request.method !== 'POST') {
      response.writeHead(405, { Allow: 'POST' }).end();
      return;
    }
    const body = await readRequest(request, response);
    if (response.headersSent || response.destroyed || lifecycle.signal.aborted) return;
    const disconnected = new AbortController();
    response.once('close', () => disconnected.abort());
    const server = new Server({ name: 'xdev-ai', version }, { capabilities: { tools: {} } });
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: definitions }));
    server.setRequestHandler(CallToolRequestSchema, async ({ params }, { signal }) => {
      const tool = tools.find(candidate => candidate.name === params.name);
      try {
        if (!tool) throw new Error('Unknown xDev AI tool.');
        const args = params.arguments ?? {};
        if (Object.keys(args).some(key => !Object.hasOwn(tool.inputSchema.properties ?? {}, key))) {
          throw new Error('Unexpected tool argument.');
        }
        const requestSignal = AbortSignal.any([lifecycle.signal, disconnected.signal, signal]);
        requestSignal.throwIfAborted();
        const result = await tool.run(args, requestSignal);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : 'xDev AI tool failed.' }] };
      }
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, body);
    } finally {
      await server.close();
    }
  }

  await new Promise<void>((resolve, reject) => {
    const failed = (error: NodeJS.ErrnoException) => reject(error.code === 'EADDRINUSE'
      ? Object.assign(new Error(`Port ${port} is in use, perhaps by xDev AI MCP in another window. Stop it there or change xdevAi.mcp.port.`), { code: 'EADDRINUSE' })
      : error);
    listener.once('error', failed);
    listener.listen(port, host, () => {
      authority = `${host}:${(listener.address() as AddressInfo).port}`;
      listener.off('error', failed);
      resolve();
    });
  });
  return {
    url: `http://${authority!}/mcp`,
    headers: { Authorization: authorization },
    dispose() {
      lifecycle.abort();
      listener.close();
      listener.closeAllConnections();
    }
  };
}
