#!/usr/bin/env node
// Builds a Rock Band Unplugged song database (JBxxxxxx.STR.EDAT + TEXT/STR_<LANG>_jukebox*.txt.EDAT)
// that contains the official songs of a base DLC folder plus custom songs.
//
//   node mkjukebox.js --base <MUSIC/<folder with newest JB>> --out <MUSIC/<custom folder>> \
//                     [--number 900] [--zero-hash] song1.json [song2.json ...]
//
// The game picks the folder whose JB number is highest (and that has TEXT/STR_<lang>_jukebox.TXT.EDAT),
// so --number must be above every official JB (571 on ULUS10418). These files are plain data despite
// the .EDAT extension. Output is written only to --out.
//
// song.json:
// {
//   "folder": "ZPUSHIT",                 MUSIC folder name (record id = CRC-32 of it, upper case)
//   "title": "...", "artist": "...", "album": "...",
//   "year": 1987,
//   "genre": "POP-ROCK",                 name or index (see GENRES)
//   "era": "'80S HITS",                  optional; name or index; default from year
//   "difficulty": "MODERATE",            optional; band difficulty label, name or index; default = band tier
//   "tiers": { "drums": 3, "guitar": 2, "bass": 2, "vocals": 1, "band": 3 },   0..6
//   "vocals": 1,                         optional; lead vocalist, 1 = male, 2 = female (record +0xAC)
//   "atm": "path/to/ZPUSHIT.ATM"         optional; default <out>/<folder>.ATM; its size goes to +0xF8
// }
"use strict";
const fs = require("fs");
const path = require("path");

const JB_SIZE = 0x1d580, REC0 = 0x34, REC_SIZE = 0x114, CAPACITY = 300, POOL = 0x1756c, POOL_END = POOL + 0x6000;
const FILL = 0x7f800001;
const FLAG_DLC_BASE = 0x8c;
// Label text ids in the newest DLC pack's text (533 entries: language, 112 songs x 3, then 196 labels). Lists with
// fewer songs (older packs, the disc's 55-song list with 362 entries) have the same labels, earlier by 3 per song:
// the ids are shifted by (entries - 533) (FINDINGS §34).
const TEXT_DIFF = 0x167, TEXT_ERA = 0x16e, TEXT_GENRE = 0x173, TEXT_SORT_123 = 0x1a7, TEXT_SORT_A = 0x1c2, TEXT_REF_COUNT = 533;
const DISC_B4_SENTINEL = 9999999;
const DIFFICULTIES = ["WARMUP", "APPRENTICE", "SOLID", "MODERATE", "CHALLENGING", "NIGHTMARE", "IMPOSSIBLE"];
const ERAS = ["'60S HITS", "'70S HITS", "'80S HITS", "'90S HITS", "'00S HITS"];
const GENRES = ["ALTERNATIVE", "BLUES", "CLASSIC ROCK", "COUNTRY", "EMO", "FUSION", "GLAM", "GRUNGE", "INDIE ROCK", "JAZZ",
  "METAL", "NOVELTY", "NU-METAL", "POP-ROCK", "PROG", "PUNK", "ROCK", "SOUTHERN ROCK", "URBAN"];

const crcTable = [...Array(256)].map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32Upper = s => { let c = 0xffffffff; for (const ch of Buffer.from(s.toUpperCase(), "latin1")) c = crcTable[(c ^ ch) & 0xff] ^ (c >>> 8); return (~c) >>> 0; };

function pick(list, value, what) {
  if (typeof value === "number") { if (value >= 0 && value < list.length) return value; }
  else if (typeof value === "string") { const i = list.indexOf(value.toUpperCase()); if (i >= 0) return i; }
  throw new Error(`${what}: "${value}" is not one of ${list.join(", ")} (or 0..${list.length - 1})`);
}
const tier = (t, k) => { const v = t && t[k]; if (!Number.isInteger(v) || v < 0 || v > 6) throw new Error(`tiers.${k} must be 0..6`); return v; };

function parseArgs(argv) {
  const o = { number: 900, zeroHash: false, songs: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--base") o.base = argv[++i];
    else if (a === "--out") o.out = argv[++i];
    else if (a === "--number") o.number = parseInt(argv[++i], 10);
    else if (a === "--zero-hash") o.zeroHash = true;
    else o.songs.push(a);
  }
  if (!o.base || !o.out || !o.songs.length) {
    console.log("usage: mkjukebox.js --base <dlc folder> --out <custom folder> [--number 900] [--zero-hash] song.json...");
    process.exit(1);
  }
  return o;
}

function findJb(dir) {
  const jbs = fs.readdirSync(dir).filter(f => /^JB\d{6}\.STR\.EDAT$/i.test(f)).sort();
  if (!jbs.length) throw new Error(`no JBxxxxxx.STR.EDAT in ${dir}`);
  return jbs[jbs.length - 1];
}

function readText(file) {
  const raw = fs.readFileSync(file, "utf8");
  const lines = raw.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const [countStr, rest] = lines[0].split("\t");
  const count = parseInt(countStr, 10);
  if (lines.length - 1 !== count) throw new Error(`${file}: header says ${count} entries, file has ${lines.length - 1}`);
  return { headerRest: rest, entries: lines.slice(1) };
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  const baseJbName = findJb(o.base);
  const baseNumber = parseInt(baseJbName.slice(2, 8), 10);
  if (!(o.number > baseNumber && o.number <= 999999)) throw new Error(`--number must be above the base JB number ${baseNumber}`);
  const jb = Buffer.from(fs.readFileSync(path.join(o.base, baseJbName)));
  if (jb.length !== JB_SIZE) throw new Error(`${baseJbName} is ${jb.length} bytes, expected ${JB_SIZE}`);

  const count = jb.readUInt32LE(0x30);
  const recAt = i => REC0 + i * REC_SIZE;
  const ids = new Set([...Array(count)].map((_, i) => jb.readUInt32LE(recAt(i))));

  // Template: last DLC record of the base table; a disc-only list (the disc's STREAMS/JUKEBOX.STR) has none, so the
  // last disc record with an ordinary +0xB4 value is used, with its .ATM hash (+0xF4, 0 on disc songs) left at 0.
  let tmpl = -1, fromDisc = false;
  for (let i = count - 1; i >= 0; i--) if (jb.readUInt32LE(recAt(i) + 0xc) & 0x80) { tmpl = i; break; }
  if (tmpl < 0) {
    for (let i = count - 1; i > 0; i--) if (jb.readUInt32LE(recAt(i) + 0xb4) !== DISC_B4_SENTINEL) { tmpl = i; break; }
    fromDisc = true;
  }
  if (tmpl < 0) throw new Error("base song list has no record to use as a template");
  const template = Buffer.from(jb.subarray(recAt(tmpl), recAt(tmpl) + REC_SIZE));
  if (fromDisc) template.writeUInt32LE(0, 0xf4);

  // Free space in the name pool: after the last referenced name, must be fill.
  let poolUsed = POOL;
  for (let i = 0; i < count; i++) for (const k of [4, 8]) {
    let e = POOL + jb.readUInt32LE(recAt(i) + k); while (jb[e]) e++; poolUsed = Math.max(poolUsed, e + 1);
  }
  let poolPos = (poolUsed + 3) & ~3;
  for (let p = poolPos; p < POOL_END; p += 4) if (jb.readUInt32LE(p) !== FILL) throw new Error(`name pool not free at +0x${(p - POOL).toString(16)}`);

  // Text files of the base folder.
  const textDir = path.join(o.base, "TEXT");
  const textFiles = fs.readdirSync(textDir).filter(f => /^STR_[A-Z]{2}_jukebox2?\.txt\.EDAT$/i.test(f));
  const texts = textFiles.map(f => ({ f, ...readText(path.join(textDir, f)) }));
  const textCount = texts[0].entries.length;
  if (texts.some(t => t.entries.length !== textCount)) throw new Error("text files disagree on entry count");
  const shift = textCount - TEXT_REF_COUNT;
  if ((-shift) % 3 !== 0 || textCount !== 1 + 3 * count + (TEXT_REF_COUNT - 1 - 3 * 112)) throw new Error(`text has ${textCount} entries; expected ${1 + 3 * count + 196} for ${count} songs`);

  const songs = o.songs.map(p => ({ p, s: JSON.parse(fs.readFileSync(p, "utf8")) }));
  if (count + songs.length > CAPACITY) throw new Error(`too many songs: ${count} + ${songs.length} > ${CAPACITY}`);

  const report = [];
  songs.forEach(({ p, s }, k) => {
    const folder = String(s.folder || "").toUpperCase();
    if (!/^Z[A-Z0-9]{1,46}$/.test(folder)) throw new Error(`${p}: folder must start with Z and be A-Z/0-9, max 47 chars`);
    for (const f of ["title", "artist"]) if (!s[f]) throw new Error(`${p}: "${f}" is required`);
    const id = crc32Upper(folder);
    if (ids.has(id)) throw new Error(`${p}: id ${id.toString(16)} of ${folder} collides with an existing song`);
    ids.add(id);

    const atmPath = s.atm ? path.resolve(path.dirname(p), s.atm) : path.join(o.out, folder + ".ATM");
    const atmSize = fs.statSync(atmPath).size;
    const year = Number.isInteger(s.year) ? s.year : 0;
    const era = s.era !== undefined ? pick(ERAS, s.era, "era") : Math.min(4, Math.max(0, Math.floor((year - 1960) / 10)));
    const genre = pick(GENRES, s.genre, "genre");
    const tiers = { drums: tier(s.tiers, "drums"), guitar: tier(s.tiers, "guitar"), bass: tier(s.tiers, "bass"), vocals: tier(s.tiers, "vocals"), band: tier(s.tiers, "band") };
    const difficulty = s.difficulty !== undefined ? pick(DIFFICULTIES, s.difficulty, "difficulty") : tiers.band;

    // Names into the pool.
    const lower = folder.toLowerCase();
    const nameBytes = Buffer.from(lower + "\0", "latin1");
    if (poolPos + nameBytes.length > POOL_END) throw new Error("name pool full");
    const nameOff = poolPos - POOL;
    nameBytes.copy(jb, poolPos);
    poolPos = (poolPos + nameBytes.length + 3) & ~3;

    // Text ids: title, artist, album appended to every language file.
    const textId = textCount + k * 3;
    for (const t of texts) t.entries.push(String(s.title), String(s.artist), String(s.album || ""));

    const first = String(s.title).trim()[0] || "";
    const up = first.toUpperCase();
    const sortId = shift + (up >= "A" && up <= "Z" ? TEXT_SORT_A + (up.charCodeAt(0) - 65) : TEXT_SORT_123);

    const r = Buffer.from(template);
    const w = (off, v) => r.writeUInt32LE(v >>> 0, off);
    w(0x00, id); w(0x04, nameOff); w(0x08, nameOff); w(0x0c, FLAG_DLC_BASE);
    w(0x10, textId); w(0x14, textId + 1); w(0x18, textId + 2); w(0x1c, sortId);
    w(0x20, shift + TEXT_DIFF + difficulty); w(0x24, shift + TEXT_GENRE + genre); w(0x28, shift + TEXT_ERA + era);
    w(0xa8, year);
    if (s.vocals === 1 || s.vocals === 2) w(0xac, s.vocals);
    w(0xb8, tiers.drums); w(0xbc, tiers.guitar); w(0xc0, tiers.bass); w(0xc4, tiers.vocals); w(0xc8, tiers.band);
    if (o.zeroHash) w(0xf4, 0);
    w(0xf8, atmSize);
    r.copy(jb, recAt(count + k));

    report.push({ record: count + k, folder, id: id.toString(16).padStart(8, "0"), title: s.title, artist: s.artist,
      textIds: `${textId}..${textId + 2}`, sort: sortId.toString(16), difficulty: DIFFICULTIES[difficulty], genre: GENRES[genre],
      era: ERAS[era], year, tiers, atmSize, template: tmpl });
  });

  const newCount = count + songs.length;
  jb.writeUInt32LE(newCount, 0x00);
  jb.writeUInt32LE(newCount, 0x30);

  fs.mkdirSync(path.join(o.out, "TEXT"), { recursive: true });
  const jbName = `JB${String(o.number).padStart(6, "0")}.STR.EDAT`;
  fs.writeFileSync(path.join(o.out, jbName), jb);
  for (const t of texts) {
    const body = [`${t.entries.length}\t${t.headerRest}`, ...t.entries].join("\n") + "\n";
    fs.writeFileSync(path.join(o.out, "TEXT", t.f), body, "utf8");
  }

  console.log(`base ${baseJbName} (${count} songs, template record ${tmpl}) -> ${path.join(o.out, jbName)} (${newCount} songs)`);
  console.log(`text: ${texts.length} files, ${textCount} -> ${textCount + songs.length * 3} entries`);
  for (const r of report) console.log(JSON.stringify(r));
}

main();
