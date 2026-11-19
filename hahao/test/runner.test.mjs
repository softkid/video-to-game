import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { packageGame, validAssetPath, ENGINE_SRC } from '../runner/package.mjs';
import { verifyGame } from '../runner/verify.mjs';
import { runJob } from '../runner/pipeline.mjs';
import { ageisClient } from '../runner/api.mjs';
import { buildPrompt, FREE_DENY } from '../runner/agent.mjs';

const FIXTURE = fileURLToPath(new URL('./fixtures/neon-run', import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), 'hahao-'));
const LIMITS = { free: { falCalls: 15, usd: 1, agentTurns: 40, minutes: 20, video: false, models3d: false, maxBytes: 25 * 1048576 }, paid: { falCalls: 80, usd: 15, agentTurns: 200, minutes: 90, video: true, models3d: true, maxBytes: 150 * 1048576 } };

test('package: inline scripts leave the page, three is bundled locally, the P2P engine is always there', async () => {
  const src = tmp(); cpSync(FIXTURE, src, { recursive: true });
  writeFileSync(join(src, '.env'), 'FAL_KEY=secret'); writeFileSync(join(src, 'fal_log.json'), '[]'); writeFileSync(join(src, 'build.sh'), 'rm -rf /');
  const out = join(tmp(), 'dist');
  const r = await packageGame({ src, out });
  const html = readFileSync(join(out, 'index.html'), 'utf8');
  assert.ok(!html.includes('importmap') && !html.includes('cdn.jsdelivr'));
  assert.ok(html.includes(`<script src="${ENGINE_SRC}"></script>`));
  assert.match(html, /<script type="text\/plain" id="world-src">[\s\S]*var WORLD/);          // data copy for textContent readers
  assert.match(html, /<script src="js\/inline-1\.js"><\/script>/); assert.match(html, /<script type="module" src="js\/game-2\.js"><\/script>/);
  assert.equal(r.engine, 'bootstrap'); assert.ok(html.includes('js/hahao-net.js'));
  const bundle = readFileSync(join(out, 'js/game-2.js'), 'utf8');
  assert.ok(bundle.includes('WebGLRenderer') && !bundle.includes('from"three"') && !/https?:\/\/cdn/.test(bundle));
  assert.deepEqual(r.files.sort(), ['assets/glow.png', 'index.html', 'js/game-2.js', 'js/hahao-net.js', 'js/inline-1.js']);
  assert.deepEqual(r.dropped.sort(), ['.env', 'build.sh', 'fal_log.json']);   // secrets, logs and anything the host would refuse stay behind
  assert.ok(!existsSync(join(out, '.env')));
  for (const f of r.files) assert.equal(validAssetPath(f), true, f);
});

test('package: a game that wires the engine itself gets no bootstrap; remote imports other than three are refused', async () => {
  const src = tmp();
  writeFileSync(join(src, 'index.html'), `<html><head><script src="${ENGINE_SRC}"></script></head><body><script type="module">import * as THREE from 'three'; const net = await window.HahaoP2P.start({ getLocal: () => ({ x: 1 }) }); window.__game = { THREE, net };</script></body></html>`);
  const r = await packageGame({ src, out: join(tmp(), 'd') });
  assert.equal(r.engine, 'game'); assert.equal(r.files.includes('js/hahao-net.js'), false);
  writeFileSync(join(src, 'index.html'), `<html><head></head><body><script type="module">import confetti from 'https://esm.sh/canvas-confetti'; confetti();</script></body></html>`);
  await assert.rejects(packageGame({ src, out: join(tmp(), 'd') }), /only three\.js is bundled/);
});

test('verify: the packaged fixture passes under the play-host CSP in real Chromium; broken builds are caught', async () => {
  const out = join(tmp(), 'dist');
  const r = await packageGame({ src: FIXTURE, out });
  const ok = await verifyGame({ dir: out, bytes: r.bytes, maxBytes: LIMITS.free.maxBytes, waitMs: 3000 });
  assert.equal(ok.ok, true, ok.problems.join('; ')); assert.equal(ok.engine, true); assert.equal(ok.game, true);
  // unpackaged: the inline module is blocked by the CSP and three would come from a CDN
  const raw = await verifyGame({ dir: FIXTURE, waitMs: 1500 });
  assert.equal(raw.ok, false); assert.ok(raw.problems.some((p) => /CSP|__game/.test(p)), raw.problems.join('; '));
  // a crash and an external request
  const bad = tmp(); mkdirSync(join(bad, 'js'));
  writeFileSync(join(bad, 'index.html'), `<html><head><script src="${ENGINE_SRC}"></script></head><body><script src="js/a.js"></script></body></html>`);
  writeFileSync(join(bad, 'js/a.js'), `fetch('https://tracker.example/x').catch(()=>{}); window.__game = {}; null.boom;`);
  const b = await verifyGame({ dir: bad, waitMs: 1000, bytes: 10, maxBytes: 5 });
  assert.equal(b.ok, false);
  const all = b.problems.join(' ');
  for (const want of ['page errors', 'blank', 'over the']) assert.ok(all.includes(want), `${want} in ${all}`);
});

/** AGEIS runner API stand-in that records what the runner does. */
function fakeAgeis(job, { cancelAt = null } = {}) {
  const st = { job, progress: [], uploads: [], finish: null, fail: null, progressCount: 0 };
  const server = createServer(async (req, res) => {
    let body = Buffer.alloc(0); for await (const c of req) body = Buffer.concat([body, c]);
    const send = (code, j) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
    if (req.headers.authorization !== 'Bearer ' + 't'.repeat(40)) return send(401, { error: 'unauthorized' });
    const p = new URL(req.url, 'http://x').pathname;
    if (p === '/api/runner/next') { if (!st.job) { res.writeHead(204); return res.end(); } const j = st.job; st.job = null; return send(200, { job: j }); }
    let m;
    if ((m = /^\/api\/runner\/jobs\/([\w-]+)\/progress$/.exec(p))) { const b = JSON.parse(body); st.progress.push(b.stage); st.progressCount++; return send(200, { ok: true, cancel: cancelAt !== null && st.progressCount >= cancelAt }); }
    if ((m = /^\/api\/runner\/jobs\/([\w-]+)\/files\/(.+)$/.exec(p))) { st.uploads.push({ path: decodeURIComponent(m[2]), bytes: body.length, runner: req.headers['x-runner-id'] }); return send(200, { ok: true }); }
    if ((m = /^\/api\/runner\/jobs\/([\w-]+)\/finish$/.exec(p))) { st.finish = JSON.parse(body); return send(200, { ok: true, url: 'https://play.hahaogames.com/neon-run-abc123/', portal: { id: 'neon-run-x1', status: 'submitted' } }); }
    if ((m = /^\/api\/runner\/jobs\/([\w-]+)\/fail$/.exec(p))) { st.fail = JSON.parse(body); return send(200, { ok: true, refunded: true }); }
    send(404, {});
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ st, api: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) })));
}
const JOB = (tier = 'free') => ({ id: 'job_test01', tier, attempt: 1, slug: 'neon-run-abc123', limits: LIMITS[tier], brief: { title: 'Neon Run', logline: 'Dash through a neon canyon.', genre: 'action', idea: 'neon runner with friends', multiplayer: 'presence' } });
const fakeBuild = async ({ workDir, onTick }) => { cpSync(FIXTURE, join(workDir, 'game'), { recursive: true }); await onTick({ falCalls: 3, video: false, minutes: 1 }); return { minutes: 1, fal: { calls: 3, endpoints: [] } }; };

test('pipeline: claim → build → package → verify → upload (index.html last) → finish', async () => {
  const s = await fakeAgeis(JOB());
  try {
    const client = ageisClient({ api: s.api, token: 't'.repeat(40), runnerId: 'r-test' });
    const job = await client.next();
    const r = await runJob({ job, client, workRoot: tmp(), steps: { build: fakeBuild }, log: () => {} });
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(s.st.progress, ['brief', 'build', 'build', 'package', 'verify', 'upload', 'finish']);
    assert.equal(s.st.uploads.at(-1).path, 'index.html'); assert.equal(s.st.uploads.length, 5); assert.equal(s.st.uploads[0].runner, 'r-test');
    assert.equal(s.st.finish.stats.falCalls, 3); assert.equal(s.st.finish.stats.verify.ok, true); assert.equal(s.st.finish.stats.p2p, 'bootstrap');
    assert.equal(s.st.fail, null);
    assert.equal(await client.next(), null);
  } finally { await s.close(); }
});

test('pipeline: a failing build reports fail (refund) with the stage; a cancel stops the job', async () => {
  const s = await fakeAgeis(JOB('paid'));
  try {
    const client = ageisClient({ api: s.api, token: 't'.repeat(40) });
    const r = await runJob({ job: await client.next(), client, workRoot: tmp(), steps: { build: async () => { throw new Error('the agent finished without ./game/index.html'); } }, log: () => {} });
    assert.equal(r.ok, false); assert.equal(s.st.fail.stage, 'video'); assert.match(s.st.fail.error, /without/); assert.equal(s.st.uploads.length, 0);
  } finally { await s.close(); }
  const c = await fakeAgeis(JOB(), { cancelAt: 3 });
  try {
    const client = ageisClient({ api: c.api, token: 't'.repeat(40) });
    const r = await runJob({ job: await client.next(), client, workRoot: tmp(), steps: { build: fakeBuild }, log: () => {} });
    assert.equal(r.ok, false); assert.equal(c.st.fail.error, 'Cancelled'); assert.equal(c.st.finish, null);
  } finally { await c.close(); }
});

test('agent prompt follows the tier; fal_asset.py enforces the call cap and the free-tier deny list before spending', () => {
  const free = buildPrompt(JOB('free')), paid = buildPrompt(JOB('paid'));
  assert.match(free, /FREE PROTOTYPE/); assert.match(free, /no video model/); assert.match(free, /at most 15 fal calls/);
  assert.match(paid, /FULL BUILD/); assert.match(paid, /generate the gameplay video/); assert.match(paid, /hahao-multiplayer\.md/);
  const script = fileURLToPath(new URL('../../skills/video-to-game/scripts/fal_asset.py', import.meta.url));
  const dir = tmp(), counter = join(dir, 'c.json');
  writeFileSync(counter, JSON.stringify({ calls: 15, endpoints: [] }));
  const run = (endpoint, env) => spawnSync('python3', ['-I', script, endpoint, '-o', dir], { env: { PATH: process.env.PATH, FAL_KEY: 'x', ...env }, encoding: 'utf8' });
  const capped = run('fal-ai/birefnet/v2', { FAL_MAX_CALLS: '15', FAL_COUNTER_FILE: counter });
  assert.notEqual(capped.status, 0); assert.match(capped.stderr, /all 15 fal calls/);
  const denied = run('minimax/h3-max/text-to-video', { FAL_DENY_PREFIXES: FREE_DENY.join(','), FAL_COUNTER_FILE: counter });
  assert.notEqual(denied.status, 0); assert.match(denied.stderr, /not available in this tier/);
});
