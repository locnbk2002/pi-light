/**
 * Claude subscription accounts for the claude-bridge controller: credential store, usage state,
 * ranking, blocks and per-session pins. Pure decisions live in functions that take the state and a
 * clock; the state store is a thin wrapper (one atomic file per record, no lock) shared by every Pi process.
 *
 * Tokens come from `claude setup-token` (inference-only, no refresh token). They are injected per
 * request as CLAUDE_CODE_OAUTH_TOKEN, so the macOS Keychain login is never read or written.
 * No function here returns or logs a token; `redactSecrets` covers every error path.
 */
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync,
  statSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';

/** Legacy single state file name; never treated as an account file. */
export const STATE_FILE = 'state.json';
export const STATE_DIR = 'state';
const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const TOKEN = /^sk-ant-oat\d+-[A-Za-z0-9_-]{60,400}$/;

/** Selection thresholds (fractions of a window). */
export const RESERVE = 0.90; // the user's 90% rule: keep 10% of both windows in reserve
export const HOT_FIVE_HOUR = 0.85; // demote an account whose 5-hour window is this full
/** An account a session moved away from must fall below these before it can win again. */
export const RETURN_FIVE_HOUR = 0.85;
export const RETURN_SEVEN_DAY = 0.88;
export const BLOCK_MARGIN_MS = 60_000;
export const DEFAULT_BLOCK_MS = 30 * 60_000;
const PIN_TTL_MS = 30 * 24 * 3600_000;
const WEEK_HOURS = 168;

// ---------------------------------------------------------------------------------------------
// Redaction

/** Remove Anthropic keys/tokens and bearer values from any text before it is shown or logged. */
export function redactSecrets(value: unknown): string {
  return String(value ?? '')
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/(bearer)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]')
    .replace(/(CLAUDE_CODE_OAUTH_TOKEN["':=\s]+)[^\s"']+/g, '$1[redacted]');
}

/** Short non-reversible fingerprint, used to notice that an account's token was replaced. */
export function tokenFingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 12);
}

// ---------------------------------------------------------------------------------------------
// Credential store: <dir>/<name>.json, mode 0600, written atomically

export interface StoredAccount {
  name: string;
  /** Organization UUID, when known. Never required for routing. */
  orgUuid?: string | null;
  token: string;
  source: string;
}
/** What may be shown: no token. */
export interface AccountSummary { name: string; orgUuid?: string | null; source: string; fingerprint: string }

export function validateAccountName(name: string): string {
  if (!NAME.test(name) || name === STATE_FILE.replace('.json', '')) throw new Error('Account names use 1-32 lowercase letters, digits, "-" or "_", and cannot be "state".');
  return name;
}
export function validateToken(token: string): string {
  if (!TOKEN.test(token)) throw new Error('That does not look like a complete `claude setup-token` token (expected sk-ant-oat…, no spaces). A token wrapped across terminal lines must be pasted whole.');
  return token;
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

/** Write a file atomically with mode 0600 (temp file in the same directory, fsync, rename). */
export function writeFileAtomic(path: string, text: string, dir: string): void {
  const tmp = join(dir, `.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(tmp, path);
  } catch (error) {
    // Any failed step (write, fsync, close or rename) removes the temp file.
    try { unlinkSync(tmp); } catch { /* already gone */ }
    throw error;
  }
}

export function saveAccount(dir: string, account: StoredAccount): void {
  validateAccountName(account.name);
  validateToken(account.token);
  ensureDir(dir);
  writeFileAtomic(join(dir, `${account.name}.json`), `${JSON.stringify({ name: account.name, orgUuid: account.orgUuid ?? null,
    token: account.token, source: account.source })}\n`, dir);
}

export function removeAccount(dir: string, name: string): boolean {
  const path = join(dir, `${validateAccountName(name)}.json`);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

/** Valid stored accounts, sorted by name. Invalid files are reported by name only. */
export function loadAccounts(dir: string): { accounts: StoredAccount[]; problems: string[] } {
  const accounts: StoredAccount[] = [];
  const problems: string[] = [];
  let files: string[];
  try { files = readdirSync(dir); } catch { return { accounts, problems }; }
  for (const file of files.sort()) {
    if (!file.endsWith('.json') || file === STATE_FILE || file.startsWith('.')) continue;
    try {
      const path = join(dir, file);
      if ((statSync(path).mode & 0o077) !== 0) throw new Error('is readable by other users; run chmod 600');
      const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<StoredAccount>;
      const name = validateAccountName(String(raw.name ?? ''));
      if (`${name}.json` !== file) throw new Error('name does not match the file name');
      validateToken(String(raw.token ?? ''));
      accounts.push({ name, orgUuid: typeof raw.orgUuid === 'string' ? raw.orgUuid : null, token: raw.token!, source: String(raw.source ?? 'unknown') });
    } catch (error) {
      problems.push(`${file}: ${redactSecrets(error instanceof Error ? error.message : 'invalid')}`);
    }
  }
  return { accounts, problems };
}

export function summarize(account: StoredAccount): AccountSummary {
  return { name: account.name, orgUuid: account.orgUuid, source: account.source, fingerprint: tokenFingerprint(account.token) };
}

// ---------------------------------------------------------------------------------------------
// Usage state

export interface UsageWindow { used: number; resetsAt?: number }
export interface AccountUsage { fiveHour?: UsageWindow; sevenDay?: UsageWindow; measuredAt: number }
export interface AccountRecord {
  usage?: AccountUsage;
  /** Epoch ms; the account is skipped until then. */
  blockedUntil?: number;
  blockReason?: string;
  /** Rejected logins, one per token fingerprint; a replaced token has a new fingerprint and is usable. */
  authFailures?: { fingerprint: string; at: number; reason: string }[];
  /** Its newest usage could not be read (corrupt, or vanishing on every try); treated as being in the reserve. */
  unreadable?: true;
  /** Latest representative reset reported with a rejected status, epoch ms. */
  limitResetsAt?: number;
}
export interface SessionPin { account: string; at: number; left?: string[] }
export interface AccountsState {
  version: 1;
  accounts: Record<string, AccountRecord>;
  pins: Record<string, SessionPin>;
}
/** Null-prototype tables: an account or session named like an Object property ("constructor") is just a key. */
export const emptyState = (): AccountsState => ({ version: 1, accounts: Object.create(null), pins: Object.create(null) });

const HEADER = 'anthropic-ratelimit-unified-';
function num(value: unknown): number | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
/** Epoch seconds (as the headers send them) to epoch ms. */
const secondsToMs = (value: number | undefined) => value === undefined ? undefined : value < 1e11 ? value * 1000 : value;

export interface ParsedUsage {
  usage?: AccountUsage;
  status?: string;
  overageStatus?: string;
  resetsAt?: number;
}
/** Parse the bridge's synthetic `anthropic-ratelimit-unified-*` headers (header names are case-insensitive). */
export function parseUsageHeaders(headers: Record<string, string> | undefined, now: number): ParsedUsage {
  const lower: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) lower[key.toLowerCase()] = value;
  const window = (name: string): UsageWindow | undefined => {
    const used = num(lower[`${HEADER}${name}-utilization`]);
    if (used === undefined) return undefined;
    return { used: Math.max(0, used), resetsAt: secondsToMs(num(lower[`${HEADER}${name}-reset`])) };
  };
  const fiveHour = window('5h');
  const sevenDay = window('7d');
  return {
    usage: fiveHour || sevenDay ? { ...(fiveHour ? { fiveHour } : {}), ...(sevenDay ? { sevenDay } : {}), measuredAt: now } : undefined,
    status: lower[`${HEADER}status`],
    overageStatus: lower[`${HEADER}overage-status`],
    resetsAt: secondsToMs(num(lower[`${HEADER}reset`])),
  };
}

/**
 * Store a usage report; a rejected status without allowed overage also blocks the account.
 * Returns the new block's end when the report blocked it.
 */
export function recordUsage(state: AccountsState, account: string, parsed: ParsedUsage, now: number): number | undefined {
  const record = state.accounts[account] ??= {};
  if (parsed.usage) {
    // Keep a window the report omitted, so a partial report does not erase known usage.
    record.usage = { ...record.usage, ...parsed.usage, measuredAt: now };
  }
  if (parsed.status === 'rejected' && parsed.overageStatus !== 'allowed') {
    record.limitResetsAt = parsed.resetsAt;
    return blockAccount(state, account, 'usage limit reported', now);
  }
  return undefined;
}

/** A window whose reset has passed is empty again. */
function effectiveUsed(window: UsageWindow | undefined, now: number): number | undefined {
  if (!window) return undefined;
  if (window.resetsAt !== undefined && window.resetsAt <= now) return 0;
  return window.used;
}

/** Block after a confirmed limit: until the exhausted window resets plus a margin, else 30 minutes. */
export function blockAccount(state: AccountsState, account: string, reason: string, now: number): number {
  const record = state.accounts[account] ??= {};
  const full = [record.usage?.fiveHour, record.usage?.sevenDay]
    .filter((window): window is UsageWindow => !!window && window.used >= 0.99 && (window.resetsAt ?? 0) > now)
    .map(window => window.resetsAt!);
  const reset = full.length ? Math.max(...full) : record.limitResetsAt && record.limitResetsAt > now ? record.limitResetsAt : undefined;
  record.blockedUntil = reset !== undefined ? reset + BLOCK_MARGIN_MS : now + DEFAULT_BLOCK_MS;
  record.blockReason = redactSecrets(reason).slice(0, 200);
  return record.blockedUntil;
}

export function markAuthFailed(state: AccountsState, account: string, fingerprint: string, reason: string, now: number): void {
  const record = state.accounts[account] ??= {};
  record.authFailures = [...(record.authFailures ?? []).filter(item => item.fingerprint !== fingerprint),
    { fingerprint, at: now, reason: redactSecrets(reason).slice(0, 200) }];
}

// ---------------------------------------------------------------------------------------------
// Ranking and session pins

export interface Candidate { name: string; fingerprint: string }

export function isUsable(state: AccountsState, candidate: Candidate, now: number): boolean {
  const record = state.accounts[candidate.name];
  if (!record) return true;
  if (record.authFailures?.some(item => item.fingerprint === candidate.fingerprint)) return false;
  if (record.blockedUntil !== undefined && record.blockedUntil > now) return false;
  return true;
}

/** Inside the reserve on either window. `strict` applies the return thresholds to an account the session left. */
export function inReserve(state: AccountsState, name: string, now: number, strict = false): boolean {
  if (state.accounts[name]?.unreadable) return true;
  const usage = state.accounts[name]?.usage;
  const fiveHour = effectiveUsed(usage?.fiveHour, now);
  const sevenDay = effectiveUsed(usage?.sevenDay, now);
  return (fiveHour ?? 0) >= (strict ? RETURN_FIVE_HOUR : RESERVE) || (sevenDay ?? 0) >= (strict ? RETURN_SEVEN_DAY : RESERVE);
}

/** Weekly quota that must be spent per hour so it is not wasted at reset: higher drains first. */
function weeklyDrain(window: UsageWindow | undefined, now: number): number {
  const used = effectiveUsed(window, now);
  if (used === undefined) return 0;
  const hours = window?.resetsAt !== undefined ? Math.max((window.resetsAt - now) / 3600_000, 1) : WEEK_HOURS;
  return (1 - Math.min(used, 1)) / hours;
}

/**
 * Usable accounts outside the reserve, best first: cool 5-hour window, measured before unmeasured,
 * highest weekly drain, lower 5-hour use, then name for a stable order.
 */
export function rankAccounts(state: AccountsState, candidates: readonly Candidate[], now: number, left: readonly string[] = []): string[] {
  const scored = candidates
    .filter(candidate => isUsable(state, candidate, now) && !inReserve(state, candidate.name, now, left.includes(candidate.name)))
    .map(candidate => {
      const usage = state.accounts[candidate.name]?.usage;
      const fiveHour = effectiveUsed(usage?.fiveHour, now) ?? 0;
      return { name: candidate.name, hot: fiveHour >= HOT_FIVE_HOUR ? 1 : 0, unmeasured: usage ? 0 : 1,
        drain: weeklyDrain(usage?.sevenDay, now), fiveHour };
    });
  scored.sort((a, b) => a.hot - b.hot || a.unmeasured - b.unmeasured || b.drain - a.drain || a.fiveHour - b.fiveHour || a.name.localeCompare(b.name));
  return scored.map(item => item.name);
}

export interface AccountChoice {
  /** Undefined when every account is blocked, failed or in reserve: the caller falls back to the next model. */
  account?: string;
  previous?: string;
  changed: boolean;
}

/**
 * Pick the account for one request of a session and update its pin.
 * - `boundary` (a new user turn, or a failover) may re-rank; otherwise a usable pin is kept so a turn
 *   never changes account midway.
 * - At a boundary a pinned account stays while it is usable and outside the reserve.
 */
export function chooseAccount(state: AccountsState, session: string, candidates: readonly Candidate[], now: number,
  boundary: boolean): AccountChoice {
  const pin = state.pins[session];
  const pinned = pin && candidates.find(candidate => candidate.name === pin.account);
  if (pinned && isUsable(state, pinned, now) && (!boundary || !inReserve(state, pinned.name, now))) {
    pin.at = now;
    return { account: pinned.name, previous: pinned.name, changed: false };
  }
  const ranked = rankAccounts(state, candidates, now, pin?.left ?? []);
  const account = ranked[0];
  if (!account) return { previous: pin?.account, changed: false };
  const left = pin && pin.account !== account ? [...new Set([...(pin.left ?? []), pin.account])].filter(name => name !== account) : pin?.left;
  state.pins[session] = { account, at: now, ...(left?.length ? { left } : {}) };
  return { account, previous: pin?.account, changed: !!pin && pin.account !== account };
}

// ---------------------------------------------------------------------------------------------
// Shared state without a lock: immutable record files, each written atomically under a new name
//
//   state/usage-<account>-<ms>-<nonce>.json  one usage sample (the newest sample of each window wins)
//   state/block-<account>-<nonce>.json       one block (the latest end time wins)
//   state/auth-<account>-<fingerprint>.json  one rejected token
//   state/pin-<session hash>-<ms>-<nonce>.json one generation of a session's pin (the newest wins)
//
// No file is ever rewritten in place, so a writer cannot overwrite a newer record, and clean-up only
// deletes records that a newer record replaces (or that expired), so it cannot delete a fresh one.

const ACCOUNT_PART = '[a-z0-9][a-z0-9_-]{0,31}';
const GENERATION = '(\\d{13})-[a-z0-9]+';
const USAGE_FILE = new RegExp(`^usage-(${ACCOUNT_PART})-${GENERATION}\\.json$`);
const BLOCK_FILE = new RegExp(`^block-(${ACCOUNT_PART})-[a-z0-9]+\\.json$`);
const AUTH_FILE = new RegExp(`^auth-(${ACCOUNT_PART})-([0-9a-f]{12})\\.json$`);
const PIN_FILE = new RegExp(`^pin-([0-9a-f]{24})-${GENERATION}\\.json$`);
/** Expired blocks are kept a day for status output, then deleted. */
const BLOCK_KEEP_MS = 24 * 3600_000;
/** A temp file this old was left by a writer that crashed between creating and renaming it. */
const TEMP_KEEP_MS = 3600_000;
const READ_ATTEMPTS = 3;
const USAGE_FIELDS = ['fiveHour', 'sevenDay', 'limitResetsAt'] as const;
const nonce = () => `${process.pid.toString(36)}${Math.random().toString(36).slice(2, 10)}`;
let sequence = 0;
/** Time, then a per-process sequence, so this process's later write of the same millisecond sorts newer. */
const generation = (ms: number) => `${String(Math.max(0, Math.floor(ms))).padStart(13, '0').slice(-13)}-${(sequence++).toString(36).padStart(8, '0')}${nonce()}`;
const sessionHash = (session: string) => createHash('sha256').update(session).digest('hex').slice(0, 24);
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
/** A stored window: a non-negative utilization and, if present, a numeric reset time. */
const isWindow = (value: unknown): value is UsageWindow => !!value && typeof value === 'object'
  && isNumber((value as UsageWindow).used) && (value as UsageWindow).used >= 0
  && ((value as UsageWindow).resetsAt === undefined || isNumber((value as UsageWindow).resetsAt));
/** A sample's time is a number and every window or reset it names has a valid shape. */
const validSample = (data: Record<string, unknown>) => isNumber(data.at)
  && (['fiveHour', 'sevenDay'] as const).every(field => data[field] === undefined || isWindow(data[field]))
  && (data.limitResetsAt === undefined || isNumber(data.limitResetsAt));
/** Files of one key, newest first (generation time, then name as a tie-break). */
const newestFirst = (a: { ms: number; file: string }, b: { ms: number; file: string }) => b.ms - a.ms || (b.file > a.file ? 1 : -1);

/** One usage report as stored: the windows it carried and, for a rejected report, the limit reset. */
export interface UsageSample { at: number; fiveHour?: UsageWindow; sevenDay?: UsageWindow; limitResetsAt?: number }

export class StateStore {
  /** The `state` directory inside the accounts directory. */
  readonly dir: string;
  constructor(accountsDir: string) { this.dir = join(accountsDir, STATE_DIR); }

  private files(): string[] {
    try { return readdirSync(this.dir).filter(file => file.endsWith('.json') && !file.startsWith('.')); } catch { return []; }
  }
  private readJson(file: string): Record<string, unknown> | undefined {
    try {
      const data = JSON.parse(readFileSync(join(this.dir, file), 'utf8'));
      return data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : undefined;
    } catch { return undefined; }
  }
  private write(file: string, data: unknown): void {
    ensureDir(this.dir);
    writeFileAtomic(join(this.dir, file), `${JSON.stringify(data)}\n`, this.dir);
  }
  private remove(file: string): void { try { unlinkSync(join(this.dir, file)); } catch { /* already gone */ } }

  /** Generation files matching `pattern`, grouped by their key (account or session hash), newest first. */
  private generations(pattern: RegExp): Map<string, { file: string; ms: number }[]> {
    const groups = new Map<string, { file: string; ms: number }[]>();
    for (const file of this.files()) {
      const match = pattern.exec(file);
      if (match) groups.set(match[1], [...groups.get(match[1]) ?? [], { file, ms: Number(match[2]) }]);
    }
    for (const list of groups.values()) list.sort(newestFirst);
    return groups;
  }

  /**
   * Assemble the current state from every record file. A usage sample or pin that was listed but is
   * gone when opened was replaced by a newer one (clean-up deletes only replaced records), so the
   * listing is taken again. If records keep vanishing, an account whose usage could not be read is
   * marked unreadable, which counts as being in its reserve: never as unmeasured.
   */
  read(): AccountsState {
    let state = emptyState();
    for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
      const vanished = { usage: new Set<string>(), pins: false };
      state = this.readOnce(vanished);
      if (!vanished.usage.size && !vanished.pins) return state;
      if (attempt === READ_ATTEMPTS - 1) for (const account of vanished.usage) (state.accounts[account] ??= {}).unreadable = true;
    }
    return state;
  }

  private gone(file: string): boolean { return !existsSync(join(this.dir, file)); }

  private readOnce(vanished: { usage: Set<string>; pins: boolean }): AccountsState {
    const state = emptyState();
    const record = (name: string) => state.accounts[name] ??= {};
    for (const [account, samples] of this.generations(USAGE_FILE)) {
      const found: Partial<Record<(typeof USAGE_FIELDS)[number], true>> = {};
      for (const { file } of samples) {
        const data = this.readJson(file);
        if (!data && this.gone(file)) { vanished.usage.add(account); continue; }
        const target = record(account);
        if (!data || !validSample(data)) {
          // A corrupt sample newer than a window's newest valid one may hide high usage: count the
          // account as in reserve until a valid newer report replaces it (clean-up then deletes it).
          if (!found.fiveHour || !found.sevenDay) target.unreadable = true;
          continue;
        }
        for (const field of ['fiveHour', 'sevenDay'] as const) {
          if (found[field] || !isWindow(data[field])) continue;
          found[field] = true;
          target.usage = { ...target.usage, [field]: data[field], measuredAt: Math.max(target.usage?.measuredAt ?? 0, data.at as number) };
        }
        if (!found.limitResetsAt && isNumber(data.limitResetsAt)) { found.limitResetsAt = true; target.limitResetsAt = data.limitResetsAt; }
      }
    }
    for (const [, generations] of this.generations(PIN_FILE)) {
      for (const { file } of generations) {
        const data = this.readJson(file);
        if (!data && this.gone(file)) { vanished.pins = true; continue; }
        if (!data || typeof data.session !== 'string' || typeof data.account !== 'string' || !isNumber(data.at)) continue;
        state.pins[data.session] = { account: data.account, at: data.at,
          ...(Array.isArray(data.left) && data.left.length ? { left: data.left.filter((item): item is string => typeof item === 'string') } : {}) };
        break;
      }
    }
    for (const file of this.files()) {
      let match: RegExpExecArray | null;
      if ((match = BLOCK_FILE.exec(file))) {
        const data = this.readJson(file);
        if (!data || !isNumber(data.until)) continue;
        const target = record(match[1]);
        if (target.blockedUntil === undefined || data.until > target.blockedUntil) {
          target.blockedUntil = data.until;
          target.blockReason = typeof data.reason === 'string' ? data.reason : 'limit';
        }
      } else if ((match = AUTH_FILE.exec(file))) {
        const data = this.readJson(file);
        if (!data && this.gone(file)) continue;
        const target = record(match[1]);
        target.authFailures = [...(target.authFailures ?? []), { fingerprint: match[2], at: isNumber(data?.at) ? data.at : 0,
          reason: typeof data?.reason === 'string' ? data.reason : 'rejected' }];
      }
    }
    return state;
  }

  /**
   * Store one usage sample under a new name, then delete older samples of the account whose every
   * field a newer sample already carries (they can never win again).
   */
  addUsage(account: string, sample: UsageSample): void {
    this.write(`usage-${validateAccountName(account)}-${generation(sample.at)}.json`, sample);
    const covered = new Set<string>();
    for (const { file } of this.generations(USAGE_FILE).get(account) ?? []) {
      const data = this.readJson(file);
      if (!data && this.gone(file)) continue;
      // A corrupt sample carries nothing a newer one with both windows does not replace.
      const fields = data && validSample(data) ? USAGE_FIELDS.filter(field => data[field] !== undefined) : ['fiveHour', 'sevenDay'];
      if (fields.every(field => covered.has(field))) this.remove(file);
      for (const field of fields) covered.add(field);
    }
  }

  addBlock(account: string, until: number, reason: string): void {
    this.write(`block-${validateAccountName(account)}-${nonce()}.json`, { until, reason: redactSecrets(reason).slice(0, 200) });
  }

  addAuthFailure(account: string, fingerprint: string, at: number, reason: string): void {
    if (!/^[0-9a-f]{12}$/.test(fingerprint)) throw new Error('invalid token fingerprint');
    this.write(`auth-${validateAccountName(account)}-${fingerprint}.json`, { at, reason: redactSecrets(reason).slice(0, 200) });
  }

  /** Write a new generation of the session's pin. */
  writePin(session: string, pin: SessionPin): void {
    this.write(`pin-${sessionHash(session)}-${generation(pin.at)}.json`, { session, ...pin });
  }

  /**
   * Delete records that can no longer matter: pin generations a newer generation replaces, sessions
   * whose newest pin is 30 days old, blocks expired a day ago, and temp files a crashed writer left an
   * hour ago. Each of these is immutable, so a deletion can only remove what this listing saw; a writer
   * working at the same time writes a new name. Rejected logins are never pruned: there is one small
   * file per rejected token, and its name is reused, so deleting it could erase a fresh rejection.
   */
  prune(now: number): void {
    for (const [, generations] of this.generations(PIN_FILE)) {
      const [newest, ...older] = generations;
      for (const { file } of older) this.remove(file);
      if (now - newest.ms > PIN_TTL_MS) this.remove(newest.file);
    }
    for (const file of this.files()) {
      if (!BLOCK_FILE.test(file)) continue;
      const data = this.readJson(file);
      if (data && isNumber(data.until) && data.until < now - BLOCK_KEEP_MS) this.remove(file);
    }
    let hidden: string[] = [];
    try { hidden = readdirSync(this.dir).filter(file => file.startsWith('.') && file.endsWith('.tmp')); } catch { /* no state yet */ }
    for (const file of hidden) {
      try { if (now - statSync(join(this.dir, file)).mtimeMs > TEMP_KEEP_MS) this.remove(file); } catch { /* already gone */ }
    }
  }

  /** Remove an account's usage, blocks, rejected logins and pins (when the account itself is removed). */
  forget(account: string): void {
    validateAccountName(account);
    for (const file of this.files()) {
      const owner = USAGE_FILE.exec(file)?.[1] ?? BLOCK_FILE.exec(file)?.[1] ?? AUTH_FILE.exec(file)?.[1]
        ?? (PIN_FILE.test(file) ? this.readJson(file)?.account : undefined);
      if (owner === account) this.remove(file);
    }
  }
}
