# Changelog

## 0.24.0 - 2026-11-28

### Added

- **Codex accounts as Squad workers.** A role with a Codex terminal account runs `codex exec` headless in the run's worktree, so Squad can use a ChatGPT subscription next to Claude Code ones: Lead, Implement, Review, Tests, AI review, answering a blocked worker, request changes, and resolving conflicts. An AI client names a Codex account as a task's `account`.
- A Codex worker's commands run in Codex's sandbox: read-only for reading roles, the worktree for Implement and Tests, no network. They cannot read other accounts' folders, the worker's sign-in file, the project's .env files, or the usual credential folders in the home folder.
- Settings `xdevAi.squad.codexModel` and `xdevAi.squad.codexWindowsSandbox`.

### Changed

- A worker is kept out of the folders of every terminal account, also Codex and Gemini CLI ones. Before, only Claude Code account folders were listed.

## 0.23.0 - 2026-11-28

### Added

- **Resolve the conflicts of a run that was left out.** **Resolve conflicts** on a combined run, or `xdev_squad_resolve` for an AI client, adds an Implement step for each run that was left out. The step opens the merge in the combined worktree and the worker resolves the conflicting files. Squad commits the merge only when no conflict marker is left; otherwise it undoes the merge and the run stays left out.

### Changed

- **Stop** ends every process of a worker on Windows, and a stopped or timed-out step is reported once its CLI has ended. Before, a Claude Code installed as a `.cmd` script could keep working after Stop.
- A failed step keeps its reason as its summary, in place of the summary of an earlier attempt.
- Conflicting files with characters outside ASCII are listed by their real names.
- A step that is blocked or failed shows why above its controls. Before, the reason was only in the chat.
- When several runs work at the same time, each live feed names its run.
- The note on a parallel plan mentions combining, and reads correctly when `xdevAi.squad.maxParallelRuns` is 1.

## 0.22.0 - 2026-11-28

### Added

- **Combine parallel runs.** **Combine N runs** on the finished runs of a parallel plan, or `xdev_squad_combine` for an AI client, merges their branches into one new run with its own branch and worktree. A run that conflicts with one merged before it is left out and its conflicting files are named. The combined run has a Review and a Tests step that check the changes together, and you merge or push one branch.

## 0.21.0 - 2026-11-28

### Added

- **Answer a blocked worker.** A worker that lacks a fact reports its question with the blocked status. **Send answer** on the step, or `xdev_squad_answer` for an AI client, sends your answer into the same Claude Code session, so the worker keeps what it had found. If that session is gone, the answer goes out with the whole task.
- **Read a worker's transcript.** **Transcript <role>** on a run opens what the worker was asked, said, and did as a document. An AI client reads it with `xdev_squad_session`.

### Changed

- The account picker says who can still sign in to Gemini CLI. Since 18 June 2026 Google serves it only to paid Gemini API keys, Vertex AI, and Gemini Code Assist Standard or Enterprise; free, AI Pro, and AI Ultra accounts moved to Antigravity CLI, which xDev AI does not manage yet.

## 0.20.1 - 2026-11-28

### Fixed

- **Stop this run** stayed on a run after the other work had ended, and did not appear when a chat request and one run were in flight.
- Two VS Code windows that saved shared artifacts at the same moment could lose one of them. The index is now changed by one window at a time.
- An artifact that another account replaces no longer keeps the link to the first account's claude.ai page, which still shows the old document. The author's own saves keep the link.
- The audit log recorded an account change that you declined in VS Code as made. It now says the change was declined.
- A run that was reopened or started after a plan was approved is not cleaned up to make room for the new run.
- `xdev_squad_wait` without a run id returned at once while another VS Code window was working.

### Changed

- Changes to the SDLC workflow made through MCP (`xdev_workflow_start`, `xdev_workflow_submit_draft`, and the others that write) are written to the audit log.

## 0.20.0 - 2026-11-28

### Added

- **Parallel runs.** Several runs can be open, and up to `xdevAi.squad.maxParallelRuns` of them (3 by default) work at the same time, each in its own worktree and branch and under its own account. A plan marked **parallel** becomes one run per task: `parallel: true` in `xdev_squad_submit_plan`, or `"parallel": true` from Squad's own Lead, which may then give one role several tasks. You review, merge, and push each run on its own.
- For an AI client: `xdev_squad_approve_plan` returns `runs` for a parallel plan, `xdev_squad_wait` returns each time one piece of work ends, `xdev_squad_status` lists `workingRuns`, and `xdev_squad_stop` takes a `runId`.
- The panel shows a live feed for each run that works, locks only that run, and has **Stop this run**. The chat stays usable while steps work.
- `npm run test:host` tests the extension in a real VS Code window; CI runs it on Linux and Windows.

### Changed

- Approving a plan no longer needs the earlier run to be finished, and **Request changes** can reopen a finished run while another run is open.
- A run of a parallel plan names its commit and merge request after its own task.

## 0.19.0 - 2026-11-28

### Security

- **Workers stay in their worktree.** A Claude Code worker could read and write any file your user account can reach, including the sign-in files of the other accounts. A worker now reads only its worktree, your checkout of the same repository, and the shared artifacts, and edits only its worktree. The folder of every other account and the sign-in files of its own are denied by name.
- **A waiting confirmation respects a lowered level.** With confirmations in the AI client, a request such as deleting an account stayed valid for 10 minutes even after you set `xdevAi.mcp.accountControl` below `manage`. It is now refused, and the refusal is in the audit log.
- **`.env` files are denied on Windows.** The rule that keeps workers from reading the files in `xdevAi.squad.workerEnvFiles` did not match Windows paths.
- Workers and Lead are told that notes, summaries, artifacts, and file contents are information and not instructions. `xdev_squad_run`, `xdev_artifacts_list`, and `xdev_artifact_read` say the same to the AI client.

### Fixed

- On Windows, a run failed to commit, and **Changes** failed to open, when a linked folder such as `node_modules` was in `.gitignore`. This is the default for JavaScript projects.
- On Windows, **Clean Up Squad Worktrees** could offer the worktree of a run that is still open.
- **Set up for this folder** checks `.mcp.json` first. An invalid file used to stop the setup after the settings had changed and the server had restarted.
- A tool call through MCP waits at most 4 minutes (`waitSeconds`), because Claude Code cancels a call that is silent for 5 minutes. The work continues; call `xdev_squad_wait` again.
- The live feed shows file paths with forward slashes on Windows.

### Added

- **Shared artifacts** (**xDev Squad → Memory & Artifacts**): documents every account of a project can read and write, such as a design, a report, or a spec. A worker returns them with its result and later steps under any account can read them. AI clients use `xdev_artifacts_list`, `xdev_artifact_read`, and `xdev_artifact_save`. **Add file…** shares a file from disk.
- An artifact can carry the address of the page it was published as on claude.ai. The page stays with the account that made it; the content is what the other accounts read.
- **A model per task.** The lead may choose the Claude Code model of each task (`model` in `xdev_squad_submit_plan`, and in plans from Squad's own Lead): for example `haiku` for simple work and `opus` only for the hardest. Tasks without a choice use the role's model from `xdevAi.squad.workerModels`. The plan, the run, and `xdev_squad_run` show the model of each step.

### Changed

- The Memory tab is named **Memory & Artifacts**.
- xDev AI MCP accepts requests of up to 1 MB, so a client can save an artifact in one call. The limit was 64 KB.

## 0.18.1 - 2026-11-27

### Fixed

- The VS Code notice for a confirmation that waits in the AI client no longer stays after the request was answered. It closes when the client or you answer, or when the request expires after 10 minutes.

### Changed

- The notice has a **Review** link, which opens a dialog to approve or decline, and a **Cancel** button, which declines. A status bar entry shows how many requests wait, and **xDev AI: Review MCP Confirmations** lists them.
- A request you decline in VS Code tells the client so when it asks.
- Waiting confirmations survive a restart of the MCP server, for example after you change a setting.

## 0.18.0 - 2026-11-27

### Added

- **MCP tab** in the Squad panel (**xDev AI: Open MCP Settings**): whether the server runs and where, what clients may do with accounts and Squad, where changes are confirmed, automatic start, the port, and every tool a client can call with those settings. Start, stop, restart, set the port, copy the client configuration, rotate the token, and open the audit log from there. **MCP servers for Squad workers** moved here from the Project tab, so all of MCP is in one place.
- **Set up for this folder** (**xDev AI: Set Up MCP for This Folder**): choose a preset (Full control, Lead Squad, Read only, or your current settings), and xDev AI keeps a fixed port, starts the server automatically, and adds the `xdev_ai` server to the folder's `.mcp.json`. The file holds no token: it names `XDEV_AI_MCP_URL` and `XDEV_AI_MCP_TOKEN`, which xDev AI sets in the AI terminals it opens.

- **Lead Squad from an MCP client** (`xdevAi.mcp.squadControl`: `off`, `read`, `run`; `off` by default). With `run`, a connected client, such as a Claude Code session you control remotely, submits a plan that hands each task to a Claude Code account (`xdev_squad_submit_plan`), approves it, runs and skips steps, requests changes, and commits the run to its local branch. `read` shows the plan, runs, results, and diffs. Merging, pushing, and deploying stay in VS Code.
- **Confirm changes in the client** (`xdevAi.mcp.confirmIn`: `vscode`, `client`). With `client`, sign-in, bypass sessions, deletions, and SDLC stage approval return a confirmation id and change nothing until the client calls `xdev_confirm`; a VS Code notification can approve the same request. Use it when you cannot reach the VS Code dialog.
- **Manage MCP** has **Set Up for This Folder**, **Squad Control**, and **Confirm Changes In** entries.
- `xdev_squad_run` returns the Claude Code session id of each headless step.

### Changed

- A plan from an MCP client keeps the order of its tasks and may use a role more than once, each with its own account.
- Requested changes on a run whose Implement role has no assigned account go back to the account that implemented the change.
- AI terminals opened by xDev AI get `XDEV_AI_MCP_URL` and `XDEV_AI_MCP_TOKEN` while the MCP server of their window runs.
- When another window holds the fixed MCP port, a window starts its server on a free port instead of reporting that the port is in use. The MCP tab shows which port the window uses.
- The **Manage MCP** button under Skills & Tools opens the MCP tab. The `xdev_ai` server in `.mcp.json` is not offered to Squad workers.

## 0.17.0 - 2026-11-26

### Added

- **Account tags, notes, and disabled flag.** Right-click a terminal account to edit its tags or note, or to disable it. Tags, the disabled state, and the last-opened time show in the sidebar. A disabled account is left out of the Squad pool and of MCP account picks. The details live in the account's `.xdev-profile.json`, next to its name.
- **Check Account Health** lists every terminal account by state (sign-in required, nearly out of quota, fine, disabled) after a fresh quota reading.
- **Quota warning** once per window when an account reaches `xdevAi.quotaAlertPercent` (default 90).
- **Audit log** (**xDev AI: Show Audit Log**): account deletions, imports, exports, and every MCP change, as JSON Lines in global storage, without keys or sign-in data.
- **MCP account control** (`xdevAi.mcp.accountControl`: `off`, `read`, `manage`). `read` adds account usage and a best-account pick; `manage` lets clients rename, tag, disable, and open accounts, select or add API profiles, and set the Squad pool. Deleting, signing in, bypass sessions, and adding a key always ask in VS Code.
- **Stable MCP connection:** the token is kept in SecretStorage, `xdevAi.mcp.port` fixes the port, `xdevAi.mcp.autoStart` starts the server with a trusted workspace, and **xDev AI: Rotate MCP Token** issues a new token. **Copy Client Configuration** can copy a `claude mcp add` command.

### Changed

- `xdev_accounts_list` returns more fields per account (`active` for API profiles; tags, note, disabled, plan, `signedIn`, quota for terminal accounts).
- `xdevAi.squad.poolAccounts` is documented to take account ids, which survive a rename.

## 0.16.0 - 2026-11-26

### Added

- API profiles are offered to the editor's built-in chat as language models. The extension contributes the model provider **xDev AI** (`languageModelChatProviders`, vendor `xdev-ai`) with one model per API profile, named after the profile. A request runs in the extension host through the profile's provider; the API key stays in SecretStorage and is not part of the model entry.
- `xdevAi.chatModels.maxInputTokens` (default `128000`) sets the input token limit reported for these models.

### Changed

- The extension needs VS Code 1.104 or later, the first release with the Language Model Chat Provider API, or a code-server release that bundles Code 1.104 or later.

### Limits

- The answer arrives in one piece when the provider has finished it, not token by token.
- These models report no tool calling and no image input. Tool calls and images in a conversation are left out of the request; text and tool-result text are sent.
- Token counts are estimated at four characters per token.
- Checked in desktop VS Code 1.147.0 through the extension API (`vscode.lm.selectChatModels` and `sendRequest`). The model picker of the chat view and code-server were not checked.

## 0.15.1 - 2026-11-26

### Changed

- **Squad waits for you by default.** `xdevAi.squad.planApproval` now defaults to `manual` and `xdevAi.squad.approver` to `human`. Set them to `auto` and `ai` to get one-message runs back.
- An AI review is sent the worktree's uncommitted changes as xDev measured them with git, next to the worker's own summary, and is told to judge the changes. A text API reviewer no longer passes a step whose changes are too large to send in full, and a review whose changes cannot be read asks for changes.

### Security

- Headless Squad runs no longer put the prompt or the role instructions on the command line: the prompt goes to Claude Code's standard input, the instructions in a private temporary file (`--append-system-prompt-file`). A step opened in a terminal reads its instructions from such a file too.
- On Windows, a Claude Code installed as a `.cmd` script is started through `cmd.exe` only when no path or argument contains `% & | < > ^` or a line break; otherwise the run stops with a message to set `xdevAi.claudeExecutable` to a `claude.exe`.
- The Squad view receives only the budget and the allowed commands of the worker settings. MCP server definitions, environment values and `.env` paths stay in the extension host.

## 0.15.0 - 2026-11-26

### Added

- Each terminal account in the Terminal Accounts sidebar lists its own quota rows: **5h** and **Week** (plus any extra limit), with a usage bar, the percentage used and that account's reset time. A window at 100% shows `Full · available again <time>`; a window that has reset shows 0% until the next request starts it. A Codex Premium seat shows only the weekly row.
- The rows update on their own as new quota samples arrive, and **Refresh Account Quota** in the view title updates them on demand.

## 0.14.0 - 2026-11-26

### Added

- **Export Terminal Accounts…** and **Import Terminal Accounts…** move terminal accounts between machines. The `.xdevai` file holds each account's name and sign-in files, encrypted with a passphrase (scrypt, AES-256-GCM); CLI history stays behind. Imported accounts are added as new ones, and a name already in use gets a number.

## 0.13.1 - 2026-11-26

### Added

- The Terminal Accounts sidebar shows each account's plan next to its provider, for example `Claude Code · Max` or `Codex · Plus`, and `Sign-in required` when the account is signed out. The tooltip shows the plan too.
- Team and Business accounts show their seat: `Claude Code · Team · Premium seat` or `Codex · Team · Standard seat`. Claude reads it from the login's rate-limit tier, Codex from whether the account has a 5-hour limit.

## 0.13.0 - 2026-11-23

### Added

- Chat sessions in Squad Chat: **New chat** starts an empty chat with a fresh Lead session, the list switches between the 20 most recent chats, and **Delete** removes one. Worker runs are shared by all chats and kept when a chat is deleted.
- `xdevAi.squad.leadSessionTurns` (20): a Claude Code Lead continues one session per chat (`--resume`). Later turns send only the new message, what happened since Lead's last reply, and context that changed, not the history, memory, and CodeGraph excerpt each time. After the set number of turns, or when the session is gone, Lead starts a fresh session with the full context. `0` keeps the earlier behaviour.
- `xdevAi.squad.planApproval` (`auto`): Lead's plan is approved as soon as it is proposed and its first step runs; later steps follow `xdevAi.squad.approver`. `manual` keeps approving each plan in the panel. A plan that needs a repository choice waits in the panel. Stop run also stops an automatic start.
- `xdevAi.squad.accountPool` (`role`) and `xdevAi.squad.poolAccounts`: spread Claude Code worker steps over several accounts, in turn (`roundRobin`) or from the account with the most rate-limit quota left (`quota`). Lead's account is used for workers only when the pool has no other, so AI reviews stay independent.
- `xdevAi.squad.resumeFeedback` (on): **Request changes** continues Implement's earlier session in the same worktree and account and sends only the feedback.
- The chat shows the Lead session's turns and the active start and pool modes.

### Changed

- One chat message now runs the whole plan by default: `xdevAi.squad.planApproval` defaults to `auto` and `xdevAi.squad.approver` to `ai` (was `human`). A blocked or failed step, requested changes, a missing repository choice, merging, and pushing still wait for you. Set `planApproval` to `manual` and `approver` to `human` for the earlier behaviour.

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
