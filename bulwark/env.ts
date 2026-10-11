// Loads .env from the working directory, if present. Variables already set in
// the shell win, and empty values are dropped so "KEY=" means "not configured".

import { existsSync } from 'node:fs';

if (existsSync('.env')) {
  const before = new Set(Object.keys(process.env));
  process.loadEnvFile('.env');
  for (const [key, value] of Object.entries(process.env)) {
    if (!before.has(key) && value === '') delete process.env[key];
  }
}
