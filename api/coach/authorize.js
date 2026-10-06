/* Recheck before every invocation, including a pipeline's repair call. */
import * as config from './config.js';
import { canDropPrivileges } from './adapters/spawn.js';
import { cachedLoginStatus, reserveSubscription, releaseSubscription } from './codex-auth.js';

export function authorizedAdapter(adapter, uid, revision) {
  return { ...adapter, async invoke(opts) {
    const denied = { code: 1, text: '', stderr: 'Coach authentication changed or is unavailable. Reconnect and retry.' };
    if (!config.isEnabled() || config.credentialRevision(uid) !== revision) return denied;
    const credential = config.credentialFor(uid);
    if (!credential.ok || (adapter.spawns !== false && !canDropPrivileges().ok)) return denied;
    const subscription = credential.type === 'chatgpt-cli';
    if (subscription && !reserveSubscription()) return denied;
    try {
      if (subscription && !await cachedLoginStatus()) {
        config.requireCodexReconnect(revision, uid); return denied;
      }
      // The asynchronous status check may race with disconnect or a provider switch.
      if (!config.isEnabled() || config.credentialRevision(uid) !== revision) return denied;
      const env = config.jobEnv(opts.jobDir, credential);
      const r = await adapter.invoke({ ...opts, env });
      // Auth errors from the CLI must never surface its raw output, including token diagnostics.
      if (subscription && r.code !== 0) {
        if (/unauthor|401|403|auth.*(fail|invalid|expire)|refresh.*(fail|invalid)/i.test(r.stderr || '')) config.requireCodexReconnect(revision, uid);
        return { ...r, text: '', stdout: '', stderr: 'Codex could not complete the request. Check connection and runtime, then reconnect if required.' };
      }
      return r;
    } finally { if (subscription) releaseSubscription(); }
  } };
}
