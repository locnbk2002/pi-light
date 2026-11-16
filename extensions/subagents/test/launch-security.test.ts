// Security patches to the imported launcher (red-team findings 3 and 4):
// display names cannot inject shell into the wrapper script, and a repo-local
// <cwd>/.pi/agent never becomes the child's profile.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import herdrSubagents, { __test__ } from "../index.ts";
import { assertSafeLabel, buildLaunchPlan, shellEscape, type LaunchPlan } from "../src/launch.ts";

const ENV_KEYS = [
  "HERDR_ENV",
  "HERDR_PANE_ID",
  "HERDR_SOCKET_PATH",
  "PI_DENY_TOOLS",
  "PI_SUBAGENT_AGENT",
  "PI_CODING_AGENT_DIR",
] as const;
const savedEnv = new Map<string, string | undefined>();
let root = "";

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
  root = mkdtempSync(join(tmpdir(), "subagents-security-"));
  process.env.PI_CODING_AGENT_DIR = join(root, "parent-agent");
  mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
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

function registerSubagentTool() {
  process.env.HERDR_ENV = "1";
  process.env.HERDR_PANE_ID = "w1:p1";
  process.env.HERDR_SOCKET_PATH = join(root, "herdr.sock");
  delete process.env.PI_DENY_TOOLS;
  delete process.env.PI_SUBAGENT_AGENT;
  const tools: any[] = [];
  const api: any = {
    registerTool: (tool: any) => tools.push(tool),
    registerCommand() {},
    registerShortcut() {},
    registerMessageRenderer() {},
    on() {},
    events: { on() {}, emit() {} },
    sendMessage() {},
    sendUserMessage() {},
    getAllTools: () => tools.map((t) => ({ name: t.name })),
    getActiveTools: () => tools.map((t) => t.name),
  };
  herdrSubagents(api);
  const find = (name: string) => tools.find((t) => t.name === name);
  return { subagent: find("subagent"), resume: find("subagent_resume") };
}

function fakeCtx(sessionDir: string) {
  return {
    hasUI: false,
    cwd: root,
    ui: { notify() {}, setWidget() {} },
    sessionManager: {
      getSessionFile: () => join(sessionDir, "parent.jsonl"),
      getSessionId: () => "orch-session-id",
      getSessionDir: () => sessionDir,
    },
  };
}

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true }).map(String);
}

function scriptOf(plan: LaunchPlan): string {
  const file = plan.files.find((f) => f.path === plan.launchScriptFile);
  assert.ok(file, "launch script must be in plan.files");
  return file.content;
}

function planFor(name: string, cwd?: string): LaunchPlan {
  const binDir = join(root, "bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, "pi"), "#!/bin/bash\nexit 0\n");
  chmodSync(join(binDir, "pi"), 0o755);
  const work = join(root, "work");
  mkdirSync(work, { recursive: true });
  return buildLaunchPlan({ name, task: "Do the thing", cwd }, null, {
    sessionDir: join(root, "orch-sessions"),
    sessionId: "orch-session-id",
    parentSessionFile: join(root, "orch-sessions", "parent.jsonl"),
    parentCwd: work,
    env: {
      PATH: `${binDir}:/usr/bin:/bin`,
      PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
      HERDR_PANE_ID: "w1:p1",
    },
    id: "abcd1234",
    now: new Date("2026-07-06T12:00:00.000Z"),
    toolCeiling: { active: ["read", "bash"] },
    projectTrusted: true,
  });
}

describe("subagents security: display-name sanitizing", () => {
  it("assertSafeLabel rejects control characters, DEL and over-long names", () => {
    assert.throws(() => assertSafeLabel("x\ntouch /tmp/pwned"), /control characters/);
    assert.throws(() => assertSafeLabel("x\ry"), /control characters/);
    assert.throws(() => assertSafeLabel("x\u001by"), /control characters/);
    assert.throws(() => assertSafeLabel("x\u007fy"), /control characters/);
    assert.throws(() => assertSafeLabel("a".repeat(121)), /longer than 120/);
    assert.doesNotThrow(() => assertSafeLabel("a".repeat(120)));
    assert.doesNotThrow(() => assertSafeLabel("Scout: auth (ü) — v2"));
  });

  it("subagent with a newline in name returns an error and writes no script", async () => {
    const { subagent } = registerSubagentTool();
    assert.ok(subagent, "subagent tool must be registered inside herdr");
    const sessionDir = join(root, "orch-sessions");
    const result = await subagent.execute(
      "t1",
      { name: "x\ntouch /tmp/pwned", task: "do it" },
      undefined,
      undefined,
      fakeCtx(sessionDir),
    );
    assert.equal(result.details.error, "invalid name");
    assert.deepEqual(listFiles(sessionDir), []);
  });

  it("subagent_resume with a newline in name returns an error and writes no script", async () => {
    const { resume } = registerSubagentTool();
    assert.ok(resume, "subagent_resume tool must be registered inside herdr");
    const sessionDir = join(root, "orch-sessions");
    const childSession = join(root, "child.jsonl");
    writeFileSync(childSession, "");
    const result = await resume.execute(
      "t1",
      { sessionPath: childSession, name: "x\ntouch /tmp/pwned" },
      undefined,
      undefined,
      fakeCtx(sessionDir),
    );
    assert.equal(result.details.error, "invalid name");
    assert.deepEqual(listFiles(sessionDir), []);
  });

  it("buildLaunchPlan refuses an unsafe name, so no wrapper can be generated for it", () => {
    assert.throws(() => planFor("x\ntouch /tmp/pwned"), /control characters/);
  });

  it("a generated wrapper contains no line starting with touch; header comments are ASCII-only", () => {
    // U+2028 passes assertSafeLabel (not C0/DEL) but must not survive in a comment.
    const script = scriptOf(planFor("x\u2028touch /tmp/pwned"));
    const lines = script.split("\n");
    assert.ok(!lines.some((line) => line.startsWith("touch")), script);
    assert.ok(lines.includes("# Subagent launch script for x?touch /tmp/pwned"), script);
  });
});

describe("subagents security: profile never switched by cwd", () => {
  it("with <cwd>/.pi/agent present, PI_CODING_AGENT_DIR is the parent's", () => {
    const cwd = join(root, "repo");
    mkdirSync(join(cwd, ".pi", "agent"), { recursive: true });
    const script = scriptOf(planFor("Worker", cwd));
    assert.ok(
      script.includes(`export PI_CODING_AGENT_DIR=${shellEscape(process.env.PI_CODING_AGENT_DIR!)}`),
      script,
    );
    assert.ok(!script.includes(join(cwd, ".pi", "agent")), script);
  });
});
