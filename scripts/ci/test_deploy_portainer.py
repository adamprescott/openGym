"""Offline checks for deployment verification; no real infrastructure or tokens."""
import importlib.util
import pathlib
import unittest
import urllib.error
from unittest import mock

spec = importlib.util.spec_from_file_location("deployment", pathlib.Path(__file__).with_name("deploy-portainer.py"))
deployment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deployment)


class DeploymentVerificationTest(unittest.TestCase):
    def setUp(self):
        self.config = deployment.configuration({
            "PORTAINER_URL": "https://control.example.test",
            "PORTAINER_API_KEY": "example-test-key",
            "PORTAINER_STACK_ID": "1",
            "OPENGYM_HEALTH_URL": "https://gym.example.test/api/health",
            "OPENGYM_TAG": "sha-" + "a" * 40,
            "OPENGYM_API_IMAGE": "ghcr.io/example/opengym-api",
            "OPENGYM_WEB_IMAGE": "ghcr.io/example/opengym-web",
            "OPENGYM_API_DIGEST": "sha256:" + "b" * 64,
            "OPENGYM_WEB_DIGEST": "sha256:" + "c" * 64,
        })
        self.old = False
        self.unhealthy = False
        self.health_calls = 0

    def get(self, url, key=None):
        if url == self.config["OPENGYM_HEALTH_URL"]:
            self.health_calls += 1
            self.assertIsNone(key)
            return {"ok": True}
        self.assertEqual(key, "example-test-key")
        if "/stacks/" in url:
            return {"Name": "example-stack", "EndpointId": 2,
                    "Env": [{"name": "OPENGYM_TAG", "value": self.config["OPENGYM_TAG"]}]}
        if "/containers/json?" in url:
            return [{"Id": service, "State": "running", "Image": self.config["OPENGYM_" + service.upper() + "_IMAGE"] + ":" + self.config["OPENGYM_TAG"],
                     "Labels": {"com.docker.compose.service": service}} for service in ("api", "web")]
        if "/containers/" in url:
            service = url.split("/containers/")[1].split("/")[0]
            return {"Image": service, "State": {"Health": {"Status": "unhealthy" if self.unhealthy else "healthy"}}}
        if "/images/" in url:
            service = url.split("/images/")[1].split("/")[0]
            return {"RepoDigests": [self.config["OPENGYM_" + service.upper() + "_IMAGE"] + "@" +
                    ("sha256:" + "d" * 64 if self.old else self.config["OPENGYM_" + service.upper() + "_DIGEST"])]}
        self.fail("Unexpected API path")

    def test_exact_images_and_health_pass(self):
        self.assertTrue(deployment.deployed(self.config, self.get))
        self.assertEqual(self.health_calls, 1)

    def test_healthy_old_digest_does_not_pass(self):
        self.old = True
        self.assertFalse(deployment.deployed(self.config, self.get))
        self.assertEqual(self.health_calls, 0)

    def test_unhealthy_container_does_not_pass(self):
        self.unhealthy = True
        self.assertFalse(deployment.deployed(self.config, self.get))

    def trigger_call(self, url, key=None, **kwargs):
        self.assertEqual(key, "example-test-key")
        if kwargs.get("method") == "PUT":
            self.update_calls.append((url, kwargs))
            return None
        if url.endswith("/file"):
            return {"StackFileContent": self.stack_file}
        return self.stack

    def prepare_stack(self):
        self.stack_file = "services:\n  api:\n    image: example:${OPENGYM_TAG}\n"
        self.stack = {"Type": 2, "EndpointId": 2, "GitConfig": None, "Env": [
            {"name": "PRIVATE_SETTING", "value": "keep-this-value"},
            {"name": "OPENGYM_TAG", "value": "old"}]}
        self.update_calls = []

    def test_trigger_preserves_live_file_and_private_environment(self):
        self.prepare_stack()
        deployment.trigger(self.config, self.trigger_call)
        self.assertEqual(len(self.update_calls), 1)
        url, kwargs = self.update_calls[0]
        self.assertTrue(url.endswith("/stacks/1?endpointId=2"))
        self.assertEqual(kwargs["payload"], {
            "StackFileContent": self.stack_file,
            "Env": [{"name": "PRIVATE_SETTING", "value": "keep-this-value"},
                    {"name": "OPENGYM_TAG", "value": self.config["OPENGYM_TAG"]}],
            "Prune": False, "PullImage": True})
        self.assertEqual(self.stack["Env"][1]["value"], "old")
        self.assertEqual(kwargs["timeout"], 120)

    def test_trigger_adds_missing_tag_without_replacing_other_settings(self):
        self.prepare_stack()
        self.stack["Env"].pop()
        deployment.trigger(self.config, self.trigger_call)
        self.assertEqual(self.update_calls[0][1]["payload"]["Env"], [
            {"name": "PRIVATE_SETTING", "value": "keep-this-value"},
            {"name": "OPENGYM_TAG", "value": self.config["OPENGYM_TAG"]}])

    def test_invalid_stack_configuration_never_updates(self):
        cases = [{"Type": 1}, {"GitConfig": {"URL": "example"}},
                 {"EndpointId": 0}, {"EndpointId": True},
                 {"Env": None}, {"Env": [{"name": "PRIVATE_SETTING"}]}]
        for changes in cases:
            with self.subTest(changes=changes):
                self.prepare_stack()
                self.stack.update(changes)
                with self.assertRaises(deployment.DeploymentError):
                    deployment.trigger(self.config, self.trigger_call)
                self.assertEqual(self.update_calls, [])
        self.prepare_stack()
        self.stack_file = ""
        with self.assertRaises(deployment.DeploymentError):
            deployment.trigger(self.config, self.trigger_call)
        self.assertEqual(self.update_calls, [])

    def test_successful_write_does_not_require_json_response(self):
        response = mock.MagicMock()
        response.__enter__.return_value = response
        with mock.patch.object(deployment.OPENER, "open", return_value=response) as opened:
            deployment.request("https://control.example.test/api/stacks/1", "example-test-key",
                               method="PUT", payload={"PullImage": True}, timeout=120)
        req = opened.call_args.args[0]
        self.assertEqual(req.get_method(), "PUT")
        self.assertEqual(req.get_header("Content-type"), "application/json")
        self.assertEqual(req.get_header("X-api-key"), "example-test-key")
        response.read.assert_not_called()

    def test_malformed_read_response_never_updates(self):
        response = mock.MagicMock()
        response.__enter__.return_value = response
        response.read.return_value = b"not-json"
        with mock.patch.object(deployment.OPENER, "open", return_value=response) as opened:
            with self.assertRaises(ValueError):
                deployment.trigger(self.config)
        self.assertEqual(opened.call_count, 1)
        self.assertEqual(opened.call_args.args[0].get_method(), "GET")

    def test_timeout_after_update_checks_deployment_without_retrying_trigger(self):
        with mock.patch.dict(deployment.os.environ, self.config, clear=True), \
                mock.patch.object(deployment, "trigger", side_effect=TimeoutError) as trigger, \
                mock.patch.object(deployment, "deployed", return_value=True) as deployed, \
                mock.patch("builtins.print"):
            deployment.main()
        trigger.assert_called_once()
        deployed.assert_called_once()

    def test_http_failure_reports_status_without_private_details(self):
        error = urllib.error.HTTPError("https://private.example.test", 403,
                                       "private response", {}, None)
        with mock.patch.dict(deployment.os.environ, self.config, clear=True), \
                mock.patch.object(deployment, "trigger", side_effect=error), \
                mock.patch.object(deployment, "deployed") as deployed:
            with self.assertRaises(deployment.DeploymentError) as result:
                deployment.main()
        self.assertIn("HTTP 403", str(result.exception))
        self.assertNotIn("private.example", str(result.exception))
        self.assertNotIn("private response", str(result.exception))
        deployed.assert_not_called()

    def test_unsafe_url_rejected_without_disclosing_it(self):
        self.config["PORTAINER_URL"] = "http://private-host.example.test"
        with self.assertRaises(deployment.DeploymentError) as error:
            deployment.configuration(self.config)
        self.assertNotIn("private-host", str(error.exception))


if __name__ == "__main__":
    unittest.main()
