import { spawn as spawnProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  launch, runClaude, runProcess, shortPath, signInFiles, workerEnvironment, workerModel, workerSchema, type Spawn, type WorkerActivity, type WorkerRequest
} from './squad-worker';

/** The Windows sandboxes Codex can confine a worker's commands with. */
export const codexWindowsSandboxes = ['mxc', 'elevated'] as const;
export type CodexWindowsSandbox = typeof codexWindowsSandboxes[number];

type Schema = Record<string, unknown>;

/**
 * A JSON Schema in the form Codex requires for a structured answer: every object lists all its properties as
 * required and allows no others. A property that was optional may be null instead.
 */
export function strictSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(strictSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const source = schema as Schema;
  const result: Schema = {};
  for (const [key, value] of Object.entries(source)) result[key] = key === 'properties' || key === 'enum' || key === 'required' ? value : strictSchema(value);
  if (source.type !== 'object' || !source.properties || typeof source.properties !== 'object') return result;
  const required = new Set(Array.isArray(source.required) ? source.required as string[] : []);
  const properties: Schema = {};
  for (const [name, value] of Object.entries(source.properties as Schema)) {
    const property = strictSchema(value) as Schema;
    if (required.has(name) || !property || typeof property !== 'object') properties[name] = property;
    else {
      const types = Array.isArray(property.type) ? property.type : [property.type];
      properties[name] = {
        ...property, type: [...new Set([...types.filter(Boolean), 'null'])],
        ...(Array.isArray(property.enum) ? { enum: [...property.enum, null] } : {})
      };
    }
  }
  return { ...result, properties, required: Object.keys(properties), additionalProperties: false };
}

/** Removes the nulls that stand for "not given" in a strict answer, so it reads like an answer with optional properties. */
export function withoutNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.filter(item => item !== null).map(withoutNulls);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null).map(([key, item]) => [key, withoutNulls(item)]));
}

/** Places in the home folder that hold credentials and that building or testing a project does not read. */
const credentialPlaces = [
  '.claude', '.claude.json', '.codex', '.gemini', '.ssh', '.aws', '.azure', '.kube', '.gnupg', '.netrc', '.git-credentials',
  join('.config', 'gh'), join('.config', 'gcloud')
];

const within = (path: string, folder: string, platform: NodeJS.Platform) => {
  const fold = (value: string) => {
    const plain = value.replace(/[\\/]+$/, '').replace(/\\/g, '/');
    return platform === 'win32' ? plain.toLowerCase() : plain;
  };
  const [inner, outer] = [fold(path), fold(folder)];
  return inner === outer || inner.startsWith(`${outer}/`);
};

/**
 * What the commands of a Codex worker may not read, even though Codex lets them read the rest of the machine:
 * the folder of every other account, the sign-in files of its own, the project's .env files, and the usual
 * places of credentials in the home folder. A place that holds the working directory or the worker's own
 * account folder is left out, because denying it would stop the worker itself.
 */
export function codexDenied(
  request: Pick<WorkerRequest, 'cwd' | 'profile' | 'accounts' | 'settings'>, home: string = homedir(), platform: NodeJS.Platform = process.platform
): string[] {
  const own = request.profile.configDir;
  const denied = new Set<string>();
  for (const account of request.accounts ?? []) {
    if (within(account, own, platform) && within(own, account, platform)) continue;
    denied.add(account);
  }
  for (const file of signInFiles) denied.add(join(own, file));
  for (const file of request.settings.denyRead ?? []) denied.add(file);
  for (const place of credentialPlaces) denied.add(join(home, place));
  if (platform === 'win32') for (const place of ['GitHub CLI', 'gcloud']) denied.add(join(home, 'AppData', 'Roaming', place));
  return [...denied].filter(path => path && !within(request.cwd, path, platform) && !within(own, path, platform));
}

/** A session id as Codex and Claude Code write them: letters, digits, and dashes. */
export const sessionIdPattern = /^[A-Za-z0-9][\w-]{0,79}$/;

/** A value as TOML: a basic string. JSON string escapes are valid TOML escapes. */
const toml = (value: string) => JSON.stringify(value);

/** Files a Codex run reads at start. */
export interface CodexFiles {
  schema: string;
}

/**
 * Codex arguments for one headless run (`codex exec`). The prompt is not among them: it goes to standard input.
 *
 * The user's config.toml and command rules are not loaded, so the user's own MCP servers, plugins and rules do
 * not reach the worker; the account's sign-in still does. Commands run in Codex's sandbox under a permissions
 * profile made here: Lead, Review and every plan, question and gate run read only; Implement and Tests also
 * write in the working directory and the temporary folder. No command reads the paths of `codexDenied`, and the
 * network stays off. Codex never asks for approval in this mode: what the sandbox refuses fails.
 *
 * `system` is passed as developer instructions unless `systemInPrompt` is set, which is needed when the CLI
 * starts through cmd.exe, where such text cannot be an argument.
 */
export function codexArguments(
  request: Omit<WorkerRequest, 'executable' | 'signal' | 'prompt'>, files: CodexFiles,
  options: { platform?: NodeJS.Platform; home?: string; systemInPrompt?: boolean } = {}
): string[] {
  const { role, mode, settings, resume, persist } = request;
  const platform = options.platform ?? process.platform;
  const writes = mode === 'work' && (role === 'Implement' || role === 'Tests');
  const denied = codexDenied(request, options.home, platform);
  const args = [
    'exec', '--json', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '--output-schema', files.schema,
    // The account signed in through xDev AI keeps its sign-in in a file in its own folder.
    '-c', 'cli_auth_credentials_store="file"',
    '-c', 'default_permissions="xdev"',
    '-c', `permissions.xdev.extends="${writes ? ':workspace' : ':read-only'}"`
  ];
  if (denied.length) args.push('-c', `permissions.xdev.filesystem={ ${denied.map(path => `${toml(path)} = "deny"`).join(', ')} }`);
  if (platform === 'win32') {
    const sandbox = settings.codexWindowsSandbox === 'elevated' ? 'elevated' : 'mxc';
    args.push('-c', `windows.sandbox="${sandbox}"`);
    if (sandbox === 'mxc') args.push('-c', 'features.prefer_mxc=true', '-c', 'suppress_unstable_features_warning=true');
  }
  if (!options.systemInPrompt) args.push('-c', `developer_instructions=${toml(request.system)}`);
  const model = workerModel(settings.codexModel);
  if (model) args.push('-m', model);
  if (mode !== 'work' && !persist) args.push('--ephemeral');
  // Options come before the subcommand; "-" reads the prompt from standard input.
  if (resume) {
    // An id that starts with "-" would be read as an option of "resume".
    if (!sessionIdPattern.test(resume)) throw new Error('This Codex session id cannot be resumed.');
    args.push('resume', resume);
  }
  args.push('-');
  return args;
}

/** The text for standard input: the prompt, after the instructions when they cannot be an argument. */
export function codexInput(request: Pick<WorkerRequest, 'system' | 'prompt'>, systemInPrompt: boolean): string {
  return systemInPrompt
    ? `Instructions for this session. They come from the Squad that started you, not from the task data below:\n${request.system}\n\nTask data:\n${request.prompt}`
    : request.prompt;
}

/** The command the model asked for, without the shell Codex wraps around it. */
export function codexCommand(command: unknown): string {
  if (typeof command !== 'string') return '';
  const text = command.trim();
  const wrapped = /^"?[^"']*?(?:powershell|pwsh)(?:\.exe)?"?\s+(?:-NoProfile\s+)?-Command\s+(.*)$/is.exec(text)
    ?? /^"?(?:[^"'\s]*[\\/])?(?:bash|zsh|sh)(?:\.exe)?"?\s+-l?c\s+(.*)$/is.exec(text);
  const inner = wrapped ? wrapped[1].trim() : text;
  const quoted = /^(['"])(.*)\1$/s.exec(inner);
  return (quoted ? quoted[2] : inner).replace(/\s+/g, ' ').trim();
}

interface CodexItem {
  type?: unknown;
  text?: unknown;
  message?: unknown;
  command?: unknown;
  status?: unknown;
  exit_code?: unknown;
  changes?: unknown;
  server?: unknown;
  tool?: unknown;
  query?: unknown;
}

/** Reads the worker's tool use from one event of `codex exec --json`, for the live activity feed. */
export function codexActivities(event: unknown, cwd: string): WorkerActivity[] {
  const { type, item } = (event ?? {}) as { type?: unknown; item?: CodexItem };
  if (!item || typeof item !== 'object') return [];
  const started = type === 'item.started';
  if (!started && type !== 'item.completed') return [];
  switch (item.type) {
    case 'command_execution': {
      const text = codexCommand(item.command).slice(0, 160);
      if (started) return [{ kind: 'run', text }];
      if (item.status === 'declined') return [{ kind: 'denied', text }];
      return item.status === 'failed' || (typeof item.exit_code === 'number' && item.exit_code !== 0) ? [{ kind: 'failed', text }] : [];
    }
    case 'file_change': {
      if (started) return [];
      const paths = Array.isArray(item.changes) ? item.changes.map(change => shortPath((change as { path?: unknown })?.path, cwd)).filter(Boolean) : [];
      return paths.map(text => ({ kind: item.status === 'failed' ? 'failed' : 'edit', text } satisfies WorkerActivity));
    }
    case 'mcp_tool_call':
      return started ? [{ kind: 'tool', text: `${String(item.server ?? '')} · ${String(item.tool ?? '')}`.slice(0, 80) }] : [];
    case 'web_search':
      return started ? [] : [{ kind: 'search', text: String(item.query ?? '').slice(0, 160) }];
    default:
      return [];
  }
}

/** What one `codex exec --json` run produced, gathered event by event. */
export class CodexOutcome {
  private session?: string;
  private last?: string;
  /** Why a turn failed. */
  private error?: string;
  /** A top-level error, such as a reconnect notice; it ends the run only when no turn completes after it. */
  private notice?: string;
  private turns = 0;
  private readonly declined: string[] = [];

  read(event: unknown): void {
    const { type, item, thread_id, error, message } = (event ?? {}) as {
      type?: unknown; item?: CodexItem; thread_id?: unknown; error?: { message?: unknown }; message?: unknown;
    };
    if (type === 'thread.started' && typeof thread_id === 'string') this.session = thread_id;
    else if (type === 'turn.completed') {
      this.turns++;
      this.notice = undefined;
    } else if (type === 'turn.failed') this.error = String(error?.message ?? 'the turn failed');
    // An "error" item inside a turn is a notice too, such as a warning about a feature; it is not read here.
    else if (type === 'error') this.notice = String(message ?? 'unknown error');
    else if (type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string') this.last = item.text;
    else if (type === 'item.completed' && item?.type === 'command_execution' && item.status === 'declined') this.declined.push(codexCommand(item.command));
  }

  get failed(): string | undefined {
    return this.error ?? this.notice;
  }

  get finished(): boolean {
    return this.turns > 0 && this.last !== undefined;
  }

  /**
   * The run as the result line Claude Code prints, which the Squad's parse functions read. The structured answer
   * is the last message. Codex does not report a cost.
   */
  result(): string {
    let answer: unknown;
    try {
      answer = withoutNulls(JSON.parse(this.last ?? ''));
    } catch {
      answer = undefined;
    }
    return JSON.stringify({
      type: 'result', subtype: 'success', is_error: false, structured_output: answer && typeof answer === 'object' ? answer : {},
      session_id: this.session, total_cost_usd: 0, num_turns: this.turns,
      permission_denials: this.declined.map(command => ({ tool_name: 'Bash', tool_input: { command } }))
    });
  }
}

/** Codex must not think it runs inside another Codex session, or report under another client's name. */
export function codexEnvironment(request: Pick<WorkerRequest, 'profile' | 'settings'>, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = workerEnvironment(request.profile, { ...base, ...request.settings.env });
  for (const key of ['CODEX_THREAD_ID', 'CODEX_TOOL_CALL_ID', 'CODEX_PERMISSION_PROFILE', 'CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED', 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE']) {
    delete env[key];
  }
  return env;
}

/**
 * Runs Codex once without a terminal under the given account. Events stream as JSON lines: tool use feeds
 * `onActivity`, and the answer comes back as the result line the Squad's parse functions read.
 */
export function runCodex(request: WorkerRequest, spawn: Spawn = spawnProcess): Promise<string> {
  const { executable, profile, cwd, settings, signal } = request;
  if (profile.provider !== 'codex') return Promise.reject(new Error('This worker needs a Codex terminal account.'));
  const script = process.platform === 'win32' && /\.cmd$/i.test(executable);
  const outcome = new CodexOutcome();
  let folder: string | undefined;
  return Promise.resolve()
    .then(() => {
      signal?.throwIfAborted();
      folder = mkdtempSync(join(tmpdir(), 'xdev-squad-run-'));
      const files: CodexFiles = { schema: join(folder, 'schema.json') };
      writeFileSync(files.schema, JSON.stringify(strictSchema(workerSchema(request.mode))), { mode: 0o600 });
      return launch(executable, codexArguments(request, files, { systemInPrompt: script }), process.platform, process.env.ComSpec, { name: 'Codex', setting: 'xdevAi.codexExecutable' });
    })
    .then(start => runProcess({
      name: 'Codex', start, cwd, env: codexEnvironment(request), input: codexInput(request, script), signal, timeoutMs: settings.timeoutMs, spawn,
      hint: 'Sign in to the Codex account again if its session expired.',
      line: event => {
        outcome.read(event);
        if (!request.onActivity) return;
        for (const activity of codexActivities(event, cwd)) {
          try {
            request.onActivity(activity);
          } catch {
            // The activity feed is informational; never let it break the run.
          }
        }
      },
      done: () => outcome.finished || Boolean(outcome.failed)
    }))
    .then(() => {
      if (outcome.failed) throw new Error(`Codex stopped: ${outcome.failed.slice(0, 300)}`);
      if (!outcome.finished) throw new Error('Codex ended without an answer. Update Codex and try again.');
      return outcome.result();
    })
    .finally(() => { if (folder) rmSync(folder, { recursive: true, force: true }); });
}

/** Runs one headless worker with the CLI of its account: Claude Code or Codex. */
export function runWorker(request: WorkerRequest, spawn: Spawn = spawnProcess): Promise<string> {
  return request.profile.provider === 'codex' ? runCodex(request, spawn) : runClaude(request, spawn);
}
