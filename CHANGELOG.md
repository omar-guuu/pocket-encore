# Changelog

What changed in each version of Pocket Encore. The newest version is first.

## 0.5.1 Beta (2026-11-24)

### Effects & Band Anims tab
- New **Effects & Band Anims** tab next to **Chart**: screen effects and the band's animations on the song's time line,
  with playback. **Screen effects** have one track for the whole song (an effect covers the whole screen, one at a
  time); double-click to add one, drag to move it or change its length. A preview box shows the effect at the
  playhead (in-game screenshots to come).
- **Singer props**: Automatic (the default) puts the prop in solos where nobody sings and in instrumental parts of 8
  bars or more; choose Tambourine, Cowbell, Hand clapping or None. **My own sections** lets you move, resize, add and
  delete them, each with its own prop. This replaces the Singer prop setting on Details.
- The singer's mic and the guitarist's and bassist's hands are shown too. They follow the song's notes, so they are
  read-only (🔒) in **Easy Edit Mode**, the default. **Enable Advanced Edit Mode** (it asks first) unlocks them: move,
  add or delete mic changes, or pick another clip for one note. Help → Easy and Advanced Edit Mode.
- Screen effects now start and end exactly at their times in game. Before, each one moved to the nearest chart event,
  which could be seconds away. Rebuild the chart of songs with effects to get this.
- The Chart tab (was "Chart & effects") keeps the gems, overdrive and solos; its effects lane moved to the new tab.

### Band animations
- The guitarist's and bassist's hands now follow each song's own notes, the way they do in official songs. Before, a
  custom song kept the hand movements of the song its chart was built on, so the band moved slowly and out of time.
- The singer now raises the microphone before each vocal part and lowers it in long breaks, following the song's own
  vocals. Before, the singer could sing with the microphone in their lap.
- In guitar solos where nobody sings, and in instrumental parts of 8 bars or more, the singer picks up a prop and
  plays it on the beat (choose the prop on the Effects & Band Anims tab). Rebuild the chart of existing songs to get all of this.

### Memory stick
- New **Memory stick** page (top right): what is on PPSSPP's memory stick and on a PSP connected by USB, song by song:
  installed, older build, not copied, and whether the game lists it or hides it. It also says which song database the
  game uses, and warns when that is another build's (someone else's pack), an older one of yours, or when its names
  come from the wrong TEXT files. An unplugged PSP shows its last check. The song list shows a one-line summary per
  memory stick and a badge on each song.
- **Install…** copies the ticked songs and your song database to a memory stick, after showing what will change
  (songs that would end up hidden, older databases that go). Each song folder and `ZZCUSTOMDB` is replaced as a whole;
  nothing else is touched. Packs have their own **Install…** button. Copying by hand still works.
- Every build writes a small `PESONG.JSON` in each song folder (details and a build code) and a `PEDB.JSON` in
  `ZZCUSTOMDB` (which songs it lists). The game ignores them. Songs built before this version are still recognised
  by their files' sizes and dates.

### Songs from other people
- **Import songs** (Memory stick page): adds songs from someone else's pack to your library, with their chart and audio
  as shipped. Details come from the song's `PESONG.JSON`, or from the pack's song database and its TEXT. A song that
  someone else's database put on your memory stick can be imported straight from there. Imported songs can be renamed
  and re-tiered; their gems and audio can't be edited. Building one only puts it in your output and your song database.
- Your song database number is now raised above any other build's database seen on your memory sticks, so the game
  always uses yours. Before, two Pocket Encore users building on the same day made databases with the same number, and
  copying someone's pack over your `ZZCUSTOMDB` hid all your songs and gave theirs your songs' names.
- Packs: `pack.txt` tells Pocket Encore users to import a pack instead of copying its `ZZCUSTOMDB`, and every song in a
  pack carries its `PESONG.JSON`, so it can be imported with all its details.

## 0.4.3 Beta (2026-11-15)

### Chart editor
- The toolbar is grouped (**Playback**, **View**, **Edit**, and the controller with Save) and fits on one line in the
  app's window; a narrower window wraps whole groups. Undo and redo are ↶ ↷, the controller button shows 🎮 and the
  connected controller, and the **Ticks** checkbox moved to the mixer, next to the Ticks volume.
- **All / Focus / Only** (or **F**, or double-click a part's name): Focus enlarges the selected part (bigger lanes and
  gems) and shrinks the others to thin strips with their gems as small marks (click a strip to switch); Only shows the
  selected part alone at full height. The choice is remembered.
- Overdrive and solo bars can be dragged: an end makes the phrase or solo longer or shorter, the middle moves it,
  snapped to the grid. A phrase stops at the next phrase; a solo stops at the next solo of any part. One undo step.
  The overdrive bar is thicker, and both show handles at their ends on hover.
- The chart-rules banner starts with a warning triangle (red when one of them is a problem). It keeps the same height
  whatever it shows, so the chart below no longer moves when a rule appears or goes; **Show all** opens the full list
  over the chart. When every rule is dismissed it says how many are dismissed, with the triangle in yellow, instead of
  "✓ Within the official charts' ranges".

### Controller
- New default layout for two gem buttons: **Y / △ is blue** and **B / ○ is green** (red and yellow stay on D-pad ← and
  ↑). If you changed the blue or green button in the Controller dialog, your choice stays; **Reset to the default
  layout** gives the new one.
- **Overdrive** and **Solo** buttons in the toolbar: they turn an overdrive phrase or a solo on or off over the
  selected gems, like the O and L keys.
- While recording, **O** (or the **Overdrive** button) starts an overdrive phrase at the playhead and a second press
  ends it, like the controller's Overdrive button. The button stays lit while a phrase is open.
- Only one part can have a solo at a time: a solo that would overlap another part's solo isn't added, and the editor
  says which part already has one. The chart checks also warn about overlapping solos that come from a MIDI.

## 0.4.2 Beta (2026-11-15)

### Accessibility
- Every form field has a name for screen readers: the labels are linked to their fields on every page and dialog, and
  fields without a visible label (filters, sort, volume sliders, the editor's difficulty menu and ticks volume, the
  pack's song checkboxes, song.json) have one.
- Song cards open with Tab + Enter as well as a click, with a visible focus outline.
- Links inside text are underlined, so they don't rely on color alone; navigation stays plain.
- Field and button borders and placeholder text have stronger contrast (3:1 for borders) in both themes.
- Chart editor: in the light theme, gems have a thin outline so the pale lane colors (yellow) stay readable; the
  dimmer texts in the dark chart and the highway are lighter.

### Fixes
- The Help page didn't open ("Couldn't load this page: Cannot set properties of null") since 0.4: its Check for
  updates button expected the daily-check setting, which is only on the Setup page.

## 0.4.1 Beta (2026-11-15)

### Uninstall
- Uninstalling (Windows Settings → Apps → Pocket Encore) closes a running Pocket Encore and its window first, so its
  files and the window's saved preferences are removed completely.
- It asks whether to delete your songs, settings and built output too (`songs`, `out`, `settings.json` and Pocket
  Encore's caches). The default is **No**: they stay in the install folder, and a new install there finds them. Files
  you put there yourself (for example at3tool or mid2rbu) are never deleted.
- The last message says where anything that was kept is, and reminds you that custom songs copied to the memory stick
  stay there (delete their folders and `ZZCUSTOMDB` by hand).
- Help → Troubleshooting and the README explain how to uninstall.
- The installer's version check now counts the third number (0.4.1 is newer than 0.4).

## 0.4 Beta (2026-11-15)

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
