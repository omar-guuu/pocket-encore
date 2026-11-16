// Chart rules: what the 112 official charts do (FINDINGS §28-33), checked on a Rock Band-format MIDI (parsed by
// midi.js). Used for the Details tab's "Chart checks" and live in the editor. None of them blocks a build: they say
// where a chart leaves the official style. Each item: { level: "error"|"warn"|"info", rule, part, diff, msg, at }.
// rule + part + diff is stable while the chart is edited, so the editor can remember dismissed warnings by it.
"use strict";

const PART_NAMES = { drums: ["PART DRUMS"], bass: ["PART BASS"], guitar: ["PART GUITAR"], vocals: ["PART KEYS", "PART VOCALS"] };
const DIFF_NAMES = ["Easy", "Medium", "Hard", "Expert"];
const TAP_MAX = 160;

// official numbers the rules use (Expert unless noted)
const OFFICIAL = {
  firstGem: 2.77,                                                // s: no official chart has a gem earlier
  density: { drums: 11, bass: 9, guitar: 12, vocals: 7 },        // gems/s in the busiest 2 s (p90 10.5/8.5/11.5/6.5)
  holds: { bass: 0.3, guitar: 0.25, vocals: 0.5 },               // held share (p90 26/18/44 %); drums never held
  guitarChords: 0.55, guitarChordsMedian: 0.19,                  // guitar chord share (4-49 %, Hard p90 55 %)
  otherChords: 0.05,                                             // bass and vocals: almost no chords
  triadsPerSong: 4,                                              // 3-gem chords: Expert guitar only, p50 4 per song
  thumbMs: 250, thumbRun: 2,                                     // one-thumb lane changes in a row (<= 250 ms apart)
  laneRun: { bass: 24, guitar: 16 },                             // same lane in a row: 95 % of official songs stay within
  odGap: 2,                                                      // s between overdrive phrases (several bars)
  vocalAfterHold: 0.25,                                          // s after a held vocal gem (p5 ~0.3 s)
  sameLaneMs: 80,                                                // two gems on one lane closer than this
};

function tempoMap(midi) {
  const segs = [];
  for (const tr of midi.tracks) for (const e of tr.events) if (e.d[0] === 0xff && e.d[1] === 0x51) segs.push({ t: e.t, us: (e.d[3] << 16) | (e.d[4] << 8) | e.d[5] });
  segs.sort((a, b) => a.t - b.t);
  if (!segs.length || segs[0].t > 0) segs.unshift({ t: 0, us: 500000 });
  let s = 0;
  segs.forEach((g, i) => { if (i) s += (g.t - segs[i - 1].t) * segs[i - 1].us / 1e6 / midi.tpb; g.s = s; });
  return t => { let g = segs[0]; for (const x of segs) if (x.t <= t) g = x; else break; return g.s + (t - g.t) * g.us / 1e6 / midi.tpb; };
}

// opts: { reduce: Easy-Hard are remade from Expert (only Expert is checked), audio: build/audio.json }
function checkChart(midi, opts = {}) {
  const sec = tempoMap(midi), items = [], tpb = midi.tpb, { audio } = opts;
  const push = (level, rule, part, diff, msg, at) => items.push({ level, rule, part, diff: diff == null ? null : DIFF_NAMES[diff], msg, at: at != null ? +at.toFixed(2) : undefined });
  const hand = l => (l < 2 ? 0 : 1), allSolos = [];
  for (const [part, names] of Object.entries(PART_NAMES)) {
    const tr = midi.tracks.find(t => names.includes(t.name));
    if (!tr) { push("warn", "no-track", part, null, "no track in the chart: the part will be empty"); continue; }
    const off = part === "drums" ? 1 : 0;
    const solos = tr.notes.filter(n => n.n === 103), od = tr.notes.filter(n => n.n === 116).sort((a, b) => a.t - b.t);
    if (solos.length > 4) push("error", "solo-count", part, null, `${solos.length} solos; the chart format holds at most 4`);
    for (const s of solos) allSolos.push({ part, s });
    for (const s of solos) if (s.l <= tpb) push("error", "solo-short", part, null, `solo at ${sec(s.t).toFixed(2)} s is shorter than a beat (mid2rbu drops it)`, sec(s.t));
    const expertGems = tr.notes.filter(n => n.n >= 96 + off && n.n < 100 + off).length;
    if (expertGems > 20 && !od.length) push("warn", "od-none", part, null, "no overdrive phrases (every official part has them)");
    for (let i = 1; i < od.length; i++) {
      const gap = sec(od[i].t) - sec(od[i - 1].t + od[i - 1].l);
      if (gap < OFFICIAL.odGap) { push("warn", "od-close", part, null, `overdrive phrases ${i} and ${i + 1} are ${gap.toFixed(1)} s apart (official: several bars)`, sec(od[i].t)); break; }
    }
    for (let d = 3; d >= 0; d--) {
      const base = 60 + 12 * d + off, gems = tr.notes.filter(n => n.n >= base && n.n < base + 4).sort((a, b) => a.t - b.t || a.n - b.n);
      const dn = DIFF_NAMES[d];
      if (!gems.length) { if (d === 3) push("warn", "no-gems", part, d, "no Expert gems"); continue; }
      if (opts.reduce && d < 3) continue;  // remade from Expert at build time
      const first = sec(gems[0].t), last = gems[gems.length - 1];
      if (first < OFFICIAL.firstGem) push("warn", "first-gem", part, d, `${dn}: first gem at ${first.toFixed(2)} s; official charts never start before ${OFFICIAL.firstGem} s`, first);
      if (audio && sec(last.t + last.l) > audio.audioSeconds) push("error", "after-audio", part, d, `${dn}: a gem ends at ${sec(last.t + last.l).toFixed(2)} s, after the audio (${audio.audioSeconds.toFixed(2)} s)`, sec(last.t));
      // onsets: tick -> lanes
      const byTick = new Map();
      for (const g of gems) { if (!byTick.has(g.t)) byTick.set(g.t, []); byTick.get(g.t).push(g.n - base); }
      const onsets = [...byTick.keys()].sort((a, b) => a - b), sizes = onsets.map(t => byTick.get(t).length);
      const chords = sizes.filter(n => n > 1).length, triples = sizes.filter(n => n === 3).length, quads = sizes.filter(n => n > 3).length;
      const at = pred => sec(onsets[sizes.findIndex(pred)]);
      if (quads) push("warn", "chord-4", part, d, `${dn}: ${quads} chord${quads > 1 ? "s" : ""} of 4 gems (official charts: practically never)`, at(n => n > 3));
      if (triples && (d < 3 || part !== "guitar")) push("warn", "chord-3-where", part, d, `${dn}: ${triples} chord${triples > 1 ? "s" : ""} of 3 gems (official: Expert guitar only)`, at(n => n === 3));
      else if (triples > Math.max(OFFICIAL.triadsPerSong * 2, onsets.length * 0.02)) push("warn", "chord-3-many", part, d, `${dn}: ${triples} chords of 3 gems (official: about ${OFFICIAL.triadsPerSong} per song)`, at(n => n === 3));
      const chordShare = chords / onsets.length;
      if (part === "guitar" && chordShare > OFFICIAL.guitarChords) push("warn", "chord-share", part, d, `${dn}: ${(chordShare * 100).toFixed(0)}% chords (official guitar: 4-49%, median 19%)`);
      if ((part === "bass" || part === "vocals") && chordShare > OFFICIAL.otherChords) push("warn", "chord-share", part, d, `${dn}: ${(chordShare * 100).toFixed(0)}% chords (official ${part}: almost none)`);
      if (part === "drums" && chords) push("info", "drum-chords", part, d, `${dn}: ${chords} drum chords (official drums have some: kick + snare, kick + cymbal)`);
      // holds
      const held = gems.filter(g => g.l > TAP_MAX);
      if (part === "drums" && held.length) push("error", "drum-held", part, d, `${dn}: ${held.length} held drum gem${held.length > 1 ? "s" : ""}; official drums are never held`, sec(held[0].t));
      else if (part !== "drums" && held.length / gems.length > OFFICIAL.holds[part]) push("warn", "held-share", part, d, `${dn}: ${(held.length / gems.length * 100).toFixed(0)}% held gems (official ${part}: up to ~${OFFICIAL.holds[part] * 100}%)`);
      // density: onsets per second in the busiest 2 s
      let worst = 0, worstAt = 0;
      for (let i = 0, j = 0; i < onsets.length; i++) {
        while (j < onsets.length && sec(onsets[j]) - sec(onsets[i]) <= 2) j++;
        if (j - i > worst) { worst = j - i; worstAt = sec(onsets[i]); }
      }
      if (worst / 2 > OFFICIAL.density[part]) push("warn", "density", part, d, `${dn}: ${(worst / 2).toFixed(1)} gems/s around ${worstAt.toFixed(1)} s (official ${part}: up to ~${OFFICIAL.density[part]}/s)`, worstAt);
      // thumbs (bass, guitar): one-thumb lane changes in a row between fast single gems (red/yellow = left, blue/green = right)
      if (part === "bass" || part === "guitar") {
        let run = 0, worstRun = 0, runAt = 0, runs = 0, runHand = 0;
        for (let i = 1; i < onsets.length; i++) {
          const a = byTick.get(onsets[i - 1]), b = byTick.get(onsets[i]);
          const fast = (sec(onsets[i]) - sec(onsets[i - 1])) * 1000 <= OFFICIAL.thumbMs;
          if (fast && a.length === 1 && b.length === 1 && a[0] !== b[0] && hand(a[0]) === hand(b[0])) {
            run++;
            if (run === OFFICIAL.thumbRun + 1) runs++;
            if (run > worstRun) { worstRun = run; runAt = sec(onsets[i - run]); runHand = hand(b[0]); }
          } else run = 0;
        }
        if (worstRun > OFFICIAL.thumbRun) push("warn", "thumb", part, d, `${dn}: ${runs} fast passage${runs > 1 ? "s" : ""} on one thumb (longest: ${worstRun + 1} gems alternating ${runHand ? "blue/green" : "red/yellow"} around ${runAt.toFixed(1)} s); official charts switch thumbs after at most ${OFFICIAL.thumbRun}`, runAt);
        // long runs on one lane
        let same = 1, longest = 1, sameAt = 0;
        for (let i = 1; i < onsets.length; i++) {
          const a = byTick.get(onsets[i - 1]), b = byTick.get(onsets[i]);
          if (a.length === 1 && b.length === 1 && a[0] === b[0]) { same++; if (same > longest) { longest = same; sameAt = sec(onsets[i - same + 1]); } } else same = 1;
        }
        if (longest > OFFICIAL.laneRun[part]) push("warn", "lane-run", part, d, `${dn}: ${longest} gems in a row on one lane around ${sameAt.toFixed(1)} s (95% of official ${part} parts stay within ${OFFICIAL.laneRun[part]})`, sameAt);
      }
      // vocals: room after a held gem
      if (part === "vocals") for (let i = 1; i < gems.length; i++) {
        const p = gems[i - 1];
        if (p.l > TAP_MAX && gems[i].t !== p.t && sec(gems[i].t) - sec(p.t + p.l) < OFFICIAL.vocalAfterHold) { push("warn", "vocal-after-hold", part, d, `${dn}: a gem ${(sec(gems[i].t) - sec(p.t + p.l)).toFixed(2)} s after a held one at ${sec(p.t).toFixed(2)} s (official: at least 0.3 s)`, sec(p.t)); break; }
      }
      // two gems on one lane almost at once
      for (let i = 1; i < gems.length; i++) if (gems[i].n === gems[i - 1].n && gems[i].t !== gems[i - 1].t && (sec(gems[i].t) - sec(gems[i - 1].t)) * 1000 < OFFICIAL.sameLaneMs) { push("warn", "same-lane-close", part, d, `${dn}: two gems on one lane ${((sec(gems[i].t) - sec(gems[i - 1].t)) * 1000).toFixed(0)} ms apart at ${sec(gems[i].t).toFixed(2)} s`, sec(gems[i].t)); break; }
      for (const s of solos) if (s.t + s.l > last.t + 1) { push("warn", "solo-end", part, d, `${dn}: solo at ${sec(s.t).toFixed(2)} s ends after the part's last gem (mksong clamps it)`, sec(s.t)); break; }
    }
  }
  // only one part has a solo at a time
  for (let i = 0; i < allSolos.length; i++) for (let j = i + 1; j < allSolos.length; j++) {
    const x = allSolos[i], y = allSolos[j];
    if (x.part !== y.part && x.s.t < y.s.t + y.s.l && y.s.t < x.s.t + x.s.l) {
      const [p, q] = x.s.t <= y.s.t ? [x, y] : [y, x];
      push("warn", "solo-overlap", q.part, null, `solo at ${sec(q.s.t).toFixed(2)} s overlaps the ${p.part} solo at ${sec(p.s.t).toFixed(2)} s; only one part should have a solo at a time`, sec(q.s.t));
    }
  }
  if (audio && audio.musicStart != null && audio.musicStart < 2.9) push("warn", "lead-in", null, null, `the music starts at ${audio.musicStart} s; official songs leave ~3 s (set "leadIn")`);
  const order = { error: 0, warn: 1, info: 2 };
  items.sort((a, b) => order[a.level] - order[b.level] || (a.at ?? 1e9) - (b.at ?? 1e9));
  return items;
}

module.exports = { checkChart, OFFICIAL };
