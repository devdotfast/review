// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";

import {
  type HostAuthoringActivity,
  HostAuthoringActivityBadge,
  HostAuthoringActivityContext,
} from "./host-authoring-activity";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => act(() => root.unmount()));
function render(value: HostAuthoringActivity) {
  act(() =>
    root.render(
      <HostAuthoringActivityContext.Provider value={value}>
        <HostAuthoringActivityBadge />
      </HostAuthoringActivityContext.Provider>,
    ),
  );
  return container.querySelector('[role="status"]')?.textContent;
}
const idle = {
  reviewId: "review",
  workingCount: 0,
  unknownCount: 0,
};

it("distinguishes ongoing authoring, expired activity, and an explicit finish", () => {
  expect(render(undefined)).toBeUndefined();
  expect(render(idle)).toBeUndefined();
  expect(render({ ...idle, workingCount: 1 })).toBe("Agent working…");
  expect(render({ ...idle, unknownCount: 1 })).toBe("Activity unknown");
  expect(render(idle)).toBeUndefined();
});

it("does not present a disconnected session as finished and supports multiple authors", () => {
  expect(render({ ...idle, workingCount: 2 })).toBe("2 agents working…");
  expect(render("unknown")).toBe("Activity unknown");
  expect(
    container.querySelector('[role="status"]')?.getAttribute("title"),
  ).toContain("does not mean the agent finished");
  // Removing the provider value (disabled feature or historical view) hides live activity.
  expect(render(undefined)).toBeUndefined();
});
