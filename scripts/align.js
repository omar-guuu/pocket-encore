#!/usr/bin/env node
// Finds the offset (and tempo scale) between MIDI drum onsets and a drum stem.
//   node align.js <drums.wav 44.1k mono> <onsets.json from MIDI>
"use strict";
const fs = require("fs");
const [wavPath, onsetPath] = process.argv.slice(2);
const b = fs.readFileSync(wavPath); let o = 12, d0 = 0, dl = 0;
while (o + 8 <= b.length) { const id = b.toString("ascii", o, o + 4), sz = b.readUInt32LE(o + 4); if (id === "data") { d0 = o + 8; dl = sz; break; } o += 8 + sz + (sz & 1); }
const RATE = 44100, HOP = 441; // 10 ms
const n = dl / 2, frames = Math.floor(n / HOP);
// onset envelope: positive change of log energy of a crude high-passed signal
const env = new Float64Array(frames), lev = new Float64Array(frames); let prevE = 0, prevX = 0;
for (let f = 0; f < frames; f++) {
  let e = 0, r = 0;
  for (let i = f * HOP; i < (f + 1) * HOP; i++) { const x = b.readInt16LE(d0 + i * 2) / 32768; const hp = x - prevX; prevX = x; e += hp * hp; r += x * x; }
  const le = Math.log(1e-9 + e); env[f] = Math.max(0, le - prevE); prevE = le;
  lev[f] = 10 * Math.log10(r / HOP + 1e-12); // frame level in dBFS (for the silence test)
}
const on = JSON.parse(fs.readFileSync(onsetPath, "utf8"));
const secPerTick = 60 / on.bpm / on.tpb;
let best = { score: -1 };
for (let scale = 0.990; scale <= 1.0101; scale += 0.0005) {
  for (let off = -5; off <= 15; off += 0.01) {
    let s = 0;
    for (const t of on.ticks) { const f = Math.round((off + t * secPerTick * scale) * 100); if (f >= 1 && f < frames - 1) s += Math.max(env[f - 1], env[f], env[f + 1]); }
    if (s > best.score) best = { score: s, off, scale };
  }
}
// refine around best at 1 ms
let fine = best;
for (let off = best.off - 0.02; off <= best.off + 0.02; off += 0.001) {
  let s = 0; for (const t of on.ticks) { const f = (off + t * secPerTick * best.scale) * 100; const fi = Math.floor(f), fr = f - fi; if (fi >= 0 && fi < frames - 1) s += env[fi] * (1 - fr) + env[fi + 1] * fr; }
  if (s > fine.score) fine = { score: s, off, scale: best.scale };
}
// how sharp is the match: score at +-50 ms
const at = off => { let s = 0; for (const t of on.ticks) { const f = Math.round((off + t * secPerTick * fine.scale) * 100); if (f >= 0 && f < frames) s += env[f]; } return s; };
console.log(`best offset ${fine.off.toFixed(3)} s, tempo scale ${fine.scale.toFixed(4)} (=${(on.bpm / fine.scale).toFixed(3)} BPM), score ${fine.score.toFixed(1)}; score at -50ms ${at(fine.off - 0.05).toFixed(1)}, +50ms ${at(fine.off + 0.05).toFixed(1)}, -1 beat ${at(fine.off - 0.4).toFixed(1)}`);
// per-section check: offset fit in 4 quarters of the song
const q = on.ticks.length / 4;
for (let k = 0; k < 4; k++) {
  const part = on.ticks.slice(Math.floor(k * q), Math.floor((k + 1) * q)); let bs = { s: -1 };
  for (let off = fine.off - 0.1; off <= fine.off + 0.1; off += 0.002) { let s = 0; for (const t of part) { const f = Math.round((off + t * secPerTick * fine.scale) * 100); if (f >= 1 && f < frames - 1) s += Math.max(env[f - 1], env[f], env[f + 1]); } if (s > bs.s) bs = { s, off }; }
  console.log(`  quarter ${k + 1}: local best offset ${bs.off.toFixed(3)} s`);
}
// machine-readable result (used by mksong.js)
// Ambiguity: repetitive parts make whole-beat shifts score almost the same (Push It: +1 beat = 99 %; Handlebars:
// -8 beats = 98 %). Among the shifts of -8..+8 beats scoring >= 90 % of the best:
//  1. keep those that put (almost) no MIDI drum note where the drum stem is silent (a wrong shift pushes notes into
//     a silent intro or past the end; Handlebars at -8 beats: the first notes fall in 25-32 s of silence);
//  2. among those, if the stem's last strong onset matches a candidate's last MIDI note within 0.15 s, take the
//     closest (the ending is rarely repetitive; Push It); otherwise take the highest score.
const beat = on.tpb * secPerTick * fine.scale;
const sc = off => { let s = 0; for (const t of on.ticks) { const f = Math.round((off + t * secPerTick * fine.scale) * 100); if (f >= 1 && f < frames - 1) s += Math.max(env[f - 1], env[f], env[f + 1]); } return s; };
const sorted = Array.from(env).sort((x, y) => x - y), strong = sorted[Math.floor(sorted.length * 0.99)] * 0.5;
let lastOnset = 0; for (let f = frames - 1; f >= 0; f--) if (env[f] >= strong) { lastOnset = f / 100; break; }
const lastTick = Math.max(...on.ticks);
const levSorted = Array.from(lev).sort((x, y) => x - y), loud = levSorted[Math.floor(levSorted.length * 0.99)];
const silent = f => { for (let g = f - 5; g <= f + 5; g++) if (g >= 0 && g < frames && lev[g] > loud - 45) return false; return true; };
const inSilence = off => { let c = 0; for (const t of on.ticks) { const f = Math.round((off + t * secPerTick * fine.scale) * 100); if (f < 0 || f >= frames || silent(f)) c++; } return c; };
const self = sc(fine.off);
let cands = [];
for (let k = -8; k <= 8; k++) { const off = fine.off + k * beat, s = sc(off); if (s >= 0.9 * self) cands.push({ k, off, s, silent: inSilence(off), endErr: Math.abs(off + lastTick * secPerTick * fine.scale - lastOnset) }); }
console.log(`last strong drum onset ${lastOnset.toFixed(2)} s; candidates (>= 90 % score): ` + cands.map(c => `${c.k > 0 ? "+" : ""}${c.k} beat ${c.off.toFixed(3)} s ${(100 * c.s / self).toFixed(0)} % ${c.silent} notes in silence, end off by ${c.endErr.toFixed(2)} s`).join("; "));
const minSilent = Math.min(...cands.map(c => c.silent));
cands = cands.filter(c => c.silent <= minSilent + Math.max(2, Math.round(on.ticks.length * 0.01)));
const byEnd = cands.filter(c => c.endErr < 0.15).sort((x, y) => x.endErr - y.endErr);
const byScore = [...cands].sort((x, y) => y.s - x.s);
const pick = byEnd.length ? byEnd[0] : byScore[0];
const how = byEnd.length ? "ending matches" : "highest score among shifts with no notes in silence";
// refine the chosen one at 1 ms
let final = { off: pick.off, s: -1 };
for (let off = pick.off - 0.02; off <= pick.off + 0.02; off += 0.001) {
  let s = 0; for (const t of on.ticks) { const f = (off + t * secPerTick * fine.scale) * 100; const fi = Math.floor(f), fr = f - fi; if (fi >= 0 && fi < frames - 1) s += env[fi] * (1 - fr) + env[fi + 1] * fr; }
  if (s > final.s) final = { off, s };
}
const endErr = Math.abs(final.off + lastTick * secPerTick * fine.scale - lastOnset);
const ambiguous = byEnd.length
  ? byEnd.length > 1 && byEnd[1].endErr - byEnd[0].endErr < 0.1
  : byScore.length > 1 && byScore[1].s > 0.98 * byScore[0].s;
console.log(`chosen offset ${final.off.toFixed(3)} s (${pick.k > 0 ? "+" : ""}${pick.k} beat(s) from the raw best; ${how}); ${pick.silent} MIDI drum notes in silence${ambiguous ? " -- AMBIGUOUS, check by ear" : ""}`);
console.log("ALIGN " + JSON.stringify({ offset: +final.off.toFixed(3), bpm: +(on.bpm / fine.scale).toFixed(3), endErr: +endErr.toFixed(3), ambiguous }));
