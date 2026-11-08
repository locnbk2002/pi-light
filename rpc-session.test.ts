import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { RpcClient, type RpcClientOptions } from '@earendil-works/pi-coding-agent';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdvisorSessions, childOptions, providerErrorSummary, replyModelLabel, resolvePiCliPath, type RpcTransport } from './rpc-session.ts';
import { Cooldowns, DEFAULT_CHAINS } from './model-fallback.ts';
import { ADVISORS } from './controller-policy.ts';

let folder: string;
let config: { cliPath: string; timeoutMs: number; heartbeatMs: number };
before(async () => {
  folder = await mkdtemp(join(tmpdir(), 'pi-light-unit-'));
  const cliPath = join(folder, 'cli.js');
  await writeFile(cliPath, '// unit transport fixture');
  config = { cliPath, timeoutMs: 2000, heartbeatMs: 10 };
});
after(async () => { await rm(folder, { recursive: true, force: true }); });

test('native extension resolves its Pi CLI without a launcher or environment override', async () => {
  const cli = resolvePiCliPath('');
  assert.ok(cli.endsWith('/dist/cli.js'));
  assert.ok((await stat(cli)).isFile());
  assert.equal(resolvePiCliPath(config.cliPath), config.cliPath);
  assert.throws(() => resolvePiCliPath('relative-cli.js'), /existing absolute/);
  assert.throws(() => resolvePiCliPath('/missing-pi-light-cli.js'), /existing absolute/);
});

test('provider failures report a short redacted reason', () => {
  assert.equal(providerErrorSummary(undefined), 'no provider reason reported');
  assert.equal(providerErrorSummary('429 usage limit reached\nstack trace'), '429 usage limit reached');
  const redacted = providerErrorSummary('401 Bearer abcdefabcdef token=supersecretvalue sk-live_1234567890abcdef ' + 'x'.repeat(40));
  for (const secret of ['abcdefabcdef', 'supersecretvalue', 'sk-live_1234567890abcdef', 'x'.repeat(40)]) assert.equal(redacted.includes(secret), false, secret);
  assert.ok(providerErrorSummary('e'.repeat(500)).length <= 200);
});

/** Controllable unit transport, not a live Pi/provider smoke test. */
class FakeRpcClient implements RpcTransport {
  listeners = new Set<(event: unknown) => void>();
  starts = 0;
  stops = 0;
  prompts: string[] = [];
  failStart = false;
  failState = false;
  failStop = false;
  behavior: 'success' | 'hang' | 'handled' | 'provider-error' | 'limit-error' | 'invalid-request' | 'exit' | 'invalid' | 'abort' | 'reject-after-settle' = 'success';
  constructor(readonly options?: RpcClientOptions) {}
  onEvent(listener: (event: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  emit(event: unknown): void { for (const listener of this.listeners) listener(event); }
  async start(): Promise<void> {
    this.starts++;
    if (this.failStart) throw new Error('provider startup diagnostics must not be echoed');
  }
  async stop(): Promise<void> {
    this.stops++;
    if (this.failStop) throw new Error('cleanup failed');
  }
  async getState(): Promise<unknown> {
    if (this.failState) throw new Error('process exited');
    return { model: this.options ? { provider: this.options.provider, id: this.options.model }
      : { provider: ADVISORS.astra.provider, id: ADVISORS.astra.model } };
  }
  async prompt(message: string): Promise<string> {
    this.prompts.push(message);
    if (this.behavior === 'hang') return 'started';
    if (this.behavior === 'handled') return 'handled';
    if (this.behavior === 'exit') { this.failState = true; return 'started'; }
    if (this.behavior === 'invalid') {
      this.emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Unattributed' }] } });
    } else {
      this.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Partial text' } });
      const failed = ['provider-error', 'limit-error', 'invalid-request'].includes(this.behavior);
      this.emit({ type: 'message_end', message: {
        role: 'assistant', provider: this.options?.provider ?? 'physical-provider', model: this.options?.model ?? 'actual-model',
        content: failed ? [] : [{ type: 'text', text: 'Authoritative final text' }],
        stopReason: failed ? 'error' : 'stop',
        ...(this.behavior === 'limit-error' ? { errorMessage: '429 usage limit reached\nretry-after details' } : {}),
        ...(this.behavior === 'invalid-request' ? { errorMessage: 'invalid_request_error: bad field' } : {}),
      } });
    }
    // agent_end is deliberately NOT the completion signal.
    this.emit({ type: 'agent_end', messages: [] });
    this.emit({ type: 'agent_settled', aborted: this.behavior === 'abort' });
    if (this.behavior === 'reject-after-settle') throw new Error('prompt response failed');
    return 'started';
  }
}
const request = () => ({ advisor: 'astra' as const, topic: 'unit-topic', prompt: 'Inspect this design', cwd: folder });

test('advisor children load only the extension that provides an extension-backed model provider', () => {
  const identity = { directory: folder, id: '12345678-1234-1234-1234-123456789abc' };
  const lookup = (provider: string) => provider === 'claude-bridge' ? '/agent/git/github.com/elidickinson/pi-claude-bridge' : undefined;
  const bridged = childOptions({ ...config, providerExtension: lookup }, 'claude-bridge/claude-fable-5-1', folder, identity);
  assert.equal(bridged.provider, 'claude-bridge');
  const at = bridged.args!.indexOf('-e');
  assert.ok(at > bridged.args!.indexOf('--no-extensions'));
  assert.equal(bridged.args![at + 1], '/agent/git/github.com/elidickinson/pi-claude-bridge');
  assert.ok(!childOptions({ ...config, providerExtension: lookup }, 'openai/gpt-6-astra', folder, identity).args!.includes('-e'));
});

test('child startup isolates resources, uses native providers and explicit resumable sessions', () => {
  const identity = { directory: folder, id: '12345678-1234-1234-1234-123456789abc' };
  const options = childOptions(config, 'fable', folder, identity);
  assert.equal(options.model, 'claude-fable-5-1');
  assert.equal(options.provider, 'anthropic');
  for (const flag of ['--no-approve', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-themes', '--no-mcp']) assert.ok(options.args!.includes(flag));
  assert.equal(options.args!.includes('-e'), false);
  assert.equal(options.args!.includes('--no-session'), false);
  assert.equal(options.args![options.args!.indexOf('--session-dir') + 1], folder);
  assert.equal(options.args![options.args!.indexOf('--session-id') + 1], identity.id);
  assert.equal(options.args![options.args!.indexOf('--tools') + 1], 'read,grep,find,ls');
  assert.equal(options.args!.includes('--approve'), false);
  assert.throws(() => childOptions({ ...config, cliPath: '/usr/bin/pi' }, 'astra', folder, identity));
  assert.throws(() => childOptions(config, 'astra', '.', identity));
  assert.throws(() => childOptions(config, 'astra', folder, { ...identity, directory: '.' }));
  assert.throws(() => childOptions(config, 'astra', folder, { ...identity, id: '--bad' }));
});

test('fast completion uses final message and actual model; topic followups reuse one child', async () => {
  const fake = new FakeRpcClient();
  const sessions = new AdvisorSessions(config, () => fake);
  const progress: string[] = [];
  try {
    assert.deepEqual(await sessions.ask({ ...request(), onProgress: text => progress.push(text) }), {
      text: 'Authoritative final text', actualModel: 'physical-provider/actual-model',
    });
    await sessions.ask({ ...request(), prompt: 'Follow-up' });
    assert.equal(fake.starts, 1);
    assert.deepEqual(fake.prompts, ['Inspect this design', 'Follow-up']);
    assert.deepEqual(progress, ['Partial text']);
    assert.equal(fake.listeners.size, 0);
  } finally { await sessions.close(); }
  await sessions.close();
  assert.equal(fake.stops, 1);
});

test('fresh reviews and distinct topics get isolated children and deterministic cleanup', async () => {
  const clients: FakeRpcClient[] = [];
  const sessions = new AdvisorSessions(config, () => { const fake = new FakeRpcClient(); clients.push(fake); return fake; });
  try {
    await sessions.ask(request());
    await sessions.ask({ ...request(), fresh: true });
    await sessions.ask({ ...request(), topic: 'second-topic' });
    assert.equal(clients.length, 3);
    assert.equal(clients[0].stops, 0);
    assert.equal(clients[1].stops, 1);
  } finally { await sessions.close(); }
  assert.deepEqual(clients.map(client => client.stops), [1, 1, 1]);
});

for (const behavior of ['handled', 'provider-error', 'exit', 'invalid', 'abort', 'reject-after-settle'] as const) {
  test(`protocol failure (${behavior}) closes the child and removes listeners`, async () => {
    const fake = new FakeRpcClient();
    fake.behavior = behavior;
    const sessions = new AdvisorSessions(config, () => fake);
    try { await assert.rejects(sessions.ask(request()), /Advisor/); }
    finally { await sessions.close(); }
    assert.equal(fake.stops, 1);
    assert.equal(fake.listeners.size, 0);
  });
}

test('cancelled and failed turns resume the same private session without replaying prompts', async () => {
  for (const failure of ['cancel', 'provider-error'] as const) {
    const clients: FakeRpcClient[] = [];
    const configs: RpcClientOptions[] = [];
    const sessions = new AdvisorSessions(config, options => {
      configs.push(options);
      const client = new FakeRpcClient();
      clients.push(client);
      return client;
    });
    let directory = '';
    try {
      await sessions.ask(request());
      directory = configs[0].args![configs[0].args!.indexOf('--session-dir') + 1];
      assert.equal((await stat(directory)).mode & 0o777, 0o700);
      clients[0].behavior = failure === 'cancel' ? 'hang' : 'provider-error';
      const cancel = new AbortController();
      const interrupted = sessions.ask({ ...request(), prompt: 'Interrupted once', signal: cancel.signal });
      const rejected = assert.rejects(interrupted, /Advisor/);
      if (failure === 'cancel') {
        while (clients[0].prompts.length < 2) await new Promise(resolve => setTimeout(resolve, 1));
        cancel.abort();
      }
      await rejected;
      await sessions.ask({ ...request(), prompt: 'New follow-up only' });
      assert.equal(clients.length, 2);
      assert.deepEqual(configs[1], configs[0], 'replacement must resume the exact directory, ID and model');
      assert.deepEqual(clients[0].prompts, ['Inspect this design', 'Interrupted once']);
      assert.deepEqual(clients[1].prompts, ['New follow-up only']);
      assert.equal(clients[0].stops, 1);
    } finally { await sessions.close(); }
    await assert.rejects(stat(directory), { code: 'ENOENT' });
    assert.equal(clients[1].stops, 1);
  }
});

test('failed cleanup blocks replacement children and reports shutdown failure', async () => {
  const fake = new FakeRpcClient();
  fake.behavior = 'provider-error';
  fake.failStop = true;
  let children = 0;
  let directory = '';
  const sessions = new AdvisorSessions(config, options => {
    children++;
    directory = options.args![options.args!.indexOf('--session-dir') + 1];
    return fake;
  });
  try {
    await assert.rejects(sessions.ask(request()), /cleanup failed/);
    await assert.rejects(sessions.ask(request()), /cleanup failed/);
    assert.equal(children, 1, 'must not replace a child whose stop failed');
    await assert.rejects(sessions.close(), /cleanup failed/);
    assert.equal(fake.stops, 1);
  } finally {
    // The fake never starts a process; the test owns its remaining private directory.
    await rm(directory, { recursive: true, force: true });
  }
});

test('agent_end alone cannot complete a consultation; deadline cleans up', async () => {
  const fake = new FakeRpcClient();
  fake.behavior = 'hang';
  const sessions = new AdvisorSessions({ ...config, timeoutMs: 60 }, () => fake);
  const pending = sessions.ask(request());
  // Deadline remains the completion boundary even if a low-level run ended.
  fake.emit({ type: 'agent_end', messages: [] });
  try { await assert.rejects(pending, /deadline/); }
  finally { await sessions.close(); }
  assert.equal(fake.stops, 1);
  assert.equal(fake.listeners.size, 0);
});

test('caller cancellation and shutdown stop a busy child without orphaning it', async () => {
  for (const shutdown of [false, true]) {
    const fake = new FakeRpcClient();
    fake.behavior = 'hang';
    const sessions = new AdvisorSessions(config, () => fake);
    const cancel = new AbortController();
    const pending = sessions.ask({ ...request(), signal: cancel.signal });
    // Register rejection before triggering the cancellation.
    const rejected = assert.rejects(pending, /cancelled/);
    await new Promise(resolve => setTimeout(resolve, 20));
    if (shutdown) await sessions.close(); else cancel.abort();
    await rejected;
    await sessions.close();
    assert.equal(fake.stops, 1);
    assert.equal(fake.listeners.size, 0);
    await assert.rejects(sessions.ask(request()), /closed/);
  }
});

for (const advisor of ['astra', 'fable'] as const) {
  test(`live native ${advisor} retains memory after cancelling and replacing its child`, {
    skip: !process.env.PI_LIGHT_LIVE_CLI, timeout: 300_000,
  }, async () => {
    const configs: RpcClientOptions[] = [];
    const sessions = new AdvisorSessions({ cliPath: process.env.PI_LIGHT_LIVE_CLI!, timeoutMs: 120_000 }, options => {
      configs.push(options);
      return new RpcClient(options);
    });
    const marker = `continuity-${randomUUID()}`;
    const base = { advisor, topic: 'live-continuity', cwd: folder };
    try {
      const first = await sessions.ask({ ...base, prompt: `Remember this exact marker for later: ${marker}. Reply only SAVED. Do not use tools.` });
      assert.equal(first.actualModel, `${ADVISORS[advisor].provider}/${ADVISORS[advisor].model}`);
      const cancel = new AbortController();
      let streamed = false;
      await assert.rejects(sessions.ask({ ...base,
        prompt: 'Write 300 numbered sentences about trees. Do not use tools. Start immediately.', signal: cancel.signal,
        onProgress() { streamed = true; cancel.abort(); },
      }), /cancelled/);
      assert.ok(streamed, 'cancel only after the native model begins streaming');
      const resumed = await sessions.ask({ ...base, prompt: 'What exact marker did I ask you to remember before the interrupted request? Reply only with that marker. Do not use tools.' });
      assert.ok(resumed.text.includes(marker), 'saved conversation must survive transport replacement');
      assert.equal(resumed.actualModel, first.actualModel);
      assert.equal(configs.length, 2);
      assert.deepEqual(configs[1], configs[0]);
    } finally { await sessions.close(); }
  });
}

test('startup failure is sanitized and cleaned up; concurrency and resource cap fail closed', async () => {
  const fake = new FakeRpcClient();
  fake.failStart = true;
  const sessions = new AdvisorSessions({ ...config, maxSessions: 1 }, () => fake);
  try {
    await assert.rejects(sessions.ask(request()), /^Error: Advisor transport failed/);
    assert.equal(fake.stops, 1);
  } finally { await sessions.close(); }
  const hanging = new FakeRpcClient();
  hanging.behavior = 'hang';
  const bounded = new AdvisorSessions({ ...config, maxSessions: 1 }, () => hanging);
  const pending = bounded.ask(request());
  const rejected = assert.rejects(pending, /cancelled/);
  try {
    await assert.rejects(bounded.ask(request()), /busy/);
    await assert.rejects(bounded.ask({ ...request(), topic: 'new-topic' }), /limit/);
  } finally { await bounded.close(); }
  await rejected;
});

/** Factory whose children fail per model, recording every child config. */
function failoverHarness(behaviors: Record<string, FakeRpcClient['behavior']>) {
  const clients: FakeRpcClient[] = [];
  const factory = (options: RpcClientOptions) => {
    const client = new FakeRpcClient(options);
    client.behavior = behaviors[`${options.provider}/${options.model}`] ?? 'success';
    clients.push(client);
    return client;
  };
  const sessionOf = (client: FakeRpcClient) => {
    const args = client.options!.args!;
    return [args[args.indexOf('--session-dir') + 1], args[args.indexOf('--session-id') + 1]];
  };
  return { clients, factory, sessionOf };
}
// Advisors fall back only to each other (no Sol).
const [ASTRA, FABLE] = DEFAULT_CHAINS.astra;
assert.deepEqual(DEFAULT_CHAINS.fable, [FABLE, ASTRA]);

test('limit error fails over to the next candidate on the same session, resending the prompt once', async () => {
  const { clients, factory, sessionOf } = failoverHarness({ [ASTRA]: 'limit-error' });
  const cooldowns = new Cooldowns();
  const sessions = new AdvisorSessions({ ...config, cooldowns }, factory);
  try {
    const reply = await sessions.ask(request());
    assert.equal(reply.actualModel, FABLE);
    assert.deepEqual(reply.fallbackFrom, [`${ASTRA}: 429 usage limit reached`]);
    assert.equal(replyModelLabel(reply), `${FABLE}, fallback from ${ASTRA}: 429 usage limit reached`);
    assert.equal(clients.length, 2);
    assert.deepEqual(clients.map(client => client.options!.model), ['gpt-6-astra', 'claude-fable-5-1']);
    assert.deepEqual(sessionOf(clients[1]), sessionOf(clients[0]), 'fallback child resumes the same session id and directory');
    assert.deepEqual(clients.map(client => client.prompts), [['Inspect this design'], ['Inspect this design']]);
    assert.equal(clients[0].stops, 1);
    assert.equal(clients[0].listeners.size, 0);
    // Cooled preferred model: the next call starts at the fallback and still reports why.
    const followup = await sessions.ask({ ...request(), prompt: 'Follow-up' });
    assert.equal(followup.actualModel, FABLE);
    assert.match(followup.fallbackFrom![0], /gpt-6-astra: cooling down after 429 usage limit reached/);
    assert.equal(clients.length, 2, 'the fallback child is reused while the preferred model cools down');
    assert.ok(cooldowns.get(ASTRA));
  } finally { await sessions.close(); }
});

test('candidates without credentials are skipped and reported, not treated as errors', async () => {
  const { clients, factory } = failoverHarness({});
  const sessions = new AdvisorSessions(config, factory);
  try {
    const reply = await sessions.ask({ ...request(), isAvailable: model => model !== ASTRA });
    assert.equal(reply.actualModel, FABLE);
    assert.deepEqual(reply.fallbackFrom, [`${ASTRA}: no credentials or unknown model`]);
    assert.equal(clients.length, 1);
    const preferred = await sessions.ask({ ...request(), topic: 'other', isAvailable: model => model !== FABLE });
    assert.equal(preferred.fallbackFrom, undefined, 'unavailable models later in the chain are not a fallback');
    await assert.rejects(sessions.ask({ ...request(), topic: 'none', isAvailable: () => false }), /no usable model/);
  } finally { await sessions.close(); }
});

test('non-limit errors keep current behavior: no fallback, no cooldown, no replay', async () => {
  for (const behavior of ['invalid-request', 'provider-error', 'abort'] as const) {
    const { clients, factory } = failoverHarness({ [ASTRA]: behavior });
    const cooldowns = new Cooldowns();
    const sessions = new AdvisorSessions({ ...config, cooldowns }, factory);
    try {
      await assert.rejects(sessions.ask(request()), /^Error: Advisor model/);
      assert.equal(clients.length, 1, behavior);
      assert.equal(cooldowns.get(ASTRA), undefined);
    } finally { await sessions.close(); }
  }
});

test('all candidates exhausted reports each model with a redacted reason', async () => {
  const { clients, factory, sessionOf } = failoverHarness({ [ASTRA]: 'limit-error', [FABLE]: 'limit-error' });
  const sessions = new AdvisorSessions(config, factory);
  try {
    const error = await sessions.ask(request()).then(() => undefined, (failure: Error) => failure);
    assert.ok(error);
    assert.match(error.message, /^Advisor astra: every fallback model hit a limit or was unavailable/);
    for (const model of [ASTRA, FABLE]) assert.ok(error.message.includes(`${model}: 429 usage limit reached`), model);
    assert.equal(error.message.includes('retry-after details'), false, 'only the first redacted line is reported');
    assert.equal(clients.length, 2);
    assert.ok(clients.every(client => client.stops === 1 && client.listeners.size === 0));
    assert.ok(clients.every(client => JSON.stringify(sessionOf(client)) === JSON.stringify(sessionOf(clients[0]))));
  } finally { await sessions.close(); }
});

test('preferred model is retried after its cooldown on the same session', async () => {
  let now = 0;
  const cooldowns = new Cooldowns(1000, () => now);
  const behaviors: Record<string, FakeRpcClient['behavior']> = { [ASTRA]: 'limit-error' };
  const { clients, factory, sessionOf } = failoverHarness(behaviors);
  const sessions = new AdvisorSessions({ ...config, cooldowns }, factory);
  try {
    assert.equal((await sessions.ask(request())).actualModel, FABLE);
    now = 1001;
    behaviors[ASTRA] = 'success';
    const reply = await sessions.ask({ ...request(), prompt: 'Later' });
    assert.deepEqual(reply, { text: 'Authoritative final text', actualModel: ASTRA });
    assert.equal(clients.length, 3);
    assert.equal(clients[2].options!.model, 'gpt-6-astra');
    assert.deepEqual(sessionOf(clients[2]), sessionOf(clients[0]));
    assert.equal(clients[1].stops, 1, 'fallback child is stopped before switching back');
    assert.deepEqual(clients[2].prompts, ['Later']);
  } finally { await sessions.close(); }
});
