# Changelog

What changed in each version of Pocket Encore. The newest version is first.

## Unreleased

### Updates
- Pocket Encore checks GitHub for a newer release once a day (only a request for the latest release; nothing about
  you is sent). When there is one, **Update available** appears next to the version, with the release notes and
  **Download and install** / **Remind me later** / **Skip this version**.
- **Download and install** is one click: Pocket Encore downloads the installer into Downloads, checks it against the
  release's SHA-256, installs it without the wizard, starts again on the same port, and the open window reloads by
  itself as the new version. A download that doesn't match the checksum is deleted and nothing is installed.
- Setup → **Updates**: turn the daily check on or off, and **Check for updates** (also on the Help page). A copy run
  from its git folder is told to `git pull` instead.
- When Pocket Encore stops (closed, or restarting for an update), the window says so and reloads by itself when it is
  back, unless that would lose unsaved changes.

### Installer
- Upgrading: a running Pocket Encore is asked to quit first (it closes cleanly); the program folders are emptied
  before the new files are copied, so files a newer version dropped don't linger; songs, settings, output and the
  window's saved preferences stay. Installing an older version over a newer one asks first.
- `node scripts\mkinstaller.js` builds the installer with the version from `pocketencore\version.json` (the only place
  it is set) and refuses when this changelog has no section for that version; `--publish` also creates the GitHub
  release with the installer and the changelog section as notes.

## 0.3 Beta (2026-11-15)

### Themes
- Dark and light themes. The theme menu at the top right offers **Auto** (follows the Windows light/dark setting, also
  when it changes), **Light** and **Dark**. The choice is remembered and applied before the page draws, with no flash.
- Everything follows the theme: pages, forms, dialogs, messages, badges, help and the chart editor. The lane colours
  stay the game's, and the highway preview stays dark in both themes, like the game's screen.
- Text colours meet the WCAG AA contrast ratio (4.5:1) in both themes; the dark theme's red was brightened to meet it.

### Controller (chart editor)
- Xbox and PlayStation controllers work in the editor. Other controllers show "Not supported" and are ignored.
- The game's layout:

  | Action | PlayStation | Xbox |
  |---|---|---|
  | Red gem | D-pad ← | D-pad ← |
  | Yellow gem | D-pad ↑ | D-pad ↑ |
  | Blue gem | ○ | B |
  | Green gem | △ | Y |
  | Part to the left / right | L1 / R1 | LB / RB |
  | Overdrive | ✕ | A |
  | Play / pause | Options | Menu |
  | Record on/off | Share | View |
  | Loop on/off | □ | X |
  | Undo / redo | L2 / R2 | LT / RT |
  | Delete the selected gems | D-pad ↓ | D-pad ↓ |
  | Back to the start | L3 | LS |

  Sticks: left ←/→ moves the playhead by the snap, right ↑/↓ changes the difficulty, right ←/→ zooms.
- Gem buttons pressed together make a chord (one undo step). Held while playing, a gem button makes a held note as
  long as the press. While recording, Overdrive starts a phrase and a second press ends it; otherwise it marks a
  phrase over the selected gems.
- The **🎮** button in the editor shows the connected controller and opens the Controller dialog: the layout for both
  controllers, **Change** to remap an action (a button already in use swaps), **Reset to the default layout**, and a
  timing offset with **Calibrate…** (8 clicks to press along to).

### Chart editor
- Keys 1–4 held while playing make held notes too, and keys pressed together make a chord.
- Pressing a lane where a gem already is selects that gem.

## 0.2 Beta (2026-11-14)

### Confirmations and messages
- Confirmations use the app's own dialog with buttons named after what they do (for example **Delete pack** /
  **Keep pack**) instead of OK/Cancel.
- Error messages say what failed first ("Couldn't save the pack: …"); rule messages are written out in full.
- The song list shows "No songs yet" with a **+ New song** button, and "No songs match …" when the filter finds nothing.
- Shorter placeholders on the New song form, with help lines under Folder, Title and Year (and Year on Details).

### Unsaved changes
- Every page with a form (chart editor, Details, song.json, New song, pack editor, Setup) asks before its changes are
  lost: **Save and leave** / **Discard changes** / **Keep editing** (New song: **Discard new song**). This covers the
  Songs link, the logo, the song tabs, the Back button and closing the window. A failed save keeps you on the page.
- **Build** / **Rebuild chart** with unsaved changes asks **Save and build** / **Build without changes** / **Cancel**.
- A finished build no longer reloads the page over unsaved changes; **Back to automatic chart** offers to save them first.

### Packs
- A built pack that is renamed shows **renamed since build**; saving the new name offers to rebuild it, which renames
  its folder in `out\PACKS` and removes the old one. Unnamed packs keep the name they were built with.

### Chart editor
- Mute (**M**) is purple and solo (**S**) is red.
- **Loop**: drag along the time ruler to mark a section, or select gems and press **K** (whole bars around them). It
  repeats without a gap, with ticks and record mode; its edges can be dragged on the ruler.
- **Gem shapes** above the chart, taken from the official charts: guitar and drums 2-gem chords and, on Expert only,
  3-gem chords; bass two gems in a row (bass has no chords); none for vocals. Drag one onto its part, click it and then
  click the part, or press **Shift+1–7** at the playhead. A shape replaces the gems already at that time.
- Chords are marked with a thin orange line between their gems, in the chart and in the highway.

## 0.1 Beta (2026-11-13)

First public version.

- **Pocket Encore**, an all-in-one local app: song library, song details, stems and their quality, builds with a live
  log, and the song.json editor.
- **New song** form with drag and drop of up to 5 stems (assigned by file name) and an optional MIDI; without one the
  chart is made from the stems.
- **Chart editor**: the four parts over each stem's waveform with playback, highway preview, record mode (keys 1–4),
  overdrive and solo phrases, a Tempo tool, undo, a comparison with the automatic chart, screen effects, and live
  chart-rule warnings that can be dismissed.
- **Automatic charts**: chords follow the music (3-gem chords on Expert), fast alternations are shared between both
  thumbs, and a "Guitar chords (%)" setting.
- **Game modes**, checked at every start: Base Game only (from the disc image), Base Game + Incomplete DLC, and Base
  Game + Complete DLC.
- **First-time setup** that finds the game and the tools, and a **Setup** page listing what is missing and where to
  get it.
- **Song packs**: sets of songs with their own song database, to switch what the game lists without rebuilding songs.
- In-app **Help** pages, the full guide (`docs\RBU_CUSTOM_SONGS.md`), the installer script, and the MIT License.
