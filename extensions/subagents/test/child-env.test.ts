import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { perRunExports, resolveChildTools, shellEscape } from "../src/child-env.ts";
import { buildLaunchPlan, buildResumeLaunchPlan, type LaunchPlanContext } from "../src/launch.ts";

const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
const roots: string[] = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
  if (savedAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "child-env-"));
  roots.push(root);
  const agentDir = join(root, "parent-agent");
  mkdirSync(agentDir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const cwd = join(root, "repo");
  mkdirSync(join(cwd, ".pi", "agent"), { recursive: true });
  const ctx: LaunchPlanContext = {
    sessionDir: join(root, "orch"),
    sessionId: "orch-id",
    parentSessionFile: join(root, "orch", "parent.jsonl"),
    parentCwd: cwd,
    env: {
      PATH: "/usr/bin:/bin",
      PI_CODING_AGENT_DIR: agentDir,
      PI_HERDR_PI_BIN: "/usr/bin/pi",
      PI_SUBAGENT_AUTO_EXIT: "1",
      PI_SUBAGENT_PARENT_SESSION: "/elsewhere.jsonl",
    },
    id: "run12345",
    now: new Date("2026-11-16T12:00:00.000Z"),
    toolCeiling: { active: ["read", "bash"] },
    projectTrusted: true,
  };
  return { root, agentDir, cwd, ctx };
}

const scriptOf = (plan: { files: Array<{ path: string; content: string }>; launchScriptFile: string }) =>
  plan.files.find((file) => file.path === plan.launchScriptFile)!.content;

describe("child env: perRunExports", () => {
  it("always writes every per-run marker and unsets the parent-session hints", () => {
    const lines = perRunExports({
      id: "abc",
      name: "Worker",
      sessionFile: "/s.jsonl",
      autoExit: false,
      denyTools: [],
      env: { PI_CODING_AGENT_DIR: "/p" },
    });
    assert.ok(lines.includes("unset PI_SUBAGENT_PARENT_SESSION PI_AGENT_ROUTER_PARENT_SESSION_ID"));
    assert.ok(lines.includes("export PI_SUBAGENT_AUTO_EXIT=0"));
    assert.ok(lines.includes("export PI_DENY_TOOLS=''"));
    assert.ok(lines.includes("export PI_SUBAGENT_AGENT=''"));
    assert.ok(lines.includes("export PI_CODING_AGENT_DIR='/p'"));
    assert.ok(lines.includes("export PI_SUBAGENT_ID='abc'"));
  });
});

describe("child env: launch scripts", () => {
  it("non-auto-exit spawn writes AUTO_EXIT=0 even when the parent has AUTO_EXIT=1", () => {
    const fx = fixture();
    const script = scriptOf(buildLaunchPlan({ name: "W", task: "t" }, null, fx.ctx));
    assert.match(script, /^export PI_SUBAGENT_AUTO_EXIT=0$/m);
    assert.match(script, /^unset PI_SUBAGENT_PARENT_SESSION PI_AGENT_ROUTER_PARENT_SESSION_ID$/m);
  });

  it("resume writes both unset hints and an explicit AUTO_EXIT", () => {
    const fx = fixture();
    const script = scriptOf(
      buildResumeLaunchPlan(
        { sessionPath: join(fx.root, "child.jsonl"), autoExit: false },
        { version: 1, agent: null, denyTools: [], tools: ["read"] },
        fx.ctx,
      ),
    );
    assert.match(script, /^export PI_SUBAGENT_AUTO_EXIT=0$/m);
    assert.match(script, /^unset PI_SUBAGENT_PARENT_SESSION PI_AGENT_ROUTER_PARENT_SESSION_ID$/m);
  });

  it("PI_CODING_AGENT_DIR is the parent's even when <cwd>/.pi/agent exists", () => {
    const fx = fixture();
    const script = scriptOf(buildLaunchPlan({ name: "W", task: "t", cwd: fx.cwd }, null, fx.ctx));
    assert.ok(script.includes(`export PI_CODING_AGENT_DIR=${shellEscape(fx.agentDir)}`), script);
    assert.ok(!script.includes(join(fx.cwd, ".pi", "agent")), script);
  });

  it("--tools is the restricted parent set intersected with params.tools, plus control tools", () => {
    const fx = fixture();
    const ceiling = { active: ["read", "grep", "find", "subagent"] };
    const plan = buildLaunchPlan(
      { name: "W", task: "t", tools: "read,bash,subagent" },
      null,
      { ...fx.ctx, toolCeiling: ceiling },
    );
    const index = plan.piArgv.indexOf("--tools");
    assert.ok(index > 0);
    assert.equal(plan.piArgv[index + 1], "read,subagent,caller_ping,subagent_done");
  });
});

describe("child env: resolveChildTools", () => {
  it("the parent's active set is the ceiling even when nothing is requested", () => {
    assert.equal(resolveChildTools({ active: ["read", "bash"] }), "read,bash,caller_ping,subagent_done");
  });

  it("a missing or malformed ceiling throws instead of omitting the flag", () => {
    assert.throws(() => resolveChildTools(undefined as any), /active tool set is unavailable/);
    assert.throws(() => resolveChildTools({ active: [1] } as any), /active tool set is unavailable/);
  });

  it("requested tools pass through only where the parent has them", () => {
    assert.equal(resolveChildTools({ active: ["read", "bash"] }, "bash,write"), "bash,caller_ping,subagent_done");
  });
});
