// Explicit project trust for resources Pi itself does not gate (`.pi/agents`, `.pi/rules`).
//
// Pi asks for a trust decision only when a project has resources from its own
// list (.pi/settings.json, extensions, skills, prompts, ...). Without any, it
// resolves trust to "yes" with no consent (`trustStore.get(cwd) ?? true`), so
// ctx.isProjectTrusted() is true for a fresh clone whose only Pi content is
// .pi/agents or .pi/rules. Those files steer models, so they need consent:
//   - Pi says untrusted (declined, saved "no", --no-approve)   -> untrusted;
//   - Pi made a real decision (gated resources exist)          -> Pi's answer;
//   - otherwise only an explicit decision counts: a saved trust.json record for
//     the project or a parent, or `--approve`/`-a` on this process's command line.
// Stateless on purpose (see run-mode.ts).
import { getAgentDir, hasTrustRequiringProjectResources, ProjectTrustStore } from '@earendil-works/pi-coding-agent';

export interface ProjectTrustContext {
  cwd?: string;
  isProjectTrusted?: () => boolean;
}

export interface ProjectTrustDeps {
  argv?: readonly string[];
  agentDir?: string;
  hasGatedResources?: (cwd: string) => boolean;
  savedDecision?: (agentDir: string, cwd: string) => boolean | null;
}

/** The last `--approve`/`--no-approve` on the command line (Pi's own parsing: last one wins), or null. */
export function cliTrustOverride(argv: readonly string[] = process.argv.slice(2)): boolean | null {
  const end = argv.indexOf('--');
  let override: boolean | null = null;
  for (const arg of end < 0 ? argv : argv.slice(0, end)) {
    if (arg === '--approve' || arg === '-a') override = true;
    else if (arg === '--no-approve' || arg === '-na') override = false;
  }
  return override;
}

const savedTrust = (agentDir: string, cwd: string) => new ProjectTrustStore(agentDir).get(cwd);

/** True only when the project in ctx.cwd is trusted by an explicit decision. Any error means untrusted. */
export function isProjectExplicitlyTrusted(ctx: ProjectTrustContext, deps: ProjectTrustDeps = {}): boolean {
  try {
    const cwd = ctx.cwd;
    if (typeof cwd !== 'string' || !cwd || ctx.isProjectTrusted?.() !== true) return false;
    if ((deps.hasGatedResources ?? hasTrustRequiringProjectResources)(cwd)) return true;
    if (cliTrustOverride(deps.argv) === true) return true;
    return (deps.savedDecision ?? savedTrust)(deps.agentDir ?? getAgentDir(), cwd) === true;
  } catch {
    return false;
  }
}
