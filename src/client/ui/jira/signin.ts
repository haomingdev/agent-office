// 🔐 Your sign-ins' Jira card: your own Atlassian email and API token, which what you do on the Jira
// board goes out as (moving, assigning, commenting, and the tickets your workers take). The token is
// checked with Jira and kept on the office's machine, in your account's folder; it never comes back here.
import type { Net } from '../../net';
import { store } from '../../state';
import { h } from '../dom';
import { confirmDialog } from '../prompt';

const TOKENS_URL = 'https://id.atlassian.com/manage-profile/security/api-tokens';

/** The card, kept across the window's redraws (so a half-typed token survives); `off` once the window's closed. */
export function jiraCard(net: Net): { el: HTMLElement; off: () => void } {
  const email = h('input', { type: 'email', placeholder: 'you@example.com', 'aria-label': 'Atlassian account email', autocomplete: 'off', spellcheck: 'false', style: 'max-width:14em' }) as HTMLInputElement;
  const token = h('input', { type: 'password', placeholder: 'Atlassian API token', 'aria-label': 'Jira API token', autocomplete: 'new-password', spellcheck: 'false' }) as HTMLInputElement;
  const status = h('span.signin-who');
  const body = h('div.signin-body');
  const el = h('section.signin', {}, h('div.team-head', {}, h('h4', {}, '📌 Jira'), status), body);
  let sent = false;

  const paint = () => {
    const you = store.jiraYou;
    // Only once there's a Jira board, or you're signed in to one already.
    const hidden = !store.jira.on && you?.status !== 'ok';
    el.className = `signin ${you?.status === 'ok' ? 'ok' : 'none'}${hidden ? ' hidden' : ''}`;
    status.className = `signin-who${you?.status === 'ok' ? ' ok' : ' none'}`;
    status.textContent = !you ? 'Loading…' : you.status === 'ok' ? `✅ ${you.who}` : sent && !you.error ? '⏳ Checking…' : 'Not signed in';
    body.replaceChildren();
    if (you?.error) body.append(h('p.team-status.error', {}, you.error));
    if (you?.office) {
      body.append(h('p.note', {}, 'On the shared office password, everyone moves, assigns and comments on Jira as the office: its email and API token are in ⚙️ Settings → Building → Jira.'));
      return;
    }
    if (you?.status === 'ok') {
      const out = h('button.btn', { type: 'button' }, 'Sign out');
      out.addEventListener('click', () => confirmDialog('Sign out of Jira?', 'The office stops acting on Jira as you until you sign in again.', 'Sign out', () => net.send({ t: 'jira.signout' })));
      body.append(h('p.note', {}, `Signed in as ${you.email}: what you do on the Jira board goes out as you.`), h('div.signin-actions', {}, out));
      return;
    }
    const save = h('button.btn.primary', { type: 'submit' }, 'Save');
    const form = h('form.invite-row', {}, email, token, save) as HTMLFormElement;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!email.value.trim()) return email.focus();
      if (!token.value.trim()) return token.focus();
      sent = true;
      net.send({ t: 'jira.signin', email: email.value.trim(), token: token.value.trim() });
      token.value = '';
      paint();
    });
    body.append(
      h('p.note', {}, 'Paste the email you sign in to Atlassian with and an API token (', h('a', { href: TOKENS_URL, target: '_blank', rel: 'noopener noreferrer' }, 'make one'), '). Moving, assigning and commenting on the Jira board then go out as you.'),
      form,
    );
  };

  const offs = [store.on('jiraYou', () => ((sent = false), paint())), store.on('jira', paint)];
  net.send({ t: 'jira.get' });
  paint();
  return { el, off: () => offs.forEach((off) => off()) };
}
