/**
 * The link between the xDev AI MCP server and the parts of the extension that show or use it: the Squad panel's
 * MCP tab and the AI terminals. It has no VS Code imports, so the terminals and tests can load it alone.
 */

export const mcpServerName = 'xdev_ai';
export const mcpUrlVariable = 'XDEV_AI_MCP_URL';
export const mcpTokenVariable = 'XDEV_AI_MCP_TOKEN';
export const mcpSettingKeys = ['accountControl', 'squadControl', 'confirmIn', 'autoStart'] as const;
export type McpSettingKey = typeof mcpSettingKeys[number];

/** What the MCP tab shows. It never holds the token. */
export interface McpPanelState {
  /** A trusted workspace folder is open, so the server can run. */
  ready: boolean;
  running: boolean;
  url?: string;
  /** 0 picks a free port on every start. */
  port: number;
  /** Another program, usually xDev AI MCP in another window, holds the fixed port, so this window uses a free one. */
  portBusy: boolean;
  autoStart: boolean;
  accountControl: string;
  squadControl: string;
  confirmIn: string;
  folder?: string;
  /** The folder's .mcp.json has the xDev AI server. */
  folderSetUp: boolean;
  /** The tools a client gets with the current settings. */
  tools: { name: string; summary: string; kind: 'read' | 'change' }[];
}

export interface McpControl {
  state(): McpPanelState;
  start(): Promise<void>;
  stop(): void;
  set(key: unknown, value: unknown): Promise<void>;
  copyConfiguration(): Promise<void>;
  /** Asks what clients may do, fixes the port, starts the server, and writes the folder's .mcp.json. */
  setUpFolder(): Promise<void>;
  /** Variables for an AI terminal, so the folder's .mcp.json reaches the server without holding the token. */
  environment(): Promise<Record<string, string>>;
}

let current: McpControl | undefined;
const listeners = new Set<() => void>();

export function mcpControl(): McpControl | undefined {
  return current;
}

export function setMcpControl(control: McpControl | undefined): void {
  current = control;
  notifyMcpChanged();
}

export function notifyMcpChanged(): void {
  for (const listener of listeners) listener();
}

export function onMcpChanged(listener: () => void): { dispose(): void } {
  listeners.add(listener);
  return { dispose: () => listeners.delete(listener) };
}

/**
 * The folder's `.mcp.json` with the xDev AI server added or replaced; other servers and keys are kept.
 * The file names two variables instead of the token, which xDev AI sets in the terminals it opens, so the file
 * is safe to keep in the project. Outside such a terminal the placeholder makes the server answer 401.
 */
export function withXdevServer(text: string | undefined, port: number): string {
  let data: Record<string, unknown> = {};
  if (text?.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('.mcp.json is not valid JSON. Fix it, then set up again.');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('.mcp.json must hold a JSON object.');
    data = parsed as Record<string, unknown>;
  }
  const existing = data.mcpServers;
  if (existing !== undefined && (!existing || typeof existing !== 'object' || Array.isArray(existing))) {
    throw new Error('"mcpServers" in .mcp.json must be an object.');
  }
  const servers = {
    ...(existing as Record<string, unknown> | undefined),
    [mcpServerName]: {
      type: 'http',
      url: `\${${mcpUrlVariable}:-http://127.0.0.1:${port}/mcp}`,
      headers: { Authorization: `Bearer \${${mcpTokenVariable}:-open-a-terminal-from-xdev-ai}` }
    }
  };
  return `${JSON.stringify({ ...data, mcpServers: servers }, null, 2)}\n`;
}

/** True when the `.mcp.json` text has the xDev AI server. */
export function hasXdevServer(text: string | undefined): boolean {
  try {
    const servers = (JSON.parse(text ?? '') as { mcpServers?: unknown })?.mcpServers;
    return Boolean(servers && typeof servers === 'object' && Object.hasOwn(servers, mcpServerName));
  } catch {
    return false;
  }
}
