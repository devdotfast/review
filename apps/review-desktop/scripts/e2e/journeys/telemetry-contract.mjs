/** Every event the Desktop sends carries one envelope, and a review's lifecycle is start, presented, ended. */
import assert from "node:assert/strict";

import { createReview, orderReviewBlocks, pickReview } from "../harness.mjs";

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

  // The debug sink never persists the install flag, so each relaunch announces
  // the install again; that is not asserted here.
  const firstId = started[0].properties.presentation_id;

  await ctx.quitAndRelaunchDesktop();
  await ctx.until(
    () => endsOf(ctx, firstId)[0] ?? null,
    "the quit session's end",
  );
  assert.deepEqual(
    endsOf(ctx, firstId).map((e) => e.properties.outcome),
    ["app_quit"],
    "a clean quit ends the session once, as app_quit",
  );
  assertContract(ctx, review);
  ctx.check("a clean quit ends the session exactly once, as app_quit");

  // The relaunch reopens the review or the reader picks it again. A workbench
  // reload can end that session and start another, so kill whichever is open.
  if (!(await openSession(ctx, 15000))) await pickReview(ctx, review.reviewId);
  const secondId = await openSession(ctx);

  await ctx.restartDesktop({ signal: "SIGKILL" });
  await ctx.until(
    () => endsOf(ctx, secondId)[0] ?? null,
    "the killed session's abnormal end",
  );
  assert.deepEqual(
    endsOf(ctx, secondId).map((e) => e.properties.outcome),
    ["abnormal"],
    "a killed session ends once, as abnormal, on the next launch",
  );
  // Two relaunches have reconciled by now; the quit session stays ended once.
  assert.equal(endsOf(ctx, firstId).length, 1, "no abnormal end after a quit");
  assertContract(ctx, review);
  ctx.check("a killed Desktop's session ends exactly once, as abnormal");
}

const endsOf = (ctx, presentationId) =>
  named(ctx, "review_session_ended").filter(
    (e) => e.properties.presentation_id === presentationId,
  );

/** The one presented session with no end yet, waited for up to `timeout`. */
async function openSession(ctx, timeout) {
  const open = () => {
    const ended = new Set(
      named(ctx, "review_session_ended").map((e) => e.properties.presentation_id),
    );

    const ids = named(ctx, "review_review_presented")
      .map((e) => e.properties.presentation_id)
      .filter((id) => !ended.has(id));

    assert.ok(ids.length <= 1, `one open session, not ${ids.length}`);

    return ids[0] ?? null;
  };

  try {
    return await ctx.until(open, "an open session", timeout);
  } catch (error) {
    if (timeout === undefined) throw error;

    return null;
  }
}
