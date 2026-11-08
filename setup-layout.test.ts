import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { HerdrLayout, planMoves, registerHerdrLayout, resolveLayout, resolveMaxSplit } from './herdr-layout.ts';
import { agentkitStatus, applyPlan, buildBrowserAddons, MANIFEST, planSetup, sourceKey } from './setup.mjs';

const pane = (pane_id: string, height: number, y = 0) => ({ pane_id, rect: { height, width: 81, x: 81, y } });

test('layout settings default to a 3-pane column', () => {
  assert.equal(resolveLayout({}), 'column');
  assert.equal(resolveLayout({ PI_HERDR_LAYOUT: 'TAB' }), 'tab');
  assert.equal(resolveLayout({ PI_HERDR_LAYOUT: 'split' }), 'split');
  assert.equal(resolveLayout({ PI_HERDR_LAYOUT: 'bogus' }), 'column');
  assert.equal(resolveMaxSplit({}), 3);
  assert.equal(resolveMaxSplit({ PI_HERDR_MAX_SPLIT: '2' }), 2);
  assert.equal(resolveMaxSplit({ PI_HERDR_MAX_SPLIT: '0' }), 3);
});

test('planMoves: first stays right, next stack under the tallest, the 4th sends all to tabs', () => {
  assert.deepEqual(planMoves('column', 'p2', [], 0, 3), []);
  assert.deepEqual(planMoves('column', 'p4', [pane('p2', 21, 0), pane('p3', 22, 21)], 2, 3), [{ pane: 'p4', target: 'p3', direction: 'down' }]);
  assert.deepEqual(planMoves('column', 'p5', [pane('p2', 21), pane('p3', 11), pane('p4', 11)], 3, 3),
    [{ pane: 'p2', newTab: true }, { pane: 'p3', newTab: true }, { pane: 'p4', newTab: true }, { pane: 'p5', newTab: true }]);
  assert.deepEqual(planMoves('column', 'p6', [], 4, 3), [{ pane: 'p6', newTab: true }], 'after the switch new panes keep going to tabs');
  assert.deepEqual(planMoves('tab', 'p2', [], 0, 3), [{ pane: 'p2', newTab: true }]);
  assert.deepEqual(planMoves('split', 'p2', [pane('p3', 40)], 1, 3), []);
});

/** Fake herdr: tracks which panes exist and which are in the orchestrator's tab. */
function fakeHerdr(userPanes: string[] = []) {
  const all = new Set(['w1:p1', ...userPanes]);
  const mainTab = new Set(['w1:p1', ...userPanes]);
  const calls: string[][] = [];
  const herdr = async (args: string[]) => {
    calls.push(args);
    if (args[0] === 'pane' && args[1] === 'list') return { panes: [...all].map(pane_id => ({ pane_id, tab_id: mainTab.has(pane_id) ? 'w1:t1' : 'w1:t9' })) };
    if (args[0] === 'pane' && args[1] === 'layout') return { layout: { panes: [...mainTab].map((pane_id, i) => pane(pane_id, 43 - i * 10, i * 10)) } };
    if (args[0] === 'pane' && args[1] === 'move' && args.includes('--new-tab')) mainTab.delete(args[2]);
    // Like herdr: a split move inside the same tab is a no-op; from another tab it lands in the target tab.
    if (args[0] === 'pane' && args[1] === 'move' && args.includes('--split') && !mainTab.has(args[2])) mainTab.add(args[2]);
    return {};
  };
  const open = (id: string) => { all.add(id); mainTab.add(id); };
  return { herdr, calls, open, all };
}

test('a parallel burst of four: three stack, then all four move to tabs; user panes never move', async () => {
  const fake = fakeHerdr(['w1:p9']);
  const layout = new HerdrLayout('w1:p1', fake.herdr, {});
  const ids = ['w1:p2', 'w1:p3', 'w1:p4', 'w1:p5'];
  ids.forEach(fake.open);
  await Promise.all(ids.map(id => layout.place(id)));
  const moves = fake.calls.filter(c => c[1] === 'move');
  // herdr ignores same-tab split moves, so each stack hops through a new tab first.
  assert.deepEqual(moves[0], ['pane', 'move', 'w1:p3', '--new-tab', '--no-focus']);
  assert.deepEqual(moves[1], ['pane', 'move', 'w1:p3', '--tab', 'w1:t1', '--split', 'down', '--target-pane', 'w1:p2', '--no-focus']);
  assert.deepEqual(moves[2].slice(0, 4), ['pane', 'move', 'w1:p4', '--new-tab']);
  assert.ok(moves[3].includes('--split') && !moves[3].includes('w1:p9'), 'never stacks onto the user pane');
  assert.deepEqual(moves.slice(4).map(m => m[2]).sort(), ids, 'all four end in tabs');
  assert.ok(moves.slice(4).every(m => m.includes('--new-tab') && m.includes('--no-focus')));
  assert.ok(!moves.some(m => m[2] === 'w1:p9' || m[2] === 'w1:p1'));
});

test('closed subagent panes stop counting toward the split limit', async () => {
  const fake = fakeHerdr();
  const layout = new HerdrLayout('w1:p1', fake.herdr, {});
  for (const id of ['w1:p2', 'w1:p3', 'w1:p4']) { fake.open(id); await layout.place(id); }
  fake.all.delete('w1:p2'); fake.all.delete('w1:p3');
  fake.open('w1:p5');
  await layout.place('w1:p5');
  const last = fake.calls.filter(c => c[1] === 'move' && c[2] === 'w1:p5').at(-1)!;
  assert.ok(last.includes('--split'), 'two live panes: still splitting');
});

test('a failing herdr call never rejects or blocks later placements', async () => {
  let fail = true;
  const herdr = async (args: string[]) => { if (fail) { fail = false; throw new Error('boom'); } return args[1] === 'list' ? { panes: [] } : {}; };
  const layout = new HerdrLayout('w1:p1', herdr, {});
  await layout.place('w1:p2');
  await layout.place('w1:p3');
});

test('registerHerdrLayout only acts on subagent results in a herdr orchestrator', async () => {
  const handlers: Array<(event: any) => void> = [];
  const pi = { on: (_name: string, handler: (event: any) => void) => handlers.push(handler) } as any;
  assert.equal(registerHerdrLayout(pi, {}), undefined);
  assert.equal(registerHerdrLayout(pi, { HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1', PI_SUBAGENT_ID: 'x' }), undefined);
  const fake = fakeHerdr();
  const layout = registerHerdrLayout(pi, { HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1', PI_HERDR_LAYOUT: 'tab' }, fake.herdr)!;
  assert.equal(handlers.length, 1);
  handlers[0]({ toolName: 'bash', isError: false, details: { paneId: 'w1:p7' } });
  handlers[0]({ toolName: 'subagent', isError: true, details: { paneId: 'w1:p8' } });
  handlers[0]({ toolName: 'subagent', isError: false, details: { paneId: 'w1:p2' } });
  await layout.place('w1:p2');
  assert.deepEqual(fake.calls.filter(c => c[1] === 'move').map(c => c[2]), ['w1:p2']);
});

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
  const dir = agentHome(['npm:pi-effort', 'git:github.com/elidickinson/pi-claude-bridge@old', 'git:github.com/modem-dev/pi-herdr-subagents@other'], skills, true);
  const plugin = join(dir, 'git/github.com/modem-dev/pi-herdr-subagents/herdr-plugin');
  const plan = planSetup({ env: { PI_CODING_AGENT_DIR: dir }, platform: 'linux', has: (t: string) => t !== 'firefox' && !t.startsWith('microsoft'),
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

test('setup builds one loadable add-on directory per browser', () => {
  const out = mkdtempSync(join(tmpdir(), 'addon-out-'));
  buildBrowserAddons(out);
  assert.equal(JSON.parse(readFileSync(join(out, 'firefox', 'manifest.json'), 'utf8')).background.scripts.length > 0, true);
  assert.ok(JSON.parse(readFileSync(join(out, 'chromium', 'manifest.json'), 'utf8')).background.service_worker);
  assert.ok(existsSync(join(out, 'chromium', 'background.js')));
});
