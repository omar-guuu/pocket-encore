# rbu-tools: custom songs for Rock Band Unplugged (PSP, ULUS10418)

Tools to build custom songs that the game loads natively on PPSSPP: audio (.ATM), chart (BEATMATCH.STR.EDAT),
preview and the song database, from stems and an optional MIDI. **RBU Studio** is the all-in-one page: song library,
details, stems and their quality, builds, and a chart/effects editor with playback, a highway preview and record mode.

For personal use with your own copy of the game and its DLC. No game files are in this repository.

## Start

1. Install the pieces the tool needs (none of them are ours):
   - [Node.js](https://nodejs.org/en/download) (LTS)
   - [Python 3.12](https://www.python.org/downloads/windows/), then `pip install mido numpy miniaudio`
   - [mid2rbu](https://github.com/maodus/mid2rbu) (`git clone` it, e.g. into `rbu-tools\mid2rbu`)
   - `at3tool.exe`, Sony's ATRAC3 encoder (from the PSP SDK), e.g. into `rbu-tools\at3tool`
   - the game's `MUSIC` folder on your PPSSPP memory stick, with the official DLC `SHESNOTTHERE` (donor chart) and
     `YOURENOROCKNROLLFUN` (song list)
2. Double-click `studio.cmd` (or run the installer from `installer\`). The studio opens in its own window; its **Setup**
   page shows what is found and where to set the paths (saved in `settings.json`).
3. **New song** → pick the stems (WAV/MP3/FLAC/OGG) and optionally a MIDI → **Build**. Copy the song folder and
   `ZZCUSTOMDB\` from `out\MUSIC` to the memory stick's `MUSIC` folder.

Everything can also be run from the command line: `node scripts\mksong.js songs\ZMYSONG\song.json`.

## Layout

| Folder | What |
|---|---|
| `studio\` | RBU Studio (local web app: `server.js`, `public\`) |
| `scripts\` | the pipeline: `mksong.js` runs everything; see the table in the guide |
| `songs\<ZNAME>\song.json` | one file per song, the single source of truth (plus `chart.mid` when gems were edited) |
| `docs\RBU_CUSTOM_SONGS.md` | the guide: file formats, pipeline, options, what was tested |
| `docs\FINDINGS.md` | reverse-engineering notes on the game's formats and behaviour |
| `installer\RBUStudio.iss` | Inno Setup script for the installer |
| `out\`, `reaper\`, `songs\*\build\` | generated (not in the repo) |

## Rules

- Never commit game files, stems or anything decoded from the game; `.gitignore` keeps them out.
- The song's `song.json` stays the source of truth; the studio and the scripts both read and write it.
