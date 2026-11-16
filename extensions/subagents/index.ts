/**
 * pi-herdr-subagents — interactive subagent orchestration built natively on herdr.
 *
 * Extension entry: activation guard, tool registration, outcome→steer wiring,
 * slim widget, /subagent + /iterate commands.
 *
 * Merged into pi-light from pi-herdr-subagents@2489019 (MIT); pi-light is the
 * only `subagent` provider.
 *
 * Tool skeletons, descriptions/promptSnippets, self-spawn block, and command
 * handlers ported from pi-interactive-subagents (MIT, HazAT)
 * pi-extension/subagents/index.ts @ fix/launch-verify-retry, adapted for herdr
 * (argv launch via src/launch.ts + herdr client, no mux/screen-scrape code).
 */
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { constants as fsConstants, copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  agentSearchDirs,
  discoverAgentDefinitions,
  getAgentConfigDir,
  loadAgentDefaults,
  type AgentLookup,
} from "./src/agents.ts";
import {
  createHerdrClient,
  HERDR_PLUGIN_ID,
  MIN_HERDR_VERSION,
  type HerdrClient,
} from "./src/herdr/client.ts";
import { createHerdrEventStream } from "./src/herdr/events.ts";
import {
  headlessWatcherDeps,
  interruptTree,
  killTree,
  startHeadless,
  type HeadlessChild,
} from "./src/headless.ts";
import {
  DEAD_AFTER_MS,
  MAX_RUN_MS,
  POLL_MS,
  STALL_WARN_MS,
  TIMEOUT_GRACE_MS,
} from "./src/limits.ts";
import { queryAgentDirs } from "../../lib/agent-dirs-events.ts";
import { isOneShotInvocation } from "../../lib/run-mode.ts";
import { consumeContextUsageSidecar, contextUsagePath } from "./src/context-usage.ts";
import {
  assertSafeLabel,
  buildLaunchPlan,
  buildResumeLaunchPlan,
  resolveResumeLaunchBehavior,
} from "./src/launch.ts";
import {
  type SubagentSteerMessage,
  buildOutcomeMessage,
  renderSubagentPing,
  renderSubagentResult,
} from "./src/messages.ts";
import { markSubagentActive, markSubagentInactive } from "./src/runtime-state.ts";
import {
  findLastAssistantMessage,
  getNewEntries,
  getSessionId,
  seedSubagentSessionFile,
} from "./src/session.ts";
import {
  watchSubagent,
  type RunningSubagent,
  type SubagentOutcome,
  type WatcherDeps,
} from "./src/watcher.ts";

/** Absolute path of this module (locates the bundled herdr-plugin and agent templates). */
const MODULE_PATH = fileURLToPath(import.meta.url);
const HERDR_PLUGIN_DIR = join(dirname(MODULE_PATH), "herdr-plugin");

// ── /reload safety ──────────────────────────────────────────────────────────
// /reload re-imports this file, giving fresh module-level state, but closures
// from the old module keep running. Abort the previous module's controllers and
// close its event stream on re-import (pattern from the reference, issue #5).

const ABORT_KEY = Symbol.for("pi-herdr-subagents/abort-controller");
const STREAM_KEY = Symbol.for("pi-herdr-subagents/event-stream");
const WIDGET_INTERVAL_KEY = Symbol.for("pi-herdr-subagents/widget-interval");

{
  const prevAbort = (globalThis as any)[ABORT_KEY] as AbortController | undefined;
  if (prevAbort) prevAbort.abort();
  (globalThis as any)[ABORT_KEY] = new AbortController();

  const prevStream = (globalThis as any)[STREAM_KEY] as { close(): void } | undefined;
  if (prevStream) prevStream.close();
  (globalThis as any)[STREAM_KEY] = null;

  const prevInterval = (globalThis as any)[WIDGET_INTERVAL_KEY];
  if (prevInterval) clearInterval(prevInterval);
  (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
}

function getModuleAbortSignal(): AbortSignal {
  return ((globalThis as any)[ABORT_KEY] as AbortController).signal;
}

// ── injectable runtime deps (unit-test seam) ────────────────────────────────

type WatcherStream = WatcherDeps["stream"] & { close(): void };

interface RuntimeDeps {
  client: HerdrClient;
  watch: typeof watchSubagent;
  createStream: (socketPath: string, signal: AbortSignal) => WatcherStream;
}

function defaultDeps(): RuntimeDeps {
  return {
    client: createHerdrClient(),
    watch: watchSubagent,
    createStream: (socketPath, signal) => createHerdrEventStream({ socketPath, signal }),
  };
}

let deps: RuntimeDeps = defaultDeps();
let capabilityCheck: Promise<string | null> | null = null;

function versionAtLeast(actual: string, minimum: string): boolean {
  const parse = (value: string): number[] | null => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
    return match ? match.slice(1).map(Number) : null;
  };
  const actualParts = parse(actual);
  const minimumParts = parse(minimum);
  if (!actualParts || !minimumParts) return false;
  for (let i = 0; i < 3; i += 1) {
    if (actualParts[i] !== minimumParts[i]) return actualParts[i] > minimumParts[i];
  }
  return true;
}

async function checkHerdrCapability(): Promise<string | null> {
  const status = await deps.client.ping();
  if (!status.ok) {
    return (
      "the herdr server is not reachable from this pane. " +
      "Is the herdr session still running?"
    );
  }
  if (!status.version || !versionAtLeast(status.version, MIN_HERDR_VERSION)) {
    return (
      `herdr >= ${MIN_HERDR_VERSION} is required for plugin split panes ` +
      `(found ${status.version ?? "unknown"}). Update herdr, then restart its session.`
    );
  }

  const plugin = await deps.client.pluginGet(HERDR_PLUGIN_ID);
  if (!plugin) {
    return (
      `the Herdr plugin is not linked. Run: herdr plugin link "${HERDR_PLUGIN_DIR}" --enabled`
    );
  }
  if (!plugin.enabled) {
    return `the Herdr plugin is disabled. Run: herdr plugin enable ${HERDR_PLUGIN_ID}`;
  }
  return null;
}

async function ensureHerdrCapability(): Promise<string | null> {
  const check = capabilityCheck ??= checkHerdrCapability();
  try {
    const message = await check;
    // Allow an in-place setup fix (link/enable/update) to be detected by the
    // next attempt without requiring a pi reload. Successful checks stay cached.
    if (message && capabilityCheck === check) capabilityCheck = null;
    return message;
  } catch (error) {
    if (capabilityCheck === check) capabilityCheck = null;
    throw error;
  }
}

/**
 * One shared HerdrEventStream per pi process (PLAN.md Key Decision #8),
 * created lazily on first spawn — no persistent socket while zero subagents
 * have ever run. Closed via the module AbortController on /reload + shutdown.
 */
function getEventStream(): WatcherStream {
  let stream = (globalThis as any)[STREAM_KEY] as WatcherStream | null;
  if (!stream) {
    stream = deps.createStream(process.env.HERDR_SOCKET_PATH ?? "", getModuleAbortSignal());
    (globalThis as any)[STREAM_KEY] = stream;
  }
  return stream;
}

// ── shared module state ─────────────────────────────────────────────────────

/** All currently running subagents, keyed by id. */
const runningSubagents = new Map<string, RunningSubagent>();

/** Headless process handles of running subagents, keyed by run id (owned: killed on shutdown). */
const headlessChildren = new Map<string, HeadlessChild>();

/** Latest ExtensionContext from session_start, used for widget updates. */
let latestCtx: ExtensionContext | null = null;

/** Last herdr agent_status seen per pane; refreshed opportunistically for the widget. */
const latestAgentStatuses = new Map<string, string>();

export function isInsideHerdr(env: Record<string, string | undefined> = process.env): boolean {
  return env.HERDR_ENV === "1" && !!env.HERDR_PANE_ID && !!env.HERDR_SOCKET_PATH;
}

// ── polished widget (boxed, width-aware running-subagent status) ────────────

type WidgetAgent = Pick<RunningSubagent, "name" | "agent" | "paneId" | "startTime"> & {
  agentStatus?: string;
};

function formatElapsedMMSS(startTime: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - startTime) / 1000));
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function truncateToWidth(text: string, width: number): string {
  if (text.length <= width) return text;
  if (width <= 0) return "";
  if (width === 1) return "…";
  return `${text.slice(0, width - 1)}…`;
}

function normalizeWidgetWidth(width: number): number {
  if (!Number.isFinite(width)) return process.stdout.columns ?? 80;
  return Math.max(0, Math.floor(width));
}

function borderLine(left: string, right: string, width: number): string {
  if (width <= 0) return "";
  if (width === 1) return "│";

  const innerWidth = Math.max(0, width - 2);
  const rightWidth = right.length;

  if (rightWidth >= innerWidth) {
    return `│${truncateToWidth(right, innerWidth).padEnd(innerWidth)}│`;
  }

  const truncatedLeft = truncateToWidth(left, innerWidth - rightWidth);
  const gap = " ".repeat(Math.max(0, innerWidth - truncatedLeft.length - rightWidth));
  return `│${truncatedLeft}${gap}${right}│`;
}

function borderTop(title: string, info: string, width: number): string {
  if (width <= 0) return "";
  if (width === 1) return "╭";

  const innerWidth = Math.max(0, width - 2);
  const titlePart = `─ ${title} `;
  const infoPart = ` ${info} ─`;
  const fill = "─".repeat(Math.max(0, innerWidth - titlePart.length - infoPart.length));
  const inner = `${titlePart}${fill}${infoPart}`.slice(0, innerWidth).padEnd(innerWidth, "─");
  return `╭${inner}╮`;
}

function borderBottom(width: number): string {
  if (width <= 0) return "";
  if (width === 1) return "╰";
  return `╰${"─".repeat(Math.max(0, width - 2))}╯`;
}

export function renderSubagentWidgetLines(
  agents: WidgetAgent[],
  now = Date.now(),
  width = process.stdout.columns ?? 80,
): string[] {
  const widgetWidth = normalizeWidgetWidth(width);
  const lines = [borderTop("Subagents", `${agents.length} running`, widgetWidth)];

  for (const agent of agents) {
    const elapsed = formatElapsedMMSS(agent.startTime, now);
    const agentTag = agent.agent ? ` (${agent.agent})` : "";
    const left = ` ${elapsed}  ${agent.name}${agentTag}`;
    const status = agent.agentStatus?.trim() || "working";
    const right = ` ${status} · ${elapsed} `;
    lines.push(borderLine(left, right, widgetWidth));
  }

  lines.push(borderBottom(widgetWidth));
  return lines;
}

function stopWidgetRefresh(): void {
  const interval = (globalThis as any)[WIDGET_INTERVAL_KEY];
  if (interval) clearInterval(interval);
  (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
}

function getWidgetAgents(): WidgetAgent[] {
  return [...runningSubagents.values()].map((agent) => ({
    ...agent,
    agentStatus: latestAgentStatuses.get(agent.paneId),
  }));
}

function setWidgetFromCurrentState(): void {
  latestCtx?.ui.setWidget(
    "herdr-subagents",
    (_tui: unknown, _theme: unknown) => ({
      invalidate() {},
      render(width: number): string[] {
        return renderSubagentWidgetLines(getWidgetAgents(), Date.now(), width);
      },
    }),
    { placement: "aboveEditor" },
  );
}

async function refreshWidgetStatuses(): Promise<void> {
  try {
    const panes = await deps.client.paneList();
    latestAgentStatuses.clear();
    for (const pane of panes) {
      if (typeof pane.agent_status === "string" && pane.agent_status.trim()) {
        latestAgentStatuses.set(pane.pane_id, pane.agent_status.trim());
      }
    }
    if (runningSubagents.size > 0 && latestCtx?.hasUI) setWidgetFromCurrentState();
  } catch {
    // The widget is best-effort; watcher reconciliation remains the source of truth.
  }
}

function updateWidget(): void {
  if (runningSubagents.size === 0) {
    stopWidgetRefresh();
    latestAgentStatuses.clear();
    if (latestCtx?.hasUI) latestCtx.ui.setWidget("herdr-subagents", undefined);
    return;
  }
  if (!latestCtx?.hasUI) return;
  setWidgetFromCurrentState();
  void refreshWidgetStatuses();
}

/** 1s refresh only while subagents are running; cleared at zero / shutdown / reload. */
function startWidgetRefresh(): void {
  updateWidget();
  if ((globalThis as any)[WIDGET_INTERVAL_KEY] || runningSubagents.size === 0) return;
  (globalThis as any)[WIDGET_INTERVAL_KEY] = setInterval(updateWidget, 1000);
}

// ── watcher arming + outcome→steer wiring ───────────────────────────────────

/** Per-run backend: herdr client/stream, or a headless process adapter. */
type WatcherBackend = Omit<WatcherDeps, "signal" | "liveness">;

function herdrBackend(): WatcherBackend {
  return { client: deps.client, stream: getEventStream() };
}

function livenessFor(pi: ExtensionAPI, running: RunningSubagent): NonNullable<WatcherDeps["liveness"]> {
  const headless = running.backend === "headless";
  return {
    heartbeatFile: `${running.sessionFile}.heartbeat`,
    deadAfterMs: DEAD_AFTER_MS,
    stallWarnMs: STALL_WARN_MS,
    maxRunMs: MAX_RUN_MS,
    timeoutGraceMs: TIMEOUT_GRACE_MS,
    exemptFromMaxRun: running.interactive,
    onStall({ idleMs }) {
      pi.sendMessage(
        {
          customType: "subagent-stall",
          content:
            `Sub-agent "${running.name}" shows no activity for ${Math.round(idleMs / 60_000)} min ` +
            "(still alive; it is stopped at the 30 min limit).",
          display: true,
          details: { id: running.id, name: running.name, idleMs },
        },
        { triggerTurn: false },
      );
      updateWidget();
    },
    interrupt() {
      if (headless) interruptTree(running.pid ?? -1);
      else return deps.client.paneSendKeys(running.paneId, ["esc"]);
    },
    kill() {
      if (headless) return killTree(running.pid ?? -1);
      return deps.client.paneClose(running.paneId);
    },
  };
}

/**
 * Watch one run. The outcome becomes a steer message (interactive
 * controllers) or is returned to the caller (`deliver: false`, one-shot
 * controllers, which dispose before any later steer could arrive).
 */
function armWatcher(
  pi: ExtensionAPI,
  running: RunningSubagent,
  backend: WatcherBackend,
  opts: {
    mapOutcome?: (outcome: SubagentOutcome) => SubagentOutcome;
    deliver?: boolean;
  } = {},
): Promise<SubagentSteerMessage | null> {
  const deliver = opts.deliver ?? true;
  const watcherAbort = new AbortController();
  running.abortController = watcherAbort;

  const moduleSignal = getModuleAbortSignal();
  const onModuleAbort = () => watcherAbort.abort();
  moduleSignal.addEventListener("abort", onModuleAbort, { once: true });

  runningSubagents.set(running.id, running);
  markSubagentActive(running.id);
  startWidgetRefresh();

  const settle = () => {
    runningSubagents.delete(running.id);
    headlessChildren.delete(running.id);
    markSubagentInactive(running.id);
    updateWidget();
  };

  return deps
    .watch(running, {
      ...backend,
      signal: watcherAbort.signal,
      pollIntervalMs: POLL_MS,
      liveness: livenessFor(pi, running),
    })
    .then((outcome) => {
      settle();
      const contextUsage =
        outcome.kind === "cancelled"
          ? null
          : consumeContextUsageSidecar(running.sessionFile, running.id);
      const message = buildOutcomeMessage(
        running,
        opts.mapOutcome ? opts.mapOutcome(outcome) : outcome,
        { contextUsage, sessionId: getSessionId(running.sessionFile) },
      );
      if (message && deliver) pi.sendMessage(message, { triggerTurn: true, deliverAs: "steer" });
      return message;
    })
    .catch((err: any) => {
      settle();
      const message: SubagentSteerMessage = {
        customType: "subagent_result",
        content: `Sub-agent "${running.name}" error: ${err?.message ?? String(err)}`,
        display: true,
        details: { name: running.name, task: running.task, error: err?.message ?? String(err) },
      };
      if (deliver) pi.sendMessage(message, { triggerTurn: true, deliverAs: "steer" });
      return message;
    })
    .finally(() => {
      moduleSignal.removeEventListener("abort", onModuleAbort);
    });
}

/** Shared launch context for spawn and resume. */
interface LaunchCtx {
  cwd: string;
  sessionManager: {
    getSessionFile(): string | null;
    getSessionId(): string;
    getSessionDir(): string;
  };
  isProjectTrusted?: () => boolean;
}

/** Agent discovery options for this call (trusted project + event-bus package dirs). */
function agentLookup(pi: ExtensionAPI, ctx: { isProjectTrusted?: () => boolean }): AgentLookup {
  let projectTrusted = false;
  try {
    projectTrusted = ctx.isProjectTrusted?.() === true;
  } catch {}
  let extraDirs: string[] = [];
  try {
    extraDirs = queryAgentDirs(pi.events);
  } catch {}
  return { projectTrusted, extraDirs };
}

/** The parent's active-tool ceiling, captured when the tool executes. */
function toolCeiling(pi: ExtensionAPI) {
  try {
    return { active: pi.getActiveTools(), all: pi.getAllTools().map((tool) => tool.name) };
  } catch {
    return undefined;
  }
}

const HEADLESS_INTERACTIVE_REFUSAL =
  "interactive agent needs herdr; run the interview in the main session with ask_user";

/**
 * Start a planned run: a herdr pane, or (outside herdr) a detached headless
 * process. Returns the running record and its watcher backend, or an error.
 */
async function startRun(
  plan: { id: string; name: string; launchScriptFile: string; sessionFile: string; paneStart: any },
  headless: boolean,
  entryOffset: number,
): Promise<{ paneId: string; pid?: number; backend: WatcherBackend } | { error: string }> {
  if (headless) {
    const child = startHeadless({ launchScriptFile: plan.launchScriptFile, sessionFile: plan.sessionFile });
    if (child.pid <= 0) return { error: "failed to spawn the headless subagent process" };
    headlessChildren.set(plan.id, child);
    const paneId = `headless:${plan.id}`;
    return { paneId, pid: child.pid, backend: headlessWatcherDeps(child, paneId, entryOffset) };
  }
  try {
    const started = await deps.client.paneStart(plan.paneStart);
    // Best-effort sidebar label; the pane is already running the subagent.
    await deps.client.paneRename(started.paneId, plan.name).catch(() => {});
    return { paneId: started.paneId, backend: herdrBackend() };
  } catch (error: any) {
    return { error: `Failed to start herdr pane for "${plan.name}": ${error?.message ?? String(error)}` };
  }
}

/** One-shot controllers get the outcome inline; interactive ones get the acknowledgement. */
function inlineOutcome(message: SubagentSteerMessage | null, running: RunningSubagent) {
  const text = message?.content ?? `Sub-agent "${running.name}" was cancelled.`;
  return {
    content: [{ type: "text" as const, text }],
    details: {
      ...(message?.details ?? {}),
      id: running.id,
      name: running.name,
      status: "finished",
    } as Record<string, unknown>,
  };
}

/** Tool-result run details: headless runs carry `pid`, never `paneId` (herdr-layout keys on it). */
function runDetails(running: RunningSubagent): Record<string, unknown> {
  return running.backend === "headless"
    ? { backend: "headless", pid: running.pid }
    : { paneId: running.paneId };
}

// ── tool parameter schema (ported, minus Claude-only resumeSessionId) ───────

const SubagentParams = Type.Object({
  name: Type.String({ description: "Display name for the subagent" }),
  task: Type.String({ description: "Task/prompt for the sub-agent" }),
  agent: Type.Optional(
    Type.String({
      description:
        "Agent name to load defaults from (e.g. 'worker', 'scout', 'reviewer'). Reads ~/.pi/agent/agents/<name>.md for model, tools, skills.",
    }),
  ),
  systemPrompt: Type.Optional(
    Type.String({ description: "Appended to system prompt (role instructions)" }),
  ),
  model: Type.Optional(
    Type.String({
      description:
        "Model override (overrides agent default). Use the provider/id form, e.g. 'anthropic/claude-opus-5-5'. A bare id combined with the agent's thinking level is fuzzy-matched by pi and can resolve to an unconfigured provider.",
    }),
  ),
  skills: Type.Optional(
    Type.String({ description: "Comma-separated skills (overrides agent default)" }),
  ),
  tools: Type.Optional(
    Type.String({ description: "Comma-separated tools (overrides agent default)" }),
  ),
  cwd: Type.Optional(
    Type.String({
      description:
        "Working directory for the sub-agent. The agent starts in this folder and picks up its local .pi/ config, CLAUDE.md, skills, and extensions. Use for role-specific subfolders.",
    }),
  ),
  fork: Type.Optional(
    Type.Boolean({
      description:
        "Force the full-context fork mode for this spawn. The sub-agent inherits the current session conversation, overriding any agent frontmatter session-mode.",
    }),
  ),
  interactive: Type.Optional(
    Type.Boolean({
      description:
        "Mark the subagent as interactive (long-running, user drives the conversation in its own pane). If omitted, falls back to the agent's `interactive` frontmatter, otherwise the inverse of `auto-exit`.",
    }),
  ),
});

const SUBAGENT_DESCRIPTION =
  "Spawn a sub-agent in a herdr pane, or as a background process outside herdr. " +
  "In interactive sessions it is fire-and-forget: the call returns immediately with only an acknowledgement; " +
  "in one-shot (-p) runs it waits and returns the result. " +
  "When the sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. " +
  "DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT call subagents_list or any other tool to 'check' status. All of that is wasted work — the harness handles delivery for you. " +
  "DO NOT fabricate, assume, or summarize results after calling this tool. " +
  "After spawning, either end your turn immediately, or work on other independent tasks (including spawning more subagents in parallel). The harness will wake you with the result when it is ready.";

// ── subagent spawn ──────────────────────────────────────────────────────────

function errorResult(text: string, error: string) {
  return {
    content: [{ type: "text" as const, text }],
    details: { error },
  };
}

async function executeSubagentSpawn(
  pi: ExtensionAPI,
  params: Static<typeof SubagentParams>,
  ctx: LaunchCtx,
) {
  try {
    assertSafeLabel(params.name);
  } catch (error: any) {
    return errorResult(`Error: invalid subagent name: ${error?.message ?? String(error)}`, "invalid name");
  }

  // Prevent self-spawning (e.g. planner spawning another planner)
  const currentAgent = process.env.PI_SUBAGENT_AGENT;
  if (params.agent && currentAgent && params.agent === currentAgent) {
    return errorResult(
      `You are the ${currentAgent} agent — do not start another ${currentAgent}. ` +
        `You were spawned to do this work yourself. Complete the task directly.`,
      "self-spawn blocked",
    );
  }

  const lookup = agentLookup(pi, ctx);
  const agentDefs = params.agent ? loadAgentDefaults(params.agent, lookup) : null;
  if (params.agent && !agentDefs) {
    const searched = agentSearchDirs(lookup).map(({ path }) => join(path, `${params.agent}.md`));
    return errorResult(
      `Agent "${params.agent}" not found. Searched ${searched.join(", ")}.`,
      "agent not found",
    );
  }
  const headless = !isInsideHerdr();

  const parentSessionFile = ctx.sessionManager.getSessionFile();
  if (!parentSessionFile) {
    return errorResult(
      "Error: no session file. Start pi with a persistent session to use subagents.",
      "no session file",
    );
  }

  if (!headless) {
    let setupError: string | null;
    try {
      setupError = await ensureHerdrCapability();
    } catch (error: any) {
      setupError = `capability check failed: ${error?.message ?? String(error)}`;
    }
    if (setupError) {
      return errorResult(
        `Cannot start subagent: ${setupError}`,
        "herdr setup incomplete",
      );
    }
  }

  let plan;
  try {
    plan = buildLaunchPlan(params, agentDefs, {
      sessionDir: ctx.sessionManager.getSessionDir(),
      sessionId: ctx.sessionManager.getSessionId(),
      parentSessionFile,
      parentCwd: ctx.cwd,
      env: process.env,
      headless,
      toolCeiling: toolCeiling(pi),
    });
  } catch (error: any) {
    const message = error?.message ?? String(error);
    return errorResult(`Failed to plan subagent launch: ${message}`, message);
  }

  if (headless && plan.interactive) {
    return errorResult(HEADLESS_INTERACTIVE_REFUSAL, "interactive needs herdr");
  }

  // Execute the plan: write artifacts, seed the child session, start the child.
  writePlanFiles(plan.files);
  if (plan.seedSession) {
    seedSubagentSessionFile(plan.seedSession);
  }
  rmSync(`${plan.sessionFile}.heartbeat`, { force: true });
  const entryOffset = plan.seedSession ? safeGetNewEntries(plan.sessionFile, 0).length : 0;

  const started = await startRun(plan, headless, entryOffset);
  if ("error" in started) return errorResult(started.error, started.error);

  const running: RunningSubagent = {
    id: plan.id,
    name: params.name,
    task: params.task,
    agent: params.agent,
    paneId: started.paneId,
    startTime: Date.now(),
    sessionFile: plan.sessionFile,
    launchScriptFile: plan.launchScriptFile,
    interactive: plan.interactive,
    autoExit: plan.autoExit,
    backend: headless ? "headless" : "herdr",
    ...(started.pid !== undefined ? { pid: started.pid } : {}),
  };
  const oneShot = isOneShotInvocation();
  const outcome = armWatcher(pi, running, started.backend, { deliver: !oneShot });
  if (oneShot) return inlineOutcome(await outcome, running);

  return {
    content: [
      {
        type: "text" as const,
        text:
          `Sub-agent "${params.name}" launched and is now running in the background. ` +
          `Do NOT generate or assume any results — you have no idea what the sub-agent will do or produce. ` +
          `The results will be delivered to you automatically as a steer message when the sub-agent finishes. ` +
          `Until then, move on to other work or tell the user you're waiting.`,
      },
    ],
    details: {
      id: running.id,
      name: params.name,
      task: params.task,
      agent: params.agent,
      ...runDetails(running),
      sessionFile: running.sessionFile,
      launchScriptFile: running.launchScriptFile,
      status: "started",
    },
  };
}

function writePlanFiles(files: Array<{ path: string; content: string }>): void {
  for (const file of files) {
    mkdirSync(dirname(file.path), { recursive: true });
    writeFileSync(file.path, file.content, "utf8");
  }
}

function registerSubagentTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: SUBAGENT_DESCRIPTION,
    promptSnippet: SUBAGENT_DESCRIPTION,
    parameters: SubagentParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return executeSubagentSpawn(pi, params, ctx as any);
    },

    renderCall(args, theme) {
      const partialArgs = args as Record<string, unknown>;
      const name =
        typeof partialArgs.name === "string" && partialArgs.name ? partialArgs.name : "(unnamed)";
      const task = typeof partialArgs.task === "string" ? partialArgs.task : "";
      const agent =
        typeof partialArgs.agent === "string" && partialArgs.agent
          ? theme.fg("dim", ` (${partialArgs.agent})`)
          : "";
      const cwdHint =
        typeof partialArgs.cwd === "string" && partialArgs.cwd
          ? theme.fg("dim", ` in ${partialArgs.cwd}`)
          : "";
      let text = "▸ " + theme.fg("toolTitle", theme.bold(name)) + agent + cwdHint;

      // Show a one-line task preview. renderCall is called repeatedly as the
      // LLM generates tool arguments, so args.task grows token by token.
      if (task) {
        const firstLine = task.split("\n").find((l: string) => l.trim()) ?? "";
        const preview = firstLine.length > 100 ? firstLine.slice(0, 100) + "…" : firstLine;
        if (preview) {
          text += "\n" + theme.fg("toolOutput", preview);
        }
        const totalLines = task.split("\n").length;
        if (totalLines > 1) {
          text += theme.fg("muted", ` (${totalLines} lines)`);
        }
      }

      return new Text(text, 0, 0);
    },

    renderResult(result, _opts, theme) {
      const details = result.details as any;
      const name = details?.name ?? "(unnamed)";

      if (details?.status === "started") {
        return new Text(
          theme.fg("accent", "▸") +
            " " +
            theme.fg("toolTitle", theme.bold(name)) +
            theme.fg("dim", " — started"),
          0,
          0,
        );
      }

      const first = result.content[0];
      const text = first?.type === "text" ? first.text : "";
      return new Text(theme.fg("dim", text), 0, 0);
    },
  });
}

// ── subagent_resume ─────────────────────────────────────────────────────────

function safeGetNewEntries(sessionFile: string, afterLine: number) {
  try {
    return getNewEntries(sessionFile, afterLine);
  } catch {
    return [];
  }
}

/**
 * Re-scope a resumed subagent's outcome summary to entries added AFTER the
 * resume launch (ported reference behavior): the pre-existing conversation
 * must not masquerade as new output. A summary the child handed over
 * explicitly via `subagent_done` is already scoped to this run and is kept
 * as-is. Launch failures and pings pass through
 * untouched — their payloads are already truthful.
 */
function resolveResumeOutcome(
  outcome: SubagentOutcome,
  sessionPath: string,
  entryCountBefore: number,
): SubagentOutcome {
  const newSummary = () =>
    findLastAssistantMessage(safeGetNewEntries(sessionPath, entryCountBefore));

  switch (outcome.kind) {
    case "completed":
      if (outcome.summarySource === "sidecar") return outcome;
      return { ...outcome, summary: newSummary() ?? "Resumed session exited without new output" };
    case "completed-user-exit":
      return { ...outcome, summary: newSummary() ?? "Resumed session exited without new output" };
    case "crashed":
    case "pane-killed":
    case "gap-exit":
      return { ...outcome, summary: newSummary() };
    default:
      return outcome;
  }
}

const RESUME_DESCRIPTION =
  "Resume a previous sub-agent session in a new herdr pane. " +
  "This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement. " +
  "When the resumed sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. " +
  "DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT poll for status. All of that is wasted work — the harness handles delivery for you. " +
  "DO NOT fabricate or assume results. After resuming, either end your turn or work on other independent tasks; the harness will wake you when the result is ready. " +
  "Use when a sub-agent was cancelled or needs follow-up work.";

async function executeSubagentResume(
  pi: ExtensionAPI,
  params: { sessionPath: string; name?: string; message?: string; autoExit?: boolean },
  ctx: LaunchCtx,
) {
  if (params.name !== undefined) {
    try {
      assertSafeLabel(params.name);
    } catch (error: any) {
      return errorResult(`Error: invalid subagent name: ${error?.message ?? String(error)}`, "invalid name");
    }
  }

  if (!existsSync(params.sessionPath)) {
    return errorResult(
      `Error: session file not found: ${params.sessionPath}`,
      "session not found",
    );
  }

  const headless = !isInsideHerdr();
  if (!headless) {
    let setupError: string | null;
    try {
      setupError = await ensureHerdrCapability();
    } catch (error: any) {
      setupError = `capability check failed: ${error?.message ?? String(error)}`;
    }
    if (setupError) {
      return errorResult(
        `Cannot resume subagent: ${setupError}`,
        "herdr setup incomplete",
      );
    }
  }

  // Record entry count before resuming so we can extract only new messages.
  const entryCountBefore = safeGetNewEntries(params.sessionPath, 0).length;

  let plan;
  try {
    plan = buildResumeLaunchPlan(params, {
      sessionDir: ctx.sessionManager.getSessionDir(),
      sessionId: ctx.sessionManager.getSessionId(),
      parentSessionFile: ctx.sessionManager.getSessionFile() ?? "",
      parentCwd: ctx.cwd,
      env: process.env,
      headless,
      toolCeiling: toolCeiling(pi),
    });
  } catch (error: any) {
    const message = error?.message ?? String(error);
    return errorResult(`Failed to plan resume launch: ${message}`, message);
  }

  if (headless && plan.interactive) {
    return errorResult(HEADLESS_INTERACTIVE_REFUSAL, "interactive needs herdr");
  }

  // Stale-sidecar belt & braces: completion signals from the previous run
  // would resolve the new watcher instantly.
  rmSync(`${params.sessionPath}.exit`, { force: true });
  rmSync(`${params.sessionPath}.exitcode`, { force: true });
  rmSync(`${params.sessionPath}.heartbeat`, { force: true });
  rmSync(contextUsagePath(params.sessionPath), { force: true });

  writePlanFiles(plan.files);

  const started = await startRun(plan, headless, entryCountBefore);
  if ("error" in started) return errorResult(started.error, started.error);

  const running: RunningSubagent = {
    id: plan.id,
    name: plan.name,
    task: params.message ?? "resumed session",
    paneId: started.paneId,
    startTime: Date.now(),
    sessionFile: params.sessionPath,
    launchScriptFile: plan.launchScriptFile,
    interactive: plan.interactive,
    autoExit: plan.autoExit,
    backend: headless ? "headless" : "herdr",
    ...(started.pid !== undefined ? { pid: started.pid } : {}),
  };
  const oneShot = isOneShotInvocation();
  const outcome = armWatcher(pi, running, started.backend, {
    mapOutcome: (o) => resolveResumeOutcome(o, params.sessionPath, entryCountBefore),
    deliver: !oneShot,
  });
  if (oneShot) return inlineOutcome(await outcome, running);

  return {
    content: [{ type: "text" as const, text: `Session "${plan.name}" resumed.` }],
    details: {
      id: running.id,
      name: plan.name,
      ...runDetails(running),
      sessionPath: params.sessionPath,
      launchScriptFile: plan.launchScriptFile,
      status: "started",
    },
  };
}

function registerResumeTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "subagent_resume",
    label: "Resume Subagent",
    description: RESUME_DESCRIPTION,
    promptSnippet: RESUME_DESCRIPTION,
    parameters: Type.Object({
      sessionPath: Type.String({ description: "Path to the session .jsonl file to resume" }),
      name: Type.Optional(
        Type.String({ description: "Display name for the herdr pane. Default: 'Resume'" }),
      ),
      message: Type.Optional(
        Type.String({
          description: "Optional message to send after resuming (e.g. follow-up instructions)",
        }),
      ),
      autoExit: Type.Optional(
        Type.Boolean({
          description:
            "Whether the resumed session should automatically exit after completing its response. Defaults to true for autonomous follow-up work; set false for interactive resumed sessions.",
        }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return executeSubagentResume(pi, params, ctx as any);
    },

    renderCall(args, theme) {
      const name = (args as any).name ?? "Resume";
      return new Text(
        "▸ " + theme.fg("toolTitle", theme.bold(name)) + theme.fg("dim", " — resuming session"),
        0,
        0,
      );
    },

    renderResult(result, _opts, theme) {
      const details = result.details as any;
      const name = details?.name ?? "Resume";

      if (details?.status === "started") {
        return new Text(
          theme.fg("accent", "▸") +
            " " +
            theme.fg("toolTitle", theme.bold(name)) +
            theme.fg("dim", " — resumed"),
          0,
          0,
        );
      }

      const first = result.content[0];
      const text = first?.type === "text" ? first.text : "";
      return new Text(theme.fg("dim", text), 0, 0);
    },
  });
}

// ── subagent_interrupt ──────────────────────────────────────────────────────

export function resolveInterruptTarget(params: {
  id?: string;
  name?: string;
}): { running: RunningSubagent } | { error: string } {
  const requestedId = params.id?.trim();
  if (requestedId) {
    const running = runningSubagents.get(requestedId);
    return running ? { running } : { error: `No running subagent with id "${requestedId}".` };
  }

  const requestedName = params.name?.trim();
  if (!requestedName) {
    return { error: "Provide a running subagent id or exact display name." };
  }

  const matches = Array.from(runningSubagents.values()).filter(
    (running) => running.name === requestedName,
  );
  if (matches.length === 1) return { running: matches[0] };
  if (matches.length === 0) {
    return { error: `No running subagent named "${requestedName}".` };
  }

  const candidates = matches.map((running) => `${running.name} [${running.id}]`).join(", ");
  return { error: `Ambiguous subagent name "${requestedName}". Matches: ${candidates}` };
}

async function handleSubagentInterrupt(params: { id?: string; name?: string }) {
  const resolved = resolveInterruptTarget(params);
  if ("error" in resolved) {
    return errorResult(resolved.error, resolved.error);
  }

  const running = resolved.running;
  if (running.backend === "headless") {
    // SIGINT to the process group: pi aborts its running tools.
    interruptTree(running.pid ?? -1);
    return {
      content: [
        { type: "text" as const, text: `Interrupt requested for subagent "${running.name}".` },
      ],
      details: { id: running.id, name: running.name, status: "interrupt_requested" },
    };
  }
  try {
    // "esc" is herdr key-combo syntax (src/input/parse.rs maps it to KeyCode::Esc).
    await deps.client.paneSendKeys(running.paneId, ["esc"]);
  } catch (error: any) {
    const message =
      `Failed to send Escape to subagent "${running.name}" via herdr: ` +
      `${error?.message ?? String(error)}`;
    return {
      content: [{ type: "text" as const, text: message }],
      details: { error: error?.message ?? String(error), id: running.id, name: running.name },
    };
  }

  return {
    content: [
      { type: "text" as const, text: `Interrupt requested for subagent "${running.name}".` },
    ],
    details: { id: running.id, name: running.name, status: "interrupt_requested" },
  };
}

const INTERRUPT_DESCRIPTION =
  "Send Escape to the active turn of a currently running subagent. " +
  "The child pane, session, watcher, and running entry remain alive; this returns only a local acknowledgement " +
  "and does not emit a subagent_result solely because of this request.";

function registerInterruptTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "subagent_interrupt",
    label: "Interrupt Subagent",
    description: INTERRUPT_DESCRIPTION,
    promptSnippet: INTERRUPT_DESCRIPTION,
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "Exact running subagent id" })),
      name: Type.Optional(Type.String({ description: "Exact running subagent display name" })),
    }),

    async execute(_toolCallId, params): Promise<AgentToolResult<Record<string, unknown>>> {
      return handleSubagentInterrupt(params);
    },

    renderCall(args, theme) {
      const target = (args as any).id ? `${(args as any).id}` : ((args as any).name ?? "(unknown)");
      return new Text(
        theme.fg("accent", "▸") +
          " " +
          theme.fg("toolTitle", theme.bold(target)) +
          theme.fg("dim", " — interrupt turn"),
        0,
        0,
      );
    },

    renderResult(result, _opts, theme) {
      const details = result.details as any;
      if (details?.status === "interrupt_requested") {
        return new Text(
          theme.fg("accent", "▸") +
            " " +
            theme.fg("toolTitle", theme.bold(details.name ?? details.id ?? "subagent")) +
            theme.fg("dim", " — interrupt requested"),
          0,
          0,
        );
      }

      const first = result.content[0];
      const text = first?.type === "text" ? first.text : "";
      return new Text(theme.fg("dim", text), 0, 0);
    },
  });
}

// ── subagents_list ──────────────────────────────────────────────────────────

const LIST_DESCRIPTION =
  "List all available subagent definitions. " +
  "Scans package agent dirs (pi-light, pi-light-kit), global ~/.pi/agent/agents/ and, in trusted projects, .pi/agents/. " +
  "Later sources override earlier ones with the same name (project > global > package).";

function registerListTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "subagents_list",
    label: "List Subagents",
    description: LIST_DESCRIPTION,
    promptSnippet: LIST_DESCRIPTION,
    parameters: Type.Object({}),

    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const list = discoverAgentDefinitions(agentLookup(pi, ctx)).filter(
        (agent) => !agent.disableModelInvocation,
      );

      if (list.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No subagent definitions found." }],
          details: { agents: [] },
        };
      }

      const lines = list.map((a) => {
        const badge = a.source === "global" ? "" : ` (${a.source})`;
        const desc = a.description ? ` — ${a.description}` : "";
        const model = a.model ? ` [${a.model}]` : "";
        return `• ${a.name}${badge}${model}${desc}`;
      });

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: { agents: list },
      };
    },

    renderResult(result, _opts, theme) {
      const details = result.details as any;
      const agents = details?.agents ?? [];
      if (agents.length === 0) {
        return new Text(theme.fg("dim", "No subagent definitions found."), 0, 0);
      }
      const lines = agents.map((a: any) => {
        const badge = a.source === "global" ? "" : theme.fg("accent", ` (${a.source})`);
        const desc = a.description ? theme.fg("dim", ` — ${a.description}`) : "";
        const model = a.model ? theme.fg("dim", ` [${a.model}]`) : "";
        return `  ${theme.fg("toolTitle", theme.bold(a.name))}${badge}${model}${desc}`;
      });
      return new Text(lines.join("\n"), 0, 0);
    },
  });
}

// ── commands ────────────────────────────────────────────────────────────────

const AGENT_TEMPLATE_FILES = ["worker.md", "planner.md", "scout.md", "reviewer.md"];

function registerCommands(pi: ExtensionAPI): void {
  // /subagents-init — copy package examples into user-owned config
  pi.registerCommand("subagents-init", {
    description: "Copy example subagent definitions: /subagents-init [global|project]",
    getArgumentCompletions: (prefix) => {
      const options = [
        {
          value: "global",
          label: "global",
          description: "copy example agent defs to ~/.pi/agent/agents",
        },
        {
          value: "project",
          label: "project",
          description: "copy example agent defs to .pi/agents",
        },
      ];
      const filtered = options.filter(({ value }) => value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      const scope = args.trim() || "global";
      if (scope !== "global" && scope !== "project") {
        ctx.ui.notify("Usage: /subagents-init [global|project]", "error");
        return;
      }

      const targetDir =
        scope === "global"
          ? join(getAgentConfigDir(), "agents")
          : join(ctx.cwd, ".pi", "agents");
      const sourceDir = join(dirname(MODULE_PATH), "agents");
      const installed: string[] = [];
      const skipped: string[] = [];
      mkdirSync(targetDir, { recursive: true });

      for (const filename of AGENT_TEMPLATE_FILES) {
        try {
          copyFileSync(
            join(sourceDir, filename),
            join(targetDir, filename),
            fsConstants.COPYFILE_EXCL,
          );
          installed.push(filename);
        } catch (error: any) {
          if (error?.code === "EEXIST") {
            skipped.push(filename);
            continue;
          }
          ctx.ui.notify(
            `Failed to install ${filename} in ${targetDir}: ${error?.message ?? String(error)}`,
            "error",
          );
          return;
        }
      }

      ctx.ui.notify(
        [
          `Installed: ${installed.length > 0 ? installed.join(", ") : "none"}`,
          `Skipped existing: ${skipped.length > 0 ? skipped.join(", ") : "none"}`,
          `Target: ${targetDir}`,
        ].join("\n"),
        "info",
      );
    },
  });

  // /iterate — fork the session into a subagent
  pi.registerCommand("iterate", {
    description: "Fork session into a subagent for focused work (bugfixes, iteration)",
    handler: async (args, _ctx) => {
      const task = args.trim() || "";
      const toolCall = task
        ? `Use subagent to fork a session. fork: true, name: "Iterate", task: ${JSON.stringify(task)}`
        : `Use subagent to fork a session. fork: true, name: "Iterate", task: "The user wants to do some hands-on work. Help them with whatever they need."`;
      pi.sendUserMessage(toolCall);
    },
  });

  // /subagent — spawn a subagent by name
  pi.registerCommand("subagent", {
    description: "Spawn a subagent: /subagent <agent> <task>",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (!trimmed) {
        ctx.ui.notify("Usage: /subagent <agent> [task]", "warning");
        return;
      }

      const spaceIdx = trimmed.indexOf(" ");
      const agentName = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
      const task = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

      const defs = loadAgentDefaults(agentName);
      if (!defs) {
        ctx.ui.notify(
          `Agent "${agentName}" not found in ~/.pi/agent/agents/ or .pi/agents/`,
          "error",
        );
        return;
      }

      const taskText = task || `You are the ${agentName} agent. Wait for instructions.`;
      const displayName = agentName[0].toUpperCase() + agentName.slice(1);
      const toolCall = `Use subagent with agent: "${agentName}", name: "${displayName}", task: ${JSON.stringify(taskText)}`;
      pi.sendUserMessage(toolCall);
    },
  });
}

/** Kill every running headless child and report it as cancelled. */
function shutdownHeadlessChildren(pi: ExtensionAPI): void {
  for (const running of runningSubagents.values()) {
    if (running.backend !== "headless") continue;
    void killTree(running.pid ?? -1).catch(() => {});
    try {
      pi.sendMessage(
        {
          customType: "subagent_result",
          content: `Sub-agent "${running.name}" cancelled (controller shut down).`,
          display: true,
          details: { id: running.id, name: running.name, error: "cancelled (controller shut down)" },
        },
        { triggerTurn: false },
      );
    } catch {}
  }
  headlessChildren.clear();
}

// ── extension entry ─────────────────────────────────────────────────────────

export default function herdrSubagents(pi: ExtensionAPI) {
  const inHerdr = isInsideHerdr();

  // Tools denied via PI_DENY_TOOLS env var (set by parent agent based on frontmatter)
  const deniedTools = new Set(
    (process.env.PI_DENY_TOOLS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const shouldRegister = (name: string) => !deniedTools.has(name);

  // Always registered: per call, herdr when inside herdr, otherwise headless.
  if (shouldRegister("subagent")) registerSubagentTool(pi);
  if (shouldRegister("subagent_resume")) registerResumeTool(pi);
  if (shouldRegister("subagent_interrupt")) registerInterruptTool(pi);
  if (shouldRegister("subagents_list")) registerListTool(pi);
  registerCommands(pi);

  pi.on("session_start", (_event, ctx) => {
    latestCtx = ctx;

    // A leftover pi-herdr-subagents package would register the same tools.
    const duplicate = pi
      .getAllTools()
      .some((tool) => tool.sourceInfo?.path?.includes("/pi-herdr-subagents/"));
    if (duplicate) {
      ctx.ui.notify(
        "pi-light: remove the pi-herdr-subagents package; it duplicates extensions/subagents",
        "warning",
      );
    }

    if (!inHerdr) return;

    // Cheap, asynchronous readiness check. Import stays side-effect free; tool
    // execution awaits the same promise so setup failures stop before artifacts
    // or panes are created.
    capabilityCheck = null;
    void ensureHerdrCapability()
      .then((message) => {
        if (message) {
          ctx.ui.notify(`pi-herdr-subagents: ${message}`, "warning");
        }
      })
      .catch((error: any) => {
        ctx.ui.notify(
          `pi-herdr-subagents: capability check failed: ${error?.message ?? String(error)}`,
          "warning",
        );
      });
  });

  pi.on("session_shutdown", () => {
    stopWidgetRefresh();
    // Owned process trees never outlive their controller (shutdown and /reload).
    shutdownHeadlessChildren(pi);
    for (const running of runningSubagents.values()) {
      running.abortController?.abort();
      markSubagentInactive(running.id);
    }
    runningSubagents.clear();
    latestAgentStatuses.clear();
    const stream = (globalThis as any)[STREAM_KEY] as WatcherStream | null;
    if (stream) stream.close();
    (globalThis as any)[STREAM_KEY] = null;
    ((globalThis as any)[ABORT_KEY] as AbortController).abort();
  });

  // Steer message renderers (registered regardless of activation so past
  // session entries still render outside herdr).
  pi.registerMessageRenderer("subagent_result", (message, options, theme) =>
    renderSubagentResult(message as any, options, theme as any),
  );
  pi.registerMessageRenderer("subagent_ping", (message, options, theme) =>
    renderSubagentPing(message as any, options, theme as any),
  );
}

// ── test seam ───────────────────────────────────────────────────────────────

export const __test__ = {
  isInsideHerdr,
  runningSubagents,
  renderSubagentWidgetLines,
  resolveInterruptTarget,
  resolveResumeLaunchBehavior,
  resolveResumeOutcome,
  setDeps(overrides: Partial<RuntimeDeps>): void {
    deps = { ...deps, ...overrides };
  },
  reset(): void {
    deps = defaultDeps();
    capabilityCheck = null;
    for (const running of runningSubagents.values()) {
      running.abortController?.abort();
      markSubagentInactive(running.id);
    }
    runningSubagents.clear();
    headlessChildren.clear();
    latestAgentStatuses.clear();
    latestCtx = null;
    stopWidgetRefresh();
    const stream = (globalThis as any)[STREAM_KEY] as WatcherStream | null;
    if (stream) stream.close();
    (globalThis as any)[STREAM_KEY] = null;
    ((globalThis as any)[ABORT_KEY] as AbortController).abort();
    (globalThis as any)[ABORT_KEY] = new AbortController();
  },
};
