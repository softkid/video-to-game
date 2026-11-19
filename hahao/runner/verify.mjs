// Play the packaged game in headless Chromium exactly as play.hahaogames.com will serve it (same CSP), before anything is
// published. Fails on: page errors, console errors, CSP violations, requests to hosts other than the game and hahaogames.com,
// a missing window.__game, the P2P engine not loading, a blank canvas, or a build over the size limit.
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { ENGINE_SRC } from './package.mjs';

/** Keep in sync with the AGEIS play host (apps/api/src/lib/publish.ts GAME_CSP). */
export const GAME_CSP = [
  "default-src 'self'", "script-src 'self' https://hahaogames.com", "style-src 'self' 'unsafe-inline'", "img-src 'self' https: data: blob:", "media-src 'self' data: blob:", "font-src 'self' data:",
  "connect-src 'self' https://hahaogames.com wss://hahaogames.com data: blob:", "worker-src 'self' blob:", "base-uri 'none'", "form-action 'none'",
].join('; ');
const CT = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.mp4': 'video/mp4', '.webm': 'video/webm', '.txt': 'text/plain', '.woff2': 'font/woff2' };
const ENGINE_FILE = fileURLToPath(new URL('../vendor/p2p-engine.js', import.meta.url));

export function serveDir(dir) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let p = decodeURIComponent(url.pathname); if (p.endsWith('/')) p += 'index.html';
    const file = normalize(join(dir, p));
    if (!file.startsWith(normalize(dir)) || !existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': CT[extname(file).toLowerCase()] ?? 'application/octet-stream', 'content-security-policy': GAME_CSP });
    res.end(readFileSync(file));
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) })));
}

/** Colour variety of a screenshot (decoded in a blank page): a frozen or empty canvas has a handful of colours and no spread. */
async function screenStats(browser, png) {
  const p = await browser.newPage();
  try {
    return await p.evaluate(async (b64) => {
      const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
      const c = document.createElement('canvas'); c.width = 160; c.height = 90; const g = c.getContext('2d'); g.drawImage(img, 0, 0, 160, 90);
      const d = g.getImageData(0, 0, 160, 90).data, seen = new Set(); let sum = 0, sq = 0;
      for (let i = 0; i < d.length; i += 4) { const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]; sum += l; sq += l * l; seen.add((d[i] >> 3) << 10 | (d[i + 1] >> 3) << 5 | (d[i + 2] >> 3)); }
      const n = d.length / 4, mean = sum / n;
      return { colors: seen.size, std: Math.round(Math.sqrt(Math.max(0, sq / n - mean * mean)) * 10) / 10 };
    }, png.toString('base64'));
  } finally { await p.close(); }
}

/**
 * @param {{dir: string, maxBytes?: number, waitMs?: number, executablePath?: string, screenshot?: string}} o
 * @returns {Promise<{ok: boolean, problems: string[], consoleErrors: string[], external: string[], game: boolean, engine: boolean, screen: {colors: number, std: number}, bytes: number}>}
 */
export async function verifyGame({ dir, maxBytes = Infinity, waitMs = 6000, executablePath, screenshot, bytes = 0 }) {
  const srv = await serveDir(dir);
  const exe = executablePath ?? process.env.CHROMIUM_PATH ?? (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
  const browser = await chromium.launch({ executablePath: exe, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
  const consoleErrors = [], pageErrors = [], external = [], csp = [];
  try {
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
    await page.addInitScript(() => { document.addEventListener('securitypolicyviolation', (e) => { (window.__csp ||= []).push(`${e.violatedDirective} ${e.blockedURI}`); }); });
    // the engine comes from the vendored copy (same file the portal serves); portal APIs answer "single-player" offline
    await page.route('https://hahaogames.com/**', (route) => {
      const u = route.request().url();
      if (u === ENGINE_SRC) return route.fulfill({ status: 200, contentType: 'text/javascript', body: readFileSync(ENGINE_FILE, 'utf8') });
      return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"offline_check"}' });
    });
    page.on('request', (r) => { const h = new URL(r.url()); if (!['127.0.0.1', 'hahaogames.com'].includes(h.hostname) && !['data:', 'blob:'].includes(h.protocol)) external.push(r.url()); });
    page.on('console', (m) => { if (m.type() === 'error' && !/offline_check|status of 503/.test(m.text())) consoleErrors.push(m.text().slice(0, 300)); });
    page.on('pageerror', (e) => pageErrors.push(String(e.message || e).slice(0, 300)));
    await page.goto(`${srv.origin}/?autostart&seed=1`, { waitUntil: 'load', timeout: 30000 });
    await page.waitForTimeout(waitMs);
    const state = await page.evaluate(() => ({ game: typeof window.__game === 'object' && window.__game !== null, engine: typeof window.HahaoP2P === 'object', csp: window.__csp || [] }));
    csp.push(...state.csp);
    const shot = await page.screenshot({ path: screenshot });
    const look = await screenStats(browser, shot);
    const problems = [];
    if (pageErrors.length) problems.push(`page errors: ${pageErrors.slice(0, 3).join(' | ')}`);
    if (consoleErrors.length) problems.push(`console errors: ${consoleErrors.slice(0, 3).join(' | ')}`);
    if (csp.length) problems.push(`blocked by the CSP: ${csp.slice(0, 3).join(' | ')}`);
    if (external.length) problems.push(`requests to other hosts: ${external.slice(0, 3).join(' | ')}`);
    if (!state.game) problems.push('window.__game is missing (the game contract)');
    if (!state.engine) problems.push('the HAHAO P2P engine did not load');
    if (look.colors < 6 || look.std < 0.5) problems.push('the screen looks blank');   // one flat colour (black, a frozen clear colour), not a dark scene
    if (bytes > maxBytes) problems.push(`the build is ${(bytes / 1048576).toFixed(1)} MB, over the ${(maxBytes / 1048576).toFixed(0)} MB limit`);
    return { ok: problems.length === 0, problems, consoleErrors, pageErrors, csp, external, game: state.game, engine: state.engine, screen: look, bytes };
  } finally { await browser.close(); await srv.close(); }
}
