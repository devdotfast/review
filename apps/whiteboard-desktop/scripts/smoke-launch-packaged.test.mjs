import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { desktopResponds } from "./smoke-launch-packaged.mjs";

test("readiness requires this launch's authenticated, connected desktop", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "desktop-readiness-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let connected = false;
  let requests = 0;

  const server = createServer((req, res) => {
    requests++;

    if (req.url !== "/sessions-api/capabilities") {
      res.writeHead(404).end();
    } else if (req.headers["x-whiteboard-token"] !== "test-secret") {
      res.writeHead(401).end();
    } else {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ desktopAvailable: connected }));
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const file = path.join(root, "server.json");

  const record = {
    version: 3,
    instanceId: "smoke-test",
    serverPid: process.pid,
    startedAt: Date.now(),
    appPid: process.pid,
    token: "test-secret",
    url: `http://127.0.0.1:${server.address().port}`,
  };

  assert.equal(await desktopResponds(file, process.pid), false);
  await writeFile(file, "{");
  assert.equal(await desktopResponds(file, process.pid), false);
  await writeFile(file, JSON.stringify(record));
  assert.equal(await desktopResponds(file, process.pid + 1), false);
  assert.equal(requests, 0, "another launch must not be contacted");
  assert.equal(await desktopResponds(file, process.pid), false);
  connected = true;
  await writeFile(file, JSON.stringify({ ...record, token: "wrong-token" }));
  assert.equal(await desktopResponds(file, process.pid), false);
  await writeFile(file, JSON.stringify(record));
  assert.equal(await desktopResponds(file, process.pid), true);
});

test("an unresponsive server cannot stall the startup deadline", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "desktop-readiness-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const server = createServer(() => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const file = path.join(root, "server.json");
  await writeFile(
    file,
    JSON.stringify({
      version: 3,
      instanceId: "smoke-test",
      serverPid: process.pid,
      startedAt: Date.now(),
      appPid: process.pid,
      token: "test-secret",
      url: `http://127.0.0.1:${server.address().port}`,
    }),
  );
  assert.equal(await desktopResponds(file, process.pid, 50), false);
});
