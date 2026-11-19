// One job, start to finish: agent build → package → verify → upload → finish. Any failure is reported with `fail`, which makes
// AGEIS remove partial files and refund the creator. Each step is a function in `steps`, so tests swap the agent for a fake.
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runAgent } from './agent.mjs';
import { packageGame } from './package.mjs';
import { verifyGame } from './verify.mjs';

export const defaultSteps = { build: runAgent, pack: packageGame, verify: verifyGame };

export class Cancelled extends Error {}

/**
 * @param {{job: any, client: ReturnType<import('./api.mjs').ageisClient>, workRoot: string, steps?: Partial<typeof defaultSteps>, log?: (m: string) => void, keepWork?: boolean}} o
 */
export async function runJob({ job, client, workRoot, steps = {}, log = console.log, keepWork = false }) {
  const s = { ...defaultSteps, ...steps };
  const work = join(workRoot, job.id);
  rmSync(work, { recursive: true, force: true }); mkdirSync(work, { recursive: true });
  let stage = 'brief';
  const stats = { tier: job.tier, attempt: job.attempt };
  const report = async (st, pct, msg) => {
    stage = st;
    const r = await client.progress(job.id, st, pct, msg);
    if (r?.cancel) throw new Cancelled('cancelled by the creator');
  };
  try {
    await report('brief', 2, 'Reading the design');
    await report(job.limits.video ? 'video' : 'build', 5, job.limits.video ? 'Designing the look on video' : 'Making the game');
    const built = await s.build({
      job, workDir: work,
      onTick: async (t) => {
        const st = t.video && t.falCalls <= 2 ? 'video' : 'build';
        const pct = Math.min(70, 5 + Math.round((t.minutes / job.limits.minutes) * 65));
        try { await report(st, pct, `${t.falCalls}/${job.limits.falCalls} asset calls · ${t.minutes} min`); return false; }
        catch (e) { if (e instanceof Cancelled) return true; return false; }
      },
    });
    Object.assign(stats, { minutes: built.minutes, falCalls: built.fal?.calls ?? 0 });

    await report('package', 75, 'Packaging for play.hahaogames.com');
    const dist = join(work, 'dist');
    const pk = await s.pack({ src: join(work, 'game'), out: dist });
    Object.assign(stats, { files: pk.files.length, bytes: pk.bytes, p2p: pk.engine, warnings: pk.warnings.slice(0, 10) });
    if (pk.bytes > job.limits.maxBytes) throw new Error(`the game is ${(pk.bytes / 1048576).toFixed(1)} MB, over the ${Math.round(job.limits.maxBytes / 1048576)} MB limit`);

    await report('verify', 82, 'Playtesting in a browser');
    const v = await s.verify({ dir: dist, maxBytes: job.limits.maxBytes, bytes: pk.bytes, screenshot: join(work, 'verify.png') });
    stats.verify = { ok: v.ok, problems: v.problems, screen: v.screen };
    if (!v.ok) throw new Error('Playtest failed: ' + v.problems.join('; '));

    await report('upload', 88, `Uploading ${pk.files.length} files`);
    // index.html last: the game only becomes reachable once every asset it needs is there
    const order = [...pk.files.filter((f) => f !== 'index.html'), 'index.html'];
    await client.upload(job.id, dist, order);

    await report('finish', 97, 'Publishing on HAHAO GAMES');
    let fin = null;
    for (let i = 0; i < 4 && !fin; i++) {
      try { fin = await client.finish(job.id, { stats, title: job.brief.title, logline: job.brief.logline, genre: job.brief.genre }); }
      catch (e) { if (e.status !== 502 || i === 3) throw e; await new Promise((r) => setTimeout(r, 2000 * (i + 1))); }   // portal busy: retry
    }
    log(`[${job.id}] published ${fin.url}`);
    return { ok: true, url: fin.url, portal: fin.portal, stats };
  } catch (e) {
    const msg = e instanceof Cancelled ? 'Cancelled' : String(e.message || e).slice(0, 300);
    log(`[${job.id}] ${stage}: ${msg}`);
    await client.fail(job.id, msg, stage, stats).catch((x) => log(`[${job.id}] could not report the failure: ${x.message}`));
    return { ok: false, error: msg, stage, stats };
  } finally {
    if (!keepWork) rmSync(work, { recursive: true, force: true });
  }
}
