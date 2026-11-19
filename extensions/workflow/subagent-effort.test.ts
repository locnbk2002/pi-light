import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildLaunchPlan, buildResumeLaunchPlan } from '../subagents/src/launch.ts';
import { CONTROLLER_MODEL, hasThinkingSuffix, innerExplicitLevel, planSubagentEffort } from './subagent-effort.ts';

const SOL = 'openai-codex/gpt-6.1-sol';

test('precedence: explicit suffix > agent-definition thinking > judge', () => {
  assert.deepEqual(planSubagentEffort({ model: `${SOL}:high` }), { action: 'keep', source: 'explicit' });
  assert.deepEqual(planSubagentEffort({ model: `${SOL}:high` }, { thinking: 'low' }), { action: 'keep', source: 'explicit' },
    'upstream appends :low; the child fix-up restores :high');
  assert.deepEqual(planSubagentEffort({ model: SOL }, { thinking: 'low' }), { action: 'keep', source: 'agent-def' });
  assert.deepEqual(planSubagentEffort({}, { model: SOL, thinking: 'low' }), { action: 'keep', source: 'agent-def' });
  assert.deepEqual(planSubagentEffort({}, { model: `${SOL}:low` }), { action: 'keep', source: 'agent-def' });
  // A thinking-only definition gets an unsuffixed base so upstream can append its level.
  assert.deepEqual(planSubagentEffort({}, { thinking: 'high' }), { action: 'set-model', model: CONTROLLER_MODEL, source: 'agent-def' });
  // Judge: the call's model, else the definition's model (kept, not replaced), else the controller.
  assert.deepEqual(planSubagentEffort({ model: SOL }), { action: 'judge', base: SOL });
  assert.deepEqual(planSubagentEffort({}, { model: 'anthropic/claude-sonnet-5-5' }), { action: 'judge', base: 'anthropic/claude-sonnet-5-5' });
  assert.deepEqual(planSubagentEffort({}), { action: 'judge', base: CONTROLLER_MODEL });
  assert.deepEqual(planSubagentEffort({ model: '  ' }), { action: 'judge', base: CONTROLLER_MODEL });
  assert.equal(CONTROLLER_MODEL, 'pi-light/controller');
});

test('thinking suffix detection only accepts real levels after a colon', () => {
  assert.equal(hasThinkingSuffix(`${SOL}:xhigh`), true);
  assert.equal(hasThinkingSuffix('openrouter/meta/llama:free'), false);
  assert.equal(hasThinkingSuffix('high'), false);
  assert.equal(hasThinkingSuffix(undefined), false);
});

test('child fix-up finds the explicit level only in a double suffix', () => {
  assert.equal(innerExplicitLevel(['--session', 's.jsonl', '--model', `${SOL}:high:low`]), 'high');
  assert.equal(innerExplicitLevel([`--model=${CONTROLLER_MODEL}:xhigh:low`]), 'xhigh');
  assert.equal(innerExplicitLevel(['--model', `${SOL}:high`]), undefined);
  assert.equal(innerExplicitLevel(['--model', 'openrouter/x:free:low']), undefined);
  assert.equal(innerExplicitLevel(['--', '--model', `${SOL}:high:low`]), undefined);
  assert.equal(innerExplicitLevel(['@task.md']), undefined);
});

test('spawn and resume pass the model as base:explicit:agentlevel, and the child restores the explicit level', () => {
  const ctx = {
    sessionDir: join(tmpdir(), 'effort-launch'),
    sessionId: 'orch',
    parentSessionFile: join(tmpdir(), 'effort-launch', 'parent.jsonl'),
    parentCwd: tmpdir(),
    env: { PATH: '/usr/bin:/bin', PI_HERDR_PI_BIN: '/usr/bin/pi' },
    now: new Date('2026-11-19T00:00:00.000Z'),
    toolCeiling: { active: ['read'] },
    projectTrusted: true,
  };
  const spawned = buildLaunchPlan({ name: 'R', task: 't', model: `${SOL}:high` }, { thinking: 'low' }, { ...ctx, id: 'aaaa1111' });
  assert.equal(innerExplicitLevel(spawned.piArgv.slice(1)), 'high');
  const plain = buildLaunchPlan({ name: 'R', task: 't' }, null, { ...ctx, id: 'bbbb2222' });
  assert.ok(!plain.piArgv.includes('--model'), 'no model flag without a model, so the child joins the controller chain');

  const record = JSON.parse(spawned.files.find(file => file.path.endsWith('.launch.json'))!.content);
  const resumed = buildResumeLaunchPlan({ sessionPath: spawned.sessionFile }, record, { ...ctx, id: 'cccc3333' });
  assert.equal(resumed.piArgv[resumed.piArgv.indexOf('--model') + 1], `${SOL}:high:low`);
  assert.equal(innerExplicitLevel(resumed.piArgv.slice(1)), 'high');
});
