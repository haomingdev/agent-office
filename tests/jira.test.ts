import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assignedTo, assigneeChoices, issueName, issueRef, parseJiraBoard } from '../src/shared/jira.js';
import { adfToMarkdown, textToAdf } from '../src/server/jira/adf.js';
import { JiraApi, type JiraFetch } from '../src/server/jira/api.js';
import { DONE_MAX, columnsOf, loadBoard } from '../src/server/jira/board.js';
import { Jira } from '../src/server/jira/index.js';
import { withJira } from '../src/server/jira/forge.js';
import type { Forge } from '../src/server/forge.js';
import type { GhIssue, GhState, JiraState } from '../src/shared/protocol.js';

// ---- A fake Jira Cloud ---------------------------------------------------------------------------

const SITE = 'https://acme.atlassian.net';
const LINK = `${SITE}/jira/software/c/projects/CHAT/boards/143`;
const OFFICE = { email: 'office@acme.com', token: 'office-token-0123456789' };
const ADA = { email: 'ada@acme.com', token: 'ada-token-0123456789abc' };

interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  auth: string;
  body?: any;
}

type Route = (call: Call) => { status?: number; body?: unknown } | undefined;

/** A Jira that answers `routes` ("GET /rest/…") and remembers every request. */
function fakeJira(routes: Record<string, Route>) {
  const calls: Call[] = [];
  const fetchFn: JiraFetch = async (url, init) => {
    const u = new URL(url);
    assert.equal(u.origin, SITE);
    const call: Call = { method: init.method, path: u.pathname, query: u.searchParams, auth: init.headers.authorization, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const r = routes[`${init.method} ${u.pathname}`]?.(call) ?? { status: 404, body: { errorMessages: ['Not here'] } };
    const status = r.status ?? 200;
    return { status, ok: status < 300, text: async () => (r.body === undefined ? '' : JSON.stringify(r.body)) };
  };
  return { fetchFn, calls };
}

const basic = (who: { email: string; token: string }) => `Basic ${Buffer.from(`${who.email}:${who.token}`).toString('base64')}`;

/** Who a token is, as /myself says. */
const myself: Route = (c) => {
  if (c.auth === basic(OFFICE)) return { body: { accountId: 'acc-office', displayName: 'Office Bot' } };
  if (c.auth === basic(ADA)) return { body: { accountId: 'acc-ada', displayName: 'Ada Lovelace' } };
  return { status: 401, body: { errorMessages: ['Client must be authenticated to access this resource.'] } };
};

const CONFIG = {
  columnConfig: {
    columns: [
      { name: 'Backlog', statuses: [{ id: '1' }] },
      { name: 'To Do', statuses: [{ id: '10000' }] },
      { name: 'In Progress', statuses: [{ id: '3' }] },
      { name: 'In Review', statuses: [{ id: '10001' }] },
      { name: 'Done', statuses: [{ id: '10002' }] },
    ],
  },
};

const STATUS = {
  todo: { id: '10000', name: 'To Do', statusCategory: { key: 'new' } },
  doing: { id: '3', name: 'In Progress', statusCategory: { key: 'indeterminate' } },
  done: { id: '10002', name: 'Done', statusCategory: { key: 'done' } },
  backlog: { id: '1', name: 'Backlog', statusCategory: { key: 'new' } },
  elsewhere: { id: '999', name: 'Somewhere else', statusCategory: { key: 'new' } },
};

function issue(n: number, status: object, extra: Record<string, unknown> = {}) {
  return {
    id: String(20000 + n),
    key: `CHAT-${n}`,
    fields: {
      summary: `Ticket ${n}`,
      status,
      issuetype: { name: n % 2 ? 'Bug' : 'Story' },
      priority: { name: 'High' },
      labels: ['web'],
      created: '2026-10-01T09:00:00.000+0200',
      updated: `2026-10-${String(10 + (n % 3)).padStart(2, '0')}T09:00:00.000+0000`,
      description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: `Fix ticket ${n}` }] }] },
      ...extra,
    },
  };
}

/** Board 143: a page of 100 tickets, then one of 60 (some finished, one off the board). */
function boardRoutes(all = boardIssues()): Record<string, Route> {
  return {
    'GET /rest/api/3/myself': myself,
    'GET /rest/agile/1.0/board/143': () => ({ body: { id: 143, name: 'CHAT board', type: 'kanban' } }),
    'GET /rest/agile/1.0/board/143/configuration': () => ({ body: CONFIG }),
    'GET /rest/agile/1.0/board/143/issue': (c) => {
      const at = Number(c.query.get('startAt'));
      const max = Number(c.query.get('maxResults'));
      return { body: { startAt: at, maxResults: max, total: all.length, issues: all.slice(at, at + Math.min(max, 100)) } };
    },
  };
}

function boardIssues() {
  const out = [];
  for (let n = 1; n <= 100; n++) out.push(issue(n, STATUS.todo, n === 1 ? { assignee: { accountId: 'acc-ada', displayName: 'Ada Lovelace' } } : n === 2 ? { assignee: { accountId: 'acc-bo', displayName: 'Bo' } } : {}));
  for (let n = 101; n <= 150; n++) out.push(issue(n, STATUS.done, { updated: `2026-10-${String(1 + (n % 12)).padStart(2, '0')}T00:00:00.000+0000` }));
  out.push(issue(151, STATUS.doing, { assignee: { accountId: 'acc-ada', displayName: 'Ada Lovelace' } }));
  out.push(issue(152, STATUS.elsewhere));
  out.push(issue(153, STATUS.backlog));
  return out;
}

function tmp() {
  return mkdtempSync(path.join(os.tmpdir(), 'jira-'));
}

/** A Jira service on a fake Jira, set up with board 143 and (unless `office` is false) the office's token. */
async function office(routes: Record<string, Route>, opts: { office?: boolean } = {}) {
  const fake = fakeJira(routes);
  const states: JiraState[] = [];
  const you: (string | undefined)[] = [];
  const dir = tmp();
  const jira = new Jira(dir, { state: (s) => states.push(s), you: (id) => you.push(id) }, fake.fetchFn);
  assert.equal(jira.configure(true, LINK, 'Ada'), undefined);
  if (opts.office !== false) assert.equal(await jira.setOffice(OFFICE.email, OFFICE.token), undefined);
  await jira.refresh(true);
  return { jira, fake, states, you, dir };
}

// ---- Reading a pasted board link -----------------------------------------------------------------

test('a board link is read for its site and board, from any of the ways Jira writes it', () => {
  for (const url of [LINK, `${LINK}/backlog?selectedIssue=CHAT-1`, `${SITE}/jira/software/projects/CHAT/boards/143`, `${SITE}/secure/RapidBoard.jspa?rapidView=143&projectKey=CHAT`, ` ${LINK}/ `]) {
    assert.deepEqual(parseJiraBoard(url), { site: SITE, board: 143 }, url);
  }
  // Only Jira Cloud, over https, and only a link that names a board.
  for (const url of ['http://acme.atlassian.net/jira/software/c/projects/CHAT/boards/143', 'https://evil.example.com/boards/143', 'https://acme.atlassian.net.evil.com/boards/1', 'https://acme.atlassian.net/browse/CHAT-1', 'not a link']) {
    assert.equal(typeof parseJiraBoard(url), 'string', url);
  }
});

// ---- Atlassian Document Format -------------------------------------------------------------------

test('a Jira document reads as Markdown: paragraphs, headings, marks, lists, code, quotes, tables', () => {
  const t = (text: string, marks?: string[], href?: string) => ({ type: 'text', text, marks: [...(marks ?? []).map((type) => ({ type })), ...(href ? [{ type: 'link', attrs: { href } }] : [])] });
  const doc = {
    type: 'doc',
    version: 1,
    content: [
      { type: 'heading', attrs: { level: 2 }, content: [t('Steps')] },
      { type: 'paragraph', content: [t('Go to '), t('the page', ['strong']), t(' and '), t('click', ['em']), t(' '), t('Save', ['code']), { type: 'hardBreak' }, t('docs', [], 'https://x.test/d')] },
      {
        type: 'orderedList',
        content: [
          { type: 'listItem', content: [{ type: 'paragraph', content: [t('one')] }, { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [t('nested')] }] }] }] },
          { type: 'listItem', content: [{ type: 'paragraph', content: [t('two')] }] },
        ],
      },
      { type: 'codeBlock', attrs: { language: 'ts' }, content: [{ type: 'text', text: 'const a = 1;' }] },
      { type: 'blockquote', content: [{ type: 'paragraph', content: [t('quoted')] }] },
      { type: 'rule' },
      { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableHeader', content: [{ type: 'paragraph', content: [t('A')] }] }, { type: 'tableHeader', content: [{ type: 'paragraph', content: [t('B')] }] }] }, { type: 'tableRow', content: [{ type: 'tableCell', content: [{ type: 'paragraph', content: [t('1')] }] }, { type: 'tableCell', content: [{ type: 'paragraph', content: [t('2')] }] }] }] },
    ],
  };
  assert.equal(
    adfToMarkdown(doc),
    ['## Steps', 'Go to **the page** and _click_ `Save`  \n[docs](https://x.test/d)', '1. one\n   - nested\n2. two', '```ts\nconst a = 1;\n```', '> quoted', '---', '| A | B |\n| --- | --- |\n| 1 | 2 |'].join('\n\n'),
  );
});

test("mentions, emoji, statuses, dates and cards read as text, and a node it doesn't know as its text", () => {
  const doc = {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'mention', attrs: { id: 'acc-1', text: '@Ada Lovelace' } },
          { type: 'text', text: ' ' },
          { type: 'emoji', attrs: { shortName: ':tada:', text: '🎉' } },
          { type: 'text', text: ' ' },
          { type: 'status', attrs: { text: 'blocked', color: 'red' } },
          { type: 'text', text: ' ' },
          { type: 'date', attrs: { timestamp: String(Date.UTC(2026, 9, 13)) } },
          { type: 'text', text: ' ' },
          { type: 'inlineCard', attrs: { url: 'https://acme.atlassian.net/browse/CHAT-2' } },
        ],
      },
      { type: 'taskList', content: [{ type: 'taskItem', attrs: { state: 'DONE' }, content: [{ type: 'text', text: 'done it' }] }, { type: 'taskItem', attrs: { state: 'TODO' }, content: [{ type: 'text', text: 'not yet' }] }] },
      { type: 'panel', attrs: { panelType: 'warning' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'careful' }] }] },
      { type: 'somethingNew', content: [{ type: 'text', text: 'still here' }] },
      { type: 'mediaSingle', content: [{ type: 'media', attrs: { id: 'x' } }] },
    ],
  };
  assert.equal(
    adfToMarkdown(doc),
    ['@Ada Lovelace 🎉 [BLOCKED] 2026-10-13 <https://acme.atlassian.net/browse/CHAT-2>', '- [x] done it\n- [ ] not yet', '> ⚠️ careful', 'still here', '_(an attachment: open the ticket in Jira to see it)_'].join('\n\n'),
  );
  assert.equal(adfToMarkdown(null), '');
  assert.equal(adfToMarkdown('plain *wiki* text'), 'plain *wiki* text');
});

test('plain text goes to Jira as paragraphs, with its lines kept', () => {
  assert.deepEqual(textToAdf('Hello\nthere\n\n\nBye'), {
    type: 'doc',
    version: 1,
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Hello' }, { type: 'hardBreak' }, { type: 'text', text: 'there' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Bye' }] },
    ],
  });
});

// ---- The board -----------------------------------------------------------------------------------

test("the board's columns are its own, without a Kanban backlog, and its to-do column is found by name", () => {
  const { columns, statuses, todo } = columnsOf(CONFIG);
  assert.deepEqual(
    columns.map((c) => c.name),
    ['To Do', 'In Progress', 'In Review', 'Done'],
  );
  assert.deepEqual(statuses, [['10000'], ['3'], ['10001'], ['10002']]);
  assert.equal(todo, 0);
  assert.equal(columns[0].todo, true);
  // "Selected for Development" is a Kanban board's to-do column; with nothing like it, the first.
  assert.equal(columnsOf({ columnConfig: { columns: [{ name: 'Triage' }, { name: 'Selected for Development' }, { name: 'Done' }] } }).todo, 1);
  assert.equal(columnsOf({ columnConfig: { columns: [{ name: 'Waiting' }, { name: 'Doing' }] } }).todo, 0);
});

test('the board is read a page at a time, keeps only the recent finished tickets, and leaves off ones it has no column for', async () => {
  const fake = fakeJira(boardRoutes());
  const b = await loadBoard(new JiraApi(SITE, OFFICE, fake.fetchFn), 143);
  const pages = fake.calls.filter((c) => c.path.endsWith('/issue'));
  assert.deepEqual(
    pages.map((c) => c.query.get('startAt')),
    ['0', '100'],
  );
  // Finished tickets: only the last two weeks', asked of Jira.
  assert.match(pages[0].query.get('jql')!, /statusCategory != Done OR updated >= -14d/);
  assert.match(pages[0].query.get('fields')!, /summary.*status.*assignee/);
  assert.equal(b.name, 'CHAT board');
  const keys = b.items.map((i) => i.jira!.key);
  assert.ok(!keys.includes('CHAT-152') && !keys.includes('CHAT-153'), 'a ticket in no column (or the backlog) is off the board');
  const done = b.items.filter((i) => i.jira!.category === 'done');
  assert.equal(done.length, DONE_MAX);
  assert.ok(done.every((d, i) => i === 0 || done[i - 1].updatedAt >= d.updatedAt), 'newest finished first');
  assert.equal(b.columns[3].done, true);
  // A ticket as the issues board's card.
  const one = b.items.find((i) => i.jira!.key === 'CHAT-1')!;
  assert.deepEqual(
    { ...one, labels: one.labels.map((l) => l.name) },
    {
      number: 20001,
      title: 'Ticket 1',
      state: 'OPEN',
      url: `${SITE}/browse/CHAT-1`,
      author: '',
      labels: ['web'],
      assignees: ['Ada Lovelace'],
      createdAt: '2026-10-01T07:00:00.000Z',
      updatedAt: '2026-10-11T09:00:00.000Z',
      body: 'Fix ticket 1',
      comments: 0,
      jira: { key: 'CHAT-1', column: 0, todo: true, status: 'To Do', category: 'new', type: 'Bug', priority: 'High', assignee: { accountId: 'acc-ada', name: 'Ada Lovelace' } },
    },
  );
  assert.equal(b.items.find((i) => i.jira!.key === 'CHAT-101')!.state, 'CLOSED');
});

test("a Scrum board is its open sprint's tickets", async () => {
  const routes = boardRoutes();
  routes['GET /rest/agile/1.0/board/143'] = () => ({ body: { id: 143, name: 'Sprints', type: 'scrum' } });
  routes['GET /rest/agile/1.0/board/143/sprint'] = () => ({ body: { values: [{ id: 7, state: 'active' }] } });
  const fake = fakeJira(routes);
  await loadBoard(new JiraApi(SITE, OFFICE, fake.fetchFn), 143);
  assert.match(fake.calls.find((c) => c.path.endsWith('/issue'))!.query.get('jql')!, /^sprint in openSprints\(\) AND /);
});

test("Jira's refusals say what to do: a wrong or expired token, no access, no such board", async () => {
  const say = async (status: number) => {
    const fake = fakeJira({ 'GET /rest/agile/1.0/board/143': () => ({ status, body: { errorMessages: ['Nope'] } }) });
    return new JiraApi(SITE, OFFICE, fake.fetchFn).get('/rest/agile/1.0/board/143', 'board 143').then(
      () => '',
      (err: Error) => err.message,
    );
  };
  assert.match(await say(401), /token is wrong or has expired/);
  assert.match(await say(403), /no access to board 143/);
  assert.match(await say(404), /can't find board 143.*access/);
  // Never the token, whatever went wrong.
  for (const s of [401, 403, 404, 500]) assert.ok(!(await say(s)).includes(OFFICE.token));
  const down: JiraFetch = async () => {
    throw new Error('getaddrinfo ENOTFOUND');
  };
  await assert.rejects(new JiraApi(SITE, OFFICE, down).get('/x'), /Couldn't reach Jira at acme\.atlassian\.net: getaddrinfo/);
});

// ---- The office's Jira ---------------------------------------------------------------------------

test("the office's token is checked with Jira, kept where only the office reads it, and never in what browsers get", async () => {
  const { jira, fake, states, dir } = await office(boardRoutes());
  const me = fake.calls.find((c) => c.path === '/rest/api/3/myself')!;
  assert.equal(me.auth, basic(OFFICE));
  const file = path.join(dir, 'jira-office.json');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.match(readFileSync(file, 'utf8'), new RegExp(OFFICE.token));
  // What browsers are sent: the board, who the office is, the floors' issues; never a token or an email of the office's.
  const sent = JSON.stringify([jira.state(), states, jira.issues, jira.you('acc'), jira.you('someone')]);
  assert.ok(!sent.includes(OFFICE.token) && !sent.includes('office@acme.com'));
  assert.equal(jira.state().office, 'Office Bot');
  assert.deepEqual(jira.state().columns.map((c) => c.name), ['To Do', 'In Progress', 'In Review', 'Done']);
  // The board is read with the office's token.
  assert.ok(fake.calls.filter((c) => c.path.startsWith('/rest/agile')).every((c) => c.auth === basic(OFFICE)));
  // A token Jira won't take isn't kept.
  assert.match((await jira.setOffice('bot@acme.com', 'wrong-token-0123456789'))!, /token is wrong or has expired/);
  assert.equal(jira.state().office, 'Office Bot');
});

test("with no token of the office's, the board is read with a signed-in member's", async () => {
  const { jira, fake, you, dir } = await office(boardRoutes(), { office: false });
  assert.match(jira.issues.error!, /no Jira API token/);
  assert.equal(await jira.signIn('ada123', ADA.email, ADA.token), undefined);
  assert.deepEqual(you, ['ada123']);
  assert.equal(statSync(path.join(dir, 'homes', 'ada123', 'jira.json')).mode & 0o777, 0o600);
  await jira.refresh(true);
  assert.equal(jira.issues.error, undefined);
  assert.equal(fake.calls.filter((c) => c.path.startsWith('/rest/agile')).at(-1)!.auth, basic(ADA));
  assert.deepEqual(jira.you('ada123'), { status: 'ok', who: 'Ada Lovelace', accountId: 'acc-ada', email: ADA.email });
  // On the shared password, you're the office.
  assert.deepEqual(jira.you(undefined), { status: 'none', office: true });
});

test('the assignee filter counts the tickets on the board by who has them, you first', async () => {
  const { jira } = await office(boardRoutes());
  const items = jira.issues.items;
  assert.deepEqual(
    assigneeChoices(items, 'acc-ada').map((c) => [c.value, c.label, c.count]),
    [
      ['all', 'Everyone', 141],
      ['none', 'Unassigned', 138],
      ['acc-ada', 'Me', 2],
      ['acc-bo', 'Bo', 1],
    ],
  );
  assert.deepEqual(
    assigneeChoices(items).map((c) => c.label),
    ['Everyone', 'Unassigned', 'Ada Lovelace', 'Bo'],
  );
  assert.deepEqual(
    items.filter((i) => assignedTo(i, 'acc-ada')).map((i) => i.jira!.key),
    ['CHAT-1', 'CHAT-151'],
  );
  assert.equal(items.filter((i) => assignedTo(i, 'none')).length, 138);
  assert.equal(issueRef(items, 20001), 'CHAT-1');
  assert.equal(issueRef(items, 7), '#7');
  assert.equal(issueName(items, 7), 'issue #7');
});

test('moving, assigning and commenting go out as whoever does them, and say so when they have no Jira sign-in', async () => {
  const routes = boardRoutes();
  routes['POST /rest/api/3/issue/CHAT-1/transitions'] = () => ({ status: 204 });
  routes['PUT /rest/api/3/issue/CHAT-1/assignee'] = () => ({ status: 204 });
  routes['POST /rest/api/3/issue/CHAT-1/comment'] = (c) => ({ status: 201, body: { id: '5', author: { displayName: 'Ada Lovelace' }, body: c.body.body, created: '2026-10-13T10:00:00.000+0000' } });
  const { jira, fake } = await office(routes);
  await jira.signIn('ada123', ADA.email, ADA.token);
  const writes = () => fake.calls.filter((c) => c.method !== 'GET');

  await jira.move('CHAT-1', '31', 'ada123');
  await jira.assign('CHAT-1', 'acc-bo', 'ada123');
  await jira.assign('CHAT-1', null, 'ada123');
  const comment = await jira.comment('CHAT-1', 'Looks good\n\nShip it', 'ada123');
  assert.deepEqual(
    writes().map((c) => [c.method, c.path, c.body, c.auth === basic(ADA)]),
    [
      ['POST', '/rest/api/3/issue/CHAT-1/transitions', { transition: { id: '31' } }, true],
      ['PUT', '/rest/api/3/issue/CHAT-1/assignee', { accountId: 'acc-bo' }, true],
      ['PUT', '/rest/api/3/issue/CHAT-1/assignee', { accountId: null }, true],
      ['POST', '/rest/api/3/issue/CHAT-1/comment', { body: textToAdf('Looks good\n\nShip it') }, true],
    ],
  );
  assert.deepEqual(comment, { id: '5', author: 'Ada Lovelace', body: 'Looks good\n\nShip it', createdAt: '2026-10-13T10:00:00.000Z', url: `${SITE}/browse/CHAT-1?focusedCommentId=5` });
  // On the shared password it's the office's token.
  await jira.move('CHAT-1', '31', undefined);
  assert.equal(writes().at(-1)!.auth, basic(OFFICE));
  // An account without a Jira sign-in of its own is told to sign in, and nothing goes to Jira.
  const before = writes().length;
  await assert.rejects(jira.move('CHAT-1', '31', 'bob456'), /Sign in to Jira first \(☰ → 🔐 Your sign-ins\)/);
  await assert.rejects(jira.comment('CHAT-1', 'hi', 'bob456'), /Sign in to Jira first/);
  assert.equal(writes().length, before);
});

test("a worker taking a ticket moves it to the board's next column it can go to, and assigns it to whoever took it", async () => {
  const routes = boardRoutes();
  // From To Do, Jira offers Done and In Review, but not In Progress: the first column after To Do it can reach is In Review.
  routes['GET /rest/api/3/issue/CHAT-5/transitions'] = () => ({ body: { transitions: [{ id: '41', name: 'Finish', to: { id: '10002' } }, { id: '21', name: 'Review', to: { id: '10001' } }] } });
  routes['POST /rest/api/3/issue/CHAT-5/transitions'] = () => ({ status: 204 });
  routes['PUT /rest/api/3/issue/CHAT-5/assignee'] = () => ({ status: 204 });
  const { jira, fake } = await office(routes);
  await jira.signIn('ada123', ADA.email, ADA.token);
  const n = jira.issues.items.find((i) => i.jira!.key === 'CHAT-5')!.number;
  assert.equal(jira.owns(n), true);
  assert.equal(jira.owns(5), false);
  const warned: string[] = [];
  jira.take(n, 'ada123', (t) => warned.push(t));
  // In progress on the board at once.
  assert.equal(jira.issues.items.find((i) => i.number === n)!.taken, true);
  await new Promise((r) => setTimeout(r, 20));
  const writes = fake.calls.filter((c) => c.method !== 'GET');
  assert.deepEqual(
    writes.map((c) => [c.method, c.path, c.body, c.auth === basic(ADA)]),
    [
      ['POST', '/rest/api/3/issue/CHAT-5/transitions', { transition: { id: '21' } }, true],
      ['PUT', '/rest/api/3/issue/CHAT-5/assignee', { accountId: 'acc-ada' }, true],
    ],
  );
  assert.deepEqual(warned, []);
});

test("when Jira won't move a taken ticket, the taker hears why, and the worker keeps it", async () => {
  const routes = boardRoutes();
  routes['GET /rest/api/3/issue/CHAT-6/transitions'] = () => ({ body: { transitions: [] } });
  routes['PUT /rest/api/3/issue/CHAT-6/assignee'] = () => ({ status: 403, body: { errorMessages: ['You do not have permission to assign issues.'] } });
  const { jira } = await office(routes);
  await jira.signIn('ada123', ADA.email, ADA.token);
  const n = jira.issues.items.find((i) => i.jira!.key === 'CHAT-6')!.number;
  const warned: string[] = [];
  jira.take(n, 'ada123', (t) => warned.push(t));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(warned.length, 1);
  assert.match(warned[0], /A worker has CHAT-6, but Jira didn't take it all in: Jira has no way to move it to In Progress.*wasn't assigned to Ada Lovelace.*permission to assign/);
});

test("a ticket's window reads it with its comments and where it can go, as you; someone else's token only reads what's on the board", async () => {
  const routes = boardRoutes();
  routes['GET /rest/api/3/issue/CHAT-1'] = (c) => {
    assert.equal(c.query.get('expand'), 'transitions');
    return {
      body: {
        key: 'CHAT-1',
        fields: {
          summary: 'Ticket 1',
          status: STATUS.todo,
          issuetype: { name: 'Bug' },
          reporter: { accountId: 'acc-bo', displayName: 'Bo' },
          labels: ['web'],
          created: '2026-10-01T09:00:00.000+0000',
          updated: '2026-10-02T09:00:00.000+0000',
          description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Broken', marks: [{ type: 'strong' }] }] }] },
          comment: { comments: [{ id: '9', author: { displayName: 'Bo' }, body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Same here' }] }] }, created: '2026-10-03T09:00:00.000+0000' }] },
        },
        transitions: [{ id: '11', name: 'Start', to: { id: '3', name: 'In Progress' } }],
      },
    };
  };
  routes['GET /rest/api/3/issue/OTHER-1'] = () => ({ body: { key: 'OTHER-1', fields: {} } });
  routes['GET /rest/api/3/user/assignable/search'] = (c) => ({ body: [{ accountId: 'acc-bo', displayName: `Bo (${c.query.get('issueKey')} ${c.query.get('query')})` }, { accountId: 'gone', displayName: 'Gone', active: false }] });
  const { jira, fake } = await office(routes);
  const t = await jira.detail('CHAT-1', undefined);
  assert.equal(t.description, '**Broken**');
  assert.deepEqual(t.reporter, { accountId: 'acc-bo', name: 'Bo' });
  assert.deepEqual(t.comments.map((c) => [c.author, c.body]), [['Bo', 'Same here']]);
  assert.deepEqual(t.transitions, [{ id: '11', name: 'Start', to: 'In Progress' }]);
  assert.deepEqual(await jira.assignable('CHAT-1', 'bo', undefined), [{ accountId: 'acc-bo', name: 'Bo (CHAT-1 bo)' }]);
  // An account without a sign-in reads a ticket on the board with the board's token, but nothing else.
  await jira.detail('CHAT-1', 'bob456');
  await assert.rejects(jira.detail('OTHER-1', 'bob456'), /OTHER-1 isn't on the board/);
  await jira.signIn('ada123', ADA.email, ADA.token);
  await jira.detail('OTHER-1', 'ada123');
  assert.equal(fake.calls.at(-1)!.auth, basic(ADA));
});

test("a floor's issues are the Jira board's while it's on, and its repository's while it's off", async () => {
  const { jira } = await office(boardRoutes());
  const own = { kind: 'github', issues: { items: [{ number: 1 }], fetchedAt: 1, loading: false }, pulls: { items: [], fetchedAt: 1, loading: false }, refresh: async () => {}, stop() {} } as unknown as Forge;
  const sent: GhState<GhIssue>[] = [];
  const forge = withJira(jira, own, (s) => sent.push(s));
  assert.equal(forge.kind, 'github');
  assert.equal(forge.issues, jira.issues);
  jira.configure(false, undefined, 'Ada');
  assert.equal(forge.issues, own.issues);
  assert.deepEqual(sent.at(-1), own.issues);
  jira.configure(true, undefined, 'Ada');
  assert.equal(sent.at(-1), jira.issues);
  forge.stop();
  const was = sent.length;
  jira.configure(false, undefined, 'Ada');
  assert.equal(sent.length, was);
});

test('the board link and whether it is on are kept across a restart', async () => {
  const { dir, fake } = await office(boardRoutes());
  const again = new Jira(dir, { state() {}, you() {} }, fake.fetchFn);
  assert.equal(again.on, true);
  assert.deepEqual([again.state().site, again.state().board, again.state().url, again.state().office], [SITE, 143, LINK, 'Office Bot']);
  assert.match(again.configure(true, 'https://example.com/boards/1', 'Ada')!, /Jira Cloud/);
});

test("a worker handed a ticket gets the Jira prompt, with what the ticket says; a rewritten one is used as it's written", async () => {
  const { fillPrompt, promptText } = await import('../src/shared/prompts.js');
  const vars = { key: 'CHAT-7', title: 'Fix login', url: `${SITE}/browse/CHAT-7`, type: 'Bug', status: 'To Do', description: 'It **breaks**' };
  const work = fillPrompt(promptText({}, 'jira.work'), vars);
  assert.match(work, /^Work on Jira ticket CHAT-7 \(Bug\): "Fix login"\.\nhttps:\/\/acme\.atlassian\.net\/browse\/CHAT-7\n\nWhat the ticket says:\nIt \*\*breaks\*\*\n\n/);
  assert.match(work, /can't reach Jira/);
  assert.match(fillPrompt(promptText({}, 'jira.ask'), vars), /Jira ticket CHAT-7 \(Bug, To Do\)/);
  // GitLab's floors get the same: a ticket isn't GitHub's or GitLab's.
  assert.equal(promptText({}, 'jira.work', 'gitlab'), promptText({}, 'jira.work'));
  assert.equal(fillPrompt(promptText({ 'jira.work': { text: 'Do {{key}}' } }, 'jira.work'), vars), 'Do CHAT-7');
});

test("a ticket taken by someone without a Jira sign-in is moved on as the office, never as another member, and isn't assigned", async () => {
  const routes = boardRoutes();
  routes['GET /rest/api/3/issue/CHAT-8/transitions'] = () => ({ body: { transitions: [{ id: '11', name: 'Start', to: { id: '3' } }] } });
  routes['POST /rest/api/3/issue/CHAT-8/transitions'] = () => ({ status: 204 });
  const take = async (withOffice: boolean) => {
    const { jira, fake } = await office(routes, { office: withOffice });
    await jira.signIn('ada123', ADA.email, ADA.token);
    await jira.refresh(true);
    const n = jira.issues.items.find((i) => i.jira!.key === 'CHAT-8')!.number;
    const warned: string[] = [];
    jira.take(n, 'bob456', (t) => warned.push(t));
    await new Promise((r) => setTimeout(r, 20));
    return { writes: fake.calls.filter((c) => c.method !== 'GET').map((c) => [c.method, c.path, c.auth === basic(OFFICE) ? 'office' : 'ada']), warned };
  };
  assert.deepEqual(await take(true), { writes: [['POST', '/rest/api/3/issue/CHAT-8/transitions', 'office']], warned: [] });
  const without = await take(false);
  assert.deepEqual(without.writes, []);
  assert.match(without.warned[0], /Sign in to Jira first/);
});
