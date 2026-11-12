// Pi Light browser relay: one local process shared by every Pi session and the single browser add-on.
// Pi sessions join on /pi and the add-on joins on /ext. Both run a challenge-response over one long-lived
// pairing secret (a user-only file; pasted once into each browser profile's add-on), and each checks the
// relay's own proof before trusting it, so neither a squatted port nor another extension learns anything.
// Messages are routed by session id; the relay never interprets browser actions (Pi validates requests,
// the add-on enforces tab policy).
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, linkSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";

export const DEFAULT_PORT = 19339;
const MAX_MESSAGE_BYTES = 64 * 1024;
// Only a screenshot result from the add-on may be this large.
const MAX_SCREENSHOT_MESSAGE_BYTES = 3 * 1024 * 1024;
const SESSION = /^[a-f0-9]{32}$/;
const NONCE = /^[a-f0-9]{32}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const EXT_ORIGIN = /^chrome-extension:\/\/[a-p]{32}\/?$/;
const MAX_SESSIONS = 16;

function record(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object");
  return value;
}
/** HMAC-SHA256 over the `|`-joined parts, keyed by the hex pairing secret. Labels keep each role's proof distinct. */
export function pairingProof(secret, ...parts) {
  return createHmac("sha256", Buffer.from(secret, "hex")).update(parts.join("|")).digest("hex");
}
function sameHex(candidate, expected) {
  if (typeof candidate !== "string" || !HEX64.test(candidate)) return false;
  return timingSafeEqual(Buffer.from(candidate, "hex"), Buffer.from(expected, "hex"));
}
/** Reads the pairing secret, creating it (0600, never overwritten) on first use. */
export function ensurePairingSecret(path) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    // Written to a private temp file, then linked into place: the link fails if another process created it first.
    const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(temp, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
    try { linkSync(temp, path); } catch (error) { if (error.code !== "EEXIST") throw error; } finally { rmSync(temp, { force: true }); }
  } catch (error) { if (error.code !== "EEXIST") throw error; }
  if (statSync(path).mode & 0o077) chmodSync(path, 0o600);
  const secret = readFileSync(path, "utf8").trim();
  if (!HEX64.test(secret)) throw new Error("Invalid pairing secret file");
  return secret;
}

/**
 * Starts the relay. Resolves once it listens.
 * `onIdle` runs when no Pi session has been connected for `idleMs` (the CLI exits then).
 */
export function startRelay({ port = DEFAULT_PORT, secretPath, idleMs = 60000, heartbeatMs = 20000, onIdle = () => {} }) {
  if (!secretPath) throw new Error("secretPath required");
  let secret;
  try { secret = ensurePairingSecret(secretPath); } catch (error) { return Promise.reject(error); }
  const sessions = new Map(); // session id -> socket
  let ext;
  let idle;
  const armIdle = () => { clearTimeout(idle); if (!sessions.size) { idle = setTimeout(onIdle, idleMs); idle.unref?.(); } };
  const toExt = message => { if (ext?.readyState === WebSocket.OPEN) ext.send(JSON.stringify(message)); };
  const broadcast = message => { const text = JSON.stringify(message); for (const s of sessions.values()) if (s.readyState === WebSocket.OPEN) s.send(text); };

  const server = new WebSocketServer({ host: "127.0.0.1", port, maxPayload: MAX_SCREENSHOT_MESSAGE_BYTES, perMessageDeflate: false,
    verifyClient: ({ origin, req }) => {
      if (req.headers.host !== `127.0.0.1:${port}`) return false;
      // Web pages always send an Origin; only an extension may send one, and only on /ext.
      if (req.url === "/ext") return typeof origin === "string" && EXT_ORIGIN.test(origin);
      return req.url === "/pi" && origin === undefined;
    } });

  /**
   * Challenge-response: the client proves the pairing secret for this relay nonce before anything else
   * flows, and the relay's reply proves it to the client. `label` separates add-on and Pi proofs.
   */
  function handshake(socket, label, onAuthenticated) {
    const relayNonce = randomBytes(16).toString("hex");
    const timer = setTimeout(() => socket.terminate(), 3000);
    socket.on("error", () => socket.terminate());
    socket.on("close", () => clearTimeout(timer));
    const listener = (bytes, binary) => {
      try {
        const raw = bytes.toString();
        if (binary || Buffer.byteLength(raw) > MAX_MESSAGE_BYTES) throw new Error("Invalid frame");
        const msg = record(JSON.parse(raw));
        if (msg.type !== "auth" || typeof msg.nonce !== "string" || !NONCE.test(msg.nonce)) throw new Error("Authentication failed");
        const session = label === "pi" ? msg.session : "";
        if (label === "pi" && (typeof session !== "string" || !SESSION.test(session))) throw new Error("Authentication failed");
        if (!sameHex(msg.proof, pairingProof(secret, label, relayNonce, msg.nonce, session))) throw new Error("Authentication failed");
        clearTimeout(timer);
        socket.off("message", listener);
        onAuthenticated({ proof: pairingProof(secret, "relay", label, relayNonce, msg.nonce, session), session });
      } catch { socket.terminate(); }
    };
    socket.on("message", listener);
    socket.send(JSON.stringify({ type: "challenge", nonce: relayNonce }));
  }

  function acceptExt(socket) {
    handshake(socket, "ext", ({ proof }) => {
      // One browser profile at a time; a second paired add-on keeps retrying until the first leaves.
      if (ext && ext.readyState === WebSocket.OPEN) { socket.terminate(); return; }
      ext = socket;
      const heartbeat = setInterval(() => toExt({ type: "heartbeat" }), heartbeatMs);
      heartbeat.unref?.();
      socket.on("close", () => {
        clearInterval(heartbeat);
        if (ext !== socket) return;
        ext = undefined;
        broadcast({ type: "browser", connected: false });
      });
      socket.on("message", (bytes, binary) => {
        try {
          const raw = bytes.toString();
          if (binary || (Buffer.byteLength(raw) > MAX_MESSAGE_BYTES && !raw.startsWith('{"type":"result",'))) throw new Error("Invalid frame");
          const msg = record(JSON.parse(raw));
          if ((msg.type !== "tabs" && msg.type !== "result") || typeof msg.session !== "string" || !SESSION.test(msg.session)) throw new Error("Invalid message");
          const target = sessions.get(msg.session);
          delete msg.session;
          // A session that just left may still receive a late reply; drop it.
          if (target?.readyState === WebSocket.OPEN) target.send(JSON.stringify(msg));
        } catch { socket.terminate(); }
      });
      socket.send(JSON.stringify({ type: "ready", proof, sessions: [...sessions.keys()] }));
      broadcast({ type: "browser", connected: true });
    });
  }

  function acceptPi(socket) {
    let session;
    handshake(socket, "pi", ({ proof, session: requested }) => {
      if (sessions.has(requested) || sessions.size >= MAX_SESSIONS) { socket.terminate(); return; }
      session = requested;
      sessions.set(session, socket);
      clearTimeout(idle);
      socket.on("message", (bytes, binary) => {
        try {
          const raw = bytes.toString();
          if (binary || Buffer.byteLength(raw) > MAX_MESSAGE_BYTES) throw new Error("Invalid frame");
          const msg = record(JSON.parse(raw));
          if (msg.type !== "request") throw new Error("Unsupported message");
          // The relay, not the client, names the session: a Pi session can only act as itself.
          toExt({ ...msg, session });
        } catch { socket.terminate(); }
      });
      socket.send(JSON.stringify({ type: "ready", proof, browser: Boolean(ext && ext.readyState === WebSocket.OPEN) }));
      toExt({ type: "session", session, open: true });
    });
    socket.on("close", () => {
      if (!session || sessions.get(session) !== socket) return;
      sessions.delete(session);
      toExt({ type: "session", session, open: false });
      armIdle();
    });
  }

  server.on("connection", (socket, req) => { if (req.url === "/ext") acceptExt(socket); else acceptPi(socket); });
  const close = () => new Promise(resolve => {
    clearTimeout(idle);
    for (const socket of server.clients) socket.terminate();
    server.close(() => resolve());
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.once("listening", () => {
      server.off("error", reject);
      server.on("error", () => {});
      armIdle();
      resolve({ port, close });
    });
  });
}

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? process.argv[index + 1] : undefined;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(argument("port") ?? DEFAULT_PORT);
  const idleMs = Number(argument("idle-ms") ?? 60000);
  startRelay({ port, secretPath: argument("secret"), idleMs, onIdle: () => process.exit(0) })
    // Losing the port race to another relay is normal: the sessions use that one.
    .catch(() => process.exit(1));
}
