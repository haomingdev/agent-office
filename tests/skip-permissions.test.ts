// ⚡ Skip permission prompts: the office-wide switch, who can be hired that way, and what each
// provider that can starts with (see server/skip-permissions.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SkipPermissions, skipPermissionsProblem } from '../src/server/skip-permissions.js';
import { CODEX_SKIP_PERMISSIONS, codexSkipArgs } from '../src/server/codex.js';
import { SKIP_PERMISSIONS, claude } from '../src/server/providers/claude.js';
import { codex } from '../src/server/providers/codex.js';
import { cursor } from '../src/server/providers/cursor.js';
import { Ledger } from '../src/server/usage.js';
import { WorkerManager, type WorkerEvents } from '../src/server/workers.js';
import { DESKS, STATIONS } from '../src/shared/layout.js';
import { AGENT_PROVIDERS, skipsPermissions } from '../src/shared/providers.js';
import type { WorkerInfo } from '../src/shared/protocol.js';

function tmp(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-office-skip-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('the switch is off until an admin turns it on, and is kept for the next office', (t) => {
  const dir = tmp(t);
  const told: boolean[] = [];
  const a = new SkipPermissions(dir, (s) => told.push(s.on));
  assert.equal(a.on, false);
  assert.deepEqual(a.state(), { on: false });
  a.set(true, 'Ada');
  assert.deepEqual(told, [true]);
  const b = new SkipPermissions(dir, () => {});
  assert.equal(b.on, true);
  assert.equal(b.state().by, 'Ada');
  b.set(false, 'Bo');
  assert.equal(new SkipPermissions(dir, () => {}).on, false);
});

test('only a worker at a desk, on a provider that can, while the switch is on, skips its prompts', () => {
  const desk = DESKS[0];
  assert.match(skipPermissionsProblem(false, 'agent', 'claude', desk) ?? '', /turned off/);
  assert.equal(skipPermissionsProblem(true, 'agent', 'claude', desk), undefined);
  assert.equal(skipPermissionsProblem(true, 'agent', 'codex', desk), undefined);
  assert.equal(skipPermissionsProblem(true, 'agent', 'cursor', desk), undefined);
  assert.match(skipPermissionsProblem(true, 'agent', 'opencode', desk) ?? '', /OpenCode can't/);
  assert.match(skipPermissionsProblem(true, 'agent', 'custom', desk) ?? '', /can't/);
  assert.match(skipPermissionsProblem(true, 'shell', undefined, desk) ?? '', /shell/);
  assert.match(skipPermissionsProblem(true, 'agent', 'claude', STATIONS[0]) ?? '', /at a desk/);
  assert.match(skipPermissionsProblem(true, 'agent', 'claude', { room: true }) ?? '', /at a desk/);
  // The hire window offers it for the same providers.
  assert.deepEqual(AGENT_PROVIDERS.filter(skipsPermissions), ['claude', 'codex', 'cursor']);
});

test('Claude Code starts with --dangerously-skip-permissions, ahead of its prompt, and its warning screen pre-accepted', (t) => {
  const launch = (info: Partial<WorkerInfo>, args: string[] = [], more: { resumeSessionId?: string } = {}) =>
    claude.launch({ h: { info } as never, args, prompt: '- fix it', cwd: '/x', setup: { settings: '/data/claude-hooks.json' }, ...more }).args;
  const yolo = launch({ skipPermissions: true, model: 'opus' });
  assert.ok(yolo.includes(SKIP_PERMISSIONS));
  assert.ok(yolo.indexOf(SKIP_PERMISSIONS) < yolo.indexOf('--'));
  assert.deepEqual(yolo.slice(-2), ['--', '- fix it']);
  assert.equal(launch({ skipPermissions: true }, [], { resumeSessionId: 's-1' }).includes(SKIP_PERMISSIONS), true);
  // Never twice, when --agent-args already has it; never at all unless it was hired that way.
  assert.equal(launch({ skipPermissions: true }, [SKIP_PERMISSIONS]).filter((a) => a === SKIP_PERMISSIONS).length, 1);
  assert.equal(launch({}).includes(SKIP_PERMISSIONS), false);

  // The hooks' --settings file says Claude's one-time "Bypass Permissions mode" screen was seen.
  const dir = tmp(t);
  const settings = JSON.parse(readFileSync(claude.prepare!({ dataDir: dir, dshProfile: 'acp' }).settings, 'utf8'));
  assert.equal(settings.skipDangerousModePermissionPrompt, true);
  assert.ok(settings.hooks.PermissionRequest);
});

test('Codex bypasses its approvals and sandbox once, before resume, whatever --agent-args said', () => {
  assert.deepEqual(codexSkipArgs(['--yolo', '--full-auto', '-a', 'never', '--ask-for-approval=on-request', '-auntrusted', '-m', 'x']), ['-m', 'x', CODEX_SKIP_PERMISSIONS]);
  assert.deepEqual(codexSkipArgs([CODEX_SKIP_PERMISSIONS]), [CODEX_SKIP_PERMISSIONS]);
  const launch = (info: Partial<WorkerInfo>, more: { prompt?: string; resumeSessionId?: string } = {}) =>
    codex.launch({ h: { info, state: codex.createState!() } as never, args: ['--full-auto'], cwd: '/x', setup: { hook: '/data/hook.cjs' }, ...more }).args;
  const fresh = launch({ skipPermissions: true }, { prompt: 'fix it' });
  assert.equal(fresh.filter((a) => a === CODEX_SKIP_PERMISSIONS).length, 1);
  assert.equal(fresh.includes('--full-auto'), false);
  const resumed = launch({ skipPermissions: true }, { resumeSessionId: 'thread-1' });
  assert.ok(resumed.indexOf(CODEX_SKIP_PERMISSIONS) < resumed.indexOf('resume'));
  // Hired to ask, it keeps the approvals --agent-args set.
  const asks = launch({});
  assert.equal(asks.includes(CODEX_SKIP_PERMISSIONS), false);
  assert.ok(asks.includes('--full-auto'));
});

test('Cursor forces its commands through only when hired to', (t) => {
  const cwd = tmp(t);
  const launch = (info: Partial<WorkerInfo>) => cursor.launch({ h: { info: { id: 'w1', ...info } } as never, args: ['--force'], cwd, setup: { hook: '/data/hook.cjs' } }).args;
  assert.deepEqual(launch({ skipPermissions: true }).filter((a) => a === '--force'), ['--force']);
  // --agent-args' own --force is dropped, as it always was.
  assert.equal(launch({}).includes('--force'), false);
});

// ---- The worker manager: who it hires that way, and what they start with ------------------------

const fakeAgent = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_AGENT_LOG, JSON.stringify({ args, worker: process.env.AGENT_OFFICE_WORKER_ID }) + '\\n');
if (args.includes('--output-format')) {
  process.stdout.write(JSON.stringify({ structured_output: { name: 'Fake Task', summary: 'A test task' } }));
  process.exit(0);
}
process.stdout.write('ready\\r\\n');
process.stdin.resume();
`;

const quiet: WorkerEvents = { update() {}, remove() {}, data() {}, screen() {}, toast() {} };

/** Every run of the fake agent for `worker`, oldest first (the task namer's left out). */
function runs(log: string, worker: string): string[][] {
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.worker === worker && !r.args.includes('--output-format')).map((r) => r.args);
}

async function waitFor<T>(read: () => T, ok: (v: T) => boolean, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  let v = read();
  while (!ok(v) && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 25));
    v = read();
  }
  assert.ok(ok(v), 'timed out waiting for the fake agent');
  return v;
}

test('the manager refuses to hire a worker that skips its prompts unless allowed, and drops it once turned off', async (t) => {
  const root = tmp(t);
  const data = path.join(root, 'data');
  const bin = path.join(root, 'bin');
  mkdirSync(data, { recursive: true });
  mkdirSync(bin, { recursive: true });
  const agent = path.join(bin, 'claude');
  writeFileSync(agent, fakeAgent, { mode: 0o700 });
  const log = path.join(root, 'runs.jsonl');
  const saved = { log: process.env.FAKE_AGENT_LOG, home: process.env.HOME, config: process.env.CLAUDE_CONFIG_DIR, path: process.env.PATH };
  process.env.FAKE_AGENT_LOG = log;
  process.env.HOME = path.join(root, 'home');
  process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude');
  process.env.PATH = `${bin}${path.delimiter}${saved.path ?? ''}`;
  t.after(() => {
    for (const [key, value] of [['FAKE_AGENT_LOG', saved.log], ['HOME', saved.home], ['CLAUDE_CONFIG_DIR', saved.config], ['PATH', saved.path]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const manager = (allowed: boolean) => {
    const m = new WorkerManager(root, data, agent, [], { url: 'http://127.0.0.1:1', token: '' }, quiet, new Ledger(data, { pauseHiring: false }, () => {}, () => {}));
    m.skipAllowed = () => allowed;
    t.after(() => m.shutdown());
    return m;
  };

  const off = manager(false);
  assert.match(off.spawn('desk-1', 'Ada', 'go', false, 'agent', 'claude', undefined, undefined, undefined, undefined, [], undefined, true) as string, /turned off/);
  assert.equal(off.list().length, 0);
  off.shutdown();

  const on = manager(true);
  const hire = (desk: string, kind: 'agent' | 'shell' = 'agent', provider: 'claude' | 'opencode' | undefined = 'claude') => on.spawn(desk, 'Ada', 'go', false, kind, provider, undefined, undefined, undefined, undefined, [], undefined, true);
  assert.match(hire('station-issues') as string, /at a desk/);
  assert.match(hire('desk-2', 'shell', undefined) as string, /shell/);
  assert.match(hire('desk-2', 'agent', 'opencode') as string, /OpenCode can't/);
  const yolo = hire('desk-1') as WorkerInfo;
  assert.equal(yolo.skipPermissions, true);
  const asks = on.spawn('desk-2', 'Ada', 'go', false, 'agent', 'claude') as WorkerInfo;
  assert.equal(asks.skipPermissions, undefined);
  const [first] = await waitFor(() => runs(log, yolo.id), (r) => r.length >= 1);
  assert.ok(first.includes('--dangerously-skip-permissions'));
  assert.ok(first.indexOf('--dangerously-skip-permissions') < first.indexOf('--'));
  const [plain] = await waitFor(() => runs(log, asks.id), (r) => r.length >= 1);
  assert.equal(plain.includes('--dangerously-skip-permissions'), false);
  on.shutdown();

  // Back after a restart, it still skips them, while that's allowed.
  const again = manager(true);
  await again.start();
  assert.equal(again.get(yolo.id)?.skipPermissions, true);
  const second = await waitFor(() => runs(log, yolo.id), (r) => r.length >= 2);
  assert.ok(second[1].includes('--dangerously-skip-permissions'));
  again.shutdown();

  // Turned off since: it starts asking like everyone else, and says so.
  const later = manager(false);
  await later.start();
  const third = await waitFor(() => runs(log, yolo.id), (r) => r.length >= 3);
  assert.equal(third[2].includes('--dangerously-skip-permissions'), false);
  assert.equal(later.get(yolo.id)?.skipPermissions, undefined);
});
