import { roles, noteLimit, taskLimit, taskStatuses } from './squad';
import { chatPromptLimit } from './squad-chat';
import { skillDescriptionLimit, skillInstructionsLimit, skillNameLimit, squadTools } from './squad-customizations';
import { memoryTextLimit } from './squad-memory';
import { workflowBriefLimit, workflowOutputLimit, workflowStages } from './workflow';

/** The Squad webview page. Kept free of the VS Code API so tests can render it. */
export function squadPage({ cspSource, nonce, script, chatScript, workspaceScript, style }: {
  cspSource: string; nonce: string; script: string; chatScript: string; workspaceScript: string; style: string;
}): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource}; script-src 'nonce-${nonce}'">
  <link rel="stylesheet" href="${style}">
  <title>Squad</title>
</head>
<body>
  <header class="top">
    <h1>Workspace squad</h1>
    <nav aria-label="Squad views">
      <button type="button" id="show-chat" aria-pressed="true">Chat</button>
      <button type="button" id="show-roles" aria-pressed="false">Roles</button>
      <button type="button" id="show-workflow" aria-pressed="false">Workflow</button>
      <button type="button" id="show-customizations" aria-pressed="false">Skills &amp; Tools</button>
      <button type="button" id="show-memory" aria-pressed="false">Memory</button>
      <button type="button" id="show-project" aria-pressed="false">Project</button>
    </nav>
  </header>
  <main id="chat-panel">
    <section id="squad-board" class="squad-board" aria-label="Squad team"></section>
    <div id="chat-messages" role="log" aria-label="Squad conversation"></div>
    <section id="chat-plan" aria-labelledby="plan-title" hidden>
      <h2 id="plan-title">Lead's proposed tasks</h2>
      <ol id="chat-jobs"></ol>
      <label class="approver">Who approves each step <select id="plan-approver">
        <option value="human">You: start every step yourself</option>
        <option value="ai+human">AI reviews each step, you start the next</option>
        <option value="ai">AI: a passing review starts the next step</option>
      </select></label>
      <p id="plan-cost" class="subtle"></p>
      <div class="actions">
        <button type="button" id="approve-plan">Approve plan</button>
        <button type="button" id="discard-plan">Discard plan</button>
      </div>
    </section>
    <section id="chat-runs" aria-labelledby="runs-title" hidden>
      <h2 id="runs-title">Worker runs</h2>
      <p id="runs-metrics" class="metrics" hidden></p>
      <ol id="run-list" class="run-list"></ol>
    </section>
    <section id="chat-live" class="live" aria-label="Worker activity" hidden></section>
    <p id="chat-status" role="status">Loading squad…</p>
    <p id="chat-error" role="alert"></p>
    <div class="actions">
      <button type="button" id="chat-assign-all" class="primary" hidden></button>
      <button type="button" id="chat-add-profile" disabled>Add AI account</button>
      <div id="chat-terminal" class="actions" hidden>
        <select id="chat-terminal-role" aria-label="AI terminal role"></select>
        <button type="button" id="open-chat-terminal">Open terminal</button>
      </div>
      <button type="button" id="stop-chat" hidden>Stop run</button>
    </div>
    <form id="chat-composer">
      <label>Message <textarea id="chat-message" rows="2" maxlength="${chatPromptLimit}"
        placeholder="Ask Lead or address a role with @Review" required disabled></textarea></label>
      <button type="submit" id="send-chat" disabled>Send</button>
    </form>
  </main>
  <main id="roles-panel" hidden>
    <p id="summary" aria-live="polite">Loading squad…</p>
    <section aria-label="Squad roles" class="board">
      <div id="roles" class="roles" data-roles="${roles.join(',')}"></div>
      <section id="escalations" class="escalations" hidden>
        <h2>Needs attention</h2>
        <ul id="blockers"></ul>
      </section>
    </section>
    <section class="detail" aria-labelledby="seat-title">
      <h2 id="seat-title">Lead</h2>
      <p id="notice" role="status"></p>
      <form id="seat">
        <fieldset id="fields" disabled>
          <div class="assignment">
            <div class="profile-field">
              <label>Profile <select id="account"></select></label>
              <button type="button" id="assign-all" class="link" hidden>Use for all roles</button>
            </div>
            <label>Status <select id="status">${taskStatuses.map(status => `<option>${status}</option>`).join('')}</select></label>
          </div>
          <label>Task brief <textarea id="brief" rows="3" maxlength="${taskLimit}" placeholder="Describe the work and expected result"></textarea></label>
          <label id="blocker-field" hidden>Blocker <textarea id="blocker" rows="2" maxlength="${noteLimit}"></textarea></label>
          <div class="actions">
            <button type="submit" id="save" disabled>Save task</button>
            <button type="button" id="copy" hidden>Copy brief</button>
            <button type="button" id="terminal" hidden>Open terminal</button>
            <button type="button" id="usage" hidden>Check usage</button>
            <button type="button" id="run" hidden>Send to API</button>
          </div>
        </fieldset>
      </form>
      <button id="stop" type="button" hidden>Cancel API request</button>
      <p id="request-error" role="alert"></p>
      <details id="reply" hidden>
        <summary>Latest API response</summary>
        <pre id="response"></pre>
      </details>
      <details id="handoff" hidden>
        <summary>Hand off to another role</summary>
        <form id="handoff-form">
          <label>Recipient <select id="recipient"></select></label>
          <label>Note <textarea id="note" rows="2" maxlength="${noteLimit}" required></textarea></label>
          <button type="submit" id="send-note">Send handoff</button>
        </form>
      </details>
    </section>
    <details id="activity" class="activity">
      <summary>Recent activity</summary>
      <ol id="events"></ol>
    </details>
  </main>
  <main id="workflow-panel" class="workspace-panel" hidden>
    <ol id="workflow-stages" class="workflow-stages" aria-label="SDLC stages">${workflowStages.map(stage =>
      `<li data-stage="${stage.name}" data-role="${stage.role}" data-instruction="${stage.instruction}"><strong>${stage.name}</strong><small>${stage.role}</small></li>`
    ).join('')}</ol>
    <form id="workflow-start" class="detail" hidden>
      <label>Project brief <textarea id="workflow-brief" maxlength="${workflowBriefLimit}" rows="4" required
        placeholder="What should ship? Include scope and acceptance criteria."></textarea></label>
      <button type="submit" class="primary">Start workflow</button>
    </form>
    <section id="workflow-current" class="detail" hidden>
      <div class="workspace-heading"><h2 id="workflow-title"></h2><button type="button" id="workflow-reset">Reset workflow</button></div>
      <p id="workflow-instruction" class="subtle"></p>
      <details><summary>Project brief</summary><p id="workflow-project" class="preserve-lines"></p></details>
      <div class="actions" id="workflow-actions">
        <button type="button" id="workflow-draft" class="primary">Draft with AI</button>
        <button type="button" id="workflow-copy">Copy stage brief</button>
        <button type="button" id="workflow-stop" hidden>Stop run</button>
      </div>
      <form id="workflow-approve">
        <label>Stage result <textarea id="workflow-output" rows="5" maxlength="${workflowOutputLimit}" required
          placeholder="Review the AI draft or enter the result from your terminal."></textarea></label>
        <button type="submit" id="workflow-approve-button" class="primary">Approve stage</button>
      </form>
      <p id="workflow-status" class="subtle" role="status"></p>
    </section>
    <section id="workflow-results" class="detail" hidden><h2>Approved results</h2><div id="workflow-artifacts"></div></section>
    <p id="workflow-notice" class="workspace-notice" role="status">Loading workflow…</p>
  </main>
  <main id="customizations-panel" class="workspace-panel" hidden>
    <section class="detail">
      <div class="workspace-heading"><h2>Workspace skills</h2><button type="button" id="add-skill" class="primary" disabled>Add skill</button></div>
      <p class="subtle">Enabled skills go into AI SDLC drafts and, as Claude Code skills, into every Claude Code account. Workers load a skill only when its description matches the task.</p>
      <ul class="workspace-list" id="skills"></ul>
      <form id="skill-form" hidden>
        <label>Name <input id="skill-name" maxlength="${skillNameLimit}" required></label>
        <label>When to use <input id="skill-description" maxlength="${skillDescriptionLimit}"
          placeholder="One line. Claude reads this to decide when to load the skill."></label>
        <label>Instructions <textarea id="skill-instructions" rows="6" maxlength="${skillInstructionsLimit}" required></textarea></label>
        <label class="checkbox"><input id="skill-enabled" type="checkbox"> Enabled</label>
        <div class="actions"><button type="submit" class="primary">Save skill</button><button type="button" id="cancel-skill">Cancel</button></div>
      </form>
    </section>
    <section class="detail">
      <h2>Sync</h2>
      <p id="sync-profiles" class="subtle"></p>
      <p id="sync-folder" class="subtle"></p>
      <p id="sync-last" class="subtle"></p>
      <div class="actions">
        <button type="button" id="sync-now" class="primary">Sync with folder</button>
        <button type="button" id="sync-accounts">Copy skills to Claude accounts</button>
        <button type="button" id="squad-settings">Worker settings</button>
      </div>
    </section>
    <section class="detail">
      <h2>Copilot and MCP tools</h2>
      <p id="tool-hint" class="subtle"></p>
      <ul id="squad-tools" class="workspace-list">${Object.entries(squadTools).map(([id, tool]) =>
        `<li><label class="checkbox"><input type="checkbox" id="${id}" disabled> ${tool.name}</label><code>#${tool.reference}</code></li>`
      ).join('')}</ul>
      <div id="native-customizations" class="actions" hidden>
        <button type="button" id="native-skills">VS Code Skills</button>
        <button type="button" id="native-tools">VS Code Tools and MCP</button>
      </div>
    </section>
    <section class="detail">
      <h2>xDev AI MCP</h2>
      <div class="actions"><button type="button" id="manage-mcp">Manage MCP</button></div>
    </section>
    <p id="customizations-notice" class="workspace-notice" role="status"></p>
  </main>
  <main id="memory-panel" class="workspace-panel" hidden>
    <section class="detail">
      <h2>Shared memory</h2>
      <p class="subtle">Short facts every agent receives with its task: conventions, decisions, pitfalls. Workers add notes when they learn something durable. Pinned notes always fit in the prompt; others are newest first within a fixed budget.</p>
      <form id="memory-form" class="memory-form">
        <label>New note <input id="memory-text" maxlength="${memoryTextLimit}" required placeholder="e.g. API errors use the Problem Details format"></label>
        <button type="submit" id="memory-submit" class="primary">Add</button>
      </form>
      <ul id="memory-list" class="workspace-list"></ul>
    </section>
    <p id="memory-notice" class="workspace-notice" role="status"></p>
  </main>
  <main id="project-panel" class="workspace-panel" hidden>
    <section class="detail">
      <div class="workspace-heading"><h2 id="project-name">Project</h2><button type="button" id="project-edit">Edit project settings</button></div>
      <p class="subtle">Squad roles, runs, memory, and these settings belong to this project. Values set in the project's <code>.vscode/settings.json</code> are marked “project”; the rest come from your user settings or defaults.</p>
      <dl id="project-settings" class="project-settings"></dl>
    </section>
    <section class="detail">
      <div class="workspace-heading"><h2>MCP servers for workers</h2><button type="button" id="project-add-mcp" class="primary">Add server</button></div>
      <p class="subtle">Workers never load your own MCP servers. Only the servers listed here start, only their listed tools can be called, and AI reviews get none.</p>
      <ul id="project-mcp" class="workspace-list"></ul>
      <div class="actions"><button type="button" id="project-mcp-file" hidden>Open .mcp.json</button></div>
    </section>
    <section class="detail">
      <div class="workspace-heading"><h2>Storage</h2><button type="button" id="project-check">Check storage</button></div>
      <p id="project-disk" class="subtle"></p>
      <ul id="project-storage" class="workspace-list"></ul>
      <div class="actions"><button type="button" id="project-clean" class="primary">Clean up…</button></div>
    </section>
    <p id="project-notice" class="workspace-notice" role="status"></p>
  </main>
  <div id="squad-toast" class="toast" role="status" hidden></div>
  <script nonce="${nonce}" src="${chatScript}"></script>
  <script nonce="${nonce}" src="${workspaceScript}"></script>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}
