/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from "node:assert/strict";
import test from "node:test";

import { Emitter } from "../../base/common/event.js";
import {
  ConfigurationTarget,
  type IConfigurationChangeEvent,
} from "../../platform/configuration/common/configuration.js";
import type { ReviewDiffLayout } from "../common/reviewProtocol.js";
import { ReviewDiffLayoutSetting } from "./reviewDiffLayout.js";

function createService() {
  const values = new Map<string, unknown>();
  const writes: Array<{ key: string; value: unknown; target: unknown }> = [];
  const changes = new Emitter<IConfigurationChangeEvent>();
  const configurationService = {
    getValue: (key: string) => values.get(key),
    updateValue: async (key: string, value: unknown, target: unknown) => {
      values.set(key, value);
      writes.push({ key, value, target });
      changes.fire({
        affectsConfiguration: (section: string) => section === key,
      } as IConfigurationChangeEvent);
    },
    onDidChangeConfiguration: changes.event,
  };
  const service = new ReviewDiffLayoutSetting(configurationService as never);
  return { service, values, writes, changes };
}

test("side by side is the default and inline maps to unified", () => {
  const { service, values } = createService();
  assert.equal(service.get(), "split");
  values.set("diffEditor.renderSideBySide", false);
  assert.equal(service.get(), "unified");
});

test("set writes the user setting and announces the new layout", async () => {
  const { service, writes } = createService();
  const announced: ReviewDiffLayout[] = [];
  service.onDidChange((layout) => announced.push(layout));

  await service.set("unified");

  assert.deepEqual(writes, [
    {
      key: "diffEditor.renderSideBySide",
      value: false,
      target: ConfigurationTarget.USER,
    },
  ]);
  assert.deepEqual(announced, ["unified"]);
  assert.equal(service.get(), "unified");
});

test("toggle flips between the two layouts", async () => {
  const { service, writes } = createService();
  await service.toggle();
  assert.equal(service.get(), "unified");
  await service.toggle();
  assert.equal(service.get(), "split");
  assert.deepEqual(
    writes.map((write) => write.value),
    [false, true],
  );
});

test("unrelated setting changes do not announce a layout", () => {
  const { service, changes } = createService();
  const announced: ReviewDiffLayout[] = [];
  service.onDidChange((layout) => announced.push(layout));
  changes.fire({
    affectsConfiguration: (section: string): boolean =>
      section === "editor.fontSize",
  } as IConfigurationChangeEvent);
  assert.deepEqual(announced, []);
});
