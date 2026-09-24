import { afterEach, expect, it, vi } from "vitest";

import { routeDocumentEmbedScroll } from "./document-embed-scroll";

let dispose: (() => void) | undefined;

afterEach(() => dispose?.());

function mount(embedClass: string, inDocument = true) {
  const region = document.createElement("section");
  region.style.cssText =
    "width:300px;height:200px;overflow:auto;line-height:20px";
  region.innerHTML = `<article class="${inDocument ? "review-document" : "diagram-tour-stage"}" style="height:2000px;width:700px">
    <div class="${embedClass}" style="width:200px;height:100px;overflow:auto">
      <div style="height:600px;width:900px">Content</div>
    </div>
  </article>`;
  document.body.append(region);
  dispose = routeDocumentEmbedScroll(region);
  const embed = region.querySelector<HTMLElement>(`.${embedClass}`)!;
  const content = embed.firstElementChild!;

  return { region, embed, content };
}

it.each(["sequence-diagram", "flow-diagram", "database-lens", "code-peek"])(
  "scrolls the document in both directions over %s without scrolling the embed",
  (embedClass) => {
    const { region, embed, content } = mount(embedClass);
    const embeddedWheel = vi.fn<(event: WheelEvent) => void>();
    embed.addEventListener("wheel", embeddedWheel);
    region.scrollTop = 300;
    embed.scrollTop = 50;
    embed.scrollLeft = 60;

    content.dispatchEvent(
      new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        deltaY: 120,
        deltaX: 30,
      }),
    );
    expect(region.scrollTop).toBe(420);
    expect(region.scrollLeft).toBe(30);
    content.dispatchEvent(
      new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -80 }),
    );
    expect(region.scrollTop).toBe(340);
    expect(embed.scrollTop).toBe(50);
    expect(embed.scrollLeft).toBe(60);
    expect(embeddedWheel).not.toHaveBeenCalled();
  },
);

it("normalizes line and page wheel deltas", () => {
  const { region, content } = mount("code-peek");
  content.dispatchEvent(
    new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: 3,
      deltaMode: WheelEvent.DOM_DELTA_LINE,
    }),
  );
  expect(region.scrollTop).toBe(60);
  content.dispatchEvent(
    new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: 1,
      deltaMode: WheelEvent.DOM_DELTA_PAGE,
    }),
  );
  expect(region.scrollTop).toBe(60 + region.clientHeight);
});

it("leaves fullscreen tours and pinch-to-zoom alone", () => {
  const { region, content } = mount("sequence-diagram", false);

  const wheel = new WheelEvent("wheel", {
    bubbles: true,
    cancelable: true,
    deltaY: 100,
  });

  content.dispatchEvent(wheel);
  expect(wheel.defaultPrevented).toBe(false);
  expect(region.scrollTop).toBe(0);
  region.firstElementChild!.className = "review-document";

  const pinch = new WheelEvent("wheel", {
    bubbles: true,
    cancelable: true,
    deltaY: 100,
    ctrlKey: true,
  });

  content.dispatchEvent(pinch);
  expect(pinch.defaultPrevented).toBe(false);
  expect(region.scrollTop).toBe(0);
});

it("continues scrolling the document when the embed fits and removes the handler on cleanup", () => {
  const { region, embed, content } = mount("sequence-diagram");
  (content as HTMLElement).style.cssText = "height:20px;width:20px";
  expect(embed.scrollHeight).toBe(embed.clientHeight);
  content.dispatchEvent(
    new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 80 }),
  );
  expect(region.scrollTop).toBe(80);
  dispose?.();

  const wheel = new WheelEvent("wheel", {
    bubbles: true,
    cancelable: true,
    deltaY: 100,
  });

  content.dispatchEvent(wheel);
  expect(wheel.defaultPrevented).toBe(false);
  expect(region.scrollTop).toBe(80);
});
