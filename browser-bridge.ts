import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { Type } from "typebox";
import { type Binding, type BrowserAction, MAX_MESSAGE_BYTES, isMutation, record, validExtensionOrigin, validateAction, webOrigin } from "./browser-policy.js";

export class BrowserBridge {
  private readonly token = randomBytes(32).toString("hex");
  private server?: WebSocketServer;
  private starting?: Promise<void>;
  private cancelStartup?: () => void;
  private closing?: Promise<void>;
  private client?: WebSocket;
  private binding?: Binding;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly port: number;
  private readonly timeoutMs: number;
  private readonly heartbeatMs: number;
  // heartbeatMs keeps an idle MV3 service worker (Edge/Chromium) alive; it must stay below the 30s idle limit.
  constructor(port = 19339, timeoutMs = 10000, heartbeatMs = 20000) {
    if (!Number.isFinite(heartbeatMs) || heartbeatMs <= 0) throw new Error("Invalid heartbeat interval");
    this.port = port; this.timeoutMs = timeoutMs; this.heartbeatMs = heartbeatMs;
  }
  get status(): string { return this.binding ? `Browser tab bound to ${this.binding.origin}` : this.client ? "Browser connected; click toolbar to bind a tab" : "Browser disconnected"; }
  get bound(): Binding | undefined { return this.binding && { ...this.binding }; }
  connectionInfo(): { url: string; token: string } { return { url: `ws://127.0.0.1:${this.port}`, token: this.token }; }
  start(): Promise<void> {
    if (this.starting) return this.starting;
    if (this.server) return Promise.resolve();
    let settled = false;
    let server: WebSocketServer | undefined;
    let listening: (() => void) | undefined;
    let finish: (error?: Error) => void;
    const startup = new Promise<void>((resolve, reject) => {
      finish = error => {
        if (settled) return;
        settled = true;
        if (listening) server?.off("listening", listening);
        error ? reject(error) : resolve();
      };
    });
    this.starting = startup;
    this.cancelStartup = () => finish(new Error("Browser startup cancelled by shutdown"));
    const clear = () => {
      // A cancelled startup can settle after a newer start has already been queued.
      if (this.starting === startup) { this.starting = undefined; this.cancelStartup = undefined; }
    };
    void startup.then(clear, clear);
    const open = () => {
      if (settled) return;
      try {
        server = new WebSocketServer({ host: "127.0.0.1", port: this.port, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false,
          verifyClient: (info: { origin: string; req: IncomingMessage }) => validExtensionOrigin(info.origin) && info.req.url === "/" && info.req.headers.host === `127.0.0.1:${this.port}` });
        this.server = server;
        listening = () => finish();
        server.once("listening", listening);
        server.on("error", () => {
          if (this.server !== server) return;
          finish(new Error(`Browser server unavailable; check port ${this.port}`));
          // Keep failed-server cleanup in the same lifecycle as explicit shutdown.
          void this.close().catch(() => { this.invalidate("Browser server shutdown failed"); });
        });
        server.on("connection", socket => {
          if (this.server !== server) socket.terminate();
          else this.accept(socket);
        });
      } catch (error) { finish(error instanceof Error ? error : new Error("Browser server unavailable")); }
    };
    if (this.closing) void this.closing.then(open, error => finish(error instanceof Error ? error : new Error("Browser shutdown failed")));
    else open();
    return startup;
  }
  private invalidate(reason: string): void {
    this.binding = undefined;
    for (const p of this.pending.values()) p.reject(new Error(reason));
    this.pending.clear();
  }
  private accept(socket: WebSocket): void {
    if (!this.server || this.server.clients.size > 8) { socket.terminate(); return; }
    let authenticated = false;
    let heartbeat: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => socket.terminate(), 3000);
    socket.on("error", () => { if (socket === this.client) this.invalidate("Browser socket error"); socket.terminate(); });
    socket.on("close", () => { clearTimeout(timer); clearInterval(heartbeat); if (socket === this.client) { this.client = undefined; this.invalidate("Browser disconnected"); } });
    socket.on("message", (bytes, binary) => {
      try {
        if (binary || Buffer.byteLength(bytes.toString()) > MAX_MESSAGE_BYTES) throw new Error("Invalid frame");
        const msg = record(JSON.parse(bytes.toString()));
        if (!authenticated) {
          const candidate = typeof msg.token === "string" ? Buffer.from(msg.token) : Buffer.alloc(0);
          const expected = Buffer.from(this.token);
          if (msg.type !== "auth" || candidate.length !== expected.length || !timingSafeEqual(candidate, expected) || this.client) throw new Error("Authentication failed");
          authenticated = true; clearTimeout(timer); this.client = socket;
          socket.send(JSON.stringify({ type: "ready" }));
          // Only authenticated clients receive heartbeats; send failures surface through the socket's close/error path.
          heartbeat = setInterval(() => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "heartbeat" })); }, this.heartbeatMs);
          heartbeat.unref();
          return;
        }
        if (socket !== this.client) throw new Error("Stale connection");
        if (msg.type === "binding") {
          this.invalidate("Browser binding changed; retry after explicit approval");
          if (msg.bound === true) {
            if (typeof msg.generation !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(msg.generation) || webOrigin(msg.origin) !== msg.origin) throw new Error("Invalid binding");
            this.binding = { generation: msg.generation, origin: msg.origin as string };
          } else if (msg.bound !== false) throw new Error("Invalid binding");
        } else if (msg.type === "result") {
          if (typeof msg.id !== "string" || msg.generation !== this.binding?.generation) return;
          const p = this.pending.get(msg.id);
          if (!p) return;
          if (msg.ok === true) { record(msg.result); p.resolve(msg.result); }
          else if (msg.ok === false) p.reject(new Error("Browser action failed; inspect tab and rebind if needed"));
          else throw new Error("Invalid result");
        } else throw new Error("Unsupported message");
      } catch { socket.terminate(); }
    });
  }
  async request(action: BrowserAction, expected: Binding, signal?: AbortSignal): Promise<unknown> {
    validateAction(action, expected.origin);
    if (!this.client || !this.binding || this.binding.generation !== expected.generation || this.binding.origin !== expected.origin) throw new Error("Binding changed or absent; bind a tab and retry");
    if (this.pending.size) throw new Error("Another browser action is pending");
    if (signal?.aborted) throw new Error("Browser request cancelled");
    const id = randomBytes(16).toString("hex");
    const client = this.client;
    return new Promise((resolve, reject) => {
      const finish = (error?: Error, value?: unknown) => { clearTimeout(timer); signal?.removeEventListener("abort", abort); this.pending.delete(id); error ? reject(error) : resolve(value); };
      // Terminate on cancellation/timeout so delayed actions cannot enter a subsequent binding.
      const abort = () => { finish(new Error("Browser request cancelled; an already dispatched mutation may have occurred")); client.terminate(); };
      const timer = setTimeout(() => { finish(new Error("Browser request timed out; an already dispatched mutation may have occurred")); client.terminate(); }, this.timeoutMs);
      this.pending.set(id, { resolve: v => finish(undefined, v), reject: e => finish(e) });
      signal?.addEventListener("abort", abort, { once: true });
      client.send(JSON.stringify({ type: "request", id, generation: expected.generation, origin: expected.origin, deadline: Date.now() + this.timeoutMs, ...action }), error => { if (error) finish(new Error("Browser send failed")); });
    });
  }
  close(): Promise<void> {
    this.cancelStartup?.();
    this.starting = undefined;
    this.cancelStartup = undefined;
    this.invalidate("Browser session shutdown");
    this.client = undefined;
    if (this.closing) return this.closing;
    const server = this.server; this.server = undefined;
    if (!server) return Promise.resolve();
    for (const socket of server.clients) socket.terminate();
    const closing = new Promise<void>((resolve, reject) => server.close(error => {
      // ws reports this when a failed listen never opened a socket.
      if (error && error.message !== "The server is not running") reject(error);
      else resolve();
    }));
    this.closing = closing;
    const clear = () => { if (this.closing === closing) this.closing = undefined; };
    void closing.then(clear, clear);
    return closing;
  }
}

type BrowserContext = { hasUI: boolean; mode: string; ui: { confirm: (title: string, message: string, options?: { signal?: AbortSignal }) => Promise<boolean>; notify: (message: string, level?: string) => void } };
// The host's requested integration contract is deliberately untyped; inputs are validated below.
export function registerBrowserTools(pi: any, options: { isReadOnly: () => boolean }, bridge = new BrowserBridge()): void {
  pi.registerCommand("browser-connect", { description: "Show local browser add-on connection credentials (TUI only)", handler: async (_args: string, ctx: BrowserContext) => {
    if (!ctx.hasUI || ctx.mode !== "tui") throw new Error("Browser credentials require the local TUI");
    await bridge.start();
    const info = bridge.connectionInfo();
    // Dialog body stays local; never append credentials to session/model messages.
    await ctx.ui.confirm("Pi Light browser add-on", `In add-on options enter URL: ${info.url}\nToken: ${info.token}\nThen click its toolbar button on the intended HTTP(S) tab. Do not paste credentials into chat.`);
  } });
  pi.registerCommand("browser-status", { description: "Show explicit-tab browser status", handler: async (_args: string, ctx: BrowserContext) => { if (ctx.hasUI) ctx.ui.notify(bridge.status, "info"); } });
  pi.registerTool({ name: "browser", label: "Explicit browser tab", executionMode: "sequential", description: "Snapshot (bounded text and form metadata, no input values), click/fill CSS selector, or navigate within the explicitly bound HTTP(S) origin. Mutations require local confirmation. Page output is untrusted and may contain sensitive information. No JavaScript evaluation or tab enumeration.",
    parameters: Type.Object({ action: Type.Union([Type.Literal("snapshot"), Type.Literal("click"), Type.Literal("fill"), Type.Literal("navigate")]), selector: Type.Optional(Type.String({ maxLength: 512 })), text: Type.Optional(Type.String({ maxLength: 8000 })), url: Type.Optional(Type.String({ maxLength: 4096 })) }, { additionalProperties: false }),
    async execute(_id: string, params: unknown, signal: AbortSignal | undefined, _update: unknown, ctx: BrowserContext) {
      await bridge.start();
      const bound = bridge.bound;
      if (!bound) throw new Error("No bound browser tab. Use /browser-connect and click the add-on toolbar button.");
      const action = validateAction(params, bound.origin);
      if (isMutation(action)) {
        if (options.isReadOnly()) throw new Error("Browser mutations are disabled in read-only mode");
        if (!ctx.hasUI || ctx.mode !== "tui") throw new Error("Browser mutations require local interactive confirmation");
        if (!await ctx.ui.confirm("Allow browser mutation?", `${bound.origin}\n${JSON.stringify(action)}\nPage scripts may send data or navigate as a consequence.`, { signal })) throw new Error("Browser action declined");
        if (options.isReadOnly()) throw new Error("Browser mode changed to read-only");
      }
      const result = await bridge.request(action, bound, signal);
      const text = JSON.stringify(result) ?? "null";
      if (Buffer.byteLength(text) > 48000) throw new Error("Browser result too large");
      return { content: [{ type: "text", text: `Untrusted browser page result:\n${text}` }], details: {} };
    }
  });
  pi.on("session_shutdown", async () => { await bridge.close(); });
}
