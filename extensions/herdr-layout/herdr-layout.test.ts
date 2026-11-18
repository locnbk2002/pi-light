import assert from 'node:assert/strict';
import test from 'node:test';
import { HerdrLayout, registerHerdrLayout, resolveLayout } from './herdr-layout.ts';

function fakeHerdr() {
  const calls: string[][] = [];
  const herdr = async (args: string[]) => { calls.push(args); return {}; };
  return { herdr, calls };
}

test('layout defaults to leaving the launcher placement untouched', () => {
  assert.equal(resolveLayout({}), 'split');
  assert.equal(resolveLayout({ PI_HERDR_LAYOUT: 'TAB' }), 'tab');
  assert.equal(resolveLayout({ PI_HERDR_LAYOUT: 'column' }), 'split');
  assert.equal(resolveLayout({ PI_HERDR_LAYOUT: 'bogus' }), 'split');
});

test('default layout never moves panes', async () => {
  const fake = fakeHerdr();
  const layout = new HerdrLayout(fake.herdr, {});
  await Promise.all(['w1:p2', 'w1:p3', 'w1:p4'].map(id => layout.place(id)));
  assert.deepEqual(fake.calls, []);
});

test('tab layout moves each subagent pane to its own tab once', async () => {
  const fake = fakeHerdr();
  const layout = new HerdrLayout(fake.herdr, { PI_HERDR_LAYOUT: 'tab' });
  await layout.place('w1:p2');
  await layout.place('w1:p2');
  await layout.place('w1:p3');
  assert.deepEqual(fake.calls, [
    ['pane', 'move', 'w1:p2', '--new-tab', '--no-focus'],
    ['pane', 'move', 'w1:p3', '--new-tab', '--no-focus'],
  ]);
});

test('a failing herdr call never rejects or blocks later placements', async () => {
  let fail = true;
  const calls: string[][] = [];
  const herdr = async (args: string[]) => { calls.push(args); if (fail) { fail = false; throw new Error('boom'); } return {}; };
  const layout = new HerdrLayout(herdr, { PI_HERDR_LAYOUT: 'tab' });
  await layout.place('w1:p2');
  await layout.place('w1:p3');
  assert.equal(calls.length, 2);
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
  assert.deepEqual(fake.calls.map(c => c[2]), ['w1:p2']);
});
