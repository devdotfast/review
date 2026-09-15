import { describe, expect, it } from "vitest";

import "./styles.css";
import "./software-map/styles.css";

describe("Review layout", () => {
  it("separates consecutive code peeks in document flow", () => {
    const documentView = document.createElement("article");
    documentView.className = "review-document";
    documentView.innerHTML = `
      <section class="code-peek"></section>
      <section class="code-peek"></section>
    `;
    document.body.append(documentView);

    const codePeeks = documentView.querySelectorAll<HTMLElement>(".code-peek");
    expect(getComputedStyle(codePeeks[1]).marginBlockStart).toBe("14px");
  });

  it("keeps an expanded software map inside the viewport and above the topbar", () => {
    const frame = document.createElement("figure");
    frame.className = "software-map-frame software-map-frame--expanded";
    const overlay = document.createElement("div");
    overlay.className = "software-map-overlay";
    const closeButton = document.createElement("button");
    closeButton.setAttribute("aria-label", "Close expanded software map");
    overlay.append(closeButton, frame);
    document.body.append(overlay);

    const overlayStyle = getComputedStyle(overlay);
    const frameStyle = getComputedStyle(frame);

    expect(frameStyle.marginBlockStart).toBe("0px");
    expect(frameStyle.marginBlockEnd).toBe("0px");
    expect(overlayStyle.position).toBe("fixed");
    expect(Number(overlayStyle.zIndex)).toBeGreaterThan(2_147_482_999);
    expect(
      overlay.querySelector('[aria-label="Close expanded software map"]'),
    ).toBe(closeButton);
  });
});
