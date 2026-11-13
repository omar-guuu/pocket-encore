#!/usr/bin/env node
// Custom song pack: a set of already built songs plus a song database (ZZCUSTOMDB) that lists only them, ready to
// copy to the memory stick. Switching packs = delete the old pack's song folders and ZZCUSTOMDB from MUSIC, copy
// the new pack's MUSIC contents (the game shows only the newest song database, so one pack is active at a time).
//
//   node mkpack.js --out <pack dir> [--name "Metal"] [--music <MUSIC dir>] [--jb <n>] ZSONG1 ZSONG2 ...
//
// Songs are read from rbu-tools/out/MUSIC/<FOLDER> (built by mksong.js) and rbu-tools/songs/<FOLDER>/song.json.
// Without --name the pack is called "Pocket Encore <JB code>" (the 6 digits of its JBxxxxxx.STR.EDAT).
// Output: <pack dir>/MUSIC/<FOLDER>... + <pack dir>/MUSIC/ZZCUSTOMDB/, and <pack dir>/pack.txt (what is inside and
// how to install it). Prints  PACK {json}  at the end.
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const settings = require("./settings.js");
const game = require("./game.js");

const TOOLS = path.resolve(__dirname, "..");
const SONGS = path.join(TOOLS, "songs"), BUILT = path.join(TOOLS, "out", "MUSIC");
const DB_FOLDER = "ZZCUSTOMDB", CAPACITY = 300;

// JB number = days since 2008-03-07 (as mksong.js): newer than every official pack and every earlier build
function dayNumber(date = new Date()) {
  return Math.round((Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) - Date.UTC(2008, 2, 7)) / 86400000);
}
const dirSize = d => fs.readdirSync(d, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? dirSize(path.join(d, e.name)) : fs.statSync(path.join(d, e.name)).size), 0);

function main() {
  const a = process.argv.slice(2), opt = k => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  const folders = a.filter((x, i) => /^Z[A-Z0-9_]+$/.test(x) && !(i > 0 && a[i - 1].startsWith("--")));
  const outDir = opt("--out");
  if (!outDir || !folders.length) { console.log('usage: mkpack.js --out <dir> [--name "Pack"] [--music <MUSIC>] [--jb <n>] ZSONG...'); process.exit(1); }
  const s = settings.load(), music = opt("--music") || s.music;
  const number = Number(opt("--jb") || dayNumber());
  const code = String(number).padStart(6, "0");
  const name = (opt("--name") || "").trim() || `Pocket Encore ${code}`;
  const g = game.resolve(music, s.iso);
  console.log(`pack "${name}": ${folders.length} song(s); game: ${g.label} (song list ${g.baseName})`);

  // every song must be built
  const songs = folders.map(f => {
    const json = path.join(SONGS, f, "song.json"), built = path.join(BUILT, f);
    if (!fs.existsSync(json)) throw new Error(`${f}: no songs/${f}/song.json`);
    for (const need of ["BEATMATCH.STR.EDAT", `${f}.ATM`]) if (!fs.existsSync(path.join(built, need))) throw new Error(`${f} is not built (no out/MUSIC/${f}/${need}): build it first`);
    return { folder: f, json, built, S: JSON.parse(fs.readFileSync(json, "utf8")) };
  });

  // fresh pack folder
  const M = path.join(outDir, "MUSIC");
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(M, { recursive: true });
  for (const x of songs) fs.cpSync(x.built, path.join(M, x.folder), { recursive: true });

  // the pack's own song database (only its songs)
  const tmp = path.join(SONGS, ".db", "pack"); fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true });
  const jsons = songs.map(x => {
    const q = path.join(tmp, `${x.folder}.json`);
    fs.writeFileSync(q, JSON.stringify({ ...x.S, atm: path.join(x.built, `${x.folder}.ATM`) }));
    return q;
  });
  const out = execFileSync(process.execPath, [path.join(__dirname, "mkjukebox.js"), "--base", g.base, "--out", path.join(M, DB_FOLDER), "--number", String(number), ...jsons], { encoding: "utf8" });
  const baseLine = out.split(/\r?\n/).find(l => l.startsWith("base ")) || "";
  console.log("  " + baseLine.replace(/ -> .*\(/, " -> pack song list ("));
  const official = Number((/\((\d+) songs/.exec(baseLine) || [])[1] || 0);

  const bytes = dirSize(M);
  const info = { name, code, jb: `JB${code}.STR.EDAT`, mode: g.label, songs: songs.length, official, capacity: CAPACITY - official,
    mb: +(bytes / 1048576).toFixed(1), dir: path.resolve(outDir), at: new Date().toISOString(),
    folders: songs.map(x => ({ folder: x.folder, title: x.S.title, artist: x.S.artist })) };
  const txt = [
    `${name}`,
    `Custom song pack for Rock Band Unplugged (ULUS10418), made with Pocket Encore on ${info.at.slice(0, 10)}.`,
    `Song database: ${DB_FOLDER}\\${info.jb}   Game mode: ${g.label}   ${songs.length} songs, ${info.mb} MB`,
    "",
    "Install: copy everything inside the MUSIC folder of this pack into PSP\\GAME\\ULUS10418\\MUSIC on the memory stick.",
    `Switch packs: first delete the previous pack's song folders and ${DB_FOLDER} from that MUSIC folder (its pack.txt`,
    "lists them), then copy this pack. Official DLC folders stay. Scores are kept per song, so they come back with it.",
    "",
    "Folders in this pack:",
    ...songs.map(x => `  ${x.folder.padEnd(22)} ${x.S.title} - ${x.S.artist}`),
    `  ${DB_FOLDER.padEnd(22)} song database (${info.jb})`,
    "",
  ].join("\r\n");
  fs.writeFileSync(path.join(outDir, "pack.txt"), txt, "utf8");
  console.log(`  ${songs.length} songs, ${info.mb} MB -> ${path.resolve(outDir)}`);
  console.log("PACK " + JSON.stringify(info));
}

try { main(); } catch (e) { console.error(`\nERROR: ${e.message}`); process.exit(1); }
