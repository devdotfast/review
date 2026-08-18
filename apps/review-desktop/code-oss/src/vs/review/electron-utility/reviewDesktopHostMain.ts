/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { pathToFileURL } from "node:url";

const serverEntry = process.env["DEV_FAST_REVIEW_SERVER_ENTRY"];
if (!serverEntry) {
  throw new Error("DEV_FAST_REVIEW_SERVER_ENTRY is required.");
}

await import(pathToFileURL(serverEntry).href);
