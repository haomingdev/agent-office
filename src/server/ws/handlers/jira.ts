// The Jira board (see server/jira/): setting it up (admins), signing in to it, and moving, assigning
// and commenting on its tickets, each as whoever asked.
import { JIRA_COMMENT_MAX, type JiraClientMsg } from '../../../shared/protocol.js';
import { JIRA_KEY } from '../../../shared/jira.js';
import type { Ctx } from '../../office/context.js';
import type { Client } from '../../office/client.js';
import { str } from '../../office/input.js';
import type { HandlerMap, ViewPieces } from './types.js';

export const jiraView: ViewPieces['jira'] = (ctx) => ctx.jira.state();

/** Tells `c` about their own Jira sign-in. */
const sendYou = (ctx: Ctx, c: Client) => ctx.sendTo(c, { t: 'jira.you', state: ctx.jira.you(c.accountId) });

/** The ticket a message is about, or nothing (and a warning) when it isn't one. */
function keyOf(ctx: Ctx, c: Client, v: unknown): string | undefined {
  const key = str(v, 64).trim().toUpperCase();
  if (JIRA_KEY.test(key)) return key;
  ctx.warn(c, 'Not a Jira ticket');
  return undefined;
}

export const jiraHandlers = {
  'jira.get'(ctx, c) {
    sendYou(ctx, c);
  },
  'jira.config'(ctx, c, msg) {
    const who = c.peer.name;
    if (!ctx.meOf(c.accountId).admin) return ctx.warn(c, 'Only admins can set up the Jira board');
    const on = msg.on === true;
    const was = ctx.jira.on;
    const err = ctx.jira.configure(on, msg.url === undefined ? undefined : str(msg.url, 2048), who);
    if (err) return ctx.warn(c, err);
    if (on !== was) ctx.toastAll(on ? `📌 ${who} made the Jira board every floor's issues board` : `📌 ${who} put the issues boards back to the floors' own issues`);
  },
  'jira.office'(ctx, c, msg) {
    const who = c.peer.name;
    if (!ctx.meOf(c.accountId).admin) return ctx.warn(c, "Only admins can set the office's Jira token");
    const token = str(msg.token, 4096).trim();
    void ctx.jira.setOffice(str(msg.email, 300), token).then((err) => {
      // Kept in ⚙️ Settings by the token's box, not a toast that's gone before it's read.
      if (err) return ctx.sendTo(c, { t: 'jira.you', state: { ...ctx.jira.you(c.accountId), error: err } });
      ctx.toastAll(token ? `🔐 ${who} gave the office a Jira API token` : `🔐 ${who} took the office's Jira API token off`);
    });
  },
  'jira.signin'(ctx, c, msg) {
    const id = c.accountId;
    // On the shared password everyone is the office, whose token is in ⚙️ Settings.
    if (!id) return ctx.warn(c, "On the shared password, the office's own Jira token is everyone's: set it in ⚙️ Settings → Building → Jira");
    void ctx.jira.signIn(id, str(msg.email, 300), str(msg.token, 4096)).then((err) => {
      if (err) ctx.sendTo(c, { t: 'jira.you', state: { ...ctx.jira.you(id), error: err } });
    });
  },
  'jira.signout'(ctx, c) {
    if (c.accountId) ctx.jira.signOut(c.accountId);
  },
  'jira.refresh'(ctx) {
    void ctx.jira.refresh(true);
  },
  'jira.move'(ctx, c, msg) {
    const who = c.peer.name;
    const key = keyOf(ctx, c, msg.key);
    if (!key) return;
    const transition = str(msg.transition, 32);
    if (!/^\d+$/.test(transition)) return ctx.warn(c, 'Not a way to move a ticket');
    void ctx.jira.move(key, transition, c.accountId).then(
      () => {
        ctx.sendTo(c, { t: 'jira.done', key, op: 'move' });
        ctx.toastFloor(ctx.floorOf(c), `📌 ${who} moved ${key} on the Jira board`);
      },
      (err: Error) => ctx.sendTo(c, { t: 'jira.done', key, op: 'move', error: err.message }),
    );
  },
  'jira.assign'(ctx, c, msg) {
    const who = c.peer.name;
    const key = keyOf(ctx, c, msg.key);
    if (!key) return;
    const to = msg.accountId === null ? null : str(msg.accountId, 128);
    if (to !== null && !/^[\w:-]{1,128}$/.test(to)) return ctx.warn(c, 'Not a Jira account');
    void ctx.jira.assign(key, to, c.accountId).then(
      () => {
        ctx.sendTo(c, { t: 'jira.done', key, op: 'assign' });
        ctx.toastFloor(ctx.floorOf(c), to ? `👤 ${who} assigned ${key}` : `👤 ${who} unassigned ${key}`);
      },
      (err: Error) => ctx.sendTo(c, { t: 'jira.done', key, op: 'assign', error: err.message }),
    );
  },
  'jira.comment'(ctx, c, msg) {
    const who = c.peer.name;
    const key = keyOf(ctx, c, msg.key);
    if (!key) return;
    const body = str(msg.body, JIRA_COMMENT_MAX + 1);
    if (!body.trim()) return ctx.sendTo(c, { t: 'jira.done', key, op: 'comment', error: 'Write something first' });
    if (body.length > JIRA_COMMENT_MAX) return ctx.sendTo(c, { t: 'jira.done', key, op: 'comment', error: `That's longer than Jira takes (${JIRA_COMMENT_MAX} characters)` });
    void ctx.jira.comment(key, body, c.accountId).then(
      (comment) => {
        ctx.sendTo(c, { t: 'jira.done', key, op: 'comment', comment });
        ctx.toastFloor(ctx.floorOf(c), `💬 ${who} commented on ${key}`);
      },
      (err: Error) => ctx.sendTo(c, { t: 'jira.done', key, op: 'comment', error: err.message }),
    );
  },
} satisfies HandlerMap<JiraClientMsg>;
