import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";

import type { ActivitySnapshot } from "../../src/review-api/activity";
import {
  AuthoringActivityBadge,
  AuthoringActivityContext,
  ReviewSurfaceLabel,
} from "./authoring-activity";
import { DisplayedReviewVersionContext } from "./displayed-review-version-context";

const working: ActivitySnapshot = {
  workingCount: 1,
  expiresAt: null,
  focuses: [],
};

const idle: ActivitySnapshot = { workingCount: 0, expiresAt: null };

let container: HTMLElement, root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function show(state: {
  activity: ActivitySnapshot;
  version: number;
  hasContent?: boolean;
  active?: boolean;
}) {
  await act(async () =>
    root.render(
      <AuthoringActivityContext.Provider value={state.activity}>
        <DisplayedReviewVersionContext.Provider value={state.version}>
          <ReviewSurfaceLabel
            hasContent={state.hasContent ?? true}
            active={state.active ?? false}
          />
        </DisplayedReviewVersionContext.Provider>
      </AuthoringActivityContext.Provider>,
    ),
  );
}

const unread = () => container.querySelector(".review-segment-unread") !== null;

const shimmering = () =>
  container.querySelector(".review-segment-word[data-working]") !== null;

it("marks the review unread when the authoring lease ends while the reader is elsewhere", async () => {
  await show({ activity: working, version: 3 });
  expect(shimmering()).toBe(true);
  expect(unread()).toBe(false);

  // More content arrives under the same live lease: still not ready.
  await show({ activity: working, version: 4 });
  expect(unread()).toBe(false);

  // The lease ends without a new version; that alone makes it ready.
  await show({ activity: idle, version: 4 });
  expect(shimmering()).toBe(false);
  expect(unread()).toBe(true);

  // Visiting the tab reads it; leaving again keeps it read.
  await show({ activity: idle, version: 4, active: true });
  expect(unread()).toBe(false);
  await show({ activity: idle, version: 4 });
  expect(unread()).toBe(false);

  // A later version finished while the reader is elsewhere is unread again.
  await show({ activity: working, version: 5 });
  expect(unread()).toBe(false);
  await show({ activity: idle, version: 5 });
  expect(unread()).toBe(true);
});

it("treats a finished review as read at mount and an empty one as never ready", async () => {
  await show({ activity: idle, version: 2 });
  expect(unread()).toBe(false);

  await act(async () => root.unmount());
  root = createRoot(container);
  await show({ activity: working, version: 0, hasContent: false });
  await show({ activity: idle, version: 0, hasContent: false });
  expect(unread()).toBe(false);
});

const longDescription =
  "Reviewing copy selection and publishing stack · Group selection tests and Copy for Agent implementation";

const longUpdate: ActivitySnapshot = {
  ...working,
  focuses: [{ description: longDescription }],
};

it("keeps a long update inside the badge and puts the whole of it in the tooltip", async () => {
  container.style.display = "flex";
  container.style.width = "900px";
  await act(async () =>
    root.render(
      <AuthoringActivityContext.Provider value={longUpdate}>
        <AuthoringActivityBadge />
      </AuthoringActivityContext.Provider>,
    ),
  );

  const badge = container.querySelector<HTMLElement>(
    ".host-authoring-activity",
  )!;

  const text = badge.querySelector<HTMLElement>(".host-authoring-text")!;

  // The text is cut short rather than running past the badge's edge.
  expect(text.scrollWidth).toBeGreaterThan(text.clientWidth);
  expect(text.getBoundingClientRect().right).toBeLessThanOrEqual(
    badge.getBoundingClientRect().right,
  );

  // Without a Desktop host the tooltip falls back to a native title.
  expect(badge.title).toContain(longDescription);
});
