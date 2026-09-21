// @vitest-environment jsdom

import { createRequire } from "node:module";
import path from "node:path";

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DatabaseLens,
  type DatabaseLensProps,
  lensUseCases,
} from "./database-lens";
import { ReviewDebugSettingsProvider } from "./debug-settings";
import { ReviewPanelProvider } from "./review-panel";
import {
  reviewSessionElement,
  testReviewSession,
} from "./review-session-test-utils";

// The lens mounts a live software-map canvas whose edge router loads the
// libavoid wasm. The desktop serves it over the review API; the test hands the
// session the package's copy so routing runs for real instead of failing
// asynchronously after the test ends.
const wasmUrl = path.join(
  path.dirname(
    createRequire(import.meta.url).resolve("@mr_mint/elkjs-libavoid"),
  ),
  "libavoid.wasm",
);

const block: DatabaseLensProps = {
  id: "db:checkout",
  title: "Checkout data",
  actors: { api: { label: "Checkout API", softwareMapPath: "shop.api" } },
  stores: {
    orders: {
      label: "Orders DB",
      storage: "relational",
      collections: {
        orders: {
          label: "Orders",
          fields: {
            id: { label: "id", dataType: "uuid", primaryKey: true },
            note: { label: "note", dataType: "text", nullable: true },
          },
        },
      },
    },
  },
  useCases: [
    {
      id: "place-order",
      label: "Place order",
      operations: [
        {
          id: "insertOrder",
          kind: "write",
          store: "orders",
          collection: "orders",
          field: "note",
          actor: "api",
          label: "insert order",
          source: {
            file: "src/orders.ts",
            start: { side: "head", line: 3 },
            end: { side: "head", line: 9 },
          },
        },
      ],
    },
    {
      id: "read-order",
      label: "Read order",
      operations: [
        {
          id: "readOrder",
          kind: "read",
          store: "orders",
          collection: "orders",
          actor: "api",
          label: "read order",
          source: {
            file: "src/orders.ts",
            start: { side: "head", line: 12 },
            end: { side: "head", line: 14 },
          },
        },
      ],
    },
  ],
};

let root: ReturnType<typeof createRoot> | undefined;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("DatabaseLens", () => {
  it("resolves canonical operations to actors and store targets", () => {
    const [placeOrder, readOrder] = lensUseCases(block);

    expect(placeOrder?.operations[0]).toMatchObject({
      id: "insertOrder",
      kind: "write",
      actor: { id: "api", label: "Checkout API", softwareMapPath: "shop.api" },
      target: {
        storeId: "orders",
        storeKind: "relational",
        collectionKind: "tables",
        collectionId: "orders",
        collectionLabel: "Orders",
        path: ["note"],
      },
    });
    expect(readOrder?.operations[0]?.target.path).toEqual([]);
  });

  it("renders the lens with its use cases and switches between them", async () => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root!.render(
        reviewSessionElement(
          testReviewSession({ wasmUrl }),
          <ReviewDebugSettingsProvider>
            <ReviewPanelProvider detailRevision={0}>
              <DatabaseLens {...block} />
            </ReviewPanelProvider>
          </ReviewDebugSettingsProvider>,
        ),
      );
    });

    expect(container.querySelector(".diagram-header-title")?.textContent).toBe(
      "Checkout data",
    );

    const select = container.querySelector<HTMLSelectElement>(
      ".database-use-case-select",
    );

    expect(
      [...(select?.options ?? [])].map((option) => option.textContent),
    ).toEqual(["Place order · 1W/0R", "Read order · 0W/1R"]);
    expect(select?.value).toBe("place-order");

    await act(async () => {
      select!.value = "read-order";
      select!.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(select?.value).toBe("read-order");
  });
});
