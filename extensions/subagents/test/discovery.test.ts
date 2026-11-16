import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { answerAgentDirsQueries, queryAgentDirs } from "../../../lib/agent-dirs-events.ts";
import { discoverAgentDefinitions, loadAgentDefaults } from "../src/agents.ts";

let root = "";
let previousCwd = "";
const savedAgentDir = process.env.PI_CODING_AGENT_DIR;

function bus() {
  const emitter = new EventEmitter();
  return {
    on: (channel: string, handler: (data: unknown) => void) => emitter.on(channel, handler),
    emit: (channel: string, data: unknown) => void emitter.emit(channel, data),
  };
}

function agent(dir: string, name: string, model: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), `---\nname: ${name}\ndescription: ${model}\nmodel: ${model}\n---\nBody\n`);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "discovery-"));
  previousCwd = process.cwd();
  mkdirSync(join(root, "project"), { recursive: true });
  process.chdir(join(root, "project"));
  process.env.PI_CODING_AGENT_DIR = join(root, "profile");
  mkdirSync(join(root, "profile", "agents"), { recursive: true });
});

afterEach(() => {
  process.chdir(previousCwd);
  rmSync(root, { recursive: true, force: true });
  if (savedAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
});

const find = (list: ReturnType<typeof discoverAgentDefinitions>, name: string) =>
  list.find((a) => a.name === name);

describe("agent discovery: package, global, trusted project", () => {
  it("lists a package agent from the agent-dirs event bus", () => {
    const kit = join(root, "kit", "agents");
    agent(kit, "kit-agent", "pkg/model");
    const events = bus();
    answerAgentDirsQueries(events, kit);
    const list = discoverAgentDefinitions({ extraDirs: queryAgentDirs(events) });
    assert.equal(find(list, "kit-agent")?.source, "package");
    assert.equal(loadAgentDefaults("kit-agent", { extraDirs: [kit] })?.model, "pkg/model");
  });

  it("a global agent overrides a package agent", () => {
    const kit = join(root, "kit", "agents");
    agent(kit, "dup", "pkg/model");
    agent(join(root, "profile", "agents"), "dup", "global/model");
    const list = discoverAgentDefinitions({ extraDirs: [kit] });
    assert.equal(find(list, "dup")?.source, "global");
    assert.equal(loadAgentDefaults("dup", { extraDirs: [kit] })?.model, "global/model");
  });

  it("a project agent overrides both only when the project is trusted", () => {
    const kit = join(root, "kit", "agents");
    agent(kit, "dup", "pkg/model");
    agent(join(root, "profile", "agents"), "dup", "global/model");
    agent(join(root, "project", ".pi", "agents"), "dup", "project/model");

    const trusted = discoverAgentDefinitions({ extraDirs: [kit], projectTrusted: true });
    assert.equal(find(trusted, "dup")?.source, "project");
    assert.equal(loadAgentDefaults("dup", { extraDirs: [kit], projectTrusted: true })?.model, "project/model");

    const untrusted = discoverAgentDefinitions({ extraDirs: [kit], projectTrusted: false });
    assert.equal(find(untrusted, "dup")?.source, "global");
    assert.equal(loadAgentDefaults("dup", { extraDirs: [kit] })?.model, "global/model");
  });

  it("an untrusted project's .pi/agents/counsel.md is ignored", () => {
    agent(join(root, "project", ".pi", "agents"), "counsel", "evil/model");
    assert.equal(find(discoverAgentDefinitions(), "counsel")?.model === "evil/model", false);
    assert.notEqual(loadAgentDefaults("counsel")?.model, "evil/model");
  });

  it("a duplicate reply (same real path) is listed once", () => {
    const kit = join(root, "kit", "agents");
    agent(kit, "kit-agent", "pkg/model");
    symlinkSync(kit, join(root, "kit-link"));
    const events = bus();
    answerAgentDirsQueries(events, kit);
    answerAgentDirsQueries(events, kit);
    answerAgentDirsQueries(events, join(root, "kit-link"));
    const dirs = queryAgentDirs(events);
    assert.deepEqual(dirs, [kit]);
    const list = discoverAgentDefinitions({ extraDirs: dirs });
    assert.equal(list.filter((a) => a.name === "kit-agent").length, 1);
  });
});
