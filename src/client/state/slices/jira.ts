import type { JiraState, JiraYou, ServerMsg } from '../../../shared/protocol';
import type { Slice } from '../store';

declare module '../store' {
  interface Store {
    /** The Jira board, when it's every floor's issues board (see ui/jira/). Its tickets are the floor's `issues`. */
    jira: JiraState;
    /** Your own Jira sign-in (the office's, on the shared password), once you've asked. */
    jiraYou: JiraYou | null;
    /** The office's last answer to something you did to a ticket: moved, assigned or commented on it. */
    jiraDone: Extract<ServerMsg, { t: 'jira.done' }> | null;
  }
  interface Topics {
    jira: true;
    jiraYou: true;
    jiraDone: true;
  }
}

export const jira: Slice = {
  init(s) {
    s.jira = { on: false, columns: [] };
    s.jiraYou = null;
    s.jiraDone = null;
  },
  on: {
    jira(s, m) {
      s.jira = m.state;
      return ['jira'];
    },
    'jira.you'(s, m) {
      s.jiraYou = m.state;
      return ['jiraYou'];
    },
    'jira.done'(s, m) {
      s.jiraDone = m;
      return ['jiraDone'];
    },
  },
  // The same on every floor, and sent with each.
  enter(s, v) {
    if (!v.jira) return;
    s.jira = v.jira;
    return ['jira'];
  },
};
