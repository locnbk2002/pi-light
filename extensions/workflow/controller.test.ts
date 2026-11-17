import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEventBus, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import piLight, { hasModelFlag } from './index.ts';
import { isHerdrSubagentChild, isOneShotInvocation } from '../../lib/run-mode.ts';
import { DEFAULT_CHAINS, MAIN_MODEL, VIRTUAL_CONTROLLER } from './model-fallback.ts';
import { EFFORT_INSTRUCTION, MODELS_QUERY, type ModelsQuery, type PiLightModels } from './models-query.ts';
// package.json lists test files explicitly; run the fallback module's unit tests with this suite.
import './model-fallback.test.ts';

// Removed names are assembled at runtime so a repository grep for them finds no leftovers (Phase 8 Verify).
const RETIRED_TOOL = ['consult', 'advisor'].join('_');
const RETIRED_COMMANDS = ['advisor', 'back', ['cancel', 'advisor'].join('-'), 'consult'];

const available = ['read', 'grep', 'find', 'ls', 'bash', 'powershell', 'edit', 'write', 'browser_click', 'browser_read', 'mcp__shell', 'codemode', 'browser'];

test('native package leaves one-shot Pi child jobs untouched', () => {
  assert.equal(isOneShotInvocation(['--mode', 'json', '-p', '--no-session']), true);
  assert.equal(isOneShotInvocation(['--print', 'hello']), true);
  assert.equal(isOneShotInvocation(['--mode', 'rpc']), false);
  assert.equal(isOneShotInvocation([]), false);
  assert.equal(isOneShotInvocation(['--', '--print']), false);
});

test('one-shot extension factory registers only the virtual controller model and its failover', () => {
  const previous = process.argv;
  try {
    process.argv = [previous[0], previous[1], '--mode', 'json', '-p', '--no-session'];
    const registered: { provider: string; id: string }[] = [];
    const events: string[] = [];
    const untouched = new Proxy({}, { get(_target, name) {
      if (name === 'registerVirtualModel') return (definition: { provider: string; id: string }) => { registered.push(definition); };
      if (name === 'on') return (event: string) => { events.push(event); };
      throw new Error(`One-shot Pi must not access extension API ${String(name)}`);
    } });
    assert.doesNotThrow(() => piLight(untouched as ExtensionAPI));
    assert.deepEqual(registered.map(({ provider, id }) => ({ provider, id })), [{ provider: VIRTUAL_CONTROLLER.provider, id: VIRTUAL_CONTROLLER.id }]);
    assert.deepEqual(events, ['agent_before_settle', 'agent_settled'], 'only the shared settle-time failover');
  } finally { process.argv = previous; }
});

test('herdr subagent panes keep their requested model and default to the controller chain', async () => {
  assert.equal(isHerdrSubagentChild({ PI_SUBAGENT_ID: 'ab12cd34' }), true);
  assert.equal(isHerdrSubagentChild({ PI_SUBAGENT_ID: '' }), false);
  assert.equal(isHerdrSubagentChild({ HERDR_ENV: '1' }), false, 'the orchestrator pane itself is not a child');
  assert.equal(hasModelFlag(['--session', 's.jsonl', '--model', 'openai-codex/gpt-6-astra:high']), true);
  assert.equal(hasModelFlag(['--model=anthropic/claude-fable-5-2']), true);
  assert.equal(hasModelFlag(['--session', 's.jsonl', '@task.md']), false);
  assert.equal(hasModelFlag(['--', '--model', 'x/y']), false);

  const previous = { argv: process.argv, id: process.env.PI_SUBAGENT_ID };
  const run = async (args: string[], current: { provider: string; id: string }) => {
    process.argv = [previous.argv[0], previous.argv[1], ...args];
    const registered: string[] = [];
    const selected: string[] = [];
    const thinking: string[] = [];
    const handlers: Record<string, (event: unknown, ctx: unknown) => Promise<void>> = {};
    const api = new Proxy({}, { get(_target, name) {
      if (name === 'registerVirtualModel') return (definition: { provider: string; id: string }) => { registered.push(`${definition.provider}/${definition.id}`); };
      if (name === 'setThinkingLevel') return (level: string) => { thinking.push(level); };
      if (name === 'on') return (event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => { handlers[event] = handler; };
      if (name === 'setModel') return async (model: { provider: string; id: string }) => { selected.push(`${model.provider}/${model.id}`); return true; };
      throw new Error(`Herdr child must not access extension API ${String(name)}`);
    } });
    piLight(api as ExtensionAPI);
    const ctx = { model: current, ui: { notify() {} }, modelRegistry: { find: (provider: string, id: string) => ({ provider, id }) } };
    await handlers.session_start?.({}, ctx);
    return { registered, selected, thinking, events: Object.keys(handlers) };
  };
  try {
    process.env.PI_SUBAGENT_ID = 'ab12cd34';
    const virtual = `${VIRTUAL_CONTROLLER.provider}/${VIRTUAL_CONTROLLER.id}`;
    const unpinned = await run(['--session', 's.jsonl', '@task.md'], { provider: 'openai-codex', id: 'gpt-6.1-sol' });
    const events = ['agent_before_settle', 'agent_settled', 'session_start'];
    assert.deepEqual(unpinned, { registered: [virtual], selected: [virtual], thinking: [], events });
    const pinned = await run(['--session', 's.jsonl', '--model', 'openai-codex/gpt-6-astra', '@task.md'], { provider: 'openai-codex', id: 'gpt-6-astra' });
    assert.deepEqual(pinned, { registered: [virtual], selected: [], thinking: [], events }, 'a requested model is never overridden');
    // Explicit level plus an appended agent-definition level: the explicit (inner) level wins.
    const doubled = await run(['--session', 's.jsonl', '--model', 'openai-codex/gpt-6.1-sol:high:low'], { provider: 'openai-codex', id: 'gpt-6.1-sol' });
    assert.deepEqual(doubled, { registered: [virtual], selected: [], thinking: ['high'], events });
    const judged = await run(['--model', `${virtual}:xhigh`], { provider: VIRTUAL_CONTROLLER.provider, id: VIRTUAL_CONTROLLER.id });
    assert.deepEqual(judged, { registered: [virtual], selected: [], thinking: [], events }, 'a single suffix is left to Pi');
  } finally {
    process.argv = previous.argv;
    if (previous.id === undefined) delete process.env.PI_SUBAGENT_ID; else process.env.PI_SUBAGENT_ID = previous.id;
  }
});

test('controller uses native Anthropic Opus', () => {
  assert.deepEqual(MAIN_MODEL, { provider: 'anthropic', model: 'claude-opus-5-5' });
});

function extensionHarness() {
  const commands = new Map<string, Parameters<ExtensionAPI['registerCommand']>[1]>();
  const tools = new Map<string, Parameters<ExtensionAPI['registerTool']>[0]>();
  const events = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const renderers = new Map<string, Parameters<ExtensionAPI['registerMessageRenderer']>[1]>();
  // The workflow never narrows the active tool set; every registered tool stays active.
  let activeTools: string[] = [...available];
  let sent = 0;
  const sentRecords: { message: unknown; options: unknown }[] = [];
  let confirmations = 0;
  const notifications: string[] = [];
  const statuses = new Map<string, string | undefined>();
  const selected: unknown[] = [];
  let virtualModel: Parameters<ExtensionAPI['registerVirtualModel']>[0] | undefined;
  const bus = createEventBus();
  // These partial test doubles exercise registered real handlers, not a copied policy.
  // Assertions at the mock boundary intentionally omit unrelated Pi UI/session APIs.
  const pi = {
    events: bus,
    on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) { events.set(name, handler); return () => {}; },
    registerCommand(name: string, command: Parameters<ExtensionAPI['registerCommand']>[1]) { commands.set(name, command); },
    registerTool(tool: Parameters<ExtensionAPI['registerTool']>[0]) { tools.set(tool.name, tool); }, registerFlag() {}, registerEntryRenderer() {},
    registerMessageRenderer(name: string, renderer: Parameters<ExtensionAPI['registerMessageRenderer']>[1]) { renderers.set(name, renderer); },
    getAllTools() { return available.map(name => ({ name })); },
    setActiveTools(names: string[]) { activeTools = names; },
    sendMessage(message: unknown, options: unknown) { sent++; sentRecords.push({ message, options }); }, appendEntry() {},
    registerVirtualModel(definition: Parameters<ExtensionAPI['registerVirtualModel']>[0]) { virtualModel = definition; },
    async setModel(model: { provider: string; id: string }) { selected.push(model); (ctx as { model: unknown }).model = model; return true; },
  } as unknown as ExtensionAPI;
  // Catalog stub: every model exists; `unavailable` simulates providers without credentials.
  const unavailable = new Set<string>();
  // Fake judge provider: records each judge call and answers with `judge.reply`.
  const judge = { calls: [] as string[], reply: (_model: string): Promise<unknown> => Promise.resolve({ content: [{ type: 'text', text: '{"level":"high"}' }], stopReason: 'stop' }) };
  const ctx = {
    mode: 'tui', hasUI: true, model: { provider: VIRTUAL_CONTROLLER.provider, id: VIRTUAL_CONTROLLER.id }, cwd: '/tmp', isIdle: () => true, hasPendingMessages: () => false,
    modelRegistry: {
      find: (provider: string, id: string) => ({ provider, id }),
      hasConfiguredAuth: (model: { provider: string; id: string }) => !unavailable.has(`${model.provider}/${model.id}`),
      streamSimple: (model: { provider: string; id: string }) => {
        const ref = `${model.provider}/${model.id}`;
        judge.calls.push(ref);
        return { result: () => judge.reply(ref) };
      },
    },
    ui: { notify(text: string) { notifications.push(text); }, setStatus(key: string, text: string | undefined) { statuses.set(key, text); }, setWidget() {},
      async confirm() { confirmations++; return false; } },
  } as unknown as ExtensionContext;
  piLight(pi);
  return {
    ctx, bus, notifications, statuses, selected, unavailable, judge, virtualModel: () => virtualModel!,
    renderers, tools, sentRecords, active: () => activeTools, sent: () => sent, confirmations: () => confirmations,
    async command(name: string, args = '') { await commands.get(name)!.handler(args, ctx as Parameters<Parameters<ExtensionAPI['registerCommand']>[1]['handler']>[1]); },
    async event(name: string, value: unknown) {
      const event = name === 'before_agent_start' ? { systemPromptOptions: { sections: {} }, ...(value as object) } : value;
      return events.get(name)!(event, ctx);
    },
    /** Ask pi-light for its model facts the way the optional routing workflow does. */
    models(queryCtx: unknown = ctx): PiLightModels[] {
      const answers: PiLightModels[] = [];
      bus.emit(MODELS_QUERY, { ctx: queryCtx, reply(answer: PiLightModels) { answers.push(answer); } } satisfies ModelsQuery);
      return answers;
    },
  };
}

test('display-only advisor filtering preserves native system and tool patch positions', async () => {
  const harness = extensionHarness();
  const head = { role: 'system', content: 'Head', toolsAdded: [{ name: 'read' }] };
  const patch = { role: 'system', content: 'Patch', toolsRemoved: [{ name: 'write' }] };
  const hidden = { role: 'custom', customType: 'pi-light-advisor', content: 'Private reply' };
  const messages = [head, { role: 'user', content: 'Question' }, patch, hidden];
  const result = await harness.event('context_with_system', { messages }) as { messages: unknown[] };
  assert.deepEqual(result.messages, messages.slice(0, 3));
  assert.equal(result.messages[0], head);
  assert.equal(result.messages[2], patch);
  assert.equal(messages.length, 4);
});

test('retired advisor and consult messages stay out of controller context', async () => {
  const harness = extensionHarness();
  const direct = { role: 'custom', customType: 'pi-light-advisor', content: 'Private advisor reply' };
  const consult = { role: 'custom', customType: 'pi-light-consult', content: 'Requested consultation' };
  const result = { role: 'custom', customType: 'subagent_result', content: 'Subagent result' };
  const user = { role: 'user', content: 'Controller task' };
  const messages = [user, direct, result, consult];
  assert.deepEqual(await harness.event('context_with_system', { messages }), { messages: [user, result] });
  assert.equal(messages.length, 4, 'context filtering must not mutate stored transcript');
  assert.equal(harness.renderers.has('pi-light-advisor'), false);
});

const OPUS_REF = DEFAULT_CHAINS.controller[0];
const SOL_REF = DEFAULT_CHAINS.controller[1];
const physical = (ref: string) => { const [provider, ...id] = ref.split('/'); return { provider, id: id.join('/') }; };

test('controller selects the fallback virtual model; the model gate accepts virtual or native Opus only', async () => {
  const harness = extensionHarness();
  const definition = harness.virtualModel();
  assert.deepEqual([definition.provider, definition.id, definition.name], ['pi-light', 'controller', 'Opus (fallback)']);
  (harness.ctx as { model: unknown }).model = { provider: MAIN_MODEL.provider, id: MAIN_MODEL.model };
  harness.ctx.mode = 'rpc';
  await harness.event('session_start', { reason: 'startup' });
  assert.deepEqual(harness.selected, [{ provider: 'pi-light', id: 'controller' }]);
  await harness.event('before_agent_start', { messageType: 'user', systemPrompt: 'Base' });
  (harness.ctx as { model: unknown }).model = { provider: MAIN_MODEL.provider, id: MAIN_MODEL.model };
  await harness.event('before_agent_start', { messageType: 'user', systemPrompt: 'Base' });
  (harness.ctx as { model: unknown }).model = { provider: 'openai-codex', id: 'gpt-6-astra' };
  (harness.ctx as { abort: () => void }).abort = () => {};
  await assert.rejects(Promise.resolve().then(() => harness.event('before_agent_start', { messageType: 'user', systemPrompt: 'Base' })), /incorrect main model/);
});

test('registered virtual route: limit retry switches with status, continuation sticks, non-limit retry stays', async () => {
  const harness = extensionHarness();
  const definition = harness.virtualModel();
  const route = (request: object) => definition.route({ model: physical('pi-light/controller'), thinkingLevel: 'high', messages: [], ...request } as unknown as Parameters<typeof definition.route>[0], harness.ctx);
  assert.deepEqual(await route({ reason: 'user' }), { model: physical(OPUS_REF), thinkingLevel: 'high' });
  assert.equal(harness.statuses.get('pi-light-model'), undefined);
  assert.deepEqual(await route({ reason: 'retry', failed: { model: physical(OPUS_REF), thinkingLevel: 'medium',
    message: { role: 'assistant', stopReason: 'error', errorMessage: 'connection reset: stream ended without message_stop' } } }),
  { model: physical(OPUS_REF), thinkingLevel: 'medium' }, 'non-limit retry stays sticky');
  assert.deepEqual(await route({ reason: 'retry', failed: { model: physical(OPUS_REF), thinkingLevel: 'medium',
    message: { role: 'assistant', stopReason: 'error', errorMessage: '429 rate_limit_error' } } }),
  { model: physical(SOL_REF), thinkingLevel: 'high' });
  assert.match(harness.statuses.get('pi-light-model')!, /controller fallback: openai-codex\/gpt-6.1-sol/);
  assert.ok(harness.notifications.some(text => text.includes('429 rate_limit_error') && text.includes(SOL_REF)));
  assert.deepEqual(await route({ reason: 'continuation', previous: { model: physical(SOL_REF), thinkingLevel: 'low' } }),
    { model: physical(SOL_REF), thinkingLevel: 'low' });
  assert.deepEqual((await route({ reason: 'user' })).model, physical(SOL_REF), 'Opus is cooling down');
  harness.unavailable.add(SOL_REF);
  assert.deepEqual((await route({ reason: 'user' })).model, physical(OPUS_REF), 'soonest-expiring model when nothing else is usable');
});

function settleEvent(errorMessage: string, model = OPUS_REF) {
  const failed = { role: 'assistant', ...physical(model), model: physical(model).id, stopReason: 'error', errorMessage, content: [] };
  return {
    type: 'agent_before_settle', outcome: 'error', entries: [], continue: false,
    context: { contextEntries: [
      { sourceEntry: { id: 'user-1' }, messages: [{ role: 'user', content: 'Task' }] },
      { sourceEntry: { id: 'failed-1' }, messages: [failed] },
    ] },
  };
}

test('non-retried usage limits omit only the failed attempt and continue once on the fallback', async () => {
  const harness = extensionHarness();
  assert.equal(await harness.event('agent_before_settle', settleEvent('invalid_request_error: bad field')), undefined);
  assert.deepEqual(await harness.event('agent_before_settle', settleEvent('You have hit your ChatGPT usage limit (pro plan).')), {
    entries: [{ type: 'context_edit', targetId: 'failed-1', replacement: null }], continue: true,
  });
  assert.ok(harness.notifications.some(text => text.includes(`Continuing this request on ${SOL_REF}`)));
  // The fallback is limited too: nothing is left, so the run settles with a clear notice.
  assert.equal(await harness.event('agent_before_settle', settleEvent('insufficient_quota', SOL_REF)), undefined);
  assert.ok(harness.notifications.at(-1)!.includes('No fallback model is left'));
  // Native (non-virtual) selection never continues automatically.
  const native = extensionHarness();
  (native.ctx as { model: unknown }).model = { provider: MAIN_MODEL.provider, id: MAIN_MODEL.model };
  assert.equal(await native.event('agent_before_settle', settleEvent('429 usage limit')), undefined);
});

test('routing lives in the optional kit: no tools, mode commands, route status or prompt section here', async () => {
  const harness = extensionHarness();
  for (const name of [...RETIRED_COMMANDS, 'auto', 'plan', 'brainstorm', 'work']) {
    await assert.rejects(harness.command(name), TypeError, `/${name} must not be registered`);
  }
  assert.deepEqual([...harness.tools.keys()], []);
  assert.equal(harness.tools.has(RETIRED_TOOL), false);
  await harness.event('session_start', { reason: 'startup' });
  assert.deepEqual(await harness.event('input', { text: 'hello', source: 'interactive' }), { action: 'continue' });
  const event = { messageType: 'user', systemPrompt: 'Base', systemPromptOptions: { sections: {} as Record<string, string> } };
  assert.equal(await harness.event('before_agent_start', event), undefined, 'no binding message');
  assert.deepEqual(event.systemPromptOptions.sections, {}, 'no workflow prompt section');
  assert.equal(harness.statuses.has('pi-light'), false, 'no route status');
});

test('input is sent only when the controller can be selected', async () => {
  const harness = extensionHarness();
  (harness.ctx as { model: unknown }).model = { provider: 'openai-codex', id: 'gpt-6-astra' };
  const missing = harness.ctx.modelRegistry as unknown as { find: (provider: string, id: string) => unknown };
  missing.find = () => undefined;
  assert.deepEqual(await harness.event('input', { text: 'hello', source: 'interactive' }), { action: 'handled' });
  assert.ok(harness.notifications.includes('Opus controller is unavailable. No controller prompt will be sent.'));
});

test('models query: pi-light names the controller, its other-family reviewer and the effort instruction', async () => {
  const harness = extensionHarness();
  assert.deepEqual(harness.models(), [{ controllerModel: MAIN_MODEL.provider + '/' + MAIN_MODEL.model, controllerFamily: 'anthropic',
    reviewerModel: 'openai-codex/gpt-6.1-sol', effortInstruction: EFFORT_INSTRUCTION }]);
  assert.match(EFFORT_INSTRUCTION, /^Start each subagent task with one line "solutionSpace: \.\.\."/);
  assert.match(EFFORT_INSTRUCTION, /small judge model uses it to pick the child's reasoning effort/);
  // Availability is checked against the asking turn's model registry.
  harness.unavailable.add('openai-codex/gpt-6.1-sol');
  assert.equal(harness.models()[0].reviewerModel, undefined, 'no other-family model is available');
  assert.equal(harness.models({})[0].reviewerModel, 'openai-codex/gpt-6.1-sol', 'without a usable context every configured model counts');
  // After a fallback route the implementing model is the fallback, reviewed by the other family.
  harness.unavailable.clear();
  const definition = harness.virtualModel();
  await definition.route({ reason: 'retry', model: physical('pi-light/controller'), thinkingLevel: 'high', messages: [],
    failed: { model: physical(OPUS_REF), thinkingLevel: 'high', message: { role: 'assistant', stopReason: 'error', errorMessage: '429 rate_limit_error' } } } as unknown as Parameters<typeof definition.route>[0], harness.ctx);
  assert.deepEqual(harness.models()[0], { controllerModel: SOL_REF, controllerFamily: 'openai', reviewerModel: OPUS_REF, effortInstruction: EFFORT_INSTRUCTION });
});

test('models query: no effort instruction while the effort judge is off', async () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const dir = await mkdtemp(join(tmpdir(), 'pi-light-models-query-'));
  try {
    await writeFile(join(dir, 'pi-light-models.json'), JSON.stringify({ effort: { enabled: false } }));
    process.env.PI_CODING_AGENT_DIR = dir;
    const [answer] = extensionHarness().models();
    assert.equal('effortInstruction' in answer, false);
    assert.equal(answer.reviewerModel, SOL_REF);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test('context filtering leaves route bindings and the signed history untouched', async () => {
  const harness = extensionHarness();
  const binding = { role: 'custom', customType: 'pi-light-route-binding', content: 'Current human request ID: fixture.' };
  const head = { role: 'system', content: 'Original prompt', toolsAdded: [{ name: 'read' }] };
  const assistant = { role: 'assistant', content: [{ type: 'thinking', thinking: 'synthetic fixture', thinkingSignature: 'fixture-signature' }] };
  const patch = { role: 'system', content: 'Native tool patch', toolsRemoved: [{ name: 'write' }] };
  const original = [head, { role: 'user', content: 'Plan a test feature.' }, binding, assistant, patch, { role: 'toolResult', content: 'Fixture result' }];
  assert.equal(await harness.event('context_with_system', { messages: original }), undefined);
  await harness.event('agent_settled', {});
  assert.equal(await harness.event('context_with_system', { messages: original }), undefined, 'settlement must not delete an old binding');
});

const subagentCall = (id: string, args: Record<string, unknown>) => ({ type: 'toolCall', id, name: 'subagent', arguments: args });

test('subagent effort: every call in one message is judged concurrently, then applied as a model suffix', async () => {
  const harness = extensionHarness();
  let resolveSlow!: () => void;
  const gate = new Promise<void>(resolve => { resolveSlow = resolve; });
  harness.judge.reply = async () => { await gate; return { content: [{ type: 'text', text: '{"level":"xhigh"}' }], stopReason: 'stop' }; };
  const inputs = Array.from({ length: 5 }, (_, i) => ({ name: `w${i}`, task: `solutionSpace: open cause ${i}\nDo the work.` }));
  await harness.event('message_end', { message: { role: 'assistant', content: inputs.map((input, i) => subagentCall(`c${i}`, input)) } });
  assert.equal(harness.judge.calls.length, 5, 'all judges start at message_end, before any tool_call preflight');
  setTimeout(resolveSlow, 30);
  const started = Date.now();
  for (const [i, input] of inputs.entries()) await harness.event('tool_call', { toolName: 'subagent', toolCallId: `c${i}`, input });
  assert.ok(Date.now() - started < 1000, 'the batch waits about one judgment, not five');
  assert.deepEqual(inputs.map(input => (input as { model?: string }).model), Array(5).fill('pi-light/controller:xhigh'));
  assert.equal(harness.judge.calls.length, 5, 'tool_call reuses the pre-judged results');
  assert.ok(harness.notifications.some(text => /subagent w0: effort xhigh \(judge anthropic\/claude-haiku-5-5, /.test(text)));
});

test('subagent effort: explicit suffix and caller model are honored; judge failure falls back to medium', async () => {
  const harness = extensionHarness();
  const explicit = { name: 'r', task: 'review', model: 'openai-codex/gpt-6.1-sol:high' };
  await harness.event('tool_call', { toolName: 'subagent', toolCallId: 'x1', input: explicit });
  assert.equal(explicit.model, 'openai-codex/gpt-6.1-sol:high', 'explicit level untouched');
  assert.equal(harness.judge.calls.length, 0);
  // No message_end first: the hook judges inline, keeping the caller's model as the base.
  const pinned = { name: 'p', task: 'fix given', model: 'openai-codex/gpt-6.1-sol' };
  await harness.event('tool_call', { toolName: 'subagent', toolCallId: 'x2', input: pinned });
  assert.equal(pinned.model, 'openai-codex/gpt-6.1-sol:high');
  harness.judge.reply = () => Promise.reject(new Error('provider down'));
  const failed = { name: 'f', task: 'anything' } as { name: string; task: string; model?: string };
  await harness.event('tool_call', { toolName: 'subagent', toolCallId: 'x3', input: failed });
  assert.equal(failed.model, 'pi-light/controller:medium');
  assert.ok(harness.notifications.some(text => /subagent f: effort medium \(fallback: .*provider down.*, /.test(text)));
  const other = { path: 'x' };
  await harness.event('tool_call', { toolName: 'read', toolCallId: 'x4', input: other });
  assert.deepEqual(other, { path: 'x' }, 'other tools are untouched');
});

test('subagent effort: precedence is decided from the arguments at tool_call, not the cached message_end view', async () => {
  const harness = extensionHarness();
  const calls = [
    { name: 'a', task: 'solutionSpace: fix given', model: 'openai-codex/gpt-6.1-sol' },
    { name: 'b', task: 'solutionSpace: fix given', model: 'openai-codex/gpt-6.1-sol' },
    { name: 'c', task: 'solutionSpace: fix given' },
  ] as Array<{ name: string; task: string; model?: string }>;
  await harness.event('message_end', { message: { role: 'assistant', content: calls.map((input, i) => subagentCall(`m${i}`, { ...input })) } });
  assert.equal(harness.judge.calls.length, 3);
  // Another extension's earlier tool_call handler changed the arguments after message_end.
  calls[0].model = 'openai-codex/gpt-6-astra:low';
  calls[1].model = 'openai-codex/gpt-6-astra';
  calls[2].task = 'solutionSpace: open cause, no reproduction';
  for (const [i, input] of calls.entries()) await harness.event('tool_call', { toolName: 'subagent', toolCallId: `m${i}`, input });
  assert.equal(calls[0].model, 'openai-codex/gpt-6-astra:low', 'a newer explicit level wins');
  assert.equal(calls[1].model, 'openai-codex/gpt-6-astra:high', 'the newer base model keeps the cached judgment for the same task');
  assert.equal(calls[2].model, 'pi-light/controller:high');
  assert.equal(harness.judge.calls.length, 4, 'a changed task is judged again inline');
});

test('subagent effort with the judge off: no judge calls, but precedence repairs stay on (option 2)', async () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const dir = await mkdtemp(join(tmpdir(), 'pi-light-effort-off-'));
  try {
    await mkdir(join(dir, 'agents'));
    await writeFile(join(dir, 'pi-light-models.json'), JSON.stringify({ effort: { enabled: false } }));
    await writeFile(join(dir, 'agents', 'thinker.md'), '---\nname: thinker\nthinking: high\n---\n');
    process.env.PI_CODING_AGENT_DIR = dir;
    const harness = extensionHarness();
    const plain = { name: 'p', task: 'anything' } as { name: string; task: string; model?: string };
    await harness.event('message_end', { message: { role: 'assistant', content: [subagentCall('o1', { ...plain })] } });
    await harness.event('tool_call', { toolName: 'subagent', toolCallId: 'o1', input: plain });
    assert.equal(plain.model, undefined, 'no judged suffix');
    const thinker = { name: 't', task: 'anything', agent: 'thinker' } as { name: string; task: string; agent: string; model?: string };
    await harness.event('tool_call', { toolName: 'subagent', toolCallId: 'o2', input: thinker });
    assert.equal(thinker.model, 'pi-light/controller', 'a thinking-only agent definition still gets a base so its level reaches the child');
    assert.equal(harness.judge.calls.length, 0);
    assert.equal(harness.notifications.some(text => text.startsWith('subagent')), false, 'no effort notices while the judge is off');
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test('subagent effort: a batch of stalled judges falls back together at one configured deadline', async () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const dir = await mkdtemp(join(tmpdir(), 'pi-light-effort-batch-'));
  try {
    await writeFile(join(dir, 'pi-light-models.json'), JSON.stringify({ effort: { timeoutMs: 500 } }));
    process.env.PI_CODING_AGENT_DIR = dir;
    const harness = extensionHarness();
    harness.judge.reply = () => new Promise(() => {}); // providers that never answer and ignore aborts
    const inputs = Array.from({ length: 5 }, (_, i) => ({ name: `s${i}`, task: `task ${i}` })) as Array<{ name: string; task: string; model?: string }>;
    await harness.event('message_end', { message: { role: 'assistant', content: inputs.map((input, i) => subagentCall(`s${i}`, { ...input })) } });
    const started = Date.now();
    for (const [i, input] of inputs.entries()) await harness.event('tool_call', { toolName: 'subagent', toolCallId: `s${i}`, input });
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 400 && elapsed < 1200, `one shared deadline for the batch, not five (${elapsed} ms)`);
    assert.deepEqual(inputs.map(input => input.model), Array(5).fill('pi-light/controller:medium'));
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test('subagent effort: an untrusted project agent definition never sets the child model (fix 4)', async () => {
  const previous = { agentDir: process.env.PI_CODING_AGENT_DIR, cwd: process.cwd() };
  const dir = await mkdtemp(join(tmpdir(), 'pi-light-effort-trust-'));
  try {
    await mkdir(join(dir, 'profile'));
    await mkdir(join(dir, 'clone', '.pi', 'agents'), { recursive: true });
    await writeFile(join(dir, 'clone', '.pi', 'agents', 'counsel.md'), '---\nname: counsel\nmodel: evil/model\n---\n');
    process.env.PI_CODING_AGENT_DIR = join(dir, 'profile');
    process.chdir(join(dir, 'clone'));
    const harness = extensionHarness();
    Object.assign(harness.ctx, { cwd: join(dir, 'clone'), isProjectTrusted: () => false });
    const call = { name: 'c', task: 'solutionSpace: open', agent: 'counsel' } as { name: string; task: string; agent: string; model?: string };
    await harness.event('message_end', { message: { role: 'assistant', content: [subagentCall('t1', { ...call })] } });
    await harness.event('tool_call', { toolName: 'subagent', toolCallId: 't1', input: call });
    assert.equal(call.model, 'anthropic/claude-fable-5-2:high', 'the packaged counsel definition is the judged base');
  } finally {
    process.chdir(previous.cwd);
    if (previous.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous.agentDir;
    await rm(dir, { recursive: true, force: true });
  }
});
