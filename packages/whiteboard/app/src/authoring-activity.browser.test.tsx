import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";

import type { ActivitySnapshot } from "../../src/session-api/activity";
import {
  AuthoringActivityContext,
  WhiteboardSurfaceLabel,
} from "./authoring-activity";
import { DisplayedWhiteboardVersionContext } from "./displayed-whiteboard-version-context";

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
        <DisplayedWhiteboardVersionContext.Provider value={state.version}>
          <WhiteboardSurfaceLabel
            hasContent={state.hasContent ?? true}
            active={state.active ?? false}
          />
        </DisplayedWhiteboardVersionContext.Provider>
      </AuthoringActivityContext.Provider>,
    ),
  );
}

const unread = () =>
  container.querySelector(".whiteboard-segment-unread") !== null;

const shimmering = () =>
  container.querySelector(".whiteboard-segment-word[data-working]") !== null;

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
