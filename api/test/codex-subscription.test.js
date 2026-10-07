import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { tempData } from './helpers.mjs';

tempData();
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-auth-test-'));
process.env.COACH_CREDENTIAL_DIR = home;
const config = await import('../coach/config.js');
const auth = await import('../coach/codex-auth.js');
const { authorizedAdapter } = await import('../coach/authorize.js');
const { forcePrivilegeVerdict, run } = await import('../coach/adapters/spawn.js');
const jobs = await import('../coach/jobs.js');
const { adapterFor } = await import('../coach/adapters/index.js');
const { coachRoutes } = await import('../coach/routes.js');
forcePrivilegeVerdict({ ok: true, dropped: false });
after(() => { auth.setAuthRunnerForTests(null); fs.rmSync(home, { recursive: true, force: true }); });

const fresh = () => config.save({ enabled: true, provider: 'codex', authMode: 'instance', auth: {}, boundUid: {} });
const cache = () => fs.writeFileSync(path.join(home, 'auth.json'), 'test-only-placeholder', { mode: 0o600 });
const okStatus = async () => ({ code: 0, stdout: '', stderr: 'Logged in using ChatGPT' });

test('model catalog enforces requester ownership and reserves auth during discovery', async () => {
  fresh(); cache(); config.saveCodexSubscription('owner'); auth.setAuthRunnerForTests(okStatus);
  const adapter = adapterFor('codex'), original = adapter.models;
  let calls = 0;
  adapter.models = async () => {
    calls++;
    assert.equal((await auth.disconnect('owner')).ok, false);
    return { ok: true, models: ['model-a'], defaultModel: 'model-a' };
  };
  try {
    assert.equal((await jobs.listRuntimeModels('other-admin')).ok, false);
    assert.equal(calls, 0);
    assert.deepEqual(await jobs.listRuntimeModels('owner'), { ok: true, models: ['model-a'], defaultModel: 'model-a' });
    assert.equal(calls, 1);
    adapter.models = async () => { config.saveCodexSubscription('owner'); return { ok: true, models: ['stale'] }; };
    assert.equal((await jobs.listRuntimeModels('owner')).ok, false, 'account changes discard stale catalog');
  } finally { adapter.models = original; }
});
const prompt = 'Open https://auth.openai.com/codex/device\nEnter this one-time code (expires in 15 minutes)\n   ABCD-EFGHI\n';
async function waitFor(state) {
  for (let n = 0; n < 100; n++) {
    if (auth.loginState('owner').state === state) return;
    await new Promise(r => setTimeout(r, 5));
  }
  assert.fail(`login did not become ${state}`);
}

test('device output exposes only the exact OpenAI URL and heading-scoped code', () => {
  assert.deepEqual(auth.deviceFields(prompt + 'secret bearer-token'), { verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-EFGHI' });
  assert.deepEqual(auth.deviceFields(prompt.replace('auth.openai.com', 'attacker.example')), {});
  assert.deepEqual(auth.deviceFields('https://auth.openai.com/codex/device\nABCD-EFGHI'), {});
});

test('credential mount validation rejects data, ancestors, descendants and symlink aliases before ownership changes', () => {
  assert.equal(auth.validateCredentialHome(home), fs.realpathSync(home));
  assert.throws(() => auth.validateCredentialHome(process.env.DATA_DIR));
  assert.throws(() => auth.validateCredentialHome(path.dirname(process.env.DATA_DIR)));
  const child = path.join(process.env.DATA_DIR, 'private-auth'); fs.mkdirSync(child);
  assert.throws(() => auth.validateCredentialHome(child));
  const alias = path.join(home, 'data-alias'); fs.symlinkSync(process.env.DATA_DIR, alias);
  assert.throws(() => auth.validateCredentialHome(alias)); fs.unlinkSync(alias);
  assert.throws(() => auth.validateCredentialHome(process.cwd()));
});

test('restart cleanup removes only named staging directories and preserves active cache and symlink targets', () => {
  cache();
  const orphan = path.join(home, 'login-00000000-0000-0000-0000-000000000000'); fs.mkdirSync(orphan);
  fs.writeFileSync(path.join(orphan, 'auth.json'), 'fake unfinished cache');
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'untouched-'));
  const link = path.join(home, 'login-11111111-1111-1111-1111-111111111111'); fs.symlinkSync(target, link);
  auth.recoverLoginOnBoot();
  assert.equal(fs.existsSync(orphan), false); assert.equal(fs.existsSync(path.join(home, 'auth.json')), true);
  assert.equal(fs.existsSync(target), true); assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  fs.unlinkSync(link); fs.rmSync(target, { recursive: true });
});

test('cached ChatGPT login needs explicit owner metadata and rejects another profile and profile mode', async () => {
  fresh(); cache();
  assert.equal(config.credentialFor('owner').ok, false, 'cache alone never grants spending');
  config.saveCodexSubscription('owner');
  assert.equal(config.credentialFor('owner').ok, true);
  assert.equal(config.credentialFor('other').reason, 'shared-account');
  assert.equal((await jobs.testRun('other')).ok, false);
  config.saveProfileAuth('owner', { type: 'chatgpt-cli', data: config.encrypt({ token: 'fake' }) });
  config.save({ authMode: 'profile' });
  assert.equal(config.credentialFor('owner').reason, 'unsupported-mode');
  fresh();
});

test('missing cache, failed local status and stale auth revision all fail before invocation', async () => {
  fresh(); cache(); config.saveCodexSubscription('owner');
  let calls = 0;
  const adapter = { spawns: true, invoke: async () => { calls++; return { code: 0 }; } };
  let guarded = authorizedAdapter(adapter, 'owner', config.credentialRevision('owner'));
  fs.unlinkSync(path.join(home, 'auth.json'));
  assert.equal((await guarded.invoke({ jobDir: home })).code, 1);
  cache(); auth.setAuthRunnerForTests(async () => ({ code: 0, stderr: 'Logged in using API key: redacted' }));
  assert.equal((await guarded.invoke({ jobDir: home })).code, 1);
  assert.equal(config.authFor().reconnectNeeded, true);
  config.saveCodexSubscription('owner'); auth.setAuthRunnerForTests(okStatus);
  assert.equal((await guarded.invoke({ jobDir: home })).code, 1, 'reconnect does not revive old queued work');
  assert.equal(calls, 0);
  guarded = authorizedAdapter(adapter, 'owner', config.credentialRevision('owner'));
  config.save({ provider: 'fixture' });
  assert.equal((await guarded.invoke({ jobDir: home })).code, 1, 'provider switches invalidate queued work');
});

test('API-key mode isolates CODEX_HOME and never injects a key into subscription mode', () => {
  fresh(); cache();
  const key = config.jobEnv('/private-job', { type: 'apikey', auth: { token: 'test-key' } });
  assert.equal(key.CODEX_HOME, '/private-job'); assert.equal(key.CODEX_API_KEY, 'test-key');
  const sub = config.jobEnv('/private-job', { type: 'chatgpt-cli', auth: null });
  assert.equal(sub.CODEX_HOME, home); assert.equal(sub.CODEX_API_KEY, undefined);
});

test('device attempt is initiator-only, cancellable, does not promote late success', async () => {
  fresh();
  auth.setAuthRunnerForTests(async (cmd, argv, opts) => {
    if (argv.includes('--device-auth')) {
      opts.onOutput(prompt);
      await new Promise(resolve => opts.signal.addEventListener('abort', resolve, { once: true }));
      fs.writeFileSync(path.join(opts.env.CODEX_HOME, 'auth.json'), 'late fake credential');
      return { code: 0 };
    }
    return okStatus();
  });
  assert.equal((await auth.startLogin('owner')).ok, true);
  assert.equal(auth.loginState('owner').userCode, 'ABCD-EFGHI');
  assert.deepEqual(auth.loginState('other'), { state: 'busy' });
  assert.equal((await auth.cancelLogin('other')).ok, false);
  assert.equal((await auth.startLogin('owner')).ok, false);
  await auth.cancelLogin('owner');
  assert.equal(auth.loginState('owner').state, 'cancelled');
  assert.equal(config.authFor(), null);
  assert.deepEqual(auth.loginState('other'), { state: 'none' });
});

test('successful staged login promotes private cache, binds owner and survives config reload', async () => {
  fresh();
  auth.setAuthRunnerForTests(async (cmd, argv, opts) => {
    if (argv.includes('--device-auth')) {
      assert.notEqual(opts.env.CODEX_HOME, home);
      fs.writeFileSync(path.join(opts.env.CODEX_HOME, 'auth.json'), 'fake cache');
    }
    return okStatus();
  });
  await auth.startLogin('owner'); await waitFor('connected');
  assert.equal(config.authFor().type, 'chatgpt-cli');
  assert.equal(config.authFor().data, undefined);
  assert.equal(config.boundUidFor(), 'owner');
  assert.equal(fs.statSync(path.join(home, 'auth.json')).mode & 0o777, 0o600);
  assert.equal(fs.readdirSync(home).some(n => n.startsWith('login-')), false);
  config.reset(); assert.equal(config.credentialFor('owner').ok, true);
});

test('expired device flow discards staged credentials and exposes no CLI diagnostics', async () => {
  fresh();
  auth.setAuthRunnerForTests(async (cmd, argv, opts) => {
    fs.writeFileSync(path.join(opts.env.CODEX_HOME, 'auth.json'), 'fake expired credential');
    opts.onOutput(prompt + 'sensitive fake diagnostics');
    return { code: 0, timedOut: true, stdout: 'sensitive fake diagnostics' };
  });
  await auth.startLogin('owner'); await waitFor('expired');
  assert.equal(config.authFor(), null);
  assert.equal(JSON.stringify(auth.loginState('owner')).includes('sensitive'), false);
  assert.equal(auth.loginState('owner').userCode, undefined);
});

test('subscription runtime errors redact raw output and require reconnect on auth failures', async () => {
  fresh(); cache(); config.saveCodexSubscription('owner'); auth.setAuthRunnerForTests(okStatus);
  const guarded = authorizedAdapter({ spawns: true, async invoke() { return { code: 1, text: 'private-token', stdout: 'private-token', stderr: '401 unauthorized private-token' }; } }, 'owner', config.credentialRevision('owner'));
  const r = await guarded.invoke({ jobDir: home });
  assert.equal(JSON.stringify(r).includes('private-token'), false);
  assert.equal(config.authFor().reconnectNeeded, true);
});

test('disconnect waits for active request and new login cannot race async logout', async () => {
  fresh(); cache(); config.saveCodexSubscription('owner'); auth.setAuthRunnerForTests(okStatus);
  let release, started;
  const begun = new Promise(r => { started = r; });
  const adapter = { spawns: true, async invoke() { started(); await new Promise(r => { release = r; }); return { code: 0 }; } };
  const guarded = authorizedAdapter(adapter, 'owner', config.credentialRevision('owner'));
  const invocation = guarded.invoke({ jobDir: home }); await begun;
  assert.equal((await auth.disconnect('owner')).ok, false);
  assert.equal(config.credentialFor('owner').ok, true);
  release(); await invocation;
  auth.setAuthRunnerForTests(async () => { await new Promise(r => { release = r; }); return { code: 0 }; });
  const logout = auth.disconnect('owner');
  await new Promise(r => setTimeout(r, 0));
  assert.equal((await auth.startLogin('owner')).ok, false);
  release(); assert.equal((await logout).ok, true);
  assert.equal(config.authFor(), null); assert.equal(auth.loginState('owner').state, 'none');
});

test('every invocation rechecks the revision, including repair, and privilege failures refuse test/login', async () => {
  fresh(); cache(); config.saveCodexSubscription('owner'); auth.setAuthRunnerForTests(okStatus);
  let count = 0;
  const guarded = authorizedAdapter({ spawns: true, async invoke() { count++; config.saveCodexSubscription('owner'); return { code: 0 }; } }, 'owner', config.credentialRevision('owner'));
  assert.equal((await guarded.invoke({ jobDir: home })).code, 0);
  assert.equal((await guarded.invoke({ jobDir: home })).code, 1);
  assert.equal(count, 1);
  forcePrivilegeVerdict({ ok: false, dropped: false });
  try {
    assert.equal((await jobs.testRun('owner')).ok, false);
    assert.equal((await auth.startLogin('owner')).ok, false);
  } finally { forcePrivilegeVerdict({ ok: true, dropped: false }); }
});

test('auth routes require admin and preserve Codex API-key removal without an installed runtime', async () => {
  const routes = coachRoutes({
    json: (res, status, body) => Object.assign(res, { status, body }), readBody: async req => req.body || {},
    readSession: req => ({ id: req.uid || 'owner' }), requireAdmin: (req, res) => { if (req.admin) return true; res.status = 403; return false; }
  });
  for (const key of ['POST /api/admin/coach/codex/login', 'GET /api/admin/coach/codex/login', 'POST /api/admin/coach/codex/cancel']) {
    const res = {}; await routes[key]({}, res); assert.equal(res.status, 403);
  }
  fresh(); config.saveAuth('codex', { type: 'apikey', data: config.encrypt({ token: 'test-key' }) });
  auth.setAuthRunnerForTests(() => { assert.fail('API key removal must not run CLI logout'); });
  const res = {}; await routes['POST /api/admin/coach/disconnect']({ admin: true, body: { provider: 'codex' } }, res);
  assert.equal(res.status, 200); assert.equal(config.authFor(), null);
});

test('process-group cancellation stops launcher descendants', async () => {
  if (process.platform === 'win32') return;
  const heartbeat = path.join(home, 'heartbeat');
  const script = `const fs = require('node:fs'); setInterval(() => fs.appendFileSync(${JSON.stringify(heartbeat)}, 'x'), 10);`;
  const launcher = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(script)}], { stdio: 'ignore' }); setInterval(() => {}, 1000);`;
  const ctl = new AbortController();
  const running = run(process.execPath, ['-e', launcher], { signal: ctl.signal, processGroup: true, asCoach: false, timeoutMs: 3000 });
  for (let n = 0; n < 100 && !fs.existsSync(heartbeat); n++) await new Promise(r => setTimeout(r, 10));
  assert.ok(fs.existsSync(heartbeat)); ctl.abort(); await running;
  await new Promise(r => setTimeout(r, 30));
  const size = fs.statSync(heartbeat).size;
  await new Promise(r => setTimeout(r, 60));
  assert.equal(fs.statSync(heartbeat).size, size, 'descendant heartbeat stopped after cancellation');
});
