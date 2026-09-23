// @vitest-environment jsdom
import { act, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

import { useDismissOnOutside } from "./use-dismiss-on-outside";

it("keeps nested content open and preserves capture versus bubbling dismissal", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);

  function Fixture({ capture }: { capture: boolean }) {
    const [open, setOpen] = useState(true);
    const ref = useRef<HTMLDivElement>(null);
    useDismissOnOutside(ref, open, setOpen, capture, capture);

    return (
      <div ref={ref}>
        {open ? "Open" : "Closed"}
        <button onKeyDown={(event) => event.stopPropagation()}>Nested</button>
      </div>
    );
  }

  try {
    await act(async () => root.render(<Fixture capture={false} />));
    await act(async () =>
      element
        .querySelector("button")!
        .dispatchEvent(new Event("pointerdown", { bubbles: true })),
    );
    expect(element.textContent).toContain("Open");
    await act(async () =>
      element
        .querySelector("button")!
        .dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        ),
    );
    expect(element.textContent).toContain("Open");
    await act(async () => root.render(<Fixture capture />));
    await act(async () =>
      element
        .querySelector("button")!
        .dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        ),
    );
    expect(element.textContent).toContain("Closed");
    await act(async () => root.render(<Fixture key="reset" capture={false} />));
    await act(async () =>
      document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })),
    );
    expect(element.textContent).toContain("Closed");
  } finally {
    await act(async () => root.unmount());
    element.remove();
    vi.unstubAllGlobals();
  }
});
