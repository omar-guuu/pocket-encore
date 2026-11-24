"use strict";
// Shared time line for Pocket Encore's editors (the Chart tab, editor.js, and the Effects & Band Anims tab, anims.js):
// tempo map, the five stems' audio (loading, waveform peaks, mixer, play / pause / seek, loop playback), the beat grid
// and seconds ruler, waveform drawing, zoom, mouse wheel and the overview strip. Every function takes the editor's
// state object E; the editor keeps its own drawing and editing.
// E needs: midi, tpb (tempo); ctx, bufs, peaks, gains, vol, mute, solo, srcs, playing, t0, off, rate, length, playLoop,
// loop (audio); x0, pps, W, g (drawing); hooks = { started(), stopped(), draw() }.
window.PETimeline = (() => {
const TRACKS = ["drums", "bass_guitar", "lead_guitar", "vocals", "fill"];
const TRACK_NAME = { drums: "Drums", bass_guitar: "Bass", lead_guitar: "Guitar", vocals: "Vocals", fill: "Backing" };

// ---------- tempo map ----------
function buildTempo(E) {
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
function seg(E, t) { const T = E.tempo; let lo = 0, hi = T.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (T[m].t <= t) lo = m; else hi = m - 1; } return T[lo]; }
function t2s(E, t) { const g = seg(E, t); return g.s + (t - g.t) * g.us / 1e6 / E.tpb; }
function s2t(E, s) { const T = E.tempo; let g = T[0]; for (const x of T) if (x.s <= s) g = x; else break; return g.t + (s - g.s) * 1e6 * E.tpb / g.us; }
function beatList(E, t0, t1) {
  if (E.beats) { const out = []; let n = 0; for (const b of E.beats) { if (b.down) n++; if (b.t >= t0 && b.t <= t1) out.push({ ...b, bar: n }); } return out; }
  const out = []; for (let t = Math.max(0, Math.floor(t0 / E.tpb)) * E.tpb; t <= t1; t += E.tpb) out.push({ t, down: (t / E.tpb) % 4 === 0, bar: Math.floor(t / E.tpb / 4) + 1 });
  return out;
}
function barPos(E, t) {
  const bs = beatList(E, 0, t); if (!bs.length) return "";
  let bar = 0, bi = 0, last = bs[0];
  for (const b of bs) { if (b.down) { bar = b.bar; bi = 0; } else bi++; last = b; }
  return `${bar}.${bi + 1}.${String(Math.round(t - last.t)).padStart(3, "0")}`;
}

// ---------- audio ----------
async function loadAudio(E, st, still) {
  try {
    E.ctx = new AudioContext();
    E.master = E.ctx.createGain(); E.master.connect(E.ctx.destination);
    E.clickGain = E.ctx.createGain(); E.clickGain.gain.value = 0.5; E.clickGain.connect(E.ctx.destination);
    for (const t of TRACKS) { E.gains[t] = E.ctx.createGain(); E.gains[t].connect(E.master); }
    let i = 0;
    for (const t of TRACKS) {
      if (!still()) return;
      st.textContent = `loading audio ${++i}/5…`;
      const r = await fetch(`/api/audio/${E.folder}/${t}`);
      if (!r.ok) { st.textContent = "no audio: build the song once"; continue; }
      const buf = await E.ctx.decodeAudioData(await r.arrayBuffer());
      if (!still()) return;
      E.bufs[t] = buf; E.peaks[t] = peaks(buf);
      E.length = Math.max(E.length, buf.duration);
      E.hooks.draw();
    }
    st.textContent = "";
    applyGains(E);
  } catch (e) { st.textContent = "Couldn't load the audio: " + e.message; }
}
function peaks(buf) {  // max |sample| per 1/200 s
  const x = buf.getChannelData(0), hop = buf.sampleRate / 200, n = Math.floor(x.length / hop), p = new Float32Array(n);
  for (let i = 0; i < n; i++) { let m = 0; const a = Math.floor(i * hop), b = Math.floor((i + 1) * hop); for (let k = a; k < b; k++) { const v = Math.abs(x[k]); if (v > m) m = v; } p[i] = m; }
  return p;
}
function initMix(E) { for (const t of TRACKS) { E.vol[t] = 1; E.mute[t] = false; E.solo[t] = false; } }
function applyGains(E) {
  if (!E.ctx) return;
  const anySolo = TRACKS.some(t => E.solo[t]);
  for (const t of TRACKS) E.gains[t].gain.value = E.mute[t] || (anySolo && !E.solo[t]) ? 0 : E.vol[t];
}
// Loop: E.loop = { a, b, on } in seconds. While playing, E.playLoop is the loop the audio sources were started with (they
// loop by themselves, gaplessly). rawPos counts on past the loop end; pos is where that is in the song.
const rawPos = E => E.playing ? E.off + (E.ctx.currentTime - E.t0) * E.rate : E.off;
const songAt = (E, r) => { const L = E.playLoop; return L && r >= L.b ? L.a + (r - L.a) % (L.b - L.a) : r; };
const pos = E => E.playing ? songAt(E, rawPos(E)) : E.off;
const loopOn = E => !!(E.loop && E.loop.on && E.loop.b > E.loop.a);
function play(E) {
  if (!E.ctx || E.playing) return;
  E.ctx.resume().catch(() => { });  // rejects if the tab closes the context before the audio device answers
  const L = loopOn(E) ? { a: E.loop.a, b: E.loop.b } : null;
  if (L && E.off >= L.b) E.off = L.a;  // starting before the loop plays into it; after it, from its start
  E.srcs = TRACKS.filter(t => E.bufs[t]).map(t => {
    const s = E.ctx.createBufferSource(); s.buffer = E.bufs[t]; s.playbackRate.value = E.rate; s.connect(E.gains[t]);
    if (L) { s.loop = true; s.loopStart = L.a; s.loopEnd = L.b; }
    s.start(0, Math.max(0, E.off)); return s;
  });
  E.playLoop = L;
  E.t0 = E.ctx.currentTime; E.playing = true;
  E.hooks.started();
}
function stop(E) {
  if (!E || !E.playing) return;
  E.off = pos(E); E.srcs.forEach(s => { try { s.stop(); } catch { } }); E.srcs = []; E.playing = false; E.playLoop = null;
  E.hooks.stopped();
}
function seek(E, s) {
  s = Math.max(0, Math.min(E.length, s));
  const was = E.playing; stop(E); E.off = s; if (was) play(E); else E.hooks.draw();
}

// ---------- drawing ----------
const xOf = (E, s, gut) => gut + (s - E.x0) * E.pps;
const sOf = (E, x, gut) => E.x0 + (x - gut) / E.pps;
// beat grid (snap lines when step > 0), beat and bar lines from `top` down to `h`, bar numbers and seconds on the ruler
function drawGrid(E, c, K, { gut, ruler, h, top = ruler, step = 0 }) {
  const W = E.W, s0 = E.x0, s1 = sOf(E, W, gut), t0 = s2t(E, Math.max(0, s0)), t1 = s2t(E, s1);
  if (step) {
    const stepPx = E.pps * (seg(E, t0).us / 1e6) * step / E.tpb;
    if (stepPx > 7) {
      c.strokeStyle = K.grid; c.beginPath();
      for (let t = Math.floor(t0 / step) * step; t <= t1; t += step) { const x = Math.round(xOf(E, t2s(E, t), gut)) + .5; c.moveTo(x, top); c.lineTo(x, h); }
      c.stroke();
    }
  }
  for (const b of beatList(E, t0 - E.tpb, t1 + E.tpb)) {
    const x = Math.round(xOf(E, t2s(E, b.t), gut)) + .5;
    if (x < gut) continue;
    c.strokeStyle = b.down ? K.beatDown : K.beat; c.beginPath(); c.moveTo(x, ruler - (b.down ? 12 : 5)); c.lineTo(x, h); c.stroke();
    if (b.down && E.pps * 2 > 40) { c.fillStyle = K.barNum; c.font = "11px Segoe UI"; c.fillText(String(b.bar), x + 3, 12); }
  }
  c.fillStyle = K.secs; c.font = "10px Segoe UI";
  const secStep = [1, 2, 5, 10, 15, 30, 60].find(v => v * E.pps > 60) || 60;
  for (let s = Math.ceil(s0 / secStep) * secStep; s < s1; s += secStep) { const x = xOf(E, s, gut); if (x > gut) c.fillText(fmtTime(s).replace(/\.0$/, ""), x + 2, ruler - 3); }
}
// a stem's waveform (peaks) between y and y + h
function wave(E, track, y, h, col, gut) {
  const pk = E.peaks[track];
  if (!pk) return;
  const c = E.g, mid = y + h / 2;
  c.fillStyle = col;
  for (let x = gut; x < E.W; x++) {
    const a = Math.floor(sOf(E, x, gut) * 200), b = Math.max(a + 1, Math.floor(sOf(E, x + 1, gut) * 200));
    if (a < 0 || a >= pk.length) continue;
    let m = 0; for (let k = a; k < b && k < pk.length; k++) if (pk[k] > m) m = pk[k];
    const v = Math.min(1, Math.sqrt(m)) * h / 2;
    c.fillRect(x, mid - v, 1, 2 * v);
  }
}
function zoom(E, f, x, gut) {
  const s = sOf(E, x, gut);
  E.pps = Math.max(8, Math.min(2000, E.pps * f));
  E.x0 = Math.max(0, s - (x - gut) / E.pps);
  E.hooks.draw();
}
function onWheel(E, e, x, gut) {
  e.preventDefault();
  if (e.ctrlKey) zoom(E, e.deltaY < 0 ? 1.2 : 1 / 1.2, Math.max(gut, x));
  else { E.x0 = Math.max(0, Math.min(E.length, E.x0 + (e.deltaY + e.deltaX) / E.pps * 0.8)); E.hooks.draw(); }
}
// the overview strip under the chart: a click or drag there scrolls the view
function bindOverview(E, cv, gut) {
  const nav = e => { const r = cv.getBoundingClientRect(), s = (e.clientX - r.left) / E.W * E.length; E.x0 = Math.max(0, s - (E.W - gut) / E.pps / 2); E.hooks.draw(); };
  cv.addEventListener("mousedown", e => { nav(e); const mv = ev => nav(ev), up = () => { window.removeEventListener("mousemove", mv); window.removeEventListener("mouseup", up); }; window.addEventListener("mousemove", mv); window.addEventListener("mouseup", up); });
}
// the view box and playhead on the overview strip
function overviewFrame(E, c, K, h, gut) {
  const k = E.W / (E.length || 1);
  c.strokeStyle = K.band; c.strokeRect(E.x0 * k + .5, .5, Math.max(4, (E.W - gut) / E.pps * k), h - 1);
  c.fillStyle = K.playhead; c.fillRect(pos(E) * k, 0, 1, h);
}

// ---------- mixer ----------
function mixerHtml(extra = "") {
  return `<div class="mixer">${TRACKS.map(t => `<span class="ch"><b>${TRACK_NAME[t]}</b><button data-m="${t}" title="mute">M</button><button data-s="${t}" title="solo">S</button><input type="range" min="0" max="1.5" step="0.05" value="1" data-v="${t}" aria-label="${TRACK_NAME[t]} volume"></span>`).join("")}${extra}<span id="audioState" class="dim"></span></div>`;
}
function bindMixer(E) {
  document.querySelectorAll("[data-m]").forEach(b => b.onclick = () => { const t = b.dataset.m; E.mute[t] = !E.mute[t]; b.classList.toggle("on", E.mute[t]); applyGains(E); });
  document.querySelectorAll("[data-s]").forEach(b => b.onclick = () => { const t = b.dataset.s; E.solo[t] = !E.solo[t]; b.classList.toggle("on", E.solo[t]); applyGains(E); });
  document.querySelectorAll("[data-v]").forEach(r => r.oninput = () => { E.vol[r.dataset.v] = Number(r.value); applyGains(E); });
}

return { TRACKS, TRACK_NAME, buildTempo, seg, t2s, s2t, beatList, barPos, loadAudio, peaks, initMix, applyGains, rawPos, songAt, pos, loopOn,
  play, stop, seek, xOf, sOf, drawGrid, wave, zoom, onWheel, bindOverview, overviewFrame, mixerHtml, bindMixer };
})();
