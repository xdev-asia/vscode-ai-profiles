import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative } from 'node:path';
import * as vscode from 'vscode';
import { Accounts, accountStorageKey } from './accounts';
import {
  findTerminalExecutable, terminalProfileEnv, terminalProfileId, terminalProviders, type TerminalProfile, type TerminalProfiles
} from './terminal-profiles';
import { chat, providers } from './core';
import { isRole, noteLimit, readTask, roles, SquadStore, type Role } from './squad';
import { approvalSettings, disposableRun, poolModes, runTitle, settledAt, SquadChat, type RunTree, type SquadOptions, type WorkerHost } from './squad-chat';
import { readClaudeQuota } from './account-usage';
import { allEnvFiles, envFilesFor, loadEnv } from './squad-env';
import { mcpControl, mcpServerName, onMcpChanged } from './mcp-control';
import { readMcpGrants, readProjectMcp, workerMcp, type McpGrant } from './squad-mcp';
import { folderSize, formatBytes, freeBytes, removeFolders, sessionFolder, sessionFolders } from './squad-storage';
import { FileMemento, workspaceKey } from './squad-state';
import { registerSquadTools } from './squad-tools';
import { squadPage } from './squad-html';
import { memoryTextLimit } from './squad-memory';
import { exploreCode, findRepositories, hasCodegraph } from './squad-codegraph';
import { launch, runClaude, terminalArguments, validCommand, workerSummary, type WorkerSettings } from './squad-worker';
import { git, validBranch, Worktrees, type MergeRequestMode } from './squad-worktree';
import { mergeSkills, readSyncFolder, syncProfileSkills, writeSyncFolder } from './skill-sync';

const viewId = 'xdevAi.squad';
type SquadTab = 'workflow' | 'customizations' | 'memory' | 'project' | 'mcp';

function squadSetting<T>(key: string, fallback: T): T {
  return vscode.workspace.getConfiguration('xdevAi.squad').get<T>(key) ?? fallback;
}

/** `xdevAi.squad.planApproval` and `xdevAi.squad.approver`; unset or unknown values leave every decision to the user. */
function approval(): Pick<SquadOptions, 'planApproval' | 'approver'> {
  const config = vscode.workspace.getConfiguration('xdevAi.squad');
  return approvalSettings(key => config.get(key));
}

function squadOptions(): SquadOptions {
  const pool = squadSetting<string>('accountPool', 'role');
  return {
    leadSessionTurns: Number(squadSetting<number>('leadSessionTurns', 20)),
    ...approval(),
    accountPool: poolModes.find(candidate => candidate === pool) ?? 'role',
    poolAccounts: squadSetting<unknown[]>('poolAccounts', []).filter((item): item is string => typeof item === 'string'),
    resumeFeedback: squadSetting('resumeFeedback', true)
  };
}

function workspaceFolder(): string | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  return folder?.scheme === 'file' ? folder.fsPath : undefined;
}

/** Extra allowed commands per repository, keyed by its path in the workspace or by its folder name. */
function repositoryCommands(): Record<string, string[]> {
  const configured = squadSetting<Record<string, unknown>>('repositoryAllowedCommands', {});
  if (!configured || typeof configured !== 'object' || Array.isArray(configured)) return {};
  return Object.fromEntries(Object.entries(configured).flatMap(([repo, commands]) =>
    Array.isArray(commands) && repo.trim() ? [[repo.trim().replace(/\/+$/, ''), commands.filter(validCommand)]] : []));
}

function commandsFor(repo: string | undefined): string[] {
  const base = squadSetting<unknown[]>('workerAllowedCommands', []).filter(validCommand);
  if (!repo) return base;
  const extra = repositoryCommands();
  const own = extra[repo] ?? extra[repo.split('/').at(-1)!] ?? [];
  return [...new Set([...base, ...own])];
}

/**
 * MCP servers this project grants Squad workers (xdevAi.squad.mcpServers), with servers looked up in the
 * project's .mcp.json. Nothing is granted in an untrusted workspace, because the settings start programs.
 */
function mcpGrants(): McpGrant[] {
  const folder = workspaceFolder();
  if (!folder || !vscode.workspace.isTrusted) return [];
  return readMcpGrants(squadSetting<unknown>('mcpServers', {}), readProjectMcp(folder));
}

export interface DeployTarget {
  /** The branch merge requests land on, for example dev. */
  from: string;
  /** The branch whose changes start the deploy pipeline, for example build-dev. Without it, merging into `from` deploys. */
  to?: string;
  /** An https address that answers when the deployed app is up. */
  health?: string;
}

/** xdevAi.squad.deployTargets, validated: { repo: { from, to?, health? } }. */
function deployTargets(): Record<string, DeployTarget> {
  const configured = squadSetting<Record<string, unknown>>('deployTargets', {});
  if (!configured || typeof configured !== 'object' || Array.isArray(configured)) return {};
  return Object.fromEntries(Object.entries(configured).flatMap(([repo, value]) => {
    const entry = value as Record<string, unknown> | null;
    if (!entry || typeof entry !== 'object' || !repo.trim()) return [];
    const from = typeof entry.from === 'string' && validBranch(entry.from.trim()) ? entry.from.trim() : undefined;
    const to = typeof entry.to === 'string' && validBranch(entry.to.trim()) ? entry.to.trim() : undefined;
    const health = typeof entry.health === 'string' && /^https?:\/\/[^\s]+$/i.test(entry.health.trim()) ? entry.health.trim() : undefined;
    if (!from || from === to) return [];
    return [[repo.trim().replace(/\/+$/, ''), { from, ...(to ? { to } : {}), ...(health ? { health } : {}) }]];
  }));
}

function deployFor(repo: string): DeployTarget | undefined {
  const targets = deployTargets();
  return targets[repo] ?? targets[repo.split('/').at(-1)!];
}

/** Base branches per repository (xdevAi.squad.repositoryBaseBranches), keyed by path or folder name. */
function repositoryBases(): Record<string, string> {
  const configured = squadSetting<Record<string, unknown>>('repositoryBaseBranches', {});
  if (!configured || typeof configured !== 'object' || Array.isArray(configured)) return {};
  return Object.fromEntries(Object.entries(configured).flatMap(([repo, branch]) =>
    typeof branch === 'string' && validBranch(branch.trim()) && repo.trim() ? [[repo.trim().replace(/\/+$/, ''), branch.trim()]] : []));
}

function ownBase(repo: string | undefined): string | undefined {
  if (!repo) return undefined;
  const bases = repositoryBases();
  return bases[repo] ?? bases[repo.split('/').at(-1)!];
}

/** The branch a repository's worktrees start from: its own base branch, else xdevAi.squad.baseBranch, else HEAD. */
function baseBranchFor(repo?: string): string | undefined {
  return ownBase(repo) ?? (squadSetting<string>('baseBranch', '').trim() || undefined);
}

function cleanupDays(): number {
  const days = Number(squadSetting<number>('cleanupAfterDays', 7));
  return Number.isFinite(days) ? Math.min(Math.max(Math.round(days), 0), 365) : 7;
}

function minFreeBytes(): number {
  const gb = Number(squadSetting<number>('minFreeDiskGb', 2));
  return (Number.isFinite(gb) ? Math.min(Math.max(gb, 0), 1000) : 2) * 1024 ** 3;
}

function workerSettings(role: Role, repo?: string): WorkerSettings {
  const models = squadSetting<Record<string, unknown>>('workerModels', {});
  const model = typeof models[role] === 'string' && /^[\w.:[\]-]{1,80}$/.test(models[role] as string) ? models[role] as string : undefined;
  const budget = Number(squadSetting<number>('workerBudgetUsd', 1));
  const minutes = Number(squadSetting<number>('workerTimeoutMinutes', 20));
  return {
    model,
    budgetUsd: Number.isFinite(budget) && budget >= 0 ? Math.min(budget, 50) : 1,
    allowedCommands: commandsFor(repo),
    timeoutMs: (Number.isFinite(minutes) ? Math.min(Math.max(minutes, 1), 120) : 20) * 60_000,
    mcp: workerMcp(mcpGrants(), role),
    ...workerEnv(role, repo)
  };
}

/**
 * The project's .env values for the roles that run commands (Implement, Tests), read from the main checkout when
 * the step starts; and, for every role, the files no worker may read. Nothing in an untrusted workspace.
 */
function workerEnv(role: Role, repo?: string): Pick<WorkerSettings, 'env' | 'denyRead'> {
  const folder = workspaceFolder();
  if (!folder || !vscode.workspace.isTrusted) return {};
  const setting = squadSetting<unknown>('workerEnvFiles', {});
  const denyRead = allEnvFiles(setting, folder).filter(file => !file.problem).map(file => file.path);
  const own = repo && (role === 'Implement' || role === 'Tests') ? envFilesFor(setting, folder, repo) : [];
  const env = own.length ? loadEnv(own) : undefined;
  return { ...(env && Object.keys(env).length ? { env } : {}), ...(denyRead.length ? { denyRead } : {}) };
}

function codegraphTimeoutMs(): number {
  const seconds = Number(squadSetting<number>('codegraphTimeoutSeconds', 20));
  return (Number.isFinite(seconds) ? Math.min(Math.max(seconds, 5), 300) : 20) * 1000;
}

/** The workspace's identity across windows: its .code-workspace file, else its first folder. */
function workspaceIdentity(): string | undefined {
  return vscode.workspace.workspaceFile?.scheme === 'file' ? vscode.workspace.workspaceFile.toString()
    : vscode.workspace.workspaceFolders?.[0]?.uri.toString();
}

export function registerSquad(
  context: vscode.ExtensionContext, accounts: Accounts, profiles: TerminalProfiles, onProfilesChanged: vscode.Event<void>
): SquadChat {
  const view = new SquadView(context, accounts, profiles);
  context.subscriptions.push(
    view,
    vscode.window.registerWebviewViewProvider(viewId, view),
    vscode.commands.registerCommand('xdevAi.squad.open', () => vscode.commands.executeCommand(`${viewId}.focus`)),
    vscode.commands.registerCommand('xdevAi.squad.workflow', () => view.open('workflow')),
    vscode.commands.registerCommand('xdevAi.squad.customizations', () => view.open('customizations')),
    vscode.commands.registerCommand('xdevAi.squad.memory', () => view.open('memory')),
    vscode.commands.registerCommand('xdevAi.squad.project', () => view.open('project')),
    vscode.commands.registerCommand('xdevAi.squad.mcp', () => view.open('mcp')),
    onMcpChanged(() => void view.refresh()),
    vscode.commands.registerCommand('xdevAi.squad.syncSkills', () => view.syncFolder()),
    vscode.commands.registerCommand('xdevAi.squad.cleanWorktrees', async () => {
      try {
        await view.cleanWorktrees();
      } catch (error) {
        void vscode.window.showErrorMessage(error instanceof Error ? error.message : 'Could not clean up Squad worktrees.');
      }
    }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('xdevAi.squad')) void view.refresh();
    }),
    context.secrets.onDidChange(({ key }) => {
      if (key === accountStorageKey) void view.refresh();
    }),
    onProfilesChanged(() => void view.refresh()),
    vscode.window.onDidChangeWindowState(({ focused }) => {
      if (focused) void view.refresh();
    })
  );
  view.registerChatTools();
  return view.teamChat;
}

interface StorageReport {
  time: number;
  runs: { id: string; title: string; bytes: number; disposable: boolean; settled: number }[];
  /** Folders under the project's worktree root that no run uses, such as runs dropped by older versions. */
  leftovers: { path: string; bytes: number }[];
  /** Worker transcripts for worktrees that no run uses any more. */
  transcripts: { paths: string[]; bytes: number; keptBytes: number };
  stateBytes: number;
  partial: boolean;
}

/** Where a setting's value comes from: this project's settings, the user's, or the default. */
function settingScope(key: string): 'project' | 'user' | 'default' {
  const value = vscode.workspace.getConfiguration('xdevAi.squad').inspect(key);
  if (value?.workspaceFolderValue !== undefined || value?.workspaceValue !== undefined) return 'project';
  return value?.globalValue !== undefined ? 'user' : 'default';
}

function describeServer(grant: McpGrant): string {
  const server = grant.server;
  if (server?.command) return `stdio · ${basename(server.command)}${server.args?.length ? ` ${server.args.join(' ')}`.slice(0, 60) : ''}`;
  if (server?.url) {
    try {
      return `${server.type ?? 'http'} · ${new URL(server.url).host}`;
    } catch {
      return server.type ?? 'http';
    }
  }
  return '';
}

class SquadView implements vscode.WebviewViewProvider, vscode.Disposable {
  private readonly store: SquadStore;
  readonly teamChat: SquadChat;
  private readonly running = new Map<Role, AbortController>();
  private readonly errors = new Map<Role, string>();
  private view?: vscode.WebviewView;
  private requestedTab?: SquadTab;
  private chatTools: string[] = [];
  private ready = false;
  private refreshId = 0;
  private actions = Promise.resolve();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly accounts: Accounts,
    private readonly profiles: TerminalProfiles
  ) {
    const identity = workspaceIdentity();
    const key = identity ? workspaceKey(identity) : undefined;
    // A file on the extension host shared by every window that opens this workspace; per-window state from older
    // versions is read until replaced. Extension global state is not used because each window caches its own copy.
    const shared = key ? new FileMemento(join(context.globalStorageUri.fsPath, 'squad-state', `${key}.json`), context.workspaceState) : undefined;
    const state = shared ?? context.workspaceState;
    this.stateWatch = shared?.watch(() => void this.refresh());
    this.store = new SquadStore(state);
    const worktreeRoot = this.worktreeRoot = key ? join(context.globalStorageUri.fsPath, 'squad-worktrees', key)
      : join((context.storageUri ?? context.globalStorageUri).fsPath, 'squad-worktrees');
    this.stateFile = key ? join(context.globalStorageUri.fsPath, 'squad-state', `${key}.json`) : undefined;
    const host: WorkerHost = {
      profiles: () => profiles.list('claude'),
      executable: async () => {
        const executable = await findTerminalExecutable('claude', vscode.workspace.getConfiguration('xdevAi').get<string>('claudeExecutable') ?? '');
        if (!executable) throw new Error('Claude Code was not found on the workspace host. Set xdevAi.claudeExecutable.');
        return executable;
      },
      folder: workspaceFolder,
      settings: workerSettings,
      run: request => runClaude(request),
      worktrees: this.worktrees = new Worktrees(worktreeRoot),
      repositoryCommands,
      baseBranch: repo => baseBranchFor(repo),
      worktreeLinks: () => squadSetting<unknown[]>('worktreeLinks', ['node_modules']).filter((item): item is string => typeof item === 'string'),
      prepare: async () => { await this.syncProfiles(); },
      repositories: () => this.repositories(),
      codeContext: async (request, signal) => {
        const folder = workspaceFolder();
        if (!folder || !squadSetting('codegraph', true) || Date.now() < this.codegraphPausedUntil) return undefined;
        const started = Date.now();
        const timeoutMs = codegraphTimeoutMs();
        const text = await exploreCode(folder, request, { signal, timeoutMs });
        if (!text && !signal.aborted && Date.now() - started > timeoutMs * 0.75) {
          // A busy, locked, or very large index would otherwise delay every message by the full timeout.
          this.codegraphPausedUntil = Date.now() + 10 * 60_000;
          void vscode.window.showWarningMessage(`CodeGraph did not answer within ${Math.round(timeoutMs / 1000)} seconds. Squad plans without it for the next 10 minutes. A large index may need a longer xdevAi.squad.codegraphTimeoutSeconds; a stale lock clears with "codegraph unlock".`);
        }
        return text;
      },
      codegraphRoot: async () => {
        const folder = workspaceFolder();
        return folder && squadSetting('codegraph', true) && await hasCodegraph(folder) ? folder : undefined;
      },
      checkDisk: async () => {
        const minimum = minFreeBytes();
        const free = minimum ? await freeBytes(worktreeRoot) : undefined;
        if (free !== undefined && free < minimum) {
          throw new Error(`Only ${formatBytes(free)} is free on the disk that holds Squad worktrees; Squad needs ${formatBytes(minimum)} (xdevAi.squad.minFreeDiskGb). Clean up under Squad → Project, or free disk space.`);
        }
      },
      options: squadOptions,
      quota: async profile => {
        const usage = await readClaudeQuota(profile.configDir);
        return usage.windows.length ? Math.max(...usage.windows.map(window => window.used)) : undefined;
      },
      forgetSessions: async paths => {
        const accounts = await profiles.list('claude');
        await removeFolders(accounts.flatMap(account => paths.map(path => sessionFolder(account.configDir, path))));
      }
    };
    this.teamChat = new SquadChat(state, accounts, this.store, () => void this.refresh(), host);
    // Runs whose work is merged or pushed are cleaned up after xdevAi.squad.cleanupAfterDays.
    const prune = () => {
      try {
        void this.teamChat.pruneRuns(cleanupDays()).catch(() => undefined);
      } catch {
        // Cleanup is best effort; the Project tab offers it again.
      }
    };
    this.pruneTimer = setTimeout(() => {
      prune();
      this.pruneTimer = setInterval(prune, 6 * 3_600_000);
      this.pruneTimer.unref?.();
    }, 60_000);
    this.pruneTimer.unref?.();
  }

  private readonly worktreeRoot: string;
  private readonly stateFile?: string;
  private pruneTimer?: ReturnType<typeof setTimeout>;
  private storage?: StorageReport;
  private storageBusy = false;

  private repositoryCache?: { folder: string; time: number; list: Promise<string[]> };
  private remotePoll?: ReturnType<typeof setTimeout>;
  private readonly stateWatch?: { dispose(): void };
  private codegraphPausedUntil = 0;
  private readonly worktrees: Worktrees;

  /**
   * Lists Squad worktrees in the workspace's repositories that no run in this window tracks, lets the user
   * pick which to remove, and deletes a branch only when it is merged.
   */
  /** The project's Squad configuration and storage, for the Project tab. */
  private async projectInfo() {
    const folder = workspaceFolder();
    const grants = mcpGrants();
    const projectServers = folder && vscode.workspace.isTrusted ? Object.keys(readProjectMcp(folder)).filter(name => name !== mcpServerName) : [];
    const keys = ['baseBranch', 'mergeRequests', 'mergeRequestTarget', 'workerBudgetUsd', 'workerTimeoutMinutes', 'workerAllowedCommands',
      'repositoryAllowedCommands', 'worktreeLinks', 'codegraph', 'mcpServers', 'cleanupAfterDays', 'minFreeDiskGb', 'workerEnvFiles', 'deployTargets', 'repositoryBaseBranches'];
    const free = await freeBytes(this.worktreeRoot).catch(() => undefined);
    return {
      name: vscode.workspace.name ?? (folder ? basename(folder) : ''),
      folder: folder ?? '',
      trusted: vscode.workspace.isTrusted,
      repositories: await this.repositories().catch(() => [] as string[]),
      settings: {
        baseBranch: squadSetting<string>('baseBranch', '').trim(),
        repositoryBases: repositoryBases(),
        mergeRequests: squadSetting<string>('mergeRequests', 'auto'),
        mergeRequestTarget: squadSetting<string>('mergeRequestTarget', '').trim(),
        budgetUsd: workerSettings('Implement').budgetUsd,
        timeoutMinutes: Math.round(workerSettings('Implement').timeoutMs / 60_000),
        allowedCommands: commandsFor(undefined),
        repositoryCommands: repositoryCommands(),
        worktreeLinks: squadSetting<unknown[]>('worktreeLinks', ['node_modules']).filter(item => typeof item === 'string'),
        codegraph: squadSetting('codegraph', true),
        cleanupAfterDays: cleanupDays(),
        minFreeDiskGb: minFreeBytes() / 1024 ** 3
      },
      scopes: Object.fromEntries(keys.map(key => [key, settingScope(key)])),
      mcp: grants.map(grant => ({
        name: grant.name, source: grant.source, tools: grant.tools, roles: grant.roles, problem: grant.problem, server: describeServer(grant)
      })),
      // Variable names only; values never leave the extension host.
      envFiles: folder && vscode.workspace.isTrusted ? allEnvFiles(squadSetting<unknown>('workerEnvFiles', {}), folder)
        .map(({ repo, file, names, skipped, problem }) => ({ repo, file, names, skipped, problem })) : [],
      deploy: deployTargets(),
      mcpFile: Boolean(folder && existsSync(join(folder, '.mcp.json'))),
      mcpAvailable: projectServers.filter(name => !grants.some(grant => grant.name === name)),
      disk: { free, minimum: minFreeBytes() },
      runs: { count: this.teamChat.snapshot().runs.length, limit: 10 },
      memory: { notes: this.teamChat.memory.read().length, limit: 200 },
      storage: this.storage,
      storageBusy: this.storageBusy
    };
  }

  /** Measures what Squad keeps on disk for this project. */
  async checkStorage(): Promise<void> {
    if (this.storageBusy) return;
    this.storageBusy = true;
    void this.refresh();
    try {
      const deadline = Date.now() + 60_000;
      const runs = this.teamChat.snapshot().runs;
      const used = new Set(runs.flatMap(run => (run.trees ?? []).map(tree => tree.path)));
      const sizes: StorageReport['runs'] = [];
      let partial = false;
      for (const run of runs) {
        let bytes = 0;
        for (const tree of run.trees ?? []) {
          const size = await folderSize(tree.path, deadline);
          bytes += size.bytes;
          partial ||= size.partial;
        }
        sizes.push({ id: run.id, title: runTitle(run.request), bytes, disposable: Boolean(run.trees?.length) && disposableRun(run), settled: settledAt(run) });
      }
      const leftovers: StorageReport['leftovers'] = [];
      for (const runFolder of this.subfolders(this.worktreeRoot)) {
        const inner = this.subfolders(runFolder);
        for (const path of inner.length ? inner : [runFolder]) {
          if (used.has(path)) continue;
          const size = await folderSize(path, deadline);
          partial ||= size.partial;
          leftovers.push({ path, bytes: size.bytes });
        }
      }
      const keep = new Set([...used].map(path => basename(sessionFolder('', path))));
      const transcripts: StorageReport['transcripts'] = { paths: [], bytes: 0, keptBytes: 0 };
      for (const account of await this.profiles.list('claude')) {
        for (const path of await sessionFolders(account.configDir, this.worktreeRoot)) {
          const size = await folderSize(path, deadline);
          partial ||= size.partial;
          if (keep.has(basename(path))) transcripts.keptBytes += size.bytes;
          else {
            transcripts.paths.push(path);
            transcripts.bytes += size.bytes;
          }
        }
      }
      let stateBytes = 0;
      try {
        stateBytes = this.stateFile ? statSync(this.stateFile).size : 0;
      } catch {
        // No state file yet.
      }
      this.storage = { time: Date.now(), runs: sizes, leftovers, transcripts, stateBytes, partial };
    } finally {
      this.storageBusy = false;
      void this.refresh();
    }
  }

  private subfolders(path: string): string[] {
    try {
      return readdirSync(path, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => join(path, entry.name));
    } catch {
      return [];
    }
  }

  /** Lets the user pick what to delete: runs whose work is merged or pushed, unused worktree folders, and old transcripts. */
  async cleanStorage(): Promise<void> {
    // While a run is being prepared its new worktrees are not recorded yet and would look unused.
    const busy = () => {
      const chat = this.teamChat.snapshot();
      if (chat.busy || chat.remote) throw new Error('Wait until Squad finishes preparing the run or running the step, then clean up.');
    };
    busy();
    await this.checkStorage();
    busy();
    const report = this.storage;
    if (!report) return;
    const day = 86_400_000;
    const days = cleanupDays();
    type Item = vscode.QuickPickItem & { run?: string; leftover?: string; transcripts?: boolean };
    const items: Item[] = [
      ...report.runs.filter(run => run.disposable).map(run => ({
        label: `$(git-merge) ${run.title}`,
        description: formatBytes(run.bytes),
        detail: `Run worktrees · merged or pushed ${Math.max(0, Math.round((Date.now() - run.settled) / day))} days ago; the branches stay on the remote`,
        picked: days > 0 && Date.now() - run.settled > days * day,
        run: run.id
      })),
      ...report.leftovers.map(item => ({
        label: `$(folder) ${relative(this.worktreeRoot, item.path)}`,
        description: formatBytes(item.bytes),
        detail: 'Worktree folder that no run uses; uncommitted files in it are deleted, unmerged branches are kept',
        picked: true,
        leftover: item.path
      })),
      ...(report.transcripts.paths.length ? [{
        label: '$(history) Worker transcripts of removed runs',
        description: formatBytes(report.transcripts.bytes),
        detail: `${report.transcripts.paths.length} folder${report.transcripts.paths.length === 1 ? '' : 's'} in Claude Code accounts`,
        picked: true,
        transcripts: true
      }] : [])
    ];
    if (!items.length) {
      void vscode.window.showInformationMessage('Nothing to clean up. Runs that are not merged or pushed are removed from their run card.');
      return;
    }
    const picked = await vscode.window.showQuickPick(items, { canPickMany: true, title: 'Clean up Squad storage', placeHolder: 'Pick what to delete' });
    if (!picked?.length) return;
    busy();
    let freed = 0;
    const kept: string[] = [];
    for (const item of picked) {
      if (item.run) {
        await this.teamChat.cleanRun(item.run);
        freed += report.runs.find(run => run.id === item.run)?.bytes ?? 0;
      } else if (item.leftover) {
        const branch = await this.removeLeftover(item.leftover);
        if (branch) kept.push(branch);
        freed += report.leftovers.find(entry => entry.path === item.leftover)?.bytes ?? 0;
      } else if (item.transcripts) {
        await removeFolders(report.transcripts.paths);
        freed += report.transcripts.bytes;
      }
    }
    await removeFolders(this.subfolders(this.worktreeRoot).filter(path => !this.subfolders(path).length && !readdirSync(path).length));
    this.storage = undefined;
    void vscode.window.showInformationMessage(`Freed about ${formatBytes(freed)}.${kept.length ? ` Kept unmerged branch${kept.length === 1 ? '' : 'es'}: ${kept.join(', ')}.` : ''}`);
    void this.checkStorage();
  }

  /** Removes a worktree folder no run uses. Returns its branch when the branch is kept because it is not merged. */
  private async removeLeftover(path: string): Promise<string | undefined> {
    let gitFile = '';
    try {
      gitFile = readFileSync(join(path, '.git'), 'utf8');
    } catch {
      // Not a worktree (or already detached from its repository): just delete the folder.
    }
    const repo = /^gitdir: (.+?)[\\/]\.git[\\/]worktrees[\\/]/m.exec(gitFile)?.[1];
    if (repo && existsSync(repo)) {
      const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], path).catch(() => '')).trim();
      if (validBranch(branch) && branch.startsWith('xdev/squad/')) {
        const merged = await git(['merge-base', '--is-ancestor', branch, 'HEAD'], repo).then(() => true, () => false);
        const { branchKept } = await this.worktrees.clean({ repo, path, branch, merged, changed: 0 });
        await removeFolders([path]);
        return branchKept ? branch : undefined;
      }
      await git(['worktree', 'remove', '--force', path], repo).catch(() => undefined);
      await git(['worktree', 'prune'], repo).catch(() => undefined);
    }
    await removeFolders([path]);
    return undefined;
  }

  /** Grants workers one more server from .mcp.json, asking which tools and roles. Saved in this project's settings. */
  async addMcp(): Promise<void> {
    const folder = workspaceFolder();
    if (!folder) throw new Error('Open a workspace folder first.');
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before giving workers MCP servers.');
    const available = Object.keys(readProjectMcp(folder)).filter(name => name !== mcpServerName && !mcpGrants().some(grant => grant.name === name));
    const custom = '$(edit) Define a server in settings…';
    const name = await vscode.window.showQuickPick([...available, custom], {
      title: 'Give Squad workers an MCP server', placeHolder: available.length ? 'Servers in this project\'s .mcp.json' : 'No unused servers in .mcp.json'
    });
    if (!name) return;
    if (name === custom) {
      await this.editMcpSettings();
      return;
    }
    const tools = await vscode.window.showInputBox({
      title: `Tools workers may call on ${name}`,
      prompt: 'Comma-separated tool names as the server lists them, for example query, list_tables. Use * only for read-only servers.',
      validateInput: value => value.split(',').map(item => item.trim()).filter(Boolean).every(item => item === '*' || /^[A-Za-z0-9_.-]{1,80}$/.test(item))
        && value.trim() ? undefined : 'Enter tool names separated by commas, or *.'
    });
    if (!tools) return;
    const picked = await vscode.window.showQuickPick(roles.map(role => ({ label: role, picked: role !== 'Review' })), {
      canPickMany: true, title: `Roles that may use ${name}`, placeHolder: 'AI reviews (gates) never get MCP servers'
    });
    if (!picked?.length) return;
    const config = vscode.workspace.getConfiguration('xdevAi.squad');
    const current = config.inspect<Record<string, unknown>>('mcpServers')?.workspaceValue ?? {};
    await config.update('mcpServers', {
      ...current, [name]: { tools: [...new Set(tools.split(',').map(item => item.trim()).filter(Boolean))], roles: picked.map(item => item.label) }
    }, vscode.ConfigurationTarget.Workspace);
  }

  async removeMcp(name: unknown): Promise<void> {
    const config = vscode.workspace.getConfiguration('xdevAi.squad');
    const current = { ...(config.inspect<Record<string, unknown>>('mcpServers')?.workspaceValue ?? {}) };
    if (typeof name !== 'string' || !Object.hasOwn(current, name)) {
      throw new Error('This server is not set in the project settings. Remove it where it is defined (user settings).');
    }
    const remove = 'Remove';
    if (await vscode.window.showWarningMessage(`Stop giving Squad workers the MCP server “${name}”?`, {
      modal: true, detail: 'The server stays in .mcp.json; only the Squad grant is removed from this project\'s settings.'
    }, remove) !== remove) return;
    delete current[name];
    await config.update('mcpServers', Object.keys(current).length ? current : undefined, vscode.ConfigurationTarget.Workspace);
  }

  private async editMcpSettings(): Promise<void> {
    await vscode.commands.executeCommand('workbench.action.openWorkspaceSettingsFile');
    void vscode.window.showInformationMessage('Add an entry under "xdevAi.squad.mcpServers": {"name": {"command": "…", "args": [], "tools": ["…"], "roles": ["Implement"]}}.');
  }

  async cleanWorktrees(): Promise<void> {
    const folder = workspaceFolder();
    if (!folder) throw new Error('Open a workspace folder first.');
    const known = new Set(this.teamChat.snapshot().runs.flatMap(run => (run.trees ?? []).map(tree => tree.path)));
    const repos = [...new Set(await Promise.all((await this.repositories()).map(repo => git(['rev-parse', '--show-toplevel'], repo === '.' ? folder : join(folder, repo)).then(top => top.trim(), () => ''))))].filter(Boolean);
    const leftovers = (await Promise.all(repos.map(repo => this.worktrees.leftovers(repo, known)))).flat();
    if (!leftovers.length) {
      void vscode.window.showInformationMessage('No leftover Squad worktrees in this workspace.');
      return;
    }
    const day = 86_400_000;
    const picked = await vscode.window.showQuickPick(leftovers.map(item => ({
      label: item.branch,
      description: relative(folder, item.repo) || '.',
      detail: `${item.merged ? 'Merged' : 'Not merged: the branch is kept'} · last commit ${item.changed ? `${Math.max(0, Math.round((Date.now() - item.changed) / day))} days ago` : 'unknown'} · ${item.path}`,
      picked: item.merged || Date.now() - item.changed > day,
      item
    })), {
      canPickMany: true, title: 'Remove leftover Squad worktrees',
      placeHolder: 'Uncommitted files in a removed worktree are deleted. Another window may still use a recent one.'
    });
    if (!picked?.length) return;
    const kept: string[] = [];
    for (const { item } of picked) if ((await this.worktrees.clean(item)).branchKept) kept.push(item.branch);
    void vscode.window.showInformationMessage(`Removed ${picked.length} worktree${picked.length === 1 ? '' : 's'}.${kept.length ? ` Kept unmerged branch${kept.length === 1 ? '' : 'es'}: ${kept.join(', ')}.` : ''}`);
  }

  /** Git repositories in the workspace folder, cached for a minute because a large workspace is slow to scan. */
  repositories(): Promise<string[]> {
    const folder = workspaceFolder();
    if (!folder) return Promise.resolve([]);
    const cached = this.repositoryCache;
    if (cached?.folder === folder && Date.now() - cached.time < 60_000) return cached.list;
    // The folder counts when it sits anywhere inside a repository; nested folders only when they are a repository root.
    const list = findRepositories(folder, path => git(['rev-parse', '--show-toplevel'], path)
      .then(top => path === folder || relative(top.trim(), path) === '', () => false));
    this.repositoryCache = { folder, time: Date.now(), list };
    return list;
  }

  /** Copies enabled skills into every Claude Code account so headless workers load them on demand. */
  async syncProfiles(): Promise<number> {
    if (!squadSetting('syncSkillsToProfiles', true)) return 0;
    return syncProfileSkills(await this.profiles.list('claude'), this.teamChat.customizations.enabledSkills());
  }

  private syncFolderPath(): string | undefined {
    const configured = squadSetting<string>('syncFolder', '').trim();
    if (!configured) return undefined;
    if (isAbsolute(configured)) return configured;
    const folder = workspaceFolder();
    return folder ? join(folder, configured) : undefined;
  }

  /**
   * Two-way sync of skills and Squad memory with a folder, normally a clone of the team's docs repository.
   * Git pull and a local commit happen automatically; pushing always asks first.
   */
  async syncFolder(): Promise<void> {
    let folder = this.syncFolderPath();
    if (!folder) {
      const picked = await vscode.window.showOpenDialog({
        canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
        openLabel: 'Use for skill sync', title: 'Choose a folder (for example a clone of your docs repository) to sync skills and memory'
      });
      if (!picked?.[0]) return;
      folder = picked[0].fsPath;
      await vscode.workspace.getConfiguration('xdevAi.squad').update('syncFolder', folder,
        vscode.workspace.workspaceFolders ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global);
    }
    const repository = await git(['rev-parse', '--show-toplevel'], folder).then(() => true, () => false);
    const notes: string[] = [];
    if (repository) {
      const upstream = await git(['rev-parse', '--abbrev-ref', '@{u}'], folder).then(() => true, () => false);
      if (upstream) {
        await git(['pull', '--ff-only', '-q'], folder).catch((error: Error) => notes.push(`Pull skipped: ${error.message}`));
      }
    }
    const customizations = this.teamChat.customizations;
    const remote = await readSyncFolder(folder);
    const state = customizations.read();
    const merge = mergeSkills(state.skills, remote.skills, state.syncBase ?? {});
    const memoryAdded = await this.teamChat.memory.merge(remote.memory);
    await writeSyncFolder(folder, merge.skills.filter(skill => !skill.name.endsWith('(sync copy)')), this.teamChat.memory.read());
    let committed = false;
    if (repository) {
      await git(['add', '--', 'skills', 'memory'], folder);
      const staged = (await git(['diff', '--cached', '--name-only'], folder)).trim();
      if (staged) {
        await git(['commit', '-q', '-m', 'xDev: sync skills and memory'], folder)
          .then(() => { committed = true; }, (error: Error) => notes.push(`Commit failed: ${error.message}`));
      }
    }
    const summary = [
      `${merge.skills.length} skills`, merge.pulled ? `${merge.pulled} updated from folder` : '',
      merge.conflicts ? `${merge.conflicts} conflict${merge.conflicts === 1 ? '' : 's'} kept as “(sync copy)”` : '',
      memoryAdded ? `${memoryAdded} memory notes added` : '', committed ? 'committed locally' : '', ...notes
    ].filter(Boolean).join(' · ');
    await customizations.applySync(merge.skills, merge.base, { time: Date.now(), folder, summary });
    await this.syncProfiles();
    if (committed) {
      const push = 'Push';
      const choice = await vscode.window.showInformationMessage('Skills and memory were committed in the sync folder. Push them to the remote?', {
        modal: true, detail: `${folder}\nTeammates receive the change on their next sync.`
      }, push);
      if (choice === push) {
        await git(['push', '-q'], folder);
        await customizations.applySync(merge.skills, merge.base, { time: Date.now(), folder, summary: `${summary} · pushed` });
      }
    }
  }

  registerChatTools(): void {
    this.chatTools = registerSquadTools(this.context, this.teamChat);
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.ready = false;
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    const receiver = view.webview.onDidReceiveMessage(message => {
      if (message?.type === 'ready') {
        this.ready = true;
        this.showRequestedTab();
        void this.refresh();
        return;
      }
      this.actions = this.actions.then(async () => {
        if (this.view !== view) return;
        const type = message?.type === 'squadChat' ? 'chatSettled' :
          message?.type === 'workspace' || message?.type === 'project' || message?.type === 'mcp' ? 'workspaceSettled' : 'settled';
        try {
          const data = await this.receive(message);
          await this.refresh();
          void view.webview.postMessage({ type, action: message?.action, data });
        } catch (error) {
          void view.webview.postMessage({
            type,
            error: error instanceof Error ? error.message : 'Unable to update the squad.'
          });
        }
      });
    });
    const visibility = view.onDidChangeVisibility(() => {
      if (view.visible) void this.refresh();
    });
    view.onDidDispose(() => {
      receiver.dispose();
      visibility.dispose();
      if (this.view === view) this.view = undefined;
    });
    view.webview.html = squadHtml(view.webview, media);
  }

  async open(tab: SquadTab): Promise<void> {
    this.requestedTab = tab;
    await vscode.commands.executeCommand(`${viewId}.focus`);
    this.showRequestedTab();
  }

  private showRequestedTab(): void {
    if (!this.ready || !this.view?.visible || !this.requestedTab) return;
    void this.view.webview.postMessage({ type: 'selectTab', tab: this.requestedTab });
    this.requestedTab = undefined;
  }

  dispose(): void {
    clearTimeout(this.remotePoll);
    clearTimeout(this.pruneTimer);
    clearInterval(this.pruneTimer);
    this.stateWatch?.dispose();
    this.view = undefined;
    this.teamChat.cancel();
    for (const controller of this.running.values()) controller.abort();
  }

  async refresh(): Promise<void> {
    const view = this.view;
    if (!view?.visible) return;
    const id = ++this.refreshId;
    try {
      const accounts = await this.profilesForBoard();
      if (view !== this.view || id !== this.refreshId) return;
      const teamChat = this.teamChat.snapshot();
      // Another window's run does not notify this one; poll while it lasts.
      clearTimeout(this.remotePoll);
      if (teamChat.remote) this.remotePoll = setTimeout(() => void this.refresh(), 3_000);
      void view.webview.postMessage({
        type: 'state',
        ...this.store.read(),
        teamChat,
        customizations: this.teamChat.customizations.read(),
        mcp: mcpControl()?.state(),
        memory: this.teamChat.memory.read(),
        sync: {
          folder: this.syncFolderPath() ?? '',
          profiles: squadSetting('syncSkillsToProfiles', true),
          approver: approval().approver,
          workers: {
            ...workerSummary(workerSettings('Implement')), models: squadSetting('workerModels', {}), repositoryCommands: repositoryCommands(),
            baseBranch: squadSetting<string>('baseBranch', '').trim()
          },
          deploy: deployTargets()
        },
        nativeChatTools: this.chatTools,
        project: await this.projectInfo(),
        accounts,
        running: [...this.running.keys()],
        errors: Object.fromEntries(this.errors)
      });
    } catch {
      if (view === this.view && id === this.refreshId) {
        void view.webview.postMessage({ type: 'loadError', error: 'Unable to load squad profiles.' });
      }
    }
  }

  private async profilesForBoard() {
    const [api, terminals] = await Promise.all([this.accounts.read(), this.profiles.list()]);
    return [
      ...api.accounts.map(account => ({
        id: `api:${account.id}`, kind: 'api', name: account.name, detail: providers[account.provider].name
      })),
      ...terminals.map(profile => ({
        id: terminalProfileId(profile), kind: 'terminal', name: profile.name, detail: terminalProviders[profile.provider].name
      }))
    ];
  }

  private async receive(input: unknown): Promise<unknown> {
    if (!input || typeof input !== 'object') return;
    const message = input as Record<string, unknown>;
    if (message.type === 'workspace') return this.updateWorkflowOrCustomizations(message);
    if (message.type === 'mcp') {
      const mcp = mcpControl();
      if (!mcp) throw new Error('xDev AI MCP is not available in this window.');
      switch (message.action) {
        case 'setup': return mcp.setUpFolder();
        case 'start': return mcp.start();
        case 'stop': return mcp.stop();
        case 'copy': return mcp.copyConfiguration();
        case 'set': return mcp.set(message.key, message.value);
        case 'rotate': return vscode.commands.executeCommand('xdevAi.rotateMcpToken');
        case 'audit': return vscode.commands.executeCommand('xdevAi.showAuditLog');
        case 'restart': return mcp.restart();
        default: return;
      }
    }
    if (message.type === 'project') {
      switch (message.action) {
        case 'editSettings': return vscode.commands.executeCommand('workbench.action.openWorkspaceSettingsFile');
        case 'openMcpFile': {
          const folder = workspaceFolder();
          if (!folder || !existsSync(join(folder, '.mcp.json'))) throw new Error('This project has no .mcp.json.');
          return vscode.window.showTextDocument(vscode.Uri.file(join(folder, '.mcp.json')));
        }
        case 'addMcp': return this.addMcp();
        case 'removeMcp': return this.removeMcp(message.name);
        case 'checkStorage':
          // Measuring can take a while on a large project; the tab updates when it finishes.
          void this.checkStorage();
          return;
        case 'cleanStorage': return this.cleanStorage();
      }
      return;
    }
    if (message.type === 'squadChat') {
      switch (message.action) {
        case 'send':
          await this.teamChat.send(message.text);
          return;
        case 'approve':
          await this.teamChat.approve(message.id, undefined, message.approver ?? approval().approver,message.repos ?? message.repo);
          return;
        case 'discard': return this.teamChat.discard(message.id);
        case 'stop': return this.teamChat.cancel();
        case 'newChat': return this.teamChat.newChat();
        case 'openChat': return this.teamChat.openChat(message.id);
        case 'deleteChat': {
          const choice = await vscode.window.showWarningMessage('Delete this chat? Its worker runs are kept.', { modal: true }, 'Delete');
          return choice === 'Delete' ? this.teamChat.deleteChat(message.id) : undefined;
        }
        case 'runDiff': return this.showRunDiff(message.id);
        case 'runChanges': return { id: message.id, files: await this.teamChat.changes(message.id) };
        case 'runOpenFile': return this.openRunFile(message.id, message.file, message.repo);
        case 'runDiscard': {
          const { record, tree } = this.teamChat.runTree(message.id, message.repo);
          if (typeof message.file !== 'string') return;
          const discard = 'Discard changes';
          if (await vscode.window.showWarningMessage(`Discard the changes to ${message.file}?`, {
            modal: true, detail: `The file goes back to how it was before the run on ${tree.branch}.${record.status === 'active' ? '' : ' A new local commit records this.'}`
          }, discard) !== discard) return;
          await this.teamChat.discardFile(record.id, message.file, tree.target);
          return { id: record.id, files: await this.teamChat.changes(record.id) };
        }
        case 'runRequestChanges':
          await this.teamChat.requestChanges(message.id, message.text, message.repo);
          return;
        case 'runPush': return this.pushRun(message.id);
        case 'runDeploy': return this.deployRun(message.id);
        case 'runHealth': return this.checkHealth(message.id, true);
        case 'runDeployLink': {
          const tree = this.teamChat.runTree(message.id, message.repo).tree;
          if (!tree.deploy?.url) throw new Error('This deploy has no merge request link.');
          await vscode.env.openExternal(vscode.Uri.parse(tree.deploy.url));
          return;
        }
        case 'runLink': {
          const tree = this.teamChat.runTree(message.id, message.repo).tree;
          if (!tree.pushed?.url) throw new Error('This branch has no merge request link yet.');
          await vscode.env.openExternal(vscode.Uri.parse(tree.pushed.url));
          return;
        }
        case 'runOpen': {
          const tree = await this.pickTree(message.id, 'Open which repository of this run?');
          if (tree) await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(tree.path), { forceNewWindow: true });
          return;
        }
        case 'runResume': return this.resumeSession(message.id, message.session);
        case 'runMerge': return this.mergeRun(message.id);
        case 'stepRun':
          await this.teamChat.runStep(message.id, message.brief);
          return;
        case 'stepTerminal': return this.terminalStep(message.id, message.brief);
        case 'stepDone': return this.teamChat.completeStep(message.id, message.summary);
        case 'stepSkip': return this.teamChat.skipStep(message.id);
        case 'runFinish': return this.teamChat.finish(message.id);
        case 'runRemove': {
          const run = this.requireRun(message.id);
          const trees = run.trees ?? [];
          const branch = trees[0]?.branch;
          const remove = branch ? (trees.length > 1 ? 'Remove worktrees' : 'Remove worktree') : 'Remove run';
          const pushed = trees.filter(tree => tree.pushed).map(tree => tree.target);
          if (await vscode.window.showWarningMessage(branch ? `Remove the ${trees.length > 1 ? `${trees.length} worktrees` : 'worktree'} and local branch ${branch}?` : 'Remove this run?', {
            modal: true,
            detail: branch ? `Unmerged local changes on this branch are deleted.${pushed.length ? ' Branches already pushed stay on the remote.' : ''}` : 'Its replies stay in the chat.'
          }, remove) === remove) await this.teamChat.removeRun(run.id);
          return;
        }
        case 'settings':
          await vscode.commands.executeCommand('workbench.action.openSettings', 'xdevAi.squad');
          return;
        case 'terminal': return this.receive({ type: 'terminal', role: message.role });
        case 'addProfile':
          await vscode.commands.executeCommand('xdevAi.addAiAccount');
          return;
        case 'assignAll': return this.receive({ type: 'assignAll', account: message.account });
      }
      return;
    }
    if (message.type === 'assignAll') {
      if (typeof message.account !== 'string' || !(await this.profilesForBoard()).some(profile => profile.id === message.account)) {
        throw new Error('That profile is no longer available.');
      }
      if (this.running.size) throw new Error('Wait for the API responses or cancel them.');
      await this.store.assignAll(message.account, roles);
      return;
    }
    if (!isRole(message.role)) return;
    const role = message.role;
    const seat = this.store.seat(role);

    switch (message.type) {
      case 'save': {
        if (this.running.has(role)) throw new Error('Wait for the API response or cancel the request.');
        const task = readTask(message);
        if (task.account && task.account !== seat.account) {
          const profiles = await this.profilesForBoard();
          if (!profiles.some(profile => profile.id === task.account)) throw new Error('That profile is no longer available.');
        }
        await this.store.save(role, task);
        this.errors.delete(role);
        break;
      }
      case 'handoff': {
        const { to, note } = message;
        if (!isRole(to) || to === role || typeof note !== 'string' || !note.trim() || note.length > noteLimit) {
          throw new Error('Choose a recipient and enter a handoff note.');
        }
        await this.store.handoff(role, to, note.trim());
        break;
      }
      case 'copy':
        if (seat.brief) await vscode.env.clipboard.writeText(seat.brief);
        break;
      case 'terminal':
      case 'usage': {
        const profile = (await this.profiles.list()).find(candidate => terminalProfileId(candidate) === seat.account);
        if (!profile) throw new Error('Assign an AI terminal profile first.');
        await vscode.commands.executeCommand(message.type === 'usage' ? 'xdevAi.checkUsage' : 'xdevAi.openTerminal', seat.account);
        break;
      }
      case 'run':
        if (!seat.brief || this.running.has(role)) return;
        await this.startRequest(role, seat.account, seat.brief);
        break;
      case 'stop':
        this.running.get(role)?.abort();
        break;
    }
  }

  private async updateWorkflowOrCustomizations(message: Record<string, unknown>): Promise<void> {
    const squad = this.teamChat;
    const { id, step } = message;
    switch (message.action) {
      case 'start': return squad.startWorkflow(message.brief);
      case 'approve': return squad.approveStage(id, step, message.output);
      case 'draft':
        await squad.draftStage(id, step);
        return;
      case 'stop': return squad.cancel();
      case 'copy': {
        const { instruction, brief, approved, skills } = squad.stageRequest(id, step);
        const text = [instruction, `Project brief\n${brief}`,
          ...approved.map(result => `${result.stage} · approved\n${result.result}`),
          ...skills.map(skill => `${skill.name}\n${skill.instructions}`)].join('\n\n');
        return vscode.env.clipboard.writeText(text);
      }
      case 'reset': {
        const reset = 'Reset Workflow';
        if (await vscode.window.showWarningMessage('Reset the current SDLC workflow?', {
          modal: true,
          detail: 'The brief and stage results will be removed. Messages already in Squad Chat remain there.'
        }, reset) === reset) await squad.resetWorkflow(id);
        return;
      }
      case 'saveSkill':
        await squad.customizations.saveSkill(message);
        await this.syncProfiles();
        return;
      case 'removeSkill': {
        const skill = squad.customizations.read().skills.find(candidate => candidate.id === id);
        const remove = 'Delete Skill';
        if (skill && await vscode.window.showWarningMessage(`Delete the skill “${skill.name}”?`, { modal: true }, remove) === remove) {
          await squad.customizations.removeSkill(id);
          await this.syncProfiles();
        }
        return;
      }
      case 'syncFolder': return this.syncFolder();
      case 'syncProfiles': {
        const count = await this.syncProfiles();
        void vscode.window.showInformationMessage(count
          ? `Enabled skills are available to ${count} Claude Code account${count === 1 ? '' : 's'}.`
          : 'Turn on xdevAi.squad.syncSkillsToProfiles and add a Claude Code account to share skills with workers.');
        return;
      }
      case 'addMemory': {
        const added = typeof message.text === 'string' ? await squad.memory.add([message.text], 'You') : 0;
        if (!added) throw new Error(`Enter a new memory note up to ${memoryTextLimit} characters.`);
        return;
      }
      case 'pinMemory':
        await squad.memory.edit(id, { pinned: message.pinned });
        return;
      case 'editMemory':
        await squad.memory.edit(id, { text: message.text });
        return;
      case 'removeMemory':
        await squad.memory.remove(id);
        return;
      case 'setTool': return squad.customizations.setTool(id, message.enabled);
      case 'manageMcp': return vscode.commands.executeCommand('xdevAi.manageMcp');
      case 'nativeTools':
      case 'nativeSkills': {
        const page = message.action === 'nativeTools' ? 'tools' : 'skills';
        const uri = vscode.Uri.parse(`${vscode.env.uriScheme}://chat-customizations/open?page=${page}`);
        if (!await vscode.env.openExternal(uri)) {
          throw new Error('Open Chat: Open Customizations in a supported VS Code session.');
        }
        return;
      }
    }
  }

  private requireRun(id: unknown) {
    const run = this.teamChat.run(id);
    if (!run) throw new Error('This run is no longer available.');
    return run;
  }

  /** The run's worktree to act on: the only one, or the one the user picks. */
  private async pickTree(id: unknown, title: string): Promise<RunTree | undefined> {
    const run = this.requireRun(id);
    const trees = run.trees ?? [];
    if (!trees.length) throw new Error('This run has no git worktree.');
    if (trees.length === 1) return trees[0];
    return (await vscode.window.showQuickPick(trees.map(tree => ({ label: tree.target, description: tree.path, tree })), { title }))?.tree;
  }

  private async claudeExecutable(): Promise<string> {
    const executable = await findTerminalExecutable('claude', vscode.workspace.getConfiguration('xdevAi').get<string>('claudeExecutable') ?? '');
    if (!executable) throw new Error('Claude Code was not found on the workspace host. Set xdevAi.claudeExecutable.');
    return executable;
  }

  /** Opens an interactive Claude Code terminal under a profile; the user drives it. */
  private openClaudeTerminal(name: string, profile: TerminalProfile, cwd: string, executable: string, args: string[]): vscode.Terminal {
    const start = launch(executable, args);
    const terminal = vscode.window.createTerminal({ name, shellPath: start.command, shellArgs: start.args, cwd, env: terminalProfileEnv(profile) });
    terminal.show();
    return terminal;
  }

  private async terminalStep(id: unknown, brief: unknown): Promise<void> {
    const executable = await this.claudeExecutable();
    const step = await this.teamChat.startTerminalStep(id, brief);
    // The system text is read from a private file, removed when the terminal closes.
    const folder = mkdtempSync(join(tmpdir(), 'xdev-squad-terminal-'));
    try {
      const file = join(folder, 'system.md');
      const { args, system } = terminalArguments(step, file, process.platform === 'win32' && /\.cmd$/i.test(executable));
      writeFileSync(file, system, { mode: 0o600 });
      const terminal = this.openClaudeTerminal(`${step.role} · ${step.name}`, step.profile, step.cwd, executable, args);
      const closed = vscode.window.onDidCloseTerminal(candidate => {
        if (candidate !== terminal) return;
        closed.dispose();
        rmSync(folder, { recursive: true, force: true });
      });
    } catch (error) {
      rmSync(folder, { recursive: true, force: true });
      throw error;
    }
  }

  /** Opens VS Code's diff editor for one file: the base commit on the left, the worktree on the right. */
  private async openRunFile(id: unknown, file: unknown, repo: unknown): Promise<void> {
    const { record, tree } = this.teamChat.runTree(id, repo);
    if (typeof file !== 'string' || !(await this.teamChat.changes(record.id)).some(change => change.path === file && change.repo === tree.target)) {
      throw new Error('That file has no changes in this run.');
    }
    const before = await git(['show', `${tree.base}:${file}`], tree.path).catch(() => '');
    const left = await vscode.workspace.openTextDocument({ content: before });
    const right = vscode.Uri.file(join(tree.path, file));
    const exists = await vscode.workspace.fs.stat(right).then(() => true, () => false);
    const target = exists ? right : (await vscode.workspace.openTextDocument({ content: '' })).uri;
    const where = (record.trees.length > 1 ? `${tree.target} · ` : '') + tree.branch;
    await vscode.commands.executeCommand('vscode.diff', left.uri, target, `${file} (${where})`, { preview: true });
  }

  private async showRunDiff(id: unknown): Promise<void> {
    const run = this.requireRun(id);
    const parts: string[] = [];
    for (const tree of run.trees ?? []) {
      const diff = await git(['diff', `${tree.base}..${tree.branch}`], tree.repo);
      parts.push((run.trees!.length > 1 ? `# ${tree.target}\n` : '') + (diff || `No changes on ${tree.branch}.`));
    }
    const document = await vscode.workspace.openTextDocument({ language: 'diff', content: parts.join('\n\n') || 'This run has no git worktree.' });
    await vscode.window.showTextDocument(document, { preview: true });
  }

  /** Merges every committed repository of the run into the branch its checkout is on, locally, after one confirmation. */
  private async mergeRun(id: unknown): Promise<void> {
    const run = this.requireRun(id);
    const trees = (run.trees ?? []).filter(tree => tree.commit && !tree.merged);
    if (!trees.length) throw new Error('This run has no committed changes to merge.');
    const targets = await Promise.all(trees.map(async tree => ({ tree, into: (await git(['rev-parse', '--abbrev-ref', 'HEAD'], tree.repo)).trim() })));
    const merge = 'Merge';
    const multiple = trees.length > 1;
    if (await vscode.window.showWarningMessage(multiple ? `Merge ${trees[0].branch} in ${trees.length} repositories?` : `Merge ${trees[0].branch} into ${targets[0].into}?`, {
      modal: true,
      detail: `${targets.map(({ tree, into }) => `${multiple ? `${tree.target}: into ${into} · ` : ''}${tree.files ?? 0} changed files`).join('\n')}\nNothing is pushed. Commit or stash local changes first.${multiple ? '' : `\n\n${trees[0].stat ?? ''}`}`
    }, merge) !== merge) return;
    const merged: string[] = [];
    for (const { tree, into } of targets) {
      try {
        await git(['merge', '--no-ff', '--no-edit', tree.branch], tree.repo);
      } catch (error) {
        throw new Error(`${multiple ? `${tree.target}: ` : ''}${error instanceof Error ? error.message : 'Merge failed.'}${merged.length ? ` Already merged: ${merged.join(', ')}.` : ''}`);
      }
      await this.teamChat.recordMerge(run.id, tree.target, into);
      merged.push(multiple ? tree.target : into);
    }
    void vscode.window.showInformationMessage(`Merged ${trees[0].branch}${multiple ? ` in ${merged.join(', ')}` : ` into ${merged[0]}`}. Remove the run when you no longer need its worktree.`);
  }

  /**
   * Pushes each committed repository's branch and, on GitLab, opens a merge request with push options.
   * The user confirms the target branch and the push first; nothing is pushed otherwise.
   */
  private async pushRun(id: unknown): Promise<void> {
    const run = this.requireRun(id);
    if (run.status === 'active') throw new Error('Finish the run before pushing it.');
    const trees = (run.trees ?? []).filter(tree => tree.commit);
    if (!trees.length) throw new Error('This run has no committed changes to push.');
    const mode = squadSetting<MergeRequestMode>('mergeRequests', 'auto');
    const configured = squadSetting<string>('mergeRequestTarget', '').trim();
    const plans = await Promise.all(trees.map(async tree => {
      const remote = await this.worktrees.remote(tree);
      // A repository with its own base branch targets it; otherwise the configured target, when the remote has it.
      const own = ownBase(tree.target) && tree.source;
      const shared = configured && (await this.worktrees.hasRemoteBranch(tree.repo, remote.name, configured)) ? configured : undefined;
      return { tree, remote, target: own || shared || tree.source || await this.worktrees.defaultTarget(tree, remote.name) };
    }));
    const multiple = plans.length > 1;
    const mergeRequests = plans.some(plan => mode === 'gitlab' || (mode === 'auto' && plan.remote.host === 'gitlab'));
    const differ = new Set(plans.map(plan => plan.target)).size > 1;
    // One target branch for all repositories keeps the dialogs short; when they differ, each keeps its own (shown before pushing).
    const asked = differ ? plans[0].target : await vscode.window.showInputBox({
      title: mergeRequests ? 'Target branch for the merge request' : 'Branch the pull request should target',
      value: plans[0].target, prompt: multiple ? `Used for ${plans.map(plan => plan.tree.target).join(', ')}.` : undefined,
      validateInput: value => validBranch(value.trim()) ? undefined : 'Enter a branch name.'
    });
    if (!asked) return;
    if (!differ) for (const plan of plans) plan.target = asked.trim();
    const target = asked;
    const title = await vscode.window.showInputBox({
      title: mergeRequests ? 'Merge request title' : 'Title', value: runTitle(run.request),
      prompt: 'Teammates see this title. Follow your team\'s convention, for example "test(api): add date parser tests".',
      validateInput: value => value.trim() ? undefined : 'Enter a title.'
    });
    if (!title) return;
    const ahead = await Promise.all(plans.map(plan => this.worktrees.ahead(plan.tree, plan.remote.name, plan.target)));
    const push = mergeRequests ? 'Push and open merge request' : 'Push';
    const lines = plans.map((plan, index) => `${multiple ? `${plan.tree.target}: ` : ''}${plan.tree.branch} → ${plan.remote.name} (${plan.remote.url})${differ ? ` · into ${plan.target}` : ''}${ahead[index] !== undefined ? ` · ${ahead[index]} commit${ahead[index] === 1 ? '' : 's'} not on ${plan.target}` : ''}`);
    if (await vscode.window.showWarningMessage(`Push ${plans[0].tree.branch}${multiple ? ` in ${plans.length} repositories` : ''}?`, {
      modal: true,
      detail: `${lines.join('\n')}\n${mergeRequests ? `GitLab opens a merge request into ${differ ? 'each repository\'s target' : target.trim()} (or updates the open one).` : 'The remote may print a link to open a pull request.'} Teammates can see the branch once it is pushed.`
    }, push) !== push) return;
    for (const plan of plans) {
      const result = await this.worktrees.push(plan.tree, { target: plan.target, title: title.trim(), mode });
      await this.teamChat.recordPush(run.id, plan.tree.target, result);
    }
    const links = this.teamChat.run(run.id)?.trees?.flatMap(tree => tree.pushed?.url ? [tree.pushed.url] : []) ?? [];
    if (links.length) {
      const open = links.length > 1 ? 'Open merge requests' : 'Open merge request';
      if (await vscode.window.showInformationMessage(`Pushed ${plans[0].tree.branch}.`, open) === open) {
        for (const link of links) await vscode.env.openExternal(vscode.Uri.parse(link));
      }
    } else {
      void vscode.window.showInformationMessage(`Pushed ${plans[0].tree.branch}.`);
    }
  }

  /**
   * Asks for a deploy of the repositories this run pushed: for each with a deploy target, fetches the branches,
   * shows what would be deployed, and after you confirm opens a GitLab merge request from → to. Merging stays with you.
   */
  private async deployRun(id: unknown): Promise<void> {
    const run = this.requireRun(id);
    const items = (run.trees ?? []).flatMap(tree => {
      const target = deployFor(tree.target);
      return target && tree.pushed ? [{ tree, target }] : [];
    });
    if (!items.length) throw new Error('Push the run first, and set a deploy target for its repository in xdevAi.squad.deployTargets.');
    const plans = [];
    for (const { tree, target } of items) {
      const remote = await this.worktrees.remote(tree);
      const fetched = await this.worktrees.fetchBranch(tree.repo, remote.name, target.from);
      if (!fetched) throw new Error(`${remote.name}/${target.from} was not found for ${tree.target}.`);
      if (target.to && !(await this.worktrees.fetchBranch(tree.repo, remote.name, target.to))) {
        throw new Error(`${remote.name}/${target.to} was not found for ${tree.target}.`);
      }
      const merged = tree.commit ? await this.worktrees.contains(tree.repo, remote.name, target.from, tree.commit) : false;
      const behind = target.to ? await this.worktrees.behind(tree.repo, remote.name, target.from, target.to) : undefined;
      plans.push({ tree, target, remote, merged, behind });
    }
    const multiple = plans.length > 1;
    const lines = plans.map(plan => `${multiple || plan.tree.target !== '.' ? `${plan.tree.target}: ` : ''}${plan.target.to
      ? `${plan.remote.name}/${plan.target.from} → ${plan.target.to} · ${plan.behind === undefined ? 'unknown number of' : plan.behind} commit${plan.behind === 1 ? '' : 's'} to deploy`
      : `deploys when ${plan.target.from} changes; only the health check runs`}${plan.merged ? '' : `\n  This run's commit is not on ${plan.target.from} yet: its merge request is not merged (or was squashed).`}`);
    const requests = plans.filter(plan => plan.target.to && plan.behind !== 0);
    if (!requests.length && !plans.some(plan => plan.target.health || (!plan.target.to && plan.merged))) {
      void vscode.window.showInformationMessage(`Nothing to deploy yet. ${lines.join(' ').replace(/\s+/g, ' ')}`);
      return;
    }
    const confirm = requests.length ? (requests.length > 1 ? 'Open deploy merge requests' : 'Open deploy merge request') : 'Check health';
    if (await vscode.window.showWarningMessage(requests.length ? 'Ask for a deploy?' : 'Nothing to merge for a deploy.', {
      modal: true,
      detail: `${lines.join('\n')}\n${requests.length ? 'GitLab opens a merge request for each; merging it starts the deploy pipeline. Teammates can see it.' : ''}`
    }, confirm) !== confirm) return;
    const mode = squadSetting<MergeRequestMode>('mergeRequests', 'auto');
    for (const plan of plans) {
      if (plan.target.to && plan.behind !== 0) {
        const result = await this.worktrees.deploy(plan.tree.repo, {
          from: plan.target.from, to: plan.target.to, branch: `xdev/deploy/${run.id.slice(0, 8)}`,
          title: `Deploy ${plan.target.from} → ${plan.target.to}: ${runTitle(run.request)}`, mode
        });
        await this.teamChat.recordDeploy(run.id, plan.tree.target, { from: plan.target.from, to: plan.target.to, url: result.url });
      } else if (!plan.target.to && plan.merged) {
        // Merging into `from` is the deploy; until the run's merge request is merged there is nothing to record.
        await this.teamChat.recordDeploy(run.id, plan.tree.target, { from: plan.target.from });
      }
    }
    await this.checkHealth(run.id, false);
    const links = this.teamChat.run(run.id)?.trees?.flatMap(tree => tree.deploy?.url ? [tree.deploy.url] : []) ?? [];
    if (links.length) {
      const open = links.length > 1 ? 'Open merge requests' : 'Open merge request';
      if (await vscode.window.showInformationMessage('Deploy merge request ready. Merge it in GitLab to deploy.', open) === open) {
        for (const link of links) await vscode.env.openExternal(vscode.Uri.parse(link));
      }
    }
  }

  /** Calls each deployed repository's health address and records the HTTP status (0 when it does not answer). */
  private async checkHealth(id: unknown, report: boolean): Promise<void> {
    const run = this.requireRun(id);
    const checks = (run.trees ?? []).flatMap(tree => {
      const health = deployFor(tree.target)?.health;
      return health ? [{ tree, health }] : [];
    });
    if (!checks.length) {
      if (report) throw new Error('Set a "health" address for this repository in xdevAi.squad.deployTargets.');
      return;
    }
    const results: string[] = [];
    for (const { tree, health } of checks) {
      let status = 0;
      try {
        status = (await fetch(health, { signal: AbortSignal.timeout(15_000), redirect: 'manual' })).status;
      } catch {
        status = 0;
      }
      await this.teamChat.recordHealth(run.id, tree.target, { url: health, status });
      results.push(`${tree.target}: ${status || 'no answer'}`);
    }
    if (report) void vscode.window.showInformationMessage(`Health: ${results.join(' · ')}`);
  }

  private async resumeSession(id: unknown, sessionId: unknown): Promise<void> {
    const run = this.requireRun(id);
    const session = run.sessions.find(candidate => candidate.sessionId === sessionId);
    if (!session) throw new Error('This worker session is no longer available.');
    const tree = run.trees?.find(candidate => candidate.target === session.repo) ?? run.trees?.[0];
    if (!tree) throw new Error('This run has no git worktree.');
    const profile: TerminalProfile | undefined = (await this.profiles.list('claude')).find(candidate => terminalProfileId(candidate) === session.profileId);
    if (!profile) throw new Error('The Claude Code account for this session was removed.');
    this.openClaudeTerminal(`${session.role} · ${session.profile}`, profile, tree.path, await this.claudeExecutable(), ['--resume', session.sessionId]);
  }

  private async startRequest(role: Role, profileId: string, brief: string): Promise<void> {
    const { accounts } = await this.accounts.read();
    const account = accounts.find(candidate => `api:${candidate.id}` === profileId);
    if (!account) throw new Error('Assign an API profile first.');
    const controller = new AbortController();
    this.errors.delete(role);
    this.running.set(role, controller);
    void (async () => {
      try {
        const response = await chat(account, [{ role: 'user', content: brief }], { signal: controller.signal });
        controller.signal.throwIfAborted();
        const limit = 32_000;
        await this.store.recordResponse(role, response.length <= limit ? response : response.slice(0, limit) + '\n[Response truncated]');
      } catch (error) {
        if (!controller.signal.aborted) {
          this.errors.set(role, error instanceof Error ? error.message : 'The API request failed.');
        }
      } finally {
        this.running.delete(role);
        await this.refresh();
      }
    })();
  }
}

function squadHtml(webview: vscode.Webview, media: vscode.Uri): string {
  const uri = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(media, file)).toString();
  return squadPage({
    cspSource: webview.cspSource, nonce: randomBytes(16).toString('base64'),
    script: uri('squad.js'), chatScript: uri('squad-chat.js'), workspaceScript: uri('squad-workspace.js'), style: uri('squad.css')
  });
}
