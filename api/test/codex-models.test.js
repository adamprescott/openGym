import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { discoverModels } from '../coach/adapters/codex-models.js';
import { forcePrivilegeVerdict } from '../coach/adapters/spawn.js';

forcePrivilegeVerdict({ ok: true });
after(() => forcePrivilegeVerdict(null));

function fake(respond) {
  const calls = [];
  let killed = false;
  const spawn = (cmd, argv, options) => {
    assert.equal(cmd, 'codex');
    assert.deepEqual(argv.slice(0, 3), ['app-server', '--listen', 'stdio://']);
    assert.equal(options.env.SECRET_FROM_PARENT, undefined);
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { killed = true; queueMicrotask(() => child.emit('close', null)); };
    child.stdin = new EventEmitter();
    child.stdin.write = line => {
      const req = JSON.parse(line); calls.push(req);
      queueMicrotask(() => respond(req, child));
    };
    return child;
  };
  return { spawn, calls, killed: () => killed };
}
const reply = (child, req, result) => child.stdout.write(JSON.stringify({ id: req.id, result }) + '\n');

test('handshake, paginated visible catalog and runtime default; no inference or raw fields', async () => {
  const f = fake((req, child) => {
    if (req.method === 'initialize') reply(child, req, {});
    if (req.method === 'model/list') reply(child, req, req.params.cursor
      ? { data: [{ model: 'model-b', isDefault: true, account: 'private' }], nextCursor: null }
      : { data: [{ model: 'model-a' }, { model: 'hidden', hidden: true }], nextCursor: 'page2' });
  });
  assert.deepEqual(await discoverModels({ env: {}, cwd: '/tmp' }, f.spawn), { ok: true, models: ['model-a', 'model-b'], defaultModel: 'model-b' });
  assert.deepEqual(f.calls.map(x => x.method), ['initialize', 'initialized', 'model/list', 'model/list']);
  assert.equal(f.killed(), true);
});

test('missing default remains unknown rather than assuming the first model', async () => {
  const f = fake((req, child) => {
    if (req.method === 'initialize') reply(child, req, {});
    if (req.method === 'model/list') reply(child, req, { data: [{ model: 'model-a' }] });
  });
  assert.equal((await discoverModels({ env: {} }, f.spawn)).defaultModel, null);
});

test('errors, malformed output, repeated cursors and timeout fail safely and kill the child', async () => {
  for (const mode of ['error', 'malformed', 'cursor', 'timeout']) {
    const f = fake((req, child) => {
      if (mode === 'timeout') return;
      if (req.method === 'initialize') return reply(child, req, {});
      if (req.method !== 'model/list') return;
      if (mode === 'error') child.stdout.write(JSON.stringify({ id: req.id, error: { message: 'private-token' } }) + '\n');
      if (mode === 'malformed') child.stdout.write('private-token\n');
      if (mode === 'cursor') reply(child, req, { data: [], nextCursor: 'loop' });
    });
    const r = await discoverModels({ env: {}, timeoutMs: 30 }, f.spawn);
    assert.equal(r.ok, false, mode);
    assert.equal(JSON.stringify(r).includes('private-token'), false);
    assert.equal(f.killed(), true, mode);
  }
});

test('privilege boundary refuses before spawning', async () => {
  forcePrivilegeVerdict({ ok: false });
  try {
    const r = await discoverModels({ env: {} }, () => assert.fail('must not spawn'));
    assert.equal(r.ok, false);
  } finally { forcePrivilegeVerdict({ ok: true }); }
});
