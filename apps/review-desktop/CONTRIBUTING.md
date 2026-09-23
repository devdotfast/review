# Contributing to Review Desktop

Thank you for your interest in Review Desktop.

## Repository layout

- `code-oss/` is a pinned fork of [Code - OSS](https://github.com/microsoft/vscode).
  Do not send fork-tree changes upstream to Microsoft, and do not report
  Review Desktop issues to the upstream project. See [`UPSTREAM`](UPSTREAM)
  for provenance and the complete divergence inventory.
- Review-owned workbench code lives in `code-oss/src/vs/review/`.
- Build, packaging, and release scripts live in `scripts/`.

## Building

See the [README](README.md) for prerequisites and build commands.

## Note on the vendored CONTRIBUTING and SECURITY files

`code-oss/CONTRIBUTING.md` and `code-oss/SECURITY.md` are retained upstream
artifacts. They describe contributing to and reporting vulnerabilities in
Microsoft's VS Code, not in this project. This file and [SECURITY.md](SECURITY.md)
take precedence for anything in this repository.
