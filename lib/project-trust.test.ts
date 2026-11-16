import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { cliTrustOverride, isProjectExplicitlyTrusted } from './project-trust.ts';

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'project-trust-')));
  const project = join(root, 'clone');
  const agentDir = join(root, 'profile');
  mkdirSync(join(project, '.pi', 'agents'), { recursive: true });
  mkdirSync(join(project, '.pi', 'rules'), { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  return { root, project, agentDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// What Pi's isProjectTrusted() returns for a project without Pi-gated resources.
const piImplicit = (cwd: string) => ({ cwd, isProjectTrusted: () => true });

test('a fresh clone with only .pi/agents and .pi/rules is not explicitly trusted', () => {
  const fx = fixture();
  try {
    assert.equal(isProjectExplicitlyTrusted(piImplicit(fx.project), { agentDir: fx.agentDir, argv: [] }), false);
  } finally { fx.cleanup(); }
});

test('a saved trust record for the project or a parent counts; a saved "no" does not', () => {
  const fx = fixture();
  try {
    writeFileSync(join(fx.agentDir, 'trust.json'), JSON.stringify({ [fx.root]: true }));
    assert.equal(isProjectExplicitlyTrusted(piImplicit(fx.project), { agentDir: fx.agentDir, argv: [] }), true);
    writeFileSync(join(fx.agentDir, 'trust.json'), JSON.stringify({ [fx.project]: false, [fx.root]: true }));
    assert.equal(isProjectExplicitlyTrusted(piImplicit(fx.project), { agentDir: fx.agentDir, argv: [] }), false);
  } finally { fx.cleanup(); }
});

test('--approve counts as explicit; --no-approve and an untrusting Pi always win', () => {
  const fx = fixture();
  try {
    assert.equal(isProjectExplicitlyTrusted(piImplicit(fx.project), { agentDir: fx.agentDir, argv: ['-a'] }), true);
    assert.equal(isProjectExplicitlyTrusted({ cwd: fx.project, isProjectTrusted: () => false },
      { agentDir: fx.agentDir, argv: ['--approve'] }), false);
    assert.equal(cliTrustOverride(['--approve', '--no-approve']), false, 'last flag wins, like Pi');
    assert.equal(cliTrustOverride(['--', '--approve']), null, 'arguments after -- are not flags');
  } finally { fx.cleanup(); }
});

test("Pi's answer stands when the project has gated resources (Pi made a real decision)", () => {
  const fx = fixture();
  try {
    writeFileSync(join(fx.project, '.pi', 'settings.json'), '{}');
    assert.equal(isProjectExplicitlyTrusted(piImplicit(fx.project), { agentDir: fx.agentDir, argv: [] }), true);
  } finally { fx.cleanup(); }
});

test('errors and missing context fail closed', () => {
  assert.equal(isProjectExplicitlyTrusted({ cwd: '/x', isProjectTrusted: () => { throw new Error('boom'); } }), false);
  assert.equal(isProjectExplicitlyTrusted({ isProjectTrusted: () => true }), false);
  assert.equal(isProjectExplicitlyTrusted({ cwd: '/x', isProjectTrusted: () => true },
    { hasGatedResources: () => false, argv: [], savedDecision: () => { throw new Error('bad trust.json'); } }), false);
});
