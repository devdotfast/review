import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { expect, it } from "vitest";

import { ReviewSessionProvider } from "./host/review-session";
import { testReviewSession } from "./review-session-test-utils";
import {
  reviewTelemetryTab,
  useReviewTabTelemetry,
} from "./use-review-tab-telemetry";

const session = testReviewSession();

function TelemetryConsumer() {
  useReviewTabTelemetry("review");
  return createElement("div", null, "review");
}

it("does not access browser globals during server rendering", () => {
  expect(
    renderToString(
      <ReviewSessionProvider session={session}>
        <TelemetryConsumer />
      </ReviewSessionProvider>,
    ),
  ).toBe("<div>review</div>");
});

it("reports the in-tab Diff view under the original files tab name", () => {
  expect(reviewTelemetryTab("diff")).toBe("files");
  expect(reviewTelemetryTab("review")).toBe("review");
  expect(reviewTelemetryTab("map")).toBe("map");
  expect(reviewTelemetryTab("trace")).toBe("trace");
});
