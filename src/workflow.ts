import type { Role } from './squad';

export const workflowStages = [
  { name: 'Plan', role: 'Lead', instruction: 'Define scope, acceptance criteria, dependencies, and delivery risks.' },
  { name: 'Implement', role: 'Implement', instruction: 'Describe the changes needed to implement the approved plan, with concrete examples where helpful.' },
  { name: 'Review', role: 'Review', instruction: 'Review the implementation for correctness and regressions. List findings and open questions.' },
  { name: 'Test', role: 'Tests', instruction: 'Describe test cases, expected results, and what still needs verification.' },
  { name: 'Release', role: 'Lead', instruction: 'Draft a Markdown changelog entry from the approved results. Group user-facing changes under Added, Changed, and Fixed as applicable. Include a release checklist, rollback steps, and any remaining blockers after the entry.' }
] as const satisfies ReadonlyArray<{ name: string; role: Role; instruction: string }>;

export const workflowBriefLimit = 4_000;
export const workflowOutputLimit = 8_000;

export interface Workflow {
  id: string;
  brief: string;
  approved: string[];
  draft?: string;
}

export function workflowStage(workflow: Workflow | undefined) {
  return workflow && workflowStages.at(workflow.approved.length);
}

export function workflowText(value: unknown, limit: number, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) {
    throw new Error(`Enter ${label} up to ${limit.toLocaleString('en')} characters.`);
  }
  return value.trim();
}
