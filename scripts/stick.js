// Memory sticks: what is installed in the game's MUSIC folder, and the files that tell builds apart.
//
// Stamps (written next to what the game reads; the game only looks at "BEATMATCH.STR*" and "JB<6 digits>.STR.EDAT"
// files, FINDINGS §1, so other files are ignored by it):
//   <FOLDER>/PESONG.JSON     every built song: its details (title, artist, tiers…), a build id (hash of the song's
//                            files) and the build date. Lets Pocket Encore tell an installed song from an older build
//                            and import a song someone shared.
//   ZZCUSTOMDB/PEDB.JSON     the song database: its JB file, the songs it lists, the pack name.
// Nothing personal goes in them: the library id is a random code made once per library (songs/.db/library.json).
//
// Memory sticks Pocket Encore can see: PPSSPP's (the MUSIC folder on the Setup page) and a PSP connected by USB (a
// drive with a PSP folder). The last check of each is kept in songs/.db/sticks.json, so an unplugged PSP still shows
// what was on it.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const TOOLS = path.resolve(__dirname, "..");
const DBDIR = path.join(TOOLS, "songs", ".db");
const GAME_ID = "ULUS10418", DB_FOLDER = "ZZCUSTOMDB";
const STAMP = "PESONG.JSON", DBSTAMP = "PEDB.JSON";
const JB_SIZE = 0x1d580, REC0 = 0x34, REC_SIZE = 0x114, POOL = 0x1756c;
const OFFICIAL_MAX = 571;  // highest official JB (2009-09-29)
const TEXT_DIFF = 0x167, TEXT_ERA = 0x16e, TEXT_GENRE = 0x173, TEXT_REF_COUNT = 533;
const DIFFICULTIES = ["WARMUP", "APPRENTICE", "SOLID", "MODERATE", "CHALLENGING", "NIGHTMARE", "IMPOSSIBLE"];
const ERAS = ["'60S HITS", "'70S HITS", "'80S HITS", "'90S HITS", "'00S HITS"];
const GENRES = ["ALTERNATIVE", "BLUES", "CLASSIC ROCK", "COUNTRY", "EMO", "FUSION", "GLAM", "GRUNGE", "INDIE ROCK", "JAZZ",
  "METAL", "NOVELTY", "NU-METAL", "POP-ROCK", "PROG", "PUNK", "ROCK", "SOUTHERN ROCK", "URBAN"];

const sha1 = b => crypto.createHash("sha1").update(b).digest("hex");
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 1)); };
// JB number = days since 2008-03-07 (the official packs' scheme)
function dayNumber(date = new Date()) {
  return Math.round((Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) - Date.UTC(2008, 2, 7)) / 86400000);
}
// a file in dir whatever its case (the memory stick is FAT: case-insensitive, but names keep their case)
function findFile(dir, name) {
  try { const f = fs.readdirSync(dir).find(x => x.toUpperCase() === name.toUpperCase()); return f ? path.join(dir, f) : null; } catch { return null; }
}

// ---------- this library ----------
function libraryId() {
  const f = path.join(DBDIR, "library.json");
  const v = readJson(f);
  if (v && /^[0-9a-f]{12}$/.test(v.id)) return v.id;
  const id = crypto.randomBytes(6).toString("hex");
  writeJson(f, { id, note: "random code that tells this library's builds apart from other people's; nothing personal" });
  return id;
}
// song databases this library built: { number, sha1, at, pack? } (newest last)
const HISTORY = path.join(DBDIR, "db-history.json");
const dbHistory = () => readJson(HISTORY) || [];
function recordDb(jbFile, extra = {}) {
  const h = dbHistory(), b = fs.readFileSync(jbFile);
  h.push({ number: parseInt(path.basename(jbFile).slice(2, 8), 10), sha1: sha1(b), at: new Date().toISOString(), ...extra });
  writeJson(HISTORY, h.slice(-200));
}

// ---------- song database (JB + TEXT) ----------
function readText(dbDir) {
  const t = findFile(path.join(dbDir, "TEXT"), "STR_EN_jukebox.txt.EDAT");
  if (!t) return null;
  const lines = fs.readFileSync(t, "utf8").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return { count: parseInt(lines[0], 10), entries: lines.slice(1).map(l => l.replace(/\r$/, "")) };
}
// records of a JB file; with its TEXT, the names of each record (only trusted when the TEXT was made for this JB)
function readDb(jbFile) {
  const jb = fs.readFileSync(jbFile), count = jb.readUInt32LE(0x30);
  const name = o => { let e = POOL + o, s = ""; while (e < jb.length && jb[e]) s += String.fromCharCode(jb[e++]); return s; };
  const recs = [];
  for (let i = 0; i < count && i < 300; i++) {
    const r = REC0 + i * REC_SIZE, u = k => jb.readUInt32LE(r + k);
    recs.push({ index: i, id: u(0), name: name(u(4)).toUpperCase(), flags: u(0xc), text: [u(0x10), u(0x14), u(0x18)], sort: u(0x1c),
      diff: u(0x20), genre: u(0x24), era: u(0x28), year: u(0xa8), vocals: u(0xac),
      tiers: { drums: u(0xb8), guitar: u(0xbc), bass: u(0xc0), vocals: u(0xc4), band: u(0xc8) }, atmSize: u(0xf8) });
  }
  const customs = recs.filter(r => r.name.startsWith("Z"));
  const official = count - customs.length;
  // label text ids are shifted by the base list's text size (mkjukebox.js)
  const shift = 1 + 3 * official + 196 - TEXT_REF_COUNT;
  const text = readText(path.dirname(jbFile));
  const textOk = !!text && text.entries.length === 1 + 3 * count + 196 && text.count === text.entries.length;
  for (const r of customs) {
    const g = r.genre - shift - TEXT_GENRE, e = r.era - shift - TEXT_ERA, d = r.diff - shift - TEXT_DIFF;
    r.details = { genre: GENRES[g], era: ERAS[e], difficulty: DIFFICULTIES[d], year: r.year || undefined,
      vocals: r.vocals === 1 || r.vocals === 2 ? r.vocals : undefined, tiers: r.tiers };
    if (textOk) [r.details.title, r.details.artist, r.details.album] = r.text.map(i => text.entries[i]);  // id = index after the count line
  }
  return { file: jbFile, number: parseInt(path.basename(jbFile).slice(2, 8), 10), count, official, customs, textOk,
    textCount: text ? text.entries.length : null, sha1: sha1(jb) };
}

// ---------- song stamps ----------
function buildId(songDir, folder) {
  const h = crypto.createHash("sha1");
  for (const f of ["BEATMATCH.STR.EDAT", `${folder}.ATM`, `${folder}_PREVIEW.AT3`]) {
    const p = findFile(songDir, f);
    h.update(f + "\0"); if (p) h.update(fs.readFileSync(p));
  }
  return h.digest("hex").slice(0, 16);
}
// S = song.json; extra = { chart, app }
function writeStamp(songDir, S, extra = {}) {
  const pick = (o, ks) => Object.fromEntries(ks.filter(k => o && o[k] !== undefined && o[k] !== "").map(k => [k, o[k]]));
  const stamp = {
    pocketEncore: 1, ...pick(S, ["folder", "title", "artist", "album", "year", "genre", "era", "difficulty", "tiers", "vocals"]),
    ...(S.stemSource ? { stemSource: pick(S.stemSource, ["type", "tool", "quality"]) } : {}),
    ...extra, build: buildId(songDir, S.folder), builtAt: new Date().toISOString(), library: libraryId(),
  };
  fs.writeFileSync(path.join(songDir, STAMP), JSON.stringify(stamp, null, 1));
  return stamp;
}
const readStamp = songDir => { const f = findFile(songDir, STAMP); return f ? readJson(f) : null; };
function writeDbStamp(dbDir, info) {
  const jb = fs.readdirSync(dbDir).find(f => /^JB\d{6}\.STR\.EDAT$/i.test(f));
  const v = { pocketEncore: 1, jb, sha1: sha1(fs.readFileSync(path.join(dbDir, jb))), builtAt: new Date().toISOString(), library: libraryId(), ...info };
  fs.writeFileSync(path.join(dbDir, DBSTAMP), JSON.stringify(v, null, 1));
  return v;
}

// ---------- a MUSIC folder: song folders, song databases, the one the game uses ----------
// { exists, songs: { FOLDER: { files: {NAME: {size, mtime}}, stamp } }, dbs: [...], active, tie }
function scanMusic(music, { hashAll = true } = {}) {
  if (!music || !fs.existsSync(music)) return { exists: false, music, songs: {}, dbs: [] };
  const songs = {}, dbs = [];
  let dirs = [];
  try { dirs = fs.readdirSync(music, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); } catch (e) { return { exists: false, music, error: e.message, songs: {}, dbs: [] }; }
  for (const d of dirs) {
    const dir = path.join(music, d);
    let files = [];
    try { files = fs.readdirSync(dir); } catch { continue; }
    if (files.some(f => /^BEATMATCH\.STR/i.test(f)) && /^Z/i.test(d)) {
      const info = {};
      for (const f of files) { try { const st = fs.statSync(path.join(dir, f)); if (st.isFile()) info[f.toUpperCase()] = { size: st.size, mtime: Math.round(st.mtimeMs / 1000) }; } catch { } }
      songs[d.toUpperCase()] = { dir: d, files: info, stamp: info[STAMP] ? readStamp(dir) : null };
    }
    for (const f of files.filter(x => /^JB\d{6}\.STR\.EDAT$/i.test(x))) {
      const p = path.join(dir, f), number = parseInt(f.slice(2, 8), 10);
      let size = 0; try { size = fs.statSync(p).size; } catch { }
      const hasText = !!findFile(path.join(dir, "TEXT"), "STR_EN_jukebox.txt.EDAT");
      const db = { folder: d, file: f, number, valid: size === JB_SIZE && hasText };
      if (number > OFFICIAL_MAX && size === JB_SIZE && hashAll) { try { db.sha1 = sha1(fs.readFileSync(p)); } catch { } }
      dbs.push(db);
    }
  }
  const valid = dbs.filter(d => d.valid), top = valid.length ? Math.max(...valid.map(d => d.number)) : null;
  const tops = valid.filter(d => d.number === top);
  let active = null;
  if (tops.length) {
    const a = tops[0];
    try {
      const r = readDb(path.join(music, a.folder, a.file));
      const stampFile = findFile(path.join(music, a.folder), DBSTAMP), ds = stampFile ? readJson(stampFile) : null;
      active = { ...a, count: r.count, official: r.official, textOk: r.textOk, textCount: r.textCount, sha1: r.sha1,
        customs: r.customs.map(c => ({ folder: c.name, title: c.details.title, artist: c.details.artist })),
        stamp: ds && ds.jb && ds.jb.toUpperCase() === a.file.toUpperCase() ? ds : null,
        others: dbs.filter(d => d.folder === a.folder && d.file !== a.file && d.number > OFFICIAL_MAX).map(d => d.file) };
    } catch (e) { active = { ...a, error: e.message }; }
  }
  return { exists: true, music, songs, dbs, active, tie: tops.length > 1 ? tops.map(d => d.folder) : null };
}

// ---------- memory sticks ----------
const STICKS = path.join(DBDIR, "sticks.json");
function volumeSerial(drive) {
  try {
    const out = execFileSync("cmd", ["/c", "vol", drive], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 4000 });
    const m = /([0-9A-F]{4}-[0-9A-F]{4})/i.exec(out);
    return m ? m[1].toUpperCase() : null;
  } catch { return null; }
}
// connected sticks: [{ id, kind, label, music, root }]
function connected(settingsMusic) {
  const out = [];
  if (settingsMusic) out.push({ id: "ppsspp", kind: "ppsspp", label: "PPSSPP memory stick", music: path.resolve(settingsMusic), root: path.resolve(settingsMusic, "..", "..", "..", "..") });
  if (process.platform === "win32") {
    for (const L of "DEFGHIJKLMNOPQRSTUVWXYZ") {
      const root = `${L}:\\`;
      if (out.some(s => s.music.toUpperCase().startsWith(root.toUpperCase()))) continue;
      let ok = false;
      try { ok = fs.existsSync(path.join(root, "PSP")) && fs.statSync(path.join(root, "PSP")).isDirectory(); } catch { }
      if (!ok) continue;
      const serial = volumeSerial(`${L}:`);
      out.push({ id: "psp-" + (serial || L), kind: "psp", label: `PSP memory stick (${L}:)`, drive: `${L}:`, serial, music: path.join(root, "PSP", "GAME", GAME_ID, "MUSIC"), root });
    }
  }
  return out;
}
const remembered = () => readJson(STICKS) || {};
function remember(stick, scan) {
  const all = remembered();
  // keep what an unplugged stick had: song folders (with build ids and sizes) and its song databases
  all[stick.id] = { id: stick.id, kind: stick.kind, label: stick.label, music: stick.music, at: new Date().toISOString(),
    scan: { exists: scan.exists, songs: scan.songs, dbs: scan.dbs, active: scan.active, tie: scan.tie } };
  writeJson(STICKS, all);
}

// ---------- the next song database number ----------
// Today's day number, but above every song database on the memory sticks that this library didn't build (someone
// else's pack): the game uses the highest number, so ours must win. Our own older databases are replaced anyway.
function nextDbNumber(settingsMusic, scans) {
  const mine = new Set(dbHistory().map(h => h.sha1));
  let top = 0;
  const all = scans || [...connected(settingsMusic).map(s => scanMusic(s.music)), ...Object.values(remembered()).map(r => r.scan || {})];
  for (const sc of all) for (const d of sc.dbs || []) if (d.valid && d.number > OFFICIAL_MAX && !(d.sha1 && mine.has(d.sha1))) top = Math.max(top, d.number);
  return { number: Math.max(dayNumber(), top + 1), foreignTop: top || null };
}

module.exports = { STAMP, DBSTAMP, DB_FOLDER, GAME_ID, GENRES, ERAS, DIFFICULTIES, JB_SIZE, OFFICIAL_MAX, dayNumber, findFile,
  libraryId, dbHistory, recordDb, readDb, readText, buildId, writeStamp, readStamp, writeDbStamp, scanMusic, connected,
  remembered, remember, nextDbNumber, sha1 };
