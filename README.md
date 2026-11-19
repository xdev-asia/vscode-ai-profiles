# xDev AI

A VS Code extension that opens Claude Code terminals for individual accounts and lets you chat with AI providers using separate API profiles.

## Installation

Use VS Code **1.95 or later**, or a code-server release that includes VS Code 1.95 or later. Download the `.vsix` from [GitHub Releases](https://github.com/xdev-asia/vscode-ai-profiles/releases), or build it locally with `npm ci` and `npm run package`.

- **VS Code Desktop.** Run **Extensions: Install from VSIX…** from the Command Palette and select the downloaded `.vsix` file.
- **VS Code Remote.** Open a workspace over Remote SSH, WSL, Dev Containers, or Remote Tunnels. Run **Extensions: Install from VSIX…** in the remote window, then confirm xDev AI appears under the remote host in the Extensions view.
- **code-server.** Copy the VSIX to the server and run `code-server --install-extension xdev-ai-0.2.2.vsix`, substituting your downloaded filename. Reload the browser window.

The extension runs on the machine that hosts the workspace. For remote workspaces, that machine needs access to the provider's API and resolves any `localhost` addresses in custom endpoints. [VS Code Remote](https://code.visualstudio.com/api/advanced-topics/remote-extensions) · [code-server installation](https://coder.com/docs/code-server/FAQ#how-do-i-install-an-extension-manually)

The extension ID changed to `xdev-asia.xdev-ai` in v0.2.1. If you installed the v0.2.0 preview (`xdev.xdev-ai`), disable it before using the new version, then add your API profiles and sign in to each Claude Code account again in the new extension.

## Use multiple Claude Code accounts

1. Install Claude Code on the workspace host. On Windows, use the native installation with `claude.exe`. If xDev AI cannot find the CLI, set `xdevAi.claudeExecutable` to its absolute path in User Settings or Remote Settings. [Claude Code installation](https://code.claude.com/docs/en/setup)
2. Run **xDev AI: Add Claude Account**, name the profile, and complete the claude.ai sign-in in your browser. Repeat for each account. On a server without a browser, open the URL Claude Code prints in the terminal and follow its instructions.
3. Run **xDev AI: Open Claude Terminal** and select an account. You can also choose **xDev AI: Claude Code** from the menu next to **+** in the Terminal panel or click **Claude Code** in the xDev AI tab. You can keep multiple terminals open at once. Run `/status` in Claude Code to see which account the terminal is using.
4. Run **xDev AI: Sign In to Claude Account** to sign in again for an existing profile.

Each profile uses a separate `CLAUDE_CONFIG_DIR` on the workspace host. Claude Code handles claude.ai sign-in and manages its credentials and session history there. Desktop and server profiles have separate sign-in sessions. [Anthropic's guide to multiple accounts](https://code.claude.com/docs/en/authentication#log-in-with-multiple-accounts)

## Chat with AI providers

1. Run **xDev AI: Open Chat** from the Command Palette.
2. Run **xDev AI: Add Account** and choose a provider. Give the profile a recognizable name, then enter a model ID and API key. For an OpenAI-compatible endpoint, also enter its base URL, such as `http://127.0.0.1:11434/v1` for Ollama. You can leave the key blank if the endpoint accepts unauthenticated requests.
3. Send a message with `Ctrl+Enter` or `Cmd+Enter`. Use the profile menu or **xDev AI: Switch Account** to change accounts. Each profile keeps its most recent 12 exchanges while the chat tab is open.
4. Run **xDev AI: Manage Accounts** to rename or remove a profile, change its model, or replace its API key. The **Đoạn chat mới** (New chat) button clears the selected profile's conversation.

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
- **Open VSX (code-server).** Declare the extension license in `package.json` and include the license file. Sign the [Open VSX Publisher Agreement](https://open-vsx.org/publisher-agreement-v1.1), create the `xdev-asia` namespace, and save the access token as `OVSX_PAT` in the [repository's Actions secrets](https://github.com/xdev-asia/vscode-ai-profiles/settings/secrets/actions) for the first release. After the first version is active, the namespace owner can register the same owner, repository, and workflow for `xdev-asia.xdev-ai` under [Trusted Publishers](https://open-vsx.org/user-settings/trusted-publishers). Remove `OVSX_PAT` after registration to use short-lived credentials for subsequent releases. [Open VSX trusted publishing](https://github.com/eclipse-openvsx/openvsx/wiki/Trusted-Publishing)

## License

xDev AI is licensed under the [Apache License 2.0](https://github.com/xdev-asia/vscode-ai-profiles/blob/main/LICENSE).
