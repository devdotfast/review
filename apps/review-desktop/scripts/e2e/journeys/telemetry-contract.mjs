/** Every event the Desktop sends carries one envelope, and a review's lifecycle is start, presented, ended. */
import assert from "node:assert/strict";

import { createReview, orderReviewBlocks } from "../harness.mjs";

export const name = "telemetry-contract";

export const phase = 1;

export const options = {
  env: {
    DEV_FAST_REVIEW_TELEMETRY_DISABLED: "",
    DEV_FAST_REVIEW_TELEMETRY_DEBUG: "1",
  },
};

const PREFIX = "[review-telemetry]";

const ENVELOPE = [
  "cli_version",
  "version",
  "channel",
  "environment",
  "surface",
  "ci",
  "internal",
  "platform",
  "arch",
  "os_version",
  "node_major",
];

/** Every event this journey may see; a new name must be added here on purpose. */
const EXPECTED_EVENTS = new Set([
  "review_app_opened",
  "review_extension_disabled",
  "review_home_empty_state_viewed",
  "review_installation_created",
  "review_session_started",
  "review_review_presented",
  "review_first_review_presented",
  "review_session_ended",
]);

/** Every event printed so far by the embedded server's debug sink. */
function sentEvents(ctx) {
  const events = [];

  for (const line of ctx.appLog().split("\n")) {
    const at = line.indexOf(PREFIX);

    if (at < 0) continue;

    try {
      events.push(JSON.parse(line.slice(at + PREFIX.length).trim()));
    } catch {
      // Not a whole event: a line still being written, or one that an
      // interleaved stdout/stderr chunk split. Such an event is lost to this
      // reader, so the journey only waits on and counts events it can parse.
    }
  }

  return events;
}

const named = (ctx, event) =>
  sentEvents(ctx).filter((e) => e.event === event);

function assertContract(ctx, review) {
  const events = sentEvents(ctx);

  for (const event of events) {
    assert.ok(
      EXPECTED_EVENTS.has(event.event),
      `unexpected event ${event.event}`,
    );

    for (const key of ENVELOPE)
      assert.ok(key in event.properties, `${event.event} carries ${key}`);
    assert.equal(
      event.properties.environment,
      "e2e",
      `${event.event} is tagged e2e`,
    );
    assert.equal(
      event.properties.surface,
      "desktop",
      `${event.event} comes from the desktop surface`,
    );
    assert.ok(
      !("product" in event.properties),
      `${event.event} has no product`,
    );
    assert.ok(
      !JSON.stringify(event).includes(review.reviewId),
      `${event.event} leaks the review id`,
    );
  }

  return events;
}

export async function run(ctx) {
  await ctx.until(
    () => named(ctx, "review_installation_created").length === 1 || null,
    "the installation event",
  );

  const review = await createReview(ctx, {
    title: "Telemetry contract",
    blocks: orderReviewBlocks,
  });

  await ctx.until(
    () => named(ctx, "review_review_presented")[0] ?? null,
    "the presented event",
  );
  const started = named(ctx, "review_session_started");
  const presented = named(ctx, "review_review_presented");

  assert.equal(started.length, 1, "one session start");
  assert.equal(presented.length, 1, "one presented");
  assert.equal(
    started[0].properties.presentation_id,
    presented[0].properties.presentation_id,
  );
  assert.match(started[0].properties.review_id, /^rv_/);
  assert.ok(presented[0].properties.load_ms >= 0);
  // The server announces the first review after a file-lock round trip, so it can trail the presented event.
  await ctx.until(
    () => named(ctx, "review_first_review_presented")[0] ?? null,
    "the first presented review",
  );
  assert.equal(
    named(ctx, "review_first_review_presented").length,
    1,
    "first review announced once",
  );
  assert.equal(
    named(ctx, "review_installation_created").length,
    1,
    "the install is announced once",
  );
  ctx.check("session start and presented share a presentation id");

  const appSessions = new Set(
    assertContract(ctx, review).map((e) => e.properties.app_session_id),
  );

  assert.equal(appSessions.size, 1, "one app session id across processes");
  assert.ok([...appSessions][0], "the app session id is set");
  ctx.check("every event carries the envelope and no raw review id");

  // A restart is a SIGTERM quit. The renderer reports app_quit on the way out,
  // or the next launch reconciles the marker as abnormal. Either way: one end.
  // The debug sink never persists the install flag, so the relaunch announces
  // the install again; that is not asserted here.
  await ctx.restartDesktop();
  await ctx.until(
    () => named(ctx, "review_session_ended")[0] ?? null,
    "the session end",
  );
  const ended = named(ctx, "review_session_ended");

  assert.equal(ended.length, 1, "exactly one session end");
  assert.ok(
    ["app_quit", "abnormal"].includes(ended[0].properties.outcome),
    ended[0].properties.outcome,
  );
  assert.equal(
    ended[0].properties.presentation_id,
    started[0].properties.presentation_id,
  );
  assertContract(ctx, review);
  ctx.check("a quit ends the session exactly once");
}
