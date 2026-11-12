import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { blockAccount, chooseAccount, DEFAULT_BLOCK_MS, emptyState, inReserve, isUsable, loadAccounts,
  markAuthFailed, parseUsageHeaders, rankAccounts, recordUsage, redactSecrets, removeAccount, saveAccount,
  summarize, tokenFingerprint, type AccountsState, type Candidate } from './claude-accounts.ts';

const HOUR = 3600_000;
const NOW = Date.UTC(2026, 10, 11, 2, 0);
const FAKE = (c: string) => `sk-ant-oat01-${c.repeat(86)}-${c}A`;
const candidates: Candidate[] = [{ name: 'personal', fingerprint: 'p' }, { name: 'work', fingerprint: 'w' }];
function stateWith(usage: Record<string, [number, number, number, number]>): AccountsState {
  const state = emptyState();
  for (const [name, [five, fiveH, seven, sevenH]] of Object.entries(usage)) {
    state.accounts[name] = { usage: { fiveHour: { used: five, resetsAt: NOW + fiveH * HOUR },
      sevenDay: { used: seven, resetsAt: NOW + sevenH * HOUR }, measuredAt: NOW } };
  }
  return state;
}

test('ranking with the 2026-11-11 numbers prefers personal (weekly quota expires sooner)', () => {
  const state = stateWith({ personal: [0.17, 3, 0.61, 15], work: [0.24, 3, 0.34, 64] });
  assert.deepEqual(rankAccounts(state, candidates, NOW), ['personal', 'work']);
});

test('reserve: an account at 91% weekly is not chosen; both in reserve or blocked means no account (fallback)', () => {
  const state = stateWith({ personal: [0.10, 3, 0.91, 15], work: [0.24, 3, 0.34, 64] });
  assert.equal(inReserve(state, 'personal', NOW), true);
  assert.deepEqual(rankAccounts(state, candidates, NOW), ['work']);
  blockAccount(state, 'work', 'quota', NOW);
  assert.deepEqual(rankAccounts(state, candidates, NOW), []);
  assert.equal(chooseAccount(state, 's1', candidates, NOW, true).account, undefined);
});

test('hot 5-hour window: at 86% the account is demoted behind a cool one', () => {
  const state = stateWith({ personal: [0.86, 3, 0.61, 15], work: [0.24, 3, 0.34, 64] });
  assert.deepEqual(rankAccounts(state, candidates, NOW), ['work', 'personal']);
});

test('a window whose reset has passed counts as empty', () => {
  const state = stateWith({ personal: [0.95, -1, 0.61, 15], work: [0.24, 3, 0.34, 64] });
  assert.equal(inReserve(state, 'personal', NOW), false);
});

test('unmeasured accounts rank after measured ones', () => {
  const state = stateWith({ work: [0.24, 3, 0.34, 64] });
  assert.deepEqual(rankAccounts(state, candidates, NOW), ['work', 'personal']);
});

test('pins: a session keeps its account mid-turn and at boundaries until it enters the reserve', () => {
  const state = stateWith({ personal: [0.17, 3, 0.61, 15], work: [0.24, 3, 0.34, 64] });
  assert.deepEqual(chooseAccount(state, 's1', candidates, NOW, true), { account: 'personal', previous: undefined, changed: false });
  // Work now ranks better, but the pin holds.
  state.accounts.personal.usage!.sevenDay!.used = 0.89;
  assert.equal(chooseAccount(state, 's1', candidates, NOW, true).account, 'personal');
  // In the reserve: mid-turn it still holds; at the next boundary it moves.
  state.accounts.personal.usage!.sevenDay!.used = 0.92;
  assert.equal(chooseAccount(state, 's1', candidates, NOW, false).account, 'personal');
  assert.deepEqual(chooseAccount(state, 's1', candidates, NOW, true), { account: 'work', previous: 'personal', changed: true });
  assert.deepEqual(state.pins.s1.left, ['personal']);
});

test('hysteresis: an account the session left must fall below 85% / 88% before it wins again', () => {
  const state = stateWith({ personal: [0.17, 3, 0.61, 15], work: [0.24, 3, 0.34, 64] });
  assert.equal(chooseAccount(state, 's1', candidates, NOW, true).account, 'personal');
  state.accounts.personal.usage!.sevenDay!.used = 0.92;
  assert.equal(chooseAccount(state, 's1', candidates, NOW, true).account, 'work'); // left personal
  state.accounts.work.usage!.fiveHour!.used = 0.95; // work enters the reserve
  state.accounts.personal.usage!.sevenDay!.used = 0.89; // just under the reserve, above the return line
  assert.equal(chooseAccount(state, 's1', candidates, NOW, true).account, undefined);
  state.accounts.personal.usage!.sevenDay!.used = 0.87;
  assert.equal(chooseAccount(state, 's1', candidates, NOW, true).account, 'personal');
  // A new session has no history with personal, so 0.89 is fine for it.
  state.accounts.personal.usage!.sevenDay!.used = 0.89;
  assert.equal(chooseAccount(state, 's2', candidates, NOW, true).account, 'personal');
});

test('blocks: until the exhausted window resets plus 60 s, or 30 minutes without a reset', () => {
  const state = stateWith({ personal: [1, 2, 0.61, 15] });
  assert.equal(blockAccount(state, 'personal', 'quota', NOW), NOW + 2 * HOUR + 60_000);
  assert.equal(isUsable(state, candidates[0], NOW + HOUR), false);
  assert.equal(isUsable(state, candidates[0], NOW + 2 * HOUR + 61_000), true);
  assert.equal(blockAccount(state, 'work', 'quota', NOW), NOW + DEFAULT_BLOCK_MS);
});

test('auth failure skips only the token that failed; a replaced token is usable again', () => {
  const state = emptyState();
  markAuthFailed(state, 'work', 'w', '401 OAuth access token is invalid', NOW);
  assert.equal(isUsable(state, { name: 'work', fingerprint: 'w' }, NOW), false);
  assert.equal(isUsable(state, { name: 'work', fingerprint: 'w2' }, NOW), true);
  markAuthFailed(state, 'work', 'w2', '401', NOW);
  assert.equal(isUsable(state, { name: 'work', fingerprint: 'w' }, NOW), false, 'a second rejected token keeps the first mark');
  assert.equal(state.accounts.work.blockedUntil, undefined, 'an auth error is not a quota block');
});

test('usage headers parse and a rejected status blocks the account', () => {
  const headers = { 'anthropic-ratelimit-unified-5h-utilization': '0.11', 'anthropic-ratelimit-unified-5h-reset': '1794384000',
    'anthropic-ratelimit-unified-7d-utilization': '0.62', 'anthropic-ratelimit-unified-7d-reset': '1794416400',
    'anthropic-ratelimit-unified-status': 'allowed' };
  const parsed = parseUsageHeaders(headers, NOW);
  assert.deepEqual(parsed.usage, { fiveHour: { used: 0.11, resetsAt: 1794384000_000 }, sevenDay: { used: 0.62, resetsAt: 1794416400_000 }, measuredAt: NOW });
  const state = emptyState();
  recordUsage(state, 'personal', parsed, NOW);
  assert.equal(state.accounts.personal.blockedUntil, undefined);
  recordUsage(state, 'personal', parseUsageHeaders({ ...headers, 'anthropic-ratelimit-unified-status': 'rejected',
    'anthropic-ratelimit-unified-overage-status': 'rejected', 'anthropic-ratelimit-unified-reset': String((NOW + HOUR) / 1000) }, NOW), NOW);
  assert.equal(state.accounts.personal.blockedUntil, NOW + HOUR + 60_000);
  assert.equal(parseUsageHeaders({}, NOW).usage, undefined);
});

test('redaction removes tokens and bearer values', () => {
  const text = redactSecrets(`failed with ${FAKE('a')} and Authorization: Bearer abc.def-123 and CLAUDE_CODE_OAUTH_TOKEN=xyz`);
  assert.doesNotMatch(text, /sk-ant-|abc\.def|xyz/);
});

test('credential store: 0600 files, atomic save, list without secrets, invalid files reported by name', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'pl-accounts-')), 'claude-accounts');
  saveAccount(dir, { name: 'personal', orgUuid: '8242f703-x', token: FAKE('a'), source: 'setup-token' });
  assert.equal(statSync(join(dir, 'personal.json')).mode & 0o777, 0o600);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  writeFileSync(join(dir, 'broken.json'), '{"name":"broken","token":"nope"}', { mode: 0o600 });
  writeFileSync(join(dir, 'open.json'), '{}');
  chmodSync(join(dir, 'open.json'), 0o644);
  const { accounts, problems } = loadAccounts(dir);
  assert.deepEqual(accounts.map(summarize), [{ name: 'personal', orgUuid: '8242f703-x', source: 'setup-token', fingerprint: tokenFingerprint(FAKE('a')) }]);
  assert.equal(problems.length, 2);
  assert.doesNotMatch(problems.join('\n'), /sk-ant-/);
  assert.throws(() => saveAccount(dir, { name: 'x', token: 'sk-ant-oat01-short', source: 'manual' }), /complete/);
  assert.throws(() => saveAccount(dir, { name: 'state', token: FAKE('b'), source: 'manual' }), /state/);
  assert.equal(removeAccount(dir, 'personal'), true);
  assert.equal(removeAccount(dir, 'personal'), false);
});
