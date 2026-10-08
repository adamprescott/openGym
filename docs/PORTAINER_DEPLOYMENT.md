# GitHub Actions deployment with Portainer and Traefik

This fork can publish its own API and web images to GHCR, then update a standalone
Docker stack managed by Portainer Business Edition. The deployment definition is
`docker-compose.portainer.yml`; the regular `docker-compose.yml` remains available
for upstream-style local development.

Infrastructure configuration belongs in Portainer and GitHub Actions secrets.
Do not commit a filled-in environment file, deployment URLs, credentials, or
server-specific network and certificate configuration. Nothing private is
passed into the image builds. The web frontend uses the same origin as its API,
so its public hostname is runtime configuration rather than a build argument.

## 1. Publish the first images

Enable Actions in the fork, then run **Build and deploy containers** manually
from `main` (or push a commit to `main`). Deployment is initially disabled.
Tests run first, and both application images are published with one full commit
tag:

```text
ghcr.io/<lowercase-github-owner>/opengym-api:sha-<full-commit-sha>
ghcr.io/<lowercase-github-owner>/opengym-web:sha-<full-commit-sha>
```

The built-in `GITHUB_TOKEN` publishes images; no personal GitHub token is needed
for the workflow. Newly created GHCR packages can be private even when the
repository is public. Set each package to public for anonymous server pulls, or
configure a GHCR registry credential in Portainer before creating the stack.
The workflow's image source labels associate the packages with this fork.

Optional repository **variables**, under Settings → Secrets and variables →
Actions → Variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENGYM_API_TARGET` | `default` | `coach` adds the optional Claude/Codex runtimes; it is not required for ordinary hosting. |
| `OPENGYM_PLATFORMS` | `linux/amd64` | Native GitHub-hosted build platform. `linux/amd64,linux/arm64` also enables QEMU for the API build. |
| `PORTAINER_DEPLOY_ENABLED` | unset | Set to exactly `true` only after the stack and deployment secrets exist. |

Changing the API target takes effect on the next new commit build. Do not rebuild
an already deployed commit with a different target or overwrite its SHA tag.
Retain previous image tags for rollback; the deploy verifier also checks the
exact published image digests, so a healthy previous release cannot pass.

## 2. Create the initial Portainer stack

Create a stack with a stable name in the **Web Editor**, and paste the contents of
`docker-compose.portainer.yml`. It requires Docker Compose, not Swarm. Provide
these values in Portainer's stack environment variables:

| Variable | Value to supply privately |
| --- | --- |
| `OPENGYM_API_IMAGE` | Your API image name, without its tag. |
| `OPENGYM_WEB_IMAGE` | Your web image name, without its tag. |
| `OPENGYM_TAG` | First successfully published `sha-<full-commit-sha>` tag. |
| `OPENGYM_HOST` | Public application hostname, without `https://` or a path. |
| `TRAEFIK_NETWORK` | Existing external Docker network used by Traefik. |
| `TRAEFIK_HTTPS_ENTRYPOINT` | Traefik HTTPS entrypoint name. |
| `TRAEFIK_CERT_RESOLVER` | Traefik certificate resolver name. |

The template sets `RP_ID` and `ORIGIN` from the hostname, connects only nginx to
the proxy network, and keeps the API on the application network. It publishes no
host ports. DNS and Traefik's Docker provider/TLS resolver must already work.
Choose the permanent hostname before registering passkeys.

The media initializer downloads the upstream exercise assets into named volumes
and must finish before nginx starts. Its success markers are written only after
both copies succeed, allowing a failed download to retry. Read `NOTICE.md` for
the media's separate licensing terms.

Optional Portainer variables include `ADMIN_UIDS`, `INVITE_ONLY`, `ALLOW_GUEST`,
`DEFAULT_LANG`, `PASSWORD_LOGIN`, `RP_NAME`, `COACH_DISABLED`, and
`MEDIA_UPLOAD_MAX`. Other application settings from `.env.example` can be added
to the API's `environment` section through Portainer if needed. Do not paste
secret values directly into a Compose definition committed to Git.

## 3. Enable automated deployment

After the first deployment works, create a GitHub environment named **production**.
Put these secrets in that environment (repository-level Actions secrets also work):

| Secret | Value |
| --- | --- |
| `PORTAINER_URL` | HTTPS base URL for Portainer, without `/api`. |
| `PORTAINER_API_KEY` | Access token able to read and update this stack and read its Docker endpoint's containers/images. |
| `PORTAINER_STACK_ID` | Numeric stack ID, visible in its Portainer page URL/API. |
| `OPENGYM_HEALTH_URL` | Complete application HTTPS URL ending in `/api/health`. |

The API token authorizes both the stack update and verification. Use a file-based
Docker Compose stack created through Portainer's editor or file upload. Both
Portainer and the health endpoint need to be reachable by
GitHub-hosted runners, have valid HTTPS certificates, and respond without login
redirects. Avoid printing secret values or API responses while diagnosing CI.

Set the repository variable `PORTAINER_DEPLOY_ENABLED=true`. Subsequent pushes to
`main` test, publish both images, and update the stack through the authenticated
Portainer API. The workflow reads the current stack file and environment, replaces
only `OPENGYM_TAG`, then requests an image pull without pruning resources. The
workflow serializes the complete pipeline and skips deployment
when its commit is no longer the latest `main`. GitHub may replace an older
pending concurrency run with a newer one; deploying every intermediate commit
is not guaranteed. Manual runs from branches other than `main` cannot publish
or deploy. Pull requests run tests without deployment credentials.

Verification polls Portainer for the requested stack environment tag, both
running service containers, their health, and their exact GHCR image digests.
Only then does it check the application health endpoint. It allows 15 minutes
for the initial media download, pulls, and Docker health checks. Requests and
responses are not printed, and failures report generic messages to keep host
configuration out of public Actions logs. Inspect Portainer privately for the
specific reason when a deployment fails. A connection timeout during an update
does not retry the update; verification checks whether the requested images
were deployed despite the interrupted response.

For completely automatic deployment, leave the production environment without
required reviewers. Add reviewers if you want an approval before each update.

## Persistence and rollback

The stack has named volumes for application data, provider credentials, images,
and GIFs. Keep the stack name stable: Compose prefixes these volume names with
it. Redeploying images preserves those volumes. Deleting them destroys their
contents. Back up the `application_data` volume, including user state, passkeys,
the session secret, and custom media. Protect backups and take one before a
release that changes data formats. Provider login cache lives separately in
`coach_auth` and can be regenerated by signing in again.

To roll back, first set `PORTAINER_DEPLOY_ENABLED=false` to stop new workflow
triggers. Let an already running deployment finish (disabling the variable does
not stop one already in progress), or cancel it and confirm Portainer has
finished its update. Set `OPENGYM_TAG` to a previous known-good published tag in
Portainer and update the stack. Retain the same image names, configuration, and
volumes. A data-format change can require restoring the corresponding backup;
rollback is deliberately not automatic.

Automated deployment preserves the live stack file while updating its image tag.
When the Compose template changes, apply its changes separately through Portainer's
editor while retaining private settings. The inherited GitLab mirror remains
upstream-only, and the GitHub Pages demo is also upstream-only. Android release
publishing is separate from server deployment; see [Android fork builds](ANDROID_FORK.md).
