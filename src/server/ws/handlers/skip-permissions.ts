// ⚙️ Settings' ⚡ Skip permission prompts: whether workers may be hired to run without asking (see
// skip-permissions.ts). Admins only.
import type { SkipPermissionsClientMsg } from '../../../shared/protocol.js';
import type { HandlerMap } from './types.js';

export const skipPermissionsHandlers = {
  'skipPermissions.set'(ctx, c, msg) {
    const who = c.peer.name;
    if (!ctx.meOf(c.accountId).admin) return ctx.warn(c, 'Only admins can let workers skip their permission prompts');
    const on = msg.on === true;
    if (on === ctx.skipPermissions.on) return;
    ctx.skipPermissions.set(on, who);
    ctx.toastAll(
      on
        ? `⚡ ${who} let workers be hired to skip their permission prompts`
        : `🛡️ ${who} turned off skipping permission prompts: workers hired that way ask again once they restart`,
    );
  },
} satisfies HandlerMap<SkipPermissionsClientMsg>;
