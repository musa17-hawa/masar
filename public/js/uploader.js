// Chunked, resumable uploads. Chunks stay well under Cloudflare's 100 MB request limit, and a dropped
// connection only costs the chunk in flight.
import { api, sleep } from './core.js';

const CHUNK = 16 * 1024 * 1024;

export async function uploadFile(trailId, file, { kind, meta, onProgress, signal } = {}) {
  const { file: rec } = await api('POST', `/api/trails/${trailId}/files`, { name: file.name, size: file.size, kind, meta });
  let offset = 0, failures = 0;
  while (offset < file.size) {
    if (signal?.aborted) throw new Error('aborted');
    const end = Math.min(file.size, offset + CHUNK);
    try {
      const res = await fetch(`/api/trails/${trailId}/files/${rec.id}?offset=${offset}`, { method: 'PUT', body: file.slice(offset, end), credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream' } });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409 && Number.isFinite(data.received)) { offset = data.received; continue; }   // resume where the server is
      if (!res.ok) throw Object.assign(new Error(data.error || 'upload_failed'), { fatal: res.status >= 400 && res.status < 500 });
      offset = data.received; failures = 0;
      onProgress?.(offset / file.size);
    } catch (err) {
      if (err.fatal || ++failures > 6) throw err;
      await sleep(Math.min(15000, 800 * 2 ** failures));
    }
  }
  return rec;
}
