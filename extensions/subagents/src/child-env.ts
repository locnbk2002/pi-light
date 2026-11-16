// Explicit per-run child environment (red-team findings 9 and 10).
//
// Every child launch (herdr or headless, spawn or resume) writes each per-run
// marker explicitly instead of conditionally, so nothing inherited from the
// parent's own environment (a parent that is itself a subagent) leaks into
// the child: PI_SUBAGENT_AUTO_EXIT is always 0|1, PI_DENY_TOOLS is always set
// (possibly empty), and the parent-session hints that would forward the
// child's permission asks to some other session are unset.
import { homedir } from "node:os";
import { join } from "node:path";


/** Single-quote a value for bash. */
export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

export interface PerRunEnv {
  id: string;
  name: string;
  agent?: string;
  sessionFile: string;
  autoExit: boolean;
  denyTools: Iterable<string>;
  /** Parent environment (normally process.env). */
  env: Record<string, string | undefined>;
}

/** Parent-session hints that permission forwarding would otherwise follow. */
export const PARENT_SESSION_HINTS = [
  "PI_SUBAGENT_PARENT_SESSION",
  "PI_AGENT_ROUTER_PARENT_SESSION_ID",
] as const;

/**
 * Kit state/log overrides (pi-light-kit). Herdr panes do not inherit the
 * controller's environment, so each is written explicitly: exported when the
 * parent has it, unset otherwise.
 */
export const KIT_ENV_KEYS = ["PI_KIT_HOME", "PI_KIT_HOOK_LOG_DIR"] as const;

/** The parent's resolved profile directory; never inferred from the child's cwd. */
export function parentAgentDir(env: Record<string, string | undefined>): string {
  return env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

/** Shell lines (unset + export) that pin the child's per-run environment. */
export function perRunExports(run: PerRunEnv): string[] {
  return [
    `unset ${PARENT_SESSION_HINTS.join(" ")}`,
    `export PI_CODING_AGENT_DIR=${shellEscape(parentAgentDir(run.env))}`,
    `export PI_SUBAGENT_ID=${shellEscape(run.id)}`,
    `export PI_SUBAGENT_NAME=${shellEscape(run.name)}`,
    `export PI_SUBAGENT_AGENT=${shellEscape(run.agent ?? "")}`,
    `export PI_SUBAGENT_SESSION=${shellEscape(run.sessionFile)}`,
    `export PI_SUBAGENT_AUTO_EXIT=${run.autoExit ? "1" : "0"}`,
    `export PI_DENY_TOOLS=${shellEscape([...run.denyTools].join(","))}`,
    ...KIT_ENV_KEYS.map((key) => (run.env[key] ? `export ${key}=${shellEscape(run.env[key]!)}` : `unset ${key}`)),
  ];
}

const CONTROL_TOOLS = ["caller_ping", "subagent_done"] as const;

function splitTools(value?: string): string[] {
  return (value ?? "")
    .split(",")
    .map((tool) => tool.trim())
    .filter(Boolean);
}

/** Parent tool ceiling captured when `subagent`/`subagent_resume` executes. */
export interface ToolCeiling {
  /** pi.getActiveTools() of the parent. */
  active: readonly string[];
}

/**
 * Child `--tools` allowlist, always emitted: the parent's active tools
 * intersected with any requested tools, plus the child control tools.
 *
 * Pi filters CLI-excluded tools out of getAllTools() too, so a restriction
 * cannot be detected by comparing the two lists; the active set is the
 * ceiling in every case. Throws when the ceiling is missing or malformed so
 * the caller refuses to launch instead of omitting the flag.
 */
export function resolveChildTools(ceiling: ToolCeiling, requested?: string): string {
  if (!ceiling || !Array.isArray(ceiling.active) || ceiling.active.some((t) => typeof t !== "string")) {
    throw new Error("the parent's active tool set is unavailable");
  }
  const active = new Set(ceiling.active);
  const requestedTools = splitTools(requested);
  const tools = requestedTools.length > 0 ? requestedTools.filter((t) => active.has(t)) : [...active];

  const allow = new Set(tools);
  for (const tool of CONTROL_TOOLS) allow.add(tool);
  return [...allow].join(",");
}
