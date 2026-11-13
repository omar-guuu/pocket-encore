#!/usr/bin/env node
// Limits stress test (RBU_CUSTOM_SONGS.md §5): fills the song database to its cap with copies of one small base song.
//
//   node stresspack.js [--count 179] [--base stress/ZSTRESS000] [--out stress/out/MUSIC]
//
// Output: <out>/ZSTRESS001..ZSTRESSnnn (copies of the built base song, files renamed) and <out>/ZZCUSTOMDB with the
// real customs (songs/*, as last built) + the copies. Titles, artists, genres, years and tiers vary so sorting and
// filters get exercised. Default count = what fills the database to 300 songs. The copies share one ATM, so the
// chart's ATM hash matches for all of them. Nothing is written outside <out>.
"use strict";
const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
const TOOLS = path.resolve(__dirname, "..");
const a = process.argv.slice(2), opt = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
const base = path.resolve(TOOLS, opt("--base", "stress/ZSTRESS000"));
const out = path.resolve(TOOLS, opt("--out", "stress/out/MUSIC"));
const MUSIC = require("./settings.js").load().music;
const GENRES = ["ALTERNATIVE", "BLUES", "CLASSIC ROCK", "COUNTRY", "EMO", "FUSION", "GLAM", "GRUNGE", "INDIE ROCK", "JAZZ",
  "METAL", "NOVELTY", "NU-METAL", "POP-ROCK", "PROG", "PUNK", "ROCK", "SOUTHERN ROCK", "URBAN"];

const B = JSON.parse(fs.readFileSync(path.join(base, "song.json"), "utf8"));
const bb = path.join(base, "build");
for (const f of ["BEATMATCH.STR.EDAT", `${B.folder}.ATM`, `${B.folder}_PREVIEW.AT3`])
  if (!fs.existsSync(path.join(bb, f))) throw new Error(`build the base song first (missing ${f}): node mksong.js ${base}/song.json --out stress/tmp`);

// real customs: songs/*/song.json with their built ATM
const songs = path.join(TOOLS, "songs");
const real = fs.readdirSync(songs).map(d => path.join(songs, d, "song.json")).filter(p => fs.existsSync(p)).map(p => {
  const s = JSON.parse(fs.readFileSync(p, "utf8"));
  return { ...s, atm: path.join(path.dirname(p), "build", `${s.folder}.ATM`) };
}).filter(s => fs.existsSync(s.atm));
const count = parseInt(opt("--count", String(300 - 112 - real.length)), 10);
if (112 + real.length + count > 300) throw new Error(`${count} copies + ${real.length} customs + 112 official > 300`);

fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });
const tmp = path.join(path.dirname(out), "db"); fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true });
const jsons = [];
for (const s of real) { const q = path.join(tmp, `${s.folder}.json`); fs.writeFileSync(q, JSON.stringify(s)); jsons.push(q); }
for (let i = 1; i <= count; i++) {
  const n = String(i).padStart(3, "0"), folder = `ZSTRESS${n}`, d = path.join(out, folder);
  fs.mkdirSync(d);
  fs.copyFileSync(path.join(bb, "BEATMATCH.STR.EDAT"), path.join(d, "BEATMATCH.STR.EDAT"));
  fs.copyFileSync(path.join(bb, `${B.folder}.ATM`), path.join(d, `${folder}.ATM`));
  fs.copyFileSync(path.join(bb, `${B.folder}_PREVIEW.AT3`), path.join(d, `${folder}_PREVIEW.AT3`));
  const t = k => (i * k) % 7;
  const s = { folder, title: `Stress Test ${n}`, artist: `Stress Artist ${String.fromCharCode(65 + (i * 7) % 26)}`,
    album: "Stress Test", year: 1960 + (i * 13) % 67, genre: GENRES[i % GENRES.length],
    tiers: { drums: t(1), guitar: t(3), bass: t(5), vocals: t(2), band: t(4) }, vocals: 1 + (i % 2),
    atm: path.join(d, `${folder}.ATM`) };
  const q = path.join(tmp, `${folder}.json`); fs.writeFileSync(q, JSON.stringify(s)); jsons.push(q);
}
const days = Math.floor((Date.now() - Date.UTC(2008, 2, 7)) / 86400000);
execFileSync(process.execPath, [path.join(__dirname, "mkjukebox.js"), "--base", path.join(MUSIC, "YOURENOROCKNROLLFUN"),
  "--out", path.join(out, "ZZCUSTOMDB"), "--number", String(days), ...jsons], { stdio: ["ignore", "ignore", "inherit"] });
const jb = fs.readdirSync(path.join(out, "ZZCUSTOMDB")).find(f => f.startsWith("JB"));
let bytes = 0; for (const d of fs.readdirSync(out)) for (const f of fs.readdirSync(path.join(out, d))) { const st = fs.statSync(path.join(out, d, f)); if (st.isFile()) bytes += st.size; }
console.log(`${count} copies + ${real.length} customs + 112 official = ${112 + real.length + count} songs; ${jb}; ${(bytes / 2 ** 30).toFixed(2)} GB in ${out}`);
