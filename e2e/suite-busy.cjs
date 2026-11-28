// Runs inside the extension host of a VS Code window whose fixed MCP port is held by another program,
// as happens when a second window opens. The window must start its server on a free port.
const vscode = require('vscode');
const { connect, steps, within } = require('./steps.cjs');

exports.run = async () => {
  const account = process.env.XDEV_E2E_ACCOUNT;
  const busyPort = Number(process.env.XDEV_E2E_BUSY_PORT);
  const { step, finish } = steps();
  let env = {};
  let terminal;

  await step('the extension activates with the fixed port taken', async () => {
    const extension = vscode.extensions.getExtension('xdev-asia.xdev-ai');
    await extension.activate();
    const config = vscode.workspace.getConfiguration('xdevAi.mcp');
    if (config.get('port') !== busyPort || config.get('autoStart') !== true) throw new Error(`settings: port ${config.get('port')}, autoStart ${config.get('autoStart')}`);
    return `xdevAi.mcp.port ${busyPort} is held by another program`;
  });

  await step('a terminal opened here gets this window\'s own address', async () => {
    const opened = new Promise(resolve => {
      const listener = vscode.window.onDidOpenTerminal(item => { listener.dispose(); resolve(item); });
    });
    void vscode.commands.executeCommand('xdevAi.openTerminal', account);
    terminal = await within(opened, 20_000, 'Opening the terminal');
    env = terminal.creationOptions.env ?? {};
    if (!env.XDEV_AI_MCP_URL) throw new Error('XDEV_AI_MCP_URL is missing: the server did not start');
    if (Number(new URL(env.XDEV_AI_MCP_URL).port) === busyPort) throw new Error('the terminal points at the port another program holds');
    return `XDEV_AI_MCP_URL=${env.XDEV_AI_MCP_URL}`;
  });

  await step('a client reaches this window on that address', async () => {
    const { client, call } = await connect(env.XDEV_AI_MCP_URL, env.XDEV_AI_MCP_TOKEN);
    try {
      const accounts = await call('xdev_accounts_list');
      if (!accounts.terminals.some(item => item.id === account)) throw new Error('the e2e account is not listed');
    } finally {
      await client.close();
    }
  });

  await step('the MCP tab opens', async () => {
    await vscode.commands.executeCommand('xdevAi.squad.mcp');
  });

  terminal?.dispose();
  finish();
};
