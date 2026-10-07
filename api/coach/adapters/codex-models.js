// Read only the runtime's model catalog: no threads, prompts, tools, or inference.
import { spawn } from 'node:child_process';
import { canDropPrivileges, unprivilegedIds } from './spawn.js';

export function discoverModels({ env, cwd, timeoutMs = 20000 }, spawnChild = spawn) {
  const failure = () => ({ ok: false, models: [], defaultModel: null, error: 'Could not read the Codex model catalog. Check the connection and try again.' });
  if (!canDropPrivileges().ok) return Promise.resolve(failure());
  return new Promise(resolve => {
    let child, timer, buffer = '', bytes = 0, result, done = false, nextId = 1;
    let pending = 1, pages = 0;
    const models = new Map(), cursors = new Set();
    const finish = value => {
      if (done) return;
      done = true; result = value;
      clearTimeout(timer);
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch { /* already exited */ }
    };
    const send = message => { if (!done) child.stdin.write(JSON.stringify(message) + '\n'); };
    const list = cursor => {
      if (++pages > 20 || (cursor && cursors.has(cursor))) return finish(failure());
      if (cursor) cursors.add(cursor);
      pending = ++nextId;
      send({ id: pending, method: 'model/list', params: { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) } });
    };
    try {
      child = spawnChild('codex', ['app-server', '--listen', 'stdio://', '-c', 'cli_auth_credentials_store="file"'], {
        env, cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', ...(unprivilegedIds() || {})
      });
    } catch { resolve(failure()); return; }
    timer = setTimeout(() => finish(failure()), timeoutMs);
    child.on('error', () => { finish(failure()); resolve(result); });
    child.on('close', () => { if (!done) { done = true; clearTimeout(timer); } resolve(result || failure()); });
    child.stdin.on('error', () => finish(failure()));
    // Never return raw diagnostics: auth failures can contain sensitive output.
    child.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > 1024 * 1024) finish(failure()); });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (done) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > 1024 * 1024) return finish(failure());
      buffer += chunk;
      let newline;
      while (!done && (newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        let message;
        try { message = JSON.parse(line); } catch { return finish(failure()); }
        if (message.id !== pending) continue;
        if (message.error || !message.result) return finish(failure());
        if (pending === 1) { send({ method: 'initialized' }); list(); continue; }
        if (!Array.isArray(message.result.data)) return finish(failure());
        for (const model of message.result.data) {
          if (!model || model.hidden || typeof model.model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,79}$/.test(model.model)) continue;
          models.set(model.model, { id: model.model, isDefault: model.isDefault === true });
        }
        const cursor = message.result.nextCursor;
        if (cursor) {
          if (typeof cursor !== 'string' || cursor.length > 4096) return finish(failure());
          list(cursor);
        } else {
          const defaults = [...models.values()].filter(m => m.isDefault);
          finish({ ok: true, models: [...models.keys()], defaultModel: defaults.length === 1 ? defaults[0].id : null });
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'opengym_coach', title: 'openGym Coach', version: '1.0.0' } } });
  });
}
