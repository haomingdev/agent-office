// Where a floor's repository lives: GitHub (through `gh`) or a GitLab (through `glab`). Everything
// about issues and pull requests goes through here, so the rest of the office never asks which.
// A GitLab merge request is a pull request to the office: its boards, windows and workers use the
// same types (shared/protocol/github.ts) for both.
import { execFileSync } from 'node:child_process';
import type { GhCloseReason, GhComment, GhIssue, GhIssueDetail, GhLabel, GhMergeMethod, GhPull, GhPullDetail, GhRepoInfo, GhState } from '../shared/protocol.js';
import { gitlabProject, normalizeRepo, repoForge, type ForgeKind } from '../shared/floors.js';
import { GitHub, gh } from './github.js';
import { GitLab } from './gitlab/boards.js';
import { GitLabApi, glab, stateOf } from './gitlab/api.js';
import { isGitLabHost } from './gitlab/repos.js';
import type { GhAs } from './signins.js';

/** A floor's issues and pull requests, kept fresh, and what the office does to them (see GitHub and GitLab). */
export interface Forge {
  readonly kind: ForgeKind;
  issues: GhState<GhIssue>;
  pulls: GhState<GhPull>;
  start(): void;
  stop(): void;
  refresh(): Promise<void>;
  repoInfo(): Promise<GhRepoInfo>;
  pullDetail(n: number, me?: string): Promise<GhPullDetail>;
  pullDiff(n: number): Promise<string>;
  issueDetail(n: number, me?: string): Promise<GhIssueDetail>;
  comment(kind: 'issue' | 'pull', n: number, body: string, as?: GhAs): Promise<{ comment?: GhComment; error?: string }>;
  review(n: number, file: string, as?: GhAs): Promise<string>;
  merge(n: number, method: GhMergeMethod, deleteBranch: boolean, auto: boolean, as?: GhAs): Promise<string | undefined>;
  close(kind: 'issue' | 'pull', n: number, opts: { comment?: string; reason?: GhCloseReason; deleteBranch?: boolean }, as?: GhAs): Promise<string | undefined>;
  repoLabels(): Promise<GhLabel[]>;
  setLabels(kind: 'issue' | 'pull', n: number, add: string[], remove: string[], as?: GhAs): Promise<{ labels?: GhLabel[]; error?: string }>;
  claim(issue: number, as?: GhAs): Promise<string | undefined>;
}

/** A floor's boards: GitLab's for a GitLab repository, else GitHub's (which say so when there's no GitHub remote). */
export function forgeFor(dir: string, repo: string | undefined, onIssues: (s: GhState<GhIssue>) => void, onPulls: (s: GhState<GhPull>) => void): Forge {
  const lab = gitlabProject(repo);
  return lab ? new GitLab(dir, lab, onIssues, onPulls) : new GitHub(dir, onIssues, onPulls);
}

/** The repository a checkout's origin points at: owner/name on GitHub, host/group/…/project on a GitLab. */
export function originOf(dir: string): string | undefined {
  let repo: string | undefined;
  try {
    repo = normalizeRepo(execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim());
  } catch {
    return undefined;
  }
  // Another host that isn't a GitLab (GitHub Enterprise): gh, in the checkout, knows it.
  const lab = gitlabProject(repo);
  return lab && !isGitLabHost(lab.host) ? undefined : repo;
}

// --- Pull requests from a checkout ------------------------------------------------------------------

export interface OpenPull {
  number: number;
  url: string;
}

/** Opening and reading a branch's pull request (a merge request on GitLab), from a checkout of its repository. */
export interface PullRequests {
  readonly kind: ForgeKind;
  /** "PR" or "MR", for what the office says. */
  readonly short: string;
  /** The open one whose head is `branch`. */
  find(branch: string, cwd: string): Promise<OpenPull | undefined>;
  /** Opens one for a pushed branch; without `base`, into the repository's default branch. */
  create(branch: string, base: string | undefined, title: string, body: string, cwd: string, as?: GhAs): Promise<OpenPull>;
  body(url: string, cwd: string, as?: GhAs): Promise<string>;
  setBody(url: string, body: string, cwd: string, as?: GhAs): Promise<void>;
  /** Its page and OPEN, MERGED or CLOSED. */
  view(n: number, cwd: string): Promise<{ url: string; state: string }>;
}

const github: PullRequests = {
  kind: 'github',
  short: 'PR',
  async find(branch, cwd) {
    const out = await gh(['pr', 'list', '--head', branch, '--state', 'open', '--limit', '1', '--json', 'number,url'], cwd);
    const found = (JSON.parse(out || '[]') as OpenPull[])[0];
    return found ? { number: found.number, url: found.url } : undefined;
  },
  async create(branch, base, title, body, cwd, as) {
    const out = await gh(['pr', 'create', '--head', branch, ...(base ? ['--base', base] : []), '--title', title, '--body', body], cwd, 60_000, as?.env);
    const url = out.trim().split('\n').pop() ?? '';
    const number = Number(/\/pull\/(\d+)/.exec(url)?.[1]);
    if (!number) throw new Error(`gh did not return a pull request URL (${out.trim().slice(0, 120)})`);
    return { number, url };
  },
  body: (url, cwd, as) => gh(['pr', 'view', url, '--json', 'body', '--jq', '.body'], cwd, 30_000, as?.env),
  async setBody(url, body, cwd, as) {
    await gh(['pr', 'edit', url, '--body', body], cwd, 60_000, as?.env);
  },
  async view(n, cwd) {
    return JSON.parse(await gh(['pr', 'view', String(n), '--json', 'url,state'], cwd)) as { url: string; state: string };
  },
};

/** The checkout's project on its GitLab, from its origin. */
function labOf(cwd: string): GitLabApi {
  const lab = gitlabProject(originOf(cwd));
  if (!lab) throw new Error("This checkout's origin isn't a GitLab project");
  return new GitLabApi(lab.host, lab.path, cwd, glab);
}

/** iid from an MR's page: https://host/group/project/-/merge_requests/12. */
function iidOf(url: string): number {
  const n = Number(/\/-\/merge_requests\/(\d+)/.exec(url)?.[1]);
  if (!n) throw new Error(`Not a GitLab merge request: ${url}`);
  return n;
}

const gitlab: PullRequests = {
  kind: 'gitlab',
  short: 'MR',
  async find(branch, cwd) {
    const found = (await labOf(cwd).get<any[]>(`merge_requests?state=opened&source_branch=${encodeURIComponent(branch)}&per_page=1`))?.[0];
    return found ? { number: Number(found.iid), url: String(found.web_url) } : undefined;
  },
  async create(branch, base, title, body, cwd, as) {
    const api = labOf(cwd);
    const target = base ?? String((await api.get('')).default_branch ?? 'main');
    const mr = await api.rest('POST', 'merge_requests', { raw: { source_branch: branch, target_branch: target, title, description: body }, env: as?.env, timeout: 60_000 });
    if (!mr?.iid) throw new Error('GitLab did not return the merge request');
    return { number: Number(mr.iid), url: String(mr.web_url) };
  },
  async body(url, cwd, as) {
    return String((await labOf(cwd).get(`merge_requests/${iidOf(url)}`, as?.env)).description ?? '');
  },
  async setBody(url, body, cwd, as) {
    await labOf(cwd).rest('PUT', `merge_requests/${iidOf(url)}`, { raw: { description: body }, env: as?.env, timeout: 60_000 });
  },
  async view(n, cwd) {
    const mr = await labOf(cwd).get(`merge_requests/${n}`);
    return { url: String(mr.web_url), state: stateOf(mr.state) };
  },
};

/** Pull requests (or merge requests) for a repository as normalizeRepo gives it; GitHub's when it's unknown. */
export function pullRequests(repo: string | undefined): PullRequests {
  return repoForge(repo) === 'gitlab' ? gitlab : github;
}

/** The same, for the checkout at `cwd`. */
export function pullRequestsAt(cwd: string): PullRequests {
  return pullRequests(originOf(cwd));
}
