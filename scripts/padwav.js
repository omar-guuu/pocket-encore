#!/usr/bin/env node
// Appends silence to a 16-bit PCM WAV:  node padwav.js <in.wav> <out.wav> <seconds>
// The game stops a song's audio (and its clock) about 1.3 s before the end of the .ATM tracks; official songs
// have ~30 s of tail after the chart, so customs need a silent tail of a few seconds.
"use strict";
const fs = require("fs");
const [inp, out, secs] = process.argv.slice(2);
if (!inp || !out || !secs) { console.log("usage: padwav.js <in.wav> <out.wav> <seconds>"); process.exit(1); }
const b = fs.readFileSync(inp);
let o = 12, fmt = null, dataOff = -1, dataLen = 0;
while (o + 8 <= b.length) {
  const id = b.toString("ascii", o, o + 4), sz = b.readUInt32LE(o + 4);
  if (id === "fmt ") fmt = { ch: b.readUInt16LE(o + 10), rate: b.readUInt32LE(o + 12), bits: b.readUInt16LE(o + 22) };
  if (id === "data") { dataOff = o + 8; dataLen = sz; break; }
  o += 8 + sz + (sz & 1);
}
if (!fmt || fmt.bits !== 16 || dataOff < 0) throw new Error("need a 16-bit PCM WAV");
const pad = Math.round(parseFloat(secs) * fmt.rate) * fmt.ch * 2;
const outBuf = Buffer.concat([b.subarray(0, dataOff + dataLen), Buffer.alloc(pad)]);
outBuf.writeUInt32LE(dataLen + pad, dataOff - 4);
outBuf.writeUInt32LE(outBuf.length - 8, 4);
fs.writeFileSync(out, outBuf);
console.log(`${out}: ${(dataLen / fmt.rate / fmt.ch / 2).toFixed(2)} s + ${secs} s silence`);
