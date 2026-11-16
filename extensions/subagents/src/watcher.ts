// Per-subagent completion watcher — implements the lifecycle classification
// matrix from PLAN.md exactly. Hard requirement 4: every signal path terminates
// the watch; there is NO path to an eternal "stalled" zombie.
//
// Three signal sources, first one wins (latecomers no-op):
//   (a) HerdrEventStream pane_exited/pane_closed for this pane — primary.
//   (b) fs.watch + slow poll on the session dir for the sidecar files. In the
//       startup-crash hold-open case the pane stays alive, so the exitcode
//       sidecar is the ONLY signal.
//   (c) the stream's reconcile hook (fired after a socket reconnect —
//       events.subscribe has no replay) plus the slow poll → pane existence
//       check; a watched-but-missing pane exited during the gap.
//
// Semantic sidecars (written by the child / wrapper script):
//   <sessionFile>.exit     — {"type":"done"[,"summary"]}, {"type":"failed","reason"}
//                            or {"type":"ping","name","message"}
//                            written by subagent-done.ts before the child exits.
//                            A `summary` is the child's explicit handoff and
//                            wins over the transcript (see SummarySource).
//   <sessionFile>.exitcode — process exit code, written by the wrapper script
//                            (pane.exited carries no exit code — verified).
//
// The watcher consumes (deletes) both sidecars when it resolves from them so a
// later resume of the same session cannot see stale completion signals. It
// does NOT touch the runningSubagents map — removal is the caller's job.
//
// Pane text is never used for lifecycle detection. A bounded, best-effort
// `pane read` captures diagnostics only after a failure has been classified.
//
// pi-light additions (D10):
//   - headless runs (`deps.headless`) classify from the run's own session
//     entries and stop reason, because `pi -p` exits 0 on errors too;
//   - `deps.liveness` adds the run-scoped heartbeat check (crashed), a single
//     non-terminal stall warning, and the hard run limit (timed-out), with
//     suspend tolerance (a long gap between ticks extends every deadline).
import { readFileSync, rmSync, watch as fsWatch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";

import type { PaneInfo } from "./herdr/client.ts";
import { findLastAssistantMessage, findLastAssistantOutcome, getNewEntries } from "./session.ts";

export interface RunningSubagent {
  id: string;
  name: string;
  task: string;
  agent?: string;
  paneId: string;
  startTime: number;
  sessionFile: string;
  launchScriptFile: string;
  interactive: boolean;
  autoExit: boolean;
  abortController?: AbortController;
  /** "herdr" (pane) or "headless" (background `pi -p`). Default herdr. */
  backend?: "herdr" | "headless";
  /** Headless only: process-group leader pid. */
  pid?: number;
}

/**
 * Where a `completed` summary came from:
 *   "sidecar"    — the child passed it to `subagent_done`; authoritative, and
 *                  immune to transcript timing (see subagent-done.ts header).
 *   "transcript" — fallback: last assistant text block on disk at settle time.
 *                  Used for auto-exit children and pre-summary child extensions.
 */
export type SummarySource = "sidecar" | "transcript";

export type SubagentOutcome =
  | { kind: "completed"; summary: string; exitCode: 0; summarySource: SummarySource }
  | { kind: "completed-user-exit"; summary: string; exitCode: 0 } // no .exit sidecar
  | { kind: "ping"; name: string; message: string }
  | { kind: "launch-failed"; exitCode: number; heldOpen: boolean; paneOutput: string | null }
  | {
      kind: "crashed";
      exitCode: number;
      summary: string | null;
      paneOutput: string | null;
      /** Set when the crash was inferred (e.g. dead heartbeat) rather than exited. */
      reason?: string;
    }
  | {
      kind: "failed";
      reason: string;
      exitCode: number | null;
      summary: string | null;
      paneOutput: string | null;
    }
  | { kind: "timed-out"; summary: string | null; elapsedMs: number }
  | { kind: "pane-killed"; summary: string | null }
  | { kind: "gap-exit"; summary: string | null; exitCode: number | null }
  | { kind: "cancelled" };

export interface WatcherDeps {
  client: {
    paneGet(paneId: string): Promise<PaneInfo | null>;
    paneRead(paneId: string, lines: number, signal?: AbortSignal): Promise<string | null>;
    paneList(): Promise<PaneInfo[]>;
  };
  stream: {
    watch(paneId: string, listener: (ev: { event: "pane_exited" | "pane_closed"; paneId: string }) => void): () => void;
    onReconcile(cb: () => void): () => void;
  };
  signal: AbortSignal;
  /** Slow-poll backstop interval (default 5s). */
  pollIntervalMs?: number;
  /** Startup-crash window: nonzero exit inside it with an empty session = launch failure (default 15s). */
  startupWindowMs?: number;
  /** Clock seam for tests. */
  now?: () => number;
  /** Headless backend: classify from the run's session entries, not pane state. */
  headless?: HeadlessProbe;
  /** Heartbeat / stall / run-limit supervision. */
  liveness?: LivenessDeps;
}

export interface HeadlessProbe {
  /** Session entries that existed before this run (resume): ignored. */
  entryOffset: number;
  /** Process exit code, or null while the process is still running. */
  exitCode(): number | null;
  /** Bounded stdout/stderr tail for failure diagnostics. */
  tail(): string;
}

export interface LivenessDeps {
  heartbeatFile: string;
  deadAfterMs: number;
  stallWarnMs: number;
  maxRunMs: number;
  timeoutGraceMs: number;
  /** Interactive children are exempt from maxRunMs. */
  exemptFromMaxRun: boolean;
  /** One non-terminal stall notice per run. */
  onStall(info: { idleMs: number }): void;
  /** Graceful stop request (headless: SIGINT to the group; herdr: Escape). */
  interrupt(): void | Promise<void>;
  /** Hard stop after the grace period (headless: killTree; herdr: close pane). */
  kill(): void | Promise<void>;
}

/** Final assistant text kept in a headless outcome. */
export const MAX_SUMMARY_BYTES = 50 * 1024;

function truncateSummary(text: string): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= MAX_SUMMARY_BYTES) return text;
  return `${buf.subarray(0, MAX_SUMMARY_BYTES).toString("utf8")}\n… [truncated at 50 KB]`;
}

interface HeartbeatRecord {
  runId?: unknown;
  at?: unknown;
  lastActivityAt?: unknown;
}

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_STARTUP_WINDOW_MS = 15_000;
const PANE_TAIL_LINES = 20;
const PANE_CAPTURE_TIMEOUT_MS = 100;

type Trigger = "event" | "sidecar" | "gone";

export function watchSubagent(
  running: RunningSubagent,
  deps: WatcherDeps,
): Promise<SubagentOutcome> {
  return new Promise((resolve) => {
    const now = deps.now ?? Date.now;
    const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const startupWindowMs = deps.startupWindowMs ?? DEFAULT_STARTUP_WINDOW_MS;
    const exitFile = `${running.sessionFile}.exit`;
    const exitcodeFile = `${running.sessionFile}.exitcode`;

    let done = false;
    let paneEventSeen = false;
    /** Run limit hit: only the grace timer may settle from now on. */
    let timingOut = false;
    const cleanups: Array<() => void> = [];

    function finish(outcome: SubagentOutcome, consumeSidecars: boolean): void {
      if (done) return;
      done = true;
      for (const cleanup of cleanups) {
        try {
          cleanup();
        } catch {
          // best-effort teardown
        }
      }
      if (consumeSidecars) {
        try {
          rmSync(exitFile, { force: true });
        } catch {}
        try {
          rmSync(exitcodeFile, { force: true });
        } catch {}
      }
      resolve(outcome);
    }

    if (deps.signal.aborted) {
      finish({ kind: "cancelled" }, false);
      return;
    }

    // ── on-disk state readers (session file is written incrementally → crash-safe) ──

    function readSessionEntries() {
      try {
        return getNewEntries(running.sessionFile, 0);
      } catch {
        return [];
      }
    }

    function readSummary(): string | null {
      return findLastAssistantMessage(readSessionEntries());
    }

    /**
     * Capture diagnostics while a failed pane may still exist. The strict time
     * budget keeps a slow or wedged herdr CLI from delaying the failure steer.
     */
    function capturePaneTail(): Promise<string | null> {
      return new Promise((resolveCapture) => {
        let settled = false;
        const controller = new AbortController();
        const settle = (output: string | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolveCapture(output);
        };
        const timer = setTimeout(() => {
          controller.abort();
          settle(null);
        }, PANE_CAPTURE_TIMEOUT_MS);
        timer.unref?.();

        try {
          void deps.client
            .paneRead(running.paneId, PANE_TAIL_LINES, controller.signal)
            .then(settle, () => settle(null));
        } catch {
          settle(null);
        }
      });
    }

    function readExitSidecar(): {
      type?: string;
      name?: string;
      message?: string;
      summary?: string;
      reason?: unknown;
    } | null {
      try {
        return JSON.parse(readFileSync(exitFile, "utf8"));
      } catch {
        return null;
      }
    }

    /**
     * Parse the wrapper's exitcode sidecar. Current wrappers write
     * "<code> <run id>"; wrappers from before id stamping wrote "<code>".
     * A stamped id makes ownership decidable without inferring it from pane
     * liveness (see the stale-sidecar guard in trySettle).
     */
    function readExitCode(): { code: number; id: string | null } | null {
      try {
        const raw = readFileSync(exitcodeFile, "utf8").trim();
        const [codeText, idText] = raw.split(/\s+/, 2);
        const parsed = Number.parseInt(codeText, 10);
        return Number.isFinite(parsed) ? { code: parsed, id: idText || null } : null;
      } catch {
        return null;
      }
    }

    // Set by classify(): true when the exitcode sidecar it accepted carried our
    // run id, so ownership is proven and the liveness guard can be skipped.
    let exitcodeIdMatched = false;

    // ── classification matrix (normative — PLAN.md) ──

    function classify(trigger: Trigger): SubagentOutcome | null {
      const exitData = readExitSidecar();
      if (exitData?.type === "ping") {
        return {
          kind: "ping",
          name: exitData.name ?? running.name,
          message: exitData.message ?? "",
        };
      }
      if (exitData?.type === "failed") {
        // An auto-exit child that stopped on anything but a clean `stop`.
        const reason = typeof exitData.reason === "string" && exitData.reason.trim()
          ? exitData.reason.trim().slice(0, 200)
          : "unknown stop reason";
        const summary = readSummary();
        return {
          kind: "failed",
          reason,
          exitCode: null,
          summary: summary ? truncateSummary(summary) : null,
          paneOutput: null,
        };
      }
      if (exitData?.type === "done") {
        const sidecarSummary =
          typeof exitData.summary === "string" ? exitData.summary.trim() : "";
        if (sidecarSummary !== "") {
          return {
            kind: "completed",
            summary: sidecarSummary,
            exitCode: 0,
            summarySource: "sidecar",
          };
        }
        return {
          kind: "completed",
          summary: readSummary() ?? "Sub-agent exited without output",
          exitCode: 0,
          summarySource: "transcript",
        };
      }

      if (deps.headless) return classifyHeadless(deps.headless);

      const exitInfo = readExitCode();
      if (exitInfo !== null) {
        // A sidecar stamped with a different run's id is definitively not ours
        // (resume reuses the session path). Consume it and keep watching.
        if (exitInfo.id !== null && exitInfo.id !== running.id) {
          try {
            rmSync(exitcodeFile, { force: true });
          } catch {}
          return null;
        }
        exitcodeIdMatched = exitInfo.id !== null;
        const exitCode = exitInfo.code;
        if (exitCode === 0) {
          // No .exit sidecar → the user drove the session and quit pi normally.
          return {
            kind: "completed-user-exit",
            summary: readSummary() ?? "Sub-agent exited without output",
            exitCode: 0,
          };
        }
        const withinStartupWindow = now() - running.startTime < startupWindowMs;
        if (withinStartupWindow && readSessionEntries().length === 0) {
          // Startup crash (e.g. bad --model). If the wrapper's hold-open kept
          // the pane alive, no pane event has fired — the sidecar is the signal.
          return {
            kind: "launch-failed",
            exitCode,
            heldOpen: !paneEventSeen,
            paneOutput: null,
          };
        }
        return { kind: "crashed", exitCode, summary: readSummary(), paneOutput: null };
      }

      // No sidecars at all.
      if (trigger === "event") {
        // The wrapper script always writes the exitcode sidecar before its pane
        // exits, so pane death without sidecars means it was killed externally.
        return { kind: "pane-killed", summary: readSummary() };
      }
      if (trigger === "gone") {
        // Watched pane vanished while the event stream was down (no replay).
        return { kind: "gap-exit", summary: readSummary(), exitCode: null };
      }
      return null; // sidecar trigger without sidecars — not a signal
    }

    /** Headless order: .exit done (above) → run's last assistant message → exit code. */
    function classifyHeadless(probe: HeadlessProbe): SubagentOutcome | null {
      const exitInfo = readExitCode();
      if (exitInfo !== null && exitInfo.id !== null && exitInfo.id !== running.id) {
        try {
          rmSync(exitcodeFile, { force: true });
        } catch {}
        return null;
      }
      // Wait for the process (and its drained stdio) even if the wrapper's
      // exitcode sidecar already landed; the close event re-triggers us.
      const processExit = probe.exitCode();
      if (processExit === null) return null;
      const exitCode = exitInfo?.code ?? processExit;

      let entries: ReturnType<typeof getNewEntries> = [];
      try {
        entries = getNewEntries(running.sessionFile, probe.entryOffset);
      } catch {}
      const last = findLastAssistantOutcome(entries);
      if (last) {
        if (last.stopReason === "stop") {
          return {
            kind: "completed",
            summary: truncateSummary(last.text || "Sub-agent exited without output"),
            exitCode: 0,
            summarySource: "transcript",
          };
        }
        return {
          kind: "failed",
          reason: last.stopReason ?? "unknown stop reason",
          exitCode,
          summary: last.text ? truncateSummary(last.text) : null,
          paneOutput: probe.tail(),
        };
      }
      return {
        kind: "failed",
        reason: exitCode === 0 ? "exited without output" : `exit code ${exitCode}`,
        exitCode,
        summary: null,
        paneOutput: probe.tail(),
      };
    }

    let staleCheckInFlight = false;
    let paneCaptureInFlight = false;

    function finishWithDiagnostics(outcome: SubagentOutcome, consumeSidecars: boolean): void {
      if (outcome.kind !== "launch-failed" && outcome.kind !== "crashed") {
        finish(outcome, consumeSidecars);
        return;
      }
      if (paneCaptureInFlight) return;
      paneCaptureInFlight = true;
      void capturePaneTail().then((paneOutput) => {
        if (done) return;
        finish({ ...outcome, paneOutput }, consumeSidecars);
      });
    }

    function trySettle(trigger: Trigger): void {
      if (done || timingOut) return;
      const outcome = classify(trigger);
      if (!outcome) return;

      // Stale-sidecar guard (verified live in the resume race): resuming a
      // session whose previous pi is still tearing down can see the OLD
      // wrapper's exit-0 sidecar land AFTER subagent_resume cleared it. An
      // exit-0 wrapper closes its pane immediately, so exit 0 signalled by a
      // sidecar while OUR pane is still alive cannot be ours — consume it and
      // keep watching. (Nonzero exits pass through: hold-open keeps the pane
      // alive on purpose, and pane events/reconcile prove the pane is gone.)
      // Only needed for unstamped (pre-id) sidecars; a matching stamped id
      // already proves the sidecar is ours.
      if (outcome.kind === "completed-user-exit" && trigger === "sidecar" && !exitcodeIdMatched) {
        if (staleCheckInFlight) return;
        staleCheckInFlight = true;
        void deps.client
          .paneGet(running.paneId)
          .then((pane) => {
            if (done) return;
            if (pane !== null) {
              try {
                rmSync(exitcodeFile, { force: true });
              } catch {}
              return;
            }
            finish(outcome, true);
          })
          .catch(() => {
            // herdr unreachable — keep watching; the next signal retries
          })
          .finally(() => {
            staleCheckInFlight = false;
          });
        return;
      }

      finishWithDiagnostics(outcome, true);
    }

    // ── signal source (a): pane events ──

    const unwatch = deps.stream.watch(running.paneId, () => {
      paneEventSeen = true;
      trySettle("event");
    });
    cleanups.push(unwatch);

    // ── signal source (b): sidecar appearance (fs.watch + slow poll backstop) ──

    let fsWatcher: FSWatcher | null = null;
    try {
      const sidecarNames = new Set([basename(exitFile), basename(exitcodeFile)]);
      fsWatcher = fsWatch(dirname(running.sessionFile), (_eventType, filename) => {
        if (filename == null || sidecarNames.has(filename)) trySettle("sidecar");
      });
      fsWatcher.on("error", () => {});
      cleanups.push(() => fsWatcher?.close());
    } catch {
      // session dir may not exist yet; the slow poll still covers sidecars
    }

    async function checkPaneGone(list: boolean): Promise<void> {
      try {
        const gone = list
          ? !(await deps.client.paneList()).some((pane) => pane.pane_id === running.paneId)
          : (await deps.client.paneGet(running.paneId)) === null;
        if (!done && gone) trySettle("gone");
      } catch {
        // herdr unreachable — keep watching; next poll retries
      }
    }

    // ── liveness: run-scoped heartbeat, stall warning, hard run limit ──

    const startedAt = now();
    let prevTick = startedAt;
    let suspendedTotal = 0;
    /** Watcher-clock time we last saw this run's heartbeat advance (or launch). */
    let lastAliveMark = startedAt;
    let lastHeartbeatAt: number | null = null;
    let lastActivityAt = startedAt;
    let stallWarned = false;

    function readHeartbeat(file: string): HeartbeatRecord | null {
      try {
        return JSON.parse(readFileSync(file, "utf8")) as HeartbeatRecord;
      } catch {
        return null;
      }
    }

    function startTimeout(liveness: LivenessDeps, t: number): void {
      timingOut = true;
      void Promise.resolve()
        .then(() => liveness.interrupt())
        .catch(() => {});
      const grace = setTimeout(() => {
        if (done) return;
        const exitData = readExitSidecar();
        const sidecarSummary =
          exitData?.type === "done" && typeof exitData.summary === "string" && exitData.summary.trim()
            ? exitData.summary.trim()
            : null;
        void Promise.resolve()
          .then(() => liveness.kill())
          .catch(() => {});
        finish(
          {
            kind: "timed-out",
            summary: sidecarSummary ?? readSummary(),
            elapsedMs: t - startedAt - suspendedTotal,
          },
          true,
        );
      }, liveness.timeoutGraceMs);
      cleanups.push(() => clearTimeout(grace));
    }

    function livenessTick(liveness: LivenessDeps): void {
      const t = now();
      const gap = t - prevTick;
      prevTick = t;
      if (gap > 2 * pollIntervalMs) {
        // Laptop suspend (or a stalled event loop): extend every deadline by
        // the missing time and skip judging liveness on this tick.
        const missing = gap - pollIntervalMs;
        suspendedTotal += missing;
        lastAliveMark += missing;
        lastActivityAt += missing;
        return;
      }

      const hb = readHeartbeat(liveness.heartbeatFile);
      if (hb && hb.runId === running.id && typeof hb.at === "number") {
        if (hb.at !== lastHeartbeatAt) {
          lastHeartbeatAt = hb.at;
          lastAliveMark = t;
        }
        if (typeof hb.lastActivityAt === "number" && hb.lastActivityAt > lastActivityAt) {
          lastActivityAt = hb.lastActivityAt;
        }
      }

      if (t - lastAliveMark > liveness.deadAfterMs) {
        finish(
          {
            kind: "crashed",
            exitCode: -1,
            summary: readSummary(),
            paneOutput: deps.headless ? deps.headless.tail() : null,
            reason: `no heartbeat for ${Math.round((t - lastAliveMark) / 1000)}s`,
          },
          false,
        );
        return;
      }

      if (!stallWarned && t - lastActivityAt > liveness.stallWarnMs) {
        stallWarned = true;
        try {
          liveness.onStall({ idleMs: t - lastActivityAt });
        } catch {}
      }

      if (!liveness.exemptFromMaxRun && t - startedAt - suspendedTotal > liveness.maxRunMs) {
        startTimeout(liveness, t);
      }
    }

    const pollTimer = setInterval(() => {
      if (done || timingOut) return;
      trySettle("sidecar");
      if (done) return;
      if (deps.liveness) {
        livenessTick(deps.liveness);
        if (done || timingOut) return;
      }
      void checkPaneGone(false);
    }, pollIntervalMs);
    cleanups.push(() => clearInterval(pollTimer));

    // ── signal source (c): reconcile after event-stream reconnect ──

    const offReconcile = deps.stream.onReconcile(() => {
      if (done) return;
      void checkPaneGone(true);
    });
    cleanups.push(offReconcile);

    // ── abort (orchestrator shutdown / interrupt) ──

    const onAbort = () => finish({ kind: "cancelled" }, false);
    deps.signal.addEventListener("abort", onAbort, { once: true });
    cleanups.push(() => deps.signal.removeEventListener("abort", onAbort));

    // Sidecars may already be on disk when the watcher arms (fast child, or
    // re-arming after a reconnect) — check immediately.
    queueMicrotask(() => trySettle("sidecar"));
  });
}
