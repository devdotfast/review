# Source availability

JSON review authoring does not require prepared worktrees or dependency installation. The host resolves anchors from immutable repository blobs and saves the excerpt with the accepted document.

Use `source.read` for a range, `source.file` for an immutable full file, and `source.tree/commits/diff` for exploration. Each request names the review and observed document version. The native read-only editor obtains bytes through this API.

If deeper source access is unavailable, report it and use retained evidence. Do not install dependencies, change `devfast.prepare`, or create worktrees merely to display saved code. Full language-server navigation is not implied by the ability to open pinned files.

The bundled tutorial may use existing prepared-worktree support. That trusted exception is not the JSON authoring workflow.
