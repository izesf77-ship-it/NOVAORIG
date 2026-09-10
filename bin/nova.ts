#!/usr/bin/env node
import { main } from '../src/cli/main.ts';

const code = await main(process.argv.slice(2));
process.exit(code);
