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
        self.current = dict(schemaVersion=1, generation="1.2.3-1-" + "a" * 40,
                            version="1.2.3", commit="a" * 40, keyFingerprint="B" * 40)
        (self.root / "repos").mkdir()
        (self.root / "repos/current.json").write_text(json.dumps(self.current))
        (self.root / "repos/package").write_bytes(b"sealed package")
        self.digests = {name: publisher.checksum(self.root / name) for name in ["repos/current.json", "repos/package"]}
        (self.root / "sha256.json").write_text(json.dumps(self.digests))
        self.calls = []
        self.previous = None
        self.failure = None
        self.pointer_failure = False

    def request(self, url, **kwargs):
        url = url.full_url
        body = {"schemaVersion": 1} if url.endswith("/health") else {"version": self.current["commit"], "productVersion": self.current["version"]}
        return io.BytesIO(json.dumps(body).encode())

    def aws(self, *args):
        self.calls.append(args)
        if args[0] == "get-object":
            if self.previous is None:
                raise RuntimeError("NoSuchKey")
            Path(args[-1]).write_text(json.dumps(self.previous))
            return {"ETag": '"previous-etag"'}
        if args[0] == "put-object" and args[args.index("--key") + 1] == "repos/package" and self.failure:
            raise RuntimeError(self.failure)
        if args[0] == "put-object" and args[args.index("--key") + 1] == "repos/current.json" and self.pointer_failure:
            raise RuntimeError("PreconditionFailed: concurrent promotion")
        if args[0] == "head-object":
            return {"Metadata": {"sha256": self.digests["repos/package"]}}
        return {}

    def publish(self):
        with patch.object(publisher, "aws", self.aws), patch.object(publisher.urllib.request, "urlopen", self.request):
            publisher.publish(self.root, "test-bucket", "https://example.test")

    def writes(self):
        return [call for call in self.calls if call[0] == "put-object"]

    def test_pointer_is_last_and_first_publication_is_conditional(self):
        self.publish()
        self.assertEqual([call[call.index("--key") + 1] for call in self.writes()], ["repos/package", "repos/current.json"])
        self.assertIn("--if-none-match", self.writes()[-1])

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
