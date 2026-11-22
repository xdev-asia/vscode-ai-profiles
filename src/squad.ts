import type { Memento } from 'vscode';

export const roles = ['Lead', 'Implement', 'Review', 'Tests'] as const;
export type Role = typeof roles[number];
export const taskStatuses = ['Ready', 'In progress', 'Blocked', 'Done'] as const;
type TaskStatus = typeof taskStatuses[number];
export const taskLimit = 8_000;
export const noteLimit = 500;

interface Task {
  account: string;
  brief: string;
  status: TaskStatus;
  blocker: string;
}

interface Seat extends Task {
  response?: string;
}

interface Activity {
  from: Role;
  to?: Role;
  message: string;
  time: number;
}

interface Squad {
  seats: Partial<Record<Role, Seat>>;
  activity: Activity[];
}

const storageKey = 'squad.v1';
const emptySeat: Readonly<Seat> = { account: '', brief: '', status: 'Ready', blocker: '' };

function field(input: unknown, limit: number): string {
  if (typeof input !== 'string' || input.length > limit) throw new Error('The task contains an invalid field.');
  return input.trim();
}

export function isRole(value: unknown): value is Role {
  return roles.some(role => role === value);
}

export function readTask(input: Record<string, unknown>): Task {
  const account = field(input.account, 60);
  const brief = field(input.brief, taskLimit);
  const status = taskStatuses.find(candidate => candidate === input.status);
  if (!status) throw new Error('Choose a task status.');
  const blocker = status === 'Blocked' ? field(input.blocker, noteLimit) : '';
  if (!brief && status !== 'Ready') throw new Error('Add a task brief before changing its status.');
  if (status === 'Blocked' && !blocker) throw new Error('Describe what needs a decision or is blocking the task.');
  return { account, brief, status, blocker };
}

export class SquadStore {
  private writes = Promise.resolve();

  constructor(private readonly storage: Memento) {}

  read(): Squad {
    return this.storage.get<Squad>(storageKey) ?? { seats: {}, activity: [] };
  }

  seat(role: Role): Readonly<Seat> {
    return this.read().seats[role] ?? emptySeat;
  }

  save(role: Role, task: Task): Promise<void> {
    return this.update(squad => {
      const previous = squad.seats[role] ?? emptySeat;
      const sameBrief = task.brief === previous.brief;
      const sameAccount = task.account === previous.account;
      if (sameBrief && sameAccount && task.status === previous.status && task.blocker === previous.blocker) return;

      squad.seats[role] = { ...task, response: sameBrief && sameAccount ? previous.response : undefined };
      let message = task.brief ? 'Updated task' : 'Cleared task';
      if (task.status === 'Blocked') message = task.blocker;
      else if (task.status !== previous.status) message = task.status;
      else if (sameBrief && !sameAccount) message = task.account ? 'Assigned profile' : 'Unassigned profile';
      const to = task.status === 'Blocked' && role !== 'Lead' ? 'Lead' : undefined;
      squad.activity.unshift({ from: role, to, message, time: Date.now() });
    });
  }

  /** Gives every role the same profile, keeping each role's task. */
  assignAll(account: string, all: readonly Role[]): Promise<void> {
    return this.update(squad => {
      for (const role of all) {
        const seat = squad.seats[role] ?? emptySeat;
        if (seat.account === account) continue;
        squad.seats[role] = { ...seat, account, response: undefined };
      }
      squad.activity.unshift({ from: 'Lead', message: 'Assigned one profile to every role', time: Date.now() });
    });
  }

  handoff(from: Role, to: Role, note: string): Promise<void> {
    return this.update(squad => {
      squad.activity.unshift({ from, to, message: note, time: Date.now() });
    });
  }

  recordResponse(role: Role, response: string): Promise<void> {
    return this.update(squad => {
      const seat = squad.seats[role];
      if (!seat) return;
      seat.response = response;
      squad.activity.unshift({ from: role, message: 'Received API response', time: Date.now() });
    });
  }

  private update(change: (squad: Squad) => void): Promise<void> {
    const pending = this.writes.then(async () => {
      const squad = structuredClone(this.read());
      change(squad);
      squad.activity = squad.activity.slice(0, 30);
      await this.storage.update(storageKey, squad);
    });
    this.writes = pending.catch(() => undefined);
    return pending;
  }
}
