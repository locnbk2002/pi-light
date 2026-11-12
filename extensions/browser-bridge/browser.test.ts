import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { BrowserBridge, type BrowserBridgeOptions, registerBrowserTools } from "./browser-bridge.js";
import { type ControlledTab, MAX_MESSAGE_BYTES, isMutation, validTabs, validateAction, validExtensionOrigin } from "./browser-policy.js";
import { ensurePairingSecret, pairingProof, startRelay } from "./browser-relay.mjs";

const EXT = `chrome-extension://${"abcdefghijklmnop".repeat(2)}`;
const origin = "https://example.com";
const bound: ControlledTab = { name: "bound", generation: "generation-1", kind: "bound", origin };
const owned: ControlledTab = { name: "main", generation: "generation-2", kind: "owned", origin };
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const until = async (check: () => unknown, what: string) => {
  for (let n = 0; n < 200; n++) { if (check()) return; await delay(5); }
  assert.fail(`Timed out waiting for ${what}`);
};
// Values created inside the add-on VM have foreign prototypes; compare their JSON form.
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const nextMessage = async (ws: WebSocket) => JSON.parse((await once(ws, "message"))[0].toString());

type Relay = Awaited<ReturnType<typeof startRelay>>;
// Pairing secret of the newest test relay; loaded add-ons are paired with it unless told otherwise.
let currentPairing = "";
/** A relay on `port` with a private pairing file, plus a factory for Pi sessions joined to it. */
async function relayFor(t: TestContext, port: number, relayOptions: { idleMs?: number; heartbeatMs?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "pi-light-relay-"));
  const secretPath = join(dir, "secret");
  const relay: Relay = await startRelay({ port, secretPath, ...relayOptions });
  const pairing = (await readFile(secretPath, "utf8")).trim();
  currentPairing = pairing;
  const bridges: BrowserBridge[] = [];
  const session = async (options: BrowserBridgeOptions = {}) => {
    const bridge = new BrowserBridge({ port, secretPath, timeoutMs: 2000, connectTimeoutMs: 1000, reconnectMs: 20, launch: () => {}, ...options });
    bridges.push(bridge);
    await bridge.start();
    return bridge;
  };
  t.after(async () => {
    disposeAddons();
    for (const bridge of bridges) await bridge.close();
    await relay.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { relay, secretPath, pairing, session, dir };
}
/** One Pi session joined to a fresh relay on the add-on test port. */
async function joined(t: TestContext, port = 19347) { return (await relayFor(t, port)).session(); }

/** Opens a socket and runs the pairing handshake as `label`; resolves with the relay's reply and collected messages. */
async function handshake(url: string, options: object, pairing: string, label: "ext" | "pi", session = "") {
  const ws = new WebSocket(url, options);
  const received: any[] = [];
  ws.on("message", raw => received.push(JSON.parse(raw.toString())));
  ws.on("error", () => {});
  const closed = new Promise(resolve => ws.on("close", resolve));
  await until(() => received.length > 0 || ws.readyState === WebSocket.CLOSED, "challenge");
  const challenge = received.shift();
  const nonce = "9".repeat(32);
  if (challenge?.type === "challenge") ws.send(JSON.stringify({ type: "auth", nonce, ...(label === "pi" ? { session } : {}), proof: pairingProof(pairing, label, challenge.nonce, nonce, session) }));
  await Promise.race([until(() => received.length > 0, "handshake reply").catch(() => {}), closed]);
  const reply = received[0];
  const proven = Boolean(challenge && reply?.type === "ready" && reply.proof === pairingProof(pairing, "relay", label, challenge.nonce, nonce, session));
  return { ws, received, reply, proven, closed, challenge };
}

/** Raw stand-in for the add-on on /ext. Collects relay messages; `tabs(session, list)` announces tabs for one session. */
async function fakeExtension(port: number, pairing = currentPairing) {
  const { ws, received, proven } = await handshake(`ws://127.0.0.1:${port}/ext`, { origin: EXT }, pairing, "ext");
  assert.ok(proven, "relay proved the pairing secret");
  return {
    ws, received,
    send: (message: object) => ws.send(JSON.stringify(message)),
    tabs: (session: string, tabs: ControlledTab[]) => ws.send(JSON.stringify({ type: "tabs", session, tabs })),
    nextRequest: async () => { await until(() => received.some(m => m.type === "request"), "request"); return received.splice(received.findIndex(m => m.type === "request"), 1)[0]; }
  };
}

test("relay admits Pi sessions and the add-on only after a pairing proof, and proves itself in return", { timeout: 8000 }, async t => {
  const { secretPath, pairing, session } = await relayFor(t, 19340);
  assert.equal((await stat(secretPath)).mode & 0o777, 0o600, "pairing file is user-only");
  assert.match(pairing, /^[a-f0-9]{64}$/);
  // The pairing secret is long-lived: neither a competing relay nor a restart replaces it.
  await assert.rejects(startRelay({ port: 19340, secretPath }));
  assert.equal((await readFile(secretPath, "utf8")).trim(), pairing);

  const wrong = "0".repeat(64);
  const sessionId = "c".repeat(32);
  const refused = async (path: string, options: object, secret: string, label: "ext" | "pi", id = "") => {
    const attempt = await handshake(`ws://127.0.0.1:19340${path}`, options, secret, label, id);
    await attempt.closed;
    // Nothing but the challenge (or nothing at all) reaches an unproven client.
    assert.deepEqual(attempt.received.filter(m => m.type !== "challenge"), [], `${path} ${JSON.stringify(options)}`);
    assert.equal(attempt.proven, false);
  };
  await refused("/pi", {}, wrong, "pi", sessionId);
  await refused("/pi", {}, pairing, "pi", "not-a-session");
  await refused("/pi", {}, pairing, "ext");
  // An unrelated extension (valid origin, no secret) can neither become the browser nor see session ids.
  await refused("/ext", { origin: `chrome-extension://${"p".repeat(32)}` }, wrong, "ext");
  // A Pi proof is not accepted as an add-on proof.
  await refused("/ext", { origin: EXT }, pairing, "pi", sessionId);
  // Web pages always send an Origin: they can reach neither endpoint.
  for (const foreign of ["https://evil.test", EXT]) await refused("/pi", { origin: foreign }, pairing, "pi", sessionId);
  for (const foreign of [undefined, "https://evil.test", "moz-extension://test-extension"]) await refused("/ext", foreign ? { origin: foreign } : {}, pairing, "ext");
  await refused("/other", { origin: EXT }, pairing, "ext");

  const first = await session();
  // The same session id cannot join twice.
  await refused("/pi", {}, pairing, "pi", first.session);
  const ext = await fakeExtension(19340);
  assert.deepEqual(ext.received[0].sessions, [first.session]);
  await until(() => first.connected, "browser connected");
  // A second paired add-on (another profile) waits until the first leaves.
  const other = await handshake("ws://127.0.0.1:19340/ext", { origin: EXT }, pairing, "ext");
  await other.closed;
  assert.equal(other.proven, false);
  assert.equal(first.connected, true);
});

test("neither Pi nor the add-on trusts a program on the port that cannot prove the pairing secret", { timeout: 8000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "pi-light-relay-"));
  const secretPath = join(dir, "secret");
  const pairing = ensurePairingSecret(secretPath);
  // An impostor relay: answers every challenge-response with a ready lacking a valid proof, and records everything.
  const seen: string[] = [];
  const impostor = new WebSocketServer({ host: "127.0.0.1", port: 19346 });
  impostor.on("connection", socket => {
    socket.send(JSON.stringify({ type: "challenge", nonce: "1".repeat(32) }));
    socket.on("message", raw => { seen.push(raw.toString()); socket.send(JSON.stringify({ type: "ready", proof: "2".repeat(64), browser: true, sessions: [] })); });
  });
  t.after(async () => { await new Promise(resolve => impostor.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  const bridge = new BrowserBridge({ port: 19346, secretPath, connectTimeoutMs: 400, launch: () => {} });
  await assert.rejects(bridge.start(), /relay unavailable/);
  await bridge.close();
  assert.ok(seen.length > 0);
  for (const message of seen) {
    assert.doesNotMatch(message, new RegExp(pairing), "the secret is never sent");
    assert.equal(JSON.parse(message).type, "auth", "nothing but the proof reaches the impostor");
  }
  const addon = await loadAddon({ pairing, url: "ws://127.0.0.1:19346/ext" });
  await until(() => /could not prove the pairing secret/.test(vm.runInContext("status", addon.context)), "add-on refuses impostor");
  assert.equal(vm.runInContext("ready", addon.context), false);
  addon.dispose();
  for (const message of seen) assert.doesNotMatch(message, new RegExp(pairing));
  // Unpaired add-ons do not connect at all.
  const unpaired = await loadAddon({ pairing: null });
  await delay(30);
  assert.equal(vm.runInContext("socket", unpaired.context), null);
  assert.match(vm.runInContext("status", unpaired.context), /Not paired/);
});

test("several Pi sessions share one add-on: routing, per-session tabs, session end and browser loss", { timeout: 5000 }, async t => {
  const { session, pairing } = await relayFor(t, 19341);
  const a = await session();
  const ext = await fakeExtension(19341);
  const b = await session();
  assert.notEqual(a.session, b.session);
  await until(() => ext.received.some(m => m.type === "session" && m.session === b.session && m.open === true), "session open notice");
  await until(() => a.connected && b.connected, "both connected");
  ext.tabs(a.session, [bound, owned]);
  ext.tabs(b.session, [bound]);
  await until(() => a.tabs.length === 2 && b.tabs.length === 1, "per-session tabs");
  assert.deepEqual(b.tabs, [bound]);

  // Requests carry the session the relay assigned; results reach only that session.
  const fromA = a.request({ action: "snapshot", tab: "main" }, owned);
  const fromB = b.request({ action: "tabs" });
  const first = await ext.nextRequest();
  const second = await ext.nextRequest();
  const requests = new Map([[first.session, first], [second.session, second]]);
  assert.deepEqual([...requests.keys()].sort(), [a.session, b.session].sort());
  ext.send({ type: "result", id: requests.get(b.session).id, session: a.session, ok: true, result: { stolen: true } });
  ext.send({ type: "result", id: requests.get(b.session).id, session: b.session, ok: true, result: { tabs: [] } });
  ext.send({ type: "result", id: requests.get(a.session).id, session: a.session, generation: owned.generation, ok: true, result: { text: "a" } });
  assert.deepEqual(await fromB, { tabs: [] });
  assert.deepEqual(await fromA, { text: "a" });

  // A session cannot speak for another: the relay overwrites any session it sends.
  const rawSession = "d".repeat(32);
  const { ws: raw, reply, proven } = await handshake("ws://127.0.0.1:19341/pi", {}, pairing, "pi", rawSession);
  assert.ok(proven);
  assert.equal(reply.browser, true);
  raw.send(JSON.stringify({ type: "request", id: "e".repeat(32), session: a.session, action: "tabs" }));
  assert.equal((await ext.nextRequest()).session, rawSession);

  // One session leaving is announced to the add-on; the other keeps working.
  await a.close();
  await until(() => ext.received.some(m => m.type === "session" && m.session === a.session && m.open === false), "session close notice");
  assert.equal(b.connected, true);
  raw.close();

  // Losing the browser invalidates pending work and tabs in every session.
  const pending = b.request({ action: "snapshot" }, bound);
  await ext.nextRequest();
  ext.ws.close();
  await assert.rejects(pending, /disconnected/);
  await until(() => !b.connected, "browser loss");
  assert.deepEqual(b.tabs, []);
});

test("bridge protocol: generations, tabless actions, bounds, timeout, cancellation and shutdown", { timeout: 8000 }, async t => {
  const { session } = await relayFor(t, 19342);
  const bridge = await session({ timeoutMs: 150 });
  let ext = await fakeExtension(19342);
  ext.tabs(bridge.session, [bound, owned]);
  await until(() => bridge.tabs.length === 2, "tabs");
  assert.equal(bridge.resolveTab()?.name, "bound");
  assert.equal(bridge.resolveTab("main")?.kind, "owned");
  assert.equal(bridge.resolveTab("nope"), undefined);
  const result = bridge.request({ action: "snapshot", tab: "main" }, owned);
  let request = await ext.nextRequest();
  assert.equal(request.action, "snapshot");
  assert.equal(request.tab, "main");
  assert.equal(request.generation, owned.generation);
  assert.equal(request.session, bridge.session);
  assert.equal("token" in request, false);
  // A result carrying another generation is ignored.
  ext.send({ type: "result", id: request.id, session: bridge.session, generation: bound.generation, ok: true, result: { text: "wrong" } });
  ext.send({ type: "result", id: request.id, session: bridge.session, generation: owned.generation, ok: true, result: { text: "hello" } });
  assert.deepEqual(await result, { text: "hello" });
  // Tabless actions carry no generation.
  const opened = bridge.request({ action: "open", url: `${origin}/x`, name: "second" });
  request = await ext.nextRequest();
  assert.equal("generation" in request, false);
  ext.send({ type: "result", id: request.id, session: bridge.session, ok: false, error: "Tab name in use or invalid" });
  await assert.rejects(opened, /Browser action failed: Tab name in use or invalid/);
  // A pending request on a tab that vanishes is rejected.
  const pending = bridge.request({ action: "click", selector: "button" }, bound);
  const rejected = assert.rejects(pending, /tab changed/);
  await ext.nextRequest();
  ext.tabs(bridge.session, [{ ...bound, generation: "generation-3" }, owned]);
  await rejected;
  await assert.rejects(bridge.request({ action: "snapshot" }, bound), /changed or absent/);
  await assert.rejects(bridge.request({ action: "navigate", url: "https://other.test/" }, bridge.resolveTab("bound")), /origin/);
  // Large frames are only admitted as a pending screenshot result.
  const big = (id: string, generation?: string) => JSON.stringify({ type: "result", id, session: bridge.session, ...(generation ? { generation } : {}), ok: true, result: { data: "A".repeat(MAX_MESSAGE_BYTES) } });
  const shot = bridge.request({ action: "screenshot", tab: "main" }, owned);
  request = await ext.nextRequest();
  ext.ws.send(big(request.id, owned.generation));
  assert.equal(((await shot) as { data: string }).data.length, MAX_MESSAGE_BYTES);
  // An unsolicited large frame ends the session's relay connection; the bridge rejoins under the same id.
  ext.ws.send(big("0".repeat(32)));
  await until(() => bridge.tabs.length === 0, "oversized frame drops tabs");
  await until(() => ext.received.some(m => m.type === "session" && m.open === true && m.session === bridge.session), "rejoined");
  await until(() => bridge.connected, "reconnected");
  ext.tabs(bridge.session, [bound]);
  await until(() => bridge.tabs.length === 1, "tabs again");
  // Timeout and cancellation leave the relay (ending the session in the add-on) and rejoin.
  const opens = () => ext.received.filter(m => m.type === "session" && m.open === true).length;
  const rejoin = async (before: number, what: string) => {
    await until(() => opens() > before && bridge.connected, what);
    ext.tabs(bridge.session, [bound]);
    await until(() => bridge.tabs.length === 1, `tabs ${what}`);
  };
  let before = opens();
  await assert.rejects(bridge.request({ action: "snapshot" }, bound), /timed out/);
  await ext.nextRequest();
  await rejoin(before, "after timeout");
  const aborter = new AbortController();
  before = opens();
  const cancelled = assert.rejects(bridge.request({ action: "snapshot" }, bound, aborter.signal), /cancelled/);
  await ext.nextRequest(); aborter.abort(); await cancelled;
  await rejoin(before, "after cancel");
  const shutdown = assert.rejects(bridge.request({ action: "snapshot" }, bound), /shutdown/);
  await ext.nextRequest(); await bridge.close(); await shutdown;
  await delay(60);
  assert.equal(bridge.connected, false, "a closed bridge does not rejoin");
  await bridge.close();
  ext.ws.close();
});

test("startup cancellation, repeated shutdown and overlapping restart settle deterministically", { timeout: 5000 }, async t => {
  const { secretPath } = await relayFor(t, 19343);
  const bridge = new BrowserBridge({ port: 19343, secretPath, connectTimeoutMs: 1000, launch: () => {} });
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
  const ext = await fakeExtension(19343);
  await until(() => bridge.connected, "connected");
  await bridge.close();
  await bridge.close();
  await until(() => ext.received.some(m => m.type === "session" && m.open === false), "left relay");
  // A queued restart is itself cancellable before the previous close finishes.
  await bridge.start();
  const stopping = bridge.close();
  const queued = bridge.start();
  const queuedCancelled = assert.rejects(queued, /cancel|shutdown/i);
  const stoppingAgain = bridge.close();
  await Promise.all([stopping, stoppingAgain, queuedCancelled]);
  await bridge.start();
  await until(() => bridge.connected, "connected again");
  ext.tabs(bridge.session, [bound]);
  await until(() => bridge.tabs.length === 1, "tabs");
  const result = bridge.request({ action: "snapshot" }, bound);
  const request = await ext.nextRequest();
  ext.send({ type: "result", id: request.id, session: bridge.session, generation: bound.generation, ok: true, result: { text: "restarted" } });
  assert.deepEqual(await result, { text: "restarted" });
  ext.ws.close();
});

test("start launches the relay when none runs, reports an unavailable port, and rejoins a restarted relay", { timeout: 8000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "pi-light-relay-"));
  const secretPath = join(dir, "secret");
  let relay: Relay | undefined;
  let launches = 0;
  const launch = () => { launches++; void startRelay({ port: 19344, secretPath }).then(r => { relay = r; }); };
  const bridge = new BrowserBridge({ port: 19344, secretPath, connectTimeoutMs: 2000, reconnectMs: 20, launch });
  const second = new BrowserBridge({ port: 19344, secretPath, connectTimeoutMs: 2000, launch });
  t.after(async () => { await bridge.close(); await second.close(); await relay?.close(); await rm(dir, { recursive: true, force: true }); });
  await bridge.start();
  assert.equal(launches, 1);
  await second.start();
  assert.equal(launches, 1, "a running relay is joined, not launched again");
  const firstRelay = relay!;
  await firstRelay.close();
  relay = undefined;
  // Both sessions rejoin a new relay under their own session ids (one of them launches it).
  await until(() => relay !== undefined, "relay relaunched");
  const joinedRelay = (b: BrowserBridge) => b.status !== "Browser relay not joined";
  await until(() => joinedRelay(bridge) && joinedRelay(second), "both sessions rejoined");
  assert.equal(launches, 2);
  await relay!.close();
  relay = undefined;
  await bridge.close(); await second.close();
  const stuck = new BrowserBridge({ port: 19344, secretPath, connectTimeoutMs: 300, launch: () => {} });
  await assert.rejects(stuck.start(), /relay unavailable; check port 19344/);
  await stuck.close();
});

test("the relay CLI creates the pairing secret, serves sessions and exits once idle", { timeout: 8000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "pi-light-relay-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const secretPath = join(dir, "nested", "secret");
  const script = fileURLToPath(new URL("./browser-relay.mjs", import.meta.url));
  const child = spawn(process.execPath, [script, "--port", "19348", "--secret", secretPath, "--idle-ms", "300"], { stdio: "ignore" });
  const exited = once(child, "exit");
  const bridge = new BrowserBridge({ port: 19348, secretPath, connectTimeoutMs: 3000, launch: () => {} });
  await bridge.start();
  assert.equal((await stat(secretPath)).mode & 0o777, 0o600);
  // Joined sessions keep it alive past the idle timeout.
  await delay(500);
  assert.equal(child.exitCode, null);
  await bridge.close();
  const [code] = await exited;
  assert.equal(code, 0);
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

test("relay heartbeats reach only the add-on", { timeout: 3000 }, async t => {
  const { session } = await relayFor(t, 19345, { heartbeatMs: 20 });
  const bridge = await session();
  const ext = await fakeExtension(19345);
  await until(() => ext.received.filter(m => m.type === "heartbeat").length >= 2, "heartbeats");
  assert.equal(ext.received[0].type, "ready");
  ext.tabs(bridge.session, [bound]);
  await until(() => bridge.tabs.length === 1, "tabs");
  ext.ws.close();
});

const readManifest = async () => JSON.parse(await readFile(new URL("./browser-addon/manifest.json", import.meta.url), "utf8"));

test("Chromium MV3 manifest: debugger without host access, fixed CSP, no Firefox leftovers", async () => {
  const manifest = await readManifest();
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ["debugger", "tabs", "tabGroups", "storage", "alarms"]);
  for (const key of ["host_permissions", "optional_host_permissions", "optional_permissions", "content_scripts", "browser_specific_settings", "externally_connectable", "web_accessible_resources"]) assert.equal(key in manifest, false, key);
  assert.doesNotMatch(JSON.stringify(manifest), /<all_urls>|:\/\/\*/);
  assert.deepEqual(manifest.background, { service_worker: "background.js" });
  assert.deepEqual(manifest.options_ui, { page: "options.html", open_in_tab: true });
  assert.equal(manifest.content_security_policy.extension_pages, "script-src 'self'; object-src 'none'; connect-src ws://127.0.0.1:19339");
  for (const file of await readdir(new URL("./browser-addon/", import.meta.url))) assert.doesNotMatch(await readFile(new URL(`./browser-addon/${file}`, import.meta.url), "utf8"), /firefox|moz-extension|globalThis\.browser/i, file);
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

const addons: Array<{ dispose: () => void }> = [];
function disposeAddons() { for (const addon of addons.splice(0)) addon.dispose(); }

async function loadAddon(options: { enabled?: boolean; pairing?: string | null; url?: string; tabs?: Array<{ id: number; url: string; title?: string }>; stored?: Record<string, unknown>; page?: any; attachFails?: boolean; gate?: { group?: () => Promise<void>; attach?: (tabId: number) => Promise<void>; remove?: () => Promise<void> } } = {}) {
  const [background, cdpSource] = await Promise.all(["background.js", "cdp.js"].map(f => readFile(new URL(`./browser-addon/${f}`, import.meta.url), "utf8")));
  const listeners: Record<string, Array<(...args: any[]) => void>> = {};
  const event = (name: string) => ({ addListener: (f: (...args: any[]) => void) => { (listeners[name] ??= []).push(f); } });
  const fire = (name: string, ...args: unknown[]) => { for (const f of listeners[name] ?? []) f(...args); };
  const stored: Record<string, unknown> = { ...options.stored };
  const local: Record<string, unknown> = { enabled: options.enabled ?? true, pairing: options.pairing === undefined ? currentPairing : options.pairing };
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
    }, local: {
      get: async (defaults: Record<string, unknown>) => ({ ...defaults, ...local }),
      set: async (values: Record<string, unknown>) => { Object.assign(local, values); }
    } },
    alarms: { create: () => {}, onAlarm: event("alarm") },
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
    // Unref'd timers: an add-on retrying a stopped relay never keeps the test process alive.
    Date, URL, TextEncoder, WebSocket: ExtensionSocket, chrome, Promise, JSON,
    setTimeout: (f: () => void, ms: number) => setTimeout(f, ms).unref(), clearTimeout,
    crypto: { randomUUID: (() => { let n = 0; return () => `gen-${++n}`; })(), subtle: webcrypto.subtle, getRandomValues: (array: Uint8Array) => webcrypto.getRandomValues(array) },
    Uint8Array, parseInt,
    console: { log: (...a: unknown[]) => logs.push(a), error: (...a: unknown[]) => logs.push(a), warn: (...a: unknown[]) => logs.push(a) },
    importScripts: (file: string) => { assert.equal(file, "cdp.js"); vm.runInContext(cdpSource, context); }
  });
  // The live Pi may own the production port; the test relay listens on 19347.
  vm.runInContext(background.replace('"ws://127.0.0.1:19339/ext"', JSON.stringify(options.url ?? "ws://127.0.0.1:19347/ext")), context);
  const addon = { context, chrome, fire, stored, local, tabs, page, calls, attached, removed, logs, dispose: () => vm.runInContext("enabled = false; clearTimeout(reconnectTimer); if (socket) socket.close()", context) };
  addons.push(addon);
  return addon;
}

test("add-on end to end over the real bridge: open, read, real input, evaluate, screenshot, logs and close", { timeout: 8000 }, async t => {
  const bridge = await joined(t);
  const addon = await loadAddon();
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
  const bridge = await joined(t);
  const addon = await loadAddon({ tabs: [{ id: 7, url: `${origin}/inbox` }, { id: 8, url: "chrome://settings" }] });
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
  const raw = vm.runInContext("(m) => run({ ...m, incarnation: live.get(m.session) }, socket)", addon.context);
  const session = bridge.session;
  await assert.rejects(raw({ id: "a".repeat(32), session, deadline: Date.now() + 1000, action: "close", tab: "bound", generation: userTab.generation }), /opened by Pi/);
  await assert.rejects(raw({ id: "b".repeat(32), session, deadline: Date.now() + 1000, action: "navigate", url: "https://other.test/", tab: "bound", generation: userTab.generation }), /stay on its origin/);
  await assert.rejects(raw({ id: "c".repeat(32), session, deadline: Date.now() + 1000, action: "snapshot", tab: "bound", generation: "stale" }), /Tab changed/);
  await assert.rejects(raw({ id: "d".repeat(32), session: "e".repeat(32), deadline: Date.now() + 1000, action: "snapshot", tab: "bound", generation: userTab.generation }), /not joined/);

  await bridge.request({ action: "open", url: `${origin}/a` });
  await bridge.request({ action: "open", url: `${origin}/b`, name: "kept", keep: true });
  assert.deepEqual(bridge.tabs.map(t => t.name).sort(), ["bound", "kept", "main"]);
  assert.deepEqual(plain(addon.stored.owned), [{ name: "main", session, tabId: 100, keep: false }, { name: "kept", session, tabId: 101, keep: true }]);

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
  assert.deepEqual(plain(addon.stored.owned), []);
  assert.deepEqual(addon.logs, [], "the add-on never logs");
});

test("add-on re-adopts remembered tabs of live sessions after a worker restart and closes those of ended sessions", { timeout: 8000 }, async t => {
  const bridge = await joined(t);
  const s = bridge.session;
  const ended = "f".repeat(32);
  const addon = await loadAddon({
    tabs: [{ id: 7, url: `${origin}/inbox` }, { id: 100, url: "https://app.test/" }, { id: 101, url: "chrome://newtab" }, { id: 102, url: `${origin}/old` }, { id: 103, url: `${origin}/old-kept` }],
    stored: { binding: { tabId: 7, origin }, owned: [
      { name: "main", session: s, tabId: 100, keep: false }, { name: "gone", session: s, tabId: 999, keep: false }, { name: "internal", session: s, tabId: 101, keep: false },
      { name: "bound", session: s, tabId: 5 }, { name: "nosession", tabId: 104, keep: false },
      { name: "main", session: ended, tabId: 102, keep: false }, { name: "kept", session: ended, tabId: 103, keep: true }
    ] }
  });
  await until(() => bridge.tabs.length === 2, "re-adopted tabs");
  assert.deepEqual(bridge.tabs.map(t => [t.name, t.kind, t.origin]).sort(), [["bound", "bound", origin], ["main", "owned", "https://app.test"]]);
  await until(() => addon.removed.includes(102), "ended session's tab closed");
  assert.equal(addon.tabs.has(103), true, "an ended session's kept tab stays open");
  assert.equal(addon.attached.has(102) || addon.attached.has(103), false);

  // Disabled in options: the add-on never connects.
  const disabled = await loadAddon({ enabled: false });
  await delay(50);
  assert.equal(vm.runInContext("socket", disabled.context), null);
});

test("add-on fails closed when the debugger cannot attach", { timeout: 5000 }, async t => {
  const bridge = await joined(t);
  const addon = await loadAddon({ attachFails: true });
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
    start: async () => {}, waitForBrowser: async () => true, connected: true, tabs: [bound, owned],
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
  const bridge = await joined(t);
  const addon = await loadAddon({ gate: { remove: () => delay(300).then(() => {}) } });
  await until(() => bridge.connected, "add-on connection");
  await bridge.request({ action: "open", url: `${origin}/` });
  assert.deepEqual(await bridge.request({ action: "close" }, bridge.resolveTab("main")), { closed: "main" });
  // Previously the add-on stayed busy until the (slow) tab removal finished.
  assert.deepEqual(plain(await bridge.request({ action: "tabs" })), { tabs: [] });
  await until(() => addon.removed.length === 1, "tab removed");
});

test("actual add-on snapshots fit the full UTF-8 response envelope over WebSocket", { timeout: 8000 }, async t => {
  const bridge = await joined(t);
  const addon = await loadAddon();
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
  const bridge = await joined(t);
  const addon = await loadAddon();
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
  const bridge = await joined(t);
  let release!: () => void;
  let paused = false;
  const gate = { group: () => { paused = true; return new Promise<void>(resolve => { release = resolve; }); } };
  const addon = await loadAddon({ gate });
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
  vm.runInContext(`ready = true; joinSession("${"a".repeat(32)}")`, addon.context);
  paused = false;
  const keptOpen = vm.runInContext(`openTab(${JSON.stringify({ url: `${origin}/kept`, name: "kept", keep: true, session: "a".repeat(32) })})`, addon.context).catch((error: Error) => error);
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
  const slow = await loadAddon({ enabled: false, tabs: [{ id: 7, url: `${origin}/inbox` }], gate: { attach: () => { attaching = true; return new Promise<void>(resolve => { releaseAttach = resolve; }); } } });
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
  // Disabled: the worker stays idle until the test drives re-adoption directly.
  const restart = await loadAddon({ enabled: false, tabs: [{ id: 100, url: `${origin}/a` }], gate: { attach: () => { attaching = true; return new Promise<void>(resolve => { releaseAttach = resolve; }); } } });
  await delay(20);
  vm.runInContext(`joinSession("${"a".repeat(32)}"); pendingOwned = [{ name: 'main', session: "${"a".repeat(32)}", tabId: 100, keep: false, kind: 'owned' }]; ready = true; void readopt()`, restart.context);
  await until(() => attaching, "re-adoption attaching");
  vm.runInContext("dropAll('test disconnect')", restart.context);
  releaseAttach();
  await delay(20);
  assert.deepEqual(restart.removed, [100]);
  assert.equal(restart.attached.has(100), false);
  assert.equal(vm.runInContext("controlled.size", restart.context), 0);
});

test("console, accessibility and evaluate results shrink to the UTF-8 envelope budget instead of failing", { timeout: 8000 }, async t => {
  const bridge = await joined(t);
  const addon = await loadAddon();
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
  const bridge = await joined(t);
  const waiting = new Map<number, () => void>();
  const gate = { attach: (tabId: number) => tabId === 1 ? new Promise<void>(resolve => waiting.set(1, resolve)) : Promise.resolve() };
  const tabs = [{ id: 1, url: `${origin}/one` }, { id: 2, url: `${origin}/two` }];
  const addon = await loadAddon({ tabs, gate });
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
  const addon = await loadAddon({ enabled: false });
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

test("two Pi sessions drive one add-on at once: own tabs, shared bound tab, queued actions, per-session cleanup", { timeout: 8000 }, async t => {
  const { session } = await relayFor(t, 19347);
  const a = await session();
  const addon = await loadAddon({ tabs: [{ id: 7, url: `${origin}/inbox` }] });
  const b = await session();
  await until(() => a.connected && b.connected, "both sessions connected");
  // Both sessions may use the same tab name; each sees only its own Pi-opened tabs.
  await a.request({ action: "open", url: `${origin}/a` });
  await b.request({ action: "open", url: "https://b.test/" });
  await b.request({ action: "open", url: "https://b.test/kept", name: "kept", keep: true });
  assert.deepEqual(a.tabs.map(t => [t.name, t.origin]), [["main", origin]]);
  assert.deepEqual(b.tabs.map(t => [t.name, t.origin]).sort(), [["kept", "https://b.test"], ["main", "https://b.test"]]);
  assert.deepEqual((plain(await a.request({ action: "tabs" })) as { tabs: Array<{ name: string }> }).tabs.map(t => t.name), ["main"]);
  // A session cannot reach another session's tab, even by name and generation.
  const bMain = b.resolveTab("main")!;
  const raw = vm.runInContext("(m) => run({ ...m, incarnation: live.get(m.session) }, socket)", addon.context);
  await assert.rejects(raw({ id: "a".repeat(32), session: a.session, deadline: Date.now() + 1000, action: "snapshot", tab: "main", generation: bMain.generation }), /Tab changed/);

  // The toolbar-bound tab is shared by every session.
  addon.fire("click", { id: 7, url: `${origin}/inbox` });
  await until(() => a.resolveTab("bound") && b.resolveTab("bound"), "bound tab in both sessions");
  assert.equal(a.resolveTab()!.name, "bound");

  // Simultaneous requests from both sessions are queued, not refused as busy.
  const [ra, rb] = await Promise.all([a.request({ action: "snapshot" }, a.resolveTab("main")), b.request({ action: "snapshot" }, b.resolveTab("main"))]) as Array<{ url: string }>;
  assert.equal(ra.url, `${origin}/page`);
  assert.equal(rb.url, `${origin}/page`);

  // Session A ending closes only its unkept tabs; B keeps its tabs and the bound tab.
  await a.close();
  await until(() => addon.removed.length === 1, "A's tab closed");
  assert.deepEqual(addon.removed, [100]);
  await delay(30);
  assert.deepEqual(b.tabs.map(t => t.name).sort(), ["bound", "kept", "main"]);
  assert.ok(addon.attached.has(7), "bound tab stays controlled");
  assert.deepEqual(plain(await b.request({ action: "snapshot" }, b.resolveTab("main"))).url, `${origin}/page`);
  // B ending closes its unkept tab but never the kept one or the user's tab.
  await b.close();
  await until(() => addon.removed.length === 2, "B's tab closed");
  assert.deepEqual(addon.removed.sort(), [100, 101]);
  assert.equal(addon.tabs.has(102), true);
  assert.equal(addon.tabs.has(7), true);
});

test("a request cancelled while queued never runs after its session rejoins under the same id", { timeout: 8000 }, async t => {
  const { session } = await relayFor(t, 19347);
  const a = await session();
  const addon = await loadAddon({ tabs: [{ id: 7, url: `${origin}/inbox` }] });
  const b = await session();
  await until(() => a.connected && b.connected, "both sessions connected");
  addon.page.elements["#go"] = [new FakeElement("BUTTON", {}, addon.page)];
  addon.fire("click", { id: 7, url: `${origin}/inbox` });
  await until(() => a.resolveTab("bound") && b.resolveTab("bound"), "shared bound tab");
  const generation = a.resolveTab("bound")!.generation;
  // B holds the add-on's queue with a slow wait.
  const slow = b.request({ action: "waitFor", selector: "#absent", timeoutMs: 500 }, b.resolveTab("bound"));
  await delay(50);
  // A queues a click behind it, then cancels before it starts; A rejoins at once under the same session id.
  const aborter = new AbortController();
  const click = a.request({ action: "click", selector: "#go" }, a.resolveTab("bound"), aborter.signal).catch(error => error);
  await delay(50);
  aborter.abort();
  assert.match(String(await click), /cancelled/);
  await until(() => a.connected && a.resolveTab("bound")?.generation === generation, "A rejoined and sees the same bound tab");
  assert.deepEqual(await slow, { found: false });
  await delay(50);
  assert.equal(addon.calls.filter(c => c.method === "Input.dispatchMouseEvent").length, 0, "the cancelled click never dispatched");
  // A fresh click from the rejoined session works.
  assert.deepEqual(await a.request({ action: "click", selector: "#go" }, a.resolveTab("bound")), { dispatched: true });
});

test("one session ending during worker-restart re-adoption does not strand another session's tabs", { timeout: 8000 }, async t => {
  let releaseAttach!: () => void;
  let paused = false;
  const A = "a".repeat(32), B = "b".repeat(32);
  const addon = await loadAddon({ enabled: false, tabs: [{ id: 100, url: `${origin}/a` }, { id: 101, url: `${origin}/b` }], gate: { attach: tabId => tabId === 100 ? new Promise<void>(resolve => { paused = true; releaseAttach = resolve; }) : Promise.resolve() } });
  t.after(() => addon.dispose());
  await delay(20);
  vm.runInContext(`joinSession("${A}"); joinSession("${B}"); pendingOwned = [{ name: "main", session: "${A}", tabId: 100, keep: false, kind: "owned" }, { name: "main", session: "${B}", tabId: 101, keep: false, kind: "owned" }]; ready = true; void readopt()`, addon.context);
  await until(() => paused, "A's tab attaching");
  vm.runInContext(`endSession("${A}")`, addon.context);
  await delay(10);
  // B's not-yet-adopted tab stays saved while A's entry is gone.
  assert.deepEqual(plain(addon.stored.owned), [{ name: "main", session: B, tabId: 101, keep: false }]);
  releaseAttach();
  await until(() => vm.runInContext(`controlled.has("${B}/main")`, addon.context), "B's tab re-adopted");
  assert.equal(vm.runInContext(`controlled.has("${A}/main")`, addon.context), false);
  assert.equal(addon.attached.has(100), false, "A's debugger released");
  assert.deepEqual(addon.removed, [100], "A's unkept tab closed");
  assert.deepEqual(plain(addon.stored.owned), [{ name: "main", session: B, tabId: 101, keep: false }]);
  assert.equal(vm.runInContext("pendingOwned.length", addon.context), 0);
});
