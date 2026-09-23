import { describe, expect, it } from "vitest";

import { scopeWhiteboardCanvasCss } from "../desktop-css-scope";
import { softwareMapOverlayClassName } from "./software-map/software-map-keyboard-navigation";

import mapCss from "./software-map/styles.css?raw";
import canvasCss from "./styles.css?raw";
import "./styles.css";
import "./api-document.css";
import "./software-map/styles.css";

describe("Review layout", () => {
  it("aligns standalone JSON trace quotes with prose while keeping nested quotes inline", () => {
    const documentView = document.createElement("article");
    documentView.className = "whiteboard-document";
    documentView.style.width = "1000px";
    documentView.innerHTML = `
      <div class="api-document-node">
        <p>Prose with <span class="whiteboard-trace-quote-container">an inline quote</span>.</p>
      </div>
      <div class="api-document-node">
        <span class="whiteboard-trace-quote-container">A standalone quote</span>
      </div>
    `;
    document.body.append(documentView);

    try {
      const prose = documentView.querySelector("p")!;

      const [inline, standalone] = documentView.querySelectorAll<HTMLElement>(
        ".whiteboard-trace-quote-container",
      );

      const proseBounds = prose.getBoundingClientRect();
      const quoteBounds = standalone.getBoundingClientRect();
      expect(quoteBounds.left).toBeCloseTo(proseBounds.left);
      expect(quoteBounds.width).toBeCloseTo(proseBounds.width);
      expect(getComputedStyle(inline).display).toBe("inline");
    } finally {
      documentView.remove();
    }
  });

  it("separates consecutive code peeks in document flow", () => {
    const documentView = document.createElement("article");
    documentView.className = "whiteboard-document";
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
    styles.textContent = scopeWhiteboardCanvasCss(`${mapCss}\n${canvasCss}`);
    const canvas = document.createElement("div");
    canvas.className = "whiteboard-canvas-root";
    canvas.style.cssText =
      "position: fixed; inset: 40px 0 0; height: auto; min-height: 0";
    const review = document.createElement("div");
    review.className = "whiteboard-app";
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

  it("keeps the find widget below and above the topbar", () => {
    const styles = document.createElement("style");
    styles.textContent = scopeWhiteboardCanvasCss(canvasCss);
    const canvas = document.createElement("div");
    canvas.className = "whiteboard-canvas-root";
    canvas.style.cssText =
      "position: fixed; inset: 40px 0 0; height: auto; min-height: 0";
    // A recoverable load error renders a status row above .whiteboard-app: the
    // height that used to slide the topbar onto the find widget.
    canvas.innerHTML = `
      <div data-whiteboard-api class="whiteboard-api-canvas">
        <p role="status" style="margin: 8px 24px; font-size: 12px">Could not refresh this review.</p>
        <div class="whiteboard-app">
          <main class="whiteboard-document-shell">
            <header class="whiteboard-topbar">
              <div class="whiteboard-topbar-left"></div>
              <div class="whiteboard-topbar-actions"></div>
            </header>
            <section class="whiteboard-view-region whiteboard-view-region--review">
              <div class="whiteboard-document-view">
                <article class="whiteboard-document">
                  <h2 id="rollout">Rollout</h2><p>body</p>
                  <h2 id="risks">Risks</h2><p>body</p>
                </article>
              </div>
            </section>
            <div class="whiteboard-find-widget" role="search" aria-label="Find in Review">
              <div class="whiteboard-find-input-shell">
                <input aria-label="Find" />
                <div class="whiteboard-find-options">
                  <button type="button" class="whiteboard-find-toggle--whole-word">ab</button>
                </div>
              </div>
            </div>
          </main>
        </div>
      </div>`;
    document.body.append(styles, canvas);

    const topbar = canvas
      .querySelector(".whiteboard-topbar")!
      .getBoundingClientRect();

    const widget = canvas.querySelector(".whiteboard-find-widget")!;

    const wholeWord = canvas.querySelector(
      ".whiteboard-find-toggle--whole-word",
    )!;

    // The widget starts below the topbar even with a status row above the app.
    expect(widget.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      topbar.bottom,
    );
    // Its toggles keep the pointer rather than handing it to what the topbar
    // stacks above them.
    const rect = wholeWord.getBoundingClientRect();

    expect(
      wholeWord.contains(
        document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        ),
      ),
    ).toBe(true);
  });
});
