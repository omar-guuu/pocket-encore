#!/usr/bin/env node
// Turns a Rock Band Unplugged chart (BEATMATCH.STR.EDAT, official or custom) into a REAPER-ready folder:
// a Rock Band-format MIDI plus the five audio tracks as WAV, all starting at 0.
//
//   node reaperpack.js --official CRUSHCRUSHCRUSH      (official song -> rbu-tools/reaper/official/CRUSHCRUSHCRUSH)
//   node reaperpack.js <BEATMATCH.STR.EDAT> <out dir> [--atm <song.ATM>] [--wav <dir with the 5 wavs>] [--name NAME]
//                      [--vocals keys|vocals]
//
// MIDI (480 ticks per beat), the layout mid2rbu reads and the Rock Band (RBN) REAPER template uses:
// - tempo map and time signatures from the chart; BEAT track (note 12 = downbeat, 13 = other beats).
// - PART DRUMS / PART BASS / PART GUITAR: Easy 60.., Medium 72.., Hard 84.., Expert 96.. Guitar and bass lanes 0-3 =
//   green, red, yellow, blue (orange unused); drums lanes 0-3 = red, yellow, blue, green pads (kick unused).
// - Vocals: Unplugged plays them as 4 lanes like the others. The RBN preview draws PART VOCALS as a singing line, so
//   by default they go to PART KEYS (same note layout) to be visible and editable as gems; chartimport.py turns
//   PART KEYS back into PART VOCALS. --vocals vocals writes them to PART VOCALS instead.
// - Overdrive phrases: note 116 (from the Expert gems, as in Rock Band one marker serves every difficulty).
// - Solos: note 103.
// - Note length = the gem's length in ticks; gems the game plays as taps (no sustain) get at most 120 ticks
//   (mid2rbu treats notes of 160 ticks or less as taps).
// Audio: --atm decodes the song's .ATM (atmtool + at3tool); --wav copies already-decoded tracks.
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { sections, Image } = require("./beatmatch.js");

const TRACKS = ["drums", "bass_guitar", "lead_guitar", "vocals", "fill"];
const PART = ["PART DRUMS", "PART BASS", "PART GUITAR", "PART VOCALS"];
const DIFF_BASE = [60, 72, 84, 96];
const OD = 1 << 25, SOLO = 1 << 27;

// ---------- minimal Standard MIDI File writer ----------
function vlq(n) { const out = [n & 0x7f]; while ((n >>= 7)) out.unshift((n & 0x7f) | 0x80); return out; }
function trackChunk(name, events /* [tick, order, bytes[]] */) {
  const evs = [[0, -1, [0xff, 0x03, ...vlq(Buffer.byteLength(name)), ...Buffer.from(name, "latin1")]], ...events];
  evs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const data = []; let now = 0;
  for (const [t, , bytes] of evs) { data.push(...vlq(t - now), ...bytes); now = t; }
  data.push(0, 0xff, 0x2f, 0);
  const h = Buffer.alloc(8); h.write("MTrk", 0); h.writeUInt32BE(data.length, 4);
  return Buffer.concat([h, Buffer.from(data)]);
}
const noteOn = (n) => [0x90, n, 100], noteOff = (n) => [0x80, n, 0];

function main() {
  const a = process.argv.slice(2);
  const opt = k => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  const pos = a.filter((x, i) => !x.startsWith("--") && !(i > 0 && a[i - 1].startsWith("--")));
  let [bmPath, outDir] = pos;
  if (opt("--official")) {
    // shortcut for an official song: chart + audio from MUSIC\NAME, output in rbu-tools\reaper\official\NAME
    const n = opt("--official").toUpperCase(), music = opt("--music") || require("./settings.js").load().music;
    bmPath = path.join(music, n, "BEATMATCH.STR.EDAT");
    outDir = outDir || path.resolve(__dirname, "..", "reaper", "official", n);
    if (!opt("--atm") && !opt("--wav")) a.push("--atm", path.join(music, n, `${n}.ATM`));
  }
  if (!bmPath || !outDir) { console.log("usage: reaperpack.js <BEATMATCH.STR.EDAT> <out dir> [--atm song.ATM] [--wav dir] [--name NAME] [--vocals keys|vocals]\n       reaperpack.js --official NAME [--music <MUSIC dir>]"); process.exit(1); }
  const name = opt("--name") || path.basename(path.dirname(path.resolve(bmPath)));
  const vocalsAs = opt("--vocals") === "vocals" ? "PART VOCALS" : "PART KEYS";
  fs.mkdirSync(outDir, { recursive: true });

  const bm = fs.readFileSync(bmPath);
  const secs = sections(bm);
  const imgs = secs.map((s, d) => new Image(bm.subarray(s.start, s.start + s.size), d));
  const charts = imgs.map(img => Object.fromEntries(img.arrays().map(x => [x.name, img.read(x)])));
  const c0 = charts[3]; // tempo / measures / beats are the same in every section

  // Tempo track
  const tempo = [];
  for (let i = 0; i < c0.tempo.n; i++) {
    const tick = c0.tempo.b.readUInt32LE(i * 12 + 4), us = c0.tempo.b.readUInt32LE(i * 12 + 8);
    tempo.push([tick, 1, [0xff, 0x51, 3, (us >> 16) & 0xff, (us >> 8) & 0xff, us & 0xff]]);
  }
  for (let i = 0; i < c0.measures.n; i++) {
    const num = c0.measures.b.readUInt32LE(i * 16 + 4), den = c0.measures.b.readUInt32LE(i * 16 + 8), tick = c0.measures.b.readUInt32LE(i * 16 + 12);
    tempo.push([tick, 0, [0xff, 0x58, 4, num, Math.round(Math.log2(den)), 24, 8]]);
  }
  // BEAT track
  const beat = [];
  for (let i = 0; i < c0.beats.n; i++) {
    const tick = c0.beats.b.readUInt32LE(i * 8), level = c0.beats.b.readUInt32LE(i * 8 + 4);
    const next = i + 1 < c0.beats.n ? c0.beats.b.readUInt32LE((i + 1) * 8) : tick + 480;
    const n = level ? 12 : 13, len = Math.max(1, Math.min(120, next - tick - 1));
    beat.push([tick, 2, noteOn(n)], [tick + len, 0, noteOff(n)]);
  }

  // Part tracks
  const parts = [];
  const counts = [];
  for (let t = 0; t < 4; t++) {
    const ev = [], cnt = [], ends = [];
    for (let d = 0; d < 4; d++) {
      const g = charts[d][`gems${t}`];
      cnt.push(g.n);
      ends.push(new Array(g.n).fill(0));
      for (let i = 0; i < g.n; i++) {
        const o = i * 0x14, tick = g.b.readUInt32LE(o + 4), tlen = g.b.readUInt16LE(o + 0xc), mask = g.b[o + 0xe], tap = g.b[o + 0xf] & 2;
        let len = tap ? Math.min(160, tlen || 120) : Math.max(161, tlen);
        for (let l = 0; l < 4; l++) if (mask >> l & 1) {
          // a note must end before the next gem on the same lane starts (same MIDI note)
          let nextSame = Infinity;
          for (let j = i + 1; j < g.n; j++) if (g.b[j * 0x14 + 0xe] >> l & 1) { nextSame = g.b.readUInt32LE(j * 0x14 + 4); break; }
          const ln = Math.max(1, Math.min(len, nextSame - tick - 1));
          const note = DIFF_BASE[d] + (t === 0 ? 1 : 0) + l;
          ev.push([tick, 2, noteOn(note)], [tick + ln, 0, noteOff(note)]);
          ends[d][i] = Math.max(ends[d][i], tick + ln);
        }
      }
    }
    // Overdrive phrases: runs of gems with bit 25 in each difficulty, merged across difficulties (official phrases
    // can include a gem on Easy just past the Expert run). mid2rbu marks a gem only if the whole note (sustain
    // included) lies inside the marker, so the marker runs to the end of the longest note in the phrase, but stops
    // before any non-OD gem that would otherwise fit inside it.
    const runs = [];
    for (let d = 0; d < 4; d++) {
      const g = charts[d][`gems${t}`];
      let s = -1;
      for (let i = 0; i <= g.n; i++) {
        const on = i < g.n && (g.b.readUInt32LE(i * 0x14 + 16) & OD);
        if (on && s < 0) s = i;
        if (!on && s >= 0) {
          let end = 0; for (let j = s; j < i; j++) end = Math.max(end, ends[d][j]);
          runs.push([g.b.readUInt32LE(s * 0x14 + 4), g.b.readUInt32LE((i - 1) * 0x14 + 4), end]); s = -1;
        }
      }
    }
    runs.sort((x, y) => x[0] - y[0]);
    const merged = [];
    for (const r of runs) {
      const m = merged[merged.length - 1];
      if (m && r[0] <= m[1]) { m[1] = Math.max(m[1], r[1]); m[2] = Math.max(m[2], r[2]); } else merged.push([...r]);
    }
    const nonOd = []; // [start, end] of non-OD notes, all difficulties
    for (let d = 0; d < 4; d++) { const g = charts[d][`gems${t}`]; for (let i = 0; i < g.n; i++) if (!(g.b.readUInt32LE(i * 0x14 + 16) & OD)) nonOd.push([g.b.readUInt32LE(i * 0x14 + 4), ends[d][i]]); }
    let ods = 0;
    for (const [st, lt, end] of merged) {
      let en = Math.max(lt + 1, end);
      for (const [a, b] of nonOd) if (a > lt && a < en && b <= en) en = a; // a non-OD note would fall inside
      ev.push([st, 1, noteOn(116)], [en, 0, noteOff(116)]); ods++;
    }
    // Solos: records (same in every difficulty)
    const so = charts[3][`solos${t}`];
    for (let k = 0; k < so.n; k++) {
      const st = so.b.readUInt32LE(k * 20 + 8), len = so.b.readUInt32LE(k * 20 + 12);
      ev.push([st, 1, noteOn(103)], [st + len, 0, noteOff(103)]);
    }
    counts.push(`${PART[t].replace("PART ", "").toLowerCase()} ${cnt.join("/")} gems, ${ods} overdrive, ${so.n} solo`);
    parts.push(trackChunk(t === 3 ? vocalsAs : PART[t], ev));
  }

  const hdr = Buffer.alloc(14); hdr.write("MThd", 0); hdr.writeUInt32BE(6, 4); hdr.writeUInt16BE(1, 8);
  hdr.writeUInt16BE(2 + parts.length, 10); hdr.writeUInt16BE(480, 12);
  const mid = Buffer.concat([hdr, trackChunk(name, tempo), trackChunk("BEAT", beat), ...parts]);
  const midPath = path.join(outDir, `${name}.mid`);
  fs.writeFileSync(midPath, mid);
  console.log(`${midPath}: ${c0.tempo.n} tempo, ${c0.measures.n} time signature(s), ${c0.beats.n} beats; vocals as ${vocalsAs}`);
  for (const l of counts) console.log(`  ${l} (Easy/Medium/Hard/Expert)`);

  // Audio
  const wavDir = opt("--wav"), atm = opt("--atm");
  if (wavDir) {
    for (const t of TRACKS) fs.copyFileSync(path.join(wavDir, `${t}.wav`), path.join(outDir, `${t}.wav`));
    console.log(`  audio: copied the 5 tracks from ${wavDir}`);
  } else if (atm) {
    const tools = path.resolve(__dirname, ".."), tmp = path.join(outDir, "_at3");
    execFileSync(process.execPath, [path.join(__dirname, "atmtool.js"), "-d", atm, tmp], { stdio: "ignore" });
    for (const t of TRACKS) {
      execFileSync(require("./settings.js").load().at3tool, ["-d", "-repeat", "1", `${t}.at3`, `../${t}.wav`], { cwd: tmp, stdio: "ignore" });
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(`  audio: decoded the 5 tracks from ${path.basename(atm)}`);
  }
}

if (require.main === module) main();
