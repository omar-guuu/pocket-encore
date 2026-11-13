"""Transcribes stems into a plain MIDI for autochart.py when a song has no MIDI (charting from stems alone).

    python stemchart.py <out.mid> --drums drums.wav [--bass bass.wav] [--guitar guitar.wav] [--bpm 140] [--report]

Prints  STEMCHART {"offset": s, "bpm": x, ...}  = the audio time of MIDI tick 0 and the tempo, for autochart.

How:
- Tempo and beat phase: comb search (70-180 BPM) over the drum stem's onset strength (spectral flux); one fixed
  tempo for the whole song (the drift is printed: more than ~20 ms means the song needs a tempo map).
- Downbeat: the beat (of 4) where the kick is strongest. MIDI tick 0 = the first downbeat after 0.5 s.
- Every 16th note of the grid is checked:
  - drums: kick = onset in 30-120 Hz, snare = 150-400 Hz body + 1.5-5 kHz crack, cymbals = 6-16 kHz;
    a cymbal whose highs still ring 0.25 s later is a crash (49), otherwise a hi-hat (42). GM notes 36/38/42/49.
  - bass / guitar: onset in the stem's band, pitch from the harmonic spectrum (lowest strong fundamental),
    length = until the next onset or until the level drops to a quarter; guitar adds the fifth (power chord) when
    it is clearly there.
- Thresholds are relative to each stem's own level (AI-separated stems leak into each other, so a fixed threshold
  would turn bleed into notes).
Tracks: 1 drums, 2 guitar, 3 bass (autochart's defaults); vocals come from the vocal stem (vocalchart.js)."""
import argparse, json, math, sys, wave
import numpy as np
import mido

SR, HOP, NFFT = 44100, 441, 2048
FPS = SR / HOP
TPB = 480


def read_wav(path):
    with wave.open(path, "rb") as w:
        n, ch, sw, sr = w.getnframes(), w.getnchannels(), w.getsampwidth(), w.getframerate()
        raw = w.readframes(n)
    if sw != 2 or sr != SR:
        raise SystemExit(f"{path}: expected 16-bit 44.1 kHz (mksong's build/wav)")
    x = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768
    return x.reshape(-1, ch).mean(1) if ch > 1 else x


def stft(x, n=NFFT):
    frames = np.lib.stride_tricks.sliding_window_view(np.pad(x, (n // 2, n)), n)[::HOP]
    return np.abs(np.fft.rfft(frames * np.hanning(n), axis=1)), np.fft.rfftfreq(n, 1 / SR)


def flux(S, f, lo, hi, floor_db=60):
    """Onset strength: summed rise of the log spectrum in a band. Bins below floor_db under the band's loudest bin
    count as silence, so faint bleed (or the step from digital silence of a lead-in into bleed) is no attack."""
    B = S[:, (f >= lo) & (f < hi)]
    L = np.log(np.maximum(B, B.max() * 10 ** (-floor_db / 20) + 1e-12))
    return np.maximum(0, np.diff(L, axis=0, prepend=L[:1])).sum(1)


def energy(S, f, lo, hi):
    return (S[:, (f >= lo) & (f < hi)] ** 2).sum(1)


def peak(env, t, w=0.03):
    a, b = int((t - w) * FPS), int((t + w) * FPS) + 1
    a = max(0, a)
    return float(env[a:max(a + 1, b)].max()) if a < len(env) else 0.0


def comb(oc, bpm):
    period = 60 / bpm * FPS
    k = np.arange(0, len(oc) / period - 1) * period
    return max((oc[(ph + k).astype(int)].mean(), ph / FPS) for ph in np.arange(0, period, 0.5))


def tempo_phase(onset, bpm_fixed=None):
    """Best (bpm, phase). Half and double tempo score alike (every other beat is still a beat), so a tempo under
    100 BPM is doubled when the double scores at least 60 % as well: rock charts count the faster pulse."""
    oc = onset - onset.mean()
    if bpm_fixed:
        return bpm_fixed, comb(oc, bpm_fixed)[1]
    best = max((comb(oc, b) + (float(b),) for b in np.arange(70, 180, 0.02)), key=lambda r: r[0])
    sc, ph, bpm = best
    if bpm < 100:
        sc2, ph2 = comb(oc, 2 * bpm)
        if sc2 >= 0.6 * sc:
            return 2 * bpm, ph2
    return bpm, ph


def drift(onset, bpm, ph):
    """Largest local shift (s) of the beat grid against the onsets, over 8-beat windows that have drums."""
    beat, oc, out = 60 / bpm, onset - onset.mean(), []
    n = int((len(onset) / FPS - ph) / beat)
    for b in range(0, n - 8, 8):
        t0 = ph + b * beat
        vals = [(oc[((t0 + s + np.arange(8) * beat) * FPS).astype(int)].sum(), s) for s in np.arange(-0.06, 0.0601, 0.005)]
        v, s = max(vals)
        if v > 0:
            out.append(abs(s))
    return max(out) if out else 0.0


def f0_of(S, f, frame, lo, hi):
    """Lowest strong fundamental between lo and hi Hz: harmonic sum over the first 5 partials."""
    spec = S[frame]
    cand = np.arange(lo, hi, 0.5)
    df = f[1] - f[0]
    score = np.zeros(len(cand))
    for h in range(1, 6):
        idx = np.clip((cand * h / df).round().astype(int), 0, len(spec) - 1)
        score += spec[idx] / h
    best = score.max()
    if best <= 0:
        return None, 0.0
    ok = np.where(score >= 0.8 * best)[0]
    return float(cand[ok[0]]), float(best)


def midi_of(hz):
    return int(round(69 + 12 * math.log2(hz / 440)))


def yin(x, t, lo, hi, w=2048, thr=0.15):
    """f0 (Hz) of a single voice at time t (YIN), or None when nothing periodic is there."""
    a = int(t * SR)
    tmax = int(SR / lo) + 2
    seg = x[a:a + w + tmax]
    if len(seg) < w + tmax or not seg.any():
        return None
    n = 1 << (2 * (w + tmax) - 1).bit_length()
    F = np.fft.rfft(seg, n)
    r = np.fft.irfft(F * np.conj(np.fft.rfft(seg[:w], n)), n)[:tmax]
    c = np.concatenate(([0.0], np.cumsum(seg ** 2)))
    e0 = c[w]
    taus = np.arange(tmax)
    d = e0 + (c[taus + w] - c[taus]) - 2 * r
    d[0] = 0
    cm = np.ones(tmax)
    cs = np.cumsum(d[1:])
    cm[1:] = d[1:] * np.arange(1, tmax) / np.where(cs > 0, cs, 1)
    tmin = int(SR / hi)
    below = np.where(cm[tmin:] < thr)[0]
    if not len(below):
        return None
    tau = tmin + below[0]
    while tau + 1 < tmax and cm[tau + 1] < cm[tau]:
        tau += 1
    if 0 < tau < tmax - 1:
        den = cm[tau - 1] - 2 * cm[tau] + cm[tau + 1]
        tau = tau + 0.5 * (cm[tau - 1] - cm[tau + 1]) / den if den else tau
    return SR / tau


def fold(pitches, span=7):
    """Octave errors: a pitch more than `span` semitones from the median of the last 8 is moved by octaves toward it."""
    out = []
    for p in pitches:
        if out:
            med = float(np.median(out[-8:]))
            while p - med > span:
                p -= 12
            while med - p > span:
                p += 12
        out.append(p)
    return out


def power_chord(x, t, midi_note, thr=0.45):
    """A fifth above the note: its partials at 1.5, 4.5 and 7.5 x the root frequency, where a single note has none
    (its own partials are whole multiples), against the root's at 1, 2 and 4 x. Measured with a 0.37 s window
    (2.7 Hz resolution), which a low E needs. Miracle Man: 25 % of the guitar onsets over 0.5, in every section."""
    nf = 16384
    a = int((t + 0.03) * SR)
    seg = x[a:a + nf]
    if len(seg) < nf:
        return False
    sp = np.abs(np.fft.rfft(seg * np.hanning(nf)))
    f0 = 440 * 2 ** ((midi_note - 69) / 12)
    amp = lambda hz: sp[max(0, int(round(hz * nf / SR)) - 1):int(round(hz * nf / SR)) + 2].max()
    fifth = amp(1.5 * f0) + amp(4.5 * f0) + amp(7.5 * f0)
    root = amp(f0) + amp(2 * f0) + amp(4 * f0)
    return fifth >= thr * root


def pitched_notes(x, grid, lo_hz, hi_hz, band, rel=0.2, chords=False, mono=False):
    """Notes on the 16th grid: a new note where the stem attacks (onset strength over rel x its 95th percentile and a
    local peak) or where the pitch moves by a semitone or more while it keeps sounding (AI-separated bass has soft
    attacks, so the pitch change is often the only sign of a new note)."""
    S, f = stft(x, 4096)
    on = flux(S, f, *band)
    lev = energy(S, f, lo_hz, hi_hz * 4)
    active = lev > 3e-3 * lev.max()
    vals = np.array([peak(on, t) for t in grid])
    act = np.array([active[min(int(t * FPS), len(active) - 1)] for t in grid])
    thr = rel * (np.percentile(vals[act], 95) if act.any() else 1)
    pitch = []
    for t in grid:
        if mono:
            hz = yin(x, t + 0.03, lo_hz, hi_hz)
        else:
            hz, _ = f0_of(S, f, min(int((t + 0.04) * FPS), len(S) - 1), lo_hz, hi_hz)
        pitch.append(midi_of(hz) if hz else None)
    hits = []
    for i in range(len(grid)):
        if not act[i] or pitch[i] is None:
            continue
        attack = vals[i] >= thr and vals[i] >= 0.6 * max(vals[max(0, i - 1)], vals[min(len(vals) - 1, i + 1)])
        moved = i > 0 and act[i - 1] and pitch[i - 1] is not None and abs(pitch[i] - pitch[i - 1]) >= 1             and i + 1 < len(grid) and pitch[i + 1] == pitch[i]  # the new pitch holds for at least a 16th
        start = i == 0 or not act[i - 1]
        if attack or moved or start:
            hits.append(i)
    ps = fold([pitch[i] for i in hits])
    out = []
    for k, i in enumerate(hits):
        t = grid[i]
        fr = min(int((t + 0.04) * FPS), len(S) - 1)
        nxt = grid[hits[k + 1]] if k + 1 < len(hits) else grid[i] + 0.5
        e0, end = lev[fr], t
        while end < nxt and lev[min(int(end * FPS), len(lev) - 1)] > 0.25 * e0:
            end += 0.01
        p = ps[k]
        notes = [p]
        if chords and power_chord(x, t, pitch[i]):
            notes.append(p + 7)
        out.append((t, max(0.06, min(end, nxt) - t), notes))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--drums", required=True)
    ap.add_argument("--bass")
    ap.add_argument("--guitar")
    ap.add_argument("--bpm", type=float)
    ap.add_argument("--report", action="store_true")
    a = ap.parse_args()

    d = read_wav(a.drums)
    S, f = stft(d)
    allflux = flux(S, f, 30, 16000)
    bpm, ph = tempo_phase(allflux, a.bpm)
    beat = 60 / bpm
    dr = drift(allflux, bpm, ph)
    kick, snare, cym = flux(S, f, 30, 120), flux(S, f, 150, 400) + 0.5 * flux(S, f, 1500, 5000), flux(S, f, 6000, 16000)
    hi_e = energy(S, f, 6000, 16000)
    nb = int((len(d) / SR - ph) / beat)
    kb = [np.mean([peak(kick, ph + b * beat) for b in range(m, nb, 4)]) for m in range(4)]
    down = int(np.argmax(kb))
    t0 = ph + down * beat
    while t0 < 0.5:
        t0 += 4 * beat
    sixteenth = beat / 4
    grid = [t0 + k * sixteenth for k in range(int((len(d) / SR - t0) / sixteenth))]
    tick = lambda t: int(round((t - t0) / beat * TPB))

    # drums
    lev = energy(S, f, 30, 16000)
    active = lev > 1e-4 * lev.max()
    def hits(env, rel):
        v = np.array([peak(env, t, 0.025) for t in grid])
        act = np.array([active[min(int(t * FPS), len(active) - 1)] for t in grid])
        thr = rel * (np.percentile(v[act], 95) if act.any() else 1)
        return v >= thr, v
    K, kv = hits(kick, 0.40)
    Sn, sv = hits(snare, 0.45)
    C, cv = hits(cym, 0.40)
    kref = np.percentile(kv, 95)
    cref = np.percentile(cv, 95)
    drums, rings = [], []
    for i, t in enumerate(grid):
        if K[i]:
            drums.append((t, 36))
        # the kick's energy reaches the snare's low band: a snare counts only where the kick is quiet
        if Sn[i] and kv[i] < 0.4 * kref:
            drums.append((t, 38))
        if C[i]:
            fr = int(t * FPS)
            ring = hi_e[min(fr + int(0.25 * FPS), len(hi_e) - 1)] / (hi_e[min(fr + 2, len(hi_e) - 1)] + 1e-12)
            rings.append(ring)
            crash = ring > 0.6 and cv[i] >= 0.8 * cref and (K[i] or Sn[i])
            drums.append((t, 49 if crash else 42))

    parts = {}
    if a.guitar:
        parts["guitar"] = pitched_notes(read_wav(a.guitar), grid, 70, 700, (200, 4000), 0.3, chords=True)
    if a.bass:
        parts["bass"] = pitched_notes(read_wav(a.bass), grid, 35, 300, (40, 1000), 0.2, mono=True)

    m = mido.MidiFile(type=1, ticks_per_beat=TPB)
    m.tracks.append(mido.MidiTrack([mido.MetaMessage("track_name", name="stemchart", time=0),
                                    mido.MetaMessage("time_signature", numerator=4, denominator=4, time=0),
                                    mido.MetaMessage("set_tempo", tempo=mido.bpm2tempo(bpm), time=0),
                                    mido.MetaMessage("end_of_track", time=0)]))
    def track(name, ev, ch):
        msgs = []
        for t, dur, notes in ev:
            for n in notes:
                msgs.append((tick(t), 1, mido.Message("note_on", note=n, velocity=100, channel=ch)))
                msgs.append((tick(t) + max(30, int(dur / beat * TPB)), 0, mido.Message("note_off", note=n, velocity=0, channel=ch)))
        tr = mido.MidiTrack([mido.MetaMessage("track_name", name=name, time=0)])
        now = 0
        for tk, _, msg in sorted(msgs, key=lambda e: (e[0], e[1])):
            tr.append(msg.copy(time=tk - now)); now = tk
        tr.append(mido.MetaMessage("end_of_track", time=0))
        m.tracks.append(tr)
    track("drums", [(t, 0.06, [n]) for t, n in drums], 9)
    track("guitar", parts.get("guitar", []), 0)
    track("bass", parts.get("bass", []), 1)
    track("vocals", [], 2)
    m.save(a.out)

    info = {"offset": round(t0, 4), "bpm": round(bpm, 3), "drift_s": round(dr, 3), "downbeat": down,
            "crashes": sum(1 for _, n in drums if n == 49),
            "drums": len(drums), "guitar": len(parts.get("guitar", [])), "bass": len(parts.get("bass", []))}
    if a.report:
        sym = {36: "K", 38: "S", 42: "h", 49: "C"}
        by = {}
        for t, n in drums:
            by.setdefault(round((t - t0) / sixteenth), set()).add(sym[n])
        bars = int((grid[-1] - t0) / (16 * sixteenth))
        for b in range(0, bars, 4):
            row = "".join(("".join(sorted(by.get(b * 16 + k, set()))) or ".").ljust(2) if k % 4 else "|" + (("".join(sorted(by.get(b * 16 + k, set()))) or ".").ljust(2)) for k in range(16))
            print(f"  bar {b + 1:3} {t0 + b * 16 * sixteenth:6.1f}s {row}")
    if dr > 0.02:
        print(f"  WARNING: the beat drifts up to {dr * 1000:.0f} ms against one tempo; this song needs a tempo map")
    print("STEMCHART " + json.dumps(info))


if __name__ == "__main__":
    main()
