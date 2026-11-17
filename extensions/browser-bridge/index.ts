import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { isChildRun, isHerdrSubagentChild, isOneShotInvocation } from '../../lib/run-mode.ts';
import { registerBrowserTools } from './browser-bridge.ts';
import { unattendedOrigins } from './browser-policy.ts';

/**
 * Whether this run gets the browser and which origins skip bound-tab prompts. Child runs get no browser,
 * except a one-shot job (not a subagent) that opted in with an unattended-origin allowlist, such as a
 * scheduled report poster. Only that job uses the allowlist: interactive and RPC sessions always ask.
 */
export function browserRunPolicy(argv = process.argv.slice(2), env = process.env): { register: boolean; unattended: ReadonlySet<string> } {
  const unattended = unattendedOrigins(env);
  const scheduledJob = unattended.size > 0 && isOneShotInvocation(argv) && !isHerdrSubagentChild(env);
  if (isChildRun(argv, env) && !scheduledJob) return { register: false, unattended: new Set() };
  return { register: true, unattended: scheduledJob ? unattended : new Set() };
}

/** pi-light browser extension: browser tool and the local bridge to the Chromium add-on. */
export default function piLightBrowserBridge(pi: ExtensionAPI): void {
  const policy = browserRunPolicy();
  if (policy.register) registerBrowserTools(pi, { unattendedOrigins: policy.unattended });
}
