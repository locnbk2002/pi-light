import type { AgentBeforeSettleEvent, AgentBeforeSettleEventResult, ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { providerErrorSummary } from '../../lib/redact.ts';
import { isHerdrSubagentChild, isOneShotInvocation } from '../../lib/run-mode.ts';
import { queryAgentDirs } from '../../lib/agent-dirs-events.ts';
import { loadAgentDefaults } from '../subagents/src/agents.ts';
import { isProjectExplicitlyTrusted } from '../../lib/project-trust.ts';
import { answerInputPreflightQueries, answerModelsQueries, inputPreflight } from './routing-events.ts';
import { EFFORT_INSTRUCTION, EFFORT_SECTION, judgeEffort, judgeInput, registryJudgeCall, type JudgeResult } from './effort-judge.ts';
import { innerExplicitLevel, planSubagentEffort, type SubagentEffortPlan } from './subagent-effort.ts';
import { Cooldowns, isLimitOrCapacityError, loadModelChains, modelConfigPath, modelFamily, planCandidates, reviewerModel, routeController, sessionChain, splitModel,
  VIRTUAL_CONTROLLER, type ControllerRouteDecision, type ModelConfig } from './model-fallback.ts';
import { ACCOUNT_PROVIDER, accountFailureKind, accountsDir, BRIDGE_PROVIDER, ClaudeAccountRouter, safeToReplay } from './claude-account-routing.ts';

type ModelLike = { provider: string; id: string } | undefined;
const modelRef = (model: ModelLike) => model ? `${model.provider}/${model.id}` : undefined;
const isVirtualController = (model: ModelLike) => model?.provider === VIRTUAL_CONTROLLER.provider && model.id === VIRTUAL_CONTROLLER.id;
const isModelRef = (model: ModelLike, ref: string) => !!model && `${model.provider}/${model.id}` === ref;

/** Retired custom message types, hidden from controller context so old sessions stay clean. */
const RETIRED_MESSAGES = new Set(['pi-light-advisor', 'pi-light-consult']);

/** Candidate is usable when it is in the catalog and its provider is configured (no secret is read). */
function modelAvailable(ctx: ExtensionContext, model: string): boolean {
  try {
    const { provider, id } = splitModel(model);
    const found = ctx.modelRegistry.find(provider, id);
    return !!found && ctx.modelRegistry.hasConfiguredAuth(found);
  } catch { return false; }
}

export function hasModelFlag(argv = process.argv.slice(2)): boolean {
  const end = argv.indexOf('--');
  return (end < 0 ? argv : argv.slice(0, end)).some(arg => arg === '--model' || arg.startsWith('--model='));
}

// Worded without retry or limit keywords: Pi must not auto-retry it and the classifiers must not match it.
const NO_ACCOUNT = 'no Claude account is available (each is blocked, rejected or holding its 10% reserve)';

function registerControllerModel(pi: ExtensionAPI, controllerChain: () => readonly string[], cooldowns: Cooldowns,
  onRoute?: (ctx: ExtensionContext, decision: ControllerRouteDecision) => void, accounts?: ClaudeAccountRouter): void {
  pi.registerVirtualModel({
    provider: VIRTUAL_CONTROLLER.provider, id: VIRTUAL_CONTROLLER.id, name: VIRTUAL_CONTROLLER.name,
    thinkingLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    async route(request, ctx) {
      const chain = controllerChain();
      const failed = request.failed && { model: modelRef(request.failed.model)!,
        stopReason: request.failed.message.stopReason, errorMessage: request.failed.message.errorMessage };
      const isAvailable = (model: string) => modelAvailable(ctx, model);
      const decide = () => routeController({ reason: request.reason, previous: modelRef(request.previous?.model), failed },
        chain, cooldowns, isAvailable, providerErrorSummary);
      const isClaude = (model: string) => splitModel(model).provider === BRIDGE_PROVIDER;
      const managed = !!accounts?.serving;
      // A retry that moves to another account or model replays the failed attempt; refuse it when that
      // attempt already showed text or asked for a tool (the error ends the run, the next prompt moves on).
      const unsafeRetry = request.reason === 'retry' && !!request.failed && !safeToReplay(request.failed.message);
      const refuseReplay = (next: string) => {
        throw new Error(`The controller stopped: ${failed?.model ?? 'the model'} failed after this request had already produced output, so it is not repeated. Your next prompt uses ${next}.`);
      };
      let decision: ControllerRouteDecision | undefined;
      let account: string | undefined;
      if (managed) {
        // A failed Claude request moves to another Claude account before the chain moves to another model.
        const kind = request.reason === 'retry' && failed && isClaude(failed.model)
          ? accountFailureKind(failed.stopReason, failed.errorMessage) : undefined;
        if (kind) {
          const result = await accounts!.failover(kind, failed!.errorMessage);
          if (result.next) {
            account = result.next;
            decision = { model: failed!.model };
            ctx.ui.notify(`Claude account ${result.failed} ${kind === 'limit' ? 'hit its usage limit' : 'login was rejected'}. Retrying on account ${result.next}.`, 'warning');
          }
        }
        decision ??= decide();
        if (!account && isClaude(decision.model)) {
          account = await accounts!.pick(request.reason === 'user' || request.reason === 'retry');
          if (!account) {
            // No managed account: never let Claude run on the bridge's own login. Route among the other models.
            const others = chain.filter(model => !isClaude(model));
            if (!others.length) throw new Error(`The controller stopped: ${NO_ACCOUNT}, and the controller list has no non-Claude model.`);
            const claude = decision.model;
            const fallback = routeController({ reason: request.reason === 'retry' ? 'user' : request.reason, previous: modelRef(request.previous?.model) },
              others, cooldowns, isAvailable, providerErrorSummary);
            decision = request.reason === 'continuation' ? fallback : { ...fallback, cooled: { model: claude, reason: NO_ACCOUNT } };
          }
        }
      }
      decision ??= decide();
      if (unsafeRetry) {
        // Compare the whole identity: the model and, for managed Claude, the account and its token. An
        // ordinary pick (for example, the account entered its reserve) also moves the request.
        const before = managed && isClaude(failed!.model) ? accounts!.streamedIdentity : undefined;
        const after = account ? accounts!.identity(account) : undefined;
        if (decision.model !== failed!.model) refuseReplay(decision.model);
        if (before?.name !== after?.name || before?.fingerprint !== after?.fingerprint) refuseReplay(`Claude account ${after?.name ?? 'none'}`);
      }
      const { provider, id } = splitModel(decision.model);
      // While rotation serves accounts, Claude runs only through the account wrapper with the chosen token.
      const model = managed && provider === BRIDGE_PROVIDER ? ctx.modelRegistry.find(ACCOUNT_PROVIDER, id) : ctx.modelRegistry.find(provider, id);
      if (!model) throw new Error(`Controller model ${managed && provider === BRIDGE_PROVIDER ? `${ACCOUNT_PROVIDER}/${id}` : decision.model} is not in the model catalog.`);
      // Sticky routes keep the level that model already used (prompt cache and thinking signatures).
      const sticky = decision.model === failed?.model ? request.failed?.thinkingLevel
        : decision.model === modelRef(request.previous?.model) ? request.previous?.thinkingLevel : undefined;
      if (request.reason !== 'direct') onRoute?.(ctx, decision);
      return { model, thinkingLevel: sticky ?? request.thinkingLevel };
    },
  });
}

/**
 * Failover when a controller run ends with an error Pi did not retry (Pi does not auto-retry quota and
 * usage-limit errors, and its retries may be off or used up). Another Claude account comes first, then
 * the next model. The failed trailing attempt is omitted, exactly as Pi's own retry does, and the run
 * continues once per candidate, but only if that attempt showed no text and called no tool.
 * Shared by the main controller and by herdr/one-shot children.
 */
function createSettleFailover(controllerChain: () => readonly string[], cooldowns: Cooldowns, accounts?: ClaudeAccountRouter) {
  let fallbackContinuations = 0;
  let accountContinuations = 0;
  return {
    reset(): void { fallbackContinuations = 0; accountContinuations = 0; },
    async beforeSettle(event: AgentBeforeSettleEvent, ctx: ExtensionContext): Promise<AgentBeforeSettleEventResult | undefined> {
      if (event.outcome !== 'error' || !isVirtualController(ctx.model)) return;
      const chain = controllerChain();
      const entries = event.context.contextEntries;
      let index = entries.length - 1;
      for (; index >= 0; index--) if (entries[index].messages.some(message => message.role === 'assistant')) break;
      const failed = index < 0 ? undefined : entries[index].messages.findLast(message => message.role === 'assistant');
      if (failed?.role !== 'assistant') return;
      const omitFailedAttempt = () => {
        const callIds = new Set(failed.content.flatMap(block => block.type === 'toolCall' ? [block.id] : []));
        const targets = [entries[index], ...entries.slice(index + 1).filter(entry =>
          entry.messages.some(message => message.role === 'toolResult' && callIds.has(message.toolCallId)))];
        return { entries: [...event.entries, ...targets.map(entry => ({ type: 'context_edit' as const, targetId: entry.sourceEntry.id, replacement: null }))],
          continue: true };
      };
      // Claude account failover comes first: another account of the same model before another model.
      const accountKind = accounts?.serving && failed.provider === BRIDGE_PROVIDER ? accountFailureKind(failed.stopReason, failed.errorMessage) : undefined;
      if (accounts && accountKind) {
        const result = await accounts.failover(accountKind, failed.errorMessage);
        const what = accountKind === 'limit' ? 'hit its usage limit' : 'login was rejected';
        if (result.next) {
          if (!safeToReplay(failed)) {
            ctx.ui.notify(`Claude account ${result.failed} ${what} after this request had already produced output, so it is not replayed. Your next prompt uses account ${result.next}.`, 'warning');
            return;
          }
          if (accountContinuations >= accounts.count) return;
          accountContinuations++;
          ctx.ui.notify(`Claude account ${result.failed} ${what}. Continuing this request on account ${result.next}.`, 'warning');
          return omitFailedAttempt();
        }
        if (accountKind === 'auth') {
          ctx.ui.notify(`Claude account ${result.failed ?? ''} login was rejected and no other Claude account is available. Add a new token with the claude-accounts command.`, 'warning');
        }
        // No account left (usage limits or rejected logins): the model fallback below takes over.
      }
      // Every managed account is limited or rejected: the route skips Claude by itself while no account is
      // usable, and cooling the Claude model would also hide an account that unblocks sooner. Other limit or
      // capacity failures (overload) are not about the account, so the Claude model cools as usual.
      const accountsExhausted = !!accountKind;
      if (!accountsExhausted && !isLimitOrCapacityError(failed.stopReason, failed.errorMessage)) return;
      const model = `${failed.provider}/${failed.model}`;
      const reason = accountKind === 'auth' ? 'no Claude account login is accepted' : providerErrorSummary(failed.errorMessage);
      if (chain.includes(model) && !accountsExhausted) cooldowns.mark(model, reason);
      const candidates = accountsExhausted ? chain.filter(item => splitModel(item).provider !== BRIDGE_PROVIDER) : chain;
      const plan = planCandidates(candidates, cooldowns, candidate => modelAvailable(ctx, candidate));
      if (plan.exhausted || fallbackContinuations >= chain.length) {
        ctx.ui.notify(`Controller ${model} has no capacity (${reason}). No fallback model is left: ${plan.skipped.join('; ') || 'none configured'}. Your next prompt retries the soonest available model.`, 'error');
        return;
      }
      if (!safeToReplay(failed)) {
        // Never replay an attempt that already showed text or asked for a tool; the next prompt starts on the fallback.
        ctx.ui.notify(`Controller ${model} has no capacity (${reason}) after this request had already produced output, so it is not replayed. Your next prompt uses ${plan.order[0]}.`, 'warning');
        return;
      }
      fallbackContinuations++;
      ctx.ui.notify(`Controller ${model} has no capacity (${reason}). Continuing this request on ${plan.order[0]}.`, 'warning');
      return omitFailedAttempt();
    },
  };
}

function createAccounts(config: ModelConfig): ClaudeAccountRouter | undefined {
  return config.claudeAccounts.enabled ? new ClaudeAccountRouter(accountsDir(getAgentDir())) : undefined;
}

/**
 * Bind account rotation to this session and install the wrapper provider for the controller's Claude
 * models. Returns a notice when rotation cannot run (the bridge then uses its own login).
 */
function installAccounts(pi: ExtensionAPI, accounts: ClaudeAccountRouter, chain: readonly string[], ctx: ExtensionContext): string | undefined {
  accounts.startSession(ctx.sessionManager.getSessionId(), ctx.modelRegistry);
  accounts.notify = (text, level) => ctx.ui.notify(text, level);
  accounts.status = text => ctx.ui.setStatus('pi-light-claude-account', text);
  const problems = accounts.reload();
  const invalid = problems.length ? ` Invalid account files: ${problems.join('; ')}.` : '';
  accounts.serving = false;
  if (!accounts.active) return `Claude account rotation is on, but ${accounts.dir} has no usable account; the bridge uses its own login.${invalid}`;
  const ids = chain.filter(model => splitModel(model).provider === BRIDGE_PROVIDER).map(model => splitModel(model).id);
  const config = accounts.providerConfig(ids);
  if (!config) return 'Claude account rotation is on, but no claude-bridge controller model is loaded; the bridge uses its own login.';
  pi.registerProvider(ACCOUNT_PROVIDER, config);
  accounts.serving = true;
  accounts.status(`claude accounts: ${accounts.names.join(', ')}`);
  return invalid ? invalid.trim() : undefined;
}

export default function piLight(pi: ExtensionAPI): void {
  const herdrChild = isHerdrSubagentChild();
  if (isOneShotInvocation() || herdrChild) {
    // One-shot children (-p jobs, headless subagents) and herdr subagent panes keep their own policy and
    // requested model. They only need the virtual controller model to resolve (with account rotation
    // when enabled); nothing else is installed.
    const config = loadModelChains();
    const childAccounts = createAccounts(config);
    const childCooldowns = new Cooldowns();
    registerControllerModel(pi, () => config.chains.controller, childCooldowns, undefined, childAccounts);
    // Children get the same settle-time failover (accounts, then models) as the main controller.
    const childFailover = createSettleFailover(() => config.chains.controller, childCooldowns, childAccounts);
    pi.on('agent_before_settle', (event, ctx) => childFailover.beforeSettle(event, ctx));
    pi.on('agent_settled', () => childFailover.reset());
    if (childAccounts || herdrChild) {
      pi.on('session_start', async (_event, ctx) => {
        if (childAccounts) {
          const notice = installAccounts(pi, childAccounts, config.chains.controller, ctx);
          if (notice) ctx.ui.notify(notice, 'warning');
        }
        if (!herdrChild) return;
        // `--model <base>:<explicit>:<agentdef>`: Pi applied the outer level; the explicit one wins.
        const explicit = innerExplicitLevel(process.argv.slice(2));
        if (explicit) pi.setThinkingLevel(explicit as Parameters<ExtensionAPI['setThinkingLevel']>[0]);
        // A herdr child without an explicit --model (user request or agent def) runs on the controller chain.
        if (hasModelFlag() || isVirtualController(ctx.model)) return;
        const virtual = ctx.modelRegistry.find(VIRTUAL_CONTROLLER.provider, VIRTUAL_CONTROLLER.id);
        if (!virtual || !await pi.setModel(virtual)) ctx.ui.notify('Controller fallback model unavailable; subagent keeps the default model.', 'warning');
      });
    }
    return;
  }
  // Fallback lists load once per Pi run; an invalid override is reported once at session start.
  const models = loadModelChains();
  let modelNotice = models.error;
  let effortNotice = models.effortError;
  let accountsNotice = models.claudeAccountsError;
  const accounts = createAccounts(models);
  // Judge-model cooldowns are kept apart from controller cooldowns.
  const judgeCooldowns = new Cooldowns();
  const cooldowns = new Cooldowns();
  let controllerModel: string | undefined;
  // A concrete model picked with /model (or Ctrl+P) for this session only; it leads the controller list.
  let sessionPick: string | undefined;
  // Set while pi-light itself selects a model, so its own model_select events are not taken as picks.
  let selfSelecting = false;
  const controllerChain = () => sessionChain(models.chains.controller, sessionPick);
  let nativeFallbackWarned = false;
  const failover = createSettleFailover(controllerChain, cooldowns, accounts);
  async function selectModel(model: Parameters<ExtensionAPI['setModel']>[0]): Promise<boolean> {
    selfSelecting = true;
    try { return await pi.setModel(model); } finally { selfSelecting = false; }
  }

  const available = modelAvailable;
  function showControllerModel(ctx: ExtensionContext, model: string): void {
    controllerModel = model;
    const preferred = controllerChain()[0];
    ctx.ui.setStatus('pi-light-model', model !== preferred ? `controller fallback: ${model} (${preferred} limited or unavailable)`
      : sessionPick ? `controller: ${model} (picked for this session)` : undefined);
  }
  function noteControllerRoute(ctx: ExtensionContext, decision: ControllerRouteDecision): void {
    if (decision.cooled && decision.cooled.model !== decision.model) {
      ctx.ui.notify(`Controller ${decision.cooled.model} hit a provider limit (${decision.cooled.reason}). Retrying on ${decision.model}.`, 'warning');
    }
    showControllerModel(ctx, decision.model);
  }
  // Model facts for an optional routing workflow (pi-light-kit): the implementing model and its
  // other-family reviewer.
  answerModelsQueries(pi.events, ctx => {
    const implementer = controllerModel ?? models.chains.controller[0];
    const reviewer = reviewerModel(models.chains, implementer, model => ctx ? available(ctx, model) : true);
    return { controllerModel: implementer, controllerFamily: modelFamily(implementer), ...(reviewer ? { reviewerModel: reviewer } : {}) };
  });
  answerInputPreflightQueries(pi.events);
  async function ensureController(ctx: ExtensionContext): Promise<boolean> {
    if (isVirtualController(ctx.model)) return true;
    const virtual = ctx.modelRegistry.find(VIRTUAL_CONTROLLER.provider, VIRTUAL_CONTROLLER.id);
    if (virtual && await selectModel(virtual)) return true;
    // The preferred controller (first entry of this session's list; provider renames applied) still works
    // natively without the virtual model, but without fallback.
    const preferred = controllerChain()[0];
    if (!nativeFallbackWarned) {
      nativeFallbackWarned = true;
      ctx.ui.notify(`Controller fallback model is unavailable; using ${preferred} without provider-limit fallback.`, 'warning');
    }
    if (isModelRef(ctx.model, preferred)) return true;
    const { provider, id } = splitModel(preferred);
    const model = ctx.modelRegistry.find(provider, id);
    if (!model || !await selectModel(model)) {
      ctx.ui.notify(`Controller ${preferred} is unavailable. No controller prompt will be sent.`, 'error');
      return false;
    }
    return true;
  }
  // Controller fallback: one selectable model that routes each request along the controller list.
  registerControllerModel(pi, controllerChain, cooldowns, (ctx, decision) => noteControllerRoute(ctx, decision), accounts);
  // A model picked with /model or Ctrl+P leads the controller list for this session; the next prompt
  // switches back to the virtual controller so provider-limit fallback stays on. Picking the virtual
  // controller itself restores the configured order. Nothing is saved.
  pi.on('model_select', (event, ctx) => {
    if (selfSelecting) return;
    const picked = modelRef(event.model)!;
    sessionPick = isVirtualController(event.model) || picked === models.chains.controller[0] ? undefined : picked;
    if (accounts?.serving && sessionPick) {
      const notice = installAccounts(pi, accounts, controllerChain(), ctx);
      if (notice) ctx.ui.notify(notice, 'warning');
    }
    showControllerModel(ctx, controllerChain()[0]);
  });
  pi.registerCommand('claude-accounts', {
    description: 'Claude account rotation status (no secrets); "reload" re-reads the account files',
    handler: async (args, ctx) => {
      if (!accounts) {
        ctx.ui.notify(`Claude account rotation is off. Turn it on with "claudeAccounts": { "enabled": true } in ${modelConfigPath()}, then restart Pi.`, 'info');
        return;
      }
      if (args.trim() && args.trim() !== 'reload') { ctx.ui.notify('Usage: /claude-accounts [reload]', 'warning'); return; }
      const notice = args.trim() === 'reload' ? installAccounts(pi, accounts, models.chains.controller, ctx) : undefined;
      ctx.ui.notify([...accounts.describe(), ...(notice ? [notice] : [])].join('\n'), notice ? 'warning' : 'info');
    },
  });
  pi.on('context_with_system', event => {
    // Preserve Pi's native prompt/tool patches and every historical binding.
    // Retired advisor and consultation messages in old sessions never enter controller context.
    const messages = event.messages.filter(message => message.role !== 'custom' || !RETIRED_MESSAGES.has(message.customType));
    return messages.length === event.messages.length ? undefined : { messages };
  });

  pi.on('input', async (event, ctx) => {
    // Every prompt runs on the controller; when it cannot be selected the input is not sent. Each
    // input is announced before the asynchronous selection and again with its outcome, because a
    // routing workflow loaded later never sees an input this handler drops.
    const preflight = inputPreflight(pi.events, { text: event.text, source: event.source, streamingBehavior: event.streamingBehavior, ctx });
    preflight.received();
    try {
      if (!await ensureController(ctx)) {
        preflight.handled();
        return { action: 'handled' };
      }
    } catch {
      preflight.handled();
      ctx.ui.notify('Could not select the controller model. Input was not sent.', 'error');
      return { action: 'handled' };
    }
    preflight.accepted();
    return { action: 'continue' };
  });
  // Subagent effort. Pi preflights sibling tool calls one at a time, so every `subagent` call of an
  // assistant message is judged concurrently when the message ends. Only the judgment is cached, keyed
  // by the text it read: precedence is decided again in tool_call from the call's current arguments,
  // because earlier tool_call handlers may have changed them.
  const pendingJudgments = new Map<string, { input: string; judged: Promise<JudgeResult> }>();
  function subagentPlan(input: Record<string, unknown>, ctx: ExtensionContext): SubagentEffortPlan {
    const agent = typeof input.agent === 'string' && input.agent.trim() ? input.agent.trim() : undefined;
    // The launch resolver itself (same sources, precedence and trust gate), so an untrusted
    // project definition can never become the child's model through the effort path.
    const defs = agent ? loadAgentDefaults(agent, { projectTrusted: isProjectExplicitlyTrusted(ctx), extraDirs: queryAgentDirs(pi.events) }) : null;
    return planSubagentEffort(input, defs ?? undefined);
  }
  function startJudgment(input: string, ctx: ExtensionContext): Promise<JudgeResult> {
    const judged = judgeEffort({ input, settings: models.effort, call: registryJudgeCall(ctx.modelRegistry),
      cooldowns: judgeCooldowns, isAvailable: model => available(ctx, model), signal: ctx.signal, redact: providerErrorSummary });
    judged.catch(() => {}); // a cancelled judgment is handled where it is awaited
    return judged;
  }
  const taskOf = (input: Record<string, unknown>) => judgeInput(typeof input.task === 'string' ? input.task : '');
  pi.on('message_end', (event, ctx) => {
    const message = event.message;
    if (message.role !== 'assistant' || !models.effort.enabled) return;
    for (const block of message.content) {
      if (block.type !== 'toolCall' || block.name !== 'subagent' || subagentPlan(block.arguments, ctx).action !== 'judge') continue;
      const input = taskOf(block.arguments);
      pendingJudgments.set(block.id, { input, judged: startJudgment(input, ctx) });
    }
  });
  async function applySubagentEffort(toolCallId: string, input: Record<string, unknown>, ctx: ExtensionContext): Promise<void> {
    const cached = pendingJudgments.get(toolCallId);
    pendingJudgments.delete(toolCallId);
    // Precedence repairs (explicit suffix, agent-definition thinking) apply even with the judge off.
    const plan = subagentPlan(input, ctx);
    const name = typeof input.name === 'string' ? input.name.slice(0, 60) : 'subagent';
    if (plan.action === 'set-model') input.model = plan.model;
    if (plan.action !== 'judge') {
      if (models.effort.enabled) ctx.ui.notify(`subagent ${name}: effort from ${plan.source === 'explicit' ? 'the model suffix' : 'the agent definition'}`, 'info');
      return;
    }
    if (!models.effort.enabled) return;
    // Reuse the pre-judgment only if the call still asks the judge the same thing; otherwise judge inline.
    const task = taskOf(input);
    const judged = cached?.input === task ? cached.judged : startJudgment(task, ctx);
    let result: JudgeResult;
    try { result = await judged; } catch { return; } // cancelled: the call is being aborted anyway
    input.model = `${plan.base}:${result.requested}`;
    const detail = result.judgeModel ? ` ${result.judgeModel}` : result.reason ? `: ${result.reason}` : '';
    ctx.ui.notify(`subagent ${name}: effort ${result.requested} (${result.source}${detail}, ${(result.ms / 1000).toFixed(1)}s)`,
      result.source === 'fallback' ? 'warning' : 'info');
  }
  pi.on('tool_call', async (event, ctx) => {
    if (event.toolName === 'subagent') await applySubagentEffort(event.toolCallId, event.input as Record<string, unknown>, ctx);
  });
  pi.on('before_agent_start', (event, ctx) => {
    if (!(isVirtualController(ctx.model) || isModelRef(ctx.model, controllerChain()[0]))) {
      ctx.abort();
      throw new Error('Controller run blocked: incorrect main model.');
    }
    // The effort judge's own guidance, with or without a routing workflow.
    if (models.effort.enabled) {
      event.systemPromptOptions.sections ??= {};
      event.systemPromptOptions.sections[EFFORT_SECTION] = EFFORT_INSTRUCTION;
    }
  });
  pi.on('agent_before_settle', (event, ctx) => failover.beforeSettle(event, ctx));
  pi.on('agent_settled', () => {
    failover.reset();
    pendingJudgments.clear();
  });
  pi.on('session_start', async (_event, ctx) => {
    // A pick belongs to one session: a new or resumed session starts on the configured order.
    sessionPick = undefined;
    controllerModel = undefined;
    ctx.ui.setStatus('pi-light-model', undefined);
    if (modelNotice) {
      ctx.ui.notify(modelNotice, 'warning');
      modelNotice = undefined;
    }
    if (effortNotice) {
      ctx.ui.notify(effortNotice, 'warning');
      effortNotice = undefined;
    }
    if (accountsNotice) {
      ctx.ui.notify(accountsNotice, 'warning');
      accountsNotice = undefined;
    }
    if (accounts) {
      const notice = installAccounts(pi, accounts, models.chains.controller, ctx);
      if (notice) ctx.ui.notify(notice, 'warning');
    }
    try { await ensureController(ctx); }
    catch { ctx.ui.notify('The controller model could not be selected; controller prompts will be blocked.', 'error'); }
  });
}
