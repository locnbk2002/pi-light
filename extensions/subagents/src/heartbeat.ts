// Run-scoped child heartbeat (D10, red-team finding 7). The child rewrites
// `<session>.heartbeat` every HEARTBEAT_MS; the parent's watcher only trusts a
// record whose `runId` matches its own run (resume reuses the session path).
import { renameSync, writeFileSync } from "node:fs";

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

export function startHeartbeat(
  file: string,
  runId: string,
  nowFn: () => number = Date.now,
  timers: HeartbeatTimers = realTimers,
  intervalMs: number = HEARTBEAT_MS,
): Heartbeat {
  let lastActivityAt = nowFn();
  let turn = 0;
  let tool: string | null = null;

  const beat = () =>
    writeAtomic(file, { runId, pid: process.pid, at: nowFn(), lastActivityAt, turn, tool });

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
