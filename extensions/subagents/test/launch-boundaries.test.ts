// Launch-boundary regressions from the phases 3-10 review (Phase 10 Task 10.0b):
// what a child inherits from its parent (tool ceiling, project trust, kit env),
// what a model-supplied argument may not change (agent name, resume limits),
// and per-run artifact isolation.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import herdrSubagents, { __test__ } from "../index.ts";
import { buildLaunchPlan, buildResumeLaunchPlan, type LaunchPlanContext } from "../src/launch.ts";
import type { SubagentOutcome } from "../src/watcher.ts";

const ENV_KEYS = [
  "HERDR_ENV",
  "HERDR_PANE_ID",
  "HERDR_SOCKET_PATH",
  "PI_CODING_AGENT_DIR",
  "PI_HERDR_PI_BIN",
  "PI_DENY_TOOLS",
  "PI_SUBAGENT_AGENT",
  "PI_KIT_HOME",
  "PI_KIT_HOOK_LOG_DIR",
] as const;
const savedEnv = new Map<string, string | undefined>();
let root = "";

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
  for (const key of ENV_KEYS) delete process.env[key];
  root = mkdtempSync(join(tmpdir(), "launch-boundaries-"));
  process.env.PI_CODING_AGENT_DIR = join(root, "profile");
  mkdirSync(join(root, "profile", "agents"), { recursive: true });
  process.env.PI_HERDR_PI_BIN = "/usr/local/bin/pi-fake";
  process.env.HERDR_ENV = "1";
  process.env.HERDR_PANE_ID = "w1:p1";
  process.env.HERDR_SOCKET_PATH = join(root, "herdr.sock");
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

/** The tools Pi exposes to a parent started with `--tools read,grep,find,subagent` (both APIs are filtered). */
const RESTRICTED = ["read", "grep", "find", "subagent"];

function harness(opts: { active?: () => string[]; all?: string[]; trusted?: boolean } = {}) {
  const tools: any[] = [];
  const scripts: string[] = [];
  const api: any = {
    registerTool: (tool: any) => tools.push(tool),
    registerCommand() {},
    registerShortcut() {},
    registerMessageRenderer() {},
    on() {},
    events: { on() {}, emit() {} },
    sendMessage() {},
    sendUserMessage() {},
    getAllTools: () => (opts.all ?? RESTRICTED).map((name) => ({ name })),
    getActiveTools: opts.active ?? (() => [...RESTRICTED]),
  };
  herdrSubagents(api);
  __test__.setDeps({
    client: {
      async ping() {
        return { ok: true, version: "0.8.2", protocol: 14 };
      },
      async pluginGet() {
        return { plugin_id: "pi-herdr-subagents", enabled: true };
      },
      async paneStart(p: any) {
        scripts.push(readFileSync(p.launchScriptFile, "utf8"));
        return { paneId: `w1:p${scripts.length + 1}`, terminalId: "", workspaceId: "", tabId: "" };
      },
      async paneRename() {},
      async paneGet() {
        return null;
      },
      async paneList() {
        return [];
      },
      async paneClose() {},
      async paneSendKeys() {},
    } as any,
    // Never settles: these tests inspect launches, not outcomes.
    watch: () => new Promise<SubagentOutcome>(() => {}),
    createStream: () => ({ watch: () => () => {}, onReconcile: () => () => {}, close() {} }) as any,
  });
  const sessionDir = join(root, "orch");
  mkdirSync(sessionDir, { recursive: true });
  const ctx = {
    hasUI: false,
    cwd: root,
    ui: { notify() {}, setWidget() {} },
    isProjectTrusted: () => opts.trusted ?? true,
    sessionManager: {
      getSessionFile: () => join(sessionDir, "parent.jsonl"),
      getSessionId: () => "orch-id",
      getSessionDir: () => sessionDir,
    },
  };
  const run = (name: string, params: Record<string, unknown>) =>
    tools.find((t) => t.name === name).execute("t1", params, undefined, undefined, ctx);
  /** Resume a spawned run once its child has created the session file. */
  const resume = (spawned: any, params: Record<string, unknown> = {}) => {
    writeFileSync(spawned.details.sessionFile, "", { flag: "a" });
    return run("subagent_resume", { sessionPath: spawned.details.sessionFile, ...params });
  };
  return { run, resume, scripts, sessionDir };
}

/** The value following `flag` in the wrapper's pi invocation, or null. */
function flagValue(script: string, flag: string): string | null {
  const match = new RegExp(`'${flag}' '([^']*)'`).exec(script);
  return match ? match[1] : null;
}

function planCtx(overrides: Partial<LaunchPlanContext> = {}): LaunchPlanContext {
  return {
    sessionDir: join(root, "orch"),
    sessionId: "orch-id",
    parentSessionFile: join(root, "orch", "parent.jsonl"),
    parentCwd: root,
    env: { PATH: "/usr/bin:/bin", PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_HERDR_PI_BIN: "/usr/bin/pi" },
    now: new Date("2026-11-16T12:00:00.000Z"),
    toolCeiling: { active: ["read", "bash"] },
    projectTrusted: true,
    ...overrides,
  };
}

describe("fix 1: the parent's active tools always cap the child", () => {
  it("a grandchild under --tools read,grep,find,subagent keeps that ceiling although getAllTools equals getActiveTools", async () => {
    const t = harness();
    const result = await t.run("subagent", { name: "W", task: "t" });
    assert.equal(result.details.status, "started", result.content[0].text);
    assert.equal(flagValue(t.scripts[0], "--tools"), "read,grep,find,subagent,caller_ping,subagent_done");
  });

  it("requested tools are intersected with the parent's active tools", async () => {
    const t = harness();
    await t.run("subagent", { name: "W", task: "t", tools: "read,bash,write" });
    assert.equal(flagValue(t.scripts[0], "--tools"), "read,caller_ping,subagent_done");
  });

  it("spawn fails closed when the parent's active tool set cannot be read", async () => {
    const t = harness({
      active: () => {
        throw new Error("boom");
      },
    });
    const result = await t.run("subagent", { name: "W", task: "t" });
    assert.equal(result.details.error, "tool ceiling unavailable");
    assert.equal(t.scripts.length, 0, "nothing is launched without a ceiling");
  });
});

describe("fix 2: the parent's project-trust decision reaches spawn and resume", () => {
  it("an untrusted parent (--no-approve) launches spawn and resume with --no-approve; a trusted one does not", async () => {
    const untrusted = harness({ trusted: false });
    const spawned = await untrusted.run("subagent", { name: "W", task: "t" });
    assert.equal(spawned.details.status, "started");
    assert.match(untrusted.scripts[0], /'--no-approve'/);
    const resumed = await untrusted.resume(spawned);
    assert.equal(resumed.details.status, "started", resumed.content[0].text);
    assert.match(untrusted.scripts[1], /'--no-approve'/);

    __test__.reset();
    const trusted = harness({ trusted: true });
    await trusted.run("subagent", { name: "W", task: "t" });
    assert.doesNotMatch(trusted.scripts[0], /--no-approve/);
  });
});

describe("fix 5: agent names cannot traverse out of the agent directories", () => {
  it("spawn refuses an agent name outside ^[\\w.-]+$ even when the traversed file exists", async () => {
    writeFileSync(join(root, "profile", "evil.md"), "---\nname: evil\nauto-exit: true\n---\nEvil.\n");
    const t = harness();
    const result = await t.run("subagent", { name: "W", task: "t", agent: "../evil" });
    assert.equal(result.details.error, "invalid agent name");
    assert.equal(t.scripts.length, 0);
  });
});

describe("fix 7: per-run artifacts never collide", () => {
  it("same-name launches in the same second get distinct task, role, runtime and resume artifact paths", () => {
    const defs = { body: "You are W.", systemPromptMode: "append" as const };
    const a = buildLaunchPlan({ name: "W x", task: "task A", agent: "w" }, defs, planCtx({ id: "aaaa1111" }));
    // Different display name, same normalized artifact name.
    const b = buildLaunchPlan({ name: "w-x", task: "task B", agent: "w" }, defs, planCtx({ id: "bbbb2222" }));
    const paths = (plan: { files: Array<{ path: string }> }) => plan.files.map((file) => file.path);
    const shared = paths(a).filter((path) => paths(b).includes(path));
    assert.deepEqual(shared, []);

    const record = { version: 1 as const, agent: "w", denyTools: [], tools: ["read"] };
    const ra = buildResumeLaunchPlan({ sessionPath: a.sessionFile, message: "m" }, record, planCtx({ id: "cccc3333" }));
    const rb = buildResumeLaunchPlan({ sessionPath: b.sessionFile, message: "m" }, record, planCtx({ id: "dddd4444" }));
    assert.deepEqual(paths(ra).filter((path) => paths(rb).includes(path)), []);
  });
});

describe("fix 10: kit state/log env reaches herdr children", () => {
  it("PI_KIT_HOME and PI_KIT_HOOK_LOG_DIR are exported on spawn and resume", async () => {
    process.env.PI_KIT_HOME = join(root, "kit");
    process.env.PI_KIT_HOOK_LOG_DIR = join(root, "logs");
    const t = harness();
    const spawned = await t.run("subagent", { name: "W", task: "t" });
    await t.resume(spawned);
    for (const script of t.scripts) {
      assert.ok(script.includes(`export PI_KIT_HOME='${join(root, "kit")}'`), script);
      assert.ok(script.includes(`export PI_KIT_HOOK_LOG_DIR='${join(root, "logs")}'`), script);
    }
  });

  it("an unset parent value is unset in the child, never inherited from the pane", () => {
    const plan = buildLaunchPlan({ name: "W", task: "t" }, null, planCtx());
    const script = plan.files.find((file) => file.path === plan.launchScriptFile)!.content;
    assert.match(script, /^unset PI_KIT_HOME$/m);
    assert.match(script, /^unset PI_KIT_HOOK_LOG_DIR$/m);
  });
});

describe("fix 11: resume reapplies the original run's limits", () => {
  it("agent, deny list and tool ceiling come from the original run, not resume arguments", async () => {
    writeFileSync(
      join(root, "profile", "agents", "worker.md"),
      "---\nname: worker\nauto-exit: true\ntools: read,find,bash\ndeny-tools: bash\n---\nWork.\n",
    );
    const t = harness({ active: () => ["read", "grep", "find", "bash", "write", "subagent"] });
    const spawned = await t.run("subagent", { name: "W", task: "t", agent: "worker" });
    assert.equal(spawned.details.status, "started", spawned.content[0].text);
    const resumed = await t.resume(spawned, {
      agent: "other",
      tools: "write",
      denyTools: "",
    });
    assert.equal(resumed.details.status, "started", resumed.content[0].text);
    const script = t.scripts[1];
    assert.match(script, /^export PI_SUBAGENT_AGENT='worker'$/m);
    assert.match(script, /^export PI_DENY_TOOLS='bash'$/m);
    assert.equal(flagValue(script, "--tools"), "read,find,bash,caller_ping,subagent_done");
  });

  it("resume is refused when the session has no launch record", async () => {
    const sessionPath = join(root, "orphan.jsonl");
    writeFileSync(sessionPath, "");
    const t = harness();
    const result = await t.run("subagent_resume", { sessionPath });
    assert.equal(result.details.error, "launch record unavailable");
    assert.equal(t.scripts.length, 0);
    assert.ok(!existsSync(join(t.sessionDir, "artifacts")) || readdirSync(join(t.sessionDir, "artifacts")).length === 0);
  });
});
