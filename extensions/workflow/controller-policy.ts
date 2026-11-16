import { randomUUID } from 'node:crypto';
export const MAIN_MODEL = { provider: 'anthropic', model: 'claude-opus-5-5' } as const;

export type Mode = 'auto' | 'advice' | 'plan' | 'brainstorm' | 'work';
export type TaskIntent = 'advice' | 'brainstorm' | 'plan' | 'implement';
export interface TaskRoute {
  intent: TaskIntent;
  requestId: string;
  requestQuote: string;
  scope: string;
}

export function nonempty(value: unknown, label: string, max = 32_000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new Error(`${label} must be nonempty text, at most ${max} characters.`);
  }
  return value;
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
    if ((source === 'interactive' || source === 'rpc') && text.trim() && text.length <= 128_000) {
      this.request = { id: randomUUID(), text };
    }
  }
  routeTask(route: TaskRoute): void {
    // Revoke first, including on malformed/stale attempts. Never echo request text on errors.
    this.route = undefined;
    this.mode = 'auto';
    if (!this.request || route.requestId !== this.request.id || route.requestQuote !== this.request.text) {
      throw new Error('Route rejected: missing or stale human request, or exact request quote mismatch.');
    }
    if (!['advice', 'brainstorm', 'plan', 'implement'].includes(route.intent)) throw new Error('Invalid task intent.');
    nonempty(route.scope, 'Scope', 4000);
    this.route = { ...route };
    this.mode = route.intent === 'implement' ? 'work' : route.intent;
  }
  setMode(mode: Mode): void {
    if (mode === 'work') throw new Error('Work requires route_task for the current explicit human implementation request.');
    this.reset(mode);
    if (mode === 'plan' || mode === 'brainstorm') this.nextMode = mode;
  }
}
