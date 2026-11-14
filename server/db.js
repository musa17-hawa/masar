// Tiny JSON-file database. Fine for a team-sized app: everything is in memory,
// writes are debounced and atomic (write to a temp file, then rename).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

const file = path.join(config.dataDir, 'db.json');
const empty = () => ({ users: [], sessions: [], trails: [] });

let state = empty();
if (fs.existsSync(file)) {
  try { state = { ...empty(), ...JSON.parse(fs.readFileSync(file, 'utf8')) }; }
  catch (err) {
    const backup = `${file}.corrupt-${Date.now()}`;
    fs.copyFileSync(file, backup);
    console.error(`db.json could not be read (${err.message}). A copy was kept at ${backup}.`);
  }
}

let timer = null;
function flush() {
  timer = null;
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
  fs.renameSync(tmp, file);
}

export const db = {
  get users() { return state.users; },
  get sessions() { return state.sessions; },
  get trails() { return state.trails; },
  set sessions(v) { state.sessions = v; },
  set trails(v) { state.trails = v; },
  set users(v) { state.users = v; },
  save() { if (!timer) timer = setTimeout(flush, 150); },
  saveNow() { if (timer) clearTimeout(timer); flush(); },
  id(bytes = 8) { return crypto.randomBytes(bytes).toString('hex'); },
};

process.on('exit', () => { if (timer) { clearTimeout(timer); flush(); } });
