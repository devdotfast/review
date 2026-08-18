# Review documentation

<!--
Outline: Start here -> Reference -> Contributing and security.

TODO(docs): Before the public launch:
- Add one link to a real public Review created from a representative pull request.
- Decide where users should ask questions: GitHub Discussions, Discord, or email.
- Decide whether these files remain repository docs or move to a hosted docs site.
- Remove this comment after the linked pages complete their own TODO(docs) items.
-->

Review is a desktop app where coding agents turn code changes into guided,
interactive reviews. Start with the quickstart, then use the rest of this
directory as a reference.

## Before the public launch

- [ ] Add a real Review screenshot or short product GIF to the root README.
- [ ] Confirm the alpha label and supported platforms in the quickstart.
- [ ] Add the public support and community links.
- [ ] Confirm the privacy, retention, and bug-report language.
- [ ] Recheck the CLI reference against the release candidate.
- [ ] Add one public example Review.

Remove this checklist once the launch details are final.

## Start here

- [Quickstart](quickstart.md) — install Review and complete a first review.
- [How Review works](how-review-works.md) — understand documents, live code,
  maps, threads, and the review lifecycle.
- [Architecture](architecture.md) — understand the major processes, data flow,
  storage boundaries, and repository layout.
- [Coding agents](agents.md) — connect Claude Code, Codex, or Cursor.

## Reference

- [CLI reference](cli-reference.md) — commands, options, and JSON output.
- [Privacy](privacy.md) — what stays local, what is sent, and how to opt out.
- [Telemetry reference](telemetry.md) — the complete event and data contract.
- [Troubleshooting](troubleshooting.md) — fixes for common setup and runtime
  problems.

## Contributing and security

- [Contributing](../CONTRIBUTING.md)
- [Security policy](../SECURITY.md)
- [Desktop build and release guide](../apps/review-desktop/README.md)
- [Code - OSS provenance](../apps/review-desktop/UPSTREAM)
