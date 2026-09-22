import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);

const marker = "<!-- dev-fast-review -->";

async function command(file, args, options) {
  let stdout;

  try {
    ({ stdout } = await exec(file, args, {
      maxBuffer: 16 * 1024 * 1024,
      ...options,
    }));
  } catch (error) {
    // JSON CLI failures are written to stdout; execFile's message only includes stderr.
    let result;

    try {
      result = JSON.parse(error.stdout);
    } catch {
      throw error;
    }

    if (
      typeof result?.error?.message === "string" &&
      result.error.message.trim()
    )
      throw new Error(`${file} ${args[0]} failed: ${result.error.message}`, {
        cause: error,
      });

    throw error;
  }

  return JSON.parse(stdout);
}

/** One bot comment per PR; workflow concurrency serializes runs of the same PR. */
export async function updateComment(
  { apiUrl, repository, number, head, url, token },
  send = fetch,
) {
  const request = async (route, method = "GET", body) => {
    const response = await send(`${apiUrl}/repos/${repository}${route}`, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (!response.ok)
      throw new Error(
        `PR comment request failed (${response.status}). The published link is available in the action outputs and job summary.`,
      );

    return response.json();
  };

  const pr = await request(`/pulls/${number}`);

  if (pr.head.sha !== head) return false;
  const body = `${marker}\n[Open the code review](<${url}>) · \`${head.slice(0, 12)}\`\n\nOpen this shared review in Review Desktop. Repository access is required to fetch its pinned source.`;

  for (let page = 1; ; page++) {
    const comments = await request(
      `/issues/${number}/comments?per_page=100&page=${page}`,
    );

    const previous = comments.find(
      (comment) =>
        comment.user?.login === "github-actions[bot]" &&
        comment.body?.startsWith(marker),
    );

    if (previous) {
      await request(`/issues/comments/${previous.id}`, "PATCH", { body });

      return true;
    }

    if (comments.length < 100) break;
  }

  await request(`/issues/${number}/comments`, "POST", { body });

  return true;
}

/** The workflow owns the harness. This runner supplies only lifecycle and result plumbing. */
export async function runWorkflow(env = process.env, send = fetch) {
  const cli = env.REVIEW_CLI || "review";
  const repo = path.resolve(env.REVIEW_REPOSITORY_PATH || ".");

  if (!env.REVIEW_BASE || !env.REVIEW_HEAD)
    throw new Error(
      "Supply explicit base and head revisions, or run on a pull_request event.",
    );

  if (!env.REVIEW_AUTHOR_COMMAND?.trim())
    throw new Error(
      "author-command is required; install your agent before this action.",
    );

  if (!env.DEV_REVIEW_SHARE_TOKEN?.trim())
    throw new Error(
      "share-token is required. Store a Review sharing token in a GitHub secret.",
    );

  if (!["true", "false"].includes(env.REVIEW_COMMENT ?? "true"))
    throw new Error("comment must be true or false.");
  const comment = (env.REVIEW_COMMENT ?? "true") === "true";

  const event = env.GITHUB_EVENT_PATH
    ? JSON.parse(await readFile(env.GITHUB_EVENT_PATH, "utf8"))
    : {};

  if (
    comment &&
    (!event.pull_request?.number ||
      !env.REVIEW_GITHUB_TOKEN ||
      !env.GITHUB_REPOSITORY)
  )
    throw new Error(
      "PR commenting needs a pull_request event and github-token; use comment: 'false' for other events.",
    );

  // This action invokes arbitrary agent commands with credentials, so fork code is not a supported execution context.
  if (
    event.pull_request &&
    event.pull_request.head.repo.full_name !==
      event.pull_request.base.repo.full_name
  )
    throw new Error(
      "Fork PR authoring must run in a separately approved, trusted workflow. This action does not run fork code with secrets.",
    );

  const directory = await mkdtemp(
    path.join(env.RUNNER_TEMP || tmpdir(), "review-action-"),
  );

  const runtimeEnv = {
    ...env,
    DEV_REVIEW_HOME: directory,
    DEV_REVIEW_SERVER_DIR: directory,
    DEV_FAST_REVIEW_CLI_NO_DELEGATE: "1",
    LC_ALL: "C",
  };

  delete runtimeEnv.DEV_REVIEW_SHARE_ORIGIN;

  if (env.REVIEW_SHARE_ORIGIN)
    runtimeEnv.DEV_REVIEW_SHARE_ORIGIN = env.REVIEW_SHARE_ORIGIN;

  if (env.REVIEW_GITHUB_TOKEN) {
    const askpass = path.join(directory, "git-askpass.sh");
    await writeFile(
      askpass,
      `#!/bin/sh
case "$1" in
  *github.com*Username*|*Username*github.com*) printf '%s\n' x-access-token ;;
  *github.com*Password*|*Password*github.com*) printf '%s\n' "$REVIEW_GITHUB_TOKEN" ;;
  *) exit 1 ;;
esac
`,
      { mode: 0o700 },
    );
    runtimeEnv.GIT_ASKPASS = askpass;
  }

  const controller = new AbortController();

  const server = spawn(
    cli,
    ["server", "start", "--authoring-mode", "batch", "--json"],
    { env: runtimeEnv, stdio: ["ignore", "ignore", "inherit"] },
  );

  const exited = new Promise((resolve) => {
    server.once("exit", resolve);
    server.once("error", resolve);
  });

  let agent;

  const stop = () => {
    controller.abort();

    if (agent?.pid && agent.exitCode === null && agent.signalCode === null) {
      try {
        process.kill(-agent.pid, "SIGTERM");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }

    server.kill("SIGTERM");
  };

  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);

  const api = (tool, input = {}) =>
    command(cli, ["api", tool, JSON.stringify(input)], {
      env: runtimeEnv,
      signal: controller.signal,
    });

  try {
    let ready = false;

    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        await command(cli, ["server", "status", "--json"], {
          env: runtimeEnv,
          signal: controller.signal,
        });
        ready = true;
        break;
      } catch {
        if (
          controller.signal.aborted ||
          server.exitCode !== null ||
          server.signalCode !== null ||
          !server.pid
        )
          throw new Error("Review server exited before readiness.");
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    if (!ready)
      throw new Error("Review server did not become ready within 60 seconds.");
    const registered = await api("review_register_repository", { path: repo });

    const pins = await api("review_resolve_pins", {
      repositoryId: registered.id,
      base: env.REVIEW_BASE,
      head: env.REVIEW_HEAD,
    });

    const promptPath = path.join(directory, "prompt.md");
    await writeFile(
      promptPath,
      `Use the dev-review-batch skill and the running batch Review server to author and commit exactly one review.\nCheckout: ${JSON.stringify(repo)}\nResolved pins: ${JSON.stringify(pins)}\nPR URL: ${JSON.stringify(event.pull_request?.html_url ?? null)}\nUse review api (or review mcp). Read review_capabilities and the tool schemas. Begin a draft, verify source evidence, write and validate it, then commit. Do not upload or post a comment; the action handles that after your command succeeds.\n\n${env.REVIEW_PROMPT || "Explain the change concisely with verified source evidence."}\n`,
    );

    const agentEnv = {
      ...runtimeEnv,
      REVIEW_PROMPT_FILE: promptPath,
      REVIEW_REPOSITORY_PATH: repo,
      REVIEW_BASE: pins.base,
      REVIEW_HEAD: pins.head,
      REVIEW_PINS_JSON: JSON.stringify(pins),
    };

    for (const key of ["DEV_REVIEW_SHARE_TOKEN", "REVIEW_GITHUB_TOKEN"])
      delete agentEnv[key];
    agent = spawn(
      "bash",
      ["-e", "-o", "pipefail", "-c", env.REVIEW_AUTHOR_COMMAND],
      { cwd: repo, env: agentEnv, stdio: "inherit", detached: true },
    );
    const [code] = await once(agent, "exit");

    if (code !== 0 || controller.signal.aborted)
      throw new Error(
        `Author command failed (${code}); no review was uploaded.`,
      );
    const reviews = await api("review_list");

    if (reviews.length !== 1)
      throw new Error(
        `Author must commit exactly one review in this run; found ${reviews.length}. No review was uploaded.`,
      );
    const review = reviews[0];

    if (
      review.target?.kind !== "commits" ||
      Object.keys(pins).some((key) => review.pins?.[key] !== pins[key]) ||
      !Number.isInteger(review.version) ||
      review.version < 0
    )
      throw new Error(
        "The committed review does not match the requested immutable comparison. No review was uploaded.",
      );

    const result = await command(
      cli,
      [
        "share",
        "--review",
        review.reviewId,
        "--version",
        String(review.version),
        "--request-id",
        randomUUID(),
        "--json",
        ...(env.REVIEW_PREVIEW === "true" ? ["--preview"] : []),
      ],
      { env: runtimeEnv, signal: controller.signal },
    );

    const link = new URL(result.url);

    if (
      link.protocol !== "https:" ||
      link.username ||
      link.password ||
      result.version !== review.version ||
      !result.shareId
    )
      throw new Error("Sharing returned an invalid result.");

    const outputs = {
      url: link.href,
      "review-id": review.reviewId,
      version: String(review.version),
      "share-id": result.shareId,
    };

    if (
      Object.values(outputs).some(
        // oxlint-disable-next-line anti-slop/no-runtime-typeof -- CLI JSON boundary: validate output fields before writing GitHub environment files.
        (value) => typeof value !== "string" || /[\r\n]/.test(value),
      )
    )
      throw new Error("Sharing returned invalid output fields.");

    if (env.GITHUB_OUTPUT)
      await appendFile(
        env.GITHUB_OUTPUT,
        Object.entries(outputs)
          .map(([key, value]) => `${key}=${value}\n`)
          .join(""),
      );

    if (env.GITHUB_STEP_SUMMARY)
      await appendFile(
        env.GITHUB_STEP_SUMMARY,
        `### Code review\n\n[Open the review](<${link.href}>) · \`${pins.head.slice(0, 12)}\`\n`,
      );

    if (comment)
      await updateComment(
        {
          apiUrl: env.GITHUB_API_URL || "https://api.github.com",
          repository: env.GITHUB_REPOSITORY,
          number: event.pull_request.number,
          head: pins.head,
          url: link.href,
          token: env.REVIEW_GITHUB_TOKEN,
        },
        send,
      );

    return outputs;
  } finally {
    stop();
    const force = setTimeout(() => server.kill("SIGKILL"), 5000);
    force.unref();
    await exited;
    clearTimeout(force);
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    await rm(directory, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await runWorkflow();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
