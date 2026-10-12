import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forgeWords, gitlabProject, normalizeRepo, repoForge } from '../src/shared/floors.js';
import { closesOf, discussionsOf, friendlyGlabError, issueOf, jobCheck, mergeStatusOf, pullOf, stateOf } from '../src/server/gitlab/api.js';
import { GitLab } from '../src/server/gitlab/boards.js';
import { isGitLabHost } from '../src/server/gitlab/repos.js';
import { originOf } from '../src/server/forge.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { GhIssue, GhPull, GhState } from '../src/shared/protocol.js';

test('a GitLab project is named by its host and full path, however it was written', () => {
  const key = 'gitlab.example.com/acme/web/app';
  for (const s of ['git@gitlab.example.com:acme/web/app.git', 'ssh://git@gitlab.example.com:2222/acme/web/app.git', 'https://gitlab.example.com/acme/web/app', 'https://gitlab.example.com/acme/web/app/-/merge_requests/5', 'gitlab.example.com/acme/web/app']) {
    assert.equal(normalizeRepo(s), key, s);
  }
  assert.deepEqual(gitlabProject(key), { host: 'gitlab.example.com', path: 'acme/web/app' });
  assert.equal(repoForge(key), 'gitlab');
  // GitHub's are as they were.
  assert.equal(normalizeRepo('git@github.com:acme/app.git'), 'acme/app');
  assert.equal(normalizeRepo('acme/app/issues/3'), 'acme/app');
  assert.equal(repoForge('acme/app'), 'github');
  assert.equal(gitlabProject('acme/app'), undefined);
  // Never an option, a way up the tree, or a host alone.
  for (const s of ['gitlab.example.com/app', 'gitlab.example.com/../etc', 'gitlab.example.com/-x/y', '--upload-pack=x/y', 'https://evil..com/a/b']) assert.equal(normalizeRepo(s), undefined, s);
});

test("a forge's words: GitLab has merge requests, !12 and glab", () => {
  assert.deepEqual([forgeWords('gitlab').pr, forgeWords('gitlab').ref, forgeWords('gitlab').cli], ['MR', '!', 'glab']);
  assert.deepEqual([forgeWords(undefined).pr, forgeWords(undefined).ref, forgeWords(undefined).site], ['PR', '#', 'GitHub']);
});

test("GitLab's issues and merge requests read as the boards' cards", () => {
  // locked: an MR while GitLab merges it, still open until it has.
  assert.deepEqual([stateOf('opened'), stateOf('merged'), stateOf('closed'), stateOf('locked')], ['OPEN', 'MERGED', 'CLOSED', 'OPEN']);
  const issue = issueOf({ iid: 4, title: 'Crash', state: 'opened', web_url: 'u', author: { username: 'ada' }, labels: [{ name: 'bug', color: '#d73a4a' }], assignees: [{ username: 'bo' }], description: 'x', user_notes_count: 3, created_at: 'c', updated_at: 'u2' });
  assert.deepEqual(issue, { number: 4, title: 'Crash', state: 'OPEN', url: 'u', author: 'ada', labels: [{ name: 'bug', color: '#d73a4a' }], assignees: ['bo'], createdAt: 'c', updatedAt: 'u2', body: 'x', comments: 3 });

  const mr = pullOf({
    iid: '9',
    title: 'Fix it',
    state: 'opened',
    draft: false,
    webUrl: 'https://gitlab.example.com/acme/app/-/merge_requests/9',
    author: { username: 'ada' },
    labels: { nodes: [{ title: 'ready', color: '#00ff00' }] },
    approved: true,
    reviewers: { nodes: [] },
    sourceBranch: 'fix-it',
    targetBranch: 'main',
    diffHeadSha: 'abc',
    diffStatsSummary: { additions: 5, deletions: 2 },
    headPipeline: { status: 'RUNNING' },
    description: 'Closes #4, #5 and fixes #6',
  });
  assert.equal(mr.number, 9);
  assert.equal(mr.reviewDecision, 'APPROVED');
  assert.equal(mr.checks, 'pending');
  assert.deepEqual([mr.headRefName, mr.baseRefName, mr.headRefOid, mr.additions, mr.deletions], ['fix-it', 'main', 'abc', 5, 2]);
  assert.deepEqual(mr.closes, [4, 5, 6]);
  assert.deepEqual(mr.labels, [{ name: 'ready', color: '#00ff00' }]);
  // A reviewer asking for changes outweighs an approval.
  assert.equal(pullOf({ iid: 1, approved: true, reviewers: { nodes: [{ mergeRequestInteraction: { reviewState: 'REQUESTED_CHANGES' } }] } }).reviewDecision, 'CHANGES_REQUESTED');
  assert.deepEqual(closesOf('Related to #3. Resolves #8'), [8]);
});

test("an MR's pipeline jobs, merge status and threads read as the PR window's", () => {
  assert.deepEqual(jobCheck({ name: 'test', stage: 'verify', status: 'failed', allow_failure: false, web_url: 'w' }), { name: 'verify / test', state: 'fail', url: 'w' });
  assert.equal(jobCheck({ name: 'lint', status: 'failed', allow_failure: true }).state, 'skip');
  assert.equal(jobCheck({ name: 'deploy', status: 'manual' }).state, 'skip');
  assert.equal(jobCheck({ name: 'build', status: 'running' }).state, 'pending');
  assert.deepEqual(mergeStatusOf('mergeable', false), { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' });
  assert.deepEqual(mergeStatusOf('need_rebase', false), { mergeable: 'MERGEABLE', mergeStateStatus: 'BEHIND' });
  assert.deepEqual(mergeStatusOf('not_approved', false), { mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED' });
  assert.deepEqual(mergeStatusOf('checking', false), { mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' });
  assert.deepEqual(mergeStatusOf('mergeable', true), { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' });

  const url = 'https://gitlab.example.com/acme/app/-/merge_requests/9';
  const note = (id: number, extra: object = {}) => ({ id, body: `n${id}`, author: { username: 'ada' }, created_at: `2026-01-0${id}`, system: false, ...extra });
  const position = { new_path: 'src/a.ts', old_path: 'src/a.ts', new_line: 12, old_line: null };
  const { comments, reviewComments } = discussionsOf(
    [
      { individual_note: true, notes: [note(2)] },
      { individual_note: true, notes: [note(1, { system: true, body: 'added 1 commit' })] },
      { individual_note: false, notes: [note(3, { type: 'DiffNote', position }), note(4, { type: 'DiffNote', position })] },
      { individual_note: false, notes: [note(5, { type: 'DiffNote', position: { new_path: 'b.ts', old_path: 'b.ts', new_line: null, old_line: 7 } })] },
    ],
    url,
  );
  assert.deepEqual(comments.map((c) => [c.id, c.url]), [['2', `${url}#note_2`]]);
  assert.deepEqual(reviewComments.map((c) => [c.id, c.replyTo, c.path, c.line, c.side]), [[3, undefined, 'src/a.ts', 12, 'RIGHT'], [4, 3, 'src/a.ts', 12, 'RIGHT'], [5, undefined, 'b.ts', 7, 'LEFT']]);
});

test("glab's errors say what to do", () => {
  assert.match(friendlyGlabError('ERROR: 401 Unauthorized'), /glab auth login/);
  assert.match(friendlyGlabError('dial tcp: lookup gitlab.example.com: no such host'), /network or VPN/);
  assert.match(friendlyGlabError('404 Project Not Found'), /can't find this project/);
});

/** A GitLab whose glab answers from `answer`, keeping every call. */
function fake(answer: (args: string[]) => unknown) {
  const calls: string[][] = [];
  const issues: GhState<GhIssue>[] = [];
  const pulls: GhState<GhPull>[] = [];
  const lab = new GitLab('/tmp', { host: 'gitlab.example.com', path: 'acme/app' }, (s) => issues.push(s), (s) => pulls.push(s), async (args) => {
    calls.push(args);
    const out = answer(args);
    if (out instanceof Error) throw out;
    return typeof out === 'string' ? out : JSON.stringify(out ?? null);
  });
  return { lab, calls, issues, pulls };
}

test('the MR list drops a GraphQL field an older GitLab lacks, and keeps the rest', async () => {
  const { lab, calls } = fake((args) => {
    if (args.includes('graphql')) {
      const query = args.find((a) => a.startsWith('query='))!;
      if (query.includes('mergeRequestInteraction')) return { errors: [{ message: "Field 'mergeRequestInteraction' doesn't exist on type 'MergeRequestReviewer'" }] };
      return { data: { project: { mergeRequests: { pageInfo: { hasNextPage: false }, nodes: query.includes('state: opened') ? [{ iid: '3', title: 'T', state: 'opened', sourceBranch: 'b' }] : [] } } } };
    }
    return [];
  });
  await lab.refresh();
  assert.deepEqual(lab.pulls.items.map((p) => [p.number, p.state, p.headRefName]), [[3, 'OPEN', 'b']]);
  assert.equal(lab.pulls.error, undefined);
  // It asks with --hostname, so the office's own checkout never decides which GitLab.
  assert.ok(calls.every((c) => c.includes('--hostname') && c.includes('gitlab.example.com')));
  assert.ok(calls.some((c) => c.some((a) => a.startsWith('projects/acme%2Fapp/issues?state=opened'))));
});

test('taking an issue adds the taker to its assignees; merging squashes and removes the branch as asked', async () => {
  const { lab, calls } = fake((args) => {
    const at = args.find((a) => a.startsWith('projects/') || a === 'user') ?? '';
    if (args.includes('user')) return { id: 77, username: 'office' };
    if (at === 'projects/acme%2Fapp/issues/4' && args.includes('GET')) return { iid: 4, assignees: [{ id: 5 }] };
    if (args.includes('graphql')) return { data: { project: { mergeRequests: { pageInfo: { hasNextPage: false }, nodes: [] } } } };
    return [];
  });
  assert.equal(await lab.claim(4), undefined);
  const put = calls.find((c) => c.includes('PUT') && c.includes('projects/acme%2Fapp/issues/4'))!;
  assert.deepEqual(put.slice(put.indexOf('-F'), put.indexOf('-F') + 2), ['-F', 'assignee_ids=[5,77]']);

  assert.equal(await lab.merge(9, 'squash', true, false), undefined);
  const merge = calls.find((c) => c.includes('projects/acme%2Fapp/merge_requests/9/merge'))!;
  assert.ok(merge.includes('squash=true') && merge.includes('should_remove_source_branch=true'));
  assert.ok(!merge.some((a) => a.startsWith('auto_merge')));
});

test('a comment goes as a plain string, and comes back as the window shows it', async () => {
  const { lab, calls } = fake((args) => (args.includes('POST') ? { id: 31, body: '@file -f x', author: { username: 'ada' }, created_at: 'c', system: false } : args.includes('graphql') ? { data: { project: { mergeRequests: { pageInfo: {}, nodes: [] } } } } : []));
  const r = await lab.comment('pull', 9, '@file -f x');
  assert.deepEqual(r.comment, { id: '31', author: 'ada', body: '@file -f x', createdAt: 'c', url: 'https://gitlab.example.com/acme/app/-/merge_requests/9#note_31' });
  const post = calls.find((c) => c.includes('POST'))!;
  // -f: glab never reads "@file" as a file to send.
  assert.equal(post[post.indexOf('body=@file -f x') - 1], '-f');
});

test('a project that only squashes, or never does, offers only that', async () => {
  for (const [option, methods] of [['always', ['squash']], ['never', ['merge']], ['default_on', ['squash', 'merge']], ['default_off', ['merge', 'squash']]] as const) {
    const { lab } = fake(() => ({ path_with_namespace: 'acme/app', squash_option: option }));
    assert.deepEqual((await lab.repoInfo()).methods, methods, option);
  }
});

test("closing an MR deletes its branch only when it's in this project, never a fork's namesake here", async () => {
  for (const [source, deleted] of [[1, true], [2, false]] as const) {
    const { lab, calls } = fake((args) => (args.includes('PUT') ? { iid: 9, source_branch: 'main', source_project_id: source, target_project_id: 1 } : args.includes('graphql') ? { data: { project: { mergeRequests: { pageInfo: {}, nodes: [] } } } } : []));
    assert.equal(await lab.close('pull', 9, { deleteBranch: true }), undefined);
    assert.equal(
      calls.some((c) => c.includes('DELETE') && c.includes('projects/acme%2Fapp/repository/branches/main')),
      deleted,
      `source project ${source}`,
    );
  }
});

test("an origin with a token in it is still the project, and the token isn't kept", () => {
  assert.equal(normalizeRepo('https://oauth2:glpat-secret@gitlab.example.com/acme/app.git'), 'gitlab.example.com/acme/app');
  assert.equal(normalizeRepo('https://x-access-token:ghp_secret@github.com/acme/app.git'), 'acme/app');
});

test("a checkout on a host that isn't a GitLab (GitHub Enterprise) stays with gh", () => {
  const conf = mkdtempSync(path.join(os.tmpdir(), 'glab-'));
  writeFileSync(path.join(conf, 'config.yml'), 'hosts:\n    code.example.org:\n        token: x\n');
  const before = process.env.GLAB_CONFIG_DIR;
  process.env.GLAB_CONFIG_DIR = conf;
  try {
    assert.equal(isGitLabHost('gitlab.corp.example'), true);
    assert.equal(isGitLabHost('code.example.org'), true);
    assert.equal(isGitLabHost('github.mycorp.com'), false);
    const repo = (url: string) => {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'origin-'));
      execFileSync('git', ['init', '-q', dir]);
      execFileSync('git', ['remote', 'add', 'origin', url], { cwd: dir });
      return originOf(dir);
    };
    assert.equal(repo('git@github.mycorp.com:org/app.git'), undefined);
    assert.equal(repo('git@code.example.org:org/app.git'), 'code.example.org/org/app');
    assert.equal(repo('git@github.com:org/app.git'), 'org/app');
  } finally {
    if (before === undefined) delete process.env.GLAB_CONFIG_DIR;
    else process.env.GLAB_CONFIG_DIR = before;
  }
});
