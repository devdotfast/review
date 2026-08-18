import { beforeEach, describe, expect, it, vi } from "vitest";

const localVcs = vi.hoisted(() => ({
  detectLocalVcs:
    vi.fn<
      (rootPath: string) => Promise<{ kind: "jj"; rootPath: string } | null>
    >(),
  git: vi.fn<
    (
      rootPath: string,
      args: string[],
      options?: { allowFailure?: boolean },
    ) => Promise<{ ok: boolean; stdout: string; stderr: string }>
  >(),
}));

vi.mock("@dev.fast/local-vcs", () => localVcs);

import {
  deleteReviewSourceHeadRef,
  reviewSourceHeadRef,
} from "./review-source-ref";

const uuid = "3b241101-e2bb-4255-8caf-4136c566a962";
const ref = reviewSourceHeadRef(uuid);

describe("review source head ref failures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localVcs.detectLocalVcs.mockResolvedValue({
      kind: "jj",
      rootPath: "/repo",
    });
  });

  it("surfaces a failed source head ref deletion", async () => {
    localVcs.git.mockImplementation(
      async (
        _rootPath: string,
        _args: string[],
        options?: { allowFailure?: boolean },
      ) => {
        if (options?.allowFailure) {
          return { ok: false, stdout: "", stderr: "delete failed" };
        }
        throw new Error("delete failed");
      },
    );

    await expect(deleteReviewSourceHeadRef("/repo", ref)).rejects.toThrow(
      "delete failed",
    );
  });
});
