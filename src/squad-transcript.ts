import { readFile, stat } from 'node:fs/promises';
import { describeTool } from './squad-worker';

export type TranscriptKind = 'prompt' | 'text' | 'tool' | 'result' | 'error';

/** One thing a worker was told, said, or did in a Claude Code session. */
export interface TranscriptItem {
  kind: TranscriptKind;
  text: string;
  time?: number;
}

const textLimit = 6_000;
const resultLimit = 2_000;
/** A session file larger than this is not read into memory. */
const fileLimit = 40 * 1024 * 1024;

const clip = (text: string, limit: number) => text.length > limit ? `${text.slice(0, limit)}\n… (${(text.length - limit).toLocaleString('en-US')} more characters)` : text;

function blockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => part && typeof part === 'object' && (part as { type?: unknown }).type === 'text' ? String((part as { text?: unknown }).text ?? '') : '').filter(Boolean).join('\n');
}

/**
 * Reads the lines of a Claude Code session file (JSON Lines) as a transcript: what the worker was asked, what
 * it said, each tool it called, and what failed. Thinking, bookkeeping lines, and the work of sub-agents are
 * left out. File paths are shown relative to `cwd`, the worktree.
 */
export function parseTranscript(text: string, cwd: string): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  /** Tool calls that are not listed, so their results are not listed either. */
  const unlisted = new Set<string>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!entry || (entry.type !== 'user' && entry.type !== 'assistant') || entry.isSidechain || entry.isMeta) continue;
    const stamp = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
    const time = Number.isFinite(stamp) ? { time: stamp } : {};
    const content = (entry.message as { content?: unknown } | undefined)?.content;
    const add = (kind: TranscriptKind, value: string, limit: number) => {
      const trimmed = value.trim();
      if (trimmed) items.push({ kind, text: clip(trimmed, limit), ...time });
    };
    if (typeof content === 'string') {
      add(entry.type === 'user' ? 'prompt' : 'text', content, textLimit);
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const block of content as Record<string, unknown>[]) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text') {
        // Claude Code writes this line itself after a report; it says nothing about the work.
        if (String(block.text ?? '').trim() !== 'No response requested.') add(entry.type === 'user' ? 'prompt' : 'text', String(block.text ?? ''), textLimit);
      } else if (block.type === 'tool_use') {
        const call = describeTool(block.name, block.input, cwd);
        if (call) add('tool', `${call.kind}: ${call.text}`, 600);
        // The report itself is a tool call; its content is the step's summary, shown elsewhere.
        else if (typeof block.id === 'string') unlisted.add(block.id);
      } else if (block.type === 'tool_result' && !unlisted.has(String(block.tool_use_id))) {
        add(block.is_error ? 'error' : 'result', blockText(block.content), resultLimit);
      }
    }
  }
  return items;
}

export async function readTranscript(file: string, cwd: string): Promise<TranscriptItem[]> {
  const info = await stat(file).catch(() => undefined);
  if (!info) throw new Error('The transcript of this session is no longer on disk.');
  if (info.size > fileLimit) throw new Error('The transcript of this session is too large to show. Resume the session in a terminal instead.');
  return parseTranscript(await readFile(file, 'utf8'), cwd);
}

const headings: Record<TranscriptKind, string> = { prompt: 'Asked', text: 'Worker', tool: 'Tool', result: 'Result', error: 'Failed' };

/** The transcript as a Markdown document for the editor. Tool results are folded into code blocks. */
export function transcriptMarkdown(title: string, items: readonly TranscriptItem[]): string {
  const fence = (text: string) => {
    // A fence longer than any run of backticks inside the text, so the text cannot close it.
    const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map(match => match[0].length));
    const marks = '`'.repeat(longest + 1);
    return `${marks}text\n${text}\n${marks}`;
  };
  const parts = items.map(item => {
    if (item.kind === 'tool') return `- \`${item.text.replace(/`/g, '\'')}\``;
    if (item.kind === 'result' || item.kind === 'error') return `**${headings[item.kind]}**\n\n${fence(item.text)}`;
    return `### ${headings[item.kind]}\n\n${item.kind === 'prompt' ? fence(item.text) : item.text}`;
  });
  return `# ${title}\n\n${items.length ? parts.join('\n\n') : 'This session has no messages.'}\n`;
}
