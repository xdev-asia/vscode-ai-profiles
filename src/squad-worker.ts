import { spawn as spawnProcess, type ChildProcess, type SpawnOptions } from 'node:child_process';
import type { Role } from './squad';
import { terminalProfileEnv, type TerminalProfile } from './terminal-profiles';

export const workerStatuses = ['done', 'blocked'] as const;
export type WorkerStatus = typeof workerStatuses[number];
export type WorkerMode = 'plan' | 'ask' | 'work';

export interface WorkerReport {
  status: WorkerStatus;
  summary: string;
  filesChanged: string[];
  tests: string;
  memory: string[];
}

export interface WorkerResult extends WorkerReport {
  sessionId?: string;
  costUsd: number;
  turns: number;
  denied: string[];
}

export interface PlanReport {
  reply: string;
  tasks: { role: string; brief: string }[];
}

export interface WorkerSettings {
  model?: string;
  budgetUsd: number;
  allowedCommands: readonly string[];
  timeoutMs: number;
}

export interface WorkerRequest {
  executable: string;
  profile: TerminalProfile;
  cwd: string;
  role: Role;
  mode: WorkerMode;
  prompt: string;
  system: string;
  settings: WorkerSettings;
  signal?: AbortSignal;
}

type Spawn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export const summaryLimit = 2_000;
export const memoryNoteLimit = 300;
const outputLimit = 4_000_000;

const reportSchema = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: workerStatuses },
    summary: { type: 'string', description: 'What you did or found, for the Lead. Short.' },
    files_changed: { type: 'array', items: { type: 'string' } },
    tests: { type: 'string', description: 'Commands run and their outcome, or empty.' },
    memory: {
      type: 'array', maxItems: 5, items: { type: 'string' },
      description: 'Durable facts teammates need later (conventions, decisions, pitfalls). Empty if none.'
    }
  },
  required: ['status', 'summary', 'files_changed', 'tests', 'memory']
} as const;

const planSchema = {
  type: 'object',
  properties: {
    reply: { type: 'string' },
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: { role: { type: 'string' }, brief: { type: 'string' } },
        required: ['role', 'brief']
      }
    }
  },
  required: ['reply', 'tasks']
} as const;

const readTools = ['Read', 'Glob', 'Grep'];
const gitRead = ['Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)'];

/**
 * Tools each role may use. Built-in tools outside `tools` are not loaded at all, which keeps
 * tool schemas out of the context. In print mode Claude Code denies anything not allowed
 * instead of prompting, and reports the denial in the result.
 */
export function workerTools(role: Role, mode: WorkerMode, allowedCommands: readonly string[]): { tools: string[]; allowed: string[] } {
  if (mode === 'plan') return { tools: [], allowed: [] };
  if (mode === 'ask' || role === 'Lead' || role === 'Review') {
    return { tools: [...readTools, 'Bash'], allowed: [...readTools, ...gitRead] };
  }
  const commands = allowedCommands.map(command => `Bash(${command}:*)`);
  return {
    tools: [...readTools, 'Edit', 'Write', 'Bash'],
    allowed: [...readTools, 'Edit', 'Write', ...gitRead, ...commands]
  };
}

export function validCommand(command: unknown): command is string {
  return typeof command === 'string' && /^[\w./@:+=-]+(?: [\w./@:+=-]+)*$/.test(command) && command.length <= 120;
}

export function workerArguments(request: Omit<WorkerRequest, 'executable' | 'profile' | 'cwd' | 'signal'>): string[] {
  const { role, mode, prompt, system, settings } = request;
  const { tools, allowed } = workerTools(role, mode, settings.allowedCommands.filter(validCommand));
  const args = [
    '-p', prompt,
    '--output-format', 'json',
    '--json-schema', JSON.stringify(mode === 'plan' ? planSchema : reportSchema),
    '--append-system-prompt', system,
    '--tools', tools.join(','),
    '--permission-mode', 'default',
    '--strict-mcp-config'
  ];
  if (allowed.length) args.push('--allowedTools', allowed.join(','));
  if (settings.budgetUsd > 0) args.push('--max-budget-usd', String(settings.budgetUsd));
  if (settings.model) args.push('--model', settings.model);
  if (mode !== 'work') args.push('--no-session-persistence');
  return args;
}

export function workerEnvironment(profile: TerminalProfile, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const [key, value] of Object.entries(terminalProfileEnv(profile))) {
    if (value === null) delete env[key];
    else env[key] = value;
  }
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  return env;
}

function strings(value: unknown, limit: number, count: number): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
      .slice(0, count).map(item => item.trim().slice(0, limit))
    : [];
}

interface ResultMessage {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: unknown;
  structured_output?: unknown;
  session_id?: unknown;
  total_cost_usd?: unknown;
  num_turns?: unknown;
  permission_denials?: unknown;
}

function readResult(stdout: string): ResultMessage {
  let value: unknown;
  try {
    value = JSON.parse(stdout.trim());
  } catch {
    throw new Error('Claude Code did not return a JSON result. Update Claude Code and try again.');
  }
  if (!value || typeof value !== 'object' || (value as ResultMessage).type !== 'result') {
    throw new Error('Claude Code returned an unexpected result.');
  }
  return value as ResultMessage;
}

function failure(message: ResultMessage): string | undefined {
  if (message.subtype === 'error_max_budget_usd') return 'The worker reached its budget limit. Raise xdevAi.squad.workerBudgetUsd or narrow the task.';
  if (message.subtype === 'error_max_turns') return 'The worker reached its turn limit before finishing.';
  if (message.is_error || message.subtype !== 'success') {
    const detail = typeof message.result === 'string' && message.result.trim() ? message.result.trim().slice(0, 300) : message.subtype;
    return `Claude Code stopped: ${detail ?? 'unknown error'}.`;
  }
  return undefined;
}

function deniedTools(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.flatMap(item => {
    const name = (item as { tool_name?: unknown })?.tool_name;
    const command = (item as { tool_input?: { command?: unknown } })?.tool_input?.command;
    if (typeof name !== 'string') return [];
    return [typeof command === 'string' ? `${name}: ${command.slice(0, 80)}` : name];
  }))].slice(0, 10);
}

export function parseWorkerOutput(stdout: string): WorkerResult {
  const message = readResult(stdout);
  const error = failure(message);
  if (error) throw new Error(error);
  const report = (message.structured_output ?? {}) as Record<string, unknown>;
  const status = workerStatuses.find(candidate => candidate === report.status);
  const summary = typeof report.summary === 'string' ? report.summary.trim().slice(0, summaryLimit) : '';
  if (!status || !summary) throw new Error('The worker did not return a structured report.');
  return {
    status,
    summary,
    filesChanged: strings(report.files_changed, 300, 100),
    tests: typeof report.tests === 'string' ? report.tests.trim().slice(0, 1_000) : '',
    memory: strings(report.memory, memoryNoteLimit, 5),
    sessionId: typeof message.session_id === 'string' ? message.session_id : undefined,
    costUsd: typeof message.total_cost_usd === 'number' ? message.total_cost_usd : 0,
    turns: typeof message.num_turns === 'number' ? message.num_turns : 0,
    denied: deniedTools(message.permission_denials)
  };
}

export function parsePlanOutput(stdout: string): PlanReport & { costUsd: number } {
  const message = readResult(stdout);
  const error = failure(message);
  if (error) throw new Error(error);
  const plan = (message.structured_output ?? {}) as Record<string, unknown>;
  if (typeof plan.reply !== 'string' || !Array.isArray(plan.tasks)) throw new Error('Lead did not return a structured plan.');
  return {
    reply: plan.reply,
    tasks: plan.tasks.map(task => ({
      role: typeof task?.role === 'string' ? task.role : '',
      brief: typeof task?.brief === 'string' ? task.brief : ''
    })),
    costUsd: typeof message.total_cost_usd === 'number' ? message.total_cost_usd : 0
  };
}

/** Runs Claude Code once in print mode under the given terminal profile and returns its stdout. */
export function runClaude(request: WorkerRequest, spawn: Spawn = spawnProcess): Promise<string> {
  const { executable, profile, cwd, settings, signal } = request;
  if (profile.provider !== 'claude') return Promise.reject(new Error('Headless workers need a Claude Code terminal account.'));
  signal?.throwIfAborted();
  const args = workerArguments(request);
  return new Promise((resolve, reject) => {
    const windowsScript = process.platform === 'win32' && /\.cmd$/i.test(executable);
    const child = spawn(windowsScript ? process.env.ComSpec ?? 'cmd.exe' : executable,
      windowsScript ? ['/d', '/s', '/c', executable, ...args] : args, {
        cwd, env: workerEnvironment(profile), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
      });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(stdout);
    };
    const stop = () => {
      if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
    };
    const abort = () => {
      stop();
      finish(signal?.reason instanceof Error ? signal.reason : new Error('The worker was stopped.'));
    };
    const timer = setTimeout(() => {
      stop();
      finish(new Error(`The worker did not finish within ${Math.round(settings.timeoutMs / 60_000)} minutes.`));
    }, settings.timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.length > outputLimit) {
        stop();
        finish(new Error('The worker output was too large.'));
      }
    });
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-2_000);
    });
    child.on('error', error => finish(new Error(`Could not start Claude Code: ${error.message}`)));
    child.on('close', code => {
      if (code === 0 || stdout.trim().startsWith('{')) return finish();
      const detail = stderr.trim().split('\n').at(-1)?.slice(0, 300);
      finish(new Error(`Claude Code exited with code ${code}${detail ? `: ${detail}` : ''}. Sign in to the terminal account again if its session expired.`));
    });
  });
}
