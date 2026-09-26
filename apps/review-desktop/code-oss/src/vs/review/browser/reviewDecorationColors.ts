/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from "../../nls.js";
import { registerColor } from "../../platform/theme/common/colorRegistry.js";

// The Git extension is not shipped; Review and the source window's file tree
// use its decoration colors.
registerColor(
  "gitDecoration.addedResourceForeground",
  {
    light: "#587c0c",
    dark: "#81b88b",
    hcDark: "#a1e3ad",
    hcLight: "#374e06",
  },
  localize("review.gitDecoration.added", "Color for added file resources."),
);
registerColor(
  "gitDecoration.modifiedResourceForeground",
  {
    light: "#895503",
    dark: "#E2C08D",
    hcDark: "#E2C08D",
    hcLight: "#895503",
  },
  localize("review.gitDecoration.modified", "Color for modified file resources."),
);
registerColor(
  "gitDecoration.deletedResourceForeground",
  {
    light: "#ad0707",
    dark: "#c74e39",
    hcDark: "#c74e39",
    hcLight: "#ad0707",
  },
  localize("review.gitDecoration.deleted", "Color for deleted file resources."),
);
registerColor(
  "gitDecoration.renamedResourceForeground",
  {
    light: "#007100",
    dark: "#73C991",
    hcDark: "#73C991",
    hcLight: "#007100",
  },
  localize("review.gitDecoration.renamed", "Color for renamed file resources."),
);
