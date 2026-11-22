import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Memento } from 'vscode';
import { Accounts, type Account } from './accounts';
import { chat } from './core';
import { isRole, roles, SquadStore, type Role } from './squad';
import { SquadCustomizations, type Skill } from './squad-customizations';
import { SquadMemory } from './squad-memory';
import { suggestRepository } from './squad-codegraph';
import {
  parseGateOutput, parsePlanOutput, parseWorkerOutput, type ActivityKind, type WorkerActivity, type WorkerMode, type WorkerRequest,
  type WorkerResult, type WorkerSettings
} from './squad-worker';
import type { FileChange, PushResult, RunWorktree, Worktrees } from './squad-worktree';
import { terminalProfileId, type TerminalProfile } from './terminal-profiles';
import { workflowBriefLimit, workflowOutputLimit, workflowStage, workflowStages, workflowText, type Workflow } from './workflow';

const storageKey = 'squadChat.v1';
const workerRoles = ['Implement', 'Review', 'Tests'] as const satisfies readonly Role[];
type WorkerRole = typeof workerRoles[number];
export const chatPromptLimit = 8_000;
const responseLimit = 16_000;
const runLimit = 10;

export interface SquadChatEntry {
  author: Role | 'You' | 'Squad';
  text: string;
  profile?: string;
  to?: Role;
  run?: string;
}

export type AgentKind = 'api' | 'claude';

interface Job {
  role: WorkerRole;
  brief: string;
  profile: string;
  kind?: AgentKind;
  accountId: string;
  revision: string;
  /** The repository a Claude Code step works in, relative to the workspace folder ('.' for the folder itself). */
  repo?: string;
}

interface Plan {
  id: string;
  prompt: string;
  jobs: Job[];
  /** Repositories in the workspace when there is more than one. */
  repos?: string[];
}

export interface RunSession {
  role: Role;
  profileId: string;
  profile: string;
  sessionId: string;
  repo?: string;
}

export type StepStatus = 'pending' | 'running' | 'terminal' | 'done' | 'blocked' | 'failed' | 'skipped';

export const approvers = ['human', 'ai+human', 'ai'] as const;
export type Approver = typeof approvers[number];
type GateVerdict = 'pass' | 'changes';

export interface StepGate {
  verdict: GateVerdict;
  reason: string;
  by: string;
}

export interface RunStep extends Job {
  status: StepStatus;
  summary?: string;
  files?: string[];
  gate?: StepGate;
  /** Total time spent running the step, in milliseconds. */
  ms?: number;
  attempts?: number;
  costUsd?: number;
  /** Commands the allowed list blocked, over all attempts. */
  problems?: number;
  /** The step was added from review feedback on the changes. */
  feedback?: boolean;
}

/** One repository's worktree in a run. */
export interface RunTree extends RunWorktree {
  /** The repository relative to the workspace folder, '.' for the folder itself. */
  target: string;
  commit?: string;
  stat?: string;
  files?: number;
  pushed?: PushResult & { time: number };
  merged?: number;
}

export interface RunRecord {
  id: string;
  request: string;
  prompt: string;
  time: number;
  status: 'active' | 'done' | 'stopped';
  approver?: Approver;
  steps: RunStep[];
  trees?: RunTree[];
  /** When the run was committed. */
  finished?: number;
  costUsd: number;
  sessions: RunSession[];
}

/** A finished run, kept after the run itself is removed so the panel can show trends. */
export interface RunMetric {
  time: number;
  ms: number;
  costUsd: number;
  steps: number;
  attempts: number;
  blocked: number;
  files: number;
  repos: number;
}

export interface SquadMetrics {
  runs: number;
  medianMs: number;
  costUsd: number;
  /** Share of steps that finished on their first attempt. */
  firstPass: number;
  files: number;
}

interface InFlight {
  owner: string;
  beat: number;
  status?: string;
}

interface Thread {
  entries: SquadChatEntry[];
  plan?: Plan;
  workflow?: Workflow;
  inFlight?: boolean | InFlight;
  runs?: RunRecord[];
  history?: RunMetric[];
}

export interface LiveActivity {
  role: Role;
  profile: string;
  since: number;
  items: { kind: ActivityKind; text: string; time: number }[];
  reads: number;
  edits: number;
  commands: number;
  problems?: number;
  /** Commands the allowed list blocked; counted against the step's first-pass rate. */
  denied?: number;
}

interface ActiveRun {
  controller: AbortController;
  signal: AbortSignal;
  entries: SquadChatEntry[];
  status: string;
  live?: LiveActivity;
}

interface StartedRun {
  finished: Promise<SquadChatEntry[]>;
}

type Agent =
  | { kind: 'api'; id: string; name: string; revision: string; account: Account }
  | { kind: 'claude'; id: string; name: string; revision: string; profile: TerminalProfile };

/** What SquadChat needs from VS Code to run Claude Code workers. Absent in text-only setups and in tests. */
export interface WorkerHost {
  profiles(): Promise<TerminalProfile[]>;
  executable(): Promise<string>;
  folder(): string | undefined;
  /** Worker settings for a role, with the allowed commands of the repository the step works in. */
  settings(role: Role, repo?: string): WorkerSettings;
  run(request: WorkerRequest): Promise<string>;
  worktrees: Pick<Worktrees, 'create' | 'commit' | 'remove' | 'changes' | 'changedFiles' | 'discard'> & Partial<Pick<Worktrees, 'setup'>>;
  /** Paths, such as node_modules, linked from the main checkout into each new worktree. */
  worktreeLinks?(): readonly string[];
  /** The branch new worktrees start from, such as origin/dev; HEAD when undefined. */
  baseBranch?(): string | undefined;
  /** Allowed commands per repository that differ from the workspace default. */
  repositoryCommands?(): Record<string, readonly string[]>;
  prepare?(): Promise<void>;
  /** Git repositories a run can target, relative to folder(); ['.'] when the folder is one. */
  repositories?(): Promise<string[]>;
  /** A CodeGraph excerpt relevant to the request, or undefined when unavailable. */
  codeContext?(request: string, signal: AbortSignal): Promise<string | undefined>;
  /** The folder holding a CodeGraph index workers may query, if enabled. */
  codegraphRoot?(): Promise<string | undefined>;
}

const roleInstructions: Record<Role, string> = {
  Lead: 'Plan the work or answer a direct question.',
  Implement: 'Propose the implementation and practical code changes.',
  Review: 'Review the proposal for correctness, regressions, and gaps.',
  Tests: 'Propose tests with high-value cases and expected results.'
};
const workerInstructions: Record<WorkerRole, string> = {
  Implement: 'Make the code changes for your task in this git worktree. Keep the change focused. When the task names an existing screen, module, or file as a model, read it first and mirror its structure and naming. Follow the repository instructions and skills. Run the allowed build or test commands when useful.',
  Review: 'Review the changes in this worktree (git diff HEAD, and changed_files when given) against the task. Report concrete findings with file and line. Do not edit files.',
  Tests: 'Add or update tests for the change in this worktree. Run only the tests that cover changed_files (the same module, screen, or domain) plus a type check scoped to them when available; run the whole suite only when shared code changed. Report what passed and failed.'
};
const textOnly = 'You are using a text API. You cannot access the workspace, edit files, or run commands. Do not claim that you did.';
const headless = 'You are a headless Claude Code worker in xDev Squad. Nobody can answer questions during the run: decide reasonably, or report status "blocked" with what you need. Do not commit, push, or change git remotes; xDev commits the worktree for the user. Shell commands are checked against an allowed list ("allowed_commands" when given, plus read-only git), and a command with pipes, redirects, ";", "&&", or "cd" is denied even when each part is allowed: run each allowed command on its own from the working directory, and create or edit files with the Write and Edit tools, not the shell. Use available skills when they apply. Report through the required JSON fields and keep the summary short, because other agents read it.';

function shorten(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(0, limit) + '\n[Truncated]';
}

function formatCost(cost: number): string {
  return cost > 0 ? `$${cost.toFixed(cost < 0.1 ? 3 : 2)}` : '';
}

function workerText(result: WorkerResult): string {
  const files = result.filesChanged;
  return [
    result.status === 'blocked' ? `Blocked: ${result.summary}` : result.summary,
    files.length ? `Files: ${files.slice(0, 12).join(', ')}${files.length > 12 ? ' …' : ''}` : '',
    result.tests ? `Tests: ${result.tests}` : '',
    result.denied.length ? `Not allowed: ${result.denied.join('; ')}. Add safe commands to xdevAi.squad.workerAllowedCommands.` : ''
  ].filter(Boolean).join('\n');
}

const liveItems = 8;
const historyLimit = 200;
const heartbeatMs = 20_000;
const staleMs = 70_000;
const metricsWindowMs = 30 * 86_400_000;

type LegacyRun = RunRecord & Partial<RunWorktree> & { target?: string; commit?: string; stat?: string; files?: number };

/** Runs saved before multi-repository support kept one worktree on the record itself. */
function normalizeRun(run: RunRecord): RunRecord {
  const legacy = run as LegacyRun;
  if (run.trees || !legacy.repo || !legacy.path || !legacy.branch || !legacy.base) return run;
  const { repo, path, branch, base, target = '.', commit, stat, files, ...rest } = legacy;
  return {
    ...rest,
    trees: [{ target, repo, path, branch, base, commit, stat, files }],
    steps: run.steps.map(step => step.kind === 'claude' && !step.repo ? { ...step, repo: target } : step)
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

export function squadMetrics(history: readonly RunMetric[], now = Date.now()): SquadMetrics | undefined {
  const recent = history.filter(item => now - item.time < metricsWindowMs);
  if (!recent.length) return undefined;
  const steps = recent.reduce((sum, item) => sum + item.steps, 0);
  const retries = recent.reduce((sum, item) => sum + Math.max(0, item.attempts - item.steps) + item.blocked, 0);
  return {
    runs: recent.length,
    medianMs: median(recent.map(item => item.ms)),
    costUsd: recent.reduce((sum, item) => sum + item.costUsd, 0),
    firstPass: steps ? Math.max(0, Math.min(1, (steps - retries) / steps)) : 1,
    files: recent.reduce((sum, item) => sum + item.files, 0)
  };
}

/** A short title for a run's commits and merge requests: the request's first sentence, at most 72 characters. */
export function runTitle(request: string): string {
  const line = request.trim().split('\n', 1)[0].trim();
  const sentence = line.split(/(?<=[.!?:;])\s+|\s+\((?=\d+\))/u, 1)[0].replace(/[.:;]+$/, '').trim() || line;
  return sentence.length <= 72 ? sentence : `${sentence.slice(0, 71).trimEnd()}…`;
}

function repoName(target: string): string {
  return target === '.' ? 'workspace' : target;
}

export class SquadChat {
  private active?: ActiveRun;
  private notifyTimer?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  /** Identifies this window, so other windows sharing the state can tell its runs apart. */
  private readonly owner = randomUUID();
  private workflowIssue?: { id: string; step: number; text: string };
  private writes = Promise.resolve();
  readonly customizations: SquadCustomizations;
  readonly memory: SquadMemory;

  constructor(
    private readonly storage: Memento,
    private readonly accounts: Accounts,
    private readonly squad: SquadStore,
    private readonly changed: () => void,
    private readonly host?: WorkerHost
  ) {
    this.customizations = new SquadCustomizations(storage);
    this.memory = new SquadMemory(storage);
  }

  snapshot() {
    const { entries, inFlight, workflow, runs, history } = this.read();
    const plan = this.pendingPlan();
    const remote = this.remoteRun(inFlight);
    return {
      entries,
      runs: runs ?? [],
      workflow,
      workflowIssue: this.workflowIssue?.id === workflow?.id && this.workflowIssue?.step === workflow?.approved.length
        ? this.workflowIssue?.text : undefined,
      plan: plan && { id: plan.id, jobs: plan.jobs, repos: plan.repos },
      workers: Boolean(this.host),
      busy: Boolean(this.active) || Boolean(remote),
      /** A run in another VS Code window that shares this workspace's Squad. */
      remote: Boolean(remote),
      live: this.active?.live,
      metrics: squadMetrics(history ?? []),
      status: this.active?.status ?? (remote ? `Another window is running: ${remote.status ?? 'a Squad step'}`
        : inFlight ? 'The previous run was interrupted. Send a new message to continue.' : '')
    };
  }

  pendingPlan() {
    const plan = this.read().plan;
    return plan && {
      id: plan.id,
      repos: plan.repos,
      jobs: plan.jobs.map(({ role, brief, profile, kind, repo }) => ({ role, brief, profile, kind: kind ?? 'api' as AgentKind, ...(repo ? { repo } : {}) }))
    };
  }

  /** The other window's run when its heartbeat is recent. */
  private remoteRun(inFlight: Thread['inFlight']): InFlight | undefined {
    if (!inFlight || typeof inFlight !== 'object' || inFlight.owner === this.owner || this.active) return undefined;
    return Date.now() - inFlight.beat < staleMs ? inFlight : undefined;
  }

  run(id: unknown): RunRecord | undefined {
    return this.read().runs?.find(run => run.id === id);
  }

  async send(input: unknown, signal?: AbortSignal): Promise<StartedRun> {
    this.requireIdle();
    if (typeof input !== 'string' || !input.trim() || input.length > chatPromptLimit) throw new Error('Enter a chat message.');
    if (this.read().plan) throw new Error('Approve or discard the current plan first.');
    const message = input.trim();
    const firstWord = message.split(/\s/, 1)[0];
    const role = roles.find(candidate => firstWord.toLowerCase() === `@${candidate.toLowerCase()}`) ?? 'Lead';
    const prompt = firstWord.startsWith('@') && firstWord.slice(1).toLowerCase() === role.toLowerCase()
      ? message.slice(firstWord.length).trim() : message;
    if (!prompt) throw new Error(`Add a message after @${role}.`);
    const directory = await this.directory();
    const agent = this.agentFor(role, directory);
    if (!agent) throw new Error(`Assign an API profile or Claude Code account to ${role} under Roles, or open its AI terminal from chat.`);
    if (agent.kind === 'claude' && !this.host?.folder()) throw new Error('Open a workspace folder to use a Claude Code account in Squad.');
    const workers = new Map(workerRoles.flatMap(worker => {
      const candidate = this.agentFor(worker, directory);
      return candidate ? [[worker, candidate] as const] : [];
    }));

    let history: Pick<SquadChatEntry, 'author' | 'text'>[] = [];
    return this.launch(`${role} is responding…`, signal, state => {
      if (state.plan) throw new Error('Approve or discard the current plan first.');
      history = state.entries
        .filter(entry => entry.author !== 'Squad' && (role === 'Lead' || entry.author === role || entry.to === role))
        .slice(-8)
        .map(entry => ({ author: entry.author, text: shorten(entry.text, 1_500) }));
      if (state.inFlight) state.entries.push({ author: 'Squad', text: 'The previous run was interrupted.' });
      state.entries.push({ author: 'You', text: message, to: role });
    }, async run => {
      const memory = this.memory.context();
      let code: string | undefined;
      let repositories: string[] = [];
      if (role === 'Lead' && this.host) {
        run.status = 'Lead is reading the code map…';
        this.changed();
        [code, repositories] = await Promise.all([
          this.host.codeContext?.(prompt, run.signal).catch(() => undefined),
          this.host.repositories?.().catch(() => []) ?? Promise.resolve([])
        ]);
        run.signal.throwIfAborted();
        run.status = 'Lead is responding…';
        this.changed();
      }
      const claudeWorkers = Boolean(this.host) && [...workers.values()].some(candidate => candidate.kind === 'claude');
      const allowedCommands = claudeWorkers ? [...this.host!.settings('Implement').allowedCommands] : undefined;
      const multiple = repositories.length > 1;
      const repositoryCommands = claudeWorkers && multiple
        ? Object.fromEntries(Object.entries(this.host!.repositoryCommands?.() ?? {}).filter(([repo]) => repositories.includes(repo)))
        : {};
      const perRepository = Object.keys(repositoryCommands).length > 0;
      const capabilities = [...workers].map(([worker, candidate]) => candidate.kind === 'claude'
        ? `${worker} (Claude Code worker: reads the repository, ${worker === 'Review' ? 'reviews the diff' : 'edits files and runs allowed commands'} in a git worktree)`
        : `${worker} (text API: proposes text only)`);
      const leadSystem = `${roleInstructions.Lead} ${agent.kind === 'api' ? textOnly : 'You may read the repository (read-only) to answer or to make briefs concrete; do not change files. Start from "code" when given, and keep reading short.'} Available worker roles: ${capabilities.join(', ') || 'none'}.
Return only a JSON object with a "reply" string and a "tasks" array. Each task has a "role" from the available worker roles and a "brief" string${multiple ? ' and a "repo"' : ''}. Use each role at most once${multiple ? ' per repository' : ''}. Use an empty tasks array for questions, summaries, or when no workers are available. Write briefs that a worker can act on without the chat history. Reply in the user's language. The user reviews proposed tasks in the xDev Squad panel and approves them with a button, then starts each step there, so keep the reply to a short summary of the plan (at most 80 words) and do not ask the user to reply to start it.${multiple ? ' Each Claude Code task runs in one git repository from "repositories": set its "repo" to that entry exactly. A change that spans repositories, such as a backend API and the frontend screen that calls it, gets one Implement task per repository, listed so that dependencies come first. Write file paths relative to the task\'s repository root.' : ''}${allowedCommands ? ` Claude Code workers may only run "allowed_commands"${perRepository ? ' plus, in a repository listed in "repository_commands", the commands listed for it' : ''} and read-only git; do not ask them to run anything else, and do not tell them a command is not allowed.` : ''}${code ? ' "code" is a CodeGraph excerpt of the relevant symbols and call paths: name concrete files and symbols in each brief so workers do not have to search.' : ''}`;
      const content = JSON.stringify({
        history, request: prompt, memory: memory.length ? memory : undefined, code, allowed_commands: allowedCommands,
        repository_commands: perRepository ? repositoryCommands : undefined,
        repositories: multiple ? repositories.slice(0, 80) : undefined
      });
      const planned = { repos: multiple ? repositories : undefined, code };

      if (agent.kind === 'claude') {
        await this.host?.prepare?.();
        const graph = await this.host!.codegraphRoot?.().catch(() => undefined);
        const settings = this.host!.settings(role);
        const stdout = await this.host!.run({
          executable: await this.host!.executable(), profile: agent.profile, cwd: this.host!.folder()!, role,
          mode: role === 'Lead' ? 'plan' : 'ask', prompt: content,
          system: role === 'Lead' ? leadSystem : `You are ${role} in xDev Squad. Answer the question using the repository. Do not edit files. Reply in the user's language.`,
          settings: graph ? { ...settings, codegraph: true } : settings, signal: run.signal, onActivity: this.track(run, role, agent.name)
        });
        run.signal.throwIfAborted();
        if (role === 'Lead') {
          const report = parsePlanOutput(stdout);
          const plan = parsePlan(JSON.stringify(report), workers, repositories);
          await this.recordPlan(role, agent, prompt, plan, report.reply, run, report.costUsd, planned);
        } else {
          const result = parseWorkerOutput(stdout);
          await this.memory.add(result.memory, role);
          await this.write(state => state.entries.push(this.reply(role, agent, workerText(result), result.costUsd)), run);
        }
        return;
      }

      const answer = await chat(agent.account, [
        { role: 'system', content: role === 'Lead' ? leadSystem : `You are ${role}. ${roleInstructions[role]} ${textOnly} Reply in the user's language.` },
        { role: 'user', content }
      ], { signal: run.signal });
      run.signal.throwIfAborted();
      if (role === 'Lead') await this.recordPlan(role, agent, prompt, parsePlan(answer, workers, repositories), answer, run, 0, planned);
      else await this.write(state => state.entries.push(this.reply(role, agent, answer)), run);
    });
  }

  private recordPlan(
    role: Role, agent: Agent, prompt: string, plan: ReturnType<typeof parsePlan>, fallback: string, run: ActiveRun, cost = 0,
    planned: { repos?: string[]; code?: string } = {}
  ): Promise<void> {
    run.live = undefined;
    return this.write(state => {
      state.entries.push(this.reply(role, agent, plan?.reply ?? fallback, cost));
      if (plan?.jobs.length) {
        const repos = planned.repos;
        // Lead names a repository per task; otherwise suggest one from the task's own brief, then from the whole plan.
        const overall = repos && suggestRepository(repos, [plan.reply, ...plan.jobs.map(job => job.brief), planned.code ?? '']);
        const jobs = plan.jobs.map(job => job.kind !== 'claude' || !repos || job.repo ? job
          : { ...job, repo: suggestRepository(repos, [job.brief]) ?? overall });
        state.plan = { id: randomUUID(), prompt, jobs, repos };
      }
      if (!plan || plan.invalid) {
        state.entries.push({ author: 'Squad', text: 'Lead did not return a valid plan. Ask again to generate tasks.' });
      }
    }, run);
  }

  /**
   * Approving a plan only prepares a run: its steps and, for Claude Code steps, a git worktree.
   * No agent starts until the user runs a step. Each step pauses the run when it ends.
   */
  /**
   * Approving a plan only prepares a run: its steps and, for Claude Code steps, one git worktree per
   * repository the steps work in. No agent starts until the user runs a step.
   * `repoInput` is one repository for every Claude Code step, or one entry per step (empty keeps the plan's).
   */
  async approve(id: unknown, signal?: AbortSignal, approverInput: unknown = 'human', repoInput?: unknown): Promise<StartedRun> {
    this.requireIdle();
    const plan = this.requirePlan(id);
    const approver = approvers.find(candidate => candidate === approverInput);
    if (!approver) throw new Error('Choose who approves each step: human, ai+human, or ai.');
    if (this.read().runs?.some(run => run.status === 'active')) throw new Error('Finish or stop the current run before approving another plan.');
    const directory = await this.directory();
    for (const job of plan.jobs) this.verify(job, directory);
    const headlessJobs = plan.jobs.some(job => job.kind === 'claude');
    const folder = this.host?.folder();
    if (headlessJobs && (!this.host || !folder)) throw new Error('Open a workspace folder to run Claude Code workers.');
    const jobs = plan.jobs.map(job => ({ ...job }));
    if (headlessJobs && this.host?.repositories) {
      const repositories = await this.host.repositories();
      if (!repositories.length) throw new Error('Claude Code workers need a git repository in this workspace.');
      if (Array.isArray(repoInput) && repoInput.length > jobs.length) throw new Error('Choose a repository for each step.');
      for (const [index, job] of jobs.entries()) {
        if (job.kind !== 'claude') { delete job.repo; continue; }
        const input = Array.isArray(repoInput) ? repoInput[index] : repoInput;
        const chosen = typeof input === 'string' && input ? input : job.repo ?? (repositories.length === 1 ? repositories[0] : undefined);
        if (!chosen || !repositories.includes(chosen)) {
          throw new Error(jobs.filter(item => item.kind === 'claude').length > 1 ? `Choose the repository for ${job.role}.` : 'Choose the repository this run works in.');
        }
        job.repo = chosen;
      }
    }
    const targets = [...new Set(jobs.flatMap(job => job.kind === 'claude' ? [job.repo ?? '.'] : []))];

    return this.launch('Preparing the run…', signal, state => {
      if (state.plan?.id !== plan.id) throw new Error('This plan is no longer available.');
      state.plan = undefined;
      state.entries.push({ author: 'Squad', text: 'Plan approved.' });
    }, async run => {
      const runId = randomUUID();
      const trees: RunTree[] = [];
      const setupNotes: string[] = [];
      if (targets.length) {
        run.status = targets.length > 1 ? `Preparing ${targets.length} git worktrees…` : 'Preparing a git worktree…';
        this.changed();
        await this.host!.prepare?.();
        try {
          for (const [index, target] of targets.entries()) {
            const worktree = await this.host!.worktrees.create(target !== '.' ? join(folder!, target) : folder!, runId,
              targets.length > 1 ? `${index + 1}-${target.split('/').at(-1)}` : undefined, this.host!.baseBranch?.());
            const prepared = await this.host!.worktrees.setup?.(worktree, this.host!.worktreeLinks?.() ?? [])
              .catch((error: Error) => ({ notes: [error.message], linked: [] as string[] }));
            trees.push({ ...worktree, target, ...(prepared?.linked.length ? { linked: prepared.linked } : {}) });
            setupNotes.push(...(prepared?.notes ?? []).map(note => targets.length > 1 ? `${repoName(target)}: ${note}` : note));
          }
        } catch (error) {
          for (const tree of trees) await this.host!.worktrees.remove(tree).catch(() => undefined);
          throw error;
        }
      }
      const record: RunRecord = {
        id: runId, request: plan.prompt, prompt: shorten(plan.prompt, 500), time: Date.now(), status: 'active', approver, costUsd: 0,
        sessions: [], steps: jobs.map(job => ({ ...job, status: 'pending' })), ...(trees.length ? { trees } : {})
      };
      await this.write(state => {
        state.runs = [record, ...(state.runs ?? [])].slice(0, runLimit);
        const branch = trees[0]?.branch;
        const from = trees[0]?.source ? ` from ${trees[0].source}` : '';
        state.entries.push({
          author: 'Squad', run: runId,
          text: `${!branch ? '' : trees.length > 1
            ? `Branch ${branch} is ready${from} in ${trees.length} repositories (${trees.map(tree => repoName(tree.target)).join(', ')}), each in a separate worktree; your checkouts are not changed. `
            : `Branch ${branch} is ready${from} in a separate worktree; your checkout is not changed. `}Nothing has run yet. Start each step under Worker runs: run it, open it in a terminal, or skip it.${setupNotes.length ? ` Setup: ${setupNotes.join('; ')}` : ''}`
        });
      }, run);
    });
  }

  /** The worktree a step works in: its repository's, or the run's only one. */
  treeFor(record: RunRecord, step: Pick<Job, 'repo'>): RunTree | undefined {
    const trees = record.trees ?? [];
    return trees.find(tree => tree.target === step.repo) ?? (trees.length === 1 ? trees[0] : undefined);
  }

  /** The next step the user can act on: the first one not done or skipped. */
  currentStep(record: RunRecord): number {
    return record.steps.findIndex(step => step.status !== 'done' && step.status !== 'skipped');
  }

  private activeRun(id: unknown): { record: RunRecord; index: number; step: RunStep } {
    const record = this.run(id);
    if (!record || record.status !== 'active') throw new Error('This run is no longer active.');
    const index = this.currentStep(record);
    if (index < 0) throw new Error('This run has no remaining steps. Finish it to commit the changes.');
    return { record, index, step: record.steps[index] };
  }

  private requireNotInTerminal(step: RunStep): void {
    if (step.status === 'terminal') throw new Error(`${step.role} is open in a terminal. Mark the step done or skip it.`);
  }

  private stepContext(record: RunRecord, index: number) {
    const done = record.steps.slice(0, index).filter(step => step.status === 'done');
    const memory = this.memory.context();
    return {
      previous: done.map(step => ({
        role: step.role, status: 'done', summary: shorten(step.summary ?? '', 1_000), files: step.files?.length ? step.files : undefined,
        ...((record.trees?.length ?? 0) > 1 && step.repo ? { repository: step.repo } : {})
      })),
      implementation: done.find(step => step.role === 'Implement' && step.kind !== 'claude')?.summary,
      memory: memory.length ? memory : undefined
    };
  }

  private briefFrom(input: unknown, fallback: string): string {
    if (input === undefined || input === null || input === '') return fallback;
    if (typeof input !== 'string' || !input.trim() || input.length > 4_000) throw new Error('Enter a step brief up to 4,000 characters.');
    return input.trim();
  }

  private updateRun(id: string, change: (record: RunRecord, state: Thread) => void, run?: ActiveRun): Promise<void> {
    return this.write(state => {
      const record = state.runs?.find(candidate => candidate.id === id);
      if (!record) throw new Error('This run is no longer available.');
      change(record, state);
    }, run);
  }

  /**
   * Runs the current step once, headless or through its text API. With an AI approver the step is then
   * reviewed by a different account; in "ai" mode a passing review starts the next step, and anything
   * else pauses the run for the user. Merging always stays with the user.
   */
  async runStep(id: unknown, briefInput?: unknown, signal?: AbortSignal): Promise<StartedRun> {
    this.requireIdle();
    const { record, index, step } = this.activeRun(id);
    this.requireNotInTerminal(step);
    const brief = this.briefFrom(briefInput, step.brief);
    const agent = this.verify(step, await this.directory());
    if (agent.kind === 'claude' && !this.treeFor(record, step)) throw new Error('This run has no worktree for Claude Code steps.');

    return this.launch(`${step.role} is ${agent.kind === 'claude' ? 'working' : 'responding'}…`, signal, state => {
      const saved = state.runs?.find(candidate => candidate.id === record.id);
      if (!saved || saved.status !== 'active' || this.currentStep(saved) !== index) throw new Error('This step has changed. Check Worker runs.');
      state.entries.push({ author: 'You', to: step.role, run: record.id, text: brief });
    }, async run => {
      let current = { index, brief, agent };
      for (;;) {
        const status = await this.executeStep(record.id, current.index, current.brief, current.agent, run);
        if (status !== 'done') break;
        const approver = this.run(record.id)?.approver ?? 'human';
        if (approver === 'human') break;
        const verdict = await this.gateStep(record.id, current.index, run);
        if (approver !== 'ai' || verdict !== 'pass') break;
        const saved = this.run(record.id);
        const next = saved ? this.currentStep(saved) : -1;
        if (!saved || next < 0) break;
        const nextStep = saved.steps[next];
        const nextAgent = this.verify(nextStep, await this.directory());
        if (nextAgent.kind === 'claude' && !this.treeFor(saved, nextStep)) break;
        run.status = `${nextStep.role} is ${nextAgent.kind === 'claude' ? 'working' : 'responding'} (approved by AI)…`;
        this.changed();
        current = { index: next, brief: nextStep.brief, agent: nextAgent };
      }
      await this.afterStep(record.id, run);
    });
  }

  private async executeStep(id: string, index: number, brief: string, agent: Agent, run: ActiveRun): Promise<StepStatus> {
    const record = this.run(id)!;
    const step = record.steps[index];
    const started = Date.now();
    await this.updateRun(id, saved => Object.assign(saved.steps[index], { brief, status: 'running', gate: undefined, attempts: (saved.steps[index].attempts ?? 0) + 1 }), run);
    const context = this.stepContext(record, index);
    const elapsed = (saved: RunStep) => (saved.ms ?? 0) + Date.now() - started;
    try {
      if (agent.kind === 'claude') {
        await this.host!.prepare?.();
        const tree = this.treeFor(record, step)!;
        const target = tree.target !== '.' ? tree.target : undefined;
        const others = (record.trees ?? []).filter(other => other !== tree).map(other => repoName(other.target));
        const changed = step.role !== 'Implement'
          ? await this.host!.worktrees.changedFiles?.(tree).catch(() => []) ?? [] : [];
        const graph = await this.host!.codegraphRoot?.().catch(() => undefined);
        const settings = this.host!.settings(step.role, tree.target);
        const stdout = await this.host!.run({
          executable: await this.host!.executable(), profile: agent.profile, cwd: tree.path, role: step.role, mode: 'work',
          prompt: JSON.stringify({
            request: record.request, task: brief, repository: target, other_repositories: others.length ? others : undefined,
            allowed_commands: step.role === 'Review' ? undefined : settings.allowedCommands,
            previous: context.previous.length ? context.previous : undefined, changed_files: changed.length ? changed : undefined, memory: context.memory
          }),
          system: `${headless} You are ${step.role}. ${workerInstructions[step.role]}${target ? ` Your working directory is the root of the repository "${target}"; read a leading "${target}/" in a path as this directory.` : ''}${others.length ? ' Other steps of this run work in the other repositories; change only this one, and read "previous" for what they did.' : ''}${graph ? ` A CodeGraph index of the workspace is at ${graph}: run \`codegraph explore -p ${graph} "<symbols or question>"\` to locate code before searching files. Its paths point to the main checkout; edit the matching files in this worktree.` : ''} Reply in the user's language.`,
          settings: graph ? { ...settings, codegraph: true } : settings, signal: run.signal, onActivity: this.track(run, step.role, agent.name)
        });
        run.signal.throwIfAborted();
        const problems = run.live?.denied ?? 0;
        run.live = undefined;
        const result = parseWorkerOutput(stdout);
        await this.memory.add(result.memory, step.role);
        await this.updateRun(id, (saved, state) => {
          saved.costUsd += result.costUsd;
          if (result.sessionId) saved.sessions.push({ role: step.role, profileId: agent.id, profile: agent.name, sessionId: result.sessionId, repo: tree.target });
          const current = saved.steps[index];
          Object.assign(current, {
            status: result.status, summary: result.summary, files: result.filesChanged, ms: elapsed(current),
            costUsd: (current.costUsd ?? 0) + result.costUsd, problems: (current.problems ?? 0) + problems
          });
          state.entries.push({ ...this.reply(step.role, agent, workerText(result), result.costUsd), run: id });
          if (result.status === 'blocked') {
            state.entries.push({ author: 'Squad', run: id, text: `${step.role} is blocked. Edit the brief and run the step again, continue it in a terminal, skip it, or finish the run.` });
          }
        }, run);
        return result.status;
      }
      const answer = await chat(agent.account, [
        { role: 'system', content: `You are ${step.role}. ${roleInstructions[step.role]} ${textOnly} Reply in the user's language.` },
        {
          role: 'user',
          content: JSON.stringify({
            request: record.request, task: brief,
            implementation: context.implementation && shorten(context.implementation, 8_000),
            previous: context.previous.some(item => item.files) ? context.previous : undefined,
            memory: context.memory
          })
        }
      ], { signal: run.signal });
      run.signal.throwIfAborted();
      await this.updateRun(id, (saved, state) => {
        Object.assign(saved.steps[index], { status: 'done', summary: shorten(answer, 8_000), ms: elapsed(saved.steps[index]) });
        state.entries.push({ ...this.reply(step.role, agent, answer), run: id });
      }, run);
      return 'done';
    } catch (error) {
      run.live = undefined;
      const detail = run.signal.aborted ? 'Step stopped.' : error instanceof Error ? error.message : 'The step failed.';
      await this.updateRun(id, saved => { Object.assign(saved.steps[index], { status: 'failed', ms: elapsed(saved.steps[index]) }); }).catch(() => undefined);
      throw new Error(`${step.role}: ${detail}`, { cause: error });
    }
  }

  /**
   * AI review of a finished step by the Lead's account, which must differ from the step's account.
   * Returns undefined when no independent reviewer is available, so the user decides.
   */
  private async gateStep(id: string, index: number, run: ActiveRun): Promise<GateVerdict | undefined> {
    const record = this.run(id)!;
    const step = record.steps[index];
    const reviewer = this.agentFor('Lead', await this.directory());
    if (!reviewer || reviewer.id === step.accountId) {
      await this.write(state => state.entries.push({
        author: 'Squad', run: id,
        text: `No independent AI reviewer for ${step.role}: assign Lead an account different from ${step.profile}. Review the step yourself.`
      }), run);
      return undefined;
    }
    run.status = `Lead is reviewing ${step.role}…`;
    this.changed();
    const criteria = 'Pass only if the step did what its brief asked, consistently with the request, without obvious regressions or missing pieces. Otherwise answer changes and say what is missing. Reply in the user\'s language.';
    const evidence = { request: record.request, step: { role: step.role, brief: step.brief, summary: step.summary, files: step.files } };
    const tree = this.treeFor(record, step);
    let gate: StepGate;
    try {
      if (reviewer.kind === 'claude') {
        const stdout = await this.host!.run({
          executable: await this.host!.executable(), profile: reviewer.profile, cwd: tree?.path ?? this.host!.folder()!, role: 'Lead', mode: 'gate',
          prompt: JSON.stringify(evidence),
          system: `You review one step of an xDev Squad run. ${tree ? 'Inspect the uncommitted changes with git diff. ' : ''}Do not edit files. ${criteria}`,
          settings: this.host!.settings('Lead'), signal: run.signal, onActivity: this.track(run, 'Lead', reviewer.name)
        });
        const verdict = parseGateOutput(stdout);
        gate = { verdict: verdict.verdict, reason: verdict.reason, by: reviewer.name };
        await this.updateRun(id, saved => { saved.costUsd += verdict.costUsd; }, run);
      } else {
        const answer = await chat(reviewer.account, [
          { role: 'system', content: `You review one step of an xDev Squad run. ${textOnly} ${criteria} Return only a JSON object {"verdict": "pass" | "changes", "reason": string}.` },
          { role: 'user', content: JSON.stringify(evidence) }
        ], { signal: run.signal });
        gate = { ...readGate(answer), by: reviewer.name };
      }
    } catch (error) {
      run.live = undefined;
      run.signal.throwIfAborted();
      gate = { verdict: 'changes', reason: `The AI review failed: ${error instanceof Error ? error.message : 'unknown error'}`, by: reviewer.name };
    }
    run.live = undefined;
    run.signal.throwIfAborted();
    await this.updateRun(id, (saved, state) => {
      saved.steps[index].gate = gate;
      state.entries.push({
        author: 'Lead', run: id, profile: `${reviewer.name} · AI review`,
        text: `${step.role}: ${gate.verdict === 'pass' ? 'pass' : 'changes requested'}. ${gate.reason}`
      });
    }, run);
    return gate.verdict;
  }

  /** Marks the current Claude Code step as handed to an interactive terminal and returns what to open. */
  async startTerminalStep(id: unknown, briefInput?: unknown) {
    this.requireIdle();
    const { record, index, step } = this.activeRun(id);
    this.requireNotInTerminal(step);
    const brief = this.briefFrom(briefInput, step.brief);
    const agent = this.verify(step, await this.directory());
    const tree = this.treeFor(record, step);
    if (agent.kind !== 'claude' || !tree) throw new Error('Only Claude Code steps can continue in a terminal.');
    await this.host?.prepare?.();
    const context = this.stepContext(record, index);
    const prompt = [
      `Task for ${step.role}: ${brief}`,
      `Original request: ${record.request}`,
      context.previous.length ? `Earlier steps:\n${context.previous.map(item => `- ${item.role}: ${item.summary}`).join('\n')}` : '',
      context.memory ? `Team memory:\n${context.memory.map(note => `- ${note}`).join('\n')}` : '',
      'Work in this git worktree. Do not commit or push; xDev commits when the run finishes.'
    ].filter(Boolean).join('\n\n');
    await this.updateRun(record.id, (saved, state) => {
      Object.assign(saved.steps[index], { brief, status: 'terminal' });
      state.entries.push({ author: 'Squad', run: record.id, text: `${step.role} continues in a terminal with ${agent.name}. Click Mark step done when you finish.` });
    });
    return { profile: agent.profile, cwd: tree.path, prompt, system: workerInstructions[step.role], role: step.role, name: agent.name };
  }

  /** Completes a step the user worked on in a terminal. */
  async completeStep(id: unknown, summaryInput?: unknown): Promise<void> {
    this.requireIdle();
    const { record, index, step } = this.activeRun(id);
    if (step.status !== 'terminal') throw new Error('Mark a step done only after continuing it in a terminal.');
    const summary = typeof summaryInput === 'string' && summaryInput.trim() ? summaryInput.trim().slice(0, 2_000) : 'Done in the terminal.';
    await this.updateRun(record.id, (saved, state) => {
      Object.assign(saved.steps[index], { status: 'done', summary });
      state.entries.push({ author: step.role, run: record.id, profile: `${step.profile} · terminal`, text: summary });
    });
    await this.afterStep(record.id);
  }

  async skipStep(id: unknown): Promise<void> {
    this.requireIdle();
    const { record, index, step } = this.activeRun(id);
    await this.updateRun(record.id, (saved, state) => {
      saved.steps[index].status = 'skipped';
      state.entries.push({ author: 'Squad', run: record.id, text: `Skipped ${step.role}.` });
    });
    await this.afterStep(record.id);
  }

  /** Ends the run now: remaining steps are skipped and the worktree is committed locally. */
  async finish(id: unknown): Promise<void> {
    this.requireIdle();
    const record = this.run(id);
    if (!record || record.status !== 'active') throw new Error('This run is no longer active.');
    await this.closeRun(record.id, 'stopped');
  }

  private async afterStep(id: string, run?: ActiveRun): Promise<void> {
    const record = this.run(id);
    if (record && this.currentStep(record) < 0) await this.closeRun(id, 'done', run);
  }

  private async closeRun(id: string, status: 'done' | 'stopped', run?: ActiveRun): Promise<void> {
    const record = this.run(id);
    if (!record) return;
    const results = new Map<string, Awaited<ReturnType<WorkerHost['worktrees']['commit']>>>();
    const issues: string[] = [];
    for (const tree of record.trees ?? []) {
      try {
        results.set(tree.target, await this.host!.worktrees.commit(tree, runTitle(record.request)));
      } catch (error) {
        issues.push(`${(record.trees?.length ?? 0) > 1 ? `${repoName(tree.target)}: ` : ''}${error instanceof Error ? error.message : 'Could not commit the worktree.'}`);
      }
    }
    await this.updateRun(id, (saved, state) => {
      const remaining = saved.steps.some(step => step.status !== 'done' && step.status !== 'skipped');
      for (const step of saved.steps) if (step.status !== 'done') step.status = 'skipped';
      for (const tree of saved.trees ?? []) {
        const changes = results.get(tree.target);
        if (changes) Object.assign(tree, { commit: changes.commit, stat: changes.stat, files: changes.files });
      }
      const wasFinished = saved.finished;
      Object.assign(saved, { status: remaining ? 'stopped' : status, finished: Date.now() });
      const files = (saved.trees ?? []).reduce((sum, tree) => sum + (tree.files ?? 0), 0);
      if (!wasFinished) {
        const ran = saved.steps.filter(step => step.attempts);
        state.history = [{
          time: saved.time, ms: Date.now() - saved.time, costUsd: saved.costUsd, steps: ran.length,
          attempts: ran.reduce((sum, step) => sum + (step.attempts ?? 0), 0),
          blocked: ran.filter(step => (step.problems ?? 0) > 0).length, files, repos: saved.trees?.length ?? 0
        }, ...(state.history ?? [])].slice(0, historyLimit);
      }
      const cost = formatCost(saved.costUsd);
      const trees = saved.trees ?? [];
      const committed = trees.filter(tree => tree.commit);
      const branch = trees[0]?.branch;
      const text = !branch ? `Run finished${cost ? ` · ${cost}` : ''}.`
        : issues.length && !committed.length ? `Could not commit the worktree: ${issues.join('; ')}`
          : committed.length
            ? `Committed ${files} changed file${files === 1 ? '' : 's'} to ${branch}${trees.length > 1 ? ` in ${committed.map(tree => repoName(tree.target)).join(', ')}` : ''}${cost ? ` · ${cost}` : ''}.${issues.length ? ` Not committed: ${issues.join('; ')}.` : ''} Review the run below, then merge, push, or remove it.`
            : `No file changes on ${branch}${cost ? ` · ${cost}` : ''}.`;
      state.entries.push({ author: 'Squad', run: id, text });
    }, run);
  }

  private worktreeRun(id: unknown): RunRecord & { trees: RunTree[] } {
    const record = this.run(id);
    if (!record) throw new Error('This run is no longer available.');
    if (!record.trees?.length || !this.host) throw new Error('This run has no git worktree.');
    return record as RunRecord & { trees: RunTree[] };
  }

  /** The worktree of a run for a repository, or its only one when `repo` is not given. */
  runTree(id: unknown, repo?: unknown): { record: RunRecord & { trees: RunTree[] }; tree: RunTree } {
    const record = this.worktreeRun(id);
    const tree = typeof repo === 'string' && repo ? record.trees.find(candidate => candidate.target === repo)
      : record.trees.length === 1 ? record.trees[0] : undefined;
    if (!tree) throw new Error('Choose a repository of this run.');
    return { record, tree };
  }

  /** The run's file changes against each worktree's base commit, including work not yet committed. */
  async changes(id: unknown): Promise<(FileChange & { repo: string })[]> {
    const record = this.worktreeRun(id);
    const lists = await Promise.all(record.trees.map(async tree =>
      (await this.host!.worktrees.changes(tree)).map(change => ({ ...change, repo: tree.target }))));
    return lists.flat();
  }

  /** Reverts one file of a run. A finished run gets a new local commit so merging matches what you see. */
  async discardFile(id: unknown, file: unknown, repo?: unknown): Promise<void> {
    this.requireIdle();
    const { record, tree } = this.runTree(id, repo);
    if (typeof file !== 'string' || !file || file.length > 1_000) throw new Error('Choose a changed file.');
    await this.host!.worktrees.discard(tree, file);
    let changes: Awaited<ReturnType<WorkerHost['worktrees']['commit']>> | undefined;
    if (record.status !== 'active' && record.finished) changes = await this.host!.worktrees.commit(tree, `xDev Squad: discard ${file}`);
    await this.updateRun(record.id, (saved, state) => {
      const target = saved.trees?.find(candidate => candidate.target === tree.target);
      if (changes && target) Object.assign(target, { commit: changes.files ? changes.commit : undefined, stat: changes.stat, files: changes.files });
      state.entries.push({ author: 'Squad', run: record.id, text: `Discarded the changes to ${file}${changes ? ` and committed the result to ${tree.branch}` : ''}.` });
    });
  }

  /**
   * Sends review feedback on the changes back to Implement as a new step in the same worktree.
   * A finished run becomes active again; its next commit lands on the same branch.
   */
  async requestChanges(id: unknown, textInput: unknown, repo?: unknown): Promise<void> {
    this.requireIdle();
    const { record, tree } = this.runTree(id, repo);
    if (typeof textInput !== 'string' || !textInput.trim() || textInput.length > 4_000) throw new Error('Describe the changes you want, up to 4,000 characters.');
    if (tree.merged) throw new Error(`${tree.branch} is already merged. Start a new request in chat instead.`);
    if (record.status !== 'active' && this.read().runs?.some(run => run.status === 'active' && run.id !== record.id)) {
      throw new Error('Finish or stop the current run before reopening this one.');
    }
    const agent = this.agentFor('Implement', await this.directory());
    if (agent?.kind !== 'claude') throw new Error('Assign a Claude Code account to Implement under Roles to apply review feedback.');
    const brief = `Apply this review feedback to the changes already made in this worktree (see git diff ${tree.base.slice(0, 12)}):\n${textInput.trim()}`;
    await this.updateRun(record.id, (saved, state) => {
      const step: RunStep = {
        role: 'Implement', brief, profile: agent.name, kind: 'claude', accountId: agent.id, revision: agent.revision,
        repo: tree.target, status: 'pending', feedback: true
      };
      const next = saved.status === 'active' ? this.currentStep(saved) : -1;
      saved.steps.splice(next < 0 ? saved.steps.length : next, 0, step);
      saved.status = 'active';
      state.entries.push({ author: 'You', to: 'Implement', run: record.id, text: `Requested changes${(saved.trees?.length ?? 0) > 1 ? ` in ${repoName(tree.target)}` : ''}: ${textInput.trim()}` });
    });
  }

  /** Records a push of one repository's branch, with the merge request link the remote returned. */
  recordPush(id: string, repo: string, result: PushResult): Promise<void> {
    return this.updateRun(id, (saved, state) => {
      const tree = saved.trees?.find(candidate => candidate.target === repo);
      if (!tree) throw new Error('This run has no such repository.');
      tree.pushed = { ...result, time: Date.now() };
      state.entries.push({
        author: 'Squad', run: id,
        text: `Pushed ${tree.branch}${(saved.trees?.length ?? 0) > 1 ? ` (${repoName(repo)})` : ''} to ${result.remote}${result.mergeRequest ? `, merge request into ${result.target}` : ''}${result.url ? `: ${result.url}` : '.'}`
      });
    });
  }

  recordMerge(id: string, repo: string, into: string): Promise<void> {
    return this.updateRun(id, (saved, state) => {
      const tree = saved.trees?.find(candidate => candidate.target === repo);
      if (!tree) return;
      tree.merged = Date.now();
      state.entries.push({ author: 'Squad', run: id, text: `Merged ${tree.branch}${(saved.trees?.length ?? 0) > 1 ? ` (${repoName(repo)})` : ''} into ${into} locally.` });
    });
  }

  async removeRun(id: unknown): Promise<void> {
    this.requireIdle();
    const record = this.run(id);
    if (!record) throw new Error('This run is no longer available.');
    if (record.trees?.length) {
      if (!this.host) throw new Error('Claude Code workers are not available here.');
      for (const tree of record.trees) await this.host.worktrees.remove(tree);
    }
    const branch = record.trees?.[0]?.branch;
    await this.write(state => {
      state.runs = (state.runs ?? []).filter(candidate => candidate.id !== id);
      state.entries.push({ author: 'Squad', text: branch ? `Removed the worktree${(record.trees?.length ?? 0) > 1 ? 's' : ''} and branch ${branch}.` : 'Removed the run.' });
    });
  }

  async discard(id: unknown): Promise<void> {
    this.requireIdle();
    const plan = this.requirePlan(id);
    await this.write(state => {
      if (state.plan?.id !== plan.id) throw new Error('This plan is no longer available.');
      state.plan = undefined;
      state.entries.push({ author: 'Squad', text: 'Plan discarded.' });
    });
  }

  startWorkflow(input: unknown): Promise<void> {
    this.requireIdle();
    const brief = workflowText(input, workflowBriefLimit, 'a project brief');
    return this.write(state => {
      if (state.workflow) throw new Error('A workflow is already open in this workspace.');
      state.workflow = { id: randomUUID(), brief, approved: [] };
    });
  }

  submitStageDraft(id: unknown, step: unknown, input: unknown): Promise<void> {
    this.requireIdle();
    const output = workflowText(input, workflowOutputLimit, 'a stage draft');
    return this.write(state => {
      const { workflow, stage } = this.currentStage(state, id, step);
      if (workflow.draft) throw new Error('There is already a draft for this stage. Review it in Workflow.');
      this.workflowIssue = undefined;
      workflow.draft = output;
      state.entries.push({ author: 'Squad', text: `SDLC stage draft submitted · ${stage.name}` });
    });
  }

  approveStage(id: unknown, step: unknown, input: unknown, approval?: { draft: string; signal: AbortSignal }): Promise<void> {
    this.requireIdle();
    const output = workflowText(input, workflowOutputLimit, 'a stage result');
    return this.write(state => {
      const { workflow, stage } = this.currentStage(state, id, step);
      approval?.signal.throwIfAborted();
      if (approval && workflow.draft !== approval.draft) throw new Error('The stage draft has changed.');
      workflow.approved.push(output);
      workflow.draft = undefined;
      state.entries.push({ author: 'Squad', text: `SDLC stage approved · ${stage.name}` });
    });
  }

  resetWorkflow(id: unknown): Promise<void> {
    this.requireIdle();
    return this.write(state => {
      if (!state.workflow || state.workflow.id !== id) throw new Error('The workflow has changed.');
      state.workflow = undefined;
    });
  }

  stageRequest(id: unknown, step: unknown): {
    instruction: string;
    brief: string;
    approved: { stage: string; result: string }[];
    skills: Pick<Skill, 'name' | 'instructions'>[];
    memory?: string[];
  } {
    const { workflow, stage } = this.currentStage(this.read(), id, step);
    const memory = this.memory.context();
    return {
      instruction: stage.instruction,
      brief: workflow.brief,
      approved: workflow.approved.map((result, index) => ({
        stage: workflowStages[index].name, result: shorten(result, 2_000)
      })),
      skills: this.customizations.activeSkills(),
      ...(memory.length ? { memory } : {})
    };
  }

  async draftStage(id: unknown, step: unknown, signal?: AbortSignal): Promise<StartedRun> {
    this.requireIdle();
    const { workflow, stage } = this.currentStage(this.read(), id, step);
    const request = this.stageRequest(id, step);
    const agent = this.agentFor(stage.role, await this.directory());
    if (agent?.kind !== 'api') throw new Error(`Assign an API profile to ${stage.role} under Roles or copy the stage brief to a terminal.`);
    const run = await this.launch(`Drafting ${stage.name}…`, signal, state => {
      this.currentStage(state, id, step);
      if (state.plan) throw new Error('Approve or discard the pending Squad plan before drafting a stage.');
      this.workflowIssue = undefined;
      state.entries.push({ author: 'You', to: stage.role, text: `Draft the SDLC ${stage.name} stage.` });
    }, async run => {
      const answer = await chat(agent.account, [
        { role: 'system', content: `You are ${stage.role}, drafting the ${stage.name} stage. ${textOnly} Use the provided project brief, approved results, and workspace skill instructions. Reply in the user's language.` },
        { role: 'user', content: JSON.stringify(request) }
      ], { signal: run.signal });
      run.signal.throwIfAborted();
      const draft = answer.trim().slice(0, workflowOutputLimit);
      if (!draft) throw new Error('The API returned an empty draft.');
      await this.write(state => {
        run.signal.throwIfAborted();
        this.currentStage(state, id, step).workflow.draft = draft;
        state.entries.push(this.reply(stage.role, agent, draft));
      }, run);
    });
    return { finished: run.finished.then(entries => {
      const issue = entries.find(entry => entry.author === 'Squad');
      if (issue) {
        this.workflowIssue = { id: workflow.id, step: workflow.approved.length, text: issue.text };
        this.changed();
      }
      return entries;
    }) };
  }

  private currentStage(state: Thread, id: unknown, step: unknown) {
    const workflow = state.workflow;
    const stage = workflowStage(workflow);
    if (!workflow || !stage || workflow.id !== id || workflow.approved.length !== step) {
      throw new Error('This workflow stage is no longer current.');
    }
    return { workflow, stage };
  }

  cancel(): void {
    if (!this.active) return;
    this.active.status = 'Stopping…';
    this.active.controller.abort();
    this.changed();
  }

  private requireIdle(): void {
    if (this.active) throw new Error('Wait for the current run or stop it first.');
    if (this.remoteRun(this.read().inFlight)) throw new Error('Another VS Code window is running a Squad step for this workspace. Wait for it to finish.');
  }

  private requirePlan(id: unknown): Plan {
    const plan = this.read().plan;
    if (!plan || id !== plan.id) throw new Error('This plan is no longer available.');
    return plan;
  }

  private async directory(): Promise<{ accounts: Account[]; terminals: TerminalProfile[] }> {
    const [{ accounts }, terminals] = await Promise.all([
      this.accounts.read(),
      this.host ? this.host.profiles().then(list => list.filter(profile => profile.provider === 'claude')) : Promise.resolve([])
    ]);
    return { accounts, terminals };
  }

  private agentFor(role: Role, { accounts, terminals }: { accounts: Account[]; terminals: TerminalProfile[] }): Agent | undefined {
    const seat = this.squad.seat(role).account;
    const account = accounts.find(candidate => `api:${candidate.id}` === seat);
    if (account) return { kind: 'api', id: account.id, name: account.name, revision: account.revision, account };
    const profile = terminals.find(candidate => terminalProfileId(candidate) === seat);
    return profile && { kind: 'claude', id: terminalProfileId(profile), name: profile.name, revision: profile.configDir, profile };
  }

  private verify(job: Job, directory: { accounts: Account[]; terminals: TerminalProfile[] }): Agent {
    const agent = this.agentFor(job.role, directory);
    if (agent?.id !== job.accountId || agent.revision !== job.revision || agent.kind !== (job.kind ?? 'api')) {
      throw new Error(`The profile for ${job.role} changed. Discard the plan if it is still pending, then ask Lead for a fresh plan.`);
    }
    return agent;
  }

  private reply(role: Role, agent: Agent, answer: string, cost = 0): SquadChatEntry {
    const label = agent.kind === 'claude' ? `${agent.name} · Claude Code` : agent.name;
    const price = formatCost(cost);
    return { author: role, profile: price ? `${label} · ${price}` : label, text: shorten(answer, responseLimit) };
  }

  /** Feeds a worker's tool calls into the live activity shown while it runs. */
  private track(run: ActiveRun, role: Role, profile: string): (activity: WorkerActivity) => void {
    run.live = { role, profile, since: Date.now(), items: [], reads: 0, edits: 0, commands: 0 };
    const live = run.live;
    return activity => {
      if (run.live !== live) return;
      live.items = [...live.items, { ...activity, time: Date.now() }].slice(-liveItems);
      if (activity.kind === 'read' || activity.kind === 'search') live.reads++;
      else if (activity.kind === 'edit') live.edits++;
      else if (activity.kind === 'run') live.commands++;
      else if (activity.kind === 'denied' || activity.kind === 'failed') live.problems = (live.problems ?? 0) + 1;
      if (activity.kind === 'denied') live.denied = (live.denied ?? 0) + 1;
      this.notifySoon();
    };
  }

  private notifySoon(): void {
    if (this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = undefined;
      this.changed();
    }, 250);
  }

  private read(): Thread {
    const state = this.storage.get<Thread>(storageKey) ?? { entries: [] };
    return state.runs?.some(run => !run.trees && (run as LegacyRun).path) ? { ...state, runs: state.runs.map(normalizeRun) } : state;
  }

  private write(update: (state: Thread) => void, run?: ActiveRun): Promise<void> {
    const pending = this.writes.then(async () => {
      const state = structuredClone(this.read());
      const count = state.entries.length;
      update(state);
      const entries = state.entries.slice(count);
      state.entries = state.entries.slice(-60);
      await this.storage.update(storageKey, state);
      run?.entries.push(...entries);
      this.changed();
    });
    this.writes = pending.catch(() => undefined);
    return pending;
  }

  private async launch(
    status: string, externalSignal: AbortSignal | undefined, setup: (state: Thread) => void,
    task: (run: ActiveRun) => Promise<void>
  ): Promise<StartedRun> {
    this.requireIdle();
    externalSignal?.throwIfAborted();
    const controller = new AbortController();
    const signal = externalSignal ? AbortSignal.any([externalSignal, controller.signal]) : controller.signal;
    const run: ActiveRun = { controller, signal, status, entries: [] };
    this.active = run;
    try {
      await this.write(state => {
        run.signal.throwIfAborted();
        if (this.remoteRun(state.inFlight)) throw new Error('Another VS Code window is running a Squad step for this workspace. Wait for it to finish.');
        setup(state);
        state.inFlight = { owner: this.owner, beat: Date.now(), status };
      });
    } catch (error) {
      this.active = undefined;
      throw error;
    }
    // Other windows share this state; the heartbeat tells them the run is still alive.
    clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => {
      if (this.active !== run) return;
      void this.write(state => {
        if (typeof state.inFlight === 'object' && state.inFlight.owner === this.owner) state.inFlight = { owner: this.owner, beat: Date.now(), status: run.status };
      }).catch(() => undefined);
    }, heartbeatMs);
    this.heartbeat.unref?.();
    return { finished: this.complete(run, task) };
  }

  private async complete(run: ActiveRun, task: (run: ActiveRun) => Promise<void>): Promise<SquadChatEntry[]> {
    let notice: string | undefined;
    try {
      run.signal.throwIfAborted();
      await task(run);
    } catch (error) {
      notice = run.signal.aborted ? 'Run stopped.' : error instanceof Error ? error.message : 'The run failed.';
    } finally {
      try {
        await this.write(state => {
          state.inFlight = undefined;
          for (const saved of state.runs ?? []) {
            for (const step of saved.steps ?? []) if (step.status === 'running') step.status = 'failed';
          }
          if (notice) state.entries.push({ author: 'Squad', text: notice });
        }, run);
      } catch {
        // The persisted in-flight marker allows the chat to report an interrupted run.
        run.entries.push({ author: 'Squad', text: notice ?? 'Could not save the final run status.' });
      } finally {
        clearInterval(this.heartbeat);
        this.heartbeat = undefined;
        this.active = undefined;
        this.changed();
      }
    }
    return run.entries;
  }
}

export type { WorkerMode };

function readGate(answer: string): { verdict: GateVerdict; reason: string } {
  const text = answer.trim();
  try {
    const value = JSON.parse(/^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text)?.[1] ?? text) as { verdict?: unknown; reason?: unknown };
    if ((value.verdict === 'pass' || value.verdict === 'changes') && typeof value.reason === 'string') {
      return { verdict: value.verdict, reason: value.reason.trim().slice(0, 1_000) };
    }
  } catch {
    // Treated as a request for changes below.
  }
  return { verdict: 'changes', reason: 'The reviewer did not return a clear verdict.' };
}

function parsePlan(
  answer: string, workers: ReadonlyMap<WorkerRole, Agent>, repositories: readonly string[] = []
): { reply: string; jobs: Job[]; invalid?: boolean } | undefined {
  let value: unknown;
  const text = answer.trim();
  try {
    value = JSON.parse(/^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text)?.[1] ?? text);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  const { reply, tasks } = value as { reply?: unknown; tasks?: unknown };
  if (typeof reply !== 'string' || !reply.trim() || !Array.isArray(tasks)) return undefined;
  const jobs: Job[] = [];
  for (const task of tasks) {
    if (!task || !isRole(task.role) || task.role === 'Lead') return { reply, jobs: [], invalid: true };
    const role = task.role;
    const agent = workers.get(role);
    const brief = typeof task.brief === 'string' ? task.brief.trim() : '';
    // A repository Lead names that is not in the list is dropped; the user picks one before approving.
    const repo = agent?.kind !== 'claude' ? undefined
      : repositories.length === 1 ? repositories[0]
        : typeof task.repo === 'string' && repositories.includes(task.repo.trim().replace(/\/+$/, '')) ? task.repo.trim().replace(/\/+$/, '') : undefined;
    const duplicate = jobs.some(job => job.role === role && (repositories.length < 2 || (repo !== undefined && job.repo === repo)));
    if (!agent || !brief || brief.length > 4_000 || duplicate || jobs.length >= 8) return { reply, jobs: [], invalid: true };
    jobs.push({ role, brief, profile: agent.name, kind: agent.kind, accountId: agent.id, revision: agent.revision, ...(repo ? { repo } : {}) });
  }
  // Implement steps come first, then Review, then Tests; Lead's order is kept within a role.
  jobs.sort((a, b) => workerRoles.indexOf(a.role) - workerRoles.indexOf(b.role));
  return { reply, jobs };
}
