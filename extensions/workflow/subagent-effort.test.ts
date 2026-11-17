import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
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

test('the subagent launch format this relies on is unchanged', async () => {
  // extensions/subagents/src/launch.ts: `--model ${model}:${thinking}`, only when a model is set.
  const source = await readFile(join(import.meta.dirname, '..', 'subagents', 'src', 'launch.ts'), 'utf8');
  assert.match(source, /const effectiveModel = params\.model \?\? agentDefs\?\.model;/);
  assert.match(source, /const effectiveThinking = agentDefs\?\.thinking;/);
  assert.match(source, /if \(effectiveModel\) \{\s*piArgv\.push\("--model", effectiveThinking \? `\$\{effectiveModel\}:\$\{effectiveThinking\}` : effectiveModel\);/);
});
