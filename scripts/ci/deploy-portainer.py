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


def request(url, key=None, method="GET", payload=None, timeout=15):
    headers = {"Accept": "application/json"}
    if key:
        headers["X-API-Key"] = key
    data = None
    if payload is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, headers=headers, method=method, data=data)
    with OPENER.open(req, timeout=timeout) as response:
        # A successful write needs no response body. Some proxies return plain
        # text instead of JSON; that must not turn an accepted update into failure.
        if method != "GET":
            return None
        body = response.read(2_000_000)
        return json.loads(body) if body else None


def require_https(value):
    parsed = urllib.parse.urlsplit(value)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
        raise DeploymentError("Deployment URLs must use HTTPS without embedded credentials or fragments.")
    return parsed


def configuration(env):
    names = ("PORTAINER_URL", "PORTAINER_API_KEY",
             "PORTAINER_STACK_ID", "OPENGYM_HEALTH_URL", "OPENGYM_TAG",
             "OPENGYM_API_IMAGE", "OPENGYM_WEB_IMAGE", "OPENGYM_API_DIGEST", "OPENGYM_WEB_DIGEST")
    if any(not env.get(name) for name in names):
        raise DeploymentError("Required deployment configuration is missing; see the deployment guide.")
    config = {name: env[name] for name in names}
    for name in ("PORTAINER_URL", "OPENGYM_HEALTH_URL"):
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


def trigger(config, call=request):
    base = config["PORTAINER_URL"].rstrip("/") + "/api"
    key = config["PORTAINER_API_KEY"]
    stack_url = base + "/stacks/" + config["PORTAINER_STACK_ID"]
    stack = call(stack_url, key)
    if not isinstance(stack, dict) or stack.get("Type") != 2 or stack.get("GitConfig"):
        raise DeploymentError("Deployment requires a file-based Docker Compose stack.")
    endpoint = stack.get("EndpointId")
    if not isinstance(endpoint, int) or isinstance(endpoint, bool) or endpoint <= 0:
        raise DeploymentError("The deployment stack has no valid Docker endpoint.")
    env = stack.get("Env")
    if not isinstance(env, list) or any(
            not isinstance(item, dict) or not isinstance(item.get("name"), str)
            or not isinstance(item.get("value"), str) for item in env):
        raise DeploymentError("The deployment stack environment could not be read safely.")
    file = call(stack_url + "/file", key)
    if not isinstance(file, dict) or not isinstance(file.get("StackFileContent"), str) or not file["StackFileContent"].strip():
        raise DeploymentError("The deployment stack file could not be read safely.")
    # Preserve the deployed definition and all private settings; only the image
    # tag changes. Never substitute the repository template for this live file.
    updated_env = [dict(item) for item in env]
    for item in updated_env:
        if item["name"] == "OPENGYM_TAG":
            item["value"] = config["OPENGYM_TAG"]
    if not any(item["name"] == "OPENGYM_TAG" for item in updated_env):
        updated_env.append({"name": "OPENGYM_TAG", "value": config["OPENGYM_TAG"]})
    call(stack_url + "?" + urllib.parse.urlencode({"endpointId": endpoint}), key,
         method="PUT", timeout=120, payload={
             "StackFileContent": file["StackFileContent"], "Env": updated_env,
             "Prune": False, "PullImage": True})


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
        trigger(config)
    except urllib.error.HTTPError as exc:
        raise DeploymentError("Portainer deployment API returned HTTP " + str(exc.code) +
                              "; inspect its stack privately.") from None
    except (TimeoutError, urllib.error.URLError, OSError):
        # An update may still finish after a connection times out. Verification
        # below resolves that ambiguity without issuing a second deployment.
        print("Deployment API connection was interrupted. Checking the published images before reporting failure.", flush=True)
    except (ValueError, KeyError, TypeError):
        raise DeploymentError("Portainer deployment configuration could not be read; inspect its stack privately.") from None
    print("Waiting for both published image digests and application health.", flush=True)
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
