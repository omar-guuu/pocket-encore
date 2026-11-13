# Pocket Encore: custom songs for Rock Band Unplugged (PSP, ULUS10418)

Tools to build custom songs that the game loads natively on PPSSPP: audio (.ATM), chart (BEATMATCH.STR.EDAT),
preview and the song database, from stems and an optional MIDI. **Pocket Encore** is the all-in-one app: song library,
details, stems and their quality, builds, and a chart/effects editor with playback, a highway preview and record mode.

> **Disclaimer:** Pocket Encore is an unofficial fan project. It is not affiliated with, endorsed by or connected to
> Harmonix, MTV Games, Electronic Arts, Sony Interactive Entertainment or any other company behind Rock Band or the
> PSP. Rock Band and Rock Band Unplugged are trademarks of their respective owners.
>
> You need your own legally obtained copy of Rock Band Unplugged (US, ULUS10418), and its DLC if you want to keep the
> DLC songs listed. This repository contains no game files, and Pocket Encore only reads the files of your own copy
> on your own computer. Do not share game files, and only use audio you have the right to use: songs built from
> copyrighted recordings are for personal use only.

## Start

1. Install the pieces the tool needs (none of them are ours):
   - [Node.js](https://nodejs.org/en/download) (LTS)
   - [Python 3.12](https://www.python.org/downloads/windows/), then `pip install mido numpy miniaudio`
   - [mid2rbu](https://github.com/maodus/mid2rbu) (`git clone` it, e.g. into `rbu-tools\mid2rbu`)
   - `at3tool.exe`, Sony's ATRAC3 encoder (from the PSP SDK), e.g. into `rbu-tools\at3tool`
   - **Rock Band Unplugged** (US, ULUS10418): its disc image (ISO or CSO), and its DLC if you have it (in
     `PSP/GAME/ULUS10418/MUSIC` on the PPSSPP memory stick). With the DLC, songs are built on it; without it, on the
     disc's own files. Pocket Encore does not include any game files.
2. Double-click `pocketencore.cmd` (or run the installer from `installer\`). Pocket Encore opens in its own window. The
   first time, a welcome and setup finds your game and the tools (saved in `settings.json`; delete it to see the
   setup again); later, **Setup** (top right) changes the paths.
3. **New song** → pick the stems (WAV/MP3/FLAC/OGG) and optionally a MIDI → **Build**. Copy the song folder and
   `ZZCUSTOMDB\` from `out\MUSIC` to the memory stick's `MUSIC` folder.

Everything can also be run from the command line: `node scripts\mksong.js songs\ZMYSONG\song.json`.

## Layout

| Folder | What |
|---|---|
| `pocketencore\` | Pocket Encore (local web app: `server.js`, `public\`) |
| `scripts\` | the pipeline: `mksong.js` runs everything; see the table in the guide |
| `songs\<ZNAME>\song.json` | one file per song, the single source of truth (plus `chart.mid` when gems were edited) |
| `docs\RBU_CUSTOM_SONGS.md` | the guide: file formats, pipeline, options, what was tested |
| `docs\FINDINGS.md` | reverse-engineering notes on the game's formats and behaviour |
| `installer\PocketEncore.iss` | Inno Setup script for the installer |
| `out\`, `reaper\`, `songs\*\build\` | generated (not in the repo) |

## Rules

- Never commit game files, stems or anything decoded from the game; `.gitignore` keeps them out.
- The song's `song.json` stays the source of truth; Pocket Encore and the scripts both read and write it.

## License

Pocket Encore and its scripts are released under the [MIT License](LICENSE). The license covers only the code in this
repository: not the game, its files or its DLC, and not the third-party tools it works with (Node.js, Python and its
packages, mid2rbu, at3tool), which keep their own licenses and are downloaded separately.
