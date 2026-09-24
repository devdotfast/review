"""Exercise publication failure boundaries without credentials or network access."""
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("publisher", Path(__file__).parents[1] / "publish-linux-repository.py")
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)


class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.calls = []
        self.requests = []
        self.previous = None
        self.failure = None
        self.pointer_failure = False
        self.channel = None
        self.seal("1.2.3", "a" * 40)

    def seal(self, version, commit, prefix="repos"):
        self.prefix = prefix
        self.pointer_key = f"{prefix}/current.json"
        self.package_key = f"{prefix}/package"
        self.current = dict(schemaVersion=1, format="rpm", generation=f"{version}-1-{commit}",
                            version=version, commit=commit, keyFingerprint="B" * 40)
        (self.root / prefix).mkdir(parents=True, exist_ok=True)
        (self.root / self.pointer_key).write_text(json.dumps(self.current))
        (self.root / self.package_key).write_bytes(b"sealed package")
        self.digests = {name: publisher.checksum(self.root / name) for name in [self.pointer_key, self.package_key]}
        (self.root / "sha256.json").write_text(json.dumps(self.digests))

    def request(self, url, **kwargs):
        url = url.full_url
        self.requests.append(url)
        body = {"schemaVersion": 1, "format": "rpm"} if url.endswith("/health") else {"version": self.current["commit"], "productVersion": self.current["version"]}
        return io.BytesIO(json.dumps(body).encode())

    def aws(self, *args):
        self.calls.append(args)
        if args[0] == "get-object":
            if self.previous is None:
                raise RuntimeError("NoSuchKey")
            Path(args[-1]).write_text(json.dumps(self.previous))
            return {"ETag": '"previous-etag"'}
        if args[0] == "put-object" and args[args.index("--key") + 1] == self.package_key and self.failure:
            raise RuntimeError(self.failure)
        if args[0] == "put-object" and args[args.index("--key") + 1] == self.pointer_key and self.pointer_failure:
            raise RuntimeError("PreconditionFailed: concurrent promotion")
        if args[0] == "head-object":
            return {"Metadata": {"sha256": self.digests[self.package_key]}}
        return {}

    def publish(self):
        with patch.object(publisher, "aws", self.aws), patch.object(publisher.urllib.request, "urlopen", self.request):
            publisher.publish(self.root, "test-bucket", "https://example.test", self.channel)

    def writes(self):
        return [call for call in self.calls if call[0] == "put-object"]

    def test_pointer_is_last_and_first_publication_is_conditional(self):
        self.publish()
        self.assertEqual([call[call.index("--key") + 1] for call in self.writes()], ["repos/package", "repos/current.json"])
        self.assertIn("--if-none-match", self.writes()[-1])

    def test_preview_channel_publishes_its_own_pointer_and_feed(self):
        self.seal("1.2.4~preview.20260922.7", "d" * 40, prefix="repos/preview")
        self.channel = "preview"
        self.publish()
        self.assertEqual([call[call.index("--key") + 1] for call in self.writes()], ["repos/preview/package", "repos/preview/current.json"])
        self.assertEqual(self.requests[-1], "https://example.test/api/update/linux-x64/preview/" + "0" * 40)

    def test_previews_order_by_build_date_and_run(self):
        self.seal("1.2.4~preview.20260922.7", "d" * 40, prefix="repos/preview")
        self.previous = {**self.current, "version": "1.2.4~preview.20260921.9", "generation": "1.2.4~preview.20260921.9-1-" + "e" * 40, "commit": "e" * 40}
        self.publish()
        self.assertEqual(self.writes()[-1][-2:], ("--if-match", '"previous-etag"'))
        self.previous = {**self.current, "version": "1.2.4~preview.20260923.1", "generation": "1.2.4~preview.20260923.1-1-" + "f" * 40, "commit": "f" * 40}
        with self.assertRaisesRegex(ValueError, "newer package"):
            self.publish()

    def test_publication_must_match_the_requested_channel(self):
        self.channel = "preview"
        with self.assertRaisesRegex(ValueError, "not a single preview pointer"):
            self.publish()
        self.assertEqual(self.calls, [])

    def test_pointer_version_must_match_its_channel(self):
        self.seal("1.2.4~preview.20260922.7", "d" * 40)
        with self.assertRaisesRegex(ValueError, "Invalid repository pointer"):
            self.publish()
        self.assertEqual(self.calls, [])

    def test_failed_immutable_upload_never_promotes(self):
        self.failure = "network failed"
        with self.assertRaisesRegex(RuntimeError, "network failed"):
            self.publish()
        self.assertEqual(len(self.writes()), 1)

    def test_identical_rerun_resumes_then_compare_and_swaps(self):
        self.previous = self.current
        self.failure = "PreconditionFailed"
        self.publish()
        self.assertEqual(self.writes()[-1][-2:], ("--if-match", '"previous-etag"'))

    def test_concurrent_promotion_fails_without_unconditional_retry(self):
        self.previous = self.current
        self.pointer_failure = True
        with self.assertRaisesRegex(RuntimeError, "concurrent promotion"):
            self.publish()
        pointers = [call for call in self.writes() if call[call.index("--key") + 1] == "repos/current.json"]
        self.assertEqual(len(pointers), 1)
        self.assertEqual(pointers[0][-2:], ("--if-match", '"previous-etag"'))

    def test_refuses_worker_without_rpm_support(self):
        with patch.object(publisher, "fetch_json", return_value={"schemaVersion": 1}):
            with self.assertRaisesRegex(RuntimeError, "Deploy the Linux repository Worker"):
                self.publish()
        self.assertEqual(self.writes(), [])

    def seal_apt(self):
        self.current["deb"] = True
        (self.root / self.pointer_key).write_text(json.dumps(self.current))
        self.digests[self.pointer_key] = publisher.checksum(self.root / self.pointer_key)
        for name in ["InRelease", "Release", "Release.gpg", "main/binary-amd64/Packages", "main/binary-amd64/Packages.gz"]:
            key = f"{self.prefix}/snapshots/{self.current['generation']}/apt/dists/{self.channel or 'stable'}/{name}"
            path = self.root / key
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"sealed APT metadata")
            self.digests[key] = publisher.checksum(path)
        (self.root / "sha256.json").write_text(json.dumps(self.digests))

    def test_apt_publication_requires_worker_support_before_upload(self):
        self.seal_apt()
        with self.assertRaisesRegex(RuntimeError, "Deploy the Ubuntu repository Worker"):
            self.publish()
        self.assertEqual(self.writes(), [])

    def test_incomplete_apt_snapshot_cannot_be_promoted(self):
        self.seal_apt()
        missing = next(key for key in self.digests if key.endswith("InRelease"))
        del self.digests[missing]
        (self.root / "sha256.json").write_text(json.dumps(self.digests))
        original = self.request
        def with_apt(url, **kwargs):
            if url.full_url.endswith("/apt/health"):
                return io.BytesIO(b'{"schemaVersion":1,"format":"deb"}')
            return original(url, **kwargs)
        self.request = with_apt
        with self.assertRaisesRegex(ValueError, "Incomplete APT publication"):
            self.publish()
        self.assertEqual(self.writes(), [])

    def test_apt_and_rpm_promote_together_after_all_uploads(self):
        self.seal_apt()
        original = self.request
        def with_apt(url, **kwargs):
            if url.full_url.endswith("/apt/health"):
                return io.BytesIO(b'{"schemaVersion":1,"format":"deb"}')
            return original(url, **kwargs)
        self.request = with_apt
        self.publish()
        keys = [call[call.index("--key") + 1] for call in self.writes()]
        self.assertEqual(keys[-1], self.pointer_key)
        self.assertEqual(set(keys), set(self.digests))

    def test_changed_sealed_bytes_fail_before_upload(self):
        (self.root / "repos/package").write_bytes(b"changed")
        with self.assertRaisesRegex(ValueError, "checksum mismatch"):
            self.publish()
        self.assertEqual(self.calls, [])

    def test_stale_rerun_cannot_roll_back_newer_release(self):
        self.previous = {**self.current, "version": "1.2.4", "generation": "1.2.4-1-" + "c" * 40, "commit": "c" * 40}
        with self.assertRaisesRegex(ValueError, "newer package"):
            self.publish()
        self.assertEqual(self.writes(), [])

    def test_different_immutable_bytes_cannot_be_overwritten(self):
        self.failure = "PreconditionFailed"
        self.digests["repos/package"] = "0" * 64
        with self.assertRaisesRegex(RuntimeError, "Immutable object differs"):
            self.publish()
        self.assertEqual(len(self.writes()), 1)


if __name__ == "__main__":
    unittest.main()
