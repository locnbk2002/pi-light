// Agent-definition parsing, discovery, and launch-behavior resolution.
//
// Ported near-verbatim from pi-interactive-subagents (MIT, HazAT)
// pi-extension/subagents/index.ts @ fix/launch-verify-retry — this module is the
// frontmatter compatibility contract (PROJECT-BRIEF.md hard requirement 2): both
// extensions read the same ~/.pi/agent/agents/*.md files during the transition
// period, so field semantics must match exactly. Read-only consumption; the regex
// line parser is intentionally kept (compat trumps elegance — no YAML lib).
//
// Adaptations vs the reference:
// - No bundled `package` source in runtime discovery; package templates must be copied into
//   user-owned config explicitly with /subagents-init.
// - Params typed as a plain interface instead of the extension's typebox schema.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export type SubagentSessionMode = "standalone" | "lineage-only" | "fork";

/** The subset of `subagent` tool params that agent-def resolution consults. */
export interface SubagentSpawnParams {
  name: string;
  task: string;
  agent?: string;
  cwd?: string;
  fork?: boolean;
  interactive?: boolean;
}

export interface AgentDefaults {
  /**
   * Frontmatter `model:`. Use the provider/id form, e.g. `anthropic/claude-opus-5-5`. A bare id
   * combined with the agent's thinking level is fuzzy-matched by pi and can resolve to an
   * unconfigured provider.
   */
  model?: string;
  tools?: string;
  skills?: string;
  thinking?: string;
  denyTools?: string;
  spawning?: boolean;
  autoExit?: boolean;
  interactive?: boolean;
  systemPromptMode?: "append" | "replace";
  sessionMode?: SubagentSessionMode;
  cwd?: string;
  cli?: string;
  body?: string;
  disableModelInvocation?: boolean;
}

export type AgentSource = "package" | "global" | "project";

/**
 * Discovery options (pi-light). Sources, later winning: package dirs
 * (pi-light's own agents/ plus `extraDirs` from the agent-dirs event bus),
 * then the global profile, then the project's .pi/agents — the last only
 * when the project is trusted.
 */
export interface AgentLookup {
  projectTrusted?: boolean;
  extraDirs?: string[];
}

/** pi-light's own agents/ (src → subagents → extensions → package root). */
export const PI_LIGHT_AGENTS_DIR = join(
  dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url))))),
  "agents",
);

/** Search directories in increasing priority. */
export function agentSearchDirs(opts: AgentLookup = {}): Array<{ path: string; source: AgentSource }> {
  const dirs: Array<{ path: string; source: AgentSource }> = [];
  const seen = new Set<string>();
  const add = (path: string, source: AgentSource) => {
    let key = path;
    try {
      key = realpathSync(path);
    } catch {}
    if (seen.has(key)) return;
    seen.add(key);
    dirs.push({ path, source });
  };
  add(PI_LIGHT_AGENTS_DIR, "package");
  for (const dir of opts.extraDirs ?? []) add(dir, "package");
  add(join(getAgentConfigDir(), "agents"), "global");
  if (opts.projectTrusted === true) add(join(process.cwd(), ".pi", "agents"), "project");
  return dirs;
}

export interface AgentDefinition extends AgentDefaults {
  name: string;
  description?: string;
  disableModelInvocation: boolean;
}

export interface ListedAgentDefinition extends AgentDefinition {
  source: AgentSource;
}

/** Tools that are gated by `spawning: false` */
export const SPAWNING_TOOLS = new Set([
  "subagent",
  "subagent_interrupt",
  "subagents_list",
  "subagent_resume",
]);

/**
 * Resolve the effective set of denied tool names from agent defaults.
 * `spawning: false` expands to all SPAWNING_TOOLS.
 * `deny-tools` adds individual tool names on top.
 */
export function resolveDenyTools(agentDefs: AgentDefaults | null): Set<string> {
  const denied = new Set<string>();
  if (!agentDefs) return denied;

  // spawning: false → deny all spawning tools
  if (agentDefs.spawning === false) {
    for (const t of SPAWNING_TOOLS) denied.add(t);
  }

  // deny-tools: explicit list
  if (agentDefs.denyTools) {
    for (const t of agentDefs.denyTools
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)) {
      denied.add(t);
    }
  }

  return denied;
}

/** Resolve the global agent config directory, respecting PI_CODING_AGENT_DIR. */
export function getAgentConfigDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function getFrontmatterValue(frontmatter: string, key: string): string | undefined {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return match ? match[1].trim() : undefined;
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  return value != null ? value === "true" : undefined;
}

function parseSessionMode(value: string | undefined): SubagentSessionMode | undefined {
  if (value === "standalone" || value === "lineage-only" || value === "fork") {
    return value;
  }
  return undefined;
}

export function parseAgentDefinition(
  content: string,
  fallbackName: string,
): AgentDefinition | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const frontmatter = match[1];
  const body = content.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();
  const systemPromptMode = getFrontmatterValue(frontmatter, "system-prompt");

  return {
    name: getFrontmatterValue(frontmatter, "name") ?? fallbackName,
    description: getFrontmatterValue(frontmatter, "description"),
    model: getFrontmatterValue(frontmatter, "model"),
    tools: getFrontmatterValue(frontmatter, "tools"),
    systemPromptMode:
      systemPromptMode === "replace"
        ? "replace"
        : systemPromptMode === "append"
          ? "append"
          : undefined,
    skills: getFrontmatterValue(frontmatter, "skill") ?? getFrontmatterValue(frontmatter, "skills"),
    thinking: getFrontmatterValue(frontmatter, "thinking"),
    denyTools: getFrontmatterValue(frontmatter, "deny-tools"),
    spawning: parseOptionalBoolean(getFrontmatterValue(frontmatter, "spawning")),
    autoExit: parseOptionalBoolean(getFrontmatterValue(frontmatter, "auto-exit")),
    interactive: parseOptionalBoolean(getFrontmatterValue(frontmatter, "interactive")),
    sessionMode: parseSessionMode(getFrontmatterValue(frontmatter, "session-mode")),
    cwd: getFrontmatterValue(frontmatter, "cwd"),
    cli: getFrontmatterValue(frontmatter, "cli"),
    body: body || undefined,
    disableModelInvocation:
      getFrontmatterValue(frontmatter, "disable-model-invocation")?.toLowerCase() === "true",
  };
}

export function discoverAgentDefinitions(opts: AgentLookup = {}): ListedAgentDefinition[] {
  const agents = new Map<string, ListedAgentDefinition>();
  const dirs = agentSearchDirs(opts);

  for (const { path: dir, source } of dirs) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((entry) => entry.endsWith(".md"))) {
      const parsed = parseAgentDefinition(
        readFileSync(join(dir, file), "utf8"),
        file.replace(/\.md$/, ""),
      );
      if (!parsed) continue;
      agents.set(parsed.name, { ...parsed, source });
    }
  }

  return [...agents.values()];
}

export function resolveSubagentPaths(
  params: SubagentSpawnParams,
  agentDefs: AgentDefaults | null,
): { effectiveCwd: string | null; effectiveAgentDir: string } {
  const rawCwd = params.cwd ?? agentDefs?.cwd ?? null;
  const cwdIsFromAgent = !params.cwd && agentDefs?.cwd != null;
  const cwdBase = cwdIsFromAgent ? getAgentConfigDir() : process.cwd();
  const effectiveCwd = rawCwd
    ? rawCwd.startsWith("/")
      ? rawCwd
      : join(cwdBase, rawCwd)
    : null;
  // The child always uses the parent's profile; a cwd-local .pi/agent is
  // never inferred (an untrusted repo could otherwise swap the profile).
  return { effectiveCwd, effectiveAgentDir: getAgentConfigDir() };
}

export function getDefaultSessionDirFor(cwd: string, agentDir: string): string {
  const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  const sessionDir = join(agentDir, "sessions", safePath);
  if (!existsSync(sessionDir)) {
    mkdirSync(sessionDir, { recursive: true });
  }
  return sessionDir;
}

export function resolveEffectiveSessionMode(
  params: SubagentSpawnParams,
  agentDefs: AgentDefaults | null,
): SubagentSessionMode {
  if (params.fork) return "fork";
  return agentDefs?.sessionMode ?? "standalone";
}

export function resolveLaunchBehavior(
  params: SubagentSpawnParams,
  agentDefs: AgentDefaults | null,
): {
  sessionMode: SubagentSessionMode;
  seededSessionMode: "lineage-only" | "fork" | null;
  inheritsConversationContext: boolean;
  taskDelivery: "direct" | "artifact";
} {
  const sessionMode = resolveEffectiveSessionMode(params, agentDefs);
  const inheritsConversationContext = sessionMode === "fork";
  return {
    sessionMode,
    seededSessionMode: sessionMode === "standalone" ? null : sessionMode,
    inheritsConversationContext,
    taskDelivery: inheritsConversationContext ? "direct" : "artifact",
  };
}

/**
 * Decide whether a subagent is interactive (user-driven, long-running).
 *
 * Resolution order:
 *   1. Explicit `interactive` tool parameter wins.
 *   2. Explicit `interactive` frontmatter field on the agent.
 *   3. Default: the inverse of `auto-exit`. Agents that auto-exit are
 *      autonomous (scout, worker, reviewer) and the parent session should be
 *      woken on stall/recovery transitions. Agents that don't auto-exit are
 *      driven by the user in their own pane (planner, iterate/fork) and
 *      stall pings are noise.
 *
 * When no agent defs exist at all (bare `subagent({ name, task })` call,
 * typical for `/iterate` with `fork: true`), `autoExit` is undefined and the
 * subagent is treated as interactive — matching the intent of iterate.
 */
export function resolveEffectiveInteractive(
  params: SubagentSpawnParams,
  agentDefs: AgentDefaults | null,
): boolean {
  if (params.interactive != null) return params.interactive;
  if (agentDefs?.interactive != null) return agentDefs.interactive;
  return !(agentDefs?.autoExit ?? false);
}

export function loadAgentDefaults(agentName: string, opts: AgentLookup = {}): AgentDefaults | null {
  // Agents resolve by file stem; highest-priority source first.
  const paths = agentSearchDirs(opts)
    .reverse()
    .map(({ path }) => join(path, `${agentName}.md`));

  for (const p of paths) {
    if (!existsSync(p)) continue;
    const parsed = parseAgentDefinition(readFileSync(p, "utf8"), agentName);
    if (parsed) return parsed;
  }

  return null;
}
