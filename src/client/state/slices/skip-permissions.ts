import type { SkipPermissionsState } from '../../../shared/protocol';
import type { Slice } from '../store';

declare module '../store' {
  interface Store {
    /** Whether workers may be hired to skip their permission prompts (⚙️ Settings, admins). */
    skipPermissions: SkipPermissionsState;
  }
  interface Topics {
    skipPermissions: true;
  }
}

export const skipPermissions: Slice = {
  init(s) {
    s.skipPermissions = { on: false };
  },
  on: {
    welcome(s, m) {
      s.skipPermissions = m.skipPermissions ?? { on: false };
      return ['skipPermissions'];
    },
    skipPermissions(s, m) {
      s.skipPermissions = m.state;
      return ['skipPermissions'];
    },
  },
};
