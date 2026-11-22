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
import type { FileChange, RunWorktree, Worktrees } from './squad-worktree';
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
}

interface Plan {
  id: string;
  prompt: string;
  jobs: Job[];
  /** Repository the plan most likely targets, relative to the workspace folder. */
  repo?: string;
  repos?: string[];
}

export interface RunSession {
  role: Role;
  profileId: string;
  profile: string;
  sessionId: string;
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
}

export interface RunRecord {
  id: string;
  request: string;
  prompt: string;
  time: number;
  status: 'active' | 'done' | 'stopped';
  approver?: Approver;
  steps: RunStep[];
  repo?: string;
  /** The repository the run targets, relative to the workspace folder. */
  target?: string;
  path?: string;
  branch?: string;
  base?: string;
  commit?: string;
  stat?: string;
  files?: number;
  costUsd: number;
  sessions: RunSession[];
}

interface Thread {
  entries: SquadChatEntry[];
  plan?: Plan;
  workflow?: Workflow;
  inFlight?: boolean;
  runs?: RunRecord[];
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
  settings(role: Role): WorkerSettings;
  run(request: WorkerRequest): Promise<string>;
  worktrees: Pick<Worktrees, 'create' | 'commit' | 'remove' | 'changes' | 'changedFiles' | 'discard'>;
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
const headless = 'You are a headless Claude Code worker in xDev Squad. Nobody can answer questions during the run: decide reasonably, or report status "blocked" with what you need. Do not commit, push, or change git remotes; xDev commits the worktree for the user. Use available skills when they apply. Report through the required JSON fields and keep the summary short, because other agents read it.';

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

export class SquadChat {
  private active?: ActiveRun;
  private notifyTimer?: ReturnType<typeof setTimeout>;
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
    const { entries, inFlight, workflow, runs } = this.read();
    const plan = this.pendingPlan();
    return {
      entries,
      runs: runs ?? [],
      workflow,
      workflowIssue: this.workflowIssue?.id === workflow?.id && this.workflowIssue?.step === workflow?.approved.length
        ? this.workflowIssue?.text : undefined,
      plan: plan && { id: plan.id, jobs: plan.jobs, repo: plan.repo, repos: plan.repos },
      workers: Boolean(this.host),
      busy: Boolean(this.active),
      live: this.active?.live,
      status: this.active?.status ?? (inFlight ? 'The previous run was interrupted. Send a new message to continue.' : '')
    };
  }

  pendingPlan() {
    const plan = this.read().plan;
    return plan && {
      id: plan.id,
      repo: plan.repo,
      repos: plan.repos,
      jobs: plan.jobs.map(({ role, brief, profile, kind }) => ({ role, brief, profile, kind: kind ?? 'api' as AgentKind }))
    };
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
      const allowedCommands = this.host && [...workers.values()].some(candidate => candidate.kind === 'claude')
        ? [...this.host.settings('Implement').allowedCommands] : undefined;
      const capabilities = [...workers].map(([worker, candidate]) => candidate.kind === 'claude'
        ? `${worker} (Claude Code worker: reads the repository, ${worker === 'Review' ? 'reviews the diff' : 'edits files and runs allowed commands'} in a git worktree)`
        : `${worker} (text API: proposes text only)`);
      const leadSystem = `${roleInstructions.Lead} ${agent.kind === 'api' ? textOnly : 'Plan only; do not change files.'} Available worker roles: ${capabilities.join(', ') || 'none'}.
Return only a JSON object with a "reply" string and a "tasks" array. Each task has a "role" from the available worker roles and a "brief" string. Use each role at most once. Use an empty tasks array for questions, summaries, or when no workers are available. Write briefs that a worker can act on without the chat history. Reply in the user's language. The user reviews proposed tasks in the xDev Squad panel and approves them with a button, then starts each step there, so keep the reply to a short summary of the plan and do not ask the user to reply to start it.${repositories.length > 1 ? ' Workers run in one git repository chosen from "repositories": name it in the reply and at the start of each brief, and write file paths relative to that repository\'s root.' : ''}${allowedCommands ? ' Claude Code workers may only run "allowed_commands" and read-only git; do not ask them to run anything else.' : ''}${code ? ' "code" is a CodeGraph excerpt of the relevant symbols and call paths: name concrete files and symbols in each brief so workers do not have to search.' : ''}`;
      const content = JSON.stringify({
        history, request: prompt, memory: memory.length ? memory : undefined, code, allowed_commands: allowedCommands,
        repositories: repositories.length > 1 ? repositories.slice(0, 80) : undefined
      });
      const planned = { repos: repositories.length > 1 ? repositories : undefined, code };

      if (agent.kind === 'claude') {
        await this.host?.prepare?.();
        const stdout = await this.host!.run({
          executable: await this.host!.executable(), profile: agent.profile, cwd: this.host!.folder()!, role,
          mode: role === 'Lead' ? 'plan' : 'ask', prompt: content,
          system: role === 'Lead' ? leadSystem : `You are ${role} in xDev Squad. Answer the question using the repository. Do not edit files. Reply in the user's language.`,
          settings: this.host!.settings(role), signal: run.signal, onActivity: this.track(run, role, agent.name)
        });
        run.signal.throwIfAborted();
        if (role === 'Lead') {
          const report = parsePlanOutput(stdout);
          const plan = parsePlan(JSON.stringify(report), workers);
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
      if (role === 'Lead') await this.recordPlan(role, agent, prompt, parsePlan(answer, workers), answer, run, 0, planned);
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
        const repo = planned.repos && suggestRepository(planned.repos, [plan.reply, ...plan.jobs.map(job => job.brief), planned.code ?? '']);
        state.plan = { id: randomUUID(), prompt, jobs: plan.jobs, repo, repos: planned.repos };
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
    let target: string | undefined;
    if (headlessJobs && this.host?.repositories) {
      const repositories = await this.host.repositories();
      const chosen = typeof repoInput === 'string' && repoInput ? repoInput : plan.repo ?? (repositories.length === 1 ? repositories[0] : undefined);
      if (!repositories.length) throw new Error('Claude Code workers need a git repository in this workspace.');
      if (!chosen || !repositories.includes(chosen)) throw new Error('Choose the repository this run works in.');
      target = chosen;
    }

    return this.launch('Preparing the run…', signal, state => {
      if (state.plan?.id !== plan.id) throw new Error('This plan is no longer available.');
      state.plan = undefined;
      state.entries.push({ author: 'Squad', text: 'Plan approved.' });
    }, async run => {
      const runId = randomUUID();
      let worktree: RunWorktree | undefined;
      if (headlessJobs) {
        run.status = 'Preparing a git worktree…';
        this.changed();
        await this.host!.prepare?.();
        worktree = await this.host!.worktrees.create(target && target !== '.' ? join(folder!, target) : folder!, runId);
      }
      const record: RunRecord = {
        id: runId, request: plan.prompt, prompt: shorten(plan.prompt, 500), time: Date.now(), status: 'active', approver, costUsd: 0, target,
        sessions: [], steps: plan.jobs.map(job => ({ ...job, status: 'pending' })), ...worktree
      };
      await this.write(state => {
        state.runs = [record, ...(state.runs ?? [])].slice(0, runLimit);
        state.entries.push({
          author: 'Squad', run: runId,
          text: `${worktree ? `Branch ${worktree.branch} is ready in a separate worktree; your checkout is not changed. ` : ''}Nothing has run yet. Start each step under Worker runs: run it, open it in a terminal, or skip it.`
        });
      }, run);
    });
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
      previous: done.map(step => ({ role: step.role, status: 'done', summary: shorten(step.summary ?? '', 1_000), files: step.files?.length ? step.files : undefined })),
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
    if (agent.kind === 'claude' && !record.path) throw new Error('This run has no worktree for Claude Code steps.');

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
        if (nextAgent.kind === 'claude' && !saved.path) break;
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
    await this.updateRun(id, saved => Object.assign(saved.steps[index], { brief, status: 'running', gate: undefined }), run);
    const context = this.stepContext(record, index);
    try {
      if (agent.kind === 'claude') {
        await this.host!.prepare?.();
        const changed = step.role !== 'Implement' && record.repo && record.branch && record.base
          ? await this.host!.worktrees.changedFiles?.(record as RunWorktree).catch(() => []) ?? [] : [];
        const graph = await this.host!.codegraphRoot?.().catch(() => undefined);
        const settings = this.host!.settings(step.role);
        const stdout = await this.host!.run({
          executable: await this.host!.executable(), profile: agent.profile, cwd: record.path!, role: step.role, mode: 'work',
          prompt: JSON.stringify({
            request: record.request, task: brief, repository: record.target && record.target !== '.' ? record.target : undefined,
            previous: context.previous.length ? context.previous : undefined, changed_files: changed.length ? changed : undefined, memory: context.memory
          }),
          system: `${headless} You are ${step.role}. ${workerInstructions[step.role]}${record.target && record.target !== '.' ? ` Your working directory is the root of the repository "${record.target}"; read a leading "${record.target}/" in a path as this directory.` : ''}${graph ? ` A CodeGraph index of the workspace is at ${graph}: run \`codegraph explore -p ${graph} "<symbols or question>"\` to locate code before searching files. Its paths point to the main checkout; edit the matching files in this worktree.` : ''} Reply in the user's language.`,
          settings: graph ? { ...settings, codegraph: true } : settings, signal: run.signal, onActivity: this.track(run, step.role, agent.name)
        });
        run.signal.throwIfAborted();
        run.live = undefined;
        const result = parseWorkerOutput(stdout);
        await this.memory.add(result.memory, step.role);
        await this.updateRun(id, (saved, state) => {
          saved.costUsd += result.costUsd;
          if (result.sessionId) saved.sessions.push({ role: step.role, profileId: agent.id, profile: agent.name, sessionId: result.sessionId });
          Object.assign(saved.steps[index], { status: result.status, summary: result.summary, files: result.filesChanged });
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
        Object.assign(saved.steps[index], { status: 'done', summary: shorten(answer, 8_000) });
        state.entries.push({ ...this.reply(step.role, agent, answer), run: id });
      }, run);
      return 'done';
    } catch (error) {
      run.live = undefined;
      const detail = run.signal.aborted ? 'Step stopped.' : error instanceof Error ? error.message : 'The step failed.';
      await this.updateRun(id, saved => { saved.steps[index].status = 'failed'; }).catch(() => undefined);
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
    let gate: StepGate;
    try {
      if (reviewer.kind === 'claude') {
        const stdout = await this.host!.run({
          executable: await this.host!.executable(), profile: reviewer.profile, cwd: record.path ?? this.host!.folder()!, role: 'Lead', mode: 'gate',
          prompt: JSON.stringify(evidence),
          system: `You review one step of an xDev Squad run. ${record.path ? 'Inspect the uncommitted changes with git diff. ' : ''}Do not edit files. ${criteria}`,
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
    if (agent.kind !== 'claude' || !record.path) throw new Error('Only Claude Code steps can continue in a terminal.');
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
    return { profile: agent.profile, cwd: record.path, prompt, system: workerInstructions[step.role], role: step.role, name: agent.name };
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
    let changes: Awaited<ReturnType<WorkerHost['worktrees']['commit']>> | undefined;
    let issue: string | undefined;
    if (record.path && record.repo && record.branch && record.base) {
      try {
        changes = await this.host!.worktrees.commit(record as RunWorktree, `xDev Squad: ${record.request.split('\n', 1)[0]}`);
      } catch (error) {
        issue = error instanceof Error ? error.message : 'Could not commit the worktree.';
      }
    }
    await this.updateRun(id, (saved, state) => {
      const remaining = saved.steps.some(step => step.status !== 'done' && step.status !== 'skipped');
      for (const step of saved.steps) if (step.status !== 'done') step.status = 'skipped';
      Object.assign(saved, { status: remaining ? 'stopped' : status, commit: changes?.commit, stat: changes?.stat, files: changes?.files ?? 0 });
      const cost = formatCost(saved.costUsd);
      const text = !saved.branch ? `Run finished${cost ? ` · ${cost}` : ''}.`
        : issue ? `Could not commit the worktree: ${issue}`
          : changes?.commit
            ? `Committed ${changes.files} changed file${changes.files === 1 ? '' : 's'} to ${saved.branch}${cost ? ` · ${cost}` : ''}. Review the run below, then merge or remove it.`
            : `No file changes on ${saved.branch}${cost ? ` · ${cost}` : ''}.`;
      state.entries.push({ author: 'Squad', run: id, text });
    }, run);
  }

  private worktreeRun(id: unknown): RunRecord & RunWorktree {
    const record = this.run(id);
    if (!record) throw new Error('This run is no longer available.');
    if (!record.repo || !record.path || !record.branch || !record.base || !this.host) throw new Error('This run has no git worktree.');
    return record as RunRecord & RunWorktree;
  }

  /** The run's file changes against its base commit, including work not yet committed. */
  changes(id: unknown): Promise<FileChange[]> {
    return this.host!.worktrees.changes(this.worktreeRun(id));
  }

  /** Reverts one file of a run. A finished run gets a new local commit so merging matches what you see. */
  async discardFile(id: unknown, file: unknown): Promise<void> {
    this.requireIdle();
    const record = this.worktreeRun(id);
    if (typeof file !== 'string' || !file || file.length > 1_000) throw new Error('Choose a changed file.');
    await this.host!.worktrees.discard(record, file);
    let changes: Awaited<ReturnType<WorkerHost['worktrees']['commit']>> | undefined;
    if (record.status !== 'active' && record.commit) changes = await this.host!.worktrees.commit(record, `xDev Squad: discard ${file}`);
    await this.updateRun(record.id, (saved, state) => {
      if (changes) Object.assign(saved, { commit: changes.files ? changes.commit : undefined, stat: changes.stat, files: changes.files });
      state.entries.push({ author: 'Squad', run: record.id, text: `Discarded the changes to ${file}${changes ? ` and committed the result to ${saved.branch}` : ''}.` });
    });
  }

  async removeRun(id: unknown): Promise<void> {
    this.requireIdle();
    const record = this.run(id);
    if (!record) throw new Error('This run is no longer available.');
    if (record.path && record.repo && record.branch) {
      if (!this.host) throw new Error('Claude Code workers are not available here.');
      await this.host.worktrees.remove({ repo: record.repo, path: record.path, branch: record.branch });
    }
    await this.write(state => {
      state.runs = (state.runs ?? []).filter(candidate => candidate.id !== id);
      state.entries.push({ author: 'Squad', text: record.branch ? `Removed worktree and branch ${record.branch}.` : 'Removed the run.' });
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
    return this.storage.get<Thread>(storageKey) ?? { entries: [] };
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
        setup(state);
        state.inFlight = true;
      });
    } catch (error) {
      this.active = undefined;
      throw error;
    }
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

function parsePlan(answer: string, workers: ReadonlyMap<WorkerRole, Agent>): { reply: string; jobs: Job[]; invalid?: boolean } | undefined {
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
    if (!agent || !brief || brief.length > 4_000 || jobs.some(job => job.role === role)) return { reply, jobs: [], invalid: true };
    jobs.push({ role, brief, profile: agent.name, kind: agent.kind, accountId: agent.id, revision: agent.revision });
  }
  jobs.sort((a, b) => workerRoles.indexOf(a.role) - workerRoles.indexOf(b.role));
  return { reply, jobs };
}
