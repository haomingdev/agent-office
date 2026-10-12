// The building: every project is a floor you ride the elevator to. Shared by the server (which
// assigns each floor its look) and the client (which paints it).

import type { CloneProgress } from './protocol.js';

/** The most floors a building has. */
export const MAX_FLOORS = 16;

/** How a floor looks: its walls, their trim, and its planks. */
export interface FloorPalette {
  name: string;
  wall: string;
  trim: string;
  floor: string;
  floorAlt: string;
  /** The gaps between planks. */
  seam: string;
}

/** The first is the office as it always looked; every new floor takes the next one nobody has. */
export const FLOOR_PALETTES: FloorPalette[] = [
  { name: 'Maple', wall: '#fff6ea', trim: '#e8a87c', floor: '#f2d7b0', floorAlt: '#e9c89a', seam: '#d9b88c' },
  { name: 'Mint', wall: '#e3f6ec', trim: '#40a878', floor: '#cfe6d9', floorAlt: '#bcdcc9', seam: '#9fc6b0' },
  { name: 'Sky', wall: '#e7f0ff', trim: '#4f7fe0', floor: '#d6dde9', floorAlt: '#c5cedd', seam: '#aab5c8' },
  { name: 'Lavender', wall: '#f2eaff', trim: '#9470e0', floor: '#e1d7ef', floorAlt: '#d2c4e7', seam: '#b8a6d6' },
  { name: 'Peach', wall: '#ffefe6', trim: '#ea7352', floor: '#efc6a5', floorAlt: '#e5b48e', seam: '#cf9c76' },
  { name: 'Lemon', wall: '#fffbe0', trim: '#dcaa16', floor: '#e9d8a4', floorAlt: '#dec98b', seam: '#c8b271' },
  { name: 'Walnut', wall: '#f5eee5', trim: '#8b5e3c', floor: '#aa7650', floorAlt: '#9b6845', seam: '#7c5236' },
  { name: 'Slate', wall: '#edf1f5', trim: '#3d5a80', floor: '#b9c3cd', floorAlt: '#aab5c0', seam: '#8d99a6' },
  { name: 'Rose', wall: '#ffeaf0', trim: '#e0567f', floor: '#eed3da', floorAlt: '#e4c1cb', seam: '#cea5b2' },
  { name: 'Teal', wall: '#e1f7f6', trim: '#1a9a9a', floor: '#c3e2de', floorAlt: '#b0d7d2', seam: '#92c3bd' },
];

export function floorPalette(i: number): FloorPalette {
  return FLOOR_PALETTES[((i % FLOOR_PALETTES.length) + FLOOR_PALETTES.length) % FLOOR_PALETTES.length];
}

/** Where a repository lives: GitHub, or a GitLab (gitlab.com or one of a company's own). */
export type ForgeKind = 'github' | 'gitlab';

/** A GitLab host: a domain or address, lower case. */
const GITLAB_HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const GITLAB_SEGMENT = /^[a-zA-Z0-9_](?:[a-zA-Z0-9_.-]{0,254})$/;

/**
 * `host/group/…/project` from a GitLab URL (https, ssh or git@) or one typed that way, with or
 * without .git; a URL may go on past the project (…/project/-/merge_requests/12). Any host but
 * github.com counts, since a company's GitLab can be called anything.
 */
function normalizeGitLab(s: string): string | undefined {
  // https://host:8443/path or ssh://git@host:2222/path; git@host:path; host/path as typed. The port
  // is the way in, not the project's name, so the same project reached two ways is one floor.
  const m =
    /^(?:https?|ssh):\/\/(?:[^@/\s]+@)?([\w.-]+)(?::\d{1,5})?\/(.+)$/i.exec(s) ??
    /^[\w.-]+@([\w.-]+):(?!\/)(.+)$/.exec(s) ??
    /^([\w.-]+)\/(.+)$/.exec(s);
  if (!m) return undefined;
  const host = m[1].toLowerCase();
  if (host === 'github.com' || !GITLAB_HOST.test(host)) return undefined;
  const rest = m[2].replace(/\/-\/.*$/, '').replace(/[?#].*$/, '').replace(/\/+$/, '').replace(/\.git$/i, '');
  const parts = rest.split('/');
  if (parts.length < 2 || parts.length > 20 || !parts.every((p) => GITLAB_SEGMENT.test(p) && p !== '..' && !p.endsWith('.'))) return undefined;
  return `${host}/${parts.join('/')}`;
}

/** Which forge a repository (as normalizeRepo gives it) is on: a GitHub owner never has a dot, a GitLab host always does. */
export function repoForge(repo: string | undefined): ForgeKind | undefined {
  if (!repo) return undefined;
  return repo.split('/')[0].includes('.') ? 'gitlab' : 'github';
}

/** What the office calls things on a forge: a GitLab has merge requests (!12) where GitHub has pull requests (#12). */
export interface ForgeWords {
  site: 'GitHub' | 'GitLab';
  /** "PR" or "MR". */
  pr: string;
  /** "pull request" or "merge request". */
  pullRequest: string;
  /** What comes before a pull request's number: # or !. */
  ref: string;
  /** Its command line tool. */
  cli: 'gh' | 'glab';
}

const WORDS: Record<ForgeKind, ForgeWords> = {
  github: { site: 'GitHub', pr: 'PR', pullRequest: 'pull request', ref: '#', cli: 'gh' },
  gitlab: { site: 'GitLab', pr: 'MR', pullRequest: 'merge request', ref: '!', cli: 'glab' },
};

/** GitHub's words when it isn't known. */
export function forgeWords(kind: ForgeKind | undefined): ForgeWords {
  return WORDS[kind ?? 'github'];
}

/** A GitLab repository's host and its project's path ("gitlab.example.com", "group/sub/project"). */
export function gitlabProject(repo: string | undefined): { host: string; path: string } | undefined {
  if (repoForge(repo) !== 'gitlab') return undefined;
  const at = repo!.indexOf('/');
  return { host: repo!.slice(0, at), path: repo!.slice(at + 1) };
}

/**
 * `owner/repo` from what someone typed or pasted: owner/repo, a github.com URL (https, ssh or
 * git@), with or without .git. A GitLab project comes back as `host/group/…/project` (see
 * normalizeGitLab). Undefined for anything else, so it can never become a CLI option or a path.
 */
export function normalizeRepo(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  let s = value.trim();
  if (s.length > 300) return undefined;
  // A host with a dot that isn't github.com: a GitLab.
  if (!/^(?:https?:\/\/|ssh:\/\/)?(?:[^@/\s]+@)?github\.com[/:]/i.test(s) && /^(?:(?:https?|ssh):\/\/)?(?:[^@/\s]+@)?[\w-]+\.[\w.-]+(?::\d+)?[/:]/i.test(s)) return normalizeGitLab(s);
  s = s.replace(/^(?:https?:\/\/|ssh:\/\/)?(?:[^@/\s]+@)?github\.com[/:]/i, '');
  s = s.replace(/[?#].*$/, '').replace(/\/+$/, '').replace(/\.git$/i, '');
  const parts = s.split('/');
  // A URL may go on past the repository (…/owner/repo/issues/12).
  if (parts.length < 2) return undefined;
  const [owner, repo] = parts;
  if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/.test(owner)) return undefined;
  if (!/^[a-zA-Z0-9_.-]{1,100}$/.test(repo) || repo === '.' || repo === '..') return undefined;
  return `${owner}/${repo}`;
}

export function sameRepo(a: string | undefined, b: string | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

/** What a floor's clone is doing: "Downloading 64%". */
export function cloneStep(p: CloneProgress | undefined): string {
  return `${p?.step ?? 'Cloning'}${p?.percent !== undefined ? ` ${p.percent}%` : '…'}`;
}

/** A floor's clone in a few words, for the floor lists: "⏳ Downloading 64%". */
export function cloneLabel(p: CloneProgress | undefined): string {
  return `⏳ ${cloneStep(p)}`;
}
