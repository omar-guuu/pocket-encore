"use strict";
// Effects & Band Anims tab: screen effects (one track for the whole song) and the band's animations on the shared time
// line (timeline.js), with playback. The build makes the band's animations from the song's own notes (scripts/band.js):
//   Singer props   the prop (tambourine, cowbell, hand clapping) in solos and long instrumental parts: automatic by
//                  default, or the song's own sections (song.json singerSections) - always editable
//   Singer mic     mic up before each vocal part, down in long breaks, from the vocals (song.json singerMic)
//   Guitarist / Bassist   one clip per note for each hand (song.json bandClips: a clip set by hand for one note)
// The mic and the hands are read-only (greyed) in Easy Edit Mode; Advanced Edit Mode (app.js) unlocks them.
// Times in song.json are seconds of the original audio; the time line shows game time (+ the lead-in).
(() => {
const TL = window.PETimeline;
const GUT = 122, RULER = 30, PAD = 4, PREV_W = 240;
const ROWS = [  // key, label, height, editable in Easy Edit Mode
  ["fx", "Screen effects", 34, true], ["props", "Singer props", 30, true], ["mic", "Singer mic", 20, false],
  ["guitarist_fret", "Guitarist fret", 18, false], ["guitarist_strum", "Guitarist strum", 18, false],
  ["bassist_fret", "Bassist fret", 18, false], ["bassist_strum", "Bassist strum", 18, false], ["ref", "Notes", 4 * 11 + 2, false],
];
const HANDS = ["guitarist_fret", "guitarist_strum", "bassist_fret", "bassist_strum"];
const PROP_NAME = { tambourine: "Tambourine", cowbell: "Cowbell", clap: "Hand clapping", none: "None" };
const PART_TRACKS = [["drums", ["PART DRUMS"], 61], ["bass", ["PART BASS"], 96], ["guitar", ["PART GUITAR"], 96], ["vocals", ["PART KEYS", "PART VOCALS"], 96]];
const PART_COL = { drums: "#c86464", bass: "#6488d8", guitar: "#d89a48", vocals: "#58b078" };
const PAL = {
  dark: { bg: "#111318", grid: "#1c2028", beatDown: "#3c4352", beat: "#262b35", barNum: "#9aa1ad", secs: "#8a919e", row: "#171a20", rowAlt: "#15171c",
    gut: "#1e2128", gutText: "#c4c9d2", gutDim: "#8a919e", fx: "rgba(180,110,240,.38)", fxLine: "#b46ef0", prop: "rgba(240,160,48,.35)", propLine: "#f0a030",
    sel: "#ffffff", text: "#ffffff", mic: "rgba(88,176,120,.45)", micLine: "#58b078", rest: "#8a919e", clip: "#5a7fb8", clipSet: "#f0a030", idle: "#3a4050",
    lock: "rgba(17,19,24,.55)", solo: "rgba(240,160,48,.12)", playhead: "#ffffff", ovBg: "#0e1014", band: "#f0a030", phrase: "rgba(88,176,120,.10)" },
  light: { bg: "#fbfbfc", grid: "#eceef1", beatDown: "#aeb5c1", beat: "#dde1e7", barNum: "#3f4652", secs: "#5f6673", row: "#f5f6f8", rowAlt: "#eff1f4",
    gut: "#eceff3", gutText: "#1d2026", gutDim: "#5f6673", fx: "rgba(150,80,220,.28)", fxLine: "#8a4fd0", prop: "rgba(240,160,48,.30)", propLine: "#b86a00",
    sel: "#1d2026", text: "#1d2026", mic: "rgba(40,140,80,.30)", micLine: "#2a8a50", rest: "#5f6673", clip: "#6f94cf", clipSet: "#d97400", idle: "#cfd4dc",
    lock: "rgba(251,251,252,.6)", solo: "rgba(240,160,48,.16)", playhead: "#1d2026", ovBg: "#eceff3", band: "#b86a00", phrase: "rgba(40,140,80,.10)" },
};
const pal = () => PAL[document.documentElement.dataset.theme === "light" ? "light" : "dark"];

let A = null;  // tab state
const advanced = () => window.editMode() === "advanced";
const r2 = v => Math.round(v * 100) / 100;

window.animsDirty = () => !!(A && A.dirty);
window.animsState = () => A;  // for tests and the console
window.animsClose = () => {
  if (!A) return;
  TL.stop(A); cancelAnimationFrame(A.raf);
  for (const [t, f] of A.listeners) window.removeEventListener(t, f);
  if (A.ctx && A.ctx.state !== "closed") A.ctx.close().catch(() => { });
  A = null;
};

let opening = null;  // only the latest openAnims call builds the tab
window.openAnims = async (root, folder, details) => {
  window.animsClose();
  const me = opening = {};
  root.innerHTML = `<div class="panel">Loading…</div>`;
  let chart, band;
  try { [chart, band] = await Promise.all([api("GET", `/api/chart/${folder}`), api("GET", `/api/band/${folder}`)]); }
  catch (e) { if (me === opening) root.innerHTML = `<div class="panel">Couldn't open this tab: ${esc(e.message)}</div>`; return; }
  if (me !== opening || !root.isConnected) return;
  window.animsClose();
  const S = details.song, lead = band.lead || 0;
  A = {
    folder, S, midi: chart.midi, tpb: chart.midi.tpb, lead, band, length: (chart.audio && chart.audio.audioSeconds) || 0,
    x0: 0, pps: 40, W: 800, sel: null, undo: [], redo: [], dirty: false, saved: false, listeners: [],
    ctx: null, bufs: {}, peaks: {}, gains: {}, vol: {}, mute: {}, solo: {}, srcs: [], playing: false, t0: 0, off: 0, rate: 1,
    fx: JSON.parse(JSON.stringify(details.effects || [])),
    prop: S.singerProp || "tambourine",
    sections: Array.isArray(S.singerSections) ? JSON.parse(JSON.stringify(S.singerSections)) : null,  // null = automatic
    mic: Array.isArray(S.singerMic) ? JSON.parse(JSON.stringify(S.singerMic)) : null,                 // null = from the vocals
    clips: Array.isArray(S.bandClips) ? JSON.parse(JSON.stringify(S.bandClips)) : [],
  };
  A.hooks = { draw: () => draw(), started: () => { $("#anPlay").textContent = "❚❚ Pause"; frame(); }, stopped: () => { $("#anPlay").textContent = "▶ Play"; draw(); } };
  TL.buildTempo(A); TL.initMix(A);
  // reference notes (Expert) and solos, from the chart
  A.parts = PART_TRACKS.map(([key, names, base]) => {
    const tr = A.midi.tracks.find(t => names.includes(t.name)) || { notes: [] };
    return { key, gems: tr.notes.filter(n => n.n >= base && n.n < base + 4).map(n => [TL.t2s(A, n.t), n.n - base]), solos: tr.notes.filter(n => n.n === 103).map(n => [TL.t2s(A, n.t), TL.t2s(A, n.t + n.l)]) };
  });
  A.length = Math.max(A.length, ...A.parts.flatMap(p => p.gems.map(g => g[0] + 1))) || 60;
  A.pps = Math.max(8, Math.min(120, 900 / Math.max(30, A.length) * 4));
  shell(root);
  const cur = A; TL.loadAudio(A, $("#audioState"), () => A === cur);
  draw();
};

// ---------- data shown: what the build will make ----------
const autoSections = () => A.band.built ? A.band.auto.sections.map(s => ({ ...s, from: r2(s.from - A.lead), to: r2(s.to - A.lead) })) : [];
const autoMic = () => A.band.built ? A.band.auto.mic.map(m => ({ at: r2(m.at - A.lead), state: m.state })) : [];
const curSections = () => A.sections || autoSections().map(s => ({ ...s, prop: A.prop }));
const curMic = () => A.mic || autoMic();
// a hand's clips (game seconds), with the clips set by hand (song.json seconds) on top
function handList(hand) {
  if (!A.band.built) return [];
  const set = A.clips.filter(c => c.hand === hand);
  return A.band.hands[hand].map(e => {
    if (e.at == null) return e;
    const o = set.find(c => Math.abs(c.at + A.lead - e.at) < 0.02);
    return o ? { ...e, sym: o.clip, set: true } : e;
  });
}
const rowEditable = key => ROWS.find(r => r[0] === key)[3] || advanced();

// ---------- layout ----------
function layout() {
  let y = RULER + 2; const out = {};
  for (const [key, label, h, easy] of ROWS) { out[key] = { y, h, label, easy }; y += h + PAD; }
  out.H = y + 2;
  return out;
}
const xOf = s => TL.xOf(A, s, GUT), sOf = x => TL.sOf(A, x, GUT);
const songX = t => xOf(t + A.lead);  // song.json seconds -> x
function rowAt(y) { const L = layout(); return ROWS.map(r => r[0]).find(k => y >= L[k].y && y < L[k].y + L[k].h) || (y < RULER ? "ruler" : null); }
const endOf = f => f.to != null ? f.to : A.length - A.lead;

// ---------- drawing ----------
function draw() {
  if (!A || !A.g) return;
  const c = A.g, K = pal(), L = layout(), W = A.W, H = L.H;
  c.fillStyle = K.bg; c.fillRect(0, 0, W, H);
  ROWS.forEach(([key], i) => { c.fillStyle = i % 2 ? K.rowAlt : K.row; c.fillRect(GUT, L[key].y, W - GUT, L[key].h); });
  // vocal phrases and solos behind everything, for orientation
  for (const p of A.parts) for (const [a, b] of p.solos) { const xa = xOf(a), xb = xOf(b); if (xb > GUT && xa < W) { c.fillStyle = K.solo; c.fillRect(Math.max(GUT, xa), RULER, xb - Math.max(GUT, xa), H - RULER); } }
  if (A.band.built) for (const ph of A.band.phrases) { const xa = xOf(ph.from), xb = xOf(ph.to); if (xb > GUT && xa < W) { c.fillStyle = K.phrase; c.fillRect(Math.max(GUT, xa), L.props.y, xb - Math.max(GUT, xa), L.mic.y + L.mic.h - L.props.y); } }
  TL.drawGrid(A, c, K, { gut: GUT, ruler: RULER, h: H });
  TL.wave(A, "fill", L.fx.y, L.fx.h, K.gutDim + "40", GUT);
  // screen effects
  A.fx.forEach((f, i) => block(c, K, L.fx, songX(f.from), songX(endOf(f)), (f.effect || "cmd " + f.cmd) + (f.to == null ? " →" : ""), K.fx, K.fxLine, isSel("fx", i)));
  // singer props
  const secs = curSections();
  secs.forEach((s, i) => {
    const auto = !A.sections, label = auto ? (A.prop === "none" ? "no prop (automatic)" : `${PROP_NAME[A.prop].toLowerCase()} (automatic)`) : PROP_NAME[s.prop].toLowerCase();
    block(c, K, L.props, songX(s.from), songX(s.to), label, auto && A.prop === "none" ? "transparent" : K.prop, K.propLine, isSel("props", i), auto);
  });
  // singer mic: shaded while the mic is up
  const mic = curMic().slice().sort((a, b) => a.at - b.at), my = L.mic.y, mh = L.mic.h;
  mic.forEach((m, i) => {
    const x = songX(m.at), nx = i + 1 < mic.length ? songX(mic[i + 1].at) : xOf(A.length);
    if (m.state === "perform" && nx > GUT && x < W) { c.fillStyle = K.mic; c.fillRect(Math.max(GUT, x), my + 3, nx - Math.max(GUT, x), mh - 6); }
    if (x < GUT - 6 || x > W + 6) return;
    c.fillStyle = m.state === "perform" ? K.micLine : K.rest;
    c.beginPath(); if (m.state === "perform") { c.moveTo(x - 5, my + mh - 2); c.lineTo(x + 5, my + mh - 2); c.lineTo(x, my + 2); } else { c.moveTo(x - 5, my + 2); c.lineTo(x + 5, my + 2); c.lineTo(x, my + mh - 2); } c.fill();
    if (isSel("mic", A.mic ? A.mic.indexOf(m) : -1)) { c.strokeStyle = K.sel; c.lineWidth = 2; c.strokeRect(x - 7, my + 1, 14, mh - 2); c.lineWidth = 1; }
  });
  // hands
  for (const hand of HANDS) {
    const R = L[hand], list = handList(hand);
    list.forEach((e, i) => {
      const xa = xOf(e.a), xb = xOf(e.e); if (xb < GUT || xa > W) return;
      const idle = e.at == null;
      c.fillStyle = e.set ? K.clipSet : idle ? K.idle : K.clip;
      c.fillRect(Math.max(GUT, xa), R.y + 3, Math.max(2, xb - Math.max(GUT, xa) - 1), R.h - 6);
      if (xb - xa > 70) { c.fillStyle = K.text; c.font = "9px Segoe UI"; c.fillText(e.sym.replace(/^(finger_|strum_)/, ""), Math.max(GUT, xa) + 2, R.y + R.h - 6); }
      if (isSel(hand, i)) { c.strokeStyle = K.sel; c.lineWidth = 2; c.strokeRect(xa - 1, R.y + 1, Math.max(4, xb - xa + 1), R.h - 2); c.lineWidth = 1; }
    });
  }
  // reference notes
  const R = L.ref, lh = (R.h - 2) / 4;
  A.parts.forEach((p, i) => { for (const [s] of p.gems) { const x = xOf(s); if (x >= GUT && x <= W) { c.fillStyle = PART_COL[p.key]; c.fillRect(x, R.y + 1 + i * lh, 2, lh - 2); } } });
  // greyed rows: read-only in Easy Edit Mode, or nothing built yet
  for (const [key, , , easy] of ROWS) {
    if (key === "ref" || key === "fx") continue;
    if ((!easy && !advanced()) || !A.band.built) { c.fillStyle = K.lock; c.fillRect(GUT, L[key].y, W - GUT, L[key].h); }
  }
  if (!A.band.built) { c.fillStyle = K.gutDim; c.font = "12px Segoe UI"; c.fillText("Build the song once to see the band's animations here.", GUT + 12, L.mic.y + 14); }
  // gutter
  c.fillStyle = K.gut; c.fillRect(0, 0, GUT - 2, H);
  c.fillStyle = K.gutText; c.font = "11px Segoe UI"; c.fillText("bar / time", 8, 18);
  for (const [key, label, h, easy] of ROWS) {
    const ro = key === "ref" || (!easy && !advanced());
    c.fillStyle = ro ? K.gutDim : K.gutText; c.font = (ro ? "" : "bold ") + "11px Segoe UI";
    c.fillText(label, 8, L[key].y + Math.min(h, 22) / 2 + 4);
    if (ro && key !== "ref") { c.font = "10px Segoe UI"; c.fillText("🔒", GUT - 20, L[key].y + Math.min(h, 22) / 2 + 4); }
  }
  A.parts.forEach((p, i) => { c.fillStyle = PART_COL[p.key]; c.font = "9px Segoe UI"; c.fillText(p.key, GUT - 44, R.y + 9 + i * lh); });
  // playhead
  const px = xOf(TL.pos(A));
  if (px >= GUT && px <= W) { c.strokeStyle = K.playhead; c.beginPath(); c.moveTo(px + .5, 0); c.lineTo(px + .5, H); c.stroke(); }
  drawOverview(K);
  updateStatus();
  drawPreview();
}
function block(c, K, R, a, b, label, fill, line, sel, dashed) {
  if (b < GUT || a > A.W) return;
  const xa = Math.max(GUT - 2, a), w = Math.max(3, b - xa);
  if (fill !== "transparent") { c.fillStyle = fill; c.fillRect(xa, R.y + 3, w, R.h - 6); }
  c.strokeStyle = sel ? K.sel : line; c.lineWidth = sel ? 2 : 1; if (dashed) c.setLineDash([4, 3]);
  c.strokeRect(xa + .5, R.y + 3.5, w - 1, R.h - 7); c.setLineDash([]); c.lineWidth = 1;
  c.fillStyle = K.text; c.font = "11px Segoe UI";
  c.save(); c.beginPath(); c.rect(xa, R.y, w, R.h); c.clip(); c.fillText(label, xa + 4, R.y + R.h / 2 + 4); c.restore();
}
const isSel = (row, i) => !!(A.sel && A.sel.row === row && A.sel.i === i && i >= 0);
function drawOverview(K) {
  const c = A.og, W = A.W, h = 30;
  c.fillStyle = K.ovBg; c.fillRect(0, 0, W, h);
  const k = W / (A.length || 1);
  A.parts.forEach((p, i) => { c.fillStyle = PART_COL[p.key] + "90"; for (const [s] of p.gems) c.fillRect(Math.floor(s * k), 2 + i * 4, 1, 3); });
  A.fx.forEach(f => { c.fillStyle = K.fxLine; c.fillRect((f.from + A.lead) * k, h - 11, Math.max(2, (endOf(f) - f.from) * k), 4); });
  curSections().forEach(s => { c.fillStyle = K.propLine; c.fillRect((s.from + A.lead) * k, h - 5, Math.max(2, (s.to - s.from) * k), 4); });
  TL.overviewFrame(A, c, K, h, GUT);
}
// the effect at the playhead: an in-game screenshot when there is one (public/fx/<effect>.jpg, also with the song time
// in front: 036_oldfilm.jpg), else a placeholder
function drawPreview() {
  const el = $("#anPreview"); if (!el) return;
  const t = TL.pos(A) - A.lead, f = A.fx.find(x => x.effect && t >= x.from && t < endOf(x)), name = f ? f.effect : "";
  if (el.dataset.fx === name) return;
  el.dataset.fx = name;
  const shot = name && A.band.shots.find(s => s.replace(/\.[^.]+$/, "").replace(/^\d+[_ -]/, "") === name);
  el.innerHTML = !name ? `<div class="pvempty"><b>Effect preview</b><span>No screen effect at the playhead.</span></div>`
    : shot ? `<img src="/fx/${encodeURIComponent(shot)}" alt="${esc(name)} in game"><div class="pvname">${esc(name)}</div>`
    : `<div class="pvempty"><b>${esc(name)}</b><span>In-game screenshot coming soon.</span></div>`;
}
function updateStatus() {
  const t = $("#anTime"); if (t) t.textContent = `${fmtTime(TL.pos(A))} · bar ${TL.barPos(A, TL.s2t(A, TL.pos(A))).split(".").slice(0, 2).join(".")}`;
}
function frame() {
  if (!A || !A.playing) return;
  const p = TL.pos(A);
  if (p >= A.length) { TL.stop(A); A.off = A.length; return; }
  const w = A.W - GUT, ps = (p - A.x0) * A.pps;
  if (ps > w * 0.85 || ps < 0) A.x0 = Math.max(0, p - (w * 0.15) / A.pps);
  draw();
  A.raf = requestAnimationFrame(frame);
}

// ---------- shell ----------
function shell(root) {
  root.innerHTML = `
  <div class="edbar">
    <div class="grp" role="group" aria-label="Playback">
      <button id="anPlay" class="primary" style="min-width:68px">▶ Play</button><button id="anStart" title="Back to the start (Home)" aria-label="Back to the start">⏮</button>
      <span id="anTime"></span>
      <select id="anRate" title="Playback speed (changes pitch)" aria-label="Playback speed"><option value="1">100%</option><option value="0.75">75%</option><option value="0.5">50%</option></select>
    </div>
    <div class="grp" role="group" aria-label="View"><button id="anOut" title="Zoom out (Ctrl+wheel)" aria-label="Zoom out">−</button><button id="anIn" title="Zoom in (Ctrl+wheel)" aria-label="Zoom in">+</button></div>
    <div class="grp" role="group" aria-label="Edit"><button id="anUndo" title="Undo (Ctrl+Z)" aria-label="Undo">↶</button><button id="anRedo" title="Redo (Ctrl+Y)" aria-label="Redo">↷</button></div>
    <div class="grp" role="group" aria-label="Edit mode"><span id="anMode"></span></div>
    <span class="grow"></span>
    <div class="grp" role="group" aria-label="Save"><span id="anBadge"></span>
      <button id="anSave" class="primary">Save</button><button id="anSaveBuild" title="Save, then rebuild the song's chart (needed to hear and see the changes in game)">Save + rebuild</button></div>
  </div>
  ${TL.mixerHtml()}
  <div class="edmain"><div class="canvaswrap" id="anWrap"><canvas id="anCv"></canvas><canvas id="anOv"></canvas></div>
    <div class="anside"><div id="anPreview" class="anpreview"></div><div class="small dim">The preview shows the screen effect at the playhead.</div></div></div>
  <div class="edfoot">
    <div class="panel" id="anPanel" style="flex:1"></div>
    <div class="panel" id="anSinger" style="width:380px"></div>
    <div class="panel keys" style="width:330px">
      <kbd>Space</kbd> play/pause · click the ruler = seek · <kbd>Home</kbd> start<br>
      <b>Screen effects</b>: double-click = new effect, drag = move, drag an end = resize, <kbd>Del</kbd> delete. One effect at a time: effects can't overlap.<br>
      <b>Singer props</b>: the same, once you use your own sections.<br>
      <b>Singer mic</b>, <b>Guitarist</b>, <b>Bassist</b>: 🔒 read-only in Easy Edit Mode.<br>
      <kbd>Ctrl</kbd>+<kbd>Z</kbd>/<kbd>Y</kbd> undo/redo · <kbd>Ctrl</kbd>+<kbd>S</kbd> save · wheel = scroll · <kbd>Ctrl</kbd>+wheel = zoom
    </div>
  </div>`;
  A.cv = $("#anCv"); A.ov = $("#anOv");
  const on = (t, f) => { window.addEventListener(t, f); A.listeners.push([t, f]); };
  const resize = () => {
    if (!A) return;
    const dpr = window.devicePixelRatio || 1, W = $("#anWrap").clientWidth, H = layout().H;
    A.W = W;
    for (const [cv, w, h] of [[A.cv, W, H], [A.ov, W, 30]]) { cv.width = w * dpr; cv.height = h * dpr; cv.style.width = w + "px"; cv.style.height = h + "px"; }
    A.g = A.cv.getContext("2d"); A.g.setTransform(dpr, 0, 0, dpr, 0, 0);
    A.og = A.ov.getContext("2d"); A.og.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  };
  on("resize", resize); resize();
  $("#anPlay").onclick = () => A.playing ? TL.stop(A) : TL.play(A);
  $("#anStart").onclick = () => { TL.seek(A, 0); A.x0 = 0; draw(); };
  $("#anRate").onchange = e => { const was = A.playing; TL.stop(A); A.rate = Number(e.target.value); if (was) TL.play(A); };
  $("#anIn").onclick = () => TL.zoom(A, 1.5, GUT + (A.W - GUT) / 2, GUT);
  $("#anOut").onclick = () => TL.zoom(A, 1 / 1.5, GUT + (A.W - GUT) / 2, GUT);
  $("#anUndo").onclick = undo; $("#anRedo").onclick = redo;
  $("#anSave").onclick = () => save(false); $("#anSaveBuild").onclick = () => save(true);
  TL.bindMixer(A); TL.bindOverview(A, A.ov, GUT);
  A.cv.addEventListener("mousedown", onDown);
  on("mousemove", onMove); on("mouseup", onUp);
  A.cv.addEventListener("dblclick", onDbl);
  A.cv.addEventListener("wheel", e => TL.onWheel(A, e, local(e)[0], GUT), { passive: false });
  A.cv.addEventListener("mousemove", e => { if (A.drag) return; const [x, y] = local(e), h = hitItem(x, y); A.cv.style.cursor = h && h.edge ? "ew-resize" : h && h.movable ? "grab" : "default"; });
  on("keydown", onKey);
  on("themechange", () => draw());
  on("editmodechange", () => { A.sel = null; renderMode(); renderPanels(); draw(); });
  renderMode(); renderPanels(); updateButtons();
}
function renderMode() {
  const el = $("#anMode"); if (!el) return;
  el.innerHTML = window.editModeButton();
}

// ---------- edits, undo ----------
const snap = () => JSON.stringify({ fx: A.fx, prop: A.prop, sections: A.sections, mic: A.mic, clips: A.clips });
function pushUndo() { A.undo.push(snap()); if (A.undo.length > 200) A.undo.shift(); A.redo = []; }
function restore(s) { const o = JSON.parse(s); Object.assign(A, o); A.sel = null; changed(); }
function undo() { if (!A.undo.length) return; A.redo.push(snap()); restore(A.undo.pop()); }
function redo() { if (!A.redo.length) return; A.undo.push(snap()); restore(A.redo.pop()); }
function changed() { A.dirty = true; updateButtons(); renderPanels(); draw(); }
function updateButtons() {
  if (!A || !$("#anSave")) return;
  $("#anUndo").disabled = !A.undo.length; $("#anRedo").disabled = !A.redo.length; $("#anSave").disabled = !A.dirty;
  const when = A.band.builtAt ? new Date(A.band.builtAt).toLocaleString() : "";
  $("#anBadge").innerHTML = A.saved && !A.dirty ? `<span class="badge warn" title="Saved to song.json; the game files change when the chart is rebuilt">rebuild needed</span>`
    : A.band.built ? `<span class="badge" title="The band rows show what the last build (${esc(when)}) makes with these settings">last build</span>` : `<span class="badge warn">not built yet</span>`;
}
// the singer's own sections start as a copy of the automatic ones
function ownSections() { if (!A.sections) A.sections = A.prop === "none" ? [] : autoSections().map(s => ({ from: s.from, to: s.to, prop: A.prop })); return A.sections; }
function ownMic() { if (!A.mic) A.mic = autoMic(); return A.mic; }

// ---------- mouse ----------
function local(e) { const r = A.cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
// the item under the mouse: { row, i, edge: "from" | "to" | null, movable }
function hitItem(x, y) {
  const row = rowAt(y); if (!row || x < GUT) return null;
  const near = (a, b) => { const xa = songX(a), xb = songX(b); return x >= xa - 4 && x <= xb + 4 ? { edge: Math.abs(x - xa) < 6 ? "from" : Math.abs(x - xb) < 6 ? "to" : null } : null; };
  if (row === "fx") { for (let i = A.fx.length - 1; i >= 0; i--) { const h = near(A.fx[i].from, endOf(A.fx[i])); if (h) return { row, i, edge: h.edge === "to" && A.fx[i].to == null ? null : h.edge, movable: true }; } return null; }
  if (row === "props") { const s = curSections(); for (let i = s.length - 1; i >= 0; i--) { const h = near(s[i].from, s[i].to); if (h) return { row, i, edge: A.sections ? h.edge : null, movable: !!A.sections }; } return null; }
  if (row === "mic") { const m = curMic(); let best = -1, bd = 7; m.forEach((v, i) => { const d = Math.abs(songX(v.at) - x); if (d < bd) { bd = d; best = i; } }); return best >= 0 ? { row, i: best, edge: null, movable: advanced() } : null; }
  if (HANDS.includes(row)) { const L = handList(row); for (let i = 0; i < L.length; i++) if (L[i].at != null && x >= xOf(L[i].a) - 1 && x <= xOf(L[i].e) + 1) return { row, i, edge: null, movable: false }; return null; }
  return null;
}
// a block's room: up to its neighbours in the same row (effects and props never overlap) and the song's ends
function room(list, i) {
  const lo = i > 0 ? endOf(list[i - 1]) : -A.lead, hi = i + 1 < list.length ? list[i + 1].from : A.length - A.lead;
  return { lo, hi };
}
function onDown(e) {
  if (e.button !== 0) return;
  const [x, y] = local(e), row = rowAt(y);
  e.preventDefault();
  if (row === "ruler") { TL.seek(A, sOf(x)); return; }
  const h = hitItem(x, y);
  if (h && (h.row === "mic" || HANDS.includes(h.row)) && !advanced()) { A.sel = { row: h.row, i: h.i }; renderPanels(); draw(); return; }
  A.sel = h ? { row: h.row, i: h.i } : null;
  if (h && h.movable) {
    const list = h.row === "fx" ? A.fx : h.row === "props" ? ownSections() : ownMic();
    A.drag = { row: h.row, i: h.i, edge: h.edge, x, orig: JSON.parse(JSON.stringify(list[h.i])), undo: snap(), list, room: h.row === "mic" ? null : room(list, h.i), changed: false };
  }
  renderPanels(); draw();
}
function onMove(e) {
  if (!A || !A.drag) return;
  const d = A.drag, [x] = local(e), ds = (x - d.x) / A.pps, it = d.list[d.i], o = d.orig;
  if (d.row === "mic") {
    const prev = d.list[d.i - 1], next = d.list[d.i + 1];
    it.at = r2(Math.max(prev ? prev.at + 0.05 : -A.lead, Math.min(next ? next.at - 0.05 : A.length - A.lead, o.at + ds)));
  } else {
    const { lo, hi } = d.room, min = d.row === "props" ? 2 : 0.2, oe = o.to != null ? o.to : null;
    if (d.edge === "from") it.from = r2(Math.max(lo, Math.min((oe ?? hi) - min, o.from + ds)));
    else if (d.edge === "to") it.to = r2(Math.max(o.from + min, Math.min(hi, oe + ds)));
    else { const len = oe != null ? oe - o.from : 0; it.from = r2(Math.max(lo, Math.min(hi - len, o.from + ds))); if (oe != null) it.to = r2(it.from + len); }
  }
  d.changed = true; A.dirty = true; updateButtons(); renderPanels(); draw();
}
function onUp() {
  if (!A || !A.drag) return;
  const d = A.drag; A.drag = null;
  if (d.changed) { A.undo.push(d.undo); A.redo = []; }
  updateButtons(); renderPanels(); draw();
}
function onDbl(e) {
  const [x, y] = local(e), row = rowAt(y);
  if (x < GUT || hitItem(x, y)) return;
  const at = r2(sOf(x) - A.lead);
  if (row === "fx") { const before = snap(); if (addBlock(A.fx, at, { effect: localStorage.lastFx || "oldfilm" }, 0.5, "effect")) { A.undo.push(before); A.redo = []; changed(); } }
  else if (row === "props") addProp(lastProp(), at);
  else if (row === "mic") {
    if (!advanced()) return toast("The singer's mic follows the vocals. Turn on Advanced Edit Mode to change it.", true);
    pushUndo(); const m = ownMic(), prev = m.filter(v => v.at < at).pop();
    m.push({ at, state: prev && prev.state === "perform" ? "rest" : "perform" }); m.sort((a, b) => a.at - b.at);
    A.sel = { row: "mic", i: m.findIndex(v => v.at === at) }; changed();
  }
}
// a new block at `at` in free space, 8 s long or up to the next block; false when there is no room (the caller
// records the undo step)
function addBlock(list, at, extra, min, what) {
  const inside = list.find(b => at >= b.from && at < endOf(b));
  if (inside) { toast(`There's already ${what === "effect" ? "an effect" : "a prop section"} there: only one at a time.`, true); return false; }
  const next = list.filter(b => b.from > at).sort((a, b) => a.from - b.from)[0], hi = next ? next.from : A.length - A.lead;
  if (hi - at < min) { toast(`No room for a new ${what} there.`, true); return false; }
  const b = { ...extra, from: at, to: r2(Math.min(at + 8, hi)) };
  list.push(b); list.sort((a, c) => a.from - c.from);
  A.sel = { row: what === "effect" ? "fx" : "props", i: list.indexOf(b) };
  return true;
}
const lastProp = () => ["tambourine", "cowbell", "clap"].includes(localStorage["pe.lastProp"]) ? localStorage["pe.lastProp"] : "tambourine";
// adding a prop switches to the song's own sections (one undo step for both)
function addProp(prop, at) {
  localStorage["pe.lastProp"] = prop;
  const before = snap(), wasAuto = !A.sections;
  ownSections();
  if (!addBlock(A.sections, at, { prop }, 2, "prop section")) { if (wasAuto) A.sections = null; return; }
  A.undo.push(before); A.redo = []; changed();
}
function deleteSel() {
  const s = A.sel; if (!s) return;
  if (s.row === "fx") { pushUndo(); A.fx.splice(s.i, 1); }
  else if (s.row === "props") { if (!A.sections) return toast("These are the automatic sections: choose \"My own sections\" to change them.", true); pushUndo(); A.sections.splice(s.i, 1); }
  else if (s.row === "mic") { if (!advanced()) return; pushUndo(); ownMic().splice(s.i, 1); }
  else return;
  A.sel = null; changed();
}

// ---------- keys ----------
function onKey(e) {
  if (!A || /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName) || !$("#modal").classList.contains("hidden")) return;
  const k = e.key, ctrl = e.ctrlKey || e.metaKey;
  if (k === " ") { e.preventDefault(); A.playing ? TL.stop(A) : TL.play(A); return; }
  if (k === "Home") { TL.seek(A, 0); A.x0 = 0; draw(); return; }
  if (ctrl && k.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (ctrl && k.toLowerCase() === "y") { e.preventDefault(); redo(); return; }
  if (ctrl && k.toLowerCase() === "s") { e.preventDefault(); save(false); return; }
  if (k === "Delete" || k === "Backspace") { e.preventDefault(); deleteSel(); return; }
  if (k === "Escape") { A.sel = null; renderPanels(); draw(); }
}

// ---------- panels ----------
const optList = (list, cur) => list.map(([v, n]) => `<option value="${v}" ${v === cur ? "selected" : ""}>${n}</option>`).join("");
function renderPanels() { renderSelPanel(); renderSinger(); }
function renderSelPanel() {
  const el = $("#anPanel"); if (!el) return;
  const s = A.sel;
  const fxHead = `<h4>Screen effects</h4><div class="small dim">${A.fx.length} effect${A.fx.length === 1 ? "" : "s"}. Each one starts and ends exactly at its times (seconds of the original audio${A.lead ? `, before the ${A.lead} s lead-in` : ""}). Effects cover the whole screen, one at a time.</div>`;
  if (!s) { el.innerHTML = fxHead + `<p class="small">Double-click the <b>Screen effects</b> track to add one; click any block on the time line to see or change it.</p>`; return; }
  if (s.row === "fx") {
    const f = A.fx[s.i]; if (!f) { A.sel = null; return renderSelPanel(); }
    if (f.cmd != null) { el.innerHTML = fxHead + `<div class="small">Raw script call cmd ${esc(f.cmd)} at ${esc(f.at)} s (edit it on the song.json tab).</div>`; return; }
    el.innerHTML = fxHead + `<div class="form" style="grid-template-columns:60px 1fr;margin-top:8px">
      <label>Effect</label><select id="fxName">${META.effects.filter(n => n !== "end").map(n => `<option ${n === f.effect ? "selected" : ""}>${n}</option>`).join("")}</select>
      <label>From</label><input type="number" step="0.01" id="fxFrom" value="${f.from}">
      <label>To</label><span class="inline"><input type="number" step="0.01" id="fxTo" value="${f.to ?? ""}" placeholder="end"><span class="small dim">empty = to the end</span></span>
    </div><div class="actions" style="margin-top:8px"><button id="fxSeek">Play from here</button><button class="danger" id="fxDel">Delete</button></div>`;
    const { lo, hi } = room(A.fx, s.i);
    $("#fxName").onchange = e => { pushUndo(); f.effect = e.target.value; localStorage.lastFx = f.effect; changed(); };
    $("#fxFrom").onchange = e => { const v = Number(e.target.value); if (!(v >= lo && v < endOf(f))) { toast(`Start between ${lo} and ${endOf(f)} s: effects can't overlap.`, true); return renderSelPanel(); } pushUndo(); f.from = v; changed(); };
    $("#fxTo").onchange = e => {
      const t = e.target.value.trim(), v = Number(t);
      if (t === "" && s.i + 1 < A.fx.length) { toast("Only the last effect can run to the end: the next one starts after it.", true); return renderSelPanel(); }
      if (t !== "" && !(v > f.from && v <= hi)) { toast(`End between ${f.from} and ${r2(hi)} s: effects can't overlap.`, true); return renderSelPanel(); }
      pushUndo(); if (t === "") delete f.to; else f.to = v; changed();
    };
    $("#fxSeek").onclick = () => { TL.seek(A, Math.max(0, f.from + A.lead - 2)); TL.play(A); };
    $("#fxDel").onclick = deleteSel;
    return;
  }
  if (s.row === "props") {
    const list = curSections(), b = list[s.i]; if (!b) { A.sel = null; return renderSelPanel(); }
    const sings = A.band.built ? A.band.phrases.filter(p => p.from - A.lead < b.to && p.to - A.lead > b.from).length : 0;
    el.innerHTML = `<h4>Singer prop section</h4><div class="small">${fmtTime(b.from + A.lead)}–${fmtTime(b.to + A.lead)}${b.why && !A.sections ? ` · automatic: ${esc(b.why)}` : ""}${b.hits ? ` · ${b.hits} hits` : ""}</div>
      ${A.sections ? `<div class="form" style="grid-template-columns:60px 1fr;margin-top:8px">
        <label>Prop</label><select id="spProp">${optList([["tambourine", "Tambourine"], ["cowbell", "Cowbell"], ["clap", "Hand clapping"]], b.prop)}</select>
        <label>From</label><input type="number" step="0.01" id="spFrom" value="${b.from}"><label>To</label><input type="number" step="0.01" id="spTo" value="${b.to}"></div>
        <div class="actions" style="margin-top:8px"><button id="spSeek">Play from here</button><button class="danger" id="spDel">Delete</button></div>`
        : `<p class="small dim">Automatic section. To move it or pick another prop for it, choose <b>My own sections</b> on the right.</p><div class="actions"><button id="spSeek">Play from here</button></div>`}
      ${sings ? `<div class="warnline small" style="margin-top:6px">The singer sings during this section: they will hold the prop while singing.</div>` : ""}`;
    $("#spSeek").onclick = () => { TL.seek(A, Math.max(0, b.from + A.lead - 2)); TL.play(A); };
    if (!A.sections) return;
    const { lo, hi } = room(A.sections, s.i);
    $("#spProp").onchange = e => { pushUndo(); b.prop = e.target.value; localStorage["pe.lastProp"] = b.prop; changed(); };
    $("#spFrom").onchange = e => { const v = Number(e.target.value); if (!(v >= lo && v <= b.to - 2)) { toast(`Start between ${r2(lo)} and ${r2(b.to - 2)} s (at least 2 s long, no overlap).`, true); return renderSelPanel(); } pushUndo(); b.from = v; changed(); };
    $("#spTo").onchange = e => { const v = Number(e.target.value); if (!(v >= b.from + 2 && v <= hi)) { toast(`End between ${r2(b.from + 2)} and ${r2(hi)} s (at least 2 s long, no overlap).`, true); return renderSelPanel(); } pushUndo(); b.to = v; changed(); };
    $("#spDel").onclick = deleteSel;
    return;
  }
  if (s.row === "mic") {
    const m = curMic()[s.i]; if (!m) { A.sel = null; return renderSelPanel(); }
    el.innerHTML = `<h4>Singer mic</h4><div class="small">${m.state === "perform" ? "Mic up (sings, or plays the prop held)" : "Mic down (rests)"} at ${fmtTime(m.at + A.lead)}${A.mic ? " · set by hand" : " · from the vocals"}</div>
      ${advanced() ? `<div class="form" style="grid-template-columns:60px 1fr;margin-top:8px"><label>State</label><select id="mcState">${optList([["perform", "Mic up"], ["rest", "Mic down"]], m.state)}</select>
        <label>At</label><input type="number" step="0.01" id="mcAt" value="${m.at}"></div><div class="actions" style="margin-top:8px"><button class="danger" id="mcDel">Delete</button></div>`
        : `<p class="small dim">🔒 Read-only in Easy Edit Mode: the mic follows the vocals.</p>`}`;
    if (!advanced()) return;
    $("#mcState").onchange = e => { pushUndo(); ownMic()[s.i].state = e.target.value; changed(); };
    $("#mcAt").onchange = e => { pushUndo(); const mm = ownMic(), it = mm[s.i]; it.at = Number(e.target.value); mm.sort((a, b) => a.at - b.at); A.sel = { row: "mic", i: mm.indexOf(it) }; changed(); };
    $("#mcDel").onclick = deleteSel;
    return;
  }
  if (HANDS.includes(s.row)) {
    const e = handList(s.row)[s.i]; if (!e) { A.sel = null; return renderSelPanel(); }
    const name = s.row.replace("_", " "), clips = A.band.clips[s.row], at = r2(e.at - A.lead);
    el.innerHTML = `<h4>${esc(name[0].toUpperCase() + name.slice(1))}</h4><div class="small">Note at ${fmtTime(e.at)} · clip <b>${esc(e.sym)}</b>${e.set ? " (set by hand)" : " (automatic)"}</div>
      ${advanced() ? (clips.length > 1 ? `<div class="form" style="grid-template-columns:60px 1fr;margin-top:8px"><label>Clip</label><select id="hcClip"><option value="">Automatic</option>${optList(clips.map(c => [c, c]), e.set ? e.sym : "")}</select></div>`
        : `<p class="small dim">The bassist plucks every note the same way: nothing to choose here.</p>`)
        : `<p class="small dim">🔒 Read-only in Easy Edit Mode: the hands follow the notes.</p>`}`;
    if (!advanced() || clips.length < 2) return;
    $("#hcClip").onchange = ev => {
      pushUndo();
      A.clips = A.clips.filter(c => !(c.hand === s.row && Math.abs(c.at - at) < 0.02));
      if (ev.target.value) A.clips.push({ hand: s.row, at, clip: ev.target.value });
      changed();
    };
  }
}
function renderSinger() {
  const el = $("#anSinger"); if (!el) return;
  const own = !!A.sections;
  el.innerHTML = `<h4>Singer props</h4>
    <div class="seg" role="radiogroup" aria-label="Singer prop sections"><button id="spAuto" class="${own ? "" : "on"}" aria-pressed="${!own}">Automatic</button><button id="spOwn" class="${own ? "on" : ""}" aria-pressed="${own}">My own sections</button></div>
    ${own ? `<p class="small dim" style="margin:6px 0">Your sections are used as they are. Double-click the <b>Singer props</b> track, or:</p>`
      : `<p class="small dim" style="margin:6px 0">Solos where nobody sings and instrumental parts of 8 bars or more (${curSections().length} in this song).</p>
        <div class="form" style="grid-template-columns:150px 1fr"><label for="spDefault">Prop in those parts</label><select id="spDefault">${optList(Object.entries(PROP_NAME), A.prop)}</select></div>`}
    <div class="actions" style="margin-top:8px"><span class="small dim">Add at the playhead:</span>
      <button data-add="tambourine">Tambourine</button><button data-add="cowbell">Cowbell</button><button data-add="clap">Clapping</button></div>
    <div class="small dim" style="margin-top:6px">${A.mic ? `Mic changes set by hand (${A.mic.length}). <button class="small" id="micAuto">Back to following the vocals</button>` : "The mic follows the vocals."}
      ${A.clips.length ? `<br>${A.clips.length} hand clip${A.clips.length > 1 ? "s" : ""} set by hand. <button class="small" id="clipsAuto">Back to automatic clips</button>` : ""}</div>`;
  $("#spAuto").onclick = () => { if (!A.sections) return; pushUndo(); A.sections = null; A.sel = null; changed(); };
  $("#spOwn").onclick = () => { if (A.sections) return; pushUndo(); ownSections(); changed(); };
  if ($("#spDefault")) $("#spDefault").onchange = e => { pushUndo(); A.prop = e.target.value; changed(); };
  el.querySelectorAll("[data-add]").forEach(b => b.onclick = () => addProp(b.dataset.add, r2(TL.pos(A) - A.lead)));
  if ($("#micAuto")) $("#micAuto").onclick = () => { pushUndo(); A.mic = null; A.sel = null; changed(); };
  if ($("#clipsAuto")) $("#clipsAuto").onclick = () => { pushUndo(); A.clips = []; changed(); };
}

// ---------- save ----------
async function save(rebuild) {
  if (!A) return;
  try {
    if (A.dirty) {
      const fx = A.fx.map(f => f.cmd != null ? f : { effect: f.effect, from: r2(f.from), ...(f.to != null ? { to: r2(f.to) } : {}) });
      await api("PUT", `/api/anims/${A.folder}`, { effects: fx, singerProp: A.prop, singerSections: A.sections, singerMic: A.mic, bandClips: A.clips.length ? A.clips : null });
      A.dirty = false; A.saved = true;
    }
    updateButtons();
    toast(rebuild ? "Saved; rebuilding the chart…" : "Saved to songs/" + A.folder + "/song.json");
    if (rebuild) runBuild(A.folder, "chart");
    return true;
  } catch (e) { fail("Couldn't save")(e); return false; }
}
window.animsSave = () => save(false);
})();
