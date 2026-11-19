import { randomUUID } from 'node:crypto';
import type { Memento } from 'vscode';
import { workflowText } from './workflow';

export const squadTools = {
  xdev_squad_ask: { name: 'Ask xDev Squad', reference: 'xdevSquadAsk' },
  xdev_squad_plan: { name: 'Manage xDev Squad Plan', reference: 'xdevSquadPlan' },
  xdev_sdlc: { name: 'xDev SDLC Workflow', reference: 'xdevSdlc' }
} as const;
type Tool = keyof typeof squadTools;

export interface Skill {
  id: string;
  name: string;
  instructions: string;
  enabled: boolean;
}

interface Customizations {
  skills: Skill[];
  disabledTools: Tool[];
}

const storageKey = 'squadCustomizations.v1';
export const skillNameLimit = 80;
export const skillInstructionsLimit = 2_000;
const skillLimit = 12;

export class SquadCustomizations {
  private writes = Promise.resolve();

  constructor(private readonly storage: Memento) {}

  read(): Customizations {
    return this.storage.get<Customizations>(storageKey) ?? { skills: [], disabledTools: [] };
  }

  activeSkills(): Pick<Skill, 'name' | 'instructions'>[] {
    return this.read().skills.filter(skill => skill.enabled).map(({ name, instructions }) => ({ name, instructions }));
  }

  requireTool(tool: Tool): void {
    if (this.read().disabledTools.includes(tool)) {
      throw new Error(`${squadTools[tool].name} is disabled in this workspace. Open xDev Squad → Skills & Tools to enable it.`);
    }
  }

  setTool(id: unknown, enabled: unknown): Promise<void> {
    if (typeof id !== 'string' || !Object.hasOwn(squadTools, id) || typeof enabled !== 'boolean') {
      throw new Error('Choose an xDev tool.');
    }
    const tool = id as Tool;
    return this.update(state => {
      state.disabledTools = state.disabledTools.filter(candidate => candidate !== tool);
      if (!enabled) state.disabledTools.push(tool);
    });
  }

  saveSkill(input: Record<string, unknown>): Promise<void> {
    const name = workflowText(input.name, skillNameLimit, 'a skill name');
    const instructions = workflowText(input.instructions, skillInstructionsLimit, 'skill instructions');
    if (/[\r\n]/.test(name) || typeof input.enabled !== 'boolean') throw new Error('Enter a single-line skill name.');
    const enabled = input.enabled;
    return this.update(state => {
      if (input.id) {
        const skill = state.skills.find(candidate => candidate.id === input.id);
        if (!skill) throw new Error('This skill is no longer available.');
        Object.assign(skill, { name, instructions, enabled });
      } else {
        if (state.skills.length >= skillLimit) throw new Error(`A workspace can store up to ${skillLimit} skills.`);
        state.skills.push({ id: randomUUID(), name, instructions, enabled });
      }
    });
  }

  removeSkill(id: unknown): Promise<void> {
    return this.update(state => { state.skills = state.skills.filter(skill => skill.id !== id); });
  }

  private update(change: (state: Customizations) => void): Promise<void> {
    const pending = this.writes.then(async () => {
      const state = structuredClone(this.read());
      change(state);
      await this.storage.update(storageKey, state);
    });
    this.writes = pending.catch(() => undefined);
    return pending;
  }
}
