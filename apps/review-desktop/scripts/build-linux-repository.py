#!/usr/bin/env python3
"""Build a complete signed, immutable APT/pacman publication (no network writes)."""

import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
from datetime import datetime, timezone
from email.utils import format_datetime

ARCH_IMAGE = "archlinux:base-devel@sha256:61f7de2dd88cc4ba1fe36c24cfe1a503c3936984492d6405eeab013ce6ac68c5"


def run(*args, **kwargs):
    return subprocess.run(args, check=True, stdout=subprocess.PIPE, **kwargs).stdout


def digest(file, algorithm="sha256"):
    result = hashlib.new(algorithm)
    with open(file, "rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def sign(file, fingerprint, *, clear=False):
    output = file.parent / ("InRelease" if clear else file.name + ".sig")
    args = ["gpg", "--batch", "--yes", "--local-user", fingerprint]
    passphrase = os.environ.get("REVIEW_SIGNING_PASSPHRASE_FILE")
    if passphrase:
        args += ["--pinentry-mode", "loopback", "--passphrase-file", passphrase]
    args += ["--output", str(output), "--clearsign" if clear else "--detach-sign", str(file)]
    run(*args)
    if clear:
        run("gpg", "--batch", "--verify", str(output))
    else:
        run("gpg", "--batch", "--verify", str(output), str(file))
    return output


def build(packages, output, version, revision, commit, fingerprint):
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version):
        raise ValueError("Expected stable X.Y.Z version")
    if not re.fullmatch(r"[1-9][0-9]*", revision) or not re.fullmatch(r"[a-f0-9]{40}", commit):
        raise ValueError("Invalid package revision or source commit")
    if not re.fullmatch(r"[A-F0-9]{40}", fingerprint):
        raise ValueError("Expected the full signing key fingerprint")
    if output.exists():
        raise ValueError("Output already exists; use a fresh directory to avoid mixing publications")
    generation = f"{version}-{revision}-{commit}"
    repos = output / "repos"
    snapshots = repos / "snapshots" / generation
    apt = snapshots / "apt"
    arch_snapshot = snapshots / "arch"
    apt.mkdir(parents=True)
    arch_snapshot.mkdir()
    keys = repos / "keys"
    keys.mkdir()
    (keys / f"{fingerprint}.asc").write_bytes(run("gpg", "--batch", "--armor", "--export", fingerprint))
    if not (keys / f"{fingerprint}.asc").stat().st_size:
        raise ValueError("Signing public key was not exported")

    deb_name = f"dev-fast-review_{version}-{revision}_amd64.deb"
    deb_source = packages / deb_name
    fields = run("dpkg-deb", "--field", str(deb_source)).decode()
    for line in ["Package: dev-fast-review", f"Version: {version}-{revision}", "Architecture: amd64"]:
        if line not in fields.splitlines():
            raise ValueError(f"DEB metadata mismatch: {line}")
    pool = repos / "apt/pool/main/d/dev-fast-review"
    pool.mkdir(parents=True)
    deb = pool / deb_name
    shutil.copyfile(deb_source, deb)
    package_index = fields.rstrip() + f"\nFilename: pool/main/d/dev-fast-review/{deb_name}\nSize: {deb.stat().st_size}\nSHA256: {digest(deb)}\nSHA512: {digest(deb, 'sha512')}\n\n"
    indexes = apt / "main/binary-amd64"
    indexes.mkdir(parents=True)
    (indexes / "Packages").write_text(package_index)
    (indexes / "Packages.gz").write_bytes(gzip.compress(package_index.encode(), mtime=0))
    index_files = [indexes / "Packages", indexes / "Packages.gz"]
    for algorithm in ["sha256", "sha512"]:
        by_hash = repos / "apt/dists/stable/main/binary-amd64/by-hash" / algorithm.upper()
        by_hash.mkdir(parents=True)
        for file in index_files:
            shutil.copyfile(file, by_hash / digest(file, algorithm))
    release = "\n".join([
        "Origin: dev.fast", "Label: Review", "Suite: stable", "Codename: stable",
        "Architectures: amd64", "Components: main", "Acquire-By-Hash: yes",
        f"Date: {format_datetime(datetime.now(timezone.utc), usegmt=True)}",
        "Description: Review Desktop stable releases", "SHA256:",
        *[f" {digest(file)} {file.stat().st_size} {file.relative_to(apt)}" for file in index_files],
        "SHA512:",
        *[f" {digest(file, 'sha512')} {file.stat().st_size} {file.relative_to(apt)}" for file in index_files], "",
    ])
    (apt / "Release").write_text(release)
    sign(apt / "Release", fingerprint, clear=True)
    sign(apt / "Release", fingerprint).rename(apt / "Release.gpg")

    arch_name = f"dev-fast-review-{version}-{revision}-x86_64.pkg.tar.zst"
    arch_source = packages / arch_name
    pkginfo = run("tar", "--zstd", "-xOf", str(arch_source), ".PKGINFO").decode()
    for line in ["pkgname = dev-fast-review", f"pkgver = {version}-{revision}", "arch = x86_64"]:
        if line not in pkginfo.splitlines():
            raise ValueError(f"Arch metadata mismatch: {line}")
    arch = repos / "arch/x86_64"
    arch.mkdir(parents=True)
    package = arch / arch_name
    shutil.copyfile(arch_source, package)
    sign(package, fingerprint)
    # Only repo-add runs in Arch. Signing keys never enter the container.
    with tempfile.TemporaryDirectory(prefix="review-repo-add-") as directory:
        staging = Path(directory)
        shutil.copyfile(package, staging / arch_name)
        shutil.copyfile(arch / (arch_name + ".sig"), staging / (arch_name + ".sig"))
        run("docker", "run", "--rm", "--platform", "linux/amd64", "--network", "none",
            "-v", f"{staging}:/repo", "-w", "/repo", ARCH_IMAGE,
            "repo-add", "--include-sigs", "dev-fast-review.db.tar.gz", arch_name)
        for name in ["dev-fast-review.db", "dev-fast-review.files"]:
            file = arch_snapshot / name
            shutil.copyfile(staging / name, file)
            sign(file, fingerprint)
    pointer = {
        "schemaVersion": 1, "generation": generation, "version": version,
        "commit": commit, "keyFingerprint": fingerprint,
    }
    (repos / "current.json").write_text(json.dumps(pointer) + "\n")
    # Publication uses this digest list to reject changes to immutable objects.
    files = {str(file.relative_to(output)): digest(file) for file in sorted(repos.rglob("*")) if file.is_file()}
    (output / "sha256.json").write_text(json.dumps(files, indent=2) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--packages", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--revision", default="1")
    parser.add_argument("--commit", required=True)
    parser.add_argument("--fingerprint", required=True)
    args = parser.parse_args()
    build(args.packages.resolve(), args.output.resolve(), args.version, args.revision, args.commit, args.fingerprint)
