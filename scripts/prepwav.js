#!/usr/bin/env node
// Prepares stems for at3tool: 16-bit PCM mono 44.1 kHz WAV.
//   node prepwav.js <in.wav> <out.wav> [gain_dB]  resample/downmix to 44.1 kHz mono 16-bit, optional gain (e.g. -1)
//   node prepwav.js --silence <like.wav> <out.wav>   silent WAV with the same length as <like.wav> (already 44.1 kHz)
// Resampling: windowed-sinc (Kaiser, beta 9, 64 zero crossings), cutoff 0.95 x the lower Nyquist,
// TPDF dither on the final 16-bit quantisation, clip counting.
"use strict";
const fs = require("fs");
const OUT_RATE = 44100;

function readWav(p) {
  const b = fs.readFileSync(p);
  if (b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WAVE") throw new Error(p + ": not a RIFF/WAVE file");
  let o = 12, fmt = null, data = null;
  while (o + 8 <= b.length) {
    const id = b.toString("ascii", o, o + 4), sz = b.readUInt32LE(o + 4);
    if (id === "fmt ") {
      fmt = { tag: b.readUInt16LE(o + 8), ch: b.readUInt16LE(o + 10), rate: b.readUInt32LE(o + 12), bits: b.readUInt16LE(o + 22) };
      if (fmt.tag === 0xfffe && sz >= 40) fmt.tag = b.readUInt16LE(o + 8 + 24); // WAVE_FORMAT_EXTENSIBLE: sub-format
    }
    if (id === "data") { data = b.subarray(o + 8, o + 8 + sz); break; }
    o += 8 + sz + (sz & 1);
  }
  if (!fmt || !data) throw new Error(p + ": missing fmt or data chunk");
  // 16/24/32-bit integer PCM or 32/64-bit float; channels are averaged to mono.
  const W = fmt.bits / 8;
  const rd = fmt.tag === 1 && fmt.bits === 16 ? o => data.readInt16LE(o) / 32768
    : fmt.tag === 1 && fmt.bits === 24 ? o => data.readIntLE(o, 3) / 8388608
    : fmt.tag === 1 && fmt.bits === 32 ? o => data.readInt32LE(o) / 2147483648
    : fmt.tag === 3 && fmt.bits === 32 ? o => data.readFloatLE(o)
    : fmt.tag === 3 && fmt.bits === 64 ? o => data.readDoubleLE(o) : null;
  if (!rd) throw new Error(`${p}: unsupported WAV format (tag ${fmt.tag}, ${fmt.bits}-bit)`);
  const n = Math.floor(data.length / (W * fmt.ch));
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let c = 0; c < fmt.ch; c++) s += rd((i * fmt.ch + c) * W); x[i] = s / fmt.ch; }
  return { rate: fmt.rate, ch: fmt.ch, x };
}

function writeWav(p, samples /* Int16Array */) {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + samples.length * 2, 4); b.write("WAVE", 8);
  b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(OUT_RATE, 24); b.writeUInt32LE(OUT_RATE * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36); b.writeUInt32LE(samples.length * 2, 40);
  Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).copy(b, 44);
  fs.writeFileSync(p, b);
}

function besselI0(x) { let s = 1, t = 1; for (let k = 1; k < 50; k++) { t *= (x / (2 * k)) ** 2; s += t; if (t < 1e-12 * s) break; } return s; }

function resample(x, inRate, outRate) {
  if (inRate === outRate) return x;
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const g = gcd(inRate, outRate), L = outRate / g, M = inRate / g; // out = in * L / M
  const zc = 64, beta = 9, cutoff = 0.95 * Math.min(1, L / M);      // normalised to input Nyquist
  const half = Math.ceil(zc / cutoff);                               // taps each side, in input samples
  // Polyphase table: phase p in [0, L) -> 2*half taps
  const taps = 2 * half, I0b = besselI0(beta);
  const table = new Float64Array(L * taps);
  for (let p = 0; p < L; p++) {
    const frac = p / L; let sum = 0;
    for (let k = 0; k < taps; k++) {
      const t = k - half + 1 - frac;                                 // distance in input samples
      const xx = cutoff * t;
      const sinc = xx === 0 ? 1 : Math.sin(Math.PI * xx) / (Math.PI * xx);
      const r = t / half;
      const w = Math.abs(r) >= 1 ? 0 : besselI0(beta * Math.sqrt(1 - r * r)) / I0b;
      const v = cutoff * sinc * w; table[p * taps + k] = v; sum += v;
    }
    for (let k = 0; k < taps; k++) table[p * taps + k] /= sum;      // unity DC gain per phase
  }
  const nOut = Math.floor(x.length * L / M);
  const y = new Float64Array(nOut);
  for (let n = 0; n < nOut; n++) {
    const pos = n * M, i0 = Math.floor(pos / L), p = pos % L;
    let acc = 0; const base = p * taps, start = i0 - half + 1;
    for (let k = 0; k < taps; k++) { const i = start + k; if (i >= 0 && i < x.length) acc += x[i] * table[base + k]; }
    y[n] = acc;
  }
  return y;
}

function toInt16(y) {
  const out = new Int16Array(y.length); let clips = 0, peak = 0;
  for (let i = 0; i < y.length; i++) {
    const d = (Math.random() - Math.random()) / 32768;               // TPDF, +-1 LSB
    let v = Math.round((y[i] + d) * 32767);
    if (v > 32767) { v = 32767; clips++; } else if (v < -32768) { v = -32768; clips++; }
    out[i] = v; if (Math.abs(y[i]) > peak) peak = Math.abs(y[i]);
  }
  return { out, clips, peak };
}

const args = process.argv.slice(2);
if (args[0] === "--silence" && args.length === 3) {
  const like = readWav(args[1]);
  if (like.rate !== OUT_RATE) throw new Error("--silence reference must already be 44.1 kHz");
  writeWav(args[2], new Int16Array(like.x.length));
  console.log(`silence ${args[2]}: ${like.x.length} samples (${(like.x.length / OUT_RATE).toFixed(2)} s)`);
} else if (args.length === 2 || args.length === 3) {
  const w = readWav(args[0]);
  const y = resample(w.x, w.rate, OUT_RATE);
  const gain = args[2] ? 10 ** (parseFloat(args[2]) / 20) : 1;
  if (gain !== 1) for (let i = 0; i < y.length; i++) y[i] *= gain;
  const { out, clips, peak } = toInt16(y);
  writeWav(args[1], out);
  console.log(`${args[0]} -> ${args[1]}: ${w.rate} Hz ${w.ch}ch, ${w.x.length} -> ${out.length} samples (${(out.length / OUT_RATE).toFixed(2)} s), peak ${(20 * Math.log10(peak || 1e-9)).toFixed(1)} dBFS, clipped ${clips}`);
} else {
  console.log("usage: prepwav.js <in.wav> <out.wav> [gain_dB] | --silence <like.wav> <out.wav>"); process.exit(1);
}
