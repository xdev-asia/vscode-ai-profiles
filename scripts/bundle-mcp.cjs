const { build } = require('esbuild');
const { readFile, writeFile } = require('node:fs/promises');
const { join } = require('node:path');

async function main() {
  const outfile = 'dist/mcp-transport.js';
  const { metafile } = await build({
    entryPoints: ['src/mcp-transport.ts'], outfile, bundle: true, platform: 'node', target: 'node20',
    minify: true, metafile: true, legalComments: 'eof'
  });
  const dependencies = new Set();
  for (const input of Object.keys(metafile.outputs[outfile].inputs)) {
    const pkg = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input);
    if (pkg) dependencies.add(pkg[1]);
  }
  const notices = await Promise.all([...dependencies].sort().map(async directory => {
    const license = await readFile(join(directory, 'LICENSE'), 'utf8');
    return `${directory.split('node_modules/').at(-1)}\n\n${license.trim()}`;
  }));
  await writeFile(`${outfile}.LICENSE.txt`, notices.join('\n\n---\n\n') + '\n');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
