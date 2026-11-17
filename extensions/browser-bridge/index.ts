import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { isChildRun, isHerdrSubagentChild, isOneShotInvocation } from '../../lib/run-mode.ts';
import { registerBrowserTools } from './browser-bridge.ts';
import { unattendedOrigins } from './browser-policy.ts';

/** pi-light browser extension: browser tool and the local bridge to the Chromium add-on. */
export default function piLightBrowserBridge(pi: ExtensionAPI): void {
  const unattended = unattendedOrigins();
  // Child runs get no browser, except a one-shot job (not a herdr subagent) that opted in with an
  // unattended-origin allowlist, such as a scheduled report poster.
  const scheduledJob = unattended.size > 0 && isOneShotInvocation() && !isHerdrSubagentChild();
  if (isChildRun() && !scheduledJob) return;
  registerBrowserTools(pi, { unattendedOrigins: unattended });
}
