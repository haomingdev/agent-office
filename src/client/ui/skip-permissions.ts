// ⚡ Skip permission prompts: the box in the hire window, and the badge a worker hired that way wears
// in its terminal and the workers list (see server/skip-permissions.ts). ⚙️ Settings' switch for it
// is settings-skip.ts.
import './skip-permissions.css';
import type { WorkerInfo } from '../../shared/protocol';
import { PROVIDER_META, skipsPermissions } from '../../shared/providers';
import { store } from '../state';
import { h } from './dom';
import type { ProviderPicker } from './provider';

/** What a worker hired to skip its permission prompts shows, small, next to its status. */
export const SKIP_BADGE = '⚡ skip permissions';
export const SKIP_TITLE = 'Hired to skip its permission prompts: it runs any command on the office’s machine without asking first';

/** The badge for a worker's terminal header: shown while `w` was hired to skip its permission prompts (see paint). */
export function skipBadge(): { element: HTMLElement; paint(w: Pick<WorkerInfo, 'skipPermissions'>): void } {
  const element = h('span.pill.skip-perms', { title: SKIP_TITLE }, SKIP_BADGE);
  return { element, paint: (w) => element.classList.toggle('hidden', !w.skipPermissions) };
}

/**
 * The hire window's box: shown while ⚙️ Settings lets workers skip their permission prompts and the
 * worker picked (`provider`) can, and ticked to start with. Its value is false whenever it isn't shown.
 */
export function skipPermissionsBox(provider: ProviderPicker): { element: HTMLElement; value(): boolean } {
  const box = h('input', { type: 'checkbox', id: 'skip-toggle' }) as HTMLInputElement;
  box.checked = true;
  const why = h('small');
  const element = h('label.skip-perms-row', { for: 'skip-toggle', title: SKIP_TITLE }, box, h('span', {}, '⚡ Skip permission prompts', why));
  const shown = () => store.skipPermissions.on && skipsPermissions(provider.value());
  const paint = () => {
    element.classList.toggle('hidden', !shown());
    why.textContent = `${PROVIDER_META[provider.value()].label} runs any command on the office’s machine without asking first. Give it its own worktree.`;
  };
  paint();
  // The worker picked, or ⚙️ Settings, can change while the window is open.
  provider.element.addEventListener('change', paint);
  provider.element.addEventListener('click', paint);
  const off = store.on('skipPermissions', () => (element.isConnected ? paint() : off()));
  return { element, value: () => shown() && box.checked };
}
