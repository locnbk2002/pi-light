import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { ADVISORS, MAIN_MODEL } from './controller-policy.ts';

/** Fallback chains are ordered 'provider/model' references; the first entry is preferred. */
export type FallbackRole = 'controller' | 'astra' | 'fable';
export type ModelChains = Readonly<Record<FallbackRole, readonly string[]>>;
export const ROLES: readonly FallbackRole[] = ['controller', 'astra', 'fable'];
export const VIRTUAL_CONTROLLER = { provider: 'pi-light', id: 'controller', name: 'Opus (fallback)' } as const;
export const DEFAULT_COOLDOWN_MS = 10 * 60_000;

const ref = (model: { provider: string; model: string }) => `${model.provider}/${model.model}`;
const SOL = 'openai-codex/gpt-6.1-sol';
export const DEFAULT_CHAINS: ModelChains = Object.freeze({
  controller: Object.freeze([ref(MAIN_MODEL), SOL]),
  // Advisors fall back only to each other; Sol stays a controller-only fallback.
  astra: Object.freeze([ref(ADVISORS.astra), ref(ADVISORS.fable)]),
  fable: Object.freeze([ref(ADVISORS.fable), ref(ADVISORS.astra)]),
});

export function splitModel(model: string): { provider: string; id: string } {
  const slash = model.indexOf('/');
  return { provider: model.slice(0, slash), id: model.slice(slash + 1) };
}

// Strong signals name a quota, rate or capacity limit even inside a generic wrapper.
const STRONG_LIMIT = /rate.?limit|too many requests|(?<![a-z0-9])(?:429|529)(?![a-z0-9])|quota|usage.?limit|usage_not_included|credit balance|overloaded|resource.?exhausted|exhausted|server_busy|high demand|at capacity|subscription_sharing_usage/i;
// Explicit non-limit failures: never fall back for these (a fallback would mask the real problem).
const NOT_LIMIT = /cancel|abort|deadline|timed? ?out|invalid.?request|content.?policy|safety|refus|unauthori[sz]ed|authenticat|invalid.?(?:api.?)?key|incorrect.?(?:api.?)?key|(?<![a-z0-9])(?:400|401|403|404)(?![a-z0-9])|permission|forbidden|context.?(?:length|window|overflow)|prompt is too long|maximum context/i;
// Weaker transient capacity signals, only trusted when no explicit non-limit signal is present.
const CAPACITY = /(?<![a-z0-9])(?:502|503)(?![a-z0-9])|capacity|temporarily unavailable|service.?unavailable|bad gateway/i;

/** Pure classifier: does a failed model turn look like a provider limit or capacity error? */
export function isLimitOrCapacityError(stopReason: unknown, errorMessage: unknown): boolean {
  if (stopReason !== 'error' || typeof errorMessage !== 'string' || !errorMessage.trim()) return false;
  if (STRONG_LIMIT.test(errorMessage)) return true;
  if (NOT_LIMIT.test(errorMessage)) return false;
  return CAPACITY.test(errorMessage);
}

const MODEL_REF = /^[a-z0-9][a-z0-9._-]{0,63}\/[A-Za-z0-9][^\s]{0,199}$/;
const MAX_CHAIN = 8;

/** Strictly validate an override object; missing roles keep their defaults. */
export function parseModelChains(raw: unknown): ModelChains {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('top level must be an object');
  const input = raw as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!ROLES.includes(key as FallbackRole)) throw new Error(`unknown key "${key.slice(0, 40)}" (allowed: ${ROLES.join(', ')})`);
  }
  const chains = { ...DEFAULT_CHAINS } as Record<FallbackRole, readonly string[]>;
  for (const role of ROLES) {
    if (!(role in input)) continue;
    const list = input[role];
    if (!Array.isArray(list) || list.length < 1 || list.length > MAX_CHAIN) throw new Error(`${role} must be an array of 1-${MAX_CHAIN} entries`);
    for (const item of list) {
      if (typeof item !== 'string' || !MODEL_REF.test(item)) throw new Error(`${role} entries must be "provider/model" strings`);
      if (role === 'controller' && splitModel(item).provider === VIRTUAL_CONTROLLER.provider) throw new Error('controller cannot route to a virtual model');
    }
    if (new Set(list).size !== list.length) throw new Error(`${role} contains duplicate entries`);
    chains[role] = Object.freeze([...list as string[]]);
  }
  return Object.freeze(chains);
}

export function modelConfigPath(): string { return join(getAgentDir(), 'pi-light-models.json'); }

/** Read the optional override. A missing file means defaults; anything invalid means defaults plus an error. */
export function loadModelChains(path = modelConfigPath()): { chains: ModelChains; error?: string } {
  let text: string;
  try { text = readFileSync(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { chains: DEFAULT_CHAINS };
    return { chains: DEFAULT_CHAINS, error: `Pi Light model override ${path} is unreadable; using default fallback lists.` };
  }
  try {
    if (text.length > 64_000) throw new Error('file too large');
    return { chains: parseModelChains(JSON.parse(text)) };
  } catch (error) {
    // Report the validation reason only; never echo file contents.
    const reason = error instanceof SyntaxError ? 'invalid JSON' : error instanceof Error ? error.message : 'invalid';
    return { chains: DEFAULT_CHAINS, error: `Pi Light model override ${path} is invalid (${reason}); using default fallback lists.` };
  }
}

/** In-memory, per-Pi-run cooldown after a limit error, keyed by 'provider/model'. */
export class Cooldowns {
  private entries = new Map<string, { until: number; reason: string }>();
  constructor(private durationMs = DEFAULT_COOLDOWN_MS, private now: () => number = Date.now) {}
  mark(model: string, reason: string): void {
    this.entries.set(model, { until: this.now() + this.durationMs, reason });
  }
  get(model: string): { until: number; reason: string } | undefined {
    const entry = this.entries.get(model);
    if (entry && entry.until <= this.now()) {
      this.entries.delete(model);
      return undefined;
    }
    return entry;
  }
}

export interface CandidatePlan {
  /** Models to try in order. Non-cooled available candidates; if none, the soonest-expiring cooled one. */
  order: string[];
  /** Preferred-chain entries not tried first, each formatted 'provider/model: reason'. */
  skipped: string[];
  /** True when every available candidate is cooling down. */
  exhausted: boolean;
}

/** Order a chain for one call: skip candidates without credentials, then cooled ones. */
export function planCandidates(chain: readonly string[], cooldowns: Cooldowns, isAvailable: (model: string) => boolean): CandidatePlan {
  const order: string[] = [];
  const skipped: string[] = [];
  const cooled: { model: string; until: number }[] = [];
  for (const model of chain) {
    if (!isAvailable(model)) { skipped.push(`${model}: no credentials or unknown model`); continue; }
    const cooldown = cooldowns.get(model);
    if (cooldown) {
      cooled.push({ model, until: cooldown.until });
      skipped.push(`${model}: cooling down after ${cooldown.reason}`);
    } else order.push(model);
  }
  const exhausted = order.length === 0;
  if (exhausted && cooled.length) {
    // Never lock the role out for the whole cooldown; try the soonest-expiring candidate once.
    const retry = cooled.reduce((best, item) => item.until < best.until ? item : best).model;
    order.push(retry);
    skipped.splice(skipped.findIndex(item => item.startsWith(`${retry}:`)), 1);
  }
  return { order, skipped, exhausted };
}

export interface ControllerRouteInput {
  reason: 'user' | 'continuation' | 'retry' | 'direct';
  previous?: string;
  failed?: { model: string; stopReason?: unknown; errorMessage?: unknown };
}
export interface ControllerRouteDecision {
  model: string;
  /** Set when the decision just cooled the failed model; carries its redacted reason. */
  cooled?: { model: string; reason: string };
}

/**
 * Pure controller routing. Tool continuations and non-limit retries stay sticky so prompt
 * caches and thinking signatures remain valid; limit retries cool the failed model and move on.
 */
export function routeController(input: ControllerRouteInput, chain: readonly string[], cooldowns: Cooldowns,
  isAvailable: (model: string) => boolean, redact: (message: unknown) => string): ControllerRouteDecision {
  const { failed, previous } = input;
  if (input.reason === 'retry' && failed) {
    if (!isLimitOrCapacityError(failed.stopReason, failed.errorMessage)) return { model: failed.model };
    const reason = redact(failed.errorMessage);
    if (chain.includes(failed.model)) cooldowns.mark(failed.model, reason);
    const plan = planCandidates(chain, cooldowns, isAvailable);
    // Every candidate is limited: keep Pi's own bounded backoff on the failed model.
    if (plan.exhausted || !plan.order.length) return { model: failed.model, cooled: { model: failed.model, reason } };
    return { model: plan.order[0], cooled: { model: failed.model, reason } };
  }
  if (input.reason === 'continuation' && previous && chain.includes(previous) && !cooldowns.get(previous) && isAvailable(previous)) {
    return { model: previous };
  }
  const plan = planCandidates(chain, cooldowns, isAvailable);
  if (!plan.order.length) throw new Error('No controller fallback model has credentials. Check /login or pi-light-models.json.');
  return { model: plan.order[0] };
}
