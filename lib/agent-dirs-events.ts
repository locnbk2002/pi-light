// Agent-definition directories shared over Pi's event bus (pi.events), so packages such as
// pi-light-kit can contribute `agents/` without symlinks into the profile. Pi's bus is a node
// EventEmitter: emit() runs every listener synchronously, so a listener that calls reply()
// synchronously answers before emit() returns.
import { realpathSync } from 'node:fs';

export const AGENT_DIRS_QUERY = 'pi-light:agent-dirs:query';

export interface AgentDirsQuery { reply(dir: string): void }

interface EventBus {
  on(channel: string, handler: (data: unknown) => void): unknown;
  emit(channel: string, data: unknown): void;
}

/** Provider side: answer every query with this package's agent directory. */
export function answerAgentDirsQueries(events: EventBus, dir: string): void {
  events.on(AGENT_DIRS_QUERY, data => (data as AgentDirsQuery).reply(dir));
}

/** Consumer side: every replied directory, in reply order, deduplicated by real path. */
export function queryAgentDirs(events: EventBus): string[] {
  const dirs: string[] = [];
  const seen = new Set<string>();
  events.emit(AGENT_DIRS_QUERY, {
    reply(dir: string) {
      if (typeof dir !== 'string' || !dir) return;
      let key = dir;
      try { key = realpathSync(dir); } catch { /* missing dir: dedupe by the given path */ }
      if (seen.has(key)) return;
      seen.add(key);
      dirs.push(dir);
    },
  } satisfies AgentDirsQuery);
  return dirs;
}
