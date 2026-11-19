import { randomUUID } from 'node:crypto';
import type { SecretStorage } from 'vscode';
import type { AccountConfig } from './core';

export interface Account extends AccountConfig {
  id: string;
  name: string;
  revision: string;
}

export type AccountSummary = Pick<Account, 'id' | 'name' | 'provider' | 'model'>;
type AccountInput = AccountConfig & { name: string };

interface AccountState {
  accounts: Account[];
  activeId?: string;
}

export const accountStorageKey = 'accounts.v1';

export function summarize({ id, name, provider, model }: Account): AccountSummary {
  return { id, name, provider, model };
}

export class Accounts {
  private writes: Promise<unknown> = Promise.resolve();

  constructor(private readonly secrets: SecretStorage) {}

  async read(): Promise<AccountState> {
    await this.writes;
    return this.load();
  }

  private async load(): Promise<AccountState> {
    const stored = await this.secrets.get(accountStorageKey);
    return stored ? JSON.parse(stored) as AccountState : { accounts: [] };
  }

  private write(change: (state: AccountState) => void): Promise<void> {
    const pending = this.writes.then(async () => {
      const state = await this.load();
      change(state);
      await this.secrets.store(accountStorageKey, JSON.stringify(state));
    });
    this.writes = pending.catch(() => undefined);
    return pending;
  }

  add(input: AccountInput): Promise<void> {
    return this.write(state => {
      const id = randomUUID();
      state.accounts.push({ ...input, id, revision: randomUUID() });
      state.activeId = id;
    });
  }

  select(id: string): Promise<void> {
    return this.write(state => {
      if (!state.accounts.some(account => account.id === id)) {
        throw new Error('Hồ sơ đã bị xóa.');
      }
      state.activeId = id;
    });
  }

  edit(id: string, input: Pick<AccountInput, 'name' | 'model' | 'apiKey'>): Promise<void> {
    return this.write(state => {
      const account = state.accounts.find(candidate => candidate.id === id);
      if (!account) {
        throw new Error('Hồ sơ đã bị xóa.');
      }
      account.name = input.name;
      if (account.model !== input.model || input.apiKey !== undefined) {
        account.revision = randomUUID();
      }
      account.model = input.model;
      account.apiKey = input.apiKey ?? account.apiKey;
    });
  }

  remove(id: string): Promise<void> {
    return this.write(state => {
      state.accounts = state.accounts.filter(account => account.id !== id);
      if (state.activeId === id) {
        state.activeId = state.accounts[0]?.id;
      }
    });
  }
}
