#!/usr/bin/env node
// pi-light machine setup: installs what pi-light needs so a new machine matches the reference one.
// Plain JS (no build step) so bootstrap.sh can run it with `node setup.mjs` before Pi loads anything.
// Never touches credentials (auth.json, AgentKit login, claude-bridge config) or the default model.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_DIR = fileURLToPath(new URL('.', import.meta.url));
export const MANIFEST = JSON.parse(readFileSync(join(PACKAGE_DIR, 'setup.json'), 'utf8'));

export function agentDir(env = process.env) {
  return env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent');
}

/** Identity of a package source without its pinned ref/version, e.g. git:github.com/a/b@sha -> git:github.com/a/b. */
export function sourceKey(source) {
  const at = source.lastIndexOf('@');
  if (source.startsWith('git:') || source.startsWith('https:')) return at > source.indexOf('/') ? source.slice(0, at) : source;
  if (source.startsWith('npm:')) return at > 'npm:'.length + 1 ? source.slice(0, at) : source;
  return source;
}

/** Path where Pi keeps a git package checkout. */
export function gitCheckout(dir, source) {
  return join(dir, 'git', ...sourceKey(source).replace(/^git:/, '').split('/'));
}

export function installedPackages(dir) {
  try {
    const settings = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
    return (settings.packages ?? []).map(p => (typeof p === 'string' ? p : p.source)).filter(Boolean);
  } catch { return []; }
}

export function agentkitStatus(dir, skills = MANIFEST.agentkit.skills) {
  const missingSkills = skills.filter(s => !existsSync(join(dir, 'skills', s, 'SKILL.md')));
  const agentTool = existsSync(join(dir, 'extensions', 'agentkit-agent'));
  return { missingSkills, agentTool, installed: agentTool && missingSkills.length < skills.length };
}

function defaultRun(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim(), missing: r.error?.code === 'ENOENT' };
}
function defaultHas(cmd) { return !defaultRun(cmd, ['--version']).missing; }

function browsers(platform, has) {
  const apps = name => platform === 'darwin' && existsSync(`/Applications/${name}.app`);
  const found = [
    ['Brave', 'brave://extensions', ['brave', 'brave-browser'], 'Brave Browser'],
    ['Chromium', 'chrome://extensions', ['chromium'], 'Chromium'],
    ['Chrome', 'chrome://extensions', ['google-chrome-stable', 'google-chrome'], 'Google Chrome'],
    ['Edge', 'edge://extensions', ['microsoft-edge-stable', 'microsoft-edge'], 'Microsoft Edge'],
  ];
  return found.filter(([, , cmds, app]) => cmds.some(has) || apps(app)).map(([name, page]) => ({ name, page }));
}

/**
 * Desired-vs-installed plan. Steps with `cmd` run; `note` lines are reports only.
 * Partial installs (something the user removed on purpose) are reported, not reverted.
 */
export function planSetup({ env = process.env, platform = process.platform, has = defaultHas, run = defaultRun } = {}) {
  const dir = agentDir(env);
  const steps = []; const notes = [];
  for (const tool of ['pi', 'git']) if (!has(tool)) notes.push(`Missing required tool: ${tool}. Install it first.`);

  const ak = MANIFEST.agentkit;
  const akState = agentkitStatus(dir);
  if (!akState.installed) {
    if (!has('ak')) notes.push('AgentKit CLI `ak` is missing: install it and run `ak login`, then rerun setup.');
    else steps.push({ label: `AgentKit ${ak.kit} ${ak.version} Pi adapter (${ak.skills.length} skills)`, cmd: 'ak',
      args: ['kit', 'install', ak.kit, '--global', '--target', ak.target, '--version', ak.version, '--skills', ak.skills.join(','), '--yes'] });
  } else if (akState.missingSkills.length) {
    notes.push(`AgentKit is installed without: ${akState.missingSkills.join(', ')} (left as is).`);
  }

  const have = installedPackages(dir);
  for (const source of MANIFEST.packages) {
    const current = have.find(p => sourceKey(p) === sourceKey(source));
    if (!current) steps.push({ label: `Pi package ${source}`, cmd: 'pi', args: ['install', source] });
    else if (current !== source && source !== sourceKey(source)) notes.push(`${current} differs from pinned ${source} (left as is).`);
  }

  if (has('herdr')) {
    const herdr = MANIFEST.herdr;
    const status = run('herdr', ['integration', 'status']).out;
    if (!new RegExp(`^${herdr.integration}: current`, 'm').test(status)) {
      steps.push({ label: `herdr ${herdr.integration} integration`, cmd: 'herdr', args: ['integration', 'install', herdr.integration] });
    }
    const pluginPath = join(gitCheckout(dir, herdr.plugin.package), herdr.plugin.dir);
    const list = run('herdr', ['plugin', 'list']).out;
    const line = list.split('\n').find(l => l.trim().startsWith(`- ${herdr.plugin.id} `));
    if (!line || !line.includes(`local:${pluginPath}]`) || !/\benabled\b/.test(line)) {
      if (line) steps.push({ label: `unlink old ${herdr.plugin.id} herdr plugin`, cmd: 'herdr', args: ['plugin', 'unlink', herdr.plugin.id] });
      steps.push({ label: `link ${herdr.plugin.id} herdr plugin`, cmd: 'herdr', args: ['plugin', 'link', pluginPath, '--enabled'] });
    }
  } else {
    notes.push('herdr is not installed: subagent panes are unavailable until it is (then rerun setup).');
  }

  const out = join(dir, 'pi-light', 'browser');
  const found = browsers(platform, has);
  steps.push({ label: `browser add-on builds in ${out}`, fn: () => buildBrowserAddons(out) });
  for (const b of found) notes.push(`${b.name}: ${b.page} > Developer mode > Load unpacked > ${join(out, 'chromium')} (stays installed; reload it there after updates).`);
  if (!found.length) notes.push(`No Chromium-family browser (Brave, Chromium, Chrome, Edge) found; the add-on build is in ${join(out, 'chromium')}.`);
  notes.push('Not touched: credentials (`pi` /login, `ak login`, claude-bridge config) and the default model.');
  return { dir, steps, notes };
}

const ADDON_SOURCE = join(PACKAGE_DIR, 'browser-addon');
// Every file of the unpacked Chromium (MV3) add-on.
export const BROWSER_ADDON_FILES = ['manifest.json', 'background.js', 'cdp.js', 'options.html', 'options.js'];

/**
 * Writes the loadable unpacked add-on into `outDir` (created if missing; listed files are overwritten).
 * @param {string} outDir
 */
export function buildBrowserAddon(outDir) {
  if (typeof outDir !== 'string' || !outDir.trim()) throw new Error('Browser add-on output directory is required');
  const destination = resolve(outDir);
  if (destination === resolve(ADDON_SOURCE)) throw new Error('Browser add-on output directory must differ from its source directory');
  mkdirSync(destination, { recursive: true });
  for (const file of BROWSER_ADDON_FILES) copyFileSync(join(ADDON_SOURCE, file), join(destination, file));
}

/** Writes <out>/chromium and removes the <out>/firefox build that older versions wrote. */
export function buildBrowserAddons(out) {
  buildBrowserAddon(join(out, 'chromium'));
  rmSync(join(out, 'firefox'), { recursive: true, force: true });
}

export function describePlan(plan) {
  const lines = plan.steps.length ? ['Planned actions:', ...plan.steps.map(s => `  - ${s.label}${s.cmd ? `: ${s.cmd} ${s.args.join(' ')}` : ''}`)] : ['Nothing to install.'];
  return [...lines, ...plan.notes.map(n => `Note: ${n}`)].join('\n');
}

/**
 * Runs steps in order and stops at the first failure so later steps never run on a broken base.
 * @param {{ steps: Array<{ label: string, cmd?: string, args?: string[], fn?: () => void }> }} plan
 * @param {(cmd: string, args: string[]) => { ok: boolean, out: string } | Promise<{ ok: boolean, out: string }>} [run]
 * @param {(line: string) => void} [log]
 */
export async function applyPlan(plan, run = defaultRun, log = console.log) {
  for (const step of plan.steps) {
    if (step.fn) { try { step.fn(); log(`ok   ${step.label}`); continue; } catch (e) { log(`FAIL ${step.label}: ${e.message}`); return false; } }
    log(`...  ${step.label}`);
    const r = await run(step.cmd, step.args);
    log(`${r.ok ? 'ok  ' : 'FAIL'} ${step.label}${r.ok ? '' : `\n${r.out.split('\n').slice(-15).join('\n')}`}`);
    if (!r.ok) return false;
  }
  return true;
}

async function main(argv) {
  const plan = planSetup();
  console.log(describePlan(plan));
  if (argv.includes('--dry-run') || !plan.steps.length) return 0;
  if (!argv.includes('--yes')) {
    const { createInterface } = await import('node:readline/promises');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question('Apply these actions? [y/N] ');
    rl.close();
    if (!/^y(es)?$/i.test(answer.trim())) { console.log('Cancelled.'); return 1; }
  }
  const ok = await applyPlan(plan);
  console.log(ok ? 'Setup finished. Restart pi or run /reload.' : 'Setup stopped at the failed step; fix it and rerun.');
  return ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = await main(process.argv.slice(2));
