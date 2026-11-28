"""Attacks (where a note starts) in the tracks the chart editor plays, for its "snap to attacks".

    python attacks.py <out.json> <part>=<wav> [<part>=<wav> ...]      parts: drums, bass, guitar, vocals

Writes {"version": 1, "parts": {"guitar": [[seconds, strength], ...], ...}}. An attack is a local peak (+-50 ms) of
the onset strength in the part's band (stemchart.flux: the rise of the log spectrum, so a pick or strum shows even
inside a loud, sustained distorted guitar whose waveform is a flat block), above rel x the track's 95th percentile;
strength = the peak / that percentile. Thresholds are relative to each track's own level, like stemchart.py, because
AI-split tracks leak into each other.
Checked on Handlebars and Miracle Man (2026-11-27): about 94 % of the charts' guitar and bass gems have an attack
within 50 ms (chance alone: about 50 %)."""
import json, sys
import numpy as np
import stemchart as sc

# part: (band in Hz, rel)
BANDS = {"drums": ((30, 16000), 0.3), "bass": ((40, 1000), 0.2), "guitar": ((200, 4000), 0.3), "vocals": ((100, 4000), 0.3)}


def attacks(path, band, rel):
    x = sc.read_wav(path)
    S, f = sc.stft(x)
    fl = sc.flux(S, f, *band)
    p95 = float(np.percentile(fl, 95)) or 1.0
    out = []
    for i in range(1, len(fl) - 1):
        v = fl[i]
        if v >= rel * p95 and v == fl[max(0, i - 5):i + 6].max():
            # the peak between frames (parabola through the 3 frames around it)
            a, b, c = fl[i - 1], v, fl[i + 1]
            d = a - 2 * b + c
            off = 0.5 * (a - c) / d if d < 0 else 0.0
            out.append([round((i + max(-.5, min(.5, off))) / sc.FPS, 4), round(v / p95, 2)])
    return out


def main():
    out, parts = sys.argv[1], {}
    for arg in sys.argv[2:]:
        part, path = arg.split("=", 1)
        if part not in BANDS: raise SystemExit(f"unknown part {part}")
        try:
            parts[part] = attacks(path, *BANDS[part])
            print(f"{part}: {len(parts[part])} attacks", flush=True)
        except (SystemExit, Exception) as e:  # one bad track should not lose the others
            print(f"{part}: skipped ({e})", flush=True)
    with open(out, "w") as fh:
        json.dump({"version": 1, "parts": parts}, fh, separators=(",", ":"))


if __name__ == "__main__":
    main()
