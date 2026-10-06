import copy
import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "polling_layout", Path(__file__).parents[2] / "deploy/polling-layout.py"
)
layout = importlib.util.module_from_spec(spec)
spec.loader.exec_module(layout)


class PollingLayoutTest(unittest.TestCase):
    def config(self):
        return {
            "name": "trisoft-kan",
            "services": {
                "postgres": {"image": "postgres:15-alpine", "volumes": ["postgres:/data"]},
                "migrate": {"image": "trisoft-kan-migrate:old", "environment": {"POSTGRES_URL": "${POSTGRES_URL}"}},
                "web": {
                    "image": "trisoft-kan:old",
                    "ports": [{"host_ip": "127.0.0.1", "published": "3100", "target": 3000}],
                    "environment": {"TASK_CONTROL_SERVICE_TOKEN": "${TASK_CONTROL_SERVICE_TOKEN:-}",
                                    "TASK_CONTROL_ALLOWED_IPS": "${TASK_CONTROL_ALLOWED_IPS:-127.0.0.2}",
                                    "TASK_CONTROL_GATEWAY_URL": "legacy", "TASK_CONTROL_GATEWAY_TOKEN": "legacy"},
                },
            },
            "volumes": {"postgres": {"name": "trisoft-kan_postgres"}},
        }

    def test_only_expected_changes(self):
        before = self.config()
        after = layout.prepare(copy.deepcopy(before), "polling-test")
        expected = copy.deepcopy(before)
        expected["services"]["web"]["image"] = "trisoft-kan:polling-test"
        expected["services"]["migrate"]["image"] = "trisoft-kan-migrate:polling-test"
        del expected["services"]["web"]["environment"]["TASK_CONTROL_GATEWAY_URL"]
        del expected["services"]["web"]["environment"]["TASK_CONTROL_GATEWAY_TOKEN"]
        self.assertEqual(expected, after)

    def test_reject_other_project(self):
        config = self.config()
        config["name"] = "redmine-legacy"
        with self.assertRaises(ValueError):
            layout.prepare(config, "test")

    def test_reject_extra_service(self):
        config = self.config()
        config["services"]["redmine"] = {}
        with self.assertRaises(ValueError):
            layout.prepare(config, "test")

    def test_reject_build(self):
        config = self.config()
        config["services"]["web"]["build"] = "."
        with self.assertRaises(ValueError):
            layout.prepare(config, "test")

    def integration_config(self):
        config = self.config()
        config["services"]["web"]["environment"] = {
            "POSTGRES_URL": "unchanged-db",
            "BETTER_AUTH_SECRET": "unchanged-auth",
            "TASK_CONTROL_SERVICE_TOKEN": "test-new-token-" + "x" * 32,
            "TASK_CONTROL_ALLOWED_IPS": "46.203.233.110",
            "TASK_CONTROL_TRUSTED_PROXIES": "172.19.0.1",
            "TASK_CONTROL_GATEWAY_TOKEN": "new-obsolete-token",
        }
        runtime = ["POSTGRES_URL=unchanged-db", "BETTER_AUTH_SECRET=unchanged-auth",
                   "TASK_CONTROL_SERVICE_TOKEN=old-service-token", "TASK_CONTROL_ALLOWED_IPS=127.0.0.2",
                   "TASK_CONTROL_TRUSTED_PROXIES=", "TASK_CONTROL_GATEWAY_TOKEN=old-obsolete-token"]
        return config, runtime

    def test_saved_integration_requires_explicit_approval(self):
        config, runtime = self.integration_config()
        with self.assertRaisesRegex(ValueError, "Unapproved environment drift"):
            layout.authorize(config, runtime)

    def test_approved_settings_and_rollback_preserve_old_runtime(self):
        config, runtime = self.integration_config()
        rollback = layout.authorize(config, runtime, True, "172.19.0.1")
        self.assertEqual(dict(s.split("=", 1) for s in runtime), rollback["services"]["web"]["environment"])
        self.assertEqual(config["services"]["postgres"], rollback["services"]["postgres"])

    def test_db_and_auth_drift_never_approved(self):
        for key in ("POSTGRES_URL", "BETTER_AUTH_SECRET"):
            config, runtime = self.integration_config()
            config["services"]["web"]["environment"][key] = "DO_NOT_PRINT_THIS_VALUE"
            with self.assertRaises(ValueError) as error:
                layout.authorize(config, runtime, True, "172.19.0.1")
            self.assertIn(key, str(error.exception))
            self.assertNotIn("DO_NOT_PRINT_THIS_VALUE", str(error.exception))

    def test_reject_broad_or_wrong_whitelist_and_proxy(self):
        for key, value in (("TASK_CONTROL_ALLOWED_IPS", "0.0.0.0/0"),
                           ("TASK_CONTROL_ALLOWED_IPS", "46.203.233.110,135.106.166.101"),
                           ("TASK_CONTROL_TRUSTED_PROXIES", "172.19.0.0/16"),
                           ("TASK_CONTROL_TRUSTED_PROXIES", "172.20.0.1")):
            config, runtime = self.integration_config()
            config["services"]["web"]["environment"][key] = value
            with self.assertRaises(ValueError):
                layout.authorize(config, runtime, True, "172.19.0.1")

    def test_reject_short_or_whitespace_service_token(self):
        for value in ("short", "x" * 40 + "\n", "x" * 40 + " "):
            config, runtime = self.integration_config()
            config["services"]["web"]["environment"]["TASK_CONTROL_SERVICE_TOKEN"] = value
            with self.assertRaises(ValueError):
                layout.authorize(config, runtime, True, "172.19.0.1")

    def test_single_host_cidr_allowed(self):
        config, runtime = self.integration_config()
        config["services"]["web"]["environment"]["TASK_CONTROL_ALLOWED_IPS"] = "46.203.233.110/32"
        config["services"]["web"]["environment"]["TASK_CONTROL_TRUSTED_PROXIES"] = "172.19.0.1/32"
        layout.authorize(config, runtime, True, "172.19.0.1")

    def test_obsolete_gateway_drift_does_not_require_activation(self):
        config = self.config()
        config["services"]["web"]["environment"] = {"TASK_CONTROL_GATEWAY_TOKEN": "unused"}
        layout.authorize(config, ["TASK_CONTROL_GATEWAY_TOKEN=old"])

    def test_absent_old_variable_is_removed_from_rollback(self):
        config = self.config()
        config["services"]["web"]["environment"] = {"TASK_CONTROL_GATEWAY_TOKEN": "unused"}
        rollback = layout.authorize(config, [])
        self.assertEqual({}, rollback["services"]["web"]["environment"])


if __name__ == "__main__":
    unittest.main()
