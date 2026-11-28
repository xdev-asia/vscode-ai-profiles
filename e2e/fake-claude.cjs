// Stands in for Claude Code in the extension host tests. As a headless worker (`-p`) it reads the prompt from
// standard input and reports like Claude Code does:
// - a task "Create NAME.md" creates that file, after a moment so that parallel runs overlap;
// - a task "Set NAME.md to WORD" writes WORD to that file, so two such tasks conflict;
// - a prompt with "merge" resolves the open merge by keeping both sides of each conflicting file;
// - a task with "Ask first" reports "blocked" with a question, and the answer creates ANSWER.md.
// Without `-p` it is the interactive CLI: it prints a line and ends.
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

if (!process.argv.includes('-p')) {
  console.log('stand-in for Claude Code');
  process.exit(0);
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  let prompt = {};
  try {
    prompt = JSON.parse(input) ?? {};
  } catch {
    // Not a worker prompt; report without a file.
  }
  const task = String(prompt.task ?? '');
  const emit = line => console.log(JSON.stringify(line));
  const report = (output, delay) => setTimeout(() => emit({
    type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0, num_turns: 1, session_id: `fake-${process.pid}`,
    structured_output: { files_changed: [], tests: '', memory: [], ...output }
  }), delay);
  const create = (file, content) => {
    emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: join(process.cwd(), file) } }] } });
    writeFileSync(join(process.cwd(), file), `${content}\n`);
  };

  if (prompt.merge) {
    const files = prompt.merge.conflicting_files ?? [];
    for (const file of files) {
      const path = join(process.cwd(), file);
      emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: path } }] } });
      writeFileSync(path, readFileSync(path, 'utf8').split('\n').filter(line => !/^(<{7}|={7}|>{7})/.test(line)).join('\n'));
    }
    report({ status: 'done', summary: `Resolved the conflicts in ${files.join(', ')} by keeping both sides.`, files_changed: files }, 300);
    return;
  }
  if (typeof prompt.answer === 'string') {
    create('ANSWER.md', prompt.answer);
    report({ status: 'done', summary: `Wrote the answer to ANSWER.md (continuing ${process.argv.includes('--resume') ? 'the earlier session' : 'in a new session'}).`, files_changed: ['ANSWER.md'] }, 300);
    return;
  }
  if (/Ask first/.test(task)) {
    report({ status: 'blocked', summary: 'I need one fact first.', question: 'What should ANSWER.md say?' }, 300);
    return;
  }
  const set = /Set ([\w.-]+\.md) to (\w+)/.exec(task);
  if (set) {
    create(set[1], set[2]);
    report({ status: 'done', summary: `Set ${set[1]} to ${set[2]}.`, files_changed: [set[1]] }, 300);
    return;
  }
  const file = /Create ([\w.-]+\.md)/.exec(task)?.[1];
  if (file) create(file, file);
  report({ status: 'done', summary: file ? `Created ${file}.` : 'Nothing to do.', files_changed: file ? [file] : [] }, Number(process.env.XDEV_E2E_WORK_MS ?? 3_000));
});
