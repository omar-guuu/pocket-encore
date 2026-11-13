// The user's copy of Rock Band Unplugged (ULUS10418): where it is, and which files a build takes from it.
//
// Modes (decided from the MUSIC folder every time a build or Pocket Encore starts):
//   dlc     SHESNOTTHERE and YOURENOROCKNROLLFUN are in MUSIC: chart container = SHESNOTTHERE's chart, song list =
//           YOURENOROCKNROLLFUN's (disc + all DLC + customs).
//   partial some official DLC, but not those two: chart container = one of the user's DLC charts, song list = the
//           newest one the user has (the game only shows the newest list, so their DLC songs stay listed).
//   disc    no official DLC: chart container and song list come from the game disc image (ISO/CSO): the list holds
//           the 55 disc songs + customs (FINDINGS §34).
// Game files are only read from the user's own copies; disc files are cached in rbu-tools/cache (never in the repo).
"use strict";
const fs = require("fs");
const path = require("path");

const TOOLS = path.resolve(__dirname, "..");
const GAME_ID = "ULUS10418";
const DLC_DONOR = "SHESNOTTHERE", DLC_BASE = "YOURENOROCKNROLLFUN";
const DISC_DONOR = "MRBRIGHTSIDE";  // disc chart with no screen effects, close to SHESNOTTHERE in size (FINDINGS §34)
const HOME = process.env.USERPROFILE || process.env.HOME || "";

// ---------- detection ----------
// PPSSPP memory sticks: portable installs keep "memstick" next to the exe, installed ones use Documents\PPSSPP.
function memstickCandidates() {
  const c = [
    path.join(HOME, "Documents", "PPSSPP"), path.join(HOME, "OneDrive", "Documents", "PPSSPP"),
    "C:/PSP/ppsspp_win/memstick", "C:/PPSSPP/memstick", "C:/Program Files/PPSSPP/memstick", "C:/Program Files (x86)/PPSSPP/memstick",
    path.join(process.env.LOCALAPPDATA || "", "PPSSPP", "memstick"),
  ];
  return [...new Set(c.map(p => path.resolve(p)))].filter(p => fs.existsSync(path.join(p, "PSP")));
}
// Is this file a ULUS10418 disc image? (UMD_DATA.BIN starts with "ULUS-10418")
function isGameImage(file) {
  try {
    const { openImage } = require("./iso.js");
    const iso = openImage(file);
    try { return iso.read("UMD_DATA.BIN").toString("ascii", 0, 10).replace("-", "") === GAME_ID; } finally { iso.close(); }
  } catch { return false; }
}
function recentFromIni(memstick) {
  try {
    const ini = fs.readFileSync(path.join(memstick, "PSP", "SYSTEM", "ppsspp.ini"), "utf8");
    const sec = ini.split(/\r?\n\[/).find(s => s.startsWith("Recent]")) || "";
    return [...sec.matchAll(/^FileName\d+\s*=\s*(.+)$/gm)].map(m => m[1].trim());
  } catch { return []; }
}
function detect() {
  const found = { memstick: null, music: null, iso: null };
  for (const m of memstickCandidates()) {
    const game = path.join(m, "PSP", "GAME");
    if (!found.memstick) found.memstick = m;
    if (fs.existsSync(path.join(game, GAME_ID))) { found.memstick = m; found.music = path.join(game, GAME_ID, "MUSIC"); }
    const imgs = [
      ...recentFromIni(m),
      ...(fs.existsSync(game) ? fs.readdirSync(game).filter(f => /\.(iso|cso)$/i.test(f)).map(f => path.join(game, f)) : []),
      ...(fs.existsSync(path.join(m, "ISO")) ? fs.readdirSync(path.join(m, "ISO")).filter(f => /\.(iso|cso)$/i.test(f)).map(f => path.join(m, "ISO", f)) : []),
    ];
    // images named after the game first, then the rest (checked by their UMD_DATA.BIN)
    imgs.sort((a, b) => (path.basename(b).toUpperCase().includes(GAME_ID)) - (path.basename(a).toUpperCase().includes(GAME_ID)));
    if (!found.iso) found.iso = imgs.find(f => fs.existsSync(f) && isGameImage(f)) || null;
    if (found.music && found.iso) break;
  }
  return found;
}

// ---------- mode ----------
function dlcFolders(music) {
  if (!music || !fs.existsSync(music)) return [];
  return fs.readdirSync(music, { withFileTypes: true }).filter(e => e.isDirectory() && !/^Z/i.test(e.name)).map(e => {
    const dir = path.join(music, e.name), files = fs.readdirSync(dir);
    const jb = files.find(f => /^JB\d{6}\.STR\.EDAT$/i.test(f));
    const bm = files.find(f => /^BEATMATCH\.STR\.EDAT$/i.test(f));
    return jb && bm ? { name: e.name, dir, jb, jbNumber: parseInt(jb.slice(2, 8), 10), chart: path.join(dir, bm) } : null;
  }).filter(Boolean);
}
function mode(music, iso) {
  const dlc = dlcFolders(music);
  const by = n => dlc.find(d => d.name.toUpperCase() === n);
  if (by(DLC_DONOR) && by(DLC_BASE)) {
    return { mode: "dlc", label: "Disc + DLC", dlc: dlc.length, donor: by(DLC_DONOR).chart, donorName: DLC_DONOR, base: by(DLC_BASE).dir, baseName: DLC_BASE };
  }
  if (dlc.length) {
    const newest = dlc.reduce((a, b) => (b.jbNumber > a.jbNumber ? b : a));
    const donor = by(DLC_DONOR) || [...dlc].sort((a, b) => a.name.localeCompare(b.name))[0];
    return { mode: "partial", label: "Disc + some DLC", dlc: dlc.length, donor: donor.chart, donorName: donor.name, base: newest.dir, baseName: newest.name };
  }
  return { mode: "disc", label: "Disc only", dlc: 0, donor: null, donorName: DISC_DONOR + " (disc)", base: null, baseName: "the disc's song list", needsIso: true, iso: iso || null };
}

// ---------- disc files (cached) ----------
// cache/disc-<size>-<mtime>/: base/JB000000.STR.EDAT (= STREAMS/JUKEBOX.STR) + base/TEXT/STR_<LANG>_jukebox(2).txt.EDAT
// (= TEXT/STR_<LANG>_JUKEBOX.TXT; DLC packs ship the same text twice), donor/BEATMATCH.STR (a disc song's chart).
function prepareDisc(iso) {
  if (!iso || !fs.existsSync(iso)) throw new Error("Disc-only mode needs the game's disc image (ISO or CSO): set it on the Setup page");
  const st = fs.statSync(iso);
  const dir = path.join(TOOLS, "cache", `disc-${st.size}-${Math.round(st.mtimeMs)}`);
  const base = path.join(dir, "base"), donor = path.join(dir, "donor", "BEATMATCH.STR");
  if (fs.existsSync(path.join(dir, "ok"))) return { base, donor };
  const { openImage } = require("./iso.js");
  const img = openImage(iso);
  try {
    if (img.read("UMD_DATA.BIN").toString("ascii", 0, 10).replace("-", "") !== GAME_ID) throw new Error(`${iso} is not Rock Band Unplugged (${GAME_ID})`);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(base, "TEXT"), { recursive: true });
    fs.mkdirSync(path.dirname(donor), { recursive: true });
    fs.writeFileSync(path.join(base, "JB000000.STR.EDAT"), img.read("PSP_GAME/USRDIR/STREAMS/JUKEBOX.STR"));
    for (const e of img.list("PSP_GAME/USRDIR/TEXT")) {
      const m = /^STR_([A-Z]{2})_JUKEBOX\.TXT$/i.exec(e.name);
      if (!m) continue;
      const t = img.read(`PSP_GAME/USRDIR/TEXT/${e.name}`);
      fs.writeFileSync(path.join(base, "TEXT", `STR_${m[1]}_jukebox.txt.EDAT`), t);
      fs.writeFileSync(path.join(base, "TEXT", `STR_${m[1]}_jukebox2.txt.EDAT`), t);
    }
    fs.writeFileSync(donor, img.read(`PSP_GAME/USRDIR/MUSIC/${DISC_DONOR}/BEATMATCH.STR`));
    fs.writeFileSync(path.join(dir, "ok"), new Date().toISOString());
  } finally { img.close(); }
  return { base, donor };
}

// Chart container and song-list base for a build: { mode, donor, base }
function resolve(music, iso) {
  const m = mode(music, iso);
  if (m.mode !== "disc") return m;
  const d = prepareDisc(iso);
  return { ...m, donor: d.donor, base: d.base };
}

module.exports = { detect, mode, resolve, prepareDisc, isGameImage, dlcFolders, GAME_ID, DISC_DONOR };
