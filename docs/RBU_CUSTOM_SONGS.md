# Rock Band Unplugged (PSP, ULUS10418) — Custom songs: reference

Summary of everything found so far (as of 2026-11-10). The detailed research log, with evidence and dead ends, is
`docs\FINDINGS.md`, next to this file. The repository is `rbu-tools` (scripts, studio, installer, docs and the songs'
`song.json` files; no game files, stems or build output).

**Status:** custom songs work **natively**, with no plugin and no cheats. The test song, "Push It" (Static-X,
folder `MUSIC\ZPUSHIT`), was confirmed in game. Its own chart, intro, overdrive, clean audio, correct song end and
on-time results screen all work, and the ATM hash check passes.
Tested on **PPSSPP only**. A real PSP may behave differently (see §9, "Real PSP").

> Personal use only: the generated song database (JB + TEXT) contains the official song list, and charts are built
> on top of an official DLC chart (the donor). Don't share these files or the game dumps.

---

## 1. How the game loads DLC songs

```
dlc_refresh (0x08a2e4a4)
 ├─ dlc_scan_music_dir (0x089f1b30)   scans ms0:PSP/GAME/ULUS10418/MUSIC/*
 │     - folder has a file starting "BEATMATCH.STR" -> CRC-32(UPPERCASE folder name) added to the folder list (max 300)
 │     - file "JB??????.STR.EDAT" (name > 11 chars, "JB" at 0, ".str" at 8, ends ".EDAT"), size exactly 0x1D580,
 │       and TEXT/STR_<lang>_jukebox.TXT.EDAT next to it -> database candidate; HIGHEST JB NUMBER WINS
 │     - every other file name is ignored
 ├─ jukebox_load (0x08a2db94) / jukebox_read (0x08a2b6a4)
 │     - the chosen JB file is copied byte-for-byte into the song table g_jukebox (pointer at 0x08c0b65c)
 │     - the name fields of each record (pool offsets) are turned into pointers
 └─ dlc_verify_song_files (0x089f191c), once per record with the DLC flag 0x80
       - record id must be in the folder list (id = CRC-32 of the uppercase folder name)
       - MUSIC/<name>/<name>.ATM must exist and its size must equal record +0xF8
       - MUSIC/<name>/BEATMATCH.str.EDAT must open and start with 01 00 00 00 80 48 00 00 80 00 00 00 00 00 00 00
       - all OK -> flags |= 0x40 (playable); otherwise the song is left out of the list (hidden)
At song start:
   - the BEATMATCH section for the chosen difficulty is loaded as a memory image at 0x096e9a80 (the chart root)
   - ATM hash check (0x08ab26a8 / compare at 0x08ab2aa8): CRC-32 of the first 0x400 bytes of the .ATM must equal
     chart root +0x324, otherwise "Memory Stick removed"
```

If DLC is disabled or the scan fails, the game falls back to the on-disc list `streams/jukebox.str`.

The DLC files on the memory stick are **not encrypted**, despite the `.EDAT` extension, so all of them can be
generated directly.

---

## 2. Files in a custom song folder (`MUSIC\ZPUSHIT\`)

| File | Required | What it is | Checked by the game | Made by |
|---|---|---|---|---|
| `ZPUSHIT.ATM` | yes | Audio: 5 encrypted ATRAC3 tracks (drums, bass, guitar, vocals, fill) | size == JB record +0xF8 (song list); CRC-32 of first 0x400 bytes == chart root +0x324 (song start) | prepwav → padwav → at3tool → atmtool |
| `BEATMATCH.STR.EDAT` | yes | Chart: 4 memory images (Easy/Medium/Hard/Expert) | its presence registers the folder; header bytes (song list); loaded at song start | beatmatch.js build |
| `JB<day>.STR.EDAT` (in `ZZCUSTOMDB\`) | yes (once, see below) | Song database: all 112 official songs + the customs | size 0x1D580; highest JB number wins | mkjukebox.js (via mksong) |
| `TEXT\STR_{EN,FR,GE,IT,SP}_jukebox.txt.EDAT` and `…jukebox2…` | yes (with the JB) | Song list text (title, artist, album…) | must sit next to the JB file | mkjukebox.js |
| `ZPUSHIT_PREVIEW.AT3` | no | 30 s stereo preview for the song list | none; without it there is just no preview | mkpreview.js → at3tool |

Official DLC folders also contain:
- **`2009-MM-DD-HH-MM`** (0 bytes): a packaging timestamp, the day and time the pack was built. It is the same day as
  the folder's JB number (see below). The scanner ignores it and no file-name pattern in the EBOOT can match it, so
  the game never reads it; it was probably for Harmonix's own tools or staff.
- **`JS<same number>.STR.EDAT`** (every pack from JB000465 on; always 310,560 bytes, as the JB is always 120,192):
  the **same song database in a smaller record layout**. Same header (count at +0x30 = 112), same 112 song ids in
  the same order, but 0xD8-byte records instead of 0x114, followed by ~390 name strings. A JS record is a JB record
  with some words left out: id, names, text ids, the block up to +0x54, year, vocalist and tiers are identical
  (tiers onward sit 0x0C earlier); the flags word differs, and the JB's .ATM size area is missing (JS +0xD0/+0xD4
  are per-song values not identified yet). ULUS10418 never reads it: the scanner only accepts names starting with
  "JB", and no file-name pattern in the EBOOT starts with "JS".
  (H) The database for another version or build of the game, which would look for JS files with this layout, so
  that one set of DLC folders served both. Not confirmed (needs another version's EBOOT). Customs don't need it.

### The song database (JB) is shared
- The game uses **one** database, from whichever folder has the highest JB number. The newest official one is
  JB000571; the custom one has a higher number, so it wins and supplies the **whole** song list.
- **All customs go into the same JB.** mksong regenerates it with every `songs\*\song.json` at once. A custom
  that isn't in the winning JB doesn't appear.
- It lives in its own folder, `MUSIC\ZZCUSTOMDB\` (JB + TEXT, no chart), confirmed in game 2026-11-07. On the memory
  stick, replace the whole folder each time. If it is removed, the game falls back to JB000571 and the customs
  disappear.
- The base for `mkjukebox` must be an official folder holding JB000571 (e.g. YOURENOROCKNROLLFUN).

### Different songs on different devices (PSP, emulator): one master database
(Confirmed on PPSSPP; whether a real PSP accepts these files at all is still open, see §9.)
- Build **one** `ZZCUSTOMDB` that lists your whole custom library (mksong does this: every `songs\*\song.json`).
- Copy the **same** `ZZCUSTOMDB` to every device, and copy only the song folders you want on each one.
- A song that is in the database but whose folder isn't on that device is **hidden** from the list, with no error
  (tested 2026-11-07: Push It disappeared with `MUSIC\ZPUSHIT` removed and came back with it).
- Regenerate `ZZCUSTOMDB` only when a song is added to (or removed from) the library, then copy it to all devices.
- Limit: the database holds up to 188 customs in total, whatever each device has.
- Not recommended: a cumulative database in each song folder (the official packs' way). The folder with the
  highest number wins, so on a device without your newest song an older database would win and the songs added
  after it would vanish; and two databases built on the same day get the same number, so the result would depend
  on scan order.

### How the official packs keep the list complete
Every DLC pack ships a **cumulative** database: all songs released so far, plus sometimes songs not out yet. The
scanner keeps only the highest JB number, and the newest database is a superset of the older ones, so no song is
left out. A song that is listed but whose files are missing is simply not shown (per-song check; confirmed for a
custom with its folder removed, 2026-11-07).

**The JB number is a date:** the number of days since **2008-03-07**. In every official folder it lands exactly on
the day of the folder's timestamp file:

| Pack (timestamp file) | Database | Songs listed |
|---|---|---|
| 2009-05-08 (first DLC, 10 songs) | JB000427 | 65 = 55 on-disc + 10 |
| 2009-06-15 | JB000465 | 75 |
| 2009-06-16 | JB000466 | 76 |
| 2009-07-27 | JB000507 | 88 |
| 2009-09-14 | JB000556 | 112 (already lists the 4 songs of the 2009-09-29 pack) |
| 2009-09-29 (last) | JB000571 | 112 |

So "highest number wins" means "newest database wins". The timestamp file adds nothing the number doesn't
already say, and the game doesn't read it.

**Customs use the same scheme:** mksong names the database `JB<days since 2008-03-07>`, e.g. **JB006819 on
2026-11-07**. This works because:
- the scanner takes the 6 characters after "JB" (the name must be `JB` + exactly 6 digits + `.STR.EDAT`),
  converts them to a number and keeps the highest; 6819 is far above 571, and 6 digits last until day 999999
  (about the year 4745);
- each rebuild on a later day gets a higher number, so a newer custom database always beats an older one, even if
  an old file is left behind by mistake;
- the number is only in the file name: JB006819 is byte-identical to the JB000901 tested in game.

`--jb <n>` overrides it (572..999999). Older custom builds used JB000900 (in `MUSIC\ZPUSHIT`, now removed) and
JB000901.

---

## 3. Making a new song (pipeline)

### Tools: what each one is for
No plugin (UnpluggedDeluxe), no cheats and no PSP SDK are needed: the game loads the files natively (§8).

| Tool | Where | Used for |
|---|---|---|
| Node.js | installed | runs the `.js` scripts |
| Python 3.12 + `mido`, `numpy`, `miniaudio` | `%LOCALAPPDATA%\Programs\Python\Python312` | runs the `.py` scripts and mid2rbu; numpy = stem analysis, miniaudio = MP3/FLAC/OGG decoding (installed 2026-11-10) |
| `at3tool.exe` (Sony ATRAC3 encoder, from the PSP SDK; not ours, not in the repo: the user supplies it) | path in `settings.json` (default `rbu-tools\at3tool`) | WAV → AT3 (song tracks 66 kbps, preview 352 kbps) |
| `mid2rbu` (github.com/maodus/mid2rbu, cloned, unmodified; not in the repo) | path in `settings.json` (default `rbu-tools\mid2rbu`) | Rock Band MIDI → `.rbu` (gems, overdrive, solos, bars) |
| Official DLC folders on the memory stick | `MUSIC\SHESNOTTHERE`, `MUSIC\YOURENOROCKNROLLFUN` (the MUSIC folder is `music` in `settings.json`) | donor chart (the container our chart is written into) and the official song list (base for the database) |
| 7-Zip + the game ISO | `ULUS10418.iso` | only for on-disc donors (e.g. TODAY for screen effects) and REAPER references |
| REAPER + RBN Preview | optional | seeing and editing gems by hand |
| PPSSPP | `C:\PSP\ppsspp_win` | playing and testing |

Our scripts (`rbu-tools\scripts`), in pipeline order:

| Step | Script | Does |
|---|---|---|
| all | `mksong.js` | runs everything below from one `song.json` |
| audio | `prepwav.js`, `padwav.js` (+ loudness stage in mksong) | stems → 44.1 kHz mono 16-bit, −14 LUFS mix, same length + silent tail |
| audio | `decode.py` | MP3/FLAC/OGG stems → float WAV (before prepwav) |
| audio | `atmtool.js` | 5 AT3 tracks → the game's `.ATM` |
| preview | `mkpreview.js` | loudest 30 s → `_PREVIEW.AT3` |
| chart | `midiinfo.py` | lists a MIDI's tracks; tells Rock Band-format from plain |
| chart | `align.js` | plain MIDI: finds the start offset and tempo against the drum stem |
| chart | `stemchart.py` | no MIDI: transcribes the stems (tempo, downbeat, drums kick/snare/hi-hat/crash, bass and guitar notes) into a plain MIDI for autochart |
| chart | `autochart.py` | plain MIDI → Rock Band chart (lanes, chords, sustains, overdrive, solos, intro) |
| chart | `vocalchart.js` | vocal notes from the vocal stem (rap/spoken parts) |
| chart | `reduce.py` | Hard/Medium/Easy from Expert, like the official charts |
| chart | `chartimport.py` | REAPER/RB MIDI → 480 ticks per beat, PART KEYS → vocals |
| chart | `beatmatch.js` | `.rbu` + donor → `BEATMATCH.STR.EDAT` (song end, music stop, ATM hash, solos); `verify` |
| chart | `countin.py` | optional drumstick count-in before the music (re-encodes the backing track) |
| chart | `fxchart.js` | screen effects / raw script calls at chosen times |
| chart | `solocheck.py` | solos in the MIDI; mksong stops if any is missing from the built chart |
| database | `mkjukebox.js` | official list + all customs → `ZZCUSTOMDB\JB<day>.STR.EDAT` + TEXT |
| editing | `reaperpack.js` | chart + WAVs for REAPER (customs and official references) |
| checks | `loudness.js`, `chartmap.js`, `stresspack.js` | loudness of decoded tracks, chart memory map, 300-song stress test |
| config | `settings.js` | reads `rbu-tools\settings.json` (MUSIC folder, python, at3tool, mid2rbu) with defaults; `check()` = the studio's Setup page |

### RBU Studio: the all-in-one page (since 2026-11-11)
Double-click `rbu-tools\studio.cmd` (or `node rbu-tools\studio\server.js --open`), or install it with the installer
(`installer\RBUStudio.iss`, built with Inno Setup; it installs only our files to `%LOCALAPPDATA%\RBUStudio` and makes
shortcuts). It opens in its own window (Edge or Chrome in app mode; otherwise the default browser) at
http://localhost:8642. The server only listens on this PC (127.0.0.1); close the console window or press Ctrl+C to stop it.
`song.json` stays the single source of truth: the page reads and writes it and runs `mksong.js` for builds.
- **Setup** (top right): checks Node, Python and its packages, mid2rbu, at3tool and the game's MUSIC folder, with a
  download link or command for each missing piece, and lets you set the paths (`rbu-tools\settings.json`). Builds are
  refused until everything is found.
- **Library**: every `songs\Z*\song.json`, with build state (built / changed since build / not built, from a hash of
  the inputs stored in `build\inputs.json`), chart source (MIDI, stems or edited), stem source and quality, and Expert
  gold. **Open output folder** opens `out\MUSIC` (you copy to the memory stick yourself).
- **New song**: folder, details, stems and an optional MIDI, picked with a file browser. Creates `song.json` and builds it.
- **Details**: title, artist, album, year, genre, lead vocals, tiers, stems (path, source format, level, peak, share of
  the song with sound, clipping, DC offset, low MP3 bitrate; and possible bleed between stems, from how their levels
  rise and fall together), stem source (type, tool, quality, notes), count-in, lead-in, stars scale with **Calibrate
  from a play…** (enter how many phrases were left when gold appeared; it computes the new scale), preview, loudness.
  **Chart checks** lists what differs from the official charts (first gem before 2.77 s, gems after the audio ends,
  3-gem chords, held drum gems, too many chords or holds, density above the official 90th percentile, overdrive phrases
  too close, solos too short or too many; "go" opens the editor at that time). Also gem counts and star scores per
  difficulty from the last build. **song.json** tab = the raw file; unknown effect names are refused on save.
  Every save keeps the old file as `song.json.bak`; saving without changes leaves the file (and build state) alone.
- **Build** (whole song) and **Rebuild chart** (chart and database only, reusing the audio). The output streams into the
  build log at the bottom and is written to `songs\<FOLDER>\build\build.log` (**Last log** shows it later).
- **Chart & effects**: the four parts' gems on a time line, over each part's own stem waveform, with playback of the
  five tracks as the game plays them (mute, solo, volume, 50/75/100% speed). The **part** selector picks the focus part:
  the **highway** on the right shows it the way the game does (gems falling to the strike line, overdrive and solo
  spans), **ticks** play a click on its gems to check sync, and keys **1–4** add a gem in that lane at the playhead,
  also while playing (**Record** / R starts playback in record mode; clicking a highway lane does the same).
  Edit gems: add, move, change length (hold), delete, copy/paste, overdrive phrase (O) and solo (L) on/off for the
  selection, undo/redo (also for effects and tempo changes); snap to the beat grid. Effects lane: add, move, resize,
  change or delete screen effects (song.json `effects`).
  - **Tempo…**: set a constant BPM from a first beat (for songs with a steady beat whose grid is off) or shift every gem
    by some ms against the audio. Both keep every gem, phrase and solo at its time in seconds; only the grid moves.
  - The editor starts from the last build's chart (`reaper\<FOLDER>\<FOLDER>_auto.mid`). Saving writes
    `songs\<FOLDER>\chart.mid` (the old one becomes `chart.mid.bak`) and sets `"chart": "chart.mid"`, so the
    automatic chart is no longer made; the badge says **rebuild needed** until the next build. "Easy, Medium and Hard
    are made from Expert" (on by default) sets `"reduce": true`. **Back to automatic chart** on the Details tab removes
    `"chart"` again. After a save the checks run again, and the footer compares the edited chart with the automatic one
    (gems added/removed per part; removed ones can be shown as outlines).
  - An edited chart is in game time. Changing the lead-in, count-in or stems afterwards moves the audio, not the gems.
  - Not editable yet: vocal pitch, cameras, time signatures other than 4/4 in the tempo tool.

### One command: `mksong.js` (since 2026-11-07)
1. Make a folder `rea-work\rbu-tools\songs\Z<NAME>\` with a `song.json` (paths are relative to it):
   ```json
   {
     "folder": "ZMYSONG", "title": "My Song", "artist": "Band", "album": "Album", "year": 2001, "genre": "ROCK",
     "tiers": { "drums": 2, "guitar": 2, "bass": 2, "vocals": 2, "band": 2 }, "vocals": 1,
     "stems": { "drums": "drums.wav", "bass": "bass.wav", "guitar": "guitar.wav", "vocals": "vocals.wav", "fill": "backing.wav" },
     "midi": "song.mid"
   }
   ```
   - Stems: any WAV (16/24/32-bit or float, any sample rate, mono or stereo). A missing part is silent;
     `fill` = everything else (backing track). Optional: `"loudness"` (default −14 LUFS), `"gain"` (manual dB, turns the loudness stage off), `"tail"` (default 6 s),
     `"preview": { "start": 60 }` or `false`, `"donor"` (default SHESNOTTHERE), `"dropSolos": true`.
   - `"starsScale": 1.2`: star cutoffs x this (the build estimates the maximum score from the notes, overdrive
     phrases and song length, fitted on the official charts; FINDINGS §33). To tune a
     song: play it cleanly and note when gold appears. Gold should come with only a few phrases left (about 10 %).
     If it came after a fraction f of the phrases, new starsScale = old x 0.9 / f (Miracle Man: gold after 19 of 36
     phrases -> about 1.6 M, i.e. starsScale 1.2 on the current model). Above 1 = harder.
   - `"countIn": true`: four drumstick clicks on the beats before the music starts, at the song's tempo, mixed into
     the backing track (never muted); the lead-in becomes at least 4.5 s so they fit (`countin.py`).
   - `"stemSource": { "type": "ai", "tool": "fadr", "quality": "medium", "notes": "..." }`: where the stems come
     from (`official`, `multitrack`, `ai`, `unknown`) and how good they are (`low`, `medium`, `high`). AI-separated
     stems can bleed between parts or sound washed out; the flag is printed by every build and is meant for the
     future editor. It doesn't change the build.
   - Genres: ALTERNATIVE, BLUES, CLASSIC ROCK, COUNTRY, EMO, FUSION, GLAM, GRUNGE, INDIE ROCK, JAZZ, METAL, NOVELTY,
     NU-METAL, POP-ROCK, PROG, PUNK, ROCK, SOUTHERN ROCK, URBAN. Tiers 0–6 = stars. `vocals`: 1 male, 2 female.
2. Run `node scripts\mksong.js songs\Z<NAME>\song.json` (in `rbu-tools`).
3. Copy `rbu-tools\out\MUSIC\Z<NAME>\` **and** `rbu-tools\out\MUSIC\ZZCUSTOMDB\` into `MUSIC\`.

What it does:
- **Audio:** prepwav (gain) → lead-in (below) → every stem padded to the longest one + tail → at3tool (66 kbps) → atmtool. It prints
  the level of the summed mix and warns if it clips (lower `gain`) or is much quieter than official songs.
- **Preview:** mkpreview (loudest 30 s unless `preview.start`) → at3tool (352 kbps).
- **Chart:**
  - **Rock Band-format MIDI** (has PART DRUMS / PART BASS / PART GUITAR / PART VOCALS / BEAT, e.g. a Rock Band,
    Clone Hero or Fortnite Festival chart): goes straight to mid2rbu (PitchedVocals on). Overdrive (note 116) and
    solos (note 103) come from the MIDI.
  - **No MIDI at all** (leave out `"midi"`): `stemchart.py` transcribes the stems into a plain MIDI, then the
    plain-MIDI path below runs on it (vocals from the vocal stem). It finds one fixed tempo and the downbeat from
    the drum stem (a tempo under 100 BPM is doubled when the double fits as well) and checks every 16th note:
    drums by band (kick 30–120 Hz; snare 150–400 Hz + 1.5–5 kHz where the kick is quiet; cymbals 6–16 kHz, crash
    when the highs still ring 0.25 s later), bass by YIN pitch with a new note on an attack or a pitch change,
    guitar by harmonic pitch with power chords when the fifth's own partials (1.5/4.5/7.5 x the root) are there;
    octave errors are folded back. (Miracle Man: guitar chords 4 % -> 18 % of Expert, in every section.)
    Onset strength ignores spectrum bins more than 60 dB under the band's loudest, so faint bleed (and the step from
    a lead-in's digital silence into it) doesn't count as an attack.
    It prints a drum grid per bar to check, and warns when the beat drifts (the song then needs a tempo map,
    not supported yet). `"autochart": { "bpm": 140 }` forces the tempo. Needs a drums stem.
    First song: Miracle Man (Fadr stems, 140 BPM, no drift).
  - **Plain MIDI** (a transcription with one track per instrument): `midiinfo.py` lists the tracks, `align.js` finds
    where the MIDI starts in the audio and the real tempo, from the kick/snare hits and the drum stem. Among
    near-equal whole-beat shifts it keeps those that put no MIDI drum note where the drum stem is silent, then
    picks the one whose last drum note lands on the stem's last strong hit (if one matches within 0.15 s) or else
    the best score; it stops with "ambiguous" if it still can't tell (Push It: 9.183 s by the ending;
    Handlebars: 6.767 s, the 0 s shift would put 18 notes in the silent intro). Then `autochart.py` writes the Rock Band-format MIDI (overdrive every 6 bars,
    intro notes from the audio, lower difficulties from Expert as below). Options under `"autochart"`: `offset`, `bpm` (skip the alignment), track
    indices `drums`, `bass`, `guitar`, `vocals` (defaults 1, 3, 2, 4; see midiinfo's track list), `odEvery`,
    `odFirst`, `odBars`, `introStart`, `intro`.
    - A part can come from several tracks: `"guitar": "0,4"` = track 0 until track 4's first note, then track 4.
    - `"vocalsFromStem": true`: vocal notes from the vocals stem instead of a MIDI track (rapped or spoken vocals).
      `vocalchart.js` finds the syllables (level rises), gives each a length, and picks the lane from the
      syllable's pitch compared with the syllables around it; autochart puts them on the 16th-note grid.
      Breaths and background sounds are dropped (since 2026-11-10; `--keep-all` turns it off): a syllable more than
      15 dB under the lead voice around it, or one with no clear pitch that is short (< 0.15 s) or 6 dB under it
      (Miracle Man: 42 of 233 dropped).
    - Solos for plain MIDIs (top level of song.json): `"solos": [ { "part": "guitar", "start": 6.7, "end": 20.2 } ]`,
      in audio seconds, up to 4 per part. autochart writes note 103 on that part; the solo takes the notes from
      `start` up to just before `end` (end it a little before the next section's first note). A solo that
      runs past the part's last gem is ended on that gem (mid2rbu silently drops a solo with no gem at or after its end).
  - **Lanes (autochart, like the official charts, FINDINGS §29):** drums: kick on the right lane, snare on the second,
    hi-hat/ride alternating the first and third lanes in busy runs (two hands instead of a wall of one colour),
    crash on the first; at most 2 gems at once (kick+cymbal on 1 and 3, kick+snare); tambourine/cowbell/shakers only
    stand in where a bar has no cymbal. Guitar/bass/vocals: lanes follow the melody (higher = further right, bigger
    jump = more lanes), a repeated note bounces between two lanes, never more than 2-3 gems in a row on one lane.
  - **Chords and held notes (autochart, FINDINGS §30):** guitar onsets with 2+ notes in the MIDI (power chords,
    octaves) become two-gem chords on beats, long notes and chord changes, at most 25 % of the gems (official median
    19 %); the rest play the root. Shapes: fifths skip a lane (1+3, 2+4), thirds/fourths are adjacent, octaves on the
    low lane 1+4; never the two left lanes. Bass gets no chords (official ~0 %). Bass/guitar hold a gem only when the
    MIDI note lasts a beat or more, at most 15 % of the gems (the longest), and the tail ends 1/16 (Expert/Hard),
    3/16 (Medium) or 1/4 note (Easy) before the next gem (rules from the Rock Band Network guides, as summarised by
    rockbandcustomsblog.wordpress.com). Medium keeps chords on downbeats/long notes; Easy never has more than 4 gems
    in a row on one lane.
  - **Vocals and drums (autochart, FINDINGS §31):** vocals are thinned to at most 2 gems/s on Expert (official median
    1.75, p90 2.4; the weakest-position syllables go first), a vocal gem is held only when the note lasts an 8th or
    more (at most 30 %, longest first), and a held vocal gem ends at least 300 ms before the next gem (official, every
    difficulty). Drum gems are never held.
  - **Difficulties (reduce.py):** you chart (or autochart makes) only Expert; Hard, Medium and Easy are picked
    from Expert's notes the way the 112 official charts do it (measured, FINDINGS §28):
    - how many: depends on the part and how busy Expert is, e.g. guitar at ~4 notes/s keeps Hard ~79 %,
      Medium ~47 %, Easy ~33 % of Expert (vocals keep more: ~90 / 65 / 52 %);
    - which: downbeats, then beats, then 8ths, then 16ths (pickups just before a beat first); sustains nearly always;
      kept notes never closer than ~140 ms (Hard), ~220 ms (Medium), ~290 ms (Easy), a bit less where needed to
      reach the count; the same off-beats survive in every bar, so patterns repeat;
    - lanes: Hard = Expert's; Medium keeps chords only on beats; Easy = single notes on the **two middle lanes**
      only (outer lanes fold inward, up/down movement kept), like every official Easy chart.
    - Checked against the official charts: note counts match within 2 %; 82-85 % of our Hard notes, 65-73 % of
      Medium and 53-64 % of Easy are the very notes the official chart kept (the rest are charter's choices).
    - autochart always does this. For a chart edited in REAPER (or a Rock Band MIDI) add `"reduce": true` to
      song.json to chart only Expert and have the rest made for you (or run `python reduce.py in.mid out.mid`).
  - mid2rbu → `beatmatch.js build` (donor chart, `--audio-seconds`, `--atm`).
- **Song database:** mkjukebox over **every** `songs\*\song.json` → `ZZCUSTOMDB\JB<days since 2008-03-07>.STR.EDAT`
  + TEXT (e.g. JB006819 on 2026-11-07; see §2).
  A database folder without a chart works (confirmed in game 2026-11-07: Push It listed and played from ZZCUSTOMDB).
- Re-run from a later stage with `--from chart` or `--from db` (earlier outputs stay in `songs\Z<NAME>\build\`).

### By hand (what mksong runs)
Paths: `M` = `C:\PSP\ppsspp_win\memstick\PSP\GAME\ULUS10418\MUSIC`; scripts in `rea-work\rbu-tools\scripts`;
`at3tool` in `rbu-tools\at3tool`; `mid2rbu` in `rbu-tools\mid2rbu`.

1. **Stems → WAV** (44.1 kHz mono 16-bit; mksong then sets the level, see "Loudness" in §4):
   `node prepwav.js <stem.wav> <out.wav> [gain dB]` (for a missing part: `node prepwav.js --silence <like.wav> <out.wav>`)
   Names: `drums.wav bass_guitar.wav lead_guitar.wav vocals.wav fill.wav`. All five must have the same length.
2. **Silent tail** (needed, see rules): `node padwav.js <in.wav> <out.wav> 6`
3. **Encode tracks:** `at3tool -e -br 66 -wholeloop <in.wav> <out.at3>` (each of the 5)
4. **Build the ATM:** `node atmtool.js -e <dir with the 5 .at3> <NAME>.ATM` (check with `node atmtool.js -i`)
5. **Preview (optional):** `node mkpreview.js <stem_dir> preview.wav [--start s]`, then
   `at3tool -e -br 352 -wholeloop preview.wav <NAME>_PREVIEW.AT3`
6. **Chart:**
   - Plain MIDI only: `python midiinfo.py <source.mid> --onsets onsets.json`, `node align.js drums.wav onsets.json`,
     `python autochart.py <source.mid> <NAME>.mid --offset 9.180 --bpm 150.15 --od-every 6 --od-first 2 --od-bars 1 --intro-stems <wav dir> --intro-start 4.3`
   - Convert to .rbu (in the chart folder, with a `config.ini`): `python mid2rbu.py -c config.ini -np <NAME>.mid`
7. **Chart file:**
   `node beatmatch.js build $M/SHESNOTTHERE/BEATMATCH.STR.EDAT <NAME>.rbu <out>/BEATMATCH.STR.EDAT --audio-seconds <audio length> --atm <out>/<NAME>.ATM`
   It must end with "chart matches the .rbu exactly".
8. **Song database:**
   `node mkjukebox.js --base $M/YOURENOROCKNROLLFUN --out <out> --number <days since 2008-03-07> song1.json [song2.json ...]`
   (`song.json` fields as above; `atm` = path to the .ATM, for its size).
9. Copy the folders to `MUSIC\`. No cheats are needed (disable `_L 0x202B2AA8 0x00000000` if it is still on).

### Editing charts in REAPER (since 2026-11-08)
Automatic charts now follow the official charts' statistics (lanes, chords, sustains, density; FINDINGS §28–31),
but a hand edit can still make a song more fun. REAPER with the Rock Band authoring setup lets you see and edit
the gems.

**Setup (one time):** install REAPER, then the Rock Band Network tools, which add the **RBN Preview** plugin that
draws the gems while you edit (there is a 64-bit build); a C3 REAPER template is optional. The RBN preview draws
from REAPER's tempo map and ignores the BEAT track, so the two must agree (they do in our files).

**Files:**
- Every `mksong` build writes `rbu-tools\reaper\<FOLDER>\`: `<FOLDER>_auto.mid` (the chart exactly as built,
  i.e. what the game plays) and the five tracks as WAV (drums, bass_guitar, lead_guitar, vocals, fill), all
  starting at 0. `_auto.mid` is overwritten by every build: save your edits under another name.
- Official songs, as a reference: `node scripts\reaperpack.js --official CRUSHCRUSHCRUSH` writes
  `rbu-tools\reaper\official\CRUSHCRUSHCRUSH\` (chart MIDI + the five decoded tracks; personal use).

**Workflow:**
1. In REAPER: put the five WAVs at the start of the project and import the MIDI at the start, accepting its tempo
   map. Keep the track names (PART DRUMS, PART BASS, PART GUITAR, PART KEYS, BEAT).
2. Edit the notes (see the layout below). Save/export the MIDI, e.g. `reaper\ZHANDLEBARS\ZHANDLEBARS_edit.mid`.
3. In `song.json` add `"chart": "../../reaper/ZHANDLEBARS/ZHANDLEBARS_edit.mid"` and run `mksong` (`--from chart`
   is enough if the audio didn't change). The edited chart is used as it is: no automatic charting and none of
   mid2rbu's clean-up (pruning, chord splitting). Remove `"chart"` to go back to the automatic chart.

**Note layout** (Rock Band standard, 480 ticks per beat; chartimport.py rescales other resolutions):

| | Easy | Medium | Hard | Expert |
|---|---|---|---|---|
| Guitar / bass lanes 1–4 (green, red, yellow, blue frets) | 60–63 | 72–75 | 84–87 | 96–99 |
| Drums lanes 1–4 (red, yellow, blue, green pads) | 61–64 | 73–76 | 85–88 | 97–100 |
- Orange fret (64/76/88/100 on guitar/bass) and kick (60/72/84/96 on drums) are ignored.
- **Vocals are on PART KEYS** (same layout as guitar), because the RBN preview draws PART VOCALS as a singing line;
  on import PART KEYS becomes the 4-lane vocal part. (Rock Band charts with real pitched vocals in PART VOCALS and no
  PART KEYS are also accepted.)
- Overdrive: note 116 over the phrase; every note of the phrase must lie entirely inside it (sustains included).
- Solo: note 103, longer than one beat, at most 4 per part. It must end on or before the part's last gem on every
  difficulty, or mid2rbu drops it without a message.
- A note of 160 ticks or less is a tap; longer is a sustain. Chords = notes starting on the same tick.

**Checked:** official charts exported and imported back come out the same (Crush Crush Crush: all 6313 gems
identical; Back from the Dead / Toxicity: 99.7 % identical, the rest are tap lengths above 160 ticks and 1–2
overdrive or solo-edge gems); Handlebars exported and imported back: all 3945 gems identical.

### What to rebuild after a change
| Change | Rebuild |
|---|---|
| Audio (re-encoded ATM) | ATM → BEATMATCH (`--atm`, for the hash) → JB + TEXT (for the size) |
| Chart / MIDI | BEATMATCH only |
| Title, artist, tiers, genre… | JB + TEXT |
| Add or remove a custom | JB + TEXT with all customs' .json |

---

## 4. Rules learned the hard way

| Rule | Why (symptom when broken) |
|---|---|
| Summed mix at about −14 LUFS with peaks held under full scale (official songs: −12.8..−15.3 LUFS, peaks −1.3..+0.3 dBFS) | Too loud: the sum clips → distortion. A plain −9.5 dB gain left customs 3.6–5.4 dB quieter than official songs |
| First notes no earlier than ~3 s: mksong adds a lead-in of silence when the stems sound before 3 s (`"leadIn"` overrides, 0 = off; song.json times stay in the original audio's seconds and are shifted) | Official songs: first gem never before 2.77 s (5 % before 3.1 s, median 4.85 s). Miracle Man had gems at 0.0 s that the highway could not show in time |
| Every gem must be in a bar: per part and difficulty, the last bar ends at the gem count (all 1624 official lists) | mid2rbu left the last gem of every part out of the bar lists: notes at the very end showed but the part couldn't be switched to and played; `beatmatch.js build` fixes the lists (2026-11-10) |
| Star thresholds come with the chart (root +0x304..+0x320; FINDINGS §33): `beatmatch.js build` estimates them from the notes (`"starsScale"` in song.json adjusts: > 1 harder, < 1 easier) | Kept from the donor before 2026-11-10: She's Not There's scores, so 5 and gold stars were out of reach on customs |
| Audio must run several seconds past the chart (silent tail, +6 s) | The game stops the audio and its clock ~1.3 s before the ATM ends; if that comes before the chart end → game idles forever, no results |
| Chart song end (root +0x124) = max over all gems of ms + ms duration | Donor value kept → song ends early (at the donor's length) |
| Last song event (root +0x2b0 list) = where the music stops | Donor events kept → music/clock stop early |
| Gem +0xC = note length in ticks (mid2rbu writes 0x7fff) | Each track's end = last gem tick + gem+0xC, rounded to the next bar; 0x7fff → ~20–27 s of empty lanes before results |
| Extra tempo/measure map copies must point at the new maps | Stale copies read leftover donor data |
| Overdrive: bit 25 on every gem of a phrase, bits 25+26 on its last gem | No bit 26 → no overdrive |
| Solos: records, gem bits, note counts and the per-track solo block must agree (see §6) | mid2rbu counts gems, not notes, so chords make the counts wrong |
| A solo must end on or before the part's last gem on every difficulty | mid2rbu silently drops it and verify still passes; mksong now compares the MIDI's solos with the chart and stops with an error (autochart ends such a solo on the last gem itself) |
| Gem +0xA = ms length + 94 | mid2rbu writes the tick length (a shorter window); the +94 version plays fine (Push It, 2026-11-07) |
| Plain-MIDI alignment: kick and snare only, and check the ending | Hi-hats make whole-bar shifts look equal (Push It: 2 bars off) |
| Chart root +0x324 = CRC-32 of the first 0x400 bytes of the .ATM | Wrong value → "Memory Stick removed" at song start |
| JB record +0xF8 = exact .ATM size | Song missing from the list (same check as a missing folder) |
| JB file exactly 0x1D580 bytes, TEXT files next to it, number above 571 | Database ignored, customs missing |

`beatmatch.js build` handles all the chart rules above automatically; `mkjukebox.js` handles the JB ones.

**Loudness** (mksong, since 2026-11-07): the game plays the five tracks summed, and official songs are mastered:
10 measured at −12.8..−15.3 LUFS (about −14) with peaks right at full scale (`scripts\loudness.js <dir>` measures a
folder of the five decoded tracks). mksong brings the summed stems to −14 LUFS with one gain for all of them, then a
limiter driven by the sum (5 ms lookahead, 80 ms release) applies the same gain reduction to every stem, so the
balance between parts is kept and neither the sum nor any track clips. Ceiling −1.5 dBFS, because ATRAC3 encoding
overshoots peaks by about 1 dB. A second pass makes up the loudness the limiter takes away. Result after encoding:
Push It −14.1 LUFS, peak −0.2 dBFS; Handlebars −14.1 LUFS, peak +0.1 dBFS (official: up to +0.3).

---

## 5. Limits

| Limit | Value | Where |
|---|---|---|
| Songs in the database | **300 total** (55 on-disc + 57 official DLC + **188 customs**) | g_jukebox record area (+0x34..+0x143a4); mkjukebox refuses more |
| Song folders registered | 300 (57 DLC + 188 customs = 245, fine) | dlc_scan_music_dir |
| Name pool | ~19.6 KB free; a custom uses ≤ 48 bytes | JB +0x1756c, 0x6000 bytes |
| Folder name | `Z` + up to 46 A–Z/0–9 | mkjukebox (the record id is the CRC-32 of the name) |
| Chart section size | up to 0x181800 (largest official) | beatmatch.js |

Removing official DLC doesn't free a slot: the database still lists all 112 official songs (missing ones are just not shown).

Checked at the full 300 songs (stress test below): save data, song list, sorting and previews all work.
Memory stick space is the practical limit (~10–12 MB per real song). Suggested stress test: 50–188 dummy copies of Push It, then
check that the list loads and scrolls and that a score saves on the last entry.

**Stress test kit (2026-11-09):** `node rbu-tools\scripts\stresspack.js` fills the database to 300 songs:
- copies `ZSTRESS001`..`ZSTRESS179` of one small base song (`rbu-tools\stress\ZSTRESS000`: 35 s of generated
  clicks/tone and a simple chart, no copyrighted content; rebuild it with
  `node mksong.js ..\stress\ZSTRESS000\song.json --out ..\stress\tmp`);
- plus every real custom.
- Titles, artists, genres, years and tiers vary.
- Output in `rbu-tools\stress\out\MUSIC` (about 1.04 GB, ~6.3 MB per copy).

The save (`PSP\SAVEDATA\ULUS10418S0000000\SETTING.SAV`, 27 KB) is encrypted, so whether scores have fixed per-song
slots can only be seen in game.
**Result (2026-11-10, PPSSPP): passed at the full 300 songs.**
- The song list loads (a couple of seconds slower than usual), scrolls, and sorts in every order; previews play.
- The score of the last entry (Stress Test 179) saves, and an official song plays and saves its score normally.
- So the database cap of 300 songs (188 customs) is usable, and save data is not a lower limit.

---

## 6. Format reference

### ATM (audio)
- Header 0x38 bytes (key words 0xDEADBEEF, track count 5, chunk 400 bytes, 5 track lengths); tracks encrypted with HC-128.
- What the tracks are: the first four belong to the playable parts. Missing notes on a part mutes its track (miss
  lead guitar notes in a solo and the lead guitar drops out). **`fill` is everything the player doesn't control**:
  rhythm guitar, keyboards, backing vocals, intro sounds. It is never muted, so the song keeps going while a part
  is muted. In Crush Crush Crush it is as loud as the other tracks and the only one playing in the first 6 s
  (listened to 2026-11-07). For customs: put any "other" or "backing" stem into `fill` (Push It with vocals and
  others split: missing vocals mutes only the voice, confirmed 2026-11-07).
- To listen to an official song's tracks: `node scripts/atmtool.js -d <MUSIC>/NAME/NAME.ATM work/dec/NAME`, then in
  that folder `at3tool -d -repeat 1 fill.at3 fill.wav` (and the same for the other four; keep the paths short).
- Track order: drums, bass_guitar, lead_guitar, vocals, fill. Each is ATRAC3 (tag 0x270), mono 44.1 kHz, 66 kbps,
  whole-loop `smpl`, all the same length.
- Packed layout: size = 0x38 + 5 × track length (the original C ATMTool pads the last chunk, so its sizes differ; atmtool.js is correct).

### Preview
ATRAC3plus stereo 44.1 kHz 352 kbps, ~30 s, 1 s fade-in / 4 s fade-out, ~−17 dBFS RMS.

### JB file (song database), 0x1D580 bytes
`header 0x30 | count @0x30 | 300 × 0x114 records @0x34 | … | name pool @0x1756c (0x6000) | tail`.
Unused space is filled with `01 00 80 7f`.

| Record off | Meaning |
|---|---|
| +0x00 | id = CRC-32(UPPERCASE folder name) |
| +0x04, +0x08 | internal (lowercase) name, as an offset into the pool |
| +0x0C | flags: 0x04, 0x08 always; 0x80 DLC; 0x40 = verified playable (set by the game) |
| +0x10 / +0x14 / +0x18 | text ids: title, artist, album |
| +0x1C | sort letter text id (0x1c2 "A" … 0x1db "Z", 0x1a7 "123") |
| +0x20 / +0x24 / +0x28 | difficulty label, genre, era text ids |
| +0xA8 | year |
| +0xAC | vocalist: 1 male, 2 female |
| +0xB8..+0xC8 | tiers: drums, guitar, bass, vocals, band (0–6) |
| +0xF4 | 32-bit value, unknown purpose (**not** the ATM hash) |
| +0xF8 | .ATM size |

Records 0–54 are on-disc songs, 55–111 official DLC.

### TEXT files
Plain UTF-8, LF. First line `<count>\t1`, then one string per line; text id n = line n+1. `jukebox2` = copy of `jukebox`.

### BEATMATCH.STR.EDAT (chart)
- Header 0x80 bytes, then a table of 288 × 0x40 entries; entries 124–127 = `{start, size, end}` of the 4 sections.
- Sections 0–3 = Easy, Medium, Hard, Expert, each a memory image loaded at **0x096e9a80** (section offset 0 = the chart
  root; pointers inside are absolute addresses). Free space is filled with 0x7f800001.

| Chart root off | Meaning |
|---|---|
| +0xD4 | pointer to the difficulty object (its first word = 0–3; the gem lists hang off it) |
| +0x114 / +0x118 / +0x11C | tempo map / measure map / beat map |
| +0x124 | song end (float ms) |
| +0x15C | current measure (runtime) |
| +0x22C / +0x230 | song clocks in ms (runtime) |
| +0x234 | current tick (runtime) |
| +0x2B0 / +0x2B4 | song events pointer / count (0x50-byte records; the last event = where the music stops) |
| +0x328 + 0x28·t | solo block per track (see below) |
| +0x324 | expected ATM hash |

Gem (0x14 bytes):

| Off | Field |
|---|---|
| +0x00 | f32 time in ms |
| +0x04 | u32 tick (480 per beat) |
| +0x08 | u16 duration in ms |
| +0x0A | u16 hit window in ms: ms duration + 94 (38 songs) or the ms up to tick + length + 60 ticks (19 songs) |
| +0x0C | u16 length in ticks (used for the track end) |
| +0x0E | u8 lane mask |
| +0x0F | u8 flags (0x08 base, \|2 ignore sustain) |
| +0x10 | u32 flags: bit 25 overdrive, bit 26 last gem of the phrase, bit 27 solo, bits 28/29 solo start/end |

Solos (root+0x58+12t vector, 20-byte records; matches all 364 official solos):

| Off | Field |
|---|---|
| +0x00 | f32 start ms |
| +0x04 | f32 length ms |
| +0x08 | u32 start tick |
| +0x0C | u32 length in ticks |
| +0x10 | u32 note count = notes in the lane masks of the solo's gems, summed (a chord counts once per note) |

- Gems of a solo: bit 27 on all; bit 28 + low 16 bits = note count on the first; bit 29 (low bits 0) on the last.
- Per-track block at root+0x328+0x28t (10 words): f32 end ms[4] (last solo gem ms + its ms duration), u32 count,
  f32 start ms[4] (first solo gem ms), u32 count. All zero without solos. At most 4 solos per track.
- In the MIDI: note 103 longer than one beat (mid2rbu).

Per-track end (FUN_08a8764c): last gem tick + gem+0xC → start of the next measure → ms. The results screen appears
when every track has passed its end (the lanes hide).

---

## 7. Useful addresses (EBOOT, retail ULUS10418; file offset = address − 0x08803000)

| Address | What |
|---|---|
| 0x08a2e4a4 | dlc_refresh (scan + load + verify) |
| 0x089f1b30 | dlc_scan_music_dir |
| 0x08a2db94 / 0x08a2b6a4 | jukebox_load / jukebox_read |
| 0x089f191c | dlc_verify_song_files |
| 0x08c0b65c | g_jukebox pointer |
| 0x08ab26a8, 0x08ab2aa8 | ATM hash check function, compare instruction (old cheat target) |
| 0x089f2648 | CRC-32 of the first 0x400 bytes of the .ATM |
| 0x08b452c0 | standard CRC-32 table |
| 0x08ad6670 | beatmatch_read (re-installs vtables in the loaded chart image) |
| 0x08a8764c | per-track end computation |
| 0x096e9a80 | chart root (loaded section) |
| *0x08b7d5a8 | game object |
| 0x08b775c8 / 0x08b775cc | folder CRC list count / array |

---

## 8. UnpluggedDeluxe (plugin) notes
- **Not needed on PPSSPP.** The game's own loader accepts customs once the files are right: the song list (JB +
  TEXT), the chart with the correct ATM hash (root +0x324), the .ATM with the size the JB records, and the song id =
  CRC-32 of the folder name. No code patches and no cheats.
- UD patched the game in memory because the formats weren't understood yet: it overwrote the song table and chart
  in RAM and disabled the two checks that rejected customs (.ATM size, ATM hash). Its source was still the map
  for this work (which memory mattered, and its workarounds pointed at what needed fixing).
- Not needed any more for single customs; its changes are kept uncommitted on branch `native-records` and were never compiled (no PSP SDK).
- Its `SongInfo` struct is shifted by 0x14 relative to the real record. Its song IDs (`0x0000ffff | i<<16`) never match
  the folder CRC list. Writing 2 text entries per custom overflows the text table's heap block once there are 2 or more customs.
- Its workarounds correspond to things now fixed in the files themselves: the hash nop (→ root +0x324), end_song_thrd
  (→ gem +0xC), and "short donor ends early" (→ song end + events).

---

## 9. Open questions / next steps
- Solos are supported (format matched on all official charts); first in-game test: Handlebars (guitar intro solo).
- Vocals from a stem (vocalchart.js) are new; first test: Handlebars.
- Vocals are charted from the synth line (no real vocal part in the source MIDI); kick notes are ignored.
- Meaning of JB record +0xF4 / +0xB4, and of donor data still copied unchanged (root +0x28..+0x4c per-track one-bar
  lists, root +0x70 segment, drum 16-entry lists). None has caused problems so far.
- Which game version reads the JS files (the same song list in 0xD8-byte records; see §2), and JS +0xD0/+0xD4.
- Limits stress test: done 2026-11-10, passed at 300 songs (§5).
- Kicks: Unplugged's drums have 4 lanes and no kick, so kick notes are dropped by design.
- TODO (parked 2026-11-09): camera shots. The camera follows the instrument being played and the codes look
  random, so naming them and a song.json "cameras" option are on hold (see "Camera shots" below; ZCAMTEST).

### Screen effects (old film on TODAY)
The engine has 22 full-screen effects (Blur, Tint, Monochrome, Sepia, FishEye, Photonegative, FilmGrain, FilmDust,
FilmScratch, NightVision, ...). An "old film" preset (FilmGrain + FilmDust + FilmScratch plus a colour tint) exists as
a script command. It is not tied to TODAY's name or database record. What triggers it is not known yet: the chart
holds the song's animation/lighting parsers and an event list, but no effect name or command id appears in any file.
**Test:** `ZTODAYFX` = TODAY's chart and audio copied unchanged (only the ATM checksum filled in). If the film effect
shows in ZTODAYFX, it comes from the chart and can be carried to customs by building them on a donor chart that has
it. Details: FINDINGS §26.
**Result:** confirmed. ZTODAYFX shows the effect, and so does `ZPUSHITFX` (Push It built on TODAY's chart as donor), so the
trigger is in the donor data the builder keeps (event lists), not in notes, tempo or audio. **To give a custom the
old-film intro:** add `"donor": "../../work/donors/TODAY/BEATMATCH.STR"` to its song.json (TODAY's chart extracted
from your own disc; personal use) and rebuild with `--from chart`.

**How it is switched (found 2026-11-08):** each chart contains small compiled scripts, and every song event runs one
of them at its time (the event id's low 18 bits are the script number). Some scripts call an effect command; a
later event runs the "end effect" command. TODAY turns its effect on at 0:00.5 and off at 0:15.0, plus four short
ones of about 2 s later in the song. The other effect songs work the same way:

| Song | Effect (command) | When |
|---|---|---|
| TODAY, Chop Suey! (intro) | blur + colour filter + flash (#50) | 0:00.5–0:15.0 / 0:00.1–0:18.0 |
| Aqualung | old film: colour filter + grain, dust, scratches (#40) | 3:24.8–3:39.7 (guitar solo) and later |
| Chop Suey!, Show Me the Way | colour filter + flash (#45) | 1:25.7, 2:15.2 / 2:13.6 |
| Show Me the Way | photonegative (#46) | 2:46.3 (guitar solo) |
| Move Along, Livin' on a Prayer | colour filter only (#47) | 2:32.2–2:48.1 (vocal solo) / 0:13.9–0:22.3 |
| The Trees | sepia (#48) | — |

The engine also has night vision (#39) and a few others. Details: FINDINGS §26.
**Test:** in `out\MUSIC\ZTODAYFX` two pairs of events were swapped so TODAY's opening effect should now run from
0:43.7 to 0:58.3 instead of at the start (the short later ones are unchanged). **Result:** confirmed (the effect
moved).

**All effects and `fxchart.js`:** the game has 16 effect presets that charts can call (plus lower-level effect
commands with parameters, #162–#175, not used by any chart and not exposed yet):

| Name in fxchart | # | What it shows |
|---|---|---|
| `end` | 37 | stops any effect (soft fade back to normal); official charts put it after every effect |
| `vortex` | 38 | vortex |
| `nightvision` | 39 | night vision + video lines |
| `oldfilm` | 40 | black and white + lines, grain, dust, scratches (Aqualung solo) |
| `colorfilm` | 41 | lines, grain, dust, scratches in colour (Aqualung intro) |
| `tintlines` | 42 | colour tint + video lines |
| `blur2`, `blur3`, `blur` | 43, 44, 52 | blur (three presets) |
| `bwflash` | 45 | black and white + grain + flash |
| `negative` | 46 | photonegative |
| `bw` | 47 | black and white only |
| `sepia` | 48 | sepia |
| `film` | 49 | grain, dust, scratches in colour |
| `blurbwflash` | 50 | blur + black and white + grain + flash (TODAY / Chop Suey! intro) |
| `blurtint` | 51 | blur + tint |

Names come from the code; the showcase song below is there to check what each really looks like.
- `node scripts\fxchart.js list <BEATMATCH>`: the effects a chart switches, with times.
- `node scripts\fxchart.js apply <in> <out> effects.json [--keep]`, where effects.json is
  `[{"effect": "sepia", "from": 83.0, "to": 97.5}, ...]` (seconds). Each effect is added to the song event nearest
  the time you ask for (events are 1–3 s apart), keeping that event's camera and animation commands. Without
  `--keep` the chart's own effects are removed first.
- **In a custom song (the normal way):** add to song.json
  `"effects": [{"effect": "oldfilm", "from": 45, "to": 60}, {"effect": "sepia", "from": 90, "to": 100}]`
  (seconds in the song's audio, e.g. read off REAPER; `"to"` optional) or `"effects": "myeffects.json"`, and
  rebuild with `--from chart`. Works on any donor (the donor's own effects are removed first; add
  `"keepDonorEffects": true` to keep them). Only scripts and events change, never notes, tempo or solos.
- Test song `ZFXTEST` = Push It on the default donor with sepia 0:20–0:30, old film 0:45–1:00, negative
  1:30–1:40 (She's Not There's chart had no room after its script table, so the tool moved it; this checks that). **Result:** all three effects show up in game.
- Test song `ZHANDLEBARSFX` ("Handlebars (FX test)") = Handlebars with old film over the guitar solo (0:07.1–0:20.5)
  and a vocal solo over the last vocal part (2:20.3 to the last gem at 3:28.7) with old film from 2:20.45 to the
  end (no "to"). Effects snap to existing song events, so they can start/end a few tenths of a second off.
  The first vocal solo built in a custom: checks vocal solos and an effect running to the end of the song.

**Showcase:** `ZTODAYALLFX` ("Today (all FX)") = TODAY with its own effects removed and the 15 effects one after
the other, about 9 s each (`songs\ZTODAYALLFX\effects.json`): vortex 0:07, night vision 0:18, old film 0:32,
colour film 0:44, tint+lines 0:55, blur2 1:08, blur3 1:20, B&W+flash 1:33, negative 1:45, B&W 1:56, sepia 2:08,
film 2:20, blur+B&W+flash 2:32, blur+tint 2:44, blur 2:56 (end 3:05). Vortex runs straight into night vision. **Result:** all 15 effects show up in game at their times.

### Camera shots (in progress)
The same chart scripts drive the cameras and the band's moves: script command #22 sends one of 32 named camera
shots/cues, which every venue file defines; #17–#20 send moves to the four band members; #28 changes the
stage/game state. The names exist only as hashes, so the showcase song `ZTODAYCAM` ("Today (camera test)")
plays each of the 32 by itself for about 6 s (TODAY's own camera messages and effects removed). The list of times
is in `rbu-tools\songs\ZTODAYCAM\timetable.txt` (S01–S32); note what each one shows, and they can be given names.
`fxchart.js` can already place any of them: `{"cmd": 22, "arg": "dc0222d9", "at": 12.5}` in the JSON, and
`--strip 22` removes the chart's own. Details: FINDINGS §27.
**Result so far:** ZTODAYCAM plays and its camera work is clearly different from the original TODAY, but the
timetable alone was not enough to tell which code is which shot. TODO (later): identify the shots (e.g. a slower
showcase with one shot per section and an on-screen marker), then add a song.json "cameras" option with names.
**Second showcase `ZCAMTEST` ("Camera test (shots)", 2026-11-09):** Handlebars' audio with no notes except a
marker at each shot change, on every part and difficulty: the lane (left to right) gives the group (S01–S08,
S09–S16, S17–S24, S25–S32), the number of gems in a row gives the shot in the group (1–8). One shot every ~6.2 s
from 0:07 (the camera calls sit exactly on the marker's event). Checklist with times, markers and what the official
charts suggest for each code: `rbu-tools\songs\ZCAMTEST\checklist.txt` (fill in "shows:"). Generator:
`songs\ZCAMTEST\make.py`; mksong's new `"stripCommands": [22]` removes the donor's own camera calls.
**Result so far:** the camera follows the instrument you are playing (guitar -> guitarist, vocals -> singer, ...),
so a code looks different depending on the active instrument. Next test: stay on one instrument the whole song,
play it twice, and note the kind of shot (close-up, wide, angle, pan, no change) for each marker.

### Real PSP (future TODO; current focus is PPSSPP)
Everything above was tested on PPSSPP. Open points for real hardware:
- **Encryption.** The DLC files on this memory stick are plain data despite the `.EDAT` extension, and PPSSPP reads
  them as they are. Official DLC on a real PSP normally comes as encrypted (NPDRM) EDAT files, and the game reads DLC
  in EDAT mode (jukebox_read, edat_file_helper). If the real system only accepts files that decrypt properly, plain
  custom files would be rejected, and validly encrypted ones can't be produced. A real PSP might then still need
  help, e.g. custom firmware with a plugin that lets plain files through (or UnpluggedDeluxe-style patching).
- **Test plan:**
  1. Copy the official DLC folders exactly as they are on the PPSSPP memory stick, plus `ZPUSHIT` and
     `ZZCUSTOMDB`, to the PSP's `PSP\GAME\ULUS10418\MUSIC\`.
  2. Check that the official DLC songs show up and play (this shows whether plain files are accepted at all).
  3. Check that Push It shows up and plays.
- **Information to note:** firmware (official or custom; which one), game copy (UMD or digital), and any error
  message. If the files are refused, a RAM dump or the error would show which check fails.
- If plain files work: the master-database approach for several devices applies as on PPSSPP (one `ZZCUSTOMDB`,
  different song folders per device).

---

## 10. Where things are
| Path (under the `rea-work` working folder) | Content |
|---|---|
| `rbu-tools\scripts\` | mksong (all-in-one), prepwav, padwav, atmtool, mkpreview, midiinfo, align, autochart, reduce, vocalchart, beatmatch, mkjukebox, chartmap, loudness, reaperpack, chartimport, fxchart, stresspack (see §3 "Tools") |
| `rbu-tools\customs\<SONG>\` | your source files (stems, MIDI) per song |
| `rbu-tools\songs\` | one folder per custom song (`song.json` + `build\`) |
| `rbu-tools\out\MUSIC\` | finished folders to copy to the memory stick |
| `rbu-tools\reaper\` | REAPER folders: `<FOLDER>\` per custom (`_auto.mid` + WAVs), `official\<NAME>\` references |
| `rbu-tools\work\pushit\` | Push It sources and builds (`ZPUSHIT\` = finished folder, `chart\` = MIDI/.rbu/backups v1–v5) |
| `rbu-tools\stress\` | stress-test base song and output (§5) |
| `docs\FINDINGS.md` | Full research log (§1–§33) |
| `rea-work\rbu-analysis\decomp\`, `round*\` | Decompiled functions (research only; outside the repo) |
| `rea-work\rbu-analysis\scripts\` | Ghidra headless scripts (outside the repo) |
| `rbu-dumps\` | Decrypted EBOOT and RAM dumps (personal use only) |
| `rbu-tools\work\pushit\ULUS10418.ini` | Old hash cheat (no longer needed) |
