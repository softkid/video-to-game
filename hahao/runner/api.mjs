// Client for the AGEIS runner API (ageis3 apps/api/src/routes/runner.ts). Bearer AGEIS_RUNNER_TOKEN.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function ageisClient({ api = process.env.AGEIS_API ?? 'https://ageis3api.hahaogames.com', token = process.env.AGEIS_RUNNER_TOKEN, runnerId = process.env.RUNNER_ID ?? 'runner-1', fetchImpl = fetch } = {}) {
  if (!token) throw new Error('AGEIS_RUNNER_TOKEN is not set');
  const base = api.replace(/\/+$/, '') + '/api/runner';
  const H = { authorization: `Bearer ${token}` };
  const post = async (path, body) => {
    const r = await fetchImpl(base + path, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ runnerId, ...body }) });
    if (r.status === 204) return null;
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(`${path}: ${r.status} ${j.error ?? ''}`), { status: r.status, body: j });
    return j;
  };
  return {
    runnerId,
    next: (tiers) => post('/next', tiers ? { tiers } : {}).then((j) => j?.job ?? null),
    progress: (id, stage, progress, message) => post(`/jobs/${id}/progress`, { stage, progress, message }),
    finish: (id, body) => post(`/jobs/${id}/finish`, body),
    fail: (id, error, stage, stats) => post(`/jobs/${id}/fail`, { error, stage, stats }),
    async upload(id, dir, files, onFile) {
      for (const [i, f] of files.entries()) {
        const r = await fetchImpl(`${base}/jobs/${id}/files/${f.split('/').map(encodeURIComponent).join('/')}`, { method: 'PUT', headers: { ...H, 'content-type': 'application/octet-stream', 'x-runner-id': runnerId }, body: readFileSync(join(dir, f)) });
        if (!r.ok) { const j = await r.json().catch(() => ({})); throw Object.assign(new Error(`upload ${f}: ${r.status} ${j.error ?? ''}`), { status: r.status }); }
        onFile?.(i + 1, files.length);
      }
    },
  };
}
