// Headless backend (outside herdr): background `pi -p` children, classified
// from the run's session file, owned (killed) by the controller.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import herdrSubagents, { __test__ } from "../index.ts";
import { killTree, startHeadless, headlessWatcherDeps } from "../src/headless.ts";
import { BLOCKED_ACTIONS_INSTRUCTION, buildLaunchPlan, type LaunchPlanContext } from "../src/launch.ts";
import { watchSubagent, type RunningSubagent } from "../src/watcher.ts";

const ENV_KEYS = [
  "HERDR_ENV",
  "HERDR_PANE_ID",
  "HERDR_SOCKET_PATH",
  "PI_CODING_AGENT_DIR",
  "PI_HERDR_PI_BIN",
  "PI_DENY_TOOLS",
  "PI_SUBAGENT_AGENT",
  "FAKE_STOP",
  "FAKE_EXIT",
  "FAKE_NOISE",
  "FAKE_SLEEP",
  "FAKE_TEXT",
] as const;
const savedEnv = new Map<string, string | undefined>();
let root = "";

const FAKE_PI = `#!/bin/bash
session=""
while [ $# -gt 0 ]; do
  case "$1" in
    --session) session="$2"; shift 2 ;;
    *) shift ;;
  esac
done
if [ -n "$FAKE_NOISE" ]; then head -c 70000 /dev/zero | tr '\\0' 'x'; echo; fi
if [ -n "$FAKE_SLEEP" ]; then sleep "$FAKE_SLEEP"; fi
printf '{"type":"message","id":"a1","message":{"role":"assistant","content":[{"type":"text","text":"%s"}],"stopReason":"%s"}}\\n' "\${FAKE_TEXT:-final answer}" "\${FAKE_STOP:-stop}" >> "$session"
exit \${FAKE_EXIT:-0}
`;

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
  for (const key of ENV_KEYS) delete process.env[key];
  root = mkdtempSync(join(tmpdir(), "headless-"));
  process.env.PI_CODING_AGENT_DIR = join(root, "profile");
  mkdirSync(join(root, "profile", "agents"), { recursive: true });
  const bin = join(root, "fake-pi");
  writeFileSync(bin, FAKE_PI);
  chmodSync(bin, 0o755);
  process.env.PI_HERDR_PI_BIN = bin;
  // Without an agent, upstream defaults a spawn to interactive (refused headless).
  writeFileSync(join(root, "profile", "agents", "runner.md"), "---\nname: runner\nauto-exit: true\n---\nRun.\n");
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
  // A reaped-later zombie still answers kill(0); check its state.
  try {
    return !/^\S+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return false;
  }
}

async function waitGone(pid: number, ms = 3_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await sleep(25);
  }
  return !alive(pid);
}

function setup() {
  const tools: any[] = [];
  const handlers = new Map<string, Array<(e: unknown, c: unknown) => void>>();
  const sent: any[] = [];
  let resolveSent: ((msg: any) => void) | null = null;
  const api: any = {
    registerTool: (tool: any) => tools.push(tool),
    registerCommand() {},
    registerShortcut() {},
    registerMessageRenderer() {},
    on(event: string, handler: (e: unknown, c: unknown) => void) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    events: { on() {}, emit() {} },
    sendMessage(msg: any) {
      sent.push(msg);
      resolveSent?.(msg);
    },
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
    isProjectTrusted: () => false,
    sessionManager: {
      getSessionFile: () => join(sessionDir, "parent.jsonl"),
      getSessionId: () => "orch-id",
      getSessionDir: () => sessionDir,
    },
  };
  return {
    tool: (name: string) => tools.find((t) => t.name === name),
    ctx,
    sent,
    nextSent: () => new Promise<any>((resolve) => (resolveSent = resolve)),
    fire: (event: string) => {
      for (const handler of handlers.get(event) ?? []) handler({}, ctx);
    },
  };
}

function planCtx(): LaunchPlanContext {
  return {
    sessionDir: join(root, "orch"),
    sessionId: "orch-id",
    parentSessionFile: join(root, "orch", "parent.jsonl"),
    parentCwd: root,
    env: process.env,
    id: "run0001",
    now: new Date("2026-11-16T12:00:00.000Z"),
  };
}

describe("headless: launch plan", () => {
  it("argv uses text-mode -p, never --mode json; no pane export; no hold-open", () => {
    const plan = buildLaunchPlan({ name: "W", task: "t" }, null, { ...planCtx(), headless: true });
    assert.equal(plan.piArgv[1], "-p");
    assert.ok(!plan.piArgv.includes("--mode"));
    const script = plan.files.find((f) => f.path === plan.launchScriptFile)!.content;
    assert.ok(!script.includes("PI_SUBAGENT_PANE"));
    assert.ok(script.includes("export PI_HERDR_HOLD_OPEN_SECS=0"));
    assert.ok(!script.includes("read -r"));
  });

  it("blocked-actions instruction is in the headless prompt file only", () => {
    const headless = buildLaunchPlan({ name: "W", task: "t" }, null, { ...planCtx(), headless: true });
    const herdr = buildLaunchPlan({ name: "W", task: "t" }, null, planCtx());
    const promptFiles = (plan: typeof headless) => {
      const files: string[] = [];
      plan.piArgv.forEach((arg, i) => {
        if (arg === "--append-system-prompt") files.push(plan.piArgv[i + 1]);
      });
      return files.map((path) => plan.files.find((f) => f.path === path)!.content).join("\n");
    };
    assert.ok(promptFiles(headless).includes(BLOCKED_ACTIONS_INSTRUCTION));
    assert.ok(!promptFiles(herdr).includes(BLOCKED_ACTIONS_INSTRUCTION));
  });
});

describe("headless: classification", () => {
  function runFor(plan: ReturnType<typeof buildLaunchPlan>): RunningSubagent {
    return {
      id: plan.id,
      name: plan.name,
      task: "t",
      paneId: `headless:${plan.id}`,
      startTime: Date.now(),
      sessionFile: plan.sessionFile,
      launchScriptFile: plan.launchScriptFile,
      interactive: false,
      autoExit: true,
      backend: "headless",
    };
  }

  async function runPlan(plan: ReturnType<typeof buildLaunchPlan>) {
    for (const file of plan.files) {
      mkdirSync(join(file.path, ".."), { recursive: true });
      writeFileSync(file.path, file.content);
    }
    const child = startHeadless({ launchScriptFile: plan.launchScriptFile, sessionFile: plan.sessionFile });
    const running = runFor(plan);
    const abort = new AbortController();
    const outcome = await watchSubagent(running, {
      ...headlessWatcherDeps(child, running.paneId, 0),
      signal: abort.signal,
    });
    return { outcome, running, child };
  }

  it("running.id === plan.id and a .exitcode stamped with plan.id is accepted", async () => {
    const plan = buildLaunchPlan({ name: "W", task: "t" }, null, { ...planCtx(), headless: true });
    const { outcome, running } = await runPlan(plan);
    assert.equal(running.id, plan.id);
    assert.equal(outcome.kind, "completed");
    assert.equal((outcome as any).summary, "final answer");
  });

  it("stopReason error with exit 0 → failed", async () => {
    process.env.FAKE_STOP = "error";
    const plan = buildLaunchPlan({ name: "W", task: "t" }, null, { ...planCtx(), headless: true });
    const { outcome } = await runPlan(plan);
    assert.equal(outcome.kind, "failed");
    assert.equal((outcome as any).reason, "error");
  });

  it("the final message after more than 64 KB of output still comes from the session file", async () => {
    process.env.FAKE_NOISE = "1";
    process.env.FAKE_TEXT = "the real result";
    const plan = buildLaunchPlan({ name: "W", task: "t" }, null, { ...planCtx(), headless: true });
    const { outcome, child } = await runPlan(plan);
    assert.equal(outcome.kind, "completed");
    assert.equal((outcome as any).summary, "the real result");
    assert.ok(child.tail().length <= 64 * 1024);
    assert.ok(existsSync(`${plan.sessionFile}.log`));
  });

  it("a non-zero exit with no assistant message → failed with the output tail", async () => {
    const plan = buildLaunchPlan({ name: "W", task: "t" }, null, { ...planCtx(), headless: true });
    for (const file of plan.files) {
      mkdirSync(join(file.path, ".."), { recursive: true });
      writeFileSync(file.path, file.content);
    }
    writeFileSync(plan.launchScriptFile, `echo boom-tail >&2\necho "3 ${plan.id}" > '${plan.sessionFile}.exitcode'\nexit 3\n`);
    const child = startHeadless({ launchScriptFile: plan.launchScriptFile, sessionFile: plan.sessionFile });
    const outcome = await watchSubagent(runFor(plan), {
      ...headlessWatcherDeps(child, "headless:x", 0),
      signal: new AbortController().signal,
    });
    assert.equal(outcome.kind, "failed");
    assert.match((outcome as any).paneOutput, /boom-tail/);
  });
});

describe("headless: process ownership", () => {
  it("killTree kills a detached (setsid) grandchild", async () => {
    const child = spawn("bash", ["-c", "setsid sleep 300 & echo $!; wait"], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const grandchild = await new Promise<number>((resolve) =>
      child.stdout!.once("data", (chunk) => resolve(Number.parseInt(String(chunk), 10))),
    );
    assert.ok(alive(grandchild));
    await killTree(child.pid!, 100);
    assert.ok(await waitGone(grandchild), "setsid grandchild must be killed");
  });

  it("session_shutdown kills running headless children", async () => {
    process.env.FAKE_SLEEP = "300";
    const t = setup();
    const result = await t.tool("subagent").execute("t1", { name: "Sleeper", task: "t", agent: "runner" }, undefined, undefined, t.ctx);
    assert.equal(result.details.status, "started");
    const pid = result.details.pid as number;
    assert.ok(alive(pid));
    t.fire("session_shutdown");
    assert.ok(await waitGone(pid), "headless child must die on shutdown");
    assert.ok(t.sent.some((m) => /controller shut down/.test(m.content)));
  });
});

describe("headless: subagent tool", () => {
  it("interactive callers get an acknowledgement without paneId, then the steer", async () => {
    const t = setup();
    const steer = t.nextSent();
    const result = await t.tool("subagent").execute("t1", { name: "W", task: "t", agent: "runner" }, undefined, undefined, t.ctx);
    assert.equal(result.details.status, "started");
    assert.equal(result.details.backend, "headless");
    assert.equal(typeof result.details.pid, "number");
    assert.ok(!("paneId" in result.details));
    const message = await steer;
    assert.equal(message.customType, "subagent_result");
    assert.ok(!("paneId" in message.details));
    assert.match(message.content, /final answer/);
  });

  it("one-shot callers get the outcome inline and no later steer", async () => {
    const t = setup();
    process.argv.push("-p");
    try {
      const result = await t.tool("subagent").execute("t1", { name: "W", task: "t", agent: "runner" }, undefined, undefined, t.ctx);
      assert.equal(result.details.status, "finished");
      assert.match(result.content[0].text, /final answer/);
      assert.equal(t.sent.length, 0);
    } finally {
      process.argv.pop();
    }
  });

  it("an interactive agent outside herdr is refused and nothing is spawned", async () => {
    const t = setup();
    const result = await t.tool("subagent").execute(
      "t1",
      { name: "Interviewer", task: "t", interactive: true },
      undefined,
      undefined,
      t.ctx,
    );
    assert.match(result.content[0].text, /interactive agent needs herdr; run the interview in the main session with ask_user/);
    assert.ok(!existsSync(join(root, "orch", "artifacts")));
  });
});
