// ⚙️ Settings' ⚡ Skip permission prompts, under Workers: whether workers may be hired to run without
// asking, for everyone (see server/skip-permissions.ts). Admins switch it; everyone else reads it.
import type { Net } from '../net';
import { providerNames } from '../../shared/providers';
import { store } from '../state';
import { h, timeAgo } from './dom';

export const SKIP_SETTING = 'Let workers skip permission prompts';

/**
 * The setting, made by `frame` from what goes in it: on and off as buttons (for an admin), and a note
 * saying what it does and what it risks. Kept up to date until `off`.
 */
export function skipPermissionsSetting(net: Net, frame: (body: Node[]) => HTMLElement): { section: HTMLElement; off: () => void } {
  const row = h('div.seg', { role: 'radiogroup', 'aria-label': SKIP_SETTING });
  const note = h('p.setting-note');
  const paint = () => {
    const { on, by, at } = store.skipPermissions;
    const admin = store.me.admin;
    row.classList.toggle('hidden', !admin);
    row.replaceChildren(
      ...([
        [false, '🛡️ Always ask'],
        [true, '⚡ Can skip them'],
      ] as const).map(([value, label]) =>
        h(
          'button.btn',
          {
            type: 'button',
            role: 'radio',
            'aria-checked': String(on === value),
            class: on === value ? 'on' : '',
            onclick: () => store.skipPermissions.on !== value && net.send({ t: 'skipPermissions.set', on: value }),
          },
          label,
        ),
      ),
    );
    const now = on
      ? `Whoever hires a ${providerNames((m) => !!m.skipsPermissions)} worker can tick ⚡ Skip permission prompts. That worker then runs any command on the office’s machine without asking anyone first, so give it its own git worktree. Board agents, meetings and the queue always ask.`
      : 'Every worker asks before it runs a command or edits a file, and the hire window doesn’t offer to skip that. Turned off, workers hired to skip their prompts ask again once they restart.';
    const set = by ? ` Set by ${by}${at ? ` ${timeAgo(at)}` : ''}.` : '';
    note.textContent = `${now}${set} --agent-args "--dangerously-skip-permissions" still makes every Claude Code worker skip them.${admin ? '' : ' Admins can change it.'}`;
  };
  paint();
  const offs = [store.on('skipPermissions', paint), store.on('me', paint)];
  return { section: frame([row, note]), off: () => offs.forEach((off) => off()) };
}
