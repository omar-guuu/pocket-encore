"""Camera showcase ZCAMTEST (FINDINGS §27): Handlebars' audio and tempo, no notes except a marker at each shot.
Shot k (1-32) is sent at an existing song event near 7 s + 6.2 s * (k-1); at that moment a marker plays on every
part and difficulty: lane = group (leftmost = S01-S08, then S09-S16, S17-S24, rightmost = S25-S32), number of gems
in a row (8th notes) = position in the group (1-8). Writes marker.mid (Rock Band-format chart), cams.json (camera
calls for fxchart) and checklist.txt.  Run: python -I make.py <ZHANDLEBARS build dir> <events.json (seconds)>"""
import json, sys, os, bisect, mido

HERE = os.path.dirname(os.path.abspath(__file__))
build, events_path = sys.argv[1], sys.argv[2]
SHOTS = "dc0222d9 35c6b11e 7f5e7af2 d3f96270 c9b343db 135d556b 7350f761 32b38316 5e13796f 2f3b3ae9 61d4b320 " \
        "b0d73205 039dc827 db1c6c86 57e16186 26109a24 ebc64f8c 31a3dd4f 0a6fd0ce a0b60a1c 78354377 0267b088 " \
        "64cfbab0 22d2bb0f a52def2c 8e3ffdbf 068fbb83 0f3de073 74af4e82 c3985a69 63edcc32 57c9a404".split()
# what the official charts suggest (usage statistics, FINDINGS §27)
HINT = {"dc0222d9": "most used (every bar, 94 songs): generic cut?", "c9b343db": "song start",
        "26109a24": "often after the last note (ending)", "22d2bb0f": "often after the last note (ending)",
        "db1c6c86": "group with a52d/8e3f/0f3d before the intro; also in guitar solos",
        "8e3ffdbf": "group with db1c/a52d/0f3d before the intro", "a52def2c": "group with db1c/8e3f/0f3d before the intro",
        "0f3de073": "group with db1c/a52d/8e3f before the intro", "7350f761": "never alone; while vocals sing",
        "068fbb83": "never alone", "35c6b11e": "often near the song start", "57c9a404": "very rare (3 songs, at the end)"}

src = mido.MidiFile(os.path.join(build, "chart", "HANDLEBARS.mid"))
TPB = src.ticks_per_beat
tempo_tr = src.tracks[0]
# tempo map: seconds -> tick
pts, t, us = [], 0, 500000
for m in tempo_tr:
    t += m.time
    if m.type == "set_tempo":
        pts.append((t, m.tempo))
secs, acc = [], 0.0
for i, (tk, tp) in enumerate(pts):
    if i:
        acc += (tk - pts[i - 1][0]) * pts[i - 1][1] / 1e6 / TPB
    secs.append(acc)
def tick_of(s):
    i = max(0, bisect.bisect_right(secs, s) - 1)
    return pts[i][0] + (s - secs[i]) * 1e6 * TPB / pts[i][1]

ev = json.load(open(events_path))
eighth = TPB // 2
cams, lines, notes = [], [], []
for k, h in enumerate(SHOTS):
    want = 7 + 6.2 * k
    at = min((e for e in ev if e > 3), key=lambda e: abs(e - want))
    group, count = divmod(k, 8)
    start = -(-int(round(tick_of(at))) // eighth) * eighth  # first 8th-note on or after the shot
    for c in range(count + 1):
        notes.append((start + c * eighth, group))
    cams.append({"cmd": 22, "arg": h, "at": round(at, 3), "label": f"S{k + 1:02d} {h}"})
    mm, ss = divmod(at, 60)
    lines.append(f"{int(mm)}:{ss:04.1f}  S{k + 1:02d}  {h}  marker: lane {group + 1} x {count + 1}   "
                 f"{HINT.get(h, '')}\n      shows: ")

out = mido.MidiFile(type=1, ticks_per_beat=TPB)
out.tracks.append(tempo_tr)
DIFF = (60, 72, 84, 96)
for name, shift in (("PART DRUMS", 1), ("PART BASS", 0), ("PART GUITAR", 0), ("PART VOCALS", 0)):
    msgs = []
    for tk, lane in notes:
        for b in DIFF:
            msgs.append((tk, 1, mido.Message("note_on", note=b + shift + lane, velocity=100)))
            msgs.append((tk + 60, 0, mido.Message("note_off", note=b + shift + lane, velocity=0)))
    tr = mido.MidiTrack([mido.MetaMessage("track_name", name=name, time=0)])
    now = 0
    for tk, _, m in sorted(msgs, key=lambda x: (x[0], x[1])):
        tr.append(m.copy(time=tk - now)); now = tk
    tr.append(mido.MetaMessage("end_of_track", time=0))
    out.tracks.append(tr)
for tr in src.tracks:
    if tr.name == "BEAT":
        out.tracks.append(tr)
out.save(os.path.join(HERE, "marker.mid"))
json.dump(cams, open(os.path.join(HERE, "cams.json"), "w"), indent=1)
open(os.path.join(HERE, "checklist.txt"), "w").write(
    "ZCAMTEST camera showcase. Play on EXPERT (any part): at each shot change a marker plays.\n"
    "Lane (left to right) 1 = S01-S08, 2 = S09-S16, 3 = S17-S24, 4 = S25-S32; gems in a row = number in the group.\n"
    "Each shot stays until the next marker (~6 s). Note what the camera shows after 'shows:'.\n\n" + "\n".join(lines) + "\n")
print(f"{len(cams)} shots, {len(notes)} marker gems, last shot at {cams[-1]['at']} s")
