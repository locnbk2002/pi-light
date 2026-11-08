export const MAX_MESSAGE_BYTES = 64 * 1024;
// Only a screenshot result may exceed MAX_MESSAGE_BYTES (base64 JPEG).
export const MAX_SCREENSHOT_MESSAGE_BYTES = 3 * 1024 * 1024;
export const MAX_SELECTOR = 512;
export const MAX_FILL = 8000;
export const MAX_CODE = 8000;
export const MAX_WAIT_MS = 8000;
export const TAB_NAME = /^[a-z0-9-]{1,32}$/;
export const BOUND_TAB = "bound";
export const KEYS = ["Enter", "Tab", "Escape", "Backspace", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "Space"] as const;

export type TabKind = "bound" | "owned";
export type ControlledTab = { name: string; generation: string; kind: TabKind; origin: string };
export type BrowserAction =
  | { action: "tabs" }
  | { action: "open"; url: string; name?: string; keep?: boolean }
  | { action: "close"; tab?: string }
  | { action: "snapshot"; tab?: string; mode?: "text" | "ax" }
  | { action: "screenshot"; tab?: string; fullPage?: boolean }
  | { action: "click"; tab?: string; selector: string }
  | { action: "hover"; tab?: string; selector: string }
  | { action: "fill"; tab?: string; selector: string; text: string }
  | { action: "press"; tab?: string; key: string }
  | { action: "scroll"; tab?: string; dy: number }
  | { action: "waitFor"; tab?: string; selector?: string; text?: string; timeoutMs?: number }
  | { action: "console"; tab?: string }
  | { action: "network"; tab?: string }
  | { action: "evaluate"; tab?: string; code: string }
  | { action: "navigate"; tab?: string; url: string };
export type ActionName = BrowserAction["action"];

const FIELDS: Record<ActionName, string[]> = {
  tabs: [], open: ["url", "name", "keep"], close: ["tab"], snapshot: ["tab", "mode"], screenshot: ["tab", "fullPage"],
  click: ["tab", "selector"], hover: ["tab", "selector"], fill: ["tab", "selector", "text"], press: ["tab", "key"],
  scroll: ["tab", "dy"], waitFor: ["tab", "selector", "text", "timeoutMs"], console: ["tab"], network: ["tab"],
  evaluate: ["tab", "code"], navigate: ["tab", "url"]
};
export const ACTIONS = Object.keys(FIELDS) as ActionName[];
// Actions that can change page, tab or account state; each needs local confirmation and is refused in read-only mode.
const MUTATIONS = new Set<ActionName>(["open", "close", "click", "fill", "press", "navigate", "evaluate"]);
// Reads that can return arbitrary page-logged text (secrets, form values): confirmed locally, allowed in read-only mode.
const SENSITIVE_READS = new Set<ActionName>(["console"]);
// Actions that run without a target tab.
const TABLESS = new Set<ActionName>(["tabs", "open"]);

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object");
  return value as Record<string, unknown>;
}
export function webOrigin(value: unknown): string {
  if (typeof value !== "string" || value.length > 4096) throw new Error("Invalid URL");
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Only credential-free HTTP(S) URLs allowed");
  return url.origin;
}
const text = (value: unknown, max: number, label: string, allowEmpty = false) => {
  if (typeof value !== "string" || value.length > max || (!allowEmpty && !value.trim())) throw new Error(`Invalid ${label}`);
};

/** Validates shape and bounds. When `target` is given, also enforces its origin policy (bound tabs are origin-locked). */
export function validateAction(value: unknown, target?: ControlledTab): BrowserAction {
  const v = record(value);
  const name = v.action as ActionName;
  const allowed = typeof name === "string" && Object.hasOwn(FIELDS, name) ? ["action", ...FIELDS[name]] : [];
  if (!allowed.length || Object.keys(v).some(k => !allowed.includes(k) || v[k] === undefined)) throw new Error("Unsupported browser action or fields");
  if (v.tab !== undefined && (typeof v.tab !== "string" || !TAB_NAME.test(v.tab))) throw new Error("Invalid tab name");
  switch (name) {
    case "open":
      webOrigin(v.url);
      if (v.name !== undefined && (typeof v.name !== "string" || !TAB_NAME.test(v.name) || v.name === BOUND_TAB)) throw new Error("Invalid tab name");
      if (v.keep !== undefined && typeof v.keep !== "boolean") throw new Error("Invalid keep flag");
      break;
    case "snapshot": if (v.mode !== undefined && v.mode !== "text" && v.mode !== "ax") throw new Error("Invalid snapshot mode"); break;
    case "screenshot": if (v.fullPage !== undefined && typeof v.fullPage !== "boolean") throw new Error("Invalid fullPage flag"); break;
    case "click": case "hover": text(v.selector, MAX_SELECTOR, "CSS selector size"); break;
    case "fill": text(v.selector, MAX_SELECTOR, "CSS selector size"); text(v.text, MAX_FILL, "fill text size", true); break;
    case "press": if (typeof v.key !== "string" || !((KEYS as readonly string[]).includes(v.key) || /^[\x20-\x7e]$/.test(v.key))) throw new Error("Unsupported key"); break;
    case "scroll": if (typeof v.dy !== "number" || !Number.isFinite(v.dy) || Math.abs(v.dy) > 20000) throw new Error("Invalid scroll delta"); break;
    case "waitFor":
      if ((v.selector === undefined) === (v.text === undefined)) throw new Error("waitFor needs exactly one of selector or text");
      if (v.selector !== undefined) text(v.selector, MAX_SELECTOR, "CSS selector size");
      if (v.text !== undefined) text(v.text, 500, "wait text");
      if (v.timeoutMs !== undefined && (typeof v.timeoutMs !== "number" || !Number.isInteger(v.timeoutMs) || v.timeoutMs < 0 || v.timeoutMs > MAX_WAIT_MS)) throw new Error("Invalid wait timeout");
      break;
    case "evaluate": text(v.code, MAX_CODE, "code size"); break;
    case "navigate": {
      const origin = webOrigin(v.url);
      if (target?.kind === "bound" && origin !== target.origin) throw new Error("Bound tab navigation must stay on its origin; open a new tab for another origin");
      break;
    }
  }
  if (target && name === "close" && target.kind !== "owned") throw new Error("Only tabs opened by Pi can be closed");
  return v as BrowserAction;
}
export function needsTab(action: BrowserAction): boolean { return !TABLESS.has(action.action); }
export function isMutation(action: BrowserAction): boolean { return MUTATIONS.has(action.action); }
/**
 * Local confirmation policy (user decision 2026-11-08): opening a tab always asks; actions on the user's
 * bound tab ask for mutations and console text; Pi-owned tabs run without prompts. Read-only mode is separate.
 */
export function needsConfirmation(action: BrowserAction, target?: ControlledTab): boolean {
  if (action.action === "open") return true;
  if (target?.kind === "owned") return false;
  return isMutation(action) || SENSITIVE_READS.has(action.action);
}
// Chromium browsers (Brave, Chrome, Edge) use chrome-extension://<32 chars a-p>.
export function validExtensionOrigin(origin: unknown): boolean {
  return typeof origin === "string" && /^chrome-extension:\/\/[a-p]{32}\/?$/.test(origin);
}
export function validTabs(value: unknown): ControlledTab[] {
  if (!Array.isArray(value) || value.length > 32) throw new Error("Invalid tab list");
  const names = new Set<string>();
  return value.map(item => {
    const t = record(item);
    if (typeof t.name !== "string" || !TAB_NAME.test(t.name) || names.has(t.name)) throw new Error("Invalid tab name");
    if (typeof t.generation !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(t.generation)) throw new Error("Invalid generation");
    if (t.kind !== "bound" && t.kind !== "owned") throw new Error("Invalid tab kind");
    if ((t.kind === "bound") !== (t.name === BOUND_TAB)) throw new Error("Bound tab name mismatch");
    if (webOrigin(t.origin) !== t.origin) throw new Error("Invalid tab origin");
    names.add(t.name);
    return { name: t.name, generation: t.generation, kind: t.kind, origin: t.origin };
  });
}
