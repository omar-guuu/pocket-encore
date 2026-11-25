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
const { checkChart } = require("./checks.js");

const TOOLS = path.resolve(__dirname, "..");
const SONGS = path.join(TOOLS, "songs"), OUT = path.join(TOOLS, "out", "MUSIC"), REAPER = path.join(TOOLS, "reaper");
const SCRIPTS = path.join(TOOLS, "scripts"), PUB = path.join(__dirname, "public");
const { sections, Image, chartFromImage } = require(path.join(SCRIPTS, "beatmatch.js"));
const { EFFECTS, effectName } = require(path.join(SCRIPTS, "fxchart.js"));
const band = require(path.join(SCRIPTS, "band.js"));
const settings = require(path.join(SCRIPTS, "settings.js"));
const stick = require(path.join(SCRIPTS, "stick.js"));
const { createUpdater } = require("./update.js");
const PORT = Number((process.argv.find((a, i) => process.argv[i - 1] === "--port")) || 8642);
const TRACKS = ["drums", "bass_guitar", "lead_guitar", "vocals", "fill"];
const STEM_KEYS = { drums: "drums", bass: "bass_guitar", guitar: "lead_guitar", vocals: "vocals", fill: "fill" };
const GENRES = ["ALTERNATIVE", "BLUES", "CLASSIC ROCK", "COUNTRY", "EMO", "FUSION", "GLAM", "GRUNGE", "INDIE ROCK", "JAZZ",
  "METAL", "NOVELTY", "NU-METAL", "POP-ROCK", "PROG", "PUNK", "ROCK", "SOUTHERN ROCK", "URBAN"];
const FOLDER_RE = /^Z[A-Z0-9_]{1,30}$/;
const VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, "version.json"), "utf8")); } catch { return { version: "?", stage: "" }; } })();
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
  validateBand(S);
}
// singer prop, prop sections, mic changes and hand clips (the Effects & Band Anims tab; band.js)
function validateBand(S) {
  const num = v => typeof v === "number" && isFinite(v);
  if (S.singerProp != null && !band.PROPS.hasOwnProperty(S.singerProp)) throw httpError(400, `unknown singer prop "${S.singerProp}" (tambourine, cowbell, clap or none)`);
  if (S.singerSections != null) {
    if (!Array.isArray(S.singerSections)) throw httpError(400, "singerSections must be a list");
    for (const x of S.singerSections) if (!num(x.from) || !num(x.to) || x.to <= x.from || !band.PROPS[x.prop]) throw httpError(400, "each singer section needs a from, a later to and a prop (tambourine, cowbell or clap)");
  }
  if (S.singerMic != null) {
    if (!Array.isArray(S.singerMic)) throw httpError(400, "singerMic must be a list");
    for (const x of S.singerMic) if (!num(x.at) || !["rest", "perform"].includes(x.state)) throw httpError(400, 'each mic change needs an "at" time and a state, rest or perform');
  }
  if (S.bandClips != null) {
    if (!Array.isArray(S.bandClips)) throw httpError(400, "bandClips must be a list");
    for (const x of S.bandClips) if (!band.CLIPS[x.hand] || !band.CLIPS[x.hand].includes(x.clip) || !num(x.at)) throw httpError(400, `unknown clip "${x.clip}" for ${x.hand}`);
  }
}
function validateEffects(list) {
  if (!Array.isArray(list)) throw httpError(400, "effects must be a list");
  for (const f of list) {
    if (f.cmd != null) continue;  // raw script call
    if (!EFFECTS[effectName(f.effect)]) throw httpError(400, `unknown effect "${f.effect}" (known: ${Object.keys(EFFECTS).join(", ")})`);
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

// what the audio stages (prepwav, lead-in, loudness, at3tool, preview) read: the stems and the song.json keys they use
function audioInputsHash(folder) {
  const dir = songDir(folder), S = readSong(folder), h = crypto.createHash("sha1");
  h.update(JSON.stringify({ stems: S.stems || {}, gain: S.gain, leadIn: S.leadIn, countIn: !!S.countIn, tail: S.tail, loudness: S.loudness, preview: S.preview }));
  for (const k of Object.keys(S.stems || {})) { const p = path.resolve(dir, S.stems[k]); try { const st = fs.statSync(p); h.update(`${p}\0${st.size}\0${st.mtimeMs}`); } catch { h.update(p + "\0missing"); } }
  return h.digest("hex");
}
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
    chartSource: S.imported ? "imported" : S.chart ? "edited" : S.midi ? "midi" : "stems",
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
  let list = S.effects || [];
  if (typeof S.effects === "string") {
    try { list = JSON.parse(fs.readFileSync(path.resolve(songDir(folder), S.effects), "utf8")); } catch { return []; }
  }
  return list.map(f => f.effect ? { ...f, effect: effectName(f.effect) } : f);  // old names (blur) shown as today's
}

// ---------- chart (Rock Band-format MIDI) ----------
function chartPath(folder, auto = false) {
  const S = readSong(folder);
  if (S.chart && !auto) return { file: path.resolve(songDir(folder), S.chart), source: "edited" };
  const a = path.join(REAPER, folder, `${folder}_auto.mid`);
  if (fs.existsSync(a)) return { file: a, source: "auto" };
  return null;
}

// ---------- song database vs game mode ----------
// mksong writes songs/.db/mode.json with the mode ZZCUSTOMDB was built for; a different mode now (DLC added or
// removed) means the database must be rebuilt (any build does it).
function dbState(mode) {
  let last = null;
  try { last = JSON.parse(fs.readFileSync(path.join(SONGS, ".db", "mode.json"), "utf8")); } catch { }
  if (!fs.existsSync(path.join(OUT, "ZZCUSTOMDB"))) return { built: false, stale: false };
  if (!last) return { built: true, stale: false, unknown: true };
  return { built: true, stale: last.mode !== mode.mode || last.base !== mode.baseName, was: last.label, wasBase: last.base };
}

// ---------- chart checks (checks.js): the rules seen in the official charts ----------
function readAudio(folder) { try { return JSON.parse(fs.readFileSync(path.join(songDir(folder), "build", "audio.json"), "utf8")); } catch { return null; } }
function chartChecks(folder) {
  if (readSong(folder).imported) return { source: null, items: [{ level: "info", rule: "imported", msg: "imported song: its chart is played as it was shipped" }] };
  const c = chartPath(folder);
  if (!c || !fs.existsSync(c.file)) return { source: null, items: [{ level: "info", rule: "no-chart", msg: "no chart yet: build the song once" }] };
  const S = readSong(folder);
  return { source: c.source, items: checkChart(MIDI.parse(fs.readFileSync(c.file)), { reduce: !!S.reduce, audio: readAudio(folder) }) };
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
let build = null;  // the running (or last) job: { folder, from, lines: [], done, code, listeners: Set }
// A job runs its steps (node scripts) one after the other, streaming their output to the page and to a log file.
// step: { args: [script, ...], label, onDone(code, output lines) }
function runJob(folder, from, steps, logFile) {
  if (build && !build.done) throw httpError(409, `a build of ${build.folder} is running`);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const log = fs.createWriteStream(logFile);
  build = { folder, from, lines: [], done: false, code: null, listeners: new Set(), started: Date.now() };
  const b = build;
  const push = line => { b.lines.push(line); log.write(line + "\n"); for (const l of b.listeners) l("line", line); };
  const finish = code => { log.end(`# exit ${code}\n`); b.done = true; b.code = code; for (const l of b.listeners) l("end", String(code)); };
  let k = 0;
  const next = () => {
    if (k >= steps.length) return finish(0);
    const st = steps[k++];
    if (st.label) push(st.label);
    const p = spawn(process.execPath, st.args, { cwd: SCRIPTS });
    const rest = { out: "", err: "" }, all = [];
    const feed = (key, chunk) => {
      rest[key] += chunk.toString("utf8");
      const parts = rest[key].split(/\r?\n/); rest[key] = parts.pop();
      parts.forEach(l => { all.push(l); push(l); });
    };
    p.stdout.on("data", c => feed("out", c));
    p.stderr.on("data", c => feed("err", c));
    p.on("close", code => {
      for (const key of ["out", "err"]) if (rest[key]) { all.push(rest[key]); push(rest[key]); }
      try { if (st.onDone) st.onDone(code, all); } catch (e) { push("error: " + e.message); }
      if (code !== 0) return finish(code);
      next();
    });
  };
  next();
  return b;
}
function checkSetup() {
  const setup = settings.check();
  if (!setup.ok) throw httpError(400, "setup incomplete: " + Object.entries(setup.checks).filter(([, c]) => !c.ok).map(([k]) => k).join(", ") + " (see Setup)");
}
function songBuildStep(folder, from = "audio") {
  const hash = inputsHash(folder), B = path.join(songDir(folder), "build");
  // the audio inputs the built audio came from: new on an audio build, carried over on a chart build (the audio wasn't redone)
  const audioHash = from === "audio" ? audioInputsHash(folder) : (readInputs(folder) || {}).audioHash;
  return { args: [path.join(SCRIPTS, "mksong.js"), path.join(songDir(folder), "song.json"), "--from", from],
    onDone: code => { if (code === 0) { fs.mkdirSync(B, { recursive: true }); fs.writeFileSync(path.join(B, "inputs.json"), JSON.stringify({ hash, audioHash, from, at: new Date().toISOString() })); } } };
}
const readInputs = folder => { try { return JSON.parse(fs.readFileSync(path.join(songDir(folder), "build", "inputs.json"), "utf8")); } catch { return null; } };
// Rebuild song: the audio stages only when something they read changed (or nothing says what the audio was built from)
function autoStage(folder) {
  const S = readSong(folder), I = readInputs(folder);
  if (S.imported || !fs.existsSync(path.join(songDir(folder), "build", "audio.json")) || !I || !I.audioHash) return "audio";
  return I.audioHash === audioInputsHash(folder) ? "chart" : "audio";
}
function startBuild(folder, from) {
  if (!["audio", "chart", "db", "auto"].includes(from)) throw httpError(400, "bad stage");
  readSong(folder);
  if (from === "auto") from = autoStage(folder);
  checkSetup();
  const step = songBuildStep(folder, from);
  step.label = `# ${new Date().toISOString()} mksong ${folder} --from ${from}`;
  return runJob(folder, from, [step], path.join(songDir(folder), "build", "build.log"));
}

// ---------- packs: sets of songs with their own song database (songs/packs.json; built into out/PACKS/<name>) ----------
const PACKS_FILE = path.join(SONGS, "packs.json"), PACKS_OUT = path.join(TOOLS, "out", "PACKS");
// packs.json (in the repo): { packs: [{ id, name, songs, created }] }; what was built where is per machine:
// songs/.db/packs-built.json { <id>: mkpack's PACK info }
const PACKS_BUILT = path.join(SONGS, ".db", "packs-built.json");
function readPacks() { try { return JSON.parse(fs.readFileSync(PACKS_FILE, "utf8")).packs || []; } catch { return []; } }
function writePacks(packs) { fs.writeFileSync(PACKS_FILE, pretty({ packs: packs.map(({ id, name, songs, created }) => ({ id, name, songs, created })) }) + "\n"); }
function readBuilt() { try { return JSON.parse(fs.readFileSync(PACKS_BUILT, "utf8")); } catch { return {}; } }
function writeBuilt(b) { fs.mkdirSync(path.dirname(PACKS_BUILT), { recursive: true }); fs.writeFileSync(PACKS_BUILT, JSON.stringify(b, null, 1)); }
// JB number = days since 2008-03-07 (as mksong.js / mkpack.js)
function dayNumber(date = new Date()) { return Math.round((Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) - Date.UTC(2008, 2, 7)) / 86400000); }
const packName = p => (p.name || "").trim() || `Pocket Encore ${String(dayNumber()).padStart(6, "0")}`;
const safeDir = n => n.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/, "").slice(0, 80) || "Pack";
function songFolderMb(d) { try { const dir = path.join(OUT, d); return fs.readdirSync(dir).reduce((n, f) => n + fs.statSync(path.join(dir, f)).size, 0) / 1048576; } catch { return 0; } }
function packsView() {
  const mode = settings.gameMode();
  const list = fs.existsSync(SONGS) ? fs.readdirSync(SONGS).filter(d => FOLDER_RE.test(d) && fs.existsSync(path.join(SONGS, d, "song.json"))) : [];
  const status = Object.fromEntries(list.map(d => { try { return [d, summary(d)]; } catch { return [d, null]; } }));
  let official = 55;
  if (mode.mode !== "disc") { try { const f = fs.readdirSync(mode.base).find(x => /^JB\d{6}/i.test(x)); official = fs.readFileSync(path.join(mode.base, f)).readUInt32LE(0x30); } catch { official = 112; } }
  return {
    mode, official, capacity: 300 - official,
    songs: list.map(d => { const s = status[d]; return s ? { folder: d, title: s.song.title, artist: s.song.artist, genre: s.song.genre || "", status: s.status, mb: +songFolderMb(d).toFixed(1) } : { folder: d, error: true }; }),
    packs: readPacks().map(p => {
      const last = readBuilt()[p.id], built = last && last.dir && fs.existsSync(last.dir) ? last : null, name = (p.name || "").trim();
      // renamed: built under another name (an unnamed pack keeps the "Pocket Encore <code>" it was built with)
      const renamed = !!built && (name ? built.name !== name : !/^Pocket Encore \d{6}$/.test(built.name || ""));
      return { ...p, display: !name && built && !renamed ? built.name : packName(p), renamed, missing: p.songs.filter(f => !status[f]), outdated: p.songs.filter(f => status[f] && status[f].status !== "built"),
        mb: +p.songs.reduce((n, f) => n + songFolderMb(f), 0).toFixed(1), built }; }),
  };
}
function startPack(id) {
  const p = readPacks().find(x => x.id === id);
  if (!p) throw httpError(404, "no such pack");
  if (!p.songs.length) throw httpError(400, "the pack has no songs");
  checkSetup();
  const view = packsView(), known = new Map(view.songs.filter(s => !s.error).map(s => [s.folder, s]));
  const missing = p.songs.filter(f => !known.has(f));
  if (missing.length) throw httpError(400, `songs not found: ${missing.join(", ")}`);
  if (p.songs.length > view.capacity) throw httpError(400, `${p.songs.length} songs; the game holds ${view.capacity} custom songs in this mode`);
  const name = packName(p), dir = path.join(PACKS_OUT, safeDir(name));
  // songs that are new or changed are built first (whole song); the others are reused as they are
  const steps = p.songs.filter(f => known.get(f).status !== "built").map(f => ({ ...songBuildStep(f), label: `\n=== building ${f} (new or changed) ===` }));
  const args = [path.join(SCRIPTS, "mkpack.js"), "--out", dir, ...(p.name && p.name.trim() ? ["--name", p.name.trim()] : []), ...p.songs];
  steps.push({ args, label: `\n=== pack "${name}": ${p.songs.length} songs ===`, onDone: (code, lines) => {
    if (code !== 0) return;
    const line = lines.find(l => l.startsWith("PACK "));
    if (!line) return;
    const info = JSON.parse(line.slice(5)), built = readBuilt(), prev = built[id];
    // an earlier build of this pack under another folder name (unnamed packs carry the day's code) is replaced
    if (prev && prev.dir && path.resolve(prev.dir) !== path.resolve(dir) && path.resolve(prev.dir).startsWith(PACKS_OUT)) fs.rmSync(prev.dir, { recursive: true, force: true });
    built[id] = info;
    writeBuilt(built);
  } });
  return runJob(`pack "${name}"`, "pack", steps, path.join(SONGS, ".db", `pack-${id}.log`));
}

// ---------- memory sticks: what is installed, install, import (scripts/stick.js) ----------
const songList = () => fs.existsSync(SONGS) ? fs.readdirSync(SONGS).filter(d => FOLDER_RE.test(d) && fs.existsSync(path.join(SONGS, d, "song.json"))) : [];
// same build on both sides: build ids from the stamps, else (songs built before stamps) the game files' sizes and dates
function sameBuild(a, b, folder) {
  if (a.stamp && b.stamp && a.stamp.build && b.stamp.build) return a.stamp.build === b.stamp.build;
  const names = ["BEATMATCH.STR.EDAT", `${folder}.ATM`, `${folder}_PREVIEW.AT3`];
  return names.every(n => { const x = a.files[n], y = b.files[n]; return (!x && !y) || (x && y && x.size === y.size && Math.abs(x.mtime - y.mtime) <= 2); });
}
const folderMb = x => +(Object.values(x.files).reduce((n, y) => n + y.size, 0) / 1048576).toFixed(1);
// a memory stick (its scan) against built songs (src: a scan of out/MUSIC or of a pack's MUSIC)
// song states: installed (same build) · older / different (another build of it) · missing (not on the stick) ·
// extra (on the stick, not in src); listed = the database the game uses lists it (else the game hides it)
function stickView(st, scan, src, online, at) {
  scan = scan || {};
  const lib = new Set(songList()), mine = new Set(stick.dbHistory().map(h => h.sha1)), libId = stick.libraryId();
  const arch = new Set(archivedList()), off = new Set(readOff()[st.id] || []);
  const A = scan.active, srcDb = src.active;
  let db = null;
  if (A) {
    const custom = A.number > stick.OFFICIAL_MAX;
    db = { file: A.file, folder: A.folder, number: A.number, textOk: A.textOk !== false, customs: (A.customs || []).map(c => c.folder), pack: (A.stamp && A.stamp.pack) || null,
      others: A.others || [], tie: scan.tie || null,
      // current = the database just built; yours-older = an earlier build of this library; other = someone else's
      state: !custom ? "official" : srcDb && A.sha1 === srcDb.sha1 ? "current" : mine.has(A.sha1) || (A.stamp && A.stamp.library === libId) ? "yours-older" : "other" };
  }
  const listed = new Set(db ? db.customs : []);
  const names = f => {
    try { const S = readSong(f); return { title: S.title, artist: S.artist }; } catch { }
    try { const S = JSON.parse(fs.readFileSync(path.join(ARCHIVE, f, "song.json"), "utf8")); return { title: S.title, artist: S.artist }; } catch { }
    const s = scan.songs && scan.songs[f] && scan.songs[f].stamp;
    if (s && s.title) return { title: s.title, artist: s.artist };
    const c = A && A.textOk && (A.customs || []).find(x => x.folder === f);
    return c ? { title: c.title, artist: c.artist } : { title: null, artist: null };
  };
  const songs = [];
  // every song of the library (also those not made yet), every song built, every song folder on the stick
  for (const f of new Set([...lib, ...Object.keys(src.songs), ...Object.keys(scan.songs || {})])) {
    const a = src.songs[f], b = scan.songs && scan.songs[f];
    let state = !b ? "missing" : !a || !lib.has(f) ? "extra" : sameBuild(a, b, f) ? "installed" : "different";
    if (state === "different" && a.stamp && b.stamp && b.stamp.builtAt && a.stamp.builtAt && b.stamp.builtAt < a.stamp.builtAt) state = "older";
    // off: the user switched it off on the Memory stick page (so it isn't suggested again); archived: in songs/.archive
    songs.push({ folder: f, ...names(f), state, inLibrary: lib.has(f), built: !!a, listed: listed.has(f), mb: a ? folderMb(a) : b ? folderMb(b) : 0,
      stickMb: b ? folderMb(b) : 0, theirs: !!(b && b.stamp && b.stamp.library && b.stamp.library !== libId), stamped: !!(b && b.stamp),
      off: off.has(f), archived: arch.has(f) });
  }
  songs.sort((x, y) => x.folder.localeCompare(y.folder));
  return { id: st.id, kind: st.kind, label: st.label, music: st.music, online, at: at || new Date().toISOString(), exists: !!scan.exists, db, songs,
    srcDb: srcDb ? { file: srcDb.file, customs: (srcDb.customs || []).map(c => c.folder) } : null, freeMb: online ? freeMb(st.music) : null };
}
// free space where a MUSIC folder is (or would be), in MB
function freeMb(dir) {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    if (fs.existsSync(d)) { try { const s = fs.statfsSync(d); return Math.round(s.bavail * s.bsize / 1048576); } catch { return null; } }
    if (path.dirname(d) === d) return null;
  }
}
function sticksView() {
  const s = settings.load(), src = stick.scanMusic(OUT), conn = stick.connected(s.music);
  const out = conn.map(st => { const scan = stick.scanMusic(st.music); try { stick.remember(st, scan); } catch { } return stickView(st, scan, src, true); });
  // an unplugged PSP: its last check
  for (const r of Object.values(stick.remembered())) if (r.kind === "psp" && !conn.some(c => c.id === r.id)) out.push(stickView(r, r.scan, src, false, r.at));
  const archived = archivedList().map(f => { try { const S = JSON.parse(fs.readFileSync(path.join(ARCHIVE, f, "song.json"), "utf8")); return { folder: f, title: S.title, artist: S.artist, imported: !!S.imported }; } catch { return { folder: f, title: f }; } });
  return { sticks: out, archived, output: { db: src.active ? { file: src.active.file, customs: (src.active.customs || []).map(c => c.folder) } : null, songs: Object.keys(src.songs) } };
}

// ---------- the Memory stick page: "Add in game" switches -> one plan -> apply (scripts/stickapply.js) ----------
// The memory stick ends up with exactly the songs switched on, and a song database of yours that lists exactly them.
// Songs switched off are removed from the stick (they stay in your library) and remembered per stick, so the page
// doesn't suggest them again. Song folders that aren't in your library are only touched by an explicit Remove.
const ARCHIVE = path.join(SONGS, ".archive"), OFF_FILE = path.join(SONGS, ".db", "stick-off.json");
function archivedList() { return fs.existsSync(ARCHIVE) ? fs.readdirSync(ARCHIVE).filter(d => FOLDER_RE.test(d) && fs.existsSync(path.join(ARCHIVE, d, "song.json"))) : []; }
function readOff() { try { return JSON.parse(fs.readFileSync(OFF_FILE, "utf8")); } catch { return {}; } }
function writeOff(o) { fs.mkdirSync(path.dirname(OFF_FILE), { recursive: true }); fs.writeFileSync(OFF_FILE, JSON.stringify(o, null, 1)); }
function onlineStick(id) {
  const st = stick.connected(settings.load().music).find(x => x.id === id);
  if (!st) throw httpError(404, "that memory stick isn't connected");
  return st;
}
const ourDb = db => !!db && (db.state === "current" || db.state === "yours-older");
const brief = x => ({ folder: x.folder, title: x.title, artist: x.artist, state: x.state, mb: x.mb, stickMb: x.stickMb });
// b = { stick, want: [folders switched on] }
function stickPlan(b) {
  const st = onlineStick(b.stick), v = stickView(st, stick.scanMusic(st.music), stick.scanMusic(OUT), true);
  const want = new Set((b.want || []).map(String)), mine = v.songs.filter(x => x.inLibrary);
  const bad = [...want].filter(f => !mine.some(x => x.folder === f && x.built));
  if (bad.length) throw httpError(400, `not made yet, or not one of your songs: ${bad.join(", ")}`);
  const on = mine.filter(x => want.has(x.folder));
  const copy = on.filter(x => x.state !== "installed");                       // not on it, or another build of it
  const show = on.filter(x => x.state === "installed" && !x.listed);          // on it, but the song database hides it
  const keep = on.filter(x => x.state === "installed" && x.listed);
  const remove = mine.filter(x => !want.has(x.folder) && x.state !== "missing");
  const dbSongs = on.map(x => x.folder).sort();
  const same = ourDb(v.db) && JSON.stringify([...v.db.customs].sort()) === JSON.stringify(dbSongs);
  // write: a new song database listing exactly the songs switched on (also after copying: their details may have
  // changed); none: no song switched on, so your song database goes; keep: nothing to change (or someone else's stays)
  const db = dbSongs.length ? (same && !copy.length ? "keep" : "write") : ourDb(v.db) ? "none" : "keep";
  const others = v.songs.filter(x => !x.inLibrary && x.state !== "missing");
  return { stick: { id: st.id, label: st.label, kind: st.kind, music: st.music }, copy: copy.map(brief), show: show.map(brief), keep: keep.map(brief),
    remove: remove.map(brief), db, dbSongs, dbBefore: v.db ? { file: v.db.file, folder: v.db.folder, state: v.db.state, pack: v.db.pack, count: v.db.customs.length } : null,
    others: others.map(x => ({ ...brief(x), archived: x.archived, listed: x.listed })),
    mb: +copy.reduce((n, x) => n + x.mb, 0).toFixed(1), freeMb: v.freeMb,
    off: mine.filter(x => x.built && !want.has(x.folder)).map(x => x.folder),
    any: !!(copy.length || remove.length || db !== "keep") };
}
const stickArgs = (music, { copy = [], remove = [], db = null, dbNone = false }) => [path.join(SCRIPTS, "stickapply.js"), "--from", OUT, "--to", music,
  ...(copy.length ? ["--copy", copy.join(",")] : []), ...(db ? ["--db", db.join(",")] : dbNone ? ["--db-none"] : []), ...(remove.length ? ["--remove", remove.join(",")] : [])];
const rememberStick = st => () => { try { stick.remember(st, stick.scanMusic(st.music)); } catch { } };
function startStickApply(b) {
  const p = stickPlan(b);
  if (!p.any) throw httpError(400, "nothing to change: the memory stick already has these songs");
  const st = onlineStick(b.stick);
  const args = stickArgs(st.music, { copy: p.copy.map(x => x.folder), remove: p.remove.map(x => x.folder), db: p.db === "write" ? p.dbSongs : null, dbNone: p.db === "none" });
  return runJob(st.label, "stick", [{ args, label: `# ${new Date().toISOString()} memory stick: ${st.label} (${st.music})`,
    onDone: code => { rememberStick(st)(); if (code === 0) { const o = readOff(); o[st.id] = p.off; writeOff(o); } } }], path.join(SONGS, ".db", "stick.log"));
}
// a song database of yours that lists some of the folders being removed: written again without them
function dbWithout(v, folders) {
  if (!ourDb(v.db) || !v.db.customs.some(f => folders.includes(f))) return {};
  const rest = v.db.customs.filter(f => !folders.includes(f) && v.songs.some(x => x.folder === f && x.inLibrary && x.built && x.state !== "missing"));
  return rest.length ? { db: rest } : { dbNone: true };
}
// Remove from memory stick: custom song folders (Z...) that aren't in your library (archived songs, a friend's pack,
// old test songs). Never your library's songs (switch those off instead) and never official songs (no Z folders).
function startStickRemove(b) {
  const st = onlineStick(b.stick), v = stickView(st, stick.scanMusic(st.music), stick.scanMusic(OUT), true);
  const folders = (b.folders || []).map(String);
  if (!folders.length) throw httpError(400, "no folders to remove");
  for (const f of folders) {
    const x = v.songs.find(y => y.folder === f && y.state !== "missing");
    if (!x) throw httpError(404, `${f} isn't on the memory stick`);
    if (x.inLibrary) throw httpError(400, `${f} is one of your songs: switch it off instead`);
  }
  return runJob(st.label, "stick", [{ args: stickArgs(st.music, { remove: folders, ...dbWithout(v, folders) }),
    label: `# ${new Date().toISOString()} remove from ${st.label}: ${folders.join(", ")}`, onDone: rememberStick(st) }], path.join(SONGS, ".db", "stick.log"));
}
// Archive: songs/<F> moves to songs/.archive/<F> (nothing deleted). removeFrom: sticks to take its folder off now.
function archiveSong(b) {
  const f = String(b.folder || "");
  if (!FOLDER_RE.test(f) || !fs.existsSync(path.join(SONGS, f, "song.json"))) throw httpError(404, "no such song");
  if (build && !build.done) throw httpError(409, `wait for the build of ${build.folder} to finish`);
  if (fs.existsSync(path.join(ARCHIVE, f))) throw httpError(409, `there is already an archived ${f}: restore or rename it first`);
  const sticks = (b.removeFrom || []).map(onlineStick);
  fs.mkdirSync(ARCHIVE, { recursive: true });
  fs.renameSync(path.join(SONGS, f), path.join(ARCHIVE, f));
  const o = readOff(); for (const k of Object.keys(o)) o[k] = o[k].filter(x => x !== f); writeOff(o);
  const steps = [];
  for (const st of sticks) {
    const v = stickView(st, stick.scanMusic(st.music), stick.scanMusic(OUT), true);
    if (!v.songs.some(x => x.folder === f && x.state !== "missing")) continue;
    steps.push({ args: stickArgs(st.music, { remove: [f], ...dbWithout(v, [f]) }), label: `# ${new Date().toISOString()} archived ${f}: removing it from ${st.label}`, onDone: rememberStick(st) });
  }
  return { archived: f, started: steps.length ? runJob(f, "stick", steps, path.join(SONGS, ".db", "stick.log")).started : null };
}
function restoreSong(b) {
  const f = String(b.folder || "");
  if (!FOLDER_RE.test(f) || !fs.existsSync(path.join(ARCHIVE, f, "song.json"))) throw httpError(404, "no such archived song");
  if (fs.existsSync(path.join(SONGS, f))) throw httpError(409, `there is already a song in songs\\${f}`);
  fs.renameSync(path.join(ARCHIVE, f), path.join(SONGS, f));
  return { restored: f };
}
// what an install would do. b = { stick, source: "library" (out/MUSIC) | "pack:<id>", songs?: [...], db?: bool }
function installPlan(b) {
  const s = settings.load(), st = stick.connected(s.music).find(x => x.id === b.stick);
  if (!st) throw httpError(404, "that memory stick isn't connected");
  let srcDir = OUT, name = "your songs";
  if (b.source && b.source.startsWith("pack:")) {
    const p = readPacks().find(x => x.id === b.source.slice(5)), built = p && readBuilt()[p.id];
    if (!built || !built.dir || !fs.existsSync(path.join(built.dir, "MUSIC"))) throw httpError(400, "build the pack first");
    srcDir = path.join(built.dir, "MUSIC"); name = `the pack "${built.name}"`;
  }
  const src = stick.scanMusic(srcDir), scan = stick.scanMusic(st.music), v = stickView(st, scan, src, true);
  if (!src.active) throw httpError(400, "no song database built yet: build a song first");
  const want = Array.isArray(b.songs) ? b.songs : v.songs.filter(x => x.built && x.state !== "installed").map(x => x.folder);
  const copy = want.filter(f => src.songs[f]);
  const db = b.db !== undefined ? !!b.db : !(v.db && v.db.state === "current");
  const newList = new Set(db ? v.srcDb.customs : v.db ? v.db.customs : []);
  const after = new Set([...Object.keys(scan.songs || {}), ...copy]);
  const title = f => (v.songs.find(x => x.folder === f) || {}).title || null;
  return { stick: st, srcDir, name, copy: copy.map(f => ({ folder: f, title: title(f), state: (v.songs.find(x => x.folder === f) || {}).state, mb: folderMb(src.songs[f]) })),
    db, dbFile: src.active.file, current: v.db,
    hidden: [...after].filter(f => !newList.has(f)).map(f => ({ folder: f, title: title(f), inLibrary: songList().includes(f) })),
    notOnStick: [...newList].filter(f => !after.has(f)),
    mb: +copy.reduce((n, f) => n + folderMb(src.songs[f]), 0).toFixed(1) };
}
function startInstall(b) {
  const p = installPlan(b);
  if (!p.copy.length && !p.db) throw httpError(400, "nothing to copy: everything is installed");
  const args = [path.join(SCRIPTS, "install.js"), "--from", p.srcDir, "--to", p.stick.music, ...(p.db ? ["--db"] : []), ...p.copy.map(c => c.folder)];
  return runJob(p.stick.label, "install", [{ args, label: `# ${new Date().toISOString()} install ${p.name} to ${p.stick.label} (${p.stick.music})`,
    onDone: () => { try { stick.remember(p.stick, stick.scanMusic(p.stick.music)); } catch { } } }], path.join(SONGS, ".db", "install.log"));
}

// ---------- import: songs from someone's pack (or a memory stick) into the library, chart and audio as shipped ----------
function importRoot(dir) {
  dir = path.resolve(String(dir || ""));
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw httpError(404, "no such folder");
  // a song folder itself: its parent, that song only
  if (fs.readdirSync(dir).some(f => /^BEATMATCH\.STR/i.test(f))) return { root: path.dirname(dir), only: path.basename(dir).toUpperCase() };
  const has = r => fs.existsSync(r) && Object.keys(stick.scanMusic(r, { hashAll: false }).songs).length > 0;
  for (const r of [dir, path.join(dir, "MUSIC"), path.join(dir, "PSP", "GAME", stick.GAME_ID, "MUSIC")]) if (has(r)) return { root: r };
  throw httpError(404, "no song folders there (a song folder has a BEATMATCH.STR.EDAT): pick the pack's folder, its MUSIC folder or one song's folder");
}
function importCandidates(dir) {
  const { root, only } = importRoot(dir), scan = stick.scanMusic(root, { hashAll: false }), libId = stick.libraryId();
  // details: the song's PESONG.JSON, else the custom song databases in the same folder (newest first; one whose TEXT
  // was made for it gives the names: a database copied over another one's TEXT has wrong names)
  const dbs = (scan.dbs || []).filter(d => d.number > stick.OFFICIAL_MAX && d.valid).sort((a, b) => b.number - a.number)
    .map(d => { try { return stick.readDb(path.join(root, d.folder, d.file)); } catch { return null; } }).filter(Boolean);
  const lib = new Set(songList());
  const songs = Object.entries(scan.songs).filter(([f]) => !only || f === only).map(([f, x]) => {
    const atm = !!x.files[`${f}.ATM`];
    let det = null, from = null;
    if (x.stamp && x.stamp.title) { det = x.stamp; from = "PESONG.JSON"; }
    else {
      const named = dbs.map(d => ({ d, r: d.customs.find(c => c.name === f) })).filter(o => o.r);
      const best = named.find(o => o.d.textOk) || named[0];
      if (best) { det = { ...best.r.details }; from = `song database ${path.basename(best.d.file).slice(0, 8)}${best.d.textOk ? "" : " (no names: its TEXT belongs to another database)"}`; }
    }
    const problem = !FOLDER_RE.test(f) ? "folder name not usable (Z + up to 30 capital letters/digits)" : !atm ? `no ${f}.ATM in it` : null;
    return { folder: f, ok: !problem, problem, inLibrary: lib.has(f), yours: !!(x.stamp && x.stamp.library === libId), from, details: det || {},
      needsDetails: !det || !det.title, mb: folderMb(x) };
  });
  return { root, songs };
}
function importSongs(dir, folders) {
  const c = importCandidates(dir), done = [];
  for (const f of folders) {
    const x = c.songs.find(s => s.folder === f);
    if (!x || !x.ok) throw httpError(400, `${f}: ${x ? x.problem : "not found there"}`);
    if (x.inLibrary) throw httpError(409, `${f} is already in your library`);
  }
  for (const f of folders) {
    const x = c.songs.find(s => s.folder === f), d = x.details, I = path.join(SONGS, f, "import");
    fs.mkdirSync(I, { recursive: true });
    for (const n of ["BEATMATCH.STR.EDAT", `${f}.ATM`, `${f}_PREVIEW.AT3`]) { const p = stick.findFile(path.join(c.root, f), n); if (p) fs.copyFileSync(p, path.join(I, n)); }
    const one = (list, v) => (list.includes(v) ? v : undefined);
    const tiers = {};
    for (const k of ["drums", "guitar", "bass", "vocals", "band"]) { const t = d.tiers && d.tiers[k]; tiers[k] = Number.isInteger(t) && t >= 0 && t <= 6 ? t : 2; }
    const S = { folder: f, title: d.title || f.slice(1), artist: d.artist || "Unknown artist", album: d.album || undefined,
      year: Number.isInteger(d.year) && d.year > 0 ? d.year : undefined, genre: one(GENRES, d.genre) || "ROCK",
      era: one(stick.ERAS, d.era), difficulty: one(stick.DIFFICULTIES, d.difficulty), tiers,
      vocals: d.vocals === 1 || d.vocals === 2 ? d.vocals : undefined,
      imported: { at: new Date().toISOString(), from: x.from || "no details found", ...(d.build ? { build: d.build } : {}), ...(d.app ? { app: d.app } : {}) } };
    writeSong(f, S);
    done.push({ folder: f, title: S.title, needsDetails: x.needsDetails });
  }
  return done;
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
  if (what === "guide") {  // the full guide, in the default app for .md files (or Notepad)
    const f = path.join(TOOLS, "docs", "RBU_CUSTOM_SONGS.md");
    spawn("cmd", ["/c", "start", "", f], { detached: true, stdio: "ignore" }).unref();
    return f;
  }
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
  // the window checks every few seconds that Pocket Encore still runs (and reloads when it is back after an update)
  if (what === "ping" && M === "GET") { pinged = true; return json(res, { version: VERSION }); }
  // quit cleanly (the installer asks this before replacing the files of a running copy)
  if (what === "quit" && M === "POST") { json(res, { ok: true }); setTimeout(() => process.exit(0), 200); return; }
  if (what === "update") {
    if (!folder && M === "GET") return json(res, await updater.status(u.searchParams.get("force") === "1"));
    if (!folder && M === "PUT") { updater.setPrefs(await body(req)); return json(res, await updater.status(false)); }
    if (folder === "install" && M === "POST") return json(res, updater.install());
    if (folder === "progress" && M === "GET") return json(res, updater.progress());
    if (folder === "open" && M === "POST") {  // the release page in the default browser
      const st = await updater.status(false), url = (st.latest && st.latest.page) || "https://github.com/omar-guuu/pocket-encore/releases/latest";
      spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
      return json(res, { url });
    }
  }
  if (what === "meta" && M === "GET") {
    const c = settings.check();
    return json(res, { genres: GENRES, effects: Object.keys(EFFECTS), tools: TOOLS, out: OUT, starFractions: STAR_FRACTIONS, setupOk: c.ok, version: VERSION,
      configured: c.configured, mode: c.mode, db: dbState(c.mode), audioExt: AUDIO_EXT, midiExt: MIDI_EXT });
  }
  if (what === "setup" && M === "GET") return json(res, { ...settings.check(), file: settings.FILE });
  if (what === "setup" && M === "POST") {  // check paths without saving them (onboarding); { redetect: true } looks for the game again
    const b = await body(req);
    if (b.redetect) settings.redetect();
    return json(res, { ...settings.check(b.settings || {}), file: settings.FILE });
  }
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
  if (what === "checks" && M === "POST") {  // the editor's chart, not saved yet
    const { midi, reduce } = await body(req);
    readSong(folder);
    return json(res, { source: "editor", items: checkChart(midi, { reduce: !!reduce, audio: readAudio(folder) }) });
  }
  if (what === "effects" && M === "PUT") {
    const { effects } = await body(req);
    validateEffects(effects);
    const S = readSong(folder);
    if (typeof S.effects === "string") fs.writeFileSync(path.resolve(songDir(folder), S.effects), pretty(effects) + "\n");
    else { if (effects.length) S.effects = effects; else delete S.effects; writeSong(folder, S); }
    return json(res, { ok: true });
  }
  // Effects & Band Anims tab: what the build makes of the band (from the last built chart), in game seconds
  if (what === "band" && M === "GET") {
    const S = readSong(folder), f = path.join(songDir(folder), "build", "BEATMATCH.STR.EDAT"), lead = (readAudio(folder) || {}).lead || 0;
    const shots = fs.existsSync(path.join(PUB, "fx")) ? fs.readdirSync(path.join(PUB, "fx")).filter(x => /\.(png|jpe?g|webp)$/i.test(x)) : [];
    if (!fs.existsSync(f)) return json(res, { built: false, lead, shots });
    const sh = t => +(t + lead).toFixed(4);
    const spec = { prop: S.singerProp || "tambourine",
      ...(Array.isArray(S.singerSections) ? { sections: S.singerSections.map(x => ({ ...x, from: sh(x.from), to: sh(x.to) })) } : {}),
      ...(Array.isArray(S.singerMic) ? { mic: S.singerMic.map(x => ({ ...x, at: sh(x.at) })) } : {}) };
    // hands: the automatic clips (the tab shows song.json bandClips on top of them)
    return json(res, { built: true, lead, shots, builtAt: mtime(f), ...band.analyze(fs.readFileSync(f), spec) });
  }
  if (what === "anims" && M === "PUT") {
    const b = await body(req), S = readSong(folder);
    validateEffects(b.effects || []);
    if (typeof S.effects === "string") fs.writeFileSync(path.resolve(songDir(folder), S.effects), pretty(b.effects || []) + "\n");
    else if ((b.effects || []).length) S.effects = b.effects; else delete S.effects;
    for (const k of ["singerProp", "singerSections", "singerMic", "bandClips"]) { if (b[k] == null) delete S[k]; else S[k] = b[k]; }
    if (S.singerProp === "tambourine") delete S.singerProp;
    writeSong(folder, S);
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
    return json(res, { started: b.started, from: b.from });
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
  if (what === "buildmany" && M === "POST") {  // several songs one after the other (e.g. just imported)
    const { folders } = await body(req);
    if (!Array.isArray(folders) || !folders.length) throw httpError(400, "no songs");
    folders.forEach(f => readSong(f));
    checkSetup();
    const steps = folders.map(f => ({ ...songBuildStep(f), label: `\n=== building ${f} ===` }));
    const b = runJob(folders.length === 1 ? folders[0] : `${folders.length} songs`, "many", steps, path.join(SONGS, ".db", "buildmany.log"));
    return json(res, { started: b.started });
  }
  if (what === "packs" && M === "GET") return json(res, packsView());
  if (what === "packs" && M === "PUT") {
    const { packs } = await body(req);
    if (!Array.isArray(packs)) throw httpError(400, "packs must be a list");
    const old = readPacks();
    const clean = packs.map(p => {
      const id = /^[a-z0-9]{4,20}$/.test(p.id || "") ? p.id : Math.random().toString(36).slice(2, 10);
      const prev = old.find(x => x.id === id);
      return { id, name: String(p.name || "").trim().slice(0, 60), songs: [...new Set((p.songs || []).filter(x => FOLDER_RE.test(x)))],
        created: (prev && prev.created) || new Date().toISOString() };
    });
    // a deleted pack's built folder goes too
    const built = readBuilt();
    for (const p of old) if (!clean.find(x => x.id === p.id)) {
      const b = built[p.id];
      if (b && b.dir && path.resolve(b.dir).startsWith(PACKS_OUT)) fs.rmSync(b.dir, { recursive: true, force: true });
      delete built[p.id];
    }
    writeBuilt(built);
    writePacks(clean);
    return json(res, packsView());
  }
  if (what === "packbuild" && M === "POST") { const bj = startPack(folder); return json(res, { started: bj.started }); }
  if (what === "packopen" && M === "POST") {
    const b = readBuilt()[folder];
    if (!b || !b.dir || !fs.existsSync(b.dir)) throw httpError(404, "this pack has not been built yet");
    spawn("explorer.exe", [b.dir], { detached: true, stdio: "ignore" }).unref();
    return json(res, { dir: b.dir });
  }
  if (what === "sticks" && M === "GET") return json(res, sticksView());
  if (what === "stick" && M === "POST") {
    const b = await body(req);
    if (folder === "plan") return json(res, stickPlan(b));
    if (folder === "apply") return json(res, { started: startStickApply(b).started });
    if (folder === "remove") return json(res, { started: startStickRemove(b).started });
  }
  if (what === "archive" && M === "POST") return json(res, archiveSong(await body(req)));
  if (what === "restore" && M === "POST") return json(res, restoreSong(await body(req)));
  if (what === "install" && M === "POST") {
    const b = await body(req);
    if (b.dry) { const p = installPlan(b); return json(res, { ...p, stick: { id: p.stick.id, label: p.stick.label, music: p.stick.music } }); }
    return json(res, { started: startInstall(b).started });
  }
  if (what === "import" && M === "GET") return json(res, importCandidates(u.searchParams.get("dir") || ""));
  if (what === "import" && M === "POST") { const b = await body(req); return json(res, { imported: importSongs(b.dir || "", b.folders || []) }); }
  if (what === "ls" && M === "GET") return json(res, listDir(u.searchParams.get("dir")));
  if (what === "open" && M === "POST") return json(res, { dir: openFolder(folder, u.searchParams.get("what")) });
  throw httpError(404, "unknown API call");
}

// "running" note for the installer (process id and port), removed when Pocket Encore stops
const RUNNING = path.join(__dirname, ".running");
let pinged = false;
const updater = createUpdater({ tools: TOOLS, version: VERSION, port: PORT, quit: () => process.exit(0) });
process.on("exit", () => { try { if (JSON.parse(fs.readFileSync(RUNNING, "utf8")).pid === process.pid) fs.rmSync(RUNNING, { force: true }); } catch { } });
for (const sig of ["SIGINT", "SIGHUP", "SIGTERM", "SIGBREAK"]) process.on(sig, () => process.exit(0));
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
  console.log(`Pocket Encore v${VERSION.version} ${VERSION.stage}: ${url}  (close this window or press Ctrl+C to stop)`);
  // the game mode is checked on every start (DLC can be added or removed between sessions)
  try {
    const c = settings.check();
    if (!c.configured) console.log("  first start: the welcome and setup pages open in the window");
    else console.log(`  game: ${c.mode.label} (chart container ${c.mode.donorName}, song list ${c.mode.baseName})${c.checks.game.ok ? "" : " - " + c.checks.game.detail}`);
    const db = dbState(c.mode);
    if (db.stale) console.log(`  the song database was built for "${db.was}"; build any song to update it`);
  } catch (e) { console.log("  game check failed: " + e.message); }
  try { fs.writeFileSync(RUNNING, JSON.stringify({ pid: process.pid, port: PORT })); } catch { }
  // --reconnect (started by the installer): a window that was already open reconnects by itself within a few seconds;
  // open a new one only if none did
  if (process.argv.includes("--open")) {
    if (process.argv.includes("--reconnect")) setTimeout(() => { if (!pinged) openWindow(url); }, 4000);
    else openWindow(url);
  }
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
