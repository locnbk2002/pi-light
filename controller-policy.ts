import { randomUUID } from 'node:crypto';
export const ADVISORS = {
  astra: { provider: 'openai-codex', model: 'gpt-6-astra' },
  fable: { provider: 'anthropic', model: 'claude-fable-5-1' },
} as const;
export const MAIN_MODEL = { provider: 'anthropic', model: 'claude-opus-5-5' } as const;
export const READ_TOOLS = ['read', 'grep', 'find', 'ls'] as const;

/** Do not replace models/tools in one-shot Pi jobs, including AgentKit children. */
export function isOneShotInvocation(argv = process.argv.slice(2)): boolean {
  const end = argv.indexOf('--');
  const options = end < 0 ? argv : argv.slice(0, end);
  return options.includes('-p') || options.includes('--print');
}
export type Advisor = keyof typeof ADVISORS;
export type Mode = 'auto' | 'advice' | 'plan' | 'brainstorm' | 'work';
export type TaskIntent = 'advice' | 'brainstorm' | 'plan' | 'implement';
export interface TaskRoute {
  intent: TaskIntent;
  requestId: string;
  requestQuote: string;
  scope: string;
}
export interface DirectChat {
  advisor: Advisor;
  topic: string;
  userQuotes: string[];
  draft?: string;
}

export function advisorName(value: unknown): Advisor {
  if (value !== 'astra' && value !== 'fable') throw new Error('Choose astra or fable explicitly.');
  return value;
}
export function nonempty(value: unknown, label: string, max = 32_000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new Error(`${label} must be nonempty text, at most ${max} characters.`);
  }
  return value;
}
export function parseAdvisorArgs(args: string): { advisor: Advisor; topic: string } {
  const [name, ...words] = args.trim().split(/\s+/);
  return { advisor: advisorName(name), topic: nonempty(words.join(' ') || 'default', 'Topic', 120) };
}

/** Request binding is enforced here; semantic intent/scope remain an LLM judgment, not a sandbox. */
export class ControllerPolicy {
  mode: Mode = 'auto';
  request?: Readonly<{ id: string; text: string }>;
  route?: Readonly<TaskRoute>;
  private nextMode?: 'plan' | 'brainstorm';
  reset(mode: Mode = 'auto'): void {
    this.request = undefined;
    this.nextMode = undefined;
    this.route = undefined;
    this.mode = mode;
  }
  captureInput(text: string, source: string): void {
    const preference = this.nextMode;
    this.reset(preference ?? 'auto');
    if (!this.direct && (source === 'interactive' || source === 'rpc') && text.trim() && text.length <= 128_000) {
      this.request = { id: randomUUID(), text };
    }
  }
  routeTask(route: TaskRoute): void {
    // Revoke first, including on malformed/stale attempts. Never echo request text on errors.
    this.route = undefined;
    this.mode = 'auto';
    if (this.direct || !this.request || route.requestId !== this.request.id || route.requestQuote !== this.request.text) {
      throw new Error('Route rejected: missing or stale human request, or exact request quote mismatch.');
    }
    if (!['advice', 'brainstorm', 'plan', 'implement'].includes(route.intent)) throw new Error('Invalid task intent.');
    nonempty(route.scope, 'Scope', 4000);
    this.route = { ...route };
    this.mode = route.intent === 'implement' ? 'work' : route.intent;
  }
  direct?: DirectChat;
  private conversations = new Map<string, DirectChat>();
  /** Routes are stage guidance, not a sandbox: only direct advisor chat locks controller tools. */
  get isReadOnly(): boolean { return this.direct !== undefined; }
  setMode(mode: Mode): void {
    if (mode === 'work') throw new Error('Work requires route_task for the current explicit human implementation request.');
    this.reset(mode);
    if (mode === 'plan' || mode === 'brainstorm') this.nextMode = mode;
  }
  allowsTool(_name: string): boolean { return !this.direct; }
  activeTools(available: string[]): string[] {
    return available.filter(name => this.allowsTool(name));
  }
  enter(advisor: Advisor, topic: string): void {
    if (this.direct) throw new Error('Use /back before switching advisor conversations.');
    const validatedTopic = nonempty(topic, 'Topic', 120);
    const key = JSON.stringify([advisor, validatedTopic]);
    this.direct = this.conversations.get(key) ?? { advisor, topic: validatedTopic, userQuotes: [] };
    this.conversations.set(key, this.direct);
    // A later handoff must never implicitly restore an old work grant.
    this.reset('plan');
  }
  recordUser(text: string): void {
    if (!this.direct) throw new Error('No direct advisor conversation.');
    this.direct.userQuotes.push(nonempty(text, 'Advisor input'));
    this.direct.draft = undefined;
  }
  completeHandoff(confirmed: boolean): boolean {
    if (!this.direct || !confirmed) return false;
    this.direct = undefined;
    this.reset('plan');
    return true;
  }
}

export const HANDOFF_REQUEST = `Prepare a structured handoff to the Opus controller from this conversation.
Use these headings: Advisor suggestions (NOT user decisions), Pending questions, Evidence (sources and observed facts; label unverified claims).
Do not invent approvals, decisions, evidence, or completed work. Do not execute anything.
The host will separately attach the user's original words as exact quotations.`;

export function handoffDraft(chat: DirectChat, summary: string, actualModel: string): string {
  return `Advisor handoff: ${chat.advisor}; topic: ${chat.topic}\nActual responding model: ${actualModel}\n\n` +
    `User statements — exact JSON quotations (constraints and decisions remain authoritative; questions are not approvals):\n` +
    chat.userQuotes.map((text, i) => `${i + 1}. ${JSON.stringify(text)}`).join('\n') +
    `\n\n${summary}\n\nController: retain explicit user constraints. Advisor suggestions are not authorization. Resolve pending questions before work; this handoff leaves plan mode active.`;
}
