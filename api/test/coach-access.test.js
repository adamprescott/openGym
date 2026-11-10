import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tempData, writeState, sampleState } from './helpers.mjs';
const dataDir = tempData();
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'coach-access-auth-'));
process.env.COACH_CREDENTIAL_DIR = home;
const config = await import('../coach/config.js');
const { coachRoutes } = await import('../coach/routes.js');
const { authorizedAdapter } = await import('../coach/authorize.js');
const auth = await import('../coach/codex-auth.js');
const { forcePrivilegeVerdict } = await import('../coach/adapters/spawn.js');
const fresh = () => {
  config.save({ enabled: true, provider: 'codex', authMode: 'instance', auth: {}, boundUid: {}, credentialAccess: {} });
  fs.writeFileSync(path.join(home, 'auth.json'), 'synthetic');
  config.saveCodexSubscription('owner');
};
test.after(() => { fs.rmSync(home, { recursive: true, force: true }); forcePrivilegeVerdict(null); auth.setAuthRunnerForTests(null); });

test('owner-only default; explicit grant, persistence, revocation and reconnect reset', () => {
  fresh();
  assert.equal(config.credentialFor('owner').ok, true);
  assert.equal(config.credentialFor('member').ok, false);
  config.setCredentialAccess('codex', ['member']);
  assert.equal(config.credentialFor('member').ok, true);
  assert.equal(config.credentialFor('stranger').ok, false);
  assert.equal(config.credentialFor('owner').ok, true);
  config.reset(); assert.equal(config.credentialFor('member').ok, true);
  config.setCredentialAccess('codex', []);
  assert.equal(config.credentialFor('member').ok, false);
  config.setCredentialAccess('codex', ['member']);
  config.saveCodexSubscription('owner');
  assert.equal(config.credentialFor('member').ok, false);
});

test('API-key migration preserves shared default, then permits only selected users', () => {
  fresh(); config.save({ provider: 'openai' });
  config.saveAuth('openai', { type: 'apikey', data: config.encrypt({ token: 'synthetic-key' }) });
  assert.equal(config.credentialFor('any-user').ok, true);
  config.setCredentialAccess('openai', ['member']);
  assert.equal(config.credentialFor('member').ok, true);
  assert.equal(config.credentialFor('any-user').ok, false);
  config.save({ provider: 'codex' });
  assert.equal(config.credentialFor('member').ok, false, 'grants are per-provider');
});

test('revocation and regrant invalidate queued work and repair calls', async () => {
  fresh(); forcePrivilegeVerdict({ ok: true });
  auth.setAuthRunnerForTests(async () => ({ code: 0, stdout: 'Logged in using ChatGPT', stderr: '' }));
  config.setCredentialAccess('codex', ['member']);
  let calls = 0;
  const adapter = { spawns: true, invoke: async () => { calls++; return { code: 0, text: 'ok' }; } };
  const guarded = authorizedAdapter(adapter, 'member', config.credentialRevision('member'));
  assert.equal((await guarded.invoke({ jobDir: home })).code, 0);
  config.setCredentialAccess('codex', []);
  assert.equal((await guarded.invoke({ jobDir: home })).code, 1);
  config.setCredentialAccess('codex', ['member']);
  assert.equal((await guarded.invoke({ jobDir: home })).code, 1, 'old queued request stays invalid');
  assert.equal(calls, 1);
});

test('deleting a selected user revokes access; deleting owner removes all delegated grants', () => {
  fresh(); config.setCredentialAccess('codex', ['one', 'two']);
  config.revokeCredentialAccess('one');
  assert.equal(config.credentialFor('one').ok, false);
  assert.equal(config.credentialFor('two').ok, true);
  config.revokeCredentialAccess('owner');
  assert.equal(config.credentialFor('two').ok, false);
});

test('access route requires owner admin, valid existing users and current connection revision', async () => {
  fresh();
  const routes = coachRoutes({ json: (res, status, body) => Object.assign(res, { status, body }),
    readSession: req => ({ id: req.uid }), readBody: async req => req.body,
    requireAdmin: (req, res) => { if (req.admin) return true; res.status = 403; return false; },
    listUsers: () => [{ id: 'owner' }, { id: 'member' }, { id: 'other-admin' }] });
  const route = routes['POST /api/admin/coach/access'];
  const call = async (uid, admin, body) => { const res = {}; await route({ uid, admin, body }, res); return res; };
  const body = { provider: 'codex', revision: config.accessRevision('owner'), uids: ['member'] };
  assert.equal((await call('owner', false, body)).status, 403);
  assert.equal((await call('other-admin', true, body)).status, 403);
  assert.equal((await call('owner', true, { ...body, uids: ['missing'] })).status, 400);
  assert.equal((await call('owner', true, { ...body, uids: 'member' })).status, 400);
  assert.equal((await call('owner', true, { ...body, revision: 'stale' })).status, 409);
  assert.equal((await call('owner', true, body)).status, 200);
  assert.equal(config.credentialFor('member').ok, true);
  assert.equal((await call('owner', true, body)).status, 409, 'stale tabs cannot overwrite access');
});

test('a connection change while reading the request cannot use the previous owner permission', async () => {
  fresh();
  const snapshot = config.load(), oldRevision = config.accessRevision('owner', snapshot);
  const routes = coachRoutes({
    json: (res, status, body) => Object.assign(res, { status, body }),
    requireAdmin: () => true, readSession: () => ({ id: 'owner' }),
    listUsers: () => [{ id: 'member' }],
    readBody: async () => {
      config.saveCodexSubscription('new-owner');
      return { provider: 'codex', revision: config.accessRevision('owner'), uids: ['member'] };
    }
  });
  const res = {}; await routes['POST /api/admin/coach/access']({}, res);
  assert.equal(res.status, 403);
  assert.equal(config.credentialFor('member').ok, false);
  assert.equal(config.accessRevision('owner', snapshot), oldRevision, 'snapshot revision stays consistent with its policy');
});

test('ask and adapt spend subscription access only for its owner and granted profiles', async () => {
  fresh();
  forcePrivilegeVerdict({ ok: true, dropped: false, why: 'synthetic runtime for access checks' });
  auth.setAuthRunnerForTests(async () => ({ code: 0, stdout: 'Logged in using ChatGPT', stderr: '' }));
  config.setCredentialAccess('codex', ['member']);
  const { adapterFor } = await import('../coach/adapters/index.js');
  const jobs = await import('../coach/jobs.js');
  const adapter = adapterFor('codex');
  const originalInvoke = adapter.invoke;
  let invocations = 0;
  // The real enqueue, credential checks and invocation wrapper run; no provider is contacted.
  adapter.invoke = async () => { invocations++; return { code: 1, text: '', stderr: 'synthetic response' }; };
  const routes = coachRoutes({
    json: (res, status, body) => Object.assign(res, { status, body }),
    readSession: req => ({ id: req.uid }), readBody: async req => req.body,
    requireAdmin: () => false
  });
  const today = { name: 'Full body A', entries: [{
    id: '0001', target: { sets: 3, reps: 10, weight: 20 },
    sets: [{ w: 20, r: 10, done: false }]
  }] };
  try {
    for (const uid of ['owner', 'member', 'stranger']) {
      writeState(dataDir, uid, sampleState());
      for (const kind of ['ask', 'adapt']) {
        const before = invocations;
        const res = {};
        await routes[`POST /api/coach/${kind}`]({ uid, body: {
          text: 'How should I adjust the next set?', today, entry: 0
        } }, res);
        if (uid === 'stranger') {
          assert.equal(res.status, 409);
          assert.equal(res.body.code, 'shared');
          assert.equal(jobs.status(uid).job, null);
          assert.equal(invocations, before, 'a refused request cannot reach the runtime');
        } else {
          assert.equal(res.status, 202, `${uid} may enqueue ${kind}`);
          const deadline = Date.now() + 5000;
          while (jobs.status(uid).job && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
          assert.equal(jobs.status(uid).job, null, 'the synthetic request completed');
          assert.equal(invocations, before + 1, `${uid}'s ${kind} passed the invocation access check`);
        }
      }
    }
    assert.equal(invocations, 4);
  } finally {
    adapter.invoke = originalInvoke;
  }
});
