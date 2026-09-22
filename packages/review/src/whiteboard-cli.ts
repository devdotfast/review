#!/usr/bin/env node

import { runCliBootstrap } from "./cli-bootstrap.js";

process.exitCode = await runCliBootstrap("whiteboard", import.meta.url);
