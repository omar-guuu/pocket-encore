#!/usr/bin/env python3
"""Describes a MIDI file for mksong.js and writes the drum onsets used by align.js.
    python midiinfo.py <song.mid> [--onsets <out.json>] [--drums <track index>]
Prints one line "MIDIINFO {json}": ticks per beat, tempo changes, whether it is already a Rock Band-format chart
(PART DRUMS / PART BASS / PART GUITAR / PART VOCALS / BEAT tracks, which mid2rbu reads directly), and for each
track its name, channels, note count and pitch range (to pick the tracks for autochart.py).
--onsets: kick/snare note-on ticks of the drum track (default: the track with the most channel-10 notes).
"""
import argparse
import json
import mido

RB_TRACKS = ["PART DRUMS", "PART BASS", "PART GUITAR", "PART VOCALS", "BEAT"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("midi")
    ap.add_argument("--onsets")
    ap.add_argument("--drums", type=int)
    a = ap.parse_args()
    mid = mido.MidiFile(a.midi)

    tempos, tracks = [], []
    for i, tr in enumerate(mid.tracks):
        tick, name, chans, notes, lo, hi, ticks = 0, "", set(), 0, 127, 0, []
        for m in tr:
            tick += m.time
            if m.type == "track_name":
                name = m.name
            elif m.type == "set_tempo":
                tempos.append({"tick": tick, "bpm": round(mido.tempo2bpm(m.tempo), 3)})
            elif m.type == "note_on" and m.velocity > 0:
                chans.add(m.channel)
                notes += 1
                lo, hi = min(lo, m.note), max(hi, m.note)
                ticks.append((tick, m.note))
        tracks.append({"index": i, "name": name, "channels": sorted(c + 1 for c in chans), "notes": notes,
                       "range": [lo, hi] if notes else None, "_ticks": ticks})

    names = {t["name"].strip().upper() for t in tracks}
    rb = all(n in names for n in RB_TRACKS)
    tempos.sort(key=lambda t: t["tick"])
    info = {"tpb": mid.ticks_per_beat, "rb_format": rb, "missing_rb_tracks": [n for n in RB_TRACKS if n not in names],
            "tempos": tempos[:20], "tempo_changes": len(tempos),
            "length_s": round(mid.length, 2),
            "tracks": [{k: v for k, v in t.items() if k != "_ticks"} for t in tracks]}

    drum = None
    if a.drums is not None:
        drum = tracks[a.drums]
    else:
        cand = [t for t in tracks if 10 in t["channels"]]
        if cand:
            drum = max(cand, key=lambda t: t["notes"])
    info["drum_track"] = drum["index"] if drum else None

    if a.onsets:
        if not drum:
            raise SystemExit("no drum track found (no channel-10 notes); pass --drums <track index>")
        bpm = tempos[0]["bpm"] if tempos else 120.0
        # Kick and snare only (GM 35/36, 37/38/40): hi-hats and cymbals repeat every beat and make whole-bar
        # shifts score almost the same (Push It: all notes -> 5.99 s, wrong by 2 bars; kick/snare -> 9.18 s).
        ks = sorted({t for t, n in drum["_ticks"] if n in (35, 36, 37, 38, 40)})
        ticks = ks if len(ks) >= 50 else sorted({t for t, _ in drum["_ticks"]})
        info["onsets"] = {"count": len(ticks), "kick_snare_only": ticks is ks}
        with open(a.onsets, "w") as f:
            json.dump({"tpb": mid.ticks_per_beat, "bpm": bpm, "ticks": ticks,
                       "kicks": sorted({t for t, n in drum["_ticks"] if n in (35, 36)}),
                       "snares": sorted({t for t, n in drum["_ticks"] if n in (37, 38, 40)})}, f)
    print("MIDIINFO " + json.dumps(info))


if __name__ == "__main__":
    main()
