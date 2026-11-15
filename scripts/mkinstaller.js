// Builds the Pocket Encore installer with the version from pocketencore/version.json (the only place it is set), and
// optionally publishes it as a GitHub release.
//
//   node scripts\mkinstaller.js             build installer\Output\PocketEncore-Setup-<version>.exe
//   node scripts\mkinstaller.js --publish   build, then create the release v<version> on GitHub with the installer and
//                                           the version's CHANGELOG.md section as notes (needs the GitHub CLI, gh,
//                                           logged in; the commit must be pushed). Pocket Encore's update check finds
//                                           it from there.
//
// Refuses when CHANGELOG.md has no "## <version> <stage>" section. Needs Inno Setup 6 (https://jrsoftware.org/isinfo.php).
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const REPO = "omar-guuu/pocket-encore";
const fail = msg => { console.error("ERROR: " + msg); process.exit(1); };

const V = JSON.parse(fs.readFileSync(path.join(ROOT, "pocketencore", "version.json"), "utf8"));
const label = `${V.version} ${V.stage}`.trim();                       // "0.3 Beta"
const fileVer = `${V.version}${V.stage ? "-" + V.stage.toLowerCase() : ""}`;  // "0.3-beta"
const tag = "v" + fileVer;                                           // "v0.3-beta"

// the version's changelog section
const log = fs.readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8").replace(/\r/g, "");
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const m = new RegExp(`^## ${esc(label)}\\b.*$([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "m").exec(log);
if (!m) fail(`CHANGELOG.md has no "## ${label}" section: add what changed in ${label} first.`);
const changes = m[1].trim();

// Inno Setup's compiler
const iscc = [process.env["ProgramFiles(x86)"], process.env.ProgramFiles, process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs")]
  .filter(Boolean).map(d => path.join(d, "Inno Setup 6", "ISCC.exe")).find(f => fs.existsSync(f));
if (!iscc) fail("Inno Setup 6 is not installed: get it from https://jrsoftware.org/isdl.php (or: winget install --id JRSoftware.InnoSetup -e).");

console.log(`Building Pocket Encore ${label} with ${iscc}`);
execFileSync(iscc, ["/Q", `/DMyAppVersion=${label}`, `/DMyAppVersionFile=${fileVer}`, path.join(ROOT, "installer", "PocketEncore.iss")], { stdio: "inherit" });
const exe = path.join(ROOT, "installer", "Output", `PocketEncore-Setup-${fileVer}.exe`);
if (!fs.existsSync(exe)) fail("the compiler finished but " + exe + " is missing");
const sha = crypto.createHash("sha256").update(fs.readFileSync(exe)).digest("hex");
console.log(`  ${exe}\n  ${(fs.statSync(exe).size / 1048576).toFixed(1)} MB, SHA-256 ${sha}`);

if (!process.argv.includes("--publish")) process.exit(0);

// publish: the build must match a pushed commit
const git = (...a) => execFileSync("git", a, { cwd: ROOT, encoding: "utf8" }).trim();
const dirty = git("status", "--porcelain", "--", "pocketencore", "scripts", "docs", "installer", "CHANGELOG.md", "README.md", "pocketencore.cmd", "LICENSE");
if (dirty) fail("there are uncommitted changes in files the installer ships; commit and push them first:\n" + dirty);
git("fetch", "-q", "origin");
const head = git("rev-parse", "HEAD");
if (head !== git("rev-parse", "origin/main")) fail("this commit is not on GitHub yet: push it first (git push origin main).");
const gh = [process.env.ProgramFiles && path.join(process.env.ProgramFiles, "GitHub CLI", "gh.exe")].filter(f => f && fs.existsSync(f))[0] || "gh";
const notes = [
  `**Download:** \`${path.basename(exe)}\` below. It installs for your Windows user only (no admin rights) into \`%LOCALAPPDATA%\\PocketEncore\`. ` +
  "Already have Pocket Encore? Use **Download and install** in the app, or run this installer: it updates the copy you have and keeps your songs and settings.",
  "",
  "**You also need** (not included): [Node.js](https://nodejs.org/en/download) (LTS), [Python 3.12](https://www.python.org/downloads/windows/) with " +
  "`pip install mido numpy miniaudio`, [mid2rbu](https://github.com/maodus/mid2rbu), at3tool, and your own copy of Rock Band Unplugged (US, ULUS10418) " +
  "for PPSSPP. The first start walks you through finding them. No game files are included.",
  "",
  `SHA-256 of the installer: \`${sha}\``,
  "",
  `## What changed in ${label}`,
  "",
  changes,
  "",
  `All changes: [CHANGELOG.md](https://github.com/${REPO}/blob/main/CHANGELOG.md)`,
].join("\n");
const notesFile = path.join(ROOT, "installer", "Output", `release-notes-${fileVer}.md`);
fs.writeFileSync(notesFile, notes);
console.log(`Publishing ${tag} on GitHub…`);
execFileSync(gh, ["release", "create", tag, exe, "-R", REPO, "--target", head, "--title", `Pocket Encore ${label}`, "--notes-file", notesFile, "--latest"], { stdio: "inherit" });
console.log("Done: Pocket Encore's update check offers it from now on.");
