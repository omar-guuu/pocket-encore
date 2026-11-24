#!/usr/bin/env node
// One-command custom song builder for Rock Band Unplugged (ULUS10418).
//
//   node mksong.js <songs/ZNAME/song.json> [--music <MUSIC dir>] [--out <dir>] [--from audio|chart|db] [--db-only] [--jb <n>]
//
// Runs the whole pipeline (see RBU_CUSTOM_SONGS.md):
//   audio : prepwav (gain, 44.1 kHz mono 16-bit) -> pad all stems to one length + silent tail -> at3tool -> atmtool
//   preview: mkpreview -> at3tool 352 kbps          (skipped with "preview": false)
//   chart : MIDI -> (autochart, if it is not already a Rock Band chart) -> mid2rbu -> beatmatch build --atm
//   db    : mkjukebox with EVERY songs/*/song.json -> JB<days since 2008-03-07> + TEXT in their own folder (ZZCUSTOMDB)
// Output: <out>/<FOLDER>/ (the song) and <out>/ZZCUSTOMDB/ (the shared song database). Copy both into MUSIC.
// Work files: <song dir>/build/. --from skips the earlier stages (their outputs must exist).
//
// song.json (paths relative to the json file):
// {
//   "folder": "ZMYSONG", "title": "...", "artist": "...", "album": "...", "year": 2001, "genre": "ROCK",
//   "tiers": { "drums": 2, "guitar": 2, "bass": 2, "vocals": 2, "band": 2 }, "vocals": 1,
//   "stems": { "drums": "stems/drums.wav", "bass": "...", "guitar": "...", "vocals": "...", "fill": "..." },
//                                  missing parts become silence; "fill" = everything else (backing)
//   "stemSource": { "type": "ai", "tool": "fadr", "quality": "medium", "notes": "bass bleeds into drums" }
//                                  where the stems come from (shown in every build; for the future editor):
//                                  type official | multitrack | ai | unknown (default); quality low | medium | high
//   "midi": "song.mid",
//   "loudness": -14,               target loudness of the summed mix in LUFS (default -14, like official songs)
//   "gain": null,                  manual dB for every stem instead (turns the loudness stage off)
//   "tail": 6,                     seconds of silence after the longest stem (default 6)
//   "starsScale": 1,               star thresholds x this (> 1 harder, < 1 easier); default from the chart (beatmatch.js)
//   "countIn": false,              true = 4 drumstick clicks on the beats before the music starts (lead-in >= 4.5 s)
//   "leadIn": null,                seconds of silence before the stems; default: enough that nothing sounds before 3 s
//                                  (official songs' first notes come after ~3 s); 0 = none. song.json times stay in
//                                  the original audio's seconds (solos, effects, preview, offset are shifted)
//   "preview": { "start": 60 },    optional; default = loudest 30 s; false = no preview
//   "donor": "SHESNOTTHERE",       chart used as the container: official MUSIC folder name or a file path
//                                  (default from the game mode: SHESNOTTHERE with DLC, a disc chart without; game.js)
//   "dropSolos": false,            true = remove solo sections (default: keep them, from MIDI note 103)
//   "pitchedVocals": null,         mid2rbu PitchedVocals; default true for Rock Band MIDIs, false for autochart
//   "mid2rbu": { "EnablePruning": true, ... }   optional extra [PostProcess] keys
//   "autochart": {                 only for plain (non Rock Band) MIDIs
//     "offset": 9.18, "bpm": 150.15,   omit both to find them with align.js from the drum stem
//     "drums": 1, "bass": 3, "guitar": 2, "vocals": 4,   source track indices (see midiinfo.py)
//     "odEvery": 6, "odFirst": 2, "odBars": 1, "introStart": 4.3, "intro": true,
//     "guitar": "0,4",               several tracks: each later one takes over from its first note
//     "vocalsFromStem": true,        vocal notes from the vocals stem's syllables (vocalchart.js), e.g. rap
//     "chords": 0.35 },              guitar chord share wanted (default: 0.8 x the source's chord share, 25-45 %);
//                                    raises single notes on strong beats to chords when too few chords were detected
//   "solos": [ { "part": "guitar", "start": 6.7, "end": 20.2 } ]   plain MIDIs: solo sections in audio seconds
//   "effects": [ { "effect": "oldfilm", "from": 83.0, "to": 97.5 } ]   screen effects (seconds; names: fxchart.js),
//                                  or a path to such a JSON file; the donor's own effects are removed first
//   "keepDonorEffects": false,     true = keep the donor's effects as well (with or without "effects")
//   "stripCommands": [22],         remove every call of these script commands first (22 = camera shots; FINDINGS §27)
//   "singerProp": "tambourine",    what the singer plays in solos and 8+ bar instrumental parts without vocals:
//                                  tambourine (default) | cowbell | clap | none (band.js, FINDINGS §39)
//   "singerSections": [ { "from": 50, "to": 62, "prop": "cowbell" } ]   prop sections set by hand (seconds), instead of
//                                  the automatic ones; [] = none (Effects & Band Anims tab)
//   "singerMic": [ { "at": 20.3, "state": "perform" } ]   mic up ("perform") / down ("rest") set by hand, instead of
//                                  following the vocals (Advanced Edit Mode)
//   "bandClips": [ { "hand": "guitarist_strum", "at": 7.19, "clip": "strum_long_03" } ]   a guitarist/bassist clip set
//                                  by hand for the note at that time (Advanced Edit Mode; clip names: band.js CLIPS)
//   "bandAnimations": true,        false = keep the donor's band animations (guitarist/bassist hands and singer)
//   "chart": "edited.mid",         a chart edited in REAPER: used as it is (no autochart, no mid2rbu clean-up);
//                                  every build writes reaper\<FOLDER>\<FOLDER>_auto.mid + the 5 WAVs to start from
//   "reduce": true,                "chart" or Rock Band MIDI: chart only Expert; Hard/Medium/Easy are made from it
//                                  like the official charts (reduce.py). autochart always does this.
// }
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const TOOLS = path.resolve(__dirname, "..");
const SCRIPTS = __dirname;
const SETTINGS = require("./settings.js").load();  // rbu-tools/settings.json: music folder, python, at3tool, mid2rbu
const PY = SETTINGS.python, AT3TOOL = SETTINGS.at3tool, MID2RBU = SETTINGS.mid2rbu, DEFAULT_MUSIC = SETTINGS.music;
const DB_FOLDER = "ZZCUSTOMDB";
// Chart container and song-list base come from the game mode (game.js): DLC (SHESNOTTHERE + YOURENOROCKNROLLFUN),
// incomplete DLC without those two (one of its charts + its newest list) or base game only (a disc chart + the disc's
// list, read from the ISO).
const game = require("./game.js");
const stick = require("./stick.js");  // memory sticks: stamps, the next song database number
let GAME = null;
function gameFiles(music) {
  if (!GAME) {
    GAME = game.resolve(music, SETTINGS.iso);
    console.log(`  game: ${GAME.label} (chart container ${GAME.donorName}, song list ${GAME.baseName})`);
  }
  return GAME;
}
// JB number = days since 2008-03-07, the same scheme as the official packs (JB000427 = 2009-05-08 ... JB000571 =
// 2009-09-29). The scanner reads the 6 digits after "JB" and keeps the highest, so today's number is newer than every
// official pack and every earlier custom build. Someone else's song database on a memory stick (a shared pack) can
// have the same or a higher number: the number is then raised above it (stick.js nextDbNumber). Override with --jb <n>.
const TRACKS = { drums: "drums", bass: "bass_guitar", guitar: "lead_guitar", vocals: "vocals", fill: "fill" };
const GENRES = ["ALTERNATIVE", "BLUES", "CLASSIC ROCK", "COUNTRY", "EMO", "FUSION", "GLAM", "GRUNGE", "INDIE ROCK", "JAZZ",
  "METAL", "NOVELTY", "NU-METAL", "POP-ROCK", "PROG", "PUNK", "ROCK", "SOUTHERN ROCK", "URBAN"];
const RATE = 44100;

function run(cmd, args, opts = {}) {
  const show = [path.basename(cmd), ...args.map(a => (/[\s]/.test(a) ? `"${a}"` : a))].join(" ");
  console.log(`  $ ${show}`);
  try {
    const out = execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20, ...opts });
    if (opts.echo !== false) for (const l of out.split(/\r?\n/).filter(Boolean).slice(-(opts.tail || 6))) console.log(`    ${l}`);
    return out;
  } catch (e) {
    console.error((e.stdout || "") + (e.stderr || ""));
    throw new Error(`${path.basename(cmd)} failed (exit ${e.status})`);
  }
}
const node = (script, args, o) => run(process.execPath, [path.join(SCRIPTS, script), ...args], o);
const py = (script, args, o) => run(PY, ["-I", script, ...args], o);

// ---------- WAV helpers (prepwav output: 44-byte header, 16-bit mono 44.1 kHz) ----------
function wavInfo(p) {
  const b = fs.readFileSync(p);
  let o = 12;
  while (o + 8 <= b.length) {
    const id = b.toString("ascii", o, o + 4), sz = b.readUInt32LE(o + 4);
    if (id === "data") return { b, off: o + 8, len: Math.min(sz, b.length - o - 8) };
    o += 8 + sz + (sz & 1);
  }
  throw new Error(p + ": no data chunk");
}
const LEAD_MIN = 3.0, LEAD_MIN_COUNTIN = 4.5;
// First time (s) a 16-bit mono WAV is within 30 dB of its loud level (99th percentile of 10 ms frames).
function firstActive(p) {
  const w = wavInfo(p), n = w.len / 2, hop = RATE / 100, F = Math.floor(n / hop), lev = new Float64Array(F);
  for (let f = 0; f < F; f++) { let e = 0; for (let i = f * hop; i < (f + 1) * hop; i++) { const v = w.b.readInt16LE(w.off + i * 2) / 32768; e += v * v; } lev[f] = 10 * Math.log10(e / hop + 1e-12); }
  const loud = Array.from(lev).sort((a, b) => a - b)[Math.floor(F * 0.99)];
  for (let f = 0; f < F; f++) if (lev[f] > loud - 30 && loud > -80) return f / 100;
  return Infinity;
}

function writeMono16(p, pcm /* Buffer of int16 */) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(p, Buffer.concat([h, pcm]));
}
function levels(paths) {
  // Sum of the stems as the game plays them: peak and RMS in dBFS.
  const d = paths.map(wavInfo), n = Math.max(...d.map(x => x.len / 2));
  let peak = 0, sq = 0, clip = 0;
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (const x of d) if (i * 2 < x.len) s += x.b.readInt16LE(x.off + i * 2);
    const a = Math.abs(s) / 32768; if (a > peak) peak = a; if (a >= 1) clip++; sq += a * a;
  }
  const db = v => (20 * Math.log10(v || 1e-9)).toFixed(1);
  return { peak: db(peak), rms: db(Math.sqrt(sq / n)), clip };
}

// ---------- loudness ----------
// Official songs, the five tracks summed: -12.8..-15.3 LUFS (10 songs, about -14), sample peaks at -1.3..+0.3 dBFS,
// i.e. mastered. Customs are brought to the same loudness: one gain for all stems, then a limiter driven by the sum
// (5 ms lookahead, 80 ms release) whose gain reduction is applied to every stem alike, so the balance between the
// parts is kept and neither the sum nor any single track goes above the ceiling.
// Ceiling -1.5 dBFS: ATRAC3 encoding overshoots peaks by ~1 dB (at -0.5 the decoded sums reached +0.7 dBFS).
const LOUDNESS_TARGET = -14, CEILING_DB = -1.5;
const { lufs } = require("./loudness.js");
function lufsOf(x) {
  const n = x[0].length, sum = new Float64Array(n);
  for (const v of x) for (let i = 0; i < n; i++) sum[i] += v[i];
  return lufs(sum, RATE);
}
// Gain + limiter on copies of the stems; returns the processed stems and limiter statistics.
function gainLimit(x, gdb) {
  const n = x[0].length, g = Math.pow(10, gdb / 20), ceil = Math.pow(10, CEILING_DB / 20);
  // required gain per sample after the make-up gain
  const req = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0, m = 0;
    for (const v of x) { s += v[i]; m = Math.max(m, Math.abs(v[i])); }
    const peak = Math.max(Math.abs(s), m) * g;
    req[i] = peak > ceil ? ceil / peak : 1;
  }
  // lookahead: minimum over +-L, then a moving average over the last L (so the gain is down before each peak)
  const L = Math.round(0.005 * RATE), mn = new Float32Array(n), dq = new Int32Array(n);
  let h = 0, t = 0;
  for (let i = 0, j = 0; i < n; i++) {
    for (; j < n && j <= i + L; j++) { while (t > h && req[dq[t - 1]] >= req[j]) t--; dq[t++] = j; }
    while (dq[h] < i - L) h++;
    mn[i] = req[dq[h]];
  }
  const env = new Float32Array(n); let acc = 0;
  for (let i = 0; i < n; i++) { acc += mn[i]; if (i >= L) acc -= mn[i - L]; env[i] = acc / Math.min(i + 1, L); }
  // release: the gain comes back up smoothly (never above the lookahead envelope's demand at a peak)
  const rel = 1 - Math.exp(-1 / (0.08 * RATE));
  const y = x.map(() => new Float32Array(n));
  let cur = 1, limited = 0, maxRed = 1;
  for (let i = 0; i < n; i++) {
    cur = env[i] < cur ? env[i] : cur + (env[i] - cur) * rel;
    if (cur < 0.999) limited++;
    if (cur < maxRed) maxRed = cur;
    const k = g * cur;
    for (let c = 0; c < x.length; c++) y[c][i] = x[c][i] * k;
  }
  return { y, limited: limited / n, maxRed: -20 * Math.log10(maxRed) };
}
// Two passes: the limiter lowers the loudness a little, so the second pass adds that back.
function loudnessStage(x, target) {
  const before = lufsOf(x);
  let gdb = target - before, r = gainLimit(x, gdb), after = lufsOf(r.y);
  if (Math.abs(after - target) > 0.1) { gdb += target - after; r = gainLimit(x, gdb); after = lufsOf(r.y); }
  for (let c = 0; c < x.length; c++) x[c].set(r.y[c]);
  console.log(`  loudness: mix ${before.toFixed(1)} LUFS -> ${after.toFixed(1)} LUFS (target ${target}): gain ${gdb.toFixed(1)} dB, ` +
    `limiter (ceiling ${CEILING_DB} dBFS) on ${(100 * r.limited).toFixed(1)} % of the song, at most ${r.maxRed.toFixed(1)} dB`);
}

// ---------- stages ----------
function stageAudio(S, B) {
  console.log("\n[audio]");
  const prep = path.join(B, "wav"), padded = path.join(B, "wav_tail"), at3 = path.join(B, "at3");
  for (const d of [prep, padded, at3]) fs.mkdirSync(d, { recursive: true });
  const stems = S.stems || {};
  const unknown = Object.keys(stems).filter(k => !TRACKS[k]);
  if (unknown.length) throw new Error(`unknown stem(s) ${unknown.join(", ")}; use ${Object.keys(TRACKS).join(", ")}`);
  const have = Object.keys(TRACKS).filter(k => stems[k]);
  if (!have.length) throw new Error("no stems given");
  // Stems at their own level (0 dB) unless a manual "gain" is given; the loudness stage below sets the level.
  const manual = S.gain != null;
  // MP3 / FLAC / OGG stems (e.g. from AI separators) are decoded to float WAV first (decode.py, miniaudio)
  const src = path.join(B, "src"); fs.mkdirSync(src, { recursive: true });
  const input = k => {
    const f = path.resolve(S._dir, stems[k]);
    if (/\.wav$/i.test(f)) return f;
    const w = path.join(src, TRACKS[k] + ".wav");
    py(path.join(SCRIPTS, "decode.py"), [f, w], { tail: 1 });
    return w;
  };
  for (const k of have) node("prepwav.js", [input(k), path.join(prep, TRACKS[k] + ".wav"), String(manual ? S.gain : 0)], { tail: 1 });

  // Lead-in: official songs never have a gem before 2.77 s (5 % before 3.1 s), so the highway can show the first
  // notes. If any stem sounds before LEAD_MIN, silence is added in front of all of them (song.json "leadIn": seconds
  // overrides, 0 = off). Times in song.json stay in the original audio's seconds; the chart stage shifts them.
  const firstSound = Math.min(...have.map(k => firstActive(path.join(prep, TRACKS[k] + ".wav"))));
  const leadMin = S.countIn ? LEAD_MIN_COUNTIN : LEAD_MIN;  // a count-in needs room for 4 beats
  const lead = S.leadIn != null ? Number(S.leadIn) : Math.max(0, Math.ceil((leadMin - firstSound) * 100) / 100);
  if (lead > 0) {
    for (const k of have) {
      const f = path.join(prep, TRACKS[k] + ".wav"), w = wavInfo(f);
      writeMono16(f, Buffer.concat([Buffer.alloc(Math.round(lead * RATE) * 2), w.b.subarray(w.off, w.off + w.len)]));
    }
    console.log(`  lead-in: ${lead.toFixed(2)} s of silence added (the stems start at ${firstSound.toFixed(2)} s; official songs' first notes come after ~3 s)`);
  }

  // One length for all five tracks: the longest stem + tail; missing parts are silence.
  const pcm = Object.fromEntries(have.map(k => { const w = wavInfo(path.join(prep, TRACKS[k] + ".wav")); return [k, w.b.subarray(w.off, w.off + w.len)]; }));
  const longest = Math.max(...Object.values(pcm).map(p => p.length / 2));
  const total = longest + Math.round((S.tail ?? 6) * RATE);
  const keys = Object.keys(TRACKS);
  const x = keys.map(k => { const f = new Float32Array(total); if (pcm[k]) for (let i = 0; i < pcm[k].length / 2; i++) f[i] = pcm[k].readInt16LE(i * 2) / 32768; return f; });
  for (const k of keys) if (!pcm[k] && k !== "fill") console.log(`  note: no ${k} stem, the ${k} track is silent`);
  // mkpreview and autochart's intro detection read the un-padded stems: silent files for the missing parts.
  for (const k of keys) if (!pcm[k]) writeMono16(path.join(prep, TRACKS[k] + ".wav"), Buffer.alloc(longest * 2));
  const audioSeconds = total / RATE;
  if (!manual) loudnessStage(x, S.loudness ?? LOUDNESS_TARGET);
  for (let k = 0; k < keys.length; k++) {
    const out = Buffer.alloc(total * 2);
    for (let i = 0; i < total; i++) out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x[k][i] * 32768))), i * 2);
    writeMono16(path.join(padded, TRACKS[keys[k]] + ".wav"), out);
  }
  const lv = levels(Object.values(TRACKS).map(t => path.join(padded, t + ".wav")));
  const mixL = lufsOf(x);
  console.log(`  length ${(longest / RATE).toFixed(2)} s + ${(S.tail ?? 6)} s tail = ${audioSeconds.toFixed(2)} s; mix of all stems: ${mixL.toFixed(1)} LUFS (official songs -12.8..-15.3), peak ${lv.peak} dBFS, ${lv.clip} clipped samples`);
  if (lv.clip > 0 || +lv.peak > -0.1) console.log(`  WARNING: the summed stems clip${manual ? ` -> lower "gain" (now ${S.gain} dB)` : ""}`);

  for (const t of Object.values(TRACKS))
    run(AT3TOOL, ["-e", "-br", "66", "-wholeloop", `${t}.wav`, `../at3/${t}.at3`], { cwd: padded, echo: false });
  const atm = path.join(B, `${S.folder}.ATM`);
  node("atmtool.js", ["-e", at3, atm], { tail: 2 });
  node("atmtool.js", ["-i", atm], { tail: 3 });
  fs.writeFileSync(path.join(B, "audio.json"), JSON.stringify({ audioSeconds, longest: longest / RATE, lead, musicStart: lead + firstSound }));

  if (S.preview !== false) {
    console.log("\n[preview]");
    const args = [prep, path.join(B, "preview.wav")];
    if (S.preview && S.preview.start !== undefined) args.push("--start", String(S.preview.start + lead));
    node("mkpreview.js", args, { tail: 2 });
    run(AT3TOOL, ["-e", "-br", "352", "-wholeloop", "preview.wav", `${S.folder}_PREVIEW.AT3`], { cwd: B, echo: false });
  }
}

function midiInfo(midi, extra = []) {
  const out = py(path.join(SCRIPTS, "midiinfo.py"), [midi, ...extra], { echo: false });
  const line = out.split(/\r?\n/).find(l => l.startsWith("MIDIINFO "));
  return JSON.parse(line.slice(9));
}

function stageChart(S, B, music) {
  console.log("\n[chart]");
  const C = path.join(B, "chart"); fs.mkdirSync(C, { recursive: true });
  const { audioSeconds, lead = 0 } = JSON.parse(fs.readFileSync(path.join(B, "audio.json"), "utf8"));
  const sh = t => +(Number(t) + lead).toFixed(4);  // song.json times (original audio) -> built audio
  const base = S.folder.replace(/^Z/, "");
  const rbMid = path.join(C, base + ".mid");
  let pitched = S.pitchedVocals, literal = false;
  if (S.chart) {
    // A chart edited in REAPER (Rock Band-format MIDI, e.g. reaper\<FOLDER>\<FOLDER>_auto.mid saved under a new
    // name): taken literally, no automatic charting and no mid2rbu clean-up.
    py(path.join(SCRIPTS, "chartimport.py"), [path.resolve(S._dir, S.chart), rbMid], { tail: 2 });
    if (pitched == null) pitched = false;
    literal = true;
  } else {
  // No MIDI at all: transcribe the stems (stemchart.py) into a plain MIDI, then autochart it like any other.
  let stemInfo = null;
  if (!S.midi) {
    const W = path.join(B, "wav"), sm = path.join(C, "stems.mid");
    if (!S.stems || !S.stems.drums) throw new Error('no "midi": charting from stems alone needs at least a drums stem');
    const A0 = S.autochart || {};
    const sargs = [sm, "--drums", path.join(W, "drums.wav"), "--report"];
    if (S.stems.bass) sargs.push("--bass", path.join(W, "bass_guitar.wav"));
    if (S.stems.guitar) sargs.push("--guitar", path.join(W, "lead_guitar.wav"));
    if (A0.bpm) sargs.push("--bpm", String(A0.bpm));
    console.log("  no MIDI: charting from the stems (stemchart.py)");
    const so = py(path.join(SCRIPTS, "stemchart.py"), sargs, { tail: 40 });
    stemInfo = JSON.parse(so.split(/\r?\n/).find(l => l.startsWith("STEMCHART ")).slice(10));
    console.log(`  stems: ${stemInfo.bpm} BPM, MIDI tick 0 = ${stemInfo.offset} s, drums ${stemInfo.drums}, guitar ${stemInfo.guitar}, bass ${stemInfo.bass} notes`);
    S.autochart = { ...A0, offset: A0.offset != null ? sh(A0.offset) : stemInfo.offset, bpm: A0.bpm ?? stemInfo.bpm,
      drums: 1, guitar: 2, bass: 3, vocalsFromStem: A0.vocalsFromStem ?? !!S.stems.vocals };
  }
  const midi = S.midi ? path.resolve(S._dir, S.midi) : path.join(C, "stems.mid");
  const info = midiInfo(midi);
  console.log(`  ${path.basename(midi)}: ${info.rb_format ? "Rock Band-format chart" : "plain MIDI (" + (info.missing_rb_tracks.join(", ") + " missing)")}, ` +
    `${info.tpb} ticks/beat, ${info.tempo_changes} tempo event(s), ${info.length_s} s`);
  for (const t of info.tracks) console.log(`    track ${t.index}: "${t.name}" ch ${t.channels.join(",") || "-"} notes ${t.notes}${t.range ? ` (${t.range[0]}-${t.range[1]})` : ""}`);

  if (info.rb_format) {
    fs.copyFileSync(midi, rbMid);
    if (pitched == null) pitched = true;
  } else {
    const A = S.autochart || {};
    let { offset, bpm } = A;
    if (offset != null && !stemInfo) offset = sh(offset);  // a hand-given offset is in the original audio's time
    if (offset == null || bpm == null) {
      if (info.tempo_changes > 1) console.log("  WARNING: the MIDI has tempo changes; autochart/align assume one tempo");
      const drumWav = path.join(B, "wav", "drums.wav");
      if (!fs.existsSync(drumWav)) throw new Error("no drum stem to align against: give autochart.offset and autochart.bpm");
      const on = path.join(C, "midi_drum_onsets.json");
      midiInfo(midi, ["--onsets", on, ...(A.drums != null ? ["--drums", String(A.drums)] : [])]);
      const al = node("align.js", [drumWav, on], { tail: 6 });
      const r = JSON.parse(al.split(/\r?\n/).find(l => l.startsWith("ALIGN ")).slice(6));
      offset = offset ?? r.offset; bpm = bpm ?? r.bpm;
      if (r.ambiguous) throw new Error(`the alignment is ambiguous (best guess ${r.offset} s, ${r.bpm} BPM); check by ear and set autochart.offset and autochart.bpm in song.json`);
      console.log(`  alignment: MIDI tick 0 = ${offset} s, ${bpm} BPM (check the quarter offsets above agree within ~20 ms)`);
      if (offset < 0.5) throw new Error(`the MIDI starts at ${offset} s (autochart needs a lead-in of at least one beat); set autochart.offset by hand`);
    }
    const drumTrack = A.drums ?? info.drum_track;
    const args = [path.join(SCRIPTS, "autochart.py"), midi, rbMid, "--offset", String(offset), "--bpm", String(bpm),
      "--name", S.title.toUpperCase()];
    for (const k of ["bass", "guitar", "vocals"]) if (A[k] != null) args.push(`--${k}`, String(A[k]));
    if (drumTrack != null) args.push("--drums", String(drumTrack));
    if (A.chords != null) args.push("--chords", String(A.chords));
    args.push("--od-every", String(A.odEvery ?? 6), "--od-first", String(A.odFirst ?? 2), "--od-bars", String(A.odBars ?? 1));
    if (A.intro !== false) args.push("--intro-stems", path.join(B, "wav"), "--intro-start", String(sh(A.introStart ?? 0)));
    if (A.vocalsFromStem) {
      const vw = path.join(B, "wav", "vocals.wav"), vj = path.join(C, "vocal_notes.json");
      if (!S.stems || !S.stems.vocals) throw new Error("autochart.vocalsFromStem needs a vocals stem");
      node("vocalchart.js", [vw, vj], { tail: 1 });
      args.push("--vocal-events", vj);
    }
    for (const so of S.solos || []) args.push("--solo", `${so.part}:${sh(so.start)}:${sh(so.end)}`);
    run(PY, ["-I", ...args], { tail: 8 });
    if (pitched == null) pitched = false;
  }
  }

  // "countIn": true = 4 drumstick clicks on the beats before the music, mixed into the backing (fill) track, which
  // is re-encoded here (before the chart build, which stores the ATM's checksum). Off again = the clean fill track.
  {
    const at3 = path.join(B, "at3"), padded = path.join(B, "wav_tail"), mark = path.join(at3, "countin.json");
    const atm = path.join(B, `${S.folder}.ATM`);
    const reencode = wav => {
      run(AT3TOOL, ["-e", "-br", "66", "-wholeloop", wav, path.join(at3, "fill.at3")], { cwd: padded, echo: false });
      node("atmtool.js", ["-e", at3, atm], { tail: 1 });
    };
    if (S.countIn) {
      const au = JSON.parse(fs.readFileSync(path.join(B, "audio.json"), "utf8"));
      const out = path.join(B, "countin_fill.wav");
      const r = py(path.join(SCRIPTS, "countin.py"), [rbMid, path.join(padded, "fill.wav"), out, "--start", String(au.musicStart ?? 0)], { echo: false });
      const ci = JSON.parse(r.split(/\r?\n/).find(l => l.startsWith("COUNTIN ")).slice(8));
      reencode(out);
      fs.writeFileSync(mark, JSON.stringify(ci));
      console.log(`  count-in: ${ci.clicks.length} clicks at ${ci.clicks.map(t => t.toFixed(2)).join(", ")} s (${ci.bpm} BPM; the song's beat 1 at ${ci.one.toFixed(2)} s)`);
      if (ci.clicks.length < 4) console.log("  note: not enough room for 4 clicks; raise \"leadIn\"");
    } else if (fs.existsSync(mark)) {
      reencode(path.join(padded, "fill.wav"));
      fs.rmSync(mark);
      console.log("  count-in removed (backing track re-encoded without it)");
    }
  }

  if (S.reduce) {
    console.log("  Hard/Medium/Easy from Expert (reduce.py):");
    py(path.join(SCRIPTS, "reduce.py"), [rbMid, rbMid], { tail: 6 });
  }

  // mid2rbu config. Its header fields are not used by beatmatch.js (the song list comes from the JB), but keep them sane.
  const tiers = S.tiers || {};
  const g = typeof S.genre === "number" ? S.genre : Math.max(0, GENRES.indexOf(String(S.genre || "").toUpperCase()));
  const era = Math.min(4, Math.max(0, Math.floor(((S.year || 2000) - 1960) / 10)));
  const ascii = s => String(s).normalize("NFKD").replace(/[^\x20-\x7e]/g, "").slice(0, 47);
  const pp = Object.assign(literal
    ? { EnablePruning: "False", PruneDelta: 120, SparseMultiGems: "False", MultiGemReduction: "False" }
    : { EnablePruning: "True", PruneDelta: 120, SparseMultiGems: "True", MultiGemReduction: "False" }, S.mid2rbu || {});
  const ini = ["[Song]", `Name = ${ascii(S.title)}`, `Artist = ${ascii(S.artist)}`, "InitialTrack = 0",
    `DifficultyOffset = ${tiers.band ?? 2}`, `GenreOffset = ${g}`, `EraOffset = ${era}`,
    `DrumDifficulty = ${tiers.drums ?? 2}`, `GuitarDifficulty = ${tiers.guitar ?? 2}`, `BassDifficulty = ${tiers.bass ?? 2}`,
    `VocalDifficulty = ${tiers.vocals ?? 2}`, `BandDifficulty = ${tiers.band ?? 2}`, "",
    "[Parser]", `PitchedVocals = ${pitched ? "True" : "False"}`,
    ...["Drum", "Bass", "Guitar", "Vocal"].map(i => `${i}LaneMap = red=red, yellow=yellow, green=green, blue=blue`), "",
    "[PostProcess]", ...Object.entries(pp).map(([k, v]) => `${k} = ${v}`), ""].join("\n");
  fs.writeFileSync(path.join(C, "config.ini"), ini);
  // Not -I here: mid2rbu imports its own packages from the script's folder, which -I removes from sys.path.
  for (const f of fs.readdirSync(C)) if (f.toLowerCase().endsWith(".rbu")) fs.rmSync(path.join(C, f));
  run(PY, ["-E", "-s", MID2RBU, "-c", "config.ini", "-np", base + ".mid"], { cwd: C, tail: 3 });
  const rbu = path.join(C, "Z" + base.replace(/[^A-Za-z0-9]/g, "").toUpperCase() + ".rbu");
  const made = fs.readdirSync(C).filter(f => f.toLowerCase().endsWith(".rbu")).map(f => path.join(C, f));
  const rbuPath = fs.existsSync(rbu) ? rbu : made.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  if (!rbuPath) throw new Error("mid2rbu wrote no .rbu");

  // "donor": an official folder name in MUSIC, or a path to a BEATMATCH file (e.g. an on-disc chart extracted from the ISO)
  const donor = S.donor && /[\\/]|\.(STR|EDAT)$/i.test(S.donor) ? path.resolve(S._dir, S.donor)
    : S.donor ? path.join(music, S.donor, "BEATMATCH.STR.EDAT") : gameFiles(music).donor;
  if (!fs.existsSync(donor)) throw new Error(`donor chart not found: ${donor}`);
  const args = ["build", donor, rbuPath, path.join(B, "BEATMATCH.STR.EDAT"), "--audio-seconds", audioSeconds.toFixed(3),
    "--atm", path.join(B, `${S.folder}.ATM`)];
  if (S.dropSolos === true) args.push("--drop-solos");
  if (S.starsScale != null) args.push("--stars-scale", String(S.starsScale));
  const out = node("beatmatch.js", args, { tail: 12 });
  if (!/matches the .rbu exactly/.test(out)) throw new Error("beatmatch verify did not pass");

  // Every solo in the MIDI must be in the chart on every difficulty: mid2rbu drops a solo it cannot place without a
  // message (no gem at or after the solo's end on that difficulty), and verify can't see it (it compares with mid2rbu's
  // own output).
  if (S.dropSolos !== true) {
    const want = JSON.parse(/SOLOS (\{.*\})/.exec(py(path.join(SCRIPTS, "solocheck.py"), [rbMid], { echo: false }))[1]);
    const { sections, Image, chartFromImage } = require("./beatmatch.js");
    const bm = fs.readFileSync(path.join(B, "BEATMATCH.STR.EDAT")), bad = [];
    sections(bm).forEach((sec, d) => {
      const c = chartFromImage(new Image(Buffer.from(bm.subarray(sec.start, sec.start + sec.size)), d));
      ["drums", "bass", "guitar", "vocals"].forEach((part, t) => {
        if (c.solos[t].n !== want[part]) bad.push(`${["easy", "medium", "hard", "expert"][d]} ${part}: ${c.solos[t].n} of ${want[part]}`);
      });
    });
    if (bad.length) throw new Error("solos missing from the chart (mid2rbu drops a solo that ends after the part's last gem on a " +
      "difficulty; end it on or before that gem): " + bad.join(", "));
    const n = Object.values(want).reduce((a, b) => a + b, 0);
    console.log(`    solos: all ${n} in the chart on every difficulty`);
  }

  // "effects": screen effects at chosen times (fxchart.js); the donor's own effects are removed unless keepDonorEffects
  if (S.effects) {
    const list = typeof S.effects === "string" ? JSON.parse(fs.readFileSync(path.resolve(S._dir, S.effects), "utf8")) : S.effects;
    const spec = path.join(B, "effects.json");  // times shifted by the lead-in
    fs.writeFileSync(spec, JSON.stringify(list.map(e => ({ ...e, ...(e.from != null ? { from: sh(e.from) } : {}),
      ...(e.to != null ? { to: sh(e.to) } : {}), ...(e.at != null ? { at: sh(e.at) } : {}) })), null, 1));
    const bm = path.join(B, "BEATMATCH.STR.EDAT");
    const strip = (S.stripCommands || []).join(",");
    node("fxchart.js", ["apply", bm, bm, spec, ...(S.keepDonorEffects ? ["--keep"] : []), ...(strip ? ["--strip", strip] : [])], { tail: 80 });
  }

  // band animations (band.js): guitarist and bassist hands from this song's notes, the singer's mic and prop from its
  // vocals (a custom otherwise keeps the donor's, which follow another song)
  if (S.bandAnimations !== false) {
    const bm = path.join(B, "BEATMATCH.STR.EDAT"), spec = path.join(B, "band.json");  // times shifted by the lead-in
    fs.writeFileSync(spec, JSON.stringify({ prop: S.singerProp || "tambourine",
      ...(Array.isArray(S.singerSections) ? { sections: S.singerSections.map(x => ({ ...x, from: sh(x.from), to: sh(x.to) })) } : {}),
      ...(Array.isArray(S.singerMic) ? { mic: S.singerMic.map(x => ({ ...x, at: sh(x.at) })) } : {}),
      ...(Array.isArray(S.bandClips) ? { overrides: S.bandClips.map(x => ({ ...x, at: sh(x.at) })) } : {}) }, null, 1));
    node("band.js", [bm, bm, "--spec", spec], { tail: 14 });
  }
}

function stageDb(songsDir, music, outRoot, number) {
  console.log("\n[song database]");
  const list = fs.readdirSync(songsDir).map(d => path.join(songsDir, d, "song.json")).filter(p => fs.existsSync(p));
  const tmp = path.join(songsDir, ".db"); fs.mkdirSync(tmp, { recursive: true });
  const jsons = list.map(p => {
    const s = JSON.parse(fs.readFileSync(p, "utf8"));
    const atm = s.atm ? path.resolve(path.dirname(p), s.atm) : path.join(path.dirname(p), "build", `${s.folder}.ATM`);
    if (!fs.existsSync(atm)) throw new Error(`${p}: no ATM at ${atm} (build that song first)`);
    const q = path.join(tmp, `${s.folder}.json`);
    fs.writeFileSync(q, JSON.stringify({ ...s, atm }));
    return q;
  }).sort();
  console.log(`  ${jsons.length} custom song(s): ${jsons.map(j => path.basename(j, ".json")).join(", ")}`);
  const dbOut = path.join(outRoot, DB_FOLDER);
  fs.rmSync(dbOut, { recursive: true, force: true });
  node("mkjukebox.js", ["--base", gameFiles(music).base, "--out", dbOut, "--number", String(number), ...jsons], { tail: 2 + jsons.length });
  // PEDB.JSON: which songs this database lists (Pocket Encore's memory stick check reads it); remembered as ours
  stick.writeDbStamp(dbOut, { kind: "library", songs: jsons.map(j => path.basename(j, ".json")) });
  stick.recordDb(path.join(dbOut, `JB${String(number).padStart(6, "0")}.STR.EDAT`));
  // which game mode this database was made for (Pocket Encore says when the mode changed and it needs rebuilding)
  fs.writeFileSync(path.join(tmp, "mode.json"), JSON.stringify({ mode: GAME.mode, label: GAME.label, base: GAME.baseName, out: dbOut, at: new Date().toISOString() }));
}

function main() {
  const a = process.argv.slice(2);
  const opt = k => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  const jsonPath = a.find(x => x.endsWith(".json"));
  if (!jsonPath) { console.log("usage: mksong.js <songs/ZNAME/song.json> [--music <MUSIC dir>] [--out <dir>] [--from audio|chart|db]"); process.exit(1); }
  const S = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  S._dir = path.dirname(path.resolve(jsonPath));
  S.folder = String(S.folder || "").toUpperCase();
  if (!/^Z[A-Z0-9]{1,46}$/.test(S.folder)) throw new Error('"folder" must start with Z and be A-Z/0-9 (max 47 chars)');
  for (const k of ["title", "artist", "tiers"]) if (!S[k]) throw new Error(`"${k}" is required`);
  if (S.imported && S.folder !== path.basename(S._dir).toUpperCase()) throw new Error("imported song: folder must match its songs folder");
  const music = opt("--music") || DEFAULT_MUSIC;
  const songsDir = path.dirname(S._dir);
  const outRoot = path.resolve(opt("--out") || path.join(songsDir, "..", "out", "MUSIC"));
  const B = path.join(S._dir, "build"); fs.mkdirSync(B, { recursive: true });
  const from = a.includes("--db-only") ? "db" : (opt("--from") || "audio");
  const order = ["audio", "chart", "db"];
  if (!order.includes(from)) throw new Error("--from must be audio, chart or db");

  const src = S.stemSource || {};
  const TYPES = ["official", "multitrack", "ai", "unknown"], QUALITY = ["low", "medium", "high"];
  if (src.type && !TYPES.includes(src.type)) throw new Error(`"stemSource.type" must be ${TYPES.join(", ")}`);
  if (src.quality && !QUALITY.includes(src.quality)) throw new Error(`"stemSource.quality" must be ${QUALITY.join(", ")}`);
  console.log(`${S.folder}: "${S.title}" by ${S.artist}`);
  console.log(`  stems: ${src.type || "unknown"}${src.tool ? " (" + src.tool + ")" : ""}${src.quality ? ", quality " + src.quality : ""}` +
    `${src.notes ? " - " + src.notes : ""}`);
  if (S.imported) {
    // a song imported from someone's pack (Pocket Encore's Import): its chart and audio are used as they were shipped
    const I = path.join(S._dir, "import");
    console.log(`\n[imported song] chart and audio as shipped (${path.relative(TOOLS, I)})`);
    for (const f of [`${S.folder}.ATM`, "BEATMATCH.STR.EDAT", `${S.folder}_PREVIEW.AT3`]) {
      if (fs.existsSync(path.join(I, f))) fs.copyFileSync(path.join(I, f), path.join(B, f));
      else if (!f.endsWith(".AT3")) throw new Error(`imported song: ${f} missing from ${I}`);
    }
  } else {
    if (order.indexOf(from) <= 0) stageAudio(S, B);
    if (order.indexOf(from) <= 1) stageChart(S, B, music);
  }
  let jb;
  if (opt("--jb")) jb = parseInt(opt("--jb"), 10);
  else {
    const n = stick.nextDbNumber(music);
    jb = n.number;
    if (n.foreignTop && jb > stick.dayNumber()) console.log(`  song database number ${jb}: above JB${String(n.foreignTop).padStart(6, "0")}, another build's database on a memory stick`);
  }
  if (!(jb > 571 && jb <= 999999)) throw new Error("--jb must be 572..999999");
  stageDb(songsDir, music, outRoot, jb);

  // Assemble the song folder.
  const out = path.join(outRoot, S.folder);
  fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });
  const preview = S.imported ? fs.existsSync(path.join(B, `${S.folder}_PREVIEW.AT3`)) : S.preview !== false;
  const files = [`${S.folder}.ATM`, "BEATMATCH.STR.EDAT", ...(preview ? [`${S.folder}_PREVIEW.AT3`] : [])];
  for (const f of files) fs.copyFileSync(path.join(B, f), path.join(out, f));
  // PESONG.JSON: the song's details and build id (memory stick check; lets others import the song from a pack)
  let app = "";
  try { app = JSON.parse(fs.readFileSync(path.join(TOOLS, "pocketencore", "version.json"), "utf8")).version; } catch { }
  stick.writeStamp(out, S, { chart: S.imported ? "imported" : S.chart ? "edited" : S.midi ? "midi" : "stems", ...(app ? { app } : {}) });
  if (!S.imported) {
    // REAPER folder: the chart as built (what the game plays) + the five tracks as they are in the .ATM.
    const rp = path.join(TOOLS, "reaper", S.folder);
    node("reaperpack.js", [path.join(B, "BEATMATCH.STR.EDAT"), rp, "--name", `${S.folder}_auto`, "--wav", path.join(B, "wav_tail")], { echo: false });
    console.log(`  REAPER: ${rp} (${S.folder}_auto.mid + 5 WAVs; save edits under another name and set "chart" in song.json)`);
  }
  console.log(`\ndone -> ${outRoot}`);
  console.log(`  copy  ${S.folder}\\  and  ${DB_FOLDER}\\  into MUSIC\\ (replace ${DB_FOLDER} if it is already there),`);
  console.log(`  or use Install on Pocket Encore's Memory stick page`);
}

try { main(); } catch (e) { console.error(`\nERROR: ${e.message}`); process.exit(1); }
