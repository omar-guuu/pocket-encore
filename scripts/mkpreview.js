#!/usr/bin/env node
// Makes the stereo WAV for <NAME>_PREVIEW.AT3 from the 44.1 kHz mono stems (output of prepwav.js).
//   node mkpreview.js <stem_dir> <out.wav> [--start <seconds>] [--length 30]
// Stems: drums.wav bass_guitar.wav lead_guitar.wav vocals.wav [fill.wav]
// Mix: mild panning, then gain to the official previews' loudness (about -17 dBFS RMS, peaks <= -1 dBFS),
// 1 s fade-in and 4 s fade-out like the official files. Without --start, the loudest window is used.
// Encode afterwards with: at3tool -e -br 352 -wholeloop <out.wav> <NAME>_PREVIEW.AT3
"use strict";
const fs = require("fs");
const path = require("path");
const RATE = 44100;

// pan: -1 = left, +1 = right (constant-power)
const STEMS = [
  { f: "drums.wav", pan: 0.0 },
  { f: "bass_guitar.wav", pan: 0.0 },
  { f: "lead_guitar.wav", pan: -0.35 },
  { f: "vocals.wav", pan: 0.1 },
  { f: "fill.wav", pan: 0.0, optional: true },
];

function readMono44k(p) {
  const b = fs.readFileSync(p);
  let o = 12, fmt, data;
  while (o + 8 <= b.length) {
    const id = b.toString("ascii", o, o + 4), sz = b.readUInt32LE(o + 4);
    if (id === "fmt ") fmt = { tag: b.readUInt16LE(o + 8), ch: b.readUInt16LE(o + 10), rate: b.readUInt32LE(o + 12), bits: b.readUInt16LE(o + 22) };
    if (id === "data") { data = b.subarray(o + 8, o + 8 + sz); break; }
    o += 8 + sz + (sz & 1);
  }
  if (!fmt || fmt.tag !== 1 || fmt.ch !== 1 || fmt.rate !== RATE || fmt.bits !== 16) throw new Error(`${p}: need 16-bit mono 44.1 kHz PCM (run prepwav.js first)`);
  const n = data.length / 2, x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = data.readInt16LE(i * 2) / 32768;
  return x;
}

function main() {
  const args = process.argv.slice(2);
  const [stemDir, out] = args;
  if (!stemDir || !out) { console.log("usage: mkpreview.js <stem_dir> <out.wav> [--start s] [--length 30]"); process.exit(1); }
  const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? parseFloat(args[i + 1]) : d; };
  const lengthS = opt("--length", 30), fadeIn = 1, fadeOut = 4;

  const stems = STEMS.filter(s => !s.optional || fs.existsSync(path.join(stemDir, s.f)))
    .map(s => ({ ...s, x: readMono44k(path.join(stemDir, s.f)) }));
  const n = Math.min(...stems.map(s => s.x.length));
  const L = new Float32Array(n), R = new Float32Array(n);
  for (const s of stems) {
    const a = (s.pan + 1) * Math.PI / 4, gl = Math.cos(a) * Math.SQRT2, gr = Math.sin(a) * Math.SQRT2;
    for (let i = 0; i < n; i++) { L[i] += s.x[i] * gl * 0.5; R[i] += s.x[i] * gr * 0.5; }
  }

  const len = Math.min(n, Math.round(lengthS * RATE));
  let start = args.includes("--start") ? Math.round(opt("--start", 0) * RATE) : -1;
  if (start < 0) { // loudest window, 1 s hops
    const hop = RATE, e = [];
    for (let w = 0; w * hop < n; w++) { let s2 = 0; for (let i = w * hop; i < Math.min(n, (w + 1) * hop); i++) s2 += L[i] * L[i] + R[i] * R[i]; e.push(s2); }
    const win = Math.round(len / hop); let best = 0, bestE = -1;
    for (let w = 0; w + win <= e.length; w++) { let s2 = 0; for (let k = 0; k < win; k++) s2 += e[w + k]; if (s2 > bestE) { bestE = s2; best = w; } }
    start = best * hop;
  }
  start = Math.max(0, Math.min(start, n - len));

  // Gain to target loudness, limited by peak.
  let s2 = 0, peak = 0;
  for (let i = start; i < start + len; i++) { s2 += L[i] * L[i] + R[i] * R[i]; peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i])); }
  const rms = Math.sqrt(s2 / (2 * len));
  const gain = Math.min(10 ** (-17 / 20) / rms, 10 ** (-1 / 20) / peak);

  const pcm = Buffer.alloc(44 + len * 4);
  pcm.write("RIFF", 0); pcm.writeUInt32LE(36 + len * 4, 4); pcm.write("WAVE", 8);
  pcm.write("fmt ", 12); pcm.writeUInt32LE(16, 16); pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(2, 22);
  pcm.writeUInt32LE(RATE, 24); pcm.writeUInt32LE(RATE * 4, 28); pcm.writeUInt16LE(4, 32); pcm.writeUInt16LE(16, 34);
  pcm.write("data", 36); pcm.writeUInt32LE(len * 4, 40);
  const fi = fadeIn * RATE, fo = fadeOut * RATE;
  for (let k = 0; k < len; k++) {
    let g = gain;
    if (k < fi) g *= k / fi;
    if (k > len - fo) g *= Math.max(0, (len - k) / fo) ** 2;
    const d = () => (Math.random() - Math.random()) / 32768;
    const q = v => Math.max(-32768, Math.min(32767, Math.round((v + d()) * 32767)));
    pcm.writeInt16LE(q(L[start + k] * g), 44 + k * 4);
    pcm.writeInt16LE(q(R[start + k] * g), 46 + k * 4);
  }
  fs.writeFileSync(out, pcm);
  const mmss = s => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
  console.log(`preview ${out}: ${mmss(start / RATE)} - ${mmss((start + len) / RATE)} (${(len / RATE).toFixed(1)} s), gain ${(20 * Math.log10(gain)).toFixed(1)} dB, peak ${(20 * Math.log10(peak * gain)).toFixed(1)} dBFS`);
}

main();
