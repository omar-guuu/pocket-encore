#!/usr/bin/env python3
"""Generates a Rock Band-format MIDI (for mid2rbu) from a plain multi-instrument transcription.

    python autochart.py <source.mid> <out.mid> --offset 9.180 --bpm 150.15
        [--drums 1] [--bass 3] [--guitar 2] [--vocals 4]
        [--od-every 6 --od-first 2 --od-bars 1]
        [--intro-stems <wav dir> --intro-start 4.3] [--name "PUSH IT"]
        [--vocal-events vocal_notes.json] [--solo guitar:6.8:20.3 ...]

--offset: audio time (s) of the source MIDI's tick 0 (found with align.js).
--bpm:    real tempo of the recording (source tempo corrected for drift).
Track numbers are indexes into the source file; "0,4" = track 0 until track 4's first note, then track 4.
--vocal-events: vocal notes from the vocal stem (vocalchart.js) instead of a MIDI track (rapped vocals).
--solo PART:START:END: a solo section (note 103) on that part, in audio seconds; repeatable (max 4 per part). Output: 480 ticks per beat, a lead-in made of one
shorter bar followed by whole 4/4 bars, so source tick 0 lands exactly on --offset and the bars just
before it line up with the music; tracks PART DRUMS/BASS/GUITAR/VOCALS and BEAT.
Overdrive: note 116 on every track for --od-bars bar(s) every --od-every bars, from song bar --od-first
(bars counted from source tick 0; official charts have a phrase every 10-15 s).
Intro: with --intro-stems, notes for the part of the audio before source tick 0 (from --intro-start)
are detected from the prepared stems (drums.wav, bass_guitar.wav, lead_guitar.wav; 44.1 kHz mono) and
quantised to 16th notes: drums alternating kick/snare lanes, bass and guitar alternating the middle lanes, each a sustain until
the next onset. Difficulties: Expert = everything (notes closer than 125 ms thinned by beat strength), then
Hard/Medium/Easy picked from Expert like the official charts do (reduce.py).
"""
import argparse
import json
import math
import struct
import wave
import os
import sys
import mido

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # mksong runs python -I
from reduce import Timing, reduce_part

TPB = 480
DIFF_BASE = {"easy": 60, "medium": 72, "hard": 84, "expert": 96}

# Drum lanes as in the official charts (FINDINGS §29; mask bit = lane, left to right): kick on lane 3, snare on
# lane 1, cymbals alternate between lanes 0 and 2 (two hands) in runs, crash on lane 0, toms on 2 (high) / 0 (low).
KICK, SNARE = {35, 36}, {37, 38, 39, 40}
CRASH, RIDE, HAT = {49, 52, 55, 57}, {51, 53, 59}, {42, 44, 46}
TOM_HI, TOM_LO = {47, 48, 50}, {41, 43, 45}
# anything else (tambourine 54, cowbell 56, shakers...) is left out, except in bars with no hi-hat/ride/crash: there
# its hits on the 8th-note grid stand in for the hi-hat (the time-keeping layer)
def notes_of(track):
    tick, on, out = 0, {}, []
    for msg in track:
        tick += msg.time
        if msg.type == "note_on" and msg.velocity > 0:
            on[(msg.note, msg.channel)] = tick
        elif msg.type in ("note_off", "note_on") and (msg.note, msg.channel) in on:
            s = on.pop((msg.note, msg.channel))
            out.append((s, tick - s, msg.note))
    return sorted(out)


def chord_lanes(root, width, octave=False):
    """Two-gem chord with its low gem on the melody lane, shapes as in the official guitar charts (FINDINGS §30):
    1-3 / 2-4 (skip one lane) for fifths, adjacent pairs near the top when the root is high, 1-4 for octaves on the
    lowest lane, adjacent 2-3 for thirds/fourths; never the two left lanes together (official: almost never)."""
    if octave and root == 0:
        return {0, 3}
    if width == 2:
        return {root, root + 2} if root <= 1 else {2, 3}
    lo = max(1, min(root, 2))
    return {lo, lo + 1}


def onsets_from_pitched(notes, timing=None, chords=False, max_chords=0.25):
    """One gem per onset; lanes follow the melody like the official charts (FINDINGS §29):
    a phrase (notes less than phrase_gap apart) starts on the lane of its first note's place in the phrase's range;
    then up = right, down = left (1 lane up to a tone, 2 up to a fifth, 3 beyond); a repeated note stays once and
    then bounces between its lane and the next one, so no lane is held for long (official: 16-25 % repeats).
    chords=True (guitar): onsets with 2+ pitches in the source (power chords, octaves) become two-gem chords where
    they matter (beats, held notes, chord changes, up to max_chords of the gems); the rest play their root.
    Official guitar: chords 4-47 % of the gems (median 19 %), bass almost never."""
    phrase_gap = 2 * TPB
    by_tick = {}
    for s_, d, p in notes:
        lo, hi, dd = by_tick.get(s_, (p, p, d))
        by_tick[s_] = (min(lo, p), max(hi, p), max(dd, d))
    ticks = sorted(by_tick)
    # which polyphonic onsets keep their chord: score, then the best ones up to max_chords of all onsets
    keep = set()
    if chords and timing is not None:
        cand = []
        prev_root = None
        for t in ticks:
            lo, hi, d = by_tick[t]
            if hi > lo:
                sc = timing.strength(t) + (3 if d >= 360 else 0) + (2 if lo != prev_root else 0)
                cand.append((-sc, t))
            prev_root = lo
        cand.sort()
        keep = {t for sc, t in cand[:int(len(ticks) * max_chords)] if -sc >= 3}
    out, lane, prev, prev_t, home, reps = [], 0, None, None, 0, 0
    for k, t in enumerate(ticks):
        p, top, d = by_tick[t]
        if prev is None or t - prev_t > phrase_gap:
            end = k
            while end + 1 < len(ticks) and ticks[end + 1] - ticks[end] <= phrase_gap:
                end += 1
            ps = [by_tick[x][0] for x in ticks[k:end + 1]]
            lo, hi = min(ps), max(ps)
            lane = 1 if hi == lo else round((p - lo) / (hi - lo) * 3)
            home, reps = lane, 0
        elif p == prev:
            reps += 1
            if reps == 1:
                home = lane
            elif not (out and len(out[-1][2]) > 1) and t not in keep:
                lane = (home + (1 if home < 2 else -1)) if lane == home else home
        else:
            reps = 0
            step = 1 if abs(p - prev) <= 2 else 2 if abs(p - prev) <= 7 else 3
            new = max(0, min(3, lane + step * (1 if p > prev else -1)))
            if new == lane:
                new = lane - 1 if lane == 3 else lane + 1
            lane = new
        if t in keep:
            width = 1 if (top - p) % 12 in (3, 4) else 2
            lanes = chord_lanes(lane, width, octave=(top - p) % 12 == 0)
            lane = min(lanes)
        else:
            lanes = {lane}
        out.append((t, d, lanes))
        prev, prev_t = p, t
    return out


def limit_runs(events, longest=2):
    """Official charts rarely put more than 2 gems in a row on one lane: longer runs bounce to the next lane."""
    out, run = [], 0
    for k, (t, d, lanes) in enumerate(events):
        if k and lanes == events[k - 1][2] and len(lanes) == 1:
            run += 1
        else:
            run = 0
        if run >= longest and run % 2 == longest % 2:
            (l,) = lanes
            lanes = {l + 1 if l < 2 else l - 1}
        out.append((t, d, lanes))
    return out


def onsets_from_drums(notes, timing):
    """Kick, snare and cymbals per tick -> at most 2 lanes. Cymbal hits alternate lanes 0/2 within runs (8th notes
    or closer); a hi-hat/ride falling together with the snare is dropped, with the kick only kept on beats 1 and 3."""
    by_tick = {}
    for s_, _, p in notes:
        by_tick.setdefault(s_, set()).add(p)
    kit = KICK | SNARE | CRASH | RIDE | HAT | TOM_HI | TOM_LO
    bars_with_cym = {timing.bar_of(t) for t, ps in by_tick.items() if ps & (CRASH | RIDE | HAT)}
    for t, ps in by_tick.items():
        if ps - kit and timing.bar_of(t) not in bars_with_cym and timing.strength(t) >= 2:
            ps.add(42)
    out, alt, last_cym = [], 0, None
    for t in sorted(by_tick):
        ps = by_tick[t]
        lanes = []
        if ps & KICK:
            lanes.append(3)
        if ps & SNARE:
            lanes.append(1)
        cym = ps & (CRASH | RIDE | HAT)
        if cym:
            if last_cym is None or t - last_cym > TPB // 2:
                alt = 0
            lane = 0 if ps & CRASH else (0 if alt % 2 == 0 else 2)
            alt += 1
            last_cym = t
            ok = not lanes or ps & CRASH or (lanes == [3] and timing.strength(t) >= 4)
            if len(lanes) < 2 and lane not in lanes and ok:
                lanes.append(lane)
        for group, lane in ((TOM_HI, 2), (TOM_LO, 0)):
            if ps & group and len(lanes) < 2 and lane not in lanes:
                lanes.append(lane)
        if lanes:
            out.append((t, 60, set(lanes)))
    return out


def intro_events(times, sec_to_tick, end_tick, lanes):
    """16th-quantised gems from onset times, alternating between two lanes; each lasts until the next one."""
    ticks = sorted({int(round(sec_to_tick(t) / 120.0)) * 120 for t in times})
    ticks = [t for t in ticks if t < end_tick]
    return [(t, (ticks[i + 1] if i + 1 < len(ticks) else end_tick) - t, {lanes[i % 2]}) for i, t in enumerate(ticks)]


def read_mono(path):
    with wave.open(path, "rb") as w:
        if w.getnchannels() != 1 or w.getsampwidth() != 2:
            raise SystemExit(f"{path}: need 16-bit mono (output of prepwav.js)")
        rate, raw = w.getframerate(), w.readframes(w.getnframes())
    return rate, struct.unpack(f"<{len(raw) // 2}h", raw)


def detect_onsets(path, start_s, end_s):
    """Onset times (s) in [start_s, end_s): a 10 ms frame at least 12 dB above the previous one and above -35 dBFS."""
    rate, x = read_mono(path)
    hop, prev, out = rate // 100, -120.0, []
    for i in range(int(start_s * rate), min(len(x), int(end_s * rate)) - hop, hop):
        e = sum(v * v for v in x[i:i + hop]) / hop / (32768.0 ** 2)
        db = 10 * math.log10(e + 1e-12)
        if db - prev > 12 and db > -35:
            out.append(i / rate)
        prev = db
    return out


# Held notes (FINDINGS §30-31). A gem is held only when its source note is long enough; lower difficulties hold only
# gems Expert holds; at most `max` of each difficulty's gems are held (the longest win); the tail stops `gap` ticks
# (and at least `gap_ms`) before the next gem; tails shorter than an 8th are dropped.
#   bass/guitar: official ~7 % held (p90 26 %); gaps from the RBN guides: 1/16 Expert/Hard, 3/16 Medium, 1/4 Easy.
#   vocals: official ~23 % held (p90 42 %), tails median a dotted 8th, and >= ~300 ms before the next gem on every
#   difficulty (p5 298-323 ms).
#   drums: never held (official 0 %).
SUS_GAP = {"expert": 120, "hard": 120, "medium": 360, "easy": 480}
SUS = {"instrument": dict(src_min=480, min=240, max=0.15, gap_ms=0),
       "vocals": dict(src_min=240, min=200, max=0.30, gap_ms=300)}


def track_from(name, per_diff, base_shift=0, kicks=None, overdrive=(), solos=(), sustains=None, ms_tick=1.0):
    """sustains: None = all gems short (drums), "instrument" or "vocals" = held-note rules above.
    ms_tick: milliseconds per tick at the song tempo (for gap_ms)."""
    msgs = []
    rule = SUS.get(sustains)
    gap_of = lambda diff: max(SUS_GAP[diff], int(rule["gap_ms"] / ms_tick)) if rule else 0
    held = {}
    if rule:
        ex = per_diff.get("expert", [])
        for i, (t, d, _) in enumerate(ex):
            nxt = ex[i + 1][0] if i + 1 < len(ex) else t + d + gap_of("expert")
            if d >= rule["src_min"] and min(d, nxt - t - gap_of("expert")) >= rule["min"]:
                held[t] = d
    for diff, events in per_diff.items():
        base = DIFF_BASE[diff] + base_shift
        mine = {}
        if rule:
            ts = [t for t, _, _ in events if t in held]
            mine = {t: held[t] for t in sorted(ts, key=lambda t: -held[t])[:int(len(events) * rule["max"])]}
        for i, (t, d, lanes) in enumerate(events):
            nxt = events[i + 1][0] if i + 1 < len(events) else t + d + gap_of(diff)
            tail = min(mine.get(t, 0), nxt - t - gap_of(diff)) if rule else 0
            dur = tail if rule and tail >= rule["min"] else 30
            for lane in lanes:
                msgs.append((t, 1, mido.Message("note_on", note=base + lane, velocity=100)))
                msgs.append((t + dur, 0, mido.Message("note_off", note=base + lane, velocity=0)))
    for t in kicks or []:
        for diff in DIFF_BASE:
            msgs.append((t, 1, mido.Message("note_on", note=DIFF_BASE[diff], velocity=100)))
            msgs.append((t + 30, 0, mido.Message("note_off", note=DIFF_BASE[diff], velocity=0)))
    for s, e in overdrive:
        msgs.append((s, 1, mido.Message("note_on", note=116, velocity=100)))
        msgs.append((e, 0, mido.Message("note_off", note=116, velocity=0)))
    for s, e in solos:
        msgs.append((s, 1, mido.Message("note_on", note=103, velocity=100)))
        msgs.append((e, 0, mido.Message("note_off", note=103, velocity=0)))
    return to_track(name, msgs)


def to_track(name, msgs):
    track = mido.MidiTrack([mido.MetaMessage("track_name", name=name, time=0)])
    now = 0
    for t, _, msg in sorted(msgs, key=lambda x: (x[0], x[1])):
        track.append(msg.copy(time=t - now))
        now = t
    track.append(mido.MetaMessage("end_of_track", time=0))
    return track


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("source"); ap.add_argument("out")
    ap.add_argument("--offset", type=float, required=True)
    ap.add_argument("--bpm", type=float, required=True)
    ap.add_argument("--drums", default="1"); ap.add_argument("--bass", default="3")
    ap.add_argument("--guitar", default="2"); ap.add_argument("--vocals", default="4")
    ap.add_argument("--od-every", type=int, default=6); ap.add_argument("--od-first", type=int, default=2)
    ap.add_argument("--od-bars", type=int, default=1)
    ap.add_argument("--intro-stems"); ap.add_argument("--intro-start", type=float, default=0.0)
    ap.add_argument("--name", default="SONG")
    ap.add_argument("--vocal-events")
    ap.add_argument("--solo", action="append", default=[])
    a = ap.parse_args()
    tracks_of = lambda v: [int(x) for x in str(v).split(",") if x.strip() != ""]

    src = mido.MidiFile(a.source)
    scale = TPB / src.ticks_per_beat
    beat_s = 60.0 / a.bpm

    # Lead-in: n whole beats ending exactly at --offset; tempo of the lead-in adjusted to make it exact.
    lead_beats = max(1, round(a.offset / beat_s))
    lead_bpm = 60.0 * lead_beats / a.offset
    full_bars, extra = divmod(lead_beats, 4)
    lead = lead_beats * TPB
    short_bar = extra * TPB  # the shorter bar (if any) comes first; whole 4/4 bars run up to the song start
    conv = lambda t: lead + int(round(t * scale))
    sec_to_tick = lambda t: t / a.offset * lead  # inside the lead-in (constant tempo lead_bpm)

    # Audio time (s) -> output tick: lead-in (constant lead_bpm) before --offset, --bpm after it.
    audio_tick = lambda t: sec_to_tick(t) if t < a.offset else lead + (t - a.offset) / beat_s * TPB
    timing = Timing([(0, mido.bpm2tempo(lead_bpm)), (lead, mido.bpm2tempo(a.bpm))],
                    [(0, extra, 4), (short_bar, 4, 4)] if extra else [(0, 4, 4)])

    def merged_notes(idxs):
        """Notes of one or more source tracks; each later track takes over from its first note ("0,4": track 0
        until track 4 starts, then track 4)."""
        out = []
        for k, idx in enumerate(idxs):
            notes = notes_of(src.tracks[idx])
            if k + 1 < len(idxs):
                nxt = notes_of(src.tracks[idxs[k + 1]])
                if nxt:
                    notes = [n for n in notes if n[0] < nxt[0][0]]
            if k > 0 and out:
                notes = [n for n in notes if n[0] >= out[-1][0]]
            out = sorted(out + notes)
        return out

    def part(idxs, kind, stem=None, lanes=(1, 2), name="guitar"):
        notes = [(conv(s), int(round(d * scale)), p) for s, d, p in merged_notes(idxs)]
        events = (onsets_from_drums(notes, timing) if kind == "drums"
                  else onsets_from_pitched(notes, timing, chords=(name == "guitar")))
        if stem and a.intro_stems:
            times = detect_onsets(f"{a.intro_stems}/{stem}", a.intro_start, a.offset - 0.05)
            events = intro_events(times, sec_to_tick, lead, lanes) + events
        return reduce_part(events, timing, name, prune_expert=True), None

    drums, kicks = part(tracks_of(a.drums), "drums", "drums.wav", (3, 1), "drums")
    bass, _ = part(tracks_of(a.bass), "pitched", "bass_guitar.wav", (1, 2), "bass")
    guitar, _ = part(tracks_of(a.guitar), "pitched", "lead_guitar.wav", (1, 2))
    if a.vocal_events:
        # Vocals from the vocal stem (vocalchart.js): seconds -> 16th-note grid, one gem per tick.
        with open(a.vocal_events) as f:
            vn = json.load(f)["notes"]
        by_tick = {}
        for v in vn:
            t = int(round(audio_tick(v["t"]) / 120.0)) * 120
            d = max(60, int(round(audio_tick(v["t"] + v["d"]))) - t)
            by_tick.setdefault(t, (d, {v["lane"]}))
        ev = [(t, by_tick[t][0], by_tick[t][1]) for t in sorted(by_tick)]
        vocals = reduce_part(limit_runs(ev), timing, "vocals", prune_expert=True)
    else:
        vocals, _ = part(tracks_of(a.vocals), "pitched", name="vocals")

    # Solos: PART:START:END in audio seconds -> note 103 on that track (mid2rbu needs it longer than one beat).
    # The end is placed just before END so a note starting exactly there is not part of the solo.
    solos = {"drums": [], "bass": [], "guitar": [], "vocals": []}
    for spec in a.solo:
        name, s, e = spec.split(":")
        if name not in solos:
            raise SystemExit(f"--solo {spec}: part must be drums, bass, guitar or vocals")
        st, en = int(round(audio_tick(float(s)))), int(round(audio_tick(float(e)))) - 1
        if en - st <= TPB:
            raise SystemExit(f"--solo {spec}: must be longer than one beat")
        # mid2rbu drops a solo whose end lies after the part's last gem (it needs a gem at or after the end tick on
        # every difficulty): end it on the last gem the part has on all difficulties instead.
        part_ev = {"drums": drums, "bass": bass, "guitar": guitar, "vocals": vocals}[name]
        last = min((ev[-1][0] for ev in part_ev.values() if ev), default=en)
        if en > last:
            print(f"  --solo {spec}: ends after the last {name} gem; solo ends on it ({en - last} ticks earlier)")
            en = last
        if en - st <= TPB:
            raise SystemExit(f"--solo {spec}: no {name} gems in it")
        solos[name].append((st, en))

    end_tick = max(e[-1][0] + e[-1][1] for p in (drums, bass, guitar, vocals) for e in [p["expert"]] if e) + 4 * TPB
    bar = 4 * TPB
    overdrive = [(lead + b * bar, lead + (b + a.od_bars) * bar)
                 for b in range(a.od_first, (end_tick - lead) // bar, a.od_every)] if a.od_every > 0 else []

    out = mido.MidiFile(type=1, ticks_per_beat=TPB)
    tempo = mido.MidiTrack([mido.MetaMessage("track_name", name=a.name, time=0),
                            mido.MetaMessage("time_signature", numerator=4, denominator=4, time=0),
                            mido.MetaMessage("set_tempo", tempo=mido.bpm2tempo(lead_bpm), time=0)])
    events = []
    if extra:
        tempo[1] = mido.MetaMessage("time_signature", numerator=extra, denominator=4, time=0)
        events.append((short_bar, mido.MetaMessage("time_signature", numerator=4, denominator=4)))
    events.append((lead, mido.MetaMessage("set_tempo", tempo=mido.bpm2tempo(a.bpm))))
    now = 0
    for t, msg in sorted(events, key=lambda x: x[0]):
        tempo.append(msg.copy(time=t - now)); now = t
    tempo.append(mido.MetaMessage("end_of_track", time=0))
    out.tracks.append(tempo)

    ms_tick = beat_s * 1000 / TPB
    out.tracks.append(track_from("PART DRUMS", drums, base_shift=1, kicks=kicks, overdrive=overdrive, solos=solos["drums"]))
    out.tracks.append(track_from("PART BASS", bass, overdrive=overdrive, solos=solos["bass"], sustains="instrument", ms_tick=ms_tick))
    out.tracks.append(track_from("PART GUITAR", guitar, overdrive=overdrive, solos=solos["guitar"], sustains="instrument", ms_tick=ms_tick))
    out.tracks.append(track_from("PART VOCALS", vocals, overdrive=overdrive, solos=solos["vocals"], sustains="vocals", ms_tick=ms_tick))

    beat_msgs, t = [], 0
    while t <= end_tick:
        if t < short_bar:
            beat_in_bar = t // TPB
        else:
            beat_in_bar = ((t - short_bar) // TPB) % 4
        note = 12 if beat_in_bar == 0 else 13
        beat_msgs.append((t, 1, mido.Message("note_on", note=note, velocity=100)))
        beat_msgs.append((t + 120, 0, mido.Message("note_off", note=note, velocity=0)))
        t += TPB
    out.tracks.append(to_track("BEAT", beat_msgs))
    out.save(a.out)

    print(f"overdrive: {len(overdrive)} phrases of {a.od_bars} bar(s), first at {a.offset + a.od_first * 4 * beat_s:.1f} s")
    print(f"lead-in {lead_beats} beats ({extra}/4 + {full_bars} bars of 4/4) at {lead_bpm:.3f} BPM = {a.offset:.3f} s; then {a.bpm} BPM")
    for name, p in (("drums", drums), ("bass", bass), ("guitar", guitar), ("vocals", vocals)):
        print(f"  {name:6} " + "  ".join(f"{d}:{len(p[d])}" for d in ("easy", "medium", "hard", "expert")))
    print(f"wrote {a.out}")


if __name__ == "__main__":
    main()
