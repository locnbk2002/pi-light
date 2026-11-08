# pi-light

A personal workflow package for the [Pi](https://github.com/earendil-works/pi) coding agent. It needs AgentKit's Pi adapter.

- **Stage routing.** Opus is the controller. Each request is routed as advice, brainstorm, plan or implement and mapped to an AgentKit skill. The agent only edits files when you ask for an implementation.
- **Advisors.** Astra (`gpt-6-astra`) and Fable (`claude-fable-5-1`) give a second opinion through hidden Pi processes. `/advisor astra|fable` opens a direct chat, and `/back` hands the result back to Opus.
- **Model fallback.** When a provider limit is hit, the controller falls back from Opus to Sol, and each advisor falls back to the other.
- **Browser bridge.** An add-on for Firefox and Edge lets Pi read and act on one tab that you bind with the toolbar button.
- **herdr subagent layout.** Up to 3 subagents from `pi-herdr-subagents` stack beside your pane. When a 4th starts, all of them move to their own tabs. `PI_HERDR_MAX_SPLIT` changes the limit, and `PI_HERDR_LAYOUT=tab|split` changes the mode.

## Install

```sh
bash <(curl -fsSL https://raw.githubusercontent.com/locnbk2002/pi-light/main/bootstrap.sh)
```

You need `pi`, `git` and `node`. For the full setup, also install the AgentKit CLI (`ak`, logged in) and herdr. The bootstrap installs this package and then runs `setup.mjs`. Setup shows its plan and asks before it changes anything. It installs:

- the AgentKit `engineer` Pi adapter with the skill list in `setup.json`;
- the latest `pi-effort` and `pi-claude-bridge`, and a pinned upstream `pi-herdr-subagents`;
- herdr's Pi integration and the subagents plugin link;
- loadable browser add-on folders in `~/.pi/agent/pi-light/browser/`.

Setup is safe to rerun, either as `/pi-light setup` inside Pi or as `node setup.mjs --dry-run`. It reports deliberate differences instead of reverting them. It never touches credentials or your default model.

Load the browser add-on by hand:

- **Edge:** go to `edge://extensions`, turn on Developer mode, choose **Load unpacked**, and pick `chromium/`.
- **Firefox:** go to `about:debugging`, choose **Load Temporary Add-on**, and pick `firefox/manifest.json`. You have to load it again after each Firefox restart.

Then run `/browser-connect` in Pi and paste the URL and token into the add-on's options page.

## Develop

```sh
pnpm install && pnpm test && pnpm typecheck
```

MIT licensed.
