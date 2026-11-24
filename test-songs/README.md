# Archived test songs

Test and research songs kept for later. They are outside `songs\`, so Pocket Encore doesn't show them and the
song database (`ZZCUSTOMDB`) doesn't list them. Each folder keeps its `song.json` and notes, its work files
(`build\`) and, where it was built, the game folder it had (`MUSIC\<FOLDER>\`, from before the archive).

| Folder | What it tested |
|---|---|
| ZTODAYFX | Today's own chart and audio, effects untouched (screen effects, FINDINGS §26) |
| ZTODAYALLFX | every preset screen effect on Today (`effects.json`) |
| ZTODAYCAM | the 32 camera shots on Today (`timetable.txt`, FINDINGS §27) |
| ZCAMTEST | camera shots on Handlebars' audio with marker gems (`checklist.txt`, `make.py`) |
| ZFXTEST | effects on Push It with the default donor |
| ZPUSHITFX | Push It on Today's chart as donor, with effects |
| ZHANDLEBARSFX | old film over the guitar solo and a vocal solo (first vocal solo in a custom) |
| ZPUSHITANIM | first band animation test: guitarist/bassist lists (FINDINGS §37-38); old patch, no mic fix |
| ZHANDLEBARSANIM | tambourine test (FINDINGS §39); old patch, no mic fix |

Game-derived files in these folders (charts, audio) are for personal use only and are never committed.

To use one again: move its folder back into `songs\`, then Build it (or Rebuild chart) in Pocket Encore so the song
database lists it again. ZTODAY* and the two ANIM songs were made by hand and can't be rebuilt; for those, copy
`MUSIC\<FOLDER>` to the memory stick yourself and rebuild the database. Paths inside the song.json files still work
from here (same depth as `songs\`).
