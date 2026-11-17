// Model facts shared over Pi's event bus (pi.events), so an optional workflow package (for example
// pi-light-kit's routing) can name the reviewer model and include the effort-judge instruction
// without importing pi-light. Pi's bus is a node EventEmitter: emit() runs listeners synchronously,
// so the synchronous reply below answers before emit() returns.
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

export const MODELS_QUERY = 'pi-light:models:query';

export interface PiLightModels {
  /** The model implementing the work, as provider/id. */
  controllerModel: string;
  /** Vendor family of the controller model. */
  controllerFamily: string;
  /** First available configured model of another family; absent when there is none. */
  reviewerModel?: string;
  /** Delegation instruction for the effort judge; present only while the judge is on. */
  effortInstruction?: string;
}

/** Query payload. `ctx` is the asking turn's context, used for model availability. */
export interface ModelsQuery {
  ctx?: unknown;
  reply(answer: PiLightModels): void;
}

interface EventBus { on(channel: string, handler: (data: unknown) => void): unknown }

/** The judge reads this line from each subagent task to pick the child's reasoning effort. */
export const EFFORT_INSTRUCTION = 'Start each subagent task with one line "solutionSpace: ..." (at most 2,000 characters) saying how open-ended the problem is (fix given vs. open cause), not how much work it is; a small judge model uses it to pick the child\'s reasoning effort. Add a :level suffix to model only when the user asked for a specific effort.';

function turnContext(value: unknown): ExtensionContext | undefined {
  const registry = (value as { modelRegistry?: { find?: unknown; hasConfiguredAuth?: unknown } } | undefined)?.modelRegistry;
  return typeof registry?.find === 'function' && typeof registry.hasConfiguredAuth === 'function' ? value as ExtensionContext : undefined;
}

/** Provider side: answer every query from current state. A query without a usable ctx gets `undefined`. */
export function answerModelsQueries(events: EventBus, answer: (ctx: ExtensionContext | undefined) => PiLightModels): void {
  events.on(MODELS_QUERY, data => {
    const query = data as Partial<ModelsQuery> | undefined;
    if (typeof query?.reply === 'function') query.reply(answer(turnContext(query.ctx)));
  });
}
