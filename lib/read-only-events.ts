// Read-only state shared between pi-light extensions over Pi's shared event bus (pi.events).
// Pi's bus is a node EventEmitter: emit() runs every listener synchronously up to its first await,
// so a listener that calls reply() synchronously answers before emit() returns.

export const READ_ONLY_QUERY = 'pi-light:read-only:query';

export interface ReadOnlyQuery { reply(readOnly: boolean): void }

interface EventBus {
  on(channel: string, handler: (data: unknown) => void): unknown;
  emit(channel: string, data: unknown): void;
}

/** Workflow side: answer read-only queries from the current policy state. */
export function answerReadOnlyQueries(events: EventBus, isReadOnly: () => boolean): void {
  events.on(READ_ONLY_QUERY, data => (data as ReadOnlyQuery).reply(isReadOnly()));
}

/**
 * Feature side: true when any loaded responder reports read-only. No reply means no workflow
 * extension is loaded (it was filtered out), so there is no read-only mode to honor.
 */
export function queryReadOnly(events: EventBus): boolean {
  let readOnly = false;
  events.emit(READ_ONLY_QUERY, { reply(value: boolean) { readOnly ||= value === true; } } satisfies ReadOnlyQuery);
  return readOnly;
}
