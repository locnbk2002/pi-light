"use strict";
// Pi Light bridge (Chromium MV3 service worker). Controls only tabs the user bound or Pi opened.
importScripts("cdp.js");

const BRIDGE_URL = "ws://127.0.0.1:19339";
const BOUND = "bound";
const NAME = /^[a-z0-9-]{1,32}$/;
const ACTIONS = ["tabs", "open", "close", "snapshot", "screenshot", "click", "hover", "fill", "press", "scroll", "waitFor", "console", "network", "evaluate", "navigate"];
const TABLESS = new Set(["tabs", "open"]);
const MAX_RESULT = 48000;
const MAX_SCREENSHOT_RESULT = 3 * 1024 * 1024 - 1024;
// Session storage is memory-only and hidden from content scripts.
const store = chrome.storage.session;
let socket = null;
let ready = false;
let busy = false;
let status = "Disconnected. Configure connection in add-on options.";
// name -> { name, kind: "bound" | "owned", tabId, origin, generation, keep }
const controlled = new Map();
// Tabs remembered across a worker restart, re-adopted once authentication completes.
let pendingBind = null;
let pendingOwned = [];
let groupId = null;
// Bumped whenever control is revoked; async open/bind/re-adoption re-check it after every await.
let epoch = 0;
// Tabs Pi created whose open has not finished registering: tabId -> keep.
const opening = new Map();
const revoked = e => e !== epoch || !ready;
// Bumped by every toolbar click and disconnect: an in-flight bind from an older selection must not register.
let bindRevision = 0;
// Target of the newest bind attempt; a stale bind of the same tab must not detach its debugger.
let latestBind = null;

function send(message) {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}
function persist(values) {
  return store.set(values).catch(() => { status = "Could not save connection state; worker restarts will need options again."; });
}
function forget(keys) {
  return store.remove(keys).catch(() => { status = "Could not clear saved connection state."; });
}
function originOf(url) {
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error("Only HTTP(S) tabs without URL credentials");
  return parsed.origin;
}
function validIntent(intent) {
  return Boolean(intent) && intent.url === BRIDGE_URL && typeof intent.token === "string" && /^[a-f0-9]{64}$/.test(intent.token);
}
function badge() {
  chrome.action.setBadgeText({ text: ready ? (controlled.size ? String(controlled.size) : "on") : "" }).catch(() => {});
}
function saveTabs() {
  const bound = controlled.get(BOUND);
  const owned = [...controlled.values()].filter(t => t.kind === "owned").map(({ name, tabId, keep }) => ({ name, tabId, keep }));
  void persist({ binding: bound ? { tabId: bound.tabId, origin: bound.origin } : null, owned });
}
function announce() {
  saveTabs();
  badge();
  if (ready) send({ type: "tabs", tabs: [...controlled.values()].map(({ name, generation, kind, origin }) => ({ name, generation, kind, origin })) });
}
function register(entry) {
  controlled.set(entry.name, { ...entry, generation: crypto.randomUUID() });
  announce();
}
function byTabId(tabId) {
  for (const t of controlled.values()) if (t.tabId === tabId) return t;
  return null;
}
/** Stops controlling a tab (it stays open). */
function release(t, reason) {
  if (controlled.get(t.name) !== t) return;
  controlled.delete(t.name);
  void detachDebugger(t.tabId);
  if (reason) status = reason;
  announce();
}
/** Pi is gone: close the tabs it opened without `keep` and stop controlling everything. */
function dropAll(reason) {
  epoch++;
  bindRevision++;
  latestBind = null;
  const close = [...controlled.values(), ...pendingOwned].filter(t => t.kind !== "bound" && !t.keep).map(t => t.tabId);
  for (const [tabId, keep] of opening) if (!keep) close.push(tabId);
  for (const t of controlled.values()) void detachDebugger(t.tabId);
  for (const tabId of opening.keys()) void detachDebugger(tabId);
  controlled.clear();
  opening.clear();
  pendingBind = null; pendingOwned = [];
  if (close.length) chrome.tabs.remove(close).catch(() => {});
  status = reason;
  void forget(["binding", "owned"]);
  badge();
}

async function bindTab(target, e = epoch, revision = bindRevision) {
  if (busy) throw new Error("Wait for the current action to finish before binding.");
  latestBind = target;
  const stale = () => revoked(e) || revision !== bindRevision;
  try {
    await attachDebugger(target.tabId);
    if (stale()) throw new Error("Selection changed");
    const tab = await chrome.tabs.get(target.tabId);
    if (stale()) throw new Error("Selection changed");
    if (originOf(tab.url) !== target.origin) throw new Error("Origin changed");
  } catch (error) {
    // Keep the debugger when the tab is controlled again or a newer bind of the same tab is in flight.
    const newer = latestBind !== target && latestBind?.tabId === target.tabId;
    if (!byTabId(target.tabId) && !newer) void detachDebugger(target.tabId);
    if (latestBind === target) latestBind = null;
    throw error;
  }
  if (latestBind === target) latestBind = null;
  const previous = controlled.get(BOUND);
  if (previous && previous.tabId !== target.tabId) void detachDebugger(previous.tabId);
  register({ name: BOUND, kind: "bound", tabId: target.tabId, origin: target.origin });
  status = `Bound to ${target.origin}. Click this tab's toolbar button again to unbind.`;
}
/** Re-adopts remembered tabs after a worker restart: each must still exist and show an allowed page. */
async function readopt() {
  const e = epoch;
  const bind = pendingBind;
  pendingBind = null;
  if (bind) {
    try { await bindTab(bind, e); }
    catch { status = "Previous tab binding could not be restored; click the toolbar to bind again."; }
  }
  // Each remembered tab stays in pendingOwned until handled, so a disconnect meanwhile still closes it.
  while (pendingOwned.length && !revoked(e)) {
    const o = pendingOwned[0];
    try {
      const tab = await chrome.tabs.get(o.tabId);
      if (revoked(e)) break;
      if (controlled.has(o.name)) throw new Error("Name in use");
      await attachDebugger(o.tabId);
      if (revoked(e)) { void detachDebugger(o.tabId); break; }
      register({ name: o.name, kind: "owned", tabId: o.tabId, origin: originOf(tab.url), keep: o.keep });
    } catch { /* tab gone or no longer debuggable: leave it uncontrolled */ }
    if (pendingOwned[0] === o) pendingOwned.shift();
  }
  if (!revoked(e)) announce();
}

async function openTab(message) {
  const origin = originOf(message.url);
  const name = message.name ?? "main";
  if (!NAME.test(name) || name === BOUND || controlled.has(name)) throw new Error("Tab name in use or invalid");
  const keep = message.keep === true;
  const e = epoch;
  const tab = await chrome.tabs.create({ url: message.url, active: false });
  // Tracked from creation, so a disconnect during the awaits below still closes it.
  opening.set(tab.id, keep);
  try {
    if (revoked(e)) throw new Error("Connection changed");
    await attachDebugger(tab.id);
    if (revoked(e)) throw new Error("Connection changed");
    try {
      groupId = await chrome.tabs.group({ tabIds: [tab.id], ...(groupId !== null ? { groupId } : {}) });
      await chrome.tabGroups.update(groupId, { title: "pi", color: "blue" });
    } catch {
      // The remembered group may be gone; retry once with a new group, and treat grouping as cosmetic.
      try { groupId = await chrome.tabs.group({ tabIds: [tab.id] }); await chrome.tabGroups.update(groupId, { title: "pi", color: "blue" }); } catch { groupId = null; }
    }
    if (revoked(e)) throw new Error("Connection changed");
    register({ name, kind: "owned", tabId: tab.id, origin, keep });
  } catch (error) {
    void detachDebugger(tab.id);
    // A revoked `keep` tab stays open, like any kept tab on disconnect.
    if (!(revoked(e) && keep)) chrome.tabs.remove(tab.id).catch(() => {});
    throw error;
  } finally { opening.delete(tab.id); }
  return { opened: name, origin, note: "Loading in background; use waitFor or snapshot next." };
}
async function listTabs() {
  const tabs = [];
  for (const t of controlled.values()) {
    const tab = await chrome.tabs.get(t.tabId).catch(() => null);
    tabs.push({ name: t.name, kind: t.kind, origin: t.origin, title: (tab?.title || "").slice(0, 200), keep: t.kind === "owned" ? t.keep : undefined });
  }
  return { tabs };
}

function errorText(error) {
  return String(error?.message || "Action failed").replace(/[^\w .,;:'()/-]/g, "").slice(0, 200) || "Action failed";
}
function validRequest(m) {
  if (typeof m.id !== "string" || !/^[a-f0-9]{32}$/.test(m.id) || !Number.isFinite(m.deadline) || m.deadline > Date.now() + 20000 || !ACTIONS.includes(m.action)) throw new Error("Invalid request");
  if (TABLESS.has(m.action)) return null;
  const t = typeof m.tab === "string" ? controlled.get(m.tab) : null;
  if (!t || m.generation !== t.generation) throw new Error("Tab changed; retry");
  return t;
}
function alive(ws, t, m) {
  if (!ready || socket !== ws || ws.readyState !== WebSocket.OPEN || Date.now() > m.deadline || (t && controlled.get(t.name) !== t)) throw new Error("Tab or connection changed");
}
async function checkOrigin(t) {
  const tab = await chrome.tabs.get(t.tabId);
  const origin = originOf(tab.url);
  if (t.kind === "bound" && origin !== t.origin) { release(t, "Origin changed; click toolbar to rebind."); throw new Error("Bound tab origin changed"); }
}

async function perform(m, t) {
  switch (m.action) {
    case "tabs": return listTabs();
    case "open": return openTab(m);
    case "close":
      // The tab is released and removed after the result is sent (see run), so Pi does not see it vanish mid-request.
      if (t.kind !== "owned") throw new Error("Only tabs opened by Pi can be closed");
      return { closed: t.name };
    case "snapshot": return m.mode === "ax" ? axSnapshot(t.tabId) : inPage(t.tabId, pageSnapshot);
    case "screenshot": return screenshot(t.tabId, m.fullPage === true);
    case "click": return click(t.tabId, m.selector);
    case "hover": return hover(t.tabId, m.selector);
    case "fill": return fill(t.tabId, m.selector, m.text);
    case "press": return press(t.tabId, m.key);
    case "scroll": return scroll(t.tabId, m.dy);
    case "waitFor": return waitFor(t.tabId, m, m.deadline);
    case "console": return recentLogs(sessions.get(t.tabId)?.console ?? []);
    case "network": return recentLogs(sessions.get(t.tabId)?.network ?? []);
    case "evaluate": return evaluate(t.tabId, m.code, m.deadline);
    case "navigate":
      if (t.kind === "bound" && originOf(m.url) !== t.origin) throw new Error("Bound tab navigation must stay on its origin");
      originOf(m.url);
      return navigate(t.tabId, m.url);
  }
  throw new Error("Unsupported action");
}

const bytes = value => new TextEncoder().encode(JSON.stringify(value)).length;
// Largest prefix of holder[key] (a string) whose complete wire envelope fits, without splitting a surrogate pair.
function trimString(response, holder, key) {
  const original = holder[key];
  let low = 0;
  let high = original.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    holder[key] = original.slice(0, middle);
    if (bytes(response) <= MAX_RESULT) low = middle;
    else high = middle - 1;
  }
  if (low > 0 && low < original.length && /[\uD800-\uDBFF]/.test(original[low - 1])) low--;
  holder[key] = original.slice(0, low);
}
// Largest run of whole entries of holder[key] that fits; `newest` keeps the end of the list.
// `onDrop` records the dropped count inside each measurement, so the count's own digits are budgeted too.
function trimList(response, holder, key, newest, onDrop = () => {}) {
  const original = holder[key];
  const take = n => { onDrop(original.length - n); return newest ? original.slice(original.length - n) : original.slice(0, n); };
  let low = 0;
  let high = original.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    holder[key] = take(middle);
    if (bytes(response) <= MAX_RESULT) low = middle;
    else high = middle - 1;
  }
  holder[key] = take(low);
  return original.length - low;
}
/** Shrinks a text-bearing result to the UTF-8 byte budget of the complete envelope instead of failing it. */
function fitResult(response, action) {
  if (bytes(response) <= MAX_RESULT) return;
  const r = response.result;
  if (action === "snapshot" && Array.isArray(r.lines)) { r.truncated = true; trimList(response, r, "lines", false); }
  else if (action === "snapshot") {
    r.truncated = true;
    trimString(response, r, "text");
    if (bytes(response) > MAX_RESULT) trimList(response, r, "controls", false);
    if (bytes(response) > MAX_RESULT) trimString(response, r, "title");
    if (bytes(response) > MAX_RESULT) trimString(response, r, "url");
  } else if ((action === "console" || action === "network") && Array.isArray(r.entries)) {
    const base = r.dropped;
    trimList(response, r, "entries", true, n => { r.dropped = base + n; });
  }
  else if (action === "evaluate" && "value" in r) {
    response.result = { truncated: true, json: JSON.stringify(r.value) };
    trimString(response, response.result, "json");
  }
}

async function run(m, ws) {
  if (busy) throw new Error("Another action is in progress");
  const t = validRequest(m);
  busy = true;
  try {
    alive(ws, t, m);
    if (t) { await checkOrigin(t); alive(ws, t, m); }
    const result = await perform(m, t);
    alive(ws, t, m);
    if (t && m.action !== "close") await checkOrigin(t).catch(() => {});
    // `type` and `id` lead the envelope: the bridge reads them to admit large screenshot frames.
    const response = { type: "result", id: m.id, ...(t ? { generation: m.generation } : {}), ok: true, result };
    if (m.action !== "screenshot") fitResult(response, m.action);
    const limit = m.action === "screenshot" ? MAX_SCREENSHOT_RESULT : MAX_RESULT;
    if (new TextEncoder().encode(JSON.stringify(response)).length > limit) throw new Error("Result exceeds limit");
    send(response);
    if (m.action === "close") { release(t); await chrome.tabs.remove(t.tabId).catch(() => {}); }
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
    dropAll(!opened ? "Connection failed. Check Pi is running, then reconnect in options." : authFailed ? "Authentication failed; enter the current token in options." : "Disconnected; Pi-opened tabs were closed. Reconnect in options.");
    // A rejected token is stale (Pi restarted); stop retrying it on future worker starts.
    if (authFailed) void forget(["intent"]);
  };
  ws.onerror = () => { ws.close(); };
  ws.onmessage = event => {
    if (socket !== ws) return;
    let msg;
    try {
      if (typeof event.data !== "string" || new TextEncoder().encode(event.data).length > 64000) throw new Error("Invalid message");
      msg = JSON.parse(event.data);
      if (!ready) {
        if (msg.type !== "ready") throw new Error("Authentication failed");
        ready = true; status = "Connected. Pi can open tabs; click the toolbar on a tab to bind it.";
        announce();
        void readopt();
        return;
      }
      // Application-level keepalive from Pi; receiving it keeps the MV3 service worker alive.
      if (msg.type === "heartbeat") return;
      if (msg.type !== "request") throw new Error("Unsupported message");
    } catch { ws.close(); return; }
    run(msg, ws).catch(error => {
      if (socket === ws && ready) send({ type: "result", id: msg.id, ...(TABLESS.has(msg.action) ? {} : { generation: msg.generation }), ok: false, error: errorText(error) });
    });
  };
}

// MV3 workers can be stopped when idle; resume the saved connection intent and tabs on every worker start.
async function restore() {
  try {
    const saved = await store.get(["intent", "binding", "owned"]);
    if (!validIntent(saved.intent)) {
      await store.remove(["intent", "binding", "owned"]);
      return;
    }
    if (socket) return;
    const b = saved.binding;
    if (!pendingBind && b && Number.isInteger(b.tabId) && typeof b.origin === "string") pendingBind = { tabId: b.tabId, origin: b.origin };
    if (Array.isArray(saved.owned)) pendingOwned = saved.owned.filter(o => o && Number.isInteger(o.tabId) && typeof o.name === "string" && NAME.test(o.name) && o.name !== BOUND).map(o => ({ name: o.name, tabId: o.tabId, keep: o.keep === true, kind: "owned" }));
    status = "Reconnecting to Pi.";
    connect(saved.intent.url, saved.intent.token);
  } catch { status = "Could not read saved connection; reconnect in options."; }
}

async function handleOptions(message, sender) {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("options.html") || !message || typeof message !== "object") throw new Error("Options page required");
  if (message.type === "status") return { status };
  if (message.type === "disconnect") {
    ready = false;
    const ws = socket; socket = null;
    if (ws) ws.close();
    dropAll("Disconnected by user; Pi-opened tabs were closed.");
    await forget(["intent"]);
    return { status };
  }
  if (message.type !== "connect" || message.url !== BRIDGE_URL || typeof message.token !== "string" || !/^[a-f0-9]{64}$/.test(message.token)) throw new Error("Use exact local URL and token from /browser-connect.");
  dropAll("Connecting; a fresh toolbar bind will be required.");
  await persist({ intent: { url: message.url, token: message.token } });
  connect(message.url, message.token);
  return { status };
}

// Listeners are registered synchronously at top level so MV3 events can wake the worker.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleOptions(message, sender).then(sendResponse, () => sendResponse({ error: true }));
  return true;
});

chrome.action.onClicked.addListener(tab => {
  // Invalidate synchronously, before any awaited work, even when rebinding the same origin.
  bindRevision++;
  const inFlight = latestBind;
  latestBind = null;
  const previous = controlled.get(BOUND);
  const previousId = previous ? previous.tabId : pendingBind ? pendingBind.tabId : inFlight ? inFlight.tabId : null;
  if (previous) release(previous, "Tab unbound.");
  pendingBind = null;
  if (tab.id === previousId) return;
  let target;
  try {
    if (!Number.isInteger(tab.id)) throw new Error("Invalid tab");
    if (byTabId(tab.id)) throw new Error("Already controlled");
    target = { tabId: tab.id, origin: originOf(tab.url) };
  } catch { status = "Cannot bind. Select an ordinary HTTP(S) tab that Pi does not already control."; return; }
  if (ready) {
    bindTab(target).catch(() => { status = "Cannot bind this tab (busy, protected page or another debugger)."; });
    return;
  }
  // Not authenticated yet: bind after the (re)connection completes, or ask for credentials if there is none.
  pendingBind = target;
  void restored.then(() => {
    if (pendingBind !== target || socket) return;
    pendingBind = null;
    chrome.runtime.openOptionsPage().catch(() => { status = "Open add-on options to connect."; });
  });
});
chrome.tabs.onRemoved.addListener(id => {
  const t = byTabId(id);
  if (t) release(t, `Tab ${t.name} closed.`);
  if (pendingBind && pendingBind.tabId === id) pendingBind = null;
});
chrome.tabs.onUpdated.addListener((id, change) => {
  const t = byTabId(id);
  if (!t || !change.url || change.url === "about:blank") return;
  let origin;
  try { origin = originOf(change.url); } catch { release(t, `Tab ${t.name} left HTTP(S); control released.`); return; }
  if (t.kind === "bound" && origin !== t.origin) release(t, "Origin changed; fresh toolbar binding required.");
  else if (t.kind === "owned" && origin !== t.origin) { t.origin = origin; announce(); }
});
chrome.tabs.onReplaced.addListener((_added, removed) => { const t = byTabId(removed); if (t) release(t, "Tab replaced; control released."); });
chrome.debugger.onEvent.addListener(onCdpEvent);
// The user dismissed the debugging bar, DevTools took over, or the target went away: stop controlling the tab.
chrome.debugger.onDetach.addListener(source => {
  if (!sessions.delete(source.tabId)) return;
  const t = byTabId(source.tabId);
  if (t) release(t, `Debugger detached from ${t.name}; control released.`);
});

const restored = restore();
