// Standard MIDI file reader/writer for the studio (format 1, any ticks per beat).
// parse(buf) -> { format, tpb, tracks: [{ name, notes: [{ t, l, n, v, c }], events: [{ t, d: [bytes] }] }] }
//   notes: note on/off pairs (t = start tick, l = length in ticks, n = note, v = velocity, c = channel);
//   events: everything else (meta, sysex, controllers), kept as raw bytes with their tick, written back unchanged.
// write(midi) -> Buffer. Note offs are written before note ons at the same tick.
"use strict";

function readVar(b, o) {
  let v = 0, c;
  do { c = b[o.i++]; v = (v << 7) | (c & 0x7f); } while (c & 0x80);
  return v;
}
function varBytes(v) {
  const out = [v & 0x7f];
  while ((v >>>= 7)) out.unshift((v & 0x7f) | 0x80);
  return out;
}

function parse(b) {
  if (b.toString("ascii", 0, 4) !== "MThd") throw new Error("not a MIDI file");
  const hlen = b.readUInt32BE(4), format = b.readUInt16BE(8), ntr = b.readUInt16BE(10), tpb = b.readUInt16BE(12);
  if (tpb & 0x8000) throw new Error("SMPTE time division is not supported");
  let p = 8 + hlen;
  const tracks = [];
  for (let k = 0; k < ntr && p + 8 <= b.length; k++) {
    const id = b.toString("ascii", p, p + 4), len = b.readUInt32BE(p + 4);
    const end = p + 8 + len;
    if (id !== "MTrk") { p = end; k--; continue; }
    const o = { i: p + 8 }, tr = { name: "", notes: [], events: [] }, open = new Map();
    let t = 0, status = 0;
    while (o.i < end) {
      t += readVar(b, o);
      let s = b[o.i];
      if (s & 0x80) { o.i++; if (s < 0xf0) status = s; } else s = status;  // running status
      if (s === 0xff) {
        const type = b[o.i++], n = readVar(b, o), data = [...b.subarray(o.i, o.i + n)];
        o.i += n;
        if (type === 0x2f) break;  // end of track: written again by write()
        if (type === 0x03 && !tr.name) tr.name = Buffer.from(data).toString("latin1");
        tr.events.push({ t, d: [0xff, type, ...varBytes(n), ...data] });
      } else if (s === 0xf0 || s === 0xf7) {
        const n = readVar(b, o), data = [...b.subarray(o.i, o.i + n)];
        o.i += n;
        tr.events.push({ t, d: [s, ...varBytes(n), ...data] });
      } else {
        const hi = s & 0xf0, ch = s & 0x0f, d1 = b[o.i++], d2 = hi === 0xc0 || hi === 0xd0 ? null : b[o.i++];
        const key = ch * 128 + d1;
        if (hi === 0x90 && d2 > 0) {
          if (open.has(key)) { const x = open.get(key); x.l = t - x.t; }  // re-triggered without an off
          const x = { t, l: 0, n: d1, v: d2, c: ch };
          tr.notes.push(x); open.set(key, x);
        } else if (hi === 0x80 || hi === 0x90) {
          const x = open.get(key);
          if (x) { x.l = t - x.t; open.delete(key); }
        } else tr.events.push({ t, d: d2 == null ? [s, d1] : [s, d1, d2] });
      }
    }
    tracks.push(tr);
    p = end;
  }
  return { format, tpb, tracks };
}

function write(m) {
  const chunks = [];
  const head = Buffer.alloc(14);
  head.write("MThd", 0); head.writeUInt32BE(6, 4); head.writeUInt16BE(1, 8);
  head.writeUInt16BE(m.tracks.length, 10); head.writeUInt16BE(m.tpb, 12);
  chunks.push(head);
  for (const tr of m.tracks) {
    // order at equal ticks: note offs (0), raw events (1), note ons (2)
    const ev = [];
    tr.events.forEach((e, i) => ev.push({ t: e.t, o: 1, i, d: e.d }));
    tr.notes.forEach((x, i) => {
      const c = (x.c || 0) & 15, l = Math.max(1, Math.round(x.l));
      ev.push({ t: x.t, o: 2, i, d: [0x90 | c, x.n, x.v || 100] });
      ev.push({ t: x.t + l, o: 0, i, d: [0x80 | c, x.n, 0] });
    });
    ev.sort((a, b) => a.t - b.t || a.o - b.o || a.i - b.i);
    const bytes = [];
    let last = 0;
    for (const e of ev) { bytes.push(...varBytes(Math.max(0, e.t - last)), ...e.d); last = Math.max(last, e.t); }
    bytes.push(0, 0xff, 0x2f, 0);
    const h = Buffer.alloc(8);
    h.write("MTrk", 0); h.writeUInt32BE(bytes.length, 4);
    chunks.push(h, Buffer.from(bytes));
  }
  return Buffer.concat(chunks);
}

module.exports = { parse, write };
