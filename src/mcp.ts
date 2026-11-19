import * as vscode from 'vscode';
import { type Accounts } from './accounts';
import type { McpConnection, McpTool } from './mcp-transport';
import { type SquadChat } from './squad-chat';
import { terminalProfileId, type TerminalProfiles } from './terminal-profiles';
import { workflowStage, workflowBriefLimit, workflowOutputLimit, workflowStages } from './workflow';

const providerId = 'xdevAi.mcp';
interface HttpDefinition {
  readonly label: string;
  uri: vscode.Uri;
}

// Native MCP discovery is optional on the older workspace hosts supported by xDev AI.
interface NativeMcpApi {
  McpHttpServerDefinition?: new (label: string, uri: vscode.Uri, headers?: Record<string, string>, version?: string) => HttpDefinition;
  lm?: {
    registerMcpServerDefinitionProvider?(id: string, provider: {
      onDidChangeMcpServerDefinitions: vscode.Event<void>;
      provideMcpServerDefinitions(): HttpDefinition[];
      resolveMcpServerDefinition(server: HttpDefinition): HttpDefinition | undefined;
    }): vscode.Disposable;
  };
}

const stageArgs = {
  workflowId: { type: 'string', description: 'Current workflow ID from xdev_workflow_status.' },
  step: { type: 'integer', minimum: 0, maximum: workflowStages.length - 1, description: 'The current zero-based stage number.' }
};

function tool(
  name: string, description: string, readOnly: boolean,
  properties: NonNullable<McpTool['inputSchema']['properties']>, run: McpTool['run']
): McpTool {
  return {
    name, description, run,
    inputSchema: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false },
    annotations: { readOnlyHint: readOnly, destructiveHint: false, openWorldHint: false }
  };
}

export function xdevMcpTools(squad: SquadChat, accounts: Accounts, profiles: TerminalProfiles): McpTool[] {
  let waitingForApproval = false;
  const status = () => {
    const { workflow, busy } = squad.snapshot();
    const stage = workflowStage(workflow);
    return { workflow: workflow ? {
      id: workflow.id, step: workflow.approved.length, total: workflowStages.length,
      stage: stage?.name ?? null, role: stage?.role ?? null, hasDraft: Boolean(workflow.draft)
    } : null, busy };
  };
  const workflowTool = (name: string, description: string, readOnly: boolean,
    properties: NonNullable<McpTool['inputSchema']['properties']>, run: McpTool['run']): McpTool =>
    tool(`xdev_${name}`, description, readOnly, properties, (args, signal) => {
      squad.customizations.requireTool('xdev_sdlc');
      return run(args, signal);
    });

  return [
    workflowTool('workflow_status', 'Get the ID and current step of the xDev SDLC workflow for this workspace.', true, {}, status),
    workflowTool('workflow_start', 'Start an xDev workflow with a project brief at the user’s request. An existing workflow is preserved.', false, {
      brief: { type: 'string', maxLength: workflowBriefLimit }
    }, async ({ brief }) => {
      await squad.startWorkflow(brief);
      return status();
    }),
    workflowTool('workflow_stage_context', 'Read the current stage instructions, project brief, approved results, and enabled workspace skills.', true,
      stageArgs, ({ workflowId, step }) => squad.stageRequest(workflowId, step)),
    workflowTool('workflow_submit_draft', 'Save a stage draft to the xDev Workflow panel for review. This does not advance the workflow.', false, {
      ...stageArgs, draft: { type: 'string', maxLength: workflowOutputLimit }
    }, async ({ workflowId, step, draft }) => {
      await squad.submitStageDraft(workflowId, step, draft);
      return status();
    }),
    workflowTool('workflow_request_approval', 'Ask a human to approve the saved draft in VS Code. Call only when expressly requested by the user. If declined or cancelled, do not retry.', false,
      stageArgs, async ({ workflowId, step }, signal) => {
        const { workflow, busy } = squad.snapshot();
        const stage = workflowStage(workflow);
        const draft = workflow?.draft;
        if (!workflow || !stage || workflow.id !== workflowId || workflow.approved.length !== step || !draft) {
          throw new Error('There is no saved draft for that stage. Get the current workflow status.');
        }
        if (busy || waitingForApproval) throw new Error('An xDev operation is already in progress.');
        const approve = 'Approve Stage';
        waitingForApproval = true;
        try {
          const choice = await vscode.window.showWarningMessage(`Approve the xDev ${stage.name} stage?`, {
            modal: true, detail: draft
          }, approve);
          signal.throwIfAborted();
          if (choice !== approve) return { approved: false };
          squad.customizations.requireTool('xdev_sdlc');
          await squad.approveStage(workflowId, step, draft, { draft, signal });
          return { approved: true, ...status() };
        } finally {
          waitingForApproval = false;
        }
      }),
    tool('xdev_accounts_list', 'List xDev API and terminal account aliases and provider names.', true, {}, async () => {
      const [api, terminals] = await Promise.all([accounts.read(), profiles.list()]);
      return {
        api: api.accounts.map(({ id, name, provider, model }) => ({ id, name, provider, model })),
        terminals: terminals.map(profile => ({ id: terminalProfileId(profile), name: profile.name, provider: profile.provider }))
      };
    })
  ];
}

function clientConfig(client: string, { url, headers }: McpConnection): string {
  if (client === 'Codex') return `[mcp_servers.xdev_ai]\nurl = ${JSON.stringify(url)}\nhttp_headers = { Authorization = ${JSON.stringify(headers.Authorization)} }\n`;
  const server = client === 'Gemini CLI' ? { httpUrl: url, headers } : { type: 'http', url, headers };
  return JSON.stringify({ [client === 'VS Code' ? 'servers' : 'mcpServers']: { xdev_ai: server } }, null, 2);
}

export function registerXdevMcp(context: vscode.ExtensionContext, squad: SquadChat, accounts: Accounts, profiles: TerminalProfiles): void {
  let connection: McpConnection | undefined;
  let manageOpen = false;
  let disposed = false;
  const changed = new vscode.EventEmitter<void>();
  const stop = () => {
    connection?.dispose();
    connection = undefined;
    changed.fire();
  };
  context.subscriptions.push({ dispose() { disposed = true; stop(); } }, changed);
  const version = String(context.extension.packageJSON.version);

  const nativeMcp: NativeMcpApi = vscode as typeof vscode & NativeMcpApi;
  const Definition = nativeMcp.McpHttpServerDefinition;
  if (typeof nativeMcp.lm?.registerMcpServerDefinitionProvider === 'function' && typeof Definition === 'function') {
    try {
      context.subscriptions.push(nativeMcp.lm.registerMcpServerDefinitionProvider(providerId, {
        onDidChangeMcpServerDefinitions: changed.event,
        provideMcpServerDefinitions: () => connection && vscode.workspace.isTrusted
          ? [new Definition('xDev AI', vscode.Uri.parse(connection.url), undefined, version)] : [],
        resolveMcpServerDefinition: server => connection && vscode.workspace.isTrusted && server.uri.toString() === connection.url
          ? new Definition(server.label, server.uri, connection.headers, version) : undefined
      }));
    } catch (error) {
      console.warn('xDev AI could not register native MCP discovery.', error);
    }
  }

  context.subscriptions.push(vscode.commands.registerCommand('xdevAi.manageMcp', async () => {
    if (manageOpen || disposed) return;
    if (!vscode.workspace.isTrusted || !vscode.workspace.workspaceFolders?.length) {
      void vscode.window.showWarningMessage('Open a trusted workspace folder to start xDev AI MCP.');
      return;
    }
    manageOpen = true;
    try {
      const startLabel = 'Start MCP';
      const stopLabel = 'Stop MCP';
      const copyLabel = 'Copy Client Configuration';
      const action = await vscode.window.showQuickPick(connection ? [copyLabel, stopLabel] : [startLabel], {
        title: `xDev AI MCP · ${connection ? 'Running' : 'Stopped'}`,
        placeHolder: connection ? 'Connect a client or stop the current session' : 'Enable local MCP access for this workspace window'
      });
      if (disposed) return;
      if (action === stopLabel) stop();
      if (action === startLabel) {
        const { startMcp } = await import('./mcp-transport.js');
        const next = await startMcp(version, xdevMcpTools(squad, accounts, profiles));
        if (disposed) { next.dispose(); return; }
        connection = next;
        changed.fire();
        void vscode.window.showInformationMessage('xDev AI MCP is running. Open MCP: List Servers in VS Code or copy the configuration for another client.');
      }
      if (action === copyLabel && connection) {
        const client = await vscode.window.showQuickPick(['Claude Code', 'Codex', 'Gemini CLI', 'VS Code'], {
          title: 'Copy xDev AI MCP Configuration', placeHolder: 'The copied configuration includes a private session token'
        });
        if (!client || !connection) return;
        await vscode.env.clipboard.writeText(clientConfig(client, connection));
        void vscode.window.showInformationMessage('xDev AI MCP configuration copied. Keep it private and refresh it when MCP restarts.');
      }
    } catch (error) {
      void vscode.window.showErrorMessage(`xDev AI MCP could not complete the operation. ${error instanceof Error ? error.message : ''}`);
    } finally {
      manageOpen = false;
    }
  }));
}
