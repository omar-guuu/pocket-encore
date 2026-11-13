"use strict";
// Chart and effects editor: gems of the 4 parts on a time line with the stems' waveforms, audio playback, editing,
// overdrive, solos, screen effects, a highway preview and record mode. Gems live in a Rock Band-format MIDI (the
// REAPER export layout): PART DRUMS / BASS / GUITAR / KEYS (vocals), difficulty bases 60/72/84/96, drums one note
// higher; 116 = overdrive, 103 = solo; notes of 160 ticks or less are taps.
(() => {
const PART_TRACKS = [["drums", ["PART DRUMS"]], ["bass", ["PART BASS"]], ["guitar", ["PART GUITAR"]], ["vocals", ["PART KEYS", "PART VOCALS"]]];
const STEM_OF = { drums: "drums", bass: "bass_guitar", guitar: "lead_guitar", vocals: "vocals" };
const TRACKS = ["drums", "bass_guitar", "lead_guitar", "vocals", "fill"];
const TRACK_NAME = { drums: "Drums", bass_guitar: "Bass", lead_guitar: "Guitar", vocals: "Vocals", fill: "Backing" };
const BASE = [60, 72, 84, 96], OD = 116, SOLO = 103, TAP_MAX = 160, TAP_LEN = 60;
const LANE_COL = ["#e65050", "#e8c440", "#4a94ec", "#4cc466"];
const PART_COL = { drums: "#c86464", bass: "#6488d8", guitar: "#d89a48", vocals: "#58b078" };
const GUT = 78, RULER = 30, FXH = 30, HEAD = 14, LANE = 22, PART_H = HEAD + 4 * LANE, PAD = 6;
const H = RULER + FXH + 4 * (PART_H + PAD) + 4;
const HW_W = 230, HW_AHEAD = 2.5;  // highway: width, seconds shown above the strike line

let E = null;  // editor state

window.editorDirty = () => !!(E && (E.dirty || E.fxDirty));
window.editorState = () => E;  // for tests and the console
window.editorClose = () => { if (!E) return; stop(); clearInterval(E.timer); cancelAnimationFrame(E.raf); window.removeEventListener("keydown", E.onKey); window.removeEventListener("resize", E.onResize); window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); if (E.ctx) E.ctx.close(); E = null; };

window.openEditor = async (root, folder, details) => {
  window.editorClose();
  root.innerHTML = `<div class="panel">Loading chart…</div>`;
  let chart;
  try { chart = await api("GET", `/api/chart/${folder}`); }
  catch (e) { root.innerHTML = `<div class="panel">${esc(e.message)}</div>`; return; }
  const S = details.song;
  E = {
    folder, S, midi: chart.midi, source: chart.source, hasAuto: chart.hasAuto, tpb: chart.midi.tpb, lead: (chart.audio && chart.audio.lead) || 0,
    diff: 3, snap: 4, pps: 120, x0: 0, sel: new Set(), undo: [], redo: [], dirty: false, fxDirty: false, saved: false,
    fx: JSON.parse(JSON.stringify(details.effects || [])), fxSel: -1, reduce: S.chart ? !!S.reduce : true,
    ctx: null, bufs: {}, peaks: {}, gains: {}, vol: {}, mute: {}, solo: {}, srcs: [], playing: false, t0: 0, off: 0, rate: 1,
    focus: "guitar", ticks: false, clickNext: 0, length: (chart.audio && chart.audio.audioSeconds) || 0, drag: null, ghost: null, showGhost: false,
  };
  E.parts = PART_TRACKS.map(([key, names]) => {
    let tr = E.midi.tracks.find(t => names.includes(t.name));
    if (!tr) { tr = { name: names[0], notes: [], events: [{ t: 0, d: [0xff, 3, names[0].length, ...[...names[0]].map(c => c.charCodeAt(0))] }] }; E.midi.tracks.push(tr); }
    return { key, tr, off: key === "drums" ? 1 : 0 };
  });
  buildTempo();
  for (const t of TRACKS) { E.vol[t] = 1; E.mute[t] = false; E.solo[t] = false; }
  E.length = Math.max(E.length, ...E.parts.flatMap(p => p.tr.notes.map(n => t2s(n.t + n.l)))) || 60;
  renderShell(root, details);
  E.timer = setInterval(scheduleClicks, 25);
  if (sessionStorage.seekTo) { const s = Number(sessionStorage.seekTo); delete sessionStorage.seekTo; E.off = Math.max(0, s - 1); E.x0 = Math.max(0, s - 2); }
  draw();
  loadAudio();
  if (E.source === "edited" && E.hasAuto) loadGhost();
};

// ---------- tempo map ----------
function buildTempo() {
  const segs = [];
  for (const tr of E.midi.tracks) for (const e of tr.events) if (e.d[0] === 0xff && e.d[1] === 0x51) segs.push({ t: e.t, us: (e.d[3] << 16) | (e.d[4] << 8) | e.d[5] });
  segs.sort((a, b) => a.t - b.t);
  if (!segs.length || segs[0].t > 0) segs.unshift({ t: 0, us: 500000 });
  let s = 0;
  segs.forEach((g, i) => { if (i) s += (g.t - segs[i - 1].t) * segs[i - 1].us / 1e6 / E.tpb; g.s = s; });
  E.tempo = segs;
  // beat lines: the BEAT track if there is one (12 = downbeat, 13 = beat), else every beat with 4/4 bars
  const beat = E.midi.tracks.find(t => t.name === "BEAT");
  E.beats = beat && beat.notes.length ? beat.notes.map(n => ({ t: n.t, down: n.n === 12 })).sort((a, b) => a.t - b.t) : null;
}
function seg(t) { const T = E.tempo; let lo = 0, hi = T.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (T[m].t <= t) lo = m; else hi = m - 1; } return T[lo]; }
function t2s(t) { const g = seg(t); return g.s + (t - g.t) * g.us / 1e6 / E.tpb; }
function s2t(s) { const T = E.tempo; let g = T[0]; for (const x of T) if (x.s <= s) g = x; else break; return g.t + (s - g.s) * 1e6 * E.tpb / g.us; }
const step = () => E.snap ? E.tpb / E.snap : 1;
const snapT = t => E.snap ? Math.round(t / step()) * step() : Math.round(t);
function beatList(t0, t1) {
  if (E.beats) { const out = []; let n = 0; for (const b of E.beats) { if (b.down) n++; if (b.t >= t0 && b.t <= t1) out.push({ ...b, bar: n }); } return out; }
  const out = []; for (let t = Math.max(0, Math.floor(t0 / E.tpb)) * E.tpb; t <= t1; t += E.tpb) out.push({ t, down: (t / E.tpb) % 4 === 0, bar: Math.floor(t / E.tpb / 4) + 1 });
  return out;
}
function barPos(t) {
  const bs = beatList(0, t); if (!bs.length) return "";
  let bar = 0, bi = 0, last = bs[0];
  for (const b of bs) { if (b.down) { bar = b.bar; bi = 0; } else bi++; last = b; }
  return `${bar}.${bi + 1}.${String(Math.round(t - last.t)).padStart(3, "0")}`;
}
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
const partOf = n => E.parts.find(p => p.tr.notes.includes(n));
const focusPart = () => E.parts.find(p => p.key === E.focus);
function snapshot() { return { notes: E.parts.map(p => p.tr.notes.map(n => ({ ...n }))), fx: JSON.parse(JSON.stringify(E.fx)), tempo: null }; }
function fullSnapshot() { return { ...snapshot(), tempo: JSON.parse(JSON.stringify(E.midi.tracks.map(t => ({ notes: t.notes, events: t.events })))) }; }
function pushUndo(full) { E.undo.push(full ? fullSnapshot() : snapshot()); if (E.undo.length > 200) E.undo.shift(); E.redo = []; }
function restore(st) {
  if (st.tempo) { E.midi.tracks.forEach((t, i) => { t.notes = st.tempo[i].notes; t.events = st.tempo[i].events; }); E.parts.forEach(p => { p.tr = E.midi.tracks.find(t => t.name === p.tr.name) || p.tr; }); buildTempo(); }
  E.parts.forEach((p, i) => { p.tr.notes = st.notes[i]; });
  E.fx = st.fx; E.fxSel = -1; E.sel.clear(); E.dirty = true; E.fxDirty = true; renderFxPanel(); markDirty();
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
  } catch (e) { const el = $("#rules"); if (el) el.innerHTML = `<span class="dim small">rule check failed: ${esc(e.message)}</span>`; }
}
function renderRules() {
  const el = $("#rules");
  if (!el || !E.checks) return;
  const dis = dismissed(), cur = DIFFS[E.diff];
  const active = E.checks.filter(i => !dis.has(ruleKey(i)))
    .sort((a, b) => (a.level === "error" ? 0 : 1) - (b.level === "error" ? 0 : 1) || (a.diff === cur ? 0 : 1) - (b.diff === cur ? 0 : 1));
  const hidden = E.checks.length - active.length;
  if (!active.length) {
    el.className = "rules ok";
    el.innerHTML = `<span>✓ Within the official charts' ranges${hidden ? ` (${hidden} dismissed)` : ""}.</span>${hidden ? ' <button class="small" id="rulesShow">Show dismissed</button>' : ""}`;
  } else {
    const shown = E.rulesOpen ? active : active.slice(0, 2);
    el.className = "rules";
    el.innerHTML = `<div class="rhead"><b>${active.length} rule${active.length > 1 ? "s" : ""} outside the official charts' style</b>
      <span class="small dim">just a heads-up: the chart still saves and builds</span><span class="grow"></span>
      ${active.length > 2 ? `<button class="small" id="rulesMore">${E.rulesOpen ? "Show fewer" : `Show all ${active.length}`}</button>` : ""}
      <button class="small" id="rulesAll">Dismiss all</button>${hidden ? ` <button class="small" id="rulesShow">Show dismissed (${hidden})</button>` : ""}</div>
      ${shown.map(i => `<div class="rrow ${E.fresh && E.fresh.has(ruleKey(i)) ? "fresh" : ""}" data-key="${esc(ruleKey(i))}">
        <span class="badge ${i.level === "error" ? "bad" : "warn"}">${i.level === "error" ? "problem" : "rule"}</span>
        ${i.part ? `<b>${esc(i.part)}</b>` : ""} <span>${esc(i.msg)}</span>
        ${i.at != null ? `<a href="#" data-at="${i.at}" class="small">go</a>` : ""}<span class="grow"></span>
        <button class="small rx" title="Dismiss: hide this warning for this song">×</button></div>`).join("")}`;
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
  const more = el.querySelector("#rulesMore"); if (more) more.onclick = () => { E.rulesOpen = !E.rulesOpen; renderRules(); };
  const show = el.querySelector("#rulesShow"); if (show) show.onclick = () => { saveDismissed(new Set()); renderRules(); };
  E.fresh = new Set();
}
function fxChanged() { E.fxDirty = true; updateButtons(); renderFxPanel(); draw(); }
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
async function loadAudio() {
  const st = $("#audioState");
  try {
    E.ctx = new AudioContext();
    E.master = E.ctx.createGain(); E.master.connect(E.ctx.destination);
    E.clickGain = E.ctx.createGain(); E.clickGain.gain.value = 0.5; E.clickGain.connect(E.ctx.destination);
    for (const t of TRACKS) { E.gains[t] = E.ctx.createGain(); E.gains[t].connect(E.master); }
    let i = 0;
    for (const t of TRACKS) {
      if (!E) return;
      st.textContent = `loading audio ${++i}/5…`;
      const r = await fetch(`/api/audio/${E.folder}/${t}`);
      if (!r.ok) { st.textContent = "no audio: build the song once"; continue; }
      const buf = await E.ctx.decodeAudioData(await r.arrayBuffer());
      if (!E) return;
      E.bufs[t] = buf; E.peaks[t] = peaks(buf);
      E.length = Math.max(E.length, buf.duration);
      draw();
    }
    st.textContent = "";
    applyGains();
  } catch (e) { st.textContent = "audio: " + e.message; }
}
function peaks(buf) {  // max |sample| per 1/200 s
  const x = buf.getChannelData(0), hop = buf.sampleRate / 200, n = Math.floor(x.length / hop), p = new Float32Array(n);
  for (let i = 0; i < n; i++) { let m = 0; const a = Math.floor(i * hop), b = Math.floor((i + 1) * hop); for (let k = a; k < b; k++) { const v = Math.abs(x[k]); if (v > m) m = v; } p[i] = m; }
  return p;
}
function applyGains() {
  if (!E.ctx) return;
  const anySolo = TRACKS.some(t => E.solo[t]);
  for (const t of TRACKS) E.gains[t].gain.value = E.mute[t] || (anySolo && !E.solo[t]) ? 0 : E.vol[t];
}
const pos = () => E.playing ? E.off + (E.ctx.currentTime - E.t0) * E.rate : E.off;
function play() {
  if (!E.ctx || E.playing) return;
  E.ctx.resume();
  E.srcs = TRACKS.filter(t => E.bufs[t]).map(t => {
    const s = E.ctx.createBufferSource(); s.buffer = E.bufs[t]; s.playbackRate.value = E.rate; s.connect(E.gains[t]); s.start(0, Math.max(0, E.off)); return s;
  });
  E.t0 = E.ctx.currentTime; E.playing = true; E.clickNext = E.off;
  $("#play").textContent = "❚❚ Pause";
  loop();
}
function stop() {
  if (!E || !E.playing) return;
  E.off = pos(); E.srcs.forEach(s => { try { s.stop(); } catch { } }); E.srcs = []; E.playing = false;
  $("#play").textContent = "▶ Play";
  draw();
}
function seek(s) {
  s = Math.max(0, Math.min(E.length, s));
  const was = E.playing; stop(); E.off = s; if (was) play(); else draw();
}
function loop() {
  if (!E || !E.playing) return;
  const p = pos();
  if (p >= E.length) { stop(); E.off = E.length; return; }
  const W = E.W - GUT, ps = (p - E.x0) * E.pps;
  if (ps > W * 0.85 || ps < 0) E.x0 = Math.max(0, p - (W * 0.15) / E.pps);
  draw();
  E.raf = requestAnimationFrame(loop);
}
function scheduleClicks() {
  if (!E || !E.playing || !E.ticks) return;
  const p = focusPart(), now = pos(), until = now + 0.2 * E.rate;
  if (E.clickNext < now - 0.05) E.clickNext = now;
  for (const n of gemsOf(p)) {
    const s = t2s(n.t);
    if (s < E.clickNext || s >= until) continue;
    const when = E.t0 + (s - E.off) / E.rate;
    if (when < E.ctx.currentTime) continue;
    const o = E.ctx.createOscillator(), g = E.ctx.createGain();
    o.frequency.value = 1500 + 300 * laneOf(p, n); o.connect(g); g.connect(E.clickGain);
    g.gain.setValueAtTime(0.9, when); g.gain.exponentialRampToValueAtTime(0.001, when + 0.04);
    o.start(when); o.stop(when + 0.05);
  }
  E.clickNext = until;
}

// ---------- layout ----------
const xOf = s => GUT + (s - E.x0) * E.pps;
const sOf = x => E.x0 + (x - GUT) / E.pps;
const partY = i => RULER + FXH + i * (PART_H + PAD) + 4;
function hit(x, y) {
  if (y < RULER) return { zone: "ruler" };
  if (y < RULER + FXH) return { zone: "fx" };
  for (let i = 0; i < 4; i++) {
    const y0 = partY(i);
    if (y >= y0 && y < y0 + HEAD) return { zone: "head", part: E.parts[i] };
    if (y >= y0 + HEAD && y < y0 + PART_H) return { zone: "lane", part: E.parts[i], lane: Math.floor((y - y0 - HEAD) / LANE) };
  }
  return { zone: "none" };
}
function gemAt(x, y) {
  const h = hit(x, y);
  if (h.zone !== "lane" || x < GUT) return null;
  const p = h.part, base = BASE[E.diff] + p.off + h.lane;
  let best = null;
  for (const n of p.tr.notes) {
    if (n.n !== base) continue;
    const a = xOf(t2s(n.t)), b = n.l > TAP_MAX ? xOf(t2s(n.t + n.l)) : a + 9;
    if (x >= a - 4 && x <= Math.max(b, a + 9) + 2) { best = { n, p, edge: n.l > TAP_MAX ? x > b - 6 : x > a + 5 }; }
  }
  return best;
}

// ---------- drawing ----------
function draw() {
  if (!E || !E.cv) return;
  const c = E.g, W = E.W;
  c.clearRect(0, 0, W, H);
  c.fillStyle = "#111318"; c.fillRect(0, 0, W, H);
  const s0 = E.x0, s1 = sOf(W), t0 = s2t(Math.max(0, s0)), t1 = s2t(s1);
  // grid
  const beats = beatList(t0 - E.tpb, t1 + E.tpb);
  const stepPx = E.pps * (seg(t0).us / 1e6) / (E.snap || 4);
  if (E.snap > 1 && stepPx > 7) {
    c.strokeStyle = "#1c2028"; c.beginPath();
    for (let t = Math.floor(t0 / step()) * step(); t <= t1; t += step()) { const x = Math.round(xOf(t2s(t))) + .5; c.moveTo(x, RULER); c.lineTo(x, H); }
    c.stroke();
  }
  for (const b of beats) {
    const x = Math.round(xOf(t2s(b.t))) + .5;
    if (x < GUT) continue;
    c.strokeStyle = b.down ? "#3c4352" : "#262b35"; c.beginPath(); c.moveTo(x, RULER - (b.down ? 12 : 5)); c.lineTo(x, H); c.stroke();
    if (b.down && E.pps * 2 > 40) { c.fillStyle = "#9aa1ad"; c.font = "11px Segoe UI"; c.fillText(String(b.bar), x + 3, 12); }
  }
  // ruler seconds
  c.fillStyle = "#6c7380"; c.font = "10px Segoe UI";
  const secStep = [1, 2, 5, 10, 15, 30, 60].find(v => v * E.pps > 60) || 60;
  for (let s = Math.ceil(s0 / secStep) * secStep; s < s1; s += secStep) { const x = xOf(s); if (x > GUT) c.fillText(fmtTime(s).replace(/\.0$/, ""), x + 2, RULER - 3); }
  // effects lane
  const fy = RULER;
  c.fillStyle = "#181b21"; c.fillRect(GUT, fy, W - GUT, FXH - 2);
  wave("fill", fy, FXH - 2, "#2c3140");
  E.fx.forEach((f, i) => {
    const a = xOf(f.from + E.lead), b = f.to != null ? xOf(f.to + E.lead) : xOf(E.length);
    if (b < GUT || a > W) return;
    c.fillStyle = i === E.fxSel ? "rgba(240,160,48,.55)" : "rgba(180,110,240,.38)";
    c.fillRect(a, fy + 3, Math.max(3, b - a), FXH - 8);
    c.strokeStyle = i === E.fxSel ? "#f0a030" : "#b46ef0"; c.strokeRect(a + .5, fy + 3.5, Math.max(3, b - a) - 1, FXH - 9);
    c.fillStyle = "#fff"; c.font = "11px Segoe UI"; c.fillText((f.effect || "cmd " + f.cmd) + (f.to == null ? " →" : ""), Math.max(a, GUT) + 4, fy + 18);
  });
  // parts
  E.parts.forEach((p, i) => {
    const y0 = partY(i);
    c.fillStyle = p.key === E.focus ? "#1a1d24" : "#171a20"; c.fillRect(GUT, y0, W - GUT, PART_H);
    wave(STEM_OF[p.key], y0 + HEAD, 4 * LANE, PART_COL[p.key] + "40");
    for (let l = 1; l < 4; l++) { c.strokeStyle = "#20242c"; c.beginPath(); c.moveTo(GUT, y0 + HEAD + l * LANE + .5); c.lineTo(W, y0 + HEAD + l * LANE + .5); c.stroke(); }
    // overdrive and solo markers (shared by every difficulty)
    const od = [];
    for (const n of p.tr.notes) {
      if (n.n !== OD && n.n !== SOLO) continue;
      const a = xOf(t2s(n.t)), b = xOf(t2s(n.t + n.l));
      if (n.n === OD) od.push(n);
      if (b < GUT || a > W) continue;
      if (n.n === SOLO) { c.fillStyle = "rgba(240,160,48,.10)"; c.fillRect(a, y0 + HEAD, b - a, 4 * LANE); c.fillStyle = "#f0a030"; c.fillRect(a, y0 + 1, b - a, 4); c.font = "9px Segoe UI"; c.fillText("solo", Math.max(a, GUT) + 2, y0 + 12); }
      else { c.fillStyle = "#6fd8ff"; c.fillRect(a, y0 + 7, Math.max(2, b - a), 4); }
    }
    const inOd = n => od.some(o => n.t >= o.t && n.t < o.t + o.l);
    if (E.showGhost && E.ghost) {  // removed gems of the automatic chart, as outlines
      const base = BASE[E.diff] + p.off, cur = new Set(p.tr.notes.map(n => `${n.t}:${n.n}`));
      for (const n of E.ghost[i].notes) {
        if (n.n < base || n.n >= base + 4 || cur.has(`${n.t}:${n.n}`)) continue;
        const a = xOf(t2s(n.t)); if (a < GUT - 10 || a > W) continue;
        const l = n.n - base, y = y0 + HEAD + l * LANE;
        c.strokeStyle = LANE_COL[l]; c.setLineDash([2, 2]); c.strokeRect(a + .5, y + 3.5, 9, LANE - 7); c.setLineDash([]);
      }
    }
    for (const n of gemsOf(p)) {
      const a = xOf(t2s(n.t));
      const sus = n.l > TAP_MAX, b = sus ? xOf(t2s(n.t + n.l)) : a;
      if (b < GUT - 10 || a > W) continue;
      const l = laneOf(p, n), y = y0 + HEAD + l * LANE, sel = E.sel.has(n);
      c.fillStyle = LANE_COL[l];
      if (sus) { c.globalAlpha = .55; c.fillRect(a, y + LANE / 2 - 3, b - a, 6); c.globalAlpha = 1; }
      c.fillRect(a, y + 3, 9, LANE - 6);
      if (inOd(n)) { c.strokeStyle = "#6fd8ff"; c.lineWidth = 2; c.strokeRect(a - 1, y + 2, 11, LANE - 4); c.lineWidth = 1; }
      if (sel) { c.strokeStyle = "#fff"; c.lineWidth = 2; c.strokeRect(a - 2, y + 1, Math.max(13, b - a + 4), LANE - 2); c.lineWidth = 1; }
    }
    // gutter label
    c.fillStyle = p.key === E.focus ? "#262a33" : "#1e2128"; c.fillRect(0, y0, GUT - 2, PART_H);
    c.fillStyle = PART_COL[p.key]; c.font = "bold 12px Segoe UI"; c.fillText(p.key, 8, y0 + 12);
    for (let l = 0; l < 4; l++) { c.fillStyle = LANE_COL[l]; c.fillRect(GUT - 14, y0 + HEAD + l * LANE + 5, 8, LANE - 10); if (p.key === E.focus) { c.fillStyle = "#9aa1ad"; c.font = "9px Segoe UI"; c.fillText(String(l + 1), GUT - 24, y0 + HEAD + l * LANE + 15); } }
    c.fillStyle = "#6c7380"; c.font = "10px Segoe UI"; c.fillText(`${gemsOf(p).length} gems`, 8, y0 + 30);
  });
  c.fillStyle = "#1e2128"; c.fillRect(0, 0, GUT - 2, RULER + FXH);
  c.fillStyle = "#9aa1ad"; c.font = "11px Segoe UI"; c.fillText("bar / time", 8, 18); c.fillText("effects", 8, RULER + 18);
  // rubber band
  if (E.drag && E.drag.mode === "band") {
    const d = E.drag; c.strokeStyle = "#f0a030"; c.setLineDash([4, 3]);
    c.strokeRect(Math.min(d.x, d.cx) + .5, Math.min(d.y, d.cy) + .5, Math.abs(d.cx - d.x), Math.abs(d.cy - d.y)); c.setLineDash([]);
  }
  // playhead
  const px = xOf(pos());
  if (px >= GUT && px <= W) { c.strokeStyle = "#fff"; c.beginPath(); c.moveTo(px + .5, 0); c.lineTo(px + .5, H); c.stroke(); }
  drawOverview();
  drawHighway();
  updateStatus();
}
function wave(track, y, h, col) {
  const pk = E.peaks[track];
  if (!pk) return;
  const c = E.g, mid = y + h / 2;
  c.fillStyle = col;
  for (let x = GUT; x < E.W; x++) {
    const a = Math.floor(sOf(x) * 200), b = Math.max(a + 1, Math.floor(sOf(x + 1) * 200));
    if (a < 0 || a >= pk.length) continue;
    let m = 0; for (let k = a; k < b && k < pk.length; k++) if (pk[k] > m) m = pk[k];
    const v = Math.min(1, Math.sqrt(m)) * h / 2;
    c.fillRect(x, mid - v, 1, 2 * v);
  }
}
function drawOverview() {
  const c = E.og, W = E.W, h = 34;
  c.fillStyle = "#0e1014"; c.fillRect(0, 0, W, h);
  const L = E.length || 1, k = W / L;
  for (const p of E.parts) {
    c.fillStyle = PART_COL[p.key] + "90";
    const i = E.parts.indexOf(p);
    for (const n of gemsOf(p)) c.fillRect(Math.floor(t2s(n.t) * k), 3 + i * 7, 1, 6);
  }
  E.fx.forEach(f => { c.fillStyle = "rgba(180,110,240,.5)"; const a = (f.from + E.lead) * k, b = (f.to != null ? f.to + E.lead : L) * k; c.fillRect(a, h - 4, Math.max(2, b - a), 3); });
  c.strokeStyle = "#f0a030"; c.strokeRect(E.x0 * k + .5, .5, Math.max(4, (W - GUT) / E.pps * k), h - 1);
  c.fillStyle = "#fff"; c.fillRect(pos() * k, 0, 1, h);
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
  c.fillStyle = "#6c7380"; c.font = "10px Segoe UI"; c.fillText(E.recording ? "● REC: keys 1-4 add gems" : "keys 1-4 add gems here", 8, Hd - 8);
}

// ---------- shell ----------
function renderShell(root, details) {
  const opts = (list, cur) => list.map(([v, n]) => `<option value="${v}" ${String(v) === String(cur) ? "selected" : ""}>${n}</option>`).join("");
  root.innerHTML = `
  <div class="edbar">
    <button id="play" class="primary" style="min-width:86px">▶ Play</button><button id="toStart" title="Home">⏮</button>
    <span id="time"></span>
    <select id="rate" title="Playback speed (changes pitch)">${opts([[1, "100%"], [0.75, "75%"], [0.5, "50%"]], 1)}</select>
    <span class="sep"></span>
    <select id="diff">${opts([[3, "Expert"], [2, "Hard"], [1, "Medium"], [0, "Easy"]], 3)}</select>
    <label class="small dim">snap</label><select id="snap">${opts([[1, "1 beat"], [2, "1/2"], [3, "1/3"], [4, "1/4"], [6, "1/6"], [8, "1/8"], [0, "off"]], 4)}</select>
    <button id="zoomOut" title="Zoom out (Ctrl+wheel)">−</button><button id="zoomIn" title="Zoom in (Ctrl+wheel)">+</button>
    <span class="sep"></span>
    <label class="small dim">part</label><select id="focus" title="The part the highway shows, the ticks follow and keys 1-4 record into">${opts([["drums", "drums"], ["bass", "bass"], ["guitar", "guitar"], ["vocals", "vocals"]], "guitar")}</select>
    <label class="small"><input type="checkbox" id="ticks"> ticks</label>
    <button id="rec" title="Record mode: while playing, keys 1-4 add gems to the part at the playhead (R)">● Record</button>
    <span class="sep"></span>
    <button id="undo" title="Ctrl+Z">Undo</button><button id="redo" title="Ctrl+Y">Redo</button>
    <button id="tempoBtn" title="Set a constant tempo or shift every gem">Tempo…</button>
    <span class="grow"></span>
    <span id="srcBadge"></span>
    <button id="saveEd" class="primary">Save</button><button id="saveBuildEd">Save + rebuild chart</button>
  </div>
  <div class="mixer">${TRACKS.map(t => `<span class="ch"><b>${TRACK_NAME[t]}</b><button data-m="${t}" title="mute">M</button><button data-s="${t}" title="solo">S</button><input type="range" min="0" max="1.5" step="0.05" value="1" data-v="${t}"></span>`).join("")}
    <span class="ch"><b>Ticks</b><input type="range" min="0" max="1" step="0.05" value="0.5" id="clickVol"></span><span id="audioState" class="dim"></span></div>
  <div id="rules" class="rules ok"><span class="dim small">checking the chart against the official charts' rules…</span></div>
  <div class="edmain"><div class="canvaswrap" id="cvwrap"><canvas id="cv"></canvas><canvas id="overview"></canvas></div><canvas id="highway"></canvas></div>
  <div class="edfoot">
    <div class="panel" style="flex:1"><div id="status"></div><div id="reduceLine" class="warnline"></div>
      <label class="small"><input type="checkbox" id="reduce" ${E.reduce ? "checked" : ""}> Easy, Medium and Hard are made from Expert at build time (only Expert edits count)</label>
      <div id="diffBox" class="diffbox" style="margin-top:6px"></div></div>
    <div class="panel" id="fxPanel" style="width:340px"></div>
    <div class="panel keys" style="width:390px">
      <kbd>Space</kbd> play/pause · click ruler = seek · <kbd>Home</kbd> start · <kbd>R</kbd> record mode<br>
      <kbd>1</kbd>–<kbd>4</kbd> add a gem in that lane of the part at the playhead (also while playing)<br>
      click a lane = add gem · drag = move · drag the right end = hold length<br>
      drag on empty space or a part's title = select area · <kbd>Shift</kbd>/<kbd>Ctrl</kbd>+click = add to selection<br>
      <kbd>Del</kbd> delete · <kbd>←</kbd><kbd>→</kbd> move by snap · <kbd>↑</kbd><kbd>↓</kbd> lane · <kbd>T</kbd> tap/hold<br>
      <kbd>O</kbd> overdrive phrase on/off · <kbd>L</kbd> solo on/off for the selection · <kbd>Ctrl</kbd>+<kbd>C</kbd>/<kbd>V</kbd> copy/paste at the playhead<br>
      effects lane: double-click = new effect, drag body/edges, <kbd>Del</kbd> delete · wheel = scroll · <kbd>Ctrl</kbd>+wheel = zoom
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
  $("#diff").onchange = e => { E.diff = Number(e.target.value); E.sel.clear(); renderDiff(); renderRules(); draw(); };
  $("#snap").onchange = e => { E.snap = Number(e.target.value); draw(); };
  $("#zoomIn").onclick = () => zoom(1.5, GUT + (E.W - GUT) / 2);
  $("#zoomOut").onclick = () => zoom(1 / 1.5, GUT + (E.W - GUT) / 2);
  $("#focus").onchange = e => { E.focus = e.target.value; E.clickNext = pos(); draw(); };
  $("#ticks").onchange = e => { E.ticks = e.target.checked; E.clickNext = pos(); };
  $("#rec").onclick = toggleRec;
  $("#clickVol").oninput = e => { if (E.clickGain) E.clickGain.gain.value = Number(e.target.value); };
  $("#undo").onclick = undo; $("#redo").onclick = redo;
  $("#tempoBtn").onclick = tempoDialog;
  $("#reduce").onchange = e => { E.reduce = e.target.checked; E.dirty = true; updateButtons(); draw(); scheduleChecks(); };
  $("#saveEd").onclick = () => save(false);
  $("#saveBuildEd").onclick = () => save(true);
  document.querySelectorAll("[data-m]").forEach(b => b.onclick = () => { const t = b.dataset.m; E.mute[t] = !E.mute[t]; b.classList.toggle("on", E.mute[t]); applyGains(); });
  document.querySelectorAll("[data-s]").forEach(b => b.onclick = () => { const t = b.dataset.s; E.solo[t] = !E.solo[t]; b.classList.toggle("on", E.solo[t]); applyGains(); });
  document.querySelectorAll("[data-v]").forEach(r => r.oninput = () => { E.vol[r.dataset.v] = Number(r.value); applyGains(); });
  E.cv.addEventListener("mousedown", onDown);
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
  E.cv.addEventListener("dblclick", onDbl);
  E.cv.addEventListener("wheel", onWheel, { passive: false });
  E.cv.addEventListener("mousemove", e => { if (!E.drag) { const r = E.cv.getBoundingClientRect(), g = gemAt(e.clientX - r.left, e.clientY - r.top); E.cv.style.cursor = g && g.edge ? "ew-resize" : fxAt(e.clientX - r.left, e.clientY - r.top)?.edge ? "ew-resize" : "default"; } });
  const ovNav = e => { const r = E.ov.getBoundingClientRect(), s = (e.clientX - r.left) / E.W * E.length; E.x0 = Math.max(0, s - (E.W - GUT) / E.pps / 2); draw(); };
  E.ov.addEventListener("mousedown", e => { ovNav(e); const mv = ev => ovNav(ev), up = () => { window.removeEventListener("mousemove", mv); window.removeEventListener("mouseup", up); }; window.addEventListener("mousemove", mv); window.addEventListener("mouseup", up); });
  E.hw.addEventListener("mousedown", e => { const r = E.hw.getBoundingClientRect(); const l = Math.floor((e.clientX - r.left - 24) / ((HW_W - 48) / 4)); if (l >= 0 && l < 4) recordGem(l); });
  E.onKey = onKey;
  window.addEventListener("keydown", E.onKey);
  updateButtons(); renderFxPanel(); renderDiff(); runChecks();
}
function toggleRec() { E.recording = !E.recording; $("#rec").classList.toggle("on", E.recording); if (E.recording && !E.playing) play(); draw(); }
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
  const dirty = E.dirty || E.fxDirty;
  $("#saveEd").disabled = !dirty;
  $("#srcBadge").innerHTML = (E.source === "edited" ? `<span class="badge ok" title="songs/${E.folder}/${esc(E.S.chart || "chart.mid")}">edited chart</span>` : `<span class="badge" title="the chart of the last build; saving makes it songs/${E.folder}/chart.mid">automatic chart</span>`)
    + (E.saved && !dirty ? ' <span class="badge warn" title="Saved, but the game files are from the last build">rebuild needed</span>' : "");
  $("#reduceLine").textContent = E.reduce && E.diff !== 3 ? "This difficulty is remade from Expert at build time; edits here are not used." : "";
}
function updateStatus() {
  const p = pos(), st = $("#status");
  $("#time").textContent = `${fmtTime(p)}  ·  bar ${barPos(s2t(p))}`;
  if (!st) return;
  const sel = [...E.sel];
  if (!sel.length) { st.textContent = "No selection."; return; }
  const n0 = sel.reduce((a, b) => a.t < b.t ? a : b), parts = new Set(sel.map(n => partOf(n)?.key));
  st.textContent = `${sel.length} gem${sel.length > 1 ? "s" : ""} selected (${[...parts].join(", ")}) · first at ${t2s(n0.t).toFixed(3)} s, bar ${barPos(n0.t)}` +
    (sel.length === 1 ? ` · ${n0.l > TAP_MAX ? "hold " + (n0.l / E.tpb).toFixed(2) + " beats" : "tap"}` : "");
}
function zoom(f, x) {
  const s = sOf(x);
  E.pps = Math.max(8, Math.min(2000, E.pps * f));
  E.x0 = Math.max(0, s - (x - GUT) / E.pps);
  draw();
}
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
    if (!(b > 20 && b < 400) || !(f >= 0)) return toast("BPM 20-400 and a first beat ≥ 0", true);
    pushUndo(true); setConstantTempo(b, f); E.sel.clear(); markDirty(); $("#modal").classList.add("hidden"); toast(`Grid set to ${b} BPM from ${f} s`);
  };
  $("#t_shiftBtn").onclick = () => {
    const ms = Number($("#t_shift").value);
    if (!ms) return;
    pushUndo(true);
    if (!shiftAll(ms)) { E.undo.pop(); return toast("That would move gems before the start", true); }
    E.sel.clear(); markDirty(); $("#modal").classList.add("hidden"); toast(`All gems shifted by ${ms} ms`);
  };
}

// ---------- mouse ----------
function fxAt(x, y) {
  if (y < RULER || y >= RULER + FXH) return null;
  for (let i = E.fx.length - 1; i >= 0; i--) {
    const f = E.fx[i], a = xOf(f.from + E.lead), b = f.to != null ? xOf(f.to + E.lead) : xOf(E.length);
    if (x >= a - 4 && x <= b + 4) return { i, edge: Math.abs(x - a) < 6 ? "from" : f.to != null && Math.abs(x - b) < 6 ? "to" : null };
  }
  return null;
}
function local(e) { const r = E.cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
function onDown(e) {
  if (e.button !== 0) return;
  const [x, y] = local(e), h = hit(x, y);
  e.preventDefault();
  if (x < GUT) { if (h.zone === "lane" || h.zone === "head") { E.focus = h.part.key; $("#focus").value = E.focus; draw(); } return; }
  if (h.zone === "ruler") { seek(sOf(x)); E.drag = { mode: "seek" }; return; }
  if (h.zone === "fx") {
    const f = fxAt(x, y);
    E.fxSel = f ? f.i : -1; renderFxPanel();
    if (f) E.drag = { mode: "fx", i: f.i, edge: f.edge, x, orig: { ...E.fx[f.i] }, undo: snapshot(), changed: false };
    draw(); return;
  }
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
  if (d.mode === "seek") { seek(sOf(x)); return; }
  if (d.mode === "fx") {
    const f = E.fx[d.i], ds = (x - d.x) / E.pps, r = v => Math.round(v * 100) / 100;
    if (d.edge === "from") f.from = r(Math.max(-E.lead, Math.min(d.orig.to != null ? d.orig.to - 0.1 : 1e9, d.orig.from + ds)));
    else if (d.edge === "to") f.to = r(Math.max(d.orig.from + 0.1, d.orig.to + ds));
    else { f.from = r(Math.max(-E.lead, d.orig.from + ds)); if (d.orig.to != null) f.to = r(f.from + (d.orig.to - d.orig.from)); }
    d.changed = true; E.fxDirty = true; updateButtons(); renderFxPanel(); draw(); return;
  }
  if (d.mode === "band") { d.cx = x; d.cy = y; bandSelect(); draw(); return; }
  if (d.mode === "move") {
    const dt = snapT(s2t(sOf(x)) - s2t(sOf(d.x)) + (d.orig.get(d.gem).t)) - d.orig.get(d.gem).t;
    const h = hit(x, y), dl = h.zone === "lane" && h.part === d.part ? h.lane - Math.floor((d.y - partY(E.parts.indexOf(d.part)) - HEAD) / LANE) : 0;
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
  if (d.mode === "band" && d.noAdd && Math.abs(d.cx - d.x) < 4 && Math.abs(d.cy - d.y) < 4) { E.sel = d.base; draw(); return; }
  if (d.mode === "band" && Math.abs(d.cx - d.x) < 4 && Math.abs(d.cy - d.y) < 4) {
    // a click on an empty lane: new gem
    const t = snapT(s2t(sOf(d.x))), p = d.part;
    if (t < 0) return draw();
    pushUndo();
    const g = addGem(p, d.lane, t);
    if (g) { E.sel.clear(); E.sel.add(g); }
    fixOverlaps(p); markDirty(); return;
  }
  if ((d.mode === "move" || d.mode === "resize") && d.changed) {
    E.undo.push(d.undo); E.redo = [];
    E.parts.forEach(fixOverlaps); markDirty(); return;
  }
  if (d.mode === "fx") {
    if (d.changed) { E.undo.push(d.undo); E.redo = []; }
    E.fx.sort((a, b) => a.from - b.from); E.fxSel = E.fx.indexOf(E.fx.find(f => f.from === d.orig.from && f.effect === d.orig.effect) || E.fx[d.i]);
    updateButtons(); renderFxPanel();
  }
  draw();
}
function bandSelect() {
  const d = E.drag, xa = Math.min(d.x, d.cx), xb = Math.max(d.x, d.cx), ya = Math.min(d.y, d.cy), yb = Math.max(d.y, d.cy);
  E.sel = new Set(d.base);
  E.parts.forEach((p, i) => {
    for (const n of gemsOf(p)) {
      const x = xOf(t2s(n.t)), y = partY(i) + HEAD + laneOf(p, n) * LANE + LANE / 2;
      if (x + 9 >= xa && x <= xb && y >= ya && y <= yb) E.sel.add(n);
    }
  });
}
function onDbl(e) {
  const [x, y] = local(e), h = hit(x, y);
  if (h.zone !== "fx" || x < GUT || fxAt(x, y)) return;
  const at = Math.round((sOf(x) - E.lead) * 100) / 100;
  pushUndo();
  E.fx.push({ effect: localStorage.lastFx || "oldfilm", from: at, to: Math.round((at + 8) * 100) / 100 });
  E.fx.sort((a, b) => a.from - b.from);
  E.fxSel = E.fx.findIndex(f => f.from === at);
  fxChanged();
}
function onWheel(e) {
  e.preventDefault();
  const [x] = local(e);
  if (e.ctrlKey) zoom(e.deltaY < 0 ? 1.2 : 1 / 1.2, Math.max(GUT, x));
  else { E.x0 = Math.max(0, Math.min(E.length, E.x0 + (e.deltaY + e.deltaX) / E.pps * 0.8)); draw(); }
}

// ---------- keys ----------
function onKey(e) {
  if (!E || /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName) && e.key !== "Escape") return;
  if (!$("#modal").classList.contains("hidden")) return;
  const k = e.key, ctrl = e.ctrlKey || e.metaKey;
  if (k >= "1" && k <= "4" && !ctrl) { e.preventDefault(); recordGem(Number(k) - 1); return; }
  if (k === " ") { e.preventDefault(); E.playing ? stop() : play(); return; }
  if (k === "Home") { seek(0); E.x0 = 0; draw(); return; }
  if (ctrl && k.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (ctrl && k.toLowerCase() === "y") { e.preventDefault(); redo(); return; }
  if (ctrl && k.toLowerCase() === "s") { e.preventDefault(); save(false); return; }
  if (ctrl && k.toLowerCase() === "a") { e.preventDefault(); E.sel = new Set(E.parts.flatMap(p => gemsOf(p))); draw(); return; }
  if (ctrl && k.toLowerCase() === "c") { copy(); return; }
  if (ctrl && k.toLowerCase() === "v") { paste(); return; }
  if (k === "r" || k === "R") { toggleRec(); return; }
  if (k === "Escape") { if (E.recording) toggleRec(); E.sel.clear(); E.fxSel = -1; renderFxPanel(); draw(); return; }
  if (k === "Delete" || k === "Backspace") {
    e.preventDefault();
    if (E.fxSel >= 0 && !E.sel.size) { pushUndo(); E.fx.splice(E.fxSel, 1); E.fxSel = -1; fxChanged(); return; }
    if (!E.sel.size) return;
    pushUndo();
    for (const p of E.parts) p.tr.notes = p.tr.notes.filter(n => !E.sel.has(n));
    E.sel.clear(); markDirty(); return;
  }
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
  if (k === "o" || k === "O") { toggleSpan(OD); return; }
  if (k === "l" || k === "L") { toggleSpan(SOLO); return; }
}
// overdrive phrase (116) or solo (103) over the selected gems of each part: remove the ones they touch, else add one
function toggleSpan(note) {
  const byPart = new Map();
  for (const n of E.sel) { const p = partOf(n); if (!byPart.has(p)) byPart.set(p, []); byPart.get(p).push(n); }
  pushUndo();
  for (const [p, gems] of byPart) {
    const a = Math.min(...gems.map(n => n.t)), b = Math.max(...gems.map(n => n.t + n.l));
    const spans = p.tr.notes.filter(n => n.n === note && n.t < b && n.t + n.l > a);
    if (spans.length) p.tr.notes = p.tr.notes.filter(n => !spans.includes(n));
    else {
      if (note === SOLO && p.tr.notes.filter(n => n.n === SOLO).length >= 4) { toast("a part can have at most 4 solos", true); continue; }
      p.tr.notes.push({ t: a, l: Math.max(note === SOLO ? E.tpb + 1 : 1, b - a), n: note, v: 100, c: 0 });
    }
  }
  markDirty();
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

// ---------- effects panel ----------
function renderFxPanel() {
  const el = $("#fxPanel");
  if (!el) return;
  const f = E.fx[E.fxSel];
  const head = `<h4>Effects</h4><div class="small dim" style="margin-bottom:6px">${E.fx.length} effect${E.fx.length === 1 ? "" : "s"}. Times are song.json seconds (the original audio, before the ${E.lead} s lead-in). In game an effect starts at the chart event nearest to its time.</div>`;
  if (!f) { el.innerHTML = head + `<div class="small dim">Double-click the effects lane to add one; click one to edit it.</div>`; return; }
  if (f.cmd != null) { el.innerHTML = head + `<div class="small">Raw script call cmd ${esc(f.cmd)} at ${esc(f.at)} s (edit it on the song.json tab).</div>`; return; }
  el.innerHTML = head + `<div class="form" style="grid-template-columns:60px 1fr">
    <label>Effect</label><select id="fxName">${META.effects.filter(n => n !== "end").map(n => `<option ${n === f.effect ? "selected" : ""}>${n}</option>`).join("")}</select>
    <label>From</label><input type="number" step="0.01" id="fxFrom" value="${f.from}">
    <label>To</label><span class="inline"><input type="number" step="0.01" id="fxTo" value="${f.to ?? ""}" placeholder="end"><span class="small dim">empty = to the end</span></span>
  </div><div class="actions" style="margin-top:8px"><button id="fxSeek">Play from here</button><button class="danger" id="fxDel">Delete</button></div>`;
  $("#fxName").onchange = e => { pushUndo(); f.effect = e.target.value; localStorage.lastFx = f.effect; fxChanged(); };
  $("#fxFrom").onchange = e => { pushUndo(); f.from = Number(e.target.value); fxChanged(); };
  $("#fxTo").onchange = e => { pushUndo(); const v = e.target.value.trim(); if (v === "") delete f.to; else f.to = Number(v); fxChanged(); };
  $("#fxSeek").onclick = () => { seek(Math.max(0, f.from + E.lead - 2)); play(); };
  $("#fxDel").onclick = () => { pushUndo(); E.fx.splice(E.fxSel, 1); E.fxSel = -1; fxChanged(); };
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
    if (E.fxDirty) {
      const fx = E.fx.map(f => f.cmd != null ? f : { effect: f.effect, from: Math.round(f.from * 100) / 100, ...(f.to != null ? { to: Math.round(f.to * 100) / 100 } : {}) });
      await api("PUT", `/api/effects/${E.folder}`, { effects: fx });
      E.fxDirty = false; E.saved = true;
    }
    updateButtons();
    toast(rebuild ? "Saved; rebuilding the chart…" : "Saved to songs/" + E.folder);
    if (rebuild) runBuild(E.folder, "chart");
  } catch (e) { toast(e.message, true); }
}
})();
