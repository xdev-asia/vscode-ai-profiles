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
  description?: string;
  instructions: string;
  enabled: boolean;
}

interface Customizations {
  skills: Skill[];
  disabledTools: Tool[];
  /** Content hash of each skill (by name) at the last folder sync, for three-way merges. */
  syncBase?: Record<string, string>;
  lastSync?: { time: number; folder: string; summary: string };
}

const storageKey = 'squadCustomizations.v1';
export const skillNameLimit = 80;
export const skillInstructionsLimit = 8_000;
export const skillDescriptionLimit = 200;
export const skillLimit = 40;

export class SquadCustomizations {
  private writes = Promise.resolve();

  constructor(private readonly storage: Memento) {}

  read(): Customizations {
    return this.storage.get<Customizations>(storageKey) ?? { skills: [], disabledTools: [] };
  }

  /** Enabled skills for text API prompts, cut to a fixed character budget. */
  activeSkills(budget = 12_000): Pick<Skill, 'name' | 'instructions'>[] {
    let used = 0;
    return this.read().skills.filter(skill => skill.enabled).flatMap(({ name, instructions }) => {
      if (used + instructions.length > budget) return [];
      used += instructions.length;
      return [{ name, instructions }];
    });
  }

  enabledSkills(): Skill[] {
    return this.read().skills.filter(skill => skill.enabled);
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
    const description = typeof input.description === 'string' ? input.description.replace(/\s+/g, ' ').trim() : '';
    if (description.length > skillDescriptionLimit) throw new Error(`Keep the description under ${skillDescriptionLimit} characters.`);
    const enabled = input.enabled;
    return this.update(state => {
      if (state.skills.some(candidate => candidate.id !== input.id && candidate.name.toLowerCase() === name.toLowerCase())) {
        throw new Error('Another skill already uses this name.');
      }
      if (input.id) {
        const skill = state.skills.find(candidate => candidate.id === input.id);
        if (!skill) throw new Error('This skill is no longer available.');
        Object.assign(skill, { name, description, instructions, enabled });
      } else {
        if (state.skills.length >= skillLimit) throw new Error(`A workspace can store up to ${skillLimit} skills.`);
        state.skills.push({ id: randomUUID(), name, description, instructions, enabled });
      }
    });
  }

  /** Replaces the skill list after a folder sync and records the merge base. */
  applySync(skills: Skill[], syncBase: Record<string, string>, lastSync: Customizations['lastSync']): Promise<void> {
    return this.update(state => {
      state.skills = skills.slice(0, skillLimit);
      state.syncBase = syncBase;
      state.lastSync = lastSync;
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
