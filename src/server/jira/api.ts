// Talking to Jira Cloud's REST API: Basic auth with an Atlassian account's email and API token, over
// Node's fetch (or a fake one, in the tests), with a timeout, and Jira's errors turned into something
// a person at the board can act on. A token never goes into an error, a log or a browser.

/** An Atlassian account's email and API token (https://id.atlassian.com/manage-profile/security/api-tokens). */
export interface JiraAuth {
  email: string;
  token: string;
}

/** As much of fetch as the office uses: the global one, or a fake Jira's. */
export type JiraFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }) => Promise<{ status: number; ok: boolean; text(): Promise<string> }>;

const TIMEOUT_MS = 20_000;

/** A request Jira turned down, with its HTTP status (0: it never got there). */
export class JiraError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** What Jira said went wrong, from its error body ({ errorMessages, errors }), if it said. */
function jiraSaid(text: string): string {
  try {
    const body = JSON.parse(text);
    const msgs = [...(Array.isArray(body?.errorMessages) ? body.errorMessages : []), ...Object.values(body?.errors ?? {})].filter((m): m is string => typeof m === 'string' && !!m.trim());
    if (msgs.length) return msgs.join(' ');
    if (typeof body?.message === 'string') return body.message;
  } catch {
    // not JSON (an HTML error page): nothing worth repeating
  }
  return '';
}

/** Turns Jira's answer to a request that failed into a sentence; `what` names what was asked for ("board 143"). */
export function friendlyJiraError(status: number, said: string, what = 'that'): string {
  if (status === 401) return "Jira didn't accept the email and API token: the token is wrong or has expired. Make a new one at id.atlassian.com → Security → API tokens";
  if (status === 403) return `That Jira account has no access to ${what}${said ? ` (Jira says: ${said})` : ''}`;
  if (status === 404) return `Jira can't find ${what}, or that account can't see it: check the board link and that the account has access${said ? ` (Jira says: ${said})` : ''}`;
  if (status === 429) return 'Jira is asking the office to slow down: try again in a minute';
  return said ? `Jira said: ${said}` : `Jira answered HTTP ${status}`;
}

/** One Jira site, as one account. */
export class JiraApi {
  constructor(
    readonly site: string,
    private auth: JiraAuth,
    private fetchFn: JiraFetch = fetch as unknown as JiraFetch,
    private timeoutMs = TIMEOUT_MS,
  ) {}

  /** The account it acts as, for telling apart (never the token). */
  get email(): string {
    return this.auth.email;
  }

  get<T = any>(path: string, what?: string): Promise<T> {
    return this.call<T>('GET', path, undefined, what);
  }

  /**
   * A request to `path` (/rest/…) with a JSON `body`; resolves to Jira's JSON answer (undefined for
   * none, like a 204), or rejects with a JiraError that says what went wrong.
   */
  async call<T = any>(method: string, path: string, body?: unknown, what?: string): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Basic ${Buffer.from(`${this.auth.email}:${this.auth.token}`).toString('base64')}`,
      accept: 'application/json',
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res: Awaited<ReturnType<JiraFetch>>;
    try {
      res = await this.fetchFn(`${this.site}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      const e = err as Error;
      const why = e.name === 'TimeoutError' || e.name === 'AbortError' ? `no answer in ${Math.round(this.timeoutMs / 1000)}s` : e.message;
      throw new JiraError(`Couldn't reach Jira at ${new URL(this.site).host}: ${why}`, 0);
    }
    const text = await res.text().catch(() => '');
    if (!res.ok) throw new JiraError(friendlyJiraError(res.status, jiraSaid(text), what), res.status);
    if (!text.trim()) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new JiraError(`Jira's answer wasn't JSON (is ${new URL(this.site).host} a Jira site?)`, res.status);
    }
  }
}
