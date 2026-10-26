#!/usr/bin/env node
import { main } from '../src/commands/index.js';

main(process.argv.slice(2)).then(
  code => { process.exitCode = code; },
  e => { process.stderr.write(`error: ${e.message}\n`); process.exitCode = 2; },
);
