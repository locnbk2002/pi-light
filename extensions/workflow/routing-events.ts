// pi-light's side of the pi.events contract with an optional routing workflow (pi-light-kit), so
// neither package imports the other. Pi's bus is a node EventEmitter: emit() runs listeners
// synchronously up to their first await, so the synchronous replies and revocations below take
// effect before emit() returns.
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

interface EventBus {
  on(channel: string, handler: (data: unknown) => void): unknown;
  emit(channel: string, data: unknown): void;
}

// Model facts: the implementing model and its other-family reviewer.
export const MODELS_QUERY = 'pi-light:models:query';

export interface PiLightModels {
  /** The model implementing the work, as provider/id. */
  controllerModel: string;
  /** Vendor family of the controller model. */
  controllerFamily: string;
  /** First available configured model of another family; absent when there is none. */
  reviewerModel?: string;
}

/** Query payload. `ctx` is the asking turn's context, used for model availability. */
export interface ModelsQuery {
  ctx?: unknown;
  reply(answer: PiLightModels): void;
}

function turnContext(value: unknown): ExtensionContext | undefined {
  const registry = (value as { modelRegistry?: { find?: unknown; hasConfiguredAuth?: unknown } } | undefined)?.modelRegistry;
  return typeof registry?.find === 'function' && typeof registry.hasConfiguredAuth === 'function' ? value as ExtensionContext : undefined;
}

/** Answer every models query from current state. A query without a usable ctx gets `undefined`. */
export function answerModelsQueries(events: EventBus, answer: (ctx: ExtensionContext | undefined) => PiLightModels): void {
  events.on(MODELS_QUERY, data => {
    const query = data as Partial<ModelsQuery> | undefined;
    if (typeof query?.reply === 'function') query.reply(answer(turnContext(query.ctx)));
  });
}

// Input preflight. pi-light selects the controller for every input and drops the input when it
// cannot. Pi stops calling later input handlers once one returns `handled`, so a routing workflow
// cannot see a dropped input itself. pi-light therefore announces each input: `received` before the
// asynchronous controller selection (a newer human input revokes earlier authority at once), then
// exactly one of `accepted` or `handled` (dropped: nothing may stay bound to it).
export const INPUT_PREFLIGHT_QUERY = 'pi-light:input:query';
export const INPUT_RECEIVED = 'pi-light:input:received';
export const INPUT_ACCEPTED = 'pi-light:input:accepted';
export const INPUT_HANDLED = 'pi-light:input:handled';

export interface InputSignal {
  text: string;
  source: string;
  streamingBehavior?: string;
  ctx: ExtensionContext;
}

export interface InputPreflight {
  received(): void;
  accepted(): void;
  handled(): void;
}

/** Answer presence queries, so the workflow follows these signals instead of its own input handler. */
export function answerInputPreflightQueries(events: EventBus): void {
  events.on(INPUT_PREFLIGHT_QUERY, data => {
    const query = data as { reply?: unknown } | undefined;
    if (typeof query?.reply === 'function') query.reply(true);
  });
}

/** Signals for one input dispatch; every signal carries the same payload. */
export function inputPreflight(events: EventBus, signal: InputSignal): InputPreflight {
  return {
    received: () => events.emit(INPUT_RECEIVED, signal),
    accepted: () => events.emit(INPUT_ACCEPTED, signal),
    handled: () => events.emit(INPUT_HANDLED, signal),
  };
}
