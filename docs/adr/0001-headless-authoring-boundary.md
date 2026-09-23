# CI owns agent execution and repository preparation

> Superseded in part: batch authoring removed (2026-09-22). The headless
> `review server` remains for interactive authoring; the batch mode, its draft
> tools, the `dev-review-batch` skill and the `author-and-share` action are in
> git history.

Headless authoring will provide a separately installable Review runtime and compatible authoring skill instructions, usable on a fresh Linux runner without a desktop installation, display server, or desktop session. CI supplies the agent harness, model credentials, and a prepared local checkout with explicit base and head revisions; missing commits must produce actionable errors. This boundary lets existing CI agent workflows author Whiteboards without making Review responsible for agent execution, PR discovery, authentication for checkout provisioning, cloning, or fetching.

This PR focuses on authoring. Its output is persistent local state and a review ID that a subsequent sharing step can consume. Portable export, uploading, sharing, and deep links belong to the separate sharing work.

Headless authoring retains the existing document components, source validation, and image, trace, and software-map resources. The shared `dev-review` skill discovers server capabilities independently of opening a review, opens the review when Desktop is available, and proceeds directly when headless. Headless software-map generation is explicitly enabled at server startup and reported through capability discovery; uploading existing maps remains supported regardless of that setting.

Distribution can use an existing npm package. The CLI surface is `review server`, with foreground `start` and a readiness `status` command.

Saving keeps its current semantics: accepted edits persist immediately, and the skill checks section statuses before finishing. This work introduces no completion gate or new restriction on saving.
