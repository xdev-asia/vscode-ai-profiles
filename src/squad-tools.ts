import * as vscode from 'vscode';
import { chatPromptLimit, type SquadChat, type SquadChatEntry } from './squad-chat';
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

function formatReplies(entries: SquadChatEntry[]): string {
  return entries.map(({ author, profile, text }) => `${author}${profile ? ` (${profile})` : ''}\n${text}`).join('\n\n');
}

export function registerSquadTools(context: vscode.ExtensionContext, squad: SquadChat): void {
  if (typeof vscode.lm?.registerTool !== 'function') return;
  context.subscriptions.push(vscode.lm.registerTool<AskInput>('xdev_squad_ask', {
    prepareInvocation({ input }) {
      squad.customizations.requireTool('xdev_squad_ask');
      return {
        invocationMessage: 'Asking xDev Squad',
        confirmationMessages: {
          title: 'Send this message to xDev Squad?',
          message: new vscode.MarkdownString()
            .appendText('The assigned API profile receives this message and recent Squad context.\n\n')
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
  }));

  context.subscriptions.push(vscode.lm.registerTool<PlanInput>('xdev_squad_plan', {
    prepareInvocation({ input }) {
      squad.customizations.requireTool('xdev_squad_plan');
      if (input.action === 'view') return { invocationMessage: 'Reading the pending xDev Squad plan' };
      const plan = selectedPlan(squad, input.planId);
      return {
        invocationMessage: input.action === 'run' ? 'Running the xDev Squad plan' : 'Discarding the xDev Squad plan',
        confirmationMessages: {
          title: input.action === 'run' ? 'Send the approved tasks to their API profiles?' : 'Discard this xDev Squad plan?',
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

        const preview = plan.jobs.map(({ role, profile, brief }) =>
          `${role} · ${profile}\n${brief.length <= 180 ? brief : brief.slice(0, 180) + '…'}`
        ).join('\n\n');
        const approve = 'Approve and run';
        const choice = await vscode.window.showWarningMessage('Run this xDev Squad plan?', {
          modal: true,
          detail: `The original request and tasks will be sent to these API profiles.\n\n${preview}`
        }, approve);
        signal.throwIfAborted();
        if (choice !== approve) return 'The user declined the xDev Squad run. The plan is still pending.';
        squad.customizations.requireTool('xdev_squad_plan');
        const run = await squad.approve(plan.id, signal);
        return formatReplies(await run.finished);
      });
    }
  }));

  context.subscriptions.push(vscode.lm.registerTool<WorkflowInput>('xdev_sdlc', {
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
  }));
}
