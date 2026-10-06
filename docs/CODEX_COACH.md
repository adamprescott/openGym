# Codex Coach with a ChatGPT subscription

The Codex runtime supports an API key or one owner's cached ChatGPT sign-in. The
subscription connection is explicitly bound to the openGym profile that completes
device sign-in. Other profiles cannot use it, including through scheduled jobs or
admin testing. Per-profile subscription accounts are not supported in this version.

## Build and storage

For GitHub Actions, set the repository variable `OPENGYM_API_TARGET=coach` and build
a new commit. For local Compose, use `API_TARGET=coach`. The default API image does
not include Codex. The coach target pins `@openai/codex` to `0.160.1`.

Keep `/coach-auth` on the private persistent credential volume supplied by the
Compose templates. It must be separate from `/data` and writable by the `coach`
user, with directory mode `0700`. When starting device login, the API validates the
mount root and sets only that directory's owner and mode; it never recursively
changes ownership or follows a mount-root symlink. A read-only mount will not work:
Codex needs to replace its cached credentials when refreshing them.

The cache is credential material. Exclude the credential volume from ordinary
workout backups and exports. Never attach its contents, device codes, raw login
output, or deployment-specific configuration to public issues.

## Connect

1. Sign in to openGym using the owner's admin profile.
2. Open **Settings → Admin dashboard → AI Coach**, enable Coach, and choose
   **Codex (OpenAI)**.
3. Click **Sign in with ChatGPT**. Follow the OpenAI verification link and enter
   the one-time code shown only to the initiating admin. Complete only the sign-in
   you started yourself. Device code login may need enabling in your OpenAI account
   or workspace settings.
4. Once connected, choose a model or leave the runtime default, then run
   **Test the Coach**. This makes a real model call using the requesting profile's
   account, without workout data.

Login runs as `coach`, in a private temporary credential directory. Only a successful
ChatGPT login status promotes the cache to the persistent home and saves the owner
binding. Concurrent attempts are refused. Cancellation kills the login process
group and discards its staged cache. Attempts expire after 15 minutes; a server
restart requires starting an unfinished sign-in again. Completed logins persist
across restart; Codex manages token refresh.

Connected status confirms the local cache and its authentication mode, rather than
remote validity. The test and a real Coach job are separate checks. Missing cache,
invalid local status, or a recognized authentication failure requires reconnecting.
Provider/runtime failures return a generic diagnostic without raw authentication
output. **Remove** disconnects the subscription, runs supported Codex logout, and
clears its binding. If a request is running, disconnect asks you to wait for it to
finish; this prevents token refresh racing logout or the next account's sign-in.

Jobs capture their connection revision when queued and check it before every model
invocation, including a repair attempt. Disconnect, reconnect, or switching provider
invalidates queued work. API-key jobs use a fresh job-local `CODEX_HOME`, so they
cannot silently fall back to the subscription. Subscription jobs receive no API key.
Disconnect before switching between these authentication types.

Execution keeps the read-only sandbox and ignores the credential home's user
configuration. The pinned CLI's shell, JavaScript, image-reading, app and subagent
features are explicitly disabled: Coach only needs to return structured text.

## Validation still required before deployment

The automated tests use synthetic credentials and fake CLI responses. CLI version
and help were checked without sign-in. A successful `--version` is not proof that
the Alpine image can complete model execution in its sandbox.

Before treating this integration as production ready, the owner must authorize a
separate container smoke test: complete device login, run Test the Coach and a real
job, verify another profile is refused, restart and confirm persistence, disconnect
and reconnect, and verify the `coach` user cannot read `/data`. Check the actual
container sandbox without bypassing it or removing the privilege drop. No live
sign-in, model call, deployment, or credential access is needed for the automated
test suite.

Official references: [authentication](https://learn.chatgpt.com/docs/auth) and
[CLI command reference](https://learn.chatgpt.com/docs/developer-commands).
