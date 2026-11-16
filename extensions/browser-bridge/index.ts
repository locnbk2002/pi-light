import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { isChildRun } from '../../lib/run-mode.ts';
import { registerBrowserTools } from './browser-bridge.ts';

/** pi-light browser extension: browser tool and the local bridge to the Chromium add-on. */
export default function piLightBrowserBridge(pi: ExtensionAPI): void {
  if (isChildRun()) return;
  registerBrowserTools(pi);
}
