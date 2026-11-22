# Changelog

## 0.12.0 - 2026-11-22

### Added

- Project `.env` files for workers: `xdevAi.squad.workerEnvFiles` lists, per repository, the `.env` files whose variables Implement and Tests get when they run commands. Squad reads them from your checkout when a step starts and sets them in the worker's environment. Values are never copied into the worktree, put in a prompt, or shown; the worker is told only the variable names. No role may read these files (Claude Code deny rules; verified for Read and Grep). Variables that would change the worker itself (`ANTHROPIC_*`, `CLAUDE_*`, `PATH`, …) are skipped.
- **Deploy** on a pushed run, for repositories in `xdevAi.squad.deployTargets` (`from`, `to`, `health`). Squad fetches the branches, shows how many commits would deploy and whether the run's merge request is merged, and after you confirm opens a GitLab merge request from → to with push options. Merging it, which starts the pipeline, stays with you. **Check health** calls the health address and shows the status on the run.
- The Project tab lists each `.env` file with its variable names (never values) and each deploy target.
- `xdevAi.squad.repositoryBaseBranches`: a base branch per repository, for workspaces that mix repositories whose main line differs (`dev` in some, `main` in others). Merge requests from such a repository target its own base branch.

### Changed

- A repository without the configured base branch now starts from its remote's default branch, and the run says so, instead of failing.
- **Push & MR** uses each repository's own target when they differ, and shows them before pushing. The configured `mergeRequestTarget` applies only where the remote has that branch.

## 0.11.0 - 2026-11-22

### Added

- MCP servers for workers, per project: `xdevAi.squad.mcpServers` grants a server (from the project's `.mcp.json`, or defined in the setting) to chosen roles, with the tools workers may call. Other tools of the server are denied, your own MCP servers are still never loaded, AI reviews get none, and server definitions reach Claude Code through a private file that is deleted after the run. Ignored in untrusted workspaces.
- **Project** tab in Squad: this project's settings and where each comes from (project or user settings), the workers' MCP servers (**Add server**, **Remove**), and storage: free disk, size of each run's worktrees, unused worktree folders, worker transcripts, and Squad state. **Clean up…** deletes what you pick. Command: **xDev AI: Open Squad Project Settings and Storage**.
- Automatic cleanup: a run whose work is merged or pushed (with nothing committed since) is removed after `xdevAi.squad.cleanupAfterDays` (7; `0` turns it off), with its worktrees, local branches, and worker transcripts. Pushed branches stay on the remote.
- `xdevAi.squad.minFreeDiskGb` (2): Squad refuses to create worktrees or start a worker step when the disk is fuller than that.

### Fixed

- Squad keeps 10 runs per project. Before, the 11th run dropped the oldest from the list but left its worktrees on disk. Now the oldest run makes room only when its work is merged or pushed; otherwise Squad asks you to push, merge, or remove a run first.
- Removing a run also deletes the Claude Code transcripts its workers left in each account.
- MCP tool calls show as `server · tool` in the live activity feed.

## 0.10.1 - 2026-11-22

### Added

- `xdevAi.squad.baseBranch`: start new worktrees from a branch such as `origin/dev` (fetched first) instead of your checkout's branch, so a merge request carries only the run's own commits.
- New worktrees initialize submodules and link `node_modules` from your checkout (`xdevAi.squad.worktreeLinks`), so builds and tests work without reinstalling. Linked paths are never committed.

## 0.10.0 - 2026-11-22

### Added

- One run can span several repositories. Lead gives each task a repository (a backend API and the screen that calls it get one Implement task each), and you can change the repository per task before approving. Each repository gets its own worktree on the same branch name; later steps see what earlier steps did in other repositories.
- **Push & MR** on a finished run: pushes the branch of every committed repository after you confirm the target branch, and on GitLab opens or updates a merge request with git push options, without an API token. The run keeps the link (**Open MR**). Settings: `xdevAi.squad.mergeRequests`, `xdevAi.squad.mergeRequestTarget`.
- **Request changes** under a run's changes: write feedback (use **Comment** on a file to start a line) and Implement gets it as a new step in the same worktree. A finished run reopens; its next commit lands on the same branch.
- Run metrics: time and cost per step, retries, time to commit per run, and a 30-day summary above Worker runs (runs, median time to commit, share of steps that passed first time, files, cost).
- **Use for all roles** on the Roles tab, and a one-click button on a fresh workspace to give every role the same account.
- Per-repository allowed commands: `xdevAi.squad.repositoryAllowedCommands`.
- `xdevAi.squad.codegraphTimeoutSeconds` for large CodeGraph indexes.

### Changed

- Squad roles, runs, memory, and skills are shared by every VS Code window that opens the workspace, including code-server windows in different browsers: they live in a file in the extension's global storage. A window sees another window's running step within a second, waits for it, and recovers if that window closes. State saved per window by older versions is read until the first change.
- A Claude Code Lead may read the repository (read-only) to answer questions and make briefs concrete.
- Workers receive their allowed commands and are told to run each one on its own. Claude Code denies compound commands such as `node --test 2>&1; echo $?` even when each part is allowed.
- New worktrees live in the extension's global storage, so any window can open or remove them.
- Lead keeps its reply to a short summary.
- Notices appear near the top of the panel and no longer cover buttons.
- A long line in a patch scrolls inside the patch instead of widening the panel.
- A step's first-pass count only includes commands the allowed list blocked, not commands that ran and failed.
- A webview test renders the real panel in jsdom.

## 0.9.0 - 2026-11-22

### Added

- Team board at the top of Squad Chat: each role's account and live state, with the working role highlighted.
- Live activity while a headless step runs: files read and edited, commands run, counts, and a timer. A notice appears when a step ends.
- Review a run's changes inside the panel: changed files with added and removed lines, a colored patch, **Open diff** in the editor, and **Discard** for one file.
- Workspaces with several git repositories: choose the repository for a run when approving its plan. xDev suggests the one the plan names.
- When the workspace has a CodeGraph index, Lead plans with an excerpt of the relevant code, and workers may query it. Setting: `xdevAi.squad.codegraph`.
- Review and Tests receive the run's changed files, and Tests runs only the tests that cover them.
- **xDev AI: Clean Up Squad Worktrees** (also in the Squad view menu) lists Squad worktrees that no run in this window tracks, such as runs from another window. You pick which to remove; a branch is deleted only when it is merged.
- The live feed marks commands that were blocked by the allowed list or failed.

### Changed

- Headless workers stream their progress (`--output-format stream-json`).
- When CodeGraph does not answer within 20 seconds, Squad plans without it for 10 minutes instead of waiting on every message.
- Long task briefs in a plan are collapsed to three lines; click one to read it all.

## 0.8.0 - 2026-11-22

### Added

- Assign a Claude Code account to a Squad role and control each step of an approved plan yourself: run it headless, open it as an interactive Claude Code session in a terminal, skip it, or finish the run. Steps work in a separate git worktree on a new local branch, and none starts another.
- Review, merge, open, resume in a terminal, or remove each worker run from the Squad chat.
- Squad Memory: shared notes that every agent receives within a fixed budget. Workers add notes after runs.
- Skills now have a **When to use** description and are copied to every Claude Code account as on-demand skills.
- Sync skills and memory with a folder, such as a docs repository clone, using a three-way merge, a local commit, and a confirmed push.
- Choose who approves each Squad step: you, AI review with you starting each step, or AI, where a passing review by Lead's account (never the step's own account) starts the next step. Merging always waits for you.

### Changed

- xDev Squad now opens in the Secondary Side Bar on the right, like Chat, with the message box kept at the bottom. Drag its icon to move it elsewhere. VS Code versions without Secondary Side Bar contributions show it in the Explorer.
- Skills can hold up to 8,000 characters, and a workspace can store up to 40 skills. SDLC drafts include enabled skills within a 12,000-character budget.

## 0.7.1 - 2026-11-19

### Added

- Hover over **xDev AI** in the status bar to see terminal accounts, plan names, quota usage and reset times when available.
- Refresh account quota from the hover or open the selected account's terminal for provider usage details.

## 0.6.1 - 2026-11-19

### Added

- View xDev AI's release history from its Changelog tab in the Extensions view.
- The Squad Release stage now drafts a Markdown changelog entry from approved workflow results for you to review and approve.

## 0.6.0 - 2026-11-19

### Added

- Open a Claude Code, Codex, or Gemini CLI terminal with bypass permissions for a single confirmed session.
- Enable the xDev AI MCP server to inspect the Squad workflow, start a workflow, fetch the current stage brief, submit a draft, request manual approval, and list account aliases.

## 0.5.1 - 2026-11-19

### Fixed

- Keep the Workflow and Skills and Tools commands available if optional Copilot tool registration fails during activation.

## 0.5.0 - 2026-11-19

### Added

- Run a Squad workflow through Plan, Implement, Review, Test, and Release with AI drafts, editable results, and manual approval at each stage.
- Manage workspace skills and control which xDev AI tools Copilot Chat can use.
- Delete terminal accounts and API profiles from the sidebar.

### Fixed

- Keep the original Claude Code terminal open during remote sign-in so you can paste the authorization code or see a login error. Open the signed-in profile in that terminal on success.

## 0.4.0 - 2026-11-19

### Added

- Open the xDev AI sidebar to manage isolated Claude Code, Codex, and Gemini CLI accounts alongside API profiles. Codex supports device-code sign-in on remote hosts.
- Assign API profiles to Squad roles, approve task plans, and follow the results in one shared chat. Use Squad tools from GitHub Copilot Chat.
- Added a custom extension icon.

## 0.3.0 - 2026-11-19

### Added

- Manage and rename Claude Code accounts in the bottom panel. Open a selected account or check its usage from the Terminal toolbar and status bar.

## 0.2.2 - 2026-11-19

### Changed

- Adopted Apache-2.0 and included the license in the VSIX for Open VSX distribution.

## 0.2.1 - 2026-11-19

### Changed

- Moved to the `xdev-asia` publisher. If you installed the `xdev.xdev-ai` preview, switch to `xdev-asia.xdev-ai`, add your API profiles again, and sign in to your Claude Code accounts in the new extension.

## 0.2.0 - 2026-11-19

### Added

- Published the preview for VS Code Desktop, remote workspaces, and code-server with English documentation and release automation.
- Open separate terminals for multiple Claude Code accounts and chat through OpenAI, Anthropic, Gemini, or an OpenAI-compatible API profile.
- Use the TypeScript chat client in Node.js or call xDev AI from another VS Code extension.
