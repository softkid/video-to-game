#!/usr/bin/env node
// HAHAO build runner: pulls AGEIS Auto jobs and builds them one at a time.
//
//   AGEIS_API=https://ageis3api.hahaogames.com AGEIS_RUNNER_TOKEN=… FAL_KEY=… node runner/index.mjs [--once] [--tiers paid,free]
//
// Needs: Node 20+, Python 3.9+ with fal-client, ffmpeg, Chromium (Playwright), and the agent CLI (HAHAO_AGENT_CMD, default `claude`).
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { ageisClient } from './api.mjs';
import { runJob } from './pipeline.mjs';

const argv = process.argv.slice(2);
const once = argv.includes('--once');
const tiersArg = argv[argv.indexOf('--tiers') + 1];
const tiers = argv.includes('--tiers') && tiersArg ? tiersArg.split(',') : undefined;
const workRoot = resolve(process.env.HAHAO_WORK ?? 'work');
const idleMs = Number(process.env.HAHAO_IDLE_MS ?? 15000);
mkdirSync(workRoot, { recursive: true });

const client = ageisClient();
let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { if (stopping) process.exit(1); stopping = true; console.log('finishing the current job, then stopping (again to force)'); });

while (!stopping) {
  let job = null;
  try { job = await client.next(tiers); } catch (e) { console.error('queue unreachable:', e.message); }
  if (job) {
    console.log(`[${job.id}] ${job.tier} "${job.brief.title}" (attempt ${job.attempt})`);
    await runJob({ job, client, workRoot });
  } else if (once) break;
  else await new Promise((r) => setTimeout(r, idleMs));
  if (once && job) break;
}
