import type { git } from "@dev.fast/local-vcs";
import { describe, expect, it } from "vitest";

import {
  deleteReviewSourceHeadRef,
  reviewSourceHeadRef,
} from "./review-source-ref";

const uuid = "3b241101-e2bb-4255-8caf-4136c566a962";
const ref = reviewSourceHeadRef(uuid);

describe("review source head ref failures", () => {
  it("surfaces a failed source head ref deletion", async () => {
    const failingGit: typeof git = async (_rootPath, _args, options) => {
      if (options?.allowFailure) {
        return { ok: false, stdout: "", stderr: "delete failed" };
      }
      throw new Error("delete failed");
    };

    await expect(
      deleteReviewSourceHeadRef("/repo", ref, failingGit),
    ).rejects.toThrow("delete failed");
  });
});
