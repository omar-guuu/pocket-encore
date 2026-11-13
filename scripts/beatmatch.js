#!/usr/bin/env node
// Rock Band Unplugged BEATMATCH.STR.EDAT <-> .rbu (mid2rbu) converter.
//
//   node beatmatch.js build   <donor BEATMATCH.STR.EDAT> <song.rbu> <out BEATMATCH.STR.EDAT> [--audio-seconds 165.04] [--atm ZPUSHIT.ATM]
//   node beatmatch.js extract <BEATMATCH.STR.EDAT> <out.rbu>        (official chart -> .rbu, for testing)
//   node beatmatch.js verify  <BEATMATCH.STR.EDAT> <song.rbu>       (does the chart contain exactly this .rbu?)
//   node beatmatch.js info    <BEATMATCH.STR.EDAT>
//
// File layout: 0x80-byte header, table of 0x40-byte entries (entries 124..127 = {start, size, end} of the
// Easy/Medium/Hard/Expert sections). Each section is a memory image the game loads at 0x096e9a80, so the
// pointers inside are absolute addresses. The chart arrays are reached from the root object exactly the way
// UnpluggedDeluxe reaches them in RAM. Unused space is filled with 0x7f800001.
"use strict";
const fs = require("fs");

const BASE = 0x096e9a80;
const FILL = 0x7f800001;
const SECTION_ENTRY0 = 124;
const RBU_HEADER = 244; // <I48s48sIIIII124x
const MAX_SECTION = 0x181800; // largest section in an official chart (CONSTANTMOTION): known to load
// Song events (root+0x2b0 pointer, +0x2b4 count): 0x50-byte records {1, id 0x09f8xxxx, 0, -1, f32 tick, f32 tick, 0, 5, ...};
// unused slots are filled. The game stops the music (and the song clock) at the last event; in most official charts
// it is one beat after the last beat, always 1-5 s after SONG_END. Donor events are scaled so the last one lands at
// the new song's end (Push It test: donor events left as they were stopped the music at 2:10).
const EVENTS = 0x2b0;
const SONG_END = 0x124;
// root+0x324: CRC-32 (standard, table at 0x08b452c0) of the first 0x400 bytes of MUSIC/<name>/<name>.atm, checked
// when the song starts (0x08ab2aa8, "Memory Stick removed" on mismatch). Equal in all 4 sections, all 57 official songs.
const ATM_CRC = 0x324;
function atmCrc(atmPath) {
  const fd = fs.openSync(atmPath, "r"), h = Buffer.alloc(0x400);
  const n = fs.readSync(fd, h, 0, 0x400, 0); fs.closeSync(fd);
  if (n !== 0x400) throw new Error(`${atmPath}: shorter than 0x400 bytes`);
  let c = 0xffffffff;
  for (let i = 0; i < 0x400; i++) { c ^= h[i]; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; }
  return (~c) >>> 0;
} // root+0x124: float ms, gameplay ends here. Official value = max over all difficulties/tracks of gem ms + gem ms_duration (all 56 charts within 1 ms)

// ---------------- .rbu ----------------
function readRbu(buf) {
  let o = 0;
  const u32 = () => { const v = buf.readUInt32LE(o); o += 4; return v; };
  const header = buf.subarray(0, RBU_HEADER); o = RBU_HEADER;
  const list = elem => { const n = u32(); const b = buf.subarray(o, o + n * elem); o += n * elem; return { n, b }; };
  const tempo = list(12), beats = list(8), measures = list(16);
  const diffs = [];
  for (let d = 0; d < 4; d++) {
    const size = u32(); const end = o + size;
    const gems = [0, 1, 2, 3].map(() => list(0x14));
    const bars = [0, 1, 2, 3].map(() => list(16));
    const solos = [0, 1, 2, 3].map(() => (o < end ? list(20) : { n: 0, b: Buffer.alloc(0) }));
    if (o !== end) throw new Error(`.rbu difficulty ${d}: section size mismatch (${o} vs ${end})`);
    diffs.push({ gems, bars, solos });
  }
  if (o !== buf.length) throw new Error(`.rbu has ${buf.length - o} trailing bytes`);
  return { header, version: header.readUInt32LE(0), tempo, beats, measures, diffs };
}

function writeRbu(r) {
  const parts = [r.header];
  const list = l => { const c = Buffer.alloc(4); c.writeUInt32LE(l.n); parts.push(c, l.b); };
  list(r.tempo); list(r.beats); list(r.measures);
  for (const d of r.diffs) {
    const sec = [];
    const add = l => { const c = Buffer.alloc(4); c.writeUInt32LE(l.n); sec.push(c, l.b); };
    d.gems.forEach(add); d.bars.forEach(add); d.solos.forEach(add);
    const body = Buffer.concat(sec); const len = Buffer.alloc(4); len.writeUInt32LE(body.length);
    parts.push(len, body);
  }
  return Buffer.concat(parts);
}

// ---------------- BEATMATCH sections ----------------
function sections(bm) {
  const out = [];
  for (let d = 0; d < 4; d++) {
    const e = 0x80 + (SECTION_ENTRY0 + d) * 0x40;
    out.push({ start: bm.readUInt32LE(e), size: bm.readUInt32LE(e + 4), end: bm.readUInt32LE(e + 8) });
  }
  return out;
}

class Image {
  constructor(buf, d) { this.b = buf; this.d = d; }
  off(addr) {
    const o = addr - BASE;
    if (o < 0 || o + 4 > this.b.length) throw new Error(`difficulty ${this.d}: address ${addr.toString(16)} outside the image`);
    return o;
  }
  u32(addr) { return this.b.readUInt32LE(this.off(addr)); }
  set(addr, v) { this.b.writeUInt32LE(v >>> 0, this.off(addr)); }
  bytes(addr, n) { return this.b.subarray(this.off(addr), this.off(addr) + n); }

  // Every chart array: { name, holder, dataOff, capOff, sizeOff, elem }
  arrays() {
    const P = a => this.u32(a);
    const root = BASE, d = this.d, list = [];
    const vec = (name, holder, dataOff, capOff, sizeOff, elem) => list.push({ name, holder, dataOff, capOff, sizeOff, elem });
    vec("tempo", P(root + 0x114), 4, 8, 0xc, 12);
    vec("measures", P(root + 0x118), 0, 4, 8, 16);
    vec("beats", P(root + 0x11c), 0, 4, 8, 8);
    const tw = root + 0x268;
    const A = P(root + 0x104), unk3 = P(P(P(A + 4 * d))), infoLists = P(unk3);
    for (let t = 0; t < 4; t++) {
      vec(`gems${t}`, P(P(P(tw + 0x38 + 4 * t)) + 8), 8, 0xc, 0x10, 0x14);
      vec(`info${t}`, P(infoLists + 4 * t), 4, 8, 0xc, 1);
      vec(`bars${t}`, P(P(P(P(root + 0x1e0) + 4 * t) + 0xc) + 0xc), 0xc, 0x10, 0x14, 16);
      vec(`solos${t}`, root + 0x58 + 0xc * t, 0, 4, 8, 20);
    }
    return list;
  }
  read(a) {
    const n = this.u32(a.holder + a.sizeOff), data = this.u32(a.holder + a.dataOff);
    return { n, cap: this.u32(a.holder + a.capOff), data, b: n && data ? Buffer.from(this.bytes(data, n * a.elem)) : Buffer.alloc(0) };
  }
  freeRuns() {
    const runs = []; let s = -1;
    for (let o = 0; o <= this.b.length; o += 4) {
      const free = o < this.b.length && this.b.readUInt32LE(o) === FILL;
      if (free && s < 0) s = o;
      if (!free && s >= 0) { runs.push({ o: s, n: o - s }); s = -1; }
    }
    return runs.sort((x, y) => y.n - x.n);
  }
}

// Info byte per gem (see FINDINGS: matches ~62 % of official bytes exactly; values off the 8th-note grid differ).
const infoByte = tick => ((-Math.floor(tick / 240)) * 16) & 0xff;

// Other vectors {ptr, cap, size} in the image whose content is identical to a shared map (tempo, measures, beats):
// the donor keeps per-track copies (SHESNOTTHERE: 5 tempo and 6 measure copies, plus vectors aliasing the main
// array). They are pointed at the new array after the build.
function mapCopies(img, name) {
  const a = img.arrays().find(x => x.name === name), cur = img.read(a), main = a.holder + a.dataOff, out = [];
  if (!cur.n) return out;
  for (let o = 0; o + 12 <= img.b.length; o += 4) {
    const addr = BASE + o;
    if (addr === main) continue;
    const p = img.b.readUInt32LE(o), c = img.b.readUInt32LE(o + 4), n = img.b.readUInt32LE(o + 8);
    if (n !== cur.n || c < n || p < BASE || p + cur.b.length > BASE + img.b.length) continue;
    if (img.b.subarray(p - BASE, p - BASE + cur.b.length).equals(cur.b)) out.push(addr);
  }
  return out;
}

function songEvents(img) {
  const ptr = img.u32(BASE + EVENTS), n = img.u32(BASE + EVENTS + 4), out = [];
  for (let i = 0; i < n; i++) if (img.u32(ptr + i * 0x50) === 1) out.push(ptr + i * 0x50);
  return out;
}
const lastEventTick = img => Math.max(0, ...songEvents(img).map(r => img.b.readFloatLE(img.off(r + 0x10)), 0));

// ms -> tick through the .rbu tempo map (entries: f32 ms, u32 tick, u32 us per beat).
function msToTick(rbu, ms) {
  let k = 0;
  while (k + 1 < rbu.tempo.n && rbu.tempo.b.readFloatLE((k + 1) * 12) <= ms) k++;
  const t0 = rbu.tempo.b.readFloatLE(k * 12), tick0 = rbu.tempo.b.readUInt32LE(k * 12 + 4), us = rbu.tempo.b.readUInt32LE(k * 12 + 8);
  return tick0 + (ms - t0) * 1000 / us * 480;
}

// Tick where the music should stop: one beat after the last beat (as in most official charts), after the last gem
// has ended; with audioSeconds, no later than 0.3 s before the audio ends (the song clock follows the audio).
function musicEndTick(rbu, audioSeconds) {
  let t = rbu.beats.n ? rbu.beats.b.readUInt32LE((rbu.beats.n - 1) * 8) + 480 : 0;
  let gemEnd = 0;
  for (const D of rbu.diffs) for (const g of D.gems) for (let i = 0; i < g.n; i++)
    gemEnd = Math.max(gemEnd, g.b.readUInt32LE(i * 0x14 + 4) + g.b.readUInt16LE(i * 0x14 + 12) + 240); // +0xC = tick length (after the build pre-pass)
  t = Math.max(t, gemEnd);
  if (audioSeconds) {
    const cap = Math.floor(msToTick(rbu, audioSeconds * 1000 - 300));
    if (cap < gemEnd) throw new Error(`the chart's last gem ends after the audio (${audioSeconds} s)`);
    t = Math.min(t, cap);
  }
  return Math.round(t);
}

function chartFromImage(img) {
  const a = Object.fromEntries(img.arrays().map(x => [x.name, img.read(x)]));
  return {
    tempo: a.tempo, beats: a.beats, measures: a.measures,
    gems: [0, 1, 2, 3].map(t => a[`gems${t}`]), info: [0, 1, 2, 3].map(t => a[`info${t}`]),
    bars: [0, 1, 2, 3].map(t => a[`bars${t}`]), solos: [0, 1, 2, 3].map(t => a[`solos${t}`]),
  };
}

// ---------------- solos ----------------
// Official charts (364 solos, 498369 gems, all consistent):
// - solo record (root+0x58+12t vector, 20 bytes): f32 start ms, f32 length ms, u32 start tick, u32 length ticks,
//   u32 note count = sum over the solo's gems of the notes in the lane mask (a chord counts once per note).
// - gems of a solo: bit 27 on all of them; bit 28 + (low 16 bits = the note count) on the first; bit 29 on the last
//   (low bits 0). No other gem has low bits set.
// - per-track block at root+0x328+0x28t (10 words): f32 end ms[4] (last solo gem ms + its ms duration),
//   u32 count, f32 start ms[4] (first solo gem ms), u32 count. All zero without solos. At most 4 solos per track.
// mid2rbu sets the bits but writes the gem count instead of the note count, so both are recomputed here.
const SOLO = 1 << 27, SOLO_START = 1 << 28, SOLO_END = 1 << 29, SOLO_BLOCK = 0x328;
const popcount = m => { let c = 0; while (m) { c += m & 1; m >>>= 1; } return c; };
function soloRuns(g) {
  const runs = []; let s = -1;
  for (let i = 0; i < g.n; i++) {
    const f = g.b.readUInt32LE(i * 0x14 + 16);
    if (f & SOLO_START) s = i;
    if (f & SOLO_END && s >= 0) { runs.push([s, i]); s = -1; }
  }
  return runs;
}
// ---------------- bar lists ----------------
// Per part and difficulty, one record per bar: u32 first gem id, u32 end gem id (exclusive), f32 start ms, f32 end ms;
// a gem on a bar line belongs to the earlier bar. In all 1624 official lists the last bar(s) end at the gem count, so
// every gem is in a bar. mid2rbu's BarBuilder leaves its index on the last gem when it runs out of gems, so the last
// gem of every part was in no bar (its end stays n-1 and the following bars read n-1..n-1); in game the part then
// counts as finished one gem early (notes at the very end that can't be switched to and played).
function fixBarEnds(rbu) {
  let fixed = 0;
  for (const D of rbu.diffs) for (let t = 0; t < 4; t++) {
    const G = D.gems[t], B = D.bars[t], n = G.n;
    if (!n || !B || !B.n) continue;
    const lastMs = G.b.readFloatLE((n - 1) * 0x14) - 0.5;
    let changed = false;
    for (let i = 0; i < B.n; i++) {
      const o = i * 16, st = B.b.readUInt32LE(o), en = B.b.readUInt32LE(o + 4), s0 = B.b.readFloatLE(o + 8), e0 = B.b.readFloatLE(o + 12);
      if (st === n - 1 && lastMs <= s0 && i > 0) { B.b.writeUInt32LE(n, o); changed = true; }
      if (en === n - 1 && lastMs <= e0) { B.b.writeUInt32LE(n, o + 4); changed = true; }
    }
    let covered = 0;
    for (let i = 0; i < B.n; i++) covered += B.b.readUInt32LE(i * 16 + 4) - B.b.readUInt32LE(i * 16);
    if (covered !== n) throw new Error(`bar list of part ${t}: covers ${covered} of ${n} gems after the fix`);
    if (changed) fixed++;
  }
  return fixed;
}

// ---------------- star thresholds ----------------
// Chart root (per difficulty): +0x30c/+0x310/+0x314/+0x318/+0x31c/+0x320 = score for 1/2/3/4/5 stars and gold
// (the star meter, FUN_088d3df0, walks these six; past gold it runs to 2 x gold); +0x308 = the chart's maximum
// score, +0x304 = the 3-star value again. The game never computes them: they come with the chart, so a donor's
// stayed in every custom (Miracle Man: She's Not There's, far too high -> no 5 or gold stars).
// Official charts (448): 2 and 3 stars = exactly 2 and 3 x the 1-star value; as a share of the maximum: 1 star
// 0.052 (p1-p99 0.028-0.067), 4 stars 0.473 (0.43-0.50), 5 stars 0.789 (0.77-0.80), gold 0.874 (0.863-0.880).
// The maximum follows Unplugged's scoring (user, in game: 50 points per note x multiplier, a completed phrase
// 1000 x multiplier, multiplier up to 5x, more with overdrive; phrases come with time): fitted per difficulty on the
// official charts (tutorials left out) as a x notes (all 4 parts) + b x overdrive phrases (bit-25 runs, all parts)
// + c x song length in s. Held-out error p50 6-7 %, p90 11-14 %. (A note-only model put Miracle Man at 1.0 M; play
// showed about 1.6 M: sparse songs get more of their score from phrases, i.e. from time.)
// scale (song.json "starsScale"): > 1 harder, < 1 easier.
const STAR_FRACTIONS = { one: 0.0524, four: 0.473, five: 0.789, gold: 0.874 };
const MAX_COEF = [[600.1, 2428.6, 1588.8], [594.8, 2142.7, 2200.8], [462.2, 5519.9, 4548.8], [598.5, 3840.0, 4303.7]];
function chartMaxScore(D, d, songEndMs) {
  let notes = 0, od = 0;
  for (const g of D.gems) {
    let inRun = false;
    for (let i = 0; i < g.n; i++) {
      const o = i * 0x14; let m = g.b[o + 0xe]; while (m) { notes += m & 1; m >>= 1; }
      const fl = g.b.readUInt32LE(o + 16);
      if (fl >>> 25 & 1) { if (!inRun) { od++; inRun = true; } if (fl >>> 26 & 1) inRun = false; }
    }
  }
  const [a, b, c] = MAX_COEF[Math.min(3, d)];
  return a * notes + b * od + c * songEndMs / 1000;
}
function writeStars(img, D, scale, d, songEndMs) {
  const donorGold = img.b.readUInt32LE(0x320);
  const max = Math.round(chartMaxScore(D, d, songEndMs) * scale);
  const one = Math.round(max * STAR_FRACTIONS.one);
  const t = [one, 2 * one, 3 * one, Math.round(max * STAR_FRACTIONS.four), Math.round(max * STAR_FRACTIONS.five), Math.round(max * STAR_FRACTIONS.gold)];
  t.forEach((v, k) => img.b.writeUInt32LE(v, 0x30c + 4 * k));
  img.b.writeUInt32LE(3 * one, 0x304);
  img.b.writeUInt32LE(max, 0x308);
  return { max, t, donorGold };
}

function normalizeSolos(rbu, drop) {
  let total = 0;
  rbu.diffs.forEach((D, d) => {
    for (let t = 0; t < 4; t++) {
      const g = D.gems[t];
      if (drop) {
        for (let i = 0; i < g.n; i++) {
          const f = g.b.readUInt32LE(i * 0x14 + 16);
          if (f & (SOLO | SOLO_START | SOLO_END)) g.b.writeUInt32LE((f & ~(SOLO | SOLO_START | SOLO_END) & 0xffff0000) >>> 0, i * 0x14 + 16);
        }
        D.solos[t] = { n: 0, b: Buffer.alloc(0) };
        continue;
      }
      const so = D.solos[t], runs = soloRuns(g);
      if (runs.length !== so.n) throw new Error(`difficulty ${d} track ${t}: ${so.n} solo record(s) but ${runs.length} marked gem run(s)`);
      if (so.n > 4) throw new Error(`difficulty ${d} track ${t}: ${so.n} solos, the game shows at most 4 per track`);
      runs.forEach(([s, e], k) => {
        if (s === e) throw new Error(`difficulty ${d} track ${t}: solo ${k} has a single gem`);
        let notes = 0;
        for (let i = s; i <= e; i++) {
          let f = g.b.readUInt32LE(i * 0x14 + 16);
          notes += popcount(g.b[i * 0x14 + 0xe]);
          f = (f & 0xffff0000) | SOLO;
          if (i === s) f |= SOLO_START; else f &= ~SOLO_START;
          if (i === e) f |= SOLO_END; else f &= ~SOLO_END;
          g.b.writeUInt32LE(f >>> 0, i * 0x14 + 16);
        }
        g.b.writeUInt32LE((g.b.readUInt32LE(s * 0x14 + 16) | notes) >>> 0, s * 0x14 + 16);
        so.b.writeUInt32LE(notes, k * 20 + 16);
      });
      total += so.n;
    }
  });
  return total;
}
function writeSoloBlock(img, t, so, g) {
  const o = SOLO_BLOCK + 0x28 * t;
  for (let k = 0; k < 10; k++) img.b.writeUInt32LE(0, o + 4 * k);
  const runs = soloRuns(g);
  runs.forEach(([s, e], k) => {
    img.b.writeFloatLE(g.b.readFloatLE(e * 0x14) + g.b.readUInt16LE(e * 0x14 + 8), o + 4 * k);
    img.b.writeFloatLE(g.b.readFloatLE(s * 0x14), o + 0x14 + 4 * k);
  });
  img.b.writeUInt32LE(runs.length, o + 0x10);
  img.b.writeUInt32LE(runs.length, o + 0x24);
}

// ---------------- commands ----------------
function cmdInfo(path) {
  const bm = fs.readFileSync(path);
  sections(bm).forEach((s, d) => {
    const img = new Image(bm.subarray(s.start, s.start + s.size), d);
    const free = img.freeRuns();
    console.log(`difficulty ${d}: section 0x${s.start.toString(16)} size 0x${s.size.toString(16)}, free ${free.reduce((x, r) => x + r.n, 0)} B (largest ${free.slice(0, 3).map(r => r.n).join(", ")})`);
    for (const a of img.arrays()) {
      const r = img.read(a);
      console.log(`  ${a.name.padEnd(9)} holder +${(a.holder - BASE).toString(16).padStart(5)} data ${r.data ? "+" + (r.data - BASE).toString(16).padStart(5) : " null "} n ${String(r.n).padStart(5)} cap ${String(r.cap).padStart(5)}`);
    }
  });
}

function cmdExtract(path, out) {
  const bm = fs.readFileSync(path);
  const secs = sections(bm);
  const charts = secs.map((s, d) => chartFromImage(new Image(bm.subarray(s.start, s.start + s.size), d)));
  const header = Buffer.alloc(RBU_HEADER); header.writeUInt32LE(2, 0);
  header.write("EXTRACTED", 4, "ascii"); header.write("EXTRACTED", 52, "ascii");
  const r = { header, tempo: charts[0].tempo, beats: charts[0].beats, measures: charts[0].measures,
    diffs: charts.map(c => ({ gems: c.gems, bars: c.bars, solos: c.solos })) };
  fs.writeFileSync(out, writeRbu(r));
  const same = ["tempo", "beats", "measures"].every(k => charts.every(c => c[k].b.equals(charts[0][k].b)));
  console.log(`extracted ${out}: tempo ${r.tempo.n}, beats ${r.beats.n}, measures ${r.measures.n}; per difficulty gems ${charts.map(c => c.gems.map(g => g.n).join("/")).join(" | ")}; shared maps identical across difficulties: ${same}`);
}

function cmdBuild(donorPath, rbuPath, outPath, opts = {}) {
  const bm = Buffer.from(fs.readFileSync(donorPath));
  const rbu = readRbu(fs.readFileSync(rbuPath));
  // Overdrive: official gems carry bit 25 inside a phrase and bits 25+26 on its last gem. mid2rbu only sets
  // bit 26 on zero-length notes at the phrase end (practically never), so the last gem of each run is marked here.
  let phrases = 0;
  for (const D of rbu.diffs) for (const g of D.gems) {
    for (let i = 0; i < g.n; i++) {
      const w = g.b.readUInt32LE(i * 0x14 + 16);
      const next = i + 1 < g.n ? g.b.readUInt32LE((i + 1) * 0x14 + 16) : 0;
      if ((w & 0x02000000) && !(next & 0x02000000)) { g.b.writeUInt32LE((w | 0x04000000) >>> 0, i * 0x14 + 16); phrases++; }
    }
  }
  console.log(`overdrive: ${phrases} phrases (all difficulties and tracks)`);
  // gem+0xC: official = the gem's length in ticks (492341 of 492364 gems); mid2rbu writes 0x7fff. The game takes
  // each track's last gem tick + this value, rounds up to the next measure and waits for that time before ending the
  // song (FUN_08a8764c -> game obj +0x164/+0x168 per track), so 0x7fff left ~17 bars of silence before the results.
  let lengths = 0;
  for (const D of rbu.diffs) for (const g of D.gems) for (let i = 0; i < g.n; i++) {
    if (g.b.readUInt16LE(i * 0x14 + 12) === 0x7fff) { g.b.writeUInt16LE(g.b.readUInt16LE(i * 0x14 + 10), i * 0x14 + 12); lengths++; }
  }
  if (lengths) console.log(`gem tick lengths (+0xC) set on ${lengths} gems`);
  // gem+0xA: official = the note's ms length plus a margin: ms_dur + 94 (38 songs) or the ms up to tick + length +
  // 60 ticks (19 songs); 98.6 % of 498369 gems. mid2rbu writes the tick length (== +0xC) there, which is shorter.
  let windows = 0;
  for (const D of rbu.diffs) for (const g of D.gems) for (let i = 0; i < g.n; i++) {
    const o = i * 0x14;
    if (g.b.readUInt16LE(o + 10) === g.b.readUInt16LE(o + 12)) { g.b.writeUInt16LE(Math.min(0xffff, g.b.readUInt16LE(o + 8) + 94), o + 10); windows++; }
  }
  if (windows) console.log(`gem ms windows (+0xA = ms length + 94) set on ${windows} gems`);
  const barFix = fixBarEnds(rbu);
  if (barFix) console.log(`bar lists: last gem added to ${barFix} part/difficulty list(s) (mid2rbu leaves it out)`);
  const soloCount = normalizeSolos(rbu, !!opts.dropSolos);
  console.log(opts.dropSolos ? "solos: dropped" : `solos: ${soloCount} (all difficulties and tracks)`);
  const report = [];
  const secs = sections(bm), imgs = [];
  let songEnd = 0;
  const endTick = musicEndTick(rbu, opts.audioSeconds);
  for (const D of rbu.diffs) for (const g of D.gems) for (let i = 0; i < g.n; i++)
    songEnd = Math.max(songEnd, g.b.readFloatLE(i * 0x14) + g.b.readUInt16LE(i * 0x14 + 8));
  secs.forEach((s, d) => {
    const img = new Image(Buffer.from(bm.subarray(s.start, s.start + s.size)), d);
    imgs.push(img);
    const arrays = Object.fromEntries(img.arrays().map(x => [x.name, x]));
    const copies = Object.fromEntries(["tempo", "measures", "beats"].map(k => [k, mapCopies(img, k)]));
    const runs = img.freeRuns();
    // Appends free space at the end of the section (pointers are absolute, so existing data stays valid).
    const grow = need => {
      const old = img.b.length;
      const size = Math.min(MAX_SECTION, (old + Math.max(need, 0x10000) + 0x7ff) & ~0x7ff);
      if (size - old < need) return false;
      const ext = Buffer.alloc(size - old); for (let o = 0; o < ext.length; o += 4) ext.writeUInt32LE(FILL, o);
      img.b = Buffer.concat([img.b, ext]);
      runs.push({ o: old, n: size - old });
      report.push({ d, name: "section", n: 0, where: `grown 0x${old.toString(16)} -> 0x${size.toString(16)}` });
      return true;
    };
    const D = rbu.diffs[d];
    // Pointers that refer into a region, other than the array's own holder field.
    const referencedFrom = (start, end, holderField) => {
      for (let o = 0; o + 4 <= img.b.length; o += 4) {
        const v = img.b.readUInt32LE(o);
        if (v >= start && v < end && BASE + o !== holderField) return BASE + o;
      }
      return 0;
    };
    const want = {
      tempo: rbu.tempo, beats: rbu.beats, measures: rbu.measures,
      ...Object.fromEntries([0, 1, 2, 3].flatMap(t => {
        const info = Buffer.alloc(D.gems[t].n);
        for (let i = 0; i < D.gems[t].n; i++) info[i] = infoByte(D.gems[t].b.readUInt32LE(i * 0x14 + 4));
        return [[`gems${t}`, D.gems[t]], [`info${t}`, { n: D.gems[t].n, b: info }], [`bars${t}`, D.bars[t]], [`solos${t}`, D.solos[t]]];
      })),
    };
    // Arrays that will move out leave their old space behind: reuse it when nothing else points into it.
    for (const [name, v] of Object.entries(want)) {
      const a = arrays[name], cur = img.read(a);
      if (!cur.data || v.n <= cur.cap || !cur.cap) continue;
      const start = cur.data, end = cur.data + cur.cap * a.elem;
      const ref = referencedFrom(start, end, a.holder + a.dataOff);
      if (ref) { report.push({ d, name, n: 0, where: `old space kept (referenced from +${(ref - BASE).toString(16)})` }); continue; }
      runs.push({ o: start - BASE, n: end - start });
    }
    // Decide placement first, then allocate the arrays that move, largest first, each into the
    // smallest free run that fits (best fit) to keep fragmentation low.
    const plan = {};
    for (const [name, v] of Object.entries(want)) {
      const a = arrays[name], cur = img.read(a);
      if (v.n === 0) plan[name] = name.startsWith("solos") ? 0 : cur.data;      // empty: keep pointer (solos use NULL)
      else if (cur.data && v.n <= cur.cap) plan[name] = cur.data;                  // fits where the donor's array is
      else plan[name] = null;                                                      // needs room: free space
    }
    const moves = Object.keys(plan).filter(k => plan[k] === null)
      .map(k => ({ k, bytes: want[k].n * arrays[k].elem })).sort((x, y) => y.bytes - x.bytes);
    for (const m of moves) {
      const need = (m.bytes + 15) & ~15;
      let best = null;
      for (const r of runs) {
        const start = (r.o + 15) & ~15, avail = r.n - (start - r.o);
        if (avail >= need && (!best || avail < best.avail)) best = { r, start, avail };
      }
      if (!best && grow(need)) { const r = runs[runs.length - 1]; best = { r, start: r.o, avail: r.n }; }
      if (!best) throw new Error(`difficulty ${d}: not enough free space for ${m.k} (${m.bytes} bytes); free runs: ${runs.filter(r => r.n >= 16).map(r => r.n).sort((x, y) => y - x).slice(0, 6).join(", ")}`);
      best.r.n -= (best.start - best.r.o) + need; best.r.o = best.start + need;
      plan[m.k] = BASE + best.start;
    }
    for (const [name, v] of Object.entries(want)) {
      const a = arrays[name], cur = img.read(a);
      const bytes = v.n * a.elem;
      const data = plan[name];
      if (bytes) v.b.copy(img.b, img.off(data));
      img.set(a.holder + a.dataOff, data);
      img.set(a.holder + a.capOff, v.n === 0 ? (name.startsWith("solos") ? 0 : cur.cap) : Math.max(v.n, data === cur.data ? cur.cap : v.n));
      img.set(a.holder + a.sizeOff, v.n);
      report.push({ d, name, n: v.n, where: data === cur.data ? "in place" : data ? "free+" + (data - BASE).toString(16) : "null" });
    }
    for (const [name, list] of Object.entries(copies)) {
      const r = img.read(arrays[name]);
      for (const v of list) { img.set(v, r.data); img.set(v + 4, r.n); img.set(v + 8, r.n); }
      if (d === 0 && list.length) console.log(`${name}: ${list.length} other vector(s) pointed at the new map`);
    }
    for (let t = 0; t < 4; t++) writeSoloBlock(img, t, D.solos[t], D.gems[t]);
    const st = writeStars(img, D, opts.starsScale || 1, d, songEnd);
    console.log(`stars ${["easy", "medium", "hard", "expert"][d]}: max ${st.max}, 1-5 stars ${st.t.slice(0, 5).join(" / ")}, gold ${st.t[5]} (donor's gold was ${st.donorGold})`);
    if (d === 0) console.log(`song end (root+0x${SONG_END.toString(16)}): donor ${img.b.readFloatLE(SONG_END).toFixed(1)} ms -> ${songEnd.toFixed(1)} ms`);
    img.b.writeFloatLE(songEnd, SONG_END);
    if (opts.atm) {
      const crc = atmCrc(opts.atm);
      if (d === 0) console.log(`ATM hash (root+0x${ATM_CRC.toString(16)}): donor ${img.b.readUInt32LE(ATM_CRC).toString(16).padStart(8, "0")} -> ${crc.toString(16).padStart(8, "0")}`);
      img.b.writeUInt32LE(crc, ATM_CRC);
    } else if (d === 0) console.log("warning: no --atm given, the donor's ATM hash is kept (the song needs the hash-check cheat)");
    const ev = songEvents(img), donorEnd = lastEventTick(img);
    if (ev.length && donorEnd > 0) {
      const k = endTick / donorEnd;
      for (const r of ev) for (const f of [0x10, 0x14]) img.b.writeFloatLE(Math.round(img.b.readFloatLE(img.off(r + f)) * k), img.off(r + f));
      if (d === 0) console.log(`song events: ${ev.length}, last (music stop) tick ${donorEnd} -> ${endTick} (x${k.toFixed(4)})`);
    } else console.log(`difficulty ${d}: warning, no song events found at root+0x${EVENTS.toString(16)}`);
  });
  // Reassemble: everything before the first section unchanged, then the four sections back to back,
  // with their table entries {start, size, end} updated.
  const head = Buffer.from(bm.subarray(0, secs[0].start));
  let pos = secs[0].start;
  imgs.forEach((img, d) => {
    const e = 0x80 + (SECTION_ENTRY0 + d) * 0x40;
    head.writeUInt32LE(pos, e); head.writeUInt32LE(img.b.length, e + 4); head.writeUInt32LE(pos + img.b.length, e + 8);
    pos += img.b.length;
  });
  if (bm.length !== secs[3].end) console.log(`note: donor has ${bm.length - secs[3].end} bytes after the last section (dropped)`);
  fs.writeFileSync(outPath, Buffer.concat([head, ...imgs.map(i => i.b)]));
  for (const r of report.filter(r => r.name === "section")) console.log(`  difficulty ${r.d} section ${r.where}`);
  const moved = report.filter(r => r.where.startsWith("free"));
  console.log(`built ${outPath} from ${donorPath}: ${report.length} arrays written, ${moved.length} moved to free space`);
  for (const r of moved) console.log(`  difficulty ${r.d} ${r.name} (${r.n}) -> ${r.where}`);
  return cmdVerify(outPath, rbu, endTick); // the chart as actually written (solos dropped, phrase ends marked)
}

function cmdVerify(path, rbuOrPath, expEvent) {
  const bm = fs.readFileSync(path);
  const rbu = typeof rbuOrPath === "string" ? readRbu(fs.readFileSync(rbuOrPath)) : rbuOrPath;
  let bad = 0;
  sections(bm).forEach((s, d) => {
    const c = chartFromImage(new Image(bm.subarray(s.start, s.start + s.size), d));
    const check = (what, got, exp) => { if (got.n !== exp.n || !got.b.equals(exp.b)) { bad++; console.log(`  MISMATCH difficulty ${d} ${what}: ${got.n} vs ${exp.n}`); } };
    check("tempo", c.tempo, rbu.tempo); check("beats", c.beats, rbu.beats); check("measures", c.measures, rbu.measures);
    for (let t = 0; t < 4; t++) {
      check(`gems${t}`, c.gems[t], rbu.diffs[d].gems[t]); check(`bars${t}`, c.bars[t], rbu.diffs[d].bars[t]); check(`solos${t}`, c.solos[t], rbu.diffs[d].solos[t]);
      if (c.info[t].n !== c.gems[t].n) { bad++; console.log(`  MISMATCH difficulty ${d} info${t} count ${c.info[t].n} vs gems ${c.gems[t].n}`); }
    }
  });
  const ends = sections(bm).map(s => bm.readFloatLE(s.start + SONG_END));
  let exp = 0;
  for (const D of rbu.diffs) for (const g of D.gems) for (let i = 0; i < g.n; i++) exp = Math.max(exp, g.b.readFloatLE(i * 0x14) + g.b.readUInt16LE(i * 0x14 + 8));
  if (ends.some(e => Math.abs(e - exp) > 1)) { bad++; console.log(`  MISMATCH song end ${ends.map(e => e.toFixed(1)).join("/")} vs ${exp.toFixed(1)} ms`); }
  const evEnd = sections(bm).map((s, d) => lastEventTick(new Image(bm.subarray(s.start, s.start + s.size), d)));
  if (expEvent !== undefined && evEnd.some(e => Math.abs(e - expEvent) > 1)) { bad++; console.log(`  MISMATCH last song event ${evEnd.join("/")} vs ${expEvent}`); }
  console.log(`music stops at tick ${evEnd[0]}, song end ${(ends[0] / 1000).toFixed(2)} s`);
  sections(bm).forEach((s, d) => {
    const img = new Image(bm.subarray(s.start, s.start + s.size), d);
    for (const name of ["tempo", "measures", "beats"]) {
      const a = img.arrays().find(x => x.name === name), r = img.read(a);
      for (let o = 0; o + 12 <= img.b.length; o += 4) {
        if (BASE + o === a.holder + a.dataOff) continue;
        const p = img.b.readUInt32LE(o), n = img.b.readUInt32LE(o + 8);
        if (p === r.data && n !== r.n && img.b.readUInt32LE(o + 4) >= n && n > 0 && n < 100000) { bad++; console.log(`  MISMATCH difficulty ${d}: vector +${o.toString(16)} uses the ${name} data with size ${n} (expected ${r.n})`); }
      }
    }
  });
  console.log(bad ? `verify: ${bad} mismatches` : "verify: chart matches the .rbu exactly (all 4 difficulties)");
  return bad === 0;
}

module.exports = { sections, Image, BASE, readRbu, writeRbu, chartFromImage };

if (require.main === module) {
  const [cmd, ...a] = process.argv.slice(2);
  if (cmd === "info" && a[0]) cmdInfo(a[0]);
  else if (cmd === "extract" && a[1]) cmdExtract(a[0], a[1]);
  else if (cmd === "build" && a[2]) {
    const i = a.indexOf("--audio-seconds");
    const j = a.indexOf("--atm");
    process.exit(cmdBuild(a[0], a[1], a[2], { dropSolos: a.includes("--drop-solos"), audioSeconds: i >= 0 ? parseFloat(a[i + 1]) : 0, atm: j >= 0 ? a[j + 1] : null, starsScale: a.indexOf("--stars-scale") >= 0 ? parseFloat(a[a.indexOf("--stars-scale") + 1]) : 1 }) ? 0 : 1);
  }
  else if (cmd === "verify" && a[1]) process.exit(cmdVerify(a[0], a[1]) ? 0 : 1);
  else { console.log("usage: beatmatch.js info <bm> | extract <bm> <out.rbu> | build <donor bm> <song.rbu> <out bm> [--drop-solos] [--audio-seconds s] [--atm <song.ATM>] | verify <bm> <song.rbu>"); process.exit(1); }
}
