# Quickstart

This guide describes the JSON-host version of Review. Use a matching Desktop and CLI; older releases may still expose the former file-based workflow.

## 1. Start Review Desktop

Install and open Review, or use the [checkout development instructions](https://github.com/devdotfast/review/blob/main/apps/review-desktop/README.md) when testing an unreleased change. Development verification must use the app built from that checkout, not another installed copy.

Home lists reviews held by the local host. **Welcome**, **Settings** and the bundled **Tutorial** remain available. Setup can install the `review` command and the `dev-review` / `dev-review-map` skills for supported coding agents.

The tutorial is trusted application content and may retain legacy rendering; it is not a template for authoring new review files.

## 2. Connect your agent

With Desktop running, check the connection:

```sh
review host capabilities
review host query repositories.list --input '{}'
```

An agent can use the CLI directly. For MCP, configure your agent's stdio integration to run the matching `review` executable with `mcp` as its argument. Skill installation does not currently create that MCP entry. See [Coding agents](agents.md).

## 3. Create a review

Ask your coding agent:

```text
Use the dev-review skill to review my current branch against up-to-date main.
Author the review through the running Desktop's JSON host API and open it.
```

The agent registers the repository if needed, creates a review with exact pins, and adds JSON nodes/definitions through commands. You can watch accepted changes appear live. Publishing creates a frozen checkpoint; it does not compile a document file.

A review can explain an existing architecture too: use a snapshot binding at one commit instead of a change range.

### Add Review guidance

Optional user guidance lives at `$DEV_REVIEW_HOME/DEV-REVIEW.md` (default `~/.dev/DEV-REVIEW.md`). Repository-root `DEV-REVIEW.md` takes precedence. These are guidance files, not review storage.

## 4. Read and respond

Use **Source** to explore the exact pinned files, commits and changes. Use the version selector to distinguish the live document from published checkpoints.

Open **Discussion** or select code in the native source editor and choose **Add Review Comment**:

- **Add to review** saves a private draft.
- **Post comment** shares a comment immediately.
- **Ask now** saves your question and launches a fresh supported local assistant alongside the canvas.
- **Submit review** shares selected saved drafts with Comment, Request changes or Approve.

Save draft edits before submitting. Posted messages cannot be edited; add a follow-up instead. Questions and final answers remain in the review. A request-changes submission is available to an authorized authoring agent through the API; it does not automatically resume the original author.

## Next steps

- [How Review works](how-review-works.md)
- [Coding agents](agents.md)
- [CLI and API reference](cli-reference.md)
- [Privacy](privacy.md)
- [Troubleshooting](troubleshooting.md)
