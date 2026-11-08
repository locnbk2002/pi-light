"use strict";
// Chrome DevTools Protocol access for controlled tabs only, through a fixed method allowlist.
// Loaded by background.js with importScripts; shares its global scope.

const CDP_ALLOWED = new Set([
  "Page.enable", "Page.getFrameTree", "Page.createIsolatedWorld", "Page.navigate", "Page.captureScreenshot", "Page.getLayoutMetrics",
  "Runtime.enable", "Runtime.evaluate", "Log.enable", "Network.enable",
  "Input.dispatchMouseEvent", "Input.dispatchKeyEvent", "Input.insertText",
  "Accessibility.getFullAXTree"
]);
const LOG_LIMIT = 200;
const LOG_TEXT = 500;
const URL_TEXT = 300;
const MAX_SCREENSHOT_CHARS = 2.5 * 1024 * 1024;
const MAX_SHOT_WIDTH = 1600;
const MAX_SHOT_HEIGHT = 8000;
// tabId -> { console: [], network: [], requests: Map }
const sessions = new Map();

function cdp(tabId, method, params = {}) {
  if (!CDP_ALLOWED.has(method) || !sessions.has(tabId)) return Promise.reject(new Error("CDP method refused"));
  return chrome.debugger.sendCommand({ tabId }, method, params);
}
// Concurrent attaches to one tab (e.g. quick toolbar re-clicks) share a single attach.
const attaching = new Map();
function attachDebugger(tabId) {
  if (sessions.has(tabId)) return Promise.resolve();
  if (!attaching.has(tabId)) attaching.set(tabId, attachOnce(tabId).finally(() => attaching.delete(tabId)));
  return attaching.get(tabId);
}
async function attachOnce(tabId) {
  // Release a stale session this extension may still hold after a worker restart; this cannot detach another debugger.
  await chrome.debugger.detach({ tabId }).catch(() => {});
  try { await chrome.debugger.attach({ tabId }, "1.3"); }
  catch { throw new Error("Cannot debug this tab (another debugger or a protected page)"); }
  sessions.set(tabId, { console: [], network: [], requests: new Map() });
  for (const method of ["Page.enable", "Runtime.enable", "Log.enable", "Network.enable"]) await cdp(tabId, method);
}
function detachDebugger(tabId) {
  if (!sessions.delete(tabId)) return Promise.resolve();
  return chrome.debugger.detach({ tabId }).catch(() => {});
}
function push(list, entry) {
  list.push(entry);
  if (list.length > LOG_LIMIT) list.shift();
}
// Path only: query strings and fragments can carry credentials.
function safeUrl(raw) {
  try { const u = new URL(raw); return (u.origin + u.pathname).slice(0, URL_TEXT); } catch { return ""; }
}
// Console text is returned only after local confirmation; URLs inside it still lose their query and fragment.
function stripUrls(text) {
  return text.replace(/\b(?:https?|wss?):\/\/[^\s"'<>)]+/gi, raw => {
    try { const u = new URL(raw); return `${u.protocol}//${u.host}${u.pathname}`.slice(0, URL_TEXT); } catch { return "[url]"; }
  });
}
function logText(value) {
  return stripUrls(String(value)).slice(0, LOG_TEXT);
}
function remoteText(arg) {
  if (!arg) return "";
  if (arg.value !== undefined) return typeof arg.value === "string" ? arg.value : JSON.stringify(arg.value);
  return arg.description || arg.type || "";
}
function onCdpEvent(source, method, params) {
  const s = sessions.get(source.tabId);
  if (!s || !params) return;
  if (method === "Runtime.consoleAPICalled") push(s.console, { level: String(params.type).slice(0, 20), text: logText((params.args || []).slice(0, 20).map(remoteText).join(" ").slice(0, LOG_TEXT * 4)) });
  else if (method === "Runtime.exceptionThrown") push(s.console, { level: "exception", text: logText(params.exceptionDetails?.exception?.description || params.exceptionDetails?.text || "") });
  else if (method === "Log.entryAdded") push(s.console, { level: String(params.entry?.level).slice(0, 20), source: String(params.entry?.source || "").slice(0, 20), text: logText(params.entry?.text || ""), ...(params.entry?.url ? { url: safeUrl(params.entry.url) } : {}) });
  else if (method === "Network.requestWillBeSent") {
    const entry = { method: String(params.request?.method).slice(0, 10), url: safeUrl(params.request?.url), type: String(params.type || "").slice(0, 20) };
    s.requests.set(params.requestId, entry);
    if (s.requests.size > LOG_LIMIT) s.requests.delete(s.requests.keys().next().value);
    push(s.network, entry);
  } else if (method === "Network.responseReceived") {
    const entry = s.requests.get(params.requestId);
    if (entry) { entry.status = params.response?.status; entry.mimeType = String(params.response?.mimeType || "").slice(0, 60); }
  } else if (method === "Network.loadingFailed") {
    const entry = s.requests.get(params.requestId);
    if (entry) entry.failed = String(params.errorText || "failed").slice(0, 100);
  }
}
/** Copies of the buffered entries; background.js trims the oldest ones to the byte budget. */
function recentLogs(list) {
  return { entries: list.map(entry => ({ ...entry })), dropped: 0 };
}

// ---- Fixed page functions: run in an isolated world; model data arrives only as JSON arguments. ----

function pageSnapshot() {
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
  let text = "";
  let node;
  let scanned = 0;
  while ((node = walker.nextNode()) && text.length < 16000 && ++scanned < 20000) {
    const parent = node.parentElement;
    if (!parent || parent.closest("input,textarea,select,option,script,style,noscript,[contenteditable],[hidden]")) continue;
    const style = getComputedStyle(parent);
    if (style.display === "none" || style.visibility !== "visible" || !parent.getClientRects().length) continue;
    text += node.textContent.slice(0, 16000 - text.length) + " ";
  }
  const controls = [];
  for (const el of document.querySelectorAll("input,textarea,select,button,a[href]")) {
    if (controls.length >= 80) break;
    controls.push({ tag: el.tagName.toLowerCase(), type: (el.getAttribute("type") || "").slice(0, 40), id: (el.id || "").slice(0, 120), name: (el.getAttribute("name") || "").slice(0, 120), label: (el.getAttribute("aria-label") || (el.tagName === "BUTTON" || el.tagName === "A" ? el.textContent : "") || "").trim().slice(0, 120), disabled: el.disabled === true });
  }
  // Never control values; the URL drops query and fragment, which can hold credentials.
  return { title: document.title.slice(0, 300), url: location.origin + location.pathname.slice(0, 2000), text: text.slice(0, 16000), controls, truncated: text.length >= 16000 || scanned >= 20000 || controls.length >= 80 };
}
function pageLocate(request) {
  const elements = document.querySelectorAll(request.selector);
  if (elements.length !== 1) throw new Error("Selector must match exactly one element");
  const el = elements[0];
  if (!(el instanceof Element) || el.closest("[hidden]")) throw new Error("Element is not visible");
  el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  const rect = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  if (!rect.width || !rect.height || style.visibility !== "visible" || style.pointerEvents === "none") throw new Error("Element is not visible");
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const hit = document.elementFromPoint(x, y);
  // Hit-test right before input so a covering overlay does not receive the click instead.
  if (!hit || !(hit === el || el.contains(hit))) throw new Error("Element is covered by another element");
  return { x, y };
}
function pagePrepareFill(request) {
  const elements = document.querySelectorAll(request.selector);
  if (elements.length !== 1) throw new Error("Selector must match exactly one element");
  const el = elements[0];
  const textInput = el instanceof HTMLInputElement && ["text", "email", "search", "tel", "url", "number", ""].includes(el.getAttribute("type") || "");
  if (!(textInput || el instanceof HTMLTextAreaElement) || el.disabled || el.readOnly || el.closest("[hidden]") || !el.getClientRects().length || getComputedStyle(el).visibility !== "visible") throw new Error("Fill refuses password/file/hidden or unsupported controls");
  el.scrollIntoView({ block: "center", behavior: "instant" });
  el.focus();
  el.select();
  if (document.activeElement !== el) throw new Error("Field could not be focused");
  return { ready: true };
}
function pageFilledValue(request) {
  const el = document.querySelectorAll(request.selector)[0];
  // Compares in the page so the field value never leaves it.
  return { matches: Boolean(el) && el.value === request.text };
}
function pageWaitCheck(request) {
  if (request.selector) {
    const el = document.querySelector(request.selector);
    return { found: Boolean(el && el.getClientRects().length && getComputedStyle(el).visibility === "visible") };
  }
  return { found: (document.body?.innerText || "").includes(request.text) };
}
function pageViewport() {
  return { width: innerWidth, height: innerHeight };
}

async function inPage(tabId, fn, arg) {
  const { frameTree } = await cdp(tabId, "Page.getFrameTree");
  const { executionContextId } = await cdp(tabId, "Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: "pi-light", grantUniveralAccess: false });
  const expression = `(${fn.toString()})(${JSON.stringify(arg ?? null)})`;
  const r = await cdp(tabId, "Runtime.evaluate", { expression, contextId: executionContextId, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.exception?.description || "Page action failed").split("\n")[0].replace(/^Error: /, "").slice(0, 200));
  return r.result.value;
}

async function mouse(tabId, type, x, y, extra = {}) {
  await cdp(tabId, "Input.dispatchMouseEvent", { type, x, y, button: "none", ...extra });
}
async function click(tabId, selector) {
  const { x, y } = await inPage(tabId, pageLocate, { selector });
  await mouse(tabId, "mouseMoved", x, y);
  await mouse(tabId, "mousePressed", x, y, { button: "left", clickCount: 1 });
  await mouse(tabId, "mouseReleased", x, y, { button: "left", clickCount: 1 });
  return { dispatched: true };
}
async function hover(tabId, selector) {
  const { x, y } = await inPage(tabId, pageLocate, { selector });
  await mouse(tabId, "mouseMoved", x, y);
  return { dispatched: true };
}

const KEY_DEFS = {
  Enter: { code: "Enter", vk: 13, text: "\r" }, Tab: { code: "Tab", vk: 9 }, Escape: { code: "Escape", vk: 27 },
  Backspace: { code: "Backspace", vk: 8 }, Delete: { code: "Delete", vk: 46 }, ArrowUp: { code: "ArrowUp", vk: 38 },
  ArrowDown: { code: "ArrowDown", vk: 40 }, ArrowLeft: { code: "ArrowLeft", vk: 37 }, ArrowRight: { code: "ArrowRight", vk: 39 },
  Home: { code: "Home", vk: 36 }, End: { code: "End", vk: 35 }, PageUp: { code: "PageUp", vk: 33 }, PageDown: { code: "PageDown", vk: 34 },
  Space: { key: " ", code: "Space", vk: 32, text: " " }
};
function keyDef(key) {
  if (KEY_DEFS[key]) return { key: KEY_DEFS[key].key || key, ...KEY_DEFS[key] };
  if (!/^[\x20-\x7e]$/.test(key)) throw new Error("Unsupported key");
  const upper = key.toUpperCase();
  const code = /[A-Z]/.test(upper) ? `Key${upper}` : /[0-9]/.test(key) ? `Digit${key}` : "";
  return { key, code, vk: /[A-Z0-9]/.test(upper) ? upper.charCodeAt(0) : 0, text: key };
}
async function press(tabId, key) {
  const d = keyDef(key);
  const base = { key: d.key, code: d.code, windowsVirtualKeyCode: d.vk, nativeVirtualKeyCode: d.vk };
  await cdp(tabId, "Input.dispatchKeyEvent", { type: d.text ? "keyDown" : "rawKeyDown", ...base, ...(d.text ? { text: d.text, unmodifiedText: d.text } : {}) });
  await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
  return { dispatched: true };
}
async function fill(tabId, selector, text) {
  await inPage(tabId, pagePrepareFill, { selector });
  // Native text input replaces the selection, so framework-controlled inputs see real input events.
  if (text) await cdp(tabId, "Input.insertText", { text });
  else await press(tabId, "Delete");
  const { matches } = await inPage(tabId, pageFilledValue, { selector, text });
  if (!matches) throw new Error("Field value differs after typing (masked or controlled input)");
  return { dispatched: true };
}
async function scroll(tabId, dy) {
  const { width, height } = await inPage(tabId, pageViewport);
  await mouse(tabId, "mouseWheel", Math.floor(width / 2), Math.floor(height / 2), { deltaX: 0, deltaY: dy });
  return { dispatched: true };
}
async function waitFor(tabId, request, deadline) {
  const until = Math.min(Date.now() + (request.timeoutMs ?? 5000), deadline - 500);
  for (;;) {
    const { found } = await inPage(tabId, pageWaitCheck, { selector: request.selector, text: request.text });
    if (found) return { found: true };
    if (Date.now() >= until) return { found: false };
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}
async function navigate(tabId, url) {
  const r = await cdp(tabId, "Page.navigate", { url });
  if (r.errorText) throw new Error(`Navigation failed: ${String(r.errorText).replace(/[^\w .:-]/g, "").slice(0, 80)}`);
  return { dispatched: true, note: "Navigation started; use waitFor before reading the page." };
}
async function evaluate(tabId, code, deadline) {
  const timeout = Math.max(500, deadline - Date.now() - 500);
  const evaluation = cdp(tabId, "Runtime.evaluate", { expression: code, replMode: true, awaitPromise: true, returnByValue: true, userGesture: true, timeout });
  const r = await Promise.race([evaluation, new Promise((_, reject) => setTimeout(() => reject(new Error("Evaluation timed out (it may still be running)")), timeout))]);
  if (r.exceptionDetails) return { exception: String(r.exceptionDetails.exception?.description || r.exceptionDetails.text || "Exception").slice(0, 2000) };
  const value = r.result.value;
  if (value === undefined && r.result.type !== "undefined") return { type: r.result.type, description: String(r.result.description || "").slice(0, 500) };
  // background.js converts an oversized value to truncated JSON text within the byte budget.
  return { value };
}
// Roles whose subtree renders what the user typed; Chromium exposes it as descendant StaticText names.
const FIELD_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton", "textField", "TextField", "SearchBox", "ComboBox", "SpinButton"]);
function isField(node) {
  return FIELD_ROLES.has(node.role?.value) || (node.properties || []).some(p => p.name === "editable" && p.value?.value);
}
async function axSnapshot(tabId) {
  const { nodes } = await cdp(tabId, "Accessibility.getFullAXTree", {});
  const byId = new Map(nodes.map(n => [n.nodeId, n]));
  const parentOf = new Map();
  for (const n of nodes) {
    for (const child of n.childIds || []) parentOf.set(child, n.nodeId);
    if (n.parentId !== undefined) parentOf.set(n.nodeId, n.parentId);
  }
  // Fails closed: a node whose ancestry cannot be walked within the bound counts as inside a field.
  const insideField = n => {
    let id = parentOf.get(n.nodeId);
    for (let depth = 0; id !== undefined; depth++) {
      if (depth > 500) return true;
      const ancestor = byId.get(id);
      if (!ancestor) return false;
      if (isField(ancestor)) return true;
      id = parentOf.get(id);
    }
    return false;
  };
  const skip = new Set(["none", "generic", "InlineTextBox", "LineBreak"]);
  const lines = [];
  for (const n of nodes) {
    if (n.ignored || insideField(n)) continue;
    const role = n.role?.value;
    // Editable regions (contenteditable) carry their content as the name; fields keep only their label.
    const editable = (n.properties || []).some(p => p.name === "editable" && p.value?.value);
    const name = typeof n.name?.value === "string" && !(editable && !FIELD_ROLES.has(role)) ? n.name.value.trim().slice(0, 200) : "";
    if (!role || skip.has(role) || (role === "StaticText" && !name)) continue;
    // Roles and accessible names only: values of form fields and text typed into them are never included.
    lines.push(name ? `${role}: ${name}` : role);
    if (lines.length >= 1500) return { lines, truncated: true };
  }
  return { lines, truncated: false };
}
async function screenshot(tabId, fullPage) {
  const m = await cdp(tabId, "Page.getLayoutMetrics");
  const view = m.cssVisualViewport || m.visualViewport;
  const content = m.cssContentSize || m.contentSize;
  const width = fullPage ? content.width : view.clientWidth;
  const height = Math.min(fullPage ? content.height : view.clientHeight, MAX_SHOT_HEIGHT);
  const scale = Math.min(1, MAX_SHOT_WIDTH / Math.max(1, width));
  const clip = { x: fullPage ? 0 : view.pageX, y: fullPage ? 0 : view.pageY, width, height, scale };
  for (const quality of [60, 35]) {
    const { data } = await cdp(tabId, "Page.captureScreenshot", { format: "jpeg", quality, clip, captureBeyondViewport: Boolean(fullPage) });
    if (data.length <= MAX_SCREENSHOT_CHARS) return { data, width: Math.round(width * scale), height: Math.round(height * scale) };
  }
  throw new Error("Screenshot too large; try without fullPage");
}
