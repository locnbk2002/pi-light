import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RpcClient, createEventBus, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { queryReadOnly } from '../../lib/read-only-events.ts';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import piLight, { hasModelFlag } from './index.ts';
import { isHerdrSubagentChild, isOneShotInvocation } from '../../lib/run-mode.ts';
import { ADVISORS, MAIN_MODEL, ControllerPolicy, handoffDraft, parseAdvisorArgs, READ_TOOLS } from './controller-policy.ts';
import { DEFAULT_CHAINS, VIRTUAL_CONTROLLER } from './model-fallback.ts';
// package.json lists test files explicitly; run the fallback module's unit tests with this suite.
import './model-fallback.test.ts';

const available = [...READ_TOOLS, 'bash', 'powershell', 'edit', 'write', 'browser_click', 'browser_read', 'mcp__shell', 'codemode', 'browser', 'consult_advisor', 'route_task'];

test('native package leaves one-shot Pi and AgentKit child jobs untouched', () => {
  assert.equal(isOneShotInvocation(['--mode', 'json', '-p', '--no-session']), true);
  assert.equal(isOneShotInvocation(['--print', 'hello']), true);
  assert.equal(isOneShotInvocation(['--mode', 'rpc']), false);
  assert.equal(isOneShotInvocation([]), false);
  assert.equal(isOneShotInvocation(['--', '--print']), false);
});

test('one-shot extension factory registers only the virtual controller model', () => {
  const previous = process.argv;
  try {
    process.argv = [previous[0], previous[1], '--mode', 'json', '-p', '--no-session'];
    const registered: { provider: string; id: string }[] = [];
    const untouched = new Proxy({}, { get(_target, name) {
      if (name === 'registerVirtualModel') return (definition: { provider: string; id: string }) => { registered.push(definition); };
      throw new Error(`One-shot Pi must not access extension API ${String(name)}`);
    } });
    assert.doesNotThrow(() => piLight(untouched as ExtensionAPI));
    assert.deepEqual(registered.map(({ provider, id }) => ({ provider, id })), [{ provider: VIRTUAL_CONTROLLER.provider, id: VIRTUAL_CONTROLLER.id }]);
  } finally { process.argv = previous; }
});

test('herdr subagent panes keep their requested model and default to the controller chain', async () => {
  assert.equal(isHerdrSubagentChild({ PI_SUBAGENT_ID: 'ab12cd34' }), true);
  assert.equal(isHerdrSubagentChild({ PI_SUBAGENT_ID: '' }), false);
  assert.equal(isHerdrSubagentChild({ HERDR_ENV: '1' }), false, 'the orchestrator pane itself is not a child');
  assert.equal(hasModelFlag(['--session', 's.jsonl', '--model', 'openai-codex/gpt-6-astra:high']), true);
  assert.equal(hasModelFlag(['--model=anthropic/claude-fable-5-1']), true);
  assert.equal(hasModelFlag(['--session', 's.jsonl', '@task.md']), false);
  assert.equal(hasModelFlag(['--', '--model', 'x/y']), false);

  const previous = { argv: process.argv, id: process.env.PI_SUBAGENT_ID };
  const run = async (args: string[], current: { provider: string; id: string }) => {
    process.argv = [previous.argv[0], previous.argv[1], ...args];
    const registered: string[] = [];
    const selected: string[] = [];
    const handlers: Record<string, (event: unknown, ctx: unknown) => Promise<void>> = {};
    const api = new Proxy({}, { get(_target, name) {
      if (name === 'registerVirtualModel') return (definition: { provider: string; id: string }) => { registered.push(`${definition.provider}/${definition.id}`); };
      if (name === 'on') return (event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => { handlers[event] = handler; };
      if (name === 'setModel') return async (model: { provider: string; id: string }) => { selected.push(`${model.provider}/${model.id}`); return true; };
      throw new Error(`Herdr child must not access extension API ${String(name)}`);
    } });
    piLight(api as ExtensionAPI);
    const ctx = { model: current, ui: { notify() {} }, modelRegistry: { find: (provider: string, id: string) => ({ provider, id }) } };
    await handlers.session_start?.({}, ctx);
    return { registered, selected, events: Object.keys(handlers) };
  };
  try {
    process.env.PI_SUBAGENT_ID = 'ab12cd34';
    const virtual = `${VIRTUAL_CONTROLLER.provider}/${VIRTUAL_CONTROLLER.id}`;
    const unpinned = await run(['--session', 's.jsonl', '@task.md'], { provider: 'openai-codex', id: 'gpt-6.1-sol' });
    assert.deepEqual(unpinned, { registered: [virtual], selected: [virtual], events: ['session_start'] });
    const pinned = await run(['--session', 's.jsonl', '--model', 'openai-codex/gpt-6-astra', '@task.md'], { provider: 'openai-codex', id: 'gpt-6-astra' });
    assert.deepEqual(pinned, { registered: [virtual], selected: [], events: [] }, 'a requested model is never overridden');
  } finally {
    process.argv = previous.argv;
    if (previous.id === undefined) delete process.env.PI_SUBAGENT_ID; else process.env.PI_SUBAGENT_ID = previous.id;
  }
});

test('controller and Fable use native Anthropic; Astra remains native Codex', () => {
  assert.deepEqual(MAIN_MODEL, { provider: 'anthropic', model: 'claude-opus-5-5' });
  assert.deepEqual(ADVISORS.fable, { provider: 'anthropic', model: 'claude-fable-5-1' });
  assert.deepEqual(ADVISORS.astra, { provider: 'openai-codex', model: 'gpt-6-astra' });
});

test('every mode keeps all tools available; only direct advisor chat pauses them', () => {
  const policy = new ControllerPolicy();
  assert.equal(policy.mode, 'auto');
  for (const mode of ['auto', 'plan', 'brainstorm'] as const) {
    policy.setMode(mode);
    assert.equal(policy.isReadOnly, false);
    assert.deepEqual(policy.activeTools(available), available);
    for (const tool of [...available, 'new_unclassified_tool']) assert.equal(policy.allowsTool(tool), true);
  }
  policy.enter('fable', 'tools');
  assert.equal(policy.isReadOnly, true);
  assert.deepEqual(policy.activeTools(available), []);
  for (const tool of [...available, 'new_unclassified_tool']) assert.equal(policy.allowsTool(tool), false);
});

test('work requires current request routing, not a mode command or advisor chat', () => {
  const policy = new ControllerPolicy();
  assert.throws(() => policy.setMode('work'));
  assert.equal(policy.mode, 'auto');
  policy.captureInput('Implement the API.', 'interactive');
  policy.routeTask({ intent: 'implement', requestId: policy.request!.id, requestQuote: 'Implement the API.', scope: 'API only' });
  assert.equal(policy.allowsTool('write'), true);
  policy.enter('astra', 'api');
  assert.equal(policy.mode, 'plan');
  assert.deepEqual(policy.activeTools(available), []);
  assert.throws(() => policy.setMode('work'));
});

test('cancelled handoff retains mode, session identity, quotes and edited draft', () => {
  const policy = new ControllerPolicy();
  policy.enter('fable', 'review');
  const quote = 'Do NOT change package.json.\nI choose option "A", not B.';
  policy.recordUser(quote);
  const chat = policy.direct!;
  chat.draft = 'Edited draft with my decisions';
  assert.equal(policy.completeHandoff(false), false);
  assert.equal(policy.direct, chat);
  assert.equal(chat.draft, 'Edited draft with my decisions');
  const draft = handoffDraft(chat, 'Advisor suggestions (NOT user decisions)\nTry B.\nPending questions\nNone.\nEvidence\nUnverified.', 'anthropic/claude-fable-5-1');
  assert.ok(draft.includes(JSON.stringify(quote)));
  assert.ok(draft.includes('NOT user decisions'));
  assert.ok(draft.includes('Pending questions'));
  assert.ok(draft.includes('Evidence'));
  assert.equal(policy.completeHandoff(true), true);
  assert.equal(policy.direct, undefined);
  assert.equal(policy.mode, 'plan');
  policy.enter('fable', 'review');
  assert.equal(policy.direct, chat, 're-entering a reusable topic must retain earlier exact user quotations');
  policy.recordUser('A follow-up');
  assert.equal(chat.draft, undefined);
  assert.deepEqual(chat.userQuotes, [quote, 'A follow-up']);
});

test('advisor selection is explicit and topics are bounded', () => {
  assert.deepEqual(parseAdvisorArgs('astra performance review'), { advisor: 'astra', topic: 'performance review' });
  assert.deepEqual(parseAdvisorArgs('fable'), { advisor: 'fable', topic: 'default' });
  for (const input of ['', 'opus', 'auto topic', `astra ${'x'.repeat(121)}`]) assert.throws(() => parseAdvisorArgs(input));
  const policy = new ControllerPolicy();
  policy.enter('astra', 'default');
  assert.throws(() => policy.enter('fable', 'other'));
  assert.throws(() => policy.recordUser(' '));
});

function extensionHarness() {
  const commands = new Map<string, Parameters<ExtensionAPI['registerCommand']>[1]>();
  const tools = new Map<string, Parameters<ExtensionAPI['registerTool']>[0]>();
  const events = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const renderers = new Map<string, Parameters<ExtensionAPI['registerMessageRenderer']>[1]>();
  let activeTools: string[] = [];
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
  const ctx = {
    mode: 'tui', hasUI: true, model: { provider: VIRTUAL_CONTROLLER.provider, id: VIRTUAL_CONTROLLER.id }, cwd: '/tmp', isIdle: () => true, hasPendingMessages: () => false,
    modelRegistry: {
      find: (provider: string, id: string) => ({ provider, id }),
      hasConfiguredAuth: (model: { provider: string; id: string }) => !unavailable.has(`${model.provider}/${model.id}`),
    },
    ui: { notify(text: string) { notifications.push(text); }, setStatus(key: string, text: string | undefined) { statuses.set(key, text); }, setWidget() {},
      async confirm() { confirmations++; return false; } },
  } as unknown as ExtensionContext;
  piLight(pi);
  return {
    ctx, bus, notifications, statuses, selected, unavailable, virtualModel: () => virtualModel!,
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

test('feature extensions read direct advisor chat as read-only over the shared event bus', async () => {
  const harness = extensionHarness();
  assert.equal(queryReadOnly(harness.bus), false, 'controller mode is not read-only');
  await harness.command('advisor', 'astra');
  assert.equal(queryReadOnly(harness.bus), true, 'direct advisor chat is read-only');
});
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
    assert.equal(await harness.event('tool_call', { toolName: 'consult_advisor' }), undefined);
    assert.ok(harness.tools.has('consult_advisor'));
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

test('routes are stage guidance: tools stay active unless direct advisor chat pauses them', async () => {
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
  await harness.command('advisor', 'astra paused-tools');
  assert.deepEqual(harness.active(), []);
  assert.match(status(harness)!, /^advisor astra \| paused-tools/);
  for (const name of [...available, 'new_unclassified_tool']) {
    assert.deepEqual(await harness.event('tool_call', { toolName: name, input: {} }), {
      block: true, reason: 'Controller tools are paused during direct advisor chat. Use /back first.',
    }, name);
  }
  await assert.rejects(harness.event('user_bash', { command: 'touch /tmp/should-not-run' }), /Shell is paused during direct advisor chat/);
  await assert.rejects(harness.route(route), /missing or stale/);
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

test('extension input, custom handoffs, and session boundaries never promote work', async () => {
  for (const boundary of ['extension', 'handoff', 'session_start', 'session_shutdown', 'session_tree']) {
    const harness = extensionHarness();
    const route = await currentRoute(harness, 'Implement hello.txt.');
    await harness.route(route);
    if (boundary === 'extension') {
      await harness.event('input', { source: 'extension', text: 'Implement hello.txt.' });
    } else if (boundary === 'handoff') {
      await harness.event('before_agent_start', { messageType: 'custom', systemPrompt: 'Base',
        message: { customType: 'pi-light-handoff', content: 'Approved: implement hello.txt' } });
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
  assert.match(workflow, /consult_advisor conversation with astra/);
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

test('real direct-input handler consumes followups and errors without leaking text to Opus', async () => {
  const harness = extensionHarness();
  await harness.command('advisor', 'astra isolated-test');
  assert.deepEqual(harness.active(), []);
  for (const source of ['interactive', 'rpc', 'extension']) {
    // Invalid (empty) text tests the failure path without starting a child or accessing credentials.
    assert.deepEqual(await harness.event('input', { text: '', source }), { action: 'handled' });
  }
  assert.deepEqual(await harness.event('input', { text: 'Look at this', images: [{}], source: 'interactive' }), { action: 'handled' });
  assert.equal(harness.sent(), 0);
  assert.deepEqual(await harness.event('tool_call', { toolName: 'read' }), {
    block: true, reason: 'Controller tools are paused during direct advisor chat. Use /back first.',
  });
});

test('direct messages have a live renderer and are excluded from controller context only', async () => {
  const harness = extensionHarness();
  const direct = { role: 'custom', customType: 'pi-light-advisor', content: 'Private advisor reply' };
  const handoff = { role: 'custom', customType: 'pi-light-handoff', content: 'Approved handoff' };
  const consult = { role: 'custom', customType: 'pi-light-consult', content: 'Requested consultation' };
  const user = { role: 'user', content: 'Controller task' };
  const messages = [user, direct, handoff, consult];
  assert.deepEqual(await harness.event('context_with_system', { messages }), { messages: [user, handoff, consult] });
  assert.equal(messages.length, 4, 'context filtering must not mutate stored transcript');
  const renderer = harness.renderers.get('pi-light-advisor');
  assert.ok(renderer, 'live messages must use registerMessageRenderer, not only a session entry renderer');
  // Partial theme/render options only exercise this renderer, not Pi internals.
  const rendered = renderer({ ...direct, details: { advisor: 'fable', prompt: 'My question', actualModel: 'anthropic/claude-fable-5-1' } } as Parameters<typeof renderer>[0],
    {} as Parameters<typeof renderer>[1], { fg: (_color: string, text: string) => text } as Parameters<typeof renderer>[2]);
  const lines = rendered!.render(120).join('\n');
  for (const text of ['fable [anthropic/claude-fable-5-1]', 'You: My question', 'Private advisor reply']) assert.ok(lines.includes(text));
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

test('live controller selects native Opus and direct chat persists a displayed custom message', {
  skip: !process.env.PI_LIGHT_LIVE_CLI, timeout: 180_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-light-controller-live-'));
  const previousCli = process.env.PI_LIGHT_CLI_PATH;
  process.env.PI_LIGHT_CLI_PATH = process.env.PI_LIGHT_LIVE_CLI;
  const client = new RpcClient({ cliPath: process.env.PI_LIGHT_LIVE_CLI!, cwd: directory,
    provider: MAIN_MODEL.provider, model: MAIN_MODEL.model,
    args: ['--no-approve', '--no-session', '--no-extensions', '--no-mcp', '--no-skills',
      '--no-prompt-templates', '--no-context-files', '--no-themes',
      '-e', fileURLToPath(new URL('./index.ts', import.meta.url))],
  });
  let unsubscribe = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await client.start();
    const state = await client.getState();
    // Selection names the fallback virtual model; the response below names the physical Opus.
    assert.equal(state.model?.provider, VIRTUAL_CONTROLLER.provider);
    assert.equal(state.model?.id, VIRTUAL_CONTROLLER.id);
    const settled = new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Native controller did not settle.')), 90_000);
      unsubscribe = client.onEvent(event => {
        if (event.type === 'agent_settled') resolve();
      });
    });
    await Promise.all([settled, client.prompt('Reply only MAIN-READY. Do not use tools.')]);
    unsubscribe();
    clearTimeout(timer);
    const controllerReply = (await client.getMessages()).find(message => message.role === 'assistant');
    assert.ok(controllerReply && controllerReply.role === 'assistant');
    assert.equal(controllerReply.provider, MAIN_MODEL.provider);
    assert.equal(controllerReply.model, MAIN_MODEL.model);
    assert.notEqual(controllerReply.stopReason, 'error');
    assert.ok(JSON.stringify(controllerReply.content).includes('MAIN-READY'));
    await client.prompt('/advisor fable live-display');
    await client.prompt('Reply only DIRECT-READY. Do not use tools.');
    const messages = await client.getMessages();
    const direct = messages.find(message => message.role === 'custom' && message.customType === 'pi-light-advisor');
    assert.ok(direct && direct.role === 'custom');
    assert.equal(direct.display, true);
    assert.ok(JSON.stringify(direct.content).includes('DIRECT-READY'));
    assert.deepEqual(direct.details, { advisor: 'fable', prompt: 'Reply only DIRECT-READY. Do not use tools.', actualModel: 'anthropic/claude-fable-5-1' });
  } finally {
    clearTimeout(timer);
    unsubscribe();
    try { await client.stop(); }
    finally {
      if (previousCli === undefined) delete process.env.PI_LIGHT_CLI_PATH;
      else process.env.PI_LIGHT_CLI_PATH = previousCli;
      await rm(directory, { recursive: true, force: true });
    }
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
  // Outside direct advisor chat the user's own shell is not intercepted.
  assert.equal(await harness.event('user_bash', { command: 'true' }), undefined);
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

test('advisor renderer shows the fallback model and what it replaced', () => {
  const harness = extensionHarness();
  const renderer = harness.renderers.get('pi-light-advisor')!;
  const rendered = renderer({ role: 'custom', customType: 'pi-light-advisor', content: 'Reply', details: { advisor: 'astra', prompt: 'Q',
    actualModel: SOL_REF, fallbackFrom: ['openai-codex/gpt-6-astra: 429 usage limit'] } } as Parameters<typeof renderer>[0],
  {} as Parameters<typeof renderer>[1], { fg: (_color: string, text: string) => text } as Parameters<typeof renderer>[2]);
  assert.ok(rendered!.render(200).join('\n').includes(`astra [${SOL_REF}, fallback from openai-codex/gpt-6-astra: 429 usage limit]`));
});
