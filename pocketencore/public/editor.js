"use strict";
// Chart editor (the Chart tab): gems of the 4 parts on a time line with the stems' waveforms, audio playback, editing,
// overdrive, solos, a highway preview and record mode. Screen effects and band animations are on the Effects & Band
// Anims tab (anims.js); the time line, audio and tempo map are shared with it (timeline.js). Gems live in a Rock Band-format MIDI (the
// REAPER export layout): PART DRUMS / BASS / GUITAR / KEYS (vocals), difficulty bases 60/72/84/96, drums one note
// higher; 116 = overdrive, 103 = solo; notes of 160 ticks or less are taps.
(() => {
const PART_TRACKS = [["drums", ["PART DRUMS"]], ["bass", ["PART BASS"]], ["guitar", ["PART GUITAR"]], ["vocals", ["PART KEYS", "PART VOCALS"]]];
const STEM_OF = { drums: "drums", bass: "bass_guitar", guitar: "lead_guitar", vocals: "vocals" };
const TL = window.PETimeline, { TRACKS } = TL;
const BASE = [60, 72, 84, 96], OD = 116, SOLO = 103, TAP_MAX = 160, TAP_LEN = 60;
const LANE_COL = ["#e65050", "#e8c440", "#4a94ec", "#4cc466"];
const LANE_NAME = ["Red", "Yellow", "Blue", "Green"];
// Gem shapes to drop onto a part: [lane, step] pairs, step = snap steps after the first gem. From the official charts
// (Expert, 57 songs): guitar chords Y+G 3175, Y+B 3076, R+B 2630, R+G 1226, B+G 1195, then Y+B+G 165, R+B+G 96 (every other
// chord <= 20); drums R+G 4510, R+B 4464, Y+G 3028, Y+B 1345, Y+B+G 263, R+B+G 165. Bass has no chords: two gems in a row,
// the most common lane changes Y>B 4604, B>Y 3886, B>R 3721, R>B 3564, Y>G 2399, G>Y 2235. 3-gem chords are Expert only.
// Vocals have none: their gems follow the singer.
const chordShape = (...lanes) => ({ gems: lanes.map(l => [l, 0]), name: lanes.map(l => LANE_NAME[l]).join(" + ") });
const runShape = (a, b) => ({ gems: [[a, 0], [b, 1]], name: `${LANE_NAME[a]} then ${LANE_NAME[b]}` });
const SHAPES = {
  guitar: [chordShape(0, 3), chordShape(1, 2), chordShape(0, 2), chordShape(1, 3), chordShape(2, 3), chordShape(1, 2, 3), chordShape(0, 2, 3)],
  drums: [chordShape(0, 3), chordShape(0, 2), chordShape(1, 3), chordShape(1, 2), chordShape(1, 2, 3), chordShape(0, 2, 3)],
  bass: [runShape(1, 2), runShape(2, 1), runShape(2, 0), runShape(0, 2), runShape(1, 3), runShape(3, 1)],
};
const PART_COL = { drums: "#c86464", bass: "#6488d8", guitar: "#d89a48", vocals: "#58b078" };
const GUT = 78, RULER = 30, HEAD = 14, LANE = 22, PART_H = HEAD + 4 * LANE, PAD = 6;
const H = RULER + 4 * (PART_H + PAD) + 4;
const PARTS_TOP = RULER + 4, PARTS_H = 4 * (PART_H + PAD), STRIP = 18;
// parts shown: all four, the focus part enlarged with the others as thin strips, or the focus part alone
const VIEWS = [["all", "All", "Show all four parts"], ["focus", "Focus", "Enlarge the selected part; the others become thin strips (click one to switch)"], ["only", "Only", "Show only the selected part, at full height"]];
const HW_W = 230, HW_AHEAD = 2.5;  // highway: width, seconds shown above the strike line

let E = null;  // editor state

window.editorDirty = () => !!(E && E.dirty);
window.editorState = () => E;  // for tests and the console
window.editorFns = () => ({ partGeo, xOf, t2s, s2t, draw, undo });  // the same, for layout and timing
window.editorClose = () => { if (!E) return; stop(); clearInterval(E.timer); clearInterval(E.padTimer); window.removeEventListener("keyup", E.onKeyUp); cancelAnimationFrame(E.raf); window.removeEventListener("keydown", E.onKey); window.removeEventListener("resize", E.onResize); window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); window.removeEventListener("mousedown", rulesOutside, true); if (E.ctx && E.ctx.state !== "closed") E.ctx.close().catch(() => { }); E = null; };

let opening = null;  // only the latest openEditor call builds the editor (two quick route changes would make two)
window.openEditor = async (root, folder, details) => {
  window.editorClose();
  const me = opening = {};
  root.innerHTML = `<div class="panel">Loading chart…</div>`;
  let chart;
  try { chart = await api("GET", `/api/chart/${folder}`); }
  catch (e) { if (me === opening) root.innerHTML = `<div class="panel">Couldn't open the editor: ${esc(e.message)}</div>`; return; }
  if (me !== opening || !root.isConnected) return;
  window.editorClose();
  const S = details.song;
  E = {
    folder, S, midi: chart.midi, source: chart.source, hasAuto: chart.hasAuto, tpb: chart.midi.tpb, lead: (chart.audio && chart.audio.lead) || 0,
    diff: 3, snap: 4, pps: 120, x0: 0, sel: new Set(), undo: [], redo: [], dirty: false, saved: false,
    reduce: S.chart ? !!S.reduce : true,
    ctx: null, bufs: {}, peaks: {}, gains: {}, vol: {}, mute: {}, solo: {}, srcs: [], playing: false, t0: 0, off: 0, rate: 1,
    focus: "guitar", ticks: false, held: [null, null, null, null], lastPress: null, odStart: null, view: (() => { try { return VIEWS.some(v => v[0] === localStorage["pe.edView"]) ? localStorage["pe.edView"] : "all"; } catch { return "all"; } })(), padState: "", clickNext: 0, length: (chart.audio && chart.audio.audioSeconds) || 0, drag: null, ghost: null, showGhost: false,
  };
  E.hooks = { draw: () => draw(), started: () => { E.clickNext = E.off; $("#play").textContent = "❚❚ Pause"; loop(); }, stopped: () => { $("#play").textContent = "▶ Play"; draw(); } };
  E.parts = PART_TRACKS.map(([key, names]) => {
    let tr = E.midi.tracks.find(t => names.includes(t.name));
    if (!tr) { tr = { name: names[0], notes: [], events: [{ t: 0, d: [0xff, 3, names[0].length, ...[...names[0]].map(c => c.charCodeAt(0))] }] }; E.midi.tracks.push(tr); }
    return { key, tr, off: key === "drums" ? 1 : 0 };
  });
  buildTempo();
  TL.initMix(E);
  E.length = Math.max(E.length, ...E.parts.flatMap(p => p.tr.notes.map(n => t2s(n.t + n.l)))) || 60;
  renderShell(root, details);
  E.timer = setInterval(scheduleClicks, 25);
  E.padTimer = setInterval(padPoll, 8);  // the controller (8 ms: timing comes from its time stamps anyway)
  if (sessionStorage.seekTo) { const s = Number(sessionStorage.seekTo); delete sessionStorage.seekTo; E.off = Math.max(0, s - 1); E.x0 = Math.max(0, s - 2); }
  draw();
  const cur = E; TL.loadAudio(E, $("#audioState"), () => E === cur);
  if (E.source === "edited" && E.hasAuto) loadGhost();
};

// ---------- tempo map (timeline.js) ----------
const buildTempo = () => TL.buildTempo(E), seg = t => TL.seg(E, t), t2s = t => TL.t2s(E, t), s2t = s => TL.s2t(E, s);
const beatList = (t0, t1) => TL.beatList(E, t0, t1), barPos = t => TL.barPos(E, t);
const step = () => E.snap ? E.tpb / E.snap : 1;
const snapT = t => E.snap ? Math.round(t / step()) * step() : Math.round(t);
// Tempo tools: a constant BPM from a first beat at `firstBeat` s; every note and marker keeps its time in seconds.
function setConstantTempo(bpm, firstBeat) {
  const beat = 60 / bpm, old = E.parts.map(p => p.tr.notes.map(n => [t2s(n.t), t2s(n.t + n.l)]));
  const others = E.midi.tracks.filter(t => !E.parts.some(p => p.tr === t) && t.name !== "BEAT").map(t => ({ t, times: t.notes.map(n => [t2s(n.t), t2s(n.t + n.l)]) }));
  // lead: N whole beats; if there is a remainder, the first beat is stretched to absorb it (tick 0 stays 0 s)
  const N = Math.max(0, Math.floor(firstBeat / beat + 1e-6)), rem = firstBeat - N * beat;
  const stretch = rem > 0.005;
  const firstTick = (N + (stretch ? 1 : 0)) * E.tpb;
  const segs = [];
  if (stretch) { segs.push({ t: 0, us: Math.round((beat + rem) * 1e6) }); segs.push({ t: E.tpb, us: Math.round(beat * 1e6) }); }
  else segs.push({ t: 0, us: Math.round(beat * 1e6) });
  // track 0: name + time signature + tempo events
  const t0 = E.midi.tracks[0];
  t0.events = t0.events.filter(e => !(e.d[0] === 0xff && (e.d[1] === 0x51 || e.d[1] === 0x58)));
  t0.events.push({ t: 0, d: [0xff, 0x58, 4, 4, 2, 24, 8] });
  for (const s of segs) t0.events.push({ t: s.t, d: [0xff, 0x51, 3, (s.us >> 16) & 255, (s.us >> 8) & 255, s.us & 255] });
  t0.events.sort((a, b) => a.t - b.t);
  for (const tr of E.midi.tracks.slice(1)) tr.events = tr.events.filter(e => !(e.d[0] === 0xff && (e.d[1] === 0x51 || e.d[1] === 0x58)));
  buildTempo();
  // BEAT track: downbeat every 4 beats from the first beat
  let bt = E.midi.tracks.find(t => t.name === "BEAT");
  if (!bt) { bt = { name: "BEAT", notes: [], events: [{ t: 0, d: [0xff, 3, 4, 66, 69, 65, 84] }] }; E.midi.tracks.splice(1, 0, bt); }
  const endTick = s2t(E.length) + E.tpb;
  bt.notes = [];
  for (let t = 0; t <= endTick; t += E.tpb) bt.notes.push({ t, l: 120, n: t >= firstTick && ((t - firstTick) / E.tpb) % 4 === 0 ? 12 : 13, v: 100, c: 0 });
  // re-tick notes at their old times
  const retick = (n, [a, b]) => { n.t = Math.max(0, Math.round(s2t(a))); n.l = Math.max(1, Math.round(s2t(b)) - n.t); if (n.l <= TAP_MAX && n.n < 100) n.l = TAP_LEN; };
  E.parts.forEach((p, i) => p.tr.notes.forEach((n, k) => retick(n, old[i][k])));
  for (const o of others) o.t.notes.forEach((n, k) => retick(n, o.times[k]));
  buildTempo();
}
function shiftAll(ms) {
  const ds = ms / 1000;
  for (const tr of E.midi.tracks) if (tr.name !== "BEAT") for (const n of tr.notes) { const a = t2s(n.t) + ds, b = t2s(n.t + n.l) + ds; if (a < 0) return false; n.t = Math.round(s2t(a)); n.l = Math.max(1, Math.round(s2t(b)) - n.t); }
  return true;
}

// ---------- notes ----------
const gemsOf = (p, d = E.diff) => p.tr.notes.filter(n => n.n >= BASE[d] + p.off && n.n < BASE[d] + p.off + 4);
const laneOf = (p, n) => n.n - BASE[E.diff] - p.off;
// chords of a part (2+ gems at the same tick): [tick, lowest lane, highest lane], for the orange line that marks them
function chordsOf(p) {
  const by = new Map();
  for (const n of gemsOf(p)) { const l = laneOf(p, n), c = by.get(n.t); if (c) { c[1] = Math.min(c[1], l); c[2] = Math.max(c[2], l); c[3]++; } else by.set(n.t, [n.t, l, l, 1]); }
  return [...by.values()].filter(c => c[3] > 1);
}
const CHORD_COL = "#f0a030";  // the highway's (dark in both themes); the chart uses pal().chord
// Chart colours per theme (the lane colours are the game's and stay). The highway keeps its dark colours in both.
const PAL = {
  dark: { bg: "#111318", grid: "#1c2028", beatDown: "#3c4352", beat: "#262b35", barNum: "#9aa1ad", secs: "#8a919e", fxLane: "#181b21", fxWave: "#2c3140",
    fx: "rgba(180,110,240,.38)", fxLine: "#b46ef0", fxSel: "rgba(240,160,48,.55)", fxSelLine: "#f0a030", fxText: "#ffffff", ovFx: "rgba(180,110,240,.5)",
    partFocus: "#1a1d24", part: "#171a20", laneLine: "#20242c", soloFill: "rgba(240,160,48,.10)", soloBar: "#f0a030", od: "#6fd8ff", sel: "#ffffff",
    gutFocus: "#262a33", gut: "#1e2128", gutText: "#9aa1ad", gutDim: "#8a919e", chord: "#f0a030", band: "#f0a030", playhead: "#ffffff", ovBg: "#0e1014",
    loopFill: "rgba(90,170,255,.09)", loopFillOff: "rgba(90,170,255,.035)", loopBand: "rgba(90,170,255,.45)", loopBandOff: "rgba(90,170,255,.2)", loopLine: "#5aaaff", waveA: "40", gemLine: "" },
  light: { bg: "#fbfbfc", grid: "#eceef1", beatDown: "#aeb5c1", beat: "#dde1e7", barNum: "#3f4652", secs: "#5f6673", fxLane: "#eff1f4", fxWave: "#cfd4dc",
    fx: "rgba(150,80,220,.28)", fxLine: "#8a4fd0", fxSel: "rgba(240,160,48,.45)", fxSelLine: "#b86a00", fxText: "#1d2026", ovFx: "rgba(150,80,220,.5)",
    partFocus: "#ffffff", part: "#f5f6f8", laneLine: "#e4e7eb", soloFill: "rgba(240,160,48,.14)", soloBar: "#c87800", od: "#0a8cbc", sel: "#1d2026",
    gutFocus: "#e2e7ef", gut: "#eceff3", gutText: "#3f4652", gutDim: "#5f6673", chord: "#d97400", band: "#b86a00", playhead: "#1d2026", ovBg: "#eceff3",
    loopFill: "rgba(40,120,220,.10)", loopFillOff: "rgba(40,120,220,.04)", loopBand: "rgba(40,120,220,.45)", loopBandOff: "rgba(40,120,220,.2)", loopLine: "#2a78d8", waveA: "55",
    gemLine: "rgba(0,0,0,.55)" },  // the lane colors are pale on a light chart (yellow 1.6:1); an outline keeps the game colors readable
};
const pal = () => PAL[document.documentElement.dataset.theme === "light" ? "light" : "dark"];
window.addEventListener("themechange", () => { if (E) draw(); });
const partOf = n => E.parts.find(p => p.tr.notes.includes(n));
const focusPart = () => E.parts.find(p => p.key === E.focus);
function snapshot() { return { notes: E.parts.map(p => p.tr.notes.map(n => ({ ...n }))), tempo: null }; }
function fullSnapshot() { return { ...snapshot(), tempo: JSON.parse(JSON.stringify(E.midi.tracks.map(t => ({ notes: t.notes, events: t.events })))) }; }
function pushUndo(full) { E.undo.push(full ? fullSnapshot() : snapshot()); if (E.undo.length > 200) E.undo.shift(); E.redo = []; }
function restore(st) {
  if (st.tempo) { E.midi.tracks.forEach((t, i) => { t.notes = st.tempo[i].notes; t.events = st.tempo[i].events; }); E.parts.forEach(p => { p.tr = E.midi.tracks.find(t => t.name === p.tr.name) || p.tr; }); buildTempo(); }
  E.parts.forEach((p, i) => { p.tr.notes = st.notes[i]; });
  E.sel.clear(); E.dirty = true; markDirty();
}
function undo() { if (!E.undo.length) return; E.redo.push(E.undo[E.undo.length - 1].tempo ? fullSnapshot() : snapshot()); restore(E.undo.pop()); }
function redo() { if (!E.redo.length) return; const st = E.redo.pop(); E.undo.push(st.tempo ? fullSnapshot() : snapshot()); restore(st); }
function markDirty() { E.dirty = true; E.parts.forEach(p => p.tr.notes.sort((a, b) => a.t - b.t || a.n - b.n)); updateButtons(); draw(); scheduleChecks(); }

// ---------- chart rules, live (checks.js on the server): dismissable warnings, nothing is blocked ----------
const ruleKey = i => `${i.rule}|${i.part || ""}|${i.diff || ""}`;
function dismissed() { try { return new Set(JSON.parse(localStorage["pe.dismissed." + E.folder] || "[]")); } catch { return new Set(); } }
function saveDismissed(set) { localStorage["pe.dismissed." + E.folder] = JSON.stringify([...set]); }
function scheduleChecks() {
  if (!E) return;
  clearTimeout(E.checkTimer);
  E.checkTimer = setTimeout(runChecks, 500);
}
async function runChecks() {
  if (!E) return;
  const seq = (E.checkSeq = (E.checkSeq || 0) + 1);
  try {
    const r = await api("POST", `/api/checks/${E.folder}`, { midi: E.midi, reduce: E.reduce });
    if (!E || seq !== E.checkSeq) return;
    const before = E.checks ? new Set(E.checks.map(ruleKey)) : null;
    E.checks = r.items.filter(i => i.level !== "info");
    // warnings this edit introduced (not on the first check) flash once
    E.fresh = before ? new Set(E.checks.map(ruleKey).filter(k => !before.has(k))) : new Set();
    renderRules();
  } catch (e) {
    const el = $("#rules"), btn = $("#rulesBtn");
    if (btn) { btn.className = "rulesbtn"; btn.textContent = "Rules: not checked"; }
    if (el) el.innerHTML = `<p class="small dim">Couldn't run the chart checks: ${esc(e.message)}</p>`;
  }
}
// the rules popover closes on a click outside it (and on Esc, in onKey)
function rulesOutside(e) { if (E && E.rulesOpen && !e.target.closest(".rulewrap")) setRulesOpen(false); }
function setRulesOpen(on) {
  E.rulesOpen = on;
  const el = $("#rules"), btn = $("#rulesBtn");
  if (el) el.hidden = !on;
  if (btn) btn.setAttribute("aria-expanded", on);
  // open toward the side with room (the toolstrip wraps on narrower windows, which can put the button at the left)
  if (on && el && btn) el.classList.toggle("alignleft", btn.getBoundingClientRect().right < el.offsetWidth + 8);
}
const warnIcon = bad => `<svg class="warnico${bad ? " bad" : ""}" viewBox="0 0 16 16" role="img" aria-label="${bad ? "Problem" : "Warning"}"><path d="M8 1.2c.4 0 .8.2 1 .6l6.6 11.6c.4.7-.1 1.6-1 1.6H1.4c-.9 0-1.4-.9-1-1.6L7 1.8c.2-.4.6-.6 1-.6z" fill="currentColor"/><rect x="7.1" y="5" width="1.8" height="5.2" rx=".9" fill="var(--bg)"/><circle cx="8" cy="12.4" r="1" fill="var(--bg)"/></svg>`;
// The rules live in a toolstrip button ("⚠ 5 rules", "✓ Rules OK", "3 dismissed") that opens the list over the chart,
// so they never take room above the chart. A warning an edit just introduced makes the button flash.
function renderRules() {
  const el = $("#rules"), btn = $("#rulesBtn");
  if (!el || !btn || !E.checks) return;
  const dis = dismissed(), cur = DIFFS[E.diff];
  const active = E.checks.filter(i => !dis.has(ruleKey(i)))
    .sort((a, b) => (a.level === "error" ? 0 : 1) - (b.level === "error" ? 0 : 1) || (a.diff === cur ? 0 : 1) - (b.diff === cur ? 0 : 1));
  const hidden = E.checks.length - active.length, bad = active.some(i => i.level === "error");
  const s = n => n > 1 ? "s" : "";
  btn.className = "rulesbtn " + (active.length ? (bad ? "bad" : "warn") : hidden ? "dis" : "ok");
  btn.innerHTML = active.length ? `${warnIcon(bad)}<span>${active.length} rule${s(active.length)}</span>` : hidden ? `<span>${hidden} dismissed</span>` : `<span>✓ Rules OK</span>`;
  btn.title = active.length ? `${active.length} rule${s(active.length)} outside the official charts' style: click to see ${active.length > 1 ? "them" : "it"}`
    : hidden ? "All rule warnings are dismissed for this song: click to see them" : "Within the official charts' ranges";
  if (active.some(i => E.fresh && E.fresh.has(ruleKey(i)))) { btn.classList.remove("flash"); void btn.offsetWidth; btn.classList.add("flash"); }
  setRulesOpen(!!E.rulesOpen);
  if (!active.length && !hidden) {
    el.innerHTML = `<p class="rok">✓ Within the official charts' ranges.</p>`;
  } else if (!active.length) {
    el.innerHTML = `<div class="rhead">${warnIcon(false)}<b>${hidden} dismissed rule${s(hidden)} outside the official charts' style</b></div>
      <p class="small dim">Hidden for this song: the chart still saves and builds.</p><div class="actions"><button class="small" id="rulesShow">Show dismissed</button></div>`;
  } else {
    el.innerHTML = `<div class="rhead">${warnIcon(bad)}<b>${active.length} rule${s(active.length)} outside the official charts' style</b></div>
      <p class="small dim">Just a heads-up: the chart still saves and builds.</p>
      <div class="actions"><button class="small" id="rulesAll">Dismiss all</button>${hidden ? `<button class="small" id="rulesShow">Show dismissed (${hidden})</button>` : ""}</div>
      <div class="rlist">${active.map(i => `<div class="rrow ${E.fresh && E.fresh.has(ruleKey(i)) ? "fresh" : ""}" data-key="${esc(ruleKey(i))}">
        <span class="badge ${i.level === "error" ? "bad" : "warn"}">${i.level === "error" ? "problem" : "rule"}</span>
        ${i.part ? `<b>${esc(i.part)}</b>` : ""} <span>${esc(i.msg)}</span>
        ${i.at != null ? `<a href="#" data-at="${i.at}" class="small">go</a>` : ""}<span class="grow"></span>
        <button class="small rx" title="Dismiss: hide this warning for this song">×</button></div>`).join("")}</div>`;
  }
  el.querySelectorAll("[data-at]").forEach(a => a.onclick = e => {
    e.preventDefault();
    const row = a.closest(".rrow"), item = E.checks.find(i => ruleKey(i) === row.dataset.key);
    if (item && item.diff) { E.diff = DIFFS.indexOf(item.diff); $("#diff").value = E.diff; }
    if (item && item.part) { E.focus = item.part; $("#focus").value = E.focus; }
    seek(Number(a.dataset.at)); E.x0 = Math.max(0, Number(a.dataset.at) - 2); renderDiff(); renderRules(); draw();
  });
  el.querySelectorAll(".rx").forEach(b => b.onclick = () => { const d = dismissed(); d.add(b.closest(".rrow").dataset.key); saveDismissed(d); renderRules(); });
  const all = el.querySelector("#rulesAll"); if (all) all.onclick = () => { const d = dismissed(); E.checks.forEach(i => d.add(ruleKey(i))); saveDismissed(d); renderRules(); };
  const show = el.querySelector("#rulesShow"); if (show) show.onclick = () => { saveDismissed(new Set()); renderRules(); };
  E.fresh = new Set();
}
// a gem must end before the next gem in the same lane (one MIDI note number)
function fixOverlaps(p) {
  const by = new Map();
  for (const n of p.tr.notes) { if (!by.has(n.n)) by.set(n.n, []); by.get(n.n).push(n); }
  const drop = new Set();
  for (const list of by.values()) {
    list.sort((a, b) => a.t - b.t);
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1], b = list[i];
      if (b.t === a.t) { drop.add(a); continue; }
      if (a.t + a.l > b.t) a.l = Math.max(1, b.t - a.t - 1);
    }
  }
  if (drop.size) { p.tr.notes = p.tr.notes.filter(n => !drop.has(n)); for (const n of drop) E.sel.delete(n); }
}
function addGem(p, lane, t, len = TAP_LEN) {
  const n = BASE[E.diff] + p.off + lane;
  if (p.tr.notes.some(x => x.n === n && x.t === t)) return null;
  const g = { t, l: len, n, v: 100, c: 0 };
  p.tr.notes.push(g);
  return g;
}

// ---------- ghost: the automatic chart, for comparing an edited one ----------
async function loadGhost() {
  try {
    const a = await api("GET", `/api/chart/${E.folder}?auto=1`);
    if (!E) return;
    E.ghost = PART_TRACKS.map(([key, names]) => { const tr = a.midi.tracks.find(t => names.includes(t.name)); return { key, notes: tr ? tr.notes : [] }; });
    renderDiff(); draw();
  } catch { }
}
function diffCounts() {
  if (!E.ghost) return null;
  return E.parts.map((p, i) => {
    const d = E.diff, base = BASE[d] + p.off, key = n => `${n.t}:${n.n}`;
    const cur = new Set(p.tr.notes.filter(n => n.n >= base && n.n < base + 4).map(key)), old = new Set(E.ghost[i].notes.filter(n => n.n >= base && n.n < base + 4).map(key));
    let added = 0, removed = 0;
    for (const k of cur) if (!old.has(k)) added++;
    for (const k of old) if (!cur.has(k)) removed++;
    return { part: p.key, added, removed };
  });
}
function renderDiff() {
  const el = $("#diffBox");
  if (!el) return;
  const d = diffCounts();
  if (!d) { el.innerHTML = E.source === "edited" ? `<span class="dim">no automatic chart to compare with (build once)</span>` : `<span class="dim">This is the automatic chart. Once edited and saved, the differences to it show here.</span>`; return; }
  const tot = d.reduce((a, x) => a + x.added + x.removed, 0);
  el.innerHTML = `<b>Compared with the automatic chart</b> (${DIFFS[E.diff]}): ${tot ? d.filter(x => x.added || x.removed).map(x => `${x.part} +${x.added} −${x.removed}`).join(", ") : "no differences"}
    <label class="small" style="margin-left:8px"><input type="checkbox" id="ghostOn" ${E.showGhost ? "checked" : ""}> show removed gems as outlines</label>`;
  $("#ghostOn").onchange = e => { E.showGhost = e.target.checked; draw(); };
}

// ---------- audio ----------
const applyGains = () => TL.applyGains(E), rawPos = () => TL.rawPos(E), songAt = r => TL.songAt(E, r), pos = () => TL.pos(E);
const loopOn = () => TL.loopOn(E), play = () => TL.play(E), stop = () => TL.stop(E), seek = s => TL.seek(E, s);
function loop() {
  if (!E || !E.playing) return;
  const p = pos();
  if (p >= E.length) { stop(); E.off = E.length; return; }
  const W = E.W - GUT, ps = (p - E.x0) * E.pps;
  if (ps > W * 0.85 || ps < 0) E.x0 = Math.max(0, p - (W * 0.15) / E.pps);
  draw();
  E.raf = requestAnimationFrame(loop);
}
// ticks for the next 0.2 s, counted in raw play time (so a loop's wrap is a jump in song time, not a gap)
function scheduleClicks() {
  if (!E || !E.playing || !E.ticks) return;
  const p = focusPart(), L = E.playLoop, rnow = rawPos(), r1 = rnow + 0.2 * E.rate;
  if (E.clickNext < rnow - 0.05 || E.clickNext > r1) E.clickNext = rnow;
  let r = E.clickNext;
  while (r < r1) {
    const s = songAt(r), end = L ? Math.max(r + 1e-6, Math.min(r1, r + (L.b - s))) : r1, s1 = s + (end - r);
    for (const n of gemsOf(p)) {
      const gs = t2s(n.t);
      if (gs < s || gs >= s1) continue;
      const when = E.t0 + (r + (gs - s) - E.off) / E.rate;
      if (when < E.ctx.currentTime) continue;
      const o = E.ctx.createOscillator(), g = E.ctx.createGain();
      o.frequency.value = 1500 + 300 * laneOf(p, n); o.connect(g); g.connect(E.clickGain);
      g.gain.setValueAtTime(0.9, when); g.gain.exponentialRampToValueAtTime(0.001, when + 0.04);
      o.start(when); o.stop(when + 0.05);
    }
    r = end;
  }
  E.clickNext = r1;
}
// ---------- loop ----------
const snapS = s => t2s(snapT(s2t(s)));
const downbeats = (t0, t1) => beatList(t0, t1).filter(b => b.down).map(b => b.t);
const barStart = t => { const d = downbeats(0, t); return d.length ? d[d.length - 1] : 0; };
const barAfter = (t, n = 1) => { const d = downbeats(t, t + E.tpb * 64).filter(x => x > t); return d[n - 1] ?? t + n * 4 * E.tpb; };
// Loop button / K: off -> on over the selected gems (whole bars), else the last section, else 2 bars from the playhead
function toggleLoop() {
  if (loopOn()) E.loop.on = false;
  else if (E.sel.size) {
    const sel = [...E.sel], a = barStart(Math.min(...sel.map(n => n.t))), b = barAfter(Math.max(...sel.map(n => n.t + (n.l > TAP_MAX ? n.l : 0))));
    E.loop = { a: t2s(a), b: t2s(b), on: true };
  } else if (E.loop && pos() >= E.loop.a && pos() < E.loop.b) E.loop.on = true;  // the playhead is in the old loop: that loop again
  else {
    // else the loop starts at the playhead's bar, as long as the last one (2 bars the first time)
    let bars = 2;
    if (E.loop) { const ta = s2t(E.loop.a), tb = s2t(E.loop.b); bars = 1; while (bars < 64 && barAfter(ta, bars) < tb - E.tpb / 4) bars++; }
    const a = barStart(s2t(pos()));
    E.loop = { a: t2s(a), b: t2s(barAfter(a, bars)), on: true };
  }
  applyLoop();
}
// the audio sources hold the loop: restart them when it changes
function applyLoop() {
  const b = $("#loopBtn");
  if (b) { b.classList.toggle("on", loopOn()); b.title = loopOn() ? `Looping ${fmtTime(E.loop.a)}–${fmtTime(E.loop.b)} (K turns it off)` : LOOP_TIP; }
  if (E.playing) { stop(); play(); } else draw();
}
function loopEdgeAt(x, y) {
  if (!E.loop || y >= RULER || x < GUT) return null;
  return Math.abs(xOf(E.loop.a) - x) <= 5 ? "a" : Math.abs(xOf(E.loop.b) - x) <= 5 ? "b" : null;
}
const LOOP_TIP = "Loop a section (K): starts at the playhead's bar, or loops the selected gems. Or drag along the time ruler to mark it; drag its edges to change it.";

// ---------- gem shapes ----------
const shapeStep = () => E.snap ? step() : E.tpb / 4;
// put a shape's gems at tick t in part p; they replace what that part had at the same times (a gem becomes a chord)
function placeShape(p, sh, t) {
  if (t < 0 || !sh) return false;
  if (sh.gems.length > 2 && E.diff !== 3) { toast("3-gem chords are Expert only, like in the official charts.", true); return false; }
  const st = shapeStep(), base = BASE[E.diff] + p.off, times = new Set(sh.gems.map(([, k]) => t + k * st));
  pushUndo();
  p.tr.notes = p.tr.notes.filter(n => !(times.has(n.t) && n.n >= base && n.n < base + 4));
  E.sel.clear();
  for (const [l, k] of sh.gems) { const g = addGem(p, l, t + k * st); if (g) E.sel.add(g); }
  fixOverlaps(p); markDirty();
  return true;
}
function shapeSvg(sh) {
  const steps = Math.max(...sh.gems.map(([, k]) => k)) + 1, w = 8 + steps * 10;
  return `<svg width="${w}" height="30" viewBox="0 0 ${w} 30">${[0, 1, 2, 3].map(l => `<rect class="ln" x="0" y="${l * 7 + 1}" width="${w}" height="6"/>`).join("")}`
    + sh.gems.map(([l, k]) => `<rect x="${4 + k * 10}" y="${l * 7 + 1}" width="7" height="6" rx="1" fill="${LANE_COL[l]}"/>`).join("") + "</svg>";
}
function renderShapes() {
  const el = $("#shapes");
  if (!el) return;
  const list = SHAPES[E.focus];
  if (E.stamp && (!list || !list.includes(E.stamp) || (E.stamp.gems.length > 2 && E.diff !== 3))) E.stamp = null;
  if (!list) { el.innerHTML = `<b>Shapes</b><span class="dim">none for vocals: its gems follow the singer.</span>`; return; }
  el.innerHTML = `<b>Shapes · ${E.focus}</b>` + list.map((sh, i) => {
    const off = sh.gems.length > 2 && E.diff !== 3;
    return `<button class="shape${E.stamp === sh ? " on" : ""}" data-i="${i}" ${off ? "disabled" : ""} title="${esc(sh.name)}${off ? ": Expert only, like in the official charts"
      : `: drag onto the ${E.focus} part, or click it and then click the chart (Shift+${i + 1} at the playhead)`}">${shapeSvg(sh)}<span>${i + 1}</span></button>`;
  }).join("") + `<span class="dim">${E.stamp ? `placing ${esc(E.stamp.name)}: click the ${E.focus} part · Esc to stop` : E.focus === "bass" ? "two gems in a row, one snap step apart" : "drag onto the chart, or click one to place it with each click"}</span>`;
  el.querySelectorAll("button.shape").forEach(b => b.onmousedown = e => {
    if (e.button !== 0) return;
    e.preventDefault();
    E.drag = { mode: "shape", sh: list[b.dataset.i], sx: e.clientX, sy: e.clientY, moved: false, cx: -1, cy: -1 };
  });
}

// ---------- layout ----------
const xOf = s => GUT + (s - E.x0) * E.pps;
const sOf = x => E.x0 + (x - GUT) / E.pps;
// where each part is drawn: { y, h, lane (lane height), gw (gem width) }, { y, h, strip: true } or { hidden: true }
function partGeo() {
  const fi = E.parts.findIndex(p => p.key === E.focus), v = fi < 0 ? "all" : E.view;
  if (v === "all") return E.parts.map((p, i) => ({ y: PARTS_TOP + i * (PART_H + PAD), h: PART_H, lane: LANE, gw: 9 }));
  const big = v === "focus" ? PARTS_H - 3 * (STRIP + PAD) - PAD : PARTS_H - PAD;
  let y = PARTS_TOP;
  return E.parts.map((p, i) => {
    if (i === fi) { const g = { y, h: big, lane: (big - HEAD) / 4, gw: 14 }; y += big + PAD; return g; }
    if (v === "only") return { hidden: true };
    const g = { y, h: STRIP, strip: true }; y += STRIP + PAD; return g;
  });
}
const geoOf = p => partGeo()[E.parts.indexOf(p)];
// a gem's box inside its lane: full height in the normal view, at most 30 px in an enlarged one
const gemBox = (g, l) => { const gh = Math.min(g.lane - 6, 30), y = g.y + HEAD + l * g.lane; return { y, gy: y + (g.lane - gh) / 2, gh, mid: y + g.lane / 2 }; };
function hit(x, y) {
  if (y < RULER) return { zone: "ruler" };
  const geo = partGeo();
  for (let i = 0; i < 4; i++) {
    const g = geo[i];
    if (g.hidden || y < g.y || y >= g.y + g.h) continue;
    if (g.strip) return { zone: "strip", part: E.parts[i] };
    if (y < g.y + HEAD) return { zone: "head", part: E.parts[i] };
    return { zone: "lane", part: E.parts[i], lane: Math.min(3, Math.floor((y - g.y - HEAD) / g.lane)) };
  }
  return { zone: "none" };
}
// overdrive phrase or solo bar under the mouse, in a part's title strip: { n, p, edge: "a" | "b" | null }
function spanAt(x, y) {
  const h = hit(x, y);
  if (h.zone !== "head" || x < GUT) return null;
  const g = geoOf(h.part), row = y - g.y < 7 ? SOLO : OD;
  const near = h.part.tr.notes.filter(n => (n.n === OD || n.n === SOLO) && x >= xOf(t2s(n.t)) - 5 && x <= xOf(t2s(n.t + n.l)) + 5);
  const n = near.find(n => n.n === row) || near[0];
  if (!n) return null;
  const a = xOf(t2s(n.t)), b = xOf(t2s(n.t + n.l)), da = Math.abs(x - a), db = Math.abs(x - b);
  return { n, p: h.part, edge: Math.min(da, db) < 6 ? (da <= db ? "a" : "b") : null };
}
function gemAt(x, y) {
  const h = hit(x, y);
  if (h.zone !== "lane" || x < GUT) return null;
  const p = h.part, base = BASE[E.diff] + p.off + h.lane, gw = geoOf(p).gw;
  let best = null;
  for (const n of p.tr.notes) {
    if (n.n !== base) continue;
    const a = xOf(t2s(n.t)), b = n.l > TAP_MAX ? xOf(t2s(n.t + n.l)) : a + gw;
    if (x >= a - 4 && x <= Math.max(b, a + gw) + 2) { best = { n, p, edge: n.l > TAP_MAX ? x > b - 6 : x > a + gw - 4 }; }
  }
  return best;
}

// ---------- drawing ----------
function draw() {
  if (!E || !E.cv) return;
  $("#odBtn").classList.toggle("on", E.odStart != null);  // lit while a recorded phrase is open
  const c = E.g, W = E.W;
  c.clearRect(0, 0, W, H);
  const K = pal();
  c.fillStyle = K.bg; c.fillRect(0, 0, W, H);
  TL.drawGrid(E, c, K, { gut: GUT, ruler: RULER, h: H, step: E.snap > 1 ? step() : 0 });
  // parts
  const geo = partGeo();
  E.parts.forEach((p, i) => {
    const g = geo[i], y0 = g.y, LN = g.lane, gw = g.gw;
    if (g.hidden) return;
    if (g.strip) { drawStrip(c, K, p, g, W); return; }
    c.fillStyle = p.key === E.focus ? K.partFocus : K.part; c.fillRect(GUT, y0, W - GUT, g.h);
    wave(STEM_OF[p.key], y0 + HEAD, 4 * LN, PART_COL[p.key] + K.waveA);
    for (let l = 1; l < 4; l++) { c.strokeStyle = K.laneLine; c.beginPath(); c.moveTo(GUT, y0 + HEAD + l * LN + .5); c.lineTo(W, y0 + HEAD + l * LN + .5); c.stroke(); }
    // overdrive and solo markers (shared by every difficulty): solo bar on top, overdrive bar below it, both draggable
    const od = [], hov = E.hoverSpan, soloLabels = [];
    for (const n of p.tr.notes) {
      if (n.n !== OD && n.n !== SOLO) continue;
      const a = xOf(t2s(n.t)), b = xOf(t2s(n.t + n.l));
      if (n.n === OD) od.push(n);
      if (b < GUT || a > W) continue;
      const by = n.n === SOLO ? y0 + 1 : y0 + 7, bh = n.n === SOLO ? 5 : 6, w = Math.max(2, b - a);
      if (n.n === SOLO) { c.fillStyle = K.soloFill; c.fillRect(a, y0 + HEAD, b - a, 4 * LN); soloLabels.push(Math.max(a, GUT)); }
      c.fillStyle = n.n === SOLO ? K.soloBar : K.od; c.fillRect(a, by, w, bh);
      if (hov && hov.n === n || E.drag && E.drag.mode === "span" && E.drag.n === n) {  // grab handles at both ends
        c.fillStyle = K.sel; c.fillRect(a - 1, by - 1, 3, bh + 2); c.fillRect(a + w - 2, by - 1, 3, bh + 2);
      }
    }
    const inOd = n => od.some(o => n.t >= o.t && n.t < o.t + o.l);
    if (E.showGhost && E.ghost) {  // removed gems of the automatic chart, as outlines
      const base = BASE[E.diff] + p.off, cur = new Set(p.tr.notes.map(n => `${n.t}:${n.n}`));
      for (const n of E.ghost[i].notes) {
        if (n.n < base || n.n >= base + 4 || cur.has(`${n.t}:${n.n}`)) continue;
        const a = xOf(t2s(n.t)); if (a < GUT - 10 || a > W) continue;
        const l = n.n - base, bx = gemBox(g, l);
        c.strokeStyle = LANE_COL[l]; c.setLineDash([2, 2]); c.strokeRect(a + .5, bx.gy + .5, gw, bx.gh - 1); c.setLineDash([]);
      }
    }
    for (const [t, lo, hi] of chordsOf(p)) {
      const x = Math.round(xOf(t2s(t)) + gw / 2) + .5; if (x < GUT || x > W) continue;
      c.strokeStyle = K.chord; c.lineWidth = 2; c.beginPath(); c.moveTo(x, gemBox(g, lo).mid); c.lineTo(x, gemBox(g, hi).mid); c.stroke(); c.lineWidth = 1;
    }
    for (const n of gemsOf(p)) {
      const a = xOf(t2s(n.t));
      const sus = n.l > TAP_MAX, b = sus ? xOf(t2s(n.t + n.l)) : a;
      if (b < GUT - 10 || a > W) continue;
      const l = laneOf(p, n), bx = gemBox(g, l), sel = E.sel.has(n), th = Math.max(6, Math.round(bx.gh / 4));
      c.fillStyle = LANE_COL[l];
      if (sus) { c.globalAlpha = .55; c.fillRect(a, bx.mid - th / 2, b - a, th); c.globalAlpha = 1; }
      c.fillRect(a, bx.gy, gw, bx.gh);
      if (K.gemLine) { c.strokeStyle = K.gemLine; c.lineWidth = 1; if (sus && b - a > gw) c.strokeRect(a + gw + .5, bx.mid - th / 2 + .5, b - a - gw, th - 1); c.strokeRect(a + .5, bx.gy + .5, gw - 1, bx.gh - 1); }
      if (inOd(n)) { c.strokeStyle = K.od; c.lineWidth = 2; c.strokeRect(a - 1, bx.gy - 1, gw + 2, bx.gh + 2); c.lineWidth = 1; }
      if (sel) { c.strokeStyle = K.sel; c.lineWidth = 2; c.strokeRect(a - 2, bx.gy - 2, Math.max(gw + 4, b - a + 4), bx.gh + 4); c.lineWidth = 1; }
    }
    // "solo" labels on top of the gems, on the part's background
    c.font = "9px Segoe UI";
    for (const x of soloLabels) { c.fillStyle = p.key === E.focus ? K.partFocus : K.part; c.fillRect(x + 1, y0 + HEAD + 1, 22, 11); c.fillStyle = K.soloBar; c.fillText("solo", x + 3, y0 + HEAD + 10); }
    // gutter label
    c.fillStyle = p.key === E.focus ? K.gutFocus : K.gut; c.fillRect(0, y0, GUT - 2, g.h);
    c.fillStyle = PART_COL[p.key]; c.font = "bold 12px Segoe UI"; c.fillText(p.key, 8, y0 + 12);
    for (let l = 0; l < 4; l++) { const bx = gemBox(g, l); c.fillStyle = LANE_COL[l]; c.fillRect(GUT - 14, bx.gy + 2, 8, bx.gh - 4); if (p.key === E.focus) { c.fillStyle = K.gutText; c.font = "9px Segoe UI"; c.fillText(String(l + 1), GUT - 24, bx.mid + 3); } }
    c.fillStyle = K.gutDim; c.font = "10px Segoe UI"; c.fillText(`${gemsOf(p).length} gems`, 8, y0 + 30);
  });
  // loop region: shaded over everything, edges as handles on the ruler
  if (E.loop) {
    const a = xOf(E.loop.a), b = xOf(E.loop.b), on = loopOn();
    if (b > GUT && a < W) {
      const xa = Math.max(GUT, a);
      c.fillStyle = on ? K.loopFill : K.loopFillOff; c.fillRect(xa, 0, b - xa, H);
      c.fillStyle = on ? K.loopBand : K.loopBandOff; c.fillRect(xa, RULER - 6, b - xa, 5);
      c.strokeStyle = on ? K.loopLine : K.loopLine + "70"; c.setLineDash(on ? [] : [3, 3]);
      for (const x of [a, b]) if (x >= GUT && x <= W) { c.beginPath(); c.moveTo(Math.round(x) + .5, 0); c.lineTo(Math.round(x) + .5, H); c.stroke(); c.fillStyle = c.strokeStyle; c.fillRect(Math.round(x) - 3, 0, 7, 10); }
      c.setLineDash([]);
    }
  }
  // shape being dragged or placed: where its gems would go
  const pv = E.drag && E.drag.mode === "shape" && E.drag.moved ? [E.drag.sh, E.drag.cx, E.drag.cy] : E.stamp && E.hover ? [E.stamp, ...E.hover] : null;
  if (pv) {
    const [sh, x, y] = pv, h = hit(x, y);
    if (x >= GUT && h.zone === "lane" && h.part.key === E.focus) {
      const g = geoOf(h.part), t = snapT(s2t(sOf(x)));
      for (const [l, k] of sh.gems) {
        const gx = xOf(t2s(t + k * shapeStep())), bx = gemBox(g, l);
        c.globalAlpha = .6; c.fillStyle = LANE_COL[l]; c.fillRect(gx, bx.gy, g.gw, bx.gh); c.globalAlpha = 1;
        c.strokeStyle = K.sel; c.setLineDash([2, 2]); c.strokeRect(gx - 1.5, bx.gy - 1.5, g.gw + 3, bx.gh + 3); c.setLineDash([]);
      }
    }
  }
  c.fillStyle = K.gut; c.fillRect(0, 0, GUT - 2, RULER);
  c.fillStyle = K.gutText; c.font = "11px Segoe UI"; c.fillText("bar / time", 8, 18);
  // rubber band
  if (E.drag && E.drag.mode === "band") {
    const d = E.drag; c.strokeStyle = K.band; c.setLineDash([4, 3]);
    c.strokeRect(Math.min(d.x, d.cx) + .5, Math.min(d.y, d.cy) + .5, Math.abs(d.cx - d.x), Math.abs(d.cy - d.y)); c.setLineDash([]);
  }
  if (E.odStart != null && E.odPart) {
    const g = geoOf(E.odPart), a = xOf(t2s(E.odStart)), b = xOf(pos());
    if (!g.hidden && !g.strip) { c.fillStyle = K.od; c.globalAlpha = .6; c.fillRect(Math.max(GUT, Math.min(a, b)), g.y + 7, Math.abs(b - a), 6); c.globalAlpha = 1; }
  }
  // playhead
  const px = xOf(pos());
  if (px >= GUT && px <= W) { c.strokeStyle = K.playhead; c.beginPath(); c.moveTo(px + .5, 0); c.lineTo(px + .5, H); c.stroke(); }
  drawOverview();
  drawHighway();
  updateStatus();
}
// a part shrunk to a thin strip (Focus view): its name, solos and gems as small marks; a click focuses it
function drawStrip(c, K, p, g, W) {
  c.fillStyle = K.part; c.fillRect(GUT, g.y, W - GUT, g.h);
  for (const n of p.tr.notes) if (n.n === SOLO) { const a = xOf(t2s(n.t)), b = xOf(t2s(n.t + n.l)); if (b >= GUT && a <= W) { c.fillStyle = K.soloFill; c.fillRect(a, g.y, b - a, g.h); } }
  const lh = (g.h - 2) / 4;
  for (const n of gemsOf(p)) {
    const a = xOf(t2s(n.t)); if (a < GUT - 3 || a > W) continue;
    const l = laneOf(p, n), b = n.l > TAP_MAX ? xOf(t2s(n.t + n.l)) : a + 3;
    c.fillStyle = LANE_COL[l]; c.fillRect(a, g.y + 1 + l * lh, Math.max(3, b - a), Math.max(2, lh - 1));
  }
  c.fillStyle = K.gut; c.fillRect(0, g.y, GUT - 2, g.h);
  c.fillStyle = PART_COL[p.key]; c.font = "bold 11px Segoe UI"; c.fillText(p.key, 8, g.y + 13);
}
const wave = (track, y, h, col) => TL.wave(E, track, y, h, col, GUT);
function drawOverview() {
  const c = E.og, W = E.W, h = 34, K = pal();
  c.fillStyle = K.ovBg; c.fillRect(0, 0, W, h);
  const L = E.length || 1, k = W / L;
  for (const p of E.parts) {
    c.fillStyle = PART_COL[p.key] + "90";
    const i = E.parts.indexOf(p);
    for (const n of gemsOf(p)) c.fillRect(Math.floor(t2s(n.t) * k), 3 + i * 7, 1, 6);
  }
  c.strokeStyle = K.band; c.strokeRect(E.x0 * k + .5, .5, Math.max(4, (W - GUT) / E.pps * k), h - 1);
  c.fillStyle = K.playhead; c.fillRect(pos() * k, 0, 1, h);
}
// Highway: the focus part as the game shows it, gems falling towards the strike line at the bottom.
function drawHighway() {
  const c = E.hg; if (!c) return;
  const Wd = HW_W, Hd = H + 34, p = focusPart(), now = pos(), strike = Hd - 40, pxPerS = (strike - 30) / HW_AHEAD;
  c.fillStyle = "#0b0d11"; c.fillRect(0, 0, Wd, Hd);
  const lx = l => 24 + l * (Wd - 48) / 4 + (Wd - 48) / 8, lw = (Wd - 48) / 4;
  // perspective: lanes narrow towards the top
  c.strokeStyle = "#2a2f3a";
  for (let l = 0; l <= 4; l++) { const x = 24 + l * (Wd - 48) / 4; c.beginPath(); c.moveTo(x, strike + 20); c.lineTo(Wd / 2 + (x - Wd / 2) * 0.55, 20); c.stroke(); }
  const yOf = s => strike - (s - now) * pxPerS, scale = y => 0.55 + 0.45 * Math.max(0, Math.min(1, (y - 20) / (strike - 20)));
  const xAt = (l, y) => Wd / 2 + (lx(l) - Wd / 2) * scale(y);
  // beat lines
  for (const b of beatList(s2t(Math.max(0, now - 0.5)), s2t(now + HW_AHEAD))) { const y = yOf(t2s(b.t)); if (y < 20 || y > strike + 20) continue; c.strokeStyle = b.down ? "#3a4150" : "#242933"; c.beginPath(); c.moveTo(xAt(0, y) - lw * scale(y) / 2, y); c.lineTo(xAt(3, y) + lw * scale(y) / 2, y); c.stroke(); }
  // overdrive and solo spans
  for (const n of p.tr.notes) {
    if (n.n !== OD && n.n !== SOLO) continue;
    const a = yOf(t2s(n.t + n.l)), b = yOf(t2s(n.t)); if (b < 20 || a > strike + 20) continue;
    c.fillStyle = n.n === OD ? "rgba(111,216,255,.08)" : "rgba(240,160,48,.08)"; c.fillRect(24, Math.max(20, a), Wd - 48, Math.min(strike + 20, b) - Math.max(20, a));
  }
  const od = p.tr.notes.filter(n => n.n === OD), inOd = n => od.some(o => n.t >= o.t && n.t < o.t + o.l);
  for (const [t, lo, hi] of chordsOf(p)) {
    const s = t2s(t), y = yOf(s); if (y < 20 || y > strike + 20) continue;
    c.strokeStyle = s < now ? CHORD_COL + "60" : CHORD_COL; c.lineWidth = 2; c.beginPath(); c.moveTo(xAt(lo, y), y); c.lineTo(xAt(hi, y), y); c.stroke(); c.lineWidth = 1;
  }
  for (const n of gemsOf(p)) {
    const s = t2s(n.t), e = t2s(n.t + n.l), y = yOf(s);
    if (y < 10 || yOf(n.l > TAP_MAX ? e : s) > strike + 30) continue;
    const l = laneOf(p, n), sc = scale(Math.min(strike, Math.max(20, y))), w = lw * 0.7 * sc, x = xAt(l, Math.min(strike + 20, Math.max(20, y)));
    if (n.l > TAP_MAX) { const ye = Math.max(20, yOf(e)); c.fillStyle = LANE_COL[l] + "70"; c.fillRect(x - 3 * sc, ye, 6 * sc, Math.min(strike + 20, y) - ye); }
    if (y > strike + 20) continue;
    c.fillStyle = s < now ? LANE_COL[l] + "60" : LANE_COL[l];
    c.beginPath(); c.ellipse(x, y, w / 2, 6 * sc, 0, 0, Math.PI * 2); c.fill();
    if (inOd(n)) { c.strokeStyle = "#6fd8ff"; c.lineWidth = 2; c.stroke(); c.lineWidth = 1; }
    if (E.sel.has(n)) { c.strokeStyle = "#fff"; c.stroke(); }
  }
  // strike line and lane buttons
  c.strokeStyle = "#e4e6eb"; c.lineWidth = 2; c.beginPath(); c.moveTo(20, strike); c.lineTo(Wd - 20, strike); c.stroke(); c.lineWidth = 1;
  for (let l = 0; l < 4; l++) { c.strokeStyle = LANE_COL[l]; c.beginPath(); c.ellipse(lx(l), strike, lw * 0.35, 6, 0, 0, Math.PI * 2); c.stroke(); c.fillStyle = "#9aa1ad"; c.font = "10px Segoe UI"; c.fillText(String(l + 1), lx(l) - 3, strike + 20); }
  c.fillStyle = PART_COL[p.key]; c.font = "bold 12px Segoe UI"; c.fillText(`${p.key} · ${DIFFS[E.diff]}`, 8, 14);
  c.fillStyle = "#8a919e"; c.font = "10px Segoe UI"; c.fillText(E.recording ? "● REC: keys 1-4 add gems" : "keys 1-4 add gems here", 8, Hd - 8);
}

// ---------- shell ----------
function renderShell(root, details) {
  const opts = (list, cur) => list.map(([v, n]) => `<option value="${v}" ${String(v) === String(cur) ? "selected" : ""}>${n}</option>`).join("");
  root.innerHTML = `
  <div class="edbar">
    <div class="grp" role="group" aria-label="Playback">
      <button id="play" class="primary" style="min-width:68px">▶ Play</button><button id="toStart" title="Back to the start (Home)" aria-label="Back to the start">⏮</button><button id="loopBtn">⟲ Loop</button>
      <button id="rec" title="Record mode: while playing, keys 1-4 (or the controller) add gems to the part at the playhead; hold for a held note (R)">● Record</button>
      <span id="time"></span>
      <select id="rate" title="Playback speed (changes pitch)" aria-label="Playback speed">${opts([[1, "100%"], [0.75, "75%"], [0.5, "50%"]], 1)}</select>
    </div>
    <div class="grp" role="group" aria-label="View">
      <select id="focus" title="The part the highway shows, the ticks follow, keys 1-4 record into and Focus enlarges" aria-label="Part">${opts([["drums", "drums"], ["bass", "bass"], ["guitar", "guitar"], ["vocals", "vocals"]], "guitar")}</select>
      <select id="diff" aria-label="Difficulty">${opts([[3, "Expert"], [2, "Hard"], [1, "Medium"], [0, "Easy"]], 3)}</select>
      <span class="seg" id="viewSeg" role="group" aria-label="Parts shown">${VIEWS.map(([v, n, tip]) => `<button data-view="${v}" title="${tip} (F)" aria-pressed="false">${n}</button>`).join("")}</span>
      <button id="zoomOut" title="Zoom out (Ctrl+wheel)" aria-label="Zoom out">−</button><button id="zoomIn" title="Zoom in (Ctrl+wheel)" aria-label="Zoom in">+</button>
    </div>
    <div class="grp" role="group" aria-label="Edit">
      <label class="small dim" for="snap">snap</label><select id="snap">${opts([[1, "1 beat"], [2, "1/2"], [3, "1/3"], [4, "1/4"], [6, "1/6"], [8, "1/8"], [0, "off"]], 4)}</select>
      <button id="odBtn" title="Overdrive phrase on/off over the selected gems; while recording, press to start a phrase at the playhead and again to end it (O). Drag a phrase's bar to move it, or its ends to resize it.">Overdrive</button><button id="soloBtn" title="Solo on/off over the selected gems; one part at a time, at most 4 per part (L). Drag a solo's bar to move it, or its ends to resize it.">Solo</button>
      <button id="undo" title="Undo (Ctrl+Z)" aria-label="Undo">↶</button><button id="redo" title="Redo (Ctrl+Y)" aria-label="Redo">↷</button>
      <button id="tempoBtn" title="Set a constant tempo or shift every gem">Tempo…</button>
    </div>
    <span class="grow"></span>
    <div class="grp" role="group" aria-label="Controller and save">
      <span class="rulewrap"><button id="rulesBtn" class="rulesbtn" aria-haspopup="dialog" aria-expanded="false" aria-controls="rules">Checking rules…</button>
        <div id="rules" class="rulespop" role="dialog" aria-label="Chart rules" hidden><p class="small dim">Checking the chart against the official charts' rules…</p></div></span>
      <button id="padBtn">🎮</button>
      <span id="srcBadge"></span>
      <button id="saveEd" class="primary">Save</button><button id="saveBuildEd" title="Save, then rebuild the song's chart">Save + rebuild</button>
    </div>
  </div>
  ${TL.mixerHtml(`<span class="ch"><label title="Play a click on the selected part's gems, to check the sync"><input type="checkbox" id="ticks"> <b>Ticks</b></label><input type="range" min="0" max="1" step="0.05" value="0.5" id="clickVol" aria-label="Ticks volume"></span>`)}
  <div id="shapes" class="shapes"></div>
  <div class="edmain"><div class="canvaswrap" id="cvwrap"><canvas id="cv"></canvas><canvas id="overview"></canvas></div><canvas id="highway"></canvas></div>
  <div class="edfoot">
    <div class="panel" style="flex:1"><div id="status"></div><div id="reduceLine" class="warnline"></div>
      <label class="small"><input type="checkbox" id="reduce" ${E.reduce ? "checked" : ""}> Easy, Medium and Hard are made from Expert at build time (only Expert edits count)</label>
      <div id="diffBox" class="diffbox" style="margin-top:6px"></div></div>
    <div class="panel keys" style="width:390px">
      <kbd>Space</kbd> play/pause · click ruler = seek, drag it = loop a section · <kbd>K</kbd> loop on/off (at the playhead's bar) · <kbd>Home</kbd> start · <kbd>R</kbd> record mode<br>
      <kbd>1</kbd>–<kbd>4</kbd> add a gem in that lane at the playhead (hold while playing = held note; together = chord) · <kbd>Shift</kbd>+<kbd>1</kbd>–<kbd>7</kbd> add that shape<br>
      shapes: drag one onto its part, or click it then click the part; <kbd>Esc</kbd> stops placing<br>
      click a lane = add gem (with several gems selected, it unselects them first) · drag = move · drag the right end = hold length<br>
      drag on empty space or a part's title = select area · <kbd>Shift</kbd>/<kbd>Ctrl</kbd>+click = add to selection<br>
      <kbd>Del</kbd> delete · <kbd>←</kbd><kbd>→</kbd> move by snap · <kbd>↑</kbd><kbd>↓</kbd> lane · <kbd>T</kbd> tap/hold<br>
      <kbd>O</kbd> / Overdrive phrase · <kbd>L</kbd> / Solo, on/off for the selection (recording: <kbd>O</kbd> starts and ends a phrase)<br>
      drag an overdrive or solo bar = move it, drag its ends = resize · <kbd>F</kbd> all parts / focus / only (or double-click a part's name) · <kbd>Ctrl</kbd>+<kbd>C</kbd>/<kbd>V</kbd> copy/paste at the playhead<br>
      🎮 controller (Xbox / PlayStation): the game's layout; see <b>🎮 Controller</b> for every button<br>
      screen effects: on the <b>Effects &amp; Band Anims</b> tab · wheel = scroll · <kbd>Ctrl</kbd>+wheel = zoom
    </div>
  </div>`;
  E.cv = $("#cv"); E.ov = $("#overview"); E.hw = $("#highway");
  E.onResize = () => {
    const dpr = window.devicePixelRatio || 1, W = $("#cvwrap").clientWidth;
    E.W = W;
    for (const [cv, w, h] of [[E.cv, W, H], [E.ov, W, 34], [E.hw, HW_W, H + 34]]) { cv.width = w * dpr; cv.height = h * dpr; cv.style.width = w + "px"; cv.style.height = h + "px"; }
    E.g = E.cv.getContext("2d"); E.g.setTransform(dpr, 0, 0, dpr, 0, 0);
    E.og = E.ov.getContext("2d"); E.og.setTransform(dpr, 0, 0, dpr, 0, 0);
    E.hg = E.hw.getContext("2d"); E.hg.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  };
  window.addEventListener("resize", E.onResize);
  E.onResize();
  $("#play").onclick = () => E.playing ? stop() : play();
  $("#toStart").onclick = () => { seek(0); E.x0 = 0; draw(); };
  $("#rate").onchange = e => { const was = E.playing; stop(); E.rate = Number(e.target.value); if (was) play(); };
  $("#diff").onchange = e => setDiff(Number(e.target.value));
  $("#padBtn").onclick = padDialog;
  $("#snap").onchange = e => { E.snap = Number(e.target.value); draw(); };
  $("#zoomIn").onclick = () => zoom(1.5, GUT + (E.W - GUT) / 2);
  $("#zoomOut").onclick = () => zoom(1 / 1.5, GUT + (E.W - GUT) / 2);
  $("#focus").onchange = e => setFocus(e.target.value);
  $("#loopBtn").onclick = toggleLoop; $("#loopBtn").title = LOOP_TIP;
  $("#ticks").onchange = e => { E.ticks = e.target.checked; E.clickNext = rawPos(); };
  $("#rec").onclick = toggleRec;
  $("#odBtn").onclick = () => overdrivePress(performance.now());
  document.querySelectorAll("#viewSeg [data-view]").forEach(b => b.onclick = () => setView(b.dataset.view));
  $("#soloBtn").onclick = soloPress;
  $("#clickVol").oninput = e => { if (E.clickGain) E.clickGain.gain.value = Number(e.target.value); };
  $("#undo").onclick = undo; $("#redo").onclick = redo;
  $("#tempoBtn").onclick = tempoDialog;
  $("#reduce").onchange = e => { E.reduce = e.target.checked; E.dirty = true; updateButtons(); draw(); scheduleChecks(); };
  $("#saveEd").onclick = () => save(false);
  $("#saveBuildEd").onclick = () => save(true);
  TL.bindMixer(E);
  E.cv.addEventListener("mousedown", onDown);
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
  E.cv.addEventListener("dblclick", onDbl);
  E.cv.addEventListener("wheel", onWheel, { passive: false });
  E.cv.addEventListener("mousemove", e => {
    if (E.drag) return;
    const [x, y] = local(e), g = gemAt(x, y), sp = spanAt(x, y), z = hit(x, y).zone;
    if ((sp && sp.n) !== (E.hoverSpan && E.hoverSpan.n)) { E.hoverSpan = sp; draw(); }
    E.cv.style.cursor = g && g.edge || sp && sp.edge || loopEdgeAt(x, y) ? "ew-resize" : sp ? "grab" : z === "strip" ? "pointer" : E.stamp && z === "lane" ? "copy" : "default";
    if (E.stamp) { E.hover = [x, y]; draw(); }
  });
  E.cv.addEventListener("mouseleave", () => { if (E.hover || E.hoverSpan) { E.hover = null; E.hoverSpan = null; draw(); } });
  TL.bindOverview(E, E.ov, GUT);
  E.hw.addEventListener("mousedown", e => { const r = E.hw.getBoundingClientRect(); const l = Math.floor((e.clientX - r.left - 24) / ((HW_W - 48) / 4)); if (l >= 0 && l < 4) recordGem(l); });
  E.onKey = onKey; E.onKeyUp = onKeyUp;
  window.addEventListener("keydown", E.onKey);
  window.addEventListener("keyup", E.onKeyUp);
  $("#rulesBtn").onclick = () => setRulesOpen(!E.rulesOpen);
  window.addEventListener("mousedown", rulesOutside, true);
  renderPadBadge();
  setView(E.view); updateButtons(); renderDiff(); renderShapes(); runChecks();
}
function toggleRec() { E.recording = !E.recording; if (!E.recording) E.odStart = null; $("#rec").classList.toggle("on", E.recording); if (E.recording && !E.playing) play(); draw(); }
function recordGem(lane) {
  const p = focusPart(), t = snapT(s2t(pos()));
  if (t < 0) return;
  pushUndo();
  const g = addGem(p, lane, t);
  if (g) { E.sel.clear(); E.sel.add(g); fixOverlaps(p); markDirty(); }
  else E.undo.pop();
}
function updateButtons() {
  if (!E) return;
  $("#undo").disabled = !E.undo.length; $("#redo").disabled = !E.redo.length;
  const dirty = E.dirty;
  $("#saveEd").disabled = !dirty;
  // one badge, so the toolbar stays on one line: "rebuild needed" stands for a saved edited chart not built yet
  $("#srcBadge").innerHTML = E.saved && !dirty ? `<span class="badge warn" title="Edited chart saved (songs/${E.folder}/${esc(E.S.chart || "chart.mid")}), but the game files are from the last build">rebuild needed</span>`
    : E.source === "edited" ? `<span class="badge ok" title="songs/${E.folder}/${esc(E.S.chart || "chart.mid")}">edited chart</span>` : `<span class="badge" title="the chart of the last build; saving makes it songs/${E.folder}/chart.mid">automatic chart</span>`;
  $("#reduceLine").textContent = E.reduce && E.diff !== 3 ? "This difficulty is remade from Expert at build time; edits here are not used." : "";
}
function updateStatus() {
  const p = pos(), st = $("#status");
  $("#time").textContent = `${fmtTime(p)} · bar ${barPos(s2t(p)).split(".").slice(0, 2).join(".")}`;
  if (!st) return;
  const sel = [...E.sel];
  if (!sel.length) { st.textContent = "No selection."; return; }
  const n0 = sel.reduce((a, b) => a.t < b.t ? a : b), parts = new Set(sel.map(n => partOf(n)?.key));
  st.textContent = `${sel.length} gem${sel.length > 1 ? "s" : ""} selected (${[...parts].join(", ")}) · first at ${t2s(n0.t).toFixed(3)} s, bar ${barPos(n0.t)}` +
    (sel.length === 1 ? ` · ${n0.l > TAP_MAX ? "hold " + (n0.l / E.tpb).toFixed(2) + " beats" : "tap"}` : "");
}
const zoom = (f, x) => TL.zoom(E, f, x, GUT);
function tempoDialog() {
  const bpm = 60 / (E.tempo[E.tempo.length - 1].us / 1e6), first = E.beats ? t2s((E.beats.find(b => b.down) || E.beats[0]).t) : 0;
  $("#modalBox").innerHTML = `<b>Tempo</b>
    <p class="small dim">The grid (bars, beats, snapping) comes from the chart's tempo map. Both tools below keep every gem, overdrive phrase and solo at its time in seconds; only the grid moves. For songs with a steady beat.</p>
    <div class="form"><label>BPM</label><input type="number" step="0.01" id="t_bpm" value="${bpm.toFixed(2)}">
      <label>First beat at (s)</label><input type="number" step="0.001" id="t_first" value="${first.toFixed(3)}">
      <label></label><span class="small dim">Tip: play the song, pause on the first downbeat and copy the time. Current playhead: ${pos().toFixed(3)} s.</span></div>
    <div class="actions" style="margin:10px 0"><button class="primary" id="t_apply">Set constant tempo</button></div>
    <hr style="border-color:var(--line)">
    <div class="form"><label>Shift all gems (ms)</label><span class="inline"><input type="number" step="1" id="t_shift" value="0"><span class="small dim">+ later, − earlier; moves every gem, phrase and solo against the audio</span></span></div>
    <div class="actions" style="margin-top:10px"><button id="t_shiftBtn">Shift</button><button id="t_cancel">Cancel</button></div>`;
  $("#modal").classList.remove("hidden");
  $("#t_cancel").onclick = () => $("#modal").classList.add("hidden");
  $("#t_apply").onclick = () => {
    const b = Number($("#t_bpm").value), f = Number($("#t_first").value);
    if (!(b >= 20 && b <= 400) || !(f >= 0)) return toast("Enter a tempo between 20 and 400 BPM and a first beat at 0 s or later.", true);
    pushUndo(true); setConstantTempo(b, f); E.sel.clear(); markDirty(); $("#modal").classList.add("hidden"); toast(`Grid set to ${b} BPM from ${f} s`);
  };
  $("#t_shiftBtn").onclick = () => {
    const ms = Number($("#t_shift").value);
    if (!ms) return;
    pushUndo(true);
    if (!shiftAll(ms)) { E.undo.pop(); return toast("Can't shift that far: some gems would land before the song starts. Try a smaller shift.", true); }
    E.sel.clear(); markDirty(); $("#modal").classList.add("hidden"); toast(`All gems shifted by ${ms} ms`);
  };
}

// ---------- mouse ----------
function local(e) { const r = E.cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
function onDown(e) {
  if (e.button !== 0) return;
  const [x, y] = local(e), h = hit(x, y);
  e.preventDefault();
  if (h.zone === "strip") { setFocus(h.part.key); return; }
  if (x < GUT) { if (h.zone === "lane" || h.zone === "head") { E.focus = h.part.key; $("#focus").value = E.focus; renderShapes(); draw(); } return; }
  if (h.zone === "ruler") {
    // an edge of the loop: resize it; else click = seek, drag = mark a new loop
    const edge = loopEdgeAt(x, y);
    if (edge) { E.drag = { mode: "loopEdge", edge }; return; }
    seek(sOf(x)); E.drag = { mode: "ruler", x }; return;
  }
  if (E.stamp && h.zone === "lane") {
    if (h.part.key !== E.focus) toast(`These are ${E.focus} shapes: click the ${E.focus} part.`, true);
    else placeShape(h.part, E.stamp, snapT(s2t(sOf(x))));
    return;
  }
  const sp = h.zone === "head" && spanAt(x, y);
  if (sp) { E.drag = { mode: "span", n: sp.n, p: sp.p, edge: sp.edge, x, orig: { t: sp.n.t, l: sp.n.l }, undo: snapshot(), changed: false, ...spanRoom(sp.n, sp.p) }; draw(); return; }
  if (h.zone === "head") { E.drag = { mode: "band", x, y, cx: x, cy: y, add: true, part: h.part, lane: 0, base: e.shiftKey || e.ctrlKey ? new Set(E.sel) : new Set(), noAdd: true }; return; }
  if (h.zone !== "lane") return;
  const g = gemAt(x, y), add = e.shiftKey || e.ctrlKey;
  if (g) {
    if (add) { if (E.sel.has(g.n)) E.sel.delete(g.n); else E.sel.add(g.n); }
    else if (!E.sel.has(g.n)) { E.sel.clear(); E.sel.add(g.n); }
    E.drag = { mode: g.edge ? "resize" : "move", x, y, gem: g.n, part: g.p, orig: new Map([...E.sel].map(n => [n, { t: n.t, n: n.n, l: n.l }])), undo: snapshot(), changed: false };
    draw(); return;
  }
  E.drag = { mode: "band", x, y, cx: x, cy: y, add, part: h.part, lane: h.lane, base: add ? new Set(E.sel) : new Set() };
}
function onMove(e) {
  if (!E || !E.drag) return;
  const [x, y] = local(e), d = E.drag;
  if (d.mode === "shape") { d.moved = d.moved || Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 4; d.cx = x; d.cy = y; if (d.moved) { document.body.style.cursor = "copy"; draw(); } return; }
  if (d.mode === "ruler") {
    if (Math.abs(x - d.x) < 4) return;
    const a = snapS(sOf(Math.min(d.x, x))), b = snapS(sOf(Math.max(d.x, x)));
    if (b > a) { E.loop = { a, b, on: true }; d.made = true; draw(); }
    return;
  }
  if (d.mode === "loopEdge") {
    const s = snapS(sOf(x)), min = t2s(shapeStep()) - t2s(0);
    if (d.edge === "a") E.loop.a = Math.max(0, Math.min(s, E.loop.b - min)); else E.loop.b = Math.max(s, E.loop.a + min);
    d.made = true; draw(); return;
  }
  if (d.mode === "band") { d.cx = x; d.cy = y; bandSelect(); draw(); return; }
  if (d.mode === "span") {
    // ends: resize (at least the minimum length); body: move. Snapped, and kept between the neighbouring spans.
    const n = d.n, o = d.orig, at = snapT(s2t(sOf(x))), min = d.min;
    if (d.edge === "a") { const a = Math.max(d.lo, Math.min(at, o.t + o.l - min)); n.t = a; n.l = o.t + o.l - a; }
    else if (d.edge === "b") { n.t = o.t; n.l = Math.max(min, Math.min(d.hi, at) - o.t); }
    else { const dt = snapT(o.t + s2t(sOf(x)) - s2t(sOf(d.x))) - o.t; n.t = Math.max(d.lo, Math.min(d.hi - o.l, o.t + dt)); n.l = o.l; }
    d.changed = n.t !== o.t || n.l !== o.l; draw(); return;
  }
  if (d.mode === "move") {
    const dt = snapT(s2t(sOf(x)) - s2t(sOf(d.x)) + (d.orig.get(d.gem).t)) - d.orig.get(d.gem).t;
    const h = hit(x, y), g = geoOf(d.part), dl = h.zone === "lane" && h.part === d.part ? h.lane - Math.min(3, Math.floor((d.y - g.y - HEAD) / g.lane)) : 0;
    let ok = true;
    for (const [n, o] of d.orig) { const p = partOf(n), l = o.n - BASE[E.diff] - p.off + dl; if (l < 0 || l > 3 || o.t + dt < 0) ok = false; }
    if (!ok) return;
    for (const [n, o] of d.orig) { n.t = o.t + dt; n.n = o.n + dl; }
    d.changed = dt !== 0 || dl !== 0; draw(); return;
  }
  if (d.mode === "resize") {
    const end = Math.max(d.gem.t + 1, snapT(s2t(sOf(x))));
    const dl = end - d.gem.t - d.orig.get(d.gem).l;
    for (const [n, o] of d.orig) n.l = Math.max(TAP_LEN, o.l + dl);
    for (const [n] of d.orig) if (n.l <= TAP_MAX) n.l = TAP_LEN;
    d.changed = true; draw();
  }
}
function onUp() {
  if (!E || !E.drag) return;
  const d = E.drag; E.drag = null;
  if (d.mode === "shape") {
    document.body.style.cursor = "";
    if (!d.moved) { E.stamp = E.stamp === d.sh ? null : d.sh; renderShapes(); draw(); return; }  // a click: pick it up / put it down
    const h = hit(d.cx, d.cy), inside = d.cx >= GUT && d.cx <= E.W && d.cy >= 0 && d.cy <= H;
    if (inside && h.zone === "lane") {
      if (h.part.key !== E.focus) toast(`These are ${E.focus} shapes: drop them on the ${E.focus} part.`, true);
      else placeShape(h.part, d.sh, snapT(s2t(sOf(d.cx))));
    }
    draw(); return;
  }
  if (d.mode === "ruler" || d.mode === "loopEdge") { if (d.made) applyLoop(); return; }
  if (d.mode === "band" && d.noAdd && Math.abs(d.cx - d.x) < 4 && Math.abs(d.cy - d.y) < 4) { E.sel = d.base; draw(); return; }
  if (d.mode === "band" && Math.abs(d.cx - d.x) < 4 && Math.abs(d.cy - d.y) < 4) {
    // a click on an empty lane with several gems selected: unselect them (the next click adds a gem)
    if (!d.add && E.sel.size > 1) { E.sel.clear(); draw(); return; }
    // a click on an empty lane: new gem
    const t = snapT(s2t(sOf(d.x))), p = d.part;
    if (t < 0) return draw();
    pushUndo();
    const g = addGem(p, d.lane, t);
    if (g) { E.sel.clear(); E.sel.add(g); }
    fixOverlaps(p); markDirty(); return;
  }
  if (d.mode === "span") {
    if (d.changed) { E.undo.push(d.undo); E.redo = []; markDirty(); return; }
    draw(); return;
  }
  if ((d.mode === "move" || d.mode === "resize") && d.changed) {
    E.undo.push(d.undo); E.redo = [];
    E.parts.forEach(fixOverlaps); markDirty(); return;
  }
  draw();
}
function bandSelect() {
  const d = E.drag, xa = Math.min(d.x, d.cx), xb = Math.max(d.x, d.cx), ya = Math.min(d.y, d.cy), yb = Math.max(d.y, d.cy);
  E.sel = new Set(d.base);
  const geo = partGeo();
  E.parts.forEach((p, i) => {
    const g = geo[i]; if (g.hidden || g.strip) return;
    for (const n of gemsOf(p)) {
      const x = xOf(t2s(n.t)), y = gemBox(g, laneOf(p, n)).mid;
      if (x + g.gw >= xa && x <= xb && y >= ya && y <= yb) E.sel.add(n);
    }
  });
}
// how far a span can go: up to the neighbouring spans of its kind on its part (solos: on every part, since only one
// part has a solo at a time) and the song's end. Spans that already overlap it are ignored.
function spanRoom(span, part) {
  const others = (span.n === SOLO ? E.parts : [part]).flatMap(p => p.tr.notes.filter(n => n.n === span.n && n !== span && !(n.t < span.t + span.l && n.t + n.l > span.t)));
  const lo = Math.max(0, ...others.filter(n => n.t + n.l <= span.t).map(n => n.t + n.l));
  const end = Math.max(span.t + span.l, Math.round(s2t(E.length || 0)));
  const hi = Math.min(end, ...others.filter(n => n.t >= span.t + span.l).map(n => n.t));
  return { lo, hi, min: span.n === SOLO ? E.tpb + 1 : Math.max(1, Math.round(E.tpb / 4)) };
}
// parts shown: All parts / Focus / Only (F cycles)
function setView(v) {
  E.view = v; try { localStorage["pe.edView"] = v; } catch { }
  document.querySelectorAll("#viewSeg [data-view]").forEach(b => { b.classList.toggle("on", b.dataset.view === v); b.setAttribute("aria-pressed", String(b.dataset.view === v)); });
  draw();
}
const cycleView = () => setView(VIEWS[(VIEWS.findIndex(v => v[0] === E.view) + 1) % VIEWS.length][0]);
function onDbl(e) {
  const [x, y] = local(e), h = hit(x, y);
  // double-click a part's title or name: enlarge it (Focus), or back to all parts
  if (h.part && (h.zone === "head" && !spanAt(x, y) || x < GUT)) { setFocus(h.part.key); setView(E.view === "all" ? "focus" : "all"); }
}
function onWheel(e) { TL.onWheel(E, e, local(e)[0], GUT); }

// ---------- playing gems in: keys 1-4 and the controller ----------
// A press adds a gem at the playhead; lanes pressed within CHORD_MS of each other land on the same tick (a chord, one undo
// step). Held while playing for HOLD_S or more, the gem becomes a held note as long as the press (snapped to the grid).
// Press times are taken from the event / controller time stamps and the timing offset, not from when they are handled.
const CHORD_MS = 50, HOLD_S = 0.25;
const inputOffset = () => { try { const v = Number(localStorage["pe.padOffset"]); return isFinite(v) ? v : 0; } catch { return 0; } };
// song time of an input that happened at performance time `ms`
function songTimeAt(ms) {
  if (!E.playing) return pos();
  const lag = Math.max(0, performance.now() - (ms || performance.now())) / 1000;
  return Math.max(0, pos() - lag * E.rate - inputOffset() / 1000 * E.rate);
}
function laneDown(lane, ms) {
  if (E.calib) return calibPress(ms);
  const p = focusPart(), s = songTimeAt(ms), now = performance.now(), lp = E.lastPress;
  const chord = lp && lp.part === p && now - lp.ms < CHORD_MS;
  const t = chord ? lp.t : snapT(s2t(s));
  if (t < 0) return;
  if (!chord) pushUndo();
  const g = addGem(p, lane, t);
  if (g) { if (!chord) E.sel.clear(); E.sel.add(g); fixOverlaps(p); markDirty(); }
  else {  // a gem is already there: select it, nothing to undo
    if (!chord) { E.undo.pop(); E.sel.clear(); }
    const ex = p.tr.notes.find(x => x.n === BASE[E.diff] + p.off + lane && x.t === t);
    if (ex) E.sel.add(ex);
    draw();
  }
  E.lastPress = { ms: now, t, part: p };
  E.held[lane] = g && E.playing ? { g, s } : null;
}
function laneUp(lane, ms) {
  const h = E.held[lane]; E.held[lane] = null;
  if (!h || !E || !E.playing) return;
  let s = songTimeAt(ms);
  if (s < h.s && E.playLoop) s = E.playLoop.b;  // the loop wrapped while held: up to the loop end
  if (s - h.s < HOLD_S * E.rate) return;
  const end = snapT(s2t(s));
  if (end - h.g.t <= TAP_MAX) return;
  h.g.l = end - h.g.t;
  fixOverlaps(partOf(h.g) || focusPart()); markDirty();
}
// overdrive: while recording, the first press starts a phrase at the playhead and the second ends it; otherwise it
// toggles a phrase over the selected gems (like O)
function overdrivePress(ms) {
  if (E.recording && E.playing) {
    const t = snapT(s2t(songTimeAt(ms)));
    if (E.odStart == null) { E.odStart = t; E.odPart = focusPart(); toast("Overdrive phrase started: press again to end it"); draw(); return; }
    const p = E.odPart, a = Math.min(E.odStart, t), b = Math.max(E.odStart, t);
    E.odStart = null; E.odPart = null;
    if (b - a < E.tpb / 4) { draw(); return; }
    pushUndo(); p.tr.notes.push({ t: a, l: b - a, n: OD, v: 100, c: 0 }); markDirty(); toast("Overdrive phrase added");
    return;
  }
  if (!E.sel.size) { toast("Select gems first, or press it while recording to start and end a phrase.", true); return; }
  toggleSpan(OD);
}
// solo: on/off over the selected gems (like L)
function soloPress() {
  if (!E.sel.size) { toast("Select the gems of the solo first.", true); return; }
  toggleSpan(SOLO);
}
function setFocus(key) { E.focus = key; $("#focus").value = key; E.clickNext = rawPos(); E.odStart = null; renderShapes(); draw(); }
function setDiff(d) { E.diff = d; $("#diff").value = d; E.sel.clear(); renderDiff(); renderRules(); renderShapes(); draw(); }

// ---------- controller: Xbox and PlayStation (the browser's "standard" button layout is the same for both) ----------
const PAD_ACTIONS = [  // key, what it does, default button (standard index); gems: D-pad ← red, ↑ yellow, Y/△ blue, B/○ green
  ["lane0", "Red gem", 14], ["lane1", "Yellow gem", 12], ["lane2", "Blue gem", 3], ["lane3", "Green gem", 1],
  ["partPrev", "Part to the left", 4], ["partNext", "Part to the right", 5], ["od", "Overdrive", 0],
  ["play", "Play / pause", 9], ["rec", "Record on/off", 8], ["loop", "Loop on/off", 2], ["undo", "Undo", 6], ["redo", "Redo", 7],
  ["del", "Delete the selected gems", 13], ["home", "Back to the start", 10],
];
const PAD_NAMES = {
  playstation: ["✕", "○", "□", "△", "L1", "R1", "L2", "R2", "Share", "Options", "L3", "R3", "D-pad ↑", "D-pad ↓", "D-pad ←", "D-pad →", "PS", "Touchpad"],
  xbox: ["A", "B", "X", "Y", "LB", "RB", "LT", "RT", "View", "Menu", "LS", "RS", "D-pad ↑", "D-pad ↓", "D-pad ←", "D-pad →", "Xbox", "—"],
};
const PAD_STICKS = "Left stick ←/→: move the playhead by the snap · Right stick ↑/↓: difficulty · Right stick ←/→: zoom";
function padKind(gp) {
  const id = (gp && gp.id || "").toLowerCase();
  if (/xbox|xinput|045e/.test(id)) return "xbox";
  if (/playstation|dualshock|dualsense|054c|wireless controller/.test(id)) return "playstation";
  return null;
}
function padMap() {
  let m = {}; try { m = JSON.parse(localStorage["pe.padMap"] || "{}"); } catch { }
  return Object.fromEntries(PAD_ACTIONS.map(([k, , d]) => [k, Number.isInteger(m[k]) ? m[k] : d]));
}
function savePadMap(m) { try { localStorage["pe.padMap"] = JSON.stringify(m); } catch { } }
const padButtonName = (kind, i) => (PAD_NAMES[kind || "playstation"][i]) || `button ${i}`;
function renderPadBadge() {
  const b = $("#padBtn"); if (!b) return;
  const st = E.padState;
  b.textContent = st === "xbox" ? "🎮 Xbox" : st === "playstation" ? "🎮 PlayStation" : st === "unsupported" ? "🎮 Not supported" : "🎮";
  b.classList.toggle("on", st === "xbox" || st === "playstation");
  b.title = st === "unsupported" ? "This controller isn't supported: Pocket Encore supports Xbox and PlayStation controllers." : "Controller: layout, timing offset and calibration";
  b.setAttribute("aria-label", st === "xbox" ? "Controller: Xbox" : st === "playstation" ? "Controller: PlayStation" : st === "unsupported" ? "Controller: not supported" : "Controller");
}
function padPoll() {
  if (!E) return;
  const pads = navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean) : [];
  const gp = pads.find(padKind), state = gp ? padKind(gp) : pads.length ? "unsupported" : "";
  if (state !== E.padState) { E.padState = state; renderPadBadge(); if ($("#modalBox .padtable") && !$("#modal").classList.contains("hidden")) padDialog(); }
  if (!gp) { E.padPrev = null; return; }
  const now = gp.buttons.map(b => b.pressed), prev = E.padPrev || now.map(() => false), ts = gp.timestamp || performance.now();
  E.padPrev = now;
  // remapping in the dialog: the first newly pressed button
  if (E.padLearn && !$("#modalBox .padtable")) E.padLearn = null;  // the dialog was closed
  if (E.padLearn) { const i = now.findIndex((v, k) => v && !prev[k]); if (i >= 0) learnPad(i); return; }
  const modal = !$("#modal").classList.contains("hidden");
  const map = padMap();
  for (const [k] of PAD_ACTIONS) {
    const i = map[k], down = now[i] && !prev[i], up = !now[i] && prev[i];
    if (k.startsWith("lane")) {
      if (down && (!modal || E.calib)) laneDown(Number(k[4]), ts);
      if (up) laneUp(Number(k[4]), ts);
      continue;
    }
    if (!down || modal) continue;
    padAction(k, ts);
  }
  if (modal) return;
  // sticks: left X moves the playhead (repeats while held), right Y difficulty (once per push), right X zoom
  const ax = gp.axes || [], t = performance.now(), dead = 0.5;
  const lx = ax[0] || 0, rx = ax[2] || 0, ry = ax[3] || 0;
  if (Math.abs(lx) > dead && t >= (E.stickNext || 0)) {
    const d = Math.sign(lx) * (E.snap ? step() : E.tpb / 4);
    seek(Math.max(0, t2s(Math.max(0, s2t(pos()) + d))));
    keepPlayheadInView();
    E.stickNext = t + (Math.abs(lx) > 0.9 ? 70 : 160);
  } else if (Math.abs(lx) <= dead && Math.abs(rx) <= dead) E.stickNext = 0;
  if (Math.abs(rx) > dead && t >= (E.zoomNext || 0)) { zoom(rx > 0 ? 1.15 : 1 / 1.15, xOf(pos())); E.zoomNext = t + 90; }
  if (Math.abs(ry) > 0.6) { if (!E.ryHeld) { E.ryHeld = true; setDiff(Math.max(0, Math.min(3, E.diff + (ry < 0 ? 1 : -1)))); } }
  else E.ryHeld = false;
}
function keepPlayheadInView() {
  const x = xOf(pos());
  if (x < GUT + 20 || x > E.W - 40) { E.x0 = Math.max(0, pos() - (E.W - GUT) / E.pps * 0.3); draw(); }
}
function padAction(k, ts) {
  const keys = ["drums", "bass", "guitar", "vocals"];
  if (k === "partPrev" || k === "partNext") { const i = keys.indexOf(E.focus) + (k === "partNext" ? 1 : -1); if (i >= 0 && i < keys.length) setFocus(keys[i]); }
  else if (k === "od") overdrivePress(ts);
  else if (k === "play") E.playing ? stop() : play();
  else if (k === "rec") toggleRec();
  else if (k === "loop") toggleLoop();
  else if (k === "undo") undo();
  else if (k === "redo") redo();
  else if (k === "home") { seek(0); E.x0 = 0; draw(); }
  else if (k === "del" && E.sel.size) { pushUndo(); for (const p of E.parts) p.tr.notes = p.tr.notes.filter(n => !E.sel.has(n)); E.sel.clear(); markDirty(); }
}
function learnPad(i) {
  const m = padMap(), k = E.padLearn, other = Object.keys(m).find(x => x !== k && m[x] === i);
  if (other) m[other] = m[k];  // the button was used: the two actions swap buttons
  m[k] = i; savePadMap(m); E.padLearn = null; padDialog();
}
// the Controller dialog: layout for both controllers, remapping, timing offset and its calibration
function padDialog() {
  E.padDialog = true;
  const kind = E.padState === "xbox" || E.padState === "playstation" ? E.padState : null, m = padMap();
  const row = ([k, label]) => `<tr><td>${esc(label)}</td><td>${esc(padButtonName("playstation", m[k]))}</td><td>${esc(padButtonName("xbox", m[k]))}</td>
    <td>${E.padLearn === k ? `<b>press a button…</b>` : `<button class="small" data-learn="${k}" ${kind ? "" : "disabled"}>Change</button>`}</td></tr>`;
  $("#modalBox").innerHTML = `<b>Controller</b>
    <p class="small">${kind ? `Connected: <b>${kind === "xbox" ? "Xbox" : "PlayStation"} controller</b>.` : E.padState === "unsupported" ? `<span class="warnline">The connected controller isn't supported.</span>` : "No controller found: connect one and press any button."}
      Pocket Encore supports Xbox and PlayStation controllers. The gem, part and overdrive buttons follow the game's layout.</p>
    <table class="t padtable"><tr><th>Action</th><th>PlayStation</th><th>Xbox</th><th></th></tr>${PAD_ACTIONS.map(row).join("")}</table>
    <p class="small dim">${PAD_STICKS}. Press gem buttons together for a chord; hold one while playing for a held note. Overdrive while recording: press to start a phrase, press again to end it.</p>
    <div class="form" style="grid-template-columns:200px 1fr"><label>Timing offset (ms)</label><span class="inline"><input type="number" id="padOff" step="1" value="${inputOffset()}">
      <button id="padCal">Calibrate…</button><span class="small dim">for the controller and keys 1–4: + if your presses land late</span></span></div>
    <div id="calOut" class="small" style="margin-top:6px"></div>
    <div class="actions" style="margin-top:12px"><button id="padReset">Reset to the default layout</button><span class="grow"></span><button class="primary" id="padClose">Close</button></div>`;
  $("#modal").classList.remove("hidden");
  $("#modalBox").querySelectorAll("[data-learn]").forEach(b => b.onclick = () => { E.padLearn = b.dataset.learn; padDialog(); });
  $("#padOff").oninput = $("#padOff").onchange = e => { try { localStorage["pe.padOffset"] = String(Math.round(Number(e.target.value) || 0)); } catch { } };
  $("#padReset").onclick = () => { savePadMap({}); E.padLearn = null; padDialog(); };
  $("#padCal").onclick = calibrate;
  $("#padClose").onclick = () => { E.padLearn = null; E.calib = null; E.padDialog = false; $("#modal").classList.add("hidden"); };
}
// calibration: 8 clicks at 100 BPM; press any gem button (or key 1-4) on each. The median lateness becomes the offset.
function calibrate() {
  if (!E.ctx) { toast("The audio isn't loaded yet: try again in a moment.", true); return; }
  if (E.playing) stop();
  E.ctx.resume().catch(() => { });
  const beat = 0.6, n = 8, t0 = E.ctx.currentTime + 1;
  for (let i = 0; i < n; i++) {
    const w = t0 + i * beat, o = E.ctx.createOscillator(), g = E.ctx.createGain();
    o.frequency.value = i % 4 ? 1500 : 2000; o.connect(g); g.connect(E.ctx.destination);
    g.gain.setValueAtTime(0.6, w); g.gain.exponentialRampToValueAtTime(0.001, w + 0.05); o.start(w); o.stop(w + 0.06);
  }
  // the clicks in performance time (where the presses' time stamps are)
  const perfAt = w => performance.now() + (w - E.ctx.currentTime) * 1000;
  E.calib = { clicks: Array.from({ length: n }, (_, i) => perfAt(t0 + i * beat)), hits: [] };
  $("#calOut").textContent = "Listen: 8 clicks. Press a gem button (or key 1–4) on each click…";
  setTimeout(() => {
    if (!E || !E.calib) return;
    const d = E.calib.hits.sort((a, b) => a - b); E.calib = null;
    if (d.length < 4) { $("#calOut").textContent = `Only ${d.length} presses heard: try again and press on each click.`; return; }
    const med = Math.round(d[d.length >> 1]);
    try { localStorage["pe.padOffset"] = String(med); } catch { }
    $("#padOff").value = med;
    $("#calOut").textContent = `Your presses were ${Math.abs(med)} ms ${med >= 0 ? "late" : "early"} on average (${d.length} presses): offset set to ${med} ms.`;
  }, (1 + n * beat + 0.6) * 1000);
}
function calibPress(ms) {
  const c = E.calib, t = ms || performance.now();
  const near = c.clicks.reduce((a, b) => Math.abs(b - t) < Math.abs(a - t) ? b : a);
  if (Math.abs(t - near) < 300) c.hits.push(t - near);
}

// ---------- keys ----------
function onKeyUp(e) {
  if (!E) return;
  if (e.key >= "1" && e.key <= "4") laneUp(Number(e.key) - 1, e.timeStamp);
}
function onKey(e) {
  if (!E || /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName) && e.key !== "Escape") return;
  if (E.calib && e.key >= "1" && e.key <= "4") { e.preventDefault(); if (!e.repeat) calibPress(e.timeStamp); return; }
  if (!$("#modal").classList.contains("hidden")) return;
  if (e.key === "Escape" && E.rulesOpen) { setRulesOpen(false); $("#rulesBtn").focus(); return; }
  const k = e.key, ctrl = e.ctrlKey || e.metaKey;
  if (e.shiftKey && !ctrl && /^Digit[1-9]$/.test(e.code)) {  // Shift+n: shape n of the part, at the playhead
    const sh = (SHAPES[E.focus] || [])[Number(e.code.slice(5)) - 1];
    if (sh) { e.preventDefault(); placeShape(focusPart(), sh, snapT(s2t(pos()))); }
    return;
  }
  if (k >= "1" && k <= "4" && !ctrl) { e.preventDefault(); if (!e.repeat) laneDown(Number(k) - 1, e.timeStamp); return; }
  if ((k === "k" || k === "K") && !ctrl) { toggleLoop(); return; }
  if (k === " ") { e.preventDefault(); E.playing ? stop() : play(); return; }
  if (k === "Home") { seek(0); E.x0 = 0; draw(); return; }
  if (ctrl && k.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (ctrl && k.toLowerCase() === "y") { e.preventDefault(); redo(); return; }
  if (ctrl && k.toLowerCase() === "s") { e.preventDefault(); save(false); return; }
  if (ctrl && k.toLowerCase() === "a") { e.preventDefault(); E.sel = new Set(E.parts.flatMap(p => gemsOf(p))); draw(); return; }
  if (ctrl && k.toLowerCase() === "c") { copy(); return; }
  if (ctrl && k.toLowerCase() === "v") { paste(); return; }
  if (k === "r" || k === "R") { toggleRec(); return; }
  if (k === "Escape") { if (E.recording) toggleRec(); E.odStart = null; if (E.stamp) { E.stamp = null; renderShapes(); } E.sel.clear(); draw(); return; }
  if (k === "Delete" || k === "Backspace") {
    e.preventDefault();
    if (!E.sel.size) return;
    pushUndo();
    for (const p of E.parts) p.tr.notes = p.tr.notes.filter(n => !E.sel.has(n));
    E.sel.clear(); markDirty(); return;
  }
  if ((k === "f" || k === "F") && !ctrl) { if (!e.repeat) cycleView(); return; }
  if ((k === "o" || k === "O") && !ctrl) { if (!e.repeat) overdrivePress(e.timeStamp); return; }
  if ((k === "l" || k === "L") && !ctrl) { if (!e.repeat) soloPress(); return; }
  if (!E.sel.size) return;
  if (k === "ArrowLeft" || k === "ArrowRight") {
    e.preventDefault();
    const dt = (k === "ArrowLeft" ? -1 : 1) * (E.snap ? step() : E.tpb / 16);
    if ([...E.sel].some(n => n.t + dt < 0)) return;
    pushUndo(); for (const n of E.sel) n.t += dt; E.parts.forEach(fixOverlaps); markDirty(); return;
  }
  if (k === "ArrowUp" || k === "ArrowDown") {
    e.preventDefault();
    const dl = k === "ArrowUp" ? -1 : 1;
    if ([...E.sel].some(n => { const p = partOf(n), l = n.n - BASE[E.diff] - p.off + dl; return l < 0 || l > 3; })) return;
    pushUndo(); for (const n of E.sel) n.n += dl; E.parts.forEach(fixOverlaps); markDirty(); return;
  }
  if (k === "t" || k === "T") {
    pushUndo();
    for (const n of E.sel) {
      if (n.l > TAP_MAX) n.l = TAP_LEN;
      else n.l = Math.max(TAP_MAX + 1, Math.round(E.tpb * (E.snap ? 4 / E.snap : 1)));
    }
    E.parts.forEach(fixOverlaps); markDirty(); return;
  }
}
// overdrive phrase (116) or solo (103) over the selected gems of each part: remove the ones they touch, else add one.
// Only one part can have a solo at a time: a solo that would overlap another part's solo is not added.
function toggleSpan(note) {
  const byPart = new Map();
  for (const n of E.sel) { const p = partOf(n); if (!byPart.has(p)) byPart.set(p, []); byPart.get(p).push(n); }
  let changed = false;
  const change = () => { if (!changed) pushUndo(); changed = true; };
  for (const [p, gems] of byPart) {
    const a = Math.min(...gems.map(n => n.t)), b = Math.max(...gems.map(n => n.t + n.l));
    const spans = p.tr.notes.filter(n => n.n === note && n.t < b && n.t + n.l > a);
    if (spans.length) { change(); p.tr.notes = p.tr.notes.filter(n => !spans.includes(n)); continue; }
    const l = Math.max(note === SOLO ? E.tpb + 1 : 1, b - a);
    if (note === SOLO) {
      if (p.tr.notes.filter(n => n.n === SOLO).length >= 4) { toast(`The ${p.key} part already has 4 solos, the most the game allows. Remove one to add another.`, true); continue; }
      const other = E.parts.find(q => q !== p && q.tr.notes.some(n => n.n === SOLO && n.t < a + l && n.t + n.l > a));
      if (other) { toast(`Couldn't add the ${p.key} solo: the ${other.key} part has a solo at that time, and only one part can have a solo at a time.`, true); continue; }
    }
    change(); p.tr.notes.push({ t: a, l, n: note, v: 100, c: 0 });
  }
  if (changed) markDirty();
}
let clip = null;
function copy() {
  if (!E.sel.size) return;
  const sel = [...E.sel], t0 = Math.min(...sel.map(n => n.t));
  clip = sel.map(n => { const p = partOf(n); return { part: p.key, t: n.t - t0, l: n.l, lane: n.n - BASE[E.diff] - p.off }; });
}
function paste() {
  if (!clip) return;
  const at = snapT(s2t(pos()));
  pushUndo(); E.sel.clear();
  for (const c of clip) {
    const p = E.parts.find(q => q.key === c.part), g = { t: at + c.t, l: c.l, n: BASE[E.diff] + p.off + c.lane, v: 100, c: 0 };
    p.tr.notes.push(g); E.sel.add(g);
  }
  E.parts.forEach(fixOverlaps); markDirty();
}

// ---------- save ----------
async function save(rebuild) {
  if (!E) return;
  try {
    if (E.dirty) {
      E.parts.forEach(fixOverlaps);
      const r = await api("PUT", `/api/chart/${E.folder}`, { midi: E.midi, reduce: E.reduce });
      E.dirty = false; E.source = "edited"; E.S.chart = "chart.mid"; E.saved = true;
      if (!E.ghost && E.hasAuto) loadGhost(); else renderDiff();
    }
    updateButtons();
    toast(rebuild ? "Saved; rebuilding the chart…" : "Saved to songs/" + E.folder);
    if (rebuild) runBuild(E.folder, "chart");
    return true;
  } catch (e) { fail("Couldn't save the chart")(e); return false; }
}
window.editorSave = () => save(false);  // used by app.js before leaving the editor or building; resolves to true when saved
})();
