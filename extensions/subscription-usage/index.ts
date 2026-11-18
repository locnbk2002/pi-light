// Subscription usage for Claude and ChatGPT/Codex accounts.
//
// /usage  - query every known account in parallel and list 5h / 7d windows.
// footer  - status item for the active model's account, updated from response
//           rate-limit headers (pi anthropic, claude-bridge) or by polling the
//           usage endpoint after each run (openai-codex).
//
// Accounts:
//   pi auth.json        anthropic*, openai-codex*  (tokens resolved/refreshed by pi)
//   Claude Code         ~/.claude/.credentials.json (used by claude-bridge)
//                       ~/.claude/.credentials-<profile>.json (cc-save profiles)
//   Codex CLI           ~/.codex/auth.json
// Tokens read from files are never refreshed here (refresh rotates the token
// and would log out Claude Code / Codex CLI); expired ones are reported.
//
// Endpoints are undocumented (the same ones Claude Code /usage and Codex CLI use).

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type Family = "claude" | "codex";
type Win = { label: string; used: number; resetAt?: number }; // used: 0..100, resetAt: epoch ms
type Account = { name: string; family: Family; token?: string; accountId?: string; dedupe?: string; note?: string };
type Report = { account: Account; plan?: string; windows: Win[]; error?: string };

const HOME = homedir();
const PI_AUTH = join(HOME, ".pi/agent/auth.json");
const CC_DIR = process.env.CLAUDE_CONFIG_DIR ?? join(HOME, ".claude");
const CODEX_AUTH = join(process.env.CODEX_HOME ?? join(HOME, ".codex"), "auth.json");
const STATUS_KEY = "usage";
const POLL_MIN_AGE_MS = 60_000;

const readJson = (path: string): any => {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
};

const jwtAccountId = (jwt?: string): string | undefined => {
	try {
		const payload = JSON.parse(Buffer.from(jwt!.split(".")[1], "base64url").toString());
		return payload["https://api.openai.com/auth"]?.chatgpt_account_id;
	} catch {
		return undefined;
	}
};

const familyOf = (provider?: string): Family | undefined =>
	provider === "anthropic" || provider === "claude-bridge" || provider?.startsWith("anthropic-")
		? "claude"
		: provider?.startsWith("openai-codex")
			? "codex"
			: undefined;

// ---------- account discovery ----------

async function piAccount(ctx: ExtensionContext, id: string, cred: any): Promise<Account | undefined> {
	const family = familyOf(id);
	if (!family || cred?.type !== "oauth") return undefined;
	let token: string | undefined;
	try {
		token = (await ctx.modelRegistry.getProviderAuth(id))?.auth.apiKey; // refreshed by pi
	} catch {}
	token ??= cred.expires > Date.now() ? cred.access : undefined;
	return {
		name: `pi ${id}`,
		family,
		token,
		accountId: family === "codex" ? (cred.accountId ?? jwtAccountId(token)) : undefined,
		dedupe: family === "codex" ? cred.accountId : cred.refresh,
		note: token ? undefined : "token expired, run /login",
	};
}

function claudeCodeAccount(file: string, name: string): Account | undefined {
	const o = readJson(file)?.claudeAiOauth;
	if (!o?.accessToken) return undefined;
	const fresh = !o.expiresAt || o.expiresAt > Date.now();
	return {
		name,
		family: "claude",
		token: fresh ? o.accessToken : undefined,
		dedupe: o.refreshToken,
		note: fresh ? undefined : "token expired, use this Claude Code login once to refresh",
	};
}

async function discoverAccounts(ctx: ExtensionContext): Promise<Account[]> {
	const accounts: Account[] = [];
	const auth = readJson(PI_AUTH) ?? {};
	for (const [id, cred] of Object.entries(auth)) {
		const acc = await piAccount(ctx, id, cred);
		if (acc) accounts.push(acc);
	}

	// Claude Code: active login (claude-bridge) first, then saved profiles.
	const activeProfile = safeRead(join(CC_DIR, ".active-profile"));
	const active = claudeCodeAccount(join(CC_DIR, ".credentials.json"), `claude-code${activeProfile ? ` ${activeProfile}` : ""} (bridge)`);
	if (active) accounts.push(active);
	let files: string[] = [];
	try {
		files = readdirSync(CC_DIR).filter((f) => /^\.credentials-.+\.json$/.test(f));
	} catch {}
	for (const f of files.sort()) {
		const profile = f.slice(".credentials-".length, -".json".length);
		const acc = claudeCodeAccount(join(CC_DIR, f), `claude-code ${profile}`);
		// Skip the profile that is currently active: its copy is stale (cc-save runs on exit).
		if (acc && !(active && profile === activeProfile)) accounts.push(acc);
	}

	const codex = readJson(CODEX_AUTH)?.tokens;
	if (codex?.access_token) {
		accounts.push({
			name: "codex-cli",
			family: "codex",
			token: codex.access_token,
			accountId: codex.account_id ?? jwtAccountId(codex.access_token),
			dedupe: codex.account_id,
		});
	}

	// Same login seen through several files: keep one, preferring a usable token.
	const keyOf = (a: Account) => a.dedupe && `${a.family}:${a.dedupe}`;
	const usable = new Set(accounts.filter((a) => a.token).map(keyOf).filter(Boolean));
	const seen = new Set<string>();
	return accounts.filter((a) => {
		const key = keyOf(a);
		if (!key) return true;
		if (seen.has(key) || (!a.token && usable.has(key))) return false;
		seen.add(key);
		return true;
	});
}

function safeRead(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8").trim() || undefined;
	} catch {
		return undefined;
	}
}

// ---------- usage endpoints ----------

async function getJson(url: string, headers: Record<string, string>, signal?: AbortSignal): Promise<any> {
	const res = await fetch(url, { headers, signal: signal ?? AbortSignal.timeout(15_000) });
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return res.json();
}

const CLAUDE_WINDOWS: [string, string][] = [
	["five_hour", "5h"],
	["seven_day", "7d"],
	["seven_day_opus", "7d opus"],
	["seven_day_sonnet", "7d sonnet"],
];

const windowLabel = (seconds?: number) =>
	!seconds ? "?" : seconds % 86_400 === 0 ? `${seconds / 86_400}d` : `${Math.round(seconds / 3600)}h`;

async function fetchUsage(acc: Account): Promise<Report> {
	if (!acc.token) return { account: acc, windows: [], error: acc.note ?? "no token" };
	try {
		if (acc.family === "claude") {
			const d = await getJson("https://api.anthropic.com/api/oauth/usage", {
				Authorization: `Bearer ${acc.token}`,
				"anthropic-beta": "oauth-2025-04-20",
			});
			const windows = CLAUDE_WINDOWS.flatMap(([key, label]) =>
				d[key] ? [{ label, used: d[key].utilization ?? 0, resetAt: d[key].resets_at ? Date.parse(d[key].resets_at) : undefined }] : [],
			);
			return { account: acc, windows };
		}
		const d = await getJson("https://chatgpt.com/backend-api/wham/usage", {
			Authorization: `Bearer ${acc.token}`,
			...(acc.accountId ? { "ChatGPT-Account-Id": acc.accountId } : {}),
		});
		const windows = [d.rate_limit?.primary_window, d.rate_limit?.secondary_window]
			.filter(Boolean)
			.map((w: any) => ({ label: windowLabel(w.limit_window_seconds), used: w.used_percent ?? 0, resetAt: w.reset_at ? w.reset_at * 1000 : undefined }));
		return { account: acc, plan: d.plan_type, windows };
	} catch (e) {
		return { account: acc, windows: [], error: e instanceof Error ? e.message : String(e) };
	}
}

// ---------- formatting ----------

function countdown(resetAt?: number): string {
	if (!resetAt) return "";
	const min = Math.max(0, Math.round((resetAt - Date.now()) / 60_000));
	const d = Math.floor(min / 1440);
	const h = Math.floor((min % 1440) / 60);
	const m = min % 60;
	return d ? `${d}d${h}h` : h ? `${h}h${String(m).padStart(2, "0")}m` : `${m}m`;
}

const fmtWindows = (ws: Win[]) =>
	ws.map((w) => `${w.label} ${Math.round(w.used)}%${w.resetAt ? ` ${countdown(w.resetAt)}` : ""}`).join(" · ");

function fmtReport(r: Report): string {
	const head = `${r.account.name}${r.plan ? ` [${r.plan}]` : ""}`;
	return r.error ? `${head}: ${r.error}` : `${head}: ${fmtWindows(r.windows) || "no data"}`;
}

// ---------- rate-limit headers ----------

function windowsFromHeaders(h: Record<string, string>): { family: Family; windows: Win[] } | undefined {
	const lower = Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
	const num = (k: string) => (lower[k] === undefined ? undefined : Number(lower[k]));

	const claude = (["5h", "7d"] as const).flatMap((label) => {
		const used = num(`anthropic-ratelimit-unified-${label}-utilization`);
		const reset = num(`anthropic-ratelimit-unified-${label}-reset`);
		return used === undefined || Number.isNaN(used) ? [] : [{ label, used: used * 100, resetAt: reset ? reset * 1000 : undefined }];
	});
	if (claude.length) return { family: "claude", windows: claude };

	const codex = (["primary", "secondary"] as const).flatMap((slot) => {
		const used = num(`x-codex-${slot}-used-percent`);
		if (used === undefined || Number.isNaN(used)) return [];
		const minutes = num(`x-codex-${slot}-window-minutes`);
		const resetAt = num(`x-codex-${slot}-reset-at`);
		const after = num(`x-codex-${slot}-reset-after-seconds`);
		return [{
			label: minutes ? windowLabel(minutes * 60) : slot === "primary" ? "5h" : "7d",
			used,
			resetAt: resetAt ? resetAt * 1000 : after !== undefined ? Date.now() + after * 1000 : undefined,
		}];
	});
	return codex.length ? { family: "codex", windows: codex } : undefined;
}

// ---------- extension ----------

export default function (pi: ExtensionAPI) {
	// Footer cache keyed by pi provider id (anthropic, claude-bridge, openai-codex, ...).
	const cache = new Map<string, { windows: Win[]; at: number }>();
	let lastCtx: ExtensionContext | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	const inflight = new Set<string>();

	const render = (ctx: ExtensionContext | undefined = lastCtx) => {
		if (!ctx?.hasUI) return;
		const provider = ctx.model?.provider;
		const entry = provider ? cache.get(provider) : undefined;
		if (!entry?.windows.length) return ctx.ui.setStatus(STATUS_KEY, undefined);
		const label = familyOf(provider) === "claude" ? "claude" : "codex";
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", `${label} ${fmtWindows(entry.windows)}`));
	};

	// The account behind the active provider, for footer polling.
	const activeAccount = async (ctx: ExtensionContext): Promise<Account | undefined> => {
		const provider = ctx.model?.provider;
		if (!provider || !familyOf(provider)) return undefined;
		if (provider === "claude-bridge") return claudeCodeAccount(join(CC_DIR, ".credentials.json"), "claude-code (bridge)");
		return piAccount(ctx, provider, (readJson(PI_AUTH) ?? {})[provider]);
	};

	const poll = (ctx: ExtensionContext, force = false) => {
		const provider = ctx.model?.provider;
		if (!ctx.hasUI || !provider || !familyOf(provider) || inflight.has(provider)) return;
		const entry = cache.get(provider);
		if (!force && entry && Date.now() - entry.at < POLL_MIN_AGE_MS) return;
		inflight.add(provider);
		const started = Date.now();
		(async () => {
			const acc = await activeAccount(ctx);
			const r = acc ? await fetchUsage(acc) : undefined;
			// Newer header data wins over this poll; a failed poll (e.g. after cc-use to a
			// logged-out account) clears the entry so a previous account is never shown.
			if ((cache.get(provider)?.at ?? 0) > started) return;
			if (r && !r.error) cache.set(provider, { windows: r.windows, at: Date.now() });
			else cache.delete(provider);
			render();
		})()
			.catch(() => {})
			.finally(() => inflight.delete(provider));
	};

	pi.on("session_start", async (_event, ctx) => {
		lastCtx = ctx;
		if (!ctx.hasUI) return;
		timer ??= setInterval(() => render(), 60_000); // keep countdowns current, no network
		poll(ctx);
	});

	pi.on("session_shutdown", async () => {
		if (timer) clearInterval(timer);
		timer = undefined;
	});

	pi.on("model_select", async (_event, ctx) => {
		lastCtx = ctx;
		render(ctx);
		poll(ctx);
	});

	pi.on("after_provider_response", (event, ctx) => {
		lastCtx = ctx;
		const parsed = windowsFromHeaders(event.headers ?? {});
		if (!parsed) return;
		const provider = ctx.model?.provider;
		// Headers carry no provider id: only trust them when they match the active model's family
		// (an advisor call to the other family must not overwrite the footer).
		if (!provider || familyOf(provider) !== parsed.family) return;
		cache.set(provider, { windows: parsed.windows, at: Date.now() });
		render(ctx);
	});

	// Codex over WebSocket may expose no headers, and the Claude Code login may have been
	// switched (cc-use): re-read the active account's usage after each run.
	pi.on("agent_end", async (_event, ctx) => {
		lastCtx = ctx;
		poll(ctx, true);
	});

	pi.registerCommand("usage", {
		description: "Show Claude and ChatGPT/Codex subscription usage for every known account",
		handler: async (_args, ctx) => {
			lastCtx = ctx;
			const accounts = await discoverAccounts(ctx);
			if (!accounts.length) return ctx.ui.notify("usage: no Claude or Codex OAuth logins found", "warning");
			ctx.ui.notify(`usage: checking ${accounts.length} account(s)...`, "info");
			const reports = await Promise.all(accounts.map(fetchUsage));
			const lines = (family: Family, title: string) => {
				const rs = reports.filter((r) => r.account.family === family);
				return rs.length ? [title, ...rs.map((r) => `  ${fmtReport(r)}`)] : [];
			};
			ctx.ui.notify([...lines("claude", "Claude"), ...lines("codex", "ChatGPT / Codex")].join("\n"), "info");
			poll(ctx, true);
		},
	});
}
