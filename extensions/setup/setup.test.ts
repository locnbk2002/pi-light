import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readdir, readFile, mkdtemp, rm } from 'node:fs/promises';
import { agentkitStatus, applyPlan, BROWSER_ADDON_FILES, buildBrowserAddon, buildBrowserAddons, buildPermissionConfig, MANIFEST, planSetup, sourceKey, sshHosts } from './setup.mjs';

// setup.mjs builds the add-on from the browser-bridge extension's source folder.
const ADDON_SOURCE = new URL('../browser-bridge/browser-addon/', import.meta.url);

test('sourceKey strips pins but keeps scoped npm names', () => {
  assert.equal(sourceKey('git:github.com/a/b@abc'), 'git:github.com/a/b');
  assert.equal(sourceKey('git:github.com/a/b'), 'git:github.com/a/b');
  assert.equal(sourceKey('npm:pi-effort@0.1.1'), 'npm:pi-effort');
  assert.equal(sourceKey('npm:@scope/pkg'), 'npm:@scope/pkg');
  assert.equal(sourceKey('npm:@scope/pkg@1.0.0'), 'npm:@scope/pkg');
});

function agentHome(packages: string[], skills: string[] = [], agentTool = false) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-light-setup-'));
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ packages }));
  for (const s of skills) { mkdirSync(join(dir, 'skills', s), { recursive: true }); writeFileSync(join(dir, 'skills', s, 'SKILL.md'), 'x'); }
  if (agentTool) mkdirSync(join(dir, 'extensions', 'agentkit-agent'), { recursive: true });
  return dir;
}
const pluginLine = (path: string) => `1 plugin installed:\n- pi-herdr-subagents (Pi Herdr Subagents) enabled [local:${path}]`;

test('fresh machine: installs AgentKit, every package, herdr integration and plugin; never credentials', () => {
  const dir = agentHome([]);
  const plan = planSetup({ env: { PI_CODING_AGENT_DIR: dir }, platform: 'linux', has: () => true,
    run: (cmd: string, args: string[]) => ({ ok: true, out: args[0] === 'integration' ? 'pi: not installed (x)' : '', missing: false }) });
  const commands = plan.steps.filter((s: any) => s.cmd).map((s: any) => `${s.cmd} ${s.args.join(' ')}`);
  assert.match(commands[0], /^ak kit install engineer --global --target pi --version 3\.1\.0-beta\.5 --skills ak-brainstorm,.*ak-security --yes$/);
  for (const source of MANIFEST.packages) assert.ok(commands.includes(`pi install ${source}`), source);
  assert.ok(commands.includes('pi install npm:pi-effort') && commands.includes('pi install git:github.com/elidickinson/pi-claude-bridge'), 'latest, unpinned');
  assert.ok(commands.includes('herdr integration install pi'));
  assert.ok(commands.includes(`herdr plugin link ${join(dir, 'git/github.com/modem-dev/pi-herdr-subagents/herdr-plugin')} --enabled`));
  assert.ok(!commands.some(c => /login|auth|unlink/.test(c)));
  assert.ok(plan.notes.some((n: string) => /Not touched: credentials/.test(n)));
});

test('configured machine: nothing to install; pin drift and removed skills are reported, not reverted', () => {
  const skills = MANIFEST.agentkit.skills.filter((s: string) => s !== 'ak-security');
  const dir = agentHome(['npm:pi-effort', 'git:github.com/elidickinson/pi-claude-bridge@old', 'git:github.com/modem-dev/pi-herdr-subagents@other', 'npm:@gotgenes/pi-permission-system'], skills, true);
  const plugin = join(dir, 'git/github.com/modem-dev/pi-herdr-subagents/herdr-plugin');
  const plan = planSetup({ env: { PI_CODING_AGENT_DIR: dir }, platform: 'linux', has: (t: string) => !t.startsWith('microsoft'),
    run: (_cmd: string, args: string[]) => ({ ok: true, out: args[0] === 'integration' ? 'pi: current (v9) (x)' : pluginLine(plugin), missing: false }) });
  assert.deepEqual(plan.steps.filter((s: any) => s.cmd), []);
  assert.ok(plan.notes.some((n: string) => n.includes('without: ak-security')));
  assert.ok(plan.notes.some((n: string) => n.includes('@other differs from pinned')));
  assert.ok(!plan.notes.some((n: string) => n.includes('pi-claude-bridge@old')), 'unpinned packages accept any installed ref');
  assert.equal(agentkitStatus(dir).installed, true);
});

test('a plugin linked from another checkout (the old fork) is relinked to upstream', () => {
  const dir = agentHome(MANIFEST.packages, MANIFEST.agentkit.skills, true);
  const plan = planSetup({ env: { PI_CODING_AGENT_DIR: dir }, platform: 'linux', has: () => true,
    run: (_cmd: string, args: string[]) => ({ ok: true, out: args[0] === 'integration' ? 'pi: current' : pluginLine('/x/locnbk2002/pi-herdr-subagents/herdr-plugin'), missing: false }) });
  assert.deepEqual(plan.steps.filter((s: any) => s.cmd).map((s: any) => s.args.slice(0, 2).join(' ')), ['plugin unlink', 'plugin link']);
});

test('missing ak and herdr become instructions instead of failing steps', () => {
  const dir = agentHome([]);
  const plan = planSetup({ env: { PI_CODING_AGENT_DIR: dir }, platform: 'linux', has: (t: string) => t === 'pi' || t === 'git', run: () => ({ ok: true, out: '', missing: false }) });
  assert.ok(!plan.steps.some((s: any) => s.cmd === 'ak' || s.cmd === 'herdr'));
  assert.ok(plan.notes.some((n: string) => n.includes('`ak` is missing')) && plan.notes.some((n: string) => n.includes('herdr is not installed')));
});

test('applyPlan stops at the first failed step', async () => {
  const ran: string[] = []; const log: string[] = [];
  const ok = await applyPlan({ steps: [{ label: 'a', cmd: 'x', args: ['1'] }, { label: 'b', cmd: 'x', args: ['2'] }, { label: 'c', cmd: 'x', args: ['3'] }] },
    async (_c: string, args: string[]) => { ran.push(args[0]); return { ok: args[0] !== '2', out: 'err' }; }, (l: string) => log.push(l));
  assert.equal(ok, false);
  assert.deepEqual(ran, ['1', '2']);
  assert.ok(log.some(l => l.startsWith('FAIL b')));
});

test('setup builds the Chromium add-on and removes the old Firefox build', () => {
  const out = mkdtempSync(join(tmpdir(), 'addon-out-'));
  mkdirSync(join(out, 'firefox'));
  writeFileSync(join(out, 'firefox', 'manifest.json'), '{}');
  buildBrowserAddons(out);
  assert.ok(JSON.parse(readFileSync(join(out, 'chromium', 'manifest.json'), 'utf8')).background.service_worker);
  assert.ok(existsSync(join(out, 'chromium', 'background.js')) && existsSync(join(out, 'chromium', 'cdp.js')));
  assert.equal(existsSync(join(out, 'firefox')), false);
});

test('setup notes how to load the add-on in each Chromium-family browser it finds', () => {
  const dir = agentHome([]);
  const notes = (has: (t: string) => boolean) => planSetup({ env: { PI_CODING_AGENT_DIR: dir }, platform: 'linux', has, run: () => ({ ok: true, out: '', missing: false }) }).notes.join('\n');
  assert.match(notes(t => t === 'brave'), /Brave: brave:\/\/extensions > Developer mode > Load unpacked > .*chromium/);
  assert.doesNotMatch(notes(t => t === 'brave'), /Edge|Firefox/);
  assert.match(notes(t => t === 'firefox'), /No Chromium-family browser/);
});

test('sshHosts lists concrete aliases and skips wildcard and negated patterns', () => {
  const text = 'Host a b\n  HostName 1.2.3.4\nhost xsign-prod \nHost *\nHost !c *.lan\n  # Host commented\nHost a';
  assert.deepEqual(sshHosts(text), ['a', 'b', 'xsign-prod']);
});

test('permission rules: ssh asks, named-host reads allowed, risky remote forms last so they win', () => {
  const bash = buildPermissionConfig(['mini']).permission.bash;
  const keys = Object.keys(bash);
  assert.equal(bash['ssh *'], 'ask');
  assert.equal(bash['ssh mini cat *'], 'allow');
  assert.equal(bash['ssh mini ls*'], 'allow');
  assert.equal(bash['ssh mini uptime'], 'allow');
  assert.ok(!keys.some(k => k.includes(' git -C ')), 'no wildcard inside git read rules');
  const lastAllow = keys.findLastIndex(k => bash[k] === 'allow');
  for (const risky of MANIFEST.permissions.sshAskLast) assert.ok(keys.indexOf(risky) > lastAllow, risky);
  assert.ok(keys.indexOf('ssh *') < keys.indexOf('ssh mini cat *'), 'catch-all before the host allows');
  assert.equal(buildPermissionConfig([]).permission.bash['ssh *'], 'ask', 'no hosts still asks');
});

test('permission rules: curl safe hosts sit between the curl ask and the later curl guards', () => {
  const bash = buildPermissionConfig([], { ...MANIFEST.permissions, curlSafeHosts: ['localhost', 'example.org'] }).permission.bash;
  const keys = Object.keys(bash);
  for (const k of ['curl *://localhost', 'curl *://localhost:*', 'curl *://example.org/*']) {
    assert.equal(bash[k], 'allow', k);
    assert.ok(keys.indexOf(k) > keys.indexOf('curl *'), `${k} after the curl ask`);
    assert.ok(keys.indexOf(k) < keys.indexOf('curl *://*@*'), `${k} before the userinfo guard`);
  }
  assert.ok(!keys.some(k => k.startsWith('curl *://example.org*') && !/(:\*|\/\*)$/.test(k) && k !== 'curl *://example.org'), 'no open-ended host prefix');
  assert.equal(bash['git commit*'], undefined, 'commits do not ask');
  assert.equal(bash['rm *'], 'allow');
});

test('permission rules: macOS and GitLab guards ask, read-only overrides come after their ask', () => {
  const { bash, path } = buildPermissionConfig([]).permission;
  const keys = Object.keys(bash);
  for (const k of ['brew *', 'diskutil *', 'launchctl *', 'security *', 'osascript *', 'defaults write*', 'glab mr merge*', 'glab mr approve*']) {
    assert.equal(bash[k], 'ask', k);
  }
  assert.equal(bash['security dump-keychain*'].action, 'deny');
  for (const [allow, ask] of [['brew list*', 'brew *'], ['diskutil list*', 'diskutil *'], ['launchctl list*', 'launchctl *'], ['glab release list*', 'glab release *']]) {
    assert.equal(bash[allow], 'allow', allow);
    assert.ok(keys.indexOf(allow) > keys.indexOf(ask), `${allow} after ${ask}`);
  }
  assert.equal(path['~/Library/Keychains/*'], 'deny');
  assert.equal(path['~/Library/Application Support/glab-cli/config.yml'], 'deny');
});

test('setup writes permission rules once; an edited file is reported, not overwritten', () => {
  const dir = agentHome([]);
  const opts = { env: { PI_CODING_AGENT_DIR: dir }, platform: 'linux' as const, has: () => false, run: () => ({ ok: true, out: '', missing: false }), sshConfig: 'Host mini\n' };
  const path = join(dir, MANIFEST.permissions.configPath);
  const step = planSetup(opts).steps.find((s: any) => s.label.startsWith('permission rules'));
  assert.ok(step && step.label.includes('1 hosts'));
  step!.fn!();
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).permission.bash['ssh mini cat *'], 'allow');
  assert.ok(!planSetup(opts).steps.some((s: any) => s.label.startsWith('permission rules')));
  assert.ok(!planSetup(opts).notes.some((n: string) => n.includes('differs from the generated rules')));
  writeFileSync(path, '{}');
  assert.ok(planSetup(opts).notes.some((n: string) => n.includes('differs from the generated rules')));
  assert.equal(readFileSync(path, 'utf8'), '{}');
});

test("setup copies exactly the browser-bridge add-on files", async () => {
  assert.deepEqual((await readdir(ADDON_SOURCE)).sort(), [...BROWSER_ADDON_FILES].sort());
});

test("buildBrowserAddon writes a loadable unpacked directory", async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-light-addon-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const out = join(root, "chromium", "nested");
  buildBrowserAddon(out);
  assert.deepEqual((await readdir(out)).sort(), [...BROWSER_ADDON_FILES].sort());
  for (const file of BROWSER_ADDON_FILES) assert.equal(await readFile(join(out, file), "utf8"), await readFile(new URL(file, ADDON_SOURCE), "utf8"));
  buildBrowserAddon(out);
  assert.throws(() => buildBrowserAddon(" "), /required/);
  assert.throws(() => buildBrowserAddon(ADDON_SOURCE.pathname), /differ/);
});
