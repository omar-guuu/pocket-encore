// Updates: asks GitHub for the latest release of Pocket Encore (at most once a day when the automatic check is on, or
// when asked), and installs it in one step: download the installer into Downloads, check it against the release's
// SHA-256, run it without its wizard (/SILENT /UPDATE=1) and quit; the installer starts Pocket Encore again and the open
// window reloads by itself. The only request is to api.github.com (and the download from github.com); nothing about
// the user is sent. State in songs/.db/update.json: { auto, skip, checkedAt, latest }.
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");

const REPO = "omar-guuu/pocket-encore", DAY = 864e5;
// for tests only: PE_UPDATE_URL (a stand-in for GitHub's latest-release answer) and PE_DOWNLOAD_DIR (instead of Downloads)
const LATEST_URL = process.env.PE_UPDATE_URL || `https://api.github.com/repos/${REPO}/releases/latest`;
const STAGES = { alpha: 0, beta: 1, rc: 2, "": 3 };

// "v0.4-beta" / "0.4 Beta" -> { nums: [0, 4, 0], stage: "Beta" }
function parseVersion(s) {
  const m = /^v?(\d+)\.(\d+)(?:\.(\d+))?(?:[-_ ]?([a-z]+))?/i.exec(String(s || "").trim());
  if (!m) return null;
  const st = (m[4] || "").toLowerCase();
  return { nums: [+m[1], +m[2], +(m[3] || 0)], stage: st ? st[0].toUpperCase() + st.slice(1) : "" };
}
const versionLabel = v => (v.nums[2] ? v.nums.join(".") : v.nums.slice(0, 2).join(".")) + (v.stage ? " " + v.stage : "");
function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) if (a.nums[i] !== b.nums[i]) return a.nums[i] - b.nums[i];
  return (STAGES[a.stage.toLowerCase()] ?? 3) - (STAGES[b.stage.toLowerCase()] ?? 3);
}

function createUpdater({ tools, version, port, quit }) {
  const STATE = path.join(tools, "songs", ".db", "update.json");
  const read = () => { try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { return {}; } };
  const write = s => { fs.mkdirSync(path.dirname(STATE), { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(s, null, 1)); };
  const current = parseVersion(`${version.version} ${version.stage}`) || { nums: [0, 0, 0], stage: "" };
  const ua = `PocketEncore/${version.version}`;
  // how this copy was installed: by the installer (one-click update), from git (git pull), or copied by hand
  const mode = fs.existsSync(path.join(tools, "unins000.exe")) ? "installer" : fs.existsSync(path.join(tools, ".git")) ? "git" : "manual";
  let job = null;  // the running update: { phase: download | verify | install | error, received, total, error }

  async function fetchLatest() {
    const r = await fetch(LATEST_URL,
      { headers: { "User-Agent": ua, Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(10000) });
    if (r.status === 404) return null;  // no release yet
    if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
    const j = await r.json(), v = parseVersion(j.tag_name);
    if (!v) throw new Error(`unexpected release tag "${j.tag_name}"`);
    const a = (j.assets || []).find(x => /^PocketEncore-Setup-.*\.exe$/i.test(x.name));
    return {
      tag: j.tag_name, label: versionLabel(v), nums: v.nums, stage: v.stage, name: j.name || "", notes: j.body || "", page: j.html_url, published: j.published_at,
      asset: a ? { name: a.name, url: a.browser_download_url, size: a.size, sha256: (/^sha256:([0-9a-f]{64})$/i.exec(a.digest || "") || [])[1] || null } : null,
    };
  }

  // force: check now (the Check for updates button); otherwise only when the automatic check is on and a day has passed
  async function status(force) {
    const s = read(), auto = s.auto !== false;
    let error = null;
    if (force || (auto && (!s.checkedAt || Date.now() - s.checkedAt > DAY))) {
      try { s.latest = await fetchLatest(); s.checkedAt = Date.now(); }
      catch (e) { error = e.message; if (!force) s.checkedAt = Date.now() - DAY + 3600e3; }  // offline: try again in an hour
      write(s);
    }
    const L = s.latest, newer = !!(L && compareVersions(L, current) > 0);
    return { current: versionLabel(current), auto, mode, checkedAt: s.checkedAt || null, latest: L || null, available: newer,
      skipped: newer && s.skip === L.tag, error, job };
  }
  function setPrefs(p) {
    const s = read();
    if (typeof p.auto === "boolean") s.auto = p.auto;
    if ("skip" in p) s.skip = p.skip || null;
    write(s);
  }

  function install() {
    const cached = read().latest;
    if (mode !== "installer") throw new Error("this copy wasn't installed with the installer: download the new version from the release page");
    if (!cached || compareVersions(cached, current) <= 0) throw new Error("no newer version to install");
    if (job && job.phase !== "error") return job;
    job = { phase: "download", received: 0, total: (cached.asset && cached.asset.size) || 0, error: null, version: cached.label };
    (async () => {
      try {
        // the release as it is now (the remembered answer can be up to a day old, and its installer may have been replaced)
        const L = await fetchLatest();
        const s = read(); s.latest = L; s.checkedAt = Date.now(); write(s);
        if (!L || compareVersions(L, current) <= 0) throw new Error("no newer version to install");
        if (!L.asset) throw new Error("the release has no installer: download it from the release page");
        if (!L.asset.sha256) throw new Error("the release has no checksum to verify the download: download it from the release page");
        job.total = L.asset.size; job.version = L.label;
        const dir = process.env.PE_DOWNLOAD_DIR || path.join(os.homedir(), "Downloads"), file = path.join(dir, L.asset.name), tmp = file + ".part";
        fs.mkdirSync(dir, { recursive: true });
        const r = await fetch(L.asset.url, { headers: { "User-Agent": ua }, signal: AbortSignal.timeout(15 * 60e3) });
        if (!r.ok || !r.body) throw new Error(`the download failed (${r.status})`);
        const h = crypto.createHash("sha256"), out = fs.createWriteStream(tmp);
        for await (const chunk of r.body) {
          h.update(chunk); job.received += chunk.length;
          if (!out.write(chunk)) await new Promise(res => out.once("drain", res));
        }
        await new Promise((res, rej) => out.end(e => e ? rej(e) : res()));
        job.phase = "verify";
        if (h.digest("hex") !== L.asset.sha256.toLowerCase()) { fs.rmSync(tmp, { force: true }); throw new Error("the download doesn't match the release's checksum, so nothing was installed"); }
        fs.rmSync(file, { force: true }); fs.renameSync(tmp, file);
        job.phase = "install"; job.file = file;
        // no wizard; the installer closes this copy if it is still running and starts the new one when done
        spawn(file, ["/SILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/UPDATE=1", `/PORT=${port}`], { detached: true, stdio: "ignore", cwd: dir }).unref();
        setTimeout(quit, 1000);
      } catch (e) { job.phase = "error"; job.error = e.message; }
    })();
    return job;
  }

  return { status, setPrefs, install, progress: () => job, mode };
}

module.exports = { createUpdater, parseVersion, compareVersions, versionLabel, REPO };
