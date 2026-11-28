// Runs the extension in a real VS Code window with its own profile and a throwaway folder, then drives it
// from the extension host (suite.cjs or suite-busy.cjs). Build first: `npm run build`.
//
//   node e2e/run.cjs          the main suite
//   node e2e/run.cjs busy     the fixed MCP port is held by another program
const { execFileSync } = require('node:child_process');
const { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } = require('node:fs');
const { createServer } = require('node:net');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { runTests } = require('@vscode/test-electron');

const root = join(__dirname, '..');
const busy = process.argv[2] === 'busy';

// A window started from a VS Code terminal or a Claude Code session must not inherit either.
for (const key of Object.keys(process.env)) if (/^(VSCODE_|ELECTRON_|CLAUDE|ANTHROPIC)/i.test(key)) delete process.env[key];

(async () => {
  const work = realpathSync.native(mkdtempSync(join(tmpdir(), 'xdev-e2e-')));
  const userData = join(work, 'user-data');
  const folder = join(work, 'project');
  for (const directory of [join(userData, 'User'), folder, join(work, 'extensions')]) mkdirSync(directory, { recursive: true });

  const git = (...args) => execFileSync('git', args, { cwd: folder, stdio: 'ignore' });
  git('init', '-b', 'main');
  writeFileSync(join(folder, 'README.md'), '# Trial\n');
  writeFileSync(join(folder, '.mcp.json'), JSON.stringify({ mcpServers: { docs: { type: 'http', url: 'https://mcp.example.com/mcp' } } }, null, 2));
  git('add', '.');
  git('-c', 'user.name=xDev e2e', '-c', 'user.email=e2e@example.invalid', 'commit', '-m', 'Initial commit');

  // Stands in for Claude Code (fake-claude.cjs), so the suite needs no AI account: terminals open, and headless
  // steps create the file their task names.
  const windows = process.platform === 'win32';
  const claude = join(work, windows ? 'claude.cmd' : 'claude');
  const fake = join(__dirname, 'fake-claude.cjs');
  writeFileSync(claude, windows ? `@echo off\r\nnode "${fake}" %*\r\n` : `#!/bin/sh\nexec node "${fake}" "$@"\n`);
  if (!windows) chmodSync(claude, 0o755);

  const holder = busy ? createServer().listen(0, '127.0.0.1') : undefined;
  if (holder) await new Promise(resolve => holder.once('listening', resolve));
  const busyPort = holder?.address().port;
  writeFileSync(join(userData, 'User', 'settings.json'), JSON.stringify({
    ...(busy ? { 'xdevAi.mcp.port': busyPort, 'xdevAi.mcp.autoStart': true } : {}),
    'xdevAi.claudeExecutable': claude,
    'security.workspace.trust.enabled': false, 'telemetry.telemetryLevel': 'off', 'update.mode': 'none',
    'extensions.autoUpdate': false, 'extensions.autoCheckUpdates': false, 'workbench.startupEditor': 'none', 'workbench.tips.enabled': false
  }));

  const { TerminalProfiles, terminalProfileId } = require(join(root, 'dist', 'terminal-profiles.js'));
  const profile = await new TerminalProfiles(join(userData, 'User', 'globalStorage', 'xdev-asia.xdev-ai')).add('claude', 'e2e-worker');

  let failed = false;
  try {
    await runTests({
      extensionDevelopmentPath: root,
      extensionTestsPath: join(__dirname, busy ? 'suite-busy.cjs' : 'suite.cjs'),
      launchArgs: [
        folder, `--user-data-dir=${userData}`, `--extensions-dir=${join(work, 'extensions')}`,
        '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-updates', '--disable-gpu'
      ],
      extensionTestsEnv: {
        XDEV_E2E_ROOT: root, XDEV_E2E_ACCOUNT: terminalProfileId(profile),
        ...(busy ? { XDEV_E2E_BUSY_PORT: String(busyPort) } : {})
      }
    });
  } catch (error) {
    failed = true;
    console.error(String(error?.message ?? error));
  } finally {
    holder?.close();
    // VS Code's helper processes hold files for some seconds after the window closes.
    for (let attempt = 1; ; attempt++) {
      try {
        rmSync(work, { recursive: true, force: true });
        break;
      } catch {
        if (attempt === 30) {
          console.warn(`Could not remove ${work}; delete it by hand.`);
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 1_000));
      }
    }
  }
  process.exit(failed ? 1 : 0);
})();
