import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { collectSoftwareMapCoverageErrors } from "./software-map-coverage-validation";
import { defineSoftwareMap } from "./software-map-model";

describe("collectSoftwareMapCoverageErrors", () => {
  it("errors when an exact coverage file is missing from tracked files", () => {
    const model = defineSoftwareMap({
      systems: {
        product: {
          containers: {
            web: {
              components: {
                shell: {
                  coverage: { files: ["src/missing.ts"] },
                },
              },
            },
          },
        },
      },
    });

    expect(
      collectSoftwareMapCoverageErrors({
        rootPath: "/repo",
        model,
        listFiles: () => ["src/app.ts"],
      }),
    ).toEqual([
      'SoftwareMap coverage: "product.web.shell" claims file "src/missing.ts" missing from the tracked files.',
    ]);
  });

  it("names an explicit frame of reference in missing-file and glob errors", () => {
    const model = defineSoftwareMap({
      systems: {
        product: {
          coverage: {
            files: ["src/missing.ts"],
            globs: ["src/profiling/**"],
          },
        },
      },
    });

    expect(
      collectSoftwareMapCoverageErrors({
        rootPath: "/repo",
        model,
        listFiles: () => ["src/app.ts"],
        pathsFrame: "tree of abc123def456",
      }),
    ).toEqual([
      'SoftwareMap coverage: "product" claims file "src/missing.ts" missing from tree of abc123def456.',
      'SoftwareMap coverage: "product" glob "src/profiling/**" matches nothing in tree of abc123def456.',
    ]);
  });

  it("errors when a coverage glob matches no tracked files", () => {
    const model = defineSoftwareMap({
      systems: {
        product: {
          containers: {
            web: {
              components: {
                shell: {
                  coverage: { globs: ["src/profiling/**"] },
                },
              },
            },
          },
        },
      },
    });

    expect(
      collectSoftwareMapCoverageErrors({
        rootPath: "/repo",
        model,
        listFiles: () => ["src/app.ts"],
      }),
    ).toEqual([
      'SoftwareMap coverage: "product.web.shell" glob "src/profiling/**" matches nothing in the tracked files.',
    ]);
  });

  it("errors when a coverage range extends beyond the claimed file", () => {
    const model = defineSoftwareMap({
      systems: {
        product: {
          containers: {
            web: {
              components: {
                shell: {
                  coverage: {
                    files: [
                      {
                        path: "src/app.ts",
                        ranges: [{ fromLine: 2, toLine: 10 }],
                      },
                    ],
                  },
                },
              },
            },
          },
        },
      },
    });

    expect(
      collectSoftwareMapCoverageErrors({
        rootPath: "/repo",
        model,
        listFiles: () => ["src/app.ts"],
        readFile: () => ["line 1", "line 2", "line 3"].join("\n"),
      }),
    ).toEqual([
      'SoftwareMap coverage: "product.web.shell" range 2-10 exceeds "src/app.ts" length (3 lines).',
    ]);
  });

  it("accepts exact files, in-bounds ranges, and matching globs", () => {
    const model = defineSoftwareMap({
      systems: {
        product: {
          containers: {
            web: {
              components: {
                shell: {
                  coverage: {
                    files: [
                      {
                        path: "./src/app.ts",
                        ranges: [{ fromLine: 1, toLine: 2 }],
                      },
                    ],
                    globs: ["src/components/**"],
                  },
                },
              },
            },
          },
        },
      },
    });

    expect(
      collectSoftwareMapCoverageErrors({
        rootPath: "/repo",
        model,
        listFiles: () => ["src/app.ts", "src/components/Button.tsx"],
        readFile: () => ["line 1", "line 2"].join("\n"),
      }),
    ).toEqual([]);
  });

  it("errors when sibling components claim the same file", () => {
    const model = defineSoftwareMap({
      systems: {
        product: {
          containers: {
            web: {
              components: {
                left: {
                  coverage: { files: ["src/shared.ts"] },
                },
                right: {
                  coverage: { files: ["src/shared.ts"] },
                },
              },
            },
          },
        },
      },
    });

    expect(
      collectSoftwareMapCoverageErrors({
        rootPath: "/repo",
        model,
        listFiles: () => ["src/shared.ts"],
      }),
    ).toEqual([
      'SoftwareMap coverage: "product.web.left" and "product.web.right" overlap on file "src/shared.ts" from file "src/shared.ts" and file "src/shared.ts"; non-nested elements must not share coverage.',
    ]);
  });

  it("errors when sibling components claim the same glob", () => {
    const model = defineSoftwareMap({
      systems: {
        product: {
          containers: {
            web: {
              components: {
                left: {
                  coverage: { globs: ["src/**"] },
                },
                right: {
                  coverage: { globs: ["src/**"] },
                },
              },
            },
          },
        },
      },
    });

    expect(
      collectSoftwareMapCoverageErrors({
        rootPath: "/repo",
        model,
        listFiles: () => ["src/shared.ts"],
      }),
    ).toEqual([
      'SoftwareMap coverage: "product.web.left" and "product.web.right" overlap on file "src/shared.ts" from glob "src/**" and glob "src/**"; non-nested elements must not share coverage.',
    ]);
  });

  it("errors when a sibling file claim overlaps another sibling's glob", () => {
    const model = defineSoftwareMap({
      systems: {
        product: {
          containers: {
            web: {
              components: {
                exact: {
                  coverage: { files: ["src/shared.ts"] },
                },
                pattern: {
                  coverage: { globs: ["src/**"] },
                },
              },
            },
          },
        },
      },
    });

    expect(
      collectSoftwareMapCoverageErrors({
        rootPath: "/repo",
        model,
        listFiles: () => ["src/shared.ts"],
      }),
    ).toEqual([
      'SoftwareMap coverage: "product.web.exact" and "product.web.pattern" overlap on file "src/shared.ts" from file "src/shared.ts" and glob "src/**"; non-nested elements must not share coverage.',
    ]);
  });

  it("errors when non-nested coverage overlaps without being identical", () => {
    const model = defineSoftwareMap({
      systems: {
        product: {
          containers: {
            web: {
              components: {
                exact: {
                  coverage: { files: ["src/shared.ts"] },
                },
                pattern: {
                  coverage: { globs: ["src/**"] },
                },
              },
            },
          },
        },
      },
    });

    const input = {
      rootPath: "/repo",
      model,
      listFiles: () => ["src/shared.ts", "src/unique.ts"],
    };

    expect(collectSoftwareMapCoverageErrors(input)).toEqual([
      'SoftwareMap coverage: "product.web.exact" and "product.web.pattern" overlap on file "src/shared.ts" from file "src/shared.ts" and glob "src/**"; non-nested elements must not share coverage.',
    ]);
  });

  it("errors when unrelated systems have identical coverage", () => {
    const model = defineSoftwareMap({
      systems: {
        alpha: {
          coverage: { files: ["src/shared.ts"] },
        },
        beta: {
          coverage: { files: ["src/shared.ts"] },
        },
      },
    });

    expect(
      collectSoftwareMapCoverageErrors({
        rootPath: "/repo",
        model,
        listFiles: () => ["src/shared.ts"],
      }),
    ).toEqual([
      'SoftwareMap coverage: "alpha" and "beta" overlap on file "src/shared.ts" from file "src/shared.ts" and file "src/shared.ts"; non-nested elements must not share coverage.',
    ]);
  });

  it("accepts disjoint ranges in the same file for sibling components", () => {
    const model = defineSoftwareMap({
      systems: {
        product: {
          containers: {
            web: {
              components: {
                firstHalf: {
                  coverage: {
                    files: [
                      {
                        path: "src/shared.ts",
                        ranges: [{ fromLine: 1, toLine: 5 }],
                      },
                    ],
                  },
                },
                secondHalf: {
                  coverage: {
                    files: [
                      {
                        path: "src/shared.ts",
                        ranges: [{ fromLine: 6, toLine: 10 }],
                      },
                    ],
                  },
                },
              },
            },
          },
        },
      },
    });
    const input = {
      rootPath: "/repo",
      model,
      listFiles: () => ["src/shared.ts"],
      readFile: () =>
        Array.from({ length: 10 }, (_, index) => `${index}`).join("\n"),
    };

    expect(collectSoftwareMapCoverageErrors(input)).toEqual([]);
  });

  it("accepts identical coverage on an ancestor and descendant", () => {
    const model = defineSoftwareMap({
      systems: {
        product: {
          coverage: { files: ["src/shared.ts"] },
          containers: {
            web: {
              coverage: { files: ["src/shared.ts"] },
            },
          },
        },
      },
    });
    const input = {
      rootPath: "/repo",
      model,
      listFiles: () => ["src/shared.ts"],
    };

    expect(collectSoftwareMapCoverageErrors(input)).toEqual([]);
  });

  it("uses jj tracked files when no test file lister is injected", async () => {
    if (!commandExists("jj")) return;

    const rootPath = await mkdtemp(path.join(tmpdir(), "map-coverage-jj-"));
    execFileSync("jj", ["git", "init"], {
      cwd: rootPath,
      stdio: ["ignore", "ignore", "ignore"],
    });
    mkdirSync(path.join(rootPath, "src"));
    writeFileSync(
      path.join(rootPath, "src/app.ts"),
      ["line 1", "line 2", "line 3"].join("\n"),
    );
    expect(
      execFileSync("git", ["ls-files"], { cwd: rootPath, encoding: "utf8" }),
    ).toBe("");

    const model = defineSoftwareMap({
      systems: {
        product: {
          containers: {
            web: {
              components: {
                shell: {
                  coverage: {
                    files: [
                      {
                        path: "src/app.ts",
                        ranges: [{ fromLine: 1, toLine: 3 }],
                      },
                    ],
                  },
                },
              },
            },
          },
        },
      },
    });

    expect(
      collectSoftwareMapCoverageErrors({
        rootPath,
        model,
      }),
    ).toEqual([]);
  });

  it("errors when child coverage is not contained by parent coverage", () => {
    const model = defineSoftwareMap({
      systems: {
        product: {
          coverage: { globs: ["packages/**/src/**"] },
          containers: {
            review: {
              coverage: { globs: ["packages/review/app/lib/**"] },
            },
          },
        },
      },
    });

    expect(
      collectSoftwareMapCoverageErrors({
        rootPath: "/repo",
        model,
        listFiles: () => [
          "packages/review/src/runtime.ts",
          "packages/review/app/lib/review-api.ts",
        ],
      }),
    ).toEqual([
      'SoftwareMap coverage: "product" must cover child "product.review" file "packages/review/app/lib/review-api.ts" from child glob "packages/review/app/lib/**".',
    ]);
  });

  it("accepts child coverage contained by parent file ranges", () => {
    const model = defineSoftwareMap({
      systems: {
        product: {
          coverage: {
            files: [
              {
                path: "src/app.ts",
                ranges: [
                  { fromLine: 1, toLine: 5 },
                  { fromLine: 6, toLine: 10 },
                ],
              },
            ],
          },
          containers: {
            web: {
              coverage: {
                files: [
                  {
                    path: "src/app.ts",
                    ranges: [{ fromLine: 3, toLine: 8 }],
                  },
                ],
              },
            },
          },
        },
      },
    });

    expect(
      collectSoftwareMapCoverageErrors({
        rootPath: "/repo",
        model,
        listFiles: () => ["src/app.ts"],
        readFile: () =>
          Array.from({ length: 10 }, (_, index) => `${index}`).join("\n"),
      }),
    ).toEqual([]);
  });
});

describe("collectSoftwareMapCoverageErrors — line counting", () => {
  function runCoverage(
    content: string,
    range: { fromLine: number; toLine: number },
  ): string[] {
    const model = defineSoftwareMap({
      systems: {
        product: {
          containers: {
            web: {
              components: {
                shell: {
                  coverage: {
                    files: [{ path: "src/app.ts", ranges: [range] }],
                  },
                },
              },
            },
          },
        },
      },
    });
    return collectSoftwareMapCoverageErrors({
      rootPath: "/repo",
      model,
      listFiles: () => ["src/app.ts"],
      readFile: () => content,
    });
  }

  it("still rejects out-of-range ranges when content has no trailing newline", () => {
    expect(
      runCoverage("line 1\nline 2\nline 3", { fromLine: 2, toLine: 10 }),
    ).toEqual([
      'SoftwareMap coverage: "product.web.shell" range 2-10 exceeds "src/app.ts" length (3 lines).',
    ]);
  });

  it("rejects a range one line past EOF for newline-terminated content", () => {
    // "a\nb\nc\n" has 3 real content lines (the shape of every production
    // file read via `git cat-file` / readFileSync); toLine 4 must be rejected.
    expect(runCoverage("a\nb\nc\n", { fromLine: 1, toLine: 4 })).toEqual([
      'SoftwareMap coverage: "product.web.shell" range 1-4 exceeds "src/app.ts" length (3 lines).',
    ]);
  });

  it("rejects a range one line past EOF for a single-line newline-terminated file", () => {
    expect(runCoverage("a\n", { fromLine: 1, toLine: 2 })).toEqual([
      'SoftwareMap coverage: "product.web.shell" range 1-2 exceeds "src/app.ts" length (1 lines).',
    ]);
  });

  it("accepts a range ending exactly at EOF for newline-terminated content", () => {
    expect(runCoverage("a\nb\nc\n", { fromLine: 1, toLine: 3 })).toEqual([]);
  });

  it("rejects a range more than one line past EOF for newline-terminated content", () => {
    expect(runCoverage("a\nb\nc\n", { fromLine: 1, toLine: 5 })).toEqual([
      'SoftwareMap coverage: "product.web.shell" range 1-5 exceeds "src/app.ts" length (3 lines).',
    ]);
  });

  it("counts CRLF-terminated content as one line per record", () => {
    expect(runCoverage("a\nb\nc\r\n", { fromLine: 1, toLine: 4 })).toEqual([
      'SoftwareMap coverage: "product.web.shell" range 1-4 exceeds "src/app.ts" length (3 lines).',
    ]);
  });

  it("counts old-Mac CR-terminated content as one line per record", () => {
    expect(runCoverage("a\nb\nc\r", { fromLine: 1, toLine: 4 })).toEqual([
      'SoftwareMap coverage: "product.web.shell" range 1-4 exceeds "src/app.ts" length (3 lines).',
    ]);
  });

  it("counts a genuine trailing blank line as a real content line", () => {
    // "a\nb\nc\n\n" has 4 content lines (a, b, c, and a real empty 4th line):
    // only one trailing terminator is stripped, so the final blank line counts.
    expect(runCoverage("a\nb\nc\n\n", { fromLine: 1, toLine: 5 })).toEqual([
      'SoftwareMap coverage: "product.web.shell" range 1-5 exceeds "src/app.ts" length (4 lines).',
    ]);
    expect(runCoverage("a\nb\nc\n\n", { fromLine: 1, toLine: 4 })).toEqual([]);
  });

  it("rejects any range on an empty file and reports zero lines", () => {
    expect(runCoverage("", { fromLine: 1, toLine: 1 })).toEqual([
      'SoftwareMap coverage: "product.web.shell" range 1-1 exceeds "src/app.ts" length (0 lines).',
    ]);
  });

  it("rejects the maintenance-drift case (stale toLine == new realLineCount + 1)", () => {
    // A file that lost its final content line: was N lines, now N-1, still
    // newline-terminated. A stale toLine of N must now be rejected by the gate.
    expect(runCoverage("a\nb\nc\n", { fromLine: 3, toLine: 4 })).toEqual([
      'SoftwareMap coverage: "product.web.shell" range 3-4 exceeds "src/app.ts" length (3 lines).',
    ]);
  });
});

function commandExists(command: string): boolean {
  try {
    execFileSync(command, ["--version"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}
