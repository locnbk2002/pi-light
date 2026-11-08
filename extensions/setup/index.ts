import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { isChildRun } from '../../lib/run-mode.ts';
import { agentDir, agentkitStatus, applyPlan, describePlan, planSetup } from './setup.mjs';

/** pi-light setup extension: /pi-light setup [--dry-run] and the missing-AgentKit warning. */
export default function piLightSetup(pi: ExtensionAPI): void {
  if (isChildRun()) return;
  registerSetupCommand(pi);
  let agentkitWarned = false;
  pi.on('session_start', (_event, ctx) => {
    if (agentkitWarned || agentkitStatus(agentDir()).installed) return;
    agentkitWarned = true;
    ctx.ui.notify('AgentKit Pi adapter not found: stage skills and the Agent tool are unavailable. Run /pi-light setup.', 'warning');
  });
}

/** /pi-light setup [--dry-run]: same plan as `node setup.mjs`, shown and confirmed before anything runs. */
export function registerSetupCommand(pi: ExtensionAPI): void {
  pi.registerCommand('pi-light', {
    description: 'Install what pi-light needs on this machine: /pi-light setup [--dry-run]',
    handler: async (args, ctx) => {
      const [sub, ...flags] = args.trim().split(/\s+/);
      if (sub !== 'setup') { ctx.ui.notify('Usage: /pi-light setup [--dry-run]', 'info'); return; }
      const plan = planSetup();
      const summary = describePlan(plan);
      if (flags.includes('--dry-run') || !plan.steps.length) { ctx.ui.notify(summary, 'info'); return; }
      if (!ctx.hasUI || !await ctx.ui.confirm('Apply pi-light setup?', summary)) { ctx.ui.notify('Setup cancelled.', 'info'); return; }
      const log: string[] = [];
      const ok = await applyPlan(plan, async (cmd: string, cmdArgs: string[]) => {
        ctx.ui.setStatus('pi-light-setup', `setup: ${cmd} ${cmdArgs.slice(0, 2).join(' ')}`);
        const r = await pi.exec(cmd, cmdArgs, { timeout: 600_000 });
        return { ok: r.code === 0, out: `${r.stdout}${r.stderr}`.trim() };
      }, (line: string) => log.push(line));
      ctx.ui.setStatus('pi-light-setup', undefined);
      ctx.ui.notify(`${log.join('\n')}\n${ok ? 'Setup finished. Run /reload to load new packages.' : 'Setup stopped at the failed step.'}`, ok ? 'info' : 'error');
    },
  });
}
