// The office's prompts for a ticket on the Jira board (see shared/jira.ts), beside the issue ones in
// prompts.ts. Workers can't reach Jira (its tokens never leave the office), so everything the ticket
// says goes in the prompt itself.

import type { PromptDef } from './prompts.js';

const TICKET_VARS = {
  key: 'The ticket: CHAT-123',
  title: 'Its summary',
  url: 'Its page in Jira',
  type: 'Bug, Story, Task…',
  status: 'Its status on the board',
  description: "Its description, as text ('(no description)' when it has none)",
};

const NO_JIRA = "You can't reach Jira from here: everything the ticket says is above.";

export const JIRA_PROMPTS = {
  'jira.work': {
    group: 'issues',
    label: '🤖 Hand a Jira ticket to a worker',
    used: 'The task a worker gets for a ticket on the Jira board: 🤖 Hand to a worker, 📋 Add to queue, and a card carried to a desk or the queue.',
    vars: TICKET_VARS,
    text: [
      'Work on Jira ticket {{key}} ({{type}}): "{{title}}".',
      '{{url}}',
      '',
      'What the ticket says:',
      '{{description}}',
      '',
      `${NO_JIRA} Create a new branch with {{key}} in its name, implement the change and verify it, then push it and open a pull request (a merge request on GitLab) with {{key}} at the start of its title.`,
    ].join('\n'),
  },
  'jira.ask': {
    group: 'issues',
    label: '✍️ Ask a worker about a Jira ticket (context)',
    used: 'Told to the worker ahead of your own words when you ✍️ Ask a worker about a ticket on the Jira board.',
    vars: TICKET_VARS,
    optional: true,
    text: ['This is about Jira ticket {{key}} ({{type}}, {{status}}): "{{title}}" ({{url}}).', '', 'What the ticket says:', '{{description}}', '', NO_JIRA].join('\n'),
  },
  'jira.meeting': {
    group: 'issues',
    label: '🤝 Meeting about a Jira ticket',
    used: 'What a 🤝 Meeting about a ticket on the Jira board is about, to start with: the meeting form opens with it filled in.',
    vars: TICKET_VARS,
    text: ['Jira ticket {{key}} ({{type}}): “{{title}}”.', '', 'What the ticket says:', '{{description}}'].join('\n'),
  },
} satisfies Record<string, PromptDef>;
