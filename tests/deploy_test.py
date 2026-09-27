"""Deployment transaction tests: no Docker daemon or network access needed."""
import contextlib
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("dockge_deploy", Path(__file__).parents[1] / "extra/deploy/deploy.py")
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)
SHA = "a" * 40
INFO = {"Image": "sha256:old", "Config": {"Image": "old:1", "Labels": {}}, "State": {"Running": True}}


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.app = deploy.Deployment(self.root)
        (self.root / "data").mkdir()
        (self.root / "data/value").write_text("old data")
        (self.root / "compose.yaml").write_text("services:\n  dockge:\n    image: old:1\n")
        self.source = self.root / "source"
        (self.source / "extra/deploy").mkdir(parents=True)
        for name in ("deploy.py", "update.sh", "rollback.sh"):
            (self.source / "extra/deploy" / name).write_text("new controller")

    def tearDown(self):
        self.temp.cleanup()

    def update_patches(self):
        return (patch.object(self.app, "preflight", return_value=INFO),
                patch.object(deploy, "resolve_revision", return_value=SHA),
                patch.object(self.app, "source", return_value=self.source),
                patch.object(self.app, "check_idle"), patch.object(deploy, "run"))

    def test_build_failure_does_not_stop_service(self):
        with self.update_patches()[0], self.update_patches()[1], self.update_patches()[2], self.update_patches()[3], self.update_patches()[4]:
            with patch.object(self.app, "build", side_effect=RuntimeError("build failed")), patch.object(self.app, "compose") as compose:
                with self.assertRaisesRegex(RuntimeError, "build failed"):
                    self.app.update("main")
                compose.assert_not_called()
                self.assertEqual((self.root / "data/value").read_text(), "old data")

    def test_health_failure_restores_config_data_and_image(self):
        with self.update_patches()[0], self.update_patches()[1], self.update_patches()[2], self.update_patches()[3], self.update_patches()[4]:
            with patch.object(self.app, "build", return_value="new:1"), patch.object(self.app, "compose") as compose:
                def health(expect_api=True):
                    if expect_api:
                        (self.root / "data/value").write_text("migrated data")
                        raise RuntimeError("new image unhealthy")
                with patch.object(self.app, "healthy", side_effect=health):
                    with self.assertRaisesRegex(RuntimeError, "new image unhealthy"):
                        self.app.update("main")
                self.assertEqual((self.root / "data/value").read_text(), "old data")
                self.assertIn("old:1", (self.root / "compose.yaml").read_text())
                override = json.loads(self.app.override.read_text())
                self.assertIn(":rollback-", override["services"]["dockge"]["image"])
                self.assertEqual(override["services"]["dockge"]["pull_policy"], "never")
                self.assertTrue(list(self.app.backups.glob("*/superseded-data-*/value")))
                self.assertTrue(any(call.args[:1] == ("up",) for call in compose.call_args_list))

    def test_backup_failure_restarts_original_without_switching_image(self):
        with self.update_patches()[0], self.update_patches()[1], self.update_patches()[2], self.update_patches()[3], self.update_patches()[4]:
            with patch.object(self.app, "build", return_value="new:1"), patch.object(self.app, "backup_data", side_effect=OSError("disk full")), patch.object(self.app, "compose") as compose, patch.object(self.app, "healthy"):
                with self.assertRaisesRegex(OSError, "disk full"):
                    self.app.update("main")
                self.assertFalse(self.app.override.exists())
                self.assertEqual((self.root / "data/value").read_text(), "old data")
                self.assertTrue(any(call.args[:1] == ("up",) for call in compose.call_args_list))

    def test_success_preserves_main_config_and_installs_controller(self):
        with self.update_patches()[0], self.update_patches()[1], self.update_patches()[2], self.update_patches()[3], self.update_patches()[4]:
            with patch.object(self.app, "build", return_value="new:1"), patch.object(self.app, "compose"), patch.object(self.app, "healthy"):
                self.app.update("main")
                self.assertEqual(json.loads(self.app.manifest.read_text())["revision"], SHA)
                self.assertIn("old:1", (self.root / "compose.yaml").read_text())
                self.assertEqual((self.root / "update.sh").read_text(), "new controller")
                self.assertTrue(list(self.app.backups.glob("*/.complete")))

    def test_same_revision_does_not_restart(self):
        info = {**INFO, "Config": {"Labels": {"org.opencontainers.image.revision": SHA}}}
        with patch.object(self.app, "preflight", return_value=info), patch.object(deploy, "resolve_revision", return_value=SHA), patch.object(self.app, "healthy"), patch.object(self.app, "compose") as compose, patch.object(self.app, "build") as build:
            self.app.update("main")
            compose.assert_not_called()
            build.assert_not_called()

    def test_active_tasks_block_upgrade(self):
        with contextlib.closing(sqlite3.connect(self.root / "data/dockge.db")) as db:
            db.execute("CREATE TABLE api_operation (state TEXT)")
            db.execute("INSERT INTO api_operation VALUES ('running')")
            db.commit()
        with self.assertRaisesRegex(RuntimeError, "operations are running"):
            self.app.check_idle()

    def test_ref_validation_and_incomplete_backup(self):
        for value in ("../main", "main;exit", "abc", "master"):
            with self.assertRaises(ValueError):
                deploy.resolve_revision(value)
        with patch.object(deploy, "fetch_json", return_value={"sha": SHA}):
            self.assertEqual(deploy.resolve_revision("main"), SHA)
        with self.assertRaisesRegex(RuntimeError, "incomplete"):
            self.app.restore(self.root / "missing")


if __name__ == "__main__":
    unittest.main()
