import '../boards.css';
import './jira.css';
import type { GhIssue } from '../../../shared/protocol';
import { assignedTo, assigneeChoices, priorityIcon, typeIcon, type AssigneeFilter } from '../../../shared/jira';
import type { Net } from '../../net';
import { store } from '../../state';
import { card, queueChip } from '../board-cards';
import { h, openModal, timeAgo } from '../dom';
import { labelChip } from '../github/labels';
import { avatar } from '../github/pieces';
import { pref, savePref } from '../github/prefs';
import type { BoardActions } from '../github/prompts';
import { openTicket } from './ticket';

// ---- The Jira board ------------------------------------------------------------------------------
// Every floor's issues board, once ⚙️ Settings points the office at a Jira board: the board's own
// columns, its tickets on them, narrowed to whoever they're assigned to and by what they say.

/** Who the board shows, kept in this browser: everyone's, the unassigned ones, or one person's. */
const WHO_KEY = 'agent-office.jira-assignee';
/** Whether the board is split into a row per assignee. */
const LANES_KEY = 'agent-office.jira-lanes';

/** CHAT-123 as a card's number: the prefix it's shown after, and the number. */
function keyParts(key: string): [string, number] {
  const at = key.lastIndexOf('-');
  return [key.slice(0, at + 1), Number(key.slice(at + 1))];
}

/** Who a ticket's assigned to, for its card. */
export function assigneeChip(it: GhIssue): Node {
  const a = it.jira?.assignee;
  if (!a) return h('span.jira-who.none', {}, it.taken ? '🤖 handed to a worker' : 'Unassigned');
  return h('span.jira-who', { title: `Assigned to ${a.name}` }, avatar(a.name), a.name);
}

function ticketCard(it: GhIssue, i: number, open: () => void): HTMLElement {
  const j = it.jira!;
  const [prefix, n] = keyParts(j.key);
  const prio = priorityIcon(j.priority);
  return card(
    n,
    it.title,
    [
      h('span', { title: j.type }, `${typeIcon(j.type)} ${j.type}`),
      prio ? h('span', { title: `${j.priority} priority` }, prio) : '',
      ...it.labels.slice(0, 3).map(labelChip),
      queueChip(it.number),
      assigneeChip(it),
      timeAgo(it.updatedAt),
    ],
    i,
    open,
    undefined,
    prefix,
  );
}

export function openJiraBoard(net: Net, actions: BoardActions) {
  // Who you are in Jira, for "Me".
  net.send({ t: 'jira.get' });
  let who = pref<AssigneeFilter>(WHO_KEY, 'all');
  let lanes = pref<boolean>(LANES_KEY, false);
  const body = h('div.body.jira-board');
  const status = h('span.board-status');
  const picker = h('select.jira-pick', { 'aria-label': 'Show the tickets assigned to', title: 'Show the tickets assigned to' }) as HTMLSelectElement;
  const search = h('input.jira-search', { type: 'search', placeholder: 'Filter by key or title…', 'aria-label': 'Filter the board by key or title', spellcheck: 'false', autocomplete: 'off' }) as HTMLInputElement;
  const lanesBtn = h('button.btn', { type: 'button', title: 'A row for each person the tickets are assigned to' }, '🏊 By assignee') as HTMLButtonElement;
  const refresh = h('button.btn', { type: 'button', title: 'Look at Jira again', onclick: () => net.send({ t: 'jira.refresh' }) }, '🔄 Refresh');
  const link = h('a.btn.jira-open', { target: '_blank', rel: 'noopener noreferrer' }, 'Open in Jira ↗') as HTMLAnchorElement;
  const close = h('button.btn.close', { 'aria-label': 'Close' }, '✕');
  const title = h('h2');
  const el = h('div.modal.board.jira', { role: 'dialog', 'aria-label': 'Jira board' }, h('header', {}, title, status, h('div.jira-tools', {}, picker, search, lanesBtn, link, refresh), close), body);

  const tickets = () => store.issues.items.filter((i) => i.jira);
  const paintStatus = () => {
    const st = store.issues;
    status.textContent = st.loading ? 'Refreshing…' : st.fetchedAt ? `Updated ${timeAgo(st.fetchedAt)}` : '';
  };

  /** The filter's choices, with how many tickets each shows; a person who's no longer on the board falls back to everyone. */
  const paintPicker = () => {
    const choices = assigneeChoices(tickets(), store.jiraYou?.accountId);
    if (!choices.some((c) => c.value === who)) who = 'all';
    picker.replaceChildren(...choices.map((c) => h('option', { value: c.value, selected: c.value === who }, `${c.label} (${c.count})`)));
    picker.value = who;
  };

  /** A column of the board, with the tickets on it that pass the filters. */
  const column = (i: number, items: GhIssue[]) => {
    const col = store.jira.columns[i];
    const ul = h('ul', {}, ...items.map((it, n) => ticketCard(it, n, () => openTicket(it, net, actions))));
    if (!items.length) ul.append(h('li.empty', {}, 'Nothing here'));
    const note = col.done ? h('small.jira-note', { title: 'Finished tickets updated in the last two weeks' }, 'recent') : null;
    return h('section.column', { class: col.todo ? 'todo' : col.done ? 'done' : '' }, h('h4', {}, h('div.col-head', {}, h('span', {}, col.name, ' ', note), h('span.col-count', {}, String(items.length)))), ul);
  };

  /** The columns, each with the tickets from `items` on it. */
  const columns = (items: GhIssue[]) => store.jira.columns.map((_, i) => column(i, items.filter((t) => t.jira!.column === i)));

  const render = () => {
    const j = store.jira;
    title.textContent = `📌 ${j.name ?? 'Jira board'}`;
    link.href = j.url ?? j.site ?? 'https://www.atlassian.com/software/jira';
    lanesBtn.setAttribute('aria-pressed', String(lanes));
    lanesBtn.classList.toggle('on', lanes);
    paintStatus();
    paintPicker();
    // Every refresh rebuilds the board: put each column's scroll back after.
    const scrolled = [...body.querySelectorAll('.column > ul')].map((ul) => ul.scrollTop);
    const { scrollLeft, scrollTop } = body;
    body.replaceChildren();
    body.classList.toggle('lanes', lanes);
    const st = store.issues;
    const all = tickets();
    if (st.error && !all.length) {
      body.append(h('div.board-error', {}, `Couldn't load the Jira board: ${st.error}`));
      return;
    }
    if (!j.columns.length) {
      body.append(h('div.board-error', {}, st.loading || !st.fetchedAt ? 'Loading the board from Jira…' : 'The board has no columns yet.'));
      return;
    }
    const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
    const shown = all.filter((t) => assignedTo(t, who) && words.every((w) => t.title.toLowerCase().includes(w) || t.jira!.key.toLowerCase().includes(w)));
    if (!lanes) body.append(...columns(shown));
    else {
      // A row per person, most tickets first, then the unassigned ones.
      const people = new Map<string, { name: string; items: GhIssue[] }>();
      for (const t of shown) {
        const a = t.jira!.assignee;
        const id = a?.accountId ?? '';
        const p = people.get(id) ?? { name: a?.name ?? 'Unassigned', items: [] };
        p.items.push(t);
        people.set(id, p);
      }
      const rows = [...people].sort(([a, x], [b, y]) => Number(!a) - Number(!b) || y.items.length - x.items.length);
      for (const [id, p] of rows) body.append(h('div.jira-lane', {}, h('h3', {}, id ? avatar(p.name) : null, p.name, h('small', {}, ` · ${p.items.length}`)), h('div.jira-lane-cols', {}, ...columns(p.items))));
      if (!rows.length) body.append(h('div.board-error', {}, 'No tickets match.'));
    }
    body.querySelectorAll('.column > ul').forEach((ul, i) => (ul.scrollTop = scrolled[i] ?? 0));
    body.scrollLeft = scrollLeft;
    body.scrollTop = scrollTop;
  };

  picker.addEventListener('change', () => {
    who = picker.value;
    savePref(WHO_KEY, who);
    render();
  });
  search.addEventListener('input', render);
  lanesBtn.addEventListener('click', () => {
    lanes = !lanes;
    savePref(LANES_KEY, lanes);
    render();
  });
  const unsubs = [store.on('issues', render), store.on('jira', render), store.on('jiraYou', render), store.on('queue', render)];
  const timer = setInterval(paintStatus, 15000);
  const modal = openModal(el, {
    doing: '📌 at the Jira board',
    onClose: () => {
      unsubs.forEach((u) => u());
      clearInterval(timer);
    },
  });
  close.addEventListener('click', () => modal.close());
  render();
}
