import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';

const host = '127.0.0.1';
const maxRequestBytes = 64 * 1024;

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

export async function startMcp(version: string, tools: readonly McpTool[]): Promise<McpConnection> {
  const lifecycle = new AbortController();
  const authorization = `Bearer ${randomBytes(32).toString('hex')}`;
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
    listener.once('error', reject);
    listener.listen(0, host, () => {
      authority = `${host}:${(listener.address() as AddressInfo).port}`;
      listener.off('error', reject);
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
