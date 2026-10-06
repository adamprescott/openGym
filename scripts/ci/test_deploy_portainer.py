"""Offline checks for deployment verification; no real infrastructure or tokens."""
import importlib.util
import pathlib
import unittest
import urllib.parse

spec = importlib.util.spec_from_file_location("deployment", pathlib.Path(__file__).with_name("deploy-portainer.py"))
deployment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deployment)


class DeploymentVerificationTest(unittest.TestCase):
    def setUp(self):
        self.config = deployment.configuration({
            "PORTAINER_WEBHOOK_URL": "https://control.example.test/api/stacks/webhooks/example?other=value",
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

    def test_tag_replaces_existing_query_value(self):
        self.config["PORTAINER_WEBHOOK_URL"] += "&OPENGYM_TAG=old"
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(deployment.webhook_url(self.config)).query)
        self.assertEqual(query["OPENGYM_TAG"], [self.config["OPENGYM_TAG"]])
        self.assertEqual(query["other"], ["value"])

    def test_unsafe_url_rejected_without_disclosing_it(self):
        self.config["PORTAINER_URL"] = "http://private-host.example.test"
        with self.assertRaises(deployment.DeploymentError) as error:
            deployment.configuration(self.config)
        self.assertNotIn("private-host", str(error.exception))


if __name__ == "__main__":
    unittest.main()
