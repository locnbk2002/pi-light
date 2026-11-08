import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cooldowns, DEFAULT_CHAINS, isLimitOrCapacityError, loadModelChains, modelFamily, parseModelChains, planCandidates, providerExtension, reviewerModel,
  routeController } from './model-fallback.ts';

const OPUS = 'anthropic/claude-opus-5-5';
const SOL = 'openai-codex/gpt-6.1-sol';
const ASTRA = 'openai-codex/gpt-6-astra';
const FABLE = 'anthropic/claude-fable-5-1';
const redact = (value: unknown) => String(value).split('\n')[0].slice(0, 80);
const all = (_model: string) => true;

test('default fallback chains match the agreed order', () => {
  assert.deepEqual(DEFAULT_CHAINS, {
    controller: [OPUS, SOL],
    astra: [ASTRA, FABLE],
    fable: [FABLE, ASTRA],
  });
});

test('classifier accepts provider limit and capacity errors only', () => {
  for (const message of ['429 Too Many Requests', 'rate_limit_error: Number of request tokens has exceeded your rate limit',
    'You have hit your ChatGPT usage limit (plus plan). Try again in 2h.', 'insufficient_quota: You exceeded your current quota',
    'Overloaded', '529 {"type":"overloaded_error"}', 'model is at capacity', 'RESOURCE_EXHAUSTED', '503 Service Unavailable',
    '502 Bad Gateway', 'The service is temporarily unavailable', 'Your credit balance is too low']) {
    assert.equal(isLimitOrCapacityError('error', message), true, message);
  }
  for (const message of ['Request was aborted', 'User cancelled the request', 'Advisor deadline exceeded', 'Request timed out',
    'invalid_request_error: messages: field required', 'Output blocked by content policy', '401 Unauthorized: invalid x-api-key',
    'authentication_error: invalid api key', '403 permission denied', 'prompt is too long: 250000 tokens > 200000 maximum',
    'context_length_exceeded', 'request id 5293429 failed', '']) {
    assert.equal(isLimitOrCapacityError('error', message), false, message);
  }
  assert.equal(isLimitOrCapacityError('aborted', '429 rate limit'), false, 'aborted turns are never limits');
  assert.equal(isLimitOrCapacityError('stop', '429'), false);
  assert.equal(isLimitOrCapacityError('error', undefined), false);
});

test('override validation is strict and partial files keep other defaults', () => {
  assert.deepEqual(parseModelChains({ astra: [SOL, FABLE] }), { ...DEFAULT_CHAINS, astra: [SOL, FABLE] });
  assert.deepEqual(parseModelChains({ controller: ['openrouter/anthropic/claude-opus'] }).controller, ['openrouter/anthropic/claude-opus']);
  for (const bad of [null, [], 'x', { opus: [OPUS] }, { astra: [] }, { astra: 'x/y' }, { astra: [ASTRA, ASTRA] },
    { astra: ['no-slash'] }, { astra: ['/model'] }, { astra: ['Bad Provider/x'] }, { astra: [42] },
    { astra: Array.from({ length: 9 }, (_, i) => `p/m${i}`) }, { controller: ['pi-light/controller'] }]) {
    assert.throws(() => parseModelChains(bad), Error, JSON.stringify(bad));
  }
});

test('override file: missing uses defaults silently; invalid notifies without echoing contents', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'pi-light-models-'));
  try {
    const path = join(folder, 'pi-light-models.json');
    assert.deepEqual(loadModelChains(path), { chains: DEFAULT_CHAINS });
    await writeFile(path, '{"astra": ["secret-looking-value"');
    let loaded = loadModelChains(path);
    assert.equal(loaded.chains, DEFAULT_CHAINS);
    assert.match(loaded.error!, /invalid JSON/);
    assert.equal(loaded.error!.includes('secret-looking-value'), false);
    await writeFile(path, JSON.stringify({ astra: ['secret-looking-value'] }));
    loaded = loadModelChains(path);
    assert.equal(loaded.chains, DEFAULT_CHAINS);
    assert.match(loaded.error!, /provider\/model/);
    assert.equal(loaded.error!.includes('secret-looking-value'), false);
    await writeFile(path, JSON.stringify({ fable: [SOL] }));
    assert.deepEqual(loadModelChains(path), { chains: { ...DEFAULT_CHAINS, fable: [SOL] } });
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('cooldown ordering skips unavailable and cooled candidates, then expires back to the preferred model', () => {
  // A three-model chain (as an override file could define) exercises skip, cooldown and exhaustion.
  const threeModels = [ASTRA, SOL, FABLE];
  let now = 1_000;
  const cooldowns = new Cooldowns(600_000, () => now);
  assert.deepEqual(planCandidates(threeModels, cooldowns, all), { order: [ASTRA, SOL, FABLE], skipped: [], exhausted: false });
  cooldowns.mark(ASTRA, '429 usage limit');
  assert.deepEqual(planCandidates(threeModels, cooldowns, model => model !== SOL), {
    order: [FABLE], skipped: [`${ASTRA}: cooling down after 429 usage limit`, `${SOL}: no credentials or unknown model`], exhausted: false,
  });
  now += 300_000;
  cooldowns.mark(FABLE, 'overloaded');
  cooldowns.mark(SOL, '529');
  // All limited: try only the soonest-expiring candidate once instead of locking the role out.
  const exhausted = planCandidates(threeModels, cooldowns, all);
  assert.deepEqual(exhausted.order, [ASTRA]);
  assert.equal(exhausted.exhausted, true);
  assert.equal(exhausted.skipped.length, 2);
  now += 300_000;
  assert.deepEqual(planCandidates(threeModels, cooldowns, all).order, [ASTRA], 'preferred model returns after its cooldown');
  assert.deepEqual(planCandidates(threeModels, cooldowns, () => false).order, []);
});

test('virtual controller routing: sticky continuation, limit retry switches, non-limit retry stays, expiry returns', () => {
  let now = 0;
  const cooldowns = new Cooldowns(600_000, () => now);
  const chain = DEFAULT_CHAINS.controller;
  const route = (input: Parameters<typeof routeController>[0], available = all) => routeController(input, chain, cooldowns, available, redact);
  assert.deepEqual(route({ reason: 'user' }), { model: OPUS });
  assert.deepEqual(route({ reason: 'direct' }), { model: OPUS });
  // Continuations stay on the model that handled the turn, even a fallback.
  assert.deepEqual(route({ reason: 'continuation', previous: SOL }), { model: SOL });
  assert.deepEqual(route({ reason: 'continuation', previous: 'other/model' }), { model: OPUS });
  // Non-limit retry: sticky, no cooldown.
  assert.deepEqual(route({ reason: 'retry', failed: { model: OPUS, stopReason: 'error', errorMessage: 'stream ended without message_stop' } }), { model: OPUS });
  assert.deepEqual(route({ reason: 'user' }), { model: OPUS });
  // Limit retry: cool the failed model and move to the next candidate.
  assert.deepEqual(route({ reason: 'retry', failed: { model: OPUS, stopReason: 'error', errorMessage: '429 rate_limit_error' } }), {
    model: SOL, cooled: { model: OPUS, reason: '429 rate_limit_error' },
  });
  assert.deepEqual(route({ reason: 'user' }), { model: SOL });
  assert.deepEqual(route({ reason: 'continuation', previous: OPUS }), { model: SOL }, 'never stick to a cooled model');
  // Every candidate limited: keep Pi's bounded backoff on the failed model.
  assert.deepEqual(route({ reason: 'retry', failed: { model: SOL, stopReason: 'error', errorMessage: 'usage limit' } }), {
    model: SOL, cooled: { model: SOL, reason: 'usage limit' },
  });
  now = 600_001;
  assert.deepEqual(route({ reason: 'user' }), { model: OPUS }, 'preferred model is retried after cooldown');
  assert.deepEqual(route({ reason: 'user' }, model => model === SOL), { model: SOL }, 'candidates without credentials are skipped');
  assert.throws(() => route({ reason: 'user' }, () => false), /No controller fallback model/);
});

test('a providers map renames every chain entry for a machine logged in under other provider names', () => {
  const chains = parseModelChains({ providers: { anthropic: 'claude-bridge', 'openai-codex': 'openai' } });
  assert.deepEqual(chains.controller, ['claude-bridge/claude-opus-5-5', 'openai/gpt-6.1-sol']);
  assert.deepEqual(chains.astra, ['openai/gpt-6-astra', 'claude-bridge/claude-fable-5-1']);
  assert.deepEqual(chains.fable, ['claude-bridge/claude-fable-5-1', 'openai/gpt-6-astra']);
  assert.deepEqual(parseModelChains({ providers: { anthropic: 'claude-bridge' }, controller: ['anthropic/claude-opus-5-5'] }).controller,
    ['claude-bridge/claude-opus-5-5'], 'explicit chains are renamed too');
  for (const bad of [{ providers: [] }, { providers: { anthropic: 7 } }, { providers: { 'Bad Name': 'x' } }, { providers: { anthropic: 'pi-light' } },
    { providers: { anthropic: 'openai-codex' }, controller: ['anthropic/x', 'openai-codex/x'] }]) {
    assert.throws(() => parseModelChains(bad));
  }
});

test('providerExtension finds the installed claude-bridge package only', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-light-agent-'));
  try {
    assert.equal(providerExtension('claude-bridge', dir), undefined, 'not installed');
    const path = join(dir, 'git', 'github.com', 'elidickinson', 'pi-claude-bridge');
    await import('node:fs/promises').then(fs => fs.mkdir(path, { recursive: true }));
    assert.equal(providerExtension('claude-bridge', dir), path);
    assert.equal(providerExtension('anthropic', dir), undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('cross-family reviewer: Opus work is reviewed by Sol, Sol work by Opus, renames keep the family', () => {
  assert.equal(modelFamily('anthropic/claude-opus-5-5'), 'anthropic');
  assert.equal(modelFamily('claude-bridge/claude-opus-5-5'), 'anthropic');
  assert.equal(modelFamily('openai-codex/gpt-6.1-sol'), 'openai');
  assert.equal(modelFamily('openai/o4-mini'), 'openai');
  assert.equal(modelFamily('local/llama-3'), 'local');
  assert.equal(reviewerModel(DEFAULT_CHAINS, 'anthropic/claude-opus-5-5'), 'openai-codex/gpt-6.1-sol');
  assert.equal(reviewerModel(DEFAULT_CHAINS, 'openai-codex/gpt-6.1-sol'), 'anthropic/claude-opus-5-5');
  // Sol unavailable: fall through to the other-family advisor model rather than a same-family one.
  assert.equal(reviewerModel(DEFAULT_CHAINS, 'anthropic/claude-opus-5-5', m => !m.endsWith('gpt-6.1-sol')), 'openai-codex/gpt-6-astra');
  assert.equal(reviewerModel(DEFAULT_CHAINS, 'anthropic/claude-opus-5-5', m => modelFamily(m) === 'anthropic'), undefined);
  const renamed = parseModelChains({ providers: { anthropic: 'claude-bridge' } });
  assert.equal(reviewerModel(renamed, 'openai-codex/gpt-6.1-sol'), 'claude-bridge/claude-opus-5-5');
});
