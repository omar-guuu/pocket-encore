#!/usr/bin/env node
// Node port of maodus/ATMTool (Rock Band Unplugged .ATM encrypt/decrypt).
//   node atmtool.js -d <file.ATM> <out_dir>      -> drums/bass_guitar/lead_guitar/vocals/fill .at3
//   node atmtool.js -e <in_dir> <file.ATM>       -> packs the five .at3 files from in_dir
//   node atmtool.js -i <file.ATM>                -> print header and track layout
// Differences from the C tool: paths are arguments (no cwd assumption) and the encoder writes the
// final partial chunk of each track packed (max_len % chunk_size bytes), which is the layout the
// decoder (and therefore the game) reads. The C encoder pads it to a full chunk instead.
"use strict";
const fs = require("fs");
const path = require("path");

const TRACKS = ["drums.at3", "bass_guitar.at3", "lead_guitar.at3", "vocals.at3", "fill.at3"];
const HDR = 0x38;

// ---------- HC-128 (Hongjun Wu, reference semantics) ----------
const rotr = (x, n) => ((x >>> n) | (x << (32 - n))) >>> 0;
const rotl = (x, n) => ((x << n) | (x >>> (32 - n))) >>> 0;
const f1 = x => (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) >>> 0;
const f2 = x => (rotr(x, 17) ^ rotr(x, 19) ^ (x >>> 10)) >>> 0;
const fw = (a, b, c, d) => (f2(a) + b + f1(c) + d) >>> 0;

function hc128(key16, iv16, data) {
  const P = new Uint32Array(512), Q = new Uint32Array(512), W = new Uint32Array(1280);
  const k = new DataView(key16.buffer, key16.byteOffset, 16), v = new DataView(iv16.buffer, iv16.byteOffset, 16);
  for (let i = 0; i < 4; i++) { W[i] = W[i + 4] = k.getUint32(i * 4, true); W[i + 8] = W[i + 12] = v.getUint32(i * 4, true); }
  for (let i = 16; i < 1280; i++) W[i] = (fw(W[i - 2], W[i - 7], W[i - 15], W[i - 16]) + i) >>> 0;
  for (let i = 0; i < 512; i++) { P[i] = W[i + 256]; Q[i] = W[i + 768]; }
  let ctr = 0;
  const step = (out) => {
    const j = ctr & 0x1ff, j3 = (j - 3) & 0x1ff, j10 = (j - 10) & 0x1ff, j511 = (j - 511) & 0x1ff, j12 = (j - 12) & 0x1ff;
    let s;
    if (ctr < 512) {
      P[j] = (P[j] + (rotr(P[j10], 8) + ((rotr(P[j3], 10) ^ rotr(P[j511], 23)) >>> 0))) >>> 0;
      const x = P[j12];
      s = ((Q[x & 0xff] + Q[256 + ((x >>> 16) & 0xff)]) >>> 0) ^ P[j];
      if (!out) P[j] = s >>> 0;
    } else {
      Q[j] = (Q[j] + (rotl(Q[j10], 8) + ((rotl(Q[j3], 10) ^ rotl(Q[j511], 23)) >>> 0))) >>> 0;
      const x = Q[j12];
      s = ((P[x & 0xff] + P[256 + ((x >>> 16) & 0xff)]) >>> 0) ^ Q[j];
      if (!out) Q[j] = s >>> 0;
    }
    ctr = (ctr + 1) & 0x3ff;
    return s >>> 0;
  };
  for (let i = 0; i < 1024; i++) step(false); // init: 1024 steps, output fed back
  const out = Buffer.from(data);
  for (let off = 0; off < out.length; off += 4) {
    const ks = step(true);
    for (let b = 0; b < 4 && off + b < out.length; b++) out[off + b] ^= (ks >>> (8 * b)) & 0xff;
  }
  return out;
}

// ---------- ATM header helpers ----------
function readHeader(buf) {
  const u = o => buf.readUInt32LE(o);
  return { key4: u(0), num_tracks: u(4), key2: u(8), chunk_size: u(0xc), key1: u(0x10),
    track_bytes: [0, 1, 2, 3, 4].map(i => u(0x14 + i * 4)), word10: u(0x28), word11: u(0x2c), word12: u(0x30), key3: u(0x34),
    raw: Buffer.from(buf.subarray(0, HDR)) };
}
function writeHeader(h) {
  const b = Buffer.alloc(HDR);
  b.writeUInt32LE(h.key4, 0); b.writeUInt32LE(h.num_tracks, 4); b.writeUInt32LE(h.key2, 8);
  b.writeUInt32LE(h.chunk_size, 0xc); b.writeUInt32LE(h.key1, 0x10);
  h.track_bytes.forEach((v, i) => b.writeUInt32LE(v, 0x14 + i * 4));
  b.writeUInt32LE(h.word10, 0x28); b.writeUInt32LE(h.word11, 0x2c); b.writeUInt32LE(h.word12, 0x30); b.writeUInt32LE(h.key3, 0x34);
  return b;
}
function secretKey(h) {
  const k = Buffer.alloc(16);
  k.writeUInt32LE((h.key1 ^ 0x5156B456) >>> 0, 0); k.writeUInt32LE((h.key2 ^ 0x28CBD70B) >>> 0, 4);
  k.writeUInt32LE((h.key3 ^ 0x4B5AEFFC) >>> 0, 8); k.writeUInt32LE((h.key4 ^ 0x6165E84B) >>> 0, 12);
  return k;
}
function initVector(hdrBytes, numTracks, track) {
  const unk = Math.floor(((8 - numTracks) * 4) / numTracks) + 1;
  const iv = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) {
    const a = hdrBytes[(track * unk + (i % unk)) - track + numTracks * 4 + 0x14];
    const last = i === 0 ? 0 : iv[i - 1];
    iv[i] = (a ^ ((last + (~a) + i + track) & 0xff)) & 0xff; // C precedence: a ^ (last + ~a + i + track)
  }
  return iv;
}
const total = h => h.track_bytes.reduce((s, v) => s + v, 0) >>> 0;
const xorHead = (buf, t) => { buf.writeUInt32LE((buf.readUInt32LE(0) ^ t) >>> 0, 0); buf.writeUInt32LE((buf.readUInt32LE(4) ^ t) >>> 0, 4); };

// ---------- decode (exact port of DecodeATM's read pattern) ----------
function decode(atmPath, outDir) {
  const f = fs.readFileSync(atmPath);
  const h = readHeader(f);
  if (h.num_tracks !== 5) throw new Error("Only 5-track ATM files are supported");
  const cs = h.chunk_size, tot = total(h), maxLen = Math.max(...h.track_bytes), lastChunk = Math.floor(maxLen / cs);
  const key = secretKey(h);
  fs.mkdirSync(outDir, { recursive: true });
  const out = [];
  for (let i = 0; i < 5; i++) {
    const len = h.track_bytes[i];
    const data = Buffer.alloc(len);
    let pos = HDR + i * cs, read = 0, chunks = 0, rl = cs;
    while (read < len) {
      if (chunks === lastChunk) rl = maxLen % cs;
      else if (len - read < cs) rl = len - read;
      if (pos + rl > f.length) throw new Error(`track ${i}: read past end of file`);
      f.copy(data, read, pos, pos + rl);
      pos += rl; chunks++; read += rl;
      pos += chunks === lastChunk ? (4 - i) * cs + (maxLen % cs) * i : cs * 4;
    }
    const plain = hc128(key, initVector(h.raw, 5, i), data);
    xorHead(plain, tot);
    fs.writeFileSync(path.join(outDir, TRACKS[i]), plain);
    out.push(plain);
  }
  return { header: h, tracks: out };
}

// ---------- encode (inverse of decode; equal or unequal track lengths) ----------
function encode(inDir, atmPath) {
  const data = TRACKS.map(n => fs.readFileSync(path.join(inDir, n)));
  const h = { key1: 0xDEADBEEF, key2: 0xDEADBEEF, key3: 0xDEADBEEF, key4: 0xDEADBEEF, num_tracks: 5, chunk_size: 400,
    track_bytes: data.map(d => d.length), word10: 0xDEADBEEF, word11: 0xDEADBEEF, word12: 0xDEADBEEF };
  const hb = writeHeader(h), cs = h.chunk_size, tot = total(h), maxLen = Math.max(...h.track_bytes), lastChunk = Math.floor(maxLen / cs);
  const key = secretKey(h);
  const enc = data.map((d, i) => { const p = Buffer.from(d); xorHead(p, tot); return hc128(key, initVector(hb, 5, i), p); });
  // Place every byte exactly where decode() will read it.
  const size = HDR + lastChunk * cs * 5 + (maxLen % cs) * 5;
  const outBuf = Buffer.alloc(Math.max(size, HDR));
  hb.copy(outBuf, 0);
  let end = HDR;
  for (let i = 0; i < 5; i++) {
    const len = h.track_bytes[i];
    let pos = HDR + i * cs, written = 0, chunks = 0, rl = cs;
    while (written < len) {
      if (chunks === lastChunk) rl = maxLen % cs;
      else if (len - written < cs) rl = len - written;
      enc[i].copy(outBuf, pos, written, written + rl);
      end = Math.max(end, pos + rl);
      pos += rl; chunks++; written += rl;
      pos += chunks === lastChunk ? (4 - i) * cs + (maxLen % cs) * i : cs * 4;
    }
  }
  fs.writeFileSync(atmPath, outBuf.subarray(0, Math.max(end, size)));
  return { header: h, size: Math.max(end, size) };
}

function info(atmPath) {
  const f = fs.readFileSync(atmPath);
  const h = readHeader(f), maxLen = Math.max(...h.track_bytes);
  const hex = v => "0x" + (v >>> 0).toString(16).padStart(8, "0");
  console.log(path.basename(atmPath), "file size", f.length);
  console.log(" keys", [h.key1, h.key2, h.key3, h.key4].map(hex).join(" "), "words", [h.word10, h.word11, h.word12].map(hex).join(" "));
  console.log(" tracks", h.num_tracks, "chunk", h.chunk_size, "bytes", h.track_bytes.join(" "), "sum", total(h));
  console.log(" packed-layout size would be", HDR + Math.floor(maxLen / h.chunk_size) * h.chunk_size * 5 + (maxLen % h.chunk_size) * 5,
    "| padded-layout size", HDR + Math.ceil(maxLen / h.chunk_size) * h.chunk_size * 5);
}

if (require.main === module) {
  const [, , op, a, b] = process.argv;
  if (op === "-d" && a && b) { decode(a, b); console.log("decoded", a, "->", b); }
  else if (op === "-e" && a && b) { const r = encode(a, b); console.log("encoded", b, r.size, "bytes"); }
  else if (op === "-i" && a) info(a);
  else { console.log("usage: atmtool.js -d <file.ATM> <out_dir> | -e <in_dir> <file.ATM> | -i <file.ATM>"); process.exit(1); }
}
module.exports = { decode, encode, hc128, readHeader };
