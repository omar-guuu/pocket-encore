#!/usr/bin/env node
// Zip files without extra packages: a pack as one .zip file to send (Pocket Encore's Share page), and opening a .zip
// someone sent (Merge Songs).
//
//   node zip.js <folder> <out.zip>          zips the folder (its name is the top folder inside the zip)
//
// Writing stores the files as they are (no compression: the songs' audio is already compressed, so deflating would
// only take time). Reading handles stored and deflated entries (zips made by Windows, 7-Zip, macOS...), not ZIP64
// (over 4 GB) or encrypted zips.
"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf, crc = 0) {
  crc = ~crc >>> 0;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return ~crc >>> 0;
}
function dosTime(d) {
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((Math.max(d.getFullYear(), 1980) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}
function listFiles(dir, rel = "") {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const r = rel ? rel + "/" + e.name : e.name;
    if (e.isDirectory()) out.push(...listFiles(dir, r)); else if (e.isFile()) out.push(r);
  }
  return out;
}

// zip a folder to out (written to out.tmp first, then renamed). onFile(name, k, n) reports progress.
function zipDir(dir, out, onFile) {
  const top = path.basename(path.resolve(dir)), files = listFiles(dir), central = [];
  const tmp = out + ".tmp", fd = fs.openSync(tmp, "w");
  let pos = 0;
  const write = b => { fs.writeSync(fd, b); pos += b.length; };
  try {
    for (const [k, rel] of files.entries()) {
      const p = path.join(dir, rel), data = fs.readFileSync(p), st = fs.statSync(p), { time, date } = dosTime(st.mtime);
      if (data.length >= 0xffffffff || pos >= 0xffffffff) throw new Error("the pack is over 4 GB: too big for one .zip file");
      const name = Buffer.from(top + "/" + rel, "utf8"), crc = crc32(data), at = pos;
      const h = Buffer.alloc(30);
      h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(0, 8);
      h.writeUInt16LE(time, 10); h.writeUInt16LE(date, 12); h.writeUInt32LE(crc, 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(data.length, 22);
      h.writeUInt16LE(name.length, 26); h.writeUInt16LE(0, 28);
      write(h); write(name); write(data);
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(0, 10);
      c.writeUInt16LE(time, 12); c.writeUInt16LE(date, 14); c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24);
      c.writeUInt16LE(name.length, 28); c.writeUInt32LE(at, 42);
      central.push(Buffer.concat([c, name]));
      if (onFile) onFile(rel, k + 1, files.length, data.length);
    }
    const cdAt = pos;
    for (const c of central) write(c);
    const e = Buffer.alloc(22);
    e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(central.length, 8); e.writeUInt16LE(central.length, 10);
    e.writeUInt32LE(pos - cdAt, 12); e.writeUInt32LE(cdAt, 16);
    write(e);
  } catch (err) { fs.closeSync(fd); fs.rmSync(tmp, { force: true }); throw err; }
  fs.closeSync(fd);
  fs.rmSync(out, { force: true });
  fs.renameSync(tmp, out);
  return { files: files.length, bytes: pos };
}

// unzip into dest (which must be empty or not exist). Entry names that would land outside dest are refused.
function unzip(file, dest) {
  const buf = fs.readFileSync(file);
  let e = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new Error("not a zip file (or a damaged one)");
  const count = buf.readUInt16LE(e + 10), cdAt = buf.readUInt32LE(e + 16);
  if (count === 0xffff || cdAt === 0xffffffff) throw new Error("this zip is too big (ZIP64): unzip it first, then pick the folder");
  const root = path.resolve(dest);
  fs.mkdirSync(root, { recursive: true });
  let p = cdAt, n = 0;
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("damaged zip file");
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), at = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nl).toString(flags & 0x0800 ? "utf8" : "latin1").replace(/\\/g, "/");
    p += 46 + nl + xl + cl;
    if (flags & 1) throw new Error("this zip is password protected: unzip it first, then pick the folder");
    const out = path.resolve(root, name);
    if (out !== root && !out.startsWith(root + path.sep)) throw new Error(`unsafe name in the zip: ${name}`);
    if (name.endsWith("/")) { fs.mkdirSync(out, { recursive: true }); continue; }
    const dataAt = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28), raw = buf.slice(dataAt, dataAt + size);
    const data = method === 0 ? raw : method === 8 ? zlib.inflateRawSync(raw) : null;
    if (!data) throw new Error(`${name}: compression method ${method} isn't supported: unzip it first, then pick the folder`);
    if (data.length !== usize) throw new Error(`${name}: damaged in the zip`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, data);
    n++;
  }
  return { files: n };
}

module.exports = { zipDir, unzip, crc32 };

if (require.main === module) {
  const [dir, out] = process.argv.slice(2);
  if (!dir || !out) { console.log("usage: zip.js <folder> <out.zip>"); process.exit(1); }
  try {
    const t0 = Date.now();
    let mb = 0;
    const r = zipDir(dir, out, (rel, k, n, size) => { mb += size / 1048576; if (/\.ATM$/i.test(rel) || k === n) console.log(`  [${k}/${n}] ${rel}`); });
    console.log(`zip: ${r.files} files, ${(r.bytes / 1048576).toFixed(1)} MB in ${((Date.now() - t0) / 1000).toFixed(1)} s -> ${out}`);
  } catch (e) { console.error(`\nERROR: ${e.message}`); process.exit(1); }
}
