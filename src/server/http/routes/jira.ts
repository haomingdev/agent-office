// The Jira ticket window: a ticket in full (its description, comments and where it can move to), and
// who it can be assigned to. Each is read as whoever asks, when they're signed in to Jira.
import { JIRA_KEY } from '../../../shared/jira.js';
import { send } from '../util.js';
import type { Route } from '../router.js';

export const jiraRoutes = {
  jira: {
    method: 'GET',
    prefix: '/api/jira/',
    auth: 'session',
    async handle(ctx, { res, url, path: p, session }) {
      const key = (url.searchParams.get('key') ?? '').trim().toUpperCase();
      if (!JIRA_KEY.test(key)) return send(res, 400, { error: 'Not a Jira ticket' });
      const me = session.account?.id;
      try {
        if (p === '/api/jira/ticket') return send(res, 200, await ctx.jira.detail(key, me));
        if (p === '/api/jira/assignable') return send(res, 200, await ctx.jira.assignable(key, (url.searchParams.get('q') ?? '').slice(0, 100), me));
      } catch (err) {
        return send(res, 502, { error: (err as Error).message });
      }
      return send(res, 404, { error: 'Not found' });
    },
  },
} satisfies Record<string, Route>;
