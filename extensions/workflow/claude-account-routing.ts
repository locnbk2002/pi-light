/**
 * Per-session Claude account rotation for the claude-bridge controller.
 *
 * A virtual route can only choose a model, not request options, so accounts are served through a
 * thin wrapper provider (`pi-light-claude/<id>`). Its stream delegates to the matching claude-bridge
 * model through the model registry with `env.CLAUDE_CODE_OAUTH_TOKEN` set to the chosen account's
 * token, and wraps `onResponse` so every usage report updates that account's state before reaching
 * Pi. Responses still name claude-bridge, so history, fallback chains and the bridge are unchanged.
 */
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { accountsForModel, blockAccount, blockModel, chooseAccount, inReserve, loadAccounts, parseUsageHeaders, recordUsage, redactSecrets,
  StateStore, tokenFingerprint, type AccountChoice, type AccountModels, type Candidate, type SessionPin, type StoredAccount } from './claude-accounts.ts';

export const BRIDGE_PROVIDER = 'claude-bridge';
export const ACCOUNT_PROVIDER = 'pi-light-claude';
const REBUILD_HOOKS = Symbol.for('claude-bridge:markRebuildHooks');

export function accountsDir(agentDir: string): string { return join(agentDir, 'pi-light', 'claude-accounts'); }

// An account limit names the plan's quota. Overload and capacity errors are not about the account,
// so they keep the model-level fallback.
const ACCOUNT_LIMIT = /quota|usage.?limit|rate.?limit|too many requests|(?<![a-z0-9])429(?![a-z0-9])|subscription_sharing_usage|resource.?exhausted/i;
// The account cannot run this model (not offered, or it needs usage credits the plan lacks, or its own
// allowance is spent): only this model moves, and the account keeps serving its other models.
const MODEL_UNAVAILABLE = /spend limit|credits_required|usage credits|usage_not_included|overage_included|issue with the selected model|may not exist or you may not have access|not_found_error/i;
const NOT_ACCOUNT_LIMIT = /overloaded|(?<![a-z0-9])529(?![a-z0-9])|at capacity|server_busy/i;
// An edge/WAF challenge page (Cloudflare "Attention Required", "Just a moment") blocks the network path,
// not the token: Claude Code wraps it as "Failed to authenticate", but banning the token would be wrong.
// Match only challenge-page titles: a real 401/429 that merely mentions Cloudflare keeps its classification.
const EDGE_BLOCK = /attention required|just a moment/i;
const AUTH = /(?<![a-z0-9])401(?![a-z0-9])|authentication_error|failed to authenticate|oauth (?:access )?token (?:is )?(?:invalid|expired|revoked)|invalid (?:oauth|bearer|access) token|token (?:has )?(?:expired|been revoked)/i;

export type AccountFailure = 'limit' | 'auth' | 'model';
/** Account-specific failure kind of a failed claude-bridge response, if any. */
export function accountFailureKind(stopReason: unknown, errorMessage: unknown): AccountFailure | undefined {
  if (stopReason !== 'error' || typeof errorMessage !== 'string') return undefined;
  if (EDGE_BLOCK.test(errorMessage)) return undefined;
  if (AUTH.test(errorMessage)) return 'auth';
  if (MODEL_UNAVAILABLE.test(errorMessage)) return 'model';
  if (ACCOUNT_LIMIT.test(errorMessage) && !NOT_ACCOUNT_LIMIT.test(errorMessage)) return 'limit';
  return undefined;
}

/** A failed attempt can be replayed only if it showed nothing and asked for no tool. */
export function safeToReplay(message: { content?: readonly { type: string; text?: string }[] }): boolean {
  return (message.content ?? []).every(block => block.type === 'thinking' || (block.type === 'text' && !block.text?.trim()));
}

type Registry = ExtensionContext['modelRegistry'];
type Model = NonNullable<ReturnType<Registry['find']>>;
type StreamOptions = Parameters<Registry['streamSimple']>[2];

export interface FailoverResult {
  /** Account that failed (the one the failed request used). */
  failed?: string;
  /** Account the next request will use; undefined when none is left. */
  next?: string;
}

/** Account and token a request used or will use. */
export interface AccountIdentity { name: string; fingerprint: string }
/** A pin's `at` is refreshed on disk at most this often when nothing else changed. */
const PIN_REFRESH_MS = 10 * 60_000;

export class ClaudeAccountRouter {
  readonly dir: string;
  private readonly store: StateStore;
  private readonly now: () => number;
  private readonly models?: AccountModels;
  private accounts: StoredAccount[] = [];
  private problems: string[] = [];
  private session = 'default';
  /**
   * Account each model's latest route chose (key `*` for a route without a model). A stream uses its own
   * model's entry, so a nested route for another model (Pi compacting between a route and its stream)
   * cannot move it.
   */
  private chosen = new Map<string, string>();
  /** Account and token of the latest stream in this session: a change means the bridge must rebuild. */
  private lastStreamed?: AccountIdentity;
  /** Model of the latest stream in this session. */
  private lastStreamedModel?: string;
  /** Account and token of each model's latest stream: a failure of that model is charged to it. */
  private streamedByModel = new Map<string, AccountIdentity>();
  /** A rejected usage report on the latest stream that blocked only its model on that account. */
  private modelRejection?: { account: string; model: string };
  /**
   * This session's latest pins, one per set of accounts that may serve a model, so Mythos on one
   * account and Fable on another each keep their own account. Keyed like the disk pins.
   */
  private pins = new Map<string, SessionPin>();
  /** Per pin key: time of the newest disk pin this process saw or wrote at a boundary; a later one is another process's. */
  private diskPinAt = new Map<string, number>();
  private registry?: Registry;
  /** True while the wrapper provider is installed for this session: Claude then runs only through it. */
  serving = false;
  notify: (text: string, level: 'info' | 'warning' | 'error') => void = () => {};
  status: (text: string | undefined) => void = () => {};

  /** `models` maps account names to the model ids they serve; without it every account serves every model. */
  constructor(dir: string, now: () => number = Date.now, store = new StateStore(dir), models?: AccountModels) {
    this.dir = dir;
    this.now = now;
    this.store = store;
    this.models = models;
    this.reload();
  }

  reload(): string[] {
    ({ accounts: this.accounts, problems: this.problems } = loadAccounts(this.dir));
    return this.problems;
  }
  get active(): boolean { return this.accounts.length > 0; }
  get names(): string[] { return this.accounts.map(account => account.name); }
  get count(): number { return this.accounts.length; }
  /** Accounts that may serve `model` (all of them without a model map). */
  eligible(model: string | undefined): string[] { return accountsForModel(this.names, this.models, model); }
  private candidates(model: string | undefined): Candidate[] {
    const allowed = new Set(this.eligible(model));
    return this.accounts.filter(account => allowed.has(account.name))
      .map(account => ({ name: account.name, fingerprint: tokenFingerprint(account.token) }));
  }
  /** Disk pin key: the session alone while every account serves the model, else one per account set. */
  private pinKey(model: string | undefined): string {
    const allowed = this.eligible(model);
    return allowed.length === this.accounts.length ? this.session : `${this.session}#${allowed.join(',')}`;
  }

  /**
   * Bind to a session: its pin key and the registry the wrapper stream delegates through. Binding the
   * same session again (a reload) keeps what it last streamed, so a changed account still rebuilds.
   */
  startSession(sessionId: string, registry: Registry): void {
    const session = sessionId || 'default';
    if (session !== this.session) {
      this.chosen.clear();
      this.streamedByModel.clear();
      this.lastStreamed = undefined;
      this.lastStreamedModel = undefined;
      this.modelRejection = undefined;
      this.pins.clear();
      this.diskPinAt.clear();
    }
    this.session = session;
    this.registry = registry;
  }

  /** Identity of the latest stream in this session. */
  get streamedIdentity(): AccountIdentity | undefined { return this.lastStreamed; }
  /** Identity of `model`'s latest stream (the account a failed request of that model used). */
  streamedIdentityFor(model: string | undefined): AccountIdentity | undefined {
    return (model !== undefined ? this.streamedByModel.get(model) : undefined) ?? this.lastStreamed;
  }
  /** Identity a request on `name` would use now. */
  identity(name: string): AccountIdentity | undefined {
    const account = this.accounts.find(item => item.name === name);
    return account && { name: account.name, fingerprint: tokenFingerprint(account.token) };
  }

  /** Wrapper provider mirroring the claude-bridge models in `ids`; undefined when none is installed. */
  providerConfig(ids: readonly string[]): Parameters<ExtensionAPI['registerProvider']>[1] | undefined {
    const registry = this.registry;
    if (!registry) return undefined;
    const models = ids.flatMap(id => {
      const base = registry.find(BRIDGE_PROVIDER, id);
      if (!base || !('contextWindow' in base)) return [];
      return [{ id: base.id, name: `${base.name} (Claude account)`, reasoning: base.reasoning, input: base.input, cost: base.cost,
        contextWindow: base.contextWindow, maxTokens: base.maxTokens,
        ...(base.thinkingLevelMap ? { thinkingLevelMap: base.thinkingLevelMap } : {}),
        ...(base.promptCache ? { promptCache: base.promptCache } : {}) }];
    });
    if (!models.length) return undefined;
    return {
      name: 'Claude accounts (pi-light)', baseUrl: ACCOUNT_PROVIDER, apiKey: 'not-used', api: ACCOUNT_PROVIDER, models,
      streamSimple: (model, context, options) => this.stream(model as Model, context, options),
    };
  }

  private stream(model: Model, context: Parameters<Registry['streamSimple']>[1], options: StreamOptions) {
    const registry = this.registry;
    const base = registry?.find(BRIDGE_PROVIDER, model.id);
    if (!registry || !base) throw new Error(`claude-bridge model ${model.id} is not available.`);
    // Never fall back to another account or the bridge's own login: the route chose this one.
    const name = this.chosen.get(model.id) ?? this.chosen.get('*');
    const account = this.accounts.find(item => item.name === name);
    if (!account) throw new Error('No Claude account was chosen for this request.');
    if (!this.eligible(model.id).includes(account.name)) throw new Error(`Claude account ${account.name} does not serve ${model.id}.`);
    const identity = { name: account.name, fingerprint: tokenFingerprint(account.token) };
    const sessionId = (options as { sessionId?: unknown } | undefined)?.sessionId;
    const last = this.lastStreamed;
    if (last && (last.name !== identity.name || last.fingerprint !== identity.fingerprint) && typeof sessionId === 'string') {
      // The Claude Code session and prompt cache belong to the old login: rebuild from Pi's history.
      // A rebuild also starts a new Claude Code query, and the bridge holds usage reports per query,
      // so every report delivered below comes from a query that ran with this account's token.
      const hooks = (globalThis as Record<symbol, unknown>)[REBUILD_HOOKS] as Set<(session: string | null, event: string) => void> | undefined;
      for (const hook of hooks ?? []) {
        try { hook(sessionId, 'pi-light claude account switch'); } catch { /* the bridge then decides itself */ }
      }
    }
    this.lastStreamed = identity;
    this.lastStreamedModel = model.id;
    this.streamedByModel.set(model.id, identity);
    this.modelRejection = undefined;
    return registry.streamSimple(base, context, {
      ...options,
      env: { ...(options?.env ?? {}), CLAUDE_CODE_OAUTH_TOKEN: account.token },
      onResponse: async (response, responseModel) => {
        try { await this.recordHeaders(account.name, response.headers, model.id); } catch { /* usage bookkeeping never fails a turn */ }
        await options?.onResponse?.(response, responseModel);
      },
    });
  }

  async recordHeaders(account: string, headers: Record<string, string> | undefined, model?: string): Promise<void> {
    const now = this.now();
    const parsed = parseUsageHeaders(headers, now);
    if (!parsed.usage && !parsed.status) return;
    const state = this.store.read();
    const block = recordUsage(state, account, parsed, now, model);
    const record = state.accounts[account] ?? {};
    // Store only what this report carried: the newest sample of each window wins when the state is read.
    const sample = { at: now, ...(parsed.usage?.fiveHour ? { fiveHour: parsed.usage.fiveHour } : {}),
      ...(parsed.usage?.sevenDay ? { sevenDay: parsed.usage.sevenDay } : {}),
      ...(parsed.usage?.sevenDayIncluded ? { sevenDayIncluded: parsed.usage.sevenDayIncluded } : {}),
      ...(block !== undefined && block.model === undefined && record.limitResetsAt !== undefined ? { limitResetsAt: record.limitResetsAt } : {}) };
    if (Object.keys(sample).length > 1) this.store.addUsage(account, sample);
    if (block?.model !== undefined) {
      this.store.addBlock(account, block.until, record.modelBlocks?.[block.model]?.reason ?? `${block.model} rejected`, block.model);
      this.modelRejection = { account, model: block.model };
    } else if (block !== undefined) this.store.addBlock(account, block.until, record.blockReason ?? 'usage limit reported');
  }

  /**
   * Account for the next request. `boundary` (new user turn, retry or failover) may move the session;
   * continuations keep their account. Undefined means every account is blocked, failed or in reserve.
   */
  async pick(boundary: boolean, model?: string): Promise<string | undefined> {
    const choice = await this.choose(boundary, model);
    if (choice.changed && choice.account) this.notify(`Claude account: ${choice.previous} -> ${choice.account} (${choice.previous} is limited or in its 10% reserve).`, 'info');
    return choice.account;
  }

  private async choose(boundary: boolean, model?: string): Promise<AccountChoice> {
    const now = this.now();
    this.store.prune(now);
    const state = this.store.read();
    const key = this.pinKey(model);
    // This session's own pin also lives in memory. A continuation always keeps it, so neither a missing
    // pin file nor another process's newer pin for the same session moves a healthy request. At a
    // boundary (new turn, retry, failover) a pin another process wrote after this one last looked is
    // taken over.
    const stored = state.pins[key];
    const seen = this.diskPinAt.get(key);
    const foreign = boundary && !!stored && (seen === undefined || stored.at > seen);
    const own = this.pins.get(key);
    if (own && !foreign) state.pins[key] = { ...own };
    const choice = chooseAccount(state, key, this.candidates(model), now, boundary, model);
    const pin = state.pins[key];
    if (pin) this.pins.set(key, { ...pin }); else this.pins.delete(key);
    // Only a boundary writes the pin, so a continuation never overwrites another process's newer pin for
    // the same session. Compare with what is on disk: write when the file is missing, differs, or its
    // timestamp is getting old (every user turn is a boundary, so an active pin never expires).
    if (boundary && pin && (!stored || stored.account !== pin.account || JSON.stringify(stored.left) !== JSON.stringify(pin.left)
      || pin.at - stored.at > PIN_REFRESH_MS)) {
      this.store.writePin(key, pin);
      this.diskPinAt.set(key, pin.at);
    } else if (boundary && stored) this.diskPinAt.set(key, stored.at);
    if (choice.account) this.chosen.set(model ?? '*', choice.account); else this.chosen.delete(model ?? '*');
    this.status(choice.account ? `claude: ${choice.account}` : 'claude: no account available');
    return choice;
  }

  /**
   * Record a failed request of `model` on its account and choose the next account for the session. A
   * model failure, or a limit whose usage report rejected only this model, blocks just that model.
   */
  async failover(kind: AccountFailure, errorMessage: unknown, model = this.lastStreamedModel): Promise<FailoverResult> {
    const streamed = this.streamedIdentityFor(model);
    const failed = streamed?.name ?? (model !== undefined ? this.chosen.get(model) : undefined) ?? this.chosen.get('*');
    if (!failed) return {};
    const fingerprint = streamed?.name === failed ? streamed.fingerprint
      : tokenFingerprint(this.accounts.find(item => item.name === failed)?.token ?? '');
    const now = this.now();
    const reason = redactSecrets(typeof errorMessage === 'string' ? errorMessage.split('\n')[0] : 'unknown error');
    const rejected = this.modelRejection;
    const modelOnly = model !== undefined && (kind === 'model' || (kind === 'limit' && rejected?.account === failed && rejected.model === model));
    if (kind === 'auth') this.store.addAuthFailure(failed, fingerprint, now, reason);
    else if (modelOnly) this.store.addBlock(failed, blockModel(this.store.read(), failed, model, reason, now), reason, model);
    else this.store.addBlock(failed, blockAccount(this.store.read(), failed, reason, now), reason);
    const next = (await this.choose(true, model)).account;
    return { failed, next: next === failed ? undefined : next };
  }

  /** Human-readable status lines; never includes a token. */
  describe(): string[] {
    const now = this.now();
    const state = this.store.read();
    const pct = (value: number | undefined) => value === undefined ? '?' : `${Math.round(value * 100)}%`;
    const when = (ms: number | undefined) => ms === undefined ? '?' : new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + 'Z';
    const lines = this.accounts.map(account => {
      const record = state.accounts[account.name];
      const usage = record?.usage;
      const flags = [
        record?.blockedUntil && record.blockedUntil > now ? `blocked until ${when(record.blockedUntil)} (${record.blockReason ?? 'limit'})` : '',
        ...Object.entries(record?.modelBlocks ?? {}).filter(([, block]) => block.until > now)
          .map(([model, block]) => `${model} blocked until ${when(block.until)} (${block.reason})`),
        ...(record?.authFailures ?? []).filter(item => item.fingerprint === tokenFingerprint(account.token))
          .map(item => `login rejected (${item.reason}); run the claude-accounts add command again`),
        record?.unreadable ? 'usage unreadable; treated as in reserve' : usage && inReserve(state, account.name, now) ? 'in reserve' : '',
      ].filter(Boolean);
      const org = account.orgUuid ? ` org ${account.orgUuid.slice(0, 8)}…` : '';
      const included = usage?.sevenDayIncluded ? `, Fable allowance ${pct(usage.sevenDayIncluded.used)}` : '';
      const measured = usage ? `5h ${pct(usage.fiveHour?.used)} (reset ${when(usage.fiveHour?.resetsAt)}), 7d ${pct(usage.sevenDay?.used)} (reset ${when(usage.sevenDay?.resetsAt)})${included}, measured ${when(usage.measuredAt)}` : 'no usage measured yet';
      const serves = this.models ? ` [${(this.models[account.name] ?? []).join(', ') || 'no models'}]` : '';
      const pinned = Object.entries(state.pins).some(([key, pin]) => (key === this.session || key.startsWith(`${this.session}#`)) && pin.account === account.name);
      return `${pinned ? '*' : ' '} ${account.name}${org}${serves}: ${measured}${flags.length ? ` — ${flags.join('; ')}` : ''}`;
    });
    if (!lines.length) lines.push(`No Claude accounts in ${this.dir}.`);
    for (const problem of this.problems) lines.push(`! ${problem}`);
    return lines;
  }
}

