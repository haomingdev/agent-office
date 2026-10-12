// Talking to a GitLab (gitlab.com or a company's own) through `glab api`, and reading what it says
// as the boards' GitHub-shaped types (shared/protocol/github.ts), so the windows work unchanged.
import { execFile } from 'node:child_process';
import type { GhCheck, GhComment, GhIssue, GhLabel, GhPull, GhReviewComment } from '../../shared/protocol.js';

export type GlabRunner = (args: string[], cwd: string, timeout?: number, env?: Record<string, string>) => Promise<string>;

/** Turns glab's stderr into something a person standing at the board can act on. */
export function friendlyGlabError(raw: string): string {
  const lines = raw.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  const text = lines.join(' ');
  if (/401|unauthorized|not authenticated|no token|glab auth login/i.test(text)) return "glab isn't signed in to this GitLab on the office's machine — run `glab auth login --hostname <host>` there";
  if (/no such host|could not resolve host|dial tcp|i\/o timeout|connection refused|tls handshake/i.test(text)) return "The office can't reach this GitLab (check the network or VPN)";
  if (/404|not found/i.test(text)) return "glab can't find this project on GitLab (check the remote and access)";
  if (/403|forbidden/i.test(text)) return "GitLab says this account isn't allowed to do that";
  return lines.slice(-2).join(' ') || raw;
}

/** How many glab calls run at once, across every floor. */
const MAX_RUNNING = 8;
/** What a GitLab that's there says when the way to it hiccups: worth one more try. */
const TRANSIENT = /i\/o timeout|lookup .* (?:no such host|server misbehaving)|tls handshake timeout|connection reset/i;
let running = 0;
const waiting: (() => void)[] = [];

async function turn<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= MAX_RUNNING) await new Promise<void>((go) => waiting.push(go));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

/** One run of glab: its output, or what it said on failing (and whether it never started). */
function once(args: string[], cwd: string, timeout: number, env: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('glab', args, { cwd, maxBuffer: 32 * 1024 * 1024, timeout, env }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      const e = new Error((stderr || stdout || err.message || '').trim()) as NodeJS.ErrnoException;
      e.code = (err as NodeJS.ErrnoException).code;
      reject(e);
    });
  });
}

/**
 * The environment glab runs in: no prompts (nobody would see them), plain errors, and Go's own DNS
 * resolver. A company GitLab is often reached over a VPN, and on a Mac the system resolver glab uses
 * by default times out when several look it up at once (as a building's boards do); Go's doesn't.
 */
export function glabEnv(env: Record<string, string | undefined>): Record<string, string> {
  return { ...env, GLAB_NO_PROMPT: '1', NO_COLOR: '1', GODEBUG: env.GODEBUG || 'netdns=go' } as Record<string, string>;
}

/** Runs glab as the office, or with `env` as someone signed in to their own GitLab (see signins.ts). */
export function glab(args: string[], cwd: string, timeout = 30_000, env?: Record<string, string>): Promise<string> {
  const full = glabEnv(env ?? process.env);
  return turn(() => once(args, cwd, timeout, full).catch((err: NodeJS.ErrnoException) => (TRANSIENT.test(err.message) ? new Promise<string>((r) => setTimeout(r, 1000)).then(() => once(args, cwd, timeout, full)) : Promise.reject(err)))).catch((err: NodeJS.ErrnoException) => {
    const msg = err.message;
    const signedOut = env && /401|unauthorized|not authenticated|no token/i.test(msg);
    throw new Error(err.code === 'ENOENT' ? 'GitLab CLI (glab) is not installed on the server' : signedOut ? 'Your GitLab sign-in stopped working — sign in again (☰ → 🔐 Your sign-ins)' : friendlyGlabError(msg));
  });
}

/** One project on one GitLab: REST paths under /api/v4 and GraphQL, through glab. */
export class GitLabApi {
  /** The project's id in REST paths: its full path, URL-encoded. */
  readonly id: string;

  constructor(
    readonly host: string,
    readonly path: string,
    private cwd: string,
    private run: GlabRunner = glab,
  ) {
    this.id = encodeURIComponent(path);
  }

  /** Its page: https://host/group/project. */
  get webUrl(): string {
    return `https://${this.host}/${this.path}`;
  }

  /** A REST call; `rel` is under projects/<id>/ unless it starts with "/". Fields: -f (strings) or -F (typed). */
  async rest<T = any>(method: string, rel: string, opts: { raw?: Record<string, string>; typed?: Record<string, string>; env?: Record<string, string>; timeout?: number; text?: boolean } = {}): Promise<T> {
    const where = rel.startsWith('/') ? rel.slice(1) : `projects/${this.id}${rel ? `/${rel}` : ''}`;
    const args = ['api', '--hostname', this.host, '--method', method, where];
    for (const [k, v] of Object.entries(opts.raw ?? {})) args.push('-f', `${k}=${v}`);
    for (const [k, v] of Object.entries(opts.typed ?? {})) args.push('-F', `${k}=${v}`);
    const out = await this.run(args, this.cwd, opts.timeout, opts.env);
    if (opts.text) return out as T;
    return (out.trim() ? JSON.parse(out) : undefined) as T;
  }

  get<T = any>(rel: string, env?: Record<string, string>): Promise<T> {
    return this.rest<T>('GET', rel, { env });
  }

  /** Up to `limit` items of a list, a page of 100 at a time. */
  async list<T = any>(rel: string, limit: number): Promise<T[]> {
    const all: T[] = [];
    const per = Math.min(100, limit);
    for (let page = 1; all.length < limit; page++) {
      const items = await this.get<T[]>(`${rel}${rel.includes('?') ? '&' : '?'}per_page=${per}&page=${page}`);
      all.push(...(items ?? []));
      if (!items || items.length < per) break;
    }
    return all.slice(0, limit);
  }

  /** A GraphQL query, with its variables as strings. */
  async graphql<T = any>(query: string, vars: Record<string, string>): Promise<T> {
    const args = ['api', '--hostname', this.host, 'graphql', '-f', `query=${query}`];
    for (const [k, v] of Object.entries(vars)) args.push('-f', `${k}=${v}`);
    const res = JSON.parse(await this.run(args, this.cwd, 60_000));
    if (res.errors?.length) throw new Error(String(res.errors[0]?.message ?? 'GraphQL error'));
    return res.data as T;
  }
}

// --- What GitLab says, as the boards read it --------------------------------------------------------

/** GitLab's states, as GitHub's: opened (or locked, an MR while it merges) → OPEN, merged → MERGED, closed → CLOSED. */
export function stateOf(s: unknown): string {
  const v = String(s ?? '').toLowerCase();
  return v === 'opened' || v === 'locked' ? 'OPEN' : v === 'merged' ? 'MERGED' : 'CLOSED';
}

/** Labels from REST (with_labels_details) or GraphQL ({title, color}). */
export function labelsOf(raw: any[]): GhLabel[] {
  return (raw ?? []).map((l) => (typeof l === 'string' ? { name: l, color: '#888888' } : { name: String(l.name ?? l.title), color: String(l.color ?? '#888888'), ...(l.description ? { description: String(l.description) } : {}) }));
}

/** The issues an MR closes, as GitLab's default closing pattern reads its description: "Closes #12, #13". */
export function closesOf(body: string): number[] {
  const out = new Set<number>();
  for (const m of body.matchAll(/\b(?:clos(?:e|es|ed|ing)|fix(?:|es|ed|ing)|resolv(?:e|es|ed|ing)|implement(?:|s|ed|ing))\b:?((?:\s*(?:,|and)?\s*#\d+)+)/gi)) {
    for (const n of m[1].matchAll(/#(\d+)/g)) out.add(Number(n[1]));
  }
  return [...out];
}

export function issueOf(i: any): GhIssue {
  return {
    number: Number(i.iid),
    title: String(i.title ?? ''),
    state: stateOf(i.state),
    url: String(i.web_url ?? ''),
    author: i.author?.username ?? '',
    labels: labelsOf(i.labels),
    assignees: (i.assignees ?? []).map((a: any) => String(a.username)),
    createdAt: i.created_at ?? '',
    updatedAt: i.updated_at ?? i.created_at ?? '',
    body: String(i.description ?? '').slice(0, 4000),
    comments: Number(i.user_notes_count ?? 0),
  };
}

/** A pipeline's status as a board card's checks (GraphQL says SUCCESS, REST success). */
export function pipelineChecks(status: unknown): GhPull['checks'] {
  const s = String(status ?? '').toLowerCase();
  if (!s) return 'none';
  if (s === 'success' || s === 'manual' || s === 'skipped') return 'pass';
  if (s === 'failed' || s === 'canceled' || s === 'canceling') return 'fail';
  return 'pending';
}

/** An MR from the GraphQL list (see GitLab.listPulls). */
export function pullOf(m: any): GhPull {
  const body = String(m.description ?? '');
  const changes = (m.reviewers?.nodes ?? []).some((r: any) => /REQUESTED_CHANGES/i.test(String(r.mergeRequestInteraction?.reviewState ?? '')));
  return {
    number: Number(m.iid),
    title: String(m.title ?? ''),
    state: stateOf(m.state),
    isDraft: !!m.draft,
    url: String(m.webUrl ?? ''),
    author: m.author?.username ?? '',
    labels: labelsOf(m.labels?.nodes),
    reviewDecision: changes ? 'CHANGES_REQUESTED' : m.approved ? 'APPROVED' : '',
    headRefName: String(m.sourceBranch ?? ''),
    headRefOid: typeof m.diffHeadSha === 'string' ? m.diffHeadSha : undefined,
    baseRefName: String(m.targetBranch ?? ''),
    createdAt: m.createdAt ?? '',
    updatedAt: m.updatedAt ?? m.createdAt ?? '',
    additions: Number(m.diffStatsSummary?.additions ?? 0),
    deletions: Number(m.diffStatsSummary?.deletions ?? 0),
    checks: pipelineChecks(m.headPipeline?.status),
    body: body.slice(0, 4000),
    closes: closesOf(body),
  };
}

/** A job of the MR's pipeline, as one of its checks. */
export function jobCheck(j: any): GhCheck {
  const s = String(j.status ?? '').toLowerCase();
  let state: GhCheck['state'] = 'pass';
  if (s === 'failed') state = j.allow_failure ? 'skip' : 'fail';
  else if (s === 'canceled') state = 'fail';
  else if (s === 'skipped' || s === 'manual') state = 'skip';
  else if (s !== 'success') state = 'pending';
  return { name: j.stage ? `${j.stage} / ${j.name}` : String(j.name ?? 'job'), state, url: j.web_url ?? undefined };
}

/**
 * Whether an MR can merge, as GitHub's mergeable and mergeStateStatus (what the merge dialog reads),
 * from GitLab's detailed_merge_status.
 */
export function mergeStatusOf(detailed: unknown, conflicts: boolean): { mergeable: string; mergeStateStatus: string } {
  const d = String(detailed ?? '').toLowerCase();
  if (conflicts || d === 'conflict' || d === 'broken_status') return { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' };
  if (!d || ['checking', 'unchecked', 'preparing', 'approvals_syncing'].includes(d)) return { mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' };
  if (d === 'mergeable') return { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' };
  if (d === 'need_rebase') return { mergeable: 'MERGEABLE', mergeStateStatus: 'BEHIND' };
  if (d === 'draft_status') return { mergeable: 'MERGEABLE', mergeStateStatus: 'DRAFT' };
  if (d === 'ci_still_running') return { mergeable: 'MERGEABLE', mergeStateStatus: 'UNSTABLE' };
  return { mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED' };
}

function noteComment(n: any, url: string): GhComment {
  return { id: String(n.id), author: n.author?.username ?? 'ghost', body: String(n.body ?? ''), createdAt: n.created_at ?? '', url: `${url}#note_${n.id}` };
}

/**
 * An MR's discussions: its conversation (notes on the MR itself) and its line comments (DiffNotes,
 * each reply pointing at the first note of its thread). GitLab's own notes ("added 2 commits") are left out.
 */
export function discussionsOf(discussions: any[], url: string): { comments: GhComment[]; reviewComments: GhReviewComment[] } {
  const comments: GhComment[] = [];
  const reviewComments: GhReviewComment[] = [];
  for (const d of discussions ?? []) {
    const notes = (d.notes ?? []).filter((n: any) => !n.system);
    const first = notes[0];
    if (!first) continue;
    if (first.type !== 'DiffNote' || !first.position) {
      for (const n of notes) comments.push(noteComment(n, url));
      continue;
    }
    for (const n of notes) {
      const p = n.position ?? first.position;
      const right = p.new_line !== null && p.new_line !== undefined;
      reviewComments.push({
        id: Number(n.id),
        replyTo: n === first ? undefined : Number(first.id),
        author: n.author?.username ?? 'ghost',
        body: String(n.body ?? ''),
        createdAt: n.created_at ?? '',
        url: `${url}#note_${n.id}`,
        path: String(p.new_path ?? p.old_path ?? ''),
        line: right ? Number(p.new_line) : p.old_line !== null && p.old_line !== undefined ? Number(p.old_line) : null,
        side: right ? 'RIGHT' : 'LEFT',
      });
    }
  }
  comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return { comments, reviewComments };
}

/** Notes on an issue (or an MR), without GitLab's own, oldest first. */
export function notesOf(notes: any[], url: string): GhComment[] {
  return (notes ?? [])
    .filter((n) => !n.system)
    .map((n) => noteComment(n, url))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
