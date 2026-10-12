// Reading a Jira board: its columns from the board's configuration, and its tickets (a page at a time)
// as the issues board's cards. A Scrum board shows its open sprint; finished tickets are only the ones
// updated in the last two weeks, and at most DONE_MAX of those, so the board isn't buried in them.

import type { GhComment, GhIssue, GhLabel, JiraCategory, JiraColumn, JiraPerson, JiraTicket, JiraTransition } from '../../shared/protocol.js';
import { ticketUrl } from '../../shared/jira.js';
import type { JiraApi } from './api.js';
import { adfToMarkdown } from './adf.js';

/** The fields a card needs, as the board endpoint is asked for them. */
const FIELDS = 'summary,status,assignee,reporter,priority,issuetype,labels,created,updated,parent,description';
/** Finished tickets on the board: updated in this many days… */
const DONE_DAYS = 14;
/** …and no more than this many of them, the newest. */
export const DONE_MAX = 40;
const PAGE = 100;
/** The most tickets one look at the board takes in. */
const MOST = 1000;
/** How much of a ticket's description its card keeps (the window asks Jira for the rest). */
const BODY_MAX = 3000;

/** A board, as one look at it found it. */
export interface Board {
  name: string;
  columns: JiraColumn[];
  /** Each column's statuses, by Jira status id. */
  statuses: string[][];
  /** Which column is the to-do one (see JiraColumn.todo). */
  todo: number;
  items: GhIssue[];
}

const LABEL_COLORS = ['#bde0fe', '#caffbf', '#ffd6a5', '#fdffb6', '#ffc6ff', '#a0c4ff', '#9bf6ff', '#ffadad'];

/** A Jira label has no color of its own: one from its name, the same every time. */
export function labelColor(name: string): string {
  let x = 0;
  for (const ch of name) x = (x * 31 + ch.charCodeAt(0)) | 0;
  return LABEL_COLORS[Math.abs(x) % LABEL_COLORS.length];
}

/** Jira's times (2024-05-01T10:00:00.000+0200) as ISO in UTC, which the page sorts and reads. */
export function isoOf(t: unknown): string {
  if (typeof t !== 'string' || !t) return '';
  const ms = Date.parse(t.replace(/([+-]\d\d)(\d\d)$/, '$1:$2'));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : t;
}

const categoryOf = (status: any): JiraCategory => {
  const key = String(status?.statusCategory?.key ?? '');
  return key === 'done' ? 'done' : key === 'indeterminate' ? 'indeterminate' : 'new';
};

const personOf = (u: any): JiraPerson | undefined => (u?.accountId ? { accountId: String(u.accountId), name: String(u.displayName ?? 'someone') } : undefined);

const parentOf = (p: any) => (p?.key ? { key: String(p.key), summary: String(p.fields?.summary ?? '') } : undefined);

/** The to-do column: the first one called something like To Do or Selected for Development, else the first. */
export function todoColumn(columns: { name: string }[]): number {
  const i = columns.findIndex((c) => /\b(to ?do|selected|ready|open|new)\b/i.test(c.name));
  return Math.max(0, i);
}

/** The board's columns from its configuration, leaving out a Kanban board's Backlog (which Jira's board leaves off too). */
export function columnsOf(config: any): { columns: JiraColumn[]; statuses: string[][]; todo: number } {
  const raw = (config?.columnConfig?.columns ?? []).filter((c: any) => !/^backlog$/i.test(String(c?.name ?? '').trim()));
  const columns: JiraColumn[] = raw.map((c: any) => ({ name: String(c.name ?? '') }));
  const statuses: string[][] = raw.map((c: any) => (c.statuses ?? []).map((s: any) => String(s.id)));
  const todo = todoColumn(columns);
  if (columns[todo]) columns[todo].todo = true;
  return { columns, statuses, todo };
}

/** A ticket from the board as the issues board's card, in `column`. */
export function ticketOf(raw: any, site: string, column: number, todo: number): GhIssue {
  const f = raw.fields ?? {};
  const key = String(raw.key);
  const category = categoryOf(f.status);
  return {
    number: Number(raw.id),
    title: String(f.summary ?? ''),
    state: category === 'done' ? 'CLOSED' : 'OPEN',
    url: ticketUrl(site, key),
    author: String(f.reporter?.displayName ?? f.creator?.displayName ?? ''),
    labels: (Array.isArray(f.labels) ? f.labels : []).map((name: unknown): GhLabel => ({ name: String(name), color: labelColor(String(name)) })),
    assignees: f.assignee?.displayName ? [String(f.assignee.displayName)] : [],
    createdAt: isoOf(f.created),
    updatedAt: isoOf(f.updated),
    body: adfToMarkdown(f.description).slice(0, BODY_MAX),
    comments: 0,
    jira: {
      key,
      column,
      todo: column === todo,
      status: String(f.status?.name ?? ''),
      category,
      type: String(f.issuetype?.name ?? 'Ticket'),
      ...(f.priority?.name ? { priority: String(f.priority.name) } : {}),
      ...(personOf(f.assignee) ? { assignee: personOf(f.assignee) } : {}),
      ...(parentOf(f.parent) ? { parent: parentOf(f.parent) } : {}),
    },
  };
}

/** One look at board `id`: its name, its columns, and its tickets on them. */
export async function loadBoard(api: JiraApi, id: number): Promise<Board> {
  const what = `board ${id}`;
  const [info, config] = await Promise.all([api.get(`/rest/agile/1.0/board/${id}`, what), api.get(`/rest/agile/1.0/board/${id}/configuration`, what)]);
  const { columns, statuses, todo } = columnsOf(config);
  const columnOf = new Map<string, number>();
  statuses.forEach((ids, i) => ids.forEach((s) => columnOf.set(s, i)));

  // A Scrum board is its open sprint, as Jira shows it; with none open, the whole board.
  let jql = `(statusCategory != Done OR updated >= -${DONE_DAYS}d)`;
  if (info?.type === 'scrum') {
    const sprints = await api.get(`/rest/agile/1.0/board/${id}/sprint?state=active&maxResults=1`, what).catch(() => undefined);
    if (sprints?.values?.length) jql = `sprint in openSprints() AND ${jql}`;
  }
  const raw: any[] = [];
  for (let startAt = 0; startAt < MOST; ) {
    const q = new URLSearchParams({ jql, fields: FIELDS, startAt: String(startAt), maxResults: String(PAGE) });
    const page = await api.get(`/rest/agile/1.0/board/${id}/issue?${q}`, what);
    const issues: any[] = Array.isArray(page?.issues) ? page.issues : [];
    raw.push(...issues);
    startAt += issues.length;
    if (!issues.length || startAt >= Number(page?.total ?? 0)) break;
  }

  const items: GhIssue[] = [];
  const done: GhIssue[] = [];
  for (const r of raw) {
    const column = columnOf.get(String(r.fields?.status?.id));
    // A status the board has no column for isn't on the board.
    if (column === undefined || !r.id || !r.key) continue;
    const t = ticketOf(r, api.site, column, todo);
    (t.jira!.category === 'done' ? done : items).push(t);
  }
  done.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  items.push(...done.slice(0, DONE_MAX));
  // A column of finished tickets: named so, or holding nothing else.
  columns.forEach((c, i) => {
    const here = items.filter((t) => t.jira!.column === i);
    if (/\b(done|closed|resolved|complete|released)\b/i.test(c.name) || (here.length && here.every((t) => t.jira!.category === 'done'))) c.done = true;
  });
  return { name: String(info?.name ?? `Board ${id}`), columns, statuses, todo, items };
}

/** A comment as the ticket window shows it. */
export function commentOf(c: any, site: string, key: string): GhComment {
  return {
    id: String(c.id),
    author: String(c.author?.displayName ?? 'someone'),
    body: adfToMarkdown(c.body),
    createdAt: isoOf(c.created),
    url: `${ticketUrl(site, key)}?focusedCommentId=${encodeURIComponent(String(c.id))}`,
  };
}

/** A ticket in full, for its window: GET /rest/api/3/issue/{key} with its comments and transitions. */
export async function ticketDetail(api: JiraApi, key: string): Promise<JiraTicket> {
  const fields = 'summary,status,assignee,reporter,priority,issuetype,labels,created,updated,description,parent,comment';
  const i = await api.get(`/rest/api/3/issue/${encodeURIComponent(key)}?fields=${fields}&expand=transitions`, key);
  const f = i?.fields ?? {};
  const realKey = String(i?.key ?? key);
  const transitions: JiraTransition[] = (i?.transitions ?? []).map((t: any) => ({ id: String(t.id), name: String(t.name ?? ''), to: String(t.to?.name ?? t.name ?? '') }));
  return {
    key: realKey,
    summary: String(f.summary ?? ''),
    url: ticketUrl(api.site, realKey),
    type: String(f.issuetype?.name ?? 'Ticket'),
    status: String(f.status?.name ?? ''),
    category: categoryOf(f.status),
    ...(f.priority?.name ? { priority: String(f.priority.name) } : {}),
    labels: (Array.isArray(f.labels) ? f.labels : []).map(String),
    ...(personOf(f.assignee) ? { assignee: personOf(f.assignee) } : {}),
    ...(personOf(f.reporter) ? { reporter: personOf(f.reporter) } : {}),
    ...(parentOf(f.parent) ? { parent: parentOf(f.parent) } : {}),
    created: isoOf(f.created),
    updated: isoOf(f.updated),
    description: adfToMarkdown(f.description),
    comments: (f.comment?.comments ?? []).map((c: any) => commentOf(c, api.site, realKey)),
    transitions,
  };
}
