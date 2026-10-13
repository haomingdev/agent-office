// ⚙️ Settings' Jira board, under Building: whether every floor's issues board is a Jira board, which
// one (its link, pasted), and the office's own Jira email and API token (see server/jira/).
import './jira.css';
import type { Net } from '../../net';
import { store } from '../../state';
import { parseJiraBoard } from '../../../shared/jira';
import { h, timeAgo } from '../dom';

const TOKENS_URL = 'https://id.atlassian.com/manage-profile/security/api-tokens';

/** The setting, made by `frame` from what goes in it; `off` stops following the office once Settings closes. */
export function jiraSetting(net: Net, frame: (body: Node[]) => HTMLElement): { section: HTMLElement; off: () => void } {
  const onRow = h('div.seg', { role: 'radiogroup', 'aria-label': 'Jira board' });
  const link = h('input', { type: 'url', placeholder: 'https://your-site.atlassian.net/jira/software/c/projects/KEY/boards/1', 'aria-label': 'The Jira board’s link', spellcheck: 'false', autocomplete: 'off' }) as HTMLInputElement;
  const save = h('button.btn.primary', { type: 'button' }, 'Use this board');
  const linkRow = h('div.webhook.jira-fields', {}, link, save);
  const problem = h('p.setting-note.bad', { hidden: true });
  const email = h('input', { type: 'email', placeholder: 'you@example.com', 'aria-label': 'Atlassian account email', autocomplete: 'off', spellcheck: 'false' }) as HTMLInputElement;
  const token = h('input', { type: 'password', placeholder: 'API token', 'aria-label': 'Atlassian API token', autocomplete: 'new-password', spellcheck: 'false' }) as HTMLInputElement;
  const saveToken = h('button.btn', { type: 'button' }, 'Save token');
  const tokenRow = h('div.webhook.jira-fields', {}, email, token, saveToken);
  /** How saving the token went: checking, Jira's answer if it said no, or saved. */
  const tokenSaid = h('p.setting-note', { hidden: true });
  let checking = false;
  const office = h('p.setting-note');
  const removeToken = h('button.btn', { type: 'button' }, 'Remove the office’s token');
  const removeRow = h('div.volume', {}, removeToken);
  const note = h('p.setting-note');
  const section = frame([onRow, linkRow, problem, office, tokenRow, tokenSaid, removeRow, note]);
  const tokenSay = (text: string, bad = false) => {
    tokenSaid.textContent = text;
    tokenSaid.hidden = !text;
    tokenSaid.classList.toggle('bad', bad);
  };

  /** Turns it on or off, with the link in the box if there's one. */
  const turn = (on: boolean) => {
    if (on === store.jira.on) return;
    const url = link.value.trim();
    const parsed = url ? parseJiraBoard(url) : undefined;
    if (typeof parsed === 'string') return say(parsed);
    say('');
    net.send({ t: 'jira.config', on, url: url || undefined });
  };
  const say = (text: string) => {
    problem.textContent = text;
    problem.hidden = !text;
    if (text) link.focus();
  };

  const paint = () => {
    const j = store.jira;
    const admin = store.me.admin;
    onRow.replaceChildren(
      ...([
        [false, 'Off'],
        [true, '📌 On'],
      ] as const).map(([value, label]) => h('button.btn', { type: 'button', role: 'radio', 'aria-checked': String(j.on === value), class: j.on === value ? 'on' : '', onclick: () => turn(value) }, label)),
    );
    for (const row of [onRow, linkRow, tokenRow]) row.classList.toggle('hidden', !admin);
    removeRow.classList.toggle('hidden', !admin || !j.office);
    if (!link.value && j.url) link.value = j.url;
    office.textContent = j.office
      ? `🔐 The office reads the board as ${j.office}${store.me.account ? '' : ', and everyone on the shared password moves, assigns and comments as it too'}.`
      : '🔐 The office has no Jira API token of its own, so the board is read with a teammate’s, once one signs in to Jira.';
    const board = j.on ? `Every floor’s issues board is ${j.name ? `“${j.name}”` : `board ${j.board}`} on ${j.site?.replace(/^https:\/\//, '')}.` : 'Off: each floor’s issues board shows its own repository’s issues.';
    const who = j.by ? ` Set by ${j.by} ${timeAgo(j.at ?? 0)}.` : '';
    note.replaceChildren(
      `${board}${who} Moving, assigning and commenting go out as whoever does them, with their own Jira sign-in (☰ → 🔐 Your sign-ins)${store.me.account ? '' : ', or on the shared password as the office'}. Make an API token at `,
      h('a', { href: TOKENS_URL, target: '_blank', rel: 'noopener noreferrer' }, 'id.atlassian.com'),
      admin ? '.' : '. Admins can change this.',
    );
  };

  const useBoard = () => {
    const url = link.value.trim();
    const parsed = parseJiraBoard(url);
    if (typeof parsed === 'string') return say(parsed);
    say('');
    net.send({ t: 'jira.config', on: true, url });
  };
  save.addEventListener('click', useBoard);
  link.addEventListener('keydown', (e) => e.key === 'Enter' && useBoard());
  saveToken.addEventListener('click', () => {
    if (!email.value.trim()) return email.focus();
    if (!token.value.trim()) return token.focus();
    net.send({ t: 'jira.office', email: email.value.trim(), token: token.value.trim() });
    token.value = '';
    checking = true;
    tokenSay('Checking the token with Jira…');
  });
  // Jira's answer: an error comes back as jira.you, a token that took as the office's name.
  const answered = () => {
    if (!checking) return;
    const err = store.jiraYou?.error;
    if (err) {
      checking = false;
      tokenSay(`Jira didn’t take it: ${err}`, true);
    } else if (store.jira.office) {
      checking = false;
      tokenSay(`✅ Saved: the office signs in to Jira as ${store.jira.office}.`);
    }
  };
  removeToken.addEventListener('click', () => net.send({ t: 'jira.office', email: '', token: '' }));
  paint();
  const offs = [store.on('jira', paint), store.on('me', paint), store.on('jira', answered), store.on('jiraYou', answered)];
  return { section, off: () => offs.forEach((off) => off()) };
}
