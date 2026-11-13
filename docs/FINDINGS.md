# Rock Band Unplugged (ULUS10418) — DLC loading findings

Source: decrypted EBOOT `rbu-dumps\ULUS10418_EBOOT.BIN` (sha256 f79c3dd1…394b), Ghidra 12.1.4 + ghidra-allegrex v21.4,
project `rbu-analysis\ghidra-project\RBU`. Decompiled code in `decomp\` and `decomp\round2\`.
Status: static analysis + two vanilla RAM dumps (UD not loaded) in `rbu-dumps\dumpRAM_*.bin` (base 0x08800000).
Items marked (H) are still hypotheses; (C) = confirmed from RAM.

## Call flow

```
dlc_refresh_a 0x08a2e4a4   (also dlc_refresh_b 0x08a2d3bc, FUN_08a2e434)
 ├─ dlc_scan_music_dir 0x089f1b30      -> picks song-database file + builds folder CRC list
 ├─ jukebox_load      0x08a2db94       -> loads song database into g_jukebox (DAT_08c0b65c)
 └─ for each song entry: dlc_verify_song_files 0x089f191c   (UD hooks this call at 0x08a2e7c4)
```
If DLC is disabled (`DAT_08b83281 == 0`) or the scan fails, the game falls back to `streams/jukebox.str` (on-disc list).

## 1. Folder scan — `dlc_scan_music_dir` (0x089f1b30)
- Opens `ms0:PSP/GAME/<id>/MUSIC`, walks every sub-folder (skips `.`/`..`).
- In each folder:
  - A file starting with `BEATMATCH.STR` → stores **CRC-32 of the upper-cased folder name** in `DAT_08b775cc[]`,
    count `DAT_08b775c8`. **Max 300 folders.** List is sorted afterwards (qsort, comparator 0x08895774).
  - A file named `JB<6 digits>.STR.EDAT` of size **0x1d580**, with `TEXT/STR_<lang>_jukebox.TXT.EDAT` next to it →
    candidate song database. **The folder with the highest JB number wins.**
- (C) Your setup: highest JB is **JB000571**, shared by CALIFORNIAUBERALLES, EXCUSEMEMR, IMSHIPPINGUP, YOURENOROCKNROLLFUN.
  The scanner keeps the first folder with a strictly higher number, so any of the four supplies the same 112-song table.
- (H) UD needs YOURENOROCKNROLLFUN because it is **record #111, the last one in the JB000571 table**: UD hard-codes that
  record (0x08EDA30C = record−0x14) as the template it copies for every custom.
- `FUN_08b2b020` = toupper (ctype flag 2 = lowercase → −0x20). The CRC really is over the **upper-cased** name.

## 2. Song table — `g_jukebox` (DAT_08c0b65c), built by 0x08a2db94
- Song count at `+0x30`. Entries are **0x114 bytes, starting at `+0x34`**, inline in the object.
- Space between `+0x34` and the next field `+0x143a4` = 0x14370 = **exactly 300 entries** (matches the 300-folder cap).
- UD's addresses fit: base 0x08ed2b40 (UD "SONG_COUNT2"), count 0x08ed2b70 (UD "SONG_COUNT1"),
  UD's "last SongInfo" 0x08EDA30C = entry #111 (minus 0x14) → **112 songs used, 188 free slots**.
  UD's appended entries therefore stay inside the table (no overrun) up to 188 customs.
- **UD's `SongInfo` struct is shifted by 0x14:** the real record starts at UD's `id` field. UD's `field0_0x0[20]`
  is the tail of the *previous* record. Real layout (offsets from record start):
  `+0x00 id (CRC-32 of folder name)`, `+0x04/+0x08 internal names`, `+0x0C flags`, `+0xF8 expected .ATM size`.
- UD also writes the count to base+0 (its "SONG_COUNT2"); nothing seen so far reads that as a count — (H) may clobber a header field.
- A second 0x114-stride array is allocated at `+0x143a8` (count `DAT_08c0b64c`, entries seeded with 0x64d48f7f) — purpose unknown.

### Confirmed in PPSSPP (2026-11-06)
- Breakpoint 0x089f191c (hit on entering Quick Play): `a0 = 0x08ED2B74` = base 0x08ed2b40 + 0x34 → records start at +0x34. **Confirms the 0x14 shift.**
- Write breakpoint on the count (0x08ed2b70) stopped on `sw t4,0x0(a2)`. Only 5 such instructions exist; the matching one is
  0x08a2b970 inside `jukebox_read` (below). PC not yet confirmed by the user.

## 2b. Database reader — `jukebox_read` (0x08a2b6a4), called first by 0x08a2db94
- Queues an async read of the chosen `JBxxxxxx.STR.EDAT` (EDAT mode for DLC) into a static buffer at **0x08bede40, size 0x1d580**, waits for it.
- Copies the buffer **byte-for-byte** into `g_jukebox` (16-byte loop up to 0x08c0b3c0 = 0x08bede40 + 0x1d580).
  The count at +0x30 is the first word of a 16-byte block → the `sw t4,0x0(a2)` store.
- **So the in-memory song table is the decrypted JB file itself.**
- Fix-up pass: for each record, the two name fields (record +0x04, +0x08) are file-relative offsets, turned into pointers
  into a **string pool at g_jukebox+0x1756c (0x6000 bytes**, matches +0x17564 = 0x6000, +0x17568 = pool pointer). 0 stays NULL.
- JB file layout (H): header 0x30 | count @0x30 | 300 × 0x114 records @0x34..0x143a4 | other fields | string pool @0x1756c..0x1d56c | tail to 0x1d580.
- Plugin implication: one hook right after this copy can append records (and names into the pool's free space) once,
  instead of re-copying on every `dlc_verify_song_files` call. Or a tool could build a whole custom JB image.

## 2c. Record fields (C, from RAM; offsets from record start, UD offset = +0x14)
| Off | Meaning | Evidence |
|---|---|---|
| +0x00 | id = CRC-32(upper folder name) | all 57 DLC match their folder |
| +0x04, +0x08 | internal name ptrs (lowercase) | e.g. "constantmotion" |
| +0x0C | flags: 0x04,0x08 all; 0x80 DLC; 0x40 set by verify; 0x100 on the four JB571 songs; 0x20 on ALLIWANT only | 0x8c→0xcc between dumps |
| +0x10/+0x14/+0x18 | text ids (title, artist, 3rd = album?) consecutive | 0xa6,a7,a8… |
| +0x1C | text id 0x1a7–0x1da (pack/source?) | |
| +0x20 | difficulty text id (UD offset 0x167) | |
| +0x24 | genre text id (UD 0x173) | |
| +0x28 | era text id (UD 0x16e) | |
| +0x2C..+0x6C | -1 except on-disc #0 (0xa6..0xa9) | unknown |
| +0xA8 | year (2007, 1997, 2000…) | |
| +0xAC | 1 or 2 (vocal gender?) | (H) |
| +0xB4 | unknown per-song value | |
| +0xB8..+0xC8 | drum/guitar/bass/vocal/band tiers 0–6 | UD diff fields |
| +0xF4 | 32-bit hash, 0 on on-disc songs | (H) .ATM hash for HASH_CHECK |
| +0xF8 | .ATM size | matches every file |
- Records 0–54 are on-disc (flags 0x0c), 55–111 DLC. g_jukebox +0x0 and +0x30 both = count; +0x10 = selected record ptr.
- String pool: names end at +0x135c; the rest is **free**, filled with 0x7f800001 (see §4).

## 3. Per-song check — `dlc_verify_song_files` (0x089f191c), arg = record pointer
- Not DLC (`flags & 0x80 == 0`) or `flags & 0x400` → OK, untouched (on-disc songs).
- `bsearch(record.id, folder CRC list)`; if found:
  - `MUSIC/<name>/<name>.ATM` must exist and its size must equal `record+0xF8` (UD patches this check at 0x089f1a18).
  - `MUSIC/<name>/BEATMATCH.str.EDAT` must open; if `DAT_08b4e430` is set, its first 16 bytes must be
    `01 00 00 00 | 80 48 00 00 | 80 00 00 00 | 00 00 00 00`.
  - All good → `flags |= 0x40`; otherwise `flags &= ~0x40`.
- (C) `0x40` gets set on all 57 DLC between entering Quick Play and the list showing.
- **Song ID solved (C):** `id = CRC-32(uppercase folder name)` (standard table at 0x08b452c0, `~crc`).
  UD's guessed `0x0000ffff | i<<16` (main.c:215) never matches the CRC list, so its entries always fail the lookup.
  Using the real CRC of `ZSONGNAME` should let the game accept customs natively.

## Next experiments
1. Custom with id = CRC-32("ZSONGNAME") and +0xF8 = real .ATM size, **without** the size-check patch → does the game set 0x40 itself?
2. Same with +0xF4 = 0 and **without** the hash-check patch → is the hash skipped for 0?
3. Remove YOURENOROCKNROLLFUN but keep another JB000571 folder → does the table still load with 112 records?
4. Find who reads +0xF4 and +0xB4 (read breakpoints) to name them.

## 4. JB file contents (C, from RAM)
- The read buffer at 0x08bede40 still holds the **raw decrypted JB000571** after loading (record names are pool offsets,
  e.g. 0x9ae, not pointers). Saved as `rbu-tools\work\jb\JB000571_from_ram.bin` (0x1d580 bytes). Personal use only — it is
  derived from purchased DLC.
- Name fix-up: `ptr = g_jukebox + 0x1756c + offset`.
- **Unused space is filled with 0x7f800001** (bytes 01 00 80 7f), not zero: record slots 112–299 and pool +0x135c..+0x6000
  (19,620 bytes) are free. (Earlier note saying the pool was full was wrong.)
- **(C) The DLC files are not encrypted on this memory stick**: JB000571.STR.EDAT is byte-identical to the RAM copy,
  BEATMATCH.STR.EDAT starts with the plain 16-byte header the verify step checks, TEXT files are plain UTF-8.
  So a JB file can be generated directly: `rbu-tools\scripts\mkjukebox.js` (verified offline against the game's checks).
- Text files `TEXT/STR_<EN|FR|GE|IT|SP>_jukebox[2].txt.EDAT`: first line `<count>\t1`, then one string per line (LF, UTF-8);
  text id n = line n+1. `jukebox2` files are identical to `jukebox`. Ids: +0x18 = album, +0x1C = sort letter
  (0x1c2 "A"..0x1db "Z", 0x1a7 "123"). 14 official songs have difficulty label −1 (none); the rest use label = band tier.
- Text table in RAM: char* array at *0x08b5d010, count 0x08b5d0a4, heap block with room for only 1 extra entry;
  the original UD writes 2 per custom → overwrites the next heap block header with ≥2 customs.

## 5. ATM audio (C)
- Official tracks: ATRAC3 (tag 0x270), mono, 44.1 kHz, 66 kbps (192-byte frames), whole-song loop `smpl` chunk,
  all five tracks the same length. `at3tool -e -br 66 -wholeloop` on a 44.1 kHz mono WAV produces an identical fmt header.
- Real .ATM files use the **packed** final-chunk layout (size = 0x38 + 5 × track length). The C ATMTool encoder pads the
  last chunk instead; `rbu-tools\scripts\atmtool.js` writes the packed layout (round-trip verified).

## 6. First in-game custom (C, 2026-11-06) — ZPUSHIT, no plugin
- Generated JB000900 + TEXT in MUSIC/ZPUSHIT, real .ATM, donor BEATMATCH (CONSTANTMOTION), no preview file.
- Listed under "P" with DLC icon, correct details; 2 stars displayed for tier 2 (tier n = n stars, 0..6).
- Starting it failed with "Memory Stick removed" → the .ATM check at 0x08ab2aa8: `CRC-32(first 0x400 bytes of
  MUSIC/<n>/<n>.atm)` (0x089f2648) vs gameplay+0x324. Source of +0x324 unknown: not record +0xF4 directly, not a plain
  CRC of the official files (tested 57 songs / several variants). +0xF4 also appears in JS000571 for all 57 songs.
- With the hash patch applied as a CWCheat (`_L 0x202B2AA8 0x00000000`) the song **plays** (donor notes).
- Missing preview: no problem in the list.

## 7. Preview (C)
- Official `<NAME>_PREVIEW.AT3`: ATRAC3plus (tag 0xFFFE, GUID e923aabf-cb58-4471-a119-fffa01e4ce62), stereo 44.1 kHz,
  352 kbps (2048-byte frames), ~30 s, whole-loop smpl, ~1 s fade-in / ~4 s fade-out, ~-17 dBFS RMS.
- `rbu-tools\scripts\mkpreview.js` + `at3tool -e -br 352 -wholeloop` → header identical to the official files.
- A missing preview does not break the song list (test 2026-11-06).

## 8. BEATMATCH.STR.EDAT (chart) — first survey (plain data)
- Header: `01 00 00 00 | 80 48 00 00 | 80 00 00 00 | 00 ..` → header 0x80 bytes, then a table of 288 × 0x40-byte entries
  (0x80..0x4880). Only entries 124..127 are meaningful: `{start, size, end}` of **4 equal-sized sections**
  (CRUSHCRUSHCRUSH 0xc4800 each, CONSTANTMOTION 0x181800), filling the file. (H) one section per difficulty.
- Each section is a **memory image loaded at a fixed address: 0x096e9a80** (= *0x08b7d5a4, UD's "gameplay root").
  Section offset 0 = the chart root object; absolute pointers inside point to 0x096e9a80 + offset.
  Checked on CRUSHCRUSHCRUSH, CONSTANTMOTION, ALLIWANT.
- So UD's chart addresses are fields of this image: tempo map ptr root+0x114 (0x096e9b94), measure map +0x118,
  beat map +0x11c, difficulty ptr +0xd4 (0x096e9b54), track watchers root+0x268 (*0x08b7cf14).
- `beatmatch_read` (0x08ad6670) is not a parser: it re-installs vtables/static pointers into the loaded image.
- Free space inside a section is filled with 0x7f800001 (~100 KB in CRUSHCRUSHCRUSH section 0).
- Some pointers fall at 0x08c5xxxx/0x08c6xxxx (outside the image, differs per song) — unknown yet.
- Section word 0: 0x7d, 0x7e, … (125, 126…) — matches table entry index + 1.

## 9. Chart image confirmed at runtime (C, gameplay dumps of CRUSHCRUSHCRUSH Easy/Expert)
- Image at 0x096e9a80 = section 0 on Easy (99.86 % identical words), section 3 on Expert (99.82 %). Difficulty value
  (**0x096e9b54) = 0 / 3. → sections 0..3 = Easy, Medium, Hard, Expert.
- Words changed after load (287 on Easy): 58 vtable pointers rewritten from dev-build 0x08c5xxxx/0x08c6xxxx to retail
  0x08b3xxxx (beatmatch_read), rest runtime state / small allocations near +0x99c00. Other 0x08c5-6 words stay as-is.
- Arrays (all inside the image, file values == RAM values), `rbu-tools\scripts\chartmap.js`:
  | array | holder (img+) | data (Easy / Expert) | elem | Easy / Expert count |
  |---|---|---|---|---|
  | tempo (ms,tick,tempo) | a7110 (+4 data,+8 cap,+c size) | 78f30 | 12 | 1 |
  | beats (tick,level) | 747a0 (+0,+4,+8) | 75200 | 8 | 432 |
  | measures | a7130 (+0,+4,+8) | 78f50 | 16 | 1 |
  | gems[track] (GameGem) | per difficulty | 80020… / 79540… | 0x14 | drums 386 / 702 … |
  | bars[track] | 99d50/9a020/9a2a0/9a520 (+c,+10,+14) | 9a660… | 16 | 107 |
  | solos[track] | root+0x58+12t (+0,+4,+8) | null | 20 | 0 |
- gem_info chain (UD replace_gem_infos) did not resolve with my reading — to redo.
- Free space per section (0x7f800001): two big runs, +0x7498 (~51 KB) and +0x6cfd8 (~22 KB), untouched at runtime.

## 10. Native chart pipeline (built 2026-11-06, confirmed in game 2026-11-07)
- Per-note info byte array (UD "gem infos"): holder = *( *( *(*(*(root+0x104)+4d))) ) + 4t ... resolved (chartmap.js);
  1 byte per gem, count == gem count. Rule `((-floor(tick/240))*16) & 0xff` matches 33,891/54,799 official bytes
  (exact on the 8th-note grid; off-grid vocal notes differ). UD writes `(0xF - i%16) << 4` and works → likely cosmetic.
- `rbu-tools\scripts\beatmatch.js`: extract (official → .rbu), build (.rbu → donor BEATMATCH: in place if it fits,
  else best-fit into 0x7f800001 free space incl. the donor's vacated arrays when nothing else points into them,
  else grows the section — max 0x181800 = CONSTANTMOTION's size), verify. Self-tests: CRUSHCRUSHCRUSH round trip
  differs only in info bytes; CRUSH→CM and CM→CRUSH (sections grown to 0xe4800) verify exactly.
  Tempo and measure arrays are referenced by the word before them (+0x...24 → +0x...30): their old space is kept.
- Push It chart: source MIDI is a GM transcription (6 tracks, 150 BPM, 384 tpb). align.js: MIDI tick 0 = 9.180 s,
  real tempo 150.15 BPM (drift <4 ms per quarter of the song). autochart.py → RB-format PUSHIT.mid (480 tpb,
  23-beat lead-in 5×4/4+3/4 at 150.327 BPM) → mid2rbu (PitchedVocals=False) → ZPUSHIT.rbu → donor SHESNOTTHERE.

## 11. First chart test (2026-11-07) - song end, overdrive, audio level

- **Song end = root+0x124 (float ms)**: gameplay stops there. Official value = max over all 4 difficulties and tracks of
  `gem.ms + gem.ms_duration (u16 at gem+8)`, all 56 charts within 1 ms; same value in every section. Confirmed in
  dumpRAM_playing_pushit_medium: 142863.3 = SHESNOTTHERE's end, copied from the donor, so Push It stopped at 2:22.9.
  beatmatch.js build now writes it (and verify checks it).
- Gem layout (0x14): f32 ms, u32 tick, u16 ms_dur, u16 tick_dur, u16 (official: ~tick length, mid2rbu 0x7fff),
  u8 lane mask, u8 flags (0x08 base, |2 ignore sustain), u32 flags: bit25 overdrive, bit26 last gem of phrase,
  bit27 solo, 28-29 solo start/end. Official pattern: every gem in a phrase has bit25, the last one bit25+26
  (411990 none, 42673 inside, 12791 end). mid2rbu never sets bit26 (end event only matches zero-length notes) ->
  build marks the last gem of each bit25 run. Official phrases: about every 10-15 s, ~1 bar, same spots on all tracks.
- Audio level: official tracks about -21..-23 dB RMS each; the 5-track sum peaks about 0 dBFS (CRUSH: -15.4 RMS, +0.3 peak).
  Push It at -1 dB per stem summed to +7.7 dBFS peak (84k clipped samples) = the distortion. Re-made at -9.5 dB:
  sum -0.9 peak, -17.5 RMS, decoded from the real ATM.
- Push It MIDI starts at the band entry (9.18 s); the audio intro (kicks from 4.39 s, bass/guitar from 4.79 s) was missing.
  autochart --intro-stems now fills it from audio onsets; the lead-in puts the short bar first so bars line up.

## 12. Music stop = last song event (2026-11-07, dumpRAM_playing_pushit_medium_v2)

- Symptom: music and gems stopped at ~2:10, results only at the gameplay end (158 s).
- Song clock is frozen in the dump: root+0x22c == root+0x230 == 130300.4 ms, root+0x234 = tick 156530 (playing Crush
  dump: the two clocks differ by one frame). root+0x15c = current measure (81).
- root+0x28c is an inline object; root+0x2b0/+0x2b4 = pointer/count of 0x50-byte song events
  `{1, id 0x09f8xxxx, 0, -1, f32 tick, f32 tick, 0, 5, 0, 0, fill, fill, 0, 0, 0, 1.0f, -1, fill...}`
  (unused slots filled; SHESNOTTHERE 264 used of 1060, ids 0x00-0x5f). The **last event tick is where the music stops**:
  donor 156480 = 130.3 s on Push It's tempo map = the frozen clock. Official charts: last event = last beat + 480 in
  most songs, always 1-5 s after root+0x124; audio files run ~30 s longer.
  This is UnpluggedDeluxe's "a donor shorter than the custom ends abruptly" (it measures in ticks, not seconds).
- beatmatch.js build scales all event ticks so the last one = max(last beat + 480, last gem end + 240), capped at
  audio end - 0.3 s with --audio-seconds. Crush round trip unchanged.
- Other donor-only data still copied unchanged (meaning unknown, not shown to cause problems yet): root+0x28..0x4c
  per-track one-bar lists (5-7 entries, same in every difficulty), root+0x70 one 15.9 s segment, per-difficulty gem
  copies of the other difficulties, drum 16-entry one-bar lists (fills?), five extra tempo-map copies.

## 13. Audio must outlast the chart (2026-11-07, dumpRAM_playing_pushit_medium_v3_idlepart)

- With the music stop at 158.74 s and audio 159.04 s, the game went idle: clock frozen at 157714.5 ms (tick 189459),
  before root+0x124 (158.02 s) and the last event, so neither end condition was ever reached and no results appeared.
- The game stops the audio and its clock about 1.3 s before the end of the .ATM tracks. Official audio runs ~30 s
  past the chart. Customs need a silent tail: rbu-tools/scripts/padwav.js (Push It: +6 s, ATM 6825416 bytes, JB
  +0xF8 regenerated). Rule: last event and root+0x124 must both be at least a few seconds before the audio end.

## 14. Per-track copies of the tempo/measure maps (2026-11-07)

- Test v4 (6 s audio tail): results screen appears, but ~10 s of silence after the last notes (official DLC: 2-3 s).
  Official Crush: music fades at ~187 s, file is silent to 219 s, results 2-3 s after the last note, so the results
  timing doesn't depend on the audio file end.
- The donor image has more vectors {ptr, cap, size} with the same content as the main maps: 5 more tempo maps
  (+824c4, +83574, +83be4, +85034, +85cc4, vtable 0x08c56788 just before each) and 6 measure maps, all embedded in
  larger (per-track?) objects. One more vector (+86954) aliases the main tempo data: after an in-place write it still
  said 69 entries while our map has 2, so it read our 2 entries plus 67 leftover donor entries.
- beatmatch.js build now points all of them at the new maps (ptr, cap = size = n). Whether this fixes the 10 s delay
  is not confirmed yet. If not: dump during the silence and note the on-screen times.

## 15. Results wait for each track's end = last gem tick + gem+0xC (2026-11-07, v4 silent/results dumps)

- Both dumps: song clock stopped at 159874 ms (tick 192053, just after the last event 192000, so the music stop works).
  game obj +0x658 kept counting (202532 -> 232734); results appeared when the 4 lanes hid, ~20 s later.
- FUN_08a8764c (song start, called from song_play_state) per track t: last gem of the gem list
  (root+0xd4/+0xec) -> end tick = gem.tick + u16 gem+0xC -> measure lookup (FUN_088b0c64 on root+0x118) -> start of the
  next measure -> ms through the tempo map (root+0x114 vtable +8) -> game obj +0x164 (tick) / +0x168 (ms),
  stride 0x130; also copied to 0x08b7d6f0.. (stride 0x60). Crush: 187445.2 = its last bar end.
- gem+0xC: official = gem length in ticks (492341 of 492364 gems, within 2). mid2rbu writes 0x7fff -> +32767 ticks ->
  Push It track ends 186.6 / 183.4 s (reproduced exactly) = ~27 s of idle lanes. build now writes the tick length
  (mid2rbu's +0xA). New: 159.43 s, before the music stop (159.83 s).
- gem+0xA: official = ms_dur + 94 in 66 % of gems (meaning of the rest unknown); mid2rbu writes the tick length. Kept.
- UnpluggedDeluxe's end_song_thrd (force 0x08b7d58c = 1 when the tick stops) works around this same problem.

## 16. ATM hash source found (2026-11-07)

- `g_gameplay_root` in the hash check is the BEATMATCH root (0x096e9a80), so gameplay+0x324 = **chart root+0x324**.
- FUN_089f2648: standard CRC-32 (table at 0x08b452c0 = the standard 0xEDB88320 table, init ~0, final ~) of the first
  0x400 bytes of MUSIC/<name>/<name>.atm (raw file bytes, read through edat_file_helper).
- All 57 official songs: root+0x324 == that CRC in all 4 sections. The custom failed because the donor's value was copied.
- beatmatch.js build --atm <song.ATM> writes it -> the CWCheat `_L 0x202B2AA8 0x00000000` is no longer needed.
  (JB record +0xF4 is a different value; not used by this check.)

Confirmed in game (2026-11-07): Push It, rebuilt with `--atm`, loads and plays with the `_L 0x202B2AA8` cheat disabled.

## 17. Solos (2026-11-07, all official charts)

- Solo record (root+0x58+12t vector, 20 bytes, per difficulty): f32 start ms, f32 length ms, u32 start tick,
  u32 length ticks, u32 note count. Note count = sum of popcount(lane mask) over the solo's gems (364/364; the gem
  count matches only 223/364 because chords count once per note). mid2rbu writes the gem count.
- Gem flags: bit 27 on every gem of the solo, bit 28 on the first with low 16 bits = note count (364/364), bit 29 on
  the last with low bits 0. No other gem in 498369 has low bits set.
- Per-track block root+0x328+0x28t (10 words): end ms[4], count, start ms[4], count. Start = first solo gem ms,
  end = last solo gem ms + its u16 ms duration (364/364). Zero on 672/676 tracks without solos. Max 4 per track
  (UD writes start+duration, which is off by up to a bar).
- beatmatch.js build now keeps solos (recomputes counts, bits, block); BACKFROMTHEDEAD, BOYSAREBACKINTOWN round trips:
  solo records, gem flags and solo blocks identical to the originals. Not yet tested in game.

## 18. Gem +0xA = hit window in ms (2026-11-07)

- Per song, one of two rules: ms_dur + 94 (38 songs) or ms from the gem to tick + tick length + 60 ticks (19 songs);
  98.6 % of all gems; most of the rest are 0-length notes. mid2rbu writes the tick length; build now writes
  ms_dur + 94 where +0xA == +0xC (mid2rbu output), official charts untouched. musicEndTick now uses +0xC.

## 19. Plain-MIDI alignment pitfall (2026-11-07)

- align.js on all drum notes of the Push It GM MIDI gave 5.99 s (2 bars early); kick/snare only gives 9.18 s, but even
  then +-1 beat scores 99 % (repetitive riff). The ending resolves it: the MIDI's last hits land on the stem's last
  strong onset only at 9.18 s (157.43/157.63/157.83 s). align.js now picks among near-equal beat shifts by the end
  match and reports "ambiguous" otherwise.

Confirmed in game (2026-11-07): ZZCUSTOMDB (JB000901 + TEXT, no chart) supplies the song list; Push It rebuilt by
mksong.js (+0xA = ms_dur + 94, auto-aligned 9.183 s) is listed and plays normally, with JB000900/TEXT removed from ZPUSHIT.

## 20. JB number = days since 2008-03-07 (2026-11-07)

- Every official folder: JB number = days from 2008-03-07 to the day of its timestamp file (427 = 2009-05-08 ...
  571 = 2009-09-29). Packs ship cumulative databases (65, 75, 76, 88 ... 112 records; JB000556 already lists the
  four songs of the 2009-09-29 pack). The scanner reads the 6 digits after "JB" (atoi) and keeps the highest.
- mksong now names the custom database JB<day number> (JB006819 on 2026-11-07); content identical to JB000901.

## 20. JB number = days since 2008-03-07 (2026-11-07)

- Every official folder: JB number = days from 2008-03-07 to the day of its timestamp file (427 = 2009-05-08 ...
  571 = 2009-09-29). Packs ship cumulative databases (65, 75, 76, 88 ... 112 records; JB000556 already lists the
  four songs of the 2009-09-29 pack). The scanner reads the 6 digits after "JB" (atoi) and keeps the highest.
- mksong now names the custom database JB<day number> (JB006819 on 2026-11-07); content identical to JB000901.

Confirmed in game (2026-11-07): a custom listed in ZZCUSTOMDB but with its MUSIC folder removed is hidden from the
song list (no error). So one master database can serve several devices with different song folders.

## 21. JS files = the song database in a smaller layout (2026-11-07)

- JS<n>.STR.EDAT (every pack from 465; always 310560 bytes) has the JB header (count +0x30 = 112) and the same 112
  ids in the same order, in 0xD8-byte records (JB: 0x114), then ~390 name strings. Field map over all 112 records:
  JS 0x00..0x54 = JB 0x00..0x54 (flags +0x0C differ), JS 0x70..0xC0 = JB 0x7C..0xCC (year, vocalist, tiers);
  JS +0xD0/+0xD4 per-song, unmatched. ULUS10418 never opens JS files. (H) another game version/build.

Confirmed in game (2026-11-07): Push It rebuilt with separate vocals and "others" stems (others -> fill): missing
vocal notes mutes only the voice; fill keeps playing. JB006819 (day-number name) works.

## 22. Handlebars: solo, vocals from the stem, alignment by silence (2026-11-07)

- Plain GM MIDI, 71 BPM. align.js raw best 6.76 s; the 0 s shift (-8 beats) scored 98 % and the "last strong onset"
  (168.6 s, threshold too high for this mix) matched nothing. New rule: drop shifts that put MIDI drum notes where
  the drum stem is silent (> 45 dB below its loud level): 0 s puts 18 notes in the silent intro -> 6.767 s.
  Push It unchanged (9.183 s by the ending).
- autochart: parts from several tracks ("0,4"), --solo PART:START:END (note 103, end just before END),
  --vocal-events from vocalchart.js (642 syllables, 16th grid). Built chart: guitar solo 6.70 s + 13.50 s on all
  difficulties (8/16/32/32 notes), next guitar gem 20.29 s; solo block start 6767 ms. Not yet tested in game.

## 23. Loudness (2026-11-07)

- Confirmed in game: Handlebars guitar solo shows and works (start/end correct); both customs listed; vocals from
  the stem OK on the tested difficulty.
- Customs sounded quieter. loudness.js (BS.1770 LUFS of the 5 decoded tracks summed): 10 official songs -12.8..-15.3
  LUFS, peaks -1.3..+0.3 dBFS; Push It -17.7, Handlebars -19.5. mksong now: gain to -14 LUFS + sum-linked
  lookahead limiter (ceiling -1.5 dBFS; at -0.5 the decoded ATRAC sums hit +0.7 dBFS with 19-36 overs) + make-up
  pass. Decoded result: -14.1 / -14.1 LUFS, peaks -0.2 / +0.1 dBFS, 0 / 2 overs. Not yet tested in game.

## 24. "R stops responding" = R reported as held (2026-11-08, rbu-dumps/BUG)

- Input: FUN_088e35c4 calls sceCtrlReadLatch (stub 0x08b335a0) every frame; buttons = press & (~(break|release) |
  release & make) -> 0x08c28bf0; per-button words at *(0x08c28bf8)+0x400.. (0x20000001 = down; R = +0x41c), analog
  word +0x430. sceCtrl imports: ReadLatch 08b335a0, SetSamplingMode 08b335a8, ReadBufferPositive 08b335b0 (used by
  FUN_088facc8, startup/main loop), PeekBufferPositive 08b335b8, SetSamplingCycle 08b335c0.
- All 3 bug dumps (with and without customs): buttons = 0x200 (R held), R word set; both working dumps: 0. The game
  only acts on new presses, so a stuck "held" R blocks it. Source = emulator input (R mapped to keyboard W and pad R1
  in controls.ini), not the game or the custom files.

## 25. REAPER export/import (2026-11-08)

- Official vs ours (Medium-Expert): repeated gem 11-40% vs 46-95%, lanes ~25% each vs up to 90% in one, guitar
  chords 25-30% vs 0%, Easy official = only the 2 middle lanes, Hard/Expert distinct (ours identical for Push It).
- reaperpack.js: chart -> RB MIDI (480 tpb; guitar/bass base+0..3, drums base+1..4, vocals on PART KEYS; OD 116
  merged over difficulties and extended to the longest note, since mid2rbu marks a note only if it lies wholly
  inside; solo 103; taps <= 160 ticks). chartimport.py: tpb -> 480, PART KEYS -> PART VOCALS, checks.
- Round trips through mid2rbu (no post-processing) + beatmatch: Crush 6313/6313 gems identical; Back from the Dead
  and Toxicity 99.7% (taps > 160 ticks, 1-2 OD/solo edge gems); Handlebars 3945/3945.
- mksong: "chart" = edited MIDI used literally; every build writes rbu-tools/reaper/<FOLDER>/<FOLDER>_auto.mid + WAVs.

## 26. Screen effects ("old film" on TODAY) — 2026-11-08
- The engine has 22 full-screen effects, numbered in the dispatcher FUN_0892e814 (switch on the effect number). Names
  as debug strings at 0x08b37c2c.. (never loaded individually): Blur=0, ReallyBlur, Soften, Flash, Tint, Monochrome,
  Sepia, SpinColor, Eggcrate, Ripple, FishEye, BlurAndTint, BlurBulge, Vortex, Tunnel, Photonegative, Posterize,
  FilmGrain=0x11, FilmDust=0x12 (renderer FUN_0892c16c, built-in 32x32 dust texture), FilmScratch=0x13, FilmJitter,
  NightVision=0x15; 0x16 = VideoLines (probably).
- Effect manager: 64 slots x 0xE0 at 0x08c23c90 (+0xC4 effect number, +0xD0 state), drawn by FUN_08918db4 (called
  from the two scene renderers 0x08a74980 / 0x08a72f78). Free list head 0x08c27490.
- Presets are script commands registered by FUN_088bb664 via FUN_088b70e4(hash, signature, handler) into a table at
  0x08b89d04 (12-byte entries). FUN_089cdfc8 (hash 0xfa9de5b3) = OLD FILM: clears active effects, sets colour/tint
  parameters (FUN_089126ec, FUN_08913774), starts FilmGrain + FilmDust + FilmScratch. FUN_089cde50 (0xb983be23)
  starts effect 0x15. Other effect commands: 0x089ce330, 0x089ce650, 0x089ce7a4, 0x089ce8f8, 0x08913850,
  0x08911b60, 0x089119f4, 0x08913604, 0x0891339c, ...
- The hash column is read only at init (FUN_089d9414); commands are called by table index from the interpreter
  FUN_088b40f8. No command hash or name is stored in any disc file (all alignments, both byte orders), so scripts are
  compiled to indices (and/or compressed: the EBOOT contains zlib inflate).
- Not tied to the song: TODAY's id 0x44806475 is not in the EBOOT; its database record has nothing unusual.
- The chart (memory image) contains the song's Harmonix object directory: MidiParser objects (vtable 0x08c60710,
  directory "main") named events_parser, guitarist_fret/strum/pos, bassist_fret/strum/pos, guitarist_parser,
  bassist_parser, drummer_parser, drummer_kick_drum, lighting_parser, joypad_vibrate; each points to two DataArrays
  (+0x58/+0x5C). Strings songs/today, songs/today.mid, today_final3.
- Root lists: +0x2B0 = song events (0x50-byte records, id 0x0A0000xx interned per song, f32 tick x2, type word +0x1C:
  5 normal, 0x15 in 1-3 events of ABC/AQUALUNG/CHOPSUEY/LIVINONAPRAYER/MOVEALONG/SHOWMETHEWAY, 0 = unused slot);
  +0x2C0 = 45 events identical in every song. TODAY has no special event type.
- Test built: songs/ZTODAYFX = TODAY's chart + ATM copied unchanged (only root+0x324 ATM CRC filled, 16 bytes), to
  check whether the effect travels with the chart.
- RESULT 2026-11-08: ZTODAYFX shows the old-film effect exactly like TODAY -> the trigger travels with the chart file
  (or the ATM; both were copied). Parser objects/scripts are identical in TODAY and WOULD (same addresses, same
  fields), so the per-song part is in the chart's data lists. Next test: ZPUSHITFX = Push It (own audio, own gems,
  tempo, beats) built by beatmatch on TODAY's chart as donor (work/donors/TODAY/BEATMATCH.STR; donor events scaled
  to the new length). mksong "donor" now also accepts a file path.
- RESULT 2026-11-08: ZPUSHITFX (Push It on TODAY's chart as donor) shows the old-film effect at the start -> the
  trigger is in donor data that beatmatch build keeps (event lists / parser data), not in gems, tempo, beats or audio.
  Customs get the effect by using TODAY's chart as donor. Exact event not yet identified.
- FOUND 2026-11-08: effects are switched by the chart's SCRIPTS. root+4 -> {u32 count, ptr} table of script pointers
  (TODAY: 129). Script = bytecode run by the VM FUN_08945548: word = opcode (low byte) | length in words (byte 1) |
  operand (bits 16-27). Header opcode 1 (operand = length<<4 | 1), 0x16 = call command #operand (index into the
  0x08b89d04 table = registration order in FUN_088bb664, starting at 0) with (length-1) argument words, 0xff = end.
  Song event (root+0x2b0 record) +4 id = (0x200 + difficulty section id root+0) << 18 | script number: the event runs
  that script at its tick. Many events share a script. Most scripts post hashed messages: #28 FUN_089d9dc0 (game
  state/camera), #22 FUN_088bf940 (msg 0x66c5d9bd), #17-#21 (band members).
- Effect commands (index: handler, what it starts): #37 089cdc74 = END (clears effects 0/1/2, starts effect 2; every
  effect is followed by it); #38 089123dc = effect 0xd; #39 089cde50 = NightVision; #40 089cdfc8 = OLD FILM (colour
  matrix 089126ec + 08913774 + Grain/Dust/Scratch); #41 089ce330 = Grain/Dust/Scratch + 08913774 (no colour matrix);
  #42 08913850 = 08912c7c + 08913774; #45 08913604 = colour matrix + Flash; #46 089ce650 = effect 0xf
  (Photonegative); #47 0891282c = colour matrix only (black and white); #48 089ce7a4 = Sepia; #50 0891339c = Blur +
  colour matrix + Flash.
- Per song (Expert section, times = event times): TODAY #50 0:00.5 -> #37 0:15.0 (+ short ones 1:07.6-1:10.0,
  1:19.4-1:21.3, 2:43.5-2:45.5, 2:55.1-2:57.3); AQUALUNG #41/#50 intro, #40 3:24.8 (solo 3:28.8) -> #37 3:39.7, more
  later; CHOPSUEY #50 0:00.1 -> 0:18.0, #45 1:25.7 and 2:15.2; SHOWMETHEWAY #45 2:13.6, #46 2:46.3 (solo 2:48.0);
  MOVEALONG #47 2:32.2 (vocal solo 2:32.7) -> 2:48.1; LIVINONAPRAYER #47 0:13.9 -> 0:22.3. Matches the in-game
  observations. Event type 0x15 is unrelated.
- Test: out/MUSIC/ZTODAYFX patched (ids of events 1<->22 and 7<->28 swapped in all 4 sections, 16 bytes; original
  kept in the session scratchpad): effect should now run 0:43.7 -> 0:58.3 instead of 0:00.5 -> 0:15.0.
- RESULT 2026-11-08: patched ZTODAYFX shows the effect later, not at the start -> event id = script number confirmed.
- Effect commands, complete: presets #37-#52 (no arguments; all clear active effects first). Effect numbers from
  the helpers: 089126ec = Monochrome (5), 08912c7c = Tint (4), 089132b8 = FilmGrain (0x11) with 4 params,
  08913774 = effect 0x16 (lines/jitter). So #38 Vortex(0xd); #39 NightVision + 0x16; #40 Monochrome + 0x16 +
  Grain/Dust/Scratch; #41 0x16 + Grain/Dust/Scratch; #42 Tint + 0x16; #43/#44/#52 Blur presets; #45 Monochrome +
  Grain + Flash; #46 Photonegative; #47 Monochrome; #48 Sepia; #49 Grain/Dust/Scratch; #50 Blur + Monochrome + Grain
  + Flash; #51 Blur + Tint; #37 = clear + Soften (2). Parameterised low-level commands #162-#175 (08912518 stop by
  number, 089126ec .. 08913774; FUN_0891... range) are not used by any chart.
- scripts/fxchart.js (list/apply): adds effect calls to copies of the nearest events' scripts (new scripts in the
  largest free run, table grown in place after root+4's array; room for ~330 more), all 4 sections. Showcase song
  ZTODAYALLFX (15 effects, TODAY's own removed); DB rebuilt (117 songs).
- RESULT 2026-11-08: ZTODAYALLFX tested in game: all 15 effects show up at their times.
- mksong "effects" (inline list or JSON path) + "keepDonorEffects": runs fxchart apply after beatmatch build. If the
  script table can't grow in place (SHESNOTTHERE), fxchart moves the pointer array into free space and updates the
  holder (checked on 117 charts / 468 sections: only root+4's holder points at the array). Built-chart arrays
  identical with/without effects (2718 bytes differ, scripts/events only). Test song ZFXTEST (Push It, default
  donor: sepia 20-30 s, oldfilm 45-60, negative 90-100); DB 118 songs. CONFIRMED in game 2026-11-09 (relocated table works).

## 27. Cameras / choreography (2026-11-08, in progress)
- Script message commands (one hash argument): #22 FUN_088bf940 posts msg 0x66c5d9bd(hash) to the director at
  DAT_08bedc58: 32 distinct hashes over all disc charts. Each venue STREAMS file (and COMMON/EMPTY) has a table of
  {hash, ptr to 0x20-byte object, 0x0003ffff} with exactly these hashes (EMPTY.STR @0x160a54..) -> #22 = camera shot
  / venue cue by name. Events often send 2-3 #22 at once (shot + other cue?). #28 FUN_089d9dc0 (22 hashes; 2 of them
  in a 21-entry table at 0x08b4fd90.., 0x95e886e7 handled in code) = game/stage state; #17/#18/#19/#20 = messages to
  the four band members (12-14 hashes each, mostly shared: c8745357, f1f96f92, 3b6d4987 ...); #21 6 hashes.
- Hash names not recoverable: CRC-32 of 1M strings from EBOOT + all STREAMS/PRESET (lower/upper/raw) match none.
- fxchart.js now also places raw calls ({cmd, arg, at}) and strips commands (--strip 22,28); "calls" lists uses.
- Showcase ZTODAYCAM: TODAY with all #22 removed and the 32 hashes one at a time, ~6 s each
  (songs/ZTODAYCAM/timetable.txt); effects removed. DB 119 songs.
- 2026-11-09: ZTODAYCAM plays, cameras visibly differ from original TODAY (so #22 drives the camera); per-hash
  mapping not yet identified from the timetable -> TODO.
- 2026-11-09 usage stats over all official charts (Expert, scratchpad ac/cam1.js):
  - dc0222d9: 9197 uses in 94 songs, mostly alone, about every bar, and 1040 of them inside guitar solos. Likely a
    generic "cut to next shot".
  - c9b343db: 77 of 294 uses before the first note (song start).
  - 26109a24 and 22d2bb0f: 33 and 19 uses after the last note (ending).
  - db1c6c86, 8e3ffdbf, a52def2c and 0f3de073 co-occur (~70 % pairwise), often before the intro. Perhaps a
    non-camera cue (lights or crowd?).
  - 7350f761 (6 of 238 alone) and 068fbb83 (never alone) always come with another #22; 7350f761 fires while
    vocals are active 96 % of the time.
  - Rare: 57c9a404 (3 songs, at the end) and 094ec705 (once).
- Showcase ZCAMTEST: marker gems (lane = group, count = shot in group) at each shot change. See
  RBU_CUSTOM_SONGS.md §9 and songs/ZCAMTEST/checklist.txt.
- ZCAMTEST in game (2026-11-09): at each marker the camera focuses on the band member of the instrument the player
  is currently on (guitar -> guitarist, vocals -> singer, ...), so the same code looked different between runs.
  Hypothesis: the director picks the subject from the active track and #22 picks the shot style (or a random shot
  from a pool). Next: a run staying on one instrument, played twice, to see which codes are stable.

## 28. Lower difficulties from Expert (2026-11-09)
Measured on 112 official charts (55 disc + 57 DLC; tracks 0-3 = drums, bass, guitar, vocals; sections 0-3 = easy..expert):
- 95-99 % of Easy/Medium/Hard gems sit on an Expert gem tick (vocals 88-93 %) -> lower difficulties = Expert thinned.
- Kept share of Expert (all songs): drums 0.80/0.50/0.39, bass 0.81/0.49/0.37, guitar 0.76/0.46/0.36, vocals
  0.90/0.65/0.53 (hard/medium/easy); falls with density (quartile tables in reduce.py DENSITY).
- Gap p5 between gems: expert ~100-130 ms, hard ~140-155, medium ~230-280, easy ~300.
- Keep rate by position (drums/bass/guitar): beats 97/87/~70 %, 8ths 80/27/17 %, 16ths 45/~10/~10 %; triplets
  ~60/15/8 %; sustains >= 1 beat ~95 %. Off-beats: and-of-2 kept most; the 16th before a beat ~2x the one after.
- Lanes: Easy uses only mask bits 1 and 2 (outer bits fold inward: 0001->0010, 1000->0100); chords 0-5 %.
  Medium/Hard keep Expert lanes mostly (bass Medium 68 %, Hard 89 % same mask). Bass never has chords.
- reduce.py: priority = 10 x beat strength (downbeat 5, mid-bar 4, beat 3, 8th 2, pickup 16th 1.5, 16th/triplet 1)
  + sustain bonus (30 for >= 1 beat, 10 for >= half); greedy with min gap widened until <= target count, then
  topped up to the target with a smaller gap (hard 95 / medium 150 / easy 200 ms); ties in official off-beat order
  then golden-ratio spread. Weights tuned on half of the songs, checked on the other half (F1 0.715 held out; a gap
  bonus made it worse). Result vs official: counts 1.00-1.02x; same notes hard 82-85 %, medium 65-73 %, easy 53-64 %;
  Easy lanes same 63-78 % (old grid method: 21-38 %, Easy counts 0.55x, vocals almost nothing below Expert).
- autochart.py uses it (and thins Expert to >= 125 ms by priority, before mid2rbu's blind 120 ms pruner).
  mksong "reduce": true runs it on "chart"/Rock Band MIDIs. ZPUSHIT and ZHANDLEBARS rebuilt (old builds in scratchpad).

## 29. How official charts arrange gems (lanes) — 2026-11-09
Expert gems of the 112 official charts (mask bit 0-3 = lanes left to right; Easy only uses bits 1-2):
- Drums: bit 3 = kick (beats 1/3 32 % of its gems vs 2/4 11 %), bit 1 mostly snare (2/4: 41 %, beat 1 only 3 %),
  bits 0 and 2 = cymbal/hi-hat layer (bit 0 alone: 55 % on off-beat 8ths). Roles are a charter's choice per song: in
  some songs the snare backbeat sits on bit 2 ("K a b a K a b a"). Common chords: kick+cymbal on 1 (1001), kick+snare
  on 2/4 (1010), snare+cymbal on 2/4 (0110); 3-gem chords ~0.5 %; chords 21 % of gems.
  Busy cymbals: consecutive cymbal-only gems <= an 8th apart alternate bit 0 <-> bit 2 (two hands) 72 % of the time
  (11631 vs 4618 same). Kick share per song 7-58 %, cymbals from almost none to most gems (charter's liberty).
  Most common bars: "K a b a K a b a", "K S Kb S K S Kb S", "Ka . ab . Ka . ab .", "K a K a K a K a".
- Bass/guitar/vocals: consecutive gems on the same lane only 25/16/22 %; same-lane runs median 1, p90 2; steps
  +-1 ~17-19 %, +-2 ~15-18 %, +-3 ~4-5 % each way; lanes used evenly (~21-36 % each).
- Old autochart vs this: Push It drums 97 % on one lane (927 tambourine hits charted as hi-hat; kick note 96 is
  ignored by mid2rbu, so no kick gems at all); guitar 90 % on lane 0 with a 224-gem same-lane run (pitch-rank lanes).
- autochart now (FINDINGS-based): kick -> bit 3, snare -> bit 1, hi-hat/ride alternate bits 0/2 within runs, crash
  bit 0, toms bit 2 (high) / bit 0 (low); max 2 per tick, kick and snare first; hi-hat with snare dropped, with kick
  kept on beats 1/3; tambourine/cowbell/shakers ignored except in bars without any cymbal, where their 8th-grid hits
  become the cymbal layer. Pitched parts: lanes follow the melody (up = right; 1 lane up to a tone, 2 up to a fifth,
  3 beyond), each phrase (gap > 2 beats) starts from its first note's place in the phrase's range, repeated notes stay
  once then bounce. Vocals from the stem: runs longer than 2 bounce. Intro gems alternate two lanes.
  Result (expert): Push It drums kick 35 / snare 24 / cymbals 49 %, guitar longest same-lane run 3 (was 224);
  Handlebars cymbal runs alternate 132/134, steps of bass/guitar/vocals close to the official spread.

**§29 addendum: thumbs (2026-11-12).** Lanes 0-1 (red, yellow) are the left thumb, 2-3 (blue, green) the right.
User feedback on ZBEAUTIFULLY: bass phrases alternated red/yellow for ~10 fast gems, all on one thumb. Official Expert
charts, consecutive single gems close together:

| gap | part | same lane | one-thumb change | other thumb | longest run of one-thumb changes per song (p50/p90/max) |
|---|---|---|---|---|---|
| <= 150 ms | bass / guitar | 7 / 4 % | 5 / 5 % | 88 / 90 % | 0/1/2, 1/2/2 |
| <= 200 ms | bass / guitar | 13 / 8 % | 11 / 10 % | 77 / 82 % | 1/2/4, 2/3/5 |
| <= 250 ms | bass / guitar | 18 / 10 % | 12 / 13 % | 70 / 77 % | 1/3/4, 2/4/6 |

Cause: repeated notes bounced to the neighbouring lane (0<->1, 3<->2: same thumb). Fix in autochart: repeated notes
bounce to the other thumb (0/1 -> 2, 2/3 -> 1), and `spread_hands` moves every other gem of a run of more than 2
one-thumb changes between single gems <= 250 ms apart to the other thumb (0<->2, 1<->3). ZBEAUTIFULLY Expert bass
(<= 200 ms): one-thumb changes 43 -> 20 %, longest run 6 -> 2; guitar 22 -> 13 %, 3 -> 2; every difficulty <= 2
up to 300 ms.

## 30. Chords and held notes on bass/guitar (official stats vs autochart, 2026-11-09)

User feedback on autocharted ZHANDLEBARS: bass/guitar had too many held notes crowding the next gem, and guitar had no chords.
Measured over the 112 official charts (gem flag byte 0x8 = held, 0xa/0xb = short; mid2rbu holds a note longer than
64/192 beat = 160 ticks):

| | held % (p10/50/90) | chords % (p10/50/90) | max same-gem run (p50/p90) |
|---|---|---|---|
| guitar expert / hard / medium / easy | 1/6/17, 2/7/20, 1/6/21, 0/5/22 | 4/19/47, 4/26/54, 0/15/49, 0/0/28 | 6/15 |
| bass expert / hard / medium / easy | 0/5/25, 0/4/25, 0/2/21, 0/2/16 | ~0 at every difficulty | 6/16, Easy 8/64 |

- Held tails: median 240 ticks (an 8th); the gap after a held note p5 is ~120 ticks, median 240.
- Expert guitar chord masks: 10 (lanes 1+3) 5002, 6 (1+2) 4457, 5 (0+2) 4249, 9 (0+3) 1758, 12 (2+3) 1624; 3-gem chords ~2 %, and
  3 (0+1) almost never.
- Old autochart: every source note longer than 160 ticks was held up to 10 ticks before the next gem (Handlebars 88-90 %,
  Push It 98 %), and chords were dropped (Push It's MIDI has power chords on 410 of 559 guitar onsets; Handlebars'
  octaves on 212 of 218).
- New autochart:
  - Chords: 2+-pitch onsets keep their chord on beats, long notes and chord changes, at most 25 %.
  - Holds: only notes of a beat or more, at most 15 % per difficulty (longest kept). The gap after a held note follows
    the RBN rules (1/16 Expert/Hard, 3/16 Medium, 1/4 Easy).
  - Medium chords: only on downbeats and long notes.
  - Easy: runs longer than 4 bounce.
- Result:
  - Handlebars guitar: held 14 %, chords 26 % (shapes 5/9/10).
  - Push It guitar: held 15 %, chords 26 %, mostly shape 5 (a low-E chug riff).
  - Bass: held 7-15 %.
  - Max runs: 4 or less.

**§30 addendum: chords follow the music; 3-gem chords (2026-11-12).** User feedback: custom guitar charts lack
chords. Our Expert charts had 18-26 % chords (official median 19 %), but three of four were at autochart's 25 % cap,
so chord-heavy songs lost most of their chords, and there were no 3-gem chords at all. Official Expert guitar:
2-gem chords 19.6 % of all gems, 3-gem 0.42 %, 4-gem 0.002 % (practically never); Hard has no 3-gem chords.
3-gem chords: 342 in 40 of 112 songs (p50 4 per song with any, max 40), spread over the song (position p10/50/90
0.12/0.46/0.91), 49 % held, shapes lanes 1+2+3 (216) and 0+2+3 (121): always both right lanes. Chord share per song,
Hard / Medium / Easy relative to Expert (p50): 1.16 / 0.73 / 0. Chords are spread out: 8-second windows with a chord
p50 77 %, longest chord-free stretch p50 30 s. Chord gem bytes (flag byte, +0x10 word) of our charts match the
official ones, so the game shows them.
Changes: chord cap = 0.8 x the source's polyphonic share, 25-45 % (Push It 26 -> 47 %, Handlebars 26 -> 35 %);
song.json `autochart.chords` sets the share and promotes strong single notes when too few chords were detected
(stem songs); Expert 3-gem chords, one per 200 gems, on held/after-pause downbeat chords (3+ pitches first);
Hard/Medium keep the strongest chords up to 1.16x/0.73x Expert's share, at most 55 %, 3-gem chords become 2.

## 31. Vocals and drums: spacing and held notes (official stats vs autochart, 2026-11-09)

User feedback: the vocals still had held notes and gems too close together, unlike any official chart.
Official (112 charts, ms):

| | gems/s p10/50/90 | gap ms p5/25/50/75 | held % p10/50/90 | after a held gem, ms p5/50 |
|---|---|---|---|---|
| vocals expert | 1.26/1.75/2.39 | 134/209/294/446 | 12/23/42 | 298/380 |
| vocals hard | 1.11/1.60/2.25 | 155/236/331/501 | 13/27/47 | 306/384 |
| vocals medium | 0.80/1.12/1.58 | 234/358/499/750 | 18/34/49 | 319/468 |
| vocals easy | 0.43/0.84/1.33 | 310/472/671/1022 | 16/41/100 | 323/621 |
| drums expert / hard / medium / easy | 4.62 / 3.70 / 2.31 / 1.65 (median) | expert 96/148/186/246 | 0 | - |

Held vocal tails: median 322 ticks.

**Before:**
- Handlebars vocals (from the stem): 2.86 gems/s on a constant 16th grid (211 ms).
- Push It vocals: 2.43 gems/s, 88 % held.
- Both left about 100-110 ms after a held gem.
- Drums already matched density and spacing (4.2-4.3 gems/s on Expert), but Push It had a few held drum gems.

**Now:**
- reduce.py thins Expert vocals with a widening gap until at most 2.0 gems/s (EXPERT_MAX_NPS); score-based, so the weakest positions go first.
- autochart track_from applies the sustain profiles (SUS):
  - vocals: hold when the source is 240+ ticks, tail at least 200 ticks, at most 30 % held, at least 300 ms before the next gem;
  - drums: never held.

**Result:**

| | gems/s | held % | after a held gem |
|---|---|---|---|
| Handlebars vocals (rap: short syllables) | 1.54 | 5-10 | 394 ms+ |
| Push It vocals | 1.39 | 15-23 | 394 ms+ |

## 32. Bar lists must cover every gem (2026-11-10)

User report: at the end of songs some notes are visible but can't be played (switching to that lane fails).

Per part and difficulty, the chart has a bar list (bars{t}). Each record is 16 bytes:
- u32 first gem id;
- u32 end gem id (exclusive);
- f32 start ms and f32 end ms.

A gem exactly on a bar line belongs to the earlier bar.

**Official charts:** in all 1624 official lists, the last bar(s) end at the gem count, so every gem is in a bar.

**mid2rbu bug:** its BarBuilder leaves its index on the last gem when it runs out of gems. The bar holding the last
gem ends at n-1, and the following bars read n-1..n-1. In every custom (16 of 16 lists per song), the last gem of
each part was in no bar. The game uses these lists for each part, so a part counted as finished one gem early.

**Fix:** `beatmatch.js build` runs fixBarEnds, which moves those n-1 indices to n (by ms against the last gem). It
then checks that the bars cover all gems. ZMIRACLEMAN, ZPUSHIT, ZHANDLEBARS and ZHANDLEBARSFX were rebuilt and now
match the official rule.

Also added that day:
- song lead-in (first notes no earlier than about 3 s; official minimum 2.77 s);
- optional drumstick count-in, `"countIn": true` (countin.py).

## 33. Star thresholds live in the chart (2026-11-10)

User report: Miracle Man can't reach 5 stars (100/100/100 + 85 % drums = 4 stars), and gold looks impossible.

**The star meter.** FUN_088d3df0 walks six ints in the chart root: +0x30c, +0x310, +0x314, +0x318, +0x31c and
+0x320. These are the scores for 1, 2, 3, 4 and 5 stars and gold. Stars = i + the fraction of the way to the next
threshold; past gold the meter runs on to 2 x gold.
- +0x308 = the chart's maximum score.
- +0x304 = the 3-star value again.

**No in-game computation.** Every write to these offsets in the EBOOT (0x0891b590, 0x08a3033c, 0x08a30900 ...)
belongs to other objects (UI state, +0x30c = 3). The thresholds come with the chart. So every custom kept its
donor's (She's Not There: Expert gold 2,061,364; Miracle Man is far smaller).

**Official charts (448 song/difficulty pairs):**
- 2 and 3 stars are exactly 2 and 3 x the 1-star value.
- As a share of +0x308:
  - 1 star: 0.052 (p1-p99 0.028-0.067);
  - 4 stars: 0.473 (0.43-0.50);
  - 5 stars: 0.789 (0.77-0.80);
  - gold: 0.874 (0.863-0.880).
- The maximum isn't a simple function of the chart. Ace of Spades Easy and Medium have identical gems except lanes,
  yet differ by 7 %. Linear fits on notes, held notes, length and the root +0x2c..+0x54 values miss by about 6.6 %
  (p50) and 20 % (p90).
- Max / (Rock Band-style score: 25 per note, streak multiplier 1-4 every 10 notes, 25 per held beat), Medium-Expert:
  p5 7.5, p25 8.2, p50 8.7, p95 10.5.

**Now.** `beatmatch.js build` (writeStars) sets max = 8.25 x the model score x `"starsScale"` (song.json, default 1),
and the thresholds from the official shares.

Miracle Man Expert: max 996,806, gold 871,208 (donor 2,061,364). The user's old run (>= 4 stars under the donor's
thresholds) means their score was >= 1,117,517 on Expert (or >= 919,233 on Hard). That is above this estimate, so
this song likely needs starsScale > 1. Calibrate with real scores.
- 2026-11-11 user data (Expert, official DLC), phrase stats from the results screen:
  - Wonderwall 5 stars: bass 9/10, drums 10/12, vocals 7/8, guitar 11/11 = 37/41 phrases (90 %).
  - Crush Crush Crush gold: 11/11, 13/13, 13/14, 12/13 = 49/51 (96 %).
  - Thresholds: Wonderwall max 3,158,664 / 5 stars 2,494,028 / gold 2,759,882; CCC max 2,186,401 / 5 stars
    1,711,918 / gold 1,901,711.
  - Final scores asked for, to calibrate max vs real play.
- Per-part lists at root +0x28/+0x34/+0x40/+0x4c ({ptr, count, cap}), still copied from the donor in customs
  (Miracle Man = She's Not There's 7/7/5/7):
  - 20-byte records: f32 start ms, f32 length ms, u32 start tick, u32 length ticks, u32 flag 0/1 (1 on ~37 %).
  - Windows of about 1 bar, at the same starts on all parts, ending at that part's last gem in the bar, every 20-30 s.
  - 4080 of 4116 contain gems of the part; only 15 % contain a bit-25 (overdrive) run.
  - Counts 5-10 per part (CCC 10/10/10/6, Wonderwall 7/7/9/5); the user's "phrases attempted" are 8-14, so they
    are not simply the phrase list.
  - Meaning still open (Unplugged phrase / bonus sections?). Needs an in-game check; then generate them for customs.
- Scoring rules seen in game (user, 2026-11-11):
  - a completed phrase = 1000 points x multiplier;
  - the multiplier rises with consecutive completed phrases up to 5x, and a failed phrase resets it to 1x;
  - with overdrive the multiplier reaches 11x on any instrument;
  - gold usually arrives with about 5 phrases left in a clean, multiplied run.
- What is not a phrase:
  - Bit-25 runs per part: CCC 12/12/11/9 = 44 and Wonderwall 8/8/10/7 = 33, but the user attempted 51 and 41
    (CCC vocals 14 > 9 runs).
  - The info byte per gem: high nibble = -(16th position in the bar), timing only.
  - The root +0x28 lists: 10/10/10/6 for CCC.
- About one phrase every 3.6 s (CCC), i.e. about 2 bars, with parts taking turns. Phrases are probably cut by the
  game from the notes; the code is not found yet.
- Phrases are built by the game at run time, not stored in the chart.
  - EBOOT sources: ../src/rock/beatmatch/PhraseFinder.cpp, BarPhraseCapturer.cpp, PhraseCapturer.cpp, PhraseDB.cpp.
  - Config symbols: capturer, phrase_slot, autoplay_accuracy, PhraseFinderType, PhraseCapturerType.
  - Debug lines: "phraseMeasure: %d", "leadMeasure: %d", "capture queue: %c %d %c %d ...".
  - Result strings: <Inst>Captured, <Inst>PhrasesPercent, phraseScore.
  - Each BEATMATCH image also holds the game's symbol table (min/max_bar_spacing, min/max_length, max_gap ...),
    but not the values next to the names.
- In game (user): the active phrase has 2 grey lines on both sides of the lane. Completed without a miss -> the
  next phrase goes to another instrument. Failed -> it stays on that instrument until completed. An instrument
  left with an unfinished phrase goes silent in the mix.
- Root +0x28 lists are not overdrive lists either: 48 % of entries overlap a bit-25 run, and 38 % of runs overlap
  an entry. Purpose still open.
- Consequence: customs get phrases from their own bars and notes automatically (the BarBuilder fix of §32 matters).
  Only the star thresholds (§33) need chart data; calibrate them with real final scores.
- Calibration from play (2026-11-11). Miracle Man, Expert, with the estimated thresholds (scale 1):
  - Result: gold, with bass 3/3, drums 5/6, vocals 13/13, guitar 14/14 (35 of 36 phrases).
  - Gold came with about 17 phrases left (after about 53 % of them), which felt too easy. On official songs gold
    comes with about 5 left.
  - So a clean run ends near gold / 0.53 x 0.9, i.e. scale about 1.65-1.7. The earlier donor-threshold run (4 stars,
    so 1.12-1.86 M) agrees.
  - Max / model for Miracle Man is about 13.6 (official 7.5-10.5): an outlier.
  - Bar counts (per part, or the song's) don't improve the official fit (held-out p50 7.3-8.0 %).
- Rule of thumb (RBU_CUSTOM_SONGS.md): if gold arrives after a fraction f of the phrases,
  new starsScale = old x 0.9 / f.
  Miracle Man: starsScale 1.65 -> Expert max 1,644,730, 5 stars 1,297,692, gold 1,437,494.
- Wonderwall Expert (user, 2026-11-11):
  - Score 2,928,956 = 92.7 % of its max 3,158,664, with 40/42 phrases (bass 9/9, drums 9/10, vocals 10/10, guitar
    12/13).
  - Gold (2,759,882 = 0.874 x max) came with 2-3 phrases left. That is the target behaviour.
  - User's point rule: 50 per note at 1x, 100 for a 2-note chord.
- New max model in beatmatch build (chartMaxScore):
  - max = a x notes (all parts) + b x overdrive phrases (bit-25 runs, all parts) + c x song length (s), per
    difficulty, fitted on the official charts (tutorials T01-T15 left out as Easy outliers);
  - Easy [600.1, 2428.6, 1588.8], Medium [594.8, 2142.7, 2200.8], Hard [462.2, 5519.9, 4548.8],
    Expert [598.5, 3840.0, 4303.7];
  - held-out error p50 6-7 %, p90 11-14 % (the note-only model: p90 17.8 %).
- The time term matters for sparse songs (phrase bonuses come with time). Miracle Man: the note-only model gave
  1.07 M, the new model 1.36 M; play showed about 1.6 M, so starsScale 1.2 keeps the user-tuned gold (1,428,280).
- Push It and Handlebars got higher (harder) thresholds than with the old model (Expert gold 1.89 M and 1.78 M).


**§33 addendum, Handlebars play test (Expert, starsScale 1.0):** 1,681,341 = 5★, not gold (gold 1,781,695, max 2,038,553), with 25/26
phrases and every part at 100% except guitar at 85%. That is only 82.5% of the predicted max, so the model overestimates this song. Handlebars
is slow (71 BPM, 62 bars in 209 s), so it has few phrases for its length, and the length term over-counts phrase bonuses. Bar count
(user phrase counts ≈ bars / 2.1–2.4: Crush 107/51, Wonderwall 96/42, Miracle Man 75/36, Handlebars 62/26) does not beat length on
the official stored maxima (held-out p90 16–17% versus 11–14%), so the model is unchanged. Slow songs get a manual starsScale: Handlebars
and the FX copy use 0.89 (Expert max 1,814,312, 5★ 1,431,492, gold 1,585,709).


## 34. Building without DLC: the disc's song list and charts (2026-11-13)
Question: can customs be built without the official DLC folders SHESNOTTHERE (chart container) and
YOURENOROCKNROLLFUN (song-list base)? The PSP store no longer sells the DLC, so many owners have only the disc.
- **Disc song list** = `PSP_GAME/USRDIR/STREAMS/JUKEBOX.STR` (§1: the game falls back to it when DLC is off or the
  scan fails). Same format and size as a DLC JB (0x1d580 bytes, 300 x 0x114 records): count 55 (the disc songs,
  flags 0x0c, +0xF4 hash 0). The newest DLC JB (JB000571, 112 songs) = these 55 + 57 DLC; its disc records differ from
  the disc file only in name-pool offsets (+0x04/+0x08) and text ids (+0x1C..+0x28), plus +0xB4 on 10 records.
- **Disc song-list text** = `PSP_GAME/USRDIR/TEXT/STR_<LANG>_JUKEBOX.TXT` (EN FR GE IT SP; plain UTF-8, same layout as
  the DLC `STR_<LANG>_jukebox(2).txt.EDAT`, which are two identical copies): 362 entries = language + 55 songs x 3 +
  196 labels. The DLC text (533) = the same first 166 entries + 57 DLC songs x 3 + the same 196 labels. So every
  label id (difficulty, era, genre, sort letter) is lower by 3 per missing song: id = DLC id + (entries - 533).
  This also matters for older DLC packs (fewer songs in their list); mkjukebox assumed the 112-song layout before.
- **Disc charts** = `PSP_GAME/USRDIR/MUSIC/<SONG>/BEATMATCH.STR`: same header as DLC charts (01 00 00 00 80 48 ...).
  Chart container chosen for disc-only builds: MRBRIGHTSIDE (no screen effects; 122 scripts / 255 events, closest to
  SHESNOTTHERE's 119 / 264). Disc charts with no effects: ABC, ALIVE, COMEOUTANDPLAY, IWASWRONG, KILLINGJAR, KRYPTONITE,
  MESSAGEINABOTTLE, MRBRIGHTSIDE, PINBALLWIZARD, ROCKYOURSOCKS (+ the tutorials T01-T15). Painkiller is on the disc.
- **Record template without DLC:** the disc list has no DLC record to copy, so mkjukebox copies the last disc record
  whose +0xB4 is not the 9999999 sentinel (record 40), sets flags 0x8c and +0xF4 = 0. +0xB4 and +0xCC stay unknown.
- Every DLC pack folder carries a chart and a JB; an older pack's JB lists only the DLC released up to then. The game
  shows only the newest JB, so with partial DLC the base is the user's newest JB (game.js "partial" mode).
- Tools: `scripts/iso.js` (ISO 9660 + CSO reader, no extraction), `scripts/game.js` (detection, modes, disc cache in
  rbu-tools/cache). Built and verified in all three modes on a copy of Miracle Man (labels resolve to the right text
  in every language). Mode labels: Base Game only / Base Game + Incomplete DLC / Base Game + Complete DLC (complete = every
  DLC record of the newest song list has its folder). Onboarding detection of both other modes confirmed by the user
  (2026-11-13); in-game play of disc-only builds still to test.
