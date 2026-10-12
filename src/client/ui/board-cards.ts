// The pieces of a board's cards (see boards.ts, and the Jira board in jira/board.ts): the note itself,
// and the chips for the queue and the desk an issue or a pull request is at.
import type { WorkerInfo } from '../../shared/protocol';
import { store } from '../state';
import { h } from './dom';
import { prName } from './forge';
import { providerLabel } from './provider';

export const TILTS = ['-1.2deg', '0.8deg', '-0.4deg', '1.4deg', '0deg', '-0.9deg'];
export const NOTE_COLORS = ['#fff7b0', '#ffd6e0', '#caffbf', '#bde0fe', '#ffe5b4'];

/** A chip naming a worker and desk, color-coded to match the worker back on the floor. */
export function workerChip(w: WorkerInfo, title: string) {
  return h('span.desk-link', { style: `--dot:${w.color}`, title }, `🪑 ${w.name} · ${store.plan().byId.get(w.deskId)?.label ?? 'a desk'}`);
}

/** Where an issue stands on the 📋 queue, for its card. */
export function queueChip(issue: number): Node | '' {
  const t = store.taskForIssue(issue);
  if (!t) return '';
  const provider = providerLabel(t.provider, store.project);
  if (t.status === 'queued') return h('span.qchip', {}, `${store.queue.tasks.find((x) => x.status === 'queued') === t ? '📋 up next' : '📋 queued'} · ${provider}`);
  if (t.status === 'running') {
    const w = t.workerId ? store.workers.get(t.workerId) : undefined;
    if (w) return workerChip(w, `${w.name} is working on this at ${store.plan().byId.get(w.deskId)?.label ?? 'a desk'} · ${provider}`);
    return h('span.qchip.running', {}, `🤖 ${t.workerName ?? 'a worker'} · ${provider}`);
  }
  return t.pr ? h('span.qchip.done', {}, `🔀 ${prName(t.pr.number)} · ${provider}`) : '';
}

/**
 * A card on a board. `ref` is what comes before the number: # for an issue, the floor's for a pull
 * request (# or !), the project's key for a Jira ticket (CHAT-). Without `onLabels` it has no 🏷️.
 */
export function card(n: number, title: string, meta: (Node | string)[], i: number, onclick: () => void, onLabels?: () => void, ref = '#') {
  return h(
    'li.card',
    {
      style: `--tilt:${TILTS[n % TILTS.length]};background:${NOTE_COLORS[n % NOTE_COLORS.length]};--pin:${['#ef476f', '#118ab2', '#06d6a0', '#ffd166'][i % 4]}`,
      tabindex: 0,
      onclick,
      onkeydown: ((e: KeyboardEvent) => e.key === 'Enter' && e.target === e.currentTarget && onclick()) as EventListener,
    },
    onLabels ? h('button.card-labels', { type: 'button', title: 'Change the labels', 'aria-label': `Change the labels on ${ref}${n}`, onclick: ((e: Event) => (e.stopPropagation(), onLabels())) as EventListener }, '🏷️') : null,
    h('div.num', {}, `${ref}${n}`),
    h('div.ttl', {}, title),
    h('div.meta', {}, ...meta.filter((m) => m !== '').map((m) => (typeof m === 'string' ? h('span', {}, m) : m))),
  );
}
