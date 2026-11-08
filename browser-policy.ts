export const MAX_MESSAGE_BYTES = 64 * 1024;
export const MAX_SELECTOR = 512;
export const MAX_FILL = 8000;
export type BrowserAction = { action: "snapshot" } | { action: "click"; selector: string } | { action: "fill"; selector: string; text: string } | { action: "navigate"; url: string };
export type Binding = { generation: string; origin: string };

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
export function validateAction(value: unknown, origin?: string): BrowserAction {
  const v = record(value);
  const keys = v.action === "snapshot" ? ["action"] : v.action === "click" ? ["action", "selector"] : v.action === "fill" ? ["action", "selector", "text"] : v.action === "navigate" ? ["action", "url"] : [];
  if (!keys.length || Object.keys(v).some(k => !keys.includes(k))) throw new Error("Unsupported browser action or fields");
  if (v.action === "click" || v.action === "fill") {
    if (typeof v.selector !== "string" || !v.selector.trim() || v.selector.length > MAX_SELECTOR) throw new Error("Invalid CSS selector size");
  }
  if (v.action === "fill" && (typeof v.text !== "string" || v.text.length > MAX_FILL)) throw new Error("Invalid fill text size");
  if (v.action === "navigate" && (webOrigin(v.url) !== origin || !origin)) throw new Error("Navigation requires the bound origin; rebind for another origin");
  return v as BrowserAction;
}
// Firefox uses moz-extension://<uuid>; Chromium browsers (Edge, Chrome) use chrome-extension://<32 chars a-p>.
export function validExtensionOrigin(origin: unknown): boolean {
  return typeof origin === "string" && /^(moz-extension:\/\/[a-zA-Z0-9-]+|chrome-extension:\/\/[a-p]{32})\/?$/.test(origin);
}
export function isMutation(action: BrowserAction): boolean { return action.action !== "snapshot"; }
