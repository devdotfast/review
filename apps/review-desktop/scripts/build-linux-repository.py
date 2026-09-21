#!/usr/bin/env python3
"""Build a sealed signed RPM/DNF publication without network writes."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile


def run(*args, **kwargs):
    return subprocess.run(args, check=True, stdout=subprocess.PIPE, **kwargs).stdout


def digest(file):
    result = hashlib.sha256()
    with open(file, "rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def sign(file, fingerprint):
    output = file.with_name(file.name + ".asc")
    args = ["gpg", "--batch", "--yes", "--local-user", fingerprint]
    passphrase = os.environ.get("REVIEW_SIGNING_PASSPHRASE_FILE")
    if passphrase:
        args += ["--pinentry-mode", "loopback", "--passphrase-file", passphrase]
    run(*args, "--armor", "--output", str(output), "--detach-sign", str(file))
    run("gpg", "--batch", "--verify", str(output), str(file))


def sign_rpm(file, fingerprint, public_key):
    # Use GnuPG on both RPM 4 (CI builder) and RPM 6 (Fedora). The key stays in
    # GNUPGHOME; no private credentials enter the native-package build container.
    args = ["rpmsign", "--define", "_openpgp_sign gpg",
            "--define", f"_openpgp_sign_id {fingerprint}",
            "--define", f"_gpg_name {fingerprint}",
            "--define", f"__gpg {shutil.which('gpg')}"]
    passphrase = os.environ.get("REVIEW_SIGNING_PASSPHRASE_FILE")
    if passphrase:
        if any(character in passphrase for character in "\n\r\"%"):
            raise ValueError("Invalid signing passphrase file path")
        args += ["--define", f'_gpg_sign_cmd_extra_args --pinentry-mode loopback --passphrase-file "{passphrase}"']
    run(*args, "--addsign", str(file))
    # Verify with an isolated RPM key database, without changing the host's trust.
    with tempfile.TemporaryDirectory(prefix="review-rpm-keys-") as database:
        run("rpmkeys", "--dbpath", database, "--import", str(public_key))
        checked = run("rpmkeys", "--dbpath", database, "--checksig", str(file), env={**os.environ, "LC_ALL": "C"}).decode()
        if "signatures OK" not in checked:
            raise ValueError("RPM has no valid package signature")


def build(packages, output, version, revision, commit, fingerprint):
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version):
        raise ValueError("Expected stable X.Y.Z version")
    if not re.fullmatch(r"[1-9][0-9]*", revision) or not re.fullmatch(r"[a-f0-9]{40}", commit):
        raise ValueError("Invalid package revision or source commit")
    if not re.fullmatch(r"[A-F0-9]{40}", fingerprint):
        raise ValueError("Expected the full signing key fingerprint")
    if output.exists():
        raise ValueError("Output already exists; use a fresh directory to avoid mixing publications")
    name = f"dev-fast-review-{version}-{revision}.x86_64.rpm"
    source = packages / name
    metadata = run("rpm", "-qp", "--queryformat", "%{NAME}\n%{VERSION}\n%{RELEASE}\n%{ARCH}\n", str(source)).decode().splitlines()
    if metadata != ["dev-fast-review", version, revision, "x86_64"]:
        raise ValueError("RPM metadata does not match the release")
    generation = f"{version}-{revision}-{commit}"
    repos = output / "repos"
    snapshot = repos / "snapshots" / generation / "rpm/repodata"
    snapshot.mkdir(parents=True)
    keys = repos / "keys"
    keys.mkdir()
    public_key = keys / f"{fingerprint}.asc"
    public_key.write_bytes(run("gpg", "--batch", "--armor", "--export", fingerprint))
    if not public_key.stat().st_size:
        raise ValueError("Signing public key was not exported")
    rpm = repos / "rpm/x86_64"
    pool = rpm / "Packages"
    pool.mkdir(parents=True)
    package = pool / name
    shutil.copyfile(source, package)
    sign_rpm(package, fingerprint, public_key)
    # Package signatures change bytes. Generate checksums only after signing.
    run("createrepo_c", "--no-database", "--unique-md-filenames", "--checksum", "sha256",
        "--revision", f"{version}-{revision}", str(rpm))
    for file in (rpm / "repodata").iterdir():
        if file.name == "repomd.xml":
            continue
        match = re.fullmatch(r"([a-f0-9]{64})-(primary|filelists|other)\.xml\.gz", file.name)
        if not match or digest(file) != match.group(1):
            raise ValueError(f"Unexpected or non-content-addressed RPM metadata: {file.name}")
    (rpm / "repodata/repomd.xml").rename(snapshot / "repomd.xml")
    sign(snapshot / "repomd.xml", fingerprint)
    pointer = {
        "schemaVersion": 1, "format": "rpm", "generation": generation, "version": version,
        "commit": commit, "keyFingerprint": fingerprint,
    }
    (repos / "current.json").write_text(json.dumps(pointer) + "\n")
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
