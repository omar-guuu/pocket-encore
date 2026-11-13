#!/usr/bin/env python3
"""Makes Hard, Medium and Easy from the Expert chart, the way the official charts do it.

    python reduce.py <chart.mid> <out.mid> [--parts drums,bass,guitar,vocals] [--report]

Reads a Rock Band-format MIDI (480 or any ticks/beat), keeps every part's Expert notes and replaces its Hard,
Medium and Easy notes with ones picked from Expert. Everything else (overdrive 116, solos 103, kicks, other
tracks) is kept. Pitched vocals (notes 36-84, no 4-lane notes) are left alone.
Also used as a library by autochart.py (reduce_part).

Rules measured on the 112 official charts (FINDINGS §28):
- Lower difficulties only use Expert's notes (95-99 % of their gems sit on an Expert gem's tick).
- How many are kept depends on the part and on how dense Expert is (DENSITY below), e.g. guitar at ~4 notes/s:
  Hard ~80 %, Medium ~49 %, Easy ~35 %.
- Which ones: strong beats first (downbeat > beat > 8th > 16th/triplet), sustains and notes after a pause
  nearly always; no two kept notes closer than the difficulty's gap (Hard >=140 ms, Medium >=220, Easy >=290;
  raised per song until the density matches).
- Lanes: Hard keeps Expert's (3-gem chords become 2); Hard/Medium keep the strongest chords up to 1.16x/0.73x Expert's chord share; Easy has single notes on the
  two middle lanes only (lane 0 folds to 1, lane 3 to 2) with the up/down direction of Expert kept.
"""
import argparse
import bisect
import mido

TPB = 480
DIFFS = ("easy", "medium", "hard", "expert")
BASE = {"easy": 60, "medium": 72, "hard": 84, "expert": 96}
# Official kept/expert ratios by Expert density (notes/s): (nps, hard, medium, easy); linear in between.
# (quartiles of the official songs per part)
DENSITY = {
    "drums": [(3.58, .87, .54, .47), (4.27, .83, .55, .39), (4.84, .80, .51, .39), (5.74, .74, .43, .33)],
    "bass": [(2.41, .89, .60, .46), (3.27, .86, .51, .38), (4.04, .82, .51, .35), (5.28, .75, .44, .32)],
    "guitar": [(2.88, .84, .49, .42), (3.61, .79, .49, .37), (4.22, .79, .47, .33), (5.20, .70, .44, .32)],
    "vocals": [(1.23, .90, .67, .57), (1.60, .93, .68, .51), (1.88, .89, .63, .50), (2.42, .89, .64, .51)],
}
# Chord share of Hard / Medium relative to Expert's (official, per song p50 1.16 / 0.73); never above CHORD_CEILING
# (official Hard guitar p90 55 %)
CHORD_RATIO = {"hard": 1.16, "medium": 0.73}
CHORD_CEILING = 0.55
MIN_GAP = {"instrument": {"hard": 140, "medium": 220, "easy": 290},
           "vocals": {"hard": 150, "medium": 220, "easy": 300}}
# second pass: if the gap above leaves too few notes (music on a grid jumps from all 8ths to only quarters), the
# best remaining notes are added down to this gap until the density matches
FILL_GAP = {"instrument": {"hard": 95, "medium": 150, "easy": 200},
            "vocals": {"hard": 110, "medium": 160, "easy": 220}}
# Expert vocals denser than this (gems/s) are thinned (official median 1.75, p90 2.4; FINDINGS §31)
EXPERT_MAX_NPS = {"vocals": 2.0}
EXPERT_GAP = 125  # mid2rbu's pruner drops the earlier of two gems <= 120 ms apart; autochart avoids that itself
# priority weights (compared against the official charts, FINDINGS §28)
W_BEAT, W_SUS_LONG, W_SUS_HALF, W_GAP, W_CHORD = 10, 30, 10, 0, 2


class Timing:
    """Tick -> ms and metric strength from tempo and time-signature changes (ticks at TPB per beat)."""

    def __init__(self, tempos, sigs):
        self.tempos = sorted(tempos) or [(0, 500000)]
        if self.tempos[0][0] != 0:
            self.tempos.insert(0, (0, 500000))
        self.sigs = sorted(sigs) or [(0, 4, 4)]
        if self.sigs[0][0] != 0:
            self.sigs.insert(0, (0, 4, 4))
        self._ms = [0.0]
        for (t0, us), (t1, _) in zip(self.tempos, self.tempos[1:]):
            self._ms.append(self._ms[-1] + (t1 - t0) * us / TPB / 1000)
        self._tt = [t for t, _ in self.tempos]
        # bar starts of each signature run (a signature change starts a new bar)
        self._st = [s[0] for s in self.sigs]

    def ms(self, t):
        k = bisect.bisect_right(self._tt, t) - 1
        return self._ms[k] + (t - self.tempos[k][0]) * self.tempos[k][1] / TPB / 1000

    def strength(self, t):
        k = bisect.bisect_right(self._st, t) - 1
        t0, num, den = self.sigs[k]
        beat = TPB * 4 // den
        bar = beat * num
        pos = (t - t0) % bar
        if pos == 0:
            return 5
        if pos % beat == 0:
            return 4 if num % 2 == 0 and pos * 2 == bar else 3
        if pos % (beat // 2) == 0:
            return 2
        if pos % beat == beat * 3 // 4:
            return 1.5  # the 16th just before a beat (a pickup) is kept twice as often as the one after it
        if pos % (beat // 4) == 0 or pos % (beat // 3) == 0:
            return 1
        return 0.5

    def bar_of(self, t):
        """(signature run, bar number) of a tick."""
        k = bisect.bisect_right(self._st, t) - 1
        t0, num, den = self.sigs[k]
        return k, (t - t0) // (TPB * 4 // den * num)

    def bar_pos(self, t):
        """Position in the bar in 16ths (None off the 16th grid)."""
        k = bisect.bisect_right(self._st, t) - 1
        t0, num, den = self.sigs[k]
        pos = (t - t0) % (TPB * 4 // den * num)
        return pos // (TPB // 4) if pos % (TPB // 4) == 0 else None


def _interp(table, x):
    if x <= table[0][0]:
        return table[0][1:]
    for a, b in zip(table, table[1:]):
        if x <= b[0]:
            f = (x - a[0]) / (b[0] - a[0])
            return tuple(p + (q - p) * f for p, q in zip(a[1:], b[1:]))
    return table[-1][1:]


# Equal scores: off-beats in the order the official charts keep them (4/4, in 16ths from the downbeat:
# and-of-2, and-of-4, and-of-3, and-of-1, then the pickups), so the same ones survive in every bar.
POS_ORDER = {6: 0, 14: 1, 10: 2, 2: 3, 7: 4, 3: 5, 11: 6, 15: 7, 13: 8, 9: 9, 5: 10, 1: 11}


def _select(ms, score, gap, start=(), limit=None, pref=None):
    """Greedy: highest score first, skipping notes closer than gap (ms) to one already kept; stops at limit notes."""
    kept = sorted(ms[i] for i in start)
    chosen = set(start)
    # then golden-ratio order, so notes added from a steady run are spread evenly over the song
    pref = pref or [0] * len(ms)
    for i in sorted(range(len(ms)), key=lambda i: (-score[i], pref[i], (i * 0.6180339887) % 1)):
        if limit is not None and len(chosen) >= limit:
            break
        if i in chosen:
            continue
        k = bisect.bisect_left(kept, ms[i])
        if k > 0 and ms[i] - kept[k - 1] < gap:
            continue
        if k < len(kept) and kept[k] - ms[i] < gap:
            continue
        kept.insert(k, ms[i])
        chosen.add(i)
    return sorted(chosen)


def _top(lanes):
    return max(lanes)


def reduce_part(events, timing, part="guitar", prune_expert=False):
    """events: Expert [(tick, dur, set(lanes))]; part: drums, bass, guitar or vocals. Returns {difficulty: events}."""
    kind = "vocals" if part == "vocals" else "instrument"
    sustains = part != "drums"
    events = sorted(events, key=lambda e: e[0])
    if not events:
        return {d: [] for d in DIFFS}
    ms = [timing.ms(t) for t, _, _ in events]
    score = []
    for i, (t, d, lanes) in enumerate(events):
        s = W_BEAT * timing.strength(t)
        if sustains:
            s += W_SUS_LONG if d >= TPB else W_SUS_HALF if d >= TPB // 2 else 0
        s += W_GAP * (min(ms[i] - ms[i - 1], 1000) / 100 if i else 10)
        s += W_CHORD if len(lanes) > 1 else 0
        score.append(s)

    pref = [POS_ORDER.get(timing.bar_pos(t), 20) for t, _, _ in events]
    if prune_expert:
        gap = EXPERT_GAP
        span = max((ms[-1] - ms[0]) / 1000, 1)
        for _ in range(80):
            idx = _select(ms, score, gap, pref=pref)
            if part not in EXPERT_MAX_NPS or len(idx) / span <= EXPERT_MAX_NPS[part]:
                break
            gap *= 1.04  # too dense for an official chart: thin Expert too (lowest-scoring gems go first)
        events = [events[i] for i in idx]
        ms = [ms[i] for i in idx]
        score = [score[i] for i in idx]
        pref = [pref[i] for i in idx]
    out = {"expert": events}
    n = len(events)
    span = (ms[-1] - ms[0]) / 1000 if n > 1 else 1
    nps = n / max(span, 1)
    targets = dict(zip(("hard", "medium", "easy"), _interp(DENSITY[part], nps)))

    for diff in ("hard", "medium", "easy"):
        # widen the gap until no more than the target is left, then top up with the best remaining notes
        gap = MIN_GAP[kind][diff]
        for _ in range(80):
            idx = _select(ms, score, gap, pref=pref)
            if len(idx) <= targets[diff] * n:
                break
            gap *= 1.04
        if len(idx) < targets[diff] * n:
            idx = _select(ms, score, FILL_GAP[kind][diff], start=idx, limit=round(targets[diff] * n), pref=pref)
        # Hard / Medium: the strongest chords (downbeats, long notes, then other beats) stay chords up to CHORD_RATIO x
        # Expert's chord share (at most CHORD_CEILING); the rest play their top lane.
        kept_chords = None
        if diff in CHORD_RATIO:
            expert_share = sum(1 for e in events if len(e[2]) > 1) / max(1, len(events))
            ranked = sorted((i for i in idx if len(events[i][2]) > 1),
                            key=lambda i: -(timing.strength(events[i][0]) + (3 if events[i][1] >= TPB else 0)))
            share = min(CHORD_CEILING, CHORD_RATIO[diff] * expert_share)
            kept_chords = set(ranked[:round(share * len(idx))])
        sel = []
        for i in idx:
            t, d, lanes = events[i]
            if len(lanes) > 2 and diff != "expert":
                # 3-gem chords are Expert only (official Hard/Medium/Easy have none): outer lanes of the chord
                lanes = {min(lanes), max(lanes)}
            if kept_chords is not None and len(lanes) > 1 and i not in kept_chords:
                lanes = {_top(lanes)}
            sel.append((t, d, set(lanes)))
        if diff == "easy":
            sel = _easy_lanes(sel)
        out[diff] = sel
    return out


def _easy_lanes(sel, longest=4):
    """Single notes on lanes 1 and 2: outer lanes fold inward; when folding flattens a move, use the other lane;
    more than `longest` gems in a row on one lane bounce to the other (official Easy max run: median 6)."""
    out, prev_ref, prev, run = [], None, None, 0
    for t, d, lanes in sel:
        ref = _top(lanes)
        lane = {0: 1, 1: 1, 2: 2, 3: 2}[ref]
        if prev is not None and lane == prev and ref != prev_ref:
            lane = 3 - prev  # Expert moved but the fold did not: move to the other lane
        run = run + 1 if lane == prev else 1
        if run > longest:
            lane, run = 3 - prev, 1
        out.append((t, d, {lane}))
        prev_ref, prev = ref, lane
    return out


# ---------------- MIDI file front end ----------------
PARTS = {"drums": "PART DRUMS", "bass": "PART BASS", "guitar": "PART GUITAR", "vocals": "PART VOCALS"}


def _abs(track):
    t, out = 0, []
    for m in track:
        t += m.time
        out.append((t, m))
    return out


def _notes(abs_msgs, lo, hi):
    on, out = {}, []
    for t, m in abs_msgs:
        if m.type == "note_on" and m.velocity > 0 and lo <= m.note <= hi:
            on[m.note] = t
        elif m.type in ("note_off", "note_on") and m.note in on:
            s = on.pop(m.note)
            out.append((s, t - s, m.note))
    return sorted(out)


def timing_of(mid):
    tempos, sigs = [], []
    for t, m in _abs(mid.tracks[0]):
        if m.type == "set_tempo":
            tempos.append((t, m.tempo))
        elif m.type == "time_signature":
            sigs.append((t, m.numerator, m.denominator))
    return Timing(tempos, sigs)


def reduce_file(src, dst, parts, report=True):
    mid = mido.MidiFile(src)
    if mid.ticks_per_beat != TPB:
        raise SystemExit(f"{src}: {mid.ticks_per_beat} ticks/beat; run chartimport.py first (it rescales to {TPB})")
    timing = timing_of(mid)
    for ti, tr in enumerate(mid.tracks):
        name = next((m.name for m in tr if m.type == "track_name"), "")
        part = next((p for p, n in PARTS.items() if n == name), None)
        if part not in parts:
            continue
        shift = 1 if part == "drums" else 0
        A = _abs(tr)
        exp = _notes(A, 96 + shift, 99 + shift)
        if not exp:
            if report:
                print(f"  {name}: no Expert notes, left as it is")
            continue
        by = {}
        for s, d, n in exp:
            e = by.setdefault(s, [d, set()])
            e[0] = max(e[0], d)
            e[1].add(n - 96 - shift)
        events = [(t, by[t][0], by[t][1]) for t in sorted(by)]
        res = reduce_part(events, timing, part)
        lower = set()
        for diff in ("easy", "medium", "hard"):
            lower.update(range(BASE[diff] + shift, BASE[diff] + shift + 4))
        msgs = [(t, m) for t, m in A if not (m.type in ("note_on", "note_off") and m.note in lower)
                and m.type != "end_of_track"]
        for diff in ("easy", "medium", "hard"):
            ev = res[diff]
            for i, (t, d, lanes) in enumerate(ev):
                nxt = ev[i + 1][0] if i + 1 < len(ev) else t + d
                dur = max(30, min(d, nxt - t - 10))
                for lane in sorted(lanes):
                    note = BASE[diff] + shift + lane
                    msgs.append((t, mido.Message("note_on", note=note, velocity=100)))
                    msgs.append((t + dur, mido.Message("note_off", note=note, velocity=0)))
        msgs.sort(key=lambda x: (x[0], 0 if x[1].type == "note_off" or (x[1].type == "note_on" and x[1].velocity == 0) else 1))
        new, now = mido.MidiTrack(), 0
        for t, m in msgs:
            new.append(m.copy(time=t - now))
            now = t
        new.append(mido.MetaMessage("end_of_track", time=0))
        mid.tracks[ti] = new
        if report:
            print(f"  {name:12} " + "  ".join(f"{d}:{len(res[d])}" for d in DIFFS))
    mid.save(dst)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("dst")
    ap.add_argument("--parts", default="drums,bass,guitar,vocals")
    a = ap.parse_args()
    reduce_file(a.src, a.dst, set(a.parts.split(",")))
    print(f"wrote {a.dst}")


if __name__ == "__main__":
    main()
