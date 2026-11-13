#!/usr/bin/env node
// Vocal notes from a vocal stem (for rapped or spoken parts with no melody in the MIDI).
//   node vocalchart.js <vocals.wav 44.1 kHz mono 16-bit (prepwav output)> <out.json> [--start s] [--end s]
// Output: { "notes": [ { "t": s, "d": s, "lane": 0..3 }, ... ] }, read by autochart.py --vocal-events.
//
// - Syllables: 10 ms frames; an onset is a rise of >= 6 dB over 30 ms to a level within 30 dB of the stem's loud
//   level (99th percentile), at least 90 ms after the previous onset.
// - Length: until the level falls 12 dB below the syllable's peak, or the next onset.
// - Breaths / background (on by default, --keep-all off): dropped when > 15 dB (--bg-db) under the lead voice
//   around it, or unpitched and short (< 0.15 s) or > 6 dB under it.
// - Lane: pitch of the syllable (autocorrelation, 75-500 Hz) ranked against the syllables around it (+-6 s), so the
//   four lanes follow the voice going up and down. Unvoiced syllables keep the previous lane.
"use strict";
const fs = require("fs");

const args = process.argv.slice(2);
const opt = k => { const i = args.indexOf(k); return i >= 0 ? parseFloat(args[i + 1]) : undefined; };
const [wav, out] = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
if (!wav || !out) { console.log("usage: vocalchart.js <vocals.wav> <out.json> [--start s] [--end s] [--bg-db 15] [--keep-all]"); process.exit(1); }

const b = fs.readFileSync(wav);
let o = 12, d0 = -1, dl = 0, rate = 44100, ch = 1, bits = 16;
while (o + 8 <= b.length) {
  const id = b.toString("ascii", o, o + 4), sz = b.readUInt32LE(o + 4);
  if (id === "fmt ") { ch = b.readUInt16LE(o + 10); rate = b.readUInt32LE(o + 12); bits = b.readUInt16LE(o + 22); }
  if (id === "data") { d0 = o + 8; dl = Math.min(sz, b.length - d0); break; }
  o += 8 + sz + (sz & 1);
}
if (d0 < 0 || ch !== 1 || bits !== 16) throw new Error("need a 16-bit mono WAV (prepwav output)");
const n = dl / 2, x = new Float32Array(n);
for (let i = 0; i < n; i++) x[i] = b.readInt16LE(d0 + i * 2) / 32768;

const HOP = Math.round(rate / 100), F = Math.floor(n / HOP);
const lev = new Float64Array(F);
for (let f = 0; f < F; f++) { let e = 0; for (let i = f * HOP; i < (f + 1) * HOP; i++) e += x[i] * x[i]; lev[f] = 10 * Math.log10(e / HOP + 1e-12); }
const loud = Array.from(lev).sort((p, q) => p - q)[Math.floor(F * 0.99)];
const f0 = Math.max(3, Math.floor((opt("--start") ?? 0) * 100)), f1 = Math.min(F - 1, Math.floor((opt("--end") ?? n / rate) * 100));

// Onsets
const on = [];
for (let f = f0; f < f1; f++) {
  if (lev[f] < loud - 30) continue;
  if (lev[f] - lev[f - 3] < 6) continue;
  if (lev[f] < lev[f - 1]) continue;                    // take the frame where the rise is still going
  if (on.length && f - on[on.length - 1] < 9) continue;
  // move to the local peak of the rise (within 40 ms) so the note sits on the syllable's attack
  on.push(f);
}

// Pitch per syllable (autocorrelation over 40 ms starting 20 ms after the onset)
function pitch(f) {
  const s = f * HOP + Math.round(rate * 0.02), W = Math.round(rate * 0.04);
  if (s + W + rate / 75 >= n) return 0;
  const lo = Math.floor(rate / 500), hi = Math.ceil(rate / 75);
  let e0 = 0; for (let i = s; i < s + W; i++) e0 += x[i] * x[i];
  if (e0 <= 0) return 0;
  let best = 0, bestLag = 0;
  for (let lag = lo; lag <= hi; lag++) {
    let c = 0, e1 = 0;
    for (let i = s; i < s + W; i++) { c += x[i] * x[i + lag]; e1 += x[i + lag] * x[i + lag]; }
    const r = c / Math.sqrt(e0 * e1 + 1e-12);
    if (r > best) { best = r; bestLag = lag; }
  }
  return best > 0.5 ? rate / bestLag : 0;               // 0 = unvoiced / unclear
}

const all = on.map((f, k) => {
  const next = k + 1 < on.length ? on[k + 1] : f1;
  let peak = lev[f], g = f;
  while (g < next && g < f + 300) { peak = Math.max(peak, lev[g]); if (lev[g] < peak - 12) break; g++; }
  return { f, end: Math.max(f + 5, Math.min(g, next - 2)), hz: pitch(f), peak };
});

// Breaths and background sounds (AI-separated vocals keep both): compared with the lead voice around it (90th
// percentile of syllable peaks within +-4 s), a syllable is dropped when it is more than BG dB quieter, or when it
// has no clear pitch and is short (< 0.15 s) or more than 6 dB quieter. --keep-all turns this off.
const BG = opt("--bg-db") ?? 15, keepAll = args.includes("--keep-all");
let dropBg = 0, dropBreath = 0;
const notes = keepAll ? all : all.filter(nt => {
  const near = all.filter(m => Math.abs(m.f - nt.f) <= 400).map(m => m.peak).sort((p, q) => p - q);
  const ref = near[Math.floor((near.length - 1) * 0.9)];
  if (nt.peak < ref - BG) { dropBg++; return false; }
  if (!nt.hz && (nt.end - nt.f < 15 || nt.peak < ref - 6)) { dropBreath++; return false; }
  return true;
});

// Lanes: rank of the pitch among voiced syllables within +-6 s (semitone scale)
const st = h => 12 * Math.log2(h / 110);
let last = 1;
for (const nt of notes) {
  if (!nt.hz) { nt.lane = last; continue; }
  const around = notes.filter(m => m.hz && Math.abs(m.f - nt.f) <= 600).map(m => st(m.hz)).sort((p, q) => p - q);
  const below = around.filter(v => v < st(nt.hz)).length, equal = around.filter(v => v === st(nt.hz)).length;
  const q = (below + equal / 2) / around.length;
  nt.lane = Math.min(3, Math.floor(q * 4));
  last = nt.lane;
}

const res = { notes: notes.map(nt => ({ t: +(nt.f / 100).toFixed(3), d: +((nt.end - nt.f) / 100).toFixed(3), lane: nt.lane })) };
fs.writeFileSync(out, JSON.stringify(res));
const voiced = notes.filter(nt => nt.hz).length, lanes = [0, 1, 2, 3].map(l => notes.filter(nt => nt.lane === l).length);
console.log(`${out}: ${notes.length} syllables (${voiced} with a clear pitch; dropped ${dropBg} background, ${dropBreath} breath/noise), lanes ${lanes.join("/")}, ` +
  `first ${notes.length ? (notes[0].f / 100).toFixed(2) : "-"} s, last ${notes.length ? (notes[notes.length - 1].f / 100).toFixed(2) : "-"} s`);
