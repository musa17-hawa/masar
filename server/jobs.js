// One build at a time (the target machine is small). Jobs run in a worker thread.
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { config } from './config.js';
import { db } from './db.js';

const queue = [];
let running = null;

export const trailDir = (id) => path.join(config.dataDir, 'trails', id);

export function enqueue(trail, task = 'build', extra = {}) {
  if (queue.some((j) => j.id === trail.id && j.task === task) || (running?.id === trail.id && running.task === task)) return;
  trail.status = task === 'build' ? 'queued' : trail.status;
  trail.progress = { stage: 'queued', pct: 0 };
  trail.error = null;
  db.save();
  queue.push({ id: trail.id, task, extra });
  next();
}

export function isBusy(id) { return running?.id === id || queue.some((j) => j.id === id); }

function next() {
  if (running || !queue.length) return;
  const job = queue.shift();
  const trail = db.trails.find((t) => t.id === job.id);
  if (!trail) return next();
  running = job;
  if (job.task === 'build') trail.status = 'processing';
  trail.progress = { stage: 'prepare', pct: 1 };
  db.save();
  const worker = new Worker(new URL('./pipeline/worker.js', import.meta.url), {
    workerData: { task: job.task, trailDir: trailDir(trail.id), trail: JSON.parse(JSON.stringify(trail)),
      cfg: { pointBudget: config.pointBudget, demMaxCells: config.demMaxCells, allowNetwork: config.allowNetwork }, ...job.extra },
    resourceLimits: { maxOldGenerationSizeMb: config.workerMemoryMb },
  });
  let settled = false;
  const finish = (fn) => { if (settled) return; settled = true; fn(); trail.updatedAt = new Date().toISOString(); db.save(); running = null; next(); };
  worker.on('message', (m) => {
    if (m.type === 'progress') { trail.progress = { stage: m.stage, pct: m.pct }; }
    else if (m.type === 'done') finish(() => { trail.status = 'ready'; trail.summary = m.summary; trail.progress = { stage: 'done', pct: 100 }; trail.error = null; });
    else if (m.type === 'error') finish(() => {
      console.error(`[trail ${trail.id}] ${m.message}\n${m.stack || ''}`);
      if (job.task === 'build') trail.status = 'error';
      trail.error = { code: m.code, message: m.message };
    });
  });
  worker.on('error', (err) => finish(() => {
    console.error(`[trail ${trail.id}] worker crashed:`, err);
    if (job.task === 'build') trail.status = 'error';
    const oom = /memory|heap/i.test(String(err.message));
    trail.error = { code: oom ? 'out_of_memory' : 'failed', message: oom ? 'The machine ran out of memory while building this trail. Lower POINT_BUDGET or crop the data.' : `Processing failed: ${err.message}` };
  }));
  worker.on('exit', (code) => { if (code !== 0) finish(() => { if (job.task === 'build') trail.status = 'error'; trail.error = trail.error || { code: 'failed', message: 'Processing stopped unexpectedly.' }; }); });
}

// Trails left "processing" by a restart are put back in the queue.
export function resumeInterrupted() {
  for (const t of db.trails) if (t.status === 'processing' || t.status === 'queued') enqueue(t);
}
