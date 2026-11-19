// The build itself: a coding agent (Claude Code by default) runs the video-to-game skill on the job's brief, inside a work folder,
// with the tier's caps enforced outside the model — fal calls by fal_asset.py (FAL_MAX_CALLS, FAL_DENY_PREFIXES), turns by
// --max-turns, time by a kill timer. The agent's deliverable is <work>/game/index.html (+ assets).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SKILL_DIR = resolve(fileURLToPath(new URL('../../skills/video-to-game', import.meta.url)));
/** Endpoints the free tier may not call (video design and image→3D are the expensive part of the pipeline). */
export const FREE_DENY = ['minimax/', 'fal-ai/bytedance/seedance', 'fal-ai/kling', 'fal-ai/veo', 'meshy/', 'fal-ai/meshy', 'tripo3d/', 'fal-ai/tripo', 'fal-ai/hunyuan3d', 'fal-ai/hunyuan-3d'];

export function buildPrompt(job) {
  const b = job.brief, L = job.limits, free = job.tier === 'free';
  const lines = [
    `You are building a game for HAHAO GAMES with the video-to-game skill in ${SKILL_DIR} (read SKILL.md first, then`,
    `references/hahao-multiplayer.md — its rules override the gallery examples).`,
    '',
    `## Brief (from the creator's AGEIS design)`,
    `Title: ${b.title}`, `Logline: ${b.logline}`, `Genre: ${b.genre}`, b.style ? `Art style: ${b.style}` : '', `Idea: ${b.idea}`,
    b.world?.setting ? `World: ${b.world.setting}` : '', ...(b.world?.lore ?? []).map((x) => `- lore: ${x}`),
    ...(b.characters ?? []).map((c) => `- character: ${c.name} (${c.role}) — ${c.bio}`),
    b.coreLoop ? `Core loop: ${b.coreLoop}` : '', ...(b.mechanics ?? []).map((m) => `- mechanic: ${m}`),
    `Multiplayer: ${b.multiplayer} (presence = see other players; coop = shared goal; versus = compete).`,
    '',
    `## Budget for this ${free ? 'FREE PROTOTYPE' : 'FULL BUILD'} (hard limits, enforced by the tools)`,
    `- at most ${L.falCalls} fal calls (python3 ${SKILL_DIR}/scripts/fal_asset.py refuses the rest), about ${L.usd} USD`,
    free ? '- no video model and no image→3D: skip the video step; design the look from the brief, use primitives, sprites (nano-banana + birefnet) and generated SFX'
      : '- the full pipeline: generate the gameplay video, study it, build assets (3D models, textures, SFX, music) from it',
    `- ${L.agentTurns} turns and ${L.minutes} minutes in total; final size under ${Math.round(L.maxBytes / 1048576)} MB`,
    '',
    '## Deliverable',
    '- ./game/index.html plus its assets under ./game/ (relative paths only, no CDN except the import map for three@0.160.0).',
    '- The game contract from the skill: ?autostart, ?seed=N, window.__game.',
    '- Multiplayer through the HAHAO P2P engine exactly as references/hahao-multiplayer.md shows. Never block the game on the network.',
    '- Playtest it with the skill\'s recorder before you stop. Write ./game/NOTES.md (controls, fal calls, what you verified).',
  ];
  return lines.filter((x) => x !== '').join('\n');
}

/**
 * Run the agent. Resolves when it exits; rejects on timeout or a non-zero exit. Reports progress through `onTick` every minute.
 * @param {{job: any, workDir: string, onTick?: (info: {falCalls: number, video: boolean, minutes: number}) => Promise<boolean|void>}} o  onTick → true = cancel
 */
export async function runAgent({ job, workDir, onTick, cmd = process.env.HAHAO_AGENT_CMD ?? 'claude', extraArgs = [] }) {
  mkdirSync(join(workDir, 'game'), { recursive: true });
  const prompt = buildPrompt(job);
  writeFileSync(join(workDir, 'BRIEF.md'), prompt + '\n');
  const counter = join(workDir, 'fal_counter.json');
  const env = {
    ...process.env,
    FAL_MAX_CALLS: String(job.limits.falCalls),
    FAL_COUNTER_FILE: counter,
    FAL_DENY_PREFIXES: job.tier === 'free' ? FREE_DENY.join(',') : '',
    HAHAO_JOB_ID: job.id,
  };
  const args = cmd === 'claude'
    ? ['-p', prompt, '--max-turns', String(job.limits.agentTurns), '--output-format', 'json', '--permission-mode', 'bypassPermissions', '--add-dir', SKILL_DIR, ...extraArgs]
    : [...extraArgs];
  const started = Date.now();
  return await new Promise((ok, fail) => {
    const child = spawn(cmd, args, { cwd: workDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out = (out + d).slice(-200000); });
    child.stderr.on('data', (d) => { err = (err + d).slice(-20000); });
    const kill = setTimeout(() => { child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 10000); }, job.limits.minutes * 60_000);
    const tick = setInterval(async () => {
      const c = falUsage(counter);
      const cancel = await onTick?.({ falCalls: c.calls, video: c.endpoints.some((e) => FREE_DENY.slice(0, 5).some((p) => e.startsWith(p))), minutes: Math.round((Date.now() - started) / 60000) }).catch(() => false);
      if (cancel) { child.kill('SIGTERM'); }
    }, 60_000);
    child.on('error', (e) => { clearTimeout(kill); clearInterval(tick); fail(new Error(`could not start the agent (${cmd}): ${e.message}`)); });
    child.on('close', (code, signal) => {
      clearTimeout(kill); clearInterval(tick);
      const minutes = (Date.now() - started) / 60000;
      if (signal || minutes >= job.limits.minutes) return fail(new Error(minutes >= job.limits.minutes ? `the build ran past its ${job.limits.minutes} minute limit` : 'the build was stopped'));
      if (code !== 0) return fail(new Error(`the agent exited with code ${code}: ${err.trim().split('\n').slice(-3).join(' ')}`));
      if (!existsSync(join(workDir, 'game', 'index.html'))) return fail(new Error('the agent finished without ./game/index.html'));
      ok({ minutes: Math.round(minutes * 10) / 10, fal: falUsage(counter), output: out.slice(-4000) });
    });
  });
}

export function falUsage(counterFile) {
  try { const j = JSON.parse(readFileSync(counterFile, 'utf8')); return { calls: j.calls ?? 0, endpoints: j.endpoints ?? [] }; } catch { return { calls: 0, endpoints: [] }; }
}
