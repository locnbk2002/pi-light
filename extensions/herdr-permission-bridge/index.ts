import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { isOneShotInvocation } from '../../lib/run-mode.ts';
import { registerPermissionBridge } from './permission-bridge.ts';

/**
 * pi-light herdr permission bridge: marks the herdr pane `blocked` while a permission prompt waits.
 * Also runs in herdr subagent panes, which show their own prompts; one-shot runs have no prompt UI.
 */
export default function piLightHerdrPermissionBridge(pi: ExtensionAPI): void {
  if (process.env.HERDR_ENV !== '1' || isOneShotInvocation()) return;
  registerPermissionBridge(pi);
}
