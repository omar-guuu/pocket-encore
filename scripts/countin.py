"""Drumstick count-in: 4 clicks on the beats just before the music starts, at the song's tempo.

    python countin.py <chart.mid (Rock Band format, 480 tpb)> <in.wav> <out.wav> --start <s> [--clicks 4]

<in.wav>/<out.wav>: 16-bit mono 44.1 kHz (mksong's padded fill track; the backing track is never muted, so the
count-in is always heard). --start = when the music (or the first note, if earlier) starts, in seconds.
The beat grid is the chart's: the beat at the start (or the first one after it) is "1" of the song; the clicks
sit 1..4 beats before it at the tempo of the first notes (the autochart lead-in has its own tempo, so its beats
are not used). Clicks earlier than 0.15 s are left out.
Prints  COUNTIN {"clicks": [s, ...], "bpm": x}."""
import argparse, bisect, json, wave
import numpy as np
import mido

SR = 44100
PARTS = ("PART DRUMS", "PART BASS", "PART GUITAR", "PART VOCALS", "PART KEYS")


def tempo_map(m):
    pts, t = [], 0
    for msg in m.tracks[0]:
        t += msg.time
        if msg.type == "set_tempo":
            pts.append((t, msg.tempo))
    if not pts or pts[0][0] > 0:
        pts.insert(0, (0, 500000))
    secs, acc = [0.0], 0.0
    for i in range(1, len(pts)):
        acc += (pts[i][0] - pts[i - 1][0]) * pts[i - 1][1] / 1e6 / m.ticks_per_beat
        secs.append(acc)
    return pts, secs


def sec_of(tick, pts, secs, tpb):
    i = bisect.bisect_right([p[0] for p in pts], tick) - 1
    return secs[i] + (tick - pts[i][0]) * pts[i][1] / 1e6 / tpb


def click():
    n = int(0.03 * SR)
    t = np.arange(n) / SR
    rng = np.random.default_rng(7)
    noise = rng.standard_normal(n)
    noise = np.diff(noise, prepend=0)  # bright (high-passed) noise: the stick's crack
    body = np.sin(2 * np.pi * 2600 * t) + 0.5 * np.sin(2 * np.pi * 4100 * t)
    x = (0.6 * noise / np.abs(noise).max() + body) * np.exp(-t * 180)
    return 0.4 * x / np.abs(x).max()  # about -8 dBFS


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("chart"); ap.add_argument("inp"); ap.add_argument("out")
    ap.add_argument("--start", type=float, required=True)
    ap.add_argument("--clicks", type=int, default=4)
    a = ap.parse_args()

    m = mido.MidiFile(a.chart)
    tpb = m.ticks_per_beat
    pts, secs = tempo_map(m)
    first = None
    for tr in m.tracks:
        if tr.name not in PARTS:
            continue
        t = 0
        for msg in tr:
            t += msg.time
            if msg.type == "note_on" and msg.velocity > 0 and 60 <= msg.note <= 100:
                first = t if first is None else min(first, t)
                break
    if first is None:
        raise SystemExit("no notes in the chart")
    start = min(a.start, sec_of(first, pts, secs, tpb))
    # song tempo = tempo at the first note; the "1" = first chart beat at or after the start (within 50 ms)
    i = bisect.bisect_right([p[0] for p in pts], first) - 1
    beat = pts[i][1] / 1e6
    k = 0
    while sec_of(k * tpb, pts, secs, tpb) < start - 0.05:
        k += 1
    one = sec_of(k * tpb, pts, secs, tpb)
    times = [one - j * beat for j in range(a.clicks, 0, -1)]
    times = [round(t, 4) for t in times if t >= 0.15]

    with wave.open(a.inp, "rb") as w:
        if w.getsampwidth() != 2 or w.getnchannels() != 1 or w.getframerate() != SR:
            raise SystemExit(f"{a.inp}: need 16-bit mono 44.1 kHz")
        x = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float64) / 32768
    x = x.copy()
    c = click()
    for t in times:
        s = int(round(t * SR))
        e = min(len(x), s + len(c))
        x[s:e] += c[:e - s]
    y = np.clip(np.round(x * 32768), -32768, 32767).astype("<i2")
    with wave.open(a.out, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes(y.tobytes())
    print("COUNTIN " + json.dumps({"clicks": times, "bpm": round(60 / beat, 3), "one": round(one, 4)}))


if __name__ == "__main__":
    main()
