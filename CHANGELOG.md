# Changelog

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
