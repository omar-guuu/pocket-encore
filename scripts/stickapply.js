#!/usr/bin/env node
// Applies the Memory stick page's plan to a memory stick's MUSIC folder: copies songs, writes a song database that
// lists exactly the songs switched on, and removes song folders.
//
//   node stickapply.js --from <built MUSIC folder> --to <...\PSP\GAME\ULUS10418\MUSIC>
//                      [--copy ZA,ZB] [--db ZA,ZB,ZC | --db-none] [--remove ZD,ZE]
//
// --copy    song folders replaced as a whole (copied under a temporary name first, then swapped in, so an interrupted
//           copy never leaves half a song). File dates are kept (the memory stick check compares them).
// --db      a new song database (ZZCUSTOMDB) listing exactly these songs (built from songs/<F>/song.json and the built
//           .ATM in --from), replacing ZZCUSTOMDB as a whole. Its number is above any other build's database.
// --db-none no custom song database: ZZCUSTOMDB is deleted (the game lists the official songs only).
// --remove  song folders deleted from the memory stick (only Z... folders with a BEATMATCH file: song folders).
// Order: copy, song database, remove; so the game never lists a song whose folder is half copied.
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const settings = require("./settings.js");
const game = require("./game.js");
const stick = require("./stick.js");

const TOOLS = path.resolve(__dirname, "..");
const SONGS = path.join(TOOLS, "songs");
const DB_FOLDER = stick.DB_FOLDER, SONG_RE = /^Z[A-Z0-9_]{1,46}$/;
const du = d => fs.readdirSync(d, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? du(path.join(d, e.name)) : fs.statSync(path.join(d, e.name)).size), 0);
const list = v => (v || "").split(",").map(x => x.trim().toUpperCase()).filter(Boolean);

// swap a folder in: copy to <dst>.PE_TMP, then replace <dst>
function swapIn(src, dst) {
  const tmp = dst + ".PE_TMP";
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.cpSync(src, tmp, { recursive: true, preserveTimestamps: true });
  fs.rmSync(dst, { recursive: true, force: true });
  fs.renameSync(tmp, dst);
}

function main() {
  const a = process.argv.slice(2), opt = k => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  const from = opt("--from"), to = opt("--to"), copy = list(opt("--copy")), remove = list(opt("--remove"));
  const dbSongs = a.includes("--db") ? list(opt("--db")) : null, dbNone = a.includes("--db-none");
  if (!from || !to || (!copy.length && !remove.length && !dbSongs && !dbNone)) {
    console.log("usage: stickapply.js --from <MUSIC> --to <...\\PSP\\GAME\\ULUS10418\\MUSIC> [--copy ZA,ZB] [--db ZA,ZB | --db-none] [--remove ZC]");
    process.exit(1);
  }
  if (!/[\\/]PSP[\\/]GAME[\\/]ULUS10418[\\/]MUSIC[\\/]?$/i.test(to)) throw new Error(`${to} is not a ...\\PSP\\GAME\\ULUS10418\\MUSIC folder`);
  if (path.resolve(from).toUpperCase() === path.resolve(to).toUpperCase()) throw new Error("source and memory stick are the same folder");
  for (const f of [...copy, ...remove, ...(dbSongs || [])]) if (!SONG_RE.test(f) || f === DB_FOLDER) throw new Error(`${f}: not a song folder name`);
  const both = copy.filter(f => remove.includes(f));
  if (both.length) throw new Error(`${both.join(", ")}: both copied and removed`);
  fs.mkdirSync(to, { recursive: true });
  const t0 = Date.now();
  let bytes = 0;

  if (copy.length) console.log(`[copy] ${copy.length} song(s)`);
  for (const [k, f] of copy.entries()) {
    const src = path.join(from, f);
    if (!fs.existsSync(path.join(src, "BEATMATCH.STR.EDAT"))) throw new Error(`${f} is not built (${src}): build it first`);
    swapIn(src, path.join(to, f));
    const size = du(path.join(to, f)); bytes += size;
    console.log(`  [${k + 1}/${copy.length}] ${f}  ${(size / 1048576).toFixed(1)} MB`);
  }

  if (dbSongs) {
    console.log(`[song database] ${dbSongs.length} song(s): ${dbSongs.join(", ")}`);
    const s = settings.load(), g = game.resolve(s.music, s.iso);
    const number = stick.nextDbNumber(s.music).number, code = String(number).padStart(6, "0");
    const tmp = path.join(SONGS, ".db", "stick"), out = path.join(tmp, DB_FOLDER);
    fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true });
    const jsons = dbSongs.map(f => {
      const json = path.join(SONGS, f, "song.json"), atm = path.join(from, f, `${f}.ATM`);
      if (!fs.existsSync(json)) throw new Error(`${f}: not in your songs (no songs/${f}/song.json)`);
      if (!fs.existsSync(atm)) throw new Error(`${f} is not built (no ${atm})`);
      if (!fs.existsSync(path.join(to, f, "BEATMATCH.STR.EDAT"))) throw new Error(`${f} is not on the memory stick: copy it too`);
      const q = path.join(tmp, `${f}.json`);
      fs.writeFileSync(q, JSON.stringify({ ...JSON.parse(fs.readFileSync(json, "utf8")), atm }));
      return q;
    });
    execFileSync(process.execPath, [path.join(__dirname, "mkjukebox.js"), "--base", g.base, "--out", out, "--number", String(number), ...jsons], { encoding: "utf8" });
    stick.writeDbStamp(out, { kind: "stick", songs: dbSongs });
    stick.recordDb(path.join(out, `JB${code}.STR.EDAT`), { stick: true });
    swapIn(out, path.join(to, DB_FOLDER));
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(`  JB${code}.STR.EDAT (${g.label}) -> ${DB_FOLDER}`);
  } else if (dbNone && fs.existsSync(path.join(to, DB_FOLDER))) {
    fs.rmSync(path.join(to, DB_FOLDER), { recursive: true, force: true });
    console.log(`[song database] none: ${DB_FOLDER} removed (the game lists the official songs only)`);
  }

  if (remove.length) console.log(`[remove] ${remove.length} song folder(s)`);
  for (const f of remove) {
    const dir = path.join(to, f);
    if (!fs.existsSync(dir)) { console.log(`  ${f}: not there`); continue; }
    if (!fs.readdirSync(dir).some(x => /^BEATMATCH\.STR/i.test(x))) throw new Error(`${f}: not a song folder (no BEATMATCH file), left as it is`);
    const size = du(dir);
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`  ${f}  ${(size / 1048576).toFixed(1)} MB removed`);
  }
  console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${(bytes / 1048576).toFixed(1)} MB copied -> ${to}`);
}

try { main(); } catch (e) { console.error(`\nERROR: ${e.message}`); process.exit(1); }
