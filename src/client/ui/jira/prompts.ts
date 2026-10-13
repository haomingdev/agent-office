import type { GhIssue } from '../../../shared/protocol';
import { store } from '../../state';
import type { MeetingPreset } from '../meeting';
import { officePrompt } from '../prompts';

// ---- Prompts for a ticket on the Jira board ----------------------------------------------------
// The issue windows, carried cards and the queue all hand a worker an issue by its number; for a
// ticket on the Jira board that's its Jira id, and these are what it gets instead of an issue's prompts.

/** Issue `n` on the board, when it's a Jira ticket. */
export function jiraIssue(n: number): GhIssue | undefined {
  return store.issues.items.find((i) => i.number === n && i.jira);
}

/** What a ticket's prompts fill in (see shared/prompts-jira.ts). */
export function ticketVars(it: GhIssue) {
  const j = it.jira!;
  return { key: j.key, title: it.title, url: it.url, type: j.type, status: j.status, description: it.body.trim() || '(no description)' };
}

/** The task a worker gets for a ticket: 🤖 Hand to a worker, 📋 Add to queue, a carried card. */
export function ticketPrompt(it: GhIssue): string {
  return officePrompt('jira.work', ticketVars(it));
}

/** Told to the worker ahead of your own words when you ✍️ Ask a worker about a ticket. */
export function ticketContext(it: GhIssue): string {
  return officePrompt('jira.ask', ticketVars(it));
}

/** A meeting about a ticket: the meeting room's form, filled in. */
export function ticketMeeting(it: GhIssue): MeetingPreset {
  return { title: `${it.jira!.key} ${it.title}`, prompt: officePrompt('jira.meeting', ticketVars(it)) };
}
