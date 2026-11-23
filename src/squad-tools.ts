import * as vscode from 'vscode';
import { chatPromptLimit, type SquadChat, type SquadChatEntry } from './squad-chat';
import type { squadTools } from './squad-customizations';
import { workflowStage, workflowStages } from './workflow';

interface AskInput {
  message: string;
}

interface PlanInput {
  action: 'view' | 'run' | 'discard';
  planId?: string;
}

interface WorkflowInput {
  action: 'view' | 'draft';
  workflowId?: string;
  step?: number;
}

type PendingPlan = NonNullable<ReturnType<SquadChat['pendingPlan']>>;

function result(text: string): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
}

function describePlan(plan: PendingPlan): string {
  const jobs = plan.jobs.map(({ role, profile, brief }) => `${role} (${profile})\n${brief}`);
  return `Pending plan ${plan.id}. No worker has started.\n\n${jobs.join('\n\n')}`;
}

function messageFrom(input: AskInput): string {
  const message = input?.message;
  if (typeof message !== 'string' || !message.trim() || message.length > chatPromptLimit) {
    throw new Error('Enter a Squad message of up to 8,000 characters.');
  }
  return message.trim();
}

function selectedPlan(squad: SquadChat, id: unknown): PendingPlan {
  const plan = squad.pendingPlan();
  if (!plan || id !== plan.id) throw new Error('This plan is no longer available. Use the view action to get the current plan.');
  return plan;
}

async function invoke(
  token: vscode.CancellationToken, task: (signal: AbortSignal) => Promise<string>
): Promise<vscode.LanguageModelToolResult> {
  const controller = new AbortController();
  const cancel = token.onCancellationRequested(() => controller.abort());
  if (token.isCancellationRequested) controller.abort();
  try {
    controller.signal.throwIfAborted();
    return result(await task(controller.signal));
  } catch (error) {
    if (controller.signal.aborted) throw new vscode.CancellationError();
    return result(error instanceof Error ? error.message : 'Unable to use xDev Squad.');
  } finally {
    cancel.dispose();
  }
}

/** With automatic plan approval, Squad chat tools run without confirmation dialogs. */
function autoApprove(): boolean {
  return vscode.workspace.getConfiguration('xdevAi.squad').get('planApproval', 'auto') === 'auto';
}

function formatReplies(entries: SquadChatEntry[]): string {
  return entries.map(({ author, profile, text }) => `${author}${profile ? ` (${profile})` : ''}\n${text}`).join('\n\n');
}

export function registerSquadTools(context: vscode.ExtensionContext, squad: SquadChat): string[] {
  const registered: string[] = [];
  if (typeof vscode.lm?.registerTool !== 'function') return registered;

  function register<Input>(name: keyof typeof squadTools, tool: vscode.LanguageModelTool<Input>): void {
    try {
      context.subscriptions.push(vscode.lm.registerTool(name, tool));
      registered.push(name);
    } catch (error) {
      console.warn(`[xDev AI] Could not register optional chat tool ${name}.`, error);
    }
  }

  register<AskInput>('xdev_squad_ask', {
    prepareInvocation({ input }) {
      squad.customizations.requireTool('xdev_squad_ask');
      if (autoApprove()) return { invocationMessage: 'Asking xDev Squad' };
      return {
        invocationMessage: 'Asking xDev Squad',
        confirmationMessages: {
          title: 'Send this message to xDev Squad?',
          message: new vscode.MarkdownString()
            .appendText('The assigned profile receives this message, recent Squad context, and shared memory.\n\n')
            .appendText(messageFrom(input))
        }
      };
    },
    invoke({ input }, token) {
      return invoke(token, async signal => {
        squad.customizations.requireTool('xdev_squad_ask');
        const run = await squad.send(messageFrom(input), signal);
        const replies = formatReplies(await run.finished);
        const plan = squad.pendingPlan();
        return plan ? `${replies}\n\n${describePlan(plan)}` : replies;
      });
    }
  });

  register<PlanInput>('xdev_squad_plan', {
    prepareInvocation({ input }) {
      squad.customizations.requireTool('xdev_squad_plan');
      if (input.action === 'view') return { invocationMessage: 'Reading the pending xDev Squad plan' };
      const plan = selectedPlan(squad, input.planId);
      if (autoApprove()) return { invocationMessage: input.action === 'run' ? 'Running the xDev Squad plan' : 'Discarding the xDev Squad plan' };
      return {
        invocationMessage: input.action === 'run' ? 'Running the xDev Squad plan' : 'Discarding the xDev Squad plan',
        confirmationMessages: {
          title: input.action === 'run' ? 'Approve this xDev Squad plan? Steps start only when you run them.' : 'Discard this xDev Squad plan?',
          message: new vscode.MarkdownString().appendText(describePlan(plan))
        }
      };
    },
    invoke({ input }, token) {
      return invoke(token, async signal => {
        squad.customizations.requireTool('xdev_squad_plan');
        if (input?.action === 'view') {
          const plan = squad.pendingPlan();
          return plan ? describePlan(plan) : 'There is no pending xDev Squad plan.';
        }
        if (input?.action !== 'run' && input?.action !== 'discard') throw new Error('Choose view, run, or discard.');
        const plan = selectedPlan(squad, input.planId);
        if (input.action === 'discard') {
          await squad.discard(plan.id);
          return 'The xDev Squad plan was discarded.';
        }

        const preview = plan.jobs.map(({ role, profile, brief, kind }) =>
          `${role} · ${profile}${kind === 'claude' ? ' · Claude Code worker' : ''}\n${brief.length <= 180 ? brief : brief.slice(0, 180) + '…'}`
        ).join('\n\n');
        const headless = plan.jobs.some(job => job.kind === 'claude');
        const approve = 'Approve plan';
        const choice = autoApprove() ? approve : await vscode.window.showWarningMessage('Approve this xDev Squad plan?', {
          modal: true,
          detail: `Nothing runs yet. You start, edit, or skip each step in xDev Squad → Chat → Worker runs.${headless
            ? ' Claude Code steps work in a new git worktree; nothing is pushed.' : ''}\n\n${preview}`
        }, approve);
        signal.throwIfAborted();
        if (choice !== approve) return 'The user declined the xDev Squad plan. The plan is still pending.';
        squad.customizations.requireTool('xdev_squad_plan');
        const started = Date.now();
        const run = await squad.approve(plan.id, signal, vscode.workspace.getConfiguration('xdevAi.squad').get('approver') ?? 'human');
        const approved = await run.finished;
        const record = autoApprove() ? squad.snapshot().runs?.find(candidate => candidate.status === 'active' && candidate.time >= started) : undefined;
        if (record) {
          const step = await squad.runStep(record.id, undefined, signal);
          return formatReplies([...approved, ...await step.finished]);
        }
        return `${formatReplies(approved)}\n\nThe plan is approved but no step has run. The user runs each step from xDev Squad → Chat → Worker runs.`;
      });
    }
  });

  register<WorkflowInput>('xdev_sdlc', {
    prepareInvocation({ input }) {
      squad.customizations.requireTool('xdev_sdlc');
      if (input?.action === 'view') return { invocationMessage: 'Reading the xDev SDLC stage' };
      const workflow = squad.snapshot().workflow;
      const stage = workflowStage(workflow);
      if (input?.action !== 'draft' || !workflow || !stage || workflow.id !== input.workflowId || workflow.approved.length !== input.step) {
        throw new Error('Use view to get the current workflow ID and step.');
      }
      return {
        invocationMessage: `Drafting SDLC ${stage.name}`,
        confirmationMessages: {
          title: `Draft ${stage.name} with ${stage.role}?`,
          message: new vscode.MarkdownString('The assigned API profile receives the project brief, approved results, and enabled workspace skills.')
        }
      };
    },
    invoke({ input }, token) {
      return invoke(token, async signal => {
        squad.customizations.requireTool('xdev_sdlc');
        if (input?.action === 'view') {
          const { workflow } = squad.snapshot();
          if (!workflow) return 'Start a workflow in xDev Squad → Workflow.';
          const stage = workflowStage(workflow);
          return stage
            ? `${stage.name} (${stage.role}) · ${workflow.approved.length}/${workflowStages.length} approved. Workflow ID ${workflow.id}. Step ${workflow.approved.length}. ${workflow.draft ? 'Draft available.' : 'No draft yet.'}`
            : `All ${workflowStages.length} stages are approved.`;
        }
        if (input?.action !== 'draft') throw new Error('Choose view or draft.');
        const run = await squad.draftStage(input.workflowId, input.step, signal);
        return `${formatReplies(await run.finished)}\n\nReview and approve the result in xDev Squad → Workflow.`;
      });
    }
  });
  return registered;
}
