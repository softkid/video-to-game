# HAHAO GAMES builds: multiplayer and publishing rules

Read this when the game is built for HAHAO GAMES (an AGEIS Auto job: the runner writes `BRIEF.md` in your folder). These
rules come on top of SKILL.md and win where they differ from the gallery games.

## The P2P engine is mandatory

Every HAHAO game loads the common engine and lets players meet. Players connect browser to browser; the portal only
introduces them. Load it in `<head>`, before your game module:

```html
<script src="https://hahaogames.com/sdk/p2p-engine.js"></script>
```

Wire it in the game module. It never throws and never blocks: without a network or a portal id it resolves with
`room: null` and the game stays single-player.

```js
const me = { x: 0, y: 0, z: 0, yaw: 0, anim: 'idle' };          // what others need to draw you, nothing more
const net = await window.HahaoP2P.start({
  getLocal: () => (state.phase === 'play' ? me : null),          // null = nothing sent (title screen, paused)
  sync: { angleKeys: ['yaw'] },
  name: 'Player',
});
window.__game.net = net;                                          // the playtest can see it

function updateGhosts() {                                         // every frame, after your own update
  const seen = new Set();
  for (const [id, s] of net.sync?.remotes() ?? []) {              // interpolated 100 ms behind, ~10 updates a second
    seen.add(id);
    const g = ghosts.get(id) ?? addGhost(id);                     // a clone of the hero, slightly transparent, tinted
    g.position.set(s.x, s.y, s.z); g.rotation.y = s.yaw;
  }
  for (const [id, g] of ghosts) if (!seen.has(id)) { scene.remove(g); ghosts.delete(id); }
}
net.room?.onData((from, data, channel) => { /* reliable events: emotes, a gate taken, a shared goal reached */ });
net.room?.send({ type: 'gate', id: 4 });                          // reliable, ordered
```

Match the brief's `Multiplayer:` line:

- **presence** — ghosts of the other players and a small "N playing" counter. No collisions between players.
- **coop** — presence plus one shared goal sent as reliable events (a door opens when two players stand on plates,
  a shared score). Each client decides its own state; never trust a peer's numbers for anything that ends the game.
- **versus** — presence plus a race or score board from the reliable channel. Keep it fair: everyone plays their own
  copy of the level from the same `?seed`.

Rooms hold 8 players (`world-1` … `world-5`); the engine picks one. Clamp every value you read from a peer.

## What the play host accepts

The runner packages your `./game/` folder for `play.hahaogames.com`, which serves it under a strict CSP:

- three.js only through the import map at `three@0.160.0` (the runner bundles it locally). Any other library: copy
  the file into `./game/` and import it relatively. No other CDN, no fonts from Google, no analytics.
- Inline scripts are fine (the runner moves them to files); inline event attributes (`onclick="…"`) are not — use
  `addEventListener`.
- Asset names: letters, digits, `_ - .`; at most 4 folders deep; extensions html, js, json, css, svg, png, jpg, webp,
  gif, glb, gltf, bin, mp3, ogg, wav, m4a, mp4, webm, txt, woff2. Nothing else is uploaded.
- Size: 25 MB for a free prototype, 150 MB for a full build. Compress textures (webp/jpg, 1024 px is plenty).
- `blob:` URLs work (GLTF textures, audio, workers from a `<script id>` source).

## Budget

The runner sets the caps; `scripts/fal_asset.py` refuses calls past them and tells you so. When it does, finish with
what you have — a complete small game beats an unfinished big one.

- **Free prototype** — no video model, no image→3D. Design the look from the brief; build with primitives, instanced
  geometry and sprites (nano-banana → birefnet cut-outs on planes), generated SFX. 15 fal calls.
- **Full build** — the whole SKILL.md workflow, 80 fal calls.

## Before you stop

Run the playtest (`references/playtest.md`) with `?autostart`: zero console errors, the engine loaded
(`window.HahaoP2P`), `window.__game` present. Write `./game/NOTES.md`: controls, fal calls per endpoint, what you checked.
