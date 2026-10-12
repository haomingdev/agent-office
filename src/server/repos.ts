// The repositories the elevator offers: GitHub's through `gh`, and every GitLab's `glab` is signed in to.
import type { RepoChoice } from '../shared/protocol.js';
import { normalizeRepo } from '../shared/floors.js';
import { gh } from './github.js';
import { gitlabRepos } from './gitlab/repos.js';

const MAX_REPOS = 1000;

/**
 * Repositories the office can clone: GitHub's through `gh`, and the projects of every GitLab `glab`
 * is signed in to. One that fails leaves the others; only all of them failing is an error.
 */
export async function allRepos(cwd: string): Promise<RepoChoice[]> {
  const [hub, lab] = await Promise.allSettled([listRepos(cwd), gitlabRepos(cwd)]);
  const lists = [hub, lab].filter((r): r is PromiseFulfilledResult<RepoChoice[]> => r.status === 'fulfilled').map((r) => r.value);
  if (!lists.length) throw (hub as PromiseRejectedResult).reason;
  // glab signed in to nothing and gh failing is gh's error, which says what to do.
  if (hub.status === 'rejected' && !lists.some((l) => l.length)) throw hub.reason;
  return lists.flat().sort((a, b) => (b.pushedAt ?? '').localeCompare(a.pushedAt ?? ''));
}

async function listRepos(cwd: string): Promise<RepoChoice[]> {
  const out = await gh(
    [
      'api',
      '--paginate',
      'user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member',
      '--jq',
      '.[] | {name: .full_name, description: (.description // ""), private: .private, pushedAt: .pushed_at}',
    ],
    cwd,
    90_000,
  );
  const repos: RepoChoice[] = [];
  const seen = new Set<string>();
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as { name?: unknown; description?: unknown; private?: unknown; pushedAt?: unknown };
      const name = normalizeRepo(r.name);
      if (!name || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      repos.push({
        name,
        description: typeof r.description === 'string' && r.description ? r.description.slice(0, 200) : undefined,
        private: r.private === true,
        pushedAt: typeof r.pushedAt === 'string' ? r.pushedAt : undefined,
      });
    } catch {
      // not a line of ours
    }
    if (repos.length >= MAX_REPOS) break;
  }
  return repos.sort((a, b) => (b.pushedAt ?? '').localeCompare(a.pushedAt ?? ''));
}
