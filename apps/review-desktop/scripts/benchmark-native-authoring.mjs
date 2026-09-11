/** Compare production installs. Benchmark-only exports are copied beside the
 * installed chunks; no source loader, authored bundler or test bypass is added
 * to the native runtime. Run via native-authoring-e2e.mjs --baseline-runtime. */
import assert from "node:assert/strict";
import { execFile, fork } from "node:child_process";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);

if (process.argv[2] === "--child") {
  const entry = await import(pathToFileURL(process.argv[3]).href);
  process.on("message", async ({ id, input, cli }) => {
    try {
      const started = performance.now();

      if (cli) {
        let output = "";

        const stream = new Writable({
          write(chunk, _encoding, done) {
            output += chunk;
            done();
          },
        });

        const code = await entry.runProgressiveReviewCli({
          argv: ["publish", "--review", cli.uuid, "--json"],
          cwd: cli.cwd,
          env: process.env,
          stdout: stream,
          stderr: stream,
        });

        assert.equal(code, 0, output);
      } else {
        const evidence = input.evidence
          ? {
              prepareEvidence: async () => input.evidence,
              resolveChangedLines: async () => ({
                added: new Set([1]),
                deleted: new Set([1]),
              }),
            }
          : {};

        let result;

        if (entry.buildReviewDocument)
          result = await entry.buildReviewDocument({
            reviewPath: input.reviewPath,
            ranges: input.evidence ? "validate" : "skip",
            ...evidence,
          });
        else {
          const compiled = await entry.compileReviewDocumentBundle({
            reviewPath: input.reviewPath,
            reviewRootPath: path.dirname(input.reviewPath),
            reviewDocumentsDir: path.join(
              path.dirname(input.reviewPath),
              ".review-documents",
            ),
            routePath: "/",
          });

          assert.deepEqual(compiled.diagnostics, []);
          assert.ok(compiled.bundle);
          result = await entry.evaluateReviewDocumentBundleForPublish({
            bundleCode: compiled.bundle.code,
            reviewDir: path.dirname(input.reviewPath),
            ranges: input.evidence ? "validate" : "skip",
            validateRanges: Boolean(input.evidence),
            ...evidence,
          });
        }

        assert.deepEqual(result.diagnostics ?? [], []);
        assert.deepEqual(result.errors, []);
        assert.ok(result.document);
      }

      process.send({ id, ms: performance.now() - started });
    } catch (error) {
      process.send({ id, error: error.stack });
    }
  });
  process.send({ ready: true });
}

async function expose(runtime) {
  const dist = path.join(runtime, "dist");
  const names = await readdir(dist);

  for (const name of names.filter((name) => /^cli-runner-.*\.js$/.test(name))) {
    const source = await readFile(path.join(dist, name), "utf8");
    const entry = path.join(dist, `.benchmark-${process.pid}.mjs`);
    // The old scanner has an unrelated buildReviewDocument function too.
    const native = !source.includes("function compileReviewDocumentBundle(");
    assert.ok(
      source.includes(
        native
          ? "function buildReviewDocument("
          : "function compileReviewDocumentBundle(",
      ),
    );
    await writeFile(
      entry,
      source +
        (native
          ? "\nexport {buildReviewDocument};\n"
          : "\nexport {compileReviewDocumentBundle, evaluateReviewDocumentBundleForPublish};\n"),
    );

    return entry;
  }

  throw new Error(`No installed CLI chunk in ${runtime}`);
}

function child(entry, env) {
  const instance = fork(import.meta.filename, ["--child", entry], {
    env,
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    execArgv: [],
  });

  let sequence = 0;
  let stderr = "";
  instance.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-8000);
  });
  const pending = new Map();
  let ready;

  const started = new Promise((resolve) => {
    ready = resolve;
  });

  instance.on("message", (message) => {
    if (message.ready) {
      ready();

      return;
    }

    const request = pending.get(message.id);
    pending.delete(message.id);

    if (message.error) request.reject(new Error(message.error));
    else request.resolve(message.ms);
  });
  instance.on("exit", (code) => {
    for (const request of pending.values())
      request.reject(new Error(`Benchmark child exited ${code}: ${stderr}`));
  });

  return {
    async run(input) {
      await started;

      return new Promise((resolve, reject) => {
        const id = ++sequence;
        pending.set(id, { resolve, reject });
        instance.send({ id, ...input });
      });
    },
    async close() {
      if (instance.exitCode !== null) return;
      const exited = new Promise((resolve) => instance.once("exit", resolve));
      instance.kill();
      await exited;
    },
  };
}

function summary(samples) {
  const sorted = [...samples].sort((a, b) => a - b);

  return {
    median:
      (sorted[Math.floor((sorted.length - 1) / 2)] +
        sorted[Math.floor(sorted.length / 2)]) /
      2,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    samples,
  };
}

export async function benchmark({
  runtime,
  baselineRuntime,
  cases,
  env,
  output,
  resumeFrom,
}) {
  const report = {
    node: process.version,
    runtime,
    baselineRuntime,
    warmSamples: 30,
    coldSamples: 20,
    rows: [],
  };

  if (resumeFrom) {
    const previous = JSON.parse(await readFile(resumeFrom, "utf8"));

    for (const key of [
      "node",
      "runtime",
      "baselineRuntime",
      "warmSamples",
      "coldSamples",
    ])
      assert.equal(previous[key], report[key], `Resume mismatch: ${key}`);
    const keys = new Set();

    for (const row of previous.rows) {
      const fixture = cases.find((candidate) => candidate.name === row.fixture);
      assert.ok(fixture, `Unknown resume fixture: ${row.fixture}`);
      assert.ok(
        row.operation === "builder" || (row.operation === "cli" && fixture.cli),
      );
      assert.ok(row.mode === "warm" || row.mode === "cold");
      const key = `${row.fixture}/${row.operation}/${row.mode}`;
      assert.ok(!keys.has(key), `Duplicate resume row: ${key}`);
      keys.add(key);

      for (const which of ["old", "native"]) {
        assert.equal(
          row[which].samples.length,
          row.mode === "warm" ? report.warmSamples : report.coldSamples,
        );
        assert.ok(
          row[which].samples.every(
            (sample) => Number.isFinite(sample) && sample > 0,
          ),
        );
        assert.deepEqual(row[which], summary(row[which].samples));
      }

      assert.equal(row.medianRatio, row.native.median / row.old.median);
      assert.equal(row.p95Ratio, row.native.p95 / row.old.p95);
      assert.equal(row.pass, row.medianRatio <= 1.05 && row.p95Ratio <= 1.1);
    }

    // Keep every completed row, including failures; only incomplete rows rerun.
    report.rows = previous.rows;
    report.resumedFrom = path.resolve(resumeFrom);
    await writeFile(output, JSON.stringify(report, null, 2));
  }

  const entries = {
    old: await expose(baselineRuntime),
    native: await expose(runtime),
  };

  try {
    for (const fixture of cases)
      for (const operation of ["builder", ...(fixture.cli ? ["cli"] : [])])
        for (const mode of ["warm", "cold"]) {
          if (
            report.rows.some(
              (row) =>
                row.fixture === fixture.name &&
                row.operation === operation &&
                row.mode === mode,
            )
          )
            continue;
          const samples = { old: [], native: [] };

          const processes =
            mode === "warm"
              ? {
                  old: child(entries.old, env),
                  native: child(entries.native, env),
                }
              : null;

          const input =
            operation === "cli"
              ? { cli: fixture.cli }
              : { input: fixture.input };

          try {
            if (processes)
              for (let index = 0; index < 3; index++)
                for (const which of index % 2
                  ? ["native", "old"]
                  : ["old", "native"])
                  await processes[which].run(input);
            const count = mode === "warm" ? 30 : 20;

            for (let index = 0; index < count; index++)
              for (const which of index % 2
                ? ["native", "old"]
                : ["old", "native"]) {
                let ms;

                if (processes) ms = await processes[which].run(input);
                else {
                  const started = performance.now();

                  if (operation === "cli")
                    await exec(
                      process.execPath,
                      [
                        path.join(
                          which === "native" ? runtime : baselineRuntime,
                          "dist/cli.js",
                        ),
                        "publish",
                        "--review",
                        fixture.cli.uuid,
                        "--json",
                      ],
                      {
                        cwd: fixture.cli.cwd,
                        env,
                        timeout: 60000,
                        maxBuffer: 8 * 1024 * 1024,
                      },
                    );
                  else {
                    const isolated = child(entries[which], env);

                    try {
                      await isolated.run(input);
                    } finally {
                      await isolated.close();
                    }
                  }

                  ms = performance.now() - started;
                }

                samples[which].push(ms);
              }
          } finally {
            if (processes) {
              await processes.old.close();
              await processes.native.close();
            }
          }

          const old = summary(samples.old),
            native = summary(samples.native);

          const row = {
            fixture: fixture.name,
            operation,
            mode,
            old,
            native,
            medianRatio: native.median / old.median,
            p95Ratio: native.p95 / old.p95,
          };

          row.pass = row.medianRatio <= 1.05 && row.p95Ratio <= 1.1;
          report.rows.push(row);
          await writeFile(output, JSON.stringify(report, null, 2));
          console.log(
            JSON.stringify({
              ...row,
              old: { median: old.median, p95: old.p95 },
              native: { median: native.median, p95: native.p95 },
            }),
          );
        }
  } finally {
    await Promise.all(
      Object.values(entries).map((entry) => rm(entry, { force: true })),
    );
  }

  report.pass = report.rows.every((row) => row.pass);
  await writeFile(output, JSON.stringify(report, null, 2));

  return report;
}
