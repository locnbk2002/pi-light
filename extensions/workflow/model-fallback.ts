import { existsSync, readFileSync } from 'node:fs';
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
const PROVIDER = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * Vendor family of a 'provider/model' reference, judged by model id so provider renames
 * (e.g. claude-bridge serving Claude) do not hide it. Unknown ids fall back to the provider name.
 */
export function modelFamily(model: string): string {
  const { provider, id } = splitModel(model);
  if (/claude|opus|sonnet|haiku|fable/i.test(id)) return 'anthropic';
  if (/gpt|codex|(?:^|[-_.])o\d|sol|astra/i.test(id)) return 'openai';
  if (/gemini/i.test(id)) return 'google';
  return provider;
}

/**
 * Reviewer for work written by `implementer`: the first configured model (controller chain first,
 * then advisor chains) from a different vendor family, so the review does not share the author's blind spots.
 */
export function reviewerModel(chains: ModelChains, implementer: string, isAvailable: (model: string) => boolean = () => true): string | undefined {
  const family = modelFamily(implementer);
  return [...chains.controller, ...chains.astra, ...chains.fable].find(model => modelFamily(model) !== family && isAvailable(model));
}

/** Rename the provider of a 'provider/model' reference (e.g. anthropic -> claude-bridge on a machine logged in elsewhere). */
export function renameProvider(model: string, providers: Readonly<Record<string, string>>): string {
  const { provider, id } = splitModel(model);
  return provider in providers ? `${providers[provider]}/${id}` : model;
}

/**
 * Extension-backed providers that advisor children (started with --no-extensions) must load explicitly.
 * Paths are Pi's git package checkouts under the agent directory; setup installs these packages.
 */
const EXTENSION_PROVIDERS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'claude-bridge': ['git', 'github.com', 'elidickinson', 'pi-claude-bridge'],
});
export function providerExtension(provider: string, agentDir = getAgentDir()): string | undefined {
  const parts = EXTENSION_PROVIDERS[provider];
  if (!parts) return undefined;
  const path = join(agentDir, ...parts);
  return existsSync(path) ? path : undefined;
}
const MAX_CHAIN = 8;
/** Keys owned by the effort judge; parsed separately so they can never reset the chains above. */
const EFFORT_KEYS = ['effort', 'judge'] as const;

function asObject(raw: unknown, what: string): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${what} must be an object`);
  return raw as Record<string, unknown>;
}

/** Optional provider rename map, applied to every chain entry (defaults and overrides alike). */
function parseProviders(input: Record<string, unknown>): Record<string, string> {
  const providers: Record<string, string> = {};
  if (!('providers' in input)) return providers;
  const map = input.providers;
  if (map === null || typeof map !== 'object' || Array.isArray(map)) throw new Error('providers must be an object of "from": "to" names');
  for (const [from, to] of Object.entries(map as Record<string, unknown>)) {
    if (!PROVIDER.test(from) || typeof to !== 'string' || !PROVIDER.test(to)) throw new Error('providers entries must map provider names to provider names');
    if (to === VIRTUAL_CONTROLLER.provider) throw new Error('providers cannot rename to the virtual controller provider');
    providers[from] = to;
  }
  return providers;
}

/** Validate one chain list; physical models only (the virtual controller cannot be a candidate). */
function parseChain(role: string, list: unknown): readonly string[] {
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_CHAIN) throw new Error(`${role} must be an array of 1-${MAX_CHAIN} entries`);
  for (const item of list) {
    if (typeof item !== 'string' || !MODEL_REF.test(item)) throw new Error(`${role} entries must be "provider/model" strings`);
    if (splitModel(item).provider === VIRTUAL_CONTROLLER.provider) throw new Error(`${role} cannot route to a virtual model`);
  }
  if (new Set(list).size !== list.length) throw new Error(`${role} contains duplicate entries`);
  return list as string[];
}

function renameChain(role: string, chain: readonly string[], providers: Readonly<Record<string, string>>): readonly string[] {
  const renamed = chain.map(model => renameProvider(model, providers));
  if (new Set(renamed).size !== renamed.length) throw new Error(`${role} contains duplicate entries after provider renames`);
  return Object.freeze(renamed);
}

/** Strictly validate an override object; missing roles keep their defaults. Effort keys are ignored here. */
export function parseModelChains(raw: unknown): ModelChains {
  const input = asObject(raw, 'top level');
  for (const key of Object.keys(input)) {
    if (key !== 'providers' && !ROLES.includes(key as FallbackRole) && !(EFFORT_KEYS as readonly string[]).includes(key)) {
      throw new Error(`unknown key "${key.slice(0, 40)}" (allowed: ${ROLES.join(', ')}, providers, ${EFFORT_KEYS.join(', ')})`);
    }
  }
  const providers = parseProviders(input);
  const chains = { ...DEFAULT_CHAINS } as Record<FallbackRole, readonly string[]>;
  for (const role of ROLES) if (role in input) chains[role] = parseChain(role, input[role]);
  for (const role of ROLES) chains[role] = renameChain(role, chains[role], providers);
  return Object.freeze(chains);
}

/** Reasoning levels the judge may choose, lowest first. `max` is never chosen automatically. */
export const JUDGE_LEVELS = ['low', 'medium', 'high', 'xhigh'] as const;
export type JudgeLevel = typeof JUDGE_LEVELS[number];
export interface EffortSettings {
  enabled: boolean;
  /** Level used when the judge fails or runs out of time. */
  fallback: JudgeLevel;
  /** Highest level the judge may resolve. */
  ceiling: JudgeLevel;
  /** One total deadline for the whole judge chain. */
  timeoutMs: number;
  /** Ordered judge models, provider renames applied. */
  judge: readonly string[];
}
// Spike 6 (2026-11-09): direct Anthropic haiku p95 2.7 s, gpt-5.6-luna p95 3.0 s.
export const DEFAULT_EFFORT: EffortSettings = Object.freeze({
  enabled: true, fallback: 'medium', ceiling: 'xhigh', timeoutMs: 8000,
  judge: Object.freeze(['anthropic/claude-haiku-5-5', 'openai-codex/gpt-5.6-luna']),
});
const DISABLED_EFFORT: EffortSettings = Object.freeze({ ...DEFAULT_EFFORT, enabled: false });
const EFFORT_FIELDS = ['enabled', 'fallback', 'ceiling', 'timeoutMs'];

function judgeLevel(field: string, value: unknown): JudgeLevel {
  if (typeof value !== 'string' || !(JUDGE_LEVELS as readonly string[]).includes(value)) throw new Error(`effort.${field} must be one of ${JUDGE_LEVELS.join(', ')}`);
  return value as JudgeLevel;
}

/**
 * Effort settings, isolated from the chains and failing closed: any invalid effort, judge or
 * providers value disables judging (never re-enables it), and an explicit enabled:false always wins.
 */
export function parseEffortSettings(raw: unknown): { effort: EffortSettings; error?: string } {
  try {
    const input = asObject(raw, 'top level');
    const block = 'effort' in input ? asObject(input.effort, 'effort') : {};
    if (block.enabled === false) return { effort: DISABLED_EFFORT };
    for (const key of Object.keys(block)) if (!EFFORT_FIELDS.includes(key)) throw new Error(`unknown effort key "${key.slice(0, 40)}"`);
    if ('enabled' in block && block.enabled !== true) throw new Error('effort.enabled must be true or false');
    // Default only an absent key: a supplied null or wrong type is invalid and disables judging.
    const timeoutMs = 'timeoutMs' in block ? block.timeoutMs : DEFAULT_EFFORT.timeoutMs;
    if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 30_000) throw new Error('effort.timeoutMs must be an integer from 500 to 30000');
    const fallback = 'fallback' in block ? judgeLevel('fallback', block.fallback) : DEFAULT_EFFORT.fallback;
    const ceiling = 'ceiling' in block ? judgeLevel('ceiling', block.ceiling) : DEFAULT_EFFORT.ceiling;
    if (JUDGE_LEVELS.indexOf(fallback) > JUDGE_LEVELS.indexOf(ceiling)) throw new Error('effort.fallback cannot exceed effort.ceiling');
    const judge = renameChain('judge', 'judge' in input ? parseChain('judge', input.judge) : DEFAULT_EFFORT.judge, parseProviders(input));
    return { effort: Object.freeze({ enabled: true, fallback, ceiling, timeoutMs, judge }) };
  } catch (error) {
    return { effort: DISABLED_EFFORT, error: error instanceof Error ? error.message : 'invalid' };
  }
}

export function modelConfigPath(): string { return join(getAgentDir(), 'pi-light-models.json'); }

export interface ModelConfig {
  chains: ModelChains;
  /** Chain problem; the default chains are in use. */
  error?: string;
  effort: EffortSettings;
  /** Effort problem; judging is disabled. Independent of `error`. */
  effortError?: string;
}

/**
 * Read the optional override. A missing file means defaults. Invalid chains mean default chains plus
 * `error`; invalid effort settings (or an unreadable file) disable judging plus `effortError`.
 * Messages carry the validation reason only, never file contents.
 */
export function loadModelChains(path = modelConfigPath()): ModelConfig {
  const failed = (reason: string, chains: string, effort = reason): ModelConfig => ({
    chains: DEFAULT_CHAINS, error: `Pi Light model override ${path} is ${chains}; using default fallback lists.`,
    effort: DISABLED_EFFORT, effortError: `Pi Light model override ${path} is ${effort}; effort judging is disabled.`,
  });
  let text: string;
  try { text = readFileSync(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { chains: DEFAULT_CHAINS, effort: DEFAULT_EFFORT };
    return failed('unreadable', 'unreadable');
  }
  let raw: unknown;
  try {
    if (text.length > 64_000) throw new Error('file too large');
    raw = JSON.parse(text);
  } catch (error) {
    const reason = `invalid (${error instanceof SyntaxError ? 'invalid JSON' : error instanceof Error ? error.message : 'invalid'})`;
    return failed(reason, reason);
  }
  const config: ModelConfig = { chains: DEFAULT_CHAINS, effort: DEFAULT_EFFORT };
  try { config.chains = parseModelChains(raw); }
  catch (error) {
    config.error = `Pi Light model override ${path} is invalid (${error instanceof Error ? error.message : 'invalid'}); using default fallback lists.`;
  }
  const parsed = parseEffortSettings(raw);
  config.effort = parsed.effort;
  if (parsed.error) config.effortError = `Pi Light model override ${path} has invalid effort settings (${parsed.error}); effort judging is disabled.`;
  return config;
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
