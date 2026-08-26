import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TutorialAuthoringConversation } from "./tutorial-authoring-conversation";

describe("TutorialAuthoringConversation", () => {
  it("labels bundled messages as representative authoring context", () => {
    const html = renderToStaticMarkup(
      <TutorialAuthoringConversation
        conversation={{
          version: 1,
          title: "How this Review was made",
          messages: [
            { role: "user", body: "Create the tutorial." },
            { role: "assistant", body: "The Review is ready." },
          ],
        }}
      />,
    );

    expect(html).toContain("Representative authoring conversation");
    expect(html).toContain("Create the tutorial.");
    expect(html).toContain("The Review is ready.");
    expect(html).toContain("You");
    expect(html).toContain("Agent");
  });
});
