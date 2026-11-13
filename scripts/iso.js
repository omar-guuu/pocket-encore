// Minimal ISO 9660 reader (PSP UMD images) and CSO (compressed ISO, v1) support: list directories and read files
// without extracting the image. Node only.
//
//   const iso = openImage("ULUS10418.iso");  iso.list("PSP_GAME/USRDIR/MUSIC");  iso.read("PSP_GAME/USRDIR/STREAMS/JUKEBOX.STR")
//   node iso.js <image> ls <dir> | cat <file> <out> | find <text>
"use strict";
const fs = require("fs");
const zlib = require("zlib");

const SECTOR = 2048;

// Block device over a plain ISO or a CSO file: read(offset, length) -> Buffer
function device(file) {
  const fd = fs.openSync(file, "r");
  const head = Buffer.alloc(24);
  fs.readSync(fd, head, 0, 24, 0);
  if (head.toString("ascii", 0, 4) !== "CISO") {
    const size = fs.fstatSync(fd).size;
    return { size, read(off, len) { const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, off); return b; }, close() { fs.closeSync(fd); } };
  }
  // CSO: header 0x18 bytes, then (blocks + 1) u32 index entries (bit 31 = stored uncompressed), shifted by align
  const total = Number(head.readBigUInt64LE(8)), block = head.readUInt32LE(16), align = head[21];
  const blocks = Math.ceil(total / block);
  const idx = Buffer.alloc((blocks + 1) * 4);
  fs.readSync(fd, idx, 0, idx.length, 24);
  const cache = new Map();
  const getBlock = n => {
    if (cache.has(n)) return cache.get(n);
    const a = idx.readUInt32LE(n * 4), b = idx.readUInt32LE(n * 4 + 4);
    const plain = a & 0x80000000, start = (a & 0x7fffffff) * 2 ** align, end = (b & 0x7fffffff) * 2 ** align;
    const raw = Buffer.alloc(end - start);
    fs.readSync(fd, raw, 0, raw.length, start);
    const data = plain ? raw.subarray(0, block) : zlib.inflateRawSync(raw);
    if (cache.size > 256) cache.clear();
    cache.set(n, data);
    return data;
  };
  return {
    size: total,
    read(off, len) {
      const out = Buffer.alloc(len);
      let done = 0;
      while (done < len) {
        const n = Math.floor((off + done) / block), inner = (off + done) % block;
        const blk = getBlock(n), take = Math.min(block - inner, len - done);
        blk.copy(out, done, inner, inner + take);
        done += take;
      }
      return out;
    },
    close() { fs.closeSync(fd); },
  };
}

function openImage(file) {
  const dev = device(file);
  const pvd = dev.read(16 * SECTOR, SECTOR);
  if (pvd[0] !== 1 || pvd.toString("ascii", 1, 6) !== "CD001") { dev.close(); throw new Error(`${file}: not an ISO 9660 image`); }
  const rec = b => ({ lba: b.readUInt32LE(2), size: b.readUInt32LE(10), dir: !!(b[25] & 2) });
  const root = rec(pvd.subarray(156, 190));
  const volume = pvd.toString("ascii", 40, 72).trim();
  const readDir = d => {
    const data = dev.read(d.lba * SECTOR, d.size), out = [];
    for (let o = 0; o < data.length;) {
      const len = data[o];
      if (!len) { o = (Math.floor(o / SECTOR) + 1) * SECTOR; continue; }  // records never cross a sector
      const nl = data[o + 32];
      let name = data.toString("latin1", o + 33, o + 33 + nl);
      if (!(nl === 1 && (data[o + 33] === 0 || data[o + 33] === 1))) {
        name = name.replace(/;1$/, "").replace(/\.$/, "");
        out.push({ name, ...rec(data.subarray(o, o + len)) });
      }
      o += len;
    }
    return out;
  };
  const find = p => {
    let cur = { ...root, name: "" };
    for (const part of String(p).split(/[\\/]+/).filter(Boolean)) {
      if (!cur.dir) return null;
      cur = readDir(cur).find(e => e.name.toUpperCase() === part.toUpperCase());
      if (!cur) return null;
    }
    return cur;
  };
  return {
    volume,
    size: dev.size,
    exists: p => !!find(p),
    list(p = "") { const d = find(p); if (!d || !d.dir) throw new Error(`not a folder in the image: ${p}`); return readDir(d); },
    read(p) { const f = find(p); if (!f || f.dir) throw new Error(`not a file in the image: ${p}`); return dev.read(f.lba * SECTOR, f.size); },
    readRaw: (off, len) => dev.read(off, len),
    close: () => dev.close(),
  };
}

module.exports = { openImage };

if (require.main === module) {
  const [img, cmd, a, b] = process.argv.slice(2);
  const iso = openImage(img);
  if (cmd === "ls") for (const e of iso.list(a || "")) console.log(`${e.dir ? "d" : "-"} ${String(e.size).padStart(11)} ${e.name}`);
  else if (cmd === "cat") { fs.writeFileSync(b, iso.read(a)); console.log(`wrote ${b}`); }
  else if (cmd === "find") {
    // every file whose bytes contain the text (latin1 or UTF-16LE)
    const needles = [Buffer.from(a, "latin1"), Buffer.from(a, "utf16le")];
    const walk = dir => {
      for (const e of iso.list(dir)) {
        const p = dir ? `${dir}/${e.name}` : e.name;
        if (e.dir) walk(p);
        else if (e.size < 512 << 20) { const data = iso.read(p); for (const n of needles) { const at = data.indexOf(n); if (at >= 0) console.log(`${p} @${at} (${n === needles[0] ? "latin1" : "utf16"})`); } }
      }
    };
    walk("");
  } else console.log("usage: iso.js <image> ls <dir> | cat <file> <out> | find <text>");
  iso.close();
}
