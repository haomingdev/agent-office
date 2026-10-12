// Everyone's own GitLab (see signins.ts): a personal access token, pasted in the office or typed into
// `glab auth login` at a desk's shell, kept by glab in the account's own folder (GLAB_CONFIG_DIR),
// never the machine's keyring, which every account would share.
import { execFile } from 'node:child_process';
import path from 'node:path';
import { quote, run } from './signins-run.js';
import { glabEnv } from './gitlab/api.js';

/** GitLab credentials the office's own environment may carry. None of them reach anything run as someone else. */
export const GITLAB_VARS = ['GITLAB_TOKEN', 'GITLAB_ACCESS_TOKEN', 'OAUTH_TOKEN', 'GITLAB_HOST', 'GLAB_CONFIG_DIR'];
/** glpat-…, or an older token without the prefix. */
export const GITLAB_TOKEN = /^[A-Za-z0-9_.-]{20,255}$/;
export const GITLAB_HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+(?::\d{1,5})?$/;

/** Where an account's glab keeps its sign-ins. */
export function glabDir(home: string): string {
  return path.join(home, 'glab');
}

/** `env` running glab as the account whose folder is `home`. */
export function asGitLab(env: Record<string, string>, home: string): Record<string, string> {
  for (const k of GITLAB_VARS) delete env[k];
  env.GLAB_CONFIG_DIR = glabDir(home);
  return env;
}

/** Signs glab in to `host` with a token, in the account's folder. Resolves to why it didn't take. */
export async function glabLogin(glab: string, env: Record<string, string>, host: string, token: string): Promise<string | undefined> {
  const r = await run(glab, ['auth', 'login', '--hostname', host, '--stdin', '--insecure-storage', '--git-protocol', 'ssh'], glabEnv(env), `${token}\n`);
  return r.code === 0 ? undefined : r.last || 'glab auth login failed';
}

export async function glabLogout(glab: string, env: Record<string, string>, host: string) {
  await run(glab, ['auth', 'logout', '--hostname', host], glabEnv(env));
}

/** The GitLab the account's glab is signed in to, when it signed in at a desk's shell (`glab auth login`) rather than here. */
export function glabSignedIn(glab: string, env: Record<string, string>): Promise<string | undefined> {
  // It says so among several lines on stderr (or stdout, by version), not the last.
  return new Promise((resolve) => {
    execFile(glab, ['auth', 'status'], { env: glabEnv(env), timeout: 20_000 }, (_err, stdout, stderr) => resolve(/Logged in to ([\w.-]+(?::\d+)?) as/i.exec(`${stdout ?? ''}\n${stderr ?? ''}`)?.[1]?.toLowerCase()));
  });
}

/** Who glab is signed in to `host` as, or nothing (and why, unless it's just signed out). */
export async function glabWho(glab: string, env: Record<string, string>, host: string): Promise<{ who?: string; name?: string; email?: string; error?: string }> {
  const r = await run(glab, ['api', '--hostname', host, 'user'], glabEnv(env));
  let user: { username?: string; name?: string; commit_email?: string; email?: string } = {};
  try {
    user = r.code === 0 ? JSON.parse(r.out) : {};
  } catch {
    // not JSON: treated as not signed in
  }
  if (user.username) return { who: `@${user.username} on ${host}`, name: user.name?.trim() || user.username, email: user.commit_email || user.email || undefined };
  const signedOut = /401|unauthorized|not authenticated|no token|glab auth login/i.test(r.last);
  return { error: signedOut || !r.last ? undefined : r.last };
}

/** git's credential helper for a GitLab over https: glab's own login, so pushes go out as the account. */
export function glabCredential(glab: string, host: string): string[] {
  return [`[credential ${quote(`https://${host}`)}]`, '\thelper =', `\thelper = ${quote(`!'${glab.replace(/'/g, `'\\''`)}' auth git-credential`)}`];
}
