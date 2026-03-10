#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';

function parseEnvFile(content) {
  const env = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;

    const [, key, rawValue] = match;
    let value = rawValue.trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    env[key] = value;
  }

  return env;
}

function loadBackendEnv(repoRoot) {
  const envPath = resolve(repoRoot, 'backend-api', '.env');
  if (!existsSync(envPath)) return;

  const fileContent = readFileSync(envPath, 'utf8');
  const parsed = parseEnvFile(fileContent);

  for (const [key, value] of Object.entries(parsed)) {
    process.env[key] = value;
  }
}

async function main() {
  const [scriptPath, ...scriptArgs] = process.argv.slice(2);

  if (!scriptPath) {
    console.error('Usage: node scripts/run-with-backend-env.mjs <script> [...args]');
    process.exit(1);
  }

  const repoRoot = process.cwd();
  loadBackendEnv(repoRoot);

  const child = spawn(process.execPath, [resolve(repoRoot, scriptPath), ...scriptArgs], {
    cwd: repoRoot,
    env: process.env,
    stdio: 'inherit',
  });

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

void main();
