#!/usr/bin/env node
// Pocket Encore: a local web app for custom songs (song library, details, stems, build, chart and effects editor).
//
//   node pocketencore/server.js [--port 8642] [--open]     then open http://localhost:8642 (pocketencore.cmd does both)
//
// songs/<FOLDER>/song.json stays the single source of truth: the page edits it and runs mksong.js to build.
// Gem edits are saved as songs/<FOLDER>/chart.mid (a Rock Band-format MIDI, the same layout as the REAPER
// export) and song.json gets "chart": "chart.mid". The server only listens on 127.0.0.1.
// External pieces (game MUSIC folder, Python, at3tool, mid2rbu) come from rbu-tools/settings.json (scripts/settings.js).
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const MIDI = require("./midi.js");

const TOOLS = path.resolve(__dirname, "..");
const SONGS = path.join(TOOLS, "songs"), OUT = path.join(TOOLS, "out", "MUSIC"), REAPER = path.join(TOOLS, "reaper");
const SCRIPTS = path.join(TOOLS, "scripts"), PUB = path.join(__dirname, "public");
const { sections, Image, chartFromImage } = require(path.join(SCRIPTS, "beatmatch.js"));
const { EFFECTS } = require(path.join(SCRIPTS, "fxchart.js"));
const settings = require(path.join(SCRIPTS, "settings.js"));
const PORT = Number((process.argv.find((a, i) => process.argv[i - 1] === "--port")) || 8642);
const TRACKS = ["drums", "bass_guitar", "lead_guitar", "vocals", "fill"];
const STEM_KEYS = { drums: "drums", bass: "bass_guitar", guitar: "lead_guitar", vocals: "vocals", fill: "fill" };
const GENRES = ["ALTERNATIVE", "BLUES", "CLASSIC ROCK", "COUNTRY", "EMO", "FUSION", "GLAM", "GRUNGE", "INDIE ROCK", "JAZZ",
  "METAL", "NOVELTY", "NU-METAL", "POP-ROCK", "PROG", "PUNK", "ROCK", "SOUTHERN ROCK", "URBAN"];
const FOLDER_RE = /^Z[A-Z0-9_]{1,30}$/;
// Stem formats the pipeline reads: WAV (16/24/32-bit PCM, 32/64-bit float; prepwav.js) and, decoded first by
// decode.py (miniaudio), MP3, FLAC and Ogg Vorbis.
const AUDIO_EXT = [".wav", ".mp3", ".flac", ".ogg"], MIDI_EXT = [".mid", ".midi"];
// Dropped files land here until the song is created (then they move to songs/<FOLDER>/stems/); old leftovers are removed.
const INCOMING = path.join(TOOLS, "incoming");
try {
  for (const d of fs.readdirSync(INCOMING)) {
    const p = path.join(INCOMING, d);
    if (Date.now() - fs.statSync(p).mtimeMs > 2 * 86400000) fs.rmSync(p, { recursive: true, force: true });
  }
} catch { }
const STAR_FRACTIONS = [0.0524, 0.1048, 0.1572, 0.473, 0.789, 0.874];  // of the chart's max (FINDINGS §33)

// ---------- song.json ----------
function songDir(folder) {
  if (!FOLDER_RE.test(folder)) throw httpError(400, "bad folder name");
  return path.join(SONGS, folder);
}
function readSong(folder) {
  const f = path.join(songDir(folder), "song.json");
  if (!fs.existsSync(f)) throw httpError(404, "no such song");
  return JSON.parse(fs.readFileSync(f, "utf8"));
}
// Pretty JSON that keeps short objects/arrays on one line, like the hand-written song.json files.
function inline(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return v.length ? "[ " + v.map(inline).join(", ") + " ]" : "[]";
  const e = Object.entries(v).filter(([, x]) => x !== undefined);
  return e.length ? "{ " + e.map(([k, x]) => JSON.stringify(k) + ": " + inline(x)).join(", ") + " }" : "{}";
}
function pretty(v, ind = "", step = "  ") {
  const flat = inline(v);
  if (v === null || typeof v !== "object" || flat.length + ind.length <= 100) return flat;
  const inner = ind + step;
  if (Array.isArray(v)) return "[\n" + v.map(x => inner + pretty(x, inner, step)).join(",\n") + "\n" + ind + "]";
  return "{\n" + Object.entries(v).filter(([, x]) => x !== undefined)
    .map(([k, x]) => inner + JSON.stringify(k) + ": " + pretty(x, inner, step)).join(",\n") + "\n" + ind + "}";
}
function validateSong(S) {
  if (!S.title || !S.artist) throw httpError(400, "title and artist are needed");
  if (S.genre && !GENRES.includes(S.genre)) throw httpError(400, `unknown genre ${S.genre}`);
  if (Array.isArray(S.effects)) validateEffects(S.effects);
}
function validateEffects(list) {
  if (!Array.isArray(list)) throw httpError(400, "effects must be a list");
  for (const f of list) {
    if (f.cmd != null) continue;  // raw script call
    if (!EFFECTS[f.effect]) throw httpError(400, `unknown effect "${f.effect}" (known: ${Object.keys(EFFECTS).join(", ")})`);
    if (typeof f.from !== "number" || (f.to != null && (typeof f.to !== "number" || f.to <= f.from))) throw httpError(400, `effect ${f.effect}: "from" must be a number and "to" later than it`);
  }
}
function writeSong(folder, S) {
  validateSong(S);
  const dir = songDir(folder), f = path.join(dir, "song.json");
  fs.mkdirSync(dir, { recursive: true });
  const text = pretty(S) + "\n";
  JSON.parse(text);
  if (fs.existsSync(f)) {
    if (fs.readFileSync(f, "utf8") === text) return;  // nothing changed: keep the file (and its build status) as it is
    fs.copyFileSync(f, path.join(dir, "song.json.bak"));
  }
  fs.writeFileSync(f, text);
}
const mtime = f => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };

// ---------- build inputs: a hash of everything a build reads from the song folder ----------
// Stored in build/inputs.json after a successful build; "changed since build" compares against it.
function inputsHash(folder) {
  const dir = songDir(folder), S = readSong(folder), h = crypto.createHash("sha1");
  const add = f => { try { h.update(f + "\0"); h.update(fs.readFileSync(f)); } catch { h.update(f + "\0missing"); } };
  h.update(JSON.stringify(S));
  if (S.chart) add(path.resolve(dir, S.chart));
  if (S.midi) add(path.resolve(dir, S.midi));
  if (typeof S.effects === "string") add(path.resolve(dir, S.effects));
  for (const k of Object.keys(S.stems || {})) { const p = path.resolve(dir, S.stems[k]); try { const st = fs.statSync(p); h.update(`${p}\0${st.size}\0${st.mtimeMs}`); } catch { h.update(p + "\0missing"); } }
  return h.digest("hex");
}

// ---------- built chart: gem counts and star thresholds per difficulty ----------
const builtCache = new Map();
function builtInfo(folder) {
  const f = path.join(songDir(folder), "build", "BEATMATCH.STR.EDAT"), m = mtime(f);
  if (!m) return null;
  const c = builtCache.get(f);
  if (c && c.m === m) return c.v;
  const bm = fs.readFileSync(f);
  const v = sections(bm).map((s, d) => {
    const b = Buffer.from(bm.subarray(s.start, s.start + s.size));
    let gems = [0, 0, 0, 0];
    try { gems = chartFromImage(new Image(b, d)).gems.map(g => g.n); } catch { /* old builds */ }
    return { gems, max: b.readUInt32LE(0x308), stars: [0x30c, 0x310, 0x314, 0x318, 0x31c, 0x320].map(o => b.readUInt32LE(o)),
      length: +(b.readFloatLE(0x124) / 1000).toFixed(2) };
  });
  builtCache.set(f, { m, v });
  return v;
}

// ---------- stems: level, active share, clipping, DC, bleed (from the prepared WAVs in build/wav) ----------
const stemCache = new Map();
function wavData(p) {
  const b = fs.readFileSync(p);
  let o = 12, fmt = null;
  while (o + 8 <= b.length) {
    const id = b.toString("ascii", o, o + 4), sz = b.readUInt32LE(o + 4);
    if (id === "fmt ") fmt = { ch: b.readUInt16LE(o + 10), rate: b.readUInt32LE(o + 12), bits: b.readUInt16LE(o + 22), tag: b.readUInt16LE(o + 8) };
    if (id === "data") return { b, off: o + 8, len: Math.min(sz, b.length - o - 8), fmt };
    o += 8 + sz + (sz & 1);
  }
  throw new Error(p + ": no data chunk");
}
function stemStats(p) {
  const m = mtime(p);
  if (!m) return null;
  const c = stemCache.get(p);
  if (c && c.m === m) return c.v;
  const w = wavData(p);
  let v;
  if (!w.fmt || w.fmt.bits !== 16 || w.fmt.ch !== 1) v = { note: "not 16-bit mono" };
  else {
    const n = w.len >> 1, hop = w.fmt.rate / 20, F = Math.floor(n / hop), lev = new Float64Array(F), env = new Float64Array(F);
    let peak = 0, sq = 0, clip = 0, sum = 0;
    for (let f = 0; f < F; f++) {
      let e = 0;
      for (let i = f * hop; i < (f + 1) * hop; i++) {
        const raw = w.b.readInt16LE(w.off + i * 2), s = raw / 32768, a = Math.abs(s);
        e += s * s; sum += s; if (a > peak) peak = a; if (raw >= 32767 || raw <= -32767) clip++;
      }
      sq += e; env[f] = Math.sqrt(e / hop); lev[f] = 10 * Math.log10(e / hop + 1e-12);
    }
    const sorted = Array.from(lev).sort((a, b) => a - b), loud = sorted[Math.floor(F * 0.95)] ?? -120;
    const active = Array.from(lev).filter(x => x > loud - 30 && x > -60).length / Math.max(1, F);
    const db = x => +(20 * Math.log10(x || 1e-9)).toFixed(1);
    const dc = sum / Math.max(1, n);
    v = { seconds: +(n / w.fmt.rate).toFixed(2), peak: db(peak), rms: db(Math.sqrt(sq / Math.max(1, n))), loud: +loud.toFixed(1),
      active: +(active * 100).toFixed(0), silent: loud < -60, clip, dc: +(dc * 100).toFixed(2), _env: env };
  }
  stemCache.set(p, { m, v });
  return v;
}
// Correlation of two stems' level envelopes: AI separations that leave the kit in the bass (or vice versa) correlate highly.
function envCorr(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 20) return null;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; sab += x * y; saa += x * x; sbb += y * y; }
  return saa && sbb ? +(sab / Math.sqrt(saa * sbb)).toFixed(2) : null;
}
function sourceInfo(file) {
  try {
    const st = fs.statSync(file), ext = path.extname(file).toLowerCase(), info = { ext: ext.slice(1), mb: +(st.size / 1048576).toFixed(1) };
    if (ext === ".wav") { const w = wavData(file); if (w.fmt) Object.assign(info, { rate: w.fmt.rate, bits: w.fmt.bits, ch: w.fmt.ch, float: w.fmt.tag === 3 }); }
    return info;
  } catch { return null; }
}

function summary(folder) {
  const S = readSong(folder), dir = songDir(folder), B = path.join(dir, "build");
  const edat = path.join(OUT, folder, "BEATMATCH.STR.EDAT"), built = mtime(edat);
  let audio = null, stored = null;
  try { audio = JSON.parse(fs.readFileSync(path.join(B, "audio.json"), "utf8")); } catch { }
  try { stored = JSON.parse(fs.readFileSync(path.join(B, "inputs.json"), "utf8")).hash; } catch { }
  let status = "not built";
  if (built) {
    if (stored) status = stored === inputsHash(folder) ? "built" : "changed since build";
    else status = mtime(path.join(dir, "song.json")) > built ? "changed since build" : "built";
  }
  return {
    folder, song: S, audio, status, builtAt: built || null,
    chartSource: S.chart ? "edited" : S.midi ? "midi" : "stems",
    built: builtInfo(folder),
  };
}
function details(folder) {
  const s = summary(folder), dir = songDir(folder), S = s.song;
  const envs = {};
  s.stems = Object.entries(STEM_KEYS).map(([k, track]) => {
    const src = S.stems && S.stems[k];
    const st = stemStats(path.join(dir, "build", "wav", track + ".wav"));
    if (st && st._env) envs[k] = st._env;
    const stats = st ? Object.fromEntries(Object.entries(st).filter(([key]) => key !== "_env")) : null;
    return { part: k, track, source: src || null, exists: src ? fs.existsSync(path.resolve(dir, src)) : null,
      format: src && fs.existsSync(path.resolve(dir, src)) ? sourceInfo(path.resolve(dir, src)) : null, stats };
  });
  s.bleed = [];
  const keys = Object.keys(envs);
  for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) {
    const c = envCorr(envs[keys[i]], envs[keys[j]]);
    if (c != null && c >= 0.6) s.bleed.push({ a: keys[i], b: keys[j], corr: c });
  }
  s.effects = loadEffects(folder, S);
  s.reaper = fs.existsSync(path.join(REAPER, folder, `${folder}_auto.mid`));
  s.buildLog = fs.existsSync(path.join(dir, "build", "build.log"));
  return s;
}
function loadEffects(folder, S) {
  if (typeof S.effects === "string") {
    try { return JSON.parse(fs.readFileSync(path.resolve(songDir(folder), S.effects), "utf8")); } catch { return []; }
  }
  return S.effects || [];
}

// ---------- chart (Rock Band-format MIDI) ----------
function chartPath(folder, auto = false) {
  const S = readSong(folder);
  if (S.chart && !auto) return { file: path.resolve(songDir(folder), S.chart), source: "edited" };
  const a = path.join(REAPER, folder, `${folder}_auto.mid`);
  if (fs.existsSync(a)) return { file: a, source: "auto" };
  return null;
}

// ---------- chart checks: the rules seen in the official charts (FINDINGS §28-33) ----------
const PART_NAMES = { drums: ["PART DRUMS"], bass: ["PART BASS"], guitar: ["PART GUITAR"], vocals: ["PART KEYS", "PART VOCALS"] };
const DIFF_NAMES = ["Easy", "Medium", "Hard", "Expert"];
function tempoMap(midi) {
  const segs = [];
  for (const tr of midi.tracks) for (const e of tr.events) if (e.d[0] === 0xff && e.d[1] === 0x51) segs.push({ t: e.t, us: (e.d[3] << 16) | (e.d[4] << 8) | e.d[5] });
  segs.sort((a, b) => a.t - b.t);
  if (!segs.length || segs[0].t > 0) segs.unshift({ t: 0, us: 500000 });
  let s = 0;
  segs.forEach((g, i) => { if (i) s += (g.t - segs[i - 1].t) * segs[i - 1].us / 1e6 / midi.tpb; g.s = s; });
  return t => { let g = segs[0]; for (const x of segs) if (x.t <= t) g = x; else break; return g.s + (t - g.t) * g.us / 1e6 / midi.tpb; };
}
function chartChecks(folder) {
  const c = chartPath(folder);
  if (!c || !fs.existsSync(c.file)) return { source: null, items: [{ level: "info", msg: "no chart yet: build the song once" }] };
  const midi = MIDI.parse(fs.readFileSync(c.file)), sec = tempoMap(midi), items = [], tpb = midi.tpb;
  let audio = null;
  try { audio = JSON.parse(fs.readFileSync(path.join(songDir(folder), "build", "audio.json"), "utf8")); } catch { }
  const S = readSong(folder);
  const push = (level, part, msg, at) => items.push({ level, part, msg, at: at != null ? +at.toFixed(2) : undefined });
  for (const [part, names] of Object.entries(PART_NAMES)) {
    const tr = midi.tracks.find(t => names.includes(t.name));
    if (!tr) { push("warn", part, "no track in the chart (the part will be empty)"); continue; }
    const off = part === "drums" ? 1 : 0;
    const solos = tr.notes.filter(n => n.n === 103), od = tr.notes.filter(n => n.n === 116).sort((a, b) => a.t - b.t);
    if (solos.length > 4) push("error", part, `${solos.length} solos; the chart format holds at most 4`);
    for (const s of solos) if (s.l <= tpb) push("error", part, `solo at ${sec(s.t).toFixed(2)} s is shorter than a beat (mid2rbu drops it)`, sec(s.t));
    for (let i = 1; i < od.length; i++) if (sec(od[i].t) - sec(od[i - 1].t + od[i - 1].l) < 2) push("warn", part, `overdrive phrases ${i} and ${i + 1} are ${(sec(od[i].t) - sec(od[i - 1].t + od[i - 1].l)).toFixed(1)} s apart (official: several bars)`, sec(od[i].t));
    for (let d = 3; d >= 0; d--) {
      const base = 60 + 12 * d + off, gems = tr.notes.filter(n => n.n >= base && n.n < base + 4).sort((a, b) => a.t - b.t);
      const dn = DIFF_NAMES[d];
      if (!gems.length) { if (d === 3) push("warn", part, "no Expert gems"); continue; }
      if (S.reduce && d < 3) continue;  // remade from Expert at build time
      const first = sec(gems[0].t), last = gems[gems.length - 1];
      if (first < 2.77) push("warn", part, `${dn}: first gem at ${first.toFixed(2)} s; official charts never start before 2.77 s`, first);
      if (audio && sec(last.t + last.l) > audio.audioSeconds) push("error", part, `${dn}: a gem ends at ${sec(last.t + last.l).toFixed(2)} s, after the audio (${audio.audioSeconds.toFixed(2)} s)`, sec(last.t));
      // chords (same tick), holds, density
      const byTick = new Map();
      for (const g of gems) byTick.set(g.t, (byTick.get(g.t) || 0) + 1);
      const onsets = [...byTick.keys()].sort((a, b) => a - b), chords = [...byTick.values()].filter(n => n > 1).length;
      // official: 3-gem chords on Expert guitar only (0.4 % of its gems, p50 4 per song); 4-gem chords practically never
      const triples = [...byTick.values()].filter(n => n === 3).length, quads = [...byTick.values()].filter(n => n > 3).length;
      if (quads) push("warn", part, `${dn}: ${quads} chord${quads > 1 ? "s" : ""} of 4 gems (official charts: practically never)`, sec(onsets.find(t => byTick.get(t) > 3)));
      if (triples && (d < 3 || part !== "guitar")) push("warn", part, `${dn}: ${triples} chord${triples > 1 ? "s" : ""} of 3 gems (official: Expert guitar only)`, sec(onsets.find(t => byTick.get(t) === 3)));
      else if (triples > Math.max(2, onsets.length * 0.02)) push("warn", part, `${dn}: ${triples} chords of 3 gems (official: about 4 per song)`, sec(onsets.find(t => byTick.get(t) === 3)));
      const chordShare = chords / onsets.length;
      if (part === "guitar" && chordShare > 0.55) push("warn", part, `${dn}: ${(chordShare * 100).toFixed(0)}% chords (official guitar: 4-49%, median 19%)`);
      if ((part === "bass" || part === "vocals") && chordShare > 0.05) push("warn", part, `${dn}: ${(chordShare * 100).toFixed(0)}% chords (official ${part}: almost none)`);
      if (part === "drums" && chords) push("info", part, `${dn}: ${chords} drum chords (official drums have some, as flams and kick+snare)`);
      // official Expert charts (90th percentile): held gems bass 26%, guitar 18%, vocals 44%; drums never
      const holds = gems.filter(g => g.l > 160).length / gems.length, holdLimit = { bass: 0.3, guitar: 0.25, vocals: 0.5 }[part];
      if (part === "drums" && holds > 0) push("error", part, `${dn}: ${gems.filter(g => g.l > 160).length} held drum gems; official drums are never held`, sec(gems.find(g => g.l > 160).t));
      else if (holds > holdLimit) push("warn", part, `${dn}: ${(holds * 100).toFixed(0)}% held gems (official ${part}: up to ~${holdLimit * 100}%)`);
      // density: onsets per second in any 2 s window
      let worst = 0, worstAt = 0;
      for (let i = 0, j = 0; i < onsets.length; i++) {
        while (j < onsets.length && sec(onsets[j]) - sec(onsets[i]) <= 2) j++;
        if (j - i > worst) { worst = j - i; worstAt = sec(onsets[i]); }
      }
      // official Expert charts, busiest 2 s window (90th percentile): drums 10.5, bass 8.5, guitar 11.5, vocals 6.5 gems/s
      const limit = { drums: 11, bass: 9, guitar: 12, vocals: 7 }[part];
      if (worst / 2 > limit) push("warn", part, `${dn}: ${(worst / 2).toFixed(1)} gems/s around ${worstAt.toFixed(1)} s (official ${part}: up to ~${limit}/s)`, worstAt);
      // vocals: gap after a hold
      if (part === "vocals") for (let i = 1; i < gems.length; i++) { const p = gems[i - 1]; if (p.l > 160 && sec(gems[i].t) - sec(p.t + p.l) < 0.25 && gems[i].t !== p.t) { push("warn", part, `${dn}: a gem ${(sec(gems[i].t) - sec(p.t + p.l)).toFixed(2)} s after a held one at ${sec(p.t).toFixed(2)} s (official: ≥ 0.3 s)`, sec(p.t)); break; } }
      // tiny gaps on the same lane
      for (let i = 1; i < gems.length; i++) if (gems[i].n === gems[i - 1].n && gems[i].t !== gems[i - 1].t && sec(gems[i].t) - sec(gems[i - 1].t) < 0.08) { push("warn", part, `${dn}: two gems on one lane ${((sec(gems[i].t) - sec(gems[i - 1].t)) * 1000).toFixed(0)} ms apart at ${sec(gems[i].t).toFixed(2)} s`, sec(gems[i].t)); break; }
      // solos must end at or before the last gem
      for (const s of solos) if (s.t + s.l > last.t + 1) push("warn", part, `${dn}: solo at ${sec(s.t).toFixed(2)} s ends after the part's last gem (mksong clamps it)`, sec(s.t));
    }
  }
  if (audio && audio.musicStart != null && audio.musicStart < 2.9) push("warn", null, `the music starts at ${audio.musicStart} s; official songs leave ~3 s (set "leadIn")`);
  const order = { error: 0, warn: 1, info: 2 };
  items.sort((a, b) => order[a.level] - order[b.level] || (a.at ?? 1e9) - (b.at ?? 1e9));
  return { source: c.source, items };
}

// ---------- audio: the five tracks as the game plays them ----------
function audioFile(folder, track) {
  if (!TRACKS.includes(track)) throw httpError(400, "bad track");
  const B = path.join(songDir(folder), "build");
  if (track === "fill" && fs.existsSync(path.join(B, "at3", "countin.json")) && fs.existsSync(path.join(B, "countin_fill.wav")))
    return path.join(B, "countin_fill.wav");
  for (const f of [path.join(B, "wav_tail", track + ".wav"), path.join(REAPER, folder, track + ".wav")])
    if (fs.existsSync(f)) return f;
  return null;
}

// ---------- builds (one at a time, output streamed to the page and written to build/build.log) ----------
let build = null;  // { folder, from, lines: [], done: false, code, listeners: Set }
function startBuild(folder, from) {
  if (build && !build.done) throw httpError(409, `a build of ${build.folder} is running`);
  if (!["audio", "chart", "db"].includes(from)) throw httpError(400, "bad stage");
  readSong(folder);
  const setup = settings.check();
  if (!setup.ok) throw httpError(400, "setup incomplete: " + Object.entries(setup.checks).filter(([, c]) => !c.ok).map(([k]) => k).join(", ") + " (see Setup)");
  const hash = inputsHash(folder);
  const B = path.join(songDir(folder), "build"); fs.mkdirSync(B, { recursive: true });
  const logFile = path.join(B, "build.log"), log = fs.createWriteStream(logFile);
  log.write(`# ${new Date().toISOString()} mksong ${folder} --from ${from}\n`);
  const args = [path.join(SCRIPTS, "mksong.js"), path.join(songDir(folder), "song.json"), "--from", from];
  const p = spawn(process.execPath, args, { cwd: SCRIPTS });
  build = { folder, from, lines: [], done: false, code: null, listeners: new Set(), started: Date.now() };
  const b = build;
  const push = line => { b.lines.push(line); log.write(line + "\n"); for (const l of b.listeners) l("line", line); };
  let rest = { out: "", err: "" };
  const feed = (k, chunk) => {
    rest[k] += chunk.toString("utf8");
    const parts = rest[k].split(/\r?\n/); rest[k] = parts.pop();
    parts.forEach(push);
  };
  p.stdout.on("data", c => feed("out", c));
  p.stderr.on("data", c => feed("err", c));
  p.on("close", code => {
    if (rest.out) push(rest.out); if (rest.err) push(rest.err);
    log.end(`# exit ${code}\n`);
    if (code === 0) fs.writeFileSync(path.join(B, "inputs.json"), JSON.stringify({ hash, from, at: new Date().toISOString() }));
    b.done = true; b.code = code;
    for (const l of b.listeners) l("end", String(code));
  });
  return b;
}

// ---------- file browser (to pick stems and MIDIs) ----------
function listDir(dir) {
  dir = path.resolve(dir || path.join(TOOLS, "customs"));
  if (!fs.existsSync(dir)) dir = TOOLS;
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => !e.name.startsWith("."))
    .map(e => ({ name: e.name, dir: e.isDirectory() }))
    .sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
  return { dir, parent: path.dirname(dir) !== dir ? path.dirname(dir) : null, entries };
}
function openFolder(folder, what) {
  const dir = what === "out" ? OUT : what === "song" ? songDir(folder) : what === "outsong" ? path.join(OUT, folder) : null;
  if (!dir || !fs.existsSync(dir)) throw httpError(404, "no such folder yet");
  spawn("explorer.exe", [dir.split("/").join("\\")], { detached: true, stdio: "ignore" }).unref();
  return dir;
}

// ---------- HTTP ----------
function httpError(code, msg) { const e = new Error(msg); e.code = code; return e; }
function body(req) {
  return new Promise((res, rej) => {
    const c = []; let n = 0;
    req.on("data", d => { n += d.length; if (n > 64 << 20) rej(httpError(413, "too big")); else c.push(d); });
    req.on("end", () => { try { res(c.length ? JSON.parse(Buffer.concat(c).toString("utf8")) : {}); } catch { rej(httpError(400, "bad JSON")); } });
    req.on("error", rej);
  });
}
const json = (res, v, code = 200) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".ico": "image/x-icon" };

async function route(req, res) {
  const u = new URL(req.url, "http://localhost"), p = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const M = req.method;
  if (p[0] !== "api") {
    const f = path.join(PUB, p.length ? p.join("/") : "index.html");
    if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) throw httpError(404, "not found");
    res.writeHead(200, { "content-type": TYPES[path.extname(f)] || "application/octet-stream", "cache-control": "no-store" });
    return fs.createReadStream(f).pipe(res);
  }
  const [, what, folder, extra] = p;
  if (what === "meta" && M === "GET")
    return json(res, { genres: GENRES, effects: Object.keys(EFFECTS), tools: TOOLS, out: OUT, starFractions: STAR_FRACTIONS, setupOk: settings.check().ok, audioExt: AUDIO_EXT, midiExt: MIDI_EXT });
  if (what === "setup" && M === "GET") return json(res, { ...settings.check(), file: settings.FILE });
  if (what === "settings" && M === "PUT") { settings.save(await body(req)); return json(res, { ...settings.check(), file: settings.FILE }); }
  if (what === "songs" && M === "GET") {
    const list = fs.existsSync(SONGS) ? fs.readdirSync(SONGS).filter(d => FOLDER_RE.test(d) && fs.existsSync(path.join(SONGS, d, "song.json"))) : [];
    return json(res, list.map(d => { try { return summary(d); } catch (e) { return { folder: d, error: e.message }; } }));
  }
  if (what === "song" && M === "GET") return json(res, details(folder));
  if (what === "song" && M === "PUT") {
    const S = await body(req);
    if (S.folder !== folder) throw httpError(400, "folder can not change");
    writeSong(folder, S);
    return json(res, details(folder));
  }
  if (what === "new" && M === "POST") {
    const S = await body(req);
    if (!FOLDER_RE.test(S.folder || "")) throw httpError(400, "folder: Z + capital letters/digits, e.g. ZMYSONG");
    if (fs.existsSync(path.join(SONGS, S.folder))) throw httpError(409, "that folder already exists");
    // required on a new song: every detail and the four instrument stems (backing is optional)
    const missing = ["title", "artist", "album", "genre"].filter(k => !String(S[k] || "").trim());
    if (!(Number.isInteger(S.year) && S.year >= 1900 && S.year <= new Date().getFullYear())) missing.push("year");
    if (S.vocals !== 1 && S.vocals !== 2) missing.push("lead vocals");
    for (const k of ["drums", "bass", "guitar", "vocals"]) {
      const f = S.stems && S.stems[k];
      if (!f) missing.push(`${k} stem`);
      else if (!fs.existsSync(path.resolve(f))) throw httpError(400, `${k} stem not found: ${f}`);
    }
    if (S.midi && !fs.existsSync(path.resolve(S.midi))) throw httpError(400, `MIDI not found: ${S.midi}`);
    if (missing.length) throw httpError(400, "missing: " + missing.join(", "));
    const dir = songDir(S.folder);
    // dropped files sit in incoming/: move them into the song's own stems/ folder
    const own = f => {
      const abs = path.resolve(f);
      if (!abs.startsWith(INCOMING + path.sep)) return abs;
      const dest = path.join(dir, "stems", path.basename(abs));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      try { fs.renameSync(abs, dest); } catch { fs.copyFileSync(abs, dest); fs.rmSync(abs, { force: true }); }
      return dest;
    };
    for (const k of Object.keys(S.stems || {})) {
      if (!S.stems[k]) delete S.stems[k];
      else S.stems[k] = path.relative(dir, own(S.stems[k])).split(path.sep).join("/");
    }
    if (S.midi) S.midi = path.relative(dir, own(S.midi)).split(path.sep).join("/");
    writeSong(S.folder, S);
    return json(res, details(S.folder));
  }
  if (what === "upload" && M === "POST") {  // a dropped file (the page can not see its path): saved to incoming/<batch>/
    const name = path.basename(String(u.searchParams.get("name") || "")).replace(/[<>:"|?*\x00-\x1f]/g, "_");
    const ext = path.extname(name).toLowerCase();
    if (!AUDIO_EXT.includes(ext) && !MIDI_EXT.includes(ext)) throw httpError(400, `${name}: unsupported format (audio: ${AUDIO_EXT.join(" ")}; MIDI: ${MIDI_EXT.join(" ")})`);
    const batch = String(u.searchParams.get("batch") || "").replace(/[^a-z0-9]/gi, "").slice(0, 24) || Date.now().toString(36);
    const dest = path.join(INCOMING, batch, name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    await new Promise((ok, bad) => {
      let n = 0;
      const out = fs.createWriteStream(dest);
      req.on("data", d => { n += d.length; if (n > 1024 << 20) { req.destroy(); out.destroy(); bad(httpError(413, "file larger than 1 GB")); } });
      req.pipe(out);
      out.on("finish", ok); out.on("error", bad); req.on("error", bad);
    });
    return json(res, { path: dest, name, size: fs.statSync(dest).size });
  }
  if (what === "relpath" && M === "GET") {  // absolute path -> relative to the song folder (for the stems form)
    return json(res, { rel: path.relative(songDir(folder), path.resolve(u.searchParams.get("p"))).split(path.sep).join("/") });
  }
  if (what === "chart" && M === "GET") {
    const c = chartPath(folder, u.searchParams.get("auto") === "1");
    if (!c || !fs.existsSync(c.file)) throw httpError(404, "no chart yet: build the song once");
    let audio = null;
    try { audio = JSON.parse(fs.readFileSync(path.join(songDir(folder), "build", "audio.json"), "utf8")); } catch { }
    return json(res, { source: c.source, file: c.file, midi: MIDI.parse(fs.readFileSync(c.file)), audio, hasAuto: !!chartPath(folder, true) });
  }
  if (what === "chart" && M === "PUT") {
    const { midi, reduce } = await body(req);
    const buf = MIDI.write(midi);
    MIDI.parse(buf);
    const dir = songDir(folder), f = path.join(dir, "chart.mid");
    if (fs.existsSync(f)) fs.copyFileSync(f, path.join(dir, "chart.mid.bak"));
    fs.writeFileSync(f, buf);
    const S = readSong(folder);
    S.chart = "chart.mid";
    if (reduce !== undefined) { if (reduce) S.reduce = true; else delete S.reduce; }
    writeSong(folder, S);
    return json(res, { ok: true, file: f, checks: chartChecks(folder) });
  }
  if (what === "chart-revert" && M === "POST") {
    const S = readSong(folder);
    delete S.chart;
    writeSong(folder, S);
    return json(res, { ok: true });
  }
  if (what === "checks" && M === "GET") return json(res, chartChecks(folder));
  if (what === "effects" && M === "PUT") {
    const { effects } = await body(req);
    validateEffects(effects);
    const S = readSong(folder);
    if (typeof S.effects === "string") fs.writeFileSync(path.resolve(songDir(folder), S.effects), pretty(effects) + "\n");
    else { if (effects.length) S.effects = effects; else delete S.effects; writeSong(folder, S); }
    return json(res, { ok: true });
  }
  if (what === "audio" && M === "GET") {
    const f = audioFile(folder, extra);
    if (!f) throw httpError(404, "no audio yet: build the song once");
    res.writeHead(200, { "content-type": "audio/wav", "content-length": fs.statSync(f).size, "cache-control": "no-store" });
    return fs.createReadStream(f).pipe(res);
  }
  if (what === "build" && M === "POST") {
    const b = startBuild(folder, u.searchParams.get("from") || "audio");
    return json(res, { started: b.started });
  }
  if (what === "build" && M === "GET") {  // server-sent events: the running (or last) build's output
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    const send = (ev, data) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
    if (!build) { send("end", "none"); return res.end(); }
    send("start", { folder: build.folder, from: build.from });
    build.lines.forEach(l => send("line", l));
    if (build.done) { send("end", String(build.code)); return res.end(); }
    const l = (ev, data) => { send(ev, data); if (ev === "end") res.end(); };
    build.listeners.add(l);
    const b = build;
    req.on("close", () => b.listeners.delete(l));
    return;
  }
  if (what === "buildlog" && M === "GET") {  // the last build's log of a song, from disk (survives a server restart)
    const f = path.join(songDir(folder), "build", "build.log");
    if (!fs.existsSync(f)) throw httpError(404, "this song has no build log yet");
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    return fs.createReadStream(f).pipe(res);
  }
  if (what === "ls" && M === "GET") return json(res, listDir(u.searchParams.get("dir")));
  if (what === "open" && M === "POST") return json(res, { dir: openFolder(folder, u.searchParams.get("what")) });
  throw httpError(404, "unknown API call");
}

const server = http.createServer((req, res) => {
  // local page only: refuse other hosts (DNS rebinding) and cross-site writes
  const host = (req.headers.host || "").replace(/:\d+$/, "");
  if (!["localhost", "127.0.0.1"].includes(host)) { res.writeHead(403); return res.end("forbidden"); }
  const origin = req.headers.origin;
  if (origin && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) { res.writeHead(403); return res.end("forbidden"); }
  route(req, res).catch(e => {
    if (!res.headersSent) json(res, { error: e.message }, e.code >= 400 && e.code < 600 ? e.code : 500);
    else res.end();
    if (!(e.code >= 400 && e.code < 500)) console.error(e);
  });
});
// --open: an app window (Edge or Chrome in app mode, no tabs or address bar) if one is installed, else the default browser.
function openWindow(url) {
  const pf = [process.env["ProgramFiles(x86)"], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
  const cands = pf.flatMap(d => [path.join(d, "Microsoft", "Edge", "Application", "msedge.exe"), path.join(d, "Google", "Chrome", "Application", "chrome.exe")]);
  const exe = cands.find(f => fs.existsSync(f));
  if (exe) spawn(exe, [`--app=${url}`, "--window-size=1500,1000", `--user-data-dir=${path.join(TOOLS, "pocketencore", ".window")}`], { detached: true, stdio: "ignore" }).unref();
  else spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
}
server.listen(PORT, "127.0.0.1", () => {
  const url = `http://localhost:${PORT}`;
  console.log(`Pocket Encore: ${url}  (close this window or press Ctrl+C to stop)`);
  if (process.argv.includes("--open")) openWindow(url);
});
server.on("error", async e => {
  if (e.code === "EADDRINUSE") {
    // already running (e.g. started twice): just open its window
    const url = `http://localhost:${PORT}`;
    try {
      const r = await fetch(url + "/api/meta", { signal: AbortSignal.timeout(3000) });
      if (r.ok && (await r.json()).genres) {
        console.log(`Pocket Encore is already running at ${url}; opening its window.`);
        if (process.argv.includes("--open")) openWindow(url);
        setTimeout(() => process.exit(0), 500);
        return;
      }
    } catch { }
    console.error(`Port ${PORT} is used by another program. Close it, or start Pocket Encore on another port: pocketencore.cmd --port 8643`);
  } else console.error(e.message);
  process.exit(1);
});
