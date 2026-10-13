// ⚡ Skip permission prompts: a worker hired that way runs whatever it likes on the office's machine
// without asking anyone first (Claude Code's --dangerously-skip-permissions, and the like for the
// providers that have one, see PROVIDER_META.skipsPermissions). Only while an admin lets workers
// in ⚙️ Settings, and only a worker someone hires at a desk: never a board agent or a meeting's.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AgentProvider, SkipPermissionsState, WorkerKind } from '../shared/protocol.js';
import { providerMeta, skipsPermissions } from '../shared/providers.js';

/**
 * Whether workers may be hired to skip their permission prompts, set in ⚙️ Settings by an admin and
 * kept in .agent-office/skip-permissions.json. The same on every floor; off until someone turns it on.
 */
export class SkipPermissions {
  private saved?: Required<SkipPermissionsState>;
  private path: string;

  constructor(
    dataDir: string,
    private onState: (state: SkipPermissionsState) => void,
  ) {
    this.path = path.join(dataDir, 'skip-permissions.json');
    this.restore();
  }

  get on(): boolean {
    return this.saved?.on ?? false;
  }

  state(): SkipPermissionsState {
    return this.saved ? { ...this.saved } : { on: false };
  }

  set(on: boolean, by: string) {
    this.saved = { on, by, at: Date.now() };
    this.persist();
    this.onState(this.state());
  }

  private restore() {
    try {
      const s = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<SkipPermissionsState>;
      if (typeof s.on === 'boolean') this.saved = { on: s.on, by: typeof s.by === 'string' ? s.by : 'someone', at: typeof s.at === 'number' ? s.at : 0 };
    } catch {
      // never set: every worker asks
    }
  }

  private persist() {
    try {
      writeFileSync(this.path, JSON.stringify(this.saved ?? {}, null, 2), { mode: 0o600 });
    } catch {
      // disk issues shouldn't take the office down
    }
  }
}

/**
 * Why a worker can't be hired to skip its permission prompts: they're not let in ⚙️ Settings
 * (`allowed`), its provider has no way to, or it isn't at a desk of its own. Undefined when it can.
 */
export function skipPermissionsProblem(allowed: boolean, kind: WorkerKind, provider: AgentProvider | undefined, seat: { station?: unknown; room?: boolean }): string | undefined {
  if (!allowed) return 'Skipping permission prompts is turned off in ⚙️ Settings: an admin can turn it on';
  if (kind !== 'agent') return 'A shell has no permission prompts to skip';
  if (!skipsPermissions(provider)) return `${providerMeta(provider)?.name ?? 'That agent'} can't skip its permission prompts`;
  if (seat.station || seat.room) return 'Only a worker hired at a desk can skip its permission prompts';
  return undefined;
}
