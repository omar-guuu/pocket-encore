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
// effect commands take no arguments. An effect is added by giving the event nearest to the wanted time a new
// script: a copy of its own script (camera/animation messages kept) plus the effect call. The new scripts go into
// free space and the table grows in place. All 4 difficulty sections get the same changes.
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
  blur: 52,         // blur (default preset)
};
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

function applySection(img, plan, keep, strip = []) {
  const drop = c => c.op === 0x16 && ((!keep && isFx(c.cmd)) || strip.includes(c.cmd));
  const L = load(img), { toMs } = tempoMs(img);
  // 1. remove the chart's own effect calls (in place; scripts only get shorter)
  if (!keep) for (const sc of L.scripts) {
    const kept = sc.calls.filter(c => !drop(c));
    if (kept.length === sc.calls.length) continue;
    encode(kept).forEach((w, k) => img.set(sc.addr + 4 * k, w));
  }
  // 2. effect calls per event (nearest event to each wanted time)
  const evMs = L.events.map(e => toMs(e.tick));
  const per = new Map(), placed = [];
  const callWords = (cmd, arg) => arg == null ? [(cmd << 16 | 0x0116) >>> 0] : [(cmd << 16 | 0x0216) >>> 0, parseInt(arg, 16) >>> 0];
  const at = (sec, cmd, label, arg) => {
    let best = 0; for (let k = 1; k < evMs.length; k++) if (Math.abs(evMs[k] - sec * 1000) < Math.abs(evMs[best] - sec * 1000)) best = k;
    if (!per.has(best)) per.set(best, []);
    per.get(best).push({ cmd, words: callWords(cmd, arg) }); placed.push({ label, want: sec, got: evMs[best] / 1000, event: L.events[best].i });
  };
  for (const p of plan) {
    if (p.cmd != null) { at(p.at, p.cmd, p.label || `#${p.cmd}${p.arg ? "(" + p.arg + ")" : ""}`, p.arg); continue; }
    at(p.from, EFFECTS[p.effect], p.effect); if (p.to != null) at(p.to, EFFECTS.end, `end of ${p.effect}`);
  }
  // 3. new scripts in free space, table grows in place
  const newScripts = [];
  for (const [k, cmds] of per) {
    const e = L.events[k], own = parseScript(img, L.scripts[e.id & 0x3ffff].addr);
    const calls = own.calls.filter(c => !drop(c));
    // "end" first, then a new effect, so an end and a start on the same event leave the new effect running
    for (const c of [...cmds].sort((a, b) => (b.cmd === EFFECTS.end) - (a.cmd === EFFECTS.end)))
      calls.push({ op: 0x16, ...c });
    newScripts.push({ e, words: encode(calls) });
  }
  let tableEnd = L.p + 4 * L.n;
  const need = 4 * newScripts.length;
  let room = true;
  for (let x = tableEnd; x < tableEnd + need; x += 4) if (img.u32(x) !== FILL) { room = false; break; }
  const run = img.freeRuns().find(r => BASE + r.o >= tableEnd + need || BASE + r.o + r.n <= tableEnd);
  if (!run) throw new Error("no free space in the chart");
  let a = BASE + run.o + 16; const end = BASE + run.o + run.n - 16;
  if (!room) { // move the pointer array into free space (only the holder at root+4 points to it)
    const p = a;
    if (p + 4 * (L.n + newScripts.length) > end) throw new Error("no free space for the script table");
    for (let i = 0; i < L.n; i++) img.set(p + 4 * i, img.u32(L.p + 4 * i));
    for (let i = 0; i < L.n; i++) img.set(L.p + 4 * i, FILL);
    img.set(L.tab + 4, p);
    tableEnd = p + 4 * L.n;
    a = tableEnd + need + 16;
  }
  newScripts.forEach((ns, j) => {
    if (a + 4 * ns.words.length > end) throw new Error("no free space for the new scripts");
    ns.words.forEach((w, k) => img.set(a + 4 * k, w));
    img.set(tableEnd + 4 * j, a);
    img.set(ns.e.rec + 4, ((ns.e.id & ~0x3ffff) | (L.n + j)) >>> 0);
    a += 4 * ns.words.length + 4;
  });
  img.set(L.tab, L.n + newScripts.length);
  return placed;
}

function apply(inPath, outPath, specPath, keep, strip) {
  const plan = JSON.parse(fs.readFileSync(specPath, "utf8"));
  for (const p of plan) if (p.cmd == null && !(p.effect in EFFECTS)) throw new Error(`unknown effect "${p.effect}" (known: ${Object.keys(EFFECTS).join(", ")})`);
  const bm = Buffer.from(fs.readFileSync(inPath));
  let placed;
  for (const [d, s] of sections(bm).entries()) {
    const img = new Image(bm.subarray(s.start, s.start + s.size), d); // writes go straight into bm
    const p = applySection(img, plan, keep, strip);
    if (d === 3) placed = p;
  }
  fs.writeFileSync(outPath, bm);
  for (const p of placed) console.log(`  ${p.label.padEnd(22)} wanted ${p.want.toFixed(1).padStart(6)} s -> event ${String(p.event).padStart(3)} at ${p.got.toFixed(2)} s`);
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
module.exports = { EFFECTS, load, tempoMs, parseScript };
