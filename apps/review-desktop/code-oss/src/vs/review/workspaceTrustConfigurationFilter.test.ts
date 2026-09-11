/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

// Behavioural guard for the CVE-2026-81376 / CVE-2026-70334 backport
// (upstream 0684cb5905a3f23156f45a28135326e09310ff4d). An untrusted workspace
// could express a restricted setting as a nested object instead of a dotted
// key and slip past the Restricted Mode filter. These assertions fail against
// the unpatched parser, so they prove the fix rather than merely detecting a
// change to it. See apps/review-desktop/UPSTREAM.

import assert from "node:assert/strict";
import test from "node:test";

import { ConfigurationModelParser } from "../platform/configuration/common/configurationModels.js";
import {
  ConfigurationScope,
  Extensions as ConfigurationExtensions,
  type IConfigurationRegistry,
} from "../platform/configuration/common/configurationRegistry.js";
import { NullLogService } from "../platform/log/common/log.js";
import { Registry } from "../platform/registry/common/platform.js";

Registry.as<IConfigurationRegistry>(
  ConfigurationExtensions.Configuration,
).registerConfiguration({
  id: "reviewTrustFilterFixture",
  type: "object",
  properties: {
    "reviewTrustFixture.restricted": {
      type: "string",
      restricted: true,
      scope: ConfigurationScope.RESOURCE,
    },
    "reviewTrustFixture.safe": {
      type: "string",
      scope: ConfigurationScope.RESOURCE,
    },
    "reviewTrustFixture.object": {
      type: "object",
      scope: ConfigurationScope.RESOURCE,
    },
  },
});

function parseUntrusted(content: object) {
  const parser = new ConfigurationModelParser("test", new NullLogService());
  parser.parse(JSON.stringify(content), { skipRestricted: true });
  return parser;
}

test("filters a restricted setting written as a dotted key", () => {
  const parsed = parseUntrusted({
    "reviewTrustFixture.restricted": "attacker",
    "reviewTrustFixture.safe": "kept",
  });

  assert.equal(
    parsed.configurationModel.getValue("reviewTrustFixture.restricted"),
    undefined,
  );
  assert.equal(
    parsed.configurationModel.getValue("reviewTrustFixture.safe"),
    "kept",
  );
  assert.deepEqual(parsed.restrictedConfigurations, [
    "reviewTrustFixture.restricted",
  ]);
});

test("filters the same setting written as a nested object", () => {
  const parsed = parseUntrusted({
    reviewTrustFixture: { restricted: "attacker", safe: "kept" },
  });

  assert.equal(
    parsed.configurationModel.getValue("reviewTrustFixture.restricted"),
    undefined,
  );
  assert.equal(
    parsed.configurationModel.getValue("reviewTrustFixture.safe"),
    "kept",
  );
  assert.deepEqual(parsed.restrictedConfigurations, [
    "reviewTrustFixture.restricted",
  ]);
});

test("leaves an object-valued setting intact", () => {
  const parsed = parseUntrusted({
    "reviewTrustFixture.object": { a: 1, b: { c: 2 } },
  });

  assert.deepEqual(
    parsed.configurationModel.getValue("reviewTrustFixture.object"),
    { a: 1, b: { c: 2 } },
  );
});

test("leaves unregistered nested values reachable", () => {
  const parsed = parseUntrusted({ unregistered: { deep: { value: 5 } } });

  assert.equal(
    parsed.configurationModel.getValue("unregistered.deep.value"),
    5,
  );
});
