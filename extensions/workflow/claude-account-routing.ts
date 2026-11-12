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
import { blockAccount, chooseAccount, inReserve, loadAccounts, parseUsageHeaders, recordUsage, redactSecrets, StateStore,
  tokenFingerprint, type AccountChoice, type Candidate, type SessionPin, type StoredAccount } from './claude-accounts.ts';

export const BRIDGE_PROVIDER = 'claude-bridge';
export const ACCOUNT_PROVIDER = 'pi-light-claude';
const REBUILD_HOOKS = Symbol.for('claude-bridge:markRebuildHooks');

export function accountsDir(agentDir: string): string { return join(agentDir, 'pi-light', 'claude-accounts'); }

// An account limit names the plan's quota. Overload and capacity errors are not about the account,
// so they keep the model-level fallback.
const ACCOUNT_LIMIT = /quota|usage.?limit|rate.?limit|too many requests|(?<![a-z0-9])429(?![a-z0-9])|usage_not_included|subscription_sharing_usage|resource.?exhausted/i;
const NOT_ACCOUNT_LIMIT = /overloaded|(?<![a-z0-9])529(?![a-z0-9])|at capacity|server_busy/i;
const AUTH = /(?<![a-z0-9])401(?![a-z0-9])|authentication_error|failed to authenticate|oauth (?:access )?token (?:is )?(?:invalid|expired|revoked)|invalid (?:oauth|bearer|access) token|token (?:has )?(?:expired|been revoked)/i;

export type AccountFailure = 'limit' | 'auth';
/** Account-specific failure kind of a failed claude-bridge response, if any. */
export function accountFailureKind(stopReason: unknown, errorMessage: unknown): AccountFailure | undefined {
  if (stopReason !== 'error' || typeof errorMessage !== 'string') return undefined;
  if (AUTH.test(errorMessage)) return 'auth';
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
  private accounts: StoredAccount[] = [];
  private problems: string[] = [];
  private session = 'default';
  /** Account chosen by the latest route; the next stream uses it. */
  private current?: string;
  /** Account and token of the latest stream in this session: a change means the bridge must rebuild. */
  private lastStreamed?: AccountIdentity;
  /** This session's latest pin. */
  private pin?: SessionPin;
  /** Time of the newest disk pin this process saw or wrote at a boundary; a later one is another process's. */
  private diskPinAt?: number;
  private registry?: Registry;
  /** True while the wrapper provider is installed for this session: Claude then runs only through it. */
  serving = false;
  notify: (text: string, level: 'info' | 'warning' | 'error') => void = () => {};
  status: (text: string | undefined) => void = () => {};

  constructor(dir: string, now: () => number = Date.now, store = new StateStore(dir)) {
    this.dir = dir;
    this.now = now;
    this.store = store;
    this.reload();
  }

  reload(): string[] {
    ({ accounts: this.accounts, problems: this.problems } = loadAccounts(this.dir));
    return this.problems;
  }
  get active(): boolean { return this.accounts.length > 0; }
  get names(): string[] { return this.accounts.map(account => account.name); }
  get count(): number { return this.accounts.length; }
  private candidates(): Candidate[] {
    return this.accounts.map(account => ({ name: account.name, fingerprint: tokenFingerprint(account.token) }));
  }

  /**
   * Bind to a session: its pin key and the registry the wrapper stream delegates through. Binding the
   * same session again (a reload) keeps what it last streamed, so a changed account still rebuilds.
   */
  startSession(sessionId: string, registry: Registry): void {
    const session = sessionId || 'default';
    if (session !== this.session) {
      this.current = undefined;
      this.lastStreamed = undefined;
      this.pin = undefined;
      this.diskPinAt = undefined;
    }
    this.session = session;
    this.registry = registry;
  }

  /** Identity of the latest stream in this session (the account a failed request used). */
  get streamedIdentity(): AccountIdentity | undefined { return this.lastStreamed; }
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
    const account = this.accounts.find(item => item.name === this.current);
    if (!account) throw new Error('No Claude account was chosen for this request.');
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
    return registry.streamSimple(base, context, {
      ...options,
      env: { ...(options?.env ?? {}), CLAUDE_CODE_OAUTH_TOKEN: account.token },
      onResponse: async (response, responseModel) => {
        try { await this.recordHeaders(account.name, response.headers); } catch { /* usage bookkeeping never fails a turn */ }
        await options?.onResponse?.(response, responseModel);
      },
    });
  }

  async recordHeaders(account: string, headers: Record<string, string> | undefined): Promise<void> {
    const now = this.now();
    const parsed = parseUsageHeaders(headers, now);
    if (!parsed.usage && !parsed.status) return;
    const state = this.store.read();
    const blockedUntil = recordUsage(state, account, parsed, now);
    const record = state.accounts[account] ?? {};
    // Store only what this report carried: the newest sample of each window wins when the state is read.
    const sample = { at: now, ...(parsed.usage?.fiveHour ? { fiveHour: parsed.usage.fiveHour } : {}),
      ...(parsed.usage?.sevenDay ? { sevenDay: parsed.usage.sevenDay } : {}),
      ...(blockedUntil !== undefined && record.limitResetsAt !== undefined ? { limitResetsAt: record.limitResetsAt } : {}) };
    if (Object.keys(sample).length > 1) this.store.addUsage(account, sample);
    if (blockedUntil !== undefined) this.store.addBlock(account, blockedUntil, record.blockReason ?? 'usage limit reported');
  }

  /**
   * Account for the next request. `boundary` (new user turn, retry or failover) may move the session;
   * continuations keep their account. Undefined means every account is blocked, failed or in reserve.
   */
  async pick(boundary: boolean): Promise<string | undefined> {
    const choice = await this.choose(boundary);
    if (choice.changed && choice.account) this.notify(`Claude account: ${choice.previous} -> ${choice.account} (${choice.previous} is limited or in its 10% reserve).`, 'info');
    return choice.account;
  }

  private async choose(boundary: boolean): Promise<AccountChoice> {
    const now = this.now();
    this.store.prune(now);
    const state = this.store.read();
    // This session's own pin also lives in memory. A continuation always keeps it, so neither a missing
    // pin file nor another process's newer pin for the same session moves a healthy request. At a
    // boundary (new turn, retry, failover) a pin another process wrote after this one last looked is
    // taken over.
    const stored = state.pins[this.session];
    const foreign = boundary && !!stored && (this.diskPinAt === undefined || stored.at > this.diskPinAt);
    if (this.pin && !foreign) state.pins[this.session] = { ...this.pin };
    const choice = chooseAccount(state, this.session, this.candidates(), now, boundary);
    const pin = state.pins[this.session];
    this.pin = pin && { ...pin };
    // Only a boundary writes the pin, so a continuation never overwrites another process's newer pin for
    // the same session. Compare with what is on disk: write when the file is missing, differs, or its
    // timestamp is getting old (every user turn is a boundary, so an active pin never expires).
    if (boundary && pin && (!stored || stored.account !== pin.account || JSON.stringify(stored.left) !== JSON.stringify(pin.left)
      || pin.at - stored.at > PIN_REFRESH_MS)) {
      this.store.writePin(this.session, pin);
      this.diskPinAt = pin.at;
    } else if (boundary && stored) this.diskPinAt = stored.at;
    this.current = choice.account;
    this.status(choice.account ? `claude: ${choice.account}` : 'claude: no account available');
    return choice;
  }

  /** Record a failed request on its account and choose the next account for the session. */
  async failover(kind: AccountFailure, errorMessage: unknown): Promise<FailoverResult> {
    const failed = this.lastStreamed?.name ?? this.current;
    if (!failed) return {};
    const fingerprint = this.lastStreamed?.name === failed ? this.lastStreamed.fingerprint
      : tokenFingerprint(this.accounts.find(item => item.name === failed)?.token ?? '');
    const now = this.now();
    const reason = redactSecrets(typeof errorMessage === 'string' ? errorMessage.split('\n')[0] : 'unknown error');
    if (kind === 'auth') this.store.addAuthFailure(failed, fingerprint, now, reason);
    else this.store.addBlock(failed, blockAccount(this.store.read(), failed, reason, now), reason);
    const next = (await this.choose(true)).account;
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
        ...(record?.authFailures ?? []).filter(item => item.fingerprint === tokenFingerprint(account.token))
          .map(item => `login rejected (${item.reason}); run the claude-accounts add command again`),
        record?.unreadable ? 'usage unreadable; treated as in reserve' : usage && inReserve(state, account.name, now) ? 'in reserve' : '',
      ].filter(Boolean);
      const org = account.orgUuid ? ` org ${account.orgUuid.slice(0, 8)}…` : '';
      const measured = usage ? `5h ${pct(usage.fiveHour?.used)} (reset ${when(usage.fiveHour?.resetsAt)}), 7d ${pct(usage.sevenDay?.used)} (reset ${when(usage.sevenDay?.resetsAt)}), measured ${when(usage.measuredAt)}` : 'no usage measured yet';
      return `${account.name === state.pins[this.session]?.account ? '*' : ' '} ${account.name}${org}: ${measured}${flags.length ? ` — ${flags.join('; ')}` : ''}`;
    });
    if (!lines.length) lines.push(`No Claude accounts in ${this.dir}.`);
    for (const problem of this.problems) lines.push(`! ${problem}`);
    return lines;
  }
}

