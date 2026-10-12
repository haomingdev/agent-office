// A GitLab floor's boards: its issues and merge requests, and what the office does to them. The same
// as the GitHub boards (server/github.ts) to everything around it, through `glab api`.
import type { GhCloseReason, GhComment, GhIssue, GhIssueDetail, GhLabel, GhMergeMethod, GhPull, GhPullDetail, GhRepoInfo, GhState } from '../../shared/protocol.js';
import { Claims } from '../github.js';
import type { Forge } from '../forge.js';
import type { GhAs } from '../signins.js';
import { GitLabApi, discussionsOf, glab, issueOf, jobCheck, labelsOf, mergeStatusOf, notesOf, pullOf, stateOf, type GlabRunner } from './api.js';

const REFRESH_MS = 90_000;
const LABELS_MS = 60_000;

const MR_FIELDS = [
  'iid',
  'title',
  'state',
  'draft',
  'webUrl',
  'author { username }',
  'labels { nodes { title color } }',
  'approved',
  'reviewers { nodes { username mergeRequestInteraction { reviewState } } }',
  'sourceBranch',
  'targetBranch',
  'diffHeadSha',
  'createdAt',
  'updatedAt',
  'diffStatsSummary { additions deletions }',
  'headPipeline { status }',
  'description',
];
const REQUIRED_MR_FIELDS = new Set(['iid', 'title', 'state']);

/** The field GitLab's GraphQL doesn't have (an older GitLab, or CE without the EE ones): "Field 'approved' doesn't exist on type 'MergeRequest'". */
function missingField(message: string): string | undefined {
  return /Field '(\w+)' doesn't exist on type/i.exec(message)?.[1];
}

export class GitLab implements Forge {
  readonly kind = 'gitlab' as const;
  issues: GhState<GhIssue> = { items: [], fetchedAt: 0, loading: false };
  pulls: GhState<GhPull> = { items: [], fetchedAt: 0, loading: false };
  readonly api: GitLabApi;
  private timer?: NodeJS.Timeout;
  private repo?: Promise<GhRepoInfo>;
  private login?: Promise<string>;
  private labelList?: { at: number; list: Promise<GhLabel[]> };
  private relabeled = new Map<string, { labels: GhLabel[]; at: number }>();
  private claims = new Claims();
  private listing?: Promise<void>;
  /** GraphQL fields this GitLab turned away, left out of the next lists. */
  private dropped = new Set<string>();

  constructor(
    dir: string,
    project: { host: string; path: string },
    private onIssues: (s: GhState<GhIssue>) => void,
    private onPulls: (s: GhState<GhPull>) => void,
    run: GlabRunner = glab,
  ) {
    this.api = new GitLabApi(project.host, project.path, dir, run);
  }

  start() {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS);
  }

  stop() {
    clearInterval(this.timer);
  }

  async refresh() {
    await Promise.all([this.refreshIssues(), this.refreshPulls()]);
  }

  /** The project's full path and how it lets MRs merge: squash, a merge commit, or (by its settings) either. */
  repoInfo(): Promise<GhRepoInfo> {
    this.repo ??= this.api.get('').then((p: any) => {
      const squash = String(p.squash_option ?? 'default_off');
      const methods: GhMergeMethod[] = squash === 'always' ? ['squash'] : squash === 'never' ? ['merge'] : squash === 'default_on' ? ['squash', 'merge'] : ['merge', 'squash'];
      return { nameWithOwner: String(p.path_with_namespace ?? this.api.path), methods };
    });
    this.repo.catch(() => (this.repo = undefined));
    return this.repo;
  }

  /** Who the office's own glab is signed in as. Asked once; '' when glab can't say. */
  viewer(): Promise<string> {
    this.login ??= this.api.get('/user').then((u: any) => String(u?.username ?? ''));
    this.login.catch(() => (this.login = undefined));
    return this.login.catch(() => '');
  }

  async pullDetail(n: number, me?: string): Promise<GhPullDetail> {
    const mr = `merge_requests/${n}`;
    const [m, discussions, approvals, commits, reviewers, repo, viewer] = await Promise.all([
      this.api.get(mr),
      this.api.list(`${mr}/discussions`, 500),
      this.api.get(`${mr}/approvals`).catch(() => undefined),
      this.api.list(`${mr}/commits`, 250),
      this.api.get<any[]>(`${mr}/reviewers`).catch(() => []),
      this.repoInfo(),
      me ?? this.viewer(),
    ]);
    const url = String(m.web_url ?? `${this.api.webUrl}/-/merge_requests/${n}`);
    const { comments, reviewComments } = discussionsOf(discussions, url);
    const jobs = m.head_pipeline?.id ? await this.api.list(`pipelines/${m.head_pipeline.id}/jobs`, 200).catch(() => []) : [];
    const approvedBy: any[] = approvals?.approved_by ?? [];
    const changes = (reviewers ?? []).some((r: any) => r.state === 'requested_changes');
    const reviewDecision = changes ? 'CHANGES_REQUESTED' : approvals?.approved && approvedBy.length ? 'APPROVED' : Number(approvals?.approvals_left ?? 0) > 0 ? 'REVIEW_REQUIRED' : '';
    return {
      number: n,
      body: String(m.description ?? ''),
      state: stateOf(m.state),
      isDraft: !!(m.draft ?? m.work_in_progress),
      reviewDecision,
      headRefName: String(m.source_branch ?? ''),
      baseRefName: String(m.target_branch ?? ''),
      ...mergeStatusOf(m.detailed_merge_status, m.has_conflicts === true),
      commits: commits.length,
      comments,
      reviews: approvedBy.map((a: any) => ({ id: `approval-${a.user?.id}`, author: a.user?.username ?? 'ghost', body: '', createdAt: '', state: 'APPROVED' })),
      reviewComments,
      checks: jobs.map(jobCheck),
      repo,
      viewer,
    };
  }

  /** The MR's unified diff, as `git diff` prints it. */
  pullDiff(n: number): Promise<string> {
    return this.api.rest<string>('GET', `merge_requests/${n}/raw_diffs`, { text: true, timeout: 60_000 });
  }

  async issueDetail(n: number, me?: string): Promise<GhIssueDetail> {
    const [i, notes, viewer] = await Promise.all([this.api.get(`issues/${n}`), this.api.list(`issues/${n}/notes?sort=asc`, 500), me ?? this.viewer()]);
    return { number: n, state: i.state === 'opened' ? 'OPEN' : 'CLOSED', body: String(i.description ?? ''), comments: notesOf(notes, String(i.web_url ?? '')), viewer };
  }

  private path(kind: 'issue' | 'pull', n: number): string {
    return `${kind === 'issue' ? 'issues' : 'merge_requests'}/${n}`;
  }

  async comment(kind: 'issue' | 'pull', n: number, body: string, as?: GhAs): Promise<{ comment?: GhComment; error?: string }> {
    let comment: GhComment;
    try {
      // -f sends the body as a plain string: no @file reading.
      const note = await this.api.rest('POST', `${this.path(kind, n)}/notes`, { raw: { body }, env: as?.env });
      const url = `${this.api.webUrl}/-/${kind === 'issue' ? 'issues' : 'merge_requests'}/${n}`;
      [comment] = notesOf([note], url);
    } catch (err) {
      return { error: (err as Error).message };
    }
    void (kind === 'issue' ? this.refreshIssues() : this.refreshPulls());
    return { comment };
  }

  /** Posts the meeting room's review on an MR as a comment, its body read from a file. Resolves to its URL. */
  async review(n: number, file: string, as?: GhAs): Promise<string> {
    const note = await this.api.rest('POST', `merge_requests/${n}/notes`, { typed: { body: `@${file}` }, env: as?.env, timeout: 60_000 });
    void this.refreshPulls();
    return `${this.api.webUrl}/-/merge_requests/${n}#note_${note?.id}`;
  }

  /** Merges an MR (squashed, or with a merge commit), or with `auto` once its pipeline passes. Returns an error. */
  async merge(n: number, method: GhMergeMethod, deleteBranch: boolean, auto: boolean, as?: GhAs): Promise<string | undefined> {
    try {
      const typed: Record<string, string> = { squash: String(method === 'squash'), should_remove_source_branch: String(deleteBranch) };
      // auto_merge since GitLab 17; merge_when_pipeline_succeeds before it (each ignores the other).
      if (auto) Object.assign(typed, { auto_merge: 'true', merge_when_pipeline_succeeds: 'true' });
      await this.api.rest('PUT', `merge_requests/${n}/merge`, { typed, env: as?.env, timeout: 90_000 });
    } catch (err) {
      return (err as Error).message;
    }
    void this.refreshPulls();
    return undefined;
  }

  /** Closes an issue, or an MR without merging it, optionally saying why. GitLab keeps no reason, so it goes in the comment. */
  async close(kind: 'issue' | 'pull', n: number, opts: { comment?: string; reason?: GhCloseReason; deleteBranch?: boolean }, as?: GhAs): Promise<string | undefined> {
    try {
      const why = kind === 'issue' && opts.reason === 'not planned' ? 'Closed as not planned.' : '';
      const comment = [opts.comment, why].filter(Boolean).join('\n\n');
      if (comment) await this.api.rest('POST', `${this.path(kind, n)}/notes`, { raw: { body: comment }, env: as?.env });
      const closed = await this.api.rest('PUT', this.path(kind, n), { raw: { state_event: 'close' }, env: as?.env });
      // A fork's MR has its branch in the fork: one by that name here is someone else's.
      if (kind === 'pull' && opts.deleteBranch && closed?.source_branch && closed.source_project_id === closed.target_project_id) {
        await this.api.rest('DELETE', `repository/branches/${encodeURIComponent(closed.source_branch)}`, { env: as?.env, text: true });
      }
    } catch (err) {
      return (err as Error).message;
    }
    const refresh = () => (kind === 'issue' ? this.refreshIssues() : this.refreshPulls());
    void refresh().then(() => {
      if ((kind === 'issue' ? this.issues : this.pulls).items.some((i) => i.number === n && i.state === 'OPEN')) setTimeout(() => void refresh(), 3000);
    });
    return undefined;
  }

  /** Every label the project has, its group's too, for the label picker. */
  repoLabels(): Promise<GhLabel[]> {
    if (!this.labelList || Date.now() - this.labelList.at > LABELS_MS) {
      const list = this.api.list('labels?include_ancestor_groups=true', 1000).then(labelsOf);
      this.labelList = { at: Date.now(), list };
      list.catch(() => this.labelList?.list === list && (this.labelList = undefined));
    }
    return this.labelList.list;
  }

  async setLabels(kind: 'issue' | 'pull', n: number, add: string[], remove: string[], as?: GhAs): Promise<{ labels?: GhLabel[]; error?: string }> {
    let now: GhLabel[];
    try {
      // A label's name can't have a comma in it on GitLab, so the lists are safe to join.
      const raw: Record<string, string> = {};
      if (add.length) raw.add_labels = add.join(',');
      if (remove.length) raw.remove_labels = remove.join(',');
      const it = await this.api.rest('PUT', this.path(kind, n), { raw, env: as?.env });
      const colors = new Map((await this.repoLabels().catch(() => [] as GhLabel[])).map((l) => [l.name, l.color]));
      now = (it?.labels ?? []).map((name: string) => ({ name, color: colors.get(name) ?? '#888888' }));
    } catch (err) {
      void (kind === 'issue' ? this.refreshIssues() : this.refreshPulls());
      return { error: (err as Error).message };
    }
    const at = Date.now();
    this.relabeled.set(`${kind}:${n}`, { labels: now, at });
    if (kind === 'issue') {
      this.issues = { ...this.issues, items: this.relabel('issue', this.issues.items, at) };
      this.onIssues(this.issues);
      void this.refreshIssues();
    } else {
      this.pulls = { ...this.pulls, items: this.relabel('pull', this.pulls.items, at) };
      this.onPulls(this.pulls);
      void this.refreshPulls();
    }
    return { labels: now };
  }

  /** See GitHub.relabel. */
  private relabel<T extends GhIssue | GhPull>(kind: 'issue' | 'pull', items: T[], asked: number): T[] {
    return items.map((it) => {
      const key = `${kind}:${it.number}`;
      const r = this.relabeled.get(key);
      if (!r) return it;
      if (r.at < asked) {
        this.relabeled.delete(key);
        return it;
      }
      return { ...it, labels: r.labels };
    });
  }

  /** A worker took the issue: In progress at once, and assigned on GitLab to `as` (else the office's glab) alongside whoever has it. */
  async claim(issue: number, as?: GhAs): Promise<string | undefined> {
    const answered = this.claims.take(issue);
    this.showClaims();
    try {
      const [me, it] = await Promise.all([this.api.get('/user', as?.env), this.api.get(`issues/${issue}`)]);
      const ids = [...new Set([...(it?.assignees ?? []).map((a: any) => Number(a.id)), Number(me.id)])];
      await this.api.rest('PUT', `issues/${issue}`, { typed: { assignee_ids: JSON.stringify(ids) }, env: as?.env });
    } catch (err) {
      answered(false);
      this.showClaims();
      return (err as Error).message;
    }
    answered(true);
    void this.refreshIssues().then(() => (this.claims.has(issue) ? this.refreshIssues() : undefined));
    return undefined;
  }

  private showClaims() {
    this.issues = { ...this.issues, items: this.claims.mark(this.issues.items) };
    this.onIssues(this.issues);
  }

  private refreshIssues(): Promise<void> {
    this.listing ??= this.listIssues().finally(() => (this.listing = undefined));
    return this.listing;
  }

  private async listIssues() {
    this.issues = { ...this.issues, loading: true };
    this.onIssues(this.issues);
    const asked = Date.now();
    try {
      // Open and closed separately, so old open issues are never crowded out by recent closed ones.
      const [open, closed] = await Promise.all([
        this.api.list('issues?state=opened&with_labels_details=true&order_by=updated_at', 300),
        this.api.list('issues?state=closed&with_labels_details=true&order_by=updated_at', 40),
      ]);
      const items = this.claims.mark(this.relabel('issue', [...open, ...closed].map(issueOf), asked), asked);
      this.issues = { items, fetchedAt: Date.now(), loading: false };
    } catch (err) {
      this.issues = { ...this.issues, loading: false, error: (err as Error).message, fetchedAt: Date.now() };
    }
    this.onIssues(this.issues);
  }

  private async refreshPulls() {
    if (this.pulls.loading) return;
    this.pulls = { ...this.pulls, loading: true };
    this.onPulls(this.pulls);
    const asked = Date.now();
    try {
      const [open, merged, closed] = await Promise.all([this.listPulls('opened', 150), this.listPulls('merged', 30), this.listPulls('closed', 40)]);
      const seen = new Set<number>();
      const all = [...open, ...merged, ...closed].map(pullOf).filter((p) => !seen.has(p.number) && seen.add(p.number));
      this.pulls = { items: this.relabel('pull', all, asked), fetchedAt: Date.now(), loading: false };
    } catch (err) {
      this.pulls = { ...this.pulls, loading: false, error: (err as Error).message, fetchedAt: Date.now() };
    }
    this.onPulls(this.pulls);
  }

  /** MRs in one state, newest activity first, through GraphQL: one call has their pipelines, approvals and sizes. */
  private async listPulls(state: string, limit: number): Promise<any[]> {
    for (;;) {
      const fields = MR_FIELDS.filter((f) => !this.dropped.has(f.split(' ')[0]));
      const nodes: any[] = [];
      try {
        let after = '';
        while (nodes.length < limit) {
          const first = Math.min(100, limit - nodes.length);
          const query = `query($p: ID!, $after: String) { project(fullPath: $p) { mergeRequests(state: ${state}, first: ${first}, after: $after, sort: UPDATED_DESC) { pageInfo { hasNextPage endCursor } nodes { ${fields.join(' ')} } } } }`;
          const data = await this.api.graphql(query, after ? { p: this.api.path, after } : { p: this.api.path });
          const page = data?.project?.mergeRequests;
          if (!data?.project) throw new Error("glab can't find this project on GitLab (check the remote and access)");
          nodes.push(...(page?.nodes ?? []));
          if (!page?.pageInfo?.hasNextPage) break;
          after = page.pageInfo.endCursor;
        }
        return nodes;
      } catch (err) {
        // A field inside another (reviewers' mergeRequestInteraction) takes the one it's in with it.
        // The three lists ask at once, so another may have dropped it already: what counts is whether this one asked for it.
        const missing = missingField((err as Error).message);
        const field = missing && MR_FIELDS.find((f) => new RegExp(`\\b${missing}\\b`).test(f))?.split(' ')[0];
        if (!field || REQUIRED_MR_FIELDS.has(field) || !fields.some((f) => f.split(' ')[0] === field)) throw err;
        this.dropped.add(field);
      }
    }
  }
}
