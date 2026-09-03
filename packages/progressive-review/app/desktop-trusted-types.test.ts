import { describe, expect, it, vi } from "vitest";

import {
  hardenLibavoidForTrustedTypes,
  isLibavoidBrowserModule,
} from "./desktop-trusted-types";

describe("libavoid Trusted Types hardening", () => {
  it("only identifies the browser libavoid module", () => {
    expect(
      isLibavoidBrowserModule(
        "/repo/node_modules/libavoid-js/dist/index.js?v=review",
      ),
    ).toBe(true);
    expect(
      isLibavoidBrowserModule(
        "/repo/node_modules/@mr_mint/elkjs-libavoid/dist/index.mjs",
      ),
    ).toBe(false);
  });

  it("passes every generated Function argument through a named Trusted Types policy", () => {
    const source = [
      'globalThis.first = new Function("value", "return value + 1")(41);',
      'globalThis.second = new Function("return 7")();',
    ].join("\n");
    const transformed = hardenLibavoidForTrustedTypes(source);
    const createPolicy = vi.fn<
      (
        name: string,
        rules: { createScript: (value: string) => string },
      ) => {
        createScript: (value: string) => { trustedScript: string };
      }
    >((_name: string, rules: { createScript: (value: string) => string }) => ({
      createScript: (value: string) => ({
        trustedScript: rules.createScript(value),
      }),
    }));
    const functionConstructor = vi.fn<
      (
        ...args: Array<{ trustedScript: string }>
      ) => (...values: unknown[]) => number
    >((...args: Array<{ trustedScript: string }>) => {
      if (!args.every((argument) => argument instanceof Object)) {
        throw new TypeError(
          "Function constructor arguments must be TrustedScript values",
        );
      }
      const body = args.at(-1);
      if (!body) {
        throw new TypeError("Function body must be a TrustedScript");
      }
      return (...values: unknown[]) =>
        body.trustedScript === "return value + 1" ? Number(values[0]) + 1 : 7;
    });
    interface LibavoidCanvasGlobal {
      Function: typeof functionConstructor;
      trustedTypes: { createPolicy: typeof createPolicy };
      first?: number;
      second?: number;
    }
    const canvasGlobal: LibavoidCanvasGlobal = {
      Function: functionConstructor,
      trustedTypes: { createPolicy },
    };

    Function("globalThis", transformed)(canvasGlobal);

    expect(createPolicy).toHaveBeenCalledWith("reviewLibavoid", {
      createScript: expect.any(Function),
    });
    expect(canvasGlobal.first).toBe(42);
    expect(canvasGlobal.second).toBe(7);
    expect(functionConstructor).toHaveBeenCalledTimes(2);
    expect(transformed).not.toContain("new Function(");
  });
});
