#!/usr/bin/env python3
"""Upload a sealed Linux publication, then atomically promote its R2 pointer."""

import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile
import urllib.request


def aws(*args):
    result = subprocess.run(["aws", "s3api", *args], capture_output=True, text=True)
    if result.returncode:
        # AWS's error message contains no request credentials. Do not print env.
        raise RuntimeError(result.stderr.strip())
    return json.loads(result.stdout) if result.stdout.strip() else {}


def checksum(file):
    result = hashlib.sha256()
    with open(file, "rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def fetch_json(url):
    request = urllib.request.Request(url, headers={"User-Agent": "Review-Linux-Repository-Publisher/1"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def publish(directory, bucket, base_url):
    if fetch_json(base_url + "/repos/health") != {"schemaVersion": 1, "format": "rpm"}:
        raise RuntimeError("Deploy the Linux repository Worker before publishing")
    files = json.loads((directory / "sha256.json").read_text())
    if "repos/current.json" not in files:
        raise ValueError("Publication has no active pointer")
    for name, sha in files.items():
        path = Path(name)
        if path.is_absolute() or ".." in path.parts or not name.startswith("repos/") or not re.fullmatch(r"[a-f0-9]{64}", sha):
            raise ValueError("Invalid publication digest entry")
        if checksum(directory / name) != sha:
            raise ValueError(f"Publication checksum mismatch: {name}")

    pointer = directory / "repos/current.json"
    current = json.loads(pointer.read_text())
    generation = re.fullmatch(r"([0-9]+)\.([0-9]+)\.([0-9]+)-([1-9][0-9]*)-([a-f0-9]{40})", current.get("generation", ""))
    if (not generation or current.get("schemaVersion") != 1 or current.get("format") != "rpm"
            or current.get("version") != ".".join(generation.groups()[:3])
            or current.get("commit") != generation.group(5)
            or not re.fullmatch(r"[A-F0-9]{40}", current.get("keyFingerprint", ""))):
        raise ValueError("Invalid repository pointer")
    # Compare-and-swap prevents concurrent or stale workflow reruns from moving
    # the repository backwards after a newer release has already won.
    with tempfile.TemporaryDirectory(prefix="review-current-") as temporary:
        previous_path = Path(temporary) / "current.json"
        try:
            previous_object = aws("get-object", "--bucket", bucket, "--key", "repos/current.json", str(previous_path))
        except RuntimeError as error:
            if "NoSuchKey" not in str(error) and "(404)" not in str(error):
                raise
            condition = ["--if-none-match", "*"]
        else:
            previous = json.loads(previous_path.read_text())
            previous_generation = re.fullmatch(r"([0-9]+)\.([0-9]+)\.([0-9]+)-([1-9][0-9]*)-([a-f0-9]{40})", previous.get("generation", ""))
            if not previous_generation:
                raise ValueError("Existing repository pointer is invalid")
            old_version = tuple(map(int, previous_generation.groups()[:4]))
            new_version = tuple(map(int, generation.groups()[:4]))
            if new_version < old_version or (new_version == old_version and current != previous):
                raise ValueError("Refusing to replace an equal or newer package release")
            condition = ["--if-match", previous_object["ETag"]]

    # A rerun can resume immutable uploads. Never replace an object with other
    # bytes under a versioned filename; rebuilds must increment package revision.
    for name, sha in files.items():
        if name == "repos/current.json":
            continue
        try:
            aws("put-object", "--bucket", bucket, "--key", name,
                "--body", str(directory / name), "--if-none-match", "*",
                "--metadata", f"sha256={sha}", "--cache-control", "public, max-age=31536000, immutable")
        except RuntimeError as error:
            if "PreconditionFailed" not in str(error) and "412" not in str(error):
                raise
            existing = aws("head-object", "--bucket", bucket, "--key", name)
            if existing.get("Metadata", {}).get("sha256") != sha:
                raise RuntimeError(f"Immutable object differs: {name}; increment the package revision") from error
    aws("put-object", "--bucket", bucket, "--key", "repos/current.json", "--body", str(pointer),
        "--content-type", "application/json", "--cache-control", "no-store", *condition)
    latest = fetch_json(base_url + "/api/update/linux-x64/stable/" + "0" * 40)
    if latest.get("version") != current["commit"] or latest.get("productVersion") != current["version"]:
        raise RuntimeError("Published Linux feed does not match the release")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--bucket", required=True)
    parser.add_argument("--base-url", default="https://install.dev.fast")
    args = parser.parse_args()
    publish(args.directory.resolve(), args.bucket, args.base_url.rstrip("/"))
