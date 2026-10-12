// The Jira board (⚙️ Settings → Building → Jira): when it's on, every floor's issues board is this one
// board's tickets (see forge.ts), the same on every floor. The board is read with the office's own Jira
// token, or else any signed-in member's; what someone does to a ticket (move it, assign it, comment)
// goes out as them, with their own token, or on the shared password as the office's. Kept in
// .agent-office/jira.json (which board), jira-office.json and each account's jira.json (see creds.ts).

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { GhComment, GhIssue, GhState, JiraCard, JiraPerson, JiraState, JiraTicket, JiraYou } from '../../shared/protocol.js';
import { JIRA_KEY, parseJiraBoard } from '../../shared/jira.js';
import { Claims } from '../github.js';
import { JiraError, type JiraApi, type JiraFetch } from './api.js';
import { textToAdf } from './adf.js';
import { commentOf, loadBoard, ticketDetail, type Board } from './board.js';
import { JiraCreds, type JiraLogin } from './creds.js';

/** The board is looked at again at most this often, unless someone asks or changed something. */
const REFRESH_GAP_MS = 60_000;
const SIGN_IN = '☰ → 🔐 Your sign-ins';
const SETTINGS = '⚙️ Settings → Building → Jira';

interface Saved {
  on: boolean;
  site?: string;
  board?: number;
  /** The board's link as it was pasted, for "Open in Jira". */
  link?: string;
  by?: string;
  at?: number;
}

export interface JiraEvents {
  /** The board's setup or columns changed: for everyone. */
  state(state: JiraState): void;
  /** A Jira sign-in changed: an account's own, or (undefined) the office's, which everyone on the shared password is. */
  you(accountId: string | undefined): void;
}

/** How a worker taking a ticket went in Jira. */
interface Taken {
  moved: boolean;
  assigned: boolean;
  error?: string;
}

export class Jira {
  issues: GhState<GhIssue> = { items: [], fetchedAt: 0, loading: false };
  readonly creds: JiraCreds;
  private saved: Saved = { on: false };
  private board?: Board;
  private file: string;
  private listeners = new Set<() => void>();
  /** Tickets workers just took, In progress on the board until Jira says they moved (see Claims). */
  private claims = new Claims();
  private looking?: Promise<void>;
  private again?: Promise<void>;
  /** Members whose tokens Jira turned down for reading the board, until they sign in again. */
  private refused = new Set<string>();

  constructor(
    dataDir: string,
    private events: JiraEvents,
    fetchFn?: JiraFetch,
  ) {
    this.file = path.join(dataDir, 'jira.json');
    this.creds = new JiraCreds(dataDir, fetchFn);
    this.restore();
  }

  /** Every floor's issues board is the Jira board. */
  get on(): boolean {
    return this.saved.on && !!this.saved.site && !!this.saved.board;
  }

  state(): JiraState {
    const { site, board, link, by, at } = this.saved;
    const office = this.creds.office();
    return {
      on: this.on,
      ...(site ? { site } : {}),
      ...(board ? { board } : {}),
      ...(this.board ? { name: this.board.name } : {}),
      ...(link ? { url: link } : {}),
      columns: this.board?.columns ?? [],
      ...(office ? { office: office.who } : {}),
      ...(by ? { by, at } : {}),
    };
  }

  /** Someone's own Jira sign-in; with no account (the shared password), the office's. */
  you(accountId: string | undefined): JiraYou {
    const login = accountId ? this.creds.account(accountId) : this.creds.office();
    const office = accountId ? {} : { office: true };
    return login ? { status: 'ok', who: login.who, accountId: login.accountId, email: login.email, ...office } : { status: 'none', ...office };
  }

  /** Hears whenever the board's tickets change (or Jira is turned on or off); returns how to stop. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Points the office at a board (a pasted link) and turns it on or off. Returns why it can't. */
  configure(on: boolean, link: string | undefined, by: string): string | undefined {
    let { site, board } = this.saved;
    let kept = this.saved.link;
    if (link?.trim()) {
      const parsed = parseJiraBoard(link);
      if (typeof parsed === 'string') return parsed;
      ({ site, board } = parsed);
      kept = link.trim();
    }
    if (on && (!site || !board)) return "Paste the board's link first";
    const moved = site !== this.saved.site || board !== this.saved.board;
    this.saved = { on, site, board, link: kept, by, at: Date.now() };
    this.persist();
    if (moved) {
      this.board = undefined;
      this.refused.clear();
      this.issues = { items: [], fetchedAt: 0, loading: this.on };
    }
    this.events.state(this.state());
    this.changed();
    if (this.on) void this.refresh(true);
    return undefined;
  }

  /** The office's own Jira email and API token, checked with Jira first; an empty token takes it off. */
  async setOffice(email: string, token: string): Promise<string | undefined> {
    if (token) {
      const login = await this.check(email, token);
      if (typeof login === 'string') return login;
      this.creds.setOffice(login);
    } else this.creds.setOffice(undefined);
    this.events.state(this.state());
    this.events.you(undefined);
    void this.refresh(true);
    return undefined;
  }

  /** An account's own Jira email and API token, checked with Jira first. */
  async signIn(accountId: string, email: string, token: string): Promise<string | undefined> {
    const login = await this.check(email, token);
    if (typeof login === 'string') return login;
    this.creds.setAccount(accountId, login);
    this.refused.delete(accountId);
    this.events.you(accountId);
    // The board may have been waiting on someone's token to be read with.
    if (this.issues.error) void this.refresh(true);
    return undefined;
  }

  signOut(accountId: string) {
    this.creds.setAccount(accountId, undefined);
    this.events.you(accountId);
  }

  /** Looks at the board again: now if `force` (someone asked, or changed something), else unless it just did. */
  refresh(force = false): Promise<void> {
    if (!this.on) return Promise.resolve();
    // A look already under way was asked before whatever just changed: look again after it.
    if (this.looking) return force ? (this.again ??= this.looking.then(() => ((this.again = undefined), this.refresh(true)))) : this.looking;
    if (!force && Date.now() - this.issues.fetchedAt < REFRESH_GAP_MS) return Promise.resolve();
    this.looking = this.look(force).finally(() => (this.looking = undefined));
    return this.looking;
  }

  /** Whether issue `n` is a ticket on the Jira board (its Jira id), which Jira takes care of rather than GitHub. */
  owns(n: number): boolean {
    return this.on && this.issues.items.some((i) => i.number === n && i.jira);
  }

  /**
   * A worker took ticket `n` (handed over from its window, a carried card, or the queue): it's In
   * progress on the board at once, then Jira moves it to the board's next column and assigns it to
   * whoever took it, when they're signed in to Jira. If Jira won't, `warn` says why; the worker keeps it.
   */
  take(n: number, accountId: string | undefined, warn: (text: string) => void) {
    const card = this.issues.items.find((i) => i.number === n)?.jira;
    if (!card) return;
    const answered = this.claims.take(n);
    this.showClaims();
    void this.claim(card, accountId).then((r) => {
      answered(r.moved || r.assigned);
      if (!r.moved && !r.assigned) this.showClaims();
      if (r.error) warn(`A worker has ${card.key}, but Jira didn't take it all in: ${r.error}`);
      void this.refresh(true);
    });
  }

  /** A ticket in full, for its window, read as whoever asked (or, for a ticket on the board, as the board is). */
  async detail(key: string, accountId: string | undefined): Promise<JiraTicket> {
    return ticketDetail(this.reading(key, accountId), key);
  }

  /** Who a ticket can be assigned to, matching `query`. */
  async assignable(key: string, query: string, accountId: string | undefined): Promise<JiraPerson[]> {
    const q = new URLSearchParams({ issueKey: key, query, maxResults: '20' });
    const users = await this.reading(key, accountId).get<any[]>(`/rest/api/3/user/assignable/search?${q}`, key);
    return (users ?? []).filter((u) => u?.accountId && u.active !== false).map((u) => ({ accountId: String(u.accountId), name: String(u.displayName ?? 'someone') }));
  }

  /** Moves a ticket by one of its transitions, as `accountId` (the office's on the shared password). */
  move(key: string, transition: string, accountId: string | undefined): Promise<void> {
    return this.write(key, accountId, (api) => api.call('POST', `/rest/api/3/issue/${key}/transitions`, { transition: { id: transition } }, key));
  }

  /** Assigns a ticket to someone (by Jira account id), or to nobody. */
  assign(key: string, to: string | null, accountId: string | undefined): Promise<void> {
    return this.write(key, accountId, (api) => api.call('PUT', `/rest/api/3/issue/${key}/assignee`, { accountId: to }, key));
  }

  /** Comments on a ticket in plain text; resolves to the comment as Jira saved it. */
  comment(key: string, body: string, accountId: string | undefined): Promise<GhComment> {
    const doc = textToAdf(body);
    return this.write(key, accountId, async (api) => {
      const saved = await api.call('POST', `/rest/api/3/issue/${key}/comment`, { body: doc }, key);
      // Jira answers with the comment; should it not, it's the one that was sent.
      return commentOf(saved ?? { id: `new-${Date.now()}`, body: doc, created: new Date().toISOString() }, api.site, key);
    });
  }

  // ---------------------------------------------------------------------------

  private async look(force: boolean) {
    const { site, board } = this.saved;
    if (force) {
      this.issues = { ...this.issues, loading: true };
      this.changed();
    }
    const asked = Date.now();
    const reader = this.reader();
    try {
      if (typeof reader === 'string') throw new Error(reader);
      const b = await loadBoard(reader.api, board!);
      // Pointed at another board meanwhile: that one's look counts, not this.
      if (this.saved.site !== site || this.saved.board !== board) return;
      const reshaped = JSON.stringify([b.name, b.columns]) !== JSON.stringify([this.board?.name, this.board?.columns]);
      this.board = b;
      this.issues = { items: this.claims.mark(b.items, asked), fetchedAt: Date.now(), loading: false };
      if (reshaped) this.events.state(this.state());
    } catch (err) {
      if (err instanceof JiraError && err.status === 401 && typeof reader !== 'string' && reader.member) this.refused.add(reader.member);
      this.issues = { ...this.issues, loading: false, error: (err as Error).message, fetchedAt: Date.now() };
    }
    this.changed();
  }

  private changed() {
    for (const fn of this.listeners) fn();
  }

  /** Puts the tickets workers have taken (or no longer have) on the board, ahead of the next look at Jira. */
  private showClaims() {
    this.issues = { ...this.issues, items: this.claims.mark(this.issues.items) };
    this.changed();
  }

  /** What the board is read with: the office's own token, else a signed-in member's (`member`). */
  private reader(): { api: JiraApi; member?: string } | string {
    const site = this.saved.site!;
    const office = this.creds.office();
    if (office) return { api: this.creds.api(site, office) };
    const m = this.creds.members().find((x) => !this.refused.has(x.id));
    if (m) return { api: this.creds.api(site, m.login), member: m.id };
    return `The office has no Jira API token to read the board with: an admin can add the office's own (${SETTINGS}), or sign in to Jira yourself (${SIGN_IN})`;
  }

  /** Who `accountId` is in Jira, to act as: their own sign-in, or with no account, the office's. */
  private actor(accountId: string | undefined): JiraLogin | string {
    if (!accountId) return this.creds.office() ?? `Add the office's Jira email and API token first (${SETTINGS})`;
    return this.creds.account(accountId) ?? `Sign in to Jira first (${SIGN_IN})`;
  }

  /** What to read a ticket with: your own sign-in, else (for a ticket on the board only) what the board is read with. */
  private reading(key: string, accountId: string | undefined): JiraApi {
    if (!this.on) throw new Error('The Jira board is off');
    if (!JIRA_KEY.test(key)) throw new Error('Not a Jira ticket');
    const actor = this.actor(accountId);
    if (typeof actor !== 'string') return this.creds.api(this.saved.site!, actor);
    if (!this.issues.items.some((i) => i.jira?.key === key)) throw new Error(`${key} isn't on the board. ${actor}`);
    const reader = this.reader();
    if (typeof reader === 'string') throw new Error(reader);
    return reader.api;
  }

  /** Does something to a ticket as `accountId`, then looks at the board again. */
  private async write<T>(key: string, accountId: string | undefined, go: (api: JiraApi) => Promise<T>): Promise<T> {
    if (!this.on) throw new Error('The Jira board is off');
    if (!JIRA_KEY.test(key)) throw new Error('Not a Jira ticket');
    const actor = this.actor(accountId);
    if (typeof actor === 'string') throw new Error(actor);
    const out = await go(this.creds.api(this.saved.site!, actor));
    void this.refresh(true);
    return out;
  }

  /** An email and token checked with the board's Jira. */
  private async check(email: string, token: string): Promise<JiraLogin | string> {
    if (!this.saved.site) return "Paste the board's link first (⚙️ Settings): a token is checked with its Jira";
    return this.creds.verify(this.saved.site, email.trim(), token.trim());
  }

  /** Moves `card` on from the to-do column and assigns it to whoever took it (see take). */
  private async claim(card: JiraCard, accountId: string | undefined): Promise<Taken> {
    const actor = this.actor(accountId);
    const reader = this.reader();
    const api = typeof actor !== 'string' ? this.creds.api(this.saved.site!, actor) : typeof reader !== 'string' ? reader.api : undefined;
    if (!api) return { moved: false, assigned: false, error: typeof actor === 'string' ? actor : String(reader) };
    const errors: string[] = [];
    let moved = false;
    let assigned = false;
    const b = this.board;
    if (b && card.column <= b.todo) {
      try {
        const next = await this.inProgress(api, card.key, b);
        if (typeof next === 'string') errors.push(next);
        else {
          await api.call('POST', `/rest/api/3/issue/${card.key}/transitions`, { transition: { id: next.id } }, card.key);
          moved = true;
        }
      } catch (err) {
        errors.push(`it wasn't moved on (${(err as Error).message})`);
      }
    }
    // Assigned to whoever took it, when Jira knows who that is.
    if (typeof actor !== 'string') {
      if (card.assignee?.accountId === actor.accountId) assigned = true;
      else {
        try {
          await api.call('PUT', `/rest/api/3/issue/${card.key}/assignee`, { accountId: actor.accountId }, card.key);
          assigned = true;
        } catch (err) {
          errors.push(`it wasn't assigned to ${actor.who} (${(err as Error).message})`);
        }
      }
    }
    return { moved, assigned, error: errors.join('; ') || undefined };
  }

  /** The transition to the first column after the to-do one that the ticket can move to from where it is, or why there's none. */
  private async inProgress(api: JiraApi, key: string, b: Board): Promise<{ id: string } | string> {
    const r = await api.get(`/rest/api/3/issue/${key}/transitions`, key);
    const transitions: any[] = Array.isArray(r?.transitions) ? r.transitions : [];
    for (let i = b.todo + 1; i < b.columns.length; i++) {
      const t = transitions.find((x) => b.statuses[i].includes(String(x?.to?.id)));
      if (t) return { id: String(t.id) };
    }
    return `Jira has no way to move it to ${b.columns[b.todo + 1]?.name ?? 'the next column'} from where it is`;
  }

  private restore() {
    try {
      const s = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Saved>;
      const parsed = typeof s.link === 'string' ? parseJiraBoard(s.link) : undefined;
      if (parsed && typeof parsed !== 'string') this.saved = { on: s.on === true, ...parsed, link: s.link, by: typeof s.by === 'string' ? s.by : undefined, at: typeof s.at === 'number' ? s.at : undefined };
    } catch {
      // never set up: no Jira board
    }
  }

  private persist() {
    try {
      writeFileSync(this.file, JSON.stringify(this.saved, null, 2), { mode: 0o600 });
    } catch {
      // disk issues shouldn't take the office down
    }
  }
}
