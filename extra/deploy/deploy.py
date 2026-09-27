#!/usr/bin/env python3
"""Build pinned main revisions and upgrade only the existing Dockge service."""
import argparse
import contextlib
import datetime
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import time
import urllib.request

REPOSITORY = "Yxa2111/dockge"
PROJECT = "dockge"
SERVICE = "dockge"
IMAGE = "yxa2111/dockge"
CONFIG_FILES = ("compose.yaml", "compose.override.yaml", ".env", ".dockge-deployment.json")


def run(*args, capture=False, cwd=None):
    result = subprocess.run(args, cwd=cwd, check=True, text=True,
                            stdout=subprocess.PIPE if capture else None)
    return result.stdout.strip() if capture else None


def atomic_write(filename, text):
    temp = filename.with_name(filename.name + ".tmp")
    with temp.open("w", encoding="utf-8") as stream:
        os.chmod(temp, 0o600)
        stream.write(text)
        stream.flush()
        os.fsync(stream.fileno())
    temp.replace(filename)


def fetch_json(url):
    request = urllib.request.Request(url, headers={"User-Agent": "dockge-fork-updater"})
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.load(response)


def resolve_revision(ref):
    if ref != "main" and not re.fullmatch(r"[0-9a-f]{40}", ref):
        raise ValueError("Use main or a full 40-character commit SHA.")
    data = fetch_json(f"https://api.github.com/repos/{REPOSITORY}/commits/{ref}")
    revision = data.get("sha", "")
    if not re.fullmatch(r"[0-9a-f]{40}", revision) or (ref != "main" and revision != ref):
        raise ValueError("GitHub returned an unexpected revision.")
    return revision


class Deployment:
    def __init__(self, directory):
        self.directory = Path(directory).resolve()
        self.backups = self.directory / "backups"
        self.releases = self.directory / "releases"
        self.override = self.directory / "compose.override.yaml"
        self.manifest = self.directory / ".dockge-deployment.json"

    def compose(self, *args, capture=False):
        command = ["docker", "compose", "--project-directory", str(self.directory),
                   "-p", PROJECT, "-f", str(self.directory / "compose.yaml")]
        if self.override.exists():
            command += ["-f", str(self.override)]
        return run(*command, *args, capture=capture, cwd=self.directory)

    def container(self):
        result = self.compose("ps", "-aq", SERVICE, capture=True)
        if not result or "\n" in result:
            raise RuntimeError("Expected exactly one existing Dockge container.")
        return result

    def inspect(self):
        return json.loads(run("docker", "inspect", self.container(), capture=True))[0]

    def preflight(self):
        if os.geteuid() != 0:
            raise RuntimeError("Run with sudo to preserve data ownership and create backups.")
        if not (self.directory / "compose.yaml").is_file():
            raise RuntimeError("Expected an existing compose.yaml deployment.")
        config = json.loads(self.compose("config", "--format", "json", capture=True))
        services = config["services"]
        if set(services) != {SERVICE}:
            raise RuntimeError("This updater requires a Compose project containing only Dockge.")
        volumes = {v["target"]: v for v in services[SERVICE].get("volumes", [])}
        data = volumes.get("/app/data", {})
        if data.get("type") != "bind" or Path(data.get("source", "")).resolve() != self.directory / "data":
            raise RuntimeError("Expected ./data:/app/data; refusing to back up a different path.")
        if self.override.exists() and not self.manifest.exists():
            raise RuntimeError("An unmanaged compose.override.yaml exists; review it before installing this updater.")
        info = self.inspect()
        if not info["State"]["Running"]:
            raise RuntimeError("Current Dockge must be running before an update.")
        self.check_idle()
        return info

    def check_idle(self):
        filename = self.directory / "data" / "dockge.db"
        if not filename.is_file():
            raise RuntimeError("Dockge database not found.")
        with contextlib.closing(sqlite3.connect(filename.as_uri() + "?mode=ro", uri=True)) as db:
            exists = db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='api_operation'").fetchone()
            if exists and db.execute("SELECT count(*) FROM api_operation WHERE state='running'").fetchone()[0]:
                raise RuntimeError("API operations are running. Wait for them to complete before upgrading.")

    def source(self, revision):
        release = self.releases / revision
        source = release / f"dockge-{revision}"
        if (release / ".ready").exists():
            return source
        release.mkdir(parents=True, exist_ok=True)
        archive = release / "source.tar.gz"
        request = urllib.request.Request(f"https://codeload.github.com/{REPOSITORY}/tar.gz/{revision}",
                                         headers={"User-Agent": "dockge-fork-updater"})
        with urllib.request.urlopen(request, timeout=120) as response, archive.open("wb") as output:
            shutil.copyfileobj(response, output)
        with tarfile.open(archive) as tar:
            tar.extractall(release, filter="data")
        if not (source / "docker" / "Dockerfile.fork").is_file():
            raise RuntimeError("This revision does not contain the fork Dockerfile.")
        (release / ".ready").touch()
        return source

    def build(self, revision, source):
        image = f"{IMAGE}:git-{revision}"
        found = subprocess.run(["docker", "image", "inspect", image], capture_output=True, text=True)
        if found.returncode == 0:
            labels = json.loads(found.stdout)[0]["Config"].get("Labels", {})
            if labels.get("org.opencontainers.image.revision") != revision:
                raise RuntimeError("Existing image tag has the wrong revision label.")
            print(f"Using existing image {image}", flush=True)
        else:
            run("docker", "build", "--build-arg", f"VCS_REF={revision}",
                "-t", image, "-f", "docker/Dockerfile.fork", ".", cwd=source)
        return image

    def set_image(self, image):
        # JSON is valid YAML; keep the original Compose file and all mounts/ports.
        atomic_write(self.override, json.dumps({"services": {SERVICE: {"image": image, "pull_policy": "never"}}}, indent=2) + "\n")

    def start(self):
        self.compose("up", "-d", "--no-deps", "--no-build", "--pull", "never", SERVICE)

    def healthy(self, expect_api=True):
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline:
            info = self.inspect()
            state = info["State"]
            status = state.get("Health", {}).get("Status")
            if not state["Running"] or status == "unhealthy":
                raise RuntimeError(f"Dockge failed to start: {state['Status']}, health={status}")
            if status == "healthy":
                if expect_api:
                    code = "const r=await fetch('http://127.0.0.1:5001/api/v1/stacks');const b=await r.json();if(r.status!==401||b.error?.code!=='unauthorized')process.exit(1)"
                    run("docker", "exec", info["Id"], "node", "--input-type=module", "-e", code)
                return
            print(f"Waiting for Docker healthcheck ({status})…", flush=True)
            time.sleep(5)
        raise RuntimeError("Dockge healthcheck timed out.")

    def backup_config(self, backup, info):
        backup.mkdir(parents=True, mode=0o700)
        files = []
        for name in CONFIG_FILES:
            file = self.directory / name
            if file.exists():
                shutil.copy2(file, backup / name)
                files.append(name)
        rollback_image = f"{IMAGE}:rollback-{backup.name}"
        run("docker", "tag", info["Image"], rollback_image)
        metadata = {"created_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                    "image": rollback_image, "original_image": info["Config"]["Image"],
                    "image_id": info["Image"], "files": files,
                    "had_api": bool(info["Config"].get("Labels", {}).get("org.opencontainers.image.revision"))}
        atomic_write(backup / "metadata.json", json.dumps(metadata, indent=2) + "\n")

    def backup_data(self, backup):
        with tarfile.open(backup / "data.tar.gz", "w:gz") as tar:
            tar.add(self.directory / "data", arcname="data")
        (backup / ".complete").touch()

    def restore(self, backup):
        if not (backup / ".complete").exists():
            raise RuntimeError("Backup is incomplete; refusing to restore it.")
        metadata = json.loads((backup / "metadata.json").read_text())
        self.compose("stop", SERVICE)
        data = self.directory / "data"
        if data.exists():
            saved = backup / ("superseded-data-" + str(time.time_ns()))
            shutil.move(data, saved)
        with tarfile.open(backup / "data.tar.gz") as tar:
            tar.extractall(self.directory, filter="tar")
        for name in CONFIG_FILES:
            target = self.directory / name
            if name in metadata["files"]:
                shutil.copy2(backup / name, target)
            elif target.exists():
                target.unlink()
        self.set_image(metadata["image"])
        self.start()
        self.healthy(expect_api=metadata["had_api"])
        atomic_write(self.manifest, json.dumps({"image": metadata["image"], "restored_from": backup.name}, indent=2) + "\n")
        print(f"Restored image and data from {backup}", flush=True)

    def update(self, ref):
        info = self.preflight()
        revision = resolve_revision(ref)
        labels = info["Config"].get("Labels", {})
        if labels.get("org.opencontainers.image.revision") == revision:
            self.healthy()
            print(f"Already running {revision}; no restart required.", flush=True)
            return
        print(f"Building main revision {revision} before stopping Dockge.", flush=True)
        source = self.source(revision)
        image = self.build(revision, source)
        # Build may take minutes: recheck task state immediately before stopping.
        self.check_idle()
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        backup = self.backups / (stamp + "-" + revision[:12])
        self.backup_config(backup, info)
        print(f"Backing up Dockge data to {backup}", flush=True)
        try:
            self.compose("stop", SERVICE)
            self.check_idle()
            self.backup_data(backup)
            self.set_image(image)
            self.start()
            self.healthy()
            manifest = {"revision": revision, "image": image, "backup": backup.name, "repository": REPOSITORY}
            atomic_write(self.manifest, json.dumps(manifest, indent=2) + "\n")
            for name in ("deploy.py", "update.sh", "rollback.sh"):
                target = self.directory / name
                atomic_write(target, (source / "extra" / "deploy" / name).read_text())
                target.chmod(0o755)
            print(f"Deployed {revision}\nImage: {image}\nRollback: sudo {self.directory}/rollback.sh {backup.name}", flush=True)
        except BaseException:
            print("Upgrade failed; recovering the previous deployment.", file=sys.stderr, flush=True)
            with contextlib.suppress(Exception):
                self.compose("logs", "--tail", "60", SERVICE)
            if (backup / ".complete").exists():
                self.restore(backup)
            else:
                self.start()
                self.healthy(expect_api=bool(labels.get("org.opencontainers.image.revision")))
            raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", default="/opt/dockge")
    commands = parser.add_subparsers(dest="command", required=True)
    update = commands.add_parser("update")
    update.add_argument("revision", nargs="?", default="main")
    rollback = commands.add_parser("rollback")
    rollback.add_argument("backup", help="Backup directory name printed by update.sh")
    args = parser.parse_args()
    deployment = Deployment(args.directory)
    os.umask(0o077)
    with (deployment.directory / ".upgrade.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.command == "update":
            deployment.update(args.revision)
        else:
            if os.geteuid() != 0 or not re.fullmatch(r"[A-Za-z0-9_-]+", args.backup):
                raise RuntimeError("Use sudo and a backup directory name, not a path.")
            deployment.restore(deployment.backups / args.backup)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Deployment error: {error}", file=sys.stderr)
        sys.exit(1)
