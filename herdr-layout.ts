import { execFile } from 'node:child_process';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

/**
 * Readable herdr layout for pi-herdr-subagents panes, applied after upstream opens each pane.
 * PI_HERDR_LAYOUT:
 * - "column" (default): while fewer than PI_HERDR_MAX_SPLIT (default 3) subagents are alive, the first stays
 *   right of the orchestrator and later ones stack under the tallest subagent pane. When one more is needed,
 *   every live subagent pane moves to its own tab and new ones open in tabs.
 * - "tab": every subagent pane moves to its own tab.
 * - "split": leave upstream placement untouched.
 * Only panes reported by this session's subagent tool results are moved; the user's own panes never are.
 */
export type SubagentLayout = 'column' | 'tab' | 'split';
export interface LayoutPane { pane_id: string; rect: { height: number; width: number; x: number; y: number } }
export type LayoutMove = { pane: string; newTab: true } | { pane: string; target: string; direction: 'down' };
export type Herdr = (args: string[]) => Promise<any>;

const SUBAGENT_TOOLS = new Set(['subagent', 'subagent_resume']);

export function resolveLayout(env: NodeJS.ProcessEnv = process.env): SubagentLayout {
  const value = env.PI_HERDR_LAYOUT?.trim().toLowerCase();
  return value === 'tab' || value === 'split' ? value : 'column';
}

export function resolveMaxSplit(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt(env.PI_HERDR_MAX_SPLIT ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3;
}

/**
 * Moves for a pane that upstream just opened right of the orchestrator.
 * `beside` are earlier live subagent panes in the orchestrator's tab; `liveCount` counts earlier live
 * subagent panes in every tab, so a burst keeps using tabs after the switch.
 */
export function planMoves(layout: SubagentLayout, pane: string, beside: LayoutPane[], liveCount: number, maxSplit: number): LayoutMove[] {
  if (layout === 'split') return [];
  if (layout === 'tab') return [{ pane, newTab: true }];
  if (liveCount >= maxSplit) return [...beside.map(p => ({ pane: p.pane_id, newTab: true as const })), { pane, newTab: true }];
  if (beside.length === 0) return [];
  const tallest = [...beside].sort((a, b) => b.rect.height - a.rect.height || a.rect.y - b.rect.y)[0];
  return [{ pane, target: tallest.pane_id, direction: 'down' }];
}

export const execHerdr: Herdr = args => new Promise((resolve, reject) => {
  execFile('herdr', args, { timeout: 10_000 }, (error, stdout) => {
    if (error) return reject(error);
    try { resolve(stdout.trim() ? JSON.parse(stdout).result ?? {} : {}); } catch (parseError) { reject(parseError); }
  });
});

export class HerdrLayout {
  private readonly children = new Set<string>();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly orchestrator: string, private readonly herdr: Herdr = execHerdr,
    private readonly env: NodeJS.ProcessEnv = process.env) {}

  /** Serialized so parallel spawns see each other's final placement. Never rejects: layout is cosmetic. */
  place(pane: string): Promise<void> {
    const run = this.queue.then(() => this.arrange(pane)).catch(() => {});
    this.queue = run;
    return run;
  }

  private async arrange(pane: string): Promise<void> {
    if (this.children.has(pane)) return;
    const layout = resolveLayout(this.env);
    let beside: LayoutPane[] = [];
    if (layout === 'column') {
      const live = new Set<string>(((await this.herdr(['pane', 'list'])).panes ?? []).map((p: { pane_id: string }) => p.pane_id));
      for (const id of [...this.children]) if (!live.has(id)) this.children.delete(id);
      const panes: LayoutPane[] = (await this.herdr(['pane', 'layout', '--pane', this.orchestrator])).layout?.panes ?? [];
      beside = panes.filter(p => this.children.has(p.pane_id));
    }
    const moves = planMoves(layout, pane, beside, this.children.size, resolveMaxSplit(this.env));
    this.children.add(pane);
    for (const move of moves) {
      const args = 'newTab' in move ? ['pane', 'move', move.pane, '--new-tab', '--no-focus']
        : ['pane', 'move', move.pane, '--split', move.direction, '--target-pane', move.target, '--no-focus'];
      // A pane that exited meanwhile cannot move; keep arranging the rest.
      await this.herdr(args).catch(() => {});
    }
  }
}

/** Active only in a herdr orchestrator pane (not inside a subagent pane). */
export function registerHerdrLayout(pi: ExtensionAPI, env: NodeJS.ProcessEnv = process.env, herdr: Herdr = execHerdr): HerdrLayout | undefined {
  if (!env.HERDR_ENV || !env.HERDR_PANE_ID || env.PI_SUBAGENT_ID) return undefined;
  const layout = new HerdrLayout(env.HERDR_PANE_ID, herdr, env);
  pi.on('tool_result', event => {
    const pane = (event.details as { paneId?: unknown } | undefined)?.paneId;
    if (!SUBAGENT_TOOLS.has(event.toolName) || event.isError || typeof pane !== 'string') return;
    void layout.place(pane);
  });
  return layout;
}
