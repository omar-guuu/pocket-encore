#!/usr/bin/env node
// Follows UnpluggedDeluxe's pointer chains through a gameplay RAM dump and reports where each chart
// array lives inside the BEATMATCH image (loaded at 0x096e9a80).
//   node chartmap.js <ram_dump> <BEATMATCH.STR.EDAT> <difficulty 0-3>
"use strict";
const fs = require("fs");
const [dumpPath, bmPath, diffArg] = process.argv.slice(2);
const B = 0x08800000, BASE = 0x096e9a80;
const m = fs.readFileSync(dumpPath), bm = fs.readFileSync(bmPath);
const diff = parseInt(diffArg || "0", 10);
const st = bm.readUInt32LE(0x80 + (124 + diff) * 0x40), sz = bm.readUInt32LE(0x80 + (124 + diff) * 0x40 + 4);
const U = a => (a >= B && a + 4 <= B + m.length) ? m.readUInt32LE(a - B) : 0;
const F = a => (a >= BASE && a < BASE + sz) ? bm.readUInt32LE(st + a - BASE) : undefined;
const hx = v => (v >>> 0).toString(16).padStart(8, "0");
const where = a => (a >= BASE && a < BASE + sz) ? "img+" + (a - BASE).toString(16) : (a ? "OUTSIDE" : "null");
const arrays = [];
function vec(name, holderAddr, dataOff, capOff, sizeOff, elem) {
  const data = U(holderAddr + dataOff), cap = U(holderAddr + capOff), size = U(holderAddr + sizeOff);
  const sameInFile = F(holderAddr + dataOff) === data && F(holderAddr + sizeOff) === size;
  arrays.push({ name, holder: where(holderAddr), data: where(data), dataAddr: data, cap, size, elem, bytes: size * elem, sameInFile });
}
const root = U(0x08b7d5a4);
vec("tempo", U(0x096e9b94), 4, 8, 0xc, 12);
vec("beats", U(0x096e9b9c), 0, 4, 8, 8);
vec("measures", U(0x096e9b98), 0, 4, 8, 16);
const tw = U(0x08b7cf14);
for (let t = 0; t < 4; t++) {
  const watcher = U(tw + 0x38 + t * 4);
  const p = U(U(watcher) + 8);
  vec(`gems[${t}]`, p, 8, 0xc, 0x10, 0x14);
}
for (let t = 0; t < 4; t++) {
  const l = U(U(U(U(U(root + 0x104) + 4 * diff)))) + 4 * t; // A, unk, unk2, unk3 -> *unk3 + 4t
  vec(`gem_info[${t}]`, U(l), 4, 8, 0xc, 1);
}
for (let t = 0; t < 4; t++) {
  const unk = U(U(root + 0x1e0) + 4 * t);
  const song = U(U(unk + 0xc) + 0xc);
  vec(`bars[${t}]`, song, 0xc, 0x10, 0x14, 16);
}
for (let t = 0; t < 4; t++) vec(`solos[${t}]`, root + 0x58 + t * 0xc, 0, 4, 8, 20);
console.log(`difficulty ${diff}: section @0x${st.toString(16)} size 0x${sz.toString(16)}`);
for (const a of arrays) console.log(`${a.name.padEnd(12)} holder ${a.holder.padEnd(12)} data ${a.data.padEnd(12)} size ${String(a.size).padStart(6)} cap ${String(a.cap).padStart(6)} x${a.elem} = ${String(a.bytes).padStart(7)} B  file==ram:${a.sameInFile}`);
module.exports = { arrays };
