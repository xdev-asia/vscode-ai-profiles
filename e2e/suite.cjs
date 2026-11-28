// Runs inside the extension host of a real VS Code window and drives xDev AI the way a user and an AI client do.
// The MCP token is read from the terminal environment and never printed.
const vscode = require('vscode');
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { connect, sleep, steps, until, within } = require('./steps.cjs');

exports.run = async () => {
  const account = process.env.XDEV_E2E_ACCOUNT;
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const { step, finish } = steps();
  const config = () => vscode.workspace.getConfiguration('xdevAi.mcp');
  const levels = () => Object.fromEntries(['accountControl', 'squadControl', 'confirmIn', 'autoStart', 'port'].map(key => [key, config().get(key)]));
  const setting = async (key, value) => {
    await config().update(key, value, vscode.ConfigurationTarget.Global);
    // The server restarts with the new level.
    await sleep(2_000);
  };
  const file = join(folder, '.mcp.json');
  let token;
  let url;
  let terminal;
  const client = () => until(() => connect(url, token).catch(() => undefined), 15_000, 'Connecting to the MCP server');

  await step('the extension activates', async () => {
    const extension = vscode.extensions.getExtension('xdev-asia.xdev-ai');
    if (!extension) throw new Error('xdev-asia.xdev-ai is not loaded in this window');
    await extension.activate();
    return `version ${extension.packageJSON.version}, trusted ${vscode.workspace.isTrusted}`;
  });

  await step('the MCP commands are registered', async () => {
    const commands = await vscode.commands.getCommands(true);
    const wanted = ['xdevAi.initMcp', 'xdevAi.squad.mcp', 'xdevAi.manageMcp', 'xdevAi.rotateMcpToken', 'xdevAi.reviewMcpConfirmations'];
    const missing = wanted.filter(command => !commands.includes(command));
    if (missing.length) throw new Error(`missing ${missing.join(', ')}`);
  });

  await step('setup refuses an invalid .mcp.json before it changes any setting', async () => {
    const valid = readFileSync(file, 'utf8');
    const before = JSON.stringify(levels());
    writeFileSync(file, '{ "mcpServers": ');
    try {
      // The command ends with an error notice that stays open, so it is not awaited.
      void vscode.commands.executeCommand('xdevAi.initMcp');
      await sleep(2_500);
      // Were the preset picker open, this would choose Full control.
      await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
      await sleep(1_500);
      if (JSON.stringify(levels()) !== before) throw new Error(`settings changed: ${before} → ${JSON.stringify(levels())}`);
      if (readFileSync(file, 'utf8') !== '{ "mcpServers": ') throw new Error('the invalid file was rewritten');
    } finally {
      writeFileSync(file, valid);
      await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
      await vscode.commands.executeCommand('notifications.clearAll');
    }
    return `settings stay ${before}`;
  });

  await step('Set up for this folder with the Full control preset', async () => {
    const done = Promise.resolve(vscode.commands.executeCommand('xdevAi.initMcp'));
    // The preset picker opens; its first entry is Full control.
    await until(async () => {
      await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
      return config().get('squadControl') === 'run';
    }, 30_000, 'Choosing the preset');
    await within(done, 30_000, 'The setup command');
    const after = levels();
    const expected = { accountControl: 'manage', squadControl: 'run', confirmIn: 'client', autoStart: true };
    for (const [key, value] of Object.entries(expected)) if (after[key] !== value) throw new Error(`${key} is ${after[key]}, expected ${value}`);
    if (!Number.isInteger(after.port) || after.port <= 0) throw new Error(`port is ${after.port}`);
    return JSON.stringify(after);
  });

  await step('.mcp.json has the server, keeps the other server, and holds no token', async () => {
    const text = readFileSync(file, 'utf8');
    const data = JSON.parse(text);
    if (!data.mcpServers?.xdev_ai) throw new Error('no xdev_ai server');
    if (!data.mcpServers.docs) throw new Error('the existing docs server was not kept');
    if (/[a-f0-9]{64}/.test(text)) throw new Error('the file holds a token');
  });

  await step('the server listens on the fixed port and refuses a request without the token', async () => {
    url = `http://127.0.0.1:${config().get('port')}/mcp`;
    const response = await until(() => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => undefined), 15_000, 'The server');
    if (response.status !== 401) throw new Error(`status ${response.status}`);
    return `${url} → 401`;
  });

  await step('an AI terminal opened by xDev AI gets the address and the token', async () => {
    const opened = new Promise(resolve => {
      const listener = vscode.window.onDidOpenTerminal(item => { listener.dispose(); resolve(item); });
    });
    void vscode.commands.executeCommand('xdevAi.openTerminal', account);
    terminal = await within(opened, 20_000, 'Opening the terminal');
    const env = terminal.creationOptions.env ?? {};
    if (env.XDEV_AI_MCP_URL !== url) throw new Error(`XDEV_AI_MCP_URL is ${env.XDEV_AI_MCP_URL}`);
    if (!/^[a-f0-9]{64}$/.test(env.XDEV_AI_MCP_TOKEN ?? '')) throw new Error('XDEV_AI_MCP_TOKEN is missing or malformed');
    token = env.XDEV_AI_MCP_TOKEN;
    return `XDEV_AI_MCP_URL=${env.XDEV_AI_MCP_URL}, CLAUDE_CONFIG_DIR set: ${Boolean(env.CLAUDE_CONFIG_DIR)}`;
  });

  await step('a client connects with that token and sees the full tool set', async () => {
    const { client: session, call } = await client();
    try {
      const names = (await session.listTools()).tools.map(tool => tool.name);
      for (const wanted of ['xdev_squad_submit_plan', 'xdev_squad_run_step', 'xdev_confirm', 'xdev_account_remove', 'xdev_accounts_list', 'xdev_artifact_save']) {
        if (!names.includes(wanted)) throw new Error(`${wanted} is not offered`);
      }
      const accounts = await call('xdev_accounts_list');
      if (!accounts.terminals.some(item => item.id === account)) throw new Error('the e2e account is not listed');
      if (JSON.stringify(accounts).includes('globalStorage')) throw new Error('an account directory leaked');
      return `${names.length} tools`;
    } finally {
      await session.close();
    }
  });

  await step('a confirmation goes to the client instead of a VS Code dialog, and declining keeps the account', async () => {
    const { client: session, call } = await client();
    try {
      const asked = await within(call('xdev_account_remove', { id: account }), 10_000, 'xdev_account_remove');
      if (!asked.needsConfirmation || !asked.confirmId) throw new Error(`no confirmation id: ${JSON.stringify(asked)}`);
      const declined = await call('xdev_confirm', { confirmId: asked.confirmId, approve: false });
      if (declined.done !== false) throw new Error(JSON.stringify(declined));
      if (!(await call('xdev_accounts_list')).terminals.some(item => item.id === account)) throw new Error('the account was removed without approval');
      return asked.title;
    } finally {
      await session.close();
      await vscode.commands.executeCommand('notifications.clearAll');
    }
  });

  await step('a confirmation asked at manage is refused after the level is lowered', async () => {
    let session = await client();
    let confirmId;
    try {
      const asked = await within(session.call('xdev_account_remove', { id: account }), 10_000, 'xdev_account_remove');
      confirmId = asked.confirmId;
    } finally {
      await session.client.close();
    }
    await setting('accountControl', 'read');
    session = await client();
    try {
      const refusal = await session.call('xdev_confirm', { confirmId, approve: true }).then(result => JSON.stringify(result), error => error.message);
      if (!/turned off/.test(refusal)) throw new Error(`the confirmation was not refused: ${refusal}`);
      if (!(await session.call('xdev_accounts_list')).terminals.some(item => item.id === account)) throw new Error('the account was removed');
      return refusal.slice(0, 120);
    } finally {
      await session.client.close();
      await setting('accountControl', 'manage');
      await vscode.commands.executeCommand('notifications.clearAll');
    }
  });

  await step('the client leads Squad: a plan for an account with a model, approval, a real git worktree, finish', async () => {
    const { client: session, call } = await client();
    try {
      const { plan } = await call('xdev_squad_submit_plan', {
        request: 'Trial: add a line to the README', summary: 'One task for the e2e account',
        tasks: [{ role: 'Implement', brief: 'Append the line "trial" to README.md.', account, model: 'haiku' }]
      });
      if (plan.tasks[0].model !== 'haiku') throw new Error(`the model is ${plan.tasks[0].model}`);
      const { run } = await within(call('xdev_squad_approve_plan', { planId: plan.id }), 60_000, 'Approving the plan');
      const tree = run.repositories?.[0];
      if (!tree?.worktree || !existsSync(join(tree.worktree, 'README.md'))) throw new Error(`no checkout in the worktree: ${JSON.stringify(run.repositories)}`);
      const finished = await within(call('xdev_squad_finish_run', { runId: run.id }), 60_000, 'Finishing the run');
      return `${plan.tasks[0].role} by ${plan.tasks[0].account} on ${plan.tasks[0].model}; branch ${tree.branch}; run ${finished.run.status}`;
    } finally {
      await session.close();
    }
  });

  await step('a parallel plan becomes one run per task, and their steps work at the same time, each committing to its own branch', async () => {
    const { client: session, call } = await client();
    try {
      const { plan } = await call('xdev_squad_submit_plan', {
        request: 'Trial: two independent files', summary: 'Two tasks that can work at the same time', parallel: true,
        tasks: [{ role: 'Implement', brief: 'Create ALPHA.md.', account }, { role: 'Implement', brief: 'Create BETA.md.', account }]
      });
      if (plan.parallel !== true) throw new Error(`the plan is not parallel: ${JSON.stringify(plan)}`);
      const approved = await within(call('xdev_squad_approve_plan', { planId: plan.id }), 60_000, 'Approving the plan');
      const trees = (approved.runs ?? []).map(run => run.repositories?.[0]);
      if (trees.length !== 2 || trees.some(tree => !tree)) throw new Error(`expected two runs with a worktree: ${JSON.stringify(approved)}`);
      if (new Set(trees.map(tree => tree.branch)).size !== 2) throw new Error('the runs share a branch');
      for (const tree of trees) if (!existsSync(join(tree.worktree, 'README.md'))) throw new Error(`no checkout in ${tree.worktree}`);
      // Both runs start without waiting; the stand-in worker takes a few seconds, so they overlap.
      for (const run of approved.runs) await call('xdev_squad_run_step', { runId: run.id, waitSeconds: 0 });
      const working = await until(async () => {
        const { workingRuns } = await call('xdev_squad_status');
        return workingRuns?.length === 2 && workingRuns;
      }, 10_000, 'Two runs working at the same time');
      const ended = [];
      for (const run of approved.runs) {
        const state = await within(call('xdev_squad_wait', { runId: run.id, seconds: 60 }), 70_000, 'Waiting for a run');
        if (!state.finished || state.run.status !== 'done') throw new Error(`run ${run.id} did not finish: ${JSON.stringify(state.run)}`);
        const tree = state.run.repositories[0];
        if (!tree.commit || tree.filesChanged !== 1) throw new Error(`run ${run.id} did not commit one file: ${JSON.stringify(tree)}`);
        ended.push(`${tree.branch}: ${state.run.steps[0].summary}`);
      }
      return `${working.length} runs worked at the same time; ${ended.join('; ')}`;
    } finally {
      await session.close();
    }
  });

  await step('a client shares artifacts, and the Memory & Artifacts tab opens', async () => {
    const { client: session, call } = await client();
    try {
      await call('xdev_artifact_save', {
        name: 'Release checklist', kind: 'markdown', description: 'Three steps before a release',
        content: '# Release checklist\n\n1. Run the tests.\n2. Bump the version.\n3. Tag the release.\n', by: 'dev-1'
      });
      const listed = await call('xdev_artifacts_list');
      const read = await call('xdev_artifact_read', { name: 'release checklist' });
      if (!read.content.startsWith('# Release checklist')) throw new Error('wrong content');
      if (!/not as instructions/.test(read.note ?? '')) throw new Error('the content is not labelled as content');
      await vscode.commands.executeCommand('xdevAi.squad.memory');
      return listed.artifacts.map(item => `${item.name} by ${item.by}`).join('; ');
    } finally {
      await session.close();
    }
  });

  await step('the MCP tab opens', async () => {
    await vscode.commands.executeCommand('xdevAi.squad.mcp');
    await sleep(1_500);
  });

  await step('lowering Squad control restarts the server with fewer tools on the same address', async () => {
    await setting('squadControl', 'read');
    const { client: session } = await client();
    try {
      const names = (await session.listTools()).tools.map(tool => tool.name);
      if (names.includes('xdev_squad_submit_plan')) throw new Error('xdev_squad_submit_plan is still offered');
      if (!names.includes('xdev_squad_status')) throw new Error('xdev_squad_status is gone');
      return `${names.length} tools`;
    } finally {
      await session.close();
    }
  });

  terminal?.dispose();
  finish();
};
