import { spawn as spawnProcess, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import type { Role } from './squad';
import { envDenyRules } from './squad-env';
import type { WorkerMcp } from './squad-mcp';
import { terminalProfileEnv, type TerminalProfile } from './terminal-profiles';

export const workerStatuses = ['done', 'blocked'] as const;
export type WorkerStatus = typeof workerStatuses[number];
export type WorkerMode = 'plan' | 'ask' | 'work' | 'gate';

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
  tasks: { role: string; brief: string; repo?: string }[];
  sessionId?: string;
}

export interface WorkerSettings {
  model?: string;
  budgetUsd: number;
  allowedCommands: readonly string[];
  timeoutMs: number;
  /** Lets workers query a CodeGraph index with `codegraph explore|node|query`. */
  codegraph?: boolean;
  /** MCP servers this project grants the role, and the rules for the tools it may call. Never used by AI gates. */
  mcp?: WorkerMcp;
  /** Variables from the project's .env files, set for the worker's commands. Never in the prompt. */
  env?: Record<string, string>;
  /** Absolute paths of the project's .env files, which no role may read. */
  denyRead?: readonly string[];
}

/**
 * The worker settings the Squad view displays. Everything else stays in the extension host: MCP server
 * definitions can hold tokens in `env` or `headers`, and `env`/`denyRead` describe the project's .env files.
 */
export function workerSummary(settings: WorkerSettings): Pick<WorkerSettings, 'budgetUsd' | 'allowedCommands'> {
  return { budgetUsd: settings.budgetUsd, allowedCommands: [...settings.allowedCommands] };
}

export type ActivityKind ='read' | 'search' | 'edit' | 'run' | 'tool' | 'denied' | 'failed';

export interface WorkerActivity {
  kind: ActivityKind;
  text: string;
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
  /** A Claude Code session to continue (`--resume`); it must belong to `profile` and `cwd`. */
  resume?: string;
  /** Keep the session of a plan, ask, or gate run so a later run can resume it. Work runs always keep theirs. */
  persist?: boolean;
  /** Called for each tool the worker uses, while it runs. */
  onActivity?: (activity: WorkerActivity) => void;
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
    reply: { type: 'string', description: 'A short summary of the plan for the user, at most 80 words, without labels or disclaimers.' },
    tasks: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        properties: {
          role: { type: 'string' },
          brief: { type: 'string' },
          repo: { type: 'string', description: 'The repository from "repositories" this task works in. Empty when there is only one.' }
        },
        required: ['role', 'brief']
      }
    }
  },
  required: ['reply', 'tasks']
} as const;

const gateSchema = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['pass', 'changes'] },
    reason: { type: 'string', description: 'Short reason. For changes, what is missing or wrong.' }
  },
  required: ['verdict', 'reason']
} as const;

const readTools = ['Read', 'Glob', 'Grep'];
const gitRead = ['Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)'];
const codegraphRead = ['Bash(codegraph explore:*)', 'Bash(codegraph node:*)', 'Bash(codegraph query:*)'];

/**
 * Tools each role may use. Built-in tools outside `tools` are not loaded at all, which keeps
 * tool schemas out of the context. In print mode Claude Code denies anything not allowed
 * instead of prompting, and reports the denial in the result.
 */
export function workerTools(
  role: Role, mode: WorkerMode, allowedCommands: readonly string[], codegraph = false
): { tools: string[]; allowed: string[] } {
  const reads = [...readTools, ...gitRead, ...(codegraph ? codegraphRead : [])];
  // Lead plans and answers questions with read-only access, so it can check files instead of guessing.
  if (mode === 'plan' || mode === 'ask' || mode === 'gate' || role === 'Lead' || role === 'Review') {
    return { tools: [...readTools, 'Bash'], allowed: reads };
  }
  // "*" lets Implement and Tests run any shell command without asking.
  const commands = allowedCommands.includes('*') ? ['Bash'] : allowedCommands.map(command => `Bash(${command}:*)`);
  return {
    tools: [...readTools, 'Edit', 'Write', 'Bash'],
    allowed: [...reads, 'Edit', 'Write', ...commands]
  };
}

export function validCommand(command: unknown): command is string {
  return command === '*' || typeof command === 'string' && /^[\w./@:+=-]+(?: [\w./@:+=-]+)*$/.test(command) && command.length <= 120;
}

/** The MCP servers a run starts: none for AI gates, which judge the work only from what they are given. */
export function runMcp(mode: WorkerMode, settings: WorkerSettings): WorkerMcp | undefined {
  return mode !== 'gate' && settings.mcp && Object.keys(settings.mcp.servers).length ? settings.mcp : undefined;
}

/** Files a run reads at start: the system text, and the MCP servers when the run has any. */
export interface WorkerFiles {
  system: string;
  mcp?: string;
}

/**
 * Claude Code arguments for one run. The prompt is not among them: it is written to the CLI's standard input, and
 * the system text is read from `files.system`, so neither is ever parsed by a shell. `--strict-mcp-config` always
 * applies, so the user's and the project's own MCP servers are not loaded; only the servers in `files.mcp` start,
 * and only their listed tools are allowed.
 */
export function workerArguments(request: Omit<WorkerRequest, 'executable' | 'profile' | 'cwd' | 'signal'>, files: WorkerFiles): string[] {
  const { role, mode, settings, resume, persist } = request;
  const { tools, allowed } = workerTools(role, mode, settings.allowedCommands.filter(validCommand), settings.codegraph);
  const mcp = files.mcp ? runMcp(mode, settings) : undefined;
  if (mcp) allowed.push(...mcp.allowed);
  const args = [
    '-p',
    '--output-format', 'stream-json', '--verbose',
    '--json-schema', JSON.stringify(mode === 'plan' ? planSchema : mode === 'gate' ? gateSchema : reportSchema),
    '--append-system-prompt-file', files.system,
    '--tools', tools.join(','),
    '--permission-mode', 'default',
    '--strict-mcp-config'
  ];
  if (mcp) args.push('--mcp-config', files.mcp!);
  if (allowed.length) args.push('--allowedTools', allowed.join(','));
  if (settings.denyRead?.length) args.push('--disallowedTools', envDenyRules(settings.denyRead).join(','));
  if (settings.budgetUsd > 0) args.push('--max-budget-usd', String(settings.budgetUsd));
  if (settings.model) args.push('--model', settings.model);
  if (resume) args.push('--resume', resume);
  if (mode !== 'work' && !persist) args.push('--no-session-persistence');
  return args;
}

/**
 * How to start the CLI. On Windows a `.cmd` install only runs through cmd.exe, which reads the whole command line
 * again: `&`, `|`, `<`, `>` and `^` start or redirect commands, `%NAME%` expands, and a line break ends the command.
 * An argument holding any of them is refused rather than handed to cmd.exe.
 */
export function launch(
  executable: string, args: readonly string[], platform: NodeJS.Platform = process.platform, comSpec: string | undefined = process.env.ComSpec
): { command: string; args: string[] } {
  if (platform !== 'win32' || !/\.cmd$/i.test(executable)) return { command: executable, args: [...args] };
  const unsafe = [executable, ...args].find(value => /[%&|<>^\r\n]/.test(value));
  if (unsafe !== undefined) {
    throw new Error(`Claude Code is installed as a .cmd script, and Windows cannot pass this value to it safely: ${unsafe.slice(0, 80)}. `
      + 'Set xdevAi.claudeExecutable to a claude.exe instead.');
  }
  return { command: comSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', executable, ...args] };
}

/**
 * Arguments for an interactive Claude Code terminal that works on one step. The system text is read from
 * `systemFile`. Through cmd.exe (`script`) the task cannot be an argument either, so it joins the file and a
 * fixed sentence starts the session. Returns the arguments and the text to write to `systemFile`.
 */
export function terminalArguments(step: { system: string; prompt: string }, systemFile: string, script: boolean): { args: string[]; system: string } {
  return script
    ? { args: ['--append-system-prompt-file', systemFile, 'Start the task described in your instructions.'], system: `${step.system}\n\nYour task:\n${step.prompt}` }
    : { args: ['--append-system-prompt-file', systemFile, step.prompt], system: step.system };
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

const activityText = 160;

function shortPath(value: unknown, cwd: string): string {
  if (typeof value !== 'string') return '';
  const path = isAbsolute(value) ? relative(cwd, value) : value;
  return (path.startsWith('..') ? value : path || '.').slice(-activityText);
}

/** Describes one tool call from the stream for the live activity feed. */
export function describeTool(name: unknown, input: unknown, cwd: string): WorkerActivity | undefined {
  if (typeof name !== 'string' || name === 'StructuredOutput') return undefined;
  const args = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  switch (name) {
    case 'Read': return { kind: 'read', text: shortPath(args.file_path, cwd) };
    case 'Edit': case 'MultiEdit': case 'Write': case 'NotebookEdit':
      return { kind: 'edit', text: shortPath(args.file_path ?? args.notebook_path, cwd) };
    case 'Glob': case 'Grep': {
      const pattern = typeof args.pattern === 'string' ? args.pattern : '';
      const where = typeof args.path === 'string' ? ` in ${shortPath(args.path, cwd)}` : '';
      return { kind: 'search', text: `${pattern}${where}`.slice(0, activityText) };
    }
    case 'Bash': {
      const command = typeof args.command === 'string' ? args.command.replace(/\s+/g, ' ').trim() : '';
      return { kind: 'run', text: command.slice(0, activityText) };
    }
    default: {
      const mcp = /^mcp__([^_].*?)__(.+)$/.exec(name);
      return { kind: 'tool', text: (mcp ? `${mcp[1]} · ${mcp[2]}` : name).slice(0, 80) };
    }
  }
}

/**
 * Reads tool calls from one stream-json event. `calls` remembers each call by id so a tool result that
 * failed or was denied can be reported against the call it belongs to.
 */
export function streamActivities(event: unknown, cwd: string, calls = new Map<string, WorkerActivity>()): WorkerActivity[] {
  const message = event as { type?: unknown; message?: { content?: unknown } };
  if (!Array.isArray(message?.message?.content)) return [];
  if (message.type === 'assistant') {
    return message.message.content.flatMap(block => {
      const item = block as { type?: unknown; id?: unknown; name?: unknown; input?: unknown };
      const activity = item?.type === 'tool_use' ? describeTool(item.name, item.input, cwd) : undefined;
      if (activity && typeof item.id === 'string') calls.set(item.id, activity);
      return activity ? [activity] : [];
    });
  }
  if (message.type !== 'user') return [];
  return message.message.content.flatMap(block => {
    const item = block as { type?: unknown; tool_use_id?: unknown; is_error?: unknown; content?: unknown };
    if (item?.type !== 'tool_result' || item.is_error !== true || typeof item.tool_use_id !== 'string') return [];
    const call = calls.get(item.tool_use_id);
    if (!call) return [];
    const detail = typeof item.content === 'string' ? item.content : JSON.stringify(item.content ?? '');
    const denied = /permission|not allowed|denied|haven't granted|requires approval/i.test(detail);
    return [{ kind: denied ? 'denied' : 'failed', text: call.text } satisfies WorkerActivity];
  });
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
      brief: typeof task?.brief === 'string' ? task.brief : '',
      ...(typeof task?.repo === 'string' && task.repo.trim() ? { repo: task.repo.trim() } : {})
    })),
    costUsd: typeof message.total_cost_usd === 'number' ? message.total_cost_usd : 0,
    ...(typeof message.session_id === 'string' ? { sessionId: message.session_id } : {})
  };
}

export function parseGateOutput(stdout: string): { verdict: 'pass' | 'changes'; reason: string; costUsd: number } {
  const message = readResult(stdout);
  const error = failure(message);
  if (error) throw new Error(error);
  const gate = (message.structured_output ?? {}) as Record<string, unknown>;
  if ((gate.verdict !== 'pass' && gate.verdict !== 'changes') || typeof gate.reason !== 'string') {
    throw new Error('The reviewer did not return a verdict.');
  }
  return { verdict: gate.verdict, reason: gate.reason.trim().slice(0, 1_000), costUsd: typeof message.total_cost_usd === 'number' ? message.total_cost_usd : 0 };
}

/**
 * Runs Claude Code once in print mode under the given terminal profile. Events stream as JSON lines:
 * tool calls feed `onActivity`, and the final result line is returned for the parse functions.
 */
export function runClaude(request: WorkerRequest, spawn: Spawn = spawnProcess): Promise<string> {
  const { executable, profile, cwd, settings, signal } = request;
  if (profile.provider !== 'claude') return Promise.reject(new Error('Headless workers need a Claude Code terminal account.'));
  signal?.throwIfAborted();
  // The system text and the server definitions (which may hold tokens) go in private files, and the prompt goes
  // to standard input, so none of them is on the command line.
  const mcp = runMcp(request.mode, settings);
  const folder = mkdtempSync(join(tmpdir(), 'xdev-squad-run-'));
  const cleanup = () => rmSync(folder, { recursive: true, force: true });
  return new Promise<string>((resolve, reject) => {
    const files: WorkerFiles = { system: join(folder, 'system.md'), ...(mcp ? { mcp: join(folder, 'mcp.json') } : {}) };
    writeFileSync(files.system, request.system, { mode: 0o600 });
    if (files.mcp) writeFileSync(files.mcp, JSON.stringify({ mcpServers: mcp!.servers }), { mode: 0o600 });
    const start = launch(executable, workerArguments(request, files));
    const child = spawn(start.command, start.args, {
      cwd, env: workerEnvironment(profile, { ...process.env, ...settings.env }), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
    });
    // A CLI that exits before reading its input closes the pipe; the close handler reports that failure.
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(request.prompt);
    let buffer = '';
    let result = '';
    let stderr = '';
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(result);
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
    const calls = new Map<string, WorkerActivity>();
    const line = (text: string) => {
      const trimmed = text.trim();
      if (!trimmed.startsWith('{')) return;
      let event: { type?: unknown };
      try {
        event = JSON.parse(trimmed) as { type?: unknown };
      } catch {
        return;
      }
      if (event.type === 'result') result = trimmed;
      else if (request.onActivity) {
        for (const activity of streamActivities(event, cwd, calls)) {
          try {
            request.onActivity(activity);
          } catch {
            // The activity feed is informational; never let it break the run.
          }
        }
      }
    };
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const text of lines) line(text);
      if (buffer.length > outputLimit) {
        stop();
        finish(new Error('The worker output was too large.'));
      }
    });
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-2_000);
    });
    child.on('error', error => finish(new Error(`Could not start Claude Code: ${error.message}`)));
    child.on('close', code => {
      line(buffer);
      buffer = '';
      if (code === 0 || result) return finish();
      const detail = stderr.trim().split('\n').at(-1)?.slice(0, 300);
      finish(new Error(`Claude Code exited with code ${code}${detail ? `: ${detail}` : ''}. Sign in to the terminal account again if its session expired.`));
    });
  }).finally(cleanup);
}
