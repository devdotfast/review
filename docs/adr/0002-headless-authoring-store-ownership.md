# Share the authoring database; keep one workspace owner

> Superseded in part: batch authoring removed (2026-09-22). Only the
> renewable interactive session remains; the batch draft ownership described
> below is in git history.

Desktop and the foreground headless server share `review-api.db` under the same
profile directory, defaulting to `DEV_WHITEBOARD_HOME`. This makes locally authored
reviews visible in Desktop without copying content or assigning new review IDs.
Independent CI jobs can select separate profiles.

SQLite transactions protect writes. Interactive authors use one renewable
session per review. Explicit batch mode instead holds server-owned draft
ownership until commit, abort or shutdown, without heartbeats. Mutations verify
ownership and the current version at commit time; the two modes exclude one
another on the same review. Scratch writes stay out of committed history and a
batch commit saves exactly one snapshot. Dead-server cleanup discards unfinished
drafts without stealing ownership from a live process.
Database change polling refreshes subscriptions across processes. Desktop alone
owns workspace preparation and cleanup; the headless server reads prepared source
commits without taking ownership of Desktop jobs.

Startup migrations run under a shared profile lock before either host opens the
live store. Preview headless stores are merged once with their review IDs, history,
resources and retry receipts intact; original files remain as backups.

CI still starts its own foreground server and supplies the agent harness. Saved
reviews outlive the agent and server, provided the registered checkout remains
available. Portable export and upload remain outside this authoring change.
