#!/usr/bin/env node
// Loudness of a song as the game plays it: the five tracks summed (all parts hit).
//   node loudness.js <dir with drums/bass_guitar/lead_guitar/vocals/fill .wav> [...more dirs]
// Prints integrated loudness (ITU-R BS.1770: K-weighting, -70 LUFS absolute and -10 LU relative gates, 400 ms
// blocks, mono), RMS, sample peak and the number of samples above full scale, plus each track's loudness.
"use strict";
const fs = require("fs");
const path = require("path");
const TRACKS = ["drums", "bass_guitar", "lead_guitar", "vocals", "fill"];

function readWav(p) {
  const b = fs.readFileSync(p);
  let o = 12, ch = 1, rate = 44100, d0 = 0, dl = 0;
  while (o + 8 <= b.length) {
    const id = b.toString("ascii", o, o + 4), sz = b.readUInt32LE(o + 4);
    if (id === "fmt ") { ch = b.readUInt16LE(o + 10); rate = b.readUInt32LE(o + 12); }
    if (id === "data") { d0 = o + 8; dl = Math.min(sz, b.length - d0); break; }
    o += 8 + sz + (sz & 1);
  }
  const n = Math.floor(dl / 2 / ch), x = new Float64Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let c = 0; c < ch; c++) s += b.readInt16LE(d0 + (i * ch + c) * 2); x[i] = s / ch / 32768; }
  return { rate, x };
}

// BS.1770 K-weighting at 44.1/48 kHz (coefficients computed from the analog prototype).
function kWeight(x, rate) {
  const biquad = (x, b, a) => { const y = new Float64Array(x.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) { const v = b[0] * x[i] + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2; x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v; } return y; };
  // stage 1: high shelf (+4 dB above ~1.5 kHz)
  let f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
  let K = Math.tan(Math.PI * f0 / rate), Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const b1 = [(Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0];
  const a1 = [1, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0];
  // stage 2: high pass (~38 Hz)
  f0 = 38.13547087602444; Q = 0.5003270373238773; K = Math.tan(Math.PI * f0 / rate);
  a0 = 1 + K / Q + K * K;
  const b2 = [1, -2, 1], a2 = [1, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0];
  return biquad(biquad(x, b1, a1), b2, a2);
}

function lufs(x, rate) {
  const y = kWeight(x, rate), blk = Math.round(0.4 * rate), hop = Math.round(0.1 * rate), z = [];
  for (let s = 0; s + blk <= y.length; s += hop) { let e = 0; for (let i = s; i < s + blk; i++) e += y[i] * y[i]; z.push(e / blk); }
  const L = e => -0.691 + 10 * Math.log10(e + 1e-15);
  const abs = z.filter(e => L(e) > -70);
  if (!abs.length) return -Infinity;
  const rel = L(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
  const g = abs.filter(e => L(e) > rel);
  return L(g.reduce((a, b) => a + b, 0) / g.length);
}

module.exports = { lufs, kWeight, readWav };
if (require.main === module) main();
function main() {
const dirs = process.argv.slice(2);
if (!dirs.length) { console.log("usage: loudness.js <track dir> [...]"); process.exit(1); }
for (const d of dirs) {
  const w = TRACKS.map(t => readWav(path.join(d, t + ".wav")));
  const rate = w[0].rate, n = Math.max(...w.map(v => v.x.length)), sum = new Float64Array(n);
  for (const v of w) for (let i = 0; i < v.x.length; i++) sum[i] += v.x[i];
  let sq = 0, pk = 0, over = 0; for (const v of sum) { sq += v * v; const a = Math.abs(v); if (a > pk) pk = a; if (a >= 1) over++; }
  const per = w.map((v, k) => `${TRACKS[k].split("_")[0]} ${lufs(v.x, rate).toFixed(1)}`).join(", ");
  console.log(`${path.basename(path.resolve(d)).padEnd(22)} mix ${lufs(sum, rate).toFixed(1)} LUFS  RMS ${(10 * Math.log10(sq / n)).toFixed(1)} dB  peak ${(20 * Math.log10(pk)).toFixed(1)} dBFS  over ${over}  | ${per}`);
}
}
