#!/usr/bin/env node
// Screen effects in a BEATMATCH chart (see FINDINGS §26).
//
//   node fxchart.js list  <BEATMATCH>                       effects the chart already switches, with times
//   node fxchart.js apply <in BEATMATCH> <out BEATMATCH> <effects.json> [--keep] [--strip 22,28]
//   node fxchart.js calls <BEATMATCH> <cmd>                  every use of a script command, with times and arguments
//
// effects.json: [{ "effect": "oldfilm", "from": 83.0, "to": 97.5 }, ...]   (seconds; "to" optional = no end)
// Without --keep the chart's own effects are removed first. Raw script calls: { "cmd": 22, "arg": "dc0222d9", "at": 12.5 }
// (arg = hex argument word, omit for no-argument commands); --strip removes every call of those commands first.
//
// How it works: root+4 -> {count, ptr} table of compiled scripts; a song event (root+0x2b0, 0x50-byte records) runs
// script (id & 0x3ffff) at its tick. Script = words: header (opcode 1, operand = length<<4 | 1), calls (opcode 0x16,
// byte 1 = length in words, bits 16-27 = command number, then length-1 argument words), 0xff = end. The preset
// effect commands take no arguments. Each effect start and end is a new event at exactly its time (insertEvents;
// the event list has spare slots, FINDINGS §39); the new scripts and a grown copy of the script table go into free
// space. Times at or after the music stop are skipped. All 4 difficulty sections get the same changes.
"use strict";
const fs = require("fs");
const { sections, Image, chartFromImage } = require("./beatmatch.js");

const BASE = 0x096e9a80, FILL = 0x7f800001, EVENTS = 0x2b0;
// Preset effect commands (index in the game's command table = registration order in FUN_088bb664).
const EFFECTS = {
  end: 37,          // stops every effect (starts a soft blur that fades); used after every effect in official charts
  vortex: 38,       // effect 0xd
  nightvision: 39,  // night vision + video lines
  oldfilm: 40,      // black and white + lines + grain + dust + scratches (Aqualung solo)
  colorfilm: 41,    // lines + grain + dust + scratches, keeps colour (Aqualung intro)
  tintlines: 42,    // tint + video lines
  blur2: 43,        // blur (preset 2)
  blur3: 44,        // blur (preset 3)
  bwflash: 45,      // black and white + grain + flash (Chop Suey!, Show Me the Way)
  negative: 46,     // photonegative (Show Me the Way solo)
  bw: 47,           // black and white only (Move Along, Livin' on a Prayer)
  sepia: 48,        // sepia (The Trees)
  film: 49,         // grain + dust + scratches, keeps colour
  blurbwflash: 50,  // blur + black and white + grain + flash (TODAY intro, Chop Suey! intro)
  blurtint: 51,     // blur + tint
  kaleidoscope: 52, // mirrors the picture into a kaleidoscope (seen in game 2026-11-24; was called "blur" before)
};
// old names still accepted in song.json / effects.json
const ALIASES = { blur: "kaleidoscope" };
const effectName = n => ALIASES[n] || n;
const NAME = Object.fromEntries(Object.entries(EFFECTS).map(([k, v]) => [v, k]));
const isFx = c => c >= 37 && c <= 52;

function parseScript(img, addr) {
  const calls = []; let o = addr + 4;
  for (let g = 0; g < 4096; g++) {
    const w = img.u32(o);
    if (w === 0xff) return { calls, words: (o - addr) / 4 + 1 };
    const len = Math.max((w >>> 8) & 0xff, 1);
    const words = []; for (let k = 0; k < len; k++) words.push(img.u32(o + 4 * k));
    calls.push({ op: w & 0xff, cmd: (w >>> 16) & 0xfff, words });
    o += 4 * len;
  }
  throw new Error(`script at ${addr.toString(16)} has no end`);
}
const encode = calls => {
  const body = calls.flatMap(c => c.words);
  return [((body.length + 2) << 20 | 1 << 16 | 0x0101) >>> 0, ...body, 0xff];
};

function tempoMs(img) {
  const T = chartFromImage(img).tempo;
  const row = k => ({ ms: T.b.readFloatLE(k * 12), tick: T.b.readUInt32LE(k * 12 + 4), us: T.b.readUInt32LE(k * 12 + 8) });
  return {
    toMs: t => { let k = 0; while (k + 1 < T.n && row(k + 1).tick <= t) k++; const r = row(k); return r.ms + (t - r.tick) * r.us / 480 / 1000; },
    toTick: ms => { let k = 0; while (k + 1 < T.n && row(k + 1).ms <= ms) k++; const r = row(k); return r.tick + (ms - r.ms) * 1000 / r.us * 480; },
  };
}

function load(img) {
  const tab = img.u32(BASE + 4), n = img.u32(tab), p = img.u32(tab + 4);
  const scripts = []; for (let i = 0; i < n; i++) { const a = img.u32(p + 4 * i); scripts.push({ addr: a, ...parseScript(img, a) }); }
  const ep = img.u32(BASE + EVENTS), en = img.u32(BASE + EVENTS + 4), events = [];
  for (let i = 0; i < en; i++) { const r = ep + i * 0x50; if (img.u32(r) === 1) events.push({ i, rec: r, id: img.u32(r + 4), tick: img.b.readFloatLE(img.off(r + 0x10)) }); }
  return { tab, n, p, scripts, events };
}

function list(path) {
  const bm = fs.readFileSync(path), s = sections(bm)[3];
  const img = new Image(Buffer.from(bm.subarray(s.start, s.start + s.size)), 3);
  const { scripts, events } = load(img), { toMs } = tempoMs(img);
  const fmt = ms => `${Math.floor(ms / 60000)}:${(ms / 1000 % 60).toFixed(1).padStart(4, "0")}`;
  console.log(`${scripts.length} scripts, ${events.length} events`);
  for (const e of events) {
    const fx = scripts[e.id & 0x3ffff].calls.filter(c => c.op === 0x16 && isFx(c.cmd));
    if (fx.length) console.log(`  ${fmt(toMs(e.tick))}  event ${e.i}: ${fx.map(c => `${NAME[c.cmd]} (#${c.cmd})`).join(", ")}`);
  }
}

function calls(path, cmd) {
  const bm = fs.readFileSync(path), s = sections(bm)[3];
  const img = new Image(Buffer.from(bm.subarray(s.start, s.start + s.size)), 3);
  const { scripts, events } = load(img), { toMs } = tempoMs(img);
  for (const e of events) for (const c of scripts[e.id & 0x3ffff].calls)
    if (c.op === 0x16 && c.cmd === cmd) console.log(`  ${(toMs(e.tick) / 1000).toFixed(2).padStart(7)} s  event ${e.i}${c.words[1] != null ? "  arg " + c.words[1].toString(16).padStart(8, "0") : ""}`);
}

// Adds song events at exact ticks: items = [{ tick, words }], words = the call words of the script the event runs.
// The used event records stay first and sorted by tick (FINDINGS §39; new ones after the chart's own at the same tick,
// in the given order); identical scripts are shared; a grown copy of the script table and the new scripts go into free
// space (only root+4's holder points at the table). Ticks at or after the music stop (the last event) are refused.
function insertEvents(img, items) {
  const L = load(img), b = img.b, ep = img.u32(BASE + EVENTS), slots = img.u32(BASE + EVENTS + 4);
  if (!items.length) return { events: [L.events.length, L.events.length, slots], scripts: [L.n, L.n] };
  const lastEvent = Math.max(...L.events.map(e => e.tick));
  for (const it of items) if (!(it.tick >= 0 && it.tick < lastEvent)) throw new Error(`difficulty ${img.d}: event at tick ${it.tick} is outside the song (music stop ${lastEvent})`);
  const keyOf = new Map(), newScripts = [];
  for (const it of items) { const k = it.words.join(","); if (!keyOf.has(k)) { keyOf.set(k, L.n + newScripts.length); newScripts.push([((it.words.length + 2) << 20 | 1 << 16 | 0x0101) >>> 0, ...it.words, 0xff]); } }
  const recs = L.events.map(e => ({ tick: e.tick, own: 1, buf: Buffer.from(img.bytes(e.rec, 0x50)) }));
  const tmpl = recs[0].buf, idHi = tmpl.readUInt32LE(4) & ~0x3ffff;
  for (const it of items) {
    const r = Buffer.from(tmpl);
    r.writeUInt32LE((idHi | keyOf.get(it.words.join(","))) >>> 0, 4); r.writeFloatLE(it.tick, 0x10); r.writeFloatLE(it.tick, 0x14);
    recs.push({ tick: it.tick, own: 0, buf: r });
  }
  if (recs.length > slots) throw new Error(`difficulty ${img.d}: ${recs.length} events, the chart has ${slots} slots`);
  recs.sort((x, y) => x.tick - y.tick || y.own - x.own);  // stable: new events keep their order
  recs.forEach((r, i) => r.buf.copy(b, img.off(ep + i * 0x50)));
  const total = L.n + newScripts.length, words = newScripts.reduce((n, s) => n + s.length + 1, 0), need = 4 * total + 4 * words + 32;
  const run = img.freeRuns().find(r => ((r.o + 15) & ~15) + need <= r.o + r.n);
  if (!run) throw new Error(`difficulty ${img.d}: no free space for ${need} bytes of scripts`);
  let at = BASE + ((run.o + 15) & ~15);
  const table = at; at += 4 * total + 4;
  for (let i = 0; i < L.n; i++) img.set(table + 4 * i, img.u32(L.p + 4 * i));
  for (let i = 0; i < L.n; i++) img.set(L.p + 4 * i, FILL);
  newScripts.forEach((s, j) => { img.set(table + 4 * (L.n + j), at); s.forEach((w, k) => img.set(at + 4 * k, w)); at += 4 * s.length + 4; });
  img.set(L.tab, total); img.set(L.tab + 4, table);
  return { events: [L.events.length, recs.length, slots], scripts: [L.n, total] };
}

function applySection(img, plan, keep, strip = []) {
  const drop = c => c.op === 0x16 && ((!keep && isFx(c.cmd)) || strip.includes(c.cmd));
  const L = load(img), { toMs, toTick } = tempoMs(img);
  // 1. remove the chart's own effect calls (in place; scripts only get shorter)
  if (!keep || strip.length) for (const sc of L.scripts) {
    const kept = sc.calls.filter(c => !drop(c));
    if (kept.length === sc.calls.length) continue;
    encode(kept).forEach((w, k) => img.set(sc.addr + 4 * k, w));
  }
  // 2. each effect start / end / raw call becomes a new event at exactly its time (calls at the same tick share one;
  //    an end comes before a start, so an effect that ends where the next begins leaves the new one running)
  const lastEvent = Math.max(...L.events.map(e => e.tick)), per = new Map(), placed = [];
  const callWords = (cmd, arg) => arg == null ? [(cmd << 16 | 0x0116) >>> 0] : [(cmd << 16 | 0x0216) >>> 0, parseInt(arg, 16) >>> 0];
  const at = (sec, cmd, label, arg) => {
    const tick = Math.max(0, Math.round(toTick(sec * 1000)));
    if (tick >= lastEvent) { placed.push({ label, want: sec, got: null }); return; }   // after the music stops: nothing to do
    if (!per.has(tick)) per.set(tick, []);
    per.get(tick).push({ cmd, words: callWords(cmd, arg) }); placed.push({ label, want: sec, got: toMs(tick) / 1000 });
  };
  for (const p of plan) {
    if (p.cmd != null) { at(p.at, p.cmd, p.label || `#${p.cmd}${p.arg ? "(" + p.arg + ")" : ""}`, p.arg); continue; }
    const name = effectName(p.effect);
    at(p.from, EFFECTS[name], name); if (p.to != null) at(p.to, EFFECTS.end, `end of ${name}`);
  }
  const items = [...per].sort((a, b) => a[0] - b[0]).map(([tick, cmds]) =>
    ({ tick, words: [...cmds].sort((a, b) => (b.cmd === EFFECTS.end) - (a.cmd === EFFECTS.end)).flatMap(c => c.words) }));
  insertEvents(img, items);
  return placed;
}

function apply(inPath, outPath, specPath, keep, strip) {
  const plan = JSON.parse(fs.readFileSync(specPath, "utf8"));
  for (const p of plan) if (p.cmd == null && !(effectName(p.effect) in EFFECTS)) throw new Error(`unknown effect "${p.effect}" (known: ${Object.keys(EFFECTS).join(", ")})`);
  const bm = Buffer.from(fs.readFileSync(inPath));
  let placed;
  for (const [d, s] of sections(bm).entries()) {
    const img = new Image(bm.subarray(s.start, s.start + s.size), d); // writes go straight into bm
    const p = applySection(img, plan, keep, strip);
    if (d === 3) placed = p;
  }
  fs.writeFileSync(outPath, bm);
  for (const p of placed) console.log(`  ${p.label.padEnd(22)} at ${p.want.toFixed(2).padStart(7)} s` + (p.got == null ? "  skipped: after the music stops" : Math.abs(p.got - p.want) > 0.005 ? ` (${p.got.toFixed(3)} s)` : ""));
  console.log(`written ${outPath}`);
}

if (require.main === module) {
  const [cmd, ...a] = process.argv.slice(2);
  if (cmd === "list" && a[0]) list(a[0]);
  else if (cmd === "calls" && a[1]) calls(a[0], Number(a[1]));
  else if (cmd === "apply" && a[2]) {
    const i = a.indexOf("--strip");
    apply(a[0], a[1], a[2], a.includes("--keep"), i >= 0 ? a[i + 1].split(",").map(Number) : []);
  }
  else { console.log("usage: fxchart.js list <bm> | calls <bm> <cmd> | apply <in bm> <out bm> <effects.json> [--keep] [--strip 22,28]\neffects: " + Object.keys(EFFECTS).join(", ")); process.exit(1); }
}
module.exports = { EFFECTS, effectName, load, tempoMs, parseScript, insertEvents };
