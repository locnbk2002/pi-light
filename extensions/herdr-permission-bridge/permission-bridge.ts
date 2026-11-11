import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

/**
 * Bridges @gotgenes/pi-permission-system prompts to herdr's Pi integration, so a pane waiting on a
 * permission dialog shows as `blocked` in herdr (and `herdr agent wait --until blocked` fires).
 *
 * pi-permission-system emits `permissions:ui_prompt` right before it shows a dialog and
 * `permissions:decision` (same requestId) when any gate resolves. herdr's managed extension
 * (~/.pi/agent/extensions/herdr-agent-state.ts) listens on `herdr:blocked` with a counter, so every
 * `active: true` must be paired with exactly one `active: false`. Open prompts are tracked by
 * requestId: several can be pending at once, and a decision for an ask that never prompted must not
 * clear anything. The counter is held at 1 while any prompt is open.
 */
export const UI_PROMPT_CHANNEL = 'permissions:ui_prompt';
export const DECISION_CHANNEL = 'permissions:decision';
export const HERDR_BLOCKED_CHANNEL = 'herdr:blocked';
const LABEL_MAX = 120;

export function promptLabel(event: { surface?: unknown; value?: unknown }): string {
  const parts = [event.surface, event.value].filter((part): part is string => typeof part === 'string' && part.length > 0);
  const label = `Permission: ${parts.join(': ') || 'approval needed'}`.replace(/\s+/g, ' ');
  return label.length > LABEL_MAX ? `${label.slice(0, LABEL_MAX - 1)}…` : label;
}

export function registerPermissionBridge(pi: Pick<ExtensionAPI, 'events' | 'on'>): void {
  const open = new Set<string>();
  const emit = (data: { active: boolean; label?: string }) => {
    try { pi.events.emit(HERDR_BLOCKED_CHANNEL, data); } catch { /* status is best-effort */ }
  };

  pi.events.on(UI_PROMPT_CHANNEL, raw => {
    const event = (raw ?? {}) as { requestId?: unknown; surface?: unknown; value?: unknown };
    if (typeof event.requestId !== 'string' || open.has(event.requestId)) return;
    if (open.size === 0) emit({ active: true, label: promptLabel(event) });
    open.add(event.requestId);
  });

  pi.events.on(DECISION_CHANNEL, raw => {
    const requestId = (raw as { requestId?: unknown } | undefined)?.requestId;
    if (typeof requestId !== 'string' || !open.delete(requestId)) return;
    if (open.size === 0) emit({ active: false });
  });

  // herdr's extension resets its counter on every session_start (/reload, /new, /resume): stay in sync.
  pi.on('session_start', () => { open.clear(); });
  pi.on('session_shutdown', () => {
    if (open.size > 0) emit({ active: false });
    open.clear();
  });
}
