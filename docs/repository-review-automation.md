# Reviews on this repository's pull requests

`.github/workflows/review-author.yml` runs the pinned author-and-share action
with Claude Code on a GitHub-hosted Ubuntu runner. It generates a Review for
non-draft, same-repository pull requests when opened, updated, reopened, or marked
ready for review. Fork PRs and Dependabot-triggered runs are skipped.

## Configure once

First run [Review CLI Release](cli-releases.md#release-from-github) from `main`
and set the repository Actions variable `REVIEW_VERSION` to the exact published
version shown in its summary. The current npm release, `0.2.10`, predates the
headless server and cannot run this action. No compatible release was published
when this workflow was added.

Add these repository Actions secrets:

- `CLAUDE_CODE_OAUTH_TOKEN`: a Claude subscription token generated locally with
  `claude setup-token`, then saved with
  `gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo devdotfast/review`.
  Runs use the publishing operator's Claude subscription allowance.
- `REVIEW_SHARE_TOKEN`: the publishing account's Review sharing bearer token.
  Follow the credential setup in [the action guide](../actions/author-and-share/README.md#sharing-credentials).

Missing configuration fails the job before agent installation or generation. The
workflow uses `GITHUB_TOKEN` with contents-read and pull-requests-write permission
for publishing source verification and updating the PR comment. Checkout does
not persist that token in Git configuration.

The optional repository variable `REVIEW_MODEL` selects the Claude model; it
defaults to `sonnet`. The action requires an exact Review CLI version from
`REVIEW_VERSION`; Claude Code `2.1.278` and the composite action commit are pinned
in the workflow. Update those code pins through a PR.

## Run behavior

The action resolves the PR's base and head commits, starts an isolated batch
server, and passes its generated prompt to Claude through stdin. Claude receives
the installed Review skills and non-interactive permission to read source, use
shell commands, and write draft files. This runs trusted repository content with
a subscription token; the tool allowlist is not a sandbox. The prompt asks Claude to leave
repository files unchanged and author through `review api`.

After Claude succeeds, the action verifies that exactly one Review was committed
with the requested pins, uploads that immutable version, and creates or updates
one PR link comment. Open the link in Review Desktop. Anyone with the link can
download the Review; reading its pinned source still requires repository access.

New pushes cancel earlier runs for the same PR. Each job has a 30-minute timeout.
Re-run a failed job from GitHub Actions after fixing credentials or a transient
failure. If uploading succeeded but commenting failed, the link remains in the
job summary. Each successful rerun can create another immutable share.
