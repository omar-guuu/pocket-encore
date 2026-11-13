"""Solo markers in a Rock Band-format MIDI: prints SOLOS {"drums": n, "bass": n, "guitar": n, "vocals": n}
(note 103 longer than one beat, as mid2rbu reads them). mksong compares this with the built chart, because mid2rbu
silently drops a solo it cannot place (no gem at or after its end on some difficulty)."""
import json, sys, mido
PARTS = {"PART DRUMS": "drums", "PART BASS": "bass", "PART GUITAR": "guitar", "PART VOCALS": "vocals"}
m = mido.MidiFile(sys.argv[1])
out = {v: 0 for v in PARTS.values()}
for tr in m.tracks:
    if tr.name not in PARTS:
        continue
    t, on = 0, None
    for msg in tr:
        t += msg.time
        if msg.type == "note_on" and msg.velocity > 0 and msg.note == 103:
            on = t
        elif msg.type in ("note_off", "note_on") and msg.note == 103 and on is not None:
            if t - on > m.ticks_per_beat:
                out[PARTS[tr.name]] += 1
            on = None
print("SOLOS " + json.dumps(out))
