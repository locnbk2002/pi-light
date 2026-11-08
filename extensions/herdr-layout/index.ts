import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { isChildRun } from '../../lib/run-mode.ts';
import { registerHerdrLayout } from './herdr-layout.ts';

/** pi-light herdr layout extension: places subagent panes in the orchestrator's herdr tab. */
export default function piLightHerdrLayout(pi: ExtensionAPI): void {
  if (isChildRun()) return;
  registerHerdrLayout(pi);
}
