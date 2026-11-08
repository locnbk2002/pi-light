import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { RpcClient, type RpcClientOptions } from '@earendil-works/pi-coding-agent';
import { ADVISORS, READ_TOOLS, advisorName, nonempty, type Advisor } from './controller-policy.ts';
import { Cooldowns, DEFAULT_CHAINS, isLimitOrCapacityError, planCandidates, providerExtension, splitModel, type ModelChains } from './model-fallback.ts';

export function resolvePiCliPath(override = process.env.PI_LIGHT_CLI_PATH, argv1 = process.argv[1] ?? '',
  resolvePi = () => import.meta.resolve('@earendil-works/pi-coding-agent')): string {
  if (override) {
    if (!isAbsolute(override) || !existsSync(override)) throw new Error('Advisor CLI override must be an existing absolute path.');
    return override;
  }
  // Native packages must work without launcher-exported environment variables. A git/npm-installed package
  // has no resolvable copy of Pi (host packages are peers), so fall back to the CLI script running this process.
  const candidates: Array<() => string> = [
    () => join(dirname(fileURLToPath(resolvePi())), 'cli.js'),
    () => realpathSync(argv1),
  ];
  for (const candidate of candidates) {
    try {
      const cli = candidate();
      if (/\.[cm]?js$/.test(cli) && existsSync(cli)) return cli;
    } catch { /* try the next location */ }
  }
  throw new Error('Advisor CLI could not be located; set PI_LIGHT_CLI_PATH to Pi\'s cli.js.');
}

export interface AdvisorReply {
  text: string;
  actualModel: string;
  /** Preferred candidates that did not answer, each 'provider/model: redacted reason'. */
  fallbackFrom?: string[];
}
export interface RpcTransport {
  start(): Promise<void>;
  stop(): Promise<void>;
  prompt(message: string): Promise<string>;
  getState(): Promise<unknown>;
  onEvent(listener: (event: unknown) => void): () => void;
}
export type TransportFactory = (options: RpcClientOptions) => RpcTransport;
interface OwnedSession {
  client: RpcTransport;
  config: RpcClientOptions;
  identity: { directory: string; id: string };
  started: boolean;
  busy: boolean;
  restart: boolean;
  stop?: Promise<void>;
}
interface SessionOptions {
  cliPath: string;
  timeoutMs?: number;
  heartbeatMs?: number;
  maxSessions?: number;
  /** Ordered fallback chains; defaults to the built-in lists. */
  chains?: ModelChains;
  /** Shared per-run cooldowns (also used by the controller router). */
  cooldowns?: Cooldowns;
  /** Extension path providing a model provider (e.g. claude-bridge); defaults to the installed package lookup. */
  providerExtension?: (provider: string) => string | undefined;
}
export interface AskOptions {
  advisor: Advisor;
  topic: string;
  cwd: string;
  prompt: string;
  fresh?: boolean;
  signal?: AbortSignal;
  onProgress?: (text: string) => void;
  /** Whether a candidate's provider has credentials in the parent registry; defaults to all available. */
  isAvailable?: (model: string) => boolean;
}

/** A failed advisor model turn, with a classification but only a redacted reason. */
class AdvisorTurnError extends Error {
  constructor(message: string, readonly limit: boolean, readonly reason: string) { super(message); }
}

/** Display label: the responding model plus any fallback it replaced. */
export function replyModelLabel(reply: Pick<AdvisorReply, 'actualModel' | 'fallbackFrom'>): string {
  return reply.fallbackFrom?.length ? `${reply.actualModel}, fallback from ${reply.fallbackFrom.join('; ')}` : reply.actualModel;
}

export function childOptions(options: SessionOptions, advisor: Advisor | string, cwd: string,
  session: { directory: string; id: string }): RpcClientOptions {
  const model = advisor === 'astra' || advisor === 'fable'
    ? { provider: ADVISORS[advisor].provider, id: ADVISORS[advisor].model } : splitModel(advisor);
  if (!model.provider || !model.id) throw new Error('Advisor model must be provider/model.');
  if (!isAbsolute(options.cliPath) || !/\.[cm]?js$/.test(options.cliPath)) {
    throw new Error('Set absolute PI_LIGHT_CLI_PATH (runnable CLI JavaScript).');
  }
  if (!isAbsolute(cwd)) throw new Error('Advisor working directory must be absolute.');
  if (!isAbsolute(session.directory) || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(session.id)) {
    throw new Error('Advisor session requires a private absolute directory and UUID.');
  }
  // Extensions stay off in advisors; only an extension that provides the advisor's model provider is loaded.
  const extension = (options.providerExtension ?? providerExtension)(model.provider);
  return {
    cliPath: options.cliPath, cwd, provider: model.provider, model: model.id,
    args: ['--no-approve', '--session-dir', session.directory, '--session-id', session.id,
      '--no-extensions', ...(extension ? ['-e', extension] : []), '--no-skills', '--no-prompt-templates', '--no-themes',
      '--no-context-files', '--no-mcp', '--tools', READ_TOOLS.join(','),
      '--system-prompt', 'You are a read-only specialist advisor. Give advice, not authorization. Do not modify files, run shell commands, delegate, or use MCP. Distinguish suggestions, pending questions, and evidence. Honor explicit user constraints.'],
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}
function modelName(value: unknown): string | undefined {
  const item = record(value);
  return typeof item?.provider === 'string' && typeof item.model === 'string' ? `${item.provider}/${item.model}` : undefined;
}
function textContent(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value.map(block => record(block)).filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block!.text as string).join('\n');
}

/** A short, redacted provider reason so failures are diagnosable without echoing credentials. */
export function providerErrorSummary(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return 'no provider reason reported';
  return value.split('\n')[0]
    .replace(/(bearer|token|key|authorization)["':= ]+\S+/gi, '$1 [redacted]')
    .replace(/\b(sk|pk|rk|ak)-[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/[A-Za-z0-9+/_=-]{32,}/g, '[redacted]')
    .slice(0, 200);
}

function untilAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('Advisor cancelled or deadline exceeded.'));
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('Advisor cancelled or deadline exceeded.'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Owns children and private on-disk sessions for this Pi run only.
 * Failed transports are replaced, resuming the same persisted conversation without replay.
 * The one exception is a provider limit/capacity failure: that turn produced no answer, so the
 * same prompt is resent once to the next fallback model on the SAME session id/dir. Pi has
 * already persisted the user message, so the transcript then holds that prompt twice; Pi's
 * provider transform drops the errored assistant turn, so the next model sees two adjacent
 * identical user messages (duplicated tokens, no fabricated answer).
 * Normal shutdown deletes transcripts; cross-run resume is deliberately unsupported.
 */
export class AdvisorSessions {
  private sessions = new Map<string, OwnedSession>();
  private shutdown = new AbortController();
  private closing?: Promise<void>;
  private sessionDirectory?: string;
  private options: SessionOptions;
  private factory: TransportFactory;
  private chains: ModelChains;
  private cooldowns: Cooldowns;
  constructor(options: SessionOptions, factory: TransportFactory = options => new RpcClient(options)) {
    this.options = options;
    this.factory = factory;
    this.chains = options.chains ?? DEFAULT_CHAINS;
    this.cooldowns = options.cooldowns ?? new Cooldowns();
  }

  private stop(session: OwnedSession): Promise<void> {
    // RpcClient.stop sends TERM and escalates to KILL after one second.
    return session.stop ??= session.client.stop().catch(() => {
      throw new Error('Advisor child cleanup failed; check owned Pi processes.');
    });
  }

  async ask(request: AskOptions): Promise<AdvisorReply> {
    if (this.shutdown.signal.aborted) throw new Error('Advisor sessions are closed.');
    const advisor = advisorName(request.advisor);
    const topic = nonempty(request.topic, 'Topic', 160);
    const prompt = nonempty(request.prompt, 'Advisor prompt');
    const chain = this.chains[advisor];
    const plan = planCandidates(chain, this.cooldowns, request.isAvailable ?? (() => true));
    if (!plan.order.length) throw new Error(`Advisor ${advisor} has no usable model: ${plan.skipped.join('; ')}.`);
    const directory = this.sessionDirectory ??= mkdtempSync(join(tmpdir(), 'pi-light-advisors-'));
    const key = JSON.stringify([advisor, topic, request.cwd]);
    let session = request.fresh ? undefined : this.sessions.get(key);
    if (session?.busy) throw new Error('This advisor conversation is busy. Cancel it or wait for completion.');
    if (!session) {
      if (this.sessions.size >= (this.options.maxSessions ?? 6)) throw new Error('Advisor session limit reached. Reuse an existing topic or restart Pi Light.');
      const identity = { directory, id: randomUUID() };
      const config = childOptions(this.options, plan.order[0], request.cwd, identity);
      session = { client: this.factory(config), config, identity, started: false, busy: false, restart: false };
      // Fresh consultations also count toward the limit and shutdown ownership.
      this.sessions.set(request.fresh ? `${key}:${randomUUID()}` : key, session);
    }
    const owned = session;
    owned.busy = true;
    const base = [this.shutdown.signal, ...(request.signal ? [request.signal] : [])];
    // Notes for chain entries that did not answer, in chain order.
    const notes = new Map(plan.skipped.map(note => [note.slice(0, note.indexOf(': ')), note]));
    try {
      // Validate the public CLI entry point without reading credentials or settings.
      const info = await untilAbort(stat(this.options.cliPath), AbortSignal.any(base));
      if (!info.isFile()) throw new Error('Advisor CLI is not a file.');
      for (const model of plan.order) {
        // Each candidate gets its own deadline so a slow failing model cannot starve its fallback.
        const signal = AbortSignal.any([...base, AbortSignal.timeout(this.options.timeoutMs ?? 180_000)]);
        try {
          const reply = await this.attempt(owned, model, prompt, request, signal);
          const fallbackFrom = chain.slice(0, Math.max(0, chain.indexOf(model))).flatMap(item => notes.get(item) ?? []);
          return fallbackFrom.length ? { ...reply, fallbackFrom } : reply;
        } catch (error) {
          if (!(error instanceof AdvisorTurnError) || !error.limit) throw error;
          this.cooldowns.mark(model, error.reason);
          notes.set(model, `${model}: ${error.reason}`);
          // A failed stop must never permit overlapping children for one session.
          owned.restart = true;
          await this.stop(owned);
        }
      }
      throw new Error(`Advisor ${advisor}: every fallback model hit a limit or was unavailable: ${chain.flatMap(item => notes.get(item) ?? []).join('; ')}.`);
    } catch (error) {
      // Never surface RpcClient stderr: provider diagnostics can contain secrets.
      const safe = error instanceof Error && /^(Advisor|Set absolute|Topic|Choose)/.test(error.message)
        && !error.message.includes('Stderr:') ? error.message : 'Advisor transport failed. Check local provider setup.';
      // Keep the session ID even on cancellation/provider failure. Pi resumes its
      // saved branch (including any interrupted user turn); never replay prompts.
      owned.restart = true;
      await this.stop(owned);
      throw new Error(safe);
    } finally {
      owned.busy = false;
      if (request.fresh) {
        await this.stop(owned);
        for (const [id, value] of this.sessions) if (value === owned) this.sessions.delete(id);
      }
    }
  }

  /** One model turn on the owned session, replacing its child first when the model changes. */
  private async attempt(owned: OwnedSession, model: string, prompt: string, request: AskOptions, signal: AbortSignal): Promise<AdvisorReply> {
    const wanted = splitModel(model);
    if (owned.restart || owned.config.provider !== wanted.provider || owned.config.model !== wanted.id) {
      // Same session directory and ID: the replacement resumes the persisted conversation.
      await untilAbort(this.stop(owned), signal);
      owned.config = childOptions(this.options, model, request.cwd, owned.identity);
      owned.client = this.factory(owned.config);
      owned.started = false;
      owned.stop = undefined;
      owned.restart = false;
    }
    let unsubscribe = () => {};
    let heartbeat: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    try {
      if (!owned.started) {
        await untilAbort(owned.client.start(), signal);
        owned.started = true;
      }
      const state = record(await untilAbort(owned.client.getState(), signal));
      const selected = record(state?.model);
      if (selected?.provider !== wanted.provider || selected?.id !== wanted.id) {
        throw new Error('Advisor child did not select the requested model.');
      }
      const completion = new Promise<AdvisorReply>((resolve, reject) => {
        let text = '';
        let actualModel: string | undefined;
        let failure: AdvisorTurnError | undefined;
        unsubscribe = owned.client.onEvent(raw => {
          const event = record(raw);
          if (!event) return;
          if (event.type === 'message_update') {
            const update = record(event.assistantMessageEvent);
            if (update?.type === 'text_delta' && typeof update.delta === 'string') request.onProgress?.(update.delta);
          } else if (event.type === 'tool_execution_start' && typeof event.toolName === 'string') {
            request.onProgress?.(`\n[advisor inspecting: ${event.toolName}]\n`);
          } else if (event.type === 'message_end') {
            const message = record(event.message);
            if (message?.role !== 'assistant') return;
            actualModel = modelName(message);
            const reason = providerErrorSummary(message.errorMessage);
            failure = message.stopReason === 'error' || message.stopReason === 'aborted'
              ? new AdvisorTurnError(`Advisor model ${String(message.stopReason)}: ${reason}`,
                isLimitOrCapacityError(message.stopReason, message.errorMessage), reason) : undefined;
            text = textContent(message.content);
          } else if (event.type === 'agent_settled') {
            if (event.aborted) failure = new AdvisorTurnError('Advisor model was aborted.', false, 'aborted');
            if (failure) reject(failure);
            else if (!actualModel || !text.trim()) reject(new Error('Advisor returned no attributable text response.'));
            else resolve({ text, actualModel });
          }
        });
        // The exported client's idle waiter does not observe process exits. A small
        // state heartbeat makes an exit after prompt acceptance observable too.
        const poll = () => {
          heartbeat = setTimeout(() => {
            if (finished) return;
            owned.client.getState().then(() => { if (!finished) poll(); }, () => reject(new Error('Advisor process exited or stopped responding.')));
          }, this.options.heartbeatMs ?? 1000);
        };
        poll();
      });
      // Subscribe first; require BOTH acceptance and settlement, in either order.
      const acceptance = owned.client.prompt(prompt).then(disposition => {
        if (disposition !== 'started') throw new Error('Advisor prompt did not start a model run.');
      }, () => { throw new Error('Advisor prompt was rejected or process exited.'); });
      const [reply] = await untilAbort(Promise.all([completion, acceptance]), signal);
      return reply;
    } finally {
      finished = true;
      clearTimeout(heartbeat);
      unsubscribe();
    }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.shutdown.abort();
    this.closing = (async () => {
      const results = await Promise.allSettled([...this.sessions.values()].map(session => this.stop(session)));
      this.sessions.clear();
      if (results.some(result => result.status === 'rejected')) throw new Error('Advisor child cleanup failed.');
      if (this.sessionDirectory) await rm(this.sessionDirectory, { recursive: true, force: true });
    })();
    return this.closing;
  }
}
