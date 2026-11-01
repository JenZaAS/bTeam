#!/usr/bin/env node
// Container health check: exit 0 if GET /healthz answers 200 (the source has been mirrored), else 1.
// Uses the same BTEAM_HOST and PORT as "bteam serve". No dependencies, no output on success.
import { healthUrl, checkHealth } from '../src/serve-options.js';

let ok = false;
try {
  ok = await checkHealth(healthUrl());
} catch (err) {
  console.error(`healthcheck: ${err.message}`);
}
process.exit(ok ? 0 : 1);
