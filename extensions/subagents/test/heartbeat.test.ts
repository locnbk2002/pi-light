import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { startHeartbeat, type HeartbeatTimers } from "../src/heartbeat.ts";
import { HEARTBEAT_MS } from "../src/limits.ts";
import {
  watchSubagent,
  type LivenessDeps,
  type RunningSubagent,
  type SubagentOutcome,
} from "../src/watcher.ts";

const roots: string[] = [];
const timers: Array<ReturnType<typeof setInterval>> = [];
afterEach(() => {
  while (timers.length) clearInterval(timers.pop()!);
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "heartbeat-"));
  roots.push(dir);
  return dir;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("heartbeat writer", () => {
  it("rewrites every HEARTBEAT_MS with runId; lastActivityAt changes only on touch", () => {
    const file = join(tempDir(), "s.jsonl.heartbeat");
    let clock = 1_000;
    let tick: (() => void) | null = null;
    let intervalMs = 0;
    const fakeTimers: HeartbeatTimers = {
      setInterval(fn, ms) {
        tick = fn;
        intervalMs = ms;
        return 1;
      },
      clearInterval() {
        tick = null;
      },
    };
    const hb = startHeartbeat(file, "run-1", () => clock, fakeTimers);
    assert.equal(intervalMs, HEARTBEAT_MS);
    const read = () => JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(
      { runId: read().runId, at: read().at, lastActivityAt: read().lastActivityAt },
      { runId: "run-1", at: 1_000, lastActivityAt: 1_000 },
    );

    clock += HEARTBEAT_MS;
    tick!();
    assert.equal(read().at, 1_000 + HEARTBEAT_MS);
    assert.equal(read().lastActivityAt, 1_000, "a plain beat does not count as activity");

    clock += 1;
    hb.touch({ kind: "tool_start", tool: "bash" });
    clock += HEARTBEAT_MS;
    tick!();
    assert.equal(read().lastActivityAt, 1_000 + HEARTBEAT_MS + 1);
    assert.equal(read().tool, "bash");
    assert.equal(read().pid, process.pid);

    hb.stop();
    assert.equal(tick, null);
  });
});

// ── watcher liveness (fake clock: each liveness tick advances it by POLL) ──

const POLL = 10;

function makeRun(dir: string, overrides: Partial<RunningSubagent> = {}): RunningSubagent {
  const sessionFile = join(dir, "child.jsonl");
  writeFileSync(sessionFile, "");
  return {
    id: "run-1",
    name: "Worker",
    task: "t",
    paneId: "headless:run-1",
    startTime: 0,
    sessionFile,
    launchScriptFile: join(dir, "x.sh"),
    interactive: false,
    autoExit: true,
    ...overrides,
  };
}

function watch(
  running: RunningSubagent,
  liveness: Partial<LivenessDeps>,
  clock: { now: number; jumpOnce?: number },
) {
  const abort = new AbortController();
  const calls = { stall: 0, interrupt: 0, kill: 0 };
  const outcome = watchSubagent(running, {
    client: {
      paneGet: async () => ({ pane_id: running.paneId }),
      paneRead: async () => "",
      paneList: async () => [{ pane_id: running.paneId }],
    },
    stream: { watch: () => () => {}, onReconcile: () => () => {} },
    signal: abort.signal,
    pollIntervalMs: POLL,
    now: () => {
      clock.now += POLL;
      if (clock.jumpOnce) {
        clock.now += clock.jumpOnce;
        clock.jumpOnce = 0;
      }
      return clock.now;
    },
    liveness: {
      heartbeatFile: `${running.sessionFile}.heartbeat`,
      deadAfterMs: 100_000,
      stallWarnMs: 100_000,
      maxRunMs: 100_000,
      timeoutGraceMs: 20,
      exemptFromMaxRun: false,
      onStall: () => void (calls.stall += 1),
      interrupt: () => void (calls.interrupt += 1),
      kill: () => void (calls.kill += 1),
      ...liveness,
    },
  });
  return { outcome, abort, calls };
}

/** Child heartbeat writer stand-in: a fresh `at` every 5 real ms. */
function beat(file: string, runId: string, lastActivityAt = 0): void {
  let at = 0;
  const handle = setInterval(() => {
    at += 1;
    writeFileSync(file, JSON.stringify({ runId, pid: 1, at, lastActivityAt, turn: 0, tool: null }));
  }, 5);
  timers.push(handle);
}

async function settledWithin(outcome: Promise<SubagentOutcome>, ms: number): Promise<SubagentOutcome | "pending"> {
  return Promise.race([outcome, sleep(ms).then(() => "pending" as const)]);
}

describe("watcher liveness", () => {
  it("a stale heartbeat of this run → crashed with the reason", async () => {
    const dir = tempDir();
    const running = makeRun(dir);
    writeFileSync(`${running.sessionFile}.heartbeat`, JSON.stringify({ runId: "run-1", at: 1 }));
    const { outcome } = watch(running, { deadAfterMs: 100 }, { now: 0 });
    const result = await settledWithin(outcome, 2_000);
    assert.notEqual(result, "pending");
    assert.equal((result as SubagentOutcome).kind, "crashed");
    assert.match((result as any).reason, /no heartbeat/);
  });

  it("a stale foreign heartbeat does not crash a resumed run that beats", async () => {
    const dir = tempDir();
    const running = makeRun(dir);
    const file = `${running.sessionFile}.heartbeat`;
    writeFileSync(file, JSON.stringify({ runId: "previous-run", at: 1 }));
    const { outcome, abort } = watch(running, { deadAfterMs: 100 }, { now: 0 });
    await sleep(40); // the resumed child starts beating within the grace
    beat(file, "run-1");
    assert.equal(await settledWithin(outcome, 300), "pending");
    abort.abort();
    assert.equal((await outcome).kind, "cancelled");
  });

  it("idle but alive → exactly one stall notice and no outcome", async () => {
    const dir = tempDir();
    const running = makeRun(dir);
    beat(`${running.sessionFile}.heartbeat`, "run-1", 0);
    const { outcome, abort, calls } = watch(running, { stallWarnMs: 50 }, { now: 0 });
    assert.equal(await settledWithin(outcome, 300), "pending");
    assert.equal(calls.stall, 1);
    abort.abort();
    assert.equal((await outcome).kind, "cancelled");
  });

  it("timed-out at maxRunMs: interrupt, grace, kill", async () => {
    const dir = tempDir();
    const running = makeRun(dir);
    beat(`${running.sessionFile}.heartbeat`, "run-1");
    const { outcome, calls } = watch(running, { maxRunMs: 100 }, { now: 0 });
    const result = await settledWithin(outcome, 2_000);
    assert.equal((result as SubagentOutcome).kind, "timed-out");
    assert.ok((result as any).elapsedMs > 100);
    assert.equal(calls.interrupt, 1);
    assert.equal(calls.kill, 1);
  });

  it("a 10-minute tick gap (suspend) neither crashes nor times out, and extends the deadline", async () => {
    const dir = tempDir();
    const running = makeRun(dir);
    beat(`${running.sessionFile}.heartbeat`, "run-1");
    const clock = { now: 0, jumpOnce: 0 };
    const { outcome } = watch(running, { deadAfterMs: 100, maxRunMs: 200 }, clock);
    await sleep(30);
    clock.jumpOnce = 600_000;
    const result = await settledWithin(outcome, 3_000);
    assert.equal((result as SubagentOutcome).kind, "timed-out", "the run still ends at its own deadline");
    assert.ok((result as any).elapsedMs < 1_000, "suspended time is not charged to the run");
  });

  it("interactive children are exempt from the run limit", async () => {
    const dir = tempDir();
    const running = makeRun(dir, { interactive: true });
    beat(`${running.sessionFile}.heartbeat`, "run-1");
    const { outcome, abort, calls } = watch(running, { maxRunMs: 50, exemptFromMaxRun: true }, { now: 0 });
    assert.equal(await settledWithin(outcome, 300), "pending");
    assert.equal(calls.interrupt, 0);
    abort.abort();
    await outcome;
  });
});
