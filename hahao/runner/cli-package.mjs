#!/usr/bin/env node
// Package a finished game for play.hahaogames.com.  Usage: node runner/cli-package.mjs <game dir> <out dir>
import { packageGame } from './package.mjs';
const [src, out] = process.argv.slice(2);
if (!src || !out) { console.error('usage: node runner/cli-package.mjs <game dir> <out dir>'); process.exit(2); }
const r = await packageGame({ src, out });
console.log(JSON.stringify({ ...r, files: r.files.length }, null, 1));
