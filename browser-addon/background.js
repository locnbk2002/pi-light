"use strict";
// Compat shim: Firefox exposes promise-based `browser`; Chromium MV3 `chrome` returns promises when no callback is given.
const api = globalThis.browser ?? globalThis.chrome;
const BRIDGE_URL = "ws://127.0.0.1:19339";
// Session storage is memory-only and hidden from content scripts; local storage is the fallback for older engines.
const store = api.storage.session ?? api.storage.local;
let socket = null;
let ready = false;
let binding = null;
// Tab to bind once authentication completes (restored after worker restart, or clicked while reconnecting).
let pendingBind = null;
let busy = false;
let status = "Disconnected. Configure connection in add-on options.";

function send(message) {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}
function persist(values) {
  return store.set(values).catch(() => { status = "Could not save connection state; worker restarts will need options again."; });
}
function forget(keys) {
  return store.remove(keys).catch(() => { status = "Could not clear saved connection state."; });
}
function unbind(reason) {
  binding = null;
  pendingBind = null;
  status = reason;
  void forget("binding");
  if (ready) send({ type: "binding", bound: false });
}
function originOf(url) {
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error("Select an HTTP(S) tab without URL credentials.");
  return parsed.origin;
}
function current(b, ws, request) {
  if (!ready || socket !== ws || ws.readyState !== WebSocket.OPEN || binding !== b || Date.now() > request.deadline) throw new Error("Binding expired or changed");
}
function validIntent(intent) {
  return Boolean(intent) && intent.url === BRIDGE_URL && typeof intent.token === "string" && /^[a-f0-9]{64}$/.test(intent.token);
}
function bindTab(target, label) {
  if (busy) throw new Error("Wait for current action to finish before binding.");
  pendingBind = null;
  binding = { tabId: target.tabId, origin: target.origin, generation: crypto.randomUUID() };
  status = `${label} ${binding.origin}. Click this tab's toolbar button again to unbind.`;
  void persist({ binding: { tabId: target.tabId, origin: target.origin } });
  send({ type: "binding", bound: true, generation: binding.generation, origin: binding.origin });
}
// Re-verifies a pending tab before binding: it must still exist and still show the remembered origin.
async function bindPending(ws, target) {
  try {
    const tab = await api.tabs.get(target.tabId);
    if (pendingBind !== target || socket !== ws || !ready) return;
    if (originOf(tab.url) !== target.origin) throw new Error("Origin changed");
    bindTab(target, "Bound to");
  } catch {
    if (pendingBind === target) unbind("Previous tab binding could not be restored; click the toolbar to bind again.");
  }
}

// Only this fixed function is injected. Model data is JSON-encoded arguments, never executable source.
function pageAction(request) {
  if (location.origin !== request.origin || Date.now() > request.deadline) throw new Error("Origin changed or request expired; rebind required");
  if (request.action === "navigate") {
    const url = new URL(request.url);
    if (url.origin !== request.origin || url.username || url.password || !["http:", "https:"].includes(url.protocol)) throw new Error("Cross-origin navigation refused");
    location.assign(url.href);
    return { dispatched: true, note: "Navigation dispatched; redirects may unbind the tab." };
  }
  if (request.action === "snapshot") {
    // Walk bounded visible text, excluding control contents, scripts and editable regions.
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
    let text = "";
    let node;
    let scanned = 0;
    while ((node = walker.nextNode()) && text.length < 16000 && ++scanned < 20000) {
      const parent = node.parentElement;
      if (!parent || parent.closest('input,textarea,select,option,script,style,noscript,[contenteditable], [hidden]')) continue;
      const style = getComputedStyle(parent);
      if (style.display === "none" || style.visibility !== "visible" || !parent.getClientRects().length) continue;
      text += node.textContent.slice(0, 16000 - text.length) + " ";
    }
    const controls = [];
    for (const el of document.querySelectorAll("input,textarea,select,button")) {
      if (controls.length >= 60) break;
      controls.push({ tag: el.tagName.toLowerCase(), type: (el.getAttribute("type") || "").slice(0, 40), id: (el.id || "").slice(0, 120), name: (el.getAttribute("name") || "").slice(0, 120), disabled: el.disabled === true });
    }
    // Avoid URLs' query/fragment values, which can contain authentication material.
    return { title: document.title.slice(0, 300), url: location.origin + location.pathname.slice(0, 2000), text: text.slice(0, 16000), controls, truncated: text.length >= 16000 || scanned >= 20000 || controls.length >= 60 };
  }
  if (typeof request.selector !== "string" || !request.selector.trim() || request.selector.length > 512) throw new Error("Invalid selector");
  const elements = document.querySelectorAll(request.selector);
  if (elements.length !== 1) throw new Error("Selector must match exactly one element");
  const el = elements[0];
  if (request.action === "click") {
    if (!(el instanceof HTMLElement) || el.hidden || !el.getClientRects().length) throw new Error("Element is not clickable");
    el.click(); return { dispatched: true };
  }
  if (request.action !== "fill" || typeof request.text !== "string" || request.text.length > 8000) throw new Error("Unsupported action");
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) || (el instanceof HTMLInputElement && !["text", "email", "search", "tel", "url", "number"].includes(el.type)) || el.disabled || el.readOnly || el.hidden || !el.getClientRects().length || getComputedStyle(el).visibility !== "visible") throw new Error("Fill refuses password/file/hidden or unsupported controls");
  const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, request.text);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { dispatched: true };
}

function boundSnapshot(response) {
  const fits = () => new TextEncoder().encode(JSON.stringify(response)).length <= 48000;
  if (fits()) return;
  const snapshot = response.result;
  snapshot.truncated = true;
  // Budget the complete wire envelope, including JSON escapes and UTF-8 metadata.
  const trim = key => {
    const original = snapshot[key];
    let low = 0;
    let high = original.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      snapshot[key] = original.slice(0, middle);
      if (fits()) low = middle;
      else high = middle - 1;
    }
    // Do not create an unpaired surrogate when shortening non-BMP page content.
    if (low > 0 && low < original.length && /[\uD800-\uDBFF]/.test(original[low - 1])) low--;
    snapshot[key] = original.slice(0, low);
  };
  trim("text");
  while (!fits() && snapshot.controls.length) snapshot.controls.pop();
  if (!fits()) trim("title");
  if (!fits()) trim("url");
  if (!fits()) throw new Error("Result exceeds limit");
}

async function run(message, ws) {
  const b = binding;
  if (!b || busy) throw new Error("No binding or action in progress");
  if (typeof message.id !== "string" || !/^[a-f0-9]{32}$/.test(message.id) || message.generation !== b.generation || message.origin !== b.origin || !Number.isFinite(message.deadline) || message.deadline > Date.now() + 15000 || !["snapshot", "click", "fill", "navigate"].includes(message.action)) throw new Error("Invalid request");
  busy = true;
  try {
    current(b, ws, message);
    const tab = await api.tabs.get(b.tabId);
    current(b, ws, message);
    if (originOf(tab.url) !== b.origin) { unbind("Origin changed; click toolbar to rebind."); throw new Error("Origin changed"); }
    // The fixed function is structured-cloned into the page; the request travels only as JSON-compatible data.
    const injected = await api.scripting.executeScript({ target: { tabId: b.tabId }, func: pageAction, args: [message] });
    current(b, ws, message);
    const frame = Array.isArray(injected) ? injected[0] : undefined;
    // Chromium reports a thrown page error as a null result; Firefox reports `error` or rejects.
    if (!frame || frame.error || frame.result === undefined || frame.result === null) throw new Error("Page action failed");
    const after = await api.tabs.get(b.tabId);
    current(b, ws, message);
    if (originOf(after.url) !== b.origin) { unbind("Redirect changed origin; rebind required."); throw new Error("Origin changed"); }
    const response = { type: "result", id: message.id, generation: b.generation, ok: true, result: frame.result };
    if (message.action === "snapshot") boundSnapshot(response);
    if (new TextEncoder().encode(JSON.stringify(response)).length > 48000) throw new Error("Result exceeds limit");
    send(response);
  } finally { busy = false; }
}

function connect(url, token) {
  ready = false;
  if (socket) socket.close();
  const ws = new WebSocket(url);
  socket = ws;
  let opened = false;
  ws.onopen = () => { if (socket === ws) { opened = true; ws.send(JSON.stringify({ type: "auth", token })); } };
  ws.onclose = () => {
    if (socket !== ws) return;
    const authFailed = opened && !ready;
    ready = false; socket = null;
    unbind(!opened ? "Connection failed. Check Pi is running, then reconnect in options." : authFailed ? "Authentication failed; enter the current token in options." : "Disconnected; reconnect in options and bind again.");
    // A rejected token is stale (Pi restarted); stop retrying it on future worker starts.
    if (authFailed) void forget(["intent", "binding"]);
  };
  ws.onerror = () => { ws.close(); };
  ws.onmessage = event => {
    if (socket !== ws) return;
    try {
      if (typeof event.data !== "string" || new TextEncoder().encode(event.data).length > 64000) throw new Error("Invalid message");
      const msg = JSON.parse(event.data);
      if (!ready) {
        if (msg.type !== "ready") throw new Error("Authentication failed");
        ready = true; status = "Connected. Click toolbar on intended tab to bind.";
        if (pendingBind) void bindPending(ws, pendingBind);
        return;
      }
      // Application-level keepalive from Pi; receiving it keeps an MV3 service worker alive.
      if (msg.type === "heartbeat") return;
      if (msg.type !== "request") throw new Error("Unsupported message");
      run(msg, ws).catch(() => {
        if (socket === ws && ready) send({ type: "result", id: msg.id, generation: msg.generation, ok: false });
      });
    } catch { ws.close(); }
  };
}

// MV3 workers can be stopped when idle; resume the saved connection intent and tab on every worker start.
async function restore() {
  try {
    const saved = await store.get(["intent", "binding"]);
    if (!validIntent(saved.intent)) {
      if (saved.intent !== undefined || saved.binding !== undefined) await store.remove(["intent", "binding"]);
      return;
    }
    if (socket) return;
    const b = saved.binding;
    if (!pendingBind && b && Number.isInteger(b.tabId) && typeof b.origin === "string") pendingBind = { tabId: b.tabId, origin: b.origin };
    status = "Reconnecting to Pi.";
    connect(saved.intent.url, saved.intent.token);
  } catch { status = "Could not read saved connection; reconnect in options."; }
}

async function handleOptions(message, sender) {
  if (sender.id !== api.runtime.id || sender.url !== api.runtime.getURL("options.html") || !message || typeof message !== "object") throw new Error("Options page required");
  if (message.type === "status") return { status };
  if (message.type === "disconnect") {
    unbind("Disconnected by user."); ready = false;
    const ws = socket; socket = null;
    if (ws) ws.close();
    await forget(["intent", "binding"]);
    return { status };
  }
  if (message.type !== "connect" || message.url !== BRIDGE_URL || typeof message.token !== "string" || !/^[a-f0-9]{64}$/.test(message.token)) throw new Error("Use exact local URL and token from /browser-connect.");
  unbind("Connecting; a fresh toolbar bind will be required.");
  await persist({ intent: { url: message.url, token: message.token } });
  connect(message.url, message.token);
  return { status };
}

// Listeners are registered synchronously at top level so MV3 events can wake the worker.
api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleOptions(message, sender).then(sendResponse, () => sendResponse({ error: true }));
  return true;
});

api.action.onClicked.addListener(tab => {
  // Invalidate synchronously, before any awaited work, even when rebinding the same origin.
  const previousId = binding ? binding.tabId : pendingBind ? pendingBind.tabId : null;
  unbind("Tab unbound.");
  if (tab.id === previousId) return;
  let target;
  try {
    if (!Number.isInteger(tab.id)) throw new Error("Invalid tab");
    target = { tabId: tab.id, origin: originOf(tab.url) };
  } catch { status = "Cannot bind. Select an ordinary HTTP(S) tab."; return; }
  if (ready) {
    try { bindTab(target, "Bound to"); }
    catch { unbind("Cannot bind. Wait for any action to finish, then click again."); }
    return;
  }
  // Not authenticated yet: bind after the (re)connection completes, or ask for credentials if there is none.
  pendingBind = target;
  void restored.then(() => {
    if (pendingBind !== target || socket) return;
    pendingBind = null;
    api.runtime.openOptionsPage().catch(() => { status = "Open add-on preferences to connect."; });
  });
});
function tracked(id) {
  return (binding && binding.tabId === id) || (pendingBind && pendingBind.tabId === id);
}
api.tabs.onRemoved.addListener(id => { if (tracked(id)) unbind("Bound tab closed."); });
api.tabs.onUpdated.addListener((id, change) => {
  if (!tracked(id) || !change.url) return;
  const origin = binding ? binding.origin : pendingBind.origin;
  try { if (originOf(change.url) !== origin) unbind("Origin changed; fresh toolbar binding required."); }
  catch { unbind("Unsupported page; binding removed."); }
});
api.tabs.onReplaced?.addListener((_added, removed) => { if (tracked(removed)) unbind("Tab replaced; bind again."); });

const restored = restore();
