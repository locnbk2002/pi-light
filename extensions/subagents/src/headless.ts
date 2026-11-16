// Headless backend (D10): outside herdr, a subagent runs as a detached
// background `bash <launch script>` → `pi -p` process group. The parent owns
// the whole tree: it drains stdout/stderr into a bounded in-memory tail (crash
// diagnostics) and an on-disk `<session>.log`, and kills every descendant on
// interrupt, timeout, shutdown or /reload.
import { spawn } from "node:child_process";
import { createWriteStream, readdirSync, readFileSync, type WriteStream } from "node:fs";

import { KILL_ESCALATE_MS } from "./limits.ts";
import type { HeadlessProbe, WatcherDeps } from "./watcher.ts";

/** In-memory crash tail per child. */
export const TAIL_BYTES = 64 * 1024;

export interface HeadlessChild {
  pid: number;
  /** Exit code once exited (signal deaths map to 128 + signo), else null. */
  exitCode(): number | null;
  /** Last TAIL_BYTES of combined stdout/stderr. */
  tail(): string;
  /** Called once when the process exits (immediately if it already has). */
  onExit(listener: () => void): () => void;
}

/** Fixed-size byte ring: keeps only the newest `capacity` bytes. */
export class RingBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  constructor(private readonly capacity: number) {}

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.capacity && this.chunks.length > 0) {
      const head = this.chunks[0];
      const excess = this.size - this.capacity;
      if (head.length <= excess) {
        this.chunks.shift();
        this.size -= head.length;
      } else {
        this.chunks[0] = head.subarray(excess);
        this.size -= excess;
      }
    }
  }

  toString(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

const SIGNAL_NUMBERS: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 };

/** Spawn `bash <launchScriptFile>` detached (own process group) and drain its output. */
export function startHeadless(opts: { launchScriptFile: string; sessionFile: string }): HeadlessChild {
  const ring = new RingBuffer(TAIL_BYTES);
  let log: WriteStream | null = null;
  try {
    log = createWriteStream(`${opts.sessionFile}.log`, { flags: "a" });
    log.on("error", () => {
      log = null;
    });
  } catch {
    log = null;
  }

  let code: number | null = null;
  const listeners = new Set<() => void>();
  const settle = (value: number) => {
    if (code !== null) return;
    code = value;
    log?.end();
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {}
    }
    listeners.clear();
  };

  const child = spawn("bash", [opts.launchScriptFile], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const drain = (chunk: Buffer) => {
    ring.push(chunk);
    log?.write(chunk);
  };
  child.stdout?.on("data", drain);
  child.stderr?.on("data", drain);
  child.on("error", (error) => {
    ring.push(Buffer.from(`\n[pi-light] failed to start subagent: ${error.message}\n`));
    settle(127);
  });
  child.on("close", (exit, signal) => {
    settle(exit ?? (signal ? 128 + (SIGNAL_NUMBERS[signal] ?? 0) : 1));
  });
  // The controller must not stay alive just for its children (it kills them on shutdown).
  child.unref();

  return {
    pid: child.pid ?? -1,
    exitCode: () => code,
    tail: () => ring.toString(),
    onExit(listener) {
      if (code !== null) {
        queueMicrotask(listener);
        return () => {};
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Every live descendant of `pid`, walking /proc/<pid>/task/<tid>/children recursively. */
export function listDescendants(pid: number): number[] {
  const seen = new Set<number>();
  const stack = [pid];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let tasks: string[] = [];
    try {
      tasks = readdirSync(`/proc/${current}/task`);
    } catch {
      continue;
    }
    for (const task of tasks) {
      let raw = "";
      try {
        raw = readFileSync(`/proc/${current}/task/${task}/children`, "utf8");
      } catch {
        continue;
      }
      for (const token of raw.split(/\s+/)) {
        const child = Number.parseInt(token, 10);
        if (Number.isInteger(child) && child > 0 && !seen.has(child)) {
          seen.add(child);
          stack.push(child);
        }
      }
    }
  }
  return [...seen];
}

function signal(target: number, sig: NodeJS.Signals): void {
  try {
    process.kill(target, sig);
  } catch {
    // already gone
  }
}

/**
 * Kill a headless process tree. SIGTERM goes to the group first (print mode
 * then kills its own detached tool children); after `escalateMs` SIGKILL goes
 * to the group and to every descendant found before the TERM (bash tool
 * children run in their own process groups and get reparented once their
 * parent dies, so they must be captured up front) or still present now.
 */
export async function killTree(pid: number, escalateMs = KILL_ESCALATE_MS): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 1) return;
  const initial = listDescendants(pid);
  signal(-pid, "SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, escalateMs));
  const remaining = new Set([...initial, ...listDescendants(pid)]);
  signal(-pid, "SIGKILL");
  signal(pid, "SIGKILL");
  for (const descendant of remaining) signal(descendant, "SIGKILL");
}

/** Graceful interrupt: SIGINT to the group so pi aborts its running tools. */
export function interruptTree(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 1) return;
  signal(-pid, "SIGINT");
}

/** Adapt a headless child to the watcher's herdr-shaped client/stream seams. */
export function headlessWatcherDeps(
  child: HeadlessChild,
  paneId: string,
  entryOffset: number,
): Pick<WatcherDeps, "client" | "stream"> & { headless: HeadlessProbe } {
  const alive = () => child.exitCode() === null;
  return {
    client: {
      paneGet: async () => (alive() ? { pane_id: paneId } : null),
      paneRead: async () => child.tail(),
      paneList: async () => (alive() ? [{ pane_id: paneId }] : []),
    },
    stream: {
      watch: (_paneId, listener) => child.onExit(() => listener({ event: "pane_exited", paneId })),
      onReconcile: () => () => {},
    },
    headless: { entryOffset, exitCode: () => child.exitCode(), tail: () => child.tail() },
  };
}
