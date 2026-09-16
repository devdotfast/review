import { describe, expect, it } from "vitest";

import { scopeReviewCanvasCss } from "../desktop-css-scope";
import { softwareMapOverlayClassName } from "./software-map/software-map-keyboard-navigation";

import mapCss from "./software-map/styles.css?raw";
import canvasCss from "./styles.css?raw";
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
    const styles = document.createElement("style");
    styles.textContent = scopeReviewCanvasCss(`${mapCss}\n${canvasCss}`);
    const canvas = document.createElement("div");
    canvas.className = "review-canvas-root";
    canvas.style.cssText =
      "position: fixed; inset: 40px 0 0; height: auto; min-height: 0";
    const review = document.createElement("div");
    review.className = "review-app";
    canvas.append(review);
    const frame = document.createElement("figure");
    frame.className = "software-map-frame software-map-frame--expanded";
    const overlay = document.createElement("div");
    overlay.className = softwareMapOverlayClassName({
      theme: "dark",
      nodeTint: "slate",
    });
    const closeButton = document.createElement("button");
    closeButton.setAttribute("aria-label", "Close expanded software map");
    overlay.append(closeButton, frame);
    canvas.append(overlay);
    document.body.append(styles, canvas);

    const overlayStyle = getComputedStyle(overlay);
    const frameStyle = getComputedStyle(frame);

    expect(frameStyle.marginBlockStart).toBe("0px");
    expect(frameStyle.marginBlockEnd).toBe("0px");
    expect(overlayStyle.position).toBe("fixed");
    const bounds = overlay.getBoundingClientRect();
    expect(bounds.top).toBe(40);
    expect(bounds.bottom).toBe(window.innerHeight);
    expect(bounds.width).toBe(window.innerWidth);
    expect(overlay.contains(document.elementFromPoint(100, 100))).toBe(true);
    expect(Number(overlayStyle.zIndex)).toBeGreaterThan(2_147_482_999);
    expect(
      overlay.querySelector('[aria-label="Close expanded software map"]'),
    ).toBe(closeButton);
  });
});
