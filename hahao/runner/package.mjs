// Turn a video-to-game build (one index.html with an import map + inline module, assets next to it) into a site that runs on
// play.hahaogames.com under its strict CSP: no inline scripts, no CDN — three.js is bundled locally — and the common P2P engine
// always loaded. Nothing in the game's code changes; only where its scripts live.
//
//   const report = await packageGame({ src: 'work/job/game', out: 'work/job/dist' });
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, sep } from 'node:path';

export const ENGINE_SRC = 'https://hahaogames.com/sdk/p2p-engine.js';
export const ALLOWED_EXT = new Set(['.html', '.js', '.mjs', '.json', '.css', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.glb', '.gltf', '.bin', '.mp3', '.ogg', '.wav', '.m4a', '.mp4', '.webm', '.txt', '.woff2']);
const require = createRequire(import.meta.url);
const THREE_DIR = dirname(dirname(require.resolve('three')));   // node_modules/three (its exports map hides package.json)
const CDN_THREE = /^https:\/\/(?:cdn\.jsdelivr\.net\/npm|unpkg\.com|esm\.sh)\/three@[\d.]+\//;

/** Same rule as the AGEIS play host (apps/api/src/lib/publish.ts validAssetPath). */
export function validAssetPath(p) {
  return /^(?:[A-Za-z0-9_][\w.-]{0,80}\/){0,4}[A-Za-z0-9_][\w.-]{0,100}\.(html|js|mjs|json|css|svg|png|jpe?g|webp|gif|glb|gltf|bin|mp3|ogg|wav|m4a|mp4|webm|txt|woff2)$/.test(p)
    && !p.split('/').some((x) => x === '..' || x.startsWith('.')) && (p === 'index.html' || !p.endsWith('.html'));
}

const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
const attr = (attrs, name) => { const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(attrs); return m ? (m[1] ?? m[2] ?? m[3]) : null; };
const isJsType = (t) => !t || /^(?:text\/javascript|application\/javascript|module)$/i.test(t.trim());

/** esbuild plugin: bare `three` / `three/addons/…` and CDN three URLs resolve to the pinned local copy; anything else remote is refused. */
function threeLocal(importMap) {
  const mapped = importMap?.imports ?? {};
  return {
    name: 'three-local',
    setup(b) {
      const toLocal = (spec) => {
        let s = spec;
        if (mapped[s]) s = mapped[s];
        else for (const [k, v] of Object.entries(mapped)) if (k.endsWith('/') && s.startsWith(k)) { s = v + s.slice(k.length); break; }
        if (s === 'three') return join(THREE_DIR, 'build/three.module.js');
        if (s.startsWith('three/addons/')) return join(THREE_DIR, 'examples/jsm', s.slice('three/addons/'.length));
        if (s.startsWith('three/examples/jsm/')) return join(THREE_DIR, s.slice('three/'.length));
        if (CDN_THREE.test(s)) return join(THREE_DIR, s.replace(CDN_THREE, ''));
        return null;
      };
      b.onResolve({ filter: /.*/ }, (args) => {
        const local = toLocal(args.path);
        if (local) return { path: local };
        if (/^https?:\/\//.test(args.path) || (!args.path.startsWith('.') && !args.path.startsWith('/') && args.importer.startsWith('<stdin>'))) {
          return { errors: [{ text: `remote or unmapped import "${args.path}" — only three.js is bundled; copy other libraries next to the game` }] };
        }
        return undefined;
      });
    },
  };
}

function walk(dir, base = dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n), st = statSync(p);
    if (st.isDirectory()) { if (!n.startsWith('.') && n !== 'node_modules') walk(p, base, out); }
    else out.push(relative(base, p).split(sep).join('/'));
  }
  return out;
}

/**
 * @param {{src: string, out: string, injectBootstrap?: boolean, minify?: boolean}} o
 * @returns {Promise<{files: string[], bytes: number, scripts: number, engine: 'game'|'bootstrap', dropped: string[], warnings: string[]}>}
 */
export async function packageGame({ src, out, injectBootstrap = true, minify = true }) {
  const indexPath = join(src, 'index.html');
  if (!existsSync(indexPath)) throw new Error('index.html missing in ' + src);
  rmSync(out, { recursive: true, force: true }); mkdirSync(out, { recursive: true });
  let html = readFileSync(indexPath, 'utf8');
  const warnings = [], dropped = [];

  // 1. the import map goes (it is inline, and three is bundled below)
  let importMap = null;
  html = html.replace(/<script\b[^>]*type\s*=\s*["']importmap["'][^>]*>([\s\S]*?)<\/script>\s*/i, (_, body) => { try { importMap = JSON.parse(body); } catch { warnings.push('import map is not valid JSON'); } return ''; });

  // 2. every inline script moves to a file; data scripts (<script id=…>) keep a non-executing copy for textContent readers (workers)
  let n = 0, usesEngine = html.includes('HahaoP2P') || html.includes(ENGINE_SRC);
  const jobs = [];
  html = html.replace(SCRIPT_RE, (whole, attrs, body) => {
    const type = attr(attrs, 'type'), srcAttr = attr(attrs, 'src'), id = attr(attrs, 'id');
    if (srcAttr) {
      if (srcAttr === ENGINE_SRC) return whole;
      if (/^https?:\/\//.test(srcAttr) || srcAttr.startsWith('//')) { dropped.push(srcAttr); warnings.push(`removed remote script ${srcAttr}`); return ''; }
      const rel = srcAttr.replace(/^\.\//, '');
      if (!validAssetPath(rel) || !existsSync(join(src, rel))) { dropped.push(srcAttr); warnings.push(`removed script outside the game folder: ${srcAttr}`); return ''; }
      return whole;
    }
    if (!isJsType(type)) return whole;          // shaders, JSON blobs: never executed, CSP does not care
    const module = (type ?? '').toLowerCase() === 'module';
    const file = `js/${module ? 'game' : 'inline'}-${++n}.js`;
    jobs.push({ file, body, module });
    const keep = id ? `<script type="text/plain" id="${id}">${body}</script>\n` : '';
    return `${keep}<script${module ? ' type="module"' : ''} src="${file}"></script>`;
  });

  // 3. bundle: modules get three from node_modules (one pinned version); classic scripts are copied as they are
  for (const j of jobs) {
    if (j.body.includes('HahaoP2P')) usesEngine = true;
    if (j.module) {
      const r = await build({ stdin: { contents: j.body, resolveDir: src, sourcefile: 'index.html', loader: 'js' }, bundle: true, format: 'esm', target: 'es2022', minify, write: false, logLevel: 'silent', plugins: [threeLocal(importMap)], legalComments: 'none' })
        .catch((e) => { throw new Error('bundling failed: ' + (e.errors?.map((x) => x.text).join('; ') ?? e.message)); });
      mkdirSync(join(out, 'js'), { recursive: true }); writeFileSync(join(out, j.file), r.outputFiles[0].contents);
    } else { mkdirSync(join(out, 'js'), { recursive: true }); writeFileSync(join(out, j.file), j.body); }
  }

  // 4. the P2P engine is mandatory. A game that wires it itself keeps its own code; otherwise a small bootstrap joins the room
  //    (presence + "N playing" badge) so players still meet.
  if (!html.includes(ENGINE_SRC)) html = html.replace(/<\/head>/i, `<script src="${ENGINE_SRC}"></script>\n</head>`);
  let engine = 'game';
  if (!usesEngine && injectBootstrap) {
    engine = 'bootstrap';
    mkdirSync(join(out, 'js'), { recursive: true });
    writeFileSync(join(out, 'js/hahao-net.js'), BOOTSTRAP);
    html = html.replace(/<\/body>/i, `<script src="js/hahao-net.js"></script>\n</body>`);
  }
  if (/<script\b(?![^>]*\bsrc=)(?![^>]*type\s*=\s*["']?(?!module|text\/javascript|application\/javascript)[\w/+.-]+)[^>]*>[\s\S]*?<\/script>/i.test(html.replace(/<script type="text\/plain"[\s\S]*?<\/script>/gi, ''))) warnings.push('an inline script is left');
  if (/\son[a-z]+\s*=\s*["']/i.test(html)) warnings.push('inline event handler attributes (onclick=…) are blocked by the CSP');

  writeFileSync(join(out, 'index.html'), html);

  // 5. assets: everything the host will serve, nothing it would refuse
  for (const rel of walk(src)) {
    if (rel === 'index.html') continue;
    if (!ALLOWED_EXT.has(extname(rel).toLowerCase()) || !validAssetPath(rel) || /(^|\/)fal_log\.json$/.test(rel)) { dropped.push(rel); continue; }
    mkdirSync(dirname(join(out, rel)), { recursive: true }); cpSync(join(src, rel), join(out, rel));
  }
  const files = walk(out);
  const bytes = files.reduce((a, f) => a + statSync(join(out, f)).size, 0);
  return { files, bytes, scripts: jobs.length, engine, dropped, warnings };
}

/** Joins the game's world-N room when the game did not wire multiplayer itself; shows how many play right now. */
export const BOOTSTRAP = `(function () {
  if (!window.HahaoP2P) return;
  var badge = document.createElement('div');
  badge.setAttribute('aria-live', 'polite');
  badge.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:9999;padding:4px 10px;border-radius:12px;background:rgba(0,0,0,.45);color:#fff;font:600 12px system-ui,sans-serif;display:none;pointer-events:none';
  document.addEventListener('DOMContentLoaded', function () { document.body.appendChild(badge); });
  var pos = function () {
    var g = window.__game, p = g && (g.player && (g.player.position || g.player.pos) || g.pos);
    return p && typeof p.x === 'number' ? { x: p.x, y: p.y || 0, z: p.z || 0 } : { x: 0, y: 0, z: 0 };
  };
  window.HahaoP2P.start({ getLocal: pos }).then(function (net) {
    window.__hahaoNet = net;
    if (!net.room) return;
    var draw = function () { var n = net.room.connectedPeers().length; badge.textContent = (n + 1) + ' playing'; badge.style.display = n > 0 ? 'block' : 'none'; };
    net.room.onPeers(draw); setInterval(draw, 2000);
  });
})();
`;
