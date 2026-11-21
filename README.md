# xDev AI

A VS Code extension for managing Claude Code, Codex, and Gemini CLI accounts, chatting with AI providers, and coordinating tasks across API profiles.

## Installation

Use VS Code **1.95 or later**, or a code-server release that includes VS Code 1.95 or later. Search Extensions for `xdev-asia.xdev-ai`.

- **VS Code Desktop.** Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=xdev-asia.xdev-ai).
- **VS Code Remote.** Open your remote workspace and install xDev AI under the remote host in the Extensions view.
- **code-server.** Install from [Open VSX](https://open-vsx.org/extension/xdev-asia/xdev-ai) through the Extensions view or run `code-server --install-extension xdev-asia.xdev-ai` on the server.

For manual installation, download the `.vsix` from [GitHub Releases](https://github.com/xdev-asia/vscode-ai-profiles/releases) and run **Extensions: Install from VSIX…** in your workspace. On code-server you can also run `code-server --install-extension <path-to-vsix>`.

See what's new under **Extensions → xDev AI → Changelog**, or read the [release history](CHANGELOG.md) on GitHub.

The extension runs on the machine that hosts the workspace. For remote workspaces, that machine needs access to the provider's API and resolves any `localhost` addresses in custom endpoints. [VS Code Remote](https://code.visualstudio.com/api/advanced-topics/remote-extensions) · [code-server installation](https://coder.com/docs/code-server/FAQ#how-do-i-install-an-extension-manually)

The extension ID changed to `xdev-asia.xdev-ai` in v0.2.1. If you installed the v0.2.0 preview (`xdev.xdev-ai`), disable it before using the new version, then add your API profiles and sign in to each Claude Code account again in the new extension.

## Manage AI accounts

Open **xDev AI** in the Activity Bar. The sidebar contains **Terminal Accounts** and **API Profiles**. To move a view to the right, run **View: Move View** from the Command Palette, select the view, and choose **New Secondary Side Bar Entry**.

1. Click **Add AI Account (+)** next to **Terminal Accounts**. Choose **Claude Code**, **Codex**, **Gemini CLI**, or **API Profile**. For a terminal account, give the profile a name and complete sign-in with the provider. Gemini opens its authentication menu in the terminal. Codex uses device code sign-in on remote hosts and code-server, which requires device code sign-in to be enabled for the account.
2. Select an account to open its terminal. Use the **xDev AI** status bar item, **Open AI Terminal** on the Terminal toolbar, or **xDev AI: Choose Account** in the terminal profile menu to pick an account without opening the sidebar.
3. Right-click a terminal account to rename it or sign in again. Click **Check AI Usage** next to a terminal account to open its session and see the provider's usage command.
4. In **API Profiles**, click **+** to add a profile. Select a profile to open xDev Chat with it, or right-click it to make it active or edit it.
5. Click the trash icon next to a terminal account or API profile, or use its right-click **Delete** command. Deleting a terminal account closes its matching terminals in the current window and removes the profile directory, including saved sign-in data and CLI history. Deleting an API profile removes its saved key from xDev AI.

Install each CLI on the workspace host. If xDev AI cannot find one, enter its absolute executable path in User Settings or Remote Settings.

| Terminal | Settings key | Usage command |
| --- | --- | --- |
| [Claude Code](https://code.claude.com/docs/en/setup) | `xdevAi.claudeExecutable` | `/usage` |
| [Codex](https://developers.openai.com/codex/cli) | `xdevAi.codexExecutable` | `/status` |
| [Gemini CLI](https://geminicli.com/docs/get-started/) | `xdevAi.geminiExecutable` | `/stats model` |

Each account has its own configuration directory on the workspace host. The CLIs manage their sign-in, credentials, and history there. Terminal and API profiles are configured separately. [Claude Code authentication](https://code.claude.com/docs/en/authentication#log-in-with-multiple-accounts) · [Codex authentication](https://developers.openai.com/codex/auth) · [Gemini CLI authentication](https://geminicli.com/docs/get-started/authentication/)

### View account quota

Hover over **xDev AI** in the VS Code or code-server status bar. The hover lists terminal profiles with the plan name, percentage used, and reset time where available. Click **Refresh quota** to update the hover or open a profile's terminal for its full usage view. API key profiles are managed separately and have no subscription quota in the hover.

- **Codex.** ChatGPT profiles show rate-limit windows from Codex App Server. The extension refreshes these readings periodically in trusted workspaces. [Codex rate limits](https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt)
- **Claude Code.** Open a new Claude session from xDev AI in a trusted workspace. On supported plans, the hover shows the latest quota sample after Claude replies. This uses the session's status line and requires Node.js on the workspace host's `PATH`. If you already use a custom Claude status line, open `/usage` in the terminal. [Claude Code status line](https://code.claude.com/docs/en/statusline#display-usage-limits)
- **Gemini CLI.** Use the account's hover link to open its terminal and enter `/stats model` for model usage and any quota the CLI displays. [Gemini CLI commands](https://geminicli.com/docs/reference/commands/)

### Open a terminal with bypass permissions

Right-click a signed-in terminal account and choose **Open AI Terminal with Bypass Permissions**, or choose **xDev AI: Bypass Permissions** from the terminal profile menu. Confirm the mode for the session. Use a trusted workspace, and use a separate VM or container when running Codex without its sandbox.

Claude Code skips permission prompts, Codex skips approval prompts and disables its sandbox, and Gemini CLI uses YOLO approval mode. The option applies to the new terminal and uses the selected account's existing sign-in. Normal terminal and sign-in actions use the CLI defaults. Managed provider policies may restrict these modes. [Claude Code options](https://code.claude.com/docs/en/cli-reference) · [Codex CLI options](https://developers.openai.com/codex/cli/reference/) · [Gemini CLI options](https://geminicli.com/docs/reference/configuration/)

### Sign in to Claude Code from code-server

1. In **Terminal Accounts**, right-click your Claude Code account and choose **Sign In to Terminal Account**. Keep the xDev AI terminal open.
2. Open the URL printed by Claude Code in your browser. If Claude Code shows **Paste code here**, use the URL directly above that prompt. After authorizing in the browser, return to the original terminal and paste the code, then press Enter.
3. Once Claude Code confirms sign-in, xDev AI opens the Claude session in the same terminal and profile. If sign-in exits with an error, the terminal stays open with the original CLI output and retry and status commands.

On the code-server host, check `claude --version` and update Claude Code if your version lacks the manual code prompt. Run `claude update` if you installed Claude Code with its native installer. [Claude Code remote OAuth troubleshooting](https://code.claude.com/docs/en/troubleshoot-install#oauth-login-fails-in-wsl2-ssh-or-containers) · [Claude Code updates](https://code.claude.com/docs/en/setup)

## Coordinate work with Squad

Open **xDev Squad** in the bottom panel, click **Open Squad** on the Terminal toolbar, or run **xDev AI: Open Squad** from the Command Palette.

### Use one chat for the squad

1. Open **Roles**, select **Lead** and any workers you want to use, and assign an API profile to each. Save each assignment.
2. Open **Chat** and send a request to Lead. If Lead proposes tasks, review the briefs and profiles, then click **Approve and run** or **Discard plan**.
3. Follow the results in the same chat. Use `@Implement`, `@Review`, or `@Tests` to send a message directly to a role. Press **Stop run** to cancel the current run and skip any remaining tasks.
4. To use an assigned terminal profile, select its role in **Chat** and click **Open terminal**.

Roles with an API profile use text APIs for planning, implementation proposals, reviews, and test suggestions, and do not read or edit repository files or run tests. To work on the repository, assign a Claude Code account instead (see [Run Claude Code workers on the repository](#run-claude-code-workers-on-the-repository)). Lead receives recent chat entries. Approved workers receive the original request and their assigned brief. Review and Tests also receive the implementation proposal when the plan includes Implement. Use profiles that are approved for the information you share.

The most recent 60 chat entries and the pending plan are stored in local VS Code workspace state. Reloading VS Code preserves pending approval and completed replies. An interrupted run needs a new request to continue.

### Use Squad in GitHub Copilot Chat

1. Assign API profiles in **xDev Squad → Roles**. Open the **Chat** view in VS Code and select a Copilot agent session with extension tools enabled.
2. In the chat input, type `#` and select **Ask xDev Squad** (`xdevSquadAsk`). Try “Ask xDev Squad to plan an API migration.” To talk directly to a role, try “Ask xDev Squad's Review role to check backward compatibility.”
3. Review the roles, profiles, and briefs in the Copilot reply. Ask Copilot to run or discard the pending Squad plan, using **Manage xDev Squad Plan** (`xdevSquadPlan`) if needed. Choose **Approve and run** in the VS Code dialog to send the tasks. The dialog is required even when Copilot's tool approvals are bypassed. Results return to the same Copilot conversation.
4. If the tools are missing, run **Chat: Open Customizations**, open **Tools**, and check that the xDev AI tools are enabled for the selected Copilot session.

Both interfaces use the same workspace profiles, pending plan, and Squad context. Copilot receives the responses to its Squad tool calls. Each assigned API profile receives the request and context described above. On code-server, open **xDev Squad → Chat** for the same workflow. [VS Code extension tools](https://code.visualstudio.com/docs/agents/run/tools?select-tools-by-harness=copilot-harness#_add-extension-tools-for-the-copilot-harness)

VS Code manages the chat session's agent harness and model picker. To change the native harness, start a new chat and choose a session target. xDev terminal profiles open in their own terminals. Use the API profiles assigned under **Roles** for xDev Squad tool calls in a Copilot session. [VS Code agent harnesses](https://code.visualstudio.com/docs/agents/run/agent-harnesses)

### Run an AI SDLC workflow

1. Open **xDev Squad → Workflow** or run **xDev AI: Open SDLC Workflow**. Enter the project brief to start **Plan → Implement → Review → Test → Release**.
2. For an AI draft, assign the stage's role an API profile in **Roles**, then click **Draft with AI** in **Workflow**. The draft also appears in the shared **Chat**. In Copilot Chat, `#xdevSdlc` can show the current stage or request a draft.
3. Edit the draft or enter your own result, then click **Approve stage**. For terminal accounts, use **Copy stage brief** and open the role's terminal. Check approved results in the same workflow after reloading the workspace.

The **Release** stage drafts a Markdown changelog entry from approved results. Review it in **Workflow**, then copy the entry to your project's changelog when preparing the release.

Each AI draft sends the project brief, excerpts of earlier approved results, and enabled workspace skills to the assigned API provider. Each stage produces a text result. Run code changes, tests, and releases in your editor, CLI, or CI. Open **Workflow** to approve results from either chat interface. Each workspace keeps one current workflow, with a reset action to start another.

If VS Code reports that the workflow command is missing after an update, check **Extensions** for the installed xDev AI version on the workspace host, then run **Developer: Reload Window**. To diagnose a failed activation, open **Output** and select **Log (Extension Host)** or **Log (Remote Extension Host)**.

### Run Claude Code workers on the repository

Assign a **Claude Code** terminal account (instead of an API profile) to a role under **Roles**. That role then runs Claude Code headless (`claude -p`) under the account's own sign-in, and can read the repository and, for Implement and Tests, edit files and run allowed commands. A Claude Code account on Lead plans with the same subscription, without file tools.

1. Open a workspace folder that is a git repository with at least one commit.
2. Send a request to Lead and review the plan. Each task shows whether it runs as **Claude Code** or **Text API**, and the plan shows the spending cap and allowed commands.
3. Click **Approve and run**. xDev creates a git worktree on a new local branch `xdev/squad/<id>`, so your checkout is not changed. Workers run one after another in that worktree: Implement edits, Review reads the diff, Tests adds and runs tests. Each worker receives the request, its brief, short summaries from earlier workers, and shared memory, not the full transcripts.
4. When the run ends, xDev commits the worktree to its branch, locally. Under **Worker runs**, use **View diff**, **Merge** (asks first, never pushes), **Open folder**, **Continue … in terminal** to resume a worker's session interactively, or **Remove** to delete the worktree and branch.

A worker that reports **blocked** stops the remaining tasks; reply to Lead with a decision. Commands outside the allowed list are denied without prompting and listed in the chat.

| Setting | Default | Purpose |
| --- | --- | --- |
| `xdevAi.squad.workerAllowedCommands` | `npm test`, `npm run build`, `npm run lint` | Command prefixes Implement and Tests may run. Read-only git is always allowed. |
| `xdevAi.squad.workerBudgetUsd` | `1` | `--max-budget-usd` for each worker run. `0` turns the cap off. |
| `xdevAi.squad.workerModels` | `{}` | Model per role, for example `{ "Review": "haiku" }`. |
| `xdevAi.squad.workerTimeoutMinutes` | `20` | Stops a worker that runs too long. |

Workers do not use `--dangerously-skip-permissions` or `--bare` (bare mode ignores claude.ai sign-in). Built-in tools a role does not need are not loaded, and MCP servers are skipped (`--strict-mcp-config`), which keeps each request small. [Claude Code headless mode](https://code.claude.com/docs/en/headless) · [CLI reference](https://code.claude.com/docs/en/cli-reference)

Each account's own plan and usage limits apply. Check your provider's terms before running unattended agents across several subscriptions.

### Share memory between agents

Open **xDev Squad → Memory** or run **xDev AI: Open Squad Memory**. Memory holds short notes, such as conventions, decisions, and pitfalls, that every Lead, worker, and SDLC draft receives with its task. Workers add up to five notes after a run when they learn something durable. Add, edit, pin, or delete notes yourself. Pinned notes are always included. Other notes are included newest first within a fixed budget of about 3,000 characters, so memory does not grow every prompt.

### Manage Skills and Tools

- Under **xDev Squad → Skills & Tools**, add, edit, disable, or delete workspace skills. A skill is a named set of instructions with an optional one-line **When to use** description. Enabled skills are included in SDLC drafting.
- Enabled skills are also copied into every Claude Code account as user skills (`$CLAUDE_CONFIG_DIR/skills/xdev-<name>/SKILL.md`) when you save them and before each run. Claude Code keeps only the description in context and loads a skill when it applies. xDev changes only folders it created. Turn this off with `xdevAi.squad.syncSkillsToProfiles`. [Claude Code skills](https://code.claude.com/docs/en/skills)
- To share skills and memory across machines and teammates, click **Sync with folder** (or run **xDev AI: Sync Squad Skills and Memory**) and choose a folder, usually a clone of your team docs repository (`xdevAi.squad.syncFolder`). Skills are stored as `skills/<name>/SKILL.md` and memory as `memory/squad-memory.json`. In a git folder, xDev pulls with `--ff-only`, merges, commits locally, and asks before pushing. When the same skill changed on both sides, your version stays and the folder version is added as a disabled “(sync copy)” skill.
- Use the tool switches to control Copilot access to **Ask xDev Squad**, **Manage xDev Squad Plan**, and **xDev SDLC Workflow** in this workspace. The SDLC switch also controls MCP access to the workflow. In supported VS Code versions, use the panel shortcuts to open native **Agent Skills** and **Tools & MCP** management. [VS Code agent customizations](https://code.visualstudio.com/docs/agent-customization/overview)

### Control the workflow through MCP

1. In a trusted workspace, open **xDev Squad → Skills & Tools → Manage MCP** or run **xDev AI: Manage MCP**. Choose **Start MCP**.
2. In VS Code builds with native MCP support, run **MCP: List Servers** and start **xDev AI** if needed. Select its tools in Copilot Agent Chat. [VS Code MCP server management](https://code.visualstudio.com/docs/agents/run/manage-mcp-servers)
3. For a terminal client, reopen **Manage MCP** and choose **Copy Client Configuration**, then choose Claude Code, Codex, or Gemini CLI. Merge the snippet into the client's private config on the workspace host. For an xDev terminal profile, use `$CODEX_HOME/config.toml` for Codex or `$GEMINI_CLI_HOME/.gemini/settings.json` for Gemini CLI. In Claude Code, you can use `claude mcp add-json xdev_ai '<server definition>'` with the `mcpServers.xdev_ai` object from the snippet. Restart the client or refresh its MCP connections. [Claude Code configuration](https://code.claude.com/docs/en/mcp) · [Codex configuration](https://developers.openai.com/codex/config-reference/) · [Gemini CLI configuration](https://geminicli.com/docs/tools/mcp-server/)
4. Ask your agent to “Use xDev AI to show the current SDLC stage and submit a draft for review.” The draft appears in **Workflow**. Approve it there, or ask the agent to request approval in a VS Code dialog.

The MCP server exposes workflow status, start, stage context, draft submission, approval requests, and account aliases. It shares the same workspace state as the Squad panel. A confirmed approval advances the current stage. The server exposes no account credentials or shell execution tools. Stage context includes the project brief, excerpts of approved results, and enabled skills, so only connect clients you trust with that context.

MCP listens on a loopback address on the workspace host, including on code-server. The client must run on that same host. Keep the copied configuration private and out of source control. **Stop MCP** ends access and invalidates the token. Reloading the window stops the server. A new start issues a new address and token.

### Manage a role manually

1. Open **Roles** in the xDev Squad panel.
2. Select **Lead**, **Implement**, **Review**, or **Tests**. Assign an API profile or terminal account, enter a task brief, and click **Save task**. Each role has one current task, and you can prepare a brief before assigning a profile.
3. For a terminal account, use **Copy brief** and **Open terminal**, then paste the brief into that provider's session. **Check usage** opens the assigned terminal and shows its usage command.
4. For an API profile, click **Send to API** to send the saved brief to the selected model. Read the reply under **Latest API response**. Include any context you want the model to see in the brief.
5. Update task status as work progresses. For **Blocked**, save a reason to show it under **Needs attention**. Use **Hand off to another role** to leave a note for that role in **Recent activity**.

The board keeps assignments, briefs, the latest API response per role, and the 30 most recent activity entries in local VS Code workspace state. Status changes and handoffs are manual.

## Chat with AI providers

1. Run **xDev AI: Open Chat** from the Command Palette.
2. Run **xDev AI: Add API Profile** and choose a provider. Give the profile a recognizable name, then enter a model ID and API key. For an OpenAI-compatible endpoint, also enter its base URL, such as `http://127.0.0.1:11434/v1` for Ollama. You can leave the key blank if the endpoint accepts unauthenticated requests.
3. Send a message with `Ctrl+Enter` or `Cmd+Enter`. Use the profile menu or **xDev AI: Switch API Profile** to change accounts. Each profile keeps its most recent 12 exchanges while the chat tab is open.
4. Run **xDev AI: Manage API Profiles** to rename or remove a profile, change its model, or replace its API key. The **Đoạn chat mới** (New chat) button clears the selected profile's conversation.

The chat tab authenticates with API keys. Get a key and model ID from your provider. [OpenAI](https://developers.openai.com/api/docs/quickstart) · [Anthropic](https://platform.claude.com/docs/en/api/messages/create) · [Google AI Studio](https://aistudio.google.com/docs/openai)

VS Code SecretStorage holds the API profiles. You may need to add your profiles again on a different VS Code installation or server. The chat sends your message and the selected profile's conversation history to its provider. Custom base URLs must use HTTPS or loopback HTTP.

## Use the TypeScript library

The chat client also runs independently in Node.js 20.3 or later. Run `npm ci` and `npm pack` from the repository root to create an `xdev-ai` archive. Install that archive in your Node.js project, then set `AI_MODEL` and `OPENAI_API_KEY` for this example.

```ts
import { chat } from 'xdev-ai'

const answer = await chat(
  { provider: 'openai', model: process.env.AI_MODEL!, apiKey: process.env.OPENAI_API_KEY },
  [{ role: 'user', content: 'Explain how to use AbortSignal.' }]
)
console.log(answer)
```

### Call xDev AI from another VS Code extension

Add `"extensionDependencies": ["xdev-asia.xdev-ai"]` to the calling extension's manifest and install xDev AI in the same extension host. `listAccounts()` returns each profile's ID, name, provider, and model. Pass `{ accountId }` to select a profile. When you omit it, `chat()` uses the active profile.

```ts
import * as vscode from 'vscode'

const extension = vscode.extensions.getExtension('xdev-asia.xdev-ai')
if (!extension) throw new Error('Install xDev AI to continue.')
const ai = await extension.activate()
const [account] = await ai.listAccounts()
if (account) {
  const answer = await ai.chat(
    [{ role: 'user', content: 'Describe how a VS Code extension host works.' }],
    { accountId: account.id }
  )
  console.log(answer)
}
```

## Build and test

```sh
npm ci
npm test
npm run package
```

## Release an extension version

[GitHub Actions](https://github.com/xdev-asia/vscode-ai-profiles/actions/workflows/publish.yml) tests and packages every pull request and push to `main`. Add the version's notes to [CHANGELOG.md](CHANGELOG.md) under a heading such as `## 0.6.1 - 2026-11-19`. Push a version tag such as `v0.6.1` that matches `package.json`. The workflow uses that changelog entry for the GitHub Release, attaches the tested VSIX, and publishes the same VSIX to both registries.

- **VS Code Marketplace.** Create or select the `xdev-asia` publisher and add a Trusted Publishing policy in [Manage Publishers & Extensions](https://marketplace.visualstudio.com/manage). Set the repository owner to `xdev-asia`, repository to `vscode-ai-profiles`, and workflow to `publish.yml`. Leave the environment blank.
- **Open VSX (code-server).** Declare the extension license in `package.json` and include the license file. Sign the [Open VSX Publisher Agreement](https://open-vsx.org/publisher-agreement-v1.1) and create the `xdev-asia` namespace. Publish the first VSIX through the [Open VSX upload page](https://open-vsx.org/publish), or save an Open VSX access token as `OVSX_PAT` in the [repository's Actions secrets](https://github.com/xdev-asia/vscode-ai-profiles/settings/secrets/actions) to publish from CI. After the first version is active, the [namespace owner](https://github.com/eclipse-openvsx/openvsx/wiki/Namespace-Access) can register the same owner, repository, and workflow for `xdev-asia.xdev-ai` under [Trusted Publishers](https://open-vsx.org/user-settings/trusted-publishers). Remove `OVSX_PAT` after registration to use short-lived credentials for subsequent releases. [Open VSX trusted publishing](https://github.com/eclipse-openvsx/openvsx/wiki/Trusted-Publishing)

## License

xDev AI is licensed under the [Apache License 2.0](https://github.com/xdev-asia/vscode-ai-profiles/blob/main/LICENSE).
