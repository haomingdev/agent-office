// The office's prompts for a floor on a GitLab: the same as GitHub's (prompts.ts), with merge
// requests (!12) for pull requests and the glab CLI for gh. A prompt rewritten in ⚙️ Settings is
// used as it's written on every floor; these are only the defaults.

import type { StationKind } from './layout.js';
import type { ForgeKind } from './floors.js';
import type { PromptId } from './prompts.js';

/** What a board agent looks after, on a GitLab floor. */
export const GITLAB_JOB: Record<StationKind, string> = {
  issues: `You look after this project's GitLab issues with the glab CLI: file new ones (a clear title, what's wrong or wanted, and how to reproduce it when that applies), find and sum them up, triage, label, comment on, close and reopen them. To get an issue worked on, put it on the task queue with its number.`,
  pulls: `You look after this project's merge requests with the glab CLI: sum them up and review them (glab mr view --comments, glab mr diff, glab ci status), comment, approve or ask for changes, merge when you're asked to, and close stale ones. Read an MR's code with glab mr diff rather than checking its branch out here. To get changes made on an MR, queue a task that tells the worker to check out that MR's branch in its worktree (glab mr checkout), make the fix and push it.`,
  queue: `You run the office's task queue, and adding to it is the only way you get anything done. Whatever you're asked for, even a one-line fix, and even when someone asks you to do it yourself, you put it on the queue and report what you queued. You never do the work: you don't edit, create or delete files, you don't run builds, tests or installs, and you don't write code, not even a snippet to show how. Read the code and glab issue list only as far as it takes to write a good task. Add one task per independent piece of work, each prompt complete on its own (what to change and where, how to check it, and to open a merge request), since the worker who picks it up knows nothing else. Link a task to its GitLab issue when it's for one. You also say what's queued, running and finished, and take waiting tasks off when asked.`,
};

const CHECKOUT = 'Get onto its branch: `glab mr checkout {{number}}`. If git says `{{branch}}` is already checked out in another worktree, use `git fetch origin {{branch}} && git checkout --detach FETCH_HEAD` instead and push with `git push origin HEAD:{{branch}}`.';
const FEEDBACK = 'Read all the feedback: `glab mr view {{number}} --comments`, and the threads on lines of code with `glab api projects/:fullpath/merge_requests/{{number}}/discussions`.';
const CHECKS = 'Wait for the pipeline with `glab ci status --branch {{branch}} --live` and fix anything that fails.';

/** The defaults that say gh or GitHub, as a GitLab floor has them. */
export const GITLAB_PROMPTS: Partial<Record<PromptId, string>> = {
  'issue.work': 'Work on GitLab issue #{{number}}: "{{title}}".\n\nRead it first with `glab issue view {{number}} --comments`. Create a new branch, implement the change, verify it, then open a merge request that closes #{{number}}.',
  'issue.ask': 'This is about GitLab issue #{{number}} "{{title}}" ({{url}}). Read it with `glab issue view {{number}} --comments`.',
  'issue.meeting': 'GitLab issue #{{number}}: “{{title}}”. Read it first with glab issue view {{number}} --comments.',
  'pull.review': "Review merge request !{{number}}: \"{{title}}\".\n\nUse `glab mr view {{number}} --comments` and `glab mr diff {{number}}`. Look for bugs, risky changes and missing tests, then give me a short summary with concrete suggestions. Don't push any commits.",
  'pull.fixMerge': [
    'Get merge request !{{number}} "{{title}}" ({{url}}) ready and merge it.',
    '',
    `1. ${CHECKOUT}`,
    `2. ${FEEDBACK}`,
    '3. Address every review thread that is still open: fix it, or if you disagree, reply on the MR saying why. If the branch conflicts with `{{base}}`, merge `{{base}}` in and resolve the conflicts.',
    '4. Verify your changes the way this project does (build, typecheck, tests), then commit and push.',
    `5. ${CHECKS}`,
    '6. When the pipeline passes and no feedback is left, merge it: `{{merge}}`. If something only a person can decide is in the way, stop and tell me instead of merging.',
  ].join('\n'),
  'pull.fixConflicts': [
    'Merge request !{{number}} "{{title}}" ({{url}}) has merge conflicts with `{{base}}`. Resolve them and merge it.',
    '',
    `1. ${CHECKOUT}`,
    '2. Bring in the latest `{{base}}`: `git fetch origin {{base}} && git merge origin/{{base}}`.',
    "3. Resolve every conflict so both sides' changes survive. Read the MR (`glab mr view {{number}}`) and the `{{base}}` commits that touched the same code to see what each side meant; don't just take one side.",
    '4. Verify the result the way this project does (build, typecheck, tests), then commit the merge and push.',
    `5. ${CHECKS}`,
    '6. When the pipeline passes, merge it: `{{merge}}`. If a conflict needs a decision only a person can make, stop and tell me instead of merging.',
  ].join('\n'),
  'pull.ask': 'This is about merge request !{{number}} "{{title}}" ({{url}}), branch `{{branch}}` into `{{base}}`. Read it with `glab mr view {{number}} --comments` and see its changes with `glab mr diff {{number}}`.',
  'pull.panel': 'Review merge request !{{number}}: “{{title}}”.',
  'queue.worktree': "You're in your own git worktree, on a fresh branch made for this task. Commit there, push it, and open the merge request from it (glab mr create).",
  'meeting.review.review': "Review merge request !{{pr}} through your lens, {{role}}, and nothing else. Read it with glab mr view {{pr}} --comments and glab mr diff {{pr}}; don't check it out or change any files. Write your findings to {{file}}, one per bullet: the file:line, what's wrong and what to do about it, the most serious first. If you find nothing, write just NO FINDINGS. Then end your turn.",
};

/** A board agent's brief says how to link a queued task to an issue: GitLab's words for GitHub's. */
export function gitlabQueueApi(text: string): string {
  return text.replace('linked to that GitHub issue', 'linked to that GitLab issue').replace('a task usually ends with a pull request', 'a task usually ends with a merge request').replace("each task's id, status, title, worker and pull request", "each task's id, status, title, worker and merge request");
}

/** The meeting brief's lines saying which pull request (or merge request) and issue it's about, and how to read them. */
export function meetingRefs(forge: ForgeKind | undefined, pr: number | undefined, issue: number | undefined): { pullRequest: string; issue: string } {
  const lab = forge === 'gitlab';
  const pull = lab ? `The merge request is !${pr}: read it with glab mr view ${pr} --comments and glab mr diff ${pr}.` : `The pull request is #${pr}: read it with gh pr view ${pr} and gh pr diff ${pr}.`;
  const from = lab ? `It comes from GitLab issue #${issue}: glab issue view ${issue} --comments.` : `It comes from GitHub issue #${issue}: gh issue view ${issue} --comments.`;
  return { pullRequest: pr !== undefined ? pull : '', issue: issue !== undefined ? from : '' };
}
