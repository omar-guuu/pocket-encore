#!/usr/bin/env python3
"""Prepares a chart MIDI edited in REAPER (or made by reaperpack.js) for mid2rbu.

    python chartimport.py <edited.mid> <out.mid>

- Rescales to 480 ticks per beat (REAPER often saves 960; mid2rbu and the game count 480 per beat).
- Vocals: if PART KEYS has notes, it becomes PART VOCALS (reaperpack.js puts the 4-lane vocals there so the RBN
  preview draws them as gems); an empty or pitched PART VOCALS is dropped in that case.
- Keeps the tempo track (first track), BEAT and the four parts; other tracks (EVENTS, VENUE, HARM1...) are dropped.
- Checks: the tracks mid2rbu needs exist, at most 4 solos (note 103) per part, solo markers longer than one beat.
"""
import argparse
import mido

PARTS = ["PART DRUMS", "PART BASS", "PART GUITAR", "PART VOCALS"]


def note_count(track):
    return sum(1 for m in track if m.type == "note_on" and m.velocity > 0)


def rescale(track, k):
    out = mido.MidiTrack()
    acc, prev = 0, 0
    for m in track:
        acc += m.time
        t = int(round(acc * k))
        out.append(m.copy(time=t - prev))
        prev = t
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("out")
    a = ap.parse_args()
    src = mido.MidiFile(a.src)
    k = 480 / src.ticks_per_beat
    named = {}
    for tr in src.tracks[1:]:
        named.setdefault(tr.name.strip().upper(), tr)

    keys = named.get("PART KEYS")
    if keys is not None and note_count(keys) > 0:
        named["PART VOCALS"] = keys
        vocal_src = "PART KEYS"
    else:
        vocal_src = "PART VOCALS"

    missing = [n for n in PARTS + ["BEAT"] if n not in named]
    if missing:
        raise SystemExit(f"missing track(s): {', '.join(missing)}")

    out = mido.MidiFile(type=1, ticks_per_beat=480)
    out.tracks.append(rescale(src.tracks[0], k))
    for name in ["BEAT"] + PARTS:
        tr = rescale(named[name], k)
        # make the track name exactly what mid2rbu looks for
        tr = mido.MidiTrack([m for m in tr if not (m.is_meta and m.type == "track_name")])
        tr.insert(0, mido.MetaMessage("track_name", name=name, time=0))
        out.tracks.append(tr)
        if name in PARTS:
            tick, on, solos = 0, None, []
            for m in tr:
                tick += m.time
                if m.type not in ("note_on", "note_off") or m.note != 103:
                    continue
                if m.type == "note_on" and m.velocity > 0:
                    on = tick
                elif on is not None:
                    solos.append((on, tick))
                    on = None
            if len(solos) > 4:
                raise SystemExit(f"{name}: {len(solos)} solos, the game shows at most 4 per part")
            short = [s for s in solos if s[1] - s[0] <= 480]
            if short:
                raise SystemExit(f"{name}: solo marker(s) at tick {short[0][0]} not longer than one beat (mid2rbu ignores them)")
    out.save(a.out)
    counts = ", ".join(f"{n.replace('PART ', '').lower()} {note_count(out.tracks[2 + i])}" for i, n in enumerate(PARTS))
    print(f"{a.out}: {src.ticks_per_beat} -> 480 ticks per beat, vocals from {vocal_src}; notes: {counts}")


if __name__ == "__main__":
    main()
