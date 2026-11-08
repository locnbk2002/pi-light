// Run-mode predicates shared by every pi-light extension. Stateless on purpose: Pi loads each
// extension with its own module instance (jiti moduleCache: false), so nothing here may hold state.

/** One-shot Pi jobs (-p/--print, including AgentKit children) keep their own model and tools. */
export function isOneShotInvocation(argv = process.argv.slice(2)): boolean {
  const end = argv.indexOf('--');
  const options = end < 0 ? argv : argv.slice(0, end);
  return options.includes('-p') || options.includes('--print');
}

/** pi-herdr-subagents exports PI_SUBAGENT_ID into every child pane launch (spawn and resume). */
export function isHerdrSubagentChild(env: NodeJS.ProcessEnv = process.env): boolean {
  return typeof env.PI_SUBAGENT_ID === 'string' && env.PI_SUBAGENT_ID.length > 0;
}

/** Child runs (one-shot jobs and herdr subagent panes) get only the controller model, no features. */
export function isChildRun(argv = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): boolean {
  return isOneShotInvocation(argv) || isHerdrSubagentChild(env);
}
