import assert from "node:assert/strict";
import test from "node:test";

import { errorHandler, setUnexpectedErrorHandler } from "../../base/common/errors.js";
import { FileOperationError, FileOperationResult } from "../../platform/files/common/files.js";
import { reportReviewUnifiedEditorError } from "./reviewUnifiedEditor.js";

test("missing source stays local while unexpected unified editor failures remain reported", () => {
  const previous = errorHandler.getUnexpectedErrorHandler();
  const reported: unknown[] = [];
  let unavailable = 0;
  setUnexpectedErrorHandler((error) => reported.push(error));
  try {
    reportReviewUnifiedEditorError(
      new FileOperationError("Pinned file missing", FileOperationResult.FILE_NOT_FOUND),
      () => { unavailable++; },
    );
    assert.equal(unavailable, 1);
    assert.deepEqual(reported, []);

    const unexpected = [
      new FileOperationError("Access denied", FileOperationResult.FILE_PERMISSION_DENIED),
      new Error("Unable to resolve nonexistent file"),
    ];
    for (const error of unexpected) {
      reportReviewUnifiedEditorError(error, () => { unavailable++; });
    }
    assert.equal(unavailable, 1);
    assert.deepEqual(reported, unexpected);
  } finally {
    setUnexpectedErrorHandler(previous);
  }
});
