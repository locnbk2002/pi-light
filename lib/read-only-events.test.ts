import assert from 'node:assert/strict';
import test from 'node:test';
import { createEventBus } from '@earendil-works/pi-coding-agent';
import { answerReadOnlyQueries, queryReadOnly } from './read-only-events.ts';

test('read-only query answers synchronously over the real Pi event bus', () => {
  const bus = createEventBus();
  assert.equal(queryReadOnly(bus), false, 'no workflow loaded: nothing to honor');
  let readOnly = false;
  answerReadOnlyQueries(bus, () => readOnly);
  assert.equal(queryReadOnly(bus), false);
  readOnly = true;
  assert.equal(queryReadOnly(bus), true, 'the current state is read on every query, not cached');
});

test('any responder reporting read-only wins', () => {
  const bus = createEventBus();
  answerReadOnlyQueries(bus, () => false);
  answerReadOnlyQueries(bus, () => true);
  assert.equal(queryReadOnly(bus), true);
});
