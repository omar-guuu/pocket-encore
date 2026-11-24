#!/usr/bin/env node
// Copies built songs and a song database to a memory stick's MUSIC folder (Pocket Encore's Install button).
//
//   node install.js --from <built MUSIC folder> --to <...\PSP\GAME\ULUS10418\MUSIC> [--db] ZSONG1 ZSONG2 ...
//
// Each song folder is replaced as a whole (copied under a temporary name first, then swapped in, so an interrupted
// copy never leaves half a song). --db replaces ZZCUSTOMDB as a whole: older song databases in it (yours or someone
// else's) go, so the game uses this one. File dates are kept (the memory stick check compares them for songs built
// before stamps existed). Nothing else on the memory stick is touched.
"use strict";
const fs = require("fs");
const path = require("path");
const DB_FOLDER = "ZZCUSTOMDB";

function main() {
  const a = process.argv.slice(2), opt = k => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  const from = opt("--from"), to = opt("--to"), db = a.includes("--db");
  const songs = a.filter((x, i) => /^Z[A-Z0-9_]+$/.test(x) && !(i > 0 && ["--from", "--to"].includes(a[i - 1])));
  if (!from || !to || (!songs.length && !db)) { console.log("usage: install.js --from <MUSIC> --to <...\\PSP\\GAME\\ULUS10418\\MUSIC> [--db] ZSONG..."); process.exit(1); }
  if (!/[\\/]PSP[\\/]GAME[\\/]ULUS10418[\\/]MUSIC[\\/]?$/i.test(to)) throw new Error(`${to} is not a ...\\PSP\\GAME\\ULUS10418\\MUSIC folder`);
  if (path.resolve(from).toUpperCase() === path.resolve(to).toUpperCase()) throw new Error("source and memory stick are the same folder");
  fs.mkdirSync(to, { recursive: true });
  const items = [...songs, ...(db ? [DB_FOLDER] : [])];
  let bytes = 0;
  const t0 = Date.now();
  for (const [k, f] of items.entries()) {
    const src = path.join(from, f), dst = path.join(to, f), tmp = path.join(to, f + ".PE_TMP");
    if (!fs.existsSync(src)) throw new Error(`${f} is not in ${from}: build it first`);
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.cpSync(src, tmp, { recursive: true, preserveTimestamps: true });
    fs.rmSync(dst, { recursive: true, force: true });
    fs.renameSync(tmp, dst);
    const size = du(dst);
    bytes += size;
    console.log(`  [${k + 1}/${items.length}] ${f}  ${(size / 1048576).toFixed(1)} MB`);
  }
  console.log(`done: ${items.length} folder(s), ${(bytes / 1048576).toFixed(1)} MB in ${((Date.now() - t0) / 1000).toFixed(1)} s -> ${to}`);
}
const du = d => fs.readdirSync(d, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? du(path.join(d, e.name)) : fs.statSync(path.join(d, e.name)).size), 0);

try { main(); } catch (e) { console.error(`\nERROR: ${e.message}`); process.exit(1); }
