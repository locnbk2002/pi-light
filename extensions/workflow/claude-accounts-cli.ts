/**
 * Manage the Claude accounts pi-light rotates between. Run from the pi-light checkout:
 *
 *   npm run claude-accounts -- add <name> [--org <uuid>] [--check]
 *   npm run claude-accounts -- list | status | remove <name>
 *
 * `add` reads a `claude setup-token` token with echo off; paste it (it may span several lines) and
 * press Enter on an empty line. No command prints a token.
 */
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { loadAccounts, redactSecrets, removeAccount, saveAccount, StateStore, summarize, validateAccountName,
  validateToken } from './claude-accounts.ts';
import { accountsDir, ClaudeAccountRouter } from './claude-account-routing.ts';

const dir = accountsDir(getAgentDir());
const USAGE = 'Usage: claude-accounts add <name> [--org <uuid>] [--check] | list | status | remove <name>';

async function readHiddenToken(): Promise<string> {
  if (!process.stdin.isTTY) throw new Error('Run this in an interactive terminal: the token is read with echo off.');
  // Save the terminal settings, then turn echo off; refuse to read the token if either step fails.
  const saved = spawnSync('stty', ['-g'], { stdio: ['inherit', 'pipe', 'pipe'], encoding: 'utf8' });
  const settings = saved.status === 0 && !saved.error ? saved.stdout.trim() : '';
  if (!settings) throw new Error('Could not read the terminal settings (stty -g); not reading the token.');
  const off = spawnSync('stty', ['-echo'], { stdio: ['inherit', 'pipe', 'pipe'] });
  if (off.status !== 0 || off.error) throw new Error('Could not turn terminal echo off; not reading the token.');
  process.stdout.write('Paste the token from `claude setup-token` (input hidden), then press Enter on an empty line:\n');
  const lines = createInterface({ input: process.stdin, terminal: false });
  const parts: string[] = [];
  try {
    for await (const line of lines) {
      if (!line.trim()) { if (parts.length) break; continue; }
      parts.push(line.replace(/\s+/g, ''));
    }
  } finally {
    lines.close();
    spawnSync('stty', [settings], { stdio: ['inherit', 'pipe', 'pipe'] });
  }
  const joined = parts.join('');
  return joined.match(/sk-ant-oat\d+-[A-Za-z0-9_-]+/)?.[0] ?? joined;
}

/** One tiny Claude Code turn with the token injected; reports success and plan usage, never the token. */
function checkToken(token: string): void {
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  const run = spawnSync('claude', ['-p', 'Reply with the single word: ok', '--model', 'haiku', '--setting-sources', '',
    '--output-format', 'stream-json', '--verbose', '--max-turns', '1'], { env, cwd: tmpdir(), encoding: 'utf8', timeout: 180_000 });
  let ok = false;
  let usage = '';
  for (const line of (run.stdout ?? '').split('\n')) {
    let message: Record<string, any>;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.type === 'result') ok = message.is_error === false;
    const windows = message.type === 'rate_limit_event' ? message.rate_limit_info?.unifiedWindows : undefined;
    if (windows) {
      const pct = (value: unknown) => typeof value === 'number' ? `${Math.round(value * 100)}%` : '?';
      const reset = (value: unknown) => typeof value === 'number' ? new Date(value * 1000).toISOString().slice(0, 16).replace('T', ' ') + 'Z' : '?';
      usage = `5h ${pct(windows.five_hour?.utilization)}, 7d ${pct(windows.seven_day?.utilization)} (weekly reset ${reset(windows.seven_day?.resetsAt)})`;
    }
  }
  if (!ok) throw new Error(`The check turn failed: ${redactSecrets((run.stderr || run.stdout || run.error?.message || 'no output').trim().split('\n').pop())}`);
  console.log(`Check turn succeeded on this token: ${usage || 'no usage reported'}.`);
  console.log('Compare the weekly reset with the account you meant: each account has its own reset time.');
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (command === 'list') {
    const { accounts, problems } = loadAccounts(dir);
    if (!accounts.length) console.log(`No accounts in ${dir}.`);
    for (const account of accounts.map(summarize)) {
      console.log(`${account.name}\torg ${account.orgUuid ? `${account.orgUuid.slice(0, 8)}…` : 'unknown'}\t${account.source}\ttoken sha256:${account.fingerprint}`);
    }
    for (const problem of problems) console.log(`! ${problem}`);
    return;
  }
  if (command === 'status') {
    for (const line of new ClaudeAccountRouter(dir).describe()) console.log(line);
    return;
  }
  if (command === 'remove') {
    const name = validateAccountName(rest[0] ?? '');
    const removed = removeAccount(dir, name);
    new StateStore(dir).forget(name);
    console.log(removed ? `Removed ${name} and its usage state.` : `No account named ${name}.`);
    return;
  }
  if (command === 'add') {
    const name = validateAccountName(rest[0] ?? '');
    const orgIndex = rest.indexOf('--org');
    const orgUuid = orgIndex >= 0 ? rest[orgIndex + 1] : undefined;
    if (orgIndex >= 0 && !/^[0-9a-f-]{8,64}$/i.test(orgUuid ?? '')) throw new Error('--org needs an organization UUID.');
    const token = validateToken(await readHiddenToken());
    if (rest.includes('--check')) checkToken(token);
    const existing = loadAccounts(dir).accounts.find(account => account.name === name);
    saveAccount(dir, { name, orgUuid: orgUuid ?? existing?.orgUuid ?? null, token, source: 'setup-token' });
    console.log(`Saved ${name} (token sha256:${summarize({ name, token, source: '' }).fingerprint}) in ${dir}.${existing ? ' It replaced the previous token, which clears a rejected-login mark.' : ''}`);
    return;
  }
  throw new Error(USAGE);
}

main(process.argv.slice(2)).catch(error => {
  console.error(redactSecrets(error instanceof Error ? error.message : error));
  process.exitCode = 1;
});
