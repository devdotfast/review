import { describe, expect, it } from "vitest";

import type { StoreRefData, TargetRef } from "./authoring";
import { databaseLensBlockFromLegacy } from "./database-lens-block";
import { selectSource } from "./lens-selection";
import { checkReferences } from "./review-api/document";

const target = (
  storeId: string,
  storeKind: "relational" | "document",
  collectionId: string,
  path: string[] = [],
): TargetRef => ({
  __kind: "db-target-ref",
  storeId,
  storeKind,
  storeLabel: storeId,
  collectionKind: storeKind === "relational" ? "tables" : "documents",
  collectionId,
  collectionLabel: collectionId,
  path,
});

const stores = {
  orders: {
    __kind: "db-store-ref",
    id: "orders",
    kind: "relational",
    label: "Orders DB",
    dataStoreKind: "database",
    softwareMapPath: "shop.orders",
    tables: {
      orders: {
        target: {
          ...target("orders", "relational", "orders"),
          collectionLabel: "Orders",
          collectionKey: "id",
        },
        schema: {
          id: { type: "uuid", pk: true, example: "ord_1" },
          note: { type: "text?" },
          owner: {
            type: "uuid",
            fk: { store: "identity", table: "users", field: "id" },
          },
          items: { type: "uuid[]", fk: "orders.id" },
        },
      },
    },
  },
  identity: {
    __kind: "db-store-ref",
    id: "identity",
    kind: "document",
    label: "Identity",
    documents: {
      users: {
        target: target("identity", "document", "users"),
        schema: {
          id: { type: "text", pk: true },
          address: { city: { type: "text" }, zip: { type: "text?" } },
          profile: { type: "object", schema: { nick: { type: "text" } } },
        },
      },
    },
  },
} satisfies Record<string, StoreRefData>;

describe("databaseLensBlockFromLegacy", () => {
  it("gives operations that reuse one anchor unique ids", () => {
    const anchor = {
      __kind: "db-anchor-ref" as const,
      id: "current",
      title: "Current row",
      peek: selectSource({
        side: "head" as const,
        file: "src/x.ts",
        fromLine: 1,
        toLine: 2,
      }),
    };

    const actor = { __kind: "db-actor-ref" as const, id: "api", label: "API" };
    const to = target("orders", "relational", "orders", []);

    const block = databaseLensBlockFromLegacy({ stores }, [
      {
        props: { id: "one", label: "One" },
        operations: [
          { name: "DbWrite", props: { from: actor, to, label: "a", anchor } },
          { name: "DbWrite", props: { from: actor, to, label: "b", anchor } },
        ],
      },
      {
        props: { id: "two", label: "Two" },
        operations: [
          { name: "DbWrite", props: { from: actor, to, label: "c", anchor } },
        ],
      },
    ]);

    expect(
      block.useCases.flatMap((useCase) =>
        useCase.operations.map((operation) => operation.id),
      ),
    ).toEqual(["current", "current--db-use-2", "current--db-use-3"]);
  });

  it("lowers stores, fields, actors and operations to the canonical block", () => {
    const block = databaseLensBlockFromLegacy(
      { title: "Checkout data", height: 480, stores },
      [
        {
          props: { id: "place-order", label: "Place order" },
          operations: [
            {
              name: "DbWrite",
              props: {
                from: {
                  __kind: "db-actor-ref",
                  id: "api",
                  label: "Checkout API",
                  softwareMapPath: "shop.api",
                },
                to: target("orders", "relational", "orders", ["owner"]),
                label: "insert order",
                anchor: {
                  __kind: "db-anchor-ref",
                  id: "insertOrder",
                  title: "Insert order",
                  detail: "Writes the row",
                  peek: selectSource({
                    side: "head",
                    file: "src/orders.ts",
                    fromLine: 3,
                    toLine: 9,
                  }),
                },
              },
            },
            {
              name: "DbRead",
              props: {
                from: target("identity", "document", "users", [
                  "address",
                  "city",
                ]),
                to: { __kind: "db-actor-ref", id: "worker", label: "Worker" },
                label: "read city",
                anchor: {
                  __kind: "db-anchor-ref",
                  id: "readCity",
                  title: "Read city",
                  peek: selectSource({
                    side: "head",
                    file: "src/users.ts",
                    fromLine: 1,
                    toLine: 2,
                  }),
                },
              },
            },
          ],
        },
      ],
    );

    expect(block.id).toBe("db:checkout-data");
    expect(block.title).toBe("Checkout data");
    expect(block.height).toBe(480);
    expect(block.actors).toEqual({
      api: { label: "Checkout API", softwareMapPath: "shop.api" },
      worker: "Worker",
    });
    expect(block.stores.orders).toEqual({
      label: "Orders DB",
      storage: "relational",
      dataStoreKind: "database",
      softwareMapPath: "shop.orders",
      collections: {
        orders: {
          label: "Orders",
          key: "id",
          fields: {
            id: {
              label: "id",
              dataType: "uuid",
              primaryKey: true,
              example: "ord_1",
            },
            note: { label: "note", dataType: "text", nullable: true },
            owner: {
              label: "owner",
              dataType: "uuid",
              references: {
                store: "identity",
                collection: "users",
                field: "id",
              },
            },
            items: {
              label: "items",
              dataType: "uuid[]",
              references: {
                store: "orders",
                collection: "orders",
                field: "id",
              },
            },
          },
        },
      },
    });
    expect(block.stores.identity?.collections.users?.fields).toEqual({
      id: { label: "id", dataType: "text", primaryKey: true },
      address: {
        label: "address",
        dataType: "object",
        fields: {
          city: { label: "city", dataType: "text" },
          zip: { label: "zip", dataType: "text", nullable: true },
        },
      },
      profile: {
        label: "profile",
        dataType: "object",
        fields: { nick: { label: "nick", dataType: "text" } },
      },
    });
    expect(block.useCases).toEqual([
      {
        id: "place-order",
        label: "Place order",
        operations: [
          {
            id: "insertOrder",
            kind: "write",
            store: "orders",
            collection: "orders",
            field: "owner",
            actor: "api",
            label: "insert order",
            detail: "Writes the row",
            source: {
              file: "src/orders.ts",
              start: { side: "head", line: 3 },
              end: { side: "head", line: 9 },
            },
          },
          {
            id: "readCity",
            kind: "read",
            store: "identity",
            collection: "users",
            field: "address.city",
            actor: "worker",
            label: "read city",
            source: {
              file: "src/users.ts",
              start: { side: "head", line: 1 },
              end: { side: "head", line: 2 },
            },
          },
        ],
      },
    ]);

    // The lowered block satisfies the JSON ingestion checks, dotted nested
    // field paths included.
    expect(() =>
      checkReferences([
        { ...block, type: "database_lens", title: block.title ?? "Lens" },
      ]),
    ).not.toThrow();
  });
});
