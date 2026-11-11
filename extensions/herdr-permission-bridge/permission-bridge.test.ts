import assert from 'node:assert/strict';
import test from 'node:test';
import { promptLabel, registerPermissionBridge } from './permission-bridge.ts';

function fakePi() {
  const listeners = new Map<string, Array<(data: unknown) => void>>();
  const hooks = new Map<string, () => void>();
  const blocked: Array<{ active: boolean; label?: string }> = [];
  const events = {
    on(channel: string, handler: (data: unknown) => void) {
      listeners.set(channel, [...(listeners.get(channel) ?? []), handler]);
      return () => {};
    },
    emit(channel: string, data: unknown) {
      if (channel === 'herdr:blocked') blocked.push(data as { active: boolean; label?: string });
      for (const handler of listeners.get(channel) ?? []) handler(data);
    },
  };
  const pi = { events, on: (name: string, handler: () => void) => { hooks.set(name, handler); } };
  registerPermissionBridge(pi as never);
  return {
    blocked,
    prompt: (requestId: string, surface = 'bash', value = 'git push') => events.emit('permissions:ui_prompt', { requestId, surface, value }),
    decide: (requestId: string) => events.emit('permissions:decision', { requestId, result: 'allow' }),
    hook: (name: string) => hooks.get(name)?.(),
  };
}

test('a prompt blocks the pane and its decision unblocks it', () => {
  const pi = fakePi();
  pi.prompt('r1');
  pi.decide('r1');
  assert.deepEqual(pi.blocked, [{ active: true, label: 'Permission: bash: git push' }, { active: false }]);
});

test('overlapping prompts hold one block until the last is decided', () => {
  const pi = fakePi();
  pi.prompt('r1');
  pi.prompt('r2');
  pi.prompt('r1');
  pi.decide('r1');
  assert.equal(pi.blocked.length, 1);
  pi.decide('r2');
  assert.deepEqual(pi.blocked.map(b => b.active), [true, false]);
});

test('decisions without a prompt, repeated or malformed events change nothing', () => {
  const pi = fakePi();
  pi.decide('never-prompted');
  pi.prompt('r1');
  pi.decide('other');
  pi.decide('r1');
  pi.decide('r1');
  assert.deepEqual(pi.blocked.map(b => b.active), [true, false]);
});

test('session_start resets silently; session_shutdown releases an open block', () => {
  const pi = fakePi();
  pi.prompt('r1');
  pi.hook('session_start');
  pi.decide('r1');
  pi.prompt('r2');
  pi.hook('session_shutdown');
  pi.hook('session_shutdown');
  assert.deepEqual(pi.blocked.map(b => b.active), [true, true, false]);
});

test('promptLabel is single-line, bounded and has a fallback', () => {
  assert.equal(promptLabel({}), 'Permission: approval needed');
  assert.equal(promptLabel({ surface: 'read', value: null }), 'Permission: read');
  const long = promptLabel({ surface: 'bash', value: `echo\n${'x'.repeat(300)}` });
  assert.equal(long.length, 120);
  assert.ok(!long.includes('\n') && long.endsWith('…'));
});
