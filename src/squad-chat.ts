import { randomUUID } from 'node:crypto';
import type { Memento } from 'vscode';
import { Accounts, type Account } from './accounts';
import { chat } from './core';
import { isRole, roles, SquadStore, type Role } from './squad';
import { SquadCustomizations, type Skill } from './squad-customizations';
import { SquadMemory } from './squad-memory';
import { parsePlanOutput, parseWorkerOutput, type WorkerMode, type WorkerRequest, type WorkerResult, type WorkerSettings } from './squad-worker';
import type { RunWorktree, Worktrees } from './squad-worktree';
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
}

export interface RunSession {
  role: Role;
  profileId: string;
  profile: string;
  sessionId: string;
}

export interface RunRecord {
  id: string;
  prompt: string;
  time: number;
  status: 'running' | 'done' | 'blocked' | 'failed' | 'stopped';
  repo: string;
  path: string;
  branch: string;
  base: string;
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

interface ActiveRun {
  controller: AbortController;
  signal: AbortSignal;
  entries: SquadChatEntry[];
  status: string;
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
  worktrees: Pick<Worktrees, 'create' | 'commit' | 'remove'>;
  prepare?(): Promise<void>;
}

const roleInstructions: Record<Role, string> = {
  Lead: 'Plan the work or answer a direct question.',
  Implement: 'Propose the implementation and practical code changes.',
  Review: 'Review the proposal for correctness, regressions, and gaps.',
  Tests: 'Propose tests with high-value cases and expected results.'
};
const workerInstructions: Record<WorkerRole, string> = {
  Implement: 'Make the code changes for your task in this git worktree. Keep the change focused. Run the allowed build or test commands when useful.',
  Review: 'Review the uncommitted changes in this worktree (git diff) against the task. Report concrete findings with file and line. Do not edit files.',
  Tests: 'Add or update tests for the change in this worktree and run the allowed test commands. Report what passed and failed.'
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

export class SquadChat {
  private active?: ActiveRun;
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
      plan: plan && { id: plan.id, jobs: plan.jobs },
      workers: Boolean(this.host),
      busy: Boolean(this.active),
      status: this.active?.status ?? (inFlight ? 'The previous run was interrupted. Send a new message to continue.' : '')
    };
  }

  pendingPlan() {
    const plan = this.read().plan;
    return plan && {
      id: plan.id,
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
      const capabilities = [...workers].map(([worker, candidate]) => candidate.kind === 'claude'
        ? `${worker} (Claude Code worker: reads the repository, ${worker === 'Review' ? 'reviews the diff' : 'edits files and runs allowed commands'} in a git worktree)`
        : `${worker} (text API: proposes text only)`);
      const leadSystem = `${roleInstructions.Lead} ${agent.kind === 'api' ? textOnly : 'Plan only; do not change files.'} Available worker roles: ${capabilities.join(', ') || 'none'}.
Return only a JSON object with a "reply" string and a "tasks" array. Each task has a "role" from the available worker roles and a "brief" string. Use each role at most once. Use an empty tasks array for questions, summaries, or when no workers are available. Write briefs that a worker can act on without the chat history. Reply in the user's language. Proposed tasks must wait for user approval.`;
      const content = JSON.stringify({ history, request: prompt, memory: memory.length ? memory : undefined });

      if (agent.kind === 'claude') {
        await this.host?.prepare?.();
        const stdout = await this.host!.run({
          executable: await this.host!.executable(), profile: agent.profile, cwd: this.host!.folder()!, role,
          mode: role === 'Lead' ? 'plan' : 'ask', prompt: content,
          system: role === 'Lead' ? leadSystem : `You are ${role} in xDev Squad. Answer the question using the repository. Do not edit files. Reply in the user's language.`,
          settings: this.host!.settings(role), signal: run.signal
        });
        run.signal.throwIfAborted();
        if (role === 'Lead') {
          const report = parsePlanOutput(stdout);
          const plan = parsePlan(JSON.stringify(report), workers);
          await this.recordPlan(role, agent, prompt, plan, report.reply, run, report.costUsd);
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
      if (role === 'Lead') await this.recordPlan(role, agent, prompt, parsePlan(answer, workers), answer, run);
      else await this.write(state => state.entries.push(this.reply(role, agent, answer)), run);
    });
  }

  private recordPlan(
    role: Role, agent: Agent, prompt: string, plan: ReturnType<typeof parsePlan>, fallback: string, run: ActiveRun, cost = 0
  ): Promise<void> {
    return this.write(state => {
      state.entries.push(this.reply(role, agent, plan?.reply ?? fallback, cost));
      if (plan?.jobs.length) state.plan = { id: randomUUID(), prompt, jobs: plan.jobs };
      if (!plan || plan.invalid) {
        state.entries.push({ author: 'Squad', text: 'Lead did not return a valid plan. Ask again to generate tasks.' });
      }
    }, run);
  }

  async approve(id: unknown, signal?: AbortSignal): Promise<StartedRun> {
    this.requireIdle();
    const plan = this.requirePlan(id);
    const directory = await this.directory();
    for (const job of plan.jobs) this.verify(job, directory);
    const headlessJobs = plan.jobs.some(job => job.kind === 'claude');
    const folder = this.host?.folder();
    if (headlessJobs && (!this.host || !folder)) throw new Error('Open a workspace folder to run Claude Code workers.');

    return this.launch('Starting approved tasks…', signal, state => {
      if (state.plan?.id !== plan.id) throw new Error('This plan is no longer available.');
      state.plan = undefined;
      state.entries.push({ author: 'Squad', text: 'Plan approved.' });
    }, async run => {
      let worktree: RunWorktree | undefined;
      let record: RunRecord | undefined;
      let outcome: RunRecord['status'] = 'done';
      const previous: { role: Role; status: string; summary: string; files?: string[] }[] = [];
      let implementation: string | undefined;
      try {
        if (headlessJobs) {
          run.status = 'Preparing a git worktree…';
          this.changed();
          await this.host!.prepare?.();
          const runId = randomUUID();
          worktree = await this.host!.worktrees.create(folder!, runId);
          record = { id: runId, prompt: shorten(plan.prompt, 500), time: Date.now(), status: 'running', costUsd: 0, sessions: [], ...worktree };
          const created = record;
          await this.write(state => {
            state.runs = [created, ...(state.runs ?? [])].slice(0, runLimit);
            state.entries.push({ author: 'Squad', run: runId, text: `Workers use branch ${worktree!.branch} in a separate worktree. Your checkout is not changed.` });
          }, run);
        }

        for (const job of plan.jobs) {
          run.signal.throwIfAborted();
          run.status = `${job.role} is ${job.kind === 'claude' ? 'working' : 'responding'}…`;
          this.changed();
          const agent = this.verify(job, await this.directory());
          const memory = this.memory.context();

          if (agent.kind === 'claude') {
            const stdout = await this.host!.run({
              executable: await this.host!.executable(), profile: agent.profile, cwd: worktree!.path, role: job.role, mode: 'work',
              prompt: JSON.stringify({ request: plan.prompt, task: job.brief, previous: previous.length ? previous : undefined, memory: memory.length ? memory : undefined }),
              system: `${headless} You are ${job.role}. ${workerInstructions[job.role]} Reply in the user's language.`,
              settings: this.host!.settings(job.role), signal: run.signal
            }).catch((error: unknown) => {
              throw new Error(`${job.role}: ${error instanceof Error ? error.message : 'The worker failed.'}`, { cause: error });
            });
            run.signal.throwIfAborted();
            const result = (() => {
              try {
                return parseWorkerOutput(stdout);
              } catch (error) {
                throw new Error(`${job.role}: ${error instanceof Error ? error.message : 'Unreadable worker result.'}`, { cause: error });
              }
            })();
            previous.push({ role: job.role, status: result.status, summary: result.summary, files: result.filesChanged.length ? result.filesChanged : undefined });
            await this.memory.add(result.memory, job.role);
            const runId = record!.id;
            await this.write(state => {
              const saved = state.runs?.find(candidate => candidate.id === runId);
              if (saved) {
                saved.costUsd += result.costUsd;
                if (result.sessionId) saved.sessions.push({ role: job.role, profileId: agent.id, profile: agent.name, sessionId: result.sessionId });
              }
              state.entries.push({ ...this.reply(job.role, agent, workerText(result), result.costUsd), run: runId });
            }, run);
            if (result.status === 'blocked') {
              outcome = 'blocked';
              await this.write(state => state.entries.push({ author: 'Squad', text: `${job.role} is blocked, so the remaining tasks were skipped. Reply to Lead with a decision to continue.` }), run);
              break;
            }
            continue;
          }

          const answer = await chat(agent.account, [
            { role: 'system', content: `You are ${job.role}. ${roleInstructions[job.role]} ${textOnly} Reply in the user's language.` },
            {
              role: 'user',
              content: JSON.stringify({
                request: plan.prompt, task: job.brief,
                implementation: implementation && shorten(implementation, 8_000),
                previous: previous.some(item => item.files) ? previous : undefined,
                memory: memory.length ? memory : undefined
              })
            }
          ], { signal: run.signal }).catch((error: unknown) => {
            const detail = error instanceof Error ? error.message : 'The API request failed.';
            throw new Error(`${job.role}: ${detail}`, { cause: error });
          });
          run.signal.throwIfAborted();
          if (job.role === 'Implement') implementation = answer;
          previous.push({ role: job.role, status: 'done', summary: shorten(answer, 1_000) });
          await this.write(state => state.entries.push(this.reply(job.role, agent, answer)), run);
        }
        await this.write(state => state.entries.push({ author: 'Squad', text: 'Approved tasks finished.' }), run);
      } catch (error) {
        outcome = run.signal.aborted ? 'stopped' : 'failed';
        throw error;
      } finally {
        if (worktree && record) await this.finishRun(record.id, worktree, plan.prompt, outcome, run);
      }
    });
  }

  private async finishRun(id: string, worktree: RunWorktree, prompt: string, status: RunRecord['status'], run: ActiveRun): Promise<void> {
    let changes: Awaited<ReturnType<WorkerHost['worktrees']['commit']>> | undefined;
    let issue: string | undefined;
    try {
      changes = await this.host!.worktrees.commit(worktree, `xDev Squad: ${prompt.split('\n', 1)[0]}`);
    } catch (error) {
      issue = error instanceof Error ? error.message : 'Could not commit the worktree.';
    }
    await this.write(state => {
      const saved = state.runs?.find(candidate => candidate.id === id);
      if (saved) Object.assign(saved, { status, commit: changes?.commit, stat: changes?.stat, files: changes?.files ?? 0 });
      const cost = formatCost(saved?.costUsd ?? 0);
      const text = issue ? `Could not commit the worktree: ${issue}` : changes?.commit
        ? `Committed ${changes.files} changed file${changes.files === 1 ? '' : 's'} to ${worktree.branch}${cost ? ` · ${cost}` : ''}. Review the run below, then merge or discard it.`
        : `No file changes on ${worktree.branch}${cost ? ` · ${cost}` : ''}.`;
      state.entries.push({ author: 'Squad', run: id, text });
    }, run).catch(() => undefined);
  }

  async removeRun(id: unknown): Promise<void> {
    this.requireIdle();
    const record = this.run(id);
    if (!record) throw new Error('This run is no longer available.');
    if (!this.host) throw new Error('Claude Code workers are not available here.');
    await this.host.worktrees.remove(record);
    await this.write(state => {
      state.runs = (state.runs ?? []).filter(candidate => candidate.id !== id);
      state.entries.push({ author: 'Squad', text: `Removed worktree and branch ${record.branch}.` });
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
          for (const saved of state.runs ?? []) if (saved.status === 'running') saved.status = 'stopped';
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
