import assert from 'node:assert/strict';
import test from 'node:test';
import { HerdrLayout, planMoves, registerHerdrLayout, resolveLayout, resolveMaxSplit } from './herdr-layout.ts';
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
