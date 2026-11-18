import { execFile } from 'node:child_process';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

/**
 * Optional post-placement layout for pi-herdr-subagents panes.
 * The subagent launcher already keeps at most two panes per tab (it opens a new tab when the
 * orchestrator's tab is full), so the default leaves that placement untouched.
 * PI_HERDR_LAYOUT:
 * - "split" (default): leave the launcher's placement untouched.
 * - "tab": every subagent pane moves to its own tab.
 * Only panes reported by this session's subagent tool results are moved; the user's own panes never are.
 */
export type SubagentLayout = 'tab' | 'split';
export type Herdr = (args: string[]) => Promise<any>;

const SUBAGENT_TOOLS = new Set(['subagent', 'subagent_resume']);

export function resolveLayout(env: NodeJS.ProcessEnv = process.env): SubagentLayout {
  return env.PI_HERDR_LAYOUT?.trim().toLowerCase() === 'tab' ? 'tab' : 'split';
}

export const execHerdr: Herdr = args => new Promise((resolve, reject) => {
  execFile('herdr', args, { timeout: 10_000 }, (error, stdout) => {
    if (error) return reject(error);
    try { resolve(stdout.trim() ? JSON.parse(stdout).result ?? {} : {}); } catch (parseError) { reject(parseError); }
  });
});

export class HerdrLayout {
  private readonly moved = new Set<string>();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly herdr: Herdr = execHerdr, private readonly env: NodeJS.ProcessEnv = process.env) {}

  /** Serialized so parallel spawns do not race. Never rejects: layout is cosmetic. */
  place(pane: string): Promise<void> {
    const run = this.queue.then(() => this.arrange(pane)).catch(() => {});
    this.queue = run;
    return run;
  }

  private async arrange(pane: string): Promise<void> {
    if (resolveLayout(this.env) !== 'tab' || this.moved.has(pane)) return;
    this.moved.add(pane);
    await this.herdr(['pane', 'move', pane, '--new-tab', '--no-focus']);
  }
}

/** Active only in a herdr orchestrator pane (not inside a subagent pane). */
export function registerHerdrLayout(pi: ExtensionAPI, env: NodeJS.ProcessEnv = process.env, herdr: Herdr = execHerdr): HerdrLayout | undefined {
  if (!env.HERDR_ENV || !env.HERDR_PANE_ID || env.PI_SUBAGENT_ID) return undefined;
  const layout = new HerdrLayout(herdr, env);
  pi.on('tool_result', event => {
    const pane = (event.details as { paneId?: unknown } | undefined)?.paneId;
    if (!SUBAGENT_TOOLS.has(event.toolName) || event.isError || typeof pane !== 'string') return;
    void layout.place(pane);
  });
  return layout;
}
