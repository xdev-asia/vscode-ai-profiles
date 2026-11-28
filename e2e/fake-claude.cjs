// Stands in for Claude Code in the extension host tests. As a headless worker (`-p`) it reads the prompt from
// standard input, creates the file its task names ("Create NAME.md"), waits a moment so that parallel runs
// overlap, and reports like Claude Code does. Without `-p` it is the interactive CLI: it prints a line and ends.
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

if (!process.argv.includes('-p')) {
  console.log('stand-in for Claude Code');
  process.exit(0);
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  let task = '';
  try {
    task = String(JSON.parse(input).task ?? '');
  } catch {
    // Not a worker prompt; report without a file.
  }
  const file = /Create ([\w.-]+\.md)/.exec(task)?.[1];
  const emit = line => console.log(JSON.stringify(line));
  if (file) {
    emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: join(process.cwd(), file) } }] } });
    writeFileSync(join(process.cwd(), file), `${file}\n`);
  }
  setTimeout(() => {
    emit({
      type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0, num_turns: 1, session_id: `fake-${process.pid}`,
      structured_output: { status: 'done', summary: file ? `Created ${file}.` : 'Nothing to do.', files_changed: file ? [file] : [], tests: '', memory: [] }
    });
  }, Number(process.env.XDEV_E2E_WORK_MS ?? 3_000));
});
