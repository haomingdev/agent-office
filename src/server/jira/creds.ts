// Who the office is in Jira: the office's own email and API token (⚙️ Settings, for reading the board,
// and for everything on the shared password), and each account's own (🔐 Your sign-ins), which what
// that person does on the board goes out as. Each is a file only the office can read (0600): the
// office's in .agent-office/jira-office.json, an account's in its folder, .agent-office/homes/<id>/jira.json,
// which goes when the account does (see SignIns.forget). Tokens never leave this machine.

import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { JiraApi, type JiraAuth, type JiraFetch } from './api.js';

/** Credentials as they're kept, with who Jira said they are when they were saved. */
export interface JiraLogin extends JiraAuth {
  who: string;
  accountId: string;
}

const EMAIL = /^[^\s@]{1,128}@[^\s@]{1,128}\.[^\s@]{1,64}$/;
/** Atlassian API tokens: older ones are 24 characters, newer ones (ATATT…) about 190. */
const TOKEN = /^[\x21-\x7e]{16,2048}$/;
const ACCOUNT_ID = /^[A-Za-z0-9]{6,64}$/;

/** Why an email and token can't be what they say, before Jira is asked. */
export function badLogin(email: string, token: string): string | undefined {
  if (!EMAIL.test(email)) return 'That email doesn’t look right: it’s the one you sign in to Atlassian with';
  if (!TOKEN.test(token)) return 'That doesn’t look like an Atlassian API token (make one at id.atlassian.com → Security → API tokens)';
  return undefined;
}

export class JiraCreds {
  constructor(
    private dataDir: string,
    private fetchFn?: JiraFetch,
  ) {}

  /** A client for `site`, as `login`. */
  api(site: string, login: JiraAuth): JiraApi {
    return new JiraApi(site, login, this.fetchFn);
  }

  /** Asks Jira who an email and token are (GET /myself): their name and account id, or why not. */
  async verify(site: string, email: string, token: string): Promise<JiraLogin | string> {
    const bad = badLogin(email, token);
    if (bad) return bad;
    try {
      const me = await this.api(site, { email, token }).get('/rest/api/3/myself', 'your Jira account');
      if (!me?.accountId) return "Jira didn't say who that is";
      return { email, token, who: String(me.displayName ?? email), accountId: String(me.accountId) };
    } catch (err) {
      return (err as Error).message;
    }
  }

  office(): JiraLogin | undefined {
    return this.read(path.join(this.dataDir, 'jira-office.json'));
  }

  setOffice(login: JiraLogin | undefined) {
    this.write(path.join(this.dataDir, 'jira-office.json'), login);
  }

  account(id: string): JiraLogin | undefined {
    return ACCOUNT_ID.test(id) ? this.read(this.accountFile(id)) : undefined;
  }

  setAccount(id: string, login: JiraLogin | undefined) {
    if (!ACCOUNT_ID.test(id)) return;
    if (login) mkdirSync(path.dirname(this.accountFile(id)), { recursive: true, mode: 0o700 });
    this.write(this.accountFile(id), login);
  }

  /** The accounts signed in to Jira, for reading the board when the office has no token of its own. */
  members(): { id: string; login: JiraLogin }[] {
    let ids: string[];
    try {
      ids = readdirSync(path.join(this.dataDir, 'homes'));
    } catch {
      return [];
    }
    return ids.flatMap((id) => {
      const login = this.account(id);
      return login ? [{ id, login }] : [];
    });
  }

  private accountFile(id: string): string {
    return path.join(this.dataDir, 'homes', id, 'jira.json');
  }

  private read(file: string): JiraLogin | undefined {
    try {
      const s = JSON.parse(readFileSync(file, 'utf8')) as Partial<JiraLogin>;
      if (typeof s.email === 'string' && typeof s.token === 'string' && typeof s.accountId === 'string') return { email: s.email, token: s.token, accountId: s.accountId, who: typeof s.who === 'string' ? s.who : s.email };
    } catch {
      // none, or unreadable: not signed in
    }
    return undefined;
  }

  private write(file: string, login: JiraLogin | undefined) {
    try {
      if (!login) {
        if (existsSync(file)) rmSync(file, { force: true });
        return;
      }
      writeFileSync(file, JSON.stringify(login, null, 2), { mode: 0o600 });
      // A file that was already there keeps its mode: make sure it's only the office's.
      chmodSync(file, 0o600);
    } catch (err) {
      // Never the token: just which file.
      console.error(`agent-office: couldn't save the Jira sign-in in ${file}: ${(err as NodeJS.ErrnoException).code ?? 'error'}`);
    }
  }
}
