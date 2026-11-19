# xDev AI

A VS Code extension for managing Claude Code, Codex, and Gemini CLI accounts, chatting with AI providers, and coordinating tasks across API profiles.

## Installation

Use VS Code **1.95 or later**, or a code-server release that includes VS Code 1.95 or later. Search Extensions for `xdev-asia.xdev-ai`.

- **VS Code Desktop.** Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=xdev-asia.xdev-ai).
- **VS Code Remote.** Open your remote workspace and install xDev AI under the remote host in the Extensions view.
- **code-server.** Install from [Open VSX](https://open-vsx.org/extension/xdev-asia/xdev-ai) through the Extensions view or run `code-server --install-extension xdev-asia.xdev-ai` on the server.

For manual installation, download the `.vsix` from [GitHub Releases](https://github.com/xdev-asia/vscode-ai-profiles/releases) and run **Extensions: Install from VSIX…** in your workspace. On code-server you can also run `code-server --install-extension <path-to-vsix>`.

The extension runs on the machine that hosts the workspace. For remote workspaces, that machine needs access to the provider's API and resolves any `localhost` addresses in custom endpoints. [VS Code Remote](https://code.visualstudio.com/api/advanced-topics/remote-extensions) · [code-server installation](https://coder.com/docs/code-server/FAQ#how-do-i-install-an-extension-manually)

The extension ID changed to `xdev-asia.xdev-ai` in v0.2.1. If you installed the v0.2.0 preview (`xdev.xdev-ai`), disable it before using the new version, then add your API profiles and sign in to each Claude Code account again in the new extension.

## Manage AI accounts

Open **xDev AI** in the Activity Bar. The sidebar contains **Terminal Accounts** and **API Profiles**. To move either view to the right, right-click its title and choose **Move View → Secondary Side Bar**.

1. Click **Add AI Account (+)** next to **Terminal Accounts**. Choose **Claude Code**, **Codex**, **Gemini CLI**, or **API Profile**. For a terminal account, give the profile a name and complete sign-in with the provider. Gemini opens its authentication menu in the terminal. Codex uses device code sign-in on remote hosts and code-server, which requires device code sign-in to be enabled for the account.
2. Select an account to open its terminal. Use the **xDev AI** status bar item, **Open AI Terminal** on the Terminal toolbar, or **xDev AI: Choose Account** in the terminal profile menu to pick an account without opening the sidebar.
3. Right-click a terminal account to rename it or sign in again. Click **Check AI Usage** next to a terminal account to open its session and see the provider's usage command.
4. In **API Profiles**, click **+** to add a profile. Select a profile to open xDev Chat with it, or right-click it to make it active, edit it, or remove it.

Install each CLI on the workspace host. If xDev AI cannot find one, enter its absolute executable path in User Settings or Remote Settings.

| Terminal | Settings key | Usage command |
| --- | --- | --- |
| [Claude Code](https://code.claude.com/docs/en/setup) | `xdevAi.claudeExecutable` | `/usage` |
| [Codex](https://developers.openai.com/codex/cli) | `xdevAi.codexExecutable` | `/status` |
| [Gemini CLI](https://geminicli.com/docs/get-started/) | `xdevAi.geminiExecutable` | `/stats model` |

Each account has its own configuration directory on the workspace host. The CLIs manage their sign-in, credentials, and history there. Terminal and API profiles are configured separately. [Claude Code authentication](https://code.claude.com/docs/en/authentication#log-in-with-multiple-accounts) · [Codex authentication](https://developers.openai.com/codex/auth) · [Gemini CLI authentication](https://geminicli.com/docs/get-started/authentication/)

## Coordinate work with Squad

Open **xDev Squad** in the bottom panel, click **Open Squad** on the Terminal toolbar, or run **xDev AI: Open Squad** from the Command Palette.

### Use one chat for the squad

1. Open **Roles**, select **Lead** and any workers you want to use, and assign an API profile to each. Save each assignment.
2. Open **Chat** and send a request to Lead. If Lead proposes tasks, review the briefs and profiles, then click **Approve and run** or **Discard plan**.
3. Follow the results in the same chat. Use `@Implement`, `@Review`, or `@Tests` to send a message directly to a role. Press **Stop run** to cancel the current run and skip any remaining tasks.
4. To use an assigned terminal profile, select its role in **Chat** and click **Open terminal**.

The shared chat uses text APIs for planning, implementation proposals, reviews, and test suggestions. This mode does not read or edit repository files or run tests. Lead receives recent chat entries. Approved workers receive the original request and their assigned brief. Review and Tests also receive the implementation proposal when the plan includes Implement. Use profiles that are approved for the information you share.

The most recent 60 chat entries and the pending plan are stored in local VS Code workspace state. Reloading VS Code preserves pending approval and completed replies. An interrupted run needs a new request to continue.

### Use Squad in GitHub Copilot Chat

1. Assign API profiles in **xDev Squad → Roles**. Open the **Chat** view in VS Code and select a Copilot agent session with extension tools enabled.
2. In the chat input, type `#` and select **Ask xDev Squad** (`xdevSquadAsk`). Try “Ask xDev Squad to plan an API migration.” To talk directly to a role, try “Ask xDev Squad's Review role to check backward compatibility.”
3. Review the roles, profiles, and briefs in the Copilot reply. Ask Copilot to run or discard the pending Squad plan, using **Manage xDev Squad Plan** (`xdevSquadPlan`) if needed. Choose **Approve and run** in the VS Code dialog to send the tasks. The dialog is required even when Copilot's tool approvals are bypassed. Results return to the same Copilot conversation.
4. If the tools are missing, run **Chat: Open Customizations**, open **Tools**, and check that the xDev AI tools are enabled for the selected Copilot session.

Both interfaces use the same workspace profiles, pending plan, and Squad context. Copilot receives the responses to its Squad tool calls. Each assigned API profile receives the request and context described above. On code-server, open **xDev Squad → Chat** for the same workflow. [VS Code extension tools](https://code.visualstudio.com/docs/agents/run/tools?select-tools-by-harness=copilot-harness#_add-extension-tools-for-the-copilot-harness)

VS Code manages the chat session's agent harness and model picker. To change the native harness, start a new chat and choose a session target. xDev terminal profiles open in their own terminals. Use the API profiles assigned under **Roles** for xDev Squad tool calls in a Copilot session. [VS Code agent harnesses](https://code.visualstudio.com/docs/agents/run/agent-harnesses)

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

[GitHub Actions](https://github.com/xdev-asia/vscode-ai-profiles/actions/workflows/publish.yml) tests and packages every pull request and push to `main`. Push a version tag such as `v0.2.2` that matches `package.json` to attach the tested VSIX to a GitHub Release and publish the same file to both registries.

- **VS Code Marketplace.** Create or select the `xdev-asia` publisher and add a Trusted Publishing policy in [Manage Publishers & Extensions](https://marketplace.visualstudio.com/manage). Set the repository owner to `xdev-asia`, repository to `vscode-ai-profiles`, and workflow to `publish.yml`. Leave the environment blank.
- **Open VSX (code-server).** Declare the extension license in `package.json` and include the license file. Sign the [Open VSX Publisher Agreement](https://open-vsx.org/publisher-agreement-v1.1) and create the `xdev-asia` namespace. Publish the first VSIX through the [Open VSX upload page](https://open-vsx.org/publish), or save an Open VSX access token as `OVSX_PAT` in the [repository's Actions secrets](https://github.com/xdev-asia/vscode-ai-profiles/settings/secrets/actions) to publish from CI. After the first version is active, the [namespace owner](https://github.com/eclipse-openvsx/openvsx/wiki/Namespace-Access) can register the same owner, repository, and workflow for `xdev-asia.xdev-ai` under [Trusted Publishers](https://open-vsx.org/user-settings/trusted-publishers). Remove `OVSX_PAT` after registration to use short-lived credentials for subsequent releases. [Open VSX trusted publishing](https://github.com/eclipse-openvsx/openvsx/wiki/Trusted-Publishing)

## License

xDev AI is licensed under the [Apache License 2.0](https://github.com/xdev-asia/vscode-ai-profiles/blob/main/LICENSE).
