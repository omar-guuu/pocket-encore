// Where the external pieces are: rbu-tools/settings.json (made by Pocket Encore's Setup page, or by hand).
// {
//   "music": "C:/PSP/ppsspp_win/memstick/PSP/GAME/ULUS10418/MUSIC",   the game's MUSIC folder (official DLC: donor chart + song list)
//   "python": "C:/.../python.exe",                                     Python 3.12 with mido, numpy, miniaudio
//   "at3tool": "C:/.../at3tool.exe",                                   Sony ATRAC3 encoder
//   "mid2rbu": "C:/.../mid2rbu/mid2rbu.py"                             github.com/maodus/mid2rbu
// }
// Missing keys fall back to the defaults below (the tool's own folder, the usual Python install, the environment).
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const TOOLS = path.resolve(__dirname, "..");
const FILE = path.join(TOOLS, "settings.json");
const LOCAL = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Local");

function findPython() {
  if (process.env.RBU_PYTHON) return process.env.RBU_PYTHON;
  for (const v of ["Python312", "Python313", "Python311"]) {
    const p = path.join(LOCAL, "Programs", "Python", v, "python.exe");
    if (fs.existsSync(p)) return p;
  }
  try { return execFileSync("py", ["-3", "-c", "import sys;print(sys.executable)"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { }
  return "python";
}
const DEFAULTS = () => ({
  music: "C:/PSP/ppsspp_win/memstick/PSP/GAME/ULUS10418/MUSIC",
  python: findPython(),
  at3tool: path.join(TOOLS, "at3tool", "at3tool.exe"),
  mid2rbu: path.join(TOOLS, "mid2rbu", "mid2rbu.py"),
});

function load() {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { }
  const d = DEFAULTS(), out = {};
  for (const k of Object.keys(d)) out[k] = typeof s[k] === "string" && s[k].trim() ? s[k].trim() : d[k];
  return out;
}
function save(s) {
  const out = {};
  for (const k of Object.keys(DEFAULTS())) if (typeof s[k] === "string" && s[k].trim()) out[k] = s[k].trim();
  fs.writeFileSync(FILE, JSON.stringify(out, null, 2) + "\n");
  return load();
}

// What is present and what is missing, for the Setup page. Each check: { ok, detail, url? }.
const URLS = {
  node: "https://nodejs.org/en/download",
  python: "https://www.python.org/downloads/windows/",
  packages: "pip install mido numpy miniaudio",
  mid2rbu: "https://github.com/maodus/mid2rbu",
  at3tool: "at3tool.exe (Sony's ATRAC3 encoder from the PSP SDK; also found alongside PSP audio tools)",
  music: "the MUSIC folder of your own Rock Band Unplugged DLC on the PPSSPP memory stick (PSP/GAME/ULUS10418/MUSIC)",
};
function check() {
  const s = load(), r = {};
  r.node = { ok: true, detail: `Node ${process.versions.node} (${process.execPath})` };
  let pyv = "";
  try { pyv = execFileSync(s.python, ["-c", "import sys;print(sys.version.split()[0])"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10000 }).trim(); } catch { }
  r.python = { ok: !!pyv, detail: pyv ? `Python ${pyv} (${s.python})` : `not found at ${s.python}`, url: URLS.python };
  let pk = "";
  if (pyv) { try { pk = execFileSync(s.python, ["-I", "-c", "import mido,numpy,miniaudio;print('ok')"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20000 }).trim(); } catch (e) { pk = ""; } }
  r.packages = { ok: pk === "ok", detail: pk === "ok" ? "mido, numpy, miniaudio installed" : "missing: run  " + URLS.packages, url: URLS.packages };
  r.mid2rbu = { ok: fs.existsSync(s.mid2rbu), detail: fs.existsSync(s.mid2rbu) ? s.mid2rbu : `not found at ${s.mid2rbu}`, url: URLS.mid2rbu };
  r.at3tool = { ok: fs.existsSync(s.at3tool), detail: fs.existsSync(s.at3tool) ? s.at3tool : `not found at ${s.at3tool}`, url: URLS.at3tool };
  const donor = path.join(s.music, "SHESNOTTHERE", "BEATMATCH.STR.EDAT"), jb = path.join(s.music, "YOURENOROCKNROLLFUN");
  const okM = fs.existsSync(donor) && fs.existsSync(jb);
  r.music = { ok: okM, detail: okM ? s.music : `${s.music}: needs the official DLC folders SHESNOTTHERE (donor chart) and YOURENOROCKNROLLFUN (song list)`, url: URLS.music };
  return { settings: s, checks: r, ok: Object.values(r).every(x => x.ok) };
}

module.exports = { load, save, check, FILE, TOOLS, URLS };
