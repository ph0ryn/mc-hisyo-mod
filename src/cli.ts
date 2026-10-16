#!/usr/bin/env node
import { parseArgs } from "node:util";

const usage = `Usage: ai-director [--help]

Minecraft AI Director

Options:
  --help  Show usage without connecting to Minecraft or Pi.

The game bridge is not available in this development stage.
`;

try {
  parseArgs({ options: { help: { type: "boolean" } }, allowPositionals: false });
  process.stdout.write(usage);
} catch (error) {
  if (!(error instanceof Error)) throw error;
  process.stderr.write(`${error.message}\nRun ai-director --help for usage.\n`);
  process.exitCode = 1;
}
