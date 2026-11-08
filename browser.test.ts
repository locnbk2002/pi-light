import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { WebSocket } from "ws";
import { BrowserBridge, registerBrowserTools } from "./browser-bridge.js";
import { BROWSER_ADDON_SHARED_FILES, buildBrowserAddon } from "./setup.mjs";
import { MAX_MESSAGE_BYTES, validateAction, validExtensionOrigin } from "./browser-policy.js";

const origin = "https://example.com";
const binding = { generation: "generation-1", origin };
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function client(bridge: BrowserBridge, token = bridge.connectionInfo().token) {
  const ws = new WebSocket(bridge.connectionInfo().url, { origin: "moz-extension://test-extension" });
  await once(ws, "open");
  const reply = once(ws, "message");
  ws.send(JSON.stringify({ type: "auth", token }));
  await reply;
  ws.send(JSON.stringify({ type: "binding", bound: true, ...binding }));
  for (let n = 0; !bridge.bound && n < 50; n++) await delay(2);
  assert.deepEqual(bridge.bound, binding);
  return ws;
}

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
  assert.equal(bridge.bound, undefined);
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
  const incoming = once(ws, "message");
  const result = bridge.request({ action: "snapshot" }, binding);
  const [raw] = await incoming;
  const request = JSON.parse(raw.toString());
  ws.send(JSON.stringify({ type: "result", id: request.id, generation: binding.generation, ok: true, result: { text: "restarted" } }));
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
  assert.deepEqual(bridge.bound, binding);
});

test("actual addon snapshots fit the full UTF-8 response envelope over WebSocket", { timeout: 5000 }, async t => {
  const source = await readFile(new URL("./browser-addon/background.js", import.meta.url), "utf8");
  const bridge = new BrowserBridge(19342, 1000);
  t.after(() => bridge.close());
  await bridge.start();
  const ws = await client(bridge);
  const envelopes: string[] = [];
  const failures: unknown[] = [];
  let pageText = "";
  let metadata = "";
  let controlCount = 0;
  const page = vm.createContext({
    Date, URL, location: { origin, pathname: "/page", search: "?secret=excluded", hash: "#excluded" },
    NodeFilter: { SHOW_TEXT: 4 }, getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    document: {
      get title() { return metadata || "Example"; }, body: {},
      createTreeWalker: () => {
        let visited = false;
        return { nextNode: () => {
          if (visited) return null;
          visited = true;
          return { textContent: pageText, parentElement: { closest: () => null, getClientRects: () => [1] } };
        } };
      },
      querySelectorAll: () => Array.from({ length: controlCount }, () => ({ tagName: "INPUT", id: metadata,
        getAttribute: () => metadata, disabled: false,
        get value(): never { throw new Error("Snapshot read a control value"); }
      }))
    }
  });
  const listener = { addListener: () => {} };
  const context = vm.createContext({
    Date, URL, TextEncoder, WebSocket,
    browser: {
      runtime: { onMessage: listener }, action: { onClicked: listener },
      storage: { session: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
      tabs: { onRemoved: listener, onUpdated: listener, onReplaced: listener, get: async () => ({ url: `${origin}/page` }) },
      // Mirrors the browser: the function is serialized into the isolated page world with JSON-cloned args.
      scripting: { executeScript: async (options: { target: { tabId: number }; func: (...args: unknown[]) => unknown; args: unknown[] }) =>
        [{ frameId: 0, result: vm.runInContext(`(${options.func.toString()})(...${JSON.stringify(options.args)})`, page) }] }
    },
    testSocket: {
      get readyState() { return ws.readyState; },
      send: (message: string) => { envelopes.push(message); ws.send(message); }
    },
    testBinding: { ...binding, tabId: 7 }
  });
  vm.runInContext(source, context);
  vm.runInContext("socket = testSocket; ready = true; binding = testBinding;", context);
  const run = vm.runInContext("message => run(message, socket)", context) as (message: unknown) => Promise<void>;
  ws.on("message", raw => {
    const message: unknown = JSON.parse(raw.toString());
    void run(message).catch(error => {
      failures.push(error);
      const request = message as { id: string; generation: string };
      ws.send(JSON.stringify({ type: "result", id: request.id, generation: request.generation, ok: false }));
    });
  });
  const cases = [
    { text: "Hello", meta: "", controls: 0, truncated: false },
    { text: "\u4e00".repeat(16000), meta: "", controls: 0, truncated: true },
    { text: "\u{1f680}".repeat(8000), meta: "", controls: 0, truncated: true },
    { text: '\\"\u0000'.repeat(6000), meta: "", controls: 0, truncated: true },
    { text: "\u4e00".repeat(16000), meta: '\\"\u0000'.repeat(1000), controls: 60, truncated: true },
    { text: "Hello", meta: "\u4e00".repeat(1000), controls: 60, truncated: true }
  ];
  for (const example of cases) {
    pageText = example.text; metadata = example.meta; controlCount = example.controls;
    const result = await bridge.request({ action: "snapshot" }, binding) as { text: string; url: string; truncated: boolean };
    const envelope = envelopes.at(-1)!;
    assert.ok(Buffer.byteLength(envelope, "utf8") <= 48000, `Envelope was ${Buffer.byteLength(envelope)} bytes`);
    assert.equal(JSON.parse(envelope).ok, true);
    assert.equal(result.truncated, example.truncated);
    assert.equal(result.url, `${origin}/page`);
    assert.ok(example.text.startsWith(result.text.trimEnd()));
    assert.equal(/[\uD800-\uDBFF]$/.test(result.text), false, "Truncation split a surrogate pair");
    if (!example.truncated) assert.equal(result.text.trim(), example.text);
  }
  assert.deepEqual(failures, []);
});

test("browser policy restricts actions, fields, selectors and origin", () => {
  assert.deepEqual(validateAction({ action: "snapshot" }), { action: "snapshot" });
  assert.deepEqual(validateAction({ action: "navigate", url: `${origin}/next` }, origin), { action: "navigate", url: `${origin}/next` });
  for (const value of [{ action: "eval", code: "alert(1)" }, { action: "snapshot", selector: "body" }, { action: "click", selector: "" }, { action: "click", selector: "a".repeat(513) }, { action: "fill", selector: "input", text: "x".repeat(8001) }, { action: "navigate", url: "https://other.test/" }, { action: "navigate", url: "javascript:alert(1)" }, { action: "navigate", url: "https://name:secret@example.com/" }]) assert.throws(() => validateAction(value, origin));
  assert.equal(validExtensionOrigin("moz-extension://1234-abcd"), true);
  assert.equal(validExtensionOrigin(`chrome-extension://${"abcdefghijklmnop".repeat(2)}`), true);
  for (const value of [undefined, "null", "https://example.com", "moz-extension://test/path", "moz-extension://test?x", "chrome-extension://short", `chrome-extension://${"q".repeat(32)}`, `chrome-extension://${"a".repeat(32)}/path`]) assert.equal(validExtensionOrigin(value), false);
});

test("real loopback protocol authentication, requests, rebind, disconnect, timeout, bounds and shutdown", async t => {
  const bridge = new BrowserBridge(19340, 100);
  t.after(async () => { await bridge.close(); });
  await bridge.start();
  const conflict = new BrowserBridge(19340);
  await assert.rejects(conflict.start(), /unavailable/);
  await conflict.close();
  const bad = new WebSocket(bridge.connectionInfo().url, { origin: "moz-extension://test-extension" });
  await once(bad, "open");
  const closed = once(bad, "close");
  let messages = 0;
  bad.on("message", () => messages++);
  bad.send(JSON.stringify({ type: "auth", token: "incorrect" }));
  await closed;
  assert.equal(messages, 0);
  assert.equal(bridge.bound, undefined);
  const unauthenticated = new WebSocket(bridge.connectionInfo().url, { origin: "moz-extension://test-extension" });
  await once(unauthenticated, "open");
  const unauthorizedClose = once(unauthenticated, "close");
  unauthenticated.on("message", () => messages++);
  unauthenticated.send(JSON.stringify({ type: "binding", bound: true, ...binding }));
  await unauthorizedClose;
  assert.equal(messages, 0);
  assert.equal(bridge.bound, undefined);
  const webPage = new WebSocket(bridge.connectionInfo().url, { origin: "https://evil.test" });
  await once(webPage, "error");
  let ws = await client(bridge);
  let incoming = once(ws, "message");
  const result = bridge.request({ action: "snapshot" }, binding);
  const [raw] = await incoming;
  const request = JSON.parse(raw.toString());
  assert.equal(request.action, "snapshot");
  assert.equal("token" in request, false);
  ws.send(JSON.stringify({ type: "result", id: request.id, generation: binding.generation, ok: true, result: { text: "hello" } }));
  assert.deepEqual(await result, { text: "hello" });
  incoming = once(ws, "message");
  const pending = bridge.request({ action: "click", selector: "button" }, binding);
  const rejected = assert.rejects(pending, /binding changed/);
  await incoming;
  ws.send(JSON.stringify({ type: "binding", bound: true, generation: "generation-2", origin }));
  await rejected;
  await assert.rejects(bridge.request({ action: "snapshot" }, binding), /Binding changed/);
  const newer = bridge.bound!;
  incoming = once(ws, "message");
  const disconnected = assert.rejects(bridge.request({ action: "snapshot" }, newer), /disconnected/);
  await incoming;
  ws.close(); await disconnected;
  ws = await client(bridge);
  await assert.rejects(bridge.request({ action: "snapshot" }, binding), /timed out/);
  await delay(10);
  ws = await client(bridge);
  incoming = once(ws, "message");
  const aborter = new AbortController();
  const cancelled = assert.rejects(bridge.request({ action: "snapshot" }, binding, aborter.signal), /cancelled/);
  await incoming; aborter.abort(); await cancelled;
  await delay(10);
  ws = await client(bridge);
  const oversizedClose = once(ws, "close");
  ws.send("x".repeat(MAX_MESSAGE_BYTES + 1));
  await oversizedClose;
  assert.equal(bridge.bound, undefined);
  ws = await client(bridge);
  incoming = once(ws, "message");
  const shutdown = assert.rejects(bridge.request({ action: "snapshot" }, binding), /shutdown/);
  await incoming; await bridge.close(); await shutdown;
  await bridge.close();
});

const readManifest = async (target: string) => JSON.parse(await readFile(new URL(`./browser-addon/manifest.${target}.json`, import.meta.url), "utf8"));

test("MV3 manifests for Firefox and Chromium share permissions and CSP without host access", async () => {
  const firefox = await readManifest("firefox");
  const chromium = await readManifest("chromium");
  for (const manifest of [firefox, chromium]) {
    assert.equal(manifest.manifest_version, 3);
    assert.deepEqual(manifest.permissions, ["activeTab", "tabs", "scripting", "storage"]);
    assert.equal("host_permissions" in manifest, false);
    assert.equal("optional_host_permissions" in manifest, false);
    assert.equal("browser_action" in manifest, false);
    assert.equal("content_scripts" in manifest, false);
    assert.doesNotMatch(JSON.stringify(manifest), /<all_urls>|:\/\/\*/);
    assert.ok(manifest.action);
    assert.deepEqual(manifest.options_ui, { page: "options.html", open_in_tab: true });
    assert.equal(manifest.content_security_policy.extension_pages, "script-src 'self'; object-src 'none'; connect-src ws://127.0.0.1:19339");
  }
  assert.deepEqual(firefox.background, { scripts: ["background.js"] });
  assert.equal(firefox.browser_specific_settings.gecko.id, "pi-light-local@example.invalid");
  assert.deepEqual(chromium.background, { service_worker: "background.js" });
  assert.equal("browser_specific_settings" in chromium, false);
  await assert.rejects(readFile(new URL("./browser-addon/manifest.json", import.meta.url)), /ENOENT/);
});

test("buildBrowserAddon writes a loadable directory per target", async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-light-addon-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const target of ["firefox", "chromium"] as const) {
    const out = join(root, target, "nested");
    buildBrowserAddon(target, out);
    assert.deepEqual((await readdir(out)).sort(), [...BROWSER_ADDON_SHARED_FILES, "manifest.json"].sort());
    assert.deepEqual(JSON.parse(await readFile(join(out, "manifest.json"), "utf8")), await readManifest(target));
    for (const file of BROWSER_ADDON_SHARED_FILES) assert.equal(await readFile(join(out, file), "utf8"), await readFile(new URL(`./browser-addon/${file}`, import.meta.url), "utf8"));
    // Rebuilding over an existing directory is idempotent.
    buildBrowserAddon(target, out);
  }
  assert.throws(() => buildBrowserAddon("safari" as "firefox", join(root, "x")), /Unsupported/);
  assert.throws(() => buildBrowserAddon("firefox", " "), /required/);
  assert.throws(() => buildBrowserAddon("chromium", new URL("./browser-addon/", import.meta.url).pathname), /differ/);
});

test("bridge sends heartbeats only to authenticated clients", { timeout: 3000 }, async t => {
  const bridge = new BrowserBridge(19345, 1000, 20);
  t.after(() => bridge.close());
  assert.throws(() => new BrowserBridge(19346, 1000, 0), /heartbeat/);
  await bridge.start();
  const ws = new WebSocket(bridge.connectionInfo().url, { origin: "moz-extension://test-extension" });
  await once(ws, "open");
  const received: Array<{ type: string }> = [];
  ws.on("message", raw => received.push(JSON.parse(raw.toString())));
  await delay(80);
  assert.equal(received.length, 0, "unauthenticated client received data");
  ws.send(JSON.stringify({ type: "auth", token: bridge.connectionInfo().token }));
  for (let n = 0; received.filter(m => m.type === "heartbeat").length < 2 && n < 100; n++) await delay(10);
  assert.equal(received[0].type, "ready");
  assert.ok(received.slice(1).length >= 2 && received.slice(1).every(m => m.type === "heartbeat"));
  // Heartbeats do not disturb the request protocol.
  ws.send(JSON.stringify({ type: "binding", bound: true, ...binding }));
  for (let n = 0; !bridge.bound && n < 50; n++) await delay(2);
  assert.deepEqual(bridge.bound, binding);
});

test("addon resumes saved intent and tab on worker start, ignores heartbeats, and keeps token auth", async () => {
  const source = await readFile(new URL("./browser-addon/background.js", import.meta.url), "utf8");
  const token = "ab".repeat(32);
  const stored: Record<string, unknown> = { intent: { url: "ws://127.0.0.1:19339", token }, binding: { tabId: 7, origin } };
  const sockets: FakeSocket[] = [];
  class FakeSocket {
    static OPEN = 1;
    readyState = 0; sent: string[] = []; closed = false;
    onopen?: () => void; onclose?: () => void; onerror?: () => void; onmessage?: (event: { data: string }) => void;
    constructor(readonly url: string) { sockets.push(this); }
    send(message: string) { this.sent.push(message); }
    close() { if (this.closed) return; this.closed = true; this.readyState = 3; this.onclose?.(); }
    open() { this.readyState = 1; this.onopen?.(); }
    receive(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }); }
  }
  const listener = { addListener: () => {} };
  const logs: unknown[] = [];
  const tabUrl = { value: `${origin}/page` };
  const area = {
    get: async (keys: string[]) => Object.fromEntries(keys.filter(k => k in stored).map(k => [k, stored[k]])),
    set: async (values: Record<string, unknown>) => { Object.assign(stored, values); },
    remove: async (keys: string | string[]) => { for (const k of [keys].flat()) delete stored[k]; }
  };
  const load = () => {
    const context = vm.createContext({
      Date, URL, TextEncoder, WebSocket: FakeSocket, crypto: { randomUUID: () => "generation-restored" },
      console: { log: (...a: unknown[]) => logs.push(a), error: (...a: unknown[]) => logs.push(a), warn: (...a: unknown[]) => logs.push(a) },
      // Chromium shape: no `browser` global, promise-returning `chrome` namespace.
      chrome: {
        runtime: { onMessage: listener, id: "x", getURL: (p: string) => p, openOptionsPage: async () => {} }, action: { onClicked: listener },
        storage: { session: area, local: { get: async () => { throw new Error("local used"); } } },
        tabs: { onRemoved: listener, onUpdated: listener, onReplaced: listener, get: async (id: number) => ({ id, url: tabUrl.value }) },
        scripting: { executeScript: async () => [] }
      }
    });
    vm.runInContext(source, context);
    return context;
  };
  const settle = () => delay(5);

  let context = load();
  await settle();
  let ws = sockets.at(-1)!;
  assert.equal(ws.url, "ws://127.0.0.1:19339");
  ws.open();
  assert.deepEqual(ws.sent.map(m => JSON.parse(m)), [{ type: "auth", token }]);
  ws.receive({ type: "ready" });
  await settle();
  assert.deepEqual(JSON.parse(ws.sent.at(-1)!), { type: "binding", bound: true, generation: "generation-restored", origin });
  assert.equal(vm.runInContext("JSON.stringify({ tabId: binding.tabId, origin: binding.origin })", context), JSON.stringify({ tabId: 7, origin }));
  const before = ws.sent.length;
  ws.receive({ type: "heartbeat" });
  assert.equal(ws.closed, false);
  assert.equal(ws.sent.length, before);
  ws.receive({ type: "unexpected" });
  assert.equal(ws.closed, true, "unknown messages still fail closed");
  assert.equal(stored.binding, undefined, "a lost connection drops the remembered tab");
  assert.ok(stored.intent);

  // Worker restart where the remembered tab has since moved to another origin: reconnect but do not rebind.
  stored.binding = { tabId: 7, origin };
  tabUrl.value = "https://other.test/";
  context = load();
  await settle();
  ws = sockets.at(-1)!;
  ws.open(); ws.receive({ type: "ready" });
  await settle();
  assert.equal(vm.runInContext("binding", context), null);
  assert.equal(ws.sent.some(m => JSON.parse(m).type === "binding" && JSON.parse(m).bound === true), false);
  assert.equal(stored.binding, undefined);

  // A rejected (stale) token is forgotten so later worker starts stop retrying it.
  context = load();
  await settle();
  ws = sockets.at(-1)!;
  ws.open(); ws.close();
  await settle();
  assert.equal(stored.intent, undefined);
  const count = sockets.length;
  load();
  await settle();
  assert.equal(sockets.length, count, "no reconnect without a saved intent");
  assert.equal(JSON.stringify(logs).includes(token), false, "token must never be logged");
});

test("static DOM action fails closed without password reads or code-string injection", async () => {
  const source = await readFile(new URL("./browser-addon/background.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\.(cookies|history|downloads)\b|captureVisibleTab|\beval\(|new Function|tabs\.executeScript|\bcode\s*:|browserAction|console\./);
  assert.match(source, /scripting\.executeScript\(\{ target: \{ tabId: b\.tabId \}, func: pageAction, args: \[message\] \}\)/);
  assert.match(source, /globalThis\.browser \?\? globalThis\.chrome/);
  const start = source.indexOf("function pageAction(");
  const end = source.indexOf("\nasync function run(", start);
  const context = vm.createContext({ location: { origin }, Date, URL });
  vm.runInContext(source.slice(start, end), context);
  assert.throws(() => vm.runInContext(`pageAction(${JSON.stringify({ action: "snapshot", origin: "https://other.test", deadline: Date.now() + 1000 })})`, context), /Origin changed/);
  assert.throws(() => vm.runInContext(`pageAction(${JSON.stringify({ action: "snapshot", origin, deadline: 0 })})`, context), /expired/);
  assert.throws(() => vm.runInContext(`pageAction(${JSON.stringify({ action: "navigate", origin, deadline: Date.now() + 1000, url: "https://other.test" })})`, context), /Cross-origin/);
  class Element { static kind = "password"; type = Element.kind; hidden = false; disabled = false; readOnly = false; getClientRects() { return [1]; } }
  Object.assign(context, { HTMLInputElement: Element, HTMLTextAreaElement: class {}, document: { querySelectorAll: () => [new Element()] }, getComputedStyle: () => ({ visibility: "visible" }) });
  const control = { tagName: "INPUT", id: "login", disabled: false, getAttribute: (name: string) => name === "type" ? "text" : name === "name" ? "login" : null, get value(): never { throw new Error("Snapshot read an input value"); } };
  let nextText = 0;
  Object.assign(context, {
    NodeFilter: { SHOW_TEXT: 4 },
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    document: {
      title: "Example", body: {},
      createTreeWalker: () => ({ nextNode: () => nextText++ === 0 ? { textContent: "Visible page", parentElement: { closest: () => null, getClientRects: () => [1] } } : null }),
      querySelectorAll: () => [control]
    },
    location: { origin, pathname: "/page", search: "?credential=not-returned", hash: "#not-returned" }
  });
  const snapshot = vm.runInContext(`pageAction(${JSON.stringify({ action: "snapshot", origin, deadline: Date.now() + 1000 })})`, context);
  assert.equal(snapshot.url, `${origin}/page`);
  assert.equal(snapshot.text.trim(), "Visible page");
  assert.equal(snapshot.controls[0].id, "login");
  assert.equal("value" in snapshot.controls[0], false);
  Object.assign(context, { document: { querySelectorAll: () => [new Element()] } });
  for (const type of ["password", "file", "hidden"]) {
    Element.kind = type;
    assert.throws(() => vm.runInContext(`pageAction(${JSON.stringify({ action: "fill", origin, deadline: Date.now() + 1000, selector: "input", text: "data" })})`, context), /Fill refuses/);
  }
});

test("registration is lazy, local-only, read-only guarded, and shutdown-owned", async () => {
  // Test host mirrors Pi's dynamically registered API; production entrypoint intentionally accepts any.
  const commands: Record<string, { handler: (args: string, ctx: unknown) => Promise<void> }> = {};
  let tool: { execute: (id: string, params: unknown, signal: undefined, update: undefined, ctx: unknown) => Promise<unknown> } | undefined;
  let shutdown: (() => Promise<void>) | undefined;
  let readOnly = true;
  registerBrowserTools({ registerCommand: (name: string, definition: typeof commands[string]) => { commands[name] = definition; }, registerTool: (definition: NonNullable<typeof tool>) => { tool = definition; }, on: (_event: string, handler: () => Promise<void>) => { shutdown = handler; } }, { isReadOnly: () => readOnly }, new BrowserBridge(19344));
  assert.ok(tool);
  assert.deepEqual(Object.keys(commands), ["browser-connect", "browser-status"]);
  await assert.rejects(commands["browser-connect"].handler("", { hasUI: false, mode: "print" }), /local TUI/);
  let info = "";
  const ctx = { hasUI: true, mode: "tui", ui: { confirm: async (_title: string, body: string) => { info = body; return true; }, notify: () => {} } };
  try {
    await commands["browser-connect"].handler("", ctx);
    const token = /Token: ([a-f0-9]{64})/.exec(info)![1];
    info = "";
    // Isolated from the production port so a running Pi session cannot affect this test.
    const ws = new WebSocket("ws://127.0.0.1:19344", { origin: "moz-extension://test-extension" });
    await once(ws, "open");
    const ready = once(ws, "message");
    ws.send(JSON.stringify({ type: "auth", token })); await ready;
    ws.send(JSON.stringify({ type: "binding", bound: true, ...binding })); await delay(10);
    const click = { action: "click", selector: "button" };
    await assert.rejects(tool!.execute("test", click, undefined, undefined, ctx), /read-only/);
    readOnly = false;
    await assert.rejects(tool!.execute("test", click, undefined, undefined, { ...ctx, hasUI: false, mode: "print" }), /interactive confirmation/);
    await assert.rejects(tool!.execute("test", click, undefined, undefined, { ...ctx, ui: { ...ctx.ui, confirm: async () => false } }), /declined/);
    await assert.rejects(tool!.execute("test", click, undefined, undefined, { ...ctx, ui: { ...ctx.ui, confirm: async () => { readOnly = true; return true; } } }), /changed to read-only/);
    readOnly = false;
    const incoming = once(ws, "message");
    const executed = tool!.execute("test", click, undefined, undefined, ctx);
    const [raw] = await incoming;
    const request = JSON.parse(raw.toString());
    assert.equal(request.action, "click");
    ws.send(JSON.stringify({ type: "result", id: request.id, generation: binding.generation, ok: true, result: { dispatched: true } }));
    assert.ok(await executed);
  } finally { await shutdown!(); }
});
