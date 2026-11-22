import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isRole, type Role } from './squad';

/** One MCP server as Claude Code reads it from `--mcp-config` or `.mcp.json`. */
export interface McpServer {
  type?: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

/** A server this project lets Squad workers use, with the tools and roles it is granted to. */
export interface McpGrant {
  name: string;
  /** Tool names workers may call; "*" allows every tool of the server. */
  tools: string[];
  roles: Role[];
  source: 'settings' | '.mcp.json';
  server?: McpServer;
  /** Why the server cannot be used; such a grant is shown but never passed to workers. */
  problem?: string;
}

/** What one worker run receives: the servers to start and the permission rules for their tools. */
export interface WorkerMcp {
  servers: Record<string, McpServer>;
  allowed: string[];
}

export const defaultMcpRoles: readonly Role[] = ['Lead', 'Implement', 'Tests'];
const serverLimit = 10;
const toolLimit = 40;
const namePattern = /^[A-Za-z0-9_-]{1,40}$/;
const toolPattern = /^[A-Za-z0-9_.-]{1,80}$/;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringMap(value: unknown): Record<string, string> | undefined {
  const input = record(value);
  if (!input) return undefined;
  const entries = Object.entries(input).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  return entries.length ? Object.fromEntries(entries) : undefined;
}

/** Keeps only the fields Claude Code understands, so nothing else from settings reaches the worker. */
export function readServer(value: unknown): McpServer | undefined {
  const input = record(value);
  if (!input) return undefined;
  const type = input.type === 'http' || input.type === 'sse' || input.type === 'stdio' ? input.type : undefined;
  const command = typeof input.command === 'string' && input.command.trim() ? input.command.trim() : undefined;
  const url = typeof input.url === 'string' && /^https?:\/\//i.test(input.url.trim()) ? input.url.trim() : undefined;
  if (!command === !url) return undefined;
  if (command && type && type !== 'stdio') return undefined;
  const server: McpServer = command ? { type: 'stdio', command } : { type: type === 'sse' ? 'sse' : 'http', url };
  if (command) {
    const args = Array.isArray(input.args) ? input.args.filter((item): item is string => typeof item === 'string') : [];
    if (args.length) server.args = args;
    const env = stringMap(input.env);
    if (env) server.env = env;
  } else {
    const headers = stringMap(input.headers);
    if (headers) server.headers = headers;
  }
  return server;
}

/** Servers defined in the project's `.mcp.json`, the file Claude Code reads for project MCP servers. */
export function readProjectMcp(folder: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(join(folder, '.mcp.json'), 'utf8')) as unknown;
    return record(record(parsed)?.mcpServers) ?? {};
  } catch {
    return {};
  }
}

/**
 * Reads `xdevAi.squad.mcpServers`. Each entry names a server and the tools workers may call. A server
 * defined in the entry itself is used as is; otherwise the server of the same name in `.mcp.json`.
 */
export function readMcpGrants(setting: unknown, project: Record<string, unknown> = {}): McpGrant[] {
  const input = record(setting);
  if (!input) return [];
  return Object.entries(input).slice(0, serverLimit).flatMap(([name, value]): McpGrant[] => {
    const entry = record(value);
    if (!entry) return [];
    const roles = Array.isArray(entry.roles) ? [...new Set(entry.roles.filter(isRole))] : [...defaultMcpRoles];
    const tools = Array.isArray(entry.tools)
      ? [...new Set(entry.tools.filter((tool): tool is string => typeof tool === 'string' && (tool === '*' || toolPattern.test(tool))))].slice(0, toolLimit)
      : [];
    const inline = entry.command !== undefined || entry.url !== undefined;
    const server = readServer(inline ? entry : project[name]);
    const grant: McpGrant = { name, tools, roles, source: inline ? 'settings' : '.mcp.json', ...(server ? { server } : {}) };
    if (!namePattern.test(name)) grant.problem = 'Use letters, digits, "-" or "_" in the server name.';
    else if (!server) grant.problem = inline ? 'Give the server a command or an http(s) url.' : 'No server with this name in .mcp.json.';
    else if (!tools.length) grant.problem = 'List the tools workers may call in "tools" (or "*").';
    else if (!roles.length) grant.problem = 'List at least one role in "roles".';
    return [grant];
  });
}

/** The permission rule Claude Code matches for an MCP tool: mcp__server__tool, or mcp__server for all its tools. */
export function mcpRule(server: string, tool: string): string {
  return tool === '*' ? `mcp__${server}` : `mcp__${server}__${tool}`;
}

/** The servers and tool rules one role receives. Grants with a problem are left out. */
export function workerMcp(grants: readonly McpGrant[], role: Role): WorkerMcp | undefined {
  const usable = grants.filter(grant => !grant.problem && grant.server && grant.roles.includes(role));
  if (!usable.length) return undefined;
  return {
    servers: Object.fromEntries(usable.map(grant => [grant.name, grant.server!])),
    allowed: usable.flatMap(grant => grant.tools.map(tool => mcpRule(grant.name, tool)))
  };
}
