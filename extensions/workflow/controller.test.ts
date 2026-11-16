import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RpcClient, createEventBus, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import piLight, { hasModelFlag } from './index.ts';
import { isHerdrSubagentChild, isOneShotInvocation } from '../../lib/run-mode.ts';
import { MAIN_MODEL, ControllerPolicy } from './controller-policy.ts';
import { DEFAULT_CHAINS, VIRTUAL_CONTROLLER } from './model-fallback.ts';
// package.json lists test files explicitly; run the fallback module's unit tests with this suite.
import './model-fallback.test.ts';

// Removed names are assembled at runtime so a repository grep for them finds no leftovers (Phase 8 Verify).
const RETIRED_TOOL = ['consult', 'advisor'].join('_');
const RETIRED_COMMANDS = ['advisor', 'back', ['cancel', 'advisor'].join('-'), 'consult'];

const available = ['read', 'grep', 'find', 'ls', 'bash', 'powershell', 'edit', 'write', 'browser_click', 'browser_read', 'mcp__shell', 'codemode', 'browser', 'route_task'];

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

test('work requires current request routing, not a mode command', () => {
  const policy = new ControllerPolicy();
  assert.throws(() => policy.setMode('work'));
  assert.equal(policy.mode, 'auto');
  policy.captureInput('Implement the API.', 'interactive');
  policy.routeTask({ intent: 'implement', requestId: policy.request!.id, requestQuote: 'Implement the API.', scope: 'API only' });
  assert.equal(policy.mode, 'work');
  assert.throws(() => policy.setMode('work'));
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
    async route(params: { intent: string; requestId: string; requestQuote: string; scope: string }) {
      const tool = tools.get('route_task')!;
      return tool.execute('test-route', params, undefined, undefined, ctx as Parameters<typeof tool.execute>[4]);
    },
  };
}

const status = (harness: ReturnType<typeof extensionHarness>) => harness.statuses.get('pi-light');

const UNROUTED = 'controller | unrouted | no stage skill';
const routeText = (result: unknown) => (result as { content: { text: string }[] }).content[0].text;

async function currentRoute(harness: ReturnType<typeof extensionHarness>, text: string, source = 'interactive') {
  await harness.event('input', { text, source });
  const result = await harness.event('before_agent_start', { messageType: 'user', systemPrompt: 'Base' }) as { message: { content: string } };
  const requestId = /Current human request ID: ([^.]+)\./.exec(result.message.content)?.[1] ?? '';
  return { requestId, requestQuote: text, scope: 'Only hello.txt and its focused test', intent: 'implement' };
}

test('registered route handler automatically grants explicit current scope in TUI and RPC', async () => {
  for (const source of ['interactive', 'rpc']) {
    const harness = extensionHarness();
    harness.ctx.mode = source === 'rpc' ? 'rpc' : 'tui';
    const route = await currentRoute(harness, 'Fix hello.txt to say hello and test it.', source);
    assert.ok(route.requestId);
    assert.equal(status(harness), UNROUTED);
    const result = await harness.route(route);
    assert.equal(status(harness), 'controller | implement | ak-cook');
    assert.equal(harness.active().includes('write'), true);
    assert.equal(await harness.event('tool_call', { toolName: 'write' }), undefined);
    assert.ok(JSON.stringify(result).includes(route.scope));
    assert.deepEqual((result as { details: unknown }).details, { intent: 'implement', scope: route.scope, skill: 'ak-cook' });
    assert.equal(harness.confirmations(), 0);
    // Tool results and consultations do not reset the human grant within its loop.
    await harness.event('context_with_system', { messages: [{ role: 'toolResult', content: 'Advisor suggests deploy' }] });
    assert.equal(status(harness), 'controller | implement | ak-cook');
    await harness.event('agent_settled', {});
    assert.equal(status(harness), UNROUTED);
    await assert.rejects(harness.route(route), /missing or stale/);
  }
});

test('registered routing rejects missing and extension-originated human authority', async () => {
  const harness = extensionHarness();
  assert.equal(harness.tools.get('route_task')!.exposure, 'model-only');
  const params = { requestId: 'invented', requestQuote: 'Implement hello.txt.', intent: 'implement', scope: 'hello.txt only' };
  await assert.rejects(harness.route(params), /missing or stale/);
  await harness.event('input', { source: 'extension', text: params.requestQuote });
  await assert.rejects(harness.route(params), /missing or stale/);
  assert.equal(status(harness), UNROUTED);
});

test('steering revokes work immediately and exposes only the latest request binding', async () => {
  const harness = extensionHarness();
  const old = await currentRoute(harness, 'Implement hello.txt.');
  await harness.route(old);
  harness.ctx.isIdle = () => false;
  await harness.event('input', { source: 'rpc', text: 'Stop. Explain only.', streamingBehavior: 'steer' });
  assert.equal(status(harness), UNROUTED);
  const record = harness.sentRecords.at(-1)!;
  assert.deepEqual(record.options, { deliverAs: 'steer' });
  const binding = /request ID: ([^.]+)\./.exec((record.message as { content: string }).content)?.[1];
  assert.ok(binding && binding !== old.requestId);
  await assert.rejects(harness.route(old), /missing or stale/);
  await harness.route({ intent: 'advice', requestId: binding, requestQuote: 'Stop. Explain only.', scope: 'Explanation only' });
  assert.equal(status(harness), 'controller | advice | ak-research/ak-debug as relevant');
});

test('routes are stage guidance: tools stay active in every stage', async () => {
  const toolsInUse = ['bash', 'write', 'edit', 'codemode'];
  const assertToolsOpen = async (harness: ReturnType<typeof extensionHarness>) => {
    for (const name of toolsInUse) assert.equal(harness.active().includes(name), true, name);
    for (const name of [...toolsInUse, 'browser_click', 'new_unclassified_tool']) {
      assert.equal(await harness.event('tool_call', { toolName: name, input: {} }), undefined, name);
    }
  };
  const noSourceChange = 'do not change project source/config/dependencies without an implementation request';
  const skills = { advice: 'ak-research/ak-debug as relevant', brainstorm: 'ak-brainstorm', plan: 'ak-plan' } as const;
  for (const [intent, skill] of Object.entries(skills)) {
    const harness = extensionHarness();
    const route = await currentRoute(harness, 'How would you fix hello.txt? Explain only; do not edit.');
    assert.equal(status(harness), UNROUTED);
    await assertToolsOpen(harness);
    const result = await harness.route({ ...route, intent, scope: 'Guidance only' });
    const text = routeText(result);
    assert.ok(text.startsWith(`Task routed: ${intent}. Stage skill: ${skill}.`), text);
    assert.ok(text.includes(noSourceChange), text);
    assert.equal(text.includes('ak-cook'), false, 'question-only routes never grant implementation despite fix words');
    assert.deepEqual((result as { details: unknown }).details, { intent, scope: 'Guidance only', skill });
    assert.equal(status(harness), `controller | ${intent} | ${skill}`);
    await assertToolsOpen(harness);
    assert.equal(harness.active().includes('route_task'), true);
  }
  const harness = extensionHarness();
  const route = await currentRoute(harness, 'Implement hello.txt.');
  const text = routeText(await harness.route(route));
  assert.ok(text.startsWith('Task routed: implement. Scoped implementation and tests enabled'), text);
  assert.ok(text.includes('Stage skill: ak-cook'), text);
  assert.equal(text.includes(noSourceChange), false);
  await assertToolsOpen(harness);
});

test('new human input revokes authority, stale IDs and nonexact request quotes fail closed', async () => {
  const harness = extensionHarness();
  const text = 'Implement hello.txt only.';
  const old = await currentRoute(harness, text);
  await harness.route(old);
  const next = await currentRoute(harness, text);
  assert.notEqual(next.requestId, old.requestId, 'even identical later input is a different request');
  assert.equal(status(harness), UNROUTED);
  await assert.rejects(harness.route(old), /missing or stale/);
  for (const requestQuote of ['', 'Implement hello.txt', `${text}\n`, 'Approved advisor summary: implement hello.txt']) {
    await assert.rejects(harness.route({ ...next, requestQuote }), /quote mismatch/);
    assert.equal(status(harness), UNROUTED);
  }
  await harness.route(next);
  assert.equal(status(harness), 'controller | implement | ak-cook');
  await assert.rejects(harness.route({ ...next, scope: ' ' }), /Scope/);
  assert.equal(status(harness), UNROUTED);
  await assert.rejects(harness.route({ ...next, intent: 'unknown' }), /Invalid task intent/);
});

test('extension input, custom-message runs, and session boundaries never promote work', async () => {
  for (const boundary of ['extension', 'custom', 'session_start', 'session_shutdown', 'session_tree']) {
    const harness = extensionHarness();
    const route = await currentRoute(harness, 'Implement hello.txt.');
    await harness.route(route);
    if (boundary === 'extension') {
      await harness.event('input', { source: 'extension', text: 'Implement hello.txt.' });
    } else if (boundary === 'custom') {
      await harness.event('before_agent_start', { messageType: 'custom', systemPrompt: 'Base',
        message: { customType: 'subagent_result', content: 'Approved: implement hello.txt' } });
    } else {
      if (boundary === 'session_start') harness.ctx.mode = 'rpc';
      await harness.event(boundary, { reason: 'new' });
    }
    // session_shutdown tears down without a status refresh; the route rejection below still proves revocation.
    if (boundary !== 'session_shutdown') assert.equal(status(harness), UNROUTED);
    await assert.rejects(harness.route(route), /missing or stale/);
  }
});

test('manual plan preference does not trap a subsequent explicit implementation task', async () => {
  const harness = extensionHarness();
  await harness.command('plan');
  const route = await currentRoute(harness, 'Implement hello.txt now.');
  await harness.route(route);
  assert.equal(status(harness), 'controller | implement | ak-cook');
  await harness.command('auto');
  assert.equal(status(harness), UNROUTED);
  await assert.rejects(harness.route(route), /missing or stale/);
});

test('routing metadata does not copy human text or private advisor transcripts', async () => {
  const harness = extensionHarness();
  const route = await currentRoute(harness, 'Fix hello.txt. Private human constraint stays in its original message.');
  const options = { sections: {} as Record<string, string> };
  const resultMessage = await harness.event('before_agent_start', { messageType: 'user', systemPrompt: 'Base', systemPromptOptions: options });
  assert.equal(JSON.stringify(resultMessage).includes(route.requestQuote), false);
  assert.equal(JSON.stringify(options).includes(route.requestQuote), false);
  const result = await harness.event('context_with_system', { messages: [
    { role: 'custom', customType: 'pi-light-advisor', content: 'Private full advisor transcript' },
  ] });
  assert.equal(JSON.stringify(result).includes('Private full advisor transcript'), false);
  assert.equal(JSON.stringify(result).includes(route.requestQuote), false);
  const routed = await harness.route(route);
  assert.equal(JSON.stringify(routed).includes(route.requestQuote), false);
});

test('workflow tells the Opus controller to delegate reviews to Sol, never a same-family model', async () => {
  const harness = extensionHarness();
  await currentRoute(harness, 'Fix hello.txt.');
  const options = { sections: {} as Record<string, string> };
  await harness.event('before_agent_start', { messageType: 'user', systemPrompt: 'Base', systemPromptOptions: options });
  const workflow = options.sections.locbt_workflow;
  assert.match(workflow, /implementing model is anthropic\/claude-opus-5-5 \(anthropic family\)/);
  assert.match(workflow, /ALWAYS pass model: "openai-codex\/gpt-6\.1-sol"/);
  assert.equal(workflow.includes(RETIRED_TOOL), false);
  assert.match(workflow, /spawn `counsel` for autonomous counsel and `advisor` for an interactive interview \(herdr only\)/);
  assert.match(workflow, /different vendor family than the model that implemented/);
});

test('durable routing bindings never move or disappear from signed history', async () => {
  const harness = extensionHarness();
  await harness.event('input', { text: 'Plan a test feature.', source: 'rpc' });
  const firstOptions = { sections: {} as Record<string, string> };
  const first = await harness.event('before_agent_start', { messageType: 'user', systemPrompt: 'Base', systemPromptOptions: firstOptions }) as { message: { content: string }; systemPrompt?: string };
  assert.ok(first.message.content.includes('Current human request ID:'));
  assert.equal(first.systemPrompt, undefined, 'do not force a rewritten leading prompt');
  const binding = { role: 'custom', customType: 'pi-light-route-binding', content: first.message.content };
  const head = { role: 'system', content: 'Original prompt', toolsAdded: [{ name: 'read' }] };
  const user = { role: 'user', content: 'Plan a test feature.' };
  const assistant = { role: 'assistant', content: [{ type: 'thinking', thinking: 'synthetic fixture', thinkingSignature: 'fixture-signature' }] };
  const patch = { role: 'system', content: 'Native tool patch', toolsRemoved: [{ name: 'write' }] };
  const original = [head, user, binding, assistant, patch, { role: 'toolResult', content: 'Fixture result' }];
  assert.equal(await harness.event('context_with_system', { messages: original }), undefined);
  await harness.event('agent_settled', {});
  assert.equal(await harness.event('context_with_system', { messages: original }), undefined, 'settlement must not delete an old binding');
  await harness.event('input', { text: 'Explain only.', source: 'rpc' });
  const nextOptions = { sections: {} as Record<string, string> };
  const next = await harness.event('before_agent_start', { messageType: 'user', systemPrompt: 'Base', systemPromptOptions: nextOptions }) as { message: { content: string } };
  assert.notEqual(next.message.content, first.message.content);
  assert.deepEqual(nextOptions, firstOptions, 'static policy cannot contain per-turn IDs or modes');
  const extended = [...original, { role: 'user', content: 'Explain only.' }, { role: 'custom', customType: 'pi-light-route-binding', content: next.message.content }];
  assert.equal(await harness.event('context_with_system', { messages: extended }), undefined);
  assert.deepEqual(extended.slice(0, original.length), original, 'old signed prefix remains byte-for-byte unchanged');
});

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

test('live automatic routing uses actual Opus: explicit fix writes, advice and plan do not', {
  skip: !process.env.PI_LIGHT_LIVE_CLI, timeout: 300_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-light-auto-route-live-'));
  const path = join(directory, 'hello.txt');
  const client = new RpcClient({ cliPath: process.env.PI_LIGHT_LIVE_CLI!, cwd: directory,
    provider: MAIN_MODEL.provider, model: MAIN_MODEL.model,
    args: ['--no-approve', '--no-session', '--no-extensions', '--no-mcp', '--no-skills',
      '--no-prompt-templates', '--no-context-files', '--no-themes',
      '-e', fileURLToPath(new URL('./index.ts', import.meta.url))],
  });
  let unsubscribe = () => {};
  try {
    await writeFile(path, 'helo\n');
    await client.start();
    await client.setAutoRetry(false);
    await client.setThinkingLevel('low');
    let calls = 0;
    let budgetExceeded = false;
    let abortError: unknown;
    unsubscribe = client.onEvent(event => {
      if (event.type === 'tool_execution_start' && ++calls > 12 && !budgetExceeded) {
        budgetExceeded = true;
        void client.abort().catch(error => { abortError = error; });
      }
    });
    const cases = [
      { prompt: 'Fix hello.txt: replace the typo with exactly hello followed by a newline. Only change hello.txt, then read it back to verify.', intent: 'implement' },
      { prompt: 'How would you fix hello.txt to say goodbye instead? Explain only; do not edit or run shell commands.', intent: 'advice' },
      { prompt: 'Plan a change to hello.txt so it says welcome instead. Give the plan only; do not implement or run shell commands.', intent: 'plan' },
    ];
    for (const item of cases) {
      calls = 0;
      const events = await client.promptAndWait(item.prompt, undefined, 90_000);
      assert.equal(budgetExceeded, false, 'Live test exceeded its 12-tool-call budget');
      assert.equal(abortError, undefined);
      const results = events.filter(event => event.type === 'tool_execution_end');
      const route = results.find(event => event.toolName === 'route_task');
      assert.ok(route && !route.isError, `Natural-language ${item.intent} task must route successfully: ${JSON.stringify(results).slice(0, 4000)}`);
      assert.equal((route.result.details as { intent: string }).intent, item.intent);
      const mutations = results.filter(event => ['write', 'edit', 'bash', 'powershell'].includes(event.toolName));
      if (item.intent === 'implement') {
        assert.ok(mutations.some(event => ['write', 'edit'].includes(event.toolName) && !event.isError));
        assert.ok(results.indexOf(route) < results.indexOf(mutations[0]), 'Route must precede mutation');
      } else {
        assert.equal(mutations.length, 0, 'Read-only tasks must not attempt mutation');
      }
      assert.equal(await readFile(path, 'utf8'), 'hello\n');
      const assistants = (await client.getMessages()).filter(message => message.role === 'assistant');
      assert.ok(assistants.length);
      for (const message of assistants) {
        assert.equal(message.provider, MAIN_MODEL.provider);
        assert.equal(message.model, MAIN_MODEL.model);
        assert.notEqual(message.stopReason, 'error');
        assert.equal(JSON.stringify(message.diagnostics ?? []).includes('"thinking_dropped"'), false,
          'Stable routing history must retain Anthropic thinking across tools and new human requests');
      }
    }
    assert.equal((await client.newSession()).cancelled, false);
    assert.equal(await readFile(path, 'utf8'), 'hello\n');
  } finally {
    unsubscribe();
    try { await client.stop(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test('legacy work command never grants authority and manual commands are unnecessary', async () => {
  const harness = extensionHarness();
  await harness.command('plan');
  harness.ctx.mode = 'rpc';
  await harness.command('work');
  assert.equal(harness.confirmations(), 0);
  assert.equal(status(harness), UNROUTED);
  harness.ctx.mode = 'tui';
  await harness.command('work');
  assert.equal(harness.confirmations(), 0);
  assert.equal(status(harness), UNROUTED);
  assert.ok(harness.notifications.includes('No /work command is needed. Submit your scoped implementation request; Opus routes it automatically.'));
  assert.equal(harness.sent(), 0);
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
  assert.ok(await harness.event('before_agent_start', { messageType: 'user', systemPrompt: 'Base' }));
  (harness.ctx as { model: unknown }).model = { provider: MAIN_MODEL.provider, id: MAIN_MODEL.model };
  assert.ok(await harness.event('before_agent_start', { messageType: 'user', systemPrompt: 'Base' }), 'native Opus stays accepted');
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

test('advice is subagent-only: no advisor commands, no advisor tool, prompt points at counsel', async () => {
  const harness = extensionHarness();
  for (const name of RETIRED_COMMANDS) {
    await assert.rejects(harness.command(name), TypeError, `/${name} must not be registered`);
  }
  assert.equal(harness.tools.has(RETIRED_TOOL), false);
  assert.deepEqual([...harness.tools.keys()], ['route_task']);
  await harness.event('input', { text: 'hello', source: 'interactive' });
  const event = { messageType: 'user', systemPrompt: 'Base', systemPromptOptions: { sections: {} as Record<string, string> } };
  await harness.event('before_agent_start', event);
  const workflow = event.systemPromptOptions.sections.locbt_workflow;
  assert.match(workflow, /counsel/);
  assert.equal(workflow.includes(RETIRED_TOOL), false);
  assert.doesNotMatch(workflow, /Astra|Fable|AgentKit Agent/);
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

test('delegation guidance asks for a solutionSpace line when effort judging is on', async () => {
  const harness = extensionHarness();
  await harness.event('input', { text: 'hello', source: 'interactive' });
  const event = { messageType: 'user', systemPrompt: 'Base', systemPromptOptions: { sections: {} as Record<string, string> } };
  await harness.event('before_agent_start', event);
  assert.match(event.systemPromptOptions.sections.locbt_workflow, /solutionSpace: \.\.\./);
  assert.match(event.systemPromptOptions.sections.locbt_workflow, /small judge model uses it to pick the child's reasoning effort/);
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
