#!/usr/bin/env node
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const entryPoint = resolve(__dirname, '../src/cli/index.ts');
const tsxBinary = resolve(__dirname, '../node_modules/.bin/tsx.cmd');

const child = spawn(tsxBinary, [
  entryPoint,
  ...process.argv.slice(2)
], {
  stdio: 'inherit',
  shell: true
});

child.on('exit', (code) => {
  process.exit(code || 0);
});
