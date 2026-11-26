import * as vscode from 'vscode';
import { type Accounts } from './accounts';
import type { AccountUsage } from './account-usage';
import type { AuditLog } from './audit';
import type { TerminalAccounts } from './ai-terminal';
import { providers, type Provider } from './core';
import type { McpConnection, McpTool } from './mcp-transport';
import { poolModes, type PoolMode, type SquadChat } from './squad-chat';
import {
  maxNoteLength, maxTags, terminalProfileId, terminalProviderIds, type TerminalProfile, type TerminalProfiles, type TerminalProvider
} from './terminal-profiles';
import { highestUse } from './usage-status';
import { workflowStage, workflowBriefLimit, workflowOutputLimit, workflowStages } from './workflow';

const providerId = 'xdevAi.mcp';
const tokenKey = 'mcp.token.v1';
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

/** How much an MCP client may do with xDev AI accounts: nothing, read them, or change them. */
export const accountControlLevels = ['off', 'read', 'manage'] as const;
export type AccountControlLevel = typeof accountControlLevels[number];

export interface ApiProfileRequest {
  provider: Provider;
  name: string;
  model: string;
  baseUrl?: string;
}

/** What the account tools need from VS Code. Tests pass a stub. */
export interface AccountHost {
  level(): AccountControlLevel;
  usage?(id: string): AccountUsage | undefined;
  refreshUsage?(): Promise<void>;
  /** Opens, signs in, opens with bypass, or deletes a terminal account. Resolves false when the user cancels. */
  perform?(action: 'open' | 'bypass' | 'signIn' | 'remove', id: string): Promise<boolean>;
  changed?(): void;
  /** Shows a modal VS Code dialog and resolves true only when the user picks `label`. */
  confirm(title: string, detail: string, label: string, signal: AbortSignal): Promise<boolean>;
  audit?(action: string, ok: boolean, details: Record<string, unknown>, error?: unknown): void;
  addApiProfile?(request: ApiProfileRequest): Promise<boolean>;
  removeApiProfile?(id: string): Promise<boolean>;
  setPool?(mode: PoolMode, accounts: string[]): Promise<void>;
}

const stageArgs = {
  workflowId: { type: 'string', description: 'Current workflow ID from xdev_workflow_status.' },
  step: { type: 'integer', minimum: 0, maximum: workflowStages.length - 1, description: 'The current zero-based stage number.' }
};

type Properties = NonNullable<McpTool['inputSchema']['properties']>;
type Kind = 'read' | 'write' | 'destructive';

function tool(
  name: string, description: string, kind: Kind | boolean, properties: Properties, run: McpTool['run'],
  required: string[] = Object.keys(properties)
): McpTool {
  const readOnly = kind === true || kind === 'read';
  return {
    name, description, run,
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
    annotations: { readOnlyHint: readOnly, destructiveHint: kind === 'destructive', openWorldHint: false }
  };
}

const idArg = { id: { type: 'string', maxLength: 200, description: 'Account id from xdev_accounts_list.' } };
const declined = { done: false, reason: 'The user declined in VS Code. Do not retry unless the user asks again.' };

function iso(time: number | undefined): string | undefined {
  return time ? new Date(time).toISOString() : undefined;
}

/** Public view of a terminal account: never its directory, tokens, or files. */
function describeTerminal(profile: TerminalProfile, usage: AccountUsage | undefined) {
  const now = Date.now();
  return {
    id: terminalProfileId(profile),
    name: profile.name,
    provider: profile.provider,
    tags: profile.tags,
    note: profile.note,
    disabled: profile.disabled,
    createdAt: iso(profile.createdAt),
    lastUsedAt: iso(profile.lastUsedAt),
    plan: usage?.plan,
    seat: usage?.seat,
    signedIn: usage ? (usage.signedOut ? false : usage.unavailable && !usage.plan && !usage.windows.length ? null : true) : null,
    quota: usage && !usage.signedOut ? usage.windows.filter(window => !window.resetsAt || window.resetsAt > now)
      .map(window => ({ window: window.label, usedPercent: Number(window.used.toFixed(1)), resetsAt: iso(window.resetsAt) })) : undefined,
    quotaObservedAt: iso(usage?.observedAt)
  };
}

export function xdevMcpTools(squad: SquadChat, accounts: Accounts, profiles: TerminalProfiles, host?: AccountHost): McpTool[] {
  let waitingForApproval = false;
  const level = () => host?.level() ?? 'read';
  const status = () => {
    const { workflow, busy } = squad.snapshot();
    const stage = workflowStage(workflow);
    return { workflow: workflow ? {
      id: workflow.id, step: workflow.approved.length, total: workflowStages.length,
      stage: stage?.name ?? null, role: stage?.role ?? null, hasDraft: Boolean(workflow.draft)
    } : null, busy };
  };
  const workflowTool = (name: string, description: string, readOnly: boolean,
    properties: Properties, run: McpTool['run']): McpTool =>
    tool(`xdev_${name}`, description, readOnly, properties, (args, signal) => {
      squad.customizations.requireTool('xdev_sdlc');
      return run(args, signal);
    });

  const findTerminal = async (id: unknown): Promise<TerminalProfile> => {
    const profile = (await profiles.list()).find(candidate => terminalProfileId(candidate) === id);
    if (!profile) throw new Error('Unknown terminal account id. Call xdev_accounts_list.');
    return profile;
  };
  const describe = (profile: TerminalProfile) => describeTerminal(profile, host?.usage?.(terminalProfileId(profile)));
  const list = async () => {
    const [api, terminals] = await Promise.all([accounts.read(), profiles.list()]);
    return {
      api: api.accounts.map(({ id, name, provider, model }) => ({ id, name, provider, model, active: id === api.activeId })),
      terminals: terminals.map(describe)
    };
  };
  const needs = <T>(value: T | undefined): T => {
    if (value === undefined) throw new Error('This xDev AI window cannot do that.');
    return value;
  };
  /** A tool that changes accounts: needs the manage level and is written to the audit log. */
  const manageTool = (name: string, description: string, destructive: boolean, properties: Properties,
    run: McpTool['run'], required?: string[]): McpTool =>
    tool(`xdev_${name}`, description, destructive ? 'destructive' : 'write', properties, async (args, signal) => {
      if (level() !== 'manage') throw new Error('Account changes are turned off. The user can set xdevAi.mcp.accountControl to manage.');
      try {
        const result = await run(args, signal);
        host?.audit?.(name, true, args);
        return result;
      } catch (error) {
        host?.audit?.(name, false, args, error);
        throw error;
      }
    }, required);
  const confirm = (title: string, detail: string, label: string, signal: AbortSignal) =>
    host ? host.confirm(title, `An AI client connected through xDev AI MCP asked for this.\n\n${detail}`, label, signal) : Promise.resolve(false);

  const workflowTools = [
    workflowTool('workflow_status', 'Get the ID and current step of the xDev SDLC workflow for this workspace.', true, {}, status),
    workflowTool('workflow_start', 'Start an xDev workflow with a project brief at the user’s request. An existing workflow is preserved.', false, {
      brief: { type: 'string', maxLength: workflowBriefLimit }
    }, async ({ brief }) => {
      await squad.startWorkflow(brief as string);
      return status();
    }),
    workflowTool('workflow_stage_context', 'Read the current stage instructions, project brief, approved results, and enabled workspace skills.', true,
      stageArgs, ({ workflowId, step }) => squad.stageRequest(workflowId as string, step as number)),
    workflowTool('workflow_submit_draft', 'Save a stage draft to the xDev Workflow panel for review. This does not advance the workflow.', false, {
      ...stageArgs, draft: { type: 'string', maxLength: workflowOutputLimit }
    }, async ({ workflowId, step, draft }) => {
      await squad.submitStageDraft(workflowId as string, step as number, draft as string);
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
          await squad.approveStage(workflowId as string, step as number, draft, { draft, signal });
          return { approved: true, ...status() };
        } finally {
          waitingForApproval = false;
        }
      })
  ];
  if (level() === 'off') return workflowTools;

  const readTools = [
    tool('xdev_accounts_list', 'List xDev API profiles and terminal accounts (Claude Code, Codex, Gemini CLI) with tags, note, disabled flag, plan, sign-in state, and quota use. Never returns keys or sign-in data.', true, {}, list),
    tool('xdev_account_usage', 'Get one terminal account’s plan, sign-in state, and quota windows (percent used and reset time).', true, idArg,
      async ({ id }) => describe(await findTerminal(id))),
    tool('xdev_accounts_pick', 'Suggest the enabled, signed-in terminal account with the most quota left, optionally for one provider or tag. Returns the pick and up to three alternatives.', true, {
      provider: { type: 'string', enum: [...terminalProviderIds] },
      tag: { type: 'string', maxLength: 32 }
    }, async ({ provider, tag }) => {
      const now = Date.now();
      const candidates = (await profiles.list(provider as TerminalProvider | undefined))
        .filter(profile => !profile.disabled && (!tag || profile.tags?.includes(String(tag).toLowerCase())))
        .map(profile => ({ profile, usage: host?.usage?.(terminalProfileId(profile)) }))
        .filter(({ usage }) => !usage?.signedOut)
        .map(({ profile, usage }) => ({ profile, used: highestUse(usage, now) }))
        .sort((a, b) => (a.used ?? 50) - (b.used ?? 50) || (a.profile.lastUsedAt ?? 0) - (b.profile.lastUsedAt ?? 0));
      if (!candidates.length) return { account: null, reason: 'No enabled, signed-in account matches.' };
      const [best, ...rest] = candidates;
      return {
        account: describe(best.profile),
        reason: best.used === undefined ? 'No quota reading yet; picked the least recently used account.' : `Highest window ${Number(best.used.toFixed(1))}% used.`,
        alternatives: rest.slice(0, 3).map(({ profile, used }) => ({ id: terminalProfileId(profile), name: profile.name, highestUsedPercent: used }))
      };
    }, [])
  ];
  if (level() !== 'manage') return [...workflowTools, ...readTools];

  const changedProfile = async (profile: Promise<TerminalProfile>) => {
    const next = await profile;
    host?.changed?.();
    return describe(next);
  };
  const manageTools = [
    manageTool('account_refresh_usage', 'Read plan, sign-in state, and quota again for every terminal account, then list the accounts.', false, {}, async () => {
      await needs(host?.refreshUsage)();
      return list();
    }),
    manageTool('account_rename', 'Rename a terminal account.', false, {
      ...idArg, name: { type: 'string', minLength: 1, maxLength: 80 }
    }, async ({ id, name }) => {
      const profile = await findTerminal(id);
      await profiles.rename(profile, String(name));
      host?.changed?.();
      return describe(await findTerminal(id));
    }),
    manageTool('account_set_tags', `Replace a terminal account’s tags (up to ${maxTags}; letters, digits, dots, underscores, hyphens). An empty list clears them.`, false, {
      ...idArg, tags: { type: 'array', items: { type: 'string', maxLength: 32 }, maxItems: maxTags }
    }, async ({ id, tags }) => changedProfile(profiles.setMetadata(await findTerminal(id), { tags: tags as unknown[] }))),
    manageTool('account_set_note', 'Replace a terminal account’s note, for example its owner or renewal date. An empty note clears it.', false, {
      ...idArg, note: { type: 'string', maxLength: maxNoteLength }
    }, async ({ id, note }) => changedProfile(profiles.setMetadata(await findTerminal(id), { note }))),
    manageTool('account_set_disabled', 'Disable or enable a terminal account. A disabled account keeps its sign-in but is left out of the Squad pool and account picks.', false, {
      ...idArg, disabled: { type: 'boolean' }
    }, async ({ id, disabled }) => changedProfile(profiles.setMetadata(await findTerminal(id), { disabled: disabled === true }))),
    manageTool('terminal_open', 'Open a VS Code terminal signed in as this terminal account, for the user to work in.', false, idArg, async ({ id }) => {
      const profile = await findTerminal(id);
      if (profile.disabled) throw new Error('This account is disabled. Enable it first if the user wants it.');
      return { done: await needs(host?.perform)('open', String(id)) };
    }),
    manageTool('terminal_sign_in', 'Open a sign-in terminal for this account after the user confirms in VS Code. The user completes sign-in in that terminal.', false, idArg, async ({ id }, signal) => {
      const profile = await findTerminal(id);
      if (!await confirm(`Sign in to “${profile.name}”?`, 'This opens a terminal where you complete sign-in with the provider.', 'Open Sign-In', signal)) return declined;
      return { done: await needs(host?.perform)('signIn', String(id)) };
    }),
    manageTool('terminal_open_bypass', 'Open a terminal for this account with the CLI’s permission prompts skipped. VS Code asks the user to confirm. Use only when the user asks.', true, idArg, async ({ id }) => {
      const profile = await findTerminal(id);
      if (profile.disabled) throw new Error('This account is disabled. Enable it first if the user wants it.');
      const done = await needs(host?.perform)('bypass', String(id));
      return done ? { done } : declined;
    }),
    manageTool('account_remove', 'Delete a terminal account with its sign-in data and CLI history. VS Code asks the user to confirm. Use only when the user asks.', true, idArg, async ({ id }) => {
      await findTerminal(id);
      const done = await needs(host?.perform)('remove', String(id));
      return done ? { done } : declined;
    }),
    manageTool('api_profile_select', 'Make an API profile the active one for xDev Chat.', false, idArg, async ({ id }) => {
      await accounts.select(String(id));
      return { done: true };
    }),
    manageTool('api_profile_add', 'Start adding an API profile. The user confirms and types the API key in VS Code; the key is never sent to you.', false, {
      provider: { type: 'string', enum: Object.keys(providers) },
      name: { type: 'string', minLength: 1, maxLength: 80 },
      model: { type: 'string', minLength: 1, maxLength: 200 },
      baseUrl: { type: 'string', maxLength: 500, description: 'Required for the compatible provider.' }
    }, async ({ provider, name, model, baseUrl }, signal) => {
      const request = { provider: provider as Provider, name: String(name).trim(), model: String(model).trim(), baseUrl: baseUrl as string | undefined };
      if (!Object.hasOwn(providers, request.provider) || !request.name || !request.model) throw new Error('Give a provider, name, and model.');
      if (!await confirm(`Add the API profile “${request.name}”?`, `${providers[request.provider].name} · ${request.model}${request.baseUrl ? ` · ${request.baseUrl}` : ''}\nYou type the API key next.`, 'Enter API Key', signal)) return declined;
      const done = await needs(host?.addApiProfile)(request);
      return done ? { done } : declined;
    }, ['provider', 'name', 'model']),
    manageTool('api_profile_remove', 'Delete an API profile and its saved key. VS Code asks the user to confirm. Use only when the user asks.', true, idArg, async ({ id }) => {
      const done = await needs(host?.removeApiProfile)(String(id));
      return done ? { done } : declined;
    }),
    manageTool('squad_set_pool', 'Set how Squad workers choose Claude Code accounts: role (each role’s own account), roundRobin, or quota (most quota left), and which account ids are in the pool. An empty list uses every enabled Claude Code account.', false, {
      mode: { type: 'string', enum: [...poolModes] },
      accounts: { type: 'array', items: { type: 'string', maxLength: 200 }, maxItems: 50 }
    }, async ({ mode, accounts: ids }) => {
      if (!poolModes.includes(mode as PoolMode)) throw new Error('Unknown pool mode.');
      const claude = await profiles.list('claude');
      const chosen = [...new Set((ids as unknown[]).map(String))];
      const unknown = chosen.filter(id => !claude.some(profile => terminalProfileId(profile) === id));
      if (unknown.length) throw new Error(`Not a Claude Code account id: ${unknown.join(', ')}.`);
      await needs(host?.setPool)(mode as PoolMode, chosen);
      return { mode, accounts: chosen };
    })
  ];
  return [...workflowTools, ...readTools, ...manageTools];
}

function clientConfig(client: string, { url, headers }: McpConnection): string {
  if (client === 'Claude Code (command)') return `claude mcp add --transport http xdev_ai ${url} --header "Authorization: ${headers.Authorization}"`;
  if (client === 'Codex') return `[mcp_servers.xdev_ai]\nurl = ${JSON.stringify(url)}\nhttp_headers = { Authorization = ${JSON.stringify(headers.Authorization)} }\n`;
  const server = client === 'Gemini CLI' ? { httpUrl: url, headers } : { type: 'http', url, headers };
  return JSON.stringify({ [client === 'VS Code' ? 'servers' : 'mcpServers']: { xdev_ai: server } }, null, 2);
}

export interface XdevMcpOptions {
  audit?: AuditLog;
  terminals?: TerminalAccounts;
  addApiProfile?(request: ApiProfileRequest): Promise<boolean>;
  removeApiProfile?(id: string): Promise<boolean>;
}

function mcpSettings() {
  const config = vscode.workspace.getConfiguration('xdevAi.mcp');
  const level = config.get<string>('accountControl', 'read');
  return {
    autoStart: config.get<boolean>('autoStart', false),
    port: Math.trunc(config.get<number>('port', 0)),
    level: accountControlLevels.find(candidate => candidate === level) ?? 'read'
  };
}

export function registerXdevMcp(
  context: vscode.ExtensionContext, squad: SquadChat, accounts: Accounts, profiles: TerminalProfiles, options: XdevMcpOptions = {}
): void {
  let connection: McpConnection | undefined;
  let starting: Promise<void> | undefined;
  let manageOpen = false;
  let disposed = false;
  let dialogs: Promise<unknown> = Promise.resolve();
  const changed = new vscode.EventEmitter<void>();
  const stop = () => {
    connection?.dispose();
    connection = undefined;
    changed.fire();
  };
  context.subscriptions.push({ dispose() { disposed = true; stop(); } }, changed);
  const version = String(context.extension.packageJSON.version);
  const { audit, terminals } = options;

  const host: AccountHost = {
    level: () => mcpSettings().level,
    usage: terminals ? id => terminals.usage.usage(id) : undefined,
    refreshUsage: terminals ? () => terminals.usage.refresh(true) : undefined,
    perform: terminals?.perform,
    changed: terminals?.changed,
    confirm(title, detail, label, signal) {
      // One dialog at a time, so a client cannot stack prompts behind each other.
      const shown = dialogs.then(async () => {
        signal.throwIfAborted();
        const choice = await vscode.window.showWarningMessage(title, { modal: true, detail }, label);
        signal.throwIfAborted();
        return choice === label;
      });
      dialogs = shown.catch(() => undefined);
      return shown;
    },
    audit: audit ? (action, ok, details, error) => void audit.record('mcp', action, ok, details, error) : undefined,
    addApiProfile: options.addApiProfile,
    removeApiProfile: options.removeApiProfile,
    async setPool(mode, ids) {
      const config = vscode.workspace.getConfiguration('xdevAi.squad');
      const target = vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
      await config.update('accountPool', mode, target);
      await config.update('poolAccounts', ids, target);
    }
  };

  async function token(rotate = false): Promise<string> {
    const { newMcpToken, validMcpToken } = await import('./mcp-transport.js');
    const saved = rotate ? undefined : await context.secrets.get(tokenKey);
    if (validMcpToken(saved)) return saved;
    const next = newMcpToken();
    await context.secrets.store(tokenKey, next);
    return next;
  }

  function start(): Promise<void> {
    starting ??= (async () => {
      const { startMcp } = await import('./mcp-transport.js');
      const next = await startMcp(version, xdevMcpTools(squad, accounts, profiles, host), { port: mcpSettings().port, token: await token() });
      if (disposed) { next.dispose(); return; }
      connection?.dispose();
      connection = next;
      changed.fire();
    })().finally(() => { starting = undefined; });
    return starting;
  }

  async function restart(): Promise<void> {
    stop();
    await start();
  }

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

  const ready = () => vscode.workspace.isTrusted && Boolean(vscode.workspace.workspaceFolders?.length);
  const autoStart = () => {
    if (disposed || connection || !ready() || !mcpSettings().autoStart) return;
    start().catch(error => {
      void vscode.window.showWarningMessage(`xDev AI MCP did not start automatically. ${error instanceof Error ? error.message : ''}`);
    });
  };

  context.subscriptions.push(
    vscode.workspace.onDidGrantWorkspaceTrust(autoStart),
    vscode.workspace.onDidChangeWorkspaceFolders(autoStart),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (!event.affectsConfiguration('xdevAi.mcp')) return;
      if (connection) {
        // Tools and their access level are fixed for a running server, so restart it with the new settings.
        restart().catch(error => void vscode.window.showErrorMessage(`xDev AI MCP could not restart. ${error instanceof Error ? error.message : ''}`));
      } else autoStart();
    }),
    vscode.commands.registerCommand('xdevAi.rotateMcpToken', async () => {
      const rotate = 'Rotate Token';
      if (await vscode.window.showWarningMessage('Rotate the xDev AI MCP token?', {
        modal: true, detail: 'Clients using the current token lose access until you copy the new configuration to them.'
      }, rotate) !== rotate) return;
      await token(true);
      void audit?.record('user', 'mcp_rotate_token', true);
      if (connection) await restart();
      void vscode.window.showInformationMessage('The xDev AI MCP token was rotated. Copy the client configuration again.');
    })
  );
  autoStart();

  context.subscriptions.push(vscode.commands.registerCommand('xdevAi.manageMcp', async () => {
    if (manageOpen || disposed) return;
    if (!ready()) {
      void vscode.window.showWarningMessage('Open a trusted workspace folder to start xDev AI MCP.');
      return;
    }
    manageOpen = true;
    try {
      const settings = mcpSettings();
      const startLabel = 'Start MCP';
      const stopLabel = 'Stop MCP';
      const restartLabel = 'Restart MCP';
      const copyLabel = 'Copy Client Configuration';
      const rotateLabel = 'Rotate Token';
      const levelLabel = `Account Control: ${settings.level}`;
      const autoLabel = `Start Automatically: ${settings.autoStart ? 'on' : 'off'}`;
      const auditLabel = 'Show Audit Log';
      const items: vscode.QuickPickItem[] = [
        ...(connection ? [{ label: copyLabel }, { label: restartLabel }, { label: stopLabel }] : [{ label: startLabel }]),
        { label: '', kind: vscode.QuickPickItemKind.Separator },
        { label: levelLabel, description: 'off · read · manage', detail: 'What AI clients may do with your accounts. Changes always ask you first when they delete, sign in, or bypass.' },
        { label: autoLabel, description: settings.port ? `port ${settings.port}` : 'random port', detail: 'Set xdevAi.mcp.port so client configuration keeps working after a restart.' },
        { label: rotateLabel },
        { label: auditLabel }
      ];
      const action = (await vscode.window.showQuickPick(items, {
        title: `xDev AI MCP · ${connection ? `Running at ${connection.url}` : 'Stopped'}`,
        placeHolder: connection ? 'Connect a client or change the server' : 'Enable local MCP access for this workspace window'
      }))?.label;
      if (disposed || !action) return;
      if (action === stopLabel) stop();
      if (action === startLabel || action === restartLabel) {
        await (action === startLabel ? start() : restart());
        void vscode.window.showInformationMessage('xDev AI MCP is running. Open MCP: List Servers in VS Code or copy the configuration for another client.');
      }
      if (action === levelLabel) {
        const level = await vscode.window.showQuickPick(accountControlLevels.map(id => ({
          label: id, picked: id === settings.level,
          description: { off: 'No account tools', read: 'List accounts, quota, and picks', manage: 'Also rename, tag, open, sign in, delete (with confirmation), and set the Squad pool' }[id]
        })), { title: 'xDev AI MCP account control' });
        if (level) {
          await vscode.workspace.getConfiguration('xdevAi.mcp').update('accountControl', level.label, vscode.ConfigurationTarget.Global);
          void audit?.record('user', 'mcp_account_control', true, { level: level.label });
        }
      }
      if (action === autoLabel) {
        await vscode.workspace.getConfiguration('xdevAi.mcp').update('autoStart', !settings.autoStart, vscode.ConfigurationTarget.Global);
      }
      if (action === rotateLabel) await vscode.commands.executeCommand('xdevAi.rotateMcpToken');
      if (action === auditLabel) await vscode.commands.executeCommand('xdevAi.showAuditLog');
      if (action === copyLabel && connection) {
        const client = await vscode.window.showQuickPick(['Claude Code', 'Claude Code (command)', 'Codex', 'Gemini CLI', 'VS Code'], {
          title: 'Copy xDev AI MCP Configuration', placeHolder: 'The copied configuration includes a private token'
        });
        if (!client || !connection) return;
        await vscode.env.clipboard.writeText(clientConfig(client, connection));
        void vscode.window.showInformationMessage(settings.port
          ? 'xDev AI MCP configuration copied. Keep it private; it keeps working until you rotate the token or change the port.'
          : 'xDev AI MCP configuration copied. Keep it private. The port changes when MCP restarts; set xdevAi.mcp.port to keep it.');
      }
    } catch (error) {
      void vscode.window.showErrorMessage(`xDev AI MCP could not complete the operation. ${error instanceof Error ? error.message : ''}`);
    } finally {
      manageOpen = false;
    }
  }));
}
