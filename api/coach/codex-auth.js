/* Codex owns credential contents. This module only runs supported authentication commands,
 * controls their lifetime, and publishes an allowlisted device URL/code to the initiator. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as config from './config.js';
import { run, canDropPrivileges, unprivilegedIds } from './adapters/spawn.js';

export const AUTH_ARGS = ['-c', 'cli_auth_credentials_store="file"'];
const LOGIN_MS = 15 * 60000;
let attempt = null;
let command = run;
let activeCalls = 0;
let changing = false;
export const authChanging = () => changing;
export function reserveSubscription() { if (changing) return false; activeCalls++; return true; }
export function releaseSubscription() { activeCalls--; }
export function setAuthRunnerForTests(fn) { command = fn || run; }

export function authEnv(home = config.CREDENTIAL_HOME) {
  return { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', HOME: home, TMPDIR: '/tmp', CODEX_HOME: home };
}

export function recoverLoginOnBoot() {
  // Runtime children are gone after container restart. Delete only staging directories this
  // module names, without touching the active cache, following symlinks, or reporting paths.
  try {
    validateCredentialHome();
    for (const name of fs.readdirSync(config.CREDENTIAL_HOME)) {
      if (!/^login-[a-f0-9-]{36}$/.test(name)) continue;
      const dir = path.join(config.CREDENTIAL_HOME, name);
      if (fs.lstatSync(dir).isDirectory()) fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch { /* mount may be unavailable; starting login reports that separately */ }
}

export async function cachedLoginStatus(home = config.CREDENTIAL_HOME) {
  if (!canDropPrivileges().ok) return false;
  try { validateCredentialHome(home); } catch { return false; }
  const r = await command('codex', [...AUTH_ARGS, 'login', 'status'], { env: authEnv(home), timeoutMs: 20000, processGroup: true });
  // Exit 0 alone also accepts API keys. Never expose this output (it may include a key).
  return r.code === 0 && !r.timedOut && /logged in using chatgpt/i.test(r.stdout + r.stderr);
}

export function deviceFields(output) {
  const clean = String(output).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  const url = clean.match(/https:\/\/auth\.openai\.com\/codex\/device(?=\s|$)/)?.[0];
  // 0.160.1 prints the server-issued code on the line after this heading; its length is
  // server-defined. Do not scan arbitrary CLI diagnostics for token-shaped strings.
  const code = clean.match(/Enter this one-time code[^\n]*\n\s*([A-Z0-9-]{6,32})\s*(?:\n|$)/)?.[1];
  return url && code ? { verificationUrl: url, userCode: code } : {};
}

export function loginState(uid) {
  if (!attempt) return { state: 'none' };
  if (attempt.uid !== uid) return { state: attempt.state === 'pending' ? 'busy' : 'none' };
  return { state: attempt.state, expiresAt: attempt.expiresAt, ...(attempt.state === 'pending' ? attempt.fields : {}) };
}

function privateDir(dir) {
  fs.mkdirSync(dir, { mode: 0o700 });
  const ids = unprivilegedIds();
  if (ids) fs.chownSync(dir, ids.uid, ids.gid);
}

export function validateCredentialHome(home = config.CREDENTIAL_HOME) {
  const stat = fs.lstatSync(home);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('invalid credential home');
  const realHome = fs.realpathSync(home);
  const data = fs.realpathSync(process.env.DATA_DIR || '/data');
  const app = fs.realpathSync(process.cwd());
  const contains = (parent, child) => parent === child || child.startsWith(parent + path.sep);
  if (realHome === path.parse(realHome).root || contains(realHome, data) || contains(data, realHome)
      || contains(realHome, app) || contains(app, realHome)) throw new Error('credential home overlaps protected storage');
  return realHome;
}

export async function startLogin(uid) {
  if (changing || activeCalls) return { ok: false, error: 'Wait for the current Codex request to finish before signing in.' };
  if (!uid) return { ok: false, error: 'Sign in before connecting.' };
  if (!canDropPrivileges().ok) return { ok: false, error: 'The Coach privilege boundary is unavailable.' };
  if (config.load().authMode !== 'instance') return { ok: false, error: 'Subscription login requires instance mode.' };
  if (attempt?.state === 'pending') return { ok: false, error: 'A sign-in attempt is already pending.' };
  // A reconnect requires explicit disconnect first. That also prevents overwriting another
  // owner's binding while a request is running.
  if (config.authFor(config.load(), 'codex')) return { ok: false, error: 'Remove the existing Codex connection before signing in.' };
  let home;
  try {
    validateCredentialHome();
    // Only the mount root, never recursive traversal or symlink targets. Codex must be able
    // to atomically replace its cache during refresh, including on existing named volumes.
    const ids = unprivilegedIds();
    if (ids) fs.chownSync(config.CREDENTIAL_HOME, ids.uid, ids.gid);
    fs.chmodSync(config.CREDENTIAL_HOME, 0o700);
    home = path.join(config.CREDENTIAL_HOME, `login-${crypto.randomUUID()}`);
    privateDir(home);
  } catch { return { ok: false, error: 'Credential storage is unavailable. Check the private Coach volume permissions.' }; }
  const a = { uid, state: 'pending', fields: {}, home, expiresAt: Date.now() + LOGIN_MS, ctl: new AbortController() };
  attempt = a;
  let output = '';
  a.done = (async () => {
    try {
      const r = await command('codex', [...AUTH_ARGS, 'login', '--device-auth'], {
        env: authEnv(home), timeoutMs: LOGIN_MS, signal: a.ctl.signal, processGroup: true,
        onOutput(chunk) { output = (output + chunk).slice(-8192); a.fields = deviceFields(output); }
      });
      if (a.state !== 'pending') return;
      if (r.timedOut || Date.now() >= a.expiresAt) { a.state = 'expired'; return; }
      if (r.code !== 0 || !await cachedLoginStatus(home)) { a.state = 'failed'; return; }
      if (Date.now() >= a.expiresAt) { a.state = 'expired'; return; }
      if (a.state !== 'pending' || config.authFor(config.load(), 'codex')) { a.state = 'cancelled'; return; }
      const file = path.join(home, 'auth.json');
      if (!fs.lstatSync(file).isFile()) { a.state = 'failed'; return; }
      validateCredentialHome();
      fs.chmodSync(file, 0o600);
      fs.renameSync(file, path.join(config.CREDENTIAL_HOME, 'auth.json'));
      config.saveCodexSubscription(uid);
      a.state = 'connected';
    } catch { if (a.state === 'pending') a.state = 'failed'; }
    finally { output = ''; a.fields = {}; try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* no auth output in diagnostics */ } }
  })();
  return { ok: true, ...loginState(uid) };
}

export async function cancelLogin(uid) {
  if (attempt?.state === 'pending') {
    if (attempt.uid !== uid) return { ok: false, error: 'Only the initiating admin can cancel this sign-in.' };
    attempt.state = 'cancelled'; attempt.fields = {}; attempt.ctl.abort();
    await attempt.done;
  }
  return { ok: true, ...loginState(uid) };
}

export async function disconnect(uid) {
  if (changing || activeCalls) return { ok: false, error: 'A Codex request is running. Wait for it to finish, then disconnect.' };
  if (attempt?.state === 'pending' && attempt.uid !== uid) return { ok: false, error: 'Another admin has a pending sign-in.' };
  const bound = config.boundUidFor(config.load(), 'codex');
  if (bound && bound !== uid) return { ok: false, error: 'Only the connected owner can disconnect this subscription.' };
  changing = true;
  try {
    await cancelLogin(uid);
    attempt = null;
    // Calls hold a lease until their CLI process group exits. Disconnect refuses while a lease
    // is held; once removed, retries and queued work cannot use a later connection either.
    config.saveAuth('codex', null);
    if (!canDropPrivileges().ok) return { ok: false, error: 'Connection removed. Runtime logout requires the Coach privilege boundary.' };
    try { validateCredentialHome(); } catch { return { ok: false, error: 'Connection removed. Credential storage is unavailable for logout.' }; }
    const r = await command('codex', [...AUTH_ARGS, 'logout'], { env: authEnv(), timeoutMs: 20000, processGroup: true });
    return r.code === 0 && !r.timedOut ? { ok: true } : { ok: false, error: 'Connection removed. Runtime logout failed; check private credential storage before reconnecting.' };
  } finally { changing = false; }
}
