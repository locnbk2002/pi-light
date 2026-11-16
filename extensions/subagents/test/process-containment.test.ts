// Task 10.0c: a headless run's detached descendants never outlive it (natural
// exit included, via a systemd user scope), and failed cleanup keeps ownership.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import herdrSubagents, { __test__ } from "../index.ts";
import { startHeadless } from "../src/headless.ts";

const ENV_KEYS = ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_SOCKET_PATH", "PI_CODING_AGENT_DIR", "PI_HERDR_PI_BIN", "PI_DENY_TOOLS", "PI_SUBAGENT_AGENT"] as const;
const savedEnv = new Map<string, string | undefined>();
let root = "";
const strayPids: number[] = [];
const units: string[] = [];

const scopesWork =
  spawnSync("systemd-run", ["--user", "--scope", "--quiet", "--collect", "--", "true"], { stdio: "ignore", timeout: 5_000 })
    .status === 0;

const FAKE_PI = `#!/bin/bash
session=""
while [ $# -gt 0 ]; do
  case "$1" in
    --session) session="$2"; shift 2 ;;
    *) shift ;;
  esac
done
echo $$ > "$session.fakepid"
sleep 300
`;

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
  for (const key of ENV_KEYS) delete process.env[key];
  root = mkdtempSync(join(tmpdir(), "containment-"));
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
  for (const pid of strayPids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  for (const unit of units.splice(0)) {
    spawnSync("systemctl", ["--user", "kill", "--kill-whom=all", "--signal=SIGKILL", `${unit}.scope`], { stdio: "ignore" });
  }
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

async function waitFor<T>(read: () => T | null | undefined | false, ms: number): Promise<T | null> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await sleep(20);
  }
}

describe("task 10.0c: systemd scope containment", () => {
  it("natural exit after `setsid sleep 300 &` leaves nothing: exit code 0, grandchild gone, scope inactive", { skip: !scopesWork && "systemd user scopes unavailable" }, async () => {
    const runId = `t${process.pid}x${Date.now().toString(16)}`;
    const unit = `pi-subagent-${runId}`;
    units.push(unit);
    const script = join(root, "launch.sh");
    writeFileSync(script, "setsid sleep 300 & echo $!; exit 0\n");
    const child = startHeadless({ launchScriptFile: script, sessionFile: join(root, "child.jsonl"), runId });
    const grandchild = await waitFor(() => Number.parseInt(child.tail().trim(), 10) || null, 2_000);
    assert.ok(grandchild, "the launch script reports its detached child");
    strayPids.push(grandchild);

    // No stop() call: the run's own exit must clean up (inherited pipes included).
    const exited = await waitFor(() => child.exitCode() !== null, 2_000);
    assert.ok(exited, "exitCode() settles although the detached child held the output pipes");
    assert.equal(child.exitCode(), 0);
    assert.equal(alive(grandchild), false, "the detached descendant does not outlive the run");
    const state = spawnSync("systemctl", ["--user", "is-active", `${unit}.scope`], { encoding: "utf8" }).stdout.trim();
    assert.equal(state, "inactive");
  });
});

describe("task 10.0c: failed cleanup keeps ownership", () => {
  it("a stop() that resolves false keeps the ownership entry, warns with the unit, and is retried at shutdown", async () => {
    __test__.setDeps({ limits: { pollMs: 20, deadAfterMs: 60_000, firstBeatMs: 60_000, stallWarnMs: 600_000, maxRunMs: 1_800_000, timeoutGraceMs: 10_000, escalateMs: 200 } });
    const tools: any[] = [];
    const handlers = new Map<string, Array<(e: unknown, c: unknown) => unknown>>();
    const sent: any[] = [];
    herdrSubagents({
      registerTool: (tool: any) => tools.push(tool),
      registerCommand() {},
      registerShortcut() {},
      registerMessageRenderer() {},
      on: (event: string, handler: (e: unknown, c: unknown) => unknown) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
      events: { on() {}, emit() {} },
      sendMessage: (msg: any) => sent.push(msg),
      sendUserMessage() {},
      getAllTools: () => tools.map((t) => ({ name: t.name })),
      getActiveTools: () => tools.map((t) => t.name),
    } as any);
    const sessionDir = join(root, "orch");
    mkdirSync(sessionDir, { recursive: true });
    const ctx = {
      hasUI: false,
      cwd: root,
      ui: { notify() {}, setWidget() {} },
      isProjectTrusted: () => true,
      sessionManager: { getSessionFile: () => join(sessionDir, "p.jsonl"), getSessionId: () => "orch", getSessionDir: () => sessionDir },
    };
    const run = (name: string, params: Record<string, unknown>) =>
      tools.find((t) => t.name === name).execute("t1", params, undefined, undefined, ctx);

    const started = await run("subagent", { name: "W", task: "t", agent: "runner" });
    assert.equal(started.details.status, "started", started.content[0].text);
    const id = started.details.id as string;
    units.push(`pi-subagent-${id}`);
    const owned = __test__.headlessChildren.get(id)!;
    assert.ok(owned, "the run is owned while it runs");
    const fakePi = await waitFor(() => {
      try {
        return Number.parseInt(readFileSync(`${started.details.sessionFile}.fakepid`, "utf8"), 10) || null;
      } catch {
        return null;
      }
    }, 3_000);
    if (fakePi) strayPids.push(fakePi);

    const realStop = owned.tree.stop.bind(owned.tree);
    owned.tree.stop = async () => false;
    await run("subagent_interrupt", { id });
    assert.ok(await waitFor(() => sent.find((m) => m.customType === "subagent_result"), 3_000), "the result is still delivered");
    assert.equal(__test__.headlessChildren.get(id), owned, "a failed stop() keeps ownership");
    const warning = sent.find((m) => /clean ?up/i.test(m.content ?? ""));
    assert.ok(warning, "the failed cleanup is surfaced");
    assert.match(warning.content, /pi-subagent-|pid \d+/);

    owned.tree.stop = realStop;
    await Promise.all((handlers.get("session_shutdown") ?? []).map((handler) => handler({}, ctx)));
    assert.equal(__test__.headlessChildren.has(id), false, "shutdown retries and then releases it");
  });
});
