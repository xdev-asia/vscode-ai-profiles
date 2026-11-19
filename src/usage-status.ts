import * as vscode from 'vscode';
import { readAccountUsage, readClaudeQuota, type AccountUsage, type UsageWindow } from './account-usage';
import { terminalProfileId, terminalProviders, type TerminalProfile, type TerminalProfiles } from './terminal-profiles';

const refreshCommand = 'xdevAi.refreshUsage';
const usageCommand = 'xdevAi.checkUsage';
const refreshInterval = 5 * 60_000;
const signInRefreshInterval = 30_000;

function commandLink(title: string, command: string, args: readonly string[] = []): string {
  const query = args.length ? `?${encodeURIComponent(JSON.stringify(args))}` : '';
  return `[${title}](command:${command}${query})`;
}

function appendWindow(tip: vscode.MarkdownString, window: UsageWindow): void {
  const filled = Math.round(Math.min(100, window.used) / 10);
  const percent = Number(window.used.toFixed(1));
  tip.appendText(`${window.label} · ${percent}% used`);
  if (window.resetsAt) tip.appendText(` · Resets ${new Date(window.resetsAt).toLocaleString()}`);
  tip.appendMarkdown(`  \n\`${'█'.repeat(filled)}${'░'.repeat(10 - filled)}\`  \n`);
}

export function registerUsageStatus(
  context: vscode.ExtensionContext,
  status: vscode.StatusBarItem,
  profiles: TerminalProfiles,
  onProfilesChanged: vscode.Event<void>
): void {
  const controller = new AbortController();
  const cache = new Map<string, { checkedAt: number; usage: AccountUsage }>();
  let running = false;
  let pending = false;
  let forceNext = false;

  async function currentUsage(profile: TerminalProfile): Promise<AccountUsage | undefined> {
    const cached = cache.get(terminalProfileId(profile));
    if (profile.provider !== 'claude') return cached?.usage;
    const sample = await readClaudeQuota(profile.configDir);
    if (cached?.usage.signedOut && (sample.observedAt ?? 0) > cached.checkedAt) return sample;
    return { ...cached?.usage, ...sample };
  }

  function render(accounts: readonly TerminalProfile[], snapshots: Map<string, AccountUsage>, refreshing = false): void {
    const tip = new vscode.MarkdownString('**xDev AI · Account quota**\n\n');
    tip.isTrusted = { enabledCommands: [refreshCommand, usageCommand] };
    if (refreshing) tip.appendMarkdown('_Refreshing…_\n\n');
    if (!accounts.length) tip.appendText('Add a terminal account to see its usage here.');
    for (const profile of accounts) {
      const id = terminalProfileId(profile);
      const provider = terminalProviders[profile.provider];
      const usage = snapshots.get(id);
      tip.appendMarkdown('**');
      tip.appendText(profile.name);
      tip.appendMarkdown('**  \n');
      tip.appendText([provider.name, usage?.plan].filter(Boolean).join(' · '));
      tip.appendMarkdown('  \n');
      const windows = usage?.signedOut ? [] : usage?.windows.filter(window => !window.resetsAt || window.resetsAt > Date.now());
      if (windows?.length) {
        for (const window of windows) appendWindow(tip, window);
        if (usage?.observedAt) {
          tip.appendText(`Updated ${new Date(usage.observedAt).toLocaleString()}`);
          tip.appendMarkdown('  \n');
        }
      } else {
        tip.appendText(usage?.signedOut ? 'Sign-in required' : refreshing && !usage && profile.provider !== 'gemini' ? 'Checking quota…' :
          profile.provider === 'claude' && !usage?.unavailable && vscode.workspace.isTrusted ? 'Waiting for a quota sample from Claude Code' : 'Check quota in the terminal');
        tip.appendMarkdown('  \n');
      }
      tip.appendMarkdown(`${commandLink(`Open terminal for ${provider.usage}`, usageCommand, [id])}\n\n`);
    }
    tip.appendMarkdown(`\n\n${commandLink('Refresh quota', refreshCommand)}`);
    status.tooltip = tip;
  }

  async function refresh(force = false): Promise<void> {
    if (controller.signal.aborted) return;
    if (running) {
      pending = true;
      forceNext ||= force;
      return;
    }
    running = true;
    try {
      const accounts = await profiles.list();
      const ids = new Set(accounts.map(terminalProfileId));
      for (const id of cache.keys()) if (!ids.has(id)) cache.delete(id);
      const snapshots = new Map<string, AccountUsage>();
      await Promise.all(accounts.map(async profile => {
        const usage = await currentUsage(profile);
        if (usage) snapshots.set(terminalProfileId(profile), usage);
      }));
      if (controller.signal.aborted) return;
      const trusted = vscode.workspace.isTrusted;
      const due = trusted ? accounts.filter(profile => {
        if (profile.provider === 'gemini') return false;
        const cached = cache.get(terminalProfileId(profile));
        const interval = cached?.usage.signedOut ? signInRefreshInterval : refreshInterval;
        return force || !cached || Date.now() - cached.checkedAt >= interval;
      }) : [];
      render(accounts, snapshots, Boolean(due.length));
      for (const [index, profile] of due.entries()) {
        const id = terminalProfileId(profile);
        const preferred = vscode.workspace.getConfiguration('xdevAi').get<string>(`${profile.provider}Executable`, '').trim();
        const version = context.extension.packageJSON.version as string;
        const next = await readAccountUsage(profile, preferred, version, controller.signal);
        if (controller.signal.aborted) return;
        const previous = snapshots.get(id);
        const usage = next.unavailable && !next.signedOut && previous ? { ...previous, plan: next.plan ?? previous.plan, unavailable: true } : next;
        cache.set(id, { checkedAt: Date.now(), usage });
        const updated = await currentUsage(profile);
        if (updated) snapshots.set(id, updated);
        if (!controller.signal.aborted && !pending) render(accounts, snapshots, index < due.length - 1);
      }
    } catch {
      if (!controller.signal.aborted) status.tooltip = 'xDev AI · Could not read account quota';
    } finally {
      running = false;
      if (pending && !controller.signal.aborted) {
        const force = forceNext;
        pending = false;
        forceNext = false;
        void refresh(force);
      }
    }
  }

  const timer = setInterval(() => {
    if (vscode.window.state.focused && !running) void refresh();
  }, 15_000);
  context.subscriptions.push(
    { dispose() { clearInterval(timer); controller.abort(); } },
    vscode.commands.registerCommand(refreshCommand, () => refresh(true)),
    onProfilesChanged(() => void refresh()),
    vscode.window.onDidChangeWindowState(state => { if (state.focused) void refresh(); }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => void refresh())
  );
  void refresh();
}
