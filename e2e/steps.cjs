// Shared by the suites that run inside the extension host.
const { join } = require('node:path');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Rejects when `promise` takes longer than `ms`. */
const within = (promise, ms, what) => Promise.race([promise, sleep(ms).then(() => { throw new Error(`${what} did not finish in ${ms / 1000}s`); })]);

/** Calls `check` until it returns a value, at most `ms`. */
async function until(check, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`${what} did not happen in ${ms / 1000}s`);
    await sleep(250);
  }
}

/** Runs named steps in order, prints each outcome, and fails the run at the end when any step failed. */
function steps() {
  const failures = [];
  return {
    async step(name, run) {
      try {
        const detail = await run();
        console.log(`PASS  ${name}${detail ? `\n      ${detail}` : ''}`);
      } catch (error) {
        failures.push(name);
        console.log(`FAIL  ${name}\n      ${String(error?.message ?? error)}`);
      }
    },
    finish() {
      if (failures.length) throw new Error(`${failures.length} step(s) failed: ${failures.join('; ')}`);
    }
  };
}

/** An MCP client for the server at `url`. The SDK is a development dependency of the repository. */
async function connect(url, token) {
  const sdk = join(process.env.XDEV_E2E_ROOT, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'cjs', 'client');
  const { Client } = require(join(sdk, 'index.js'));
  const { StreamableHTTPClientTransport } = require(join(sdk, 'streamableHttp.js'));
  const client = new Client({ name: 'e2e-lead', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) throw new Error(`${name}: ${result.content[0].text}`);
    return JSON.parse(result.content[0].text);
  };
  return { client, call };
}

module.exports = { connect, sleep, steps, until, within };
