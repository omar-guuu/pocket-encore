// Where the external pieces are: rbu-tools/settings.json (written by Pocket Encore's first-time setup or Setup page,
// or by hand). Its absence means Pocket Encore has not been set up yet (the onboarding shows again).
// {
//   "music": "C:/PSP/ppsspp_win/memstick/PSP/GAME/ULUS10418/MUSIC",   the game's MUSIC folder (official DLC, if any)
//   "iso": "C:/PSP/ppsspp_win/memstick/PSP/GAME/ULUS10418.iso",       the game's disc image (ISO or CSO)
//   "python": "C:/.../python.exe",                                     Python 3.12 with mido, numpy, miniaudio
//   "at3tool": "C:/.../at3tool.exe",                                   Sony ATRAC3 encoder
//   "mid2rbu": "C:/.../mid2rbu/mid2rbu.py"                             github.com/maodus/mid2rbu
// }
// Missing keys fall back to what is detected (PPSSPP memory stick, the usual Python install, the tool's own folder).
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const game = require("./game.js");

const TOOLS = path.resolve(__dirname, "..");
const FILE = path.join(TOOLS, "settings.json");
const LOCAL = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Local");
const KEYS = ["music", "iso", "python", "at3tool", "mid2rbu"];

function findPython() {
  if (process.env.RBU_PYTHON) return process.env.RBU_PYTHON;
  for (const v of ["Python312", "Python313", "Python311"]) {
    const p = path.join(LOCAL, "Programs", "Python", v, "python.exe");
    if (fs.existsSync(p)) return p;
  }
  try { return execFileSync("py", ["-3", "-c", "import sys;print(sys.executable)"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { }
  return "python";
}
let detected = null;
const detectGame = () => (detected = detected || game.detect());
function DEFAULTS() {
  const g = detectGame();
  return {
    music: g.music || (g.memstick ? path.join(g.memstick, "PSP", "GAME", game.GAME_ID, "MUSIC") : ""),
    iso: g.iso || "",
    python: findPython(),
    at3tool: path.join(TOOLS, "at3tool", "at3tool.exe"),
    mid2rbu: path.join(TOOLS, "mid2rbu", "mid2rbu.py"),
  };
}

const configured = () => fs.existsSync(FILE);
function load() {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { }
  const d = DEFAULTS(), out = {};
  for (const k of KEYS) out[k] = typeof s[k] === "string" && s[k].trim() ? s[k].trim() : d[k];
  return out;
}
function save(s) {
  const out = {};
  for (const k of KEYS) if (typeof s[k] === "string" && s[k].trim()) out[k] = s[k].trim();
  fs.writeFileSync(FILE, JSON.stringify(out, null, 2) + "\n");
  detected = null;
  return load();
}
// The mode for the current settings: { mode: dlc|partial|disc, label, donor, base, ... } (game.js)
const gameMode = (s = load()) => game.mode(s.music, s.iso);

// What is present and what is missing, for the onboarding and the Setup page. Each check: { ok, detail, url? }.
const URLS = {
  node: "https://nodejs.org/en/download",
  python: "https://www.python.org/downloads/windows/",
  packages: "pip install mido numpy miniaudio",
  mid2rbu: "https://github.com/maodus/mid2rbu",
  at3tool: "at3tool.exe (Sony's ATRAC3 encoder from the PSP SDK), with msvcr71.dll next to it",
  game: "your own copy of Rock Band Unplugged (US, ULUS10418): its disc image (ISO/CSO) and, if you have it, its DLC in PSP/GAME/ULUS10418/MUSIC",
};
// over: paths to try without saving them (the onboarding checks what the user entered before writing settings.json)
function check(over = {}) {
  const s = load(), r = {};
  for (const k of KEYS) if (typeof over[k] === "string" && over[k].trim()) s[k] = over[k].trim();
  r.node = { ok: true, detail: `Node ${process.versions.node} (${process.execPath})` };
  let pyv = "";
  try { pyv = execFileSync(s.python, ["-c", "import sys;print(sys.version.split()[0])"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10000 }).trim(); } catch { }
  r.python = { ok: !!pyv, detail: pyv ? `Python ${pyv} (${s.python})` : `not found at ${s.python}`, url: URLS.python };
  let pk = "";
  if (pyv) { try { pk = execFileSync(s.python, ["-I", "-c", "import mido,numpy,miniaudio;print('ok')"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20000 }).trim(); } catch (e) { pk = ""; } }
  r.packages = { ok: pk === "ok", detail: pk === "ok" ? "mido, numpy, miniaudio installed" : "missing: run  " + URLS.packages, url: URLS.packages };
  r.mid2rbu = { ok: fs.existsSync(s.mid2rbu), detail: fs.existsSync(s.mid2rbu) ? s.mid2rbu : `not found at ${s.mid2rbu}`, url: URLS.mid2rbu };
  r.at3tool = { ok: fs.existsSync(s.at3tool), detail: fs.existsSync(s.at3tool) ? s.at3tool : `not found at ${s.at3tool}`, url: URLS.at3tool };
  // the game: the disc image always identifies it; with DLC the build can run on the DLC alone
  const m = gameMode(s), isoOk = !!s.iso && fs.existsSync(s.iso) && game.isGameImage(s.iso);
  const isoNote = isoOk ? `disc image ${s.iso}` : s.iso ? `${s.iso} is not a Rock Band Unplugged (${game.GAME_ID}) disc image` : "no disc image found";
  if (m.mode === "disc") r.game = { ok: isoOk, mode: m, detail: isoOk ? `${m.label}: ${isoNote}; no official DLC in ${s.music || "(no MUSIC folder)"}` : `${m.label} (no official DLC found), and ${isoNote}`, url: URLS.game };
  else r.game = { ok: true, mode: m, detail: `${m.label}: ${m.coverage ? `${m.coverage.present} of the ${m.coverage.listed} DLC songs` : `${m.dlc} official DLC song folder${m.dlc > 1 ? "s" : ""}`} in ${s.music}; ${isoNote}`, url: URLS.game };
  return { settings: s, checks: r, ok: Object.values(r).every(x => x.ok), configured: configured(), mode: m, detected: detectGame() };
}

const redetect = () => { detected = null; return detectGame(); };
module.exports = { load, save, check, gameMode, configured, redetect, FILE, TOOLS, URLS };
