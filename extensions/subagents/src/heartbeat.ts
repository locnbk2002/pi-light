// Run-scoped child heartbeat (D10, red-team finding 7). The child rewrites
// `<session>.heartbeat` every HEARTBEAT_MS; the parent's watcher only trusts a
// record whose `runId` matches its own run (resume reuses the session path).
//
// Headless children also watch their controller (red-team kongming 6): a
// SIGKILLed controller cannot clean up, so each beat checks that the parent
// pid is still the same process and calls onParentGone once when it is not.
import { readFileSync, renameSync, writeFileSync } from "node:fs";

import { HEARTBEAT_MS } from "./limits.ts";

export interface HeartbeatRecord {
  runId: string;
  pid: number;
  /** Write time (ms epoch). */
  at: number;
  /** Last agent/turn/tool activity (ms epoch). */
  lastActivityAt: number;
  turn: number;
  /** Tool currently executing, or null. */
  tool: string | null;
}

export type HeartbeatActivity =
  | { kind: "agent_start" | "agent_end" | "turn_start" }
  | { kind: "tool_start"; tool: string }
  | { kind: "tool_end" };

export interface Heartbeat {
  touch(activity: HeartbeatActivity): void;
  stop(): void;
}

export interface HeartbeatTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const realTimers: HeartbeatTimers = {
  setInterval: (fn, ms) => {
    const handle = setInterval(fn, ms);
    handle.unref?.();
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

/** Atomic write: tmp file + rename, so the watcher never reads a torn record. */
function writeAtomic(file: string, record: HeartbeatRecord): void {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(record), "utf8");
    renameSync(tmp, file);
  } catch {
    // Best-effort: a missed beat is tolerated (DEAD_AFTER_MS spans 4 beats).
  }
}

/** Kernel start time of `pid` (field 22 of /proc/<pid>/stat); null when gone or a zombie. */
function processStartTime(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[0] === "Z" ? null : (fields[19] ?? null);
  } catch {
    return null;
  }
}

/**
 * Liveness check for the controller `pid`, pinned to the process seen now: a
 * reused pid is a different process (different start time) and counts as gone.
 * Without /proc it falls back to a signal-0 probe.
 */
export function watchParentProcess(pid: number): () => boolean {
  if (!Number.isInteger(pid) || pid <= 1) return () => false;
  const start = processStartTime(pid);
  const probe = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error: any) {
      return error?.code === "EPERM";
    }
  };
  if (start === null) {
    let procAvailable = false;
    try {
      readFileSync("/proc/self/stat");
      procAvailable = true;
    } catch {}
    return procAvailable ? () => false : probe;
  }
  return () => processStartTime(pid) === start;
}

export interface ParentWatch {
  parentAlive(): boolean;
  /** Called once, from the beat that first finds the parent gone. */
  onParentGone(): void;
}

export function startHeartbeat(
  file: string,
  runId: string,
  nowFn: () => number = Date.now,
  timers: HeartbeatTimers = realTimers,
  intervalMs: number = HEARTBEAT_MS,
  parent?: ParentWatch,
): Heartbeat {
  let lastActivityAt = nowFn();
  let turn = 0;
  let tool: string | null = null;
  let parentGone = false;

  const beat = () => {
    writeAtomic(file, { runId, pid: process.pid, at: nowFn(), lastActivityAt, turn, tool });
    if (!parent || parentGone) return;
    let alive = true;
    try {
      alive = parent.parentAlive();
    } catch {}
    if (alive) return;
    parentGone = true;
    try {
      parent.onParentGone();
    } catch {}
  };

  beat();
  const handle = timers.setInterval(beat, intervalMs);

  return {
    touch(activity) {
      lastActivityAt = nowFn();
      if (activity.kind === "turn_start") turn += 1;
      else if (activity.kind === "tool_start") tool = activity.tool;
      else if (activity.kind === "tool_end") tool = null;
    },
    stop() {
      timers.clearInterval(handle);
    },
  };
}
