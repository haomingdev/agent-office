// What the office and the page both know about the Jira board (see server/jira/): reading a pasted
// board URL, what a ticket is called, and who the board's tickets are assigned to.

import type { GhIssue } from './protocol.js';

/** A Jira Cloud site: the office only ever sends a Jira token to one of these. */
const CLOUD_HOST = /^[a-z0-9][a-z0-9-]*\.(atlassian\.net|jira\.com)$/;

/** CHAT-123: a project key (a letter, then letters, digits or _) and the ticket's number. */
export const JIRA_KEY = /^[A-Z][A-Z0-9_]{0,49}-\d{1,9}$/;

/**
 * The site and board from a board's URL as it's pasted from the browser
 * (https://example.atlassian.net/jira/software/c/projects/CHAT/boards/143, …/boards/143/backlog,
 * an old …/secure/RapidBoard.jspa?rapidView=143), or why it isn't one.
 */
export function parseJiraBoard(raw: string): { site: string; board: number } | string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return "That isn't a link: paste the board's address from your browser";
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || !CLOUD_HOST.test(host)) return 'The office works with Jira Cloud boards, at https://<your-site>.atlassian.net';
  const id = /\/boards\/(\d+)(?:\/|$)/.exec(url.pathname)?.[1] ?? url.searchParams.get('rapidView') ?? '';
  const board = /^\d{1,9}$/.test(id) ? Number(id) : 0;
  if (!board) return "That link doesn't name a board: open the board in Jira and copy its address (…/boards/143)";
  return { site: `https://${host}`, board };
}

/** A ticket's page in Jira. */
export function ticketUrl(site: string, key: string): string {
  return `${site}/browse/${key}`;
}

/** What an issue on the board is called: CHAT-123 for a Jira ticket, else #12. */
export function issueRef(items: readonly GhIssue[], n: number): string {
  return items.find((i) => i.number === n)?.jira?.key ?? `#${n}`;
}

/** The same in a sentence: "CHAT-123", or "issue #12". */
export function issueName(items: readonly GhIssue[], n: number): string {
  const key = items.find((i) => i.number === n)?.jira?.key;
  return key ?? `issue #${n}`;
}

const TYPE_ICON: [RegExp, string][] = [
  [/bug|defect|incident/i, '🐞'],
  [/epic/i, '⚡'],
  [/story/i, '📗'],
  [/sub-?task/i, '↳'],
  [/task/i, '☑️'],
  [/spike|research/i, '🔬'],
];

/** An emoji for a ticket's type: 🐞 a bug, 📗 a story, ☑️ a task… */
export function typeIcon(type: string): string {
  return TYPE_ICON.find(([re]) => re.test(type))?.[1] ?? '📄';
}

const PRIORITY_ICON: Record<string, string> = { highest: '⏫', blocker: '⛔', critical: '⏫', high: '🔼', major: '🔼', medium: '🟰', low: '🔽', minor: '🔽', lowest: '⏬', trivial: '⏬' };

/** An emoji for a ticket's priority, '' for one Jira's defaults don't have. */
export function priorityIcon(priority: string | undefined): string {
  return (priority && PRIORITY_ICON[priority.toLowerCase()]) || '';
}

/** Who the board's filter shows: everyone, the unassigned tickets, or one person's (by Jira account id). */
export type AssigneeFilter = 'all' | 'none' | string;

/** One choice in the board's assignee filter, with how many tickets it shows. */
export interface AssigneeChoice {
  value: AssigneeFilter;
  label: string;
  count: number;
}

/**
 * The assignee filter's choices for the tickets on the board: Everyone, Unassigned, you (when the
 * office knows your Jira account), then everyone else with tickets, most first.
 */
export function assigneeChoices(items: readonly GhIssue[], me?: string): AssigneeChoice[] {
  const tickets = items.filter((i) => i.jira);
  const people = new Map<string, { name: string; count: number }>();
  for (const t of tickets) {
    const a = t.jira!.assignee;
    if (!a) continue;
    const p = people.get(a.accountId) ?? { name: a.name, count: 0 };
    p.count++;
    people.set(a.accountId, p);
  }
  const out: AssigneeChoice[] = [
    { value: 'all', label: 'Everyone', count: tickets.length },
    { value: 'none', label: 'Unassigned', count: tickets.filter((t) => !t.jira!.assignee).length },
  ];
  if (me) out.push({ value: me, label: 'Me', count: people.get(me)?.count ?? 0 });
  const rest = [...people].filter(([id]) => id !== me).sort((a, b) => b[1].count - a[1].count || a[1].name.localeCompare(b[1].name));
  for (const [id, p] of rest) out.push({ value: id, label: p.name, count: p.count });
  return out;
}

/** Whether a ticket passes the assignee filter. */
export function assignedTo(it: GhIssue, filter: AssigneeFilter): boolean {
  if (filter === 'all') return true;
  const a = it.jira?.assignee;
  return filter === 'none' ? !a : a?.accountId === filter;
}
