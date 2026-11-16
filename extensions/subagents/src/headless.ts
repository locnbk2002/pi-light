// Headless backend (D10): outside herdr, a subagent runs as a detached
// background `bash <launch script>` → `pi -p` process group. The parent owns
// the whole tree: it drains stdout/stderr into a bounded in-memory tail (crash
// diagnostics) and an on-disk `<session>.log`, and kills every descendant on
// interrupt, timeout, shutdown or /reload.
//
// Ownership (OwnedTree): pi's bash tool runs commands in their own process
// groups, and they are reparented away once pi dies, so a group signal plus a
// later /proc walk can miss them. The tree records every member (pid + kernel
// start time, so a reused pid is never signalled) before each signal, and a
// run's ownership is released only after all recorded members are gone.
//
// Containment (Task 10.0c): recording cannot catch a descendant that detaches
// and outlives its parent between captures. When systemd user scopes work, a
// run launches inside its own scope (`systemd-run --user --scope` execs in
// place: pid, process group, pipes and exit code are unchanged), so every
// descendant stays in the run's cgroup. The scope is SIGKILLed when the run's
// leader exits and on stop; a run is gone only when the scope is inactive.
// Without scopes the run falls back to OwnedTree recording ("best-effort").
// Known limit: a tool that itself calls `systemd-run --user` escapes the scope.
import { execFile, spawn, spawnSync } from "node:child_process";
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
  /** Resolves true once the process exited, false after `ms` without exit. */
  waitExit(ms: number): Promise<boolean>;
  /** Every process this run started, recorded before each signal (and its scope, when contained). */
  tree: OwnedTree;
  /** "scope": a systemd user scope contains the run; "best-effort": OwnedTree recording only. */
  containment: "scope" | "best-effort";
}

const SCOPE_FLAGS = ["--user", "--scope", "--quiet", "--collect"] as const;
const SYSTEMCTL_TIMEOUT_MS = 5_000;
let scopeSupport: boolean | null = null;

/** Whether `systemd-run --user --scope` works here; probed once per process. */
export function systemdScopesAvailable(): boolean {
  if (scopeSupport === null) {
    try {
      const probe = spawnSync("systemd-run", [...SCOPE_FLAGS, "--", "true"], {
        stdio: "ignore",
        timeout: SYSTEMCTL_TIMEOUT_MS,
      });
      scopeSupport = probe.status === 0;
    } catch {
      scopeSupport = false;
    }
  }
  return scopeSupport;
}

/** The scope unit (without `.scope`) of a run. */
export function scopeUnitFor(runId: string): string {
  return `pi-subagent-${runId.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

function systemctl(args: string[]): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    execFile("systemctl", ["--user", ...args], { timeout: SYSTEMCTL_TIMEOUT_MS }, (error, stdout) => {
      resolve({ ok: !error, stdout: String(stdout ?? "") });
    });
  });
}

/** SIGKILL every process in the run's scope (never `systemctl stop`: its timeout is 90 s). */
export async function killScope(unit: string): Promise<void> {
  await systemctl(["kill", "--kill-whom=all", "--signal=SIGKILL", `${unit}.scope`]);
}

/** True only when systemd reports the scope inactive (empty and collected); errors count as active. */
export async function scopeInactive(unit: string): Promise<boolean> {
  const { stdout } = await systemctl(["is-active", `${unit}.scope`]);
  return stdout.trim() === "inactive";
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

/**
 * Spawn `bash <launchScriptFile>` detached (own process group) and drain its
 * output; inside the run's systemd scope when `runId` is given and scopes work.
 */
export function startHeadless(opts: { launchScriptFile: string; sessionFile: string; runId?: string }): HeadlessChild {
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

  const unit = opts.runId && systemdScopesAvailable() ? scopeUnitFor(opts.runId) : null;
  const child = unit
    ? spawn("systemd-run", [...SCOPE_FLAGS, "--unit", unit, "--", "bash", opts.launchScriptFile], {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      })
    : spawn("bash", [opts.launchScriptFile], {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
  // The leader exited: nothing in its scope may outlive it. Killing the scope
  // also closes output pipes a detached descendant inherited, so `close` fires.
  if (unit) child.on("exit", () => void killScope(unit));
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

  const onExit = (listener: () => void) => {
    if (code !== null) {
      queueMicrotask(listener);
      return () => {};
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  return {
    pid: child.pid ?? -1,
    exitCode: () => code,
    tail: () => ring.toString(),
    onExit,
    waitExit: (ms) =>
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          off();
          resolve(false);
        }, ms);
        const off = onExit(() => {
          clearTimeout(timer);
          resolve(true);
        });
      }),
    tree: new OwnedTree(child.pid ?? -1, unit),
    containment: unit ? "scope" : "best-effort",
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

/** Start time and process group of a live process; null when gone or a zombie. */
function procInfo(pid: number): { start: string; pgid: number } | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (fields[0] === "Z" || fields[19] === undefined) return null;
    return { start: fields[19], pgid: Number.parseInt(fields[2], 10) };
  } catch {
    return null;
  }
}

/** How long to wait for SIGKILLed members to disappear. */
const KILL_CONFIRM_MS = 2_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The process tree a headless run owns: the group leader plus every
 * descendant seen at any capture. Members are pinned to their start time, so
 * a pid reused by an unrelated process is never signalled.
 */
export class OwnedTree {
  private readonly members = new Map<number, string>();

  /** `unit`: the run's systemd scope (without `.scope`), or null for recording only. */
  constructor(
    readonly leader: number,
    readonly unit: string | null = null,
  ) {
    if (Number.isInteger(leader) && leader > 1) this.add(leader);
    this.capture();
  }

  private add(pid: number): void {
    if (this.members.has(pid)) return;
    const info = procInfo(pid);
    if (info) this.members.set(pid, info.start);
  }

  /** Recorded members that are still the same live process. */
  live(): number[] {
    return [...this.members].filter(([pid, start]) => procInfo(pid)?.start === start).map(([pid]) => pid);
  }

  /** Record every current descendant of every live member (walks only verified roots). */
  capture(): void {
    for (const root of this.live()) {
      for (const pid of listDescendants(root)) this.add(pid);
    }
  }

  private signalGroup(sig: NodeJS.Signals): void {
    // Only while a recorded member still belongs to the leader's group: never a recycled pgid.
    if (this.live().some((pid) => procInfo(pid)?.pgid === this.leader)) signal(-this.leader, sig);
  }

  /** Capture, then signal the group (SIGINT: pi aborts; the tree stays owned). */
  signal(sig: NodeJS.Signals): void {
    this.capture();
    this.signalGroup(sig);
  }

  private async waitGone(ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (this.live().length > 0) {
      if (Date.now() >= deadline) return false;
      await sleep(Math.min(25, Math.max(1, deadline - Date.now())));
    }
    return true;
  }

  /** What a cleanup warning names: the scope unit, or the leader pid. */
  describe(): string {
    return this.unit ? `${this.unit}.scope` : `pid ${this.leader}`;
  }

  /**
   * SIGTERM to the group (print mode kills its own tool children), then
   * SIGKILL to the group and every recorded member still alive after
   * `escalateMs` (contained runs: to the whole scope). Resolves true once
   * every member is gone (contained runs: once the scope is inactive).
   */
  async stop(escalateMs = KILL_ESCALATE_MS): Promise<boolean> {
    if (this.unit) return this.stopScope(this.unit, escalateMs);
    this.capture();
    if (this.live().length === 0) return true;
    this.signalGroup("SIGTERM");
    if (await this.waitGone(escalateMs)) return true;
    this.capture();
    this.signalGroup("SIGKILL");
    for (const pid of this.live()) signal(pid, "SIGKILL");
    return this.waitGone(KILL_CONFIRM_MS);
  }

  /** Group SIGTERM grace, then SIGKILL the whole scope; true only once the scope is inactive. */
  private async stopScope(unit: string, escalateMs: number): Promise<boolean> {
    if (await scopeInactive(unit)) return true;
    this.signal("SIGTERM");
    const grace = Date.now() + escalateMs;
    while (Date.now() < grace) {
      await sleep(Math.min(50, Math.max(1, grace - Date.now())));
      if (await scopeInactive(unit)) return true;
    }
    await killScope(unit);
    const confirm = Date.now() + KILL_CONFIRM_MS;
    for (;;) {
      if (await scopeInactive(unit)) return true;
      if (Date.now() >= confirm) return false;
      await sleep(50);
    }
  }
}

/** Stop a process tree not started by startHeadless (descendants captured before the first signal). */
export function killTree(pid: number, escalateMs = KILL_ESCALATE_MS): Promise<boolean> {
  return new OwnedTree(pid).stop(escalateMs);
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
