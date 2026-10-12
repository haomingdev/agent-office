// The GitLab projects the elevator offers and clones: every GitLab `glab` is signed in to on the
// office's machine (gitlab.com, or a company's own).
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RepoChoice } from '../../shared/protocol.js';
import { GitLabApi, glab, glabEnv } from './api.js';

/** Projects listed per GitLab, most recently active first. */
const MAX_PROJECTS = 500;

/** What `glab auth status` says, stdout and stderr together (it writes to either, by version). */
function authStatus(cwd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile('glab', ['auth', 'status'], { cwd, timeout: 20_000, env: glabEnv(process.env) }, (_err, stdout, stderr) => resolve(`${stdout ?? ''}\n${stderr ?? ''}`));
  });
}

/** The GitLabs glab is signed in to ("Logged in to gitlab.example.com as …"). None when glab isn't installed. */
export async function gitlabHosts(cwd: string): Promise<string[]> {
  const out = await authStatus(cwd);
  return [...new Set([...out.matchAll(/Logged in to ([\w.-]+(?::\d+)?) as/gi)].map((m) => m[1].toLowerCase()))];
}

/** Where glab keeps its config (and so its sign-ins), by OS: Go's user config folder, or GLAB_CONFIG_DIR. */
function glabConfigs(): string[] {
  const home = os.homedir();
  const dirs = [process.env.GLAB_CONFIG_DIR, process.env.XDG_CONFIG_HOME && path.join(process.env.XDG_CONFIG_HOME, 'glab-cli'), path.join(home, '.config', 'glab-cli'), path.join(home, 'Library', 'Application Support', 'glab-cli'), process.env.APPDATA && path.join(process.env.APPDATA, 'glab-cli')];
  return dirs.filter((d): d is string => !!d).map((d) => path.join(d, 'config.yml'));
}

/**
 * Whether a checkout's origin on `host` is a GitLab's: one called so, or one glab has a sign-in for.
 * Any other host (a GitHub Enterprise, say) stays with gh, as it was before there were GitLab floors.
 */
export function isGitLabHost(host: string): boolean {
  if (/(?:^|[.-])gitlab(?:[.-]|$)/i.test(host)) return true;
  const entry = new RegExp(`^\\s+${host.replace(/[.]/g, '\\.')}:\\s*$`, 'im');
  return glabConfigs().some((file) => {
    try {
      return entry.test(readFileSync(file, 'utf8'));
    } catch {
      return false;
    }
  });
}

/** How glab clones from `host`: over ssh (its default) or https. */
function gitProtocol(host: string, cwd: string): Promise<'ssh' | 'https'> {
  return new Promise((resolve) => {
    execFile('glab', ['config', 'get', 'git_protocol', '--host', host], { cwd, timeout: 10_000, env: glabEnv(process.env) }, (_err, stdout) => resolve(String(stdout ?? '').trim() === 'https' ? 'https' : 'ssh'));
  });
}

/**
 * A GitLab project the office was asked to clone: its name with GitLab's case (host/group/…/project),
 * whether it has no commits yet, and the URL git clones it from (as glab would: ssh unless set to https).
 */
export async function lookUpGitLab(lab: { host: string; path: string }, cwd: string): Promise<{ repo: string; empty: boolean; from: string }> {
  const [p, protocol] = await Promise.all([new GitLabApi(lab.host, lab.path, cwd, glab).get(''), gitProtocol(lab.host, cwd)]);
  const from = String((protocol === 'https' ? p.http_url_to_repo : p.ssh_url_to_repo) ?? p.ssh_url_to_repo ?? '');
  if (!/^(?:https:\/\/|ssh:\/\/|[\w.-]+@[\w.-]+:)/.test(from)) throw new Error("GitLab didn't say where to clone it from");
  return { repo: `${lab.host}/${String(p.path_with_namespace ?? lab.path)}`, empty: p.empty_repo === true, from };
}

/** Every project the office's glab can see on each GitLab it's signed in to, as elevator choices. */
export async function gitlabRepos(cwd: string): Promise<RepoChoice[]> {
  const hosts = await gitlabHosts(cwd);
  const lists = await Promise.allSettled(
    hosts.map(async (host) => {
      const api = new GitLabApi(host, '', cwd, glab);
      const projects = await api.list<any>('/projects?membership=true&simple=true&archived=false&order_by=last_activity_at', MAX_PROJECTS);
      return projects.map(
        (p): RepoChoice => ({
          name: `${host}/${String(p.path_with_namespace)}`,
          description: typeof p.description === 'string' && p.description ? p.description.slice(0, 200) : undefined,
          private: p.visibility !== 'public',
          pushedAt: typeof p.last_activity_at === 'string' ? p.last_activity_at : undefined,
        }),
      );
    }),
  );
  const ok = lists.filter((r): r is PromiseFulfilledResult<RepoChoice[]> => r.status === 'fulfilled');
  if (hosts.length && !ok.length) throw (lists[0] as PromiseRejectedResult).reason;
  return ok.flatMap((r) => r.value);
}
