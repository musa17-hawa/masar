// Writes the synthetic sample datasets to ./samples so you can practise the upload flow by hand:
//   npm run sample
import path from 'node:path';
import fs from 'node:fs';
import { ROOT } from '../server/config.js';
import { makeAlpineSample, makePhoneSample } from '../server/sample.js';

const dir = path.join(ROOT, 'samples');
makeAlpineSample(dir);
makePhoneSample(dir);
console.log(`Sample files written to ${dir}:`);
for (const f of fs.readdirSync(dir)) console.log(`  ${f}  (${(fs.statSync(path.join(dir, f)).size / 1e6).toFixed(1)} MB)`);
console.log('\nAerial flow: upload the .las and .gpx, then add the ortho .png together with its .pgw world file.');
console.log('Phone flow:  upload the .ply on its own.');
