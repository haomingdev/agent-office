// A floor's boards with the Jira board as its issues board: while Jira is on, its issues are the Jira
// board's tickets (the same on every floor); its pull requests, and its issues while Jira is off, are
// still its repository's. Everything else the office does to issues (taking one, see Jira.take) asks
// the Jira board first.

import type { GhIssue, GhState } from '../../shared/protocol.js';
import type { Forge } from '../forge.js';
import type { Jira } from './index.js';

/**
 * `own` is the floor's own boards (which say nothing of their issues while Jira is on); `emit` tells
 * the floor's people about its issues, which are Jira's while it's on.
 */
export function withJira(jira: Jira, own: Forge, emit: (s: GhState<GhIssue>) => void): Forge {
  const off = jira.subscribe(() => emit(forge.issues));
  const forge: Forge = {
    get kind() {
      return own.kind;
    },
    get issues() {
      return jira.on ? jira.issues : own.issues;
    },
    get pulls() {
      return own.pulls;
    },
    start: () => own.start(),
    stop() {
      off();
      own.stop();
    },
    refresh: async () => {
      await Promise.all([own.refresh(), jira.refresh()]);
    },
    repoInfo: () => own.repoInfo(),
    pullDetail: (n, me) => own.pullDetail(n, me),
    pullDiff: (n) => own.pullDiff(n),
    issueDetail: (n, me) => own.issueDetail(n, me),
    comment: (kind, n, body, as) => own.comment(kind, n, body, as),
    review: (n, file, as) => own.review(n, file, as),
    merge: (n, method, deleteBranch, auto, as) => own.merge(n, method, deleteBranch, auto, as),
    close: (kind, n, opts, as) => own.close(kind, n, opts, as),
    repoLabels: () => own.repoLabels(),
    setLabels: (kind, n, add, remove, as) => own.setLabels(kind, n, add, remove, as),
    claim: (issue, as) => own.claim(issue, as),
  };
  return forge;
}
