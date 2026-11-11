# pi-light

A personal workflow package for the [Pi](https://github.com/earendil-works/pi) coding agent. It needs AgentKit's Pi adapter.

The package root is the workflow core. Each feature is its own extension under `extensions/`, and every one loads by default:

| Extension | Provides |
|---|---|
| `extensions/workflow` | Stage routing, advisors, model fallback, cross-family review, the `locbt-router` skill policy |
| `extensions/browser-bridge` | The `browser` tool, `/browser-connect`, `/browser-status` and the Chromium add-on |
| `extensions/herdr-layout` | herdr subagent pane layout |
| `extensions/herdr-permission-bridge` | herdr `blocked` status while a permission prompt waits |
| `extensions/setup` | `/pi-light setup` and the missing-AgentKit warning |

- **Stage routing.** Opus is the controller. Each request is routed as advice, brainstorm, plan or implement and mapped to an AgentKit skill. The agent only edits files when you ask for an implementation.
- **Advisors.** Astra (`gpt-6-astra`) and Fable (`claude-fable-5-1`) give a second opinion through hidden Pi processes. `/advisor astra|fable` opens a direct chat, and `/back` hands the result back to Opus.
- **Effort judge.** A small model picks the reasoning effort (low to xhigh) for each subagent spawn and each advisor message, judging how open-ended the task is. The controller's own effort stays with `/effort`. See Effort judge below.
- **Model fallback.** When a provider limit is hit, the controller falls back from Opus to Sol, and each advisor falls back to the other.
- **Cross-family review.** Reviews of the controller's own work run on a model from another vendor family: an Opus-written change is reviewed by Sol (and by Opus if Sol wrote it). The controller passes that model explicitly when it delegates a review subagent.
- **Browser bridge.** A Chromium add-on (Brave, Chromium, Chrome, Edge) lets Pi open and drive its own tabs in your signed-in browser, and use a tab you bind with the toolbar button. Every click, key press, navigation, script and tab open or close asks you first.
- **herdr subagent layout.** Up to 3 subagents from `pi-herdr-subagents` stack beside your pane. When a 4th starts, all of them move to their own tabs. `PI_HERDR_MAX_SPLIT` changes the limit, and `PI_HERDR_LAYOUT=tab|split` changes the mode.

## Install

```sh
bash <(curl -fsSL https://raw.githubusercontent.com/locnbk2002/pi-light/main/bootstrap.sh)
```

You need `pi`, `git` and `node`. For the full setup, also install the AgentKit CLI (`ak`, logged in) and herdr. The bootstrap installs this package (or updates a pre-0.5 checkout) and then runs `extensions/setup/setup.mjs`. Setup shows its plan and asks before it changes anything. It installs:

- the AgentKit `engineer` Pi adapter (pinned version in `extensions/setup/setup.json`; needs a matching `ak`, e.g. `ak self-update --beta --yes`) with the skill list in `setup.json`;
- the latest `pi-effort` and `pi-claude-bridge`, and a pinned upstream `pi-herdr-subagents`;
- herdr's Pi integration and the subagents plugin link;
- a loadable browser add-on folder in `~/.pi/agent/pi-light/browser/chromium/`;
- the latest `@gotgenes/pi-permission-system` and, if none exists yet, its rule file (see Permissions below).

Setup is safe to rerun, either as `/pi-light setup` inside Pi or as `node extensions/setup/setup.mjs --dry-run`. It reports deliberate differences instead of reverting them. It never touches credentials or your default model.

Load the browser add-on by hand: open `brave://extensions` (or `chrome://extensions`, `edge://extensions`), turn on Developer mode, choose **Load unpacked**, and pick `~/.pi/agent/pi-light/browser/chromium/`. After an update, rerun setup and click the add-on's reload button there. Firefox is not supported.

Then run `/browser-connect` in Pi and paste the URL and token into the add-on's options page.

### Load only some extensions

Narrow what loads with the object form of the package entry in `~/.pi/agent/settings.json` (or toggle them in `pi config`). Drop the browser bridge:

```json
{ "source": "git:github.com/locnbk2002/pi-light", "extensions": ["!extensions/browser-bridge/**"] }
```

Or load only the browser bridge, without the workflow skill:

```json
{ "source": "git:github.com/locnbk2002/pi-light", "extensions": ["extensions/browser-bridge/index.ts"], "skills": [] }
```

Without the workflow extension there is no direct advisor chat, so the browser never enters read-only mode. Extensions never import each other; the browser asks the workflow for read-only state over `pi.events`. The model chains are machine-local: see Models below.

## Browser tool

The `browser` tool takes named actions; there is no raw DevTools endpoint.

| Action | What it does | Asks first on your bound tab |
|---|---|---|
| `tabs` | List the tabs Pi controls | no |
| `open {url, name?, keep?}` | Open a background tab Pi owns (default name `main`, grouped as "pi") | always asks |
| `close {tab}` | Close a tab Pi opened | (Pi-owned only) |
| `snapshot {mode: text\|ax}` | Visible text and controls, or the accessibility tree (roles and labels); never text typed into fields | no |
| `screenshot {fullPage?}` | JPEG image, at most 1600 px wide and 8000 px tall | no |
| `click`, `hover {selector}` | Real mouse input on one visible, uncovered element | click only |
| `fill {selector, text}` | Real typing into a text field (never password, file or hidden fields) | yes |
| `press {key}`, `scroll {dy}` | Real key press; mouse wheel | press only |
| `waitFor {selector \| text, timeoutMs}` | Wait up to 8 s | no |
| `console` | Last 200 console entries. URLs lose their query strings, but page-logged text can still hold private data | yes |
| `network` | Last 200 requests after Pi attached (a tab's first document request is usually missed): method, origin and path, status and type, never headers or query strings | no |
| `evaluate {code}` | Run JavaScript in the page and return its JSON value | yes |
| `navigate {url}` | Go to a URL. A bound tab must stay on its origin; Pi's own tabs may go anywhere over HTTP(S) | yes |

Approval: opening a tab always asks. On a tab Pi opened, every other action runs without a prompt, so approving `open` lets Pi browse, type, run scripts and read console output there, signed in as you. On the tab you bound, the actions marked above ask each time. Read-only mode (during direct advisor chat) refuses every action that changes something (open, close, click, fill, press, navigate, evaluate) on any tab.

Without `tab`, actions use the bound tab, then `main`, then the only controlled tab.

How control works and what it costs:

- The add-on uses the browser's debugger API through a fixed list of allowed DevTools methods, and only on tabs you bound or Pi opened. The browser shows a "debugging this browser" bar while it does; dismissing it releases control of the tab.
- Tabs Pi opened close when Pi disconnects, unless it opened them with `keep`. Pi never closes a tab it did not open.
- A bound tab is released when it leaves its origin; bind it again to continue.
- Page content, console output and evaluated values are untrusted and can contain private data or instructions. This is not secret isolation.

## Permissions

Pi runs every tool call without asking. Setup installs [`@gotgenes/pi-permission-system`](https://www.npmjs.com/package/@gotgenes/pi-permission-system) and writes `~/.pi/agent/extensions/pi-permission-system/config.json` from the rules in `extensions/setup/setup.json`. These are fixed rules, not a model judge:

- Everything runs as before, except that `rm`, `curl`, `git push`, `git commit`, `ssh`, `scp`, `rsync` and `sftp` ask first. Reading `~/.ssh/id_*` private keys is denied.
- Read-only remote commands run without asking on every host named in that machine's `~/.ssh/config`: `ssh <host> cat|head|tail|grep|find|stat|du ...`, `ssh <host> ls|df|ps...` and `ssh <host> uptime`. Write them unquoted. SSH hands its arguments to a remote shell, so anything that remote shell could act on asks: quotes, chain or redirect characters, `$`, a backslash, `[`, `sudo`, and `find -delete|-exec|-ok|-fprint|-fls`. A filename produced by a local `*` glob is the one known gap.
- The extension's bash rules are last-match-wins, so the risky remote forms come last. Without an interactive prompt (`pi -p`, RPC), an ask is denied.

While a permission prompt waits for you, the `herdr-permission-bridge` extension marks the pane `blocked` in herdr (also in subagent panes), so herdr shows it as waiting and `herdr agent wait --until blocked` returns. It relays the extension's `permissions:ui_prompt` and `permissions:decision` events to herdr's own Pi integration and needs that integration installed.

Setup never overwrites an existing rule file; it reports when the file differs from the generated rules. After adding hosts to `~/.ssh/config`, delete the file and rerun setup. Pattern rules are an approval policy, not a sandbox.

## Models

The defaults are the controller `anthropic/claude-opus-5-5` with fallback `openai-codex/gpt-6.1-sol`, Astra `openai-codex/gpt-6-astra`, and Fable `anthropic/claude-fable-5-1`. If a machine is logged in under other provider names, rename them in `~/.pi/agent/pi-light-models.json`:

```json
{ "providers": { "anthropic": "claude-bridge", "openai-codex": "openai" } }
```

You can also replace whole lists with the `controller`, `astra` and `fable` keys. Advisors run without extensions, except the one that provides their model's provider (for example `pi-claude-bridge`).

## Effort judge

Before a subagent is spawned or an advisor answers, a small judge model rates how open-ended the task is and picks the child's reasoning level. It judges whether the fix or design is given or which causes stay open, not how much work there is, and picks the lower level when torn.

| Level | When |
|---|---|
| `low` | One obvious solution, mechanically applied |
| `medium` | A few candidates in one area, or one small trap |
| `high` | Several viable designs or candidate causes |
| `xhigh` | Open cause of flaky, concurrent or stale behavior; easy to get subtly wrong |

`max` is never chosen automatically. The main controller's level is never changed.

- **What the judge reads.** For a subagent, the first `solutionSpace:` line of its task (the controller is told to write one), otherwise the task text. For an advisor, `consult_advisor`'s optional `solutionSpace`, otherwise the question; every `/consult` and direct `/advisor` message is judged too. Input is cut to 2,000 characters and treated as untrusted data.
- **Subagents.** The level travels as a `model` suffix (`pi-light/controller:high`, or `<model>:high` when a model is given). Precedence: an explicit `:level` in `model`, then an agent definition's `thinking:`, then the judge. A notice shows each spawn's level and source.
- **Advisors.** The level is set before every message and again after a fallback switch. The reply label shows the level actually used, e.g. `effort high (judge xhigh, clamped; 0.8s)`.
- **Time and failure.** One 4 s deadline covers the whole judge chain, and all subagent calls in one message are judged at once. A timeout, provider error or unreadable reply falls back to `medium` and never blocks the spawn or the answer.
- **Disclosure.** Each judged task or message (up to 2,000 characters) is sent to the judge provider: Anthropic for `claude-haiku-5-5`, or OpenAI Codex for the fallback `gpt-5.6-luna`. If `providers` renames `anthropic`, the judge is renamed too; `claude-bridge` was unusable as a judge in testing (not logged in, ignored aborts), so set `judge` explicitly on such a machine.

Settings live in the same `~/.pi/agent/pi-light-models.json` (all optional; defaults shown):

```json
{
  "judge": ["anthropic/claude-haiku-5-5", "openai-codex/gpt-5.6-luna"],
  "effort": { "enabled": true, "fallback": "medium", "ceiling": "xhigh", "timeoutMs": 4000 }
}
```

`"effort": { "enabled": false }` turns the judge off: no judge requests, no judged levels and no effort labels. The precedence repairs stay on, so an explicit `:level` still beats an agent definition's `thinking:`, and a definition with only `thinking:` still reaches the child. Invalid effort or judge settings, including `null` values, also turn the judge off (with a warning), and never change the controller or advisor lists.

## Develop

```sh
pnpm install && pnpm test && pnpm typecheck
```

Layout: `extensions/<name>/index.ts` is each extension's entry (the only files Pi loads), with its tests beside it. `lib/` holds stateless helpers shared by the extensions (run-mode checks, the read-only event). Pi loads every extension with its own module instance, so shared state must go through `pi.events`. To try a working copy, remove the git install first (`pi remove git:github.com/locnbk2002/pi-light`), then `pi install ~/code/pi-light`; otherwise every tool registers twice.

MIT licensed.
