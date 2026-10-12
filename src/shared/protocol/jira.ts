// The Jira board: once ⚙️ Settings points the office at one, every floor's issues board is that
// board's tickets (see server/jira/), each one an issue (GhIssue) carrying its Jira card. Nothing
// here ever holds a Jira API token: those stay on the office's machine.

import type { GhComment } from './github.js';

/** Someone in Jira: who a ticket is assigned to, or who reported it. */
export interface JiraPerson {
  accountId: string;
  name: string;
}

/** What a ticket on the board has beyond what every issue has (GhIssue.jira). */
export interface JiraCard {
  /** CHAT-123 */
  key: string;
  /** The board column its status puts it in: an index into JiraState.columns. */
  column: number;
  /** It's in the board's to-do column, where the cork board on the wall takes its notes from. */
  todo: boolean;
  status: string;
  /** Jira's kind of status: new, indeterminate (in progress) or done. */
  category: JiraCategory;
  /** Bug, Story, Task… */
  type: string;
  priority?: string;
  assignee?: JiraPerson;
  /** Its epic or parent ticket. */
  parent?: { key: string; summary: string };
}

export type JiraCategory = 'new' | 'indeterminate' | 'done';

export interface JiraColumn {
  name: string;
  /** Where tickets wait to be taken: the cork board's notes, and where a worker takes one from. */
  todo?: boolean;
  /** Holds finished tickets: only the ones updated lately are on the board. */
  done?: boolean;
}

/** The Jira board as everyone sees it (FloorView.jira, then 'jira' whenever it changes). */
export interface JiraState {
  /** Every floor's issues board is the Jira board. */
  on: boolean;
  /** https://example.atlassian.net */
  site?: string;
  board?: number;
  /** The board's name, once Jira has said. */
  name?: string;
  /** Its page in Jira. */
  url?: string;
  columns: JiraColumn[];
  /** Who the office's own Jira API token (⚙️ Settings) signs in as, when it has one. */
  office?: string;
  /** Who set it up, and when. */
  by?: string;
  at?: number;
}

/** Your own Jira sign-in, as the office sees it: answered to 'jira.get', and sent again when it changes. */
export interface JiraYou {
  status: 'ok' | 'none';
  /** Their name in Jira. */
  who?: string;
  accountId?: string;
  /** The email it signs in with (only ever sent to its owner). */
  email?: string;
  /** It's the office's own token: on the shared password, everyone is the office. */
  office?: boolean;
  error?: string;
}

/** A way to move a ticket on: to the status `to`. */
export interface JiraTransition {
  id: string;
  name: string;
  to: string;
}

/** Everything the ticket window shows: GET /api/jira/ticket?key=CHAT-123 */
export interface JiraTicket {
  key: string;
  summary: string;
  url: string;
  type: string;
  status: string;
  category: JiraCategory;
  priority?: string;
  labels: string[];
  assignee?: JiraPerson;
  reporter?: JiraPerson;
  parent?: { key: string; summary: string };
  created: string;
  updated: string;
  /** As Markdown, from Jira's document format. */
  description: string;
  comments: GhComment[];
  /** Where you can move it from here, as whoever asked. */
  transitions: JiraTransition[];
}

/** Jira turns away comments longer than this. */
export const JIRA_COMMENT_MAX = 32_000;

export type JiraClientMsg =
  /** Your own Jira sign-in; answered with jira.you. */
  | { t: 'jira.get' }
  /** Admins: turn the Jira board on or off, and which board (a board's URL, pasted). */
  | { t: 'jira.config'; on: boolean; url?: string }
  /** Admins: the office's own Jira email and API token, for reading the board (and acting, on the shared password); an empty token takes it off. */
  | { t: 'jira.office'; email: string; token: string }
  /** Your own Jira email and API token, which what you do on the board goes out as. */
  | { t: 'jira.signin'; email: string; token: string }
  | { t: 'jira.signout' }
  | { t: 'jira.refresh' }
  /** Move a ticket by one of its transitions; answered with jira.done. */
  | { t: 'jira.move'; key: string; transition: string }
  /** Assign a ticket (null: nobody); answered with jira.done. */
  | { t: 'jira.assign'; key: string; accountId: string | null }
  /** Comment on a ticket, in plain text; answered with jira.done. */
  | { t: 'jira.comment'; key: string; body: string };

export type JiraServerMsg =
  | { t: 'jira'; state: JiraState }
  | { t: 'jira.you'; state: JiraYou }
  /** Sent to whoever asked: how it went, and for a comment, the comment as Jira saved it. */
  | { t: 'jira.done'; key: string; op: 'move' | 'assign' | 'comment'; error?: string; comment?: GhComment };
