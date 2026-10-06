#!/usr/bin/env python3
"""Trigger a private Portainer stack and verify both exact published image digests.

Do not print request URLs, server responses, or exception text: Actions logs on a
public repository must not disclose deployment infrastructure.
"""
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


class DeploymentError(Exception):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # In particular, never forward the API key to a redirected host.
        return None


OPENER = urllib.request.build_opener(NoRedirect)


def request(url, key=None, method="GET"):
    headers = {"Accept": "application/json"}
    if key:
        headers["X-API-Key"] = key
    req = urllib.request.Request(url, headers=headers, method=method)
    with OPENER.open(req, timeout=15) as response:
        body = response.read(2_000_000)
        return json.loads(body) if body else None


def require_https(value):
    parsed = urllib.parse.urlsplit(value)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
        raise DeploymentError("Deployment URLs must use HTTPS without embedded credentials or fragments.")
    return parsed


def configuration(env):
    names = ("PORTAINER_WEBHOOK_URL", "PORTAINER_URL", "PORTAINER_API_KEY",
             "PORTAINER_STACK_ID", "OPENGYM_HEALTH_URL", "OPENGYM_TAG",
             "OPENGYM_API_IMAGE", "OPENGYM_WEB_IMAGE", "OPENGYM_API_DIGEST", "OPENGYM_WEB_DIGEST")
    if any(not env.get(name) for name in names):
        raise DeploymentError("Required deployment configuration is missing; see the deployment guide.")
    config = {name: env[name] for name in names}
    for name in ("PORTAINER_WEBHOOK_URL", "PORTAINER_URL", "OPENGYM_HEALTH_URL"):
        require_https(config[name])
    if urllib.parse.urlsplit(config["PORTAINER_URL"]).query:
        raise DeploymentError("Portainer base URL cannot contain a query string.")
    if not config["PORTAINER_STACK_ID"].isdigit():
        raise DeploymentError("Stack ID must be numeric.")
    if not re.fullmatch(r"sha-[0-9a-f]{40}", config["OPENGYM_TAG"]):
        raise DeploymentError("Image tag must be a full commit SHA tag.")
    for name in ("OPENGYM_API_DIGEST", "OPENGYM_WEB_DIGEST"):
        if not re.fullmatch(r"sha256:[0-9a-f]{64}", config[name]):
            raise DeploymentError("Published image digests are invalid.")
    return config


def webhook_url(config):
    parsed = urllib.parse.urlsplit(config["PORTAINER_WEBHOOK_URL"])
    pairs = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
    pairs = [(name, value) for name, value in pairs if name != "OPENGYM_TAG"]
    pairs.append(("OPENGYM_TAG", config["OPENGYM_TAG"]))
    return urllib.parse.urlunsplit(parsed._replace(query=urllib.parse.urlencode(pairs)))


def deployed(config, get=request):
    base = config["PORTAINER_URL"].rstrip("/") + "/api"
    key = config["PORTAINER_API_KEY"]
    stack = get(base + "/stacks/" + config["PORTAINER_STACK_ID"], key)
    if not stack or not stack.get("Name") or not stack.get("EndpointId"):
        return False
    if not any(item.get("name") == "OPENGYM_TAG" and item.get("value") == config["OPENGYM_TAG"]
               for item in stack.get("Env", [])):
        return False
    docker = base + "/endpoints/" + str(stack["EndpointId"]) + "/docker"
    filters = urllib.parse.urlencode({"all": "1", "filters": json.dumps({
        "label": ["com.docker.compose.project=" + stack["Name"]]})})
    containers = get(docker + "/containers/json?" + filters, key)
    for service in ("api", "web"):
        matching = [item for item in containers if
                    item.get("Labels", {}).get("com.docker.compose.service") == service]
        if not matching:
            return False
        image = config["OPENGYM_" + service.upper() + "_IMAGE"]
        digest = config["OPENGYM_" + service.upper() + "_DIGEST"]
        for container in matching:
            if container.get("State") != "running" or container.get("Image") != image + ":" + config["OPENGYM_TAG"]:
                return False
            details = get(docker + "/containers/" + container["Id"] + "/json", key)
            if details.get("State", {}).get("Health", {}).get("Status", "healthy") != "healthy":
                return False
            metadata = get(docker + "/images/" + urllib.parse.quote(details["Image"], safe="") + "/json", key)
            if image + "@" + digest not in metadata.get("RepoDigests", []):
                return False
    health = get(config["OPENGYM_HEALTH_URL"])
    return isinstance(health, dict) and health.get("ok") is True


def main():
    config = configuration(os.environ)
    try:
        request(webhook_url(config), method="POST")
    except (urllib.error.URLError, TimeoutError, ValueError, OSError):
        raise DeploymentError("Portainer did not confirm the deployment trigger; inspect its stack privately.") from None
    print("Deployment accepted. Waiting for both published image digests and application health.", flush=True)
    deadline = time.monotonic() + 900
    while time.monotonic() < deadline:
        try:
            if deployed(config):
                print("Both published images are running and application health passed.")
                return
        except (urllib.error.URLError, TimeoutError, ValueError, KeyError, TypeError, OSError):
            pass  # Pulling/recreating containers can temporarily make API reads fail.
        time.sleep(10)
    raise DeploymentError("Deployment verification timed out. Inspect the stack privately; rollback is not automatic.")


if __name__ == "__main__":
    try:
        main()
    except DeploymentError as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
    except Exception:
        # Even unexpected failures must not disclose a server URL in a traceback.
        print("Deployment failed unexpectedly; inspect the stack privately.", file=sys.stderr)
        sys.exit(1)
