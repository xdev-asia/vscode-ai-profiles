import { randomUUID } from 'node:crypto';
import type { Memento } from 'vscode';
import { Accounts, type Account } from './accounts';
import { chat } from './core';
import { isRole, roles, SquadStore, type Role } from './squad';

const storageKey = 'squadChat.v1';
const workerRoles = ['Implement', 'Review', 'Tests'] as const satisfies readonly Role[];
type WorkerRole = typeof workerRoles[number];
export const chatPromptLimit = 8_000;
const responseLimit = 16_000;

export interface SquadChatEntry {
  author: Role | 'You' | 'Squad';
  text: string;
  profile?: string;
  to?: Role;
}

interface Job {
  role: WorkerRole;
  brief: string;
  profile: string;
  accountId: string;
  revision: string;
}

interface Plan {
  id: string;
  prompt: string;
  jobs: Job[];
}

interface Thread {
  entries: SquadChatEntry[];
  plan?: Plan;
  inFlight?: boolean;
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

const roleInstructions: Record<Role, string> = {
  Lead: 'Plan the work or answer a direct question.',
  Implement: 'Propose the implementation and practical code changes.',
  Review: 'Review the proposal for correctness, regressions, and gaps.',
  Tests: 'Propose tests with high-value cases and expected results.'
};
const textOnly = 'You are using a text API. You cannot access the workspace, edit files, or run commands. Do not claim that you did.';

function shorten(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(0, limit) + '\n[Truncated]';
}

export class SquadChat {
  private active?: ActiveRun;
  private writes = Promise.resolve();

  constructor(
    private readonly storage: Memento,
    private readonly accounts: Accounts,
    private readonly squad: SquadStore,
    private readonly changed: () => void
  ) {}

  snapshot() {
    const { entries, inFlight } = this.read();
    const plan = this.pendingPlan();
    return {
      entries,
      plan: plan && { id: plan.id, jobs: plan.jobs },
      busy: Boolean(this.active),
      status: this.active?.status ?? (inFlight ? 'The previous run was interrupted. Send a new message to continue.' : '')
    };
  }

  pendingPlan() {
    const plan = this.read().plan;
    return plan && {
      id: plan.id,
      jobs: plan.jobs.map(({ role, brief, profile }) => ({ role, brief, profile }))
    };
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
    const { accounts } = await this.accounts.read();
    const account = this.accountFor(role, accounts);
    if (!account) throw new Error(`Assign an API profile to ${role} under Roles, or open its AI terminal from chat.`);
    const workers = new Map(workerRoles.flatMap(worker => {
      const profile = this.accountFor(worker, accounts);
      return profile ? [[worker, profile] as const] : [];
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
      const system = role === 'Lead'
        ? `${roleInstructions.Lead} ${textOnly} Available worker roles: ${[...workers.keys()].join(', ') || 'none'}.
Return only a JSON object with a "reply" string and a "tasks" array. Each task has a "role" from the available worker roles and a "brief" string. Use each role at most once. Use an empty tasks array for questions, summaries, or when no workers are available. Reply in the user's language. Proposed tasks must wait for user approval.`
        : `You are ${role}. ${roleInstructions[role]} ${textOnly} Reply in the user's language.`;
      const answer = await chat(account, [
        { role: 'system', content: system },
        { role: 'user', content: JSON.stringify({ history, request: prompt }) }
      ], { signal: run.signal });
      run.signal.throwIfAborted();
      const plan = role === 'Lead' ? parsePlan(answer, workers) : undefined;
      await this.write(state => {
        state.entries.push(this.reply(role, account, plan?.reply ?? answer));
        if (plan?.jobs.length) state.plan = { id: randomUUID(), prompt, jobs: plan.jobs };
        if (role === 'Lead' && (!plan || plan.invalid)) {
          state.entries.push({ author: 'Squad', text: 'Lead did not return a valid plan. Ask again to generate tasks.' });
        }
      }, run);
    });
  }

  async approve(id: unknown, signal?: AbortSignal): Promise<StartedRun> {
    this.requireIdle();
    const plan = this.requirePlan(id);
    const { accounts } = await this.accounts.read();
    for (const job of plan.jobs) this.verify(job, accounts);

    return this.launch('Starting approved tasks…', signal, state => {
      if (state.plan?.id !== plan.id) throw new Error('This plan is no longer available.');
      state.plan = undefined;
      state.entries.push({ author: 'Squad', text: 'Plan approved.' });
    }, async run => {
      let implementation: string | undefined;
      for (const job of plan.jobs) {
        run.signal.throwIfAborted();
        run.status = `${job.role} is responding…`;
        this.changed();
        const { accounts: available } = await this.accounts.read();
        const account = this.verify(job, available);
        const answer = await chat(account, [
          { role: 'system', content: `You are ${job.role}. ${roleInstructions[job.role]} ${textOnly} Reply in the user's language.` },
          {
            role: 'user',
            content: JSON.stringify({
              request: plan.prompt, task: job.brief,
              implementation: implementation && shorten(implementation, 8_000)
            })
          }
        ], { signal: run.signal }).catch((error: unknown) => {
          const detail = error instanceof Error ? error.message : 'The API request failed.';
          throw new Error(`${job.role}: ${detail}`, { cause: error });
        });
        run.signal.throwIfAborted();
        if (job.role === 'Implement') implementation = answer;
        await this.write(state => state.entries.push(this.reply(job.role, account, answer)), run);
      }
      await this.write(state => state.entries.push({ author: 'Squad', text: 'Approved tasks finished.' }), run);
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

  private accountFor(role: Role, accounts: Account[]): Account | undefined {
    const profile = this.squad.seat(role).account;
    return accounts.find(account => `api:${account.id}` === profile);
  }

  private verify(job: Job, accounts: Account[]): Account {
    const account = this.accountFor(job.role, accounts);
    if (account?.id !== job.accountId || account.revision !== job.revision) {
      throw new Error(`The API profile for ${job.role} changed. Discard the plan if it is still pending, then ask Lead for a fresh plan.`);
    }
    return account;
  }

  private reply(role: Role, account: Account, answer: string): SquadChatEntry {
    return { author: role, profile: account.name, text: shorten(answer, responseLimit) };
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

function parsePlan(answer: string, workers: ReadonlyMap<WorkerRole, Account>): { reply: string; jobs: Job[]; invalid?: boolean } | undefined {
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
    const account = workers.get(role);
    const brief = typeof task.brief === 'string' ? task.brief.trim() : '';
    if (!account || !brief || brief.length > 2_000 || jobs.some(job => job.role === role)) return { reply, jobs: [], invalid: true };
    jobs.push({ role, brief, profile: account.name, accountId: account.id, revision: account.revision });
  }
  jobs.sort((a, b) => workerRoles.indexOf(a.role) - workerRoles.indexOf(b.role));
  return { reply, jobs };
}
