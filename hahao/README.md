# HAHAO build runner

This folder turns the video-to-game skill into the builder behind **AGEIS Auto** on HAHAO GAMES: a creator clicks
*Full build* or *Free prototype* on ageis.hahaogames.com, and a runner here makes, checks and publishes the game.
Everything outside `hahao/` stays the upstream skill (one addition: `references/hahao-multiplayer.md`, plus the
budget caps in `scripts/fal_asset.py`).

```
AGEIS (ageis3)  ──next──▶  runner  ──agent──▶  ./game/index.html + assets   (skill, fal, Chromium playtest)
                                   ──package─▶  dist/  (inline scripts → files, three bundled, P2P engine attached)
                                   ──verify──▶  headless Chromium under the play-host CSP
                ◀─files/finish──   upload, index.html last → portal registration → credit confirmed
                ◀─fail─────────    any error → files removed, credit refunded
```

| File | What |
|---|---|
| `runner/index.mjs` | the loop: claim a job, run it, repeat (`--once`, `--tiers paid,free`) |
| `runner/pipeline.mjs` | one job: build → package → verify → upload → finish, `fail` on any error |
| `runner/agent.mjs` | the build: Claude Code (`HAHAO_AGENT_CMD`) on the brief, with the tier's caps |
| `runner/package.mjs` | CSP-safe packaging (`node runner/cli-package.mjs <game> <out>` by hand) |
| `runner/verify.mjs` | Chromium check: errors, CSP, other hosts, `window.__game`, P2P engine, blank screen, size |
| `runner/api.mjs` | AGEIS runner API client |
| `vendor/p2p-engine.js` | the engine the portal serves (`softkid/p2p-engine` `dist/p2p-engine.js`), used offline by verify |

## Tiers

The limits come with each job from AGEIS (`apps/api/src/lib/auto.ts`); the runner enforces them outside the model.

| | free prototype | full build |
|---|---|---|
| fal calls | 15 (no video model, no image→3D: `FAL_DENY_PREFIXES`) | 80 |
| agent turns / minutes | 40 / 20 | 200 / 90 |
| size | 25 MB | 150 MB |

## Run one

```bash
cd hahao && npm install
export AGEIS_API=https://ageis3api.hahaogames.com AGEIS_RUNNER_TOKEN=…   # = RUNNER_TOKEN on the AGEIS Worker
export FAL_KEY=…  ANTHROPIC_API_KEY=…                                    # the agent's keys
pip install fal-client                                                   # plus ffmpeg on PATH
node runner/index.mjs
```

The machine needs Node 20+, Python 3.9+, ffmpeg, Chromium (`CHROMIUM_PATH`, or `npx playwright install chromium`) and the
Claude Code CLI. One runner builds one game at a time; start more runners for more throughput (each claims its own job).

## Test

```bash
npm test     # packaging, the Chromium check, the whole pipeline against a fake AGEIS, the fal caps
```
