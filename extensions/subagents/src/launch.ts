// LaunchPlan builder — agent defs + tool params → artifacts + wrapper script + plugin-pane launch.
//
// Pure planning module: no herdr calls, no subprocesses. index.ts executes the
// plan (write plan.files, seed plan.seedSession, client.paneStart(plan.paneStart)).
// The only filesystem side effect here is getDefaultSessionDirFor() creating the
// child session directory (ported behavior from pi-interactive-subagents).
//
// Design (PLAN.md Key Decisions #4–#7):
// - The generated wrapper script is the single place env/wrapping/exit-capture
//   happens. Herdr passes its path to the fixed plugin dispatcher — no shell
//   typing, launch race, or verify/retry machinery.
// - Env correctness for direnv/devenv repos: the script exports the
//   orchestrator's PATH + curated PI_SUBAGENT_* vars (never a full env dump),
//   and wraps the pi invocation in `direnv exec '<cwd>'` when the target cwd
//   (or an ancestor) has an .envrc. Overrides: PI_HERDR_LAUNCH_PREFIX
//   (template, `{cwd}` interpolated, empty string disables), PI_HERDR_PI_BIN,
//   PI_HERDR_DIRENV=0.
// - Exit code via `<sessionFile>.exitcode` sidecar (pane.exited carries no exit
//   code and pane records vanish on exit). On startup crash (exit ≠ 0 within
//   PI_HERDR_HOLD_OPEN_SECS, default 15) the script holds the pane open for
//   post-mortem — the sidecar, not pane.exited, is the completion signal then.
//
// buildPiPromptArgs / shellEscape and artifact
// conventions ported from pi-interactive-subagents (MIT, HazAT)
// pi-extension/subagents/{index.ts,cmux.ts} @ fix/launch-verify-retry.
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { perRunExports, resolveChildTools, shellEscape, type ToolCeiling } from "./child-env.ts";
import {
  type AgentDefaults,
  getAgentConfigDir,
  getDefaultSessionDirFor,
  isSafeAgentName,
  resolveDenyTools,
  resolveEffectiveInteractive,
  resolveLaunchBehavior,
  resolveSubagentPaths,
} from "./agents.ts";

/** `subagent` tool params consulted by launch planning. */
export interface SubagentLaunchParams {
  name: string;
  task: string;
  agent?: string;
  cwd?: string;
  model?: string;
  tools?: string;
  skills?: string;
  systemPrompt?: string;
  fork?: boolean;
  interactive?: boolean;
}

export interface LaunchPlanContext {
  /** Orchestrator session directory (ctx.sessionManager.getSessionDir()). */
  sessionDir: string;
  /** Orchestrator session id (artifact dir key). */
  sessionId: string;
  /** Orchestrator session file (fork/lineage seeding source). */
  parentSessionFile: string;
  /** Orchestrator process cwd (ctx.cwd). */
  parentCwd: string;
  /** Environment snapshot — normally process.env. Injectable test seam. */
  env: Record<string, string | undefined>;
  /** Deterministic seams for tests. */
  now?: Date;
  id?: string;
  /** Override pi binary resolution (default: scan env.PATH for an executable `pi`). */
  resolvePiBin?: (env: Record<string, string | undefined>) => string;
  /** Override the child extension path (default: <package root>/subagent-done.ts). */
  subagentDonePath?: string;
  /** Launch as a background `pi -p` process instead of a herdr pane. */
  headless?: boolean;
  /** Controller pid a headless child watches (default process.pid); it exits when this one is gone. */
  parentPid?: number;
  /** Parent's active-tool ceiling (pi.getActiveTools() at call time). Always applied. */
  toolCeiling: ToolCeiling;
  /**
   * The parent's effective project trust (ctx.isProjectTrusted(), including a
   * CLI --no-approve). An untrusted parent launches children with --no-approve.
   */
  projectTrusted: boolean;
}

export interface LaunchPlan {
  id: string;
  name: string;
  task: string;
  agent?: string;
  /** Effective working directory for the child (param > agent def > orchestrator cwd). */
  effectiveCwd: string;
  /** Deterministic child session file path. */
  sessionFile: string;
  launchScriptFile: string;
  taskArtifactFile: string | null;
  syspromptFile: string | null;
  /** Files the executor must write (mkdir -p dirname first). Includes the launch script. */
  files: Array<{ path: string; content: string }>;
  /** Session seeding the executor must perform before launch (fork/lineage modes). */
  seedSession: {
    mode: "lineage-only" | "fork";
    parentSessionFile: string;
    childSessionFile: string;
    childCwd: string;
  } | null;
  /** Arguments for HerdrClient.paneStart(). */
  paneStart: {
    name: string;
    cwd: string;
    /** Orchestrator's own pane (HERDR_PANE_ID) — the new pane splits off it. */
    targetPaneId?: string;
    direction?: "right" | "down";
    launchScriptFile: string;
  };
  /** The unescaped pi invocation embedded in the wrapper script (piArgv[0] = binary). */
  piArgv: string[];
  interactive: boolean;
  autoExit: boolean;
  /** Startup crash hold-open window in seconds (0 = disabled). */
  holdOpenSecs: number;
}

/** Absolute path to the package root (src/ → package). */
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const DEFAULT_HOLD_OPEN_SECS = 15;

/** Ported from pi-interactive-subagents cmux.ts — the only thing taken from cmux.ts. */
/** Longest accepted display name for a subagent (pane title, wrapper header, env). */
export const MAX_LABEL_LENGTH = 120;

/**
 * Reject display names that could break out of a wrapper-script comment or
 * pane title: any C0 control character (U+0000-U+001F), DEL (U+007F), or a
 * name longer than MAX_LABEL_LENGTH.
 */
export function assertSafeLabel(value: string, field = "name"): void {
  if (value.length > MAX_LABEL_LENGTH) {
    throw new Error(`${field} is longer than ${MAX_LABEL_LENGTH} characters`);
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${field} must not contain control characters (newline, tab, escape, ...)`);
  }
}

/** Header comments are defence in depth: replace anything outside printable ASCII. */
function commentSafe(value: string): string {
  return value.replace(/[^\x20-\x7E]/g, "?");
}

export { shellEscape };

/**
 * Headless children run with no pane (and must never block on a hold-open
 * `read`) and follow their controller's lifetime via PI_SUBAGENT_PARENT_PID.
 */
function backendExports(headless: boolean, parentPid: number): string[] {
  return headless
    ? ["export PI_HERDR_HOLD_OPEN_SECS=0", `export PI_SUBAGENT_PARENT_PID=${shellEscape(String(parentPid))}`]
    : // The pane id is only known inside the pane — forward herdr's injected env.
      ['export PI_SUBAGENT_PANE="${HERDR_PANE_ID:-}"', "unset PI_SUBAGENT_PARENT_PID"];
}

function wrapperEnv(
  env: Record<string, string | undefined>,
  headless: boolean,
): Record<string, string | undefined> {
  return headless ? { ...env, PI_HERDR_HOLD_OPEN_SECS: "0" } : env;
}

/** Headless children cannot ask the user; denials must reach the controller. */
export const BLOCKED_ACTIONS_INSTRUCTION =
  "If any tool call is denied by permission policy, finish with a section 'Blocked actions' listing tool, target and reason.";

/** Extra system-prompt text appended to every child launch (empty → none). */
export function buildRuntimePrompt(opts: { headless: boolean; agent?: string }): string {
  const parts: string[] = [];
  // pi-permission-system matches the attribute form (ACTIVE_AGENT_TAG_REGEX).
  if (opts.agent) parts.push(`<active_agent name="${opts.agent.replace(/["'<>]/g, "")}">`);
  if (opts.headless) parts.push(BLOCKED_ACTIONS_INSTRUCTION);
  return parts.join("\n\n");
}

/** Pi's CLI override that ignores trust-gated project-local files for one run. */
const NO_APPROVE_FLAG = "--no-approve";

/**
 * Limits of one run, persisted next to its session (`<session>.launch.json`)
 * so a resume reapplies them instead of trusting model-supplied arguments.
 */
export interface LaunchRecord {
  version: 1;
  agent: string | null;
  denyTools: string[];
  /** The child's --tools allowlist. */
  tools: string[];
}

export function launchRecordPath(sessionFile: string): string {
  return `${sessionFile}.launch.json`;
}

function launchRecordFile(sessionFile: string, record: LaunchRecord): { path: string; content: string } {
  return { path: launchRecordPath(sessionFile), content: `${JSON.stringify(record)}\n` };
}

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/** Parse and validate a launch record; throws on anything malformed. */
export function parseLaunchRecord(text: string): LaunchRecord {
  const data = JSON.parse(text) as Record<string, unknown> | null;
  if (!data || typeof data !== "object" || data.version !== 1) throw new Error("unsupported launch record");
  const agent = data.agent;
  if (agent !== null && !isSafeAgentName(agent)) throw new Error("launch record has an invalid agent name");
  if (!isStringArray(data.denyTools) || !isStringArray(data.tools)) throw new Error("launch record is malformed");
  return { version: 1, agent, denyTools: data.denyTools, tools: data.tools };
}

/**
 * Build the positional prompt args for a Pi CLI subagent launch.
 *
 * In artifact-backed launches (lineage-only, standalone), Pi's buildInitialMessage()
 * concatenates @file content with messages[0] into one initial prompt. That breaks
 * /skill: expansion because the message no longer starts with "/skill:". Only
 * messages[1..] are sent as separate follow-up prompts where /skill: is recognized.
 *
 * When there are skill prompts AND artifact-backed delivery, we prepend an empty
 * first positional message so that /skill: args land in messages[1..] and arrive
 * as standalone prompts in the child session.
 */
export function buildPiPromptArgs(params: {
  effectiveSkills?: string;
  taskDelivery: "direct" | "artifact";
  taskArg: string;
}): string[] {
  const skillPrompts = (params.effectiveSkills ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((skill) => `/skill:${skill}`);

  const needsSeparator = params.taskDelivery === "artifact" && skillPrompts.length > 0;

  return [...(needsSeparator ? [""] : []), ...skillPrompts, params.taskArg];
}

/** Artifact dir convention shared with pi-interactive-subagents: <sessionDir>/artifacts/<session-id>/ */
export function getArtifactDir(sessionDir: string, sessionId: string): string {
  return join(sessionDir, "artifacts", sessionId);
}

/** Ported safe-name normalization for artifact file names. */
function safeName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "subagent"
  );
}

/** Walk up from cwd looking for .envrc (direnv semantics). Stops at $HOME or filesystem root. */
function hasEnvrc(cwd: string): boolean {
  const home = homedir();
  let dir = cwd;
  for (;;) {
    if (existsSync(join(dir, ".envrc"))) return true;
    if (dir === home) return false;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/** Default pi binary resolution: first executable `pi` on env.PATH. Must be absolute. */
function defaultResolvePiBin(env: Record<string, string | undefined>): string {
  for (const dir of (env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const candidate = join(dir, "pi");
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // keep scanning
    }
  }
  throw new Error(
    "Could not resolve an absolute path to `pi` on PATH. " +
      "Set PI_HERDR_PI_BIN to the pi binary (e.g. ~/.local/bin/pi).",
  );
}

/**
 * Resolve the launch-command wrapper prefix (raw shell text, "" = none).
 *
 * PI_HERDR_LAUNCH_PREFIX (if defined, even empty) replaces autodetection;
 * `{cwd}` is interpolated shell-escaped. Otherwise `direnv exec '<cwd>'` when
 * the effective cwd has an .envrc (disable with PI_HERDR_DIRENV=0).
 */
function resolveLaunchPrefix(env: Record<string, string | undefined>, cwd: string): string {
  const template = env.PI_HERDR_LAUNCH_PREFIX;
  if (template != null) {
    return template.replaceAll("{cwd}", shellEscape(cwd)).trim();
  }
  if (env.PI_HERDR_DIRENV === "0") return "";
  if (hasEnvrc(cwd)) return `direnv exec ${shellEscape(cwd)}`;
  return "";
}

function resolveHoldOpenSecs(env: Record<string, string | undefined>): number {
  const raw = env.PI_HERDR_HOLD_OPEN_SECS?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_HOLD_OPEN_SECS;
}

/**
 * Assemble the wrapper-script body shared by spawn and resume launches:
 * curated exports → cd → (prefix-wrapped) pi invocation → exitcode sidecar →
 * startup-crash hold-open → exit passthrough.
 */
function buildWrapperScript(opts: {
  env: Record<string, string | undefined>;
  headerLines: string[];
  exports: string[];
  cwd: string;
  piArgv: string[];
  sessionFile: string;
}): { content: string; holdOpenSecs: number } {
  const launchPrefix = resolveLaunchPrefix(opts.env, opts.cwd);
  const holdOpenSecs = resolveHoldOpenSecs(opts.env);
  const piCommand =
    (launchPrefix ? `${launchPrefix} ` : "") + opts.piArgv.map((arg) => shellEscape(arg)).join(" ");

  const scriptLines = [
    "#!/usr/bin/env bash",
    "# Ignore SIGTSTP — argv-launched panes have no parent interactive shell",
    "# to resume from, so Ctrl+Z would leave the pane permanently stuck.",
    "trap '' TSTP",
    ...opts.headerLines.map(commentSafe),
    ...opts.exports,
    `cd ${shellEscape(opts.cwd)}`,
    piCommand,
    'code=$?',
    // Stamp the run id so the watcher can decide ownership of this sidecar
    // outright. Resume reuses the session path, so a previous run's wrapper
    // can land its sidecar after ours was cleared; without the id the watcher
    // has to infer ownership from whether the pane is still alive, which is a
    // race whenever pane teardown is slower than the sidecar write.
    `echo "$code $PI_SUBAGENT_ID" > ${shellEscape(`${opts.sessionFile}.exitcode`)}`,
    ...(holdOpenSecs > 0
      ? [
          `if [ "$code" -ne 0 ] && [ "$SECONDS" -lt ${holdOpenSecs} ]; then`,
          `  echo "subagent crashed (exit $code) — press Enter to close"`,
          "  read -r",
          "fi",
        ]
      : []),
    'exit "$code"',
    "",
  ];
  return { content: scriptLines.join("\n"), holdOpenSecs };
}

export function buildLaunchPlan(
  params: SubagentLaunchParams,
  agentDefs: AgentDefaults | null,
  ctx: LaunchPlanContext,
): LaunchPlan {
  if (agentDefs?.cli && agentDefs.cli !== "pi") {
    throw new Error(
      `Agent "${params.agent ?? params.name}" uses cli: ${agentDefs.cli}, which is ` +
        "not supported by pi-herdr-subagents (pi children only).",
    );
  }

  assertSafeLabel(params.name);
  const env = ctx.env;
  const now = ctx.now ?? new Date();
  const id = ctx.id ?? Math.random().toString(16).slice(2, 10);

  const effectiveModel = params.model ?? agentDefs?.model;
  const effectiveTools = params.tools ?? agentDefs?.tools;
  const effectiveSkills = params.skills ?? agentDefs?.skills;
  const effectiveThinking = agentDefs?.thinking;
  const headless = ctx.headless === true;
  const interactive = resolveEffectiveInteractive(params, agentDefs, { headless });
  // A bare headless spawn is one-shot: non-interactive and auto-exit.
  const autoExit = agentDefs?.autoExit ?? (headless && !agentDefs && !interactive);

  const artifactDir = getArtifactDir(ctx.sessionDir, ctx.sessionId);
  const { effectiveCwd, effectiveAgentDir } = resolveSubagentPaths(
    params,
    agentDefs,
  );
  const targetCwd = effectiveCwd ?? ctx.parentCwd;
  const childSessionDir = getDefaultSessionDirFor(targetCwd, effectiveAgentDir);

  // Deterministic child session file path — each launch knows exactly which
  // file is its child's, eliminating races between concurrent spawns.
  const sessionTimestamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 23) + "Z";
  const uuid = [
    id,
    Math.random().toString(16).slice(2, 10),
    Math.random().toString(16).slice(2, 10),
    Math.random().toString(16).slice(2, 6),
  ].join("-");
  const sessionFile = join(childSessionDir, `${sessionTimestamp}_${uuid}.jsonl`);

  const launchBehavior = resolveLaunchBehavior(params, agentDefs);
  const seedSession = launchBehavior.seededSessionMode
    ? {
        mode: launchBehavior.seededSessionMode,
        parentSessionFile: ctx.parentSessionFile,
        childSessionFile: sessionFile,
        childCwd: targetCwd,
      }
    : null;

  // ── Task message (wrapper instructions only for blank-session modes) ──
  // The handoff is the `summary` argument of subagent_done, not the last
  // assistant message: the sidecar is written before the model's trailing
  // prose lands, and thinking blocks are not text (see subagent-done.ts).
  const modeHint = autoExit
    ? "Complete your task autonomously. When finished, call the subagent_done tool."
    : "Complete your task. When finished, call the subagent_done tool. The user can interact with you at any time.";
  const summaryInstruction =
    "Hand off your results by passing your complete final report as the `summary` argument of subagent_done. " +
    "The caller receives ONLY that argument \u2014 not your messages, thinking, or files you wrote \u2014 " +
    "so include the verdict, what you did, key findings, and paths to any artifacts. " +
    "Do not put the report in a separate message before or after the call." +
    (autoExit ? "" : " If the user closes the session instead, your last assistant message is used.");
  const identity = agentDefs?.body ?? params.systemPrompt ?? null;
  const systemPromptMode = agentDefs?.systemPromptMode;
  const identityInSystemPrompt = Boolean(systemPromptMode && identity);
  const roleBlock = identity && !identityInSystemPrompt ? `\n\n${identity}` : "";
  const fullTask = launchBehavior.inheritsConversationContext
    ? params.task
    : `${roleBlock}\n\n${modeHint}\n\n${params.task}\n\n${summaryInstruction}`;

  const files: Array<{ path: string; content: string }> = [];
  const artifactTimestamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const name = safeName(params.name);

  // ── pi argv ──
  const piBin = env.PI_HERDR_PI_BIN ?? (ctx.resolvePiBin ?? defaultResolvePiBin)(env);
  const piArgv: string[] = [piBin, ...(ctx.headless ? ["-p"] : []), "--session", sessionFile];

  const subagentDonePath = ctx.subagentDonePath ?? join(PACKAGE_ROOT, "subagent-done.ts");
  piArgv.push("-e", subagentDonePath);

  if (effectiveModel) {
    piArgv.push("--model", effectiveThinking ? `${effectiveModel}:${effectiveThinking}` : effectiveModel);
  }

  // System prompt via file — pi's --system-prompt/--append-system-prompt
  // auto-detect file paths, avoiding shell escaping issues with multiline content.
  let syspromptFile: string | null = null;
  if (identityInSystemPrompt && identity) {
    syspromptFile = join(artifactDir, "context", `${name}-sysprompt-${artifactTimestamp}-${id}.md`);
    files.push({ path: syspromptFile, content: identity });
    piArgv.push(
      systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt",
      syspromptFile,
    );
  }

  const runtimePrompt = buildRuntimePrompt({ headless: ctx.headless === true, agent: params.agent });
  if (runtimePrompt) {
    const runtimePromptFile = join(artifactDir, "context", `${name}-runtime-${artifactTimestamp}-${id}.md`);
    files.push({ path: runtimePromptFile, content: runtimePrompt });
    piArgv.push("--append-system-prompt", runtimePromptFile);
  }

  const toolAllowlist = resolveChildTools(ctx.toolCeiling, effectiveTools);
  piArgv.push("--tools", toolAllowlist);
  if (!ctx.projectTrusted) piArgv.push(NO_APPROVE_FLAG);

  // Task delivery: fork inherits the conversation → direct arg; blank-session
  // modes get the artifact-backed handoff so wrapper instructions arrive as
  // the initial user message.
  let taskArtifactFile: string | null = null;
  let taskArg: string;
  if (launchBehavior.taskDelivery === "direct") {
    taskArg = fullTask;
  } else {
    taskArtifactFile = join(artifactDir, "context", `${name}-${artifactTimestamp}-${id}.md`);
    files.push({ path: taskArtifactFile, content: fullTask });
    taskArg = `@${taskArtifactFile}`;
  }

  piArgv.push(
    ...buildPiPromptArgs({ effectiveSkills, taskDelivery: launchBehavior.taskDelivery, taskArg }),
  );

  const denyTools = [...resolveDenyTools(agentDefs)];
  files.push(
    launchRecordFile(sessionFile, {
      version: 1,
      agent: params.agent ?? null,
      denyTools,
      tools: toolAllowlist.split(","),
    }),
  );

  // ── Curated env exports (never a full env dump) ──
  const exports: string[] = [];
  if (env.PATH) exports.push(`export PATH=${shellEscape(env.PATH)}`);
  // Never switch profile by cwd: the child always gets the parent's profile.
  exports.push(
    ...perRunExports({
      id,
      name: params.name,
      agent: params.agent,
      sessionFile,
      autoExit,
      denyTools,
      env,
    }),
  );
  exports.push(...backendExports(ctx.headless === true, ctx.parentPid ?? process.pid));

  // ── Wrapper script ──
  const { content: scriptContent, holdOpenSecs } = buildWrapperScript({
    env: wrapperEnv(env, ctx.headless === true),
    headerLines: [
      `# Subagent launch script for ${params.name}`,
      `# Generated: ${now.toISOString()}`,
      `# Session: ${sessionFile}`,
    ],
    exports,
    cwd: targetCwd,
    piArgv,
    sessionFile,
  });

  const launchScriptFile = join(artifactDir, "subagent-scripts", `${name}-${id}.sh`);
  files.push({ path: launchScriptFile, content: scriptContent });

  return {
    id,
    name: params.name,
    task: params.task,
    agent: params.agent,
    effectiveCwd: targetCwd,
    sessionFile,
    launchScriptFile,
    taskArtifactFile,
    syspromptFile,
    files,
    seedSession,
    paneStart: {
      name: params.name,
      cwd: targetCwd,
      targetPaneId: env.HERDR_PANE_ID,
      direction: "right",
      launchScriptFile,
    },
    piArgv,
    interactive,
    autoExit,
    holdOpenSecs,
  };
}

// ── resume launches ─────────────────────────────────────────────────────────

export interface ResumeLaunchParams {
  sessionPath: string;
  name?: string;
  message?: string;
  autoExit?: boolean;
}

/**
 * Ported from pi-interactive-subagents: resumed sessions default to
 * autonomous follow-up work (auto-exit, non-interactive); explicit
 * autoExit: false yields an interactive resumed session.
 */
export function resolveResumeLaunchBehavior(params: { autoExit?: boolean }): {
  autoExit: boolean;
  interactive: boolean;
} {
  const autoExit = params.autoExit ?? true;
  return { autoExit, interactive: !autoExit };
}

export interface ResumeLaunchPlan {
  id: string;
  name: string;
  /** The existing child session file being resumed. */
  sessionFile: string;
  launchScriptFile: string;
  resumeMessageFile: string | null;
  /** Files the executor must write (mkdir -p dirname first). Includes the launch script. */
  files: Array<{ path: string; content: string }>;
  paneStart: {
    name: string;
    cwd: string;
    targetPaneId?: string;
    direction?: "right" | "down";
    launchScriptFile: string;
  };
  piArgv: string[];
  interactive: boolean;
  autoExit: boolean;
  holdOpenSecs: number;
}

/**
 * Plan a resume launch: pi --session <existing path> -e subagent-done.ts,
 * plus an optional @<artifact> follow-up message. Same wrapper-script
 * machinery (curated env, direnv wrap, exitcode sidecar, hold-open) as
 * buildLaunchPlan; the pane runs in the orchestrator's cwd.
 *
 * NOTE: the executor must rmSync <sessionPath>.exit and <sessionPath>.exitcode
 * (force: true) before launching — stale sidecars from the previous run would
 * otherwise complete the new watcher instantly.
 */
export function buildResumeLaunchPlan(
  params: ResumeLaunchParams,
  record: LaunchRecord,
  ctx: LaunchPlanContext,
): ResumeLaunchPlan {
  const env = ctx.env;
  const now = ctx.now ?? new Date();
  const id = ctx.id ?? Math.random().toString(16).slice(2, 10);
  const displayName = params.name ?? "Resume";
  assertSafeLabel(displayName);
  const { autoExit, interactive } = resolveResumeLaunchBehavior(params);

  const artifactDir = getArtifactDir(ctx.sessionDir, ctx.sessionId);
  const artifactTimestamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const name = safeName(displayName);
  const files: Array<{ path: string; content: string }> = [];

  // ── pi argv ──
  const piBin = env.PI_HERDR_PI_BIN ?? (ctx.resolvePiBin ?? defaultResolvePiBin)(env);
  const subagentDonePath = ctx.subagentDonePath ?? join(PACKAGE_ROOT, "subagent-done.ts");
  const piArgv: string[] = [
    piBin,
    ...(ctx.headless ? ["-p"] : []),
    "--session",
    params.sessionPath,
    "-e",
    subagentDonePath,
  ];

  // The original run's identity and limits, never resume arguments (red-team kongming 5).
  const agent = record.agent ?? undefined;
  const runtimePrompt = buildRuntimePrompt({ headless: ctx.headless === true, agent });
  if (runtimePrompt) {
    const runtimePromptFile = join(artifactDir, "context", `${name}-resume-runtime-${artifactTimestamp}-${id}.md`);
    files.push({ path: runtimePromptFile, content: runtimePrompt });
    piArgv.push("--append-system-prompt", runtimePromptFile);
  }
  // The original allowlist, further capped by the resuming parent's active tools.
  const toolAllowlist = resolveChildTools(ctx.toolCeiling, record.tools.join(","));
  piArgv.push("--tools", toolAllowlist);
  if (!ctx.projectTrusted) piArgv.push(NO_APPROVE_FLAG);
  files.push(launchRecordFile(params.sessionPath, { ...record, tools: toolAllowlist.split(",") }));

  let resumeMessageFile: string | null = null;
  if (params.message) {
    resumeMessageFile = join(artifactDir, "subagent-resume", `${name}-${artifactTimestamp}-${id}.md`);
    files.push({ path: resumeMessageFile, content: params.message });
    piArgv.push(`@${resumeMessageFile}`);
  }

  // ── Curated env exports (never a full env dump) ──
  const exports: string[] = [];
  if (env.PATH) exports.push(`export PATH=${shellEscape(env.PATH)}`);
  exports.push(
    ...perRunExports({
      id,
      name: displayName,
      agent,
      sessionFile: params.sessionPath,
      autoExit,
      denyTools: record.denyTools,
      env,
    }),
  );
  exports.push(...backendExports(ctx.headless === true, ctx.parentPid ?? process.pid));

  const { content: scriptContent, holdOpenSecs } = buildWrapperScript({
    env: wrapperEnv(env, ctx.headless === true),
    headerLines: [
      `# Subagent resume script for ${displayName}`,
      `# Generated: ${now.toISOString()}`,
      `# Session: ${params.sessionPath}`,
      ...(resumeMessageFile ? [`# Resume message file: ${resumeMessageFile}`] : []),
    ],
    exports,
    cwd: ctx.parentCwd,
    piArgv,
    sessionFile: params.sessionPath,
  });

  const launchScriptFile = join(artifactDir, "subagent-scripts", `${name}-resume-${id}.sh`);
  files.push({ path: launchScriptFile, content: scriptContent });

  return {
    id,
    name: displayName,
    sessionFile: params.sessionPath,
    launchScriptFile,
    resumeMessageFile,
    files,
    paneStart: {
      name: displayName,
      cwd: ctx.parentCwd,
      targetPaneId: env.HERDR_PANE_ID,
      direction: "right",
      launchScriptFile,
    },
    piArgv,
    interactive,
    autoExit,
    holdOpenSecs,
  };
}
