// Rebuilds the small 3D scene the landing page animates (public/demo). It is the synthetic alpine sample
// pushed through the real pipeline at a reduced point budget, so the landing page shows genuine output.
//   node scripts/build-demo.js
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ROOT } from '../server/config.js';
import { makeAlpineSample } from '../server/sample.js';
import { build } from '../server/pipeline/worker.js';

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'masar-demo-'));
const raw = path.join(work, 'raw');
const s = makeAlpineSample(raw);
const trail = { id: 'demo', name: 'Demo', files: s.files.map((f, i) => ({ id: `f${i}`, name: f.name, stored: f.name, kind: f.kind })), options: s.options };
await build({ trailDir: work, trail, cfg: { pointBudget: 230000, demMaxCells: 400, allowNetwork: false } });
const out = path.join(ROOT, 'public', 'demo');
fs.mkdirSync(out, { recursive: true });
for (const f of ['points.bin.gz', 'dem.bin.gz', 'meta.json', 'report.json']) fs.copyFileSync(path.join(work, 'out', f), path.join(out, f));
fs.copyFileSync(path.join(raw, s.texture.file), path.join(out, 'texture.png'));
fs.rmSync(work, { recursive: true, force: true });
console.log('Demo scene written to public/demo (convert texture.png to texture.jpg to keep the page light).');
