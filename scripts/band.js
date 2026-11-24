#!/usr/bin/env node
// Band animations for a custom chart, made from the song's own notes like the official charts (FINDINGS §37-39).
//
//   node band.js <in BEATMATCH> <out BEATMATCH> [--prop tambourine|cowbell|clap|none] [--spec band.json]
//                [--no-lists] [--no-singer] [--dry]
//
// 1. Guitarist and bassist (§37-38): the four animation lists (guitarist_fret, guitarist_strum, bassist_fret,
//    bassist_strum) are rebuilt from the Expert guitar and bass notes. A custom otherwise keeps its donor's lists, so
//    the hands move to another song's notes (slow and out of time).
// 2. Singer (§39, script command #20): every donor singer call is removed and new ones are placed from the Expert
//    vocals: "rest" (mic down) 0.4 s after a phrase that is followed by 4 s or more without singing, "perform" (mic to
//    the mouth, or play the prop held) 0.45 s before the next phrase, the end pose at the end. A custom otherwise keeps
//    its donor's calls, so the singer can sing with the mic in the lap.
// 3. Prop (§39): in every solo where the singer is silent and every vocal rest of 8 bars or more with music, the singer
//    picks up a prop and plays it: tambourine (hit on every beat, shake on every off-beat), cowbell or hand clapping
//    (a hit on every beat). --prop none = the singer just rests there.
// All 4 difficulty sections get the same lists and calls (official charts do the same).
//
// --spec band.json (game seconds, i.e. after the lead-in; Pocket Encore's Effects & Band Anims tab, via mksong):
//   { "prop": "tambourine",
//     "sections": [ { "from": 12.5, "to": 30, "prop": "cowbell" } ],      prop sections set by hand (replace the automatic ones)
//     "mic": [ { "at": 20.1, "state": "perform" }, { "at": 41, "state": "rest" } ],   mic changes set by hand (replace the automatic ones)
//     "overrides": [ { "hand": "guitarist_strum", "at": 33.25, "clip": "strum_long_02" } ] }   the clip for the note at that time
"use strict";
const fs = require("fs");
const { sections, Image, chartFromImage, BASE } = require("./beatmatch.js");
const { load, insertEvents } = require("./fxchart.js");

const FILL = 0x7f800001, REC = 24, SINGER = 20;

// ---------- 1. guitarist / bassist lists (§38) ----------
// A note counts as held for the clip choice when it has a sustain or is >= 140 ticks long.
const isHeld = n => n.held || n.len >= 140;
const popcount = m => { let c = 0; while (m) { c += m & 1; m >>= 1; } return c; };
const r4 = x => Math.round(x * 10000) / 10000;
function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
// the clips a note can get on each hand (idle clips - finger_open, strum_open, bass_pluck_open - are placed by the rules)
const FRET_CLIPS = ["finger_hold_index", "finger_hold_middle", "finger_hold_index_hi", "finger_hold_middle_hi", "finger_vibrato_index",
  "finger_vibrato_middle", "finger_powerchord_1", "finger_powerchord_2"];
const CLIPS = {
  guitarist_fret: FRET_CLIPS, bassist_fret: FRET_CLIPS,
  guitarist_strum: ["strum_pick_01", "strum_pick_02", "strum_short_01", "strum_short_02", "strum_short_03", "strum_short_04",
    "strum_long_01", "strum_long_02", "strum_long_03", "strum_long_04"],
  bassist_strum: ["kBassPluck"],
};

// Fret hand: one clip per note, ending on it; finger_open in rests of >= 1 beat. Times in beat-grid units (§37).
function fret(notes) {
  const out = [];
  notes.forEach((n, i) => {
    const prev = notes[i - 1];
    const lead = prev ? Math.min(0.24, Math.max(0.12, n.p - prev.pe)) : 0.24;
    let sym;
    if (popcount(n.mask) > 1) sym = n.mask === 12 ? "finger_powerchord_2" : "finger_powerchord_1";
    else if (isHeld(n)) sym = n.mask & 5 ? "finger_vibrato_index" : "finger_vibrato_middle";
    else sym = { 1: "finger_hold_index", 2: "finger_hold_middle", 4: "finger_hold_index_hi", 8: "finger_hold_middle_hi" }[n.mask];
    out.push({ a: r4(n.p - lead), e: r4(n.p), sym, v: n.mask, ni: i });
    const next = notes[i + 1];
    if (!next || next.p - n.pe >= 0.98) out.push({ a: r4(n.pe), e: r4(n.pe + 0.24), sym: "finger_open", v: 0 });
  });
  return out;
}

// Strumming hand. Guitar: strum_pick_01/02 (single), strum_short_01..04 (held single or chord), strum_long_01..04
// (held chord); strum_open 1.26-1.5 beats after a note followed by >= 5.5 beats without notes (and after the last).
// Bass: kBassPluck for every note; bass_pluck_open 0.16-0.4 beats after a note followed by >= 4.33 beats.
function strum(notes, bass, seed) {
  const rand = rng(seed), out = [];
  let prevEnd = null, prevOpen = true;
  notes.forEach((n, i) => {
    const max = bass && prevOpen ? 0.4 : 0.24;
    const lead = prevEnd === null ? max : Math.min(max, n.p - prevEnd);
    let sym;
    if (bass) sym = "kBassPluck";
    else if (popcount(n.mask) > 1) sym = (isHeld(n) ? "strum_long_0" : "strum_short_0") + (1 + Math.floor(rand() * 4));
    else sym = isHeld(n) ? "strum_short_0" + (1 + Math.floor(rand() * 4)) : "strum_pick_0" + (1 + Math.floor(rand() * 2));
    out.push({ a: r4(n.p - lead), e: r4(n.p), sym, v: n.mask, ni: i });
    prevEnd = n.p; prevOpen = false;
    const next = notes[i + 1];
    const [gap, from, to, name] = bass ? [4.33, 0.16, 0.4, "bass_pluck_open"] : [5.5, 1.26, 1.5, "strum_open"];
    if (!next || next.p - n.p >= gap) { out.push({ a: r4(n.p + from), e: r4(n.p + to), sym: name, v: 0 }); prevEnd = n.p + to; prevOpen = true; }
  });
  return out;
}

// beat-grid position <-> chart tick, for a section
function grid(img) {
  const c = chartFromImage(img), bt = [...Array(c.beats.n)].map((_, i) => c.beats.b.readUInt32LE(i * 8));
  const pos = x => {
    let lo = 0, hi = bt.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (bt[m] <= x) lo = m; else hi = m - 1; }
    const step = lo + 1 < bt.length ? bt[lo + 1] - bt[lo] : bt[lo] - bt[lo - 1];
    return lo + (x - bt[lo]) / step;
  };
  const tickOf = p => { const i = Math.max(0, Math.min(bt.length - 2, Math.floor(p))); return bt[i] + (p - i) * (bt[i + 1] - bt[i]); };
  return { pos, tickOf };
}

// Expert notes of a part (gems t: 1 bass, 2 guitar) as beat-grid positions, with their time in ms
function partNotes(img, t) {
  const c = chartFromImage(img), { pos } = grid(img), { toMs } = timeline(img);
  const g = c.gems[t], out = [];
  for (let i = 0; i < g.n; i++) {
    const o = i * 20, tick = g.b.readUInt32LE(o + 4), len = g.b.readUInt16LE(o + 12), msDur = g.b.readUInt16LE(o + 8), f8 = g.b[o + 15];
    out.push({ p: pos(tick), pe: pos(tick + len), mask: g.b[o + 14], held: msDur > 0 && !(f8 & 2), len, ms: toMs(tick) });
  }
  return out;
}

// the four lists, with clips set by hand: overrides [{ hand, at (ms), clip }] -> the note within 20 ms of `at`
function makeLists(notes, seed, overrides = []) {
  const lists = {
    guitarist_fret: fret(notes.guitar), guitarist_strum: strum(notes.guitar, false, seed),
    bassist_fret: fret(notes.bass), bassist_strum: strum(notes.bass, true, seed + 100),
  };
  let applied = 0;
  for (const o of overrides) {
    const list = lists[o.hand], ns = o.hand.startsWith("guitarist") ? notes.guitar : notes.bass;
    if (!list || !CLIPS[o.hand].includes(o.clip)) continue;
    let ni = -1, best = 20;
    ns.forEach((n, i) => { const d = Math.abs(n.ms - o.at); if (d <= best) { best = d; ni = i; } });
    const ev = ni >= 0 && list.find(e => e.ni === ni);
    if (ev) { ev.sym = o.clip; ev.set = true; applied++; }
  }
  return { lists, applied };
}

// clip name -> address of that string in the chart's own symbol table (it becomes the game's at load, §36)
function symbolPointers(img) {
  const b = img.b, W = o => b.readUInt32LE(o), h = W(0x2ec) - BASE, e = W(h) - BASE, n = W(h + 4) + 1, map = new Map();
  for (let i = 0; i < n; i++) {
    const a = W(e + 4 * i);
    if (a >= BASE && a < BASE + b.length) { const o = a - BASE; let z = o; while (b[z]) z++; map.set(b.toString("latin1", o, z), a); }
  }
  return map;
}

// animation parser objects by name (root+0x290 -> parser list, §37)
function parserObjects(img) {
  const b = img.b, W = o => b.readUInt32LE(o), isPtr = v => v >= BASE && v < BASE + b.length;
  const str = a => { const o = a - BASE; let e = o; while (b[e]) e++; return b.toString("latin1", o, e); };
  const mp = W(0x290) - BASE, list = W(mp + 0x14) - BASE, cnt = W(mp + 0x1c), out = {};
  for (let i = 0; i < cnt; i++) {
    const o = W(list + 4 * i) - BASE;
    for (let k = 4; k < 0x40; k += 4) if (isPtr(W(o + k)) && /^[a-z_]+$/.test(str(W(o + k)))) { out[str(W(o + k))] = o; break; }
  }
  return out;
}

function alloc(img, bytes) {
  for (const run of img.freeRuns()) { const start = (run.o + 15) & ~15; if (start + bytes <= run.o + run.n) return start; }
  throw new Error(`difficulty ${img.d}: no free space for ${bytes} bytes`);
}

function writeLists(img, lists) {
  const b = img.b, W = o => b.readUInt32LE(o);
  const P = parserObjects(img), syms = symbolPointers(img);
  // free the donor's lists (only their parser's +0xc0 holder points at them); keep each sentinel record
  const sentinel = {};
  for (const name of Object.keys(lists)) {
    const o = P[name]; if (o === undefined) throw new Error(`difficulty ${img.d}: no ${name} parser in the donor chart`);
    const ptr = W(o + 0xc0) - BASE, n = W(o + 0xc8);
    sentinel[name] = Buffer.from(b.subarray(ptr, ptr + REC));
    for (let k = 0; k < n * REC; k += 4) b.writeUInt32LE(FILL, ptr + k);
  }
  const counts = {};
  for (const [name, evs] of Object.entries(lists)) {
    const o = P[name], n = evs.length + 1, at = alloc(img, n * REC);
    sentinel[name].copy(b, at);
    evs.forEach((ev, k) => {
      const r = at + (k + 1) * REC, s = syms.get(ev.sym);
      if (!s) throw new Error(`clip ${ev.sym} is not in the donor chart's symbol table`);
      b.writeFloatLE(ev.a, r); b.writeFloatLE(ev.e, r + 4); b.writeUInt32LE(s, r + 8); b.writeUInt32LE(5, r + 12);
      b.writeUInt32LE(ev.v, r + 16); b.writeUInt32LE(0, r + 20);
    });
    b.writeUInt32LE(BASE + at, o + 0xc0); b.writeUInt32LE(n, o + 0xc4); b.writeUInt32LE(n, o + 0xc8); b.writeUInt32LE(0, o + 0xcc);
    counts[name] = evs.length;
  }
  return counts;
}

// ---------- 2-3. singer (§39) ----------
const CALL = { rest: 0x0014258a, perform: 0x82b94e25, end: 0xbaecac3e, hit: 0xed74731c, shake: 0x7be36136 };
const PROPS = {
  tambourine: { up: 0xee71e39b, down: 0x55b55ee7, shakes: true },
  cowbell: { up: 0x593661d2, down: 0x84fa43f9, shakes: false },
  clap: { up: 0x037973b7, down: 0x9621fc9d, shakes: false },
  none: null,
};
const REST_GAP = 4000;   // ms without singing that gets rest + perform (official: 89 % of gaps >= 4 s, rarely < 3 s)

function timeline(img) {
  const c = chartFromImage(img);
  const T = [...Array(c.tempo.n)].map((_, k) => ({ ms: c.tempo.b.readFloatLE(k * 12), tick: c.tempo.b.readUInt32LE(k * 12 + 4), us: c.tempo.b.readUInt32LE(k * 12 + 8) }));
  const toMs = t => { let k = 0; while (k + 1 < T.length && T[k + 1].tick <= t) k++; return T[k].ms + (t - T[k].tick) * T[k].us / 480 / 1000; };
  const toTick = ms => { let k = 0; while (k + 1 < T.length && T[k + 1].ms <= ms) k++; return T[k].tick + (ms - T[k].ms) * 1000 / T[k].us * 480; };
  const beats = [...Array(c.beats.n)].map((_, i) => ({ tick: c.beats.b.readUInt32LE(i * 8), level: c.beats.b.readUInt32LE(i * 8 + 4) }));
  return { c, toMs, toTick, beats };
}

// The singer's calls, from the Expert section: { calls: [{ tick, arg, kind }] in order, sections, mic, phrases }.
// opts.sections [{ from, to, prop }] / opts.mic [{ at, state }] (ms) replace the automatic sections / mic changes.
// Ticks are the same in every section.
function singerPlan(img, propName, opts = {}) {
  const { c, toMs, toTick, beats } = timeline(img), L = load(img);
  const notes = t => { const g = c.gems[t], o = []; for (let i = 0; i < g.n; i++) o.push([g.b.readFloatLE(i * 20), g.b.readFloatLE(i * 20) + g.b.readUInt16LE(i * 20 + 8)]); return o; };
  const voc = notes(3), band = [0, 1, 2].flatMap(notes).sort((a, b) => a[0] - b[0]);
  const ticks = L.events.map(e => e.tick), firstEvent = Math.min(...ticks), lastEvent = Math.max(...ticks);
  const stopMs = toMs(lastEvent), startMs = Math.max(0, toMs(firstEvent));
  const calls = [], at = (ms, arg, kind) => calls.push({ ms, arg, kind });
  // vocal phrases: gems closer than REST_GAP belong together
  const ph = [];
  for (const [a, e] of voc) { if (ph.length && a - ph[ph.length - 1][1] < REST_GAP) ph[ph.length - 1][1] = Math.max(ph[ph.length - 1][1], e); else ph.push([a, e]); }
  const mic = [];
  if (opts.mic) for (const m of opts.mic) mic.push({ ms: m.at, state: m.state === "rest" ? "rest" : "perform" });
  else {
    mic.push({ ms: startMs, state: "rest" });
    if (ph.length) mic.push({ ms: Math.max(startMs + 100, ph[0][0] - 450), state: "perform" });
    for (let i = 0; i + 1 < ph.length; i++) { mic.push({ ms: ph[i][1] + 400, state: "rest" }); mic.push({ ms: ph[i + 1][0] - 450, state: "perform" }); }
    if (ph.length && stopMs - ph[ph.length - 1][1] >= REST_GAP) mic.push({ ms: ph[ph.length - 1][1] + 400, state: "rest" });
  }
  for (const m of mic) at(m.ms, CALL[m.state], "mic");

  // prop sections: solos where the singer is silent + vocal rests of 8 bars or more that have music (or set by hand)
  if (PROPS[propName] === undefined) throw new Error(`unknown prop "${propName}" (known: ${Object.keys(PROPS).join(", ")})`);
  const wanted = [];
  if (opts.sections) {
    for (const s of opts.sections) {
      if (PROPS[s.prop] === undefined) throw new Error(`unknown prop "${s.prop}"`);
      const a = Math.max(s.from, startMs + 100), e = Math.min(s.to, stopMs - 500);
      if (PROPS[s.prop] && e - a >= 2000) wanted.push({ a, e, prop: s.prop, why: "set by hand" });
    }
  } else if (PROPS[propName] && band.length) {
    const musicA = band[0][0], musicE = Math.max(...band.map(n => n[1]));
    const solos = [];
    for (let t = 0; t < 3; t++) for (let k = 0; k < c.solos[t].n; k++) solos.push([c.solos[t].b.readFloatLE(k * 20), c.solos[t].b.readFloatLE(k * 20) + c.solos[t].b.readFloatLE(k * 20 + 4)]);
    const bars = beats.filter(b => b.level === 1).map(b => toMs(b.tick));
    const barMs = ms => { let k = 0; while (k + 2 < bars.length && bars[k + 1] <= ms) k++; return bars.length > 1 ? bars[k + 1] - bars[k] : 2000; };
    const rests = []; let prev = -Infinity;
    for (const [a, e] of voc) { if (a - prev > 0) rests.push([prev, a]); prev = Math.max(prev, e); }
    rests.push([prev, Infinity]);
    for (const [r0, r1] of rests) {
      const a = Math.max(r0 + 500, musicA - 1000, startMs + 100), e = Math.min(r1 - 1500, musicE, stopMs - 1000);
      if (e - a < 4000) continue;
      const solo = solos.some(([s0, s1]) => s1 > a && s0 < e);
      const long = Math.min(r1, musicE) - Math.max(r0, musicA) >= 8 * barMs(a);
      if (solo || long) wanted.push({ a, e, prop: propName, why: solo ? "solo" : "8+ bars without vocals" });
    }
  }
  const sections = [];
  for (const w of wanted) {
    const prop = PROPS[w.prop];
    // hits from the first beat >= 1 s after the pick-up to the last one 170 ms before the end, starting on a beat
    const firstTick = toTick(w.a + 1000), lastTick = toTick(w.e - 170), hits = [];
    for (let i = 0; i + 1 < beats.length; i++) {
      const t = beats[i].tick, mid = (beats[i].tick + beats[i + 1].tick) / 2;
      if (t >= firstTick && t <= lastTick) hits.push([t, CALL.hit]);
      if (prop.shakes && !opts.noShakes && mid >= firstTick && mid <= lastTick) hits.push([mid, CALL.shake]);
    }
    hits.sort((x, y) => x[0] - y[0]);
    while (hits.length && hits[0][1] !== CALL.hit) hits.shift();
    if (!hits.length) continue;
    const first = toMs(hits[0][0]), last = toMs(hits[hits.length - 1][0]);
    sections.push({ a: w.a, e: last + 170, prop: w.prop, why: w.why, hits: hits.length });
    at(w.a, prop.up, "prop"); at(first - 170, CALL.perform, "prop");
    for (const [t, arg] of hits) calls.push({ tick: t, arg, kind: "prop" });
    at(last + 170, prop.down, "prop"); at(last + 170, CALL.rest, "prop");   // put down, then rest (official order)
  }
  const endMs = Math.max(ph.length ? ph[ph.length - 1][1] + 1000 : 0, img.b.readFloatLE(0x124) - 500);
  at(endMs, CALL.end, "end");
  // ticks; nothing may go past the music stop (= the last event's tick, §12): the end pose sits just before it
  const out = calls.map((k, i) => ({ tick: k.tick ?? toTick(k.ms), arg: k.arg, kind: k.kind, i }));
  for (const k of out) { if (k.tick >= lastEvent) k.tick = lastEvent - 1; if (k.tick < 0) k.tick = 0; }
  out.sort((x, y) => x.tick - y.tick || x.i - y.i);
  return { calls: out, sections, mic, phrases: ph, stopMs, startMs, toMs };
}

const encode = words => [((words.length + 2) << 20 | 1 << 16 | 0x0101) >>> 0, ...words, 0xff];
const isSinger = k => k.op === 0x16 && k.cmd === SINGER;

function eventRoom(img) {
  const L = load(img), slots = img.u32(BASE + 0x2b4);
  return slots - L.events.length;
}

function writeSinger(img, plan) {
  const L = load(img);
  // remove every donor singer call (in place; scripts only get shorter), then one new event per planned call
  let removed = 0;
  for (const sc of L.scripts) {
    const kept = sc.calls.filter(k => !isSinger(k));
    if (kept.length === sc.calls.length) continue;
    removed += sc.calls.length - kept.length;
    encode(kept.flatMap(k => k.words)).forEach((w, k) => img.set(sc.addr + 4 * k, w));
  }
  const r = insertEvents(img, plan.calls.map(k => ({ tick: k.tick, words: [(SINGER << 16 | 0x0216) >>> 0, k.arg >>> 0] })));
  return { removed, ...r };
}

// spec times (s) -> ms
const specMs = spec => ({
  sections: Array.isArray(spec.sections) ? spec.sections.map(s => ({ ...s, from: s.from * 1000, to: s.to * 1000 })) : null,
  mic: Array.isArray(spec.mic) ? spec.mic.map(m => ({ ...m, at: m.at * 1000 })) : null,
  overrides: Array.isArray(spec.overrides) ? spec.overrides.map(o => ({ ...o, at: o.at * 1000 })) : [],
});

// ---------- whole chart ----------
function patch(bm, spec = {}) {
  const { prop = "tambourine", lists = true, singer = true, dry = false } = spec, M = specMs(spec);
  const S = sections(bm), img = d => new Image(bm.subarray(S[d].start, S[d].start + S[d].size), d);  // writes go into bm
  const ex = img(3), report = [];
  const notes = { guitar: partNotes(ex, 2), bass: partNotes(ex, 1) };
  let plan = null;
  if (singer) {
    // the event list has a fixed number of slots: with too few, drop the tambourine shakes, then the props
    const room = Math.min(...S.map((_, d) => eventRoom(img(d)))), o = { sections: M.sections, mic: M.mic };
    plan = singerPlan(ex, prop, o);
    if (plan.calls.length > room) { plan = singerPlan(ex, prop, { ...o, noShakes: true }); report.push(`  only ${room} free event slots: tambourine without the off-beat shakes`); }
    if (plan.calls.length > room) { plan = singerPlan(ex, "none", { mic: M.mic, sections: [] }); report.push(`  only ${room} free event slots: no props`); }
    if (plan.calls.length > room) throw new Error(`the donor chart has only ${room} free event slots; the singer needs ${plan.calls.length}`);
    report.push(`  singer: ${plan.phrases.length} vocal phrase(s), mic ${M.mic ? "set by hand" : "from the vocals"} (${plan.mic.length} changes), ${plan.calls.length} calls; ` +
      (M.sections ? `props set by hand (${plan.sections.length})` : `prop: ${prop}` + (plan.sections.length ? "" : PROPS[prop] ? " (no solo or 8-bar instrumental part without vocals)" : "")));
    for (const s of plan.sections) report.push(`    ${s.prop} ${(s.a / 1000).toFixed(1)}-${(s.e / 1000).toFixed(1)} s (${s.why}), ${s.hits} hits`);
  }
  if (dry) return report;
  S.forEach((_, d) => {
    const im = img(d);
    if (lists) {
      const { lists: L, applied } = makeLists(notes, d + 1, M.overrides);
      const n = writeLists(im, L);
      if (d === 3) report.unshift(`  guitarist ${n.guitarist_fret}/${n.guitarist_strum}, bassist ${n.bassist_fret}/${n.bassist_strum} animation events (fret/strum)` +
        ` from ${notes.guitar.length} guitar and ${notes.bass.length} bass notes` + (M.overrides.length ? `; ${applied} of ${M.overrides.length} clips set by hand` : ""));
    }
    if (singer) {
      const r = writeSinger(im, plan);
      if (d === 3) report.push(`  donor singer calls removed: ${r.removed}; events ${r.events[0]} -> ${r.events[1]} of ${r.events[2]}; scripts ${r.scripts[0]} -> ${r.scripts[1]}`);
    }
  });
  return report;
}

// What the build would make, for Pocket Encore's Effects & Band Anims tab (times in game seconds).
function analyze(bm, spec = {}) {
  const S = sections(bm), ex = new Image(Buffer.from(bm.subarray(S[3].start, S[3].start + S[3].size)), 3), M = specMs(spec);
  const prop = spec.prop || "tambourine", { toMs } = timeline(ex), { tickOf } = grid(ex);
  const auto = singerPlan(ex, prop), mine = singerPlan(ex, prop, { sections: M.sections, mic: M.mic });
  const notes = { guitar: partNotes(ex, 2), bass: partNotes(ex, 1) }, { lists } = makeLists(notes, 4, M.overrides);
  const sec = ms => +(ms / 1000).toFixed(3), sp = p => sec(toMs(tickOf(p)));
  const hands = {};
  for (const [name, evs] of Object.entries(lists)) {
    const ns = name.startsWith("guitarist") ? notes.guitar : notes.bass;
    hands[name] = evs.map(e => ({ a: sp(e.a), e: sp(e.e), sym: e.sym, ...(e.ni != null ? { at: sec(ns[e.ni].ms) } : {}), ...(e.set ? { set: true } : {}) }));
  }
  const secs = p => p.sections.map(s => ({ from: sec(s.a), to: sec(s.e), prop: s.prop, why: s.why, hits: s.hits }));
  return {
    stop: sec(auto.stopMs), phrases: auto.phrases.map(([a, e]) => ({ from: sec(a), to: sec(e) })),
    auto: { sections: secs(auto), mic: auto.mic.map(m => ({ at: sec(m.ms), state: m.state })) },
    sections: secs(mine), mic: mine.mic.map(m => ({ at: sec(m.ms), state: m.state })),
    hands, clips: CLIPS, props: Object.keys(PROPS),
  };
}

if (require.main === module) {
  const a = process.argv.slice(2), files = a.filter((x, i) => !x.startsWith("--") && a[i - 1] !== "--prop" && a[i - 1] !== "--spec");
  const opt = k => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; }, dry = a.includes("--dry");
  if (files.length < (dry ? 1 : 2)) { console.log("usage: band.js <in BEATMATCH> <out BEATMATCH> [--prop tambourine|cowbell|clap|none] [--spec band.json] [--no-lists] [--no-singer] [--dry]"); process.exit(1); }
  const spec = opt("--spec") ? JSON.parse(fs.readFileSync(opt("--spec"), "utf8")) : {};
  if (opt("--prop")) spec.prop = opt("--prop");
  const bm = Buffer.from(fs.readFileSync(files[0]));
  const report = patch(bm, { ...spec, lists: !a.includes("--no-lists"), singer: !a.includes("--no-singer"), dry });
  console.log("band animations:\n" + report.join("\n"));
  if (!dry) { fs.writeFileSync(files[1], bm); console.log(`  written ${files[1]}`); }
}
module.exports = { patch, analyze, singerPlan, fret, strum, PROPS, CLIPS };
