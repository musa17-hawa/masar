// End-to-end self-test: starts a throwaway server, creates an admin, builds the synthetic phone-scan
// sample through the real pipeline and checks the report. Leaves your data folder untouched.
//   npm test
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from '../server/config.js';

const port = 3900 + Math.floor(Math.random() * 90);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'masar-test-'));
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, ALLOW_NETWORK: '0', ADMIN_EMAIL: '', ADMIN_PASSWORD: '' }, stdio: ['ignore', 'ignore', 'inherit'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let cookie = '';
const call = async (method, url, body) => {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Origin: base, Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
  const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${JSON.stringify(data)}`);
  return data;
};
const step = (label) => console.log(`  ok  ${label}`);
let failed = false;
try {
  for (let i = 0; ; i++) { try { await call('GET', '/api/health'); break; } catch (err) { if (i > 50) throw err; await sleep(100); } }
  step('server starts');
  await call('POST', '/api/setup', { name: 'Test', email: 'test@example.com', password: 'self-test-password' });
  step('first admin account');
  const { trail } = await call('POST', '/api/sample', { kind: 'phone' });
  let t = trail;
  for (let i = 0; t.status !== 'ready'; i++) { if (t.status === 'error' || i > 240) throw new Error(`build failed: ${t.error?.message || 'timeout'}`); await sleep(500); t = (await call('GET', `/api/trails/${trail.id}`)).trail; }
  step(`pipeline builds a trail (${t.summary.points.toLocaleString('en')} points)`);
  const report = await fetch(`${base}/api/trails/${trail.id}/data/report.json`, { headers: { Cookie: cookie } }).then((r) => r.json());
  if (!report.hasPath || !(report.summary.lengthM > 5) || !report.hazards.some((h) => h.type === 'stairs' || h.type === 'step')) throw new Error('report is missing the trail line or the steps');
  step(`report: ${report.summary.lengthM} m, ${report.hazards.length} findings, rated ${report.difficulty.level}`);
  const anon = await fetch(`${base}/api/trails`);
  if (anon.status !== 401) throw new Error('the API must refuse requests without a session');
  step('API is closed without a session');
  console.log('\nAll checks passed.');
} catch (err) { failed = true; console.error(`\nFAILED: ${err.message}`); }
server.kill();
await sleep(200);
fs.rmSync(dataDir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
