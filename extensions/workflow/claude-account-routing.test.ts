import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEventBus, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import piLight from './index.ts';
import { ACCOUNT_PROVIDER, accountFailureKind, accountsDir, BRIDGE_PROVIDER, ClaudeAccountRouter, safeToReplay } from './claude-account-routing.ts';
import { inReserve, saveAccount, StateStore, tokenFingerprint, writeFileAtomic } from './claude-accounts.ts';
import { parseClaudeAccountSettings } from './model-fallback.ts';

const HOUR = 3600_000;
const NOW = Date.UTC(2026, 10, 11, 2, 0);
const TOKENS = { personal: `sk-ant-oat01-${'p'.repeat(86)}-pA`, work: `sk-ant-oat01-${'w'.repeat(86)}-wA`,
  personal2: `sk-ant-oat01-${'q'.repeat(86)}-qA` };
const OPUS = 'claude-opus-5-5';
const SOL = 'openai-codex/gpt-6.1-sol';
const REBUILD = Symbol.for('claude-bridge:markRebuildHooks');
const usageHeaders = (five: number, seven: number, sevenResetHours: number, status = 'allowed') => ({
  'anthropic-ratelimit-unified-status': status, 'anthropic-ratelimit-unified-overage-status': 'rejected',
  'anthropic-ratelimit-unified-5h-utilization': String(five), 'anthropic-ratelimit-unified-5h-reset': String((NOW + 3 * HOUR) / 1000),
  'anthropic-ratelimit-unified-7d-utilization': String(seven), 'anthropic-ratelimit-unified-7d-reset': String((NOW + sevenResetHours * HOUR) / 1000),
});

function accountDir(names: (keyof typeof TOKENS)[] = ['personal', 'work']): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'pl-routing-')), 'claude-accounts');
  for (const name of names) saveAccount(dir, { name, token: TOKENS[name], source: 'setup-token' });
  return dir;
}

/** Registry double: records every delegated stream with its env and lets the test answer onResponse. */
function fakeRegistry() {
  const streams: { model: string; env?: Record<string, string>; options: Record<string, any> }[] = [];
  const registry = {
    find: (provider: string, id: string) => ({ provider, id, name: id, api: provider, reasoning: true, input: ['text'], cost: {},
      contextWindow: 200_000, maxTokens: 32_000 }),
    hasConfiguredAuth: () => true,
    streamSimple: (model: { provider: string; id: string }, _context: unknown, options: Record<string, any>) => {
      streams.push({ model: `${model.provider}/${model.id}`, env: options.env, options });
      return { stream: true };
    },
  };
  return { registry: registry as unknown as ExtensionContext['modelRegistry'], streams };
}

/** Capture the bridge's rebuild hook for the duration of `run`. */
async function withRebuildHook(run: (rebuilds: string[]) => Promise<void>): Promise<void> {
  const rebuilds: string[] = [];
  const previous = (globalThis as Record<symbol, unknown>)[REBUILD];
  (globalThis as Record<symbol, unknown>)[REBUILD] = new Set([(session: string | null) => { rebuilds.push(String(session)); }]);
  try { await run(rebuilds); } finally { (globalThis as Record<symbol, unknown>)[REBUILD] = previous; }
}

function startRouter(dir: string, registry: ExtensionContext['modelRegistry'], options: { now?: () => number; store?: StateStore } = {}) {
  const router = new ClaudeAccountRouter(dir, options.now ?? (() => NOW), options.store);
  router.startSession('s1', registry);
  const config = router.providerConfig([OPUS])!;
  const stream = (extra: Record<string, unknown> = {}) =>
    config.streamSimple!({ provider: ACCOUNT_PROVIDER, id: OPUS } as never, {} as never, { sessionId: 'pi-session-1', ...extra } as never);
  return { router, config, stream };
}

test('account failure classification: quota and auth are per account; overload is not', () => {
  assert.equal(accountFailureKind('error', 'Claude quota exceeded — rate limit (five_hour)'), 'limit');
  assert.equal(accountFailureKind('error', '429 rate_limit_error'), 'limit');
  assert.equal(accountFailureKind('error', 'Failed to authenticate. API Error: 401 OAuth access token is invalid.'), 'auth');
  assert.equal(accountFailureKind('error', '529 overloaded_error: Overloaded'), undefined);
  assert.equal(accountFailureKind('error', 'invalid_request_error: bad field'), undefined);
  assert.equal(accountFailureKind('stop', 'quota'), undefined);
});

test('replay safety: only an attempt that showed nothing and called no tool is replayed', () => {
  assert.equal(safeToReplay({ content: [] }), true);
  assert.equal(safeToReplay({ content: [{ type: 'thinking' }, { type: 'text', text: '  ' }] }), true);
  assert.equal(safeToReplay({ content: [{ type: 'text', text: 'Partial answer' }] }), false);
  assert.equal(safeToReplay({ content: [{ type: 'toolCall' }] }), false);
});

test('settings: rotation is off unless claudeAccounts.enabled is exactly true', () => {
  assert.deepEqual(parseClaudeAccountSettings({}), { claudeAccounts: { enabled: false } });
  assert.deepEqual(parseClaudeAccountSettings({ claudeAccounts: { enabled: true } }), { claudeAccounts: { enabled: true } });
  assert.equal(parseClaudeAccountSettings({ claudeAccounts: { enabled: 'yes' } }).claudeAccounts.enabled, false);
  assert.match(parseClaudeAccountSettings({ claudeAccounts: { enabled: true, extra: 1 } }).error!, /unknown/);
});

test('router: the wrapper injects the chosen token, records usage on that account and still forwards onResponse', async () => {
  const dir = accountDir();
  const { registry, streams } = fakeRegistry();
  const { router, config, stream } = startRouter(dir, registry);
  assert.deepEqual(config.models!.map(model => model.id), [OPUS]);
  assert.throws(() => stream(), /No Claude account was chosen/, 'never streams without a chosen account');
  assert.equal(await router.pick(true), 'personal', 'unmeasured accounts tie; name order');
  let forwarded = 0;
  stream({ env: { KEEP: '1' }, onResponse: async () => { forwarded++; } });
  assert.deepEqual(streams[0].model, `${BRIDGE_PROVIDER}/${OPUS}`);
  assert.deepEqual(streams[0].env, { KEEP: '1', CLAUDE_CODE_OAUTH_TOKEN: TOKENS.personal });
  await streams[0].options.onResponse({ status: 200, headers: usageHeaders(0.17, 0.61, 15) }, {});
  assert.equal(forwarded, 1);
  const state = new StateStore(dir).read();
  assert.equal(state.accounts.personal.usage!.sevenDay!.used, 0.61);
  assert.equal(state.pins.s1.account, 'personal');
  assert.doesNotMatch(JSON.stringify(state), /sk-ant-/, 'the shared state never holds a token');
  assert.doesNotMatch(router.describe().join('\n'), /sk-ant-/);
});

test('router: a report is recorded on the account of the stream that received it, even with a nearby weekly reset', async () => {
  const dir = accountDir();
  const { registry, streams } = fakeRegistry();
  const { router, stream } = startRouter(dir, registry);
  await router.pick(true);
  stream();
  await streams[0].options.onResponse({ status: 200, headers: usageHeaders(0.2, 0.2, 15) }, {});
  await router.failover('limit', 'Claude quota exceeded');
  stream();
  // Work's weekly reset is one minute from personal's: it is still work's report.
  await streams[1].options.onResponse({ status: 200, headers: usageHeaders(0.5, 0.91, 15 + 1 / 60) }, {});
  const state = new StateStore(dir).read();
  assert.equal(state.accounts.personal.usage!.sevenDay!.used, 0.2);
  assert.equal(state.accounts.work.usage!.sevenDay!.used, 0.91);
});

test('router: failover blocks the failed account, moves the session and rebuilds the bridge session on the switch', async () => {
  await withRebuildHook(async rebuilds => {
    const dir = accountDir();
    const { registry, streams } = fakeRegistry();
    const { router, stream } = startRouter(dir, registry);
    assert.equal(await router.pick(true), 'personal');
    stream();
    assert.deepEqual(await router.failover('limit', 'Claude quota exceeded'), { failed: 'personal', next: 'work' });
    stream();
    assert.equal(streams[1].env!.CLAUDE_CODE_OAUTH_TOKEN, TOKENS.work);
    assert.deepEqual(rebuilds, ['pi-session-1'], 'one rebuild for the one account switch');
    assert.ok(new StateStore(dir).read().accounts.personal.blockedUntil! > NOW);
    // Work's login is rejected: marked failed, not blocked; nothing is left.
    assert.deepEqual(await router.failover('auth', '401 OAuth access token is invalid'), { failed: 'work', next: undefined });
    const after = new StateStore(dir).read();
    assert.equal(after.accounts.work.blockedUntil, undefined);
    assert.equal(after.accounts.work.authFailures?.length, 1);
    assert.equal(await router.pick(true), undefined);
  });
});

test('router: a reload of the same session keeps the last streamed identity, so a removed or replaced token rebuilds', async () => {
  await withRebuildHook(async rebuilds => {
    const dir = accountDir();
    const { registry, streams } = fakeRegistry();
    const { router, stream } = startRouter(dir, registry);
    await router.pick(true);
    stream();
    // Same name, new token (re-added after a rejected login), then a reload of the same session.
    saveAccount(dir, { name: 'personal', token: TOKENS.personal2, source: 'setup-token' });
    router.reload();
    router.startSession('s1', registry);
    await router.pick(true);
    stream();
    assert.equal(streams[1].env!.CLAUDE_CODE_OAUTH_TOKEN, TOKENS.personal2);
    assert.deepEqual(rebuilds, ['pi-session-1'], 'a replaced token is a switch');
    // A different session starts clean: its first stream is not a switch.
    router.startSession('s2', registry);
    await router.pick(true);
    stream({ sessionId: 'pi-session-2' });
    assert.deepEqual(rebuilds, ['pi-session-1']);
  });
});

test('router: a process with an older account list never deletes a newer account\'s records', async () => {
  const dir = accountDir(['personal']);
  const { registry } = fakeRegistry();
  const old = startRouter(dir, registry).router;
  saveAccount(dir, { name: 'work', token: TOKENS.work, source: 'setup-token' });
  const store = new StateStore(dir);
  store.addAuthFailure('work', tokenFingerprint(TOKENS.work), NOW, 'rejected');
  store.addBlock('work', NOW + HOUR, 'limit');
  store.writePin('other', { account: 'work', at: NOW });
  await old.pick(true);
  const state = store.read();
  assert.equal(state.accounts.work?.authFailures?.length, 1, 'work\'s mark survives a pick by a process that does not know work');
  assert.equal(state.accounts.work.blockedUntil, NOW + HOUR);
  assert.equal(state.pins.other?.account, 'work');
});

test('router: a rejected login stays recorded however many usage reports follow it', async () => {
  const dir = accountDir();
  const { registry, streams } = fakeRegistry();
  const { router, stream } = startRouter(dir, registry);
  await router.pick(true);
  stream();
  assert.equal((await router.failover('auth', '401 OAuth access token is invalid')).next, 'work');
  stream();
  for (let i = 0; i < 150; i++) await streams.at(-1)!.options.onResponse({ status: 200, headers: usageHeaders(0.2, 0.3, 15) }, {});
  // A new process (fresh view of disk) still refuses personal's rejected token.
  const fresh = startRouter(dir, registry).router;
  assert.equal(await fresh.pick(true), 'work');
  assert.equal(new StateStore(dir).read().accounts.personal.authFailures?.length, 1);
});

/** piLight with an isolated agent dir that enables rotation; `child` simulates a herdr subagent pane. */
async function accountHarness(options: { chain?: string[]; child?: boolean } = {}) {
  const agentDir = mkdtempSync(join(tmpdir(), 'pl-agent-'));
  writeFileSync(join(agentDir, 'pi-light-models.json'), JSON.stringify({ providers: { anthropic: BRIDGE_PROVIDER }, effort: { enabled: false },
    claudeAccounts: { enabled: true }, ...(options.chain ? { controller: options.chain } : {}) }));
  const dir = accountsDir(agentDir);
  mkdirSync(dir, { recursive: true });
  saveAccount(dir, { name: 'personal', token: TOKENS.personal, source: 'setup-token' });
  saveAccount(dir, { name: 'work', token: TOKENS.work, source: 'setup-token' });
  const previous = { dir: process.env.PI_CODING_AGENT_DIR, child: process.env.PI_SUBAGENT_ID };
  process.env.PI_CODING_AGENT_DIR = agentDir;
  if (options.child) process.env.PI_SUBAGENT_ID = 'test-child'; else delete process.env.PI_SUBAGENT_ID;
  const events = new Map<string, ((event: unknown, ctx: ExtensionContext) => unknown)[]>();
  const providers = new Map<string, Parameters<ExtensionAPI['registerProvider']>[1]>();
  const notifications: string[] = [];
  let virtual: Parameters<ExtensionAPI['registerVirtualModel']>[0] | undefined;
  const { registry, streams } = fakeRegistry();
  const pi = {
    events: createEventBus(),
    on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) { events.set(name, [...events.get(name) ?? [], handler]); return () => {}; },
    registerCommand() {}, registerTool() {}, registerFlag() {}, registerEntryRenderer() {}, registerMessageRenderer() {},
    getAllTools: () => [], setActiveTools() {}, sendMessage() {}, appendEntry() {}, setThinkingLevel() {},
    registerVirtualModel(definition: typeof virtual) { virtual = definition; },
    registerProvider(name: string, config: Parameters<ExtensionAPI['registerProvider']>[1]) { providers.set(name, config); },
    async setModel() { return true; },
  } as unknown as ExtensionAPI;
  const ctx = {
    mode: 'rpc', hasUI: false, cwd: '/tmp', model: { provider: 'pi-light', id: 'controller' }, isIdle: () => true, hasPendingMessages: () => false,
    sessionManager: { getSessionId: () => 'pi-session-1' },
    modelRegistry: { ...registry, find: (provider: string, id: string) => provider === ACCOUNT_PROVIDER && !providers.has(ACCOUNT_PROVIDER) ? undefined : registry.find(provider, id) },
    ui: { notify(text: string) { notifications.push(text); }, setStatus() {}, setWidget() {} },
  } as unknown as ExtensionContext;
  const emit = async (name: string, event: unknown) => {
    let result: unknown;
    for (const handler of events.get(name) ?? []) result = await handler(event, ctx) ?? result;
    return result;
  };
  try {
    piLight(pi);
    await emit('session_start', { reason: 'startup' });
  } finally {
    if (previous.dir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous.dir;
    if (previous.child === undefined) delete process.env.PI_SUBAGENT_ID; else process.env.PI_SUBAGENT_ID = previous.child;
  }
  const route = async (request: object) => {
    const result = await virtual!.route({ model: { provider: 'pi-light', id: 'controller' }, thinkingLevel: 'high', messages: [], ...request } as never, ctx);
    return `${result.model.provider}/${result.model.id}`;
  };
  const stream = () => providers.get(ACCOUNT_PROVIDER)!.streamSimple!({ provider: ACCOUNT_PROVIDER, id: OPUS } as never, {} as never, { sessionId: 'pi-session-1' } as never);
  const settle = (errorMessage: string, content: unknown[] = []) => emit('agent_before_settle', {
    type: 'agent_before_settle', outcome: 'error', entries: [], continue: false,
    context: { contextEntries: [
      { sourceEntry: { id: 'user-1' }, messages: [{ role: 'user', content: 'Task' }] },
      { sourceEntry: { id: 'failed-1' }, messages: [{ role: 'assistant', provider: BRIDGE_PROVIDER, model: OPUS, stopReason: 'error', errorMessage, content }] },
    ] },
  });
  const failedRetry = (errorMessage: string, content: unknown[] = []) => ({ reason: 'retry', failed: { model: { provider: BRIDGE_PROVIDER, id: OPUS }, thinkingLevel: 'medium',
    message: { role: 'assistant', stopReason: 'error', errorMessage, content } } });
  return { route, stream, settle, failedRetry, streams, notifications, dir, providers };
}

test('controller: the route serves Claude through the account wrapper and keeps the account for continuations', async () => {
  const harness = await accountHarness();
  assert.ok(harness.providers.has(ACCOUNT_PROVIDER), 'session_start installs the wrapper provider');
  assert.equal(await harness.route({ reason: 'user' }), `${ACCOUNT_PROVIDER}/${OPUS}`);
  harness.stream();
  assert.equal(harness.streams.at(-1)!.env!.CLAUDE_CODE_OAUTH_TOKEN, TOKENS.personal);
  assert.equal(await harness.route({ reason: 'continuation', previous: { model: { provider: BRIDGE_PROVIDER, id: OPUS } } }), `${ACCOUNT_PROVIDER}/${OPUS}`);
  harness.stream();
  assert.equal(harness.streams.at(-1)!.env!.CLAUDE_CODE_OAUTH_TOKEN, TOKENS.personal);
});

test('controller: a limit before any output continues on the other account; after output it is not replayed', async () => {
  const harness = await accountHarness();
  await harness.route({ reason: 'user' });
  harness.stream();
  assert.deepEqual(await harness.settle('Claude quota exceeded — rate limit'), {
    entries: [{ type: 'context_edit', targetId: 'failed-1', replacement: null }], continue: true });
  assert.ok(harness.notifications.some(text => text.includes('Continuing this request on account work')));
  assert.equal(await harness.route({ reason: 'continuation' }), `${ACCOUNT_PROVIDER}/${OPUS}`);
  harness.stream();
  assert.equal(harness.streams.at(-1)!.env!.CLAUDE_CODE_OAUTH_TOKEN, TOKENS.work);
  // Work is limited after it streamed text: no replay, and nothing is left for the next prompt but Sol.
  assert.equal(await harness.settle('Claude quota exceeded — rate limit', [{ type: 'text', text: 'Half an answer' }]), undefined);
  assert.equal(await harness.route({ reason: 'user' }), SOL, 'Sol only when every Claude account is unavailable');
});

test('controller: an auth error marks the account and moves on without a quota block', async () => {
  const harness = await accountHarness();
  await harness.route({ reason: 'user' });
  harness.stream();
  const result = await harness.settle('Failed to authenticate. API Error: 401 OAuth access token is invalid.') as { continue: boolean };
  assert.equal(result.continue, true);
  const state = new StateStore(harness.dir).read();
  assert.equal(state.accounts.personal.blockedUntil, undefined);
  assert.equal(state.accounts.personal.authFailures?.length, 1);
  assert.ok(harness.notifications.some(text => text.includes('login was rejected')));
});

test('controller: when every account login is rejected before any output, the request continues on Sol', async () => {
  const harness = await accountHarness();
  const rejected = 'Failed to authenticate. API Error: 401 OAuth access token is invalid.';
  await harness.route({ reason: 'user' });
  harness.stream();
  assert.equal((await harness.settle(rejected) as { continue: boolean }).continue, true, 'personal rejected: on to work');
  await harness.route({ reason: 'continuation' });
  harness.stream();
  assert.deepEqual(await harness.settle(rejected), {
    entries: [{ type: 'context_edit', targetId: 'failed-1', replacement: null }], continue: true }, 'work rejected too: on to Sol');
  assert.ok(harness.notifications.some(text => text.includes(`Continuing this request on ${SOL}`)));
  assert.equal(await harness.route({ reason: 'continuation' }), SOL);
  const state = new StateStore(harness.dir).read();
  assert.equal(state.accounts.work.blockedUntil, undefined, 'a rejected login is not a quota block');
  // After visible output the last rejection is not replayed on Sol.
  const again = await accountHarness();
  await again.route({ reason: 'user' });
  again.stream();
  await again.settle(rejected);
  await again.route({ reason: 'continuation' });
  again.stream();
  assert.equal(await again.settle(rejected, [{ type: 'text', text: 'Partial' }]), undefined);
});

test('controller: a native retry switches accounts before the model chain moves, and only if nothing was shown', async () => {
  const harness = await accountHarness();
  await harness.route({ reason: 'user' });
  harness.stream();
  assert.equal(await harness.route(harness.failedRetry('429 rate_limit_error')), `${ACCOUNT_PROVIDER}/${OPUS}`);
  harness.stream();
  assert.equal(harness.streams.at(-1)!.env!.CLAUDE_CODE_OAUTH_TOKEN, TOKENS.work);
  // Work fails after visible text: the retry is refused (the run ends), but the next prompt moves on.
  await assert.rejects(harness.route(harness.failedRetry('429 rate_limit_error', [{ type: 'text', text: 'Partial' }])),
    error => /already produced output/.test(String(error)) && !/rate.?limit|quota|overload|429|exhaust/i.test(String(error)));
  assert.equal(await harness.route({ reason: 'user' }), SOL);
});

test('controller: a native retry to another model after visible output is refused too', async () => {
  const harness = await accountHarness();
  await harness.route({ reason: 'user' });
  harness.stream();
  await harness.route(harness.failedRetry('429 rate_limit_error'));
  harness.stream();
  // Both accounts limited before any output: the retry moves to Sol.
  assert.equal(await harness.route(harness.failedRetry('429 rate_limit_error')), SOL);
});

test('controller: a non-limit retry that an ordinary pick moves to another account is refused after visible output', async () => {
  const harness = await accountHarness();
  await harness.route({ reason: 'user' });
  harness.stream();
  // Personal enters its reserve (91%), then fails with a server error after showing text.
  const later = String(Math.floor((Date.now() + 3 * HOUR) / 1000));
  await harness.streams.at(-1)!.options.onResponse({ status: 200, headers: { ...usageHeaders(0.91, 0.5, 15),
    'anthropic-ratelimit-unified-5h-reset': later, 'anthropic-ratelimit-unified-7d-reset': later } }, {});
  await assert.rejects(harness.route(harness.failedRetry('500 internal server error', [{ type: 'text', text: 'Partial' }])),
    error => /already produced output/.test(String(error)) && /account work/.test(String(error)));
  // Without visible output the same retry may move to work.
  assert.equal(await harness.route(harness.failedRetry('500 internal server error')), `${ACCOUNT_PROVIDER}/${OPUS}`);
  harness.stream();
  assert.equal(harness.streams.at(-1)!.env!.CLAUDE_CODE_OAUTH_TOKEN, TOKENS.work);
});

test('controller: a managed Claude overload falls back to Sol and stays there (the Claude model cools)', async () => {
  const harness = await accountHarness();
  await harness.route({ reason: 'user' });
  harness.stream();
  assert.deepEqual(await harness.settle('529 overloaded_error: Overloaded'), {
    entries: [{ type: 'context_edit', targetId: 'failed-1', replacement: null }], continue: true });
  assert.ok(harness.notifications.some(text => text.includes(`Continuing this request on ${SOL}`)));
  assert.equal(await harness.route({ reason: 'continuation' }), SOL);
  assert.equal(await harness.route({ reason: 'user' }), SOL, 'the overloaded Claude model is cooled, not retried at once');
});

test('controller: with only Claude in the chain and no usable account, it stops instead of using the bridge login', async () => {
  const harness = await accountHarness({ chain: [`anthropic/${OPUS}`] });
  await harness.route({ reason: 'user' });
  harness.stream();
  await harness.route(harness.failedRetry('429 rate_limit_error'));
  harness.stream();
  await assert.rejects(harness.route(harness.failedRetry('429 rate_limit_error')), /no Claude account is available/);
  await assert.rejects(harness.route({ reason: 'user' }), /no non-Claude model/);
  const unmanaged = harness.streams.filter(item => !item.env?.CLAUDE_CODE_OAUTH_TOKEN);
  assert.equal(unmanaged.length, 0, 'every Claude request carried a managed token');
});

test('controller: herdr children fail over between accounts on a non-retried quota error too', async () => {
  const harness = await accountHarness({ child: true });
  assert.ok(harness.providers.has(ACCOUNT_PROVIDER));
  await harness.route({ reason: 'user' });
  harness.stream();
  assert.deepEqual(await harness.settle('Claude quota exceeded — rate limit'), {
    entries: [{ type: 'context_edit', targetId: 'failed-1', replacement: null }], continue: true });
  await harness.route({ reason: 'continuation' });
  harness.stream();
  assert.equal(harness.streams.at(-1)!.env!.CLAUDE_CODE_OAUTH_TOKEN, TOKENS.work);
});

test('state store: concurrent processes never lose a block or a rejected login, and the newest usage wins', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pl-procs-'));
  const module = new URL('./claude-accounts.ts', import.meta.url).pathname;
  const script = (worker: number) => `import { StateStore } from ${JSON.stringify(module)};
    const store = new StateStore(${JSON.stringify(dir)});
    for (let i = 0; i < 25; i++) {
      store.addBlock('personal', ${NOW} + ${worker} * 100 + i, 'limit');
      store.addUsage('work', { at: ${NOW} + ${worker} * 100 + i, fiveHour: { used: ${worker} / 10 } });
      store.addAuthFailure('acct${worker}', 'abcdef' + String(100000 + i).slice(0, 6), ${NOW}, 'rejected');
    }`;
  const run = (worker: number) => new Promise<number>((resolve, reject) => {
    spawn(process.execPath, ['--input-type=module', '-e', script(worker)], { stdio: 'inherit' }).on('error', reject).on('exit', code => resolve(code ?? 1));
  });
  assert.deepEqual(await Promise.all([1, 2, 3, 4].map(run)), [0, 0, 0, 0]);
  const state = new StateStore(dir).read();
  assert.equal(state.accounts.personal.blockedUntil, NOW + 424, 'the latest block end wins');
  for (const worker of [1, 2, 3, 4]) assert.equal(state.accounts[`acct${worker}`].authFailures?.length, 25);
  assert.equal(state.accounts.work.usage!.measuredAt, NOW + 424, 'an older measurement never replaces a newer one');
  assert.equal(state.accounts.work.usage!.fiveHour!.used, 0.4);
});

test('state store: a usage report written late never replaces a newer one, and a partial report keeps the other window', () => {
  const store = new StateStore(mkdtempSync(join(tmpdir(), 'pl-usage-')));
  store.addUsage('work', { at: NOW + 10, fiveHour: { used: 0.95 }, sevenDay: { used: 0.4 } });
  // An older report whose writer paused before publishing arrives afterwards.
  store.addUsage('work', { at: NOW, fiveHour: { used: 0.1 }, sevenDay: { used: 0.1 } });
  assert.deepEqual({ ...store.read().accounts.work.usage }, { fiveHour: { used: 0.95 }, sevenDay: { used: 0.4 }, measuredAt: NOW + 10 });
  store.addUsage('work', { at: NOW + 20, sevenDay: { used: 0.5 } });
  assert.deepEqual({ ...store.read().accounts.work.usage }, { fiveHour: { used: 0.95 }, sevenDay: { used: 0.5 }, measuredAt: NOW + 20 });
  store.addUsage('work', { at: NOW + 30, limitResetsAt: NOW + HOUR });
  assert.equal(store.read().accounts.work.limitResetsAt, NOW + HOUR);
  // Clean-up keeps only samples that can still win: the newest five-hour, seven-day and limit samples.
  assert.equal(readdirSync(store.dir).filter(file => file.startsWith('usage-')).length, 3);
});

test('state store: pin clean-up working from an old listing never deletes a pin written meanwhile', () => {
  const store = new StateStore(mkdtempSync(join(tmpdir(), 'pl-pin-race-')));
  store.writePin('s', { account: 'personal', at: NOW - 31 * 24 * HOUR });
  // Another process lists and reads the directory, then the resumed session writes its pin before that
  // process deletes anything: its clean-up works entirely from what it saw before.
  const listing = readdirSync(store.dir);
  const seen = new Map(listing.map(file => [file, JSON.parse(readFileSync(join(store.dir, file), 'utf8'))]));
  store.writePin('s', { account: 'personal', at: NOW });
  const stale = store as unknown as { files: () => string[]; readJson: (file: string) => unknown };
  stale.files = () => listing;
  stale.readJson = file => seen.get(file);
  store.prune(NOW);
  const fresh = new StateStore(join(store.dir, '..'));
  assert.deepEqual({ ...fresh.read().pins.s }, { account: 'personal', at: NOW });
});

test('router: a continuation keeps its account even if the session\'s pin file disappears', async () => {
  const dir = accountDir();
  const { registry, streams } = fakeRegistry();
  const { router, stream } = startRouter(dir, registry);
  assert.equal(await router.pick(true), 'personal');
  stream();
  // Personal is now hot (ranks below work, still outside its reserve), and its pin file is gone.
  await streams[0].options.onResponse({ status: 200, headers: usageHeaders(0.87, 0.5, 15) }, {});
  assert.equal(await new ClaudeAccountRouter(dir, () => NOW).pick(false), 'work', 'a session without a pin would now get work');
  const store = new StateStore(dir);
  for (const file of readdirSync(store.dir)) if (file.startsWith('pin-')) unlinkSync(join(store.dir, file));
  assert.equal(await router.pick(false), 'personal');
});

test('state store: an account named constructor is an ordinary account', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pl-proto-'));
  const store = new StateStore(dir);
  const fingerprint = tokenFingerprint(TOKENS.work);
  store.addAuthFailure('constructor', fingerprint, NOW, 'rejected');
  store.addBlock('constructor', NOW + HOUR, 'limit');
  store.writePin('constructor', { account: 'constructor', at: NOW });
  const name: string = 'constructor';
  store.read();
  const state = store.read();
  assert.equal(state.accounts[name].authFailures?.length, 1, 'read twice, still one mark');
  assert.equal(state.accounts[name].blockedUntil, NOW + HOUR);
  assert.equal(state.pins[name].account, 'constructor');
  assert.equal((Object as unknown as { authFailures?: unknown }).authFailures, undefined, 'Object is untouched');
  store.forget(name);
  assert.equal(store.read().accounts[name], undefined);
  assert.equal(store.read().pins[name], undefined);
});

test('state store: pruning drops only old pins, and forget removes one account\'s records only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pl-forget-'));
  const store = new StateStore(dir);
  store.writePin('old', { account: 'personal', at: NOW - 31 * 24 * HOUR });
  store.writePin('new', { account: 'personal', at: NOW });
  store.writePin('w', { account: 'work', at: NOW });
  store.addBlock('personal', NOW + HOUR, 'limit');
  store.addBlock('work', NOW + HOUR, 'limit');
  store.addAuthFailure('personal', tokenFingerprint(TOKENS.personal), NOW, 'rejected');
  store.addUsage('personal', { at: NOW, fiveHour: { used: 0.1 } });
  store.prune(NOW);
  assert.deepEqual(Object.keys(store.read().pins).sort(), ['new', 'w']);
  store.forget('personal');
  const state = store.read();
  assert.equal(state.accounts.personal, undefined);
  assert.equal(state.accounts.work.blockedUntil, NOW + HOUR);
  assert.deepEqual(Object.keys(state.pins), ['w']);
});

const reserveSample = (at: number, used: number) => ({ at, fiveHour: { used, resetsAt: NOW + 3 * HOUR }, sevenDay: { used: 0.5, resetsAt: NOW + 50 * HOUR } });
type StoreInternals = { readJson: (file: string) => unknown; gone: (file: string) => boolean };

test('state store: a usage sample replaced while being read is read again, never seen as unmeasured', async () => {
  const dir = accountDir();
  const store = new StateStore(dir);
  store.addUsage('personal', reserveSample(NOW, 0.95));
  store.addUsage('work', reserveSample(NOW, 0.96));
  const internals = store as unknown as StoreInternals;
  const readJson = internals.readJson.bind(store);
  let raced = false;
  internals.readJson = file => {
    if (!raced && file.startsWith('usage-personal-')) {
      raced = true;
      // Another process publishes a newer report between this listing and this open; it deletes the old one.
      new StateStore(dir).addUsage('personal', reserveSample(NOW + 1, 0.97));
    }
    return readJson(file);
  };
  const { registry } = fakeRegistry();
  const { router } = startRouter(dir, registry, { store });
  assert.equal(await router.pick(true), undefined, 'both accounts are in reserve');
  assert.ok(raced);
  assert.equal(store.read().accounts.personal.usage!.fiveHour!.used, 0.97);
});

test('state store: usage that keeps vanishing while being read counts as in reserve', () => {
  const dir = accountDir();
  const store = new StateStore(dir);
  store.addUsage('personal', reserveSample(NOW, 0.1));
  const internals = store as unknown as StoreInternals;
  const readJson = internals.readJson.bind(store);
  internals.readJson = file => file.startsWith('usage-personal-') ? undefined : readJson(file);
  internals.gone = () => true;
  const state = store.read();
  assert.equal(state.accounts.personal.unreadable, true);
  assert.equal(inReserve(state, 'personal', NOW), true);
});

test('router: an active session refreshes its pin file at every boundary and recreates it when it disappears', async () => {
  const dir = accountDir();
  const { registry } = fakeRegistry();
  let now = NOW;
  const { router } = startRouter(dir, registry, { now: () => now });
  await router.pick(true);
  // A user turn every five minutes for a day: the file on disk never falls more than ten minutes behind.
  for (let i = 0; i < 288; i++) { now += 5 * 60_000; await router.pick(true); await router.pick(false); }
  const store = new StateStore(dir);
  assert.ok(now - store.read().pins.s1.at <= 10 * 60_000, 'the pin file is refreshed against its own age');
  for (const file of readdirSync(store.dir)) if (file.startsWith('pin-')) unlinkSync(join(store.dir, file));
  assert.equal(await router.pick(false), 'personal', 'a continuation keeps its account from memory');
  await router.pick(true);
  assert.equal(store.read().pins.s1?.account, 'personal', 'the next boundary writes the missing pin file again');
});

test('router: a newer pin from another process does not move a continuation, only the next boundary', async () => {
  const dir = accountDir();
  const { registry, streams } = fakeRegistry();
  const { router, stream } = startRouter(dir, registry);
  assert.equal(await router.pick(true), 'personal');
  new StateStore(dir).writePin('s1', { account: 'work', at: NOW + 1 });
  assert.equal(await router.pick(false), 'personal', 'a healthy continuation keeps its account');
  stream();
  assert.equal(streams.at(-1)!.env!.CLAUDE_CODE_OAUTH_TOKEN, TOKENS.personal);
  assert.equal(await router.pick(true), 'work', 'the newer pin counts at the next boundary');
});

test('atomic write: a failed write leaves no temp file, and prune removes temp files a crashed writer left', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pl-tmp-'));
  assert.throws(() => writeFileAtomic(join(dir, 'x.json'), undefined as unknown as string, dir));
  assert.deepEqual(readdirSync(dir), [], 'no temp file after a failed write');
  const store = new StateStore(dir);
  store.addUsage('work', reserveSample(NOW, 0.1));
  const old = join(store.dir, '.1.2.old.tmp');
  const fresh = join(store.dir, '.1.2.fresh.tmp');
  writeFileSync(old, '{}');
  writeFileSync(fresh, '{}');
  const twoHoursAgo = (Date.now() - 2 * HOUR) / 1000;
  utimesSync(old, twoHoursAgo, twoHoursAgo);
  store.prune(Date.now());
  assert.deepEqual(readdirSync(store.dir).filter(file => file.endsWith('.tmp')), ['.1.2.fresh.tmp']);
});

test('state store: prune removes blocks expired a day ago, keeps live blocks and never prunes a rejected login', () => {
  const store = new StateStore(mkdtempSync(join(tmpdir(), 'pl-growth-')));
  for (let i = 0; i < 50; i++) store.addBlock('personal', NOW - 2 * 24 * HOUR - i, 'old limit');
  store.addBlock('personal', NOW + HOUR, 'limit');
  store.addAuthFailure('work', 'aaaaaaaaaaaa', NOW - 365 * 24 * HOUR, 'old token');
  store.addAuthFailure('work', tokenFingerprint(TOKENS.work), NOW, 'rejected');
  store.prune(NOW);
  const files = readdirSync(store.dir);
  assert.equal(files.filter(file => file.startsWith('block-')).length, 1);
  assert.equal(files.filter(file => file.startsWith('auth-')).length, 2);
  const state = store.read();
  assert.equal(state.accounts.personal.blockedUntil, NOW + HOUR);
  assert.deepEqual(state.accounts.work.authFailures?.map(item => item.fingerprint).sort(), ['aaaaaaaaaaaa', tokenFingerprint(TOKENS.work)].sort());
});

test('router: two processes on one session never overwrite each other\'s pin from a continuation', async () => {
  const dir = accountDir();
  let now = NOW;
  const one = startRouter(dir, fakeRegistry().registry, { now: () => now }).router;
  const two = startRouter(dir, fakeRegistry().registry, { now: () => now }).router;
  assert.equal(await one.pick(true), 'personal');
  now += 1;
  new StateStore(dir).writePin('s1', { account: 'work', at: now });
  assert.equal(await two.pick(true), 'work', 'process two adopts the newer pin at its boundary');
  const disk: string[] = [];
  for (let i = 0; i < 6; i++) {
    now += 1;
    assert.equal(await (i % 2 ? two : one).pick(false), i % 2 ? 'work' : 'personal', 'each continuation keeps its own account');
    disk.push(new StateStore(dir).read().pins.s1.account);
  }
  assert.deepEqual(new Set(disk), new Set(['work']), 'continuations never write the pin');
  now += 1;
  assert.equal(await one.pick(true), 'work', 'process one adopts the newer pin at its next boundary');
});

test('state store: a corrupt newer usage sample counts as in reserve until a valid report replaces it', async () => {
  const dir = accountDir();
  const store = new StateStore(dir);
  store.addUsage('personal', reserveSample(NOW, 0.1));
  store.addUsage('personal', reserveSample(NOW + 1, 0.95));
  const newest = readdirSync(store.dir).filter(file => file.startsWith('usage-personal-')).sort().at(-1)!;
  writeFileSync(join(store.dir, newest), '{"at": "broken"');
  const { registry } = fakeRegistry();
  const { router } = startRouter(dir, registry);
  assert.equal(store.read().accounts.personal.unreadable, true);
  assert.equal(await router.pick(true), 'work', 'personal is held in reserve, not treated as unmeasured');
  assert.match(router.describe().join('\n'), /personal.*usage unreadable; treated as in reserve/);
  store.addUsage('personal', reserveSample(NOW + 2, 0.2));
  assert.equal(store.read().accounts.personal.unreadable, undefined);
  assert.ok(!readdirSync(store.dir).includes(newest), 'clean-up deletes the corrupt sample once a valid one replaces it');
});

test('router: status names an account whose usage could not be read even without any recovered window', () => {
  const dir = accountDir();
  const store = new StateStore(dir);
  store.addUsage('personal', reserveSample(NOW, 0.1));
  for (const file of readdirSync(store.dir)) writeFileSync(join(store.dir, file), 'not json');
  const { router } = startRouter(dir, fakeRegistry().registry);
  assert.match(router.describe().join('\n'), /personal: no usage measured yet — usage unreadable; treated as in reserve/);
});

test('state store: a window with a non-numeric reset or negative use is corrupt and holds the account in reserve', () => {
  for (const window of [{ used: 0.95, resetsAt: '1' }, { used: -0.5 }]) {
    const store = new StateStore(mkdtempSync(join(tmpdir(), 'pl-window-')));
    store.addUsage('personal', reserveSample(NOW, 0.1));
    store.addUsage('personal', { at: NOW + 1, fiveHour: window as never });
    const state = store.read();
    assert.equal(state.accounts.personal.unreadable, true, JSON.stringify(window));
    assert.equal(inReserve(state, 'personal', NOW), true);
    store.addUsage('personal', reserveSample(NOW + 2, 0.2));
    assert.equal(store.read().accounts.personal.unreadable, undefined, 'a valid newer report recovers it');
  }
});
