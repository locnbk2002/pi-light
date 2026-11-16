// Kill ownership of headless runs (Phase 10 Task 10.0b fixes 6 and 12): every
// process a run started is captured before it is signalled, stopped before its
// ownership is dropped, and shutdown waits for TERM→KILL. Children also exit
// on their own when the controller disappears.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import herdrSubagents, { __test__ } from "../index.ts";
import { buildLaunchPlan, type LaunchPlanContext } from "../src/launch.ts";
import { parentWatchFromEnv } from "../subagent-done.ts";

const ENV_KEYS = [
  "HERDR_ENV",
  "HERDR_PANE_ID",
  "HERDR_SOCKET_PATH",
  "PI_CODING_AGENT_DIR",
  "PI_HERDR_PI_BIN",
  "PI_DENY_TOOLS",
  "PI_SUBAGENT_AGENT",
  "FAKE_DETACH",
  "FAKE_IGNORE_TERM",
] as const;
const savedEnv = new Map<string, string | undefined>();
let root = "";

// Records its own pid; optionally ignores TERM and/or leaves a detached (setsid) tool process.
const FAKE_PI = `#!/bin/bash
session=""
while [ $# -gt 0 ]; do
  case "$1" in
    --session) session="$2"; shift 2 ;;
    *) shift ;;
  esac
done
echo $$ > "$session.fakepid"
if [ -n "$FAKE_IGNORE_TERM" ]; then trap '' TERM; fi
# Like pi's bash tool: the detached command has its own stdio, not the run's pipes.
if [ -n "$FAKE_DETACH" ]; then setsid sleep 300 </dev/null >/dev/null 2>&1 & echo $! > "$session.grandchild"; fi
sleep 300
`;

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
  for (const key of ENV_KEYS) delete process.env[key];
  root = mkdtempSync(join(tmpdir(), "ownership-"));
  process.env.PI_CODING_AGENT_DIR = join(root, "profile");
  mkdirSync(join(root, "profile", "agents"), { recursive: true });
  writeFileSync(join(root, "profile", "agents", "runner.md"), "---\nname: runner\nauto-exit: true\n---\nRun.\n");
  const bin = join(root, "fake-pi");
  writeFileSync(bin, FAKE_PI);
  chmodSync(bin, 0o755);
  process.env.PI_HERDR_PI_BIN = bin;
});

afterEach(() => {
  __test__.reset();
  rmSync(root, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return !/^\S+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return false;
  }
}

async function waitFor<T>(read: () => T | null | undefined, ms = 3_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value != null) return value;
    if (Date.now() > deadline) throw new Error("waitFor timeout");
    await sleep(20);
  }
}

const readPid = (file: string) => (existsSync(file) ? Number.parseInt(readFileSync(file, "utf8"), 10) || null : null);

/** Fast limits so liveness paths run in test time. */
const FAST = {
  pollMs: 20,
  deadAfterMs: 60_000,
  firstBeatMs: 60_000,
  stallWarnMs: 600_000,
  maxRunMs: 1_800_000,
  timeoutGraceMs: 10_000,
  escalateMs: 200,
};

function setup(limits: Partial<typeof FAST> = {}) {
  __test__.setDeps({ limits: { ...FAST, ...limits } });
  const tools: any[] = [];
  const handlers = new Map<string, Array<(e: unknown, c: unknown) => unknown>>();
  const sent: any[] = [];
  const api: any = {
    registerTool: (tool: any) => tools.push(tool),
    registerCommand() {},
    registerShortcut() {},
    registerMessageRenderer() {},
    on(event: string, handler: (e: unknown, c: unknown) => unknown) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    events: { on() {}, emit() {} },
    sendMessage: (msg: any) => sent.push(msg),
    sendUserMessage() {},
    getAllTools: () => tools.map((t) => ({ name: t.name })),
    getActiveTools: () => tools.map((t) => t.name),
  };
  herdrSubagents(api);
  const sessionDir = join(root, "orch");
  mkdirSync(sessionDir, { recursive: true });
  const ctx = {
    hasUI: false,
    cwd: root,
    ui: { notify() {}, setWidget() {} },
    isProjectTrusted: () => true,
    sessionManager: {
      getSessionFile: () => join(sessionDir, "parent.jsonl"),
      getSessionId: () => "orch-id",
      getSessionDir: () => sessionDir,
    },
  };
  return {
    run: (name: string, params: Record<string, unknown>) =>
      tools.find((t) => t.name === name).execute("t1", params, undefined, undefined, ctx),
    sent,
    result: () => sent.find((m) => m.customType === "subagent_result"),
    fire: (event: string) => Promise.all((handlers.get(event) ?? []).map((handler) => handler({}, ctx))),
  };
}

describe("fix 6: headless kill ownership", () => {
  it("interrupt captures a detached tool grandchild first; it is killed before the result is reported", async () => {
    process.env.FAKE_DETACH = "1";
    const t = setup();
    const started = await t.run("subagent", { name: "W", task: "t", agent: "runner" });
    assert.equal(started.details.status, "started", started.content[0].text);
    const grandchild = await waitFor(() => readPid(`${started.details.sessionFile}.grandchild`));
    assert.ok(alive(grandchild));
    await t.run("subagent_interrupt", { id: started.details.id });
    await waitFor(() => t.result());
    assert.equal(alive(grandchild), false, "the detached tool process must not outlive the run");
  });

  it("a live child that never beats is stopped before crashed is reported", async () => {
    const t = setup({ firstBeatMs: 200, deadAfterMs: 200 });
    const started = await t.run("subagent", { name: "W", task: "t", agent: "runner" });
    const fakePi = await waitFor(() => readPid(`${started.details.sessionFile}.fakepid`));
    const message = await waitFor(() => t.result());
    assert.match(message.content, /no heartbeat/);
    assert.equal(alive(fakePi), false, "heartbeat death must not strand a running child");
  });

  it("timeout: interrupt, grace, then kill reaches the detached grandchild too", async () => {
    process.env.FAKE_DETACH = "1";
    const t = setup({ maxRunMs: 200, timeoutGraceMs: 100 });
    const started = await t.run("subagent", { name: "W", task: "t", agent: "runner" });
    const grandchild = await waitFor(() => readPid(`${started.details.sessionFile}.grandchild`));
    const message = await waitFor(() => t.result());
    assert.match(message.content, /timed out|time limit|30 min|limit/i);
    assert.equal(alive(grandchild), false);
  });

  it("session_shutdown resolves only after TERM→KILL, even for a child that ignores TERM", async () => {
    process.env.FAKE_IGNORE_TERM = "1";
    const t = setup();
    const started = await t.run("subagent", { name: "W", task: "t", agent: "runner" });
    const fakePi = await waitFor(() => readPid(`${started.details.sessionFile}.fakepid`));
    await sleep(50); // let the trap install
    await t.fire("session_shutdown");
    // The controller may exit right after the handler resolves: nothing may be left by then.
    assert.equal(alive(fakePi), false, "a TERM-ignoring child must be killed before shutdown returns");
  });
});

describe("fix 12: headless children follow their controller", () => {
  const planCtx = (headless: boolean): LaunchPlanContext => ({
    sessionDir: join(root, "orch"),
    sessionId: "orch-id",
    parentSessionFile: join(root, "orch", "parent.jsonl"),
    parentCwd: root,
    env: { PATH: "/usr/bin:/bin", PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_HERDR_PI_BIN: "/usr/bin/pi" },
    headless,
    toolCeiling: { active: ["read"] },
    projectTrusted: true,
  });
  const scriptOf = (plan: ReturnType<typeof buildLaunchPlan>) =>
    plan.files.find((file) => file.path === plan.launchScriptFile)!.content;

  it("headless launches export the controller pid; herdr launches unset it", () => {
    assert.match(scriptOf(buildLaunchPlan({ name: "W", task: "t" }, null, planCtx(true))), new RegExp(`^export PI_SUBAGENT_PARENT_PID='${process.pid}'$`, "m"));
    assert.match(scriptOf(buildLaunchPlan({ name: "W", task: "t" }, null, planCtx(false))), /^unset PI_SUBAGENT_PARENT_PID$/m);
  });

  it("parentWatchFromEnv only watches a valid pid", () => {
    assert.equal(parentWatchFromEnv({}, () => {}), undefined);
    assert.equal(parentWatchFromEnv({ PI_SUBAGENT_PARENT_PID: "abc" }, () => {}), undefined);
    assert.ok(parentWatchFromEnv({ PI_SUBAGENT_PARENT_PID: String(process.pid) }, () => {}));
  });

  it("a real child process exits after its controller is SIGKILLed", async () => {
    const controller = spawn("sleep", ["30"], { stdio: "ignore" });
    const script = [
      `import { startHeartbeat } from ${JSON.stringify(join(import.meta.dirname, "..", "src", "heartbeat.ts"))};`,
      `import { parentWatchFromEnv } from ${JSON.stringify(join(import.meta.dirname, "..", "subagent-done.ts"))};`,
      `const hb = startHeartbeat(${JSON.stringify(join(root, "hb"))}, "r", Date.now, undefined, 50, parentWatchFromEnv(process.env));`,
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      env: { ...process.env, PI_SUBAGENT_PARENT_PID: String(controller.pid) },
      stdio: "ignore",
    });
    const exited = new Promise<NodeJS.Signals | number | null>((resolve) =>
      child.once("exit", (code, signal) => resolve(signal ?? code)),
    );
    await waitFor(() => (existsSync(join(root, "hb")) ? true : null), 10_000);
    assert.ok(alive(child.pid!), "the child runs while its controller lives");
    controller.kill("SIGKILL");
    const how = await Promise.race([exited, sleep(5_000).then(() => "still running" as const)]);
    if (how === "still running") child.kill("SIGKILL");
    assert.equal(how, "SIGTERM", "the child terminates itself (SIGTERM: pi's cleanup path)");
  });
});
