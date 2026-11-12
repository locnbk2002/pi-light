"use strict";
// Pi Light bridge (Chromium MV3 service worker). Controls only tabs the user bound or Pi opened.
// Connects on its own to the local Pi Light relay, which every running Pi session joins; each session
// gets its own Pi-opened tabs, and the tab bound from the toolbar is shared by all of them. The relay and
// this add-on prove a pairing secret (pasted once into the options) to each other before anything flows.
importScripts("cdp.js");

const BRIDGE_URL = "ws://127.0.0.1:19339/ext";
const BOUND = "bound";
const NAME = /^[a-z0-9-]{1,32}$/;
const SESSION = /^[a-f0-9]{32}$/;
const NONCE = /^[a-f0-9]{32}$/;
const PAIRING = /^[a-f0-9]{64}$/;
const ACTIONS = ["tabs", "open", "close", "snapshot", "screenshot", "click", "hover", "fill", "press", "scroll", "waitFor", "console", "network", "evaluate", "navigate"];
const TABLESS = new Set(["tabs", "open"]);
const MAX_RESULT = 48000;
const MAX_SCREENSHOT_RESULT = 3 * 1024 * 1024 - 1024;
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 5000;
// Session storage is memory-only and hidden from content scripts.
const store = chrome.storage.session;
let socket = null;
let ready = false;
let busy = false;
let enabled = true;
// Pairing secret from the options page; kept in local storage so it survives browser restarts.
let pairing = null;
let reconnectDelay = RECONNECT_MIN_MS;
let reconnectTimer = null;
let status = "Waiting for Pi. Start Pi; the add-on connects on its own.";
// Pi sessions currently joined to the relay: session -> incarnation. A rejoin under the same id gets a new
// incarnation, so work queued by an earlier connection of that session can never run.
const live = new Map();
let incarnations = 0;
const joinSession = session => live.set(session, ++incarnations);
// key -> { name, kind: "bound" | "owned", session (owned), tabId, origin, generation, keep }
const controlled = new Map();
// Tabs remembered across a worker restart, re-adopted once the relay connection is ready.
let pendingBind = null;
let pendingOwned = [];
let groupId = null;
// Bumped whenever all control is revoked; async open/bind/re-adoption re-check it after every await.
let epoch = 0;
// Tabs Pi created whose open has not finished registering: tabId -> { keep, session }.
const opening = new Map();
const revoked = e => e !== epoch || !ready;
// Bumped by every toolbar click and disconnect: an in-flight bind from an older selection must not register.
let bindRevision = 0;
// Target of the newest bind attempt; a stale bind of the same tab must not detach its debugger.
let latestBind = null;
// Requests from all sessions run one at a time, in arrival order.
let queue = Promise.resolve();

const keyOf = (session, name) => name === BOUND ? BOUND : `${session}/${name}`;

function send(message) {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}
function persist(values) {
  return store.set(values).catch(() => { status = "Could not save tab state; a worker restart may release tabs."; });
}
function forget(keys) {
  return store.remove(keys).catch(() => { status = "Could not clear saved tab state."; });
}
function originOf(url) {
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error("Only HTTP(S) tabs without URL credentials");
  return parsed.origin;
}
function badge() {
  chrome.action.setBadgeText({ text: ready ? (controlled.size ? String(controlled.size) : "on") : "" }).catch(() => {});
}
function saveTabs() {
  const bound = controlled.get(BOUND) ?? pendingBind;
  // Remembered tabs not yet re-adopted stay saved, so another worker restart can still recover them.
  const owned = [...controlled.values(), ...pendingOwned].filter(t => t.kind === "owned").map(({ name, session, tabId, keep }) => ({ name, session, tabId, keep }));
  void persist({ binding: bound ? { tabId: bound.tabId, origin: bound.origin } : null, owned });
}
function tabsFor(session) {
  return [...controlled.values()].filter(t => t.kind === "bound" || t.session === session).map(({ name, generation, kind, origin }) => ({ name, generation, kind, origin }));
}
/** Sends each live session its own view: its Pi-opened tabs plus the shared bound tab. */
function announce(only) {
  saveTabs();
  badge();
  if (!ready) return;
  for (const session of only ? [only] : live.keys()) send({ type: "tabs", session, tabs: tabsFor(session) });
}
function register(entry) {
  controlled.set(keyOf(entry.session, entry.name), { ...entry, generation: crypto.randomUUID() });
  announce(entry.kind === "owned" ? entry.session : undefined);
}
function byTabId(tabId) {
  for (const t of controlled.values()) if (t.tabId === tabId) return t;
  return null;
}
/** Stops controlling a tab (it stays open). */
function release(t, reason) {
  const key = keyOf(t.session, t.name);
  if (controlled.get(key) !== t) return;
  controlled.delete(key);
  void detachDebugger(t.tabId);
  if (reason) status = reason;
  announce(t.kind === "owned" ? t.session : undefined);
}
/** A Pi session left: close the tabs it opened without `keep` and stop controlling its tabs. */
function endSession(session) {
  live.delete(session);
  const close = [];
  for (const [key, t] of controlled) {
    if (t.session !== session) continue;
    controlled.delete(key);
    void detachDebugger(t.tabId);
    if (!t.keep) close.push(t.tabId);
  }
  for (const [tabId, o] of opening) if (o.session === session && !o.keep) close.push(tabId);
  pendingOwned = pendingOwned.filter(o => { if (o.session !== session) return true; if (!o.keep) close.push(o.tabId); return false; });
  if (close.length) chrome.tabs.remove(close).catch(() => {});
  announce();
}
/** The relay is gone: close every tab Pi opened without `keep` and stop controlling everything. */
function dropAll(reason) {
  epoch++;
  bindRevision++;
  latestBind = null;
  live.clear();
  const close = [...controlled.values(), ...pendingOwned].filter(t => t.kind !== "bound" && !t.keep).map(t => t.tabId);
  for (const [tabId, o] of opening) if (!o.keep) close.push(tabId);
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
  status = `Bound to ${target.origin} for every Pi session. Click this tab's toolbar button again to unbind.`;
}
/** Re-adopts remembered tabs after a worker restart: each must still exist, show an allowed page and belong to a live session. */
async function readopt() {
  const e = epoch;
  const bind = pendingBind;
  pendingBind = null;
  if (bind) {
    try { await bindTab(bind, e); }
    catch { status = "Previous tab binding could not be restored; click the toolbar to bind again."; }
  }
  // Each remembered tab stays in pendingOwned until handled, so a disconnect meanwhile still closes it.
  // Only a global revocation stops the loop: one session ending must not strand another session's tabs.
  while (pendingOwned.length && !revoked(e)) {
    const o = pendingOwned[0];
    const incarnation = live.get(o.session);
    const gone = () => live.get(o.session) !== incarnation;
    try {
      if (incarnation === undefined) {
        // Its Pi session ended while the worker was stopped.
        if (!o.keep) chrome.tabs.remove(o.tabId).catch(() => {});
        throw new Error("Session gone");
      }
      const tab = await chrome.tabs.get(o.tabId);
      if (revoked(e)) break;
      if (gone()) throw new Error("Session gone");
      if (controlled.has(keyOf(o.session, o.name))) throw new Error("Name in use");
      await attachDebugger(o.tabId);
      if (revoked(e)) { void detachDebugger(o.tabId); break; }
      if (gone()) { void detachDebugger(o.tabId); throw new Error("Session gone"); }
      if (pendingOwned[0] === o) pendingOwned.shift();
      register({ name: o.name, kind: "owned", session: o.session, tabId: o.tabId, origin: originOf(tab.url), keep: o.keep });
    } catch { /* tab gone, session gone or no longer debuggable: leave it uncontrolled */ }
    if (pendingOwned[0] === o) { pendingOwned.shift(); saveTabs(); }
  }
  if (!revoked(e)) announce();
}

async function openTab(message) {
  const origin = originOf(message.url);
  const session = message.session;
  const name = message.name ?? "main";
  if (!NAME.test(name) || name === BOUND || controlled.has(keyOf(session, name))) throw new Error("Tab name in use or invalid");
  const keep = message.keep === true;
  const e = epoch;
  const incarnation = live.get(session);
  const gone = () => revoked(e) || incarnation === undefined || live.get(session) !== incarnation;
  const tab = await chrome.tabs.create({ url: message.url, active: false });
  // Tracked from creation, so a disconnect during the awaits below still closes it.
  opening.set(tab.id, { keep, session });
  try {
    if (gone()) throw new Error("Connection changed");
    await attachDebugger(tab.id);
    if (gone()) throw new Error("Connection changed");
    try {
      groupId = await chrome.tabs.group({ tabIds: [tab.id], ...(groupId !== null ? { groupId } : {}) });
      await chrome.tabGroups.update(groupId, { title: "pi", color: "blue" });
    } catch {
      // The remembered group may be gone; retry once with a new group, and treat grouping as cosmetic.
      try { groupId = await chrome.tabs.group({ tabIds: [tab.id] }); await chrome.tabGroups.update(groupId, { title: "pi", color: "blue" }); } catch { groupId = null; }
    }
    if (gone()) throw new Error("Connection changed");
    if (controlled.has(keyOf(session, name))) throw new Error("Tab name in use or invalid");
    register({ name, kind: "owned", session, tabId: tab.id, origin, keep });
  } catch (error) {
    void detachDebugger(tab.id);
    // A revoked `keep` tab stays open, like any kept tab on disconnect.
    if (!(gone() && keep)) chrome.tabs.remove(tab.id).catch(() => {});
    throw error;
  } finally { opening.delete(tab.id); }
  return { opened: name, origin, note: "Loading in background; use waitFor or snapshot next." };
}
async function listTabs(session) {
  const tabs = [];
  for (const t of controlled.values()) {
    if (t.kind !== "bound" && t.session !== session) continue;
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
  if (typeof m.session !== "string" || m.incarnation === undefined || live.get(m.session) !== m.incarnation) throw new Error("Pi session not joined");
  if (TABLESS.has(m.action)) return null;
  const t = typeof m.tab === "string" && NAME.test(m.tab) ? controlled.get(keyOf(m.session, m.tab)) : null;
  if (!t || m.generation !== t.generation) throw new Error("Tab changed; retry");
  return t;
}
function alive(ws, t, m) {
  if (!ready || socket !== ws || ws.readyState !== WebSocket.OPEN || live.get(m.session) !== m.incarnation || Date.now() > m.deadline || (t && controlled.get(keyOf(t.session, t.name)) !== t)) throw new Error("Tab or connection changed");
}
async function checkOrigin(t) {
  const tab = await chrome.tabs.get(t.tabId);
  const origin = originOf(tab.url);
  if (t.kind === "bound" && origin !== t.origin) { release(t, "Origin changed; click toolbar to rebind."); throw new Error("Bound tab origin changed"); }
}

async function perform(m, t) {
  switch (m.action) {
    case "tabs": return listTabs(m.session);
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
    // `type` and `id` lead the envelope: Pi reads them to admit large screenshot frames (the relay strips `session`).
    const response = { type: "result", id: m.id, session: m.session, ...(t ? { generation: m.generation } : {}), ok: true, result };
    if (m.action !== "screenshot") fitResult(response, m.action);
    const limit = m.action === "screenshot" ? MAX_SCREENSHOT_RESULT : MAX_RESULT;
    if (new TextEncoder().encode(JSON.stringify(response)).length > limit) throw new Error("Result exceeds limit");
    send(response);
    // Not awaited: the next request may arrive as soon as Pi has the result.
    if (m.action === "close") { release(t); chrome.tabs.remove(t.tabId).catch(() => {}); }
  } finally { busy = false; }
}
function enqueue(m, ws) {
  // Bound to the session's connection at arrival; overwrites any value the request carried.
  m.incarnation = typeof m.session === "string" ? live.get(m.session) : undefined;
  const job = queue.then(() => run(m, ws));
  queue = job.catch(() => {});
  job.catch(error => {
    if (socket === ws && ready && typeof m.session === "string") send({ type: "result", id: m.id, session: m.session, ...(TABLESS.has(m.action) ? {} : { generation: m.generation }), ok: false, error: errorText(error) });
  });
}

function randomHex(bytes) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map(b => b.toString(16).padStart(2, "0")).join("");
}
/** HMAC-SHA256 over the `|`-joined parts, keyed by the hex pairing secret (matches the relay's pairingProof). */
async function hmac(secret, ...parts) {
  const raw = new Uint8Array(secret.match(/../g).map(h => parseInt(h, 16)));
  const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(parts.join("|"))));
  return [...signature].map(b => b.toString(16).padStart(2, "0")).join("");
}
function sameText(a, b) {
  if (typeof a !== "string" || a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}
function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  if (!enabled || !pairing) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
}
function connect() {
  if (!pairing) { status = "Not paired. Run /browser-connect in Pi and paste the pairing secret into these options."; return; }
  if (!enabled || (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING))) return;
  ready = false;
  const ws = new WebSocket(BRIDGE_URL);
  socket = ws;
  let opened = false;
  // Relay proof expected for this connection; set before our proof is sent, so the reply can be checked at once.
  let expected = null;
  let challenged = false;
  let failure = null;
  const secret = pairing;
  ws.onopen = () => { if (socket === ws) opened = true; };
  ws.onclose = () => {
    if (socket !== ws) return;
    const wasReady = ready;
    ready = false; socket = null;
    const waiting = "Waiting for Pi. Start Pi; the add-on connects on its own.";
    const reason = wasReady ? "Pi relay stopped; Pi-opened tabs were closed. Reconnecting when Pi runs again." : failure ?? (challenged ? "Pairing rejected. Run /browser-connect in Pi and paste the current pairing secret here." : waiting);
    if (wasReady || opened || controlled.size || pendingOwned.length || opening.size) dropAll(reason);
    else { pendingBind = null; status = reason; badge(); }
    scheduleReconnect();
  };
  ws.onerror = () => { ws.close(); };
  ws.onmessage = event => {
    if (socket !== ws) return;
    let msg;
    try {
      if (typeof event.data !== "string" || new TextEncoder().encode(event.data).length > 64000) throw new Error("Invalid message");
      msg = JSON.parse(event.data);
      if (!ready) {
        if (msg.type === "challenge" && !challenged && typeof msg.nonce === "string" && NONCE.test(msg.nonce)) {
          challenged = true;
          const nonce = randomHex(16);
          void Promise.all([hmac(secret, "ext", msg.nonce, nonce, ""), hmac(secret, "relay", "ext", msg.nonce, nonce, "")]).then(([proof, relayProof]) => {
            if (socket !== ws) return;
            expected = relayProof;
            ws.send(JSON.stringify({ type: "auth", nonce, proof }));
          }).catch(() => ws.close());
          return;
        }
        // Whatever holds the port must prove the pairing secret before Pi requests are trusted.
        if (msg.type !== "ready" || !expected || !sameText(msg.proof, expected) || !Array.isArray(msg.sessions)) {
          failure = "The program on port 19339 could not prove the pairing secret; it is not this Pi.";
          throw new Error("Unexpected relay");
        }
        ready = true; reconnectDelay = RECONNECT_MIN_MS;
        for (const s of msg.sessions) if (typeof s === "string" && SESSION.test(s)) joinSession(s);
        status = "Connected. Pi can open tabs; click the toolbar on a tab to bind it for every Pi session.";
        announce();
        void readopt();
        return;
      }
      // Application-level keepalive from the relay; receiving it keeps the MV3 service worker alive.
      if (msg.type === "heartbeat") return;
      if (msg.type === "session") {
        if (typeof msg.session !== "string" || !SESSION.test(msg.session)) throw new Error("Invalid session");
        if (msg.open === true) { joinSession(msg.session); announce(msg.session); }
        else endSession(msg.session);
        return;
      }
      if (msg.type !== "request") throw new Error("Unsupported message");
    } catch { ws.close(); return; }
    enqueue(msg, ws);
  };
}

// MV3 workers can be stopped when idle; resume the remembered tabs and the connection on every worker start.
async function restore() {
  try {
    const settings = await chrome.storage.local.get({ enabled: true, pairing: null });
    enabled = settings.enabled !== false;
    pairing = typeof settings.pairing === "string" && PAIRING.test(settings.pairing) ? settings.pairing : null;
    const saved = await store.get(["binding", "owned"]);
    if (!enabled) { await store.remove(["binding", "owned"]); status = "Disabled in options."; return; }
    if (socket) return;
    const b = saved.binding;
    if (!pendingBind && b && Number.isInteger(b.tabId) && typeof b.origin === "string") pendingBind = { tabId: b.tabId, origin: b.origin };
    if (Array.isArray(saved.owned)) pendingOwned = saved.owned.filter(o => o && Number.isInteger(o.tabId) && typeof o.name === "string" && NAME.test(o.name) && o.name !== BOUND && typeof o.session === "string" && SESSION.test(o.session)).map(o => ({ name: o.name, session: o.session, tabId: o.tabId, keep: o.keep === true, kind: "owned" }));
    connect();
  } catch { status = "Could not read saved state; reload the add-on."; }
}

async function handleOptions(message, sender) {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("options.html") || !message || typeof message !== "object") throw new Error("Options page required");
  if (message.type === "status") return { status, enabled, paired: Boolean(pairing) };
  if (message.type === "pair") {
    if (typeof message.secret !== "string" || !PAIRING.test(message.secret)) throw new Error("Invalid pairing secret");
    await chrome.storage.local.set({ pairing: message.secret });
    pairing = message.secret;
    // A new pairing replaces any current connection.
    ready = false;
    const ws = socket; socket = null;
    if (ws) ws.close();
    dropAll("Paired; connecting to Pi.");
    reconnectDelay = RECONNECT_MIN_MS;
    connect();
    return { status, enabled, paired: true };
  }
  if (message.type === "disable") {
    enabled = false;
    clearTimeout(reconnectTimer);
    await chrome.storage.local.set({ enabled: false });
    ready = false;
    const ws = socket; socket = null;
    if (ws) ws.close();
    dropAll("Disabled by user; Pi-opened tabs were closed.");
    return { status, enabled, paired: Boolean(pairing) };
  }
  if (message.type === "enable") {
    enabled = true;
    reconnectDelay = RECONNECT_MIN_MS;
    await chrome.storage.local.set({ enabled: true });
    status = "Connecting to Pi.";
    connect();
    return { status, enabled, paired: Boolean(pairing) };
  }
  throw new Error("Unsupported options message");
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
  // Not connected yet: bind once the relay connection is ready; a failed connection drops the request.
  pendingBind = target;
  if (!enabled) { pendingBind = null; status = "Disabled in options; enable it to bind tabs."; return; }
  void restored.then(() => { if (pendingBind === target) connect(); });
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
  else if (t.kind === "owned" && origin !== t.origin) { t.origin = origin; announce(t.session); }
});
chrome.tabs.onReplaced.addListener((_added, removed) => { const t = byTabId(removed); if (t) release(t, "Tab replaced; control released."); });
chrome.debugger.onEvent.addListener(onCdpEvent);
// The user dismissed the debugging bar, DevTools took over, or the target went away: stop controlling the tab.
chrome.debugger.onDetach.addListener(source => {
  if (!sessions.delete(source.tabId)) return;
  const t = byTabId(source.tabId);
  if (t) release(t, `Debugger detached from ${t.name}; control released.`);
});
// A stopped worker has no timers; the alarm wakes it to retry the relay while Pi is not running.
chrome.alarms.create("pi-light-reconnect", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === "pi-light-reconnect") void restored.then(connect); });

const restored = restore();
