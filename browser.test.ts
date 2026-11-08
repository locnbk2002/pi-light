import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { WebSocket } from "ws";
import { BrowserBridge, registerBrowserTools } from "./browser-bridge.js";
import { BROWSER_ADDON_FILES, buildBrowserAddon } from "./setup.mjs";
import { type ControlledTab, MAX_MESSAGE_BYTES, isMutation, validTabs, validateAction, validExtensionOrigin } from "./browser-policy.js";

const EXT = `chrome-extension://${"abcdefghijklmnop".repeat(2)}`;
const origin = "https://example.com";
const bound: ControlledTab = { name: "bound", generation: "generation-1", kind: "bound", origin };
const owned: ControlledTab = { name: "main", generation: "generation-2", kind: "owned", origin };
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const until = async (check: () => unknown, what: string) => {
  for (let n = 0; n < 200; n++) { if (check()) return; await delay(5); }
  assert.fail(`Timed out waiting for ${what}`);
};

/** Authenticated raw client that announces `tabs`. */
async function client(bridge: BrowserBridge, tabs: ControlledTab[] = [bound], token = bridge.connectionInfo().token) {
  const ws = new WebSocket(bridge.connectionInfo().url, { origin: EXT });
  await once(ws, "open");
  const reply = once(ws, "message");
  ws.send(JSON.stringify({ type: "auth", token }));
  await reply;
  ws.send(JSON.stringify({ type: "tabs", tabs }));
  await until(() => bridge.tabs.length === tabs.length, "tab announcement");
  return ws;
}
// Values created inside the add-on VM have foreign prototypes; compare their JSON form.
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const nextRequest = async (ws: WebSocket) => JSON.parse((await once(ws, "message"))[0].toString());

test("startup cancellation, repeated shutdown and overlapping restart settle deterministically", { timeout: 3000 }, async t => {
  const bridge = new BrowserBridge(19341);
  t.after(() => bridge.close());
  const started = bridge.start();
  assert.equal(bridge.start(), started);
  const cancelled = assert.rejects(started, /cancel|shutdown/i);
  const closing = bridge.close();
  const repeated = bridge.close();
  const restarted = bridge.start();
  assert.equal(bridge.start(), restarted);
  await cancelled;
  // Settling the cancelled start must not clear the newer startup promise.
  assert.equal(bridge.start(), restarted);
  await Promise.all([closing, repeated, restarted]);
  await bridge.start();
  let ws = await client(bridge);
  const disconnected = once(ws, "close");
  await bridge.close();
  await disconnected;
  assert.deepEqual(bridge.tabs, []);
  await bridge.close();
  // A queued restart is itself cancellable before the previous close finishes.
  await bridge.start();
  const stopping = bridge.close();
  const queued = bridge.start();
  const queuedCancelled = assert.rejects(queued, /cancel|shutdown/i);
  const stoppingAgain = bridge.close();
  await Promise.all([stopping, stoppingAgain, queuedCancelled]);
  await bridge.start();
  ws = await client(bridge);
  const incoming = nextRequest(ws);
  const result = bridge.request({ action: "snapshot" }, bound);
  const request = await incoming;
  ws.send(JSON.stringify({ type: "result", id: request.id, generation: bound.generation, ok: true, result: { text: "restarted" } }));
  assert.deepEqual(await result, { text: "restarted" });
});

test("failed listen can close repeatedly and restart after the port is released", { timeout: 3000 }, async t => {
  const blocker = new BrowserBridge(19343);
  const bridge = new BrowserBridge(19343);
  t.after(async () => { await bridge.close(); await blocker.close(); });
  await blocker.start();
  await assert.rejects(bridge.start(), /unavailable/);
  await Promise.all([bridge.close(), bridge.close(), blocker.close()]);
  await bridge.start();
  await client(bridge);
  assert.deepEqual(bridge.tabs, [bound]);
});

test("browser policy restricts actions, fields, keys, URLs and origins", () => {
  assert.deepEqual(validateAction({ action: "snapshot" }), { action: "snapshot" });
  assert.deepEqual(validateAction({ action: "navigate", url: `${origin}/next` }, bound), { action: "navigate", url: `${origin}/next` });
  assert.deepEqual(validateAction({ action: "navigate", url: "https://other.test/" }, owned), { action: "navigate", url: "https://other.test/" });
  assert.deepEqual(validateAction({ action: "open", url: "http://localhost:3000/", name: "app", keep: true }), { action: "open", url: "http://localhost:3000/", name: "app", keep: true });
  for (const ok of [{ action: "press", key: "Enter" }, { action: "press", key: "a" }, { action: "waitFor", text: "Done", timeoutMs: 8000 }, { action: "evaluate", code: "document.title" }, { action: "fill", selector: "input", text: "" }, { action: "screenshot", fullPage: true }, { action: "snapshot", mode: "ax" }]) assert.deepEqual(validateAction(ok), ok);
  const bad = [
    { action: "eval", code: "alert(1)" }, { action: "snapshot", selector: "body" }, { action: "click", selector: "" }, { action: "click", selector: "a".repeat(513) },
    { action: "fill", selector: "input", text: "x".repeat(8001) }, { action: "navigate", url: "javascript:alert(1)" }, { action: "navigate", url: "https://name:secret@example.com/" },
    { action: "open", url: "file:///etc/passwd" }, { action: "open", url: "data:text/html,x" }, { action: "open", url: `${origin}/`, name: "bound" }, { action: "open", url: `${origin}/`, name: "Bad Name" },
    { action: "press", key: "F13" }, { action: "press", key: "ab" }, { action: "waitFor" }, { action: "waitFor", selector: "a", text: "b" }, { action: "waitFor", text: "x", timeoutMs: 9000 },
    { action: "scroll", dy: Infinity }, { action: "evaluate", code: "" }, { action: "evaluate", code: "x".repeat(8001) }, { action: "snapshot", tab: "../x" }, { action: "snapshot", mode: "html" }, { action: "snapshot", tab: undefined }
  ];
  for (const value of bad) assert.throws(() => validateAction(value), Error, JSON.stringify(value));
  assert.throws(() => validateAction({ action: "navigate", url: "https://other.test/" }, bound), /origin/);
  assert.throws(() => validateAction({ action: "close" }, bound), /opened by Pi/);
  assert.equal(validateAction({ action: "close" }, owned).action, "close");
  for (const a of ["open", "close", "click", "fill", "press", "navigate", "evaluate"]) assert.equal(isMutation({ action: a } as never), true, a);
  for (const a of ["tabs", "snapshot", "screenshot", "hover", "scroll", "waitFor", "console", "network"]) assert.equal(isMutation({ action: a } as never), false, a);
  assert.equal(validExtensionOrigin(EXT), true);
  for (const value of [undefined, "null", "https://example.com", "moz-extension://1234-abcd", "chrome-extension://short", `chrome-extension://${"q".repeat(32)}`, `${EXT}/path`]) assert.equal(validExtensionOrigin(value), false);
  assert.deepEqual(validTabs([bound, owned]), [bound, owned]);
  for (const tabs of [[{ ...owned, name: "bound" }], [{ ...bound, name: "main" }], [owned, owned], [{ ...owned, origin: "https://example.com/path" }], [{ ...owned, kind: "other" }], "x"]) assert.throws(() => validTabs(tabs));
});

test("real loopback protocol: auth, origin, tab announcements, generations, timeout, bounds and shutdown", async t => {
  const bridge = new BrowserBridge(19340, 100);
  t.after(async () => { await bridge.close(); });
  await bridge.start();
  const conflict = new BrowserBridge(19340);
  await assert.rejects(conflict.start(), /unavailable/);
  await conflict.close();
  const bad = new WebSocket(bridge.connectionInfo().url, { origin: EXT });
  await once(bad, "open");
  const closed = once(bad, "close");
  let messages = 0;
  bad.on("message", () => messages++);
  bad.send(JSON.stringify({ type: "auth", token: "incorrect" }));
  await closed;
  assert.equal(messages, 0);
  const unauthenticated = new WebSocket(bridge.connectionInfo().url, { origin: EXT });
  await once(unauthenticated, "open");
  const unauthorizedClose = once(unauthenticated, "close");
  unauthenticated.on("message", () => messages++);
  unauthenticated.send(JSON.stringify({ type: "tabs", tabs: [bound] }));
  await unauthorizedClose;
  assert.equal(messages, 0);
  assert.deepEqual(bridge.tabs, []);
  for (const foreign of ["https://evil.test", "moz-extension://test-extension"]) {
    const page = new WebSocket(bridge.connectionInfo().url, { origin: foreign });
    await once(page, "error");
  }
  let ws = await client(bridge, [bound, owned]);
  assert.equal(bridge.resolveTab()?.name, "bound");
  assert.equal(bridge.resolveTab("main")?.kind, "owned");
  assert.equal(bridge.resolveTab("nope"), undefined);
  let incoming = nextRequest(ws);
  const result = bridge.request({ action: "snapshot", tab: "main" }, owned);
  let request = await incoming;
  assert.equal(request.action, "snapshot");
  assert.equal(request.tab, "main");
  assert.equal(request.generation, owned.generation);
  assert.equal("token" in request, false);
  // A result carrying another generation is ignored.
  ws.send(JSON.stringify({ type: "result", id: request.id, generation: bound.generation, ok: true, result: { text: "wrong" } }));
  ws.send(JSON.stringify({ type: "result", id: request.id, generation: owned.generation, ok: true, result: { text: "hello" } }));
  assert.deepEqual(await result, { text: "hello" });
  // Tabless actions carry no generation.
  incoming = nextRequest(ws);
  const opened = bridge.request({ action: "open", url: `${origin}/x`, name: "second" });
  request = await incoming;
  assert.equal("generation" in request, false);
  ws.send(JSON.stringify({ type: "result", id: request.id, ok: false, error: "Tab name in use or invalid" }));
  await assert.rejects(opened, /Browser action failed: Tab name in use or invalid/);
  // A pending request on a tab that vanishes is rejected; requests on other tabs are not affected.
  incoming = nextRequest(ws);
  const pending = bridge.request({ action: "click", selector: "button" }, bound);
  const rejected = assert.rejects(pending, /tab changed/);
  await incoming;
  ws.send(JSON.stringify({ type: "tabs", tabs: [{ ...bound, generation: "generation-3" }, owned] }));
  await rejected;
  await assert.rejects(bridge.request({ action: "snapshot" }, bound), /changed or absent/);
  await assert.rejects(bridge.request({ action: "navigate", url: "https://other.test/" }, bridge.resolveTab("bound")), /origin/);
  // Large frames are only admitted as a pending screenshot result.
  const oversized = JSON.stringify({ type: "result", id: "0".repeat(32), ok: true, result: { data: "A".repeat(MAX_MESSAGE_BYTES) } });
  incoming = nextRequest(ws);
  const shot = bridge.request({ action: "screenshot", tab: "main" }, owned);
  request = await incoming;
  ws.send(oversized.replace("0".repeat(32), request.id).replace('"ok"', `"generation":"${owned.generation}","ok"`));
  assert.equal(((await shot) as { data: string }).data.length, MAX_MESSAGE_BYTES);
  const oversizedClose = once(ws, "close");
  ws.send(oversized);
  await oversizedClose;
  assert.deepEqual(bridge.tabs, []);
  ws = await client(bridge);
  incoming = nextRequest(ws);
  const disconnected = assert.rejects(bridge.request({ action: "snapshot" }, bound), /disconnected/);
  await incoming;
  ws.close(); await disconnected;
  ws = await client(bridge);
  await assert.rejects(bridge.request({ action: "snapshot" }, bound), /timed out/);
  await delay(10);
  ws = await client(bridge);
  incoming = nextRequest(ws);
  const aborter = new AbortController();
  const cancelled = assert.rejects(bridge.request({ action: "snapshot" }, bound, aborter.signal), /cancelled/);
  await incoming; aborter.abort(); await cancelled;
  await delay(10);
  ws = await client(bridge);
  incoming = nextRequest(ws);
  const shutdown = assert.rejects(bridge.request({ action: "snapshot" }, bound), /shutdown/);
  await incoming; await bridge.close(); await shutdown;
  await bridge.close();
});

test("bridge sends heartbeats only to authenticated clients", { timeout: 3000 }, async t => {
  const bridge = new BrowserBridge(19345, 1000, 20);
  t.after(() => bridge.close());
  assert.throws(() => new BrowserBridge(19346, 1000, 0), /heartbeat/);
  await bridge.start();
  const ws = new WebSocket(bridge.connectionInfo().url, { origin: EXT });
  await once(ws, "open");
  const received: Array<{ type: string }> = [];
  ws.on("message", raw => received.push(JSON.parse(raw.toString())));
  await delay(80);
  assert.equal(received.length, 0, "unauthenticated client received data");
  ws.send(JSON.stringify({ type: "auth", token: bridge.connectionInfo().token }));
  await until(() => received.filter(m => m.type === "heartbeat").length >= 2, "heartbeats");
  assert.equal(received[0].type, "ready");
  assert.ok(received.slice(1).every(m => m.type === "heartbeat"));
  ws.send(JSON.stringify({ type: "tabs", tabs: [bound] }));
  await until(() => bridge.tabs.length === 1, "tabs");
});

const readManifest = async () => JSON.parse(await readFile(new URL("./browser-addon/manifest.json", import.meta.url), "utf8"));

test("Chromium MV3 manifest: debugger without host access, fixed CSP, no Firefox leftovers", async () => {
  const manifest = await readManifest();
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ["debugger", "tabs", "tabGroups", "storage"]);
  for (const key of ["host_permissions", "optional_host_permissions", "optional_permissions", "content_scripts", "browser_specific_settings", "externally_connectable", "web_accessible_resources"]) assert.equal(key in manifest, false, key);
  assert.doesNotMatch(JSON.stringify(manifest), /<all_urls>|:\/\/\*/);
  assert.deepEqual(manifest.background, { service_worker: "background.js" });
  assert.deepEqual(manifest.options_ui, { page: "options.html", open_in_tab: true });
  assert.equal(manifest.content_security_policy.extension_pages, "script-src 'self'; object-src 'none'; connect-src ws://127.0.0.1:19339");
  const files = await readdir(new URL("./browser-addon/", import.meta.url));
  assert.deepEqual(files.sort(), [...BROWSER_ADDON_FILES].sort());
  for (const file of BROWSER_ADDON_FILES) assert.doesNotMatch(await readFile(new URL(`./browser-addon/${file}`, import.meta.url), "utf8"), /firefox|moz-extension|globalThis\.browser/i, file);
});

test("buildBrowserAddon writes a loadable unpacked directory", async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-light-addon-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const out = join(root, "chromium", "nested");
  buildBrowserAddon(out);
  assert.deepEqual((await readdir(out)).sort(), [...BROWSER_ADDON_FILES].sort());
  for (const file of BROWSER_ADDON_FILES) assert.equal(await readFile(join(out, file), "utf8"), await readFile(new URL(`./browser-addon/${file}`, import.meta.url), "utf8"));
  buildBrowserAddon(out);
  assert.throws(() => buildBrowserAddon(" "), /required/);
  assert.throws(() => buildBrowserAddon(new URL("./browser-addon/", import.meta.url).pathname), /differ/);
});

// ---------- Add-on harness: real background.js + cdp.js in a VM with a fake chrome API and fake page. ----------

class FakeElement {
  hidden = false; disabled = false; readOnly = false; id = ""; value = ""; textContent = "Go";
  constructor(public tagName: string, public attrs: Record<string, string> = {}, public page?: any) {}
  closest() { return null; }
  scrollIntoView() {}
  getBoundingClientRect() { return { left: 10, top: 20, width: 100, height: 40 }; }
  getClientRects() { return [1]; }
  contains(other: unknown) { return other === this; }
  getAttribute(name: string) { return this.attrs[name] ?? null; }
  focus() { this.page.document.activeElement = this; }
  select() {}
}
class FakeInput extends FakeElement {}
class FakeTextArea extends FakeElement {}

function fakePage(pageOrigin = origin) {
  const page: any = {};
  const elements: Record<string, FakeElement[]> = {};
  page.elements = elements;
  page.text = "Hello";
  page.title = "Example";
  page.cover = null;
  page.document = {
    activeElement: null,
    get title() { return page.title; },
    body: { get innerText() { return page.text; } },
    documentElement: {},
    createTreeWalker: () => {
      let visited = false;
      return { nextNode: () => { if (visited) return null; visited = true; return { textContent: page.text, parentElement: { closest: () => null, getClientRects: () => [1] } }; } };
    },
    querySelectorAll: (selector: string) => elements[selector] ?? [],
    querySelector: (selector: string) => (elements[selector] ?? [])[0] ?? null,
    elementFromPoint: () => page.cover ?? Object.values(elements).flat()[0] ?? null
  };
  page.context = vm.createContext({
    document: page.document, location: { origin: pageOrigin, pathname: "/page", search: "?secret=excluded", hash: "#x" },
    NodeFilter: { SHOW_TEXT: 4 }, getComputedStyle: () => ({ display: "block", visibility: "visible", pointerEvents: "auto" }),
    Element: FakeElement, HTMLInputElement: FakeInput, HTMLTextAreaElement: FakeTextArea, innerWidth: 1200, innerHeight: 800, JSON, Error, Boolean, String
  });
  return page;
}

async function loadAddon(options: { token: string; tabs?: Array<{ id: number; url: string; title?: string }>; stored?: Record<string, unknown>; page?: any; attachFails?: boolean; gate?: { group?: () => Promise<void>; attach?: (tabId: number) => Promise<void>; remove?: () => Promise<void> } }) {
  const [background, cdpSource] = await Promise.all(["background.js", "cdp.js"].map(f => readFile(new URL(`./browser-addon/${f}`, import.meta.url), "utf8")));
  const listeners: Record<string, Array<(...args: any[]) => void>> = {};
  const event = (name: string) => ({ addListener: (f: (...args: any[]) => void) => { (listeners[name] ??= []).push(f); } });
  const fire = (name: string, ...args: unknown[]) => { for (const f of listeners[name] ?? []) f(...args); };
  const stored: Record<string, unknown> = { intent: { url: "ws://127.0.0.1:19347", token: options.token }, ...options.stored };
  const tabs = new Map((options.tabs ?? []).map(t => [t.id, { title: "", ...t }]));
  const page = options.page ?? fakePage();
  const calls: Array<{ tabId: number; method: string; params: any }> = [];
  const attached = new Set<number>();
  const removed: number[] = [];
  let nextId = 100;
  const logs: unknown[] = [];
  const evaluateIn = (expression: string) => {
    try { return { result: { type: "object", value: vm.runInContext(expression, page.context) } }; }
    catch (error) { return { exceptionDetails: { exception: { description: `Error: ${(error as Error).message}\n    at page` } } }; }
  };
  const chrome = {
    runtime: { onMessage: event("message"), id: "x", getURL: (p: string) => p, openOptionsPage: async () => {} },
    action: { onClicked: event("click"), setBadgeText: async () => {} },
    storage: { session: {
      get: async (keys: string[]) => Object.fromEntries(keys.filter(k => k in stored).map(k => [k, stored[k]])),
      set: async (values: Record<string, unknown>) => { Object.assign(stored, values); },
      remove: async (keys: string | string[]) => { for (const k of [keys].flat()) delete stored[k]; }
    } },
    tabs: {
      onRemoved: event("removed"), onUpdated: event("updated"), onReplaced: event("replaced"),
      get: async (id: number) => { const tab = tabs.get(id); if (!tab) throw new Error("No tab"); return tab; },
      create: async ({ url }: { url: string }) => { const tab = { id: nextId++, url, title: "" }; tabs.set(tab.id, tab); return tab; },
      remove: async (ids: number | number[]) => { await options.gate?.remove?.(); for (const id of [ids].flat()) { tabs.delete(id); removed.push(id); fire("removed", id); } },
      group: async () => { await options.gate?.group?.(); return 5; }
    },
    tabGroups: { update: async () => {} },
    debugger: {
      onEvent: event("cdpEvent"), onDetach: event("detach"),
      attach: async ({ tabId }: { tabId: number }) => { await options.gate?.attach?.(tabId); if (options.attachFails || attached.has(tabId)) throw new Error("Another debugger is already attached"); attached.add(tabId); },
      detach: async ({ tabId }: { tabId: number }) => { if (!attached.delete(tabId)) throw new Error("Not attached"); },
      sendCommand: async ({ tabId }: { tabId: number }, method: string, params: any) => {
        calls.push({ tabId, method, params });
        switch (method) {
          case "Page.getFrameTree": return { frameTree: { frame: { id: "frame" } } };
          case "Page.createIsolatedWorld": return { executionContextId: 9 };
          case "Runtime.evaluate": return evaluateIn(params.expression);
          case "Input.insertText": page.document.activeElement.value = params.text; return {};
          case "Page.getLayoutMetrics": return { cssVisualViewport: { clientWidth: 1200, clientHeight: 800, pageX: 0, pageY: 0 }, cssContentSize: { width: 3200, height: 20000 } };
          case "Page.captureScreenshot": return { data: "QUJD" };
          case "Accessibility.getFullAXTree": return { nodes: page.axNodes ?? [{ nodeId: "1", role: { value: "button" }, name: { value: "Go" } }, { nodeId: "2", ignored: true, role: { value: "link" } }, { nodeId: "3", role: { value: "generic" } }, { nodeId: "4", role: { value: "textbox" }, name: { value: "Email" }, value: { value: "secret@example.com" } }] };
          case "Page.navigate": return { frameId: "frame" };
          default: return {};
        }
      }
    }
  };
  // Every connection the add-on makes uses its extension origin, like a real browser.
  class ExtensionSocket extends WebSocket { constructor(url: string) { super(url, { origin: EXT }); } }
  const context: any = vm.createContext({
    Date, URL, TextEncoder, WebSocket: ExtensionSocket, chrome, setTimeout, Promise, JSON,
    crypto: { randomUUID: (() => { let n = 0; return () => `gen-${++n}`; })() },
    console: { log: (...a: unknown[]) => logs.push(a), error: (...a: unknown[]) => logs.push(a), warn: (...a: unknown[]) => logs.push(a) },
    importScripts: (file: string) => { assert.equal(file, "cdp.js"); vm.runInContext(cdpSource, context); }
  });
  // The live Pi may own the production port; the test bridge listens on 19347.
  vm.runInContext(background.replace('"ws://127.0.0.1:19339"', '"ws://127.0.0.1:19347"'), context);
  return { context, chrome, fire, stored, tabs, page, calls, attached, removed, logs };
}

test("add-on end to end over the real bridge: open, read, real input, evaluate, screenshot, logs and close", { timeout: 8000 }, async t => {
  const bridge = new BrowserBridge(19347, 2000);
  t.after(() => bridge.close());
  await bridge.start();
  const addon = await loadAddon({ token: bridge.connectionInfo().token });
  await until(() => bridge.connected, "add-on connection");
  assert.deepEqual(bridge.tabs, []);

  assert.deepEqual(await bridge.request({ action: "open", url: `${origin}/page` }), { opened: "main", origin, note: "Loading in background; use waitFor or snapshot next." });
  const main = bridge.resolveTab()!;
  assert.deepEqual({ ...main, generation: "" }, { name: "main", kind: "owned", origin, generation: "" });
  assert.ok(addon.attached.has(100), "debugger attached to the opened tab");
  assert.deepEqual(addon.calls.filter(c => c.method.endsWith(".enable")).map(c => c.method), ["Page.enable", "Runtime.enable", "Log.enable", "Network.enable"]);
  await assert.rejects(bridge.request({ action: "open", url: `${origin}/page` }), /name in use/);

  const snapshot = await bridge.request({ action: "snapshot" }, main) as { url: string; text: string };
  assert.equal(snapshot.url, `${origin}/page`);
  assert.equal(snapshot.text.trim(), "Hello");
  const evaluated = addon.calls.filter(c => c.method === "Runtime.evaluate").at(-1)!;
  assert.equal(evaluated.params.contextId, 9, "page helpers run in the isolated world");
  const ax = await bridge.request({ action: "snapshot", mode: "ax" }, main) as { lines: string[] };
  assert.deepEqual(ax.lines, ["button: Go", "textbox: Email"]);

  const button = new FakeElement("BUTTON", {}, addon.page);
  addon.page.elements["#go"] = [button];
  assert.deepEqual(await bridge.request({ action: "click", selector: "#go" }, main), { dispatched: true });
  const mouse = addon.calls.filter(c => c.method === "Input.dispatchMouseEvent").map(c => [c.params.type, c.params.x, c.params.y]);
  assert.deepEqual(mouse, [["mouseMoved", 60, 40], ["mousePressed", 60, 40], ["mouseReleased", 60, 40]]);
  addon.page.cover = new FakeElement("DIV");
  await assert.rejects(bridge.request({ action: "click", selector: "#go" }, main), /covered by another element/);
  addon.page.cover = null;
  addon.page.elements["#many"] = [button, button];
  await assert.rejects(bridge.request({ action: "hover", selector: "#many" }, main), /exactly one element/);

  const email = new FakeInput("INPUT", { type: "email" }, addon.page);
  addon.page.elements["#email"] = [email];
  assert.deepEqual(await bridge.request({ action: "fill", selector: "#email", text: "a@b.c" }, main), { dispatched: true });
  assert.equal(email.value, "a@b.c");
  assert.equal(addon.calls.filter(c => c.method === "Input.insertText").at(-1)!.params.text, "a@b.c");
  for (const type of ["password", "file", "hidden"]) {
    addon.page.elements["#secret"] = [new FakeInput("INPUT", { type }, addon.page)];
    await assert.rejects(bridge.request({ action: "fill", selector: "#secret", text: "x" }, main), /Fill refuses/);
  }

  assert.deepEqual(await bridge.request({ action: "press", key: "Enter" }, main), { dispatched: true });
  const keys = addon.calls.filter(c => c.method === "Input.dispatchKeyEvent").slice(-2).map(c => [c.params.type, c.params.key, c.params.windowsVirtualKeyCode]);
  assert.deepEqual(keys, [["keyDown", "Enter", 13], ["keyUp", "Enter", 13]]);
  assert.deepEqual(await bridge.request({ action: "scroll", dy: 500 }, main), { dispatched: true });
  assert.deepEqual(plain(addon.calls.at(-1)!.params), { type: "mouseWheel", x: 600, y: 400, button: "none", deltaX: 0, deltaY: 500 });

  assert.deepEqual(await bridge.request({ action: "waitFor", text: "Hello", timeoutMs: 500 }, main), { found: true });
  assert.deepEqual(await bridge.request({ action: "waitFor", selector: "#absent", timeoutMs: 300 }, main), { found: false });

  assert.deepEqual(await bridge.request({ action: "evaluate", code: "1 + 1" }, main), { value: 2 });
  const evaluation = addon.calls.filter(c => c.method === "Runtime.evaluate").at(-1)!.params;
  assert.equal(evaluation.contextId, undefined, "evaluate runs in the page's main world");
  assert.equal(evaluation.replMode, true);
  assert.match(JSON.stringify(await bridge.request({ action: "evaluate", code: "throw new Error('boom')" }, main)), /exception.*boom/);

  const shot = await bridge.request({ action: "screenshot", fullPage: true }, main) as { data: string; width: number; height: number };
  assert.deepEqual(shot, { data: "QUJD", width: 1600, height: 4000 });
  const capture = addon.calls.filter(c => c.method === "Page.captureScreenshot").at(-1)!.params;
  assert.deepEqual(plain(capture.clip), { x: 0, y: 0, width: 3200, height: 8000, scale: 0.5 });

  addon.fire("cdpEvent", { tabId: 100 }, "Runtime.consoleAPICalled", { type: "log", args: [{ type: "string", value: "hi" }, { type: "number", value: 3 }] });
  addon.fire("cdpEvent", { tabId: 100 }, "Network.requestWillBeSent", { requestId: "r1", type: "Fetch", request: { method: "POST", url: `${origin}/api?token=secret#frag`, headers: { authorization: "Bearer x" } } });
  addon.fire("cdpEvent", { tabId: 100 }, "Network.responseReceived", { requestId: "r1", response: { status: 201, mimeType: "application/json", headers: { "set-cookie": "a=b" } } });
  addon.fire("cdpEvent", { tabId: 100 }, "Log.entryAdded", { entry: { level: "error", source: "network", text: `Failed to load ${origin}/img.png?session=secret#x`, url: `${origin}/img.png?session=secret` } });
  addon.fire("cdpEvent", { tabId: 100 }, "Runtime.exceptionThrown", { exceptionDetails: { exception: { description: "Error at wss://ws.example.com/socket?auth=secret" } } });
  const early = JSON.stringify(await bridge.request({ action: "console" }, main));
  assert.match(early, /https:\/\/example\.com\/img\.png/);
  assert.match(early, /wss:\/\/ws\.example\.com\/socket/);
  assert.doesNotMatch(early, /session=|auth=|#x/, "console URLs lose query strings and fragments");
  for (let n = 0; n < 250; n++) addon.fire("cdpEvent", { tabId: 100 }, "Log.entryAdded", { entry: { level: "warning", text: `w${n}` } });
  const logs = await bridge.request({ action: "console" }, main) as { entries: Array<{ text: string }>; dropped: number };
  assert.equal(logs.entries.length, 200, "console ring buffer is bounded");
  assert.equal(logs.entries.at(-1)!.text, "w249");
  const network = await bridge.request({ action: "network" }, main) as { entries: unknown[] };
  assert.deepEqual(network.entries, [{ method: "POST", url: `${origin}/api`, type: "Fetch", status: 201, mimeType: "application/json" }]);
  assert.doesNotMatch(JSON.stringify(network), /secret|Bearer|set-cookie/);

  assert.deepEqual(await bridge.request({ action: "navigate", url: "https://other.test/" }, main), { dispatched: true, note: "Navigation started; use waitFor before reading the page." });
  addon.tabs.get(100)!.url = "https://other.test/";
  addon.fire("updated", 100, { url: "https://other.test/" });
  await until(() => bridge.resolveTab("main")?.origin === "https://other.test", "owned tab origin update");
  assert.equal(bridge.resolveTab("main")!.generation, main.generation, "owned tabs keep their generation across origins");

  const list = await bridge.request({ action: "tabs" }) as { tabs: Array<{ name: string }> };
  assert.deepEqual(list.tabs.map(t => t.name), ["main"]);
  assert.deepEqual(await bridge.request({ action: "close" }, bridge.resolveTab("main")), { closed: "main" });
  await until(() => !bridge.tabs.length, "closed tab removal");
  assert.deepEqual(addon.removed, [100]);
  assert.equal(addon.attached.has(100), false);
});

test("add-on binds, origin-locks and never closes user tabs; disconnect closes only unkept Pi tabs", { timeout: 8000 }, async t => {
  const bridge = new BrowserBridge(19347, 2000);
  t.after(() => bridge.close());
  await bridge.start();
  const addon = await loadAddon({ token: bridge.connectionInfo().token, tabs: [{ id: 7, url: `${origin}/inbox` }, { id: 8, url: "chrome://settings" }] });
  await until(() => bridge.connected, "add-on connection");
  addon.fire("click", { id: 8, url: "chrome://settings" });
  await delay(20);
  assert.equal(bridge.tabs.length, 0, "browser-internal pages cannot be bound");
  addon.fire("click", { id: 7, url: `${origin}/inbox` });
  await until(() => bridge.tabs.length === 1, "bound tab");
  const userTab = bridge.resolveTab()!;
  assert.deepEqual({ ...userTab, generation: "" }, { name: "bound", kind: "bound", origin, generation: "" });
  await assert.rejects(bridge.request({ action: "close" }, userTab), /opened by Pi/);
  // The add-on refuses even if a request bypasses the bridge policy.
  const raw = vm.runInContext("(m) => run(m, socket)", addon.context);
  await assert.rejects(raw({ id: "a".repeat(32), deadline: Date.now() + 1000, action: "close", tab: "bound", generation: userTab.generation }), /opened by Pi/);
  await assert.rejects(raw({ id: "b".repeat(32), deadline: Date.now() + 1000, action: "navigate", url: "https://other.test/", tab: "bound", generation: userTab.generation }), /stay on its origin/);
  await assert.rejects(raw({ id: "c".repeat(32), deadline: Date.now() + 1000, action: "snapshot", tab: "bound", generation: "stale" }), /Tab changed/);

  await bridge.request({ action: "open", url: `${origin}/a` });
  await bridge.request({ action: "open", url: `${origin}/b`, name: "kept", keep: true });
  assert.deepEqual(bridge.tabs.map(t => t.name).sort(), ["bound", "kept", "main"]);
  assert.deepEqual(plain(addon.stored.owned), [{ name: "main", tabId: 100, keep: false }, { name: "kept", tabId: 101, keep: true }]);

  // A bound tab that changes origin is released.
  addon.fire("updated", 7, { url: "https://other.test/" });
  await until(() => !bridge.resolveTab("bound"), "bound release");
  assert.equal(addon.attached.has(7), false);
  // The user dismissing the debugging bar releases an owned tab without closing it.
  addon.fire("detach", { tabId: 101 }, "canceled_by_user");
  await until(() => !bridge.resolveTab("kept"), "detach release");
  assert.equal(addon.tabs.has(101), true);

  await bridge.close();
  await until(() => addon.removed.length > 0, "cleanup on disconnect");
  assert.deepEqual(addon.removed, [100], "only the unkept Pi tab closes");
  assert.equal(addon.tabs.has(7), true);
  assert.equal(addon.stored.owned, undefined);
  assert.equal(JSON.stringify(addon.logs).includes(bridge.connectionInfo().token), false, "token must never be logged");
});

test("add-on re-adopts remembered tabs after a worker restart and forgets a rejected token", { timeout: 8000 }, async t => {
  const bridge = new BrowserBridge(19347, 2000);
  t.after(() => bridge.close());
  await bridge.start();
  const addon = await loadAddon({
    token: bridge.connectionInfo().token,
    tabs: [{ id: 7, url: `${origin}/inbox` }, { id: 100, url: "https://app.test/" }, { id: 101, url: "chrome://newtab" }],
    stored: { binding: { tabId: 7, origin }, owned: [{ name: "main", tabId: 100, keep: false }, { name: "gone", tabId: 999, keep: false }, { name: "internal", tabId: 101, keep: false }, { name: "bound", tabId: 5 }] }
  });
  await until(() => bridge.tabs.length === 2, "re-adopted tabs");
  assert.deepEqual(bridge.tabs.map(t => [t.name, t.kind, t.origin]).sort(), [["bound", "bound", origin], ["main", "owned", "https://app.test"]]);
  await bridge.close();

  const fresh = new BrowserBridge(19347, 2000);
  t.after(() => fresh.close());
  await fresh.start();
  const stale = await loadAddon({ token: "ab".repeat(32) });
  await until(() => stale.stored.intent === undefined, "stale token forgotten");
  assert.equal(fresh.connected, false);
});

test("add-on fails closed when the debugger cannot attach", { timeout: 5000 }, async t => {
  const bridge = new BrowserBridge(19347, 2000);
  t.after(() => bridge.close());
  await bridge.start();
  const addon = await loadAddon({ token: bridge.connectionInfo().token, attachFails: true });
  await until(() => bridge.connected, "add-on connection");
  await assert.rejects(bridge.request({ action: "open", url: `${origin}/` }), /Cannot debug this tab/);
  assert.deepEqual(addon.removed, [100], "the unusable tab is closed");
  assert.deepEqual(bridge.tabs, []);
});

test("add-on only allowlisted CDP methods and fixed page functions", async () => {
  const source = await readFile(new URL("./browser-addon/cdp.js", import.meta.url), "utf8");
  const background = await readFile(new URL("./browser-addon/background.js", import.meta.url), "utf8");
  for (const text of [source, background]) assert.doesNotMatch(text, /\.(cookies|history|downloads)\b|\beval\(|new Function|Network\.getResponseBody|Network\.getCookies|Storage\.|Target\.|Browser\.|console\.(log|error|warn)/);
  assert.match(source, /if \(!CDP_ALLOWED\.has\(method\) \|\| !sessions\.has\(tabId\)\)/);
  // Every sendCommand goes through cdp().
  assert.equal((source.match(/chrome\.debugger\.sendCommand/g) ?? []).length, 1);
  assert.equal((background.match(/chrome\.debugger\.sendCommand/g) ?? []).length, 0);
});

test("browser tool: open always asks, bound-tab mutations and console ask, Pi-owned tabs run freely, read-only blocks mutations", async t => {
  const tools: any[] = [];
  const pi = { registerCommand: () => {}, registerTool: (tool: any) => tools.push(tool), on: () => {} };
  const requests: Array<{ action: string }> = [];
  const fake = ({
    start: async () => {}, connected: true, tabs: [bound, owned],
    resolveTab: (name?: string) => (!name || name === "bound" ? { ...bound } : name === "main" ? { ...owned } : undefined),
    request: async (action: { action: string }) => { requests.push(action); return action.action === "screenshot" ? { data: "QUJD", width: 2, height: 1 } : { ok: 1 }; }
  });
  let readOnly = false;
  registerBrowserTools(pi, { isReadOnly: () => readOnly }, fake as unknown as BrowserBridge);
  const tool = tools[0];
  const confirms: string[] = [];
  let answer = true;
  const ctx = { hasUI: true, mode: "tui", ui: { confirm: async (_title: string, message: string) => { confirms.push(message); return answer; }, notify: () => {} } };
  const run = (params: object, context: object = ctx) => tool.execute("id", params, undefined, undefined, context);

  const shot = await run({ action: "screenshot" });
  assert.deepEqual(shot.content[1], { type: "image", data: "QUJD", mimeType: "image/jpeg" });
  assert.equal(confirms.length, 0, "reads need no confirmation");

  // Opening a tab always asks.
  await run({ action: "open", url: `${origin}/` });
  assert.match(confirms.at(-1)!, /new tab[\s\S]*"open"/);
  answer = false;
  await assert.rejects(run({ action: "open", url: `${origin}/` }), /declined/);
  answer = true;

  // Pi-owned tab: every action runs without a prompt, even outside the TUI.
  const owned0 = confirms.length;
  for (const params of [{ action: "evaluate", code: "1" }, { action: "click", selector: "a" }, { action: "fill", selector: "input", text: "x" }, { action: "press", key: "Enter" }, { action: "navigate", url: "https://other.test/" }, { action: "console" }, { action: "close" }]) {
    await run({ ...params, tab: "main" }, { ...ctx, mode: "rpc" });
  }
  assert.equal(confirms.length, owned0, "Pi-owned tabs never prompt");

  // Bound user tab: mutations and console ask; declining stops the action.
  await run({ action: "evaluate", code: "document.title" });
  assert.match(confirms.at(-1)!, /bound \(bound\) https:\/\/example\.com[\s\S]*document\.title/);
  await run({ action: "console" });
  assert.match(confirms.at(-1)!, /private data/);
  answer = false;
  await assert.rejects(run({ action: "click", selector: "a" }), /declined/);
  await assert.rejects(run({ action: "console" }), /declined/);
  answer = true;
  await assert.rejects(run({ action: "click", selector: "a" }, { ...ctx, mode: "rpc" }), /interactive confirmation/);

  // Read-only refuses mutations on every tab, but reads (including console) still work.
  readOnly = true;
  const blocked = requests.length;
  await assert.rejects(run({ action: "open", url: `${origin}/` }), /read-only/);
  await assert.rejects(run({ action: "click", selector: "a", tab: "main" }), /read-only/);
  await assert.rejects(run({ action: "evaluate", code: "1", tab: "main" }), /read-only/);
  await assert.rejects(run({ action: "close", tab: "main" }), /read-only/);
  assert.equal(requests.length, blocked);
  await run({ action: "snapshot", tab: "main" });
  await run({ action: "console", tab: "main" });
  await run({ action: "console" });
  readOnly = false;
  await assert.rejects(run({ action: "snapshot", tab: "nope" }), /No such controlled tab/);
  t.diagnostic(`tool description length ${tool.description.length}`);
});

test("a request right after close is not refused as busy", { timeout: 5000 }, async t => {
  const bridge = new BrowserBridge(19347, 2000);
  t.after(() => bridge.close());
  await bridge.start();
  const addon = await loadAddon({ token: bridge.connectionInfo().token, gate: { remove: () => delay(300).then(() => {}) } });
  await until(() => bridge.connected, "add-on connection");
  await bridge.request({ action: "open", url: `${origin}/` });
  assert.deepEqual(await bridge.request({ action: "close" }, bridge.resolveTab("main")), { closed: "main" });
  // Previously the add-on stayed busy until the (slow) tab removal finished.
  assert.deepEqual(plain(await bridge.request({ action: "tabs" })), { tabs: [] });
  await until(() => addon.removed.length === 1, "tab removed");
});

test("actual add-on snapshots fit the full UTF-8 response envelope over WebSocket", { timeout: 8000 }, async t => {
  const bridge = new BrowserBridge(19347, 2000);
  t.after(() => bridge.close());
  await bridge.start();
  const addon = await loadAddon({ token: bridge.connectionInfo().token });
  await until(() => bridge.connected, "add-on connection");
  await bridge.request({ action: "open", url: `${origin}/page` });
  const main = bridge.resolveTab()!;
  const cases = [
    { text: "Hello", title: "Example", controls: 0, truncated: false },
    { text: "\u4e00".repeat(16000), title: "Example", controls: 0, truncated: true },
    { text: "\u{1f680}".repeat(8000), title: "Example", controls: 0, truncated: true },
    { text: '\\"\u0000'.repeat(6000), title: "Example", controls: 0, truncated: true },
    { text: "\u4e00".repeat(16000), title: '\\"\u0000'.repeat(1000), controls: 80, truncated: true }
  ];
  for (const example of cases) {
    addon.page.text = example.text; addon.page.title = example.title;
    addon.page.elements["input,textarea,select,button,a[href]"] = Array.from({ length: example.controls }, () => {
      const control = new FakeInput("INPUT", { name: "\u4e00".repeat(200) }, addon.page);
      control.id = "\u4e00".repeat(200);
      Object.defineProperty(control, "value", { get() { throw new Error("Snapshot read a control value"); } });
      return control;
    });
    const result = await bridge.request({ action: "snapshot" }, main) as { text: string; url: string; truncated: boolean };
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 48000);
    assert.equal(result.truncated, example.truncated);
    assert.equal(result.url, `${origin}/page`);
    assert.ok(example.text.startsWith(result.text.trimEnd()));
    assert.equal(/[\uD800-\uDBFF]$/.test(result.text), false, "Truncation split a surrogate pair");
  }
});

test("accessibility snapshots never include text typed into fields or editable regions (Chromium AX shapes)", { timeout: 8000 }, async t => {
  const bridge = new BrowserBridge(19347, 2000);
  t.after(() => bridge.close());
  await bridge.start();
  const addon = await loadAddon({ token: bridge.connectionInfo().token });
  await until(() => bridge.connected, "add-on connection");
  await bridge.request({ action: "open", url: `${origin}/form` });
  const main = bridge.resolveTab()!;
  // Shapes observed from Chromium: values appear as descendant StaticText (and InlineTextBox) names.
  const node = (nodeId: string, role: string, name: string, childIds: string[] = [], extra: object = {}) => ({ nodeId, role: { value: role }, name: { value: name }, childIds, ...extra });
  addon.page.axNodes = [
    node("1", "RootWebArea", "Form", ["2", "3", "6", "9", "12"]),
    node("2", "heading", "Sign in"),
    node("3", "textbox", "Email", ["4"], { properties: [{ name: "editable", value: { value: "plaintext" } }] }),
    node("4", "generic", "", ["5"]), node("5", "StaticText", "INPUT-MARKER"),
    node("6", "textbox", "Notes", ["7"]), node("7", "StaticText", "TEXTAREA-MARKER", ["8"]), node("8", "InlineTextBox", "TEXTAREA-MARKER"),
    node("9", "generic", "EDITABLE-MARKER", ["10"], { properties: [{ name: "editable", value: { value: "richtext" } }] }),
    node("10", "paragraph", "", ["11"]), node("11", "StaticText", "EDITABLE-MARKER"),
    node("12", "combobox", "Country", ["13"]), node("13", "StaticText", "COMBO-MARKER")
  ];
  const ax = JSON.stringify(await bridge.request({ action: "snapshot", mode: "ax" }, main));
  assert.doesNotMatch(ax, /MARKER/);
  for (const kept of ["heading: Sign in", "textbox: Email", "textbox: Notes", "combobox: Country"]) assert.ok(ax.includes(kept), kept);
});

test("disconnect during open, bind or re-adoption leaves no unkept tab or debugger behind", { timeout: 8000 }, async t => {
  const bridge = new BrowserBridge(19347, 2000);
  t.after(() => bridge.close());
  await bridge.start();
  let release!: () => void;
  let paused = false;
  const gate = { group: () => { paused = true; return new Promise<void>(resolve => { release = resolve; }); } };
  const addon = await loadAddon({ token: bridge.connectionInfo().token, gate });
  await until(() => bridge.connected, "add-on connection");
  const open = bridge.request({ action: "open", url: `${origin}/slow` }).catch(error => error);
  await until(() => paused, "open paused in grouping");
  assert.ok(addon.attached.has(100));
  vm.runInContext("dropAll('test disconnect')", addon.context);
  await until(() => addon.removed.length > 0, "in-flight tab removal");
  assert.deepEqual(addon.removed, [100], "the in-flight tab is closed at disconnect");
  release();
  await delay(20);
  assert.equal(addon.attached.has(100), false, "debugger released after the revoked open");
  assert.equal(vm.runInContext("controlled.size", addon.context), 0, "revoked open never registers");
  // A kept tab survives a revoked open, uncontrolled.
  vm.runInContext("ready = true", addon.context);
  paused = false;
  const keptOpen = vm.runInContext(`openTab(${JSON.stringify({ url: `${origin}/kept`, name: "kept", keep: true })})`, addon.context).catch((error: Error) => error);
  await until(() => paused, "kept open paused");
  vm.runInContext("dropAll('test disconnect')", addon.context);
  release();
  assert.match(String(await keptOpen), /Connection changed/);
  assert.equal(addon.tabs.has(101), true, "kept tab stays open");
  assert.equal(addon.attached.has(101), false);
  await open;

  // Bind revoked while the debugger attaches.
  let releaseAttach!: () => void;
  let attaching = false;
  const slow = await loadAddon({ token: bridge.connectionInfo().token, tabs: [{ id: 7, url: `${origin}/inbox` }], gate: { attach: () => { attaching = true; return new Promise<void>(resolve => { releaseAttach = resolve; }); } } });
  vm.runInContext("ready = true", slow.context);
  const bind = vm.runInContext("bindTab({ tabId: 7, origin: 'https://example.com' })", slow.context).catch((error: Error) => error);
  await until(() => attaching, "bind attaching");
  vm.runInContext("dropAll('test disconnect')", slow.context);
  releaseAttach();
  assert.match(String(await bind), /Selection changed/);
  assert.equal(slow.attached.has(7), false);
  assert.equal(vm.runInContext("controlled.size", slow.context), 0);

  // Re-adoption revoked midway: the unkept remembered tab still closes.
  attaching = false;
  // No saved connection: the worker stays idle until the test drives re-adoption directly.
  const restart = await loadAddon({ token: "ab".repeat(32), tabs: [{ id: 100, url: `${origin}/a` }], stored: { intent: null }, gate: { attach: () => { attaching = true; return new Promise<void>(resolve => { releaseAttach = resolve; }); } } });
  await delay(20);
  vm.runInContext("pendingOwned = [{ name: 'main', tabId: 100, keep: false, kind: 'owned' }]; ready = true; void readopt()", restart.context);
  await until(() => attaching, "re-adoption attaching");
  vm.runInContext("dropAll('test disconnect')", restart.context);
  releaseAttach();
  await delay(20);
  assert.deepEqual(restart.removed, [100]);
  assert.equal(restart.attached.has(100), false);
  assert.equal(vm.runInContext("controlled.size", restart.context), 0);
});

test("console, accessibility and evaluate results shrink to the UTF-8 envelope budget instead of failing", { timeout: 8000 }, async t => {
  const bridge = new BrowserBridge(19347, 2000);
  t.after(() => bridge.close());
  await bridge.start();
  const addon = await loadAddon({ token: bridge.connectionInfo().token });
  await until(() => bridge.connected, "add-on connection");
  await bridge.request({ action: "open", url: `${origin}/page` });
  const main = bridge.resolveTab()!;
  const fits = (value: unknown) => assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 48000, `${Buffer.byteLength(JSON.stringify(value))} bytes`);
  for (const sample of ["\u4e00", "\u{1f680}", '\\"\u0000']) {
    for (let n = 0; n < 200; n++) addon.fire("cdpEvent", { tabId: 100 }, "Log.entryAdded", { entry: { level: "info", text: `${n}:${sample.repeat(400)}` } });
    const logs = await bridge.request({ action: "console" }, main) as { entries: Array<{ text: string }>; dropped: number };
    fits(logs);
    assert.ok(logs.entries.length > 0 && logs.dropped > 0 && logs.entries.length + logs.dropped === 200);
    assert.match(logs.entries.at(-1)!.text, /^199:/, "the newest entries are kept");

    addon.page.axNodes = Array.from({ length: 1400 }, (_, n) => ({ nodeId: String(n), role: { value: "heading" }, name: { value: sample.repeat(60) } }));
    const ax = await bridge.request({ action: "snapshot", mode: "ax" }, main) as { lines: string[]; truncated: boolean };
    fits(ax);
    assert.equal(ax.truncated, true);
    assert.ok(ax.lines.length > 0);

    const evaluated = await bridge.request({ action: "evaluate", code: `"${sample}".repeat(30000)` }, main) as { truncated: boolean; json: string };
    fits(evaluated);
    assert.equal(evaluated.truncated, true);
    assert.ok(evaluated.json.length > 1000);
    assert.equal(/[\uD800-\uDBFF]$/.test(evaluated.json), false, "no split surrogate pair");
  }
});

test("toolbar clicks cancel in-flight binds: a stale bind never restores control after unbinding", { timeout: 8000 }, async t => {
  const bridge = new BrowserBridge(19347, 2000);
  t.after(() => bridge.close());
  await bridge.start();
  const waiting = new Map<number, () => void>();
  const gate = { attach: (tabId: number) => tabId === 1 ? new Promise<void>(resolve => waiting.set(1, resolve)) : Promise.resolve() };
  const tabs = [{ id: 1, url: `${origin}/one` }, { id: 2, url: `${origin}/two` }];
  const addon = await loadAddon({ token: bridge.connectionInfo().token, tabs, gate });
  await until(() => bridge.connected, "add-on connection");
  const click = (id: number) => addon.fire("click", { id, url: tabs.find(tab => tab.id === id)!.url });

  // Sol's sequence: slow bind of tab 1, bind tab 2, unbind tab 2, then tab 1's attach completes.
  click(1);
  await until(() => waiting.has(1), "tab 1 attach pending");
  click(2);
  await until(() => bridge.resolveTab("bound")?.origin === origin, "tab 2 bound");
  click(2);
  await until(() => bridge.tabs.length === 0, "tab 2 unbound");
  waiting.get(1)!(); waiting.delete(1);
  await delay(30);
  assert.equal(bridge.tabs.length, 0, "the stale bind does not register");
  assert.equal(addon.attached.has(1), false, "the stale bind releases its debugger");
  assert.equal(addon.attached.has(2), false);

  // Same tab: bind, unbind while pending, bind again; the stale first bind must not detach the newer one.
  click(1);
  await until(() => waiting.has(1), "first attach pending");
  click(1);
  click(1);
  waiting.get(1)!(); waiting.delete(1);
  await until(() => bridge.tabs.length === 1, "newest bind registered");
  await delay(30);
  assert.equal(vm.runInContext("controlled.get('bound').tabId", addon.context), 1);
  assert.equal(addon.attached.has(1), true, "the newer bind keeps its debugger");

  // Clicking the pending tab again unbinds it before it ever registers.
  click(1);
  await until(() => bridge.tabs.length === 0, "unbound");
  click(2);
  click(2);
  await delay(30);
  assert.equal(bridge.tabs.length, 0);
  assert.equal(addon.attached.has(2), false);
});

test("trimmed console results stay within the byte budget including the dropped count", async () => {
  const addon = await loadAddon({ token: "ab".repeat(32), stored: { intent: null } });
  const measure = vm.runInContext(`(lastLength, count) => {
    const entries = Array.from({ length: count }, (_, n) => ({ level: "log", text: "x".repeat(n === count - 1 ? lastLength : 500) }));
    const response = { type: "result", id: "a".repeat(32), generation: "123e4567-e89b-12d3-a456-426614174000", ok: true, result: { entries, dropped: 0 } };
    fitResult(response, "console");
    return { bytes: new TextEncoder().encode(JSON.stringify(response)).length, kept: response.result.entries.length, dropped: response.result.dropped };
  }`, addon.context) as (lastLength: number, count: number) => { bytes: number; kept: number; dropped: number };
  // Sweep the newest entry's length across the digit-width boundaries of the dropped count.
  for (const count of [200, 150, 100]) {
    for (let lastLength = 400; lastLength <= 500; lastLength++) {
      const { bytes, kept, dropped } = measure(lastLength, count);
      assert.ok(bytes <= 48000, `count ${count}, last ${lastLength}: ${bytes} bytes`);
      assert.equal(kept + dropped, count);
    }
  }
  assert.equal(measure(479, 200).bytes <= 48000, true, "Sol's reproduction case");
});
