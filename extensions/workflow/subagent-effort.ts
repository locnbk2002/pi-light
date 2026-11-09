// Subagent effort: decide how a pi-herdr-subagents `subagent` call gets its reasoning level.
// pi-light cannot change the upstream tool, so the level travels as a `--model <base>:<level>` suffix,
// which upstream builds as `${model}:${agentDef.thinking}` when the agent definition sets thinking.
// Precedence: explicit `:level` in model > agent-definition `thinking:` > judge > configured fallback.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { VIRTUAL_CONTROLLER } from './model-fallback.ts';

/** Pi's thinking levels, as accepted in a `--model <pattern>:<level>` suffix. */
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const isLevel = (value: string | undefined) => !!value && (THINKING_LEVELS as readonly string[]).includes(value);
export const CONTROLLER_MODEL = `${VIRTUAL_CONTROLLER.provider}/${VIRTUAL_CONTROLLER.id}`;

export interface AgentDefaults { model?: string; thinking?: string }

function frontmatterValue(frontmatter: string, key: string): string | undefined {
  return frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1].trim();
}

/**
 * The `model:` and `thinking:` that upstream `loadAgentDefaults` would read, with the same lookup order
 * and parsing (pi-herdr-subagents src/agents.ts @ 2489019): project `.pi/agents` first, then the agent dir.
 */
export function readAgentDefaults(name: string, cwd = process.cwd(),
  agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent')): AgentDefaults | undefined {
  for (const path of [join(cwd, '.pi', 'agents', `${name}.md`), join(agentDir, 'agents', `${name}.md`)]) {
    if (!existsSync(path)) continue;
    const frontmatter = /^---\n([\s\S]*?)\n---/.exec(readFileSync(path, 'utf8'))?.[1];
    if (frontmatter === undefined) continue;
    return { model: frontmatterValue(frontmatter, 'model'), thinking: frontmatterValue(frontmatter, 'thinking') };
  }
  return undefined;
}

/** True when a model pattern already ends in a thinking suffix (`provider/id:high`). */
export function hasThinkingSuffix(model: string | undefined): boolean {
  return isLevel(model?.slice(model.lastIndexOf(':') + 1)) && model!.includes(':');
}

export type SubagentEffortPlan =
  | { action: 'keep'; source: 'explicit' | 'agent-def' }
  | { action: 'set-model'; model: string; source: 'agent-def' }
  | { action: 'judge'; base: string };

/** Decide what to do with one subagent call, before any judge runs. */
export function planSubagentEffort(input: { model?: unknown; agent?: unknown }, defs?: AgentDefaults): SubagentEffortPlan {
  const model = typeof input.model === 'string' && input.model.trim() ? input.model.trim() : undefined;
  // An explicit level wins. If the agent definition also sets thinking, upstream launches
  // `<model>:<explicit>:<agentdef>` and the child fix-up (innerExplicitLevel) restores the explicit one.
  if (hasThinkingSuffix(model)) return { action: 'keep', source: 'explicit' };
  if (defs?.thinking) {
    // Upstream appends thinking only to a model; give a thinking-only definition an unsuffixed base.
    return model || defs.model ? { action: 'keep', source: 'agent-def' } : { action: 'set-model', model: CONTROLLER_MODEL, source: 'agent-def' };
  }
  const base = model ?? defs?.model;
  if (hasThinkingSuffix(base)) return { action: 'keep', source: 'agent-def' };
  return { action: 'judge', base: base ?? CONTROLLER_MODEL };
}

/**
 * Child-side fix-up: with `--model <base>:<L1>:<L2>` (explicit L1 plus an appended agent-definition L2),
 * Pi resolves the outer L2. Returns L1 so the child can restore the explicit level.
 */
export function innerExplicitLevel(argv: readonly string[]): string | undefined {
  const end = argv.indexOf('--');
  const options = end < 0 ? argv : argv.slice(0, end);
  const at = options.findIndex(arg => arg === '--model' || arg.startsWith('--model='));
  if (at < 0) return undefined;
  const value = options[at].startsWith('--model=') ? options[at].slice('--model='.length) : options[at + 1] ?? '';
  const parts = value.split(':');
  if (parts.length < 3) return undefined;
  const [inner, outer] = parts.slice(-2);
  return isLevel(inner) && isLevel(outer) ? inner : undefined;
}
