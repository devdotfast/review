import type { Writable } from "node:stream";

import {
  REVIEW_INSTANCE_ENV,
  clearDefaultReviewInstance,
  readDefaultReviewInstance,
  selectReviewInstance,
  writeDefaultReviewInstance,
} from "./desktop-discovery";

interface ReviewInstancesInput {
  env: NodeJS.ProcessEnv;
  stdout: Writable;
  stderr: Writable;
  json?: boolean;
}

export async function listReviewInstancesCommand(input: ReviewInstancesInput) {
  const selection = await selectReviewInstance({
    env: input.env,
    warn: (message) => input.stderr.write(`${message}\n`),
  });

  const defaultKey = await readDefaultReviewInstance(input.env);

  const rows = selection.instances.map(({ key, discovery, healthy }) => ({
    key,
    channel: discovery.channel ?? null,
    state: healthy ? "running" : "stopped",
    version: discovery.appVersion ?? null,
    url: discovery.url,
    checkout: discovery.checkout ?? null,
    selected: key === selection.key,
    default: key === defaultKey,
  }));

  if (input.json) {
    input.stdout.write(
      `${JSON.stringify({ event: "instances", selected: selection.key, selectedBy: selection.source, default: defaultKey ?? null, instances: rows })}\n`,
    );

    return;
  }

  const table = [
    ["", "KEY", "CHANNEL", "STATE", "VERSION", "URL", "CHECKOUT"],
    ...rows.map((row) => [
      row.selected ? "*" : "",
      row.key,
      row.channel ?? "",
      row.state,
      row.version ?? "",
      row.url,
      row.checkout ?? "",
    ]),
  ];

  const widths = table[0]!.map((_, column) =>
    Math.max(...table.map((row) => row[column]!.length)),
  );

  for (const row of table)
    input.stdout.write(
      `${row
        .map((cell, column) => cell.padEnd(widths[column]!))
        .join("  ")
        .trimEnd()}\n`,
    );

  input.stdout.write(
    `\nSelected: ${selection.key} (${describeSource(selection.source)}).${selection.instance ? "" : " It has not started on this machine."}\n`,
  );
}

export async function useReviewInstance(
  key: string,
  input: ReviewInstancesInput,
) {
  await writeDefaultReviewInstance(key, input.env);

  input.stdout.write(
    input.json
      ? `${JSON.stringify({ event: "instances.use", default: key })}\n`
      : `Default instance: ${key}\nFor this shell only: export ${REVIEW_INSTANCE_ENV}=${key}\n`,
  );
}

export async function clearReviewInstance(input: ReviewInstancesInput) {
  await clearDefaultReviewInstance(input.env);

  input.stdout.write(
    input.json
      ? `${JSON.stringify({ event: "instances.clear" })}\n`
      : "Cleared the default instance.\n",
  );
}

function describeSource(
  source: Awaited<ReturnType<typeof selectReviewInstance>>["source"],
) {
  return {
    env: `from ${REVIEW_INSTANCE_ENV}`,
    default: "the machine default",
    "only-running": "the only one running",
    fallback: "no selection, so stable",
  }[source];
}
