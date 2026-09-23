#!/usr/bin/env node

import { runCliBootstrap } from "./cli-bootstrap.js";

process.exitCode = await runCliBootstrap(import.meta.url);
