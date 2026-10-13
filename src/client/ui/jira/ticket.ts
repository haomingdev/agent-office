import '../github/windows.css';
import './jira.css';
import type { GhComment, GhIssue, JiraPerson, JiraTicket } from '../../../shared/protocol';
import { JIRA_COMMENT_MAX } from '../../../shared/protocol';
import { priorityIcon, typeIcon } from '../../../shared/jira';
import type { Net } from '../../net';
import { store } from '../../state';
import { h, openModal, timeAgo } from '../dom';
import { getJson } from '../github/api';
import { labelChip } from '../github/labels';
import { avatar, errorBox, nodes, spinnerRow, when } from '../github/pieces';
import { DRAFT_KEY, pref, savePref } from '../github/prefs';
import type { BoardActions } from '../github/prompts';
import { markdown } from '../markdown';
import { providerPicker } from '../provider';
import { openSignIns } from '../signins';
import { ticketContext, ticketMeeting, ticketPrompt } from './prompts';

// ---- The ticket window ---------------------------------------------------------------------------
// A ticket on the Jira board: what it says and what's been said on it, moving it on, assigning it and
// commenting (each as you, with your own Jira sign-in), and handing it to a worker like an issue.

/** Jira's text as Markdown, without GitHub's links for #12 and @name, which mean nothing here. */
function ticketMarkdown(src: string): HTMLElement {
  const el = markdown(src);
  for (const a of el.querySelectorAll('a.mention, a.ref')) a.replaceWith(a.textContent ?? '');
  return el;
}

function commentCard(c: GhComment, verb: string): HTMLElement {
  return h('article.gh-card', {}, h('header', {}, avatar(c.author), h('b', {}, c.author), h('span', {}, verb), when(c.createdAt, c.url)), ticketMarkdown(c.body));
}

const PILL: Record<string, string> = { new: 'idle', indeterminate: 'working', done: 'done' };

/** Why you can't change the ticket from here yet, and where to fix that; '' when you can. */
function signInNote(): string {
  const you = store.jiraYou;
  if (!you || you.status === 'ok') return '';
  return you.office ? "The office has no Jira token yet: add one in ⚙️ Settings → Building → Jira to move, assign and comment from here." : 'Sign in to Jira (☰ → 🔐 Your sign-ins) to move, assign and comment as you.';
}

export function openTicket(first: GhIssue, net: Net, actions: BoardActions) {
  let it = first;
  const key = it.jira!.key;
  let detail: JiraTicket | null = null;
  let error = '';
  /** What you asked the office to do and haven't heard back about. */
  let busy: 'move' | 'assign' | 'comment' | null = null;
  let timer = 0;
  if (!store.jiraYou) net.send({ t: 'jira.get' });

  const close = h('button.btn.close', { 'aria-label': 'Close' }, '✕');
  const pill = h('span.pill');
  const heading = h('h2', { title: it.title });
  const meta = h('div.gh-meta');
  const thread = h('div.gh-items');
  const result = h('div.gh-merge-result.hidden');

  // Move it on: where it can go from here, as Jira says for you.
  const moveTo = h('select', { 'aria-label': 'Move it to' }) as HTMLSelectElement;
  const moveBtn = h('button.btn', { type: 'button' }, 'Move') as HTMLButtonElement;
  // Assign it: to you, to a teammate you look up, or to nobody.
  const mine = h('button.btn', { type: 'button' }, '🙋 Assign to me') as HTMLButtonElement;
  const unassign = h('button.btn', { type: 'button' }, 'Unassign') as HTMLButtonElement;
  const find = h('input', { type: 'search', placeholder: 'Assign to a teammate…', 'aria-label': 'Find a teammate to assign it to', autocomplete: 'off', spellcheck: 'false' }) as HTMLInputElement;
  const found = h('div.jira-found');
  const note = h('p.jira-signin.hidden');
  const signIn = h('button.btn.small.hidden', { type: 'button', onclick: () => openSignIns(net, 'Sign in to Jira to change tickets as you.') }, '🔐 Sign in to Jira') as HTMLButtonElement;
  const controls = h(
    'section.jira-controls',
    {},
    h('div.jira-row', {}, h('b', {}, 'Status'), moveTo, moveBtn),
    h('div.jira-row', {}, h('b', {}, 'Assignee'), mine, unassign, find),
    found,
    h('div.jira-row', {}, note, signIn),
    result,
  );

  // Commenting, in plain text (Jira gets it as paragraphs); the draft's kept per ticket.
  const draftKey = `${DRAFT_KEY}${it.url}`;
  const ta = h('textarea', { rows: 4, maxlength: JIRA_COMMENT_MAX, placeholder: 'Leave a comment. Plain text; ⌘/Ctrl+Enter posts it.', 'aria-label': 'Comment' }) as HTMLTextAreaElement;
  ta.value = pref<string>(draftKey, '');
  const post = h('button.btn.primary', { type: 'button' }, '💬 Comment') as HTMLButtonElement;
  const as = h('span.grow');
  const compose = h('article.gh-card.gh-compose', {}, h('header', {}, h('b', {}, 'Add a comment')), h('div.gh-compose-body', {}, ta), h('div.gh-compose-foot', {}, as, post));

  const queueProvider = providerPicker(store.project, `ticket-provider-${it.number}`, 'Queue on');
  const queue = h('button.btn', { type: 'button' }) as HTMLButtonElement;
  const carry = actions.pickUp;
  const pickUp = carry ? h('button.btn', { type: 'button', title: 'Carry its card to an empty desk, a worker or the queue board, and press E there', onclick: () => carry(it) }, '✋ Pick it up') : null;
  const el = h(
    'div.modal.gh-window.issue.jira-ticket',
    { role: 'dialog', 'aria-label': `Jira ticket ${key}` },
    h('header', {}, pill, heading, close),
    meta,
    h('div.gh-body', {}, h('div.gh-conv', {}, h('div.gh-col', {}, controls, thread, compose))),
    h(
      'footer',
      {},
      h('a.grow', { href: it.url, target: '_blank', rel: 'noopener noreferrer' }, 'Open in Jira ↗'),
      h('button.btn', { type: 'button', title: 'Send a worker your own prompt about this ticket', onclick: () => actions.ask(ticketContext(it), `Ask about ${key}`) }, '✍️ Ask a worker…'),
      h('button.btn', { type: 'button', title: 'Workers take it on together in the meeting room', onclick: () => actions.meeting(ticketMeeting(it)) }, '🤝 Meeting…'),
      queueProvider.element,
      queue,
      pickUp,
      h('button.btn.primary', { type: 'button', onclick: () => actions.assign(ticketPrompt(it), `Hand ${key} to a worker`, it.number) }, '🤖 Hand to a worker'),
    ),
  );

  const say = (text: string, bad = false) => {
    result.textContent = text;
    result.classList.toggle('error', bad);
    result.classList.toggle('hidden', !text);
  };

  /** Sends what you asked for, and waits for the office to say how it went (see the jiraDone topic). */
  const ask = (op: 'move' | 'assign' | 'comment', send: () => void) => {
    if (busy) return;
    busy = op;
    say('');
    clearTimeout(timer);
    // The office drops messages while it's disconnected, and then no answer comes.
    timer = window.setTimeout(() => {
      busy = null;
      say('No answer from the office. Reload the ticket to see whether it went through.', true);
      paint();
    }, 45_000);
    send();
    paint();
  };

  const paint = () => {
    const j = it.jira!;
    const d = detail;
    const can = store.jiraYou?.status === 'ok';
    heading.textContent = `${key} ${d?.summary ?? it.title}`;
    const category = d?.category ?? j.category;
    pill.className = `pill ${PILL[category] ?? 'idle'}`;
    pill.textContent = d?.status ?? j.status;
    const assignee = d ? d.assignee : j.assignee;
    const prio = d?.priority ?? j.priority;
    meta.replaceChildren(
      ...nodes(
        h('span', { title: 'Type' }, `${typeIcon(d?.type ?? j.type)} ${d?.type ?? j.type}`),
        prio ? h('span', { title: 'Priority' }, `· ${[priorityIcon(prio), prio].filter(Boolean).join(' ')}`) : null,
        h('span', {}, '· 👤'),
        assignee ? h('b', {}, assignee.name) : h('span', {}, it.taken ? '🤖 handed to a worker' : 'Unassigned'),
        d?.reporter ? h('span', {}, `· reported by ${d.reporter.name} ${timeAgo(d.created)}`) : null,
        (d?.parent ?? j.parent) ? h('span', {}, `· in ${(d?.parent ?? j.parent)!.key} ${(d?.parent ?? j.parent)!.summary}`) : null,
        ...(d?.labels ?? it.labels.map((l) => l.name)).map((name) => labelChip(it.labels.find((l) => l.name === name) ?? { name, color: '#dddddd' })),
      ),
    );
    // Where it can move to, as Jira told you; keep what you picked across a refresh.
    const picked = moveTo.value;
    moveTo.replaceChildren(
      ...(d?.transitions.length ? d.transitions.map((t) => h('option', { value: t.id }, t.name === t.to ? t.to : `${t.name} → ${t.to}`)) : [h('option', { value: '' }, d ? 'Nowhere to move it' : 'Loading…')]),
    );
    if (d?.transitions.some((t) => t.id === picked)) moveTo.value = picked;
    moveTo.disabled = !d?.transitions.length || !!busy || !can;
    moveBtn.disabled = moveTo.disabled;
    moveBtn.textContent = busy === 'move' ? 'Moving…' : 'Move';
    const me = store.jiraYou?.accountId;
    mine.disabled = !!busy || !can || !me || assignee?.accountId === me;
    mine.textContent = busy === 'assign' ? 'Assigning…' : '🙋 Assign to me';
    unassign.disabled = !!busy || !can || !assignee;
    find.disabled = !can;
    const why = signInNote();
    note.textContent = why;
    note.classList.toggle('hidden', !why);
    signIn.classList.toggle('hidden', !why || !!store.jiraYou?.office);
    post.disabled = !!busy || !can || !ta.value.trim();
    ta.readOnly = busy === 'comment';
    post.textContent = busy === 'comment' ? 'Posting…' : '💬 Comment';
    as.textContent = can ? `Posts to Jira as ${store.jiraYou!.who}${store.jiraYou!.office ? ' (the office’s token)' : ''}` : why;
    // The footer: on the queue, or not.
    const task = store.taskForIssue(it.number);
    const onQueue = !!task && task.status !== 'done';
    const open = it.state === 'OPEN';
    queueProvider.element.classList.toggle('hidden', !open || onQueue);
    queue.classList.toggle('hidden', !open);
    queue.disabled = onQueue;
    queue.textContent = onQueue ? (task!.status === 'running' ? `🤖 ${task!.workerName ?? 'A worker'} is on it` : '📋 On the queue') : '📋 Add to queue';
    pickUp?.classList.toggle('hidden', !open);
  };

  const render = () => {
    const d = detail;
    const author = d?.reporter?.name ?? (it.author || 'Jira');
    thread.replaceChildren(h('article.gh-card', {}, h('header', {}, avatar(author), h('b', {}, author), h('span', {}, 'wrote'), when(d?.created ?? it.createdAt, it.url)), ticketMarkdown(d?.description ?? it.body)));
    if (error) thread.append(errorBox(error, load));
    else if (!d) thread.append(spinnerRow('Loading the ticket…'));
    else if (!d.comments.length) thread.append(h('p.gh-quiet', {}, 'No comments yet.'));
    else thread.append(...d.comments.map((c) => commentCard(c, 'commented')));
  };

  let generation = 0;
  function load() {
    const g = ++generation;
    error = '';
    render();
    getJson<JiraTicket>(`/api/jira/ticket?key=${encodeURIComponent(key)}`)
      .then((d) => g === generation && (detail = d))
      .catch((err) => g === generation && (error = (err as Error).message))
      .finally(() => g === generation && (paint(), render()));
  }

  // Looking a teammate up as you type, a moment after you stop.
  let lookup = 0;
  let asked = 0;
  find.addEventListener('input', () => {
    clearTimeout(lookup);
    const q = find.value.trim();
    if (!q) return found.replaceChildren();
    lookup = window.setTimeout(() => {
      const n = ++asked;
      getJson<JiraPerson[]>(`/api/jira/assignable?key=${encodeURIComponent(key)}&q=${encodeURIComponent(q)}`)
        .then((people) => {
          if (n !== asked) return;
          found.replaceChildren(...people.map((p) => h('button.btn.small', { type: 'button', onclick: () => assignTo(p) }, avatar(p.name), p.name)));
          if (!people.length) found.append(h('small', {}, `Nobody called “${q}” can be assigned this`));
        })
        .catch((err) => n === asked && found.replaceChildren(h('small', {}, (err as Error).message)));
    }, 250);
  });
  const assignTo = (p: JiraPerson | null) => {
    find.value = '';
    found.replaceChildren();
    ask('assign', () => net.send({ t: 'jira.assign', key, accountId: p?.accountId ?? null }));
  };
  mine.addEventListener('click', () => {
    const me = store.jiraYou;
    if (me?.accountId) assignTo({ accountId: me.accountId, name: me.who ?? 'you' });
  });
  unassign.addEventListener('click', () => assignTo(null));
  moveBtn.addEventListener('click', () => {
    const transition = moveTo.value;
    if (transition) ask('move', () => net.send({ t: 'jira.move', key, transition }));
  });
  const submit = () => {
    const body = ta.value;
    if (!body.trim()) return;
    ask('comment', () => net.send({ t: 'jira.comment', key, body }));
  };
  post.addEventListener('click', submit);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  });
  ta.addEventListener('input', () => {
    savePref(draftKey, ta.value);
    paint();
  });

  const addToQueue = () => {
    if (!queueProvider.valid()) return;
    modal.close();
    actions.queue(ticketPrompt(it), `${key} ${it.title}`, it.number, queueProvider.value(), queueProvider.model(), queueProvider.effort());
  };
  queue.addEventListener('click', addToQueue);

  const unsubs = [
    store.on('issues', () => {
      const fresh = store.issues.items.find((i) => i.number === it.number);
      if (fresh) it = fresh;
      paint();
    }),
    store.on('queue', paint),
    store.on('jiraYou', paint),
    store.on('jiraDone', () => {
      const m = store.jiraDone;
      if (!m || m.key !== key || m.op !== busy) return;
      clearTimeout(timer);
      busy = null;
      if (m.error) say(m.error, true);
      else if (m.op === 'comment') {
        ta.value = '';
        savePref(draftKey, '');
        if (m.comment && detail) detail.comments.push(m.comment);
        render();
      } else {
        say(m.op === 'move' ? `Moved ${key}` : `Assigned ${key}`);
        // Where it can go next, and who has it, as Jira has it now.
        load();
      }
      paint();
    }),
  ];
  const modal = openModal(el, {
    doing: `📋 reading ${key}`,
    onClose: () => {
      clearTimeout(timer);
      clearTimeout(lookup);
      unsubs.forEach((u) => u());
    },
  });
  close.addEventListener('click', () => modal.close());
  paint();
  load();
}
