import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { expect, it } from "vitest";

import { WhiteboardSessionProvider } from "./host/whiteboard-session";
import {
  useWhiteboardTabTelemetry,
  whiteboardTelemetryTab,
} from "./use-whiteboard-tab-telemetry";
import { testWhiteboardSession } from "./whiteboard-session-test-utils";

const session = testWhiteboardSession();

function TelemetryConsumer() {
  useWhiteboardTabTelemetry("review");

  return createElement("div", null, "review");
}

it("does not access browser globals during server rendering", () => {
  expect(
    renderToString(
      <WhiteboardSessionProvider session={session}>
        <TelemetryConsumer />
      </WhiteboardSessionProvider>,
    ),
  ).toBe("<div>review</div>");
});

it("reports the in-tab Diff view under the original files tab name", () => {
  expect(whiteboardTelemetryTab("diff")).toBe("files");
  expect(whiteboardTelemetryTab("review")).toBe("review");
  expect(whiteboardTelemetryTab("map")).toBe("map");
  expect(whiteboardTelemetryTab("trace")).toBe("trace");
});
