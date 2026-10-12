import { forgeWords, type ForgeWords } from '../../shared/floors';
import { store } from '../state';

/**
 * What the floor you're on calls things: GitHub's pull requests (PR #12), or a GitLab's merge
 * requests (MR !12). GitHub's words while there's no floor yet.
 */
export function words(): ForgeWords {
  return forgeWords(store.currentFloor()?.forge);
}

/** "PR #12" on GitHub, "MR !12" on GitLab. */
export function prName(n: number): string {
  const w = words();
  return `${w.pr} ${w.ref}${n}`;
}
