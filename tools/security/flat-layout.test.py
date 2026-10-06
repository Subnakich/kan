import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("flat", Path(__file__).resolve().parents[2] / "deploy/flat-layout.py")
flat = importlib.util.module_from_spec(spec)
spec.loader.exec_module(flat)


class FlatLayoutTests(unittest.TestCase):
    def config(self):
        return {"name": "trisoft-kan", "services": {
            "web": {"image": "trisoft-kan:${KAN_RELEASE}", "build": {"context": ".."},
                    "environment": {"BETTER_AUTH_SECRET": "${BETTER_AUTH_SECRET:?Required}",
                                    "TASK_CONTROL_SERVICE_TOKEN": "${TASK_CONTROL_SERVICE_TOKEN:-}"}},
            "migrate": {"image": "trisoft-kan-migrate:${KAN_RELEASE}", "build": {"context": ".."}},
            "postgres": {"image": "postgres:15-alpine", "volumes": [{"source": "postgres"}]}},
            "volumes": {"postgres": {"name": "trisoft-kan_postgres"}}}

    def test_remove_only_build_sections(self):
        original = self.config()
        new = flat.prepare(original)
        self.assertNotIn("build", new["services"]["web"])
        self.assertNotIn("build", new["services"]["migrate"])
        self.assertIn("build", original["services"]["web"])
        self.assertEqual(flat.without_build(original), new)

    def test_keeps_variables_and_data_volume(self):
        new = flat.prepare(self.config())
        self.assertEqual(new["services"]["web"]["environment"]["BETTER_AUTH_SECRET"], "${BETTER_AUTH_SECRET:?Required}")
        self.assertEqual(new["volumes"]["postgres"]["name"], "trisoft-kan_postgres")

    def test_wrong_project_rejected(self):
        config = self.config()
        config["name"] = "redmine-legacy"
        with self.assertRaises(ValueError):
            flat.prepare(config)

    def test_unexpected_service_rejected(self):
        config = self.config()
        config["services"]["other"] = {}
        with self.assertRaises(ValueError):
            flat.prepare(config)

    def test_real_compose_interpolation_equivalence(self):
        source = Path(__file__).resolve().parents[2] / "deploy/compose.yml"
        env = dict(os.environ, KAN_RELEASE="test-no-launch", KAN_DB_PASSWORD="test-db-placeholder",
                   BETTER_AUTH_SECRET="test-auth-placeholder", NEXT_PUBLIC_DISABLE_SIGN_UP="true",
                   TASK_CONTROL_SERVICE_TOKEN="test-service-placeholder",
                   TASK_CONTROL_GATEWAY_TOKEN="test-gateway-placeholder")
        base = ["docker", "compose", "--project-name", "trisoft-kan", "--env-file", "/dev/null"]
        def render(path, *flags):
            return json.loads(subprocess.check_output(base + ["-f", str(path), "config", *flags, "--format", "json"], env=env))
        old = render(source)
        unexpanded = render(source, "--no-interpolate")
        with tempfile.TemporaryDirectory(prefix="kan-flat-test-") as folder:
            target = Path(folder) / "compose.yml"
            target.write_text(json.dumps(flat.prepare(unexpanded)))
            self.assertEqual(flat.without_build(old), render(target))

    def run_helper(self, action, documents):
        with tempfile.TemporaryDirectory(prefix="kan-flat-check-") as folder:
            paths = []
            for index, document in enumerate(documents):
                path = Path(folder) / f"{index}.json"
                path.write_text(json.dumps(document))
                paths.append(str(path))
            return subprocess.run([sys.executable, str(Path(flat.__file__)), action, *paths], capture_output=True, text=True)

    def test_runtime_matches(self):
        result = self.run_helper("runtime", [{"services": {"web": {"environment": {"TOKEN": "dummy-value"}}}},
                                             ["TOKEN=dummy-value", "PATH=/bin"]])
        self.assertEqual(result.returncode, 0)

    def test_runtime_mismatch_never_prints_secret(self):
        result = self.run_helper("runtime", [{"services": {"web": {"environment": {"TOKEN": "private-fixture-value"}}}},
                                             ["TOKEN=another-private-value"]])
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Saved web settings differ", result.stderr)
        self.assertNotIn("private-fixture-value", result.stdout + result.stderr)
        self.assertNotIn("another-private-value", result.stdout + result.stderr)

    def test_config_drift_is_rejected(self):
        old = self.config()
        changed = flat.prepare(old)
        changed["services"]["postgres"]["image"] = "postgres:16"
        result = self.run_helper("compare", [old, changed])
        self.assertNotEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main()
