// Configuration: reads .env (if present) and environment variables. No dependencies.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadDotEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (!m || line.trim().startsWith('#')) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}
loadDotEnv();

const num = (name, fallback) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

export const config = {
  port: num('PORT', 3000),
  host: process.env.HOST || '0.0.0.0',
  dataDir: path.resolve(ROOT, process.env.DATA_DIR || './data'),
  publicDir: path.join(ROOT, 'public'),
  pointBudget: num('POINT_BUDGET', 1_500_000),
  demMaxCells: num('DEM_MAX_CELLS', 1536),
  workerMemoryMb: num('WORKER_MEMORY_MB', 3072),
  maxUploadBytes: num('MAX_UPLOAD_GB', 6) * 1024 ** 3,
  allowNetwork: process.env.ALLOW_NETWORK !== '0',
  admin: {
    email: process.env.ADMIN_EMAIL || '',
    password: process.env.ADMIN_PASSWORD || '',
    name: process.env.ADMIN_NAME || 'Admin',
  },
};

fs.mkdirSync(path.join(config.dataDir, 'trails'), { recursive: true });
