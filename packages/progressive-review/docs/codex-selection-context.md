# Share Review selections with Codex

Review can act as an IDE context provider while you keep using the Codex desktop
or terminal UI. This integration uses Codex's private local IPC protocol.

## Use

1. Run this build of Review and keep Codex desktop running (it supplies the IPC router).
2. Open the source workspace (or its containing monorepo) in Codex. A Codex
   task in Review's pinned head checkout also matches.
3. Enable **Codex context** in the bottom-right corner of the Review canvas.
4. Select prose, select a code range, click a sequence participant/message, or
   use **Select for Codex** beside a database use case.
5. Enable IDE context in Codex desktop, or run `/ide on` in Codex CLI, and send
   your question there. No Review comment or agent launch is required.

The control shows the retained selection and whether the router is connected.
It does not prove that Codex chose Review over another eligible IDE. Disable
other providers (including the experimental Emacs provider) for deterministic
selection when the same workspace is open in several editors.

Selections persist when switching to Codex. **Clear** removes the selection;
unchecking **Codex context** stops sharing. Navigating to a different document
revision clears the old selection. Sharing is off on initial mount.

## What is shared

For prose and diagrams, the active file is the editable authoring Review MDX.
For diffs, it is the pinned head file, or the pinned base file for deletions.
Open tabs list the existing pinned sides and the authoring MDX. Focusing a diff
file without selecting text publishes file context without a selection block;
collapsing a selection returns to that file context. Selection content is kept in
memory and supplied directly over IPC; no Markdown snapshot files are created.
Prose selections contain only the selected text. Code and diagram selections
include a descriptive heading and their relevant content, without an internal
Review target JSON block. The popup previews the full context sent to Codex.
Unified diff selections preserve the displayed pinned rows as a fenced diff,
including removed, added, and unchanged lines with old/new line coordinates.

Native editor selections are shared as whole lines.
Sequence context includes endpoints and source metadata; database use-case
context includes operations and stores. Opening a comment draft also selects
its referent, but sharing never submits that draft.

Context is capped below Codex's 40,000-character selection limit. Mixed-side
unified diff selections are supported. Multi-element diagram selection is not implemented.
Semantic selections do not claim a source line range in the MDX document.

The provider uses `$CODEX_HOME/ipc/ipc.sock` (default `~/.codex/ipc/ipc.sock`), or
`\\.\pipe\codex-ipc` on Windows, and reconnects after the router restarts. It
only answers version 0 `ide-context` requests for matching local workspaces.
A single backend chooses the latest selection among its Review windows;
heartbeats preserve that ordering. A canvas that stops refreshing its selection
lease expires after 45 seconds. This integration neither creates Codex tasks nor
sends prompts itself.

Claude integration and an editor-preference setting are outside this change.
The IPC contract is private and may change with Codex updates.
