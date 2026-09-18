# Author and share a Review in GitHub Actions

This composite action starts an isolated batch server, runs **your agent command**, uploads its committed review, and creates or updates a PR comment with the share link. You control agent installation, model credentials, prompting, and repository preparation. No Desktop installation or display session is needed on the runner.

Use Node-compatible Linux runners with Bash and Git. Pin this action to a reviewed commit and set `REVIEW_VERSION` to an exact npm release that includes headless sharing. Until that release is published, test using the built runtime in this checkout; the action cannot install an unreleased npm version.

## Add a workflow

Save this as `.github/workflows/review.yml`, replace `<action-commit-sha>`, and implement the two harness scripts for your agent. The setup script installs/configures your chosen agent; the author script sends the contents of its first argument to that agent.

```yaml
name: Author a shared Review
on:
  pull_request:
    types: [opened, synchronize, reopened]
permissions:
  contents: read
  pull-requests: write
concurrency:
  group: shared-review-${{ github.event.pull_request.number }}
  cancel-in-progress: true
jobs:
  review:
    # Fork PRs do not receive the publishing/model secrets. Do not use
    # pull_request_target to execute an untrusted checkout with these tokens.
    if: github.event.pull_request.head.repo.full_name == github.repository && github.actor != 'dependabot[bot]'
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6
        with:
          ref: ${{ github.event.pull_request.head.sha }}
          fetch-depth: 0
      - name: Set up your agent
        run: ./ci/setup-review-agent.sh
      - uses: devdotfast/review/actions/author-and-share@<action-commit-sha>
        id: review
        env:
          # Names and credentials belong to your harness; these are examples.
          MY_MODEL_API_KEY: ${{ secrets.MY_MODEL_API_KEY }}
        with:
          review-version: ${{ vars.REVIEW_VERSION }}
          share-token: ${{ secrets.REVIEW_SHARE_TOKEN }}
          author-command: |
            review install codex --no-shim
            ./ci/author-review.sh "$REVIEW_PROMPT_FILE"
          prompt: |
            Explain user-visible behavior and significant design choices.
            Keep the review short and ground claims in the pinned source.
      - name: Consume the result
        env:
          REVIEW_URL: ${{ steps.review.outputs.url }}
        run: printf 'Shared review available at %s\n' "$REVIEW_URL"
```

`review install codex --no-shim` is one example; choose the integration for your harness, or load the packaged skill directly. Your command runs in `repository-path` (default `.`). Arbitrary text such as `prompt` is passed as data, not interpolated into shell source. `author-command` is trusted workflow code.

The example skips forks and Dependabot because their usual PR workflows cannot access these secrets. This action also refuses fork events, including `pull_request_target`. If you need fork reviews, design a separately approved trusted workflow instead of exposing credentials to fork-controlled code. GitHub documents [fork permissions](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax) and [composite action inputs](https://docs.github.com/en/actions/reference/workflows-and-actions/metadata-syntax).

## Sharing credentials

On a trusted machine, run `review login` using the publishing account. Copy its sharing bearer token into the repository secret without printing it:

```sh
jq -r .token "${DEV_REVIEW_HOME:-$HOME/.dev}/auth.json" |
  gh secret set REVIEW_SHARE_TOKEN --repo OWNER/REPOSITORY
```

This is a Review account token, not `GITHUB_TOKEN` or a model API key. Rotate the secret when the login expires or is revoked. No trace-upload permission is required to publish a Review. For a non-default sharing service, provide `share-origin` as its bare HTTPS origin; the token must belong to that service.

The action supplies `github-token` (default `github.token`) to the publish server's Git credential prompt so it can verify private commits from the same repository. That token also needs `pull-requests: write` to update the comment. Cross-repository private source needs a token with access to the source repository too. Existing Git/SSH credentials remain an option outside this action.

The share includes retained images, maps, and full attached trace conversations. Anyone with the link can download the review; recipients still need GitHub source access. Posting the comment makes that link available to everyone who can read the PR.

## Agent contract and outputs

Your author command gets:

- `REVIEW_PROMPT_FILE`: generated instructions plus your custom prompt.
- `REVIEW_REPOSITORY_PATH`, `REVIEW_BASE`, `REVIEW_HEAD`: prepared checkout and resolved immutable commits.
- `REVIEW_PINS_JSON`: resolved repository ID and pins for `review_draft_begin`.
- `DEV_REVIEW_HOME` / `DEV_REVIEW_SERVER_DIR`: isolated server profile used automatically by `review api` and `review mcp`.

The agent must commit exactly one review matching these pins and exit successfully. It need not print JSON or write a special result file. No committed review, multiple reviews, different pins, or a failed command prevents upload. The action reads the committed identity and exact version from its own isolated profile. Publishing and commenting credentials are omitted from the agent subprocess environment; this is not a sandbox for untrusted agents or repository code.

Outputs are `url`, `review-id`, `version`, and `share-id`. The link is also written to the job summary before commenting. If the comment fails, the step fails but the published link is retained in the summary/outputs. Repeated runs update the existing `github-actions[bot]` comment; an old-head run never replaces the link for a newer PR head. Keep the example's concurrency setting to serialize runs for a PR. Custom bot identities are not supported for comment reuse.

Use `comment: 'false'` for workflows without a PR, and supply explicit `base` and `head`. Server shutdown and scratch-profile cleanup run on success, failure, and normal cancellation. A hard runner kill relies on runner cleanup. Completed uploads survive teardown; incomplete drafts do not.

## The same flow outside Actions

```sh
export DEV_REVIEW_SHARE_TOKEN=... # Inject from your secret manager.
review server start --authoring-mode batch
# In another process, run your agent, then:
review share --review REVIEW_ID --version VERSION --request-id UUID --json
```

`review share` discovers the same headless server as `review api`. Select a profile consistently with `DEV_REVIEW_SERVER_DIR` or `review --state-dir PATH share …`. Retrying the same immutable upload with the same request UUID reuses the backend's idempotency contract. Existing local `review login` credentials remain supported when the environment token is absent.
