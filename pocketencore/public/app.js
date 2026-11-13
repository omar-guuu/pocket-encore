"use strict";
// Pocket Encore page: library, song details (song.json form), new song, setup, builds. The chart/FX editor is editor.js.
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const DIFFS = ["Easy", "Medium", "Hard", "Expert"];
const PARTS = ["drums", "bass", "guitar", "vocals"];
let META = null, CUR = null;  // CUR = details of the open song

async function api(method, url, body) {
  const r = await fetch(url, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const v = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(v.error || r.statusText);
  return v;
}
function toast(msg, bad) {
  const d = document.createElement("div");
  d.textContent = msg;
  d.className = "toast";
  const top = [...document.querySelectorAll(".toast")].reduce((y, t) => Math.max(y, t.offsetTop + t.offsetHeight + 6), 56);
  Object.assign(d.style, { position: "fixed", right: "16px", top: top + "px", background: bad ? "#5a1f1f" : "#1f4a2c", padding: "8px 14px", borderRadius: "6px", zIndex: 30, maxWidth: "50vw" });
  document.body.appendChild(d);
  setTimeout(() => d.remove(), bad ? 6000 : 2500);
}
const fmtN = n => n == null ? "–" : Number(n).toLocaleString("en-US");
const starStr = n => "★".repeat(n) + "☆".repeat(Math.max(0, 6 - n));
const fmtTime = s => { if (s == null || !isFinite(s)) return "–"; const m = Math.floor(s / 60); return `${m}:${(s - m * 60).toFixed(1).padStart(4, "0")}`; };

// ---------- routing ----------
let skipRoute = false, lastHash = location.hash;
async function route(ev) {
  if (skipRoute) { skipRoute = false; return; }
  if (ev && window.editorDirty && window.editorDirty() && !confirm("Leave the editor without saving?")) { skipRoute = true; location.hash = lastHash; return; }
  lastHash = location.hash;
  if (window.editorClose) window.editorClose();
  document.body.classList.remove("editing");
  document.body.classList.remove("onboarding");
  const h = location.hash.replace(/^#\/?/, "").split("/");
  try {
    if (!META.configured || h[0] === "welcome") { if (h[0] !== "welcome") { skipRoute = true; location.hash = "#/welcome"; lastHash = location.hash; } return await showWelcome(); }
    if (h[0] === "song" && h[1]) await showSong(h[1], h[2] || "details");
    else if (h[0] === "new") showNew();
    else if (h[0] === "setup") await showSetup();
    else await showLibrary();
  } catch (e) { $("#main").innerHTML = `<div class="panel">Error: ${esc(e.message)}</div>`; }
}
window.addEventListener("hashchange", route);
window.addEventListener("beforeunload", e => { if (window.editorDirty && window.editorDirty()) { e.preventDefault(); e.returnValue = ""; } });

// ---------- library ----------
function qualityBadge(S) {
  const q = S.stemSource || {};
  const type = q.type || "unknown";
  return `<span class="badge ${q.quality ? "q-" + q.quality : ""}" title="${esc(q.notes || "")}">stems: ${esc(type)}${q.tool ? " (" + esc(q.tool) + ")" : ""}${q.quality ? " · " + esc(q.quality) : ""}</span>`;
}
function statusBadge(s) {
  const cls = s.status === "built" ? "ok" : s.status === "not built" ? "bad" : "warn";
  return `<span class="badge ${cls}">${esc(s.status)}</span>`;
}
async function showLibrary() {
  $("#crumb").textContent = "Songs";
  const list = await api("GET", "/api/songs");
  const sort = localStorage.libSort || "folder";
  list.sort((a, b) => sort === "title" ? String(a.song?.title).localeCompare(String(b.song?.title)) : sort === "changed" ? (b.builtAt || 0) - (a.builtAt || 0) : a.folder.localeCompare(b.folder));
  const dbNote = META.db && META.db.stale ? `<div class="panel warnline">The game mode changed to <b>${esc(META.mode.label)}</b> since the song database was built (for "${esc(META.db.was)}"). Build any song to update the database, then copy ZZCUSTOMDB to the memory stick again.</div>` : "";
  const setupNote = META.setupOk ? "" : `<div class="panel warnline">Setup is incomplete: builds will fail until the missing pieces are installed. <a href="#/setup">Open Setup</a>.</div>`;
  $("#main").innerHTML = dbNote + setupNote + `
    <div class="libbar"><button class="primary" onclick="location.hash='#/new'">+ New song</button>
      <input id="filter" placeholder="Filter…" value="${esc(localStorage.libFilter || "")}">
      <select id="sort"><option value="folder">by folder</option><option value="title">by title</option><option value="changed">last built</option></select>
      <button onclick="openFolder('', 'out')" title="The built songs, ready to copy to the memory stick">Open output folder</button>
      <span class="grow"></span><span class="dim">${list.length} songs in rbu-tools/songs</span></div>
    <div class="cards">${list.map(s => {
      if (s.error) return `<div class="card"><h3>${esc(s.folder)}</h3><div class="sub" style="color:var(--bad)">${esc(s.error)}</div></div>`;
      const S = s.song, ex = s.built && s.built[3];
      return `<div class="card" data-f="${esc(s.folder)}" data-q="${esc((S.title + " " + S.artist + " " + s.folder).toLowerCase())}">
        <h3>${esc(S.title)}</h3><div class="sub">${esc(S.artist)}${S.year ? " · " + esc(S.year) : ""}${S.genre ? " · " + esc(S.genre) : ""}</div>
        <div class="row">${statusBadge(s)}<span class="badge">chart: ${esc(s.chartSource)}</span>${qualityBadge(S)}</div>
        <div class="row small dim">${esc(s.folder)}${s.audio ? " · " + fmtTime(s.audio.audioSeconds) : ""}${ex ? " · Expert gold " + fmtN(ex.stars[5]) : ""}${S.effects ? " · FX" : ""}${S.countIn ? " · count-in" : ""}</div>
      </div>`;
    }).join("")}</div>`;
  $("#sort").value = sort;
  $("#sort").onchange = e => { localStorage.libSort = e.target.value; showLibrary(); };
  const filt = () => { const q = $("#filter").value.toLowerCase(); localStorage.libFilter = q; document.querySelectorAll(".card[data-q]").forEach(c => c.classList.toggle("hidden", !c.dataset.q.includes(q))); };
  $("#filter").oninput = filt; filt();
  document.querySelectorAll(".card[data-f]").forEach(c => c.onclick = () => location.hash = `#/song/${c.dataset.f}`);
}
async function openFolder(folder, what) {
  try { await api("POST", `/api/open/${folder || "ZNONE"}?what=${what}`); } catch (e) { toast(e.message, true); }
}

// ---------- first-time setup (onboarding) ----------
// Shown while rbu-tools/settings.json does not exist; finishing writes it. Nothing is saved before the last step.
const OB = { step: 0, settings: null, check: null };
const REQUIRED_NOTE = `<div class="obreq"><b>You need Rock Band Unplugged to use Pocket Encore</b>: the game (US version, ULUS10418) as a
  UMD disc image (ISO or CSO), or the game plus its DLC. Pocket Encore builds custom songs from the game's own files on
  your computer and does not include any of them.</div>`;
function obCheckRow(c, label, extra = "") {
  return `<div class="obrow"><span class="badge ${c.ok ? "ok" : "bad"}">${c.ok ? "found" : "missing"}</span><b>${label}</b>
    <div class="small dim mono">${esc(c.detail)}</div>${!c.ok && c.url ? `<div class="small">${c.url.startsWith("http") ? `Get it: <a href="${esc(c.url)}" target="_blank">${esc(c.url)}</a>` : esc(c.url)}</div>` : ""}${extra}</div>`;
}
async function obCheck(redetect) {
  const r = await api("POST", "/api/setup", { settings: OB.settings || {}, redetect: !!redetect });
  OB.check = r;
  if (!OB.settings || redetect) OB.settings = { ...r.settings };
  return r;
}
async function showWelcome() {
  document.body.classList.add("onboarding");
  $("#crumb").textContent = "Welcome";
  if (!OB.check) await obCheck();
  const steps = ["Welcome", "Your game", "Tools", "Done"];
  const head = `<div class="obsteps">${steps.map((n, i) => `<span class="${i === OB.step ? "on" : i < OB.step ? "done" : ""}">${i + 1}. ${n}</span>`).join("")}</div>`;
  const c = OB.check, s = OB.settings, m = c.mode;
  let body = "", next = "Next", canNext = true;
  if (OB.step === 0) {
    body = `<h2>Welcome to Pocket Encore</h2>
      <p>Pocket Encore makes custom songs for <b>Rock Band Unplugged</b> on PSP (played with PPSSPP): pick the stems of a
      song, let it chart the four parts, edit the gems and effects with the music playing, and build the files the game
      loads, with no plugin and no cheats.</p>
      ${REQUIRED_NOTE}
      <p class="small dim">For personal use with your own copy of the game. Never share the game's files or songs built from
      copyrighted audio. The next steps find your game and the tools Pocket Encore uses; nothing is saved until the end.</p>`;
    next = "Find my game";
  } else if (OB.step === 1) {
    const g = c.checks.game;
    const cov = m.coverage ? `${m.coverage.present} of the ${m.coverage.listed} DLC songs are installed` : `${m.dlc} DLC song folder${m.dlc > 1 ? "s" : ""}`;
    const modeText = m.complete ? `All the DLC is installed (${cov}): custom songs are built on it, and the game keeps listing every base game and DLC song.`
      : m.mode !== "disc" ? `Some of the DLC is installed (${cov}): custom songs are built on it, and the game keeps listing your DLC songs.`
      : "No official DLC was found: custom songs are built from the base game's disc image, and the game lists the base game's songs and yours.";
    body = `<h2>Your game</h2>
      ${REQUIRED_NOTE}
      <div class="form" style="grid-template-columns:170px 1fr auto;margin-top:12px">
        <label>Disc image (ISO/CSO)</label><input type="text" id="ob_iso" value="${esc(s.iso)}" placeholder="e.g. ...\\PSP\\GAME\\ULUS10418.iso"><button onclick="pickInto('#ob_iso')">Browse…</button>
        <label>Game's MUSIC folder</label><input type="text" id="ob_music" value="${esc(s.music)}" placeholder="...\\memstick\\PSP\\GAME\\ULUS10418\\MUSIC"><button onclick="pickInto('#ob_music', null, true)">Browse…</button>
      </div>
      <p class="small dim">Found automatically from PPSSPP when possible. The MUSIC folder is where the game keeps DLC
      (PSP/GAME/ULUS10418/MUSIC on PPSSPP's memory stick); it may not exist yet if you have no DLC. It is also where you
      copy the songs you build.</p>
      <div class="actions"><button id="ob_recheck">Check these paths</button><button id="ob_detect">Detect again</button></div>
      ${obCheckRow(g, "Rock Band Unplugged", `<div class="obmode"><span class="badge ${g.ok ? "ok" : "warn"}">${esc(m.label)}</span> ${esc(modeText)}</div>`)}`;
    canNext = g.ok;
    if (!g.ok) body += `<p class="warnline">Pocket Encore can't continue without the game: set the disc image of your copy (or the MUSIC folder with its DLC).</p>`;
  } else if (OB.step === 2) {
    const k = c.checks;
    body = `<h2>Tools</h2>
      <p class="small dim">Pocket Encore uses these free tools to build songs. They are not ours, so they are not included:
      install each one, then press <b>Check again</b>.</p>
      ${obCheckRow(k.node, "Node.js", "")}
      ${obCheckRow(k.python, "Python 3.12", `<div class="inline"><input type="text" id="ob_python" value="${esc(s.python)}" style="flex:1"><button onclick="pickInto('#ob_python')">Browse…</button></div>`)}
      ${obCheckRow(k.packages, "Python packages: mido, numpy, miniaudio", `<div class="small">In a console: <span class="mono">"${esc(s.python)}" -m pip install mido numpy miniaudio</span></div>`)}
      ${obCheckRow(k.mid2rbu, "mid2rbu", `<div class="inline"><input type="text" id="ob_mid2rbu" value="${esc(s.mid2rbu)}" style="flex:1"><button onclick="pickInto('#ob_mid2rbu')">Browse…</button></div>`)}
      ${obCheckRow(k.at3tool, "at3tool.exe (with msvcr71.dll next to it)", `<div class="inline"><input type="text" id="ob_at3tool" value="${esc(s.at3tool)}" style="flex:1"><button onclick="pickInto('#ob_at3tool')">Browse…</button></div>`)}
      <div class="actions"><button id="ob_recheck">Check again</button></div>`;
    const missing = ["python", "packages", "mid2rbu", "at3tool"].filter(x => !k[x].ok);
    if (missing.length) { next = "Finish anyway"; body += `<p class="warnline">Missing: ${missing.join(", ")}. You can finish now and add them later on the Setup page, but songs can't be built until everything is found.</p>`; }
    else next = "Finish";
  } else {
    body = `<h2>All set</h2>
      <p>Game: <b>${esc(m.label)}</b>. Chart container ${esc(m.donorName)}, song list ${esc(m.baseName)}.</p>
      <p>${c.ok ? "Everything Pocket Encore needs was found." : "Some tools are still missing: songs can be created and edited, but not built until they are installed (Setup, top right)."}</p>
      <p class="small dim">Settings saved in <span class="mono">${esc(c.file)}</span>. Pocket Encore checks the game every time it starts:
      add or remove DLC and it switches mode by itself.</p>
      <div class="actions"><button class="primary" onclick="location.hash='#/new'">Create my first song</button><button onclick="location.hash='#/'">Open the song library</button></div>`;
  }
  $("#main").innerHTML = `<div class="onboard">${head}<div class="panel">${body}
    ${OB.step < 3 ? `<div class="actions obnav">${OB.step ? '<button id="ob_back">Back</button>' : ""}<span class="grow"></span><button class="primary" id="ob_next" ${canNext ? "" : "disabled"}>${next}</button></div>` : ""}</div></div>`;
  const grab = () => {
    for (const k of ["iso", "music", "python", "mid2rbu", "at3tool"]) { const el = $("#ob_" + k); if (el) OB.settings[k] = el.value.trim(); }
  };
  // Detect again: forget what was typed in and look for the game afresh
  const recheck = async redetect => { if (redetect) OB.settings = null; else grab(); try { await obCheck(redetect); } catch (e) { toast(e.message, true); } showWelcome(); };
  if ($("#ob_recheck")) $("#ob_recheck").onclick = () => recheck(false);
  if ($("#ob_detect")) $("#ob_detect").onclick = () => recheck(true);
  if ($("#ob_back")) $("#ob_back").onclick = () => { grab(); OB.step--; showWelcome(); };
  if ($("#ob_next")) $("#ob_next").onclick = async () => {
    grab();
    try {
      await obCheck();
      if (OB.step === 1 && !OB.check.checks.game.ok) return showWelcome();
      if (OB.step === 2) {  // finish: write settings.json
        const r = await api("PUT", "/api/settings", OB.settings);
        OB.check = { ...r };
        META = await api("GET", "/api/meta");
        renderModeBadge();
      }
      OB.step++;
      showWelcome();
    } catch (e) { toast(e.message, true); }
  };
}
function renderModeBadge() {
  const el = $("#modeBadge");
  if (!el || !META.mode) return;
  const m = META.mode, stale = META.db && META.db.stale;
  el.className = "badge " + (stale ? "warn" : m.mode === "disc" ? "" : "ok");
  el.textContent = m.label + (stale ? " · rebuild needed" : "");
  el.title = `Game mode: ${m.label}. Chart container ${m.donorName}; song list ${m.baseName}.` +
    (stale ? ` The song database was built for "${META.db.was}": build any song to update it.` : "") + " Checked every time Pocket Encore starts.";
}

// ---------- setup ----------
async function showSetup() {
  $("#crumb").innerHTML = `<a href="#/">Songs</a> / Setup`;
  const s = await api("GET", "/api/setup");
  const row = (k, label) => { const c = s.checks[k]; return `<tr><td>${c.ok ? '<span class="badge ok">ok</span>' : '<span class="badge bad">missing</span>'}</td><td>${label}</td><td class="mono small">${esc(c.detail)}</td><td class="small">${!c.ok && c.url ? (c.url.startsWith("http") ? `<a href="${esc(c.url)}" target="_blank">${esc(c.url)}</a>` : esc(c.url)) : ""}</td></tr>`; };
  $("#main").innerHTML = `<div class="panel"><h4>What the tool needs</h4>
    <p class="small dim">Pocket Encore and its scripts are ours; the pieces below are not, so they are not included. Install each one and set its path here (saved in <span class="mono">${esc(s.file)}</span>).</p>
    <table class="t setup"><tr><th></th><th>Piece</th><th>Found</th><th>Where to get it</th></tr>
      ${row("node", "Node.js (runs Pocket Encore and the scripts)")}${row("python", "Python 3.12 (charting, stem analysis, count-in, mid2rbu)")}${row("packages", "Python packages mido, numpy, miniaudio")}
      ${row("mid2rbu", "mid2rbu (Rock Band MIDI → .rbu chart)")}${row("at3tool", "at3tool.exe (ATRAC3 encoder for the audio)")}${row("game", `Rock Band Unplugged: <span class="badge ${s.mode.mode === "disc" ? "" : "ok"}">${esc(s.mode.label)}</span> <span class="small dim">chart container ${esc(s.mode.donorName)}, song list ${esc(s.mode.baseName)}</span>`)}</table>
    <p class="small dim">The game mode is checked every time Pocket Encore starts: Base Game + Complete / Incomplete DLC → built on your DLC (every song you have stays listed); Base Game only → built from the disc image. <a href="#/welcome" onclick="OB.step=0;OB.check=null;OB.settings=null">Run the first-time setup again</a></p></div>
    <div class="panel"><h4>Paths</h4><div class="form" style="grid-template-columns:160px 1fr auto">
      <label>Disc image (ISO/CSO)</label><input type="text" id="s_iso" value="${esc(s.settings.iso)}"><button onclick="pickInto('#s_iso')">Browse…</button>
      <label>MUSIC folder</label><input type="text" id="s_music" value="${esc(s.settings.music)}"><button onclick="pickInto('#s_music', null, true)">Browse…</button>
      <label>python.exe</label><input type="text" id="s_python" value="${esc(s.settings.python)}"><button onclick="pickInto('#s_python')">Browse…</button>
      <label>at3tool.exe</label><input type="text" id="s_at3tool" value="${esc(s.settings.at3tool)}"><button onclick="pickInto('#s_at3tool')">Browse…</button>
      <label>mid2rbu.py</label><input type="text" id="s_mid2rbu" value="${esc(s.settings.mid2rbu)}"><button onclick="pickInto('#s_mid2rbu')">Browse…</button>
    </div><div class="actions" style="margin-top:10px"><button class="primary" id="s_save">Save and check again</button>
      <span class="small dim">Python packages: open a console and run <span class="mono">pip install mido numpy miniaudio</span> (with the same python.exe).</span></div></div>`;
  $("#s_save").onclick = async () => {
    try {
      const r = await api("PUT", "/api/settings", { iso: $("#s_iso").value, music: $("#s_music").value, python: $("#s_python").value, at3tool: $("#s_at3tool").value, mid2rbu: $("#s_mid2rbu").value });
      META = await api("GET", "/api/meta"); renderModeBadge(); $("#setupLink").classList.toggle("warn", !META.setupOk); toast(r.ok ? "Setup complete" : "Saved; some pieces are still missing", !r.ok); showSetup();
    } catch (e) { toast(e.message, true); }
  };
}

// ---------- song page ----------
async function showSong(folder, tab) {
  CUR = await api("GET", `/api/song/${folder}`);
  const S = CUR.song;
  $("#crumb").innerHTML = `<a href="#/">Songs</a> / ${esc(S.title)} <span class="dim">(${esc(folder)})</span> ${statusBadge(CUR)}`;
  const tabs = [["details", "Details"], ["editor", "Chart & effects"], ["json", "song.json"]];
  $("#main").innerHTML = `<div class="tabs">${tabs.map(([k, n]) => `<button class="${k === tab ? "on" : ""}" onclick="location.hash='#/song/${folder}/${k}'">${n}</button>`).join("")}
    <span class="grow"></span>${buildButtons(folder)}</div><div id="tab"></div>`;
  if (tab === "editor") { document.body.classList.add("editing"); return window.openEditor($("#tab"), folder, CUR); }
  if (tab === "json") return showJson(folder);
  showDetails(folder);
}
function buildButtons(folder) {
  return `<span class="actions">
    <button class="primary" onclick="runBuild('${folder}','audio')" title="Audio, preview, chart and song database (mksong.js)">Build</button>
    <button onclick="runBuild('${folder}','chart')" title="Chart and database only: reuses the audio from the last build">Rebuild chart</button>
    <button onclick="openFolder('${folder}','outsong')" title="The built song folder in out\\MUSIC">Open output</button>
    ${CUR && CUR.buildLog ? `<button onclick="showStoredLog('${folder}')" title="The last build's log, from disk">Last log</button>` : ""}
  </span>`;
}

function opt(list, cur) { return list.map(([v, n]) => `<option value="${esc(v)}" ${String(v) === String(cur ?? "") ? "selected" : ""}>${esc(n)}</option>`).join(""); }
function stemLine(st) {
  const x = st.stats, f = st.format;
  if (!st.source) return "no stem (silence)";
  if (st.exists === false) return '<span style="color:var(--bad)">file not found</span>';
  const fmt = f ? `${f.ext.toUpperCase()}${f.rate ? ` ${f.rate / 1000} kHz ${f.float ? "float" : f.bits + "-bit"} ${f.ch === 1 ? "mono" : f.ch === 2 ? "stereo" : f.ch + " ch"}` : ""} ${f.mb} MB` : "";
  if (!x) return `${fmt} · not prepared yet (build once)`;
  if (x.note) return esc(x.note);
  const flags = [];
  if (x.silent) flags.push('<span style="color:var(--warn)">nearly silent</span>');
  if (x.clip > 50) flags.push(`<span style="color:var(--warn)">clipping (${x.clip} samples)</span>`);
  if (Math.abs(x.dc) > 1) flags.push(`<span style="color:var(--warn)">DC offset ${x.dc}%</span>`);
  if (f && f.ext === "mp3" && f.mb / Math.max(1, x.seconds) * 8192 < 160) flags.push(`<span style="color:var(--warn)">low bitrate (~${Math.round(f.mb / x.seconds * 8192)} kbps)</span>`);
  return `${fmt} · peak ${x.peak} dB · RMS ${x.rms} dB · sound in ${x.active}% of the song${flags.length ? " · " + flags.join(" · ") : ""}`;
}
function checksHtml(c) {
  if (!c || !c.items.length) return `<div class="small" style="color:var(--ok)">No problems found in the ${c && c.source === "edited" ? "edited" : "automatic"} chart.</div>`;
  return `<ul class="checks">${c.items.map(i => `<li class="${i.level}"><span class="badge ${i.level === "error" ? "bad" : i.level === "warn" ? "warn" : ""}">${i.level}</span> ${i.part ? `<b>${esc(i.part)}</b> ` : ""}${esc(i.msg)}${i.at != null ? ` <a href="#" data-at="${i.at}" class="small">go</a>` : ""}</li>`).join("")}</ul>`;
}
async function showDetails(folder) {
  const s = CUR, S = s.song, T = S.tiers || {}, src = S.stemSource || {};
  const tierSel = k => `<select data-tier="${k}">${opt([0, 1, 2, 3, 4, 5, 6].map(n => [n, n === 0 ? "0 (none)" : starStr(n).slice(0, n) + "  " + n]), T[k] ?? 0)}</select>`;
  const stemLines = s.stems.map(st => `<div class="stemrow"><label>${st.part} ${tip(st.part)}</label><input type="text" data-stem="${st.part}" value="${esc(st.source || "")}" placeholder="${esc(st.part === "fill" ? PH.stem("fill") : st.part[0].toUpperCase() + st.part.slice(1) + " stem file: Browse…")}">
      <button onclick="pickInto('[data-stem=${st.part}]','${folder}')">Browse…</button><div class="stemstat">${stemLine(st)}</div></div>`).join("");
  const bleed = s.bleed && s.bleed.length ? `<div class="small warnline" style="margin-top:6px">Possible bleed (stems that rise and fall together): ${s.bleed.map(b => `${b.a} ↔ ${b.b} (${(b.corr * 100).toFixed(0)}%)`).join(", ")}. Normal for a real band playing together; with AI stems it usually means one instrument leaked into another's track.</div>` : "";
  const B = s.built;
  const starsTable = B ? `<table class="t"><tr><th>Difficulty</th><th>Drums</th><th>Bass</th><th>Guitar</th><th>Vocals</th><th>5★</th><th>Gold</th><th>Max</th></tr>
    ${B.map((d, i) => `<tr><td>${DIFFS[i]}</td>${d.gems.map(n => `<td>${n}</td>`).join("")}<td>${fmtN(d.stars[4])}</td><td>${fmtN(d.stars[5])}</td><td>${fmtN(d.max)}</td></tr>`).join("")}</table>
    <div class="small dim" style="margin-top:6px">Gems per part and star scores from the last build (estimated max × starsScale ${S.starsScale ?? 1}).</div>` : `<div class="dim">Not built yet.</div>`;
  const au = s.audio;
  $("#tab").innerHTML = `<div class="grid2"><div>
    <div class="panel"><h4>Song</h4><div class="form">
      <label>Title</label><input type="text" id="f_title" value="${esc(S.title)}" placeholder="${esc(PH.title)}">
      <label>Artist</label><input type="text" id="f_artist" value="${esc(S.artist)}" placeholder="${esc(PH.artist)}">
      <label>Album</label><input type="text" id="f_album" value="${esc(S.album)}" placeholder="${esc(PH.album)}">
      <label>Year</label><input type="number" id="f_year" value="${esc(S.year)}" placeholder="${esc(PH.year)}" style="width:100%">
      <label>Genre</label><select id="f_genre">${opt(META.genres.map(g => [g, g]), S.genre)}</select>
      <label>Lead vocals</label><select id="f_vocals">${opt([["", "(not set)"], [1, "male"], [2, "female"]], S.vocals)}</select>
    </div></div>
    <div class="panel"><h4>Difficulty tiers (0–6)</h4><div class="form">
      ${["band", "guitar", "bass", "drums", "vocals"].map(k => `<label>${k}</label>${tierSel(k)}`).join("")}
    </div></div>
    <div class="panel"><h4>Options</h4><div class="form">
      <label>Count-in</label><label class="inline"><input type="checkbox" id="f_countIn" ${S.countIn ? "checked" : ""}> 4 stick clicks before the music</label>
      <label>Lead-in (s)</label><span class="inline"><input type="number" step="0.1" id="f_leadIn" value="${esc(S.leadIn ?? "")}" placeholder="auto"><span class="small dim">empty = auto (music starts ≥ 3 s, ≥ 4.5 s with count-in)</span></span>
      <label>Stars scale</label><span class="inline"><input type="number" step="0.01" id="f_starsScale" value="${esc(S.starsScale ?? "")}" placeholder="1"><span class="small dim">&gt; 1 harder, &lt; 1 easier</span> <button class="small" id="calib">Calibrate from a play…</button></span>
      <label>Preview start (s)</label><span class="inline"><input type="number" step="0.1" id="f_preview" value="${esc(S.preview && S.preview.start != null ? S.preview.start : "")}" placeholder="loudest 30 s" ${S.preview === false ? "disabled" : ""}>
        <label class="small"><input type="checkbox" id="f_nopreview" ${S.preview === false ? "checked" : ""}> no preview</label></span>
      <label>Guitar chords (%)</label><span class="inline"><input type="number" step="1" min="0" max="60" id="f_chords" value="${S.autochart && S.autochart.chords != null ? Math.round(S.autochart.chords * 100) : ""}" placeholder="auto" ${S.chart ? "disabled" : ""}><span class="small dim">${S.chart ? "not used: the gems were edited by hand" : "share of guitar gems that are chords; empty = from the music (official songs 4–49 %, median 19 %)"}</span></span>
      <label>Loudness (LUFS)</label><input type="number" step="0.5" id="f_loudness" value="${esc(S.loudness ?? "")}" placeholder="-14">
    </div></div>
    <div class="panel"><h4>Chart checks</h4><div id="checks" class="dim small">checking…</div></div>
  </div><div>
    <div class="panel"><h4>Stems</h4>${stemLines}${bleed}
      <div class="form" style="margin-top:10px">
        <label>Stems origin</label><select id="f_srcType">${opt([["unknown", "unknown"], ["official", "official multitracks"], ["multitrack", "other multitracks"], ["ai", "AI separation"]], src.type || "unknown")}</select>
        <label>Stem tool</label><input type="text" id="f_srcTool" value="${esc(src.tool || "")}" placeholder="${esc(PH.tool)}">
        <label>Quality</label><select id="f_srcQuality">${opt([["", "(not rated)"], ["low", "low"], ["medium", "medium"], ["high", "high"]], src.quality || "")}</select>
        <label>Notes</label><input type="text" id="f_srcNotes" value="${esc(src.notes || "")}" placeholder="bleed, missing parts…">
      </div></div>
    <div class="panel"><h4>Chart</h4><div class="form">
      <label>Source MIDI</label><span class="inline"><input type="text" id="f_midi" value="${esc(S.midi || "")}" placeholder="${esc(PH.midi)}" style="flex:1"><button onclick="pickInto('#f_midi','${folder}')">Browse…</button></span>
      <label>Gems</label><span>${s.chartSource === "edited" ? `edited in Pocket Encore (<span class="mono">${esc(S.chart)}</span>) <button class="danger" onclick="revertChart('${folder}')">Back to automatic chart</button><div class="warnline">The edited chart is in game time: changing the lead-in, the count-in or the stems' start moves the audio but not the gems.</div>` : "automatic (autochart from " + (S.midi ? "the MIDI" : "the stems") + ")"}</span>
      <label>Audio</label><span class="small">${au ? `length ${fmtTime(au.audioSeconds)}, lead-in ${au.lead ?? 0} s, music starts at ${au.musicStart ?? "–"} s` : "not built"}</span>
    </div></div>
    <div class="panel"><h4>Stars and gems (last build)</h4>${starsTable}</div>
  </div></div>
  <div class="actions"><button class="primary" id="save">Save song.json</button><button id="saveBuild">Save and build</button><span class="dim small">Writes songs/${esc(folder)}/song.json (the old one is kept as song.json.bak).</span></div>`;
  $("#f_nopreview").onchange = e => { $("#f_preview").disabled = e.target.checked; };
  $("#save").onclick = () => saveDetails(folder).catch(e => toast(e.message, true));
  $("#saveBuild").onclick = () => saveDetails(folder).then(() => runBuild(folder, "audio")).catch(e => toast(e.message, true));
  $("#calib").onclick = () => calibrate(folder);
  try {
    const c = await api("GET", `/api/checks/${folder}`);
    if ($("#checks")) { $("#checks").innerHTML = checksHtml(c); $("#checks").querySelectorAll("[data-at]").forEach(a => a.onclick = e => { e.preventDefault(); sessionStorage.seekTo = a.dataset.at; location.hash = `#/song/${folder}/editor`; }); }
  } catch (e) { if ($("#checks")) $("#checks").textContent = e.message; }
}
// Stars calibration: the game shows gold about 5 phrases before the end of a well-played song. If gold came with
// `left` of `total` phrases to go, the thresholds should move by (wanted fraction done) / (actual fraction done).
function calibrate(folder) {
  const B = CUR.built;
  $("#modalBox").innerHTML = `<b>Calibrate the star scale from a play</b>
    <p class="small dim">Play the song on Expert and note when the gold stars appeared. Official songs give gold with about 2–5 phrases left when played well.</p>
    <div class="form"><label>Phrases in the song</label><input type="number" id="c_total" value="${sessionStorage["c_total_" + folder] || ""}" placeholder="e.g. 36">
      <label>Phrases left at gold</label><input type="number" id="c_left" value="" placeholder="e.g. 10 (or 0 if gold never came)">
      <label>Score reached</label><input type="number" id="c_score" placeholder="optional">
      <label>Wanted phrases left</label><input type="number" id="c_want" value="4"></div>
    <div id="c_out" class="small" style="margin:10px 0"></div>
    <div class="actions"><button class="primary" id="c_apply" disabled>Use this scale</button><button id="c_cancel">Cancel</button></div>`;
  $("#modal").classList.remove("hidden");
  const upd = () => {
    const total = Number($("#c_total").value), left = Number($("#c_left").value), want = Number($("#c_want").value), score = Number($("#c_score").value);
    sessionStorage["c_total_" + folder] = total || "";
    const cur = Number(CUR.song.starsScale || 1);
    let r = null, why = "";
    if (total > 0 && left >= 0 && left < total) {
      const doneAtGold = (total - left) / total, wantDone = (total - want) / total;
      r = cur * wantDone / doneAtGold;
      why = `Gold came after ${(doneAtGold * 100).toFixed(0)}% of the phrases; it should come after ${(wantDone * 100).toFixed(0)}%, so the thresholds scale by ${(wantDone / doneAtGold).toFixed(3)}: starsScale ${cur} → <b>${r.toFixed(2)}</b>.`;
      if (B && B[3] && left === 0 && score) { r = cur * (score / (B[3].stars[5])) * 0.95; why = `Gold never came; your ${fmtN(score)} is ${(score / B[3].stars[5] * 100).toFixed(0)}% of the gold threshold ${fmtN(B[3].stars[5])}. Scaling so that score sits just above gold: starsScale ${cur} → <b>${r.toFixed(2)}</b>.`; }
    } else if (total > 0 && left >= total) why = "Gold at the very start? Check the numbers.";
    $("#c_out").innerHTML = why;
    $("#c_apply").disabled = !r;
    $("#c_apply").onclick = () => { $("#f_starsScale").value = r.toFixed(2); $("#modal").classList.add("hidden"); toast("Scale set; save and rebuild the chart to apply"); };
  };
  ["#c_total", "#c_left", "#c_want", "#c_score"].forEach(id => $(id).oninput = upd);
  $("#c_cancel").onclick = () => $("#modal").classList.add("hidden");
  upd();
}
function setOrDelete(o, k, v) { if (v === "" || v == null || (typeof v === "number" && isNaN(v))) delete o[k]; else o[k] = v; }
async function saveDetails(folder) {
  const S = JSON.parse(JSON.stringify(CUR.song)), v = id => $(id).value.trim();
  S.title = v("#f_title"); S.artist = v("#f_artist"); setOrDelete(S, "album", v("#f_album"));
  setOrDelete(S, "year", v("#f_year") ? Number(v("#f_year")) : ""); S.genre = v("#f_genre");
  setOrDelete(S, "vocals", v("#f_vocals") ? Number(v("#f_vocals")) : "");
  S.tiers = Object.assign({}, S.tiers);
  document.querySelectorAll("[data-tier]").forEach(e => S.tiers[e.dataset.tier] = Number(e.value));
  S.stems = Object.assign({}, S.stems);
  document.querySelectorAll("[data-stem]").forEach(e => setOrDelete(S.stems, e.dataset.stem, e.value.trim()));
  const src = Object.assign({}, S.stemSource);
  setOrDelete(src, "type", v("#f_srcType") === "unknown" ? "" : v("#f_srcType"));
  setOrDelete(src, "tool", v("#f_srcTool")); setOrDelete(src, "quality", v("#f_srcQuality")); setOrDelete(src, "notes", v("#f_srcNotes"));
  if (Object.keys(src).length) S.stemSource = src; else delete S.stemSource;
  setOrDelete(S, "midi", v("#f_midi"));
  if ($("#f_countIn").checked) S.countIn = true; else delete S.countIn;
  setOrDelete(S, "leadIn", v("#f_leadIn") === "" ? "" : Number(v("#f_leadIn")));
  setOrDelete(S, "starsScale", v("#f_starsScale") === "" ? "" : Number(v("#f_starsScale")));
  setOrDelete(S, "loudness", v("#f_loudness") === "" ? "" : Number(v("#f_loudness")));
  if ($("#f_chords") && !$("#f_chords").disabled) {
    const A = Object.assign({}, S.autochart), pc = v("#f_chords");
    if (pc === "") delete A.chords;
    else { const x = Number(pc); if (!(x >= 0 && x <= 60)) throw new Error("Guitar chords: 0-60 %"); A.chords = Math.round(x) / 100; }
    if (Object.keys(A).length) S.autochart = A; else delete S.autochart;
  }
  if ($("#f_nopreview").checked) S.preview = false;
  else if (v("#f_preview") !== "") S.preview = Object.assign(typeof S.preview === "object" ? S.preview : {}, { start: Number(v("#f_preview")) });
  else if (S.preview === false || (S.preview && S.preview.start != null)) delete S.preview;
  if (!S.title || !S.artist) throw new Error("title and artist are needed");
  CUR = await api("PUT", `/api/song/${folder}`, S);
  $("#crumb").innerHTML = `<a href="#/">Songs</a> / ${esc(S.title)} <span class="dim">(${esc(folder)})</span> ${statusBadge(CUR)}`;
  toast("song.json saved");
}
async function revertChart(folder) {
  if (!confirm("Use the automatic chart again? Your chart.mid stays in the song folder, but the build will no longer use it.")) return;
  await api("POST", `/api/chart-revert/${folder}`);
  toast("Back to the automatic chart: build to apply");
  route();
}
function showJson(folder) {
  $("#tab").innerHTML = `<div class="panel"><h4>songs/${esc(folder)}/song.json</h4>
    <textarea id="raw" rows="34" spellcheck="false">${esc(JSON.stringify(CUR.song, null, 2))}</textarea>
    <div class="actions" style="margin-top:8px"><button class="primary" id="saveRaw">Save</button><span class="dim small">Every option is listed at the top of scripts/mksong.js. Effect names: ${META.effects.filter(e => e !== "end").join(", ")}.</span></div></div>`;
  $("#saveRaw").onclick = async () => {
    try { const S = JSON.parse($("#raw").value); CUR = await api("PUT", `/api/song/${folder}`, S); toast("song.json saved"); }
    catch (e) { toast(e.message, true); }
  };
}

// ---------- new song ----------
// ---------- stems: slots, tooltips, drag and drop ----------
const STEM_SLOTS = ["drums", "bass", "guitar", "vocals", "fill"];
const MAX_DROP = 5;
// Hover text for each instrument (to be written).
const STEM_TIPS = { drums: "placeholder", bass: "placeholder", guitar: "placeholder", vocals: "placeholder", fill: "placeholder" };
const tip = k => `<span class="tip" data-tip="${esc(STEM_TIPS[k] || "")}">ⓘ</span>`;
// Instrument from the file name only (no audio analysis). Checked in this order, so "drum bass" is drums,
// "no_vocals"/"instrumental" is backing and "lead vocal" is vocals, not guitar.
const NAME_RULES = [
  ["fill", /no[ _.-]?vocals?|instrumental|karaoke|minus[ _.-]?one/i],
  ["vocals", /vocal|vox|voice|sing|acapella|a[ _.-]?cappella/i],
  ["drums", /drum|kit|perc/i],
  ["bass", /bass/i],
  ["guitar", /guitar|gtr/i],
  ["fill", /backing|back[ _.-]?track|other|accomp|keys|piano|synth|fill|rest|music/i],
];
function slotFromName(name) {
  const base = name.replace(/\.[^.]+$/, "");
  for (const [slot, re] of NAME_RULES) if (re.test(base)) return slot;
  return null;
}
// files -> { slot: File } for the stems, plus the MIDI; named files first, then the rest in the order given
function assignFiles(files, filled) {
  const out = {}, rest = [];
  let midi = null;
  for (const f of files) {
    const ext = "." + f.name.split(".").pop().toLowerCase();
    if (META.midiExt.includes(ext)) { midi = f; continue; }
    const s = slotFromName(f.name);
    if (s && !out[s]) out[s] = f; else rest.push(f);
  }
  const free = STEM_SLOTS.filter(s => !out[s] && !filled.includes(s));
  const unplaced = [];
  for (const f of rest) { const s = free.shift(); if (s) out[s] = f; else unplaced.push(f); }
  return { out, midi, unplaced };
}
function badFiles(files) {
  const ok = [...META.audioExt, ...META.midiExt];
  return files.filter(f => !ok.includes("." + f.name.split(".").pop().toLowerCase()));
}
async function uploadTo(input, file, batch) {
  input.value = ""; input.placeholder = `uploading ${file.name}…`;
  const r = await fetch(`/api/upload?name=${encodeURIComponent(file.name)}&batch=${batch}`, { method: "POST", body: file });
  const v = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(v.error || r.statusText);
  input.value = v.path; input.scrollLeft = input.scrollWidth; input.title = `${file.name} (${(file.size / 1048576).toFixed(1)} MB), copied into the song's stems folder when the song is created`;
}
function setupDrop() {
  const panel = $("#dropPanel"), zone = $("#dropzone");
  const batch = Date.now().toString(36);
  let depth = 0;
  panel.addEventListener("dragenter", e => { e.preventDefault(); depth++; panel.classList.add("dragging"); });
  panel.addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; panel.classList.remove("dragging"); } });
  panel.addEventListener("dragover", e => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; });
  panel.addEventListener("drop", async e => {
    e.preventDefault(); depth = 0; panel.classList.remove("dragging");
    const files = [...e.dataTransfer.files];
    if (!files.length) return;
    if (files.length > MAX_DROP) return toast(`${files.length} files dropped; at most ${MAX_DROP} at a time`, true);
    const bad = badFiles(files);
    if (bad.length) return toast(`Not supported: ${bad.map(f => f.name).join(", ")}. Audio: ${META.audioExt.join(" ")}; MIDI: ${META.midiExt.join(" ")}`, true);
    // dropped on one instrument's row with a single file: that slot, whatever the name says
    const row = e.target.closest && e.target.closest("[data-slot]");
    let plan;
    if (row && files.length === 1 && !META.midiExt.includes("." + files[0].name.split(".").pop().toLowerCase())) plan = { out: { [row.dataset.slot]: files[0] }, midi: null, unplaced: [] };
    else plan = assignFiles(files, STEM_SLOTS.filter(s => $("#n_stem_" + s).value.trim()));
    if (plan.midi && files.filter(f => META.midiExt.includes("." + f.name.split(".").pop().toLowerCase())).length > 1) toast("More than one MIDI dropped; using " + plan.midi.name, true);
    try {
      zone.textContent = "Copying the files…";
      for (const [slot, f] of Object.entries(plan.out)) await uploadTo($("#n_stem_" + slot), f, batch);
      if (plan.midi) await uploadTo($("#n_midi"), plan.midi, batch);
      const placed = Object.entries(plan.out).map(([s, f]) => `${f.name} → ${s}`).concat(plan.midi ? [`${plan.midi.name} → MIDI`] : []);
      toast(placed.join(" · ") + (plan.unplaced.length ? ` · no free slot for ${plan.unplaced.map(f => f.name).join(", ")}` : ""), !!plan.unplaced.length);
    } catch (err) { toast(err.message, true); }
    zone.innerHTML = zone.dataset.html;
  });
  zone.dataset.html = zone.innerHTML;
}

// Placeholders shared by the New song form and the Details tab (they say what each field is for).
const PH = {
  folder: "e.g. ZMYSONG: Z + capital letters/digits, the song's folder on the memory stick",
  title: "Song name, as shown in the game's song list",
  artist: "Band or artist name",
  album: "Album the song is from",
  year: "Release year, e.g. 1999 (sets the song's era)",
  midi: "None: will auto-generate chart from stems",
  tool: "eg: Fadr, Moises.ai, Lalal.ai",
  stem: k => k === "fill" ? "Backing: everything else in the song (optional)" : `${k[0].toUpperCase() + k.slice(1)} stem (required): drop a file or Browse…`,
};
const REQUIRED_STEMS = ["drums", "bass", "guitar", "vocals"];
function showNew() {
  $("#crumb").innerHTML = `<a href="#/">Songs</a> / New song`;
  const thisYear = new Date().getFullYear();
  const req = ' <span class="req">*</span>';
  const stemRow = k => `<div class="stemrow" data-slot="${k}"><label>${k}${REQUIRED_STEMS.includes(k) ? req : ""} ${tip(k)}</label>`
    + `<input type="text" id="n_stem_${k}" placeholder="${esc(PH.stem(k))}"${REQUIRED_STEMS.includes(k) ? ` data-req="${k} stem"` : ""}>`
    + `<button onclick="pickInto('#n_stem_${k}')">Browse…</button></div>`;
  $("#main").innerHTML = `<div class="grid2"><div class="panel"><h4>New song</h4><div class="form">
      <label>Folder${req}</label><input type="text" id="n_folder" placeholder="${esc(PH.folder)}" style="text-transform:uppercase" data-req="Folder">
      <label>Title${req}</label><input type="text" id="n_title" placeholder="${esc(PH.title)}" data-req="Title">
      <label>Artist${req}</label><input type="text" id="n_artist" placeholder="${esc(PH.artist)}" data-req="Artist">
      <label>Album${req}</label><input type="text" id="n_album" placeholder="${esc(PH.album)}" data-req="Album">
      <label>Year${req}</label><input type="number" id="n_year" min="1900" max="${thisYear}" placeholder="${esc(PH.year)}" data-req="Year" style="width:100%">
      <label>Genre${req}</label><select id="n_genre" data-req="Genre"><option value="">Choose the song list genre…</option>${opt(META.genres.map(g => [g, g]), "")}</select>
      <label>Lead vocals${req}</label><select id="n_vocals" data-req="Lead vocals"><option value="">Choose the singer shown in game…</option>${opt([[1, "male"], [2, "female"]], "")}</select>
    </div><p class="small dim"><span class="req">*</span> required</p></div>
    <div class="panel" id="dropPanel"><h4>Audio and chart</h4>
      <div class="dropzone" id="dropzone">Drop up to ${MAX_DROP} files here (stems and/or a MIDI). Each goes to the instrument its name mentions
        (drums, bass, guitar, vocals, backing…); the rest fill the empty slots in the order given.<br>
        <span class="small dim">Audio: ${META.audioExt.map(e => e.slice(1).toUpperCase()).join(", ")} (WAV: 16/24/32-bit or float, any rate, mono or stereo) · MIDI: ${META.midiExt.join(" ")}</span></div>
      ${STEM_SLOTS.map(stemRow).join("")}
      <div class="form" style="margin-top:10px">
        <label>MIDI</label><span class="inline"><input type="text" id="n_midi" placeholder="${esc(PH.midi)}" style="flex:1"><button onclick="pickInto('#n_midi')">Browse…</button></span>
        <label>Stems origin</label><select id="n_srcType">${opt([["ai", "AI separation"], ["official", "official multitracks"], ["multitrack", "other multitracks"], ["unknown", "unknown"]], "ai")}</select>
        <label>Stem tool</label><input type="text" id="n_srcTool" placeholder="${esc(PH.tool)}">
        <label>Quality</label><select id="n_srcQuality">${opt([["", "(not rated)"], ["low", "low"], ["medium", "medium"], ["high", "high"]], "")}</select>
        <label>Count-in</label><label class="inline"><input type="checkbox" id="n_countIn"> 4 stick clicks before the music</label>
      </div>
      <p class="small dim">Without a MIDI the chart is made from the stems. Tiers start at 2; set them on the Details tab.</p>
      <div class="actions"><button class="primary" id="n_create">Create</button><label class="small"><input type="checkbox" id="n_build" checked> and build now</label><span id="n_missing" class="small warnline"></span></div>
    </div></div>`;
  setupDrop();
  // a field marked missing is cleared as soon as it gets a value (typed, picked, dropped)
  document.querySelectorAll("[data-req]").forEach(el => ["input", "change"].forEach(t => el.addEventListener(t, () => { if (el.value.trim()) el.classList.remove("invalid"); if (!document.querySelector(".invalid")) $("#n_missing").textContent = ""; })));
  $("#n_create").onclick = async () => {
    const v = id => $(id).value.trim();
    const folder = v("#n_folder").toUpperCase();
    const bad = [];
    document.querySelectorAll("[data-req]").forEach(el => { const ok = !!el.value.trim(); el.classList.toggle("invalid", !ok); if (!ok) bad.push(el.dataset.req); });
    if (folder && !/^Z[A-Z0-9_]{1,30}$/.test(folder)) { $("#n_folder").classList.add("invalid"); bad.push("Folder (Z + capital letters/digits, e.g. ZMYSONG)"); }
    const year = Number(v("#n_year"));
    if (v("#n_year") && !(Number.isInteger(year) && year >= 1900 && year <= thisYear)) { $("#n_year").classList.add("invalid"); bad.push(`Year (1900–${thisYear})`); }
    if (bad.length) {
      $("#n_missing").textContent = "Missing or invalid: " + bad.join(", ");
      document.querySelector(".invalid")?.focus();
      return toast("Fill in the required fields first: " + bad.join(", "), true);
    }
    $("#n_missing").textContent = "";
    const S = { folder, title: v("#n_title"), artist: v("#n_artist"), album: v("#n_album"), year,
      genre: v("#n_genre"), tiers: { drums: 2, guitar: 2, bass: 2, vocals: 2, band: 2 }, vocals: Number(v("#n_vocals")), stems: {} };
    for (const k of STEM_SLOTS) if (v("#n_stem_" + k)) S.stems[k] = v("#n_stem_" + k);
    if (v("#n_midi")) S.midi = v("#n_midi");
    S.stemSource = { type: v("#n_srcType") };
    if (v("#n_srcTool")) S.stemSource.tool = v("#n_srcTool");
    if (v("#n_srcQuality")) S.stemSource.quality = v("#n_srcQuality");
    if ($("#n_countIn").checked) S.countIn = true;
    try {
      await api("POST", "/api/new", S);
      location.hash = `#/song/${folder}`;
      if ($("#n_build").checked) runBuild(folder, "audio");
    } catch (e) { toast(e.message, true); }
  };
}

// ---------- file picker ----------
async function pickInto(selector, folder, dirs) {
  const target = $(selector);
  let cur = localStorage.pickDir || "";
  const open = async dir => {
    let r;
    try { r = await api("GET", "/api/ls?dir=" + encodeURIComponent(dir || "")); } catch (e) { toast(e.message, true); return; }
    localStorage.pickDir = r.dir;
    $("#modalBox").innerHTML = `<b>${dirs ? "Pick a folder" : "Pick a file"}</b><div class="mono small dim" style="margin-top:6px">${esc(r.dir)}</div>
      <div class="filelist">${r.parent ? `<div class="d" data-p="${esc(r.parent)}">..</div>` : ""}
      ${r.entries.map(e => `<div class="${e.dir ? "d" : ""}" data-p="${esc(r.dir + "\\" + e.name)}" data-file="${e.dir ? "" : 1}">${e.dir ? "📁 " : ""}${esc(e.name)}</div>`).join("")}</div>
      <div class="actions"><input type="text" id="pickPath" style="flex:1" placeholder="or type a folder path"><button id="pickGo">Go</button>${dirs ? '<button id="pickThis" class="primary">Use this folder</button>' : ""}<button id="pickCancel">Cancel</button></div>`;
    document.querySelectorAll(".filelist div").forEach(d => d.onclick = async () => {
      if (!d.dataset.file) return open(d.dataset.p);
      if (dirs) return;
      let p = d.dataset.p;
      if (folder) p = (await api("GET", `/api/relpath/${folder}?p=${encodeURIComponent(p)}`)).rel;
      target.value = p; $("#modal").classList.add("hidden");
    });
    $("#pickGo").onclick = () => open($("#pickPath").value.trim());
    if (dirs) $("#pickThis").onclick = () => { target.value = r.dir; $("#modal").classList.add("hidden"); };
    $("#pickCancel").onclick = () => $("#modal").classList.add("hidden");
  };
  $("#modal").classList.remove("hidden");
  await open(cur);
}

// ---------- builds ----------
let es = null;
function showBuildPanel(show = true) { $("#buildPanel").classList.toggle("hidden", !show); }
$("#buildToggle").onclick = () => { showBuildPanel($("#buildPanel").classList.contains("hidden")); followBuild(); };
$("#buildClose").onclick = () => showBuildPanel(false);
async function runBuild(folder, from) {
  if (window.editorDirty && window.editorDirty() && !confirm("The editor has unsaved changes; build without them?")) return;
  try { await api("POST", `/api/build/${folder}?from=${from}`); } catch (e) { toast(e.message, true); return; }
  showBuildPanel(true);
  followBuild();
}
function logLine(log, l) {
  const div = document.createElement("div");
  div.textContent = l;
  if (/error|failed|missing/i.test(l)) div.className = "err"; else if (/^\[|^done|copy /.test(l.trim())) div.className = "hl";
  const stick = log.scrollTop + log.clientHeight >= log.scrollHeight - 30;
  log.appendChild(div);
  if (stick) log.scrollTop = log.scrollHeight;
}
async function showStoredLog(folder) {
  if (es) { es.close(); es = null; }
  const log = $("#buildLog"); log.innerHTML = "";
  showBuildPanel(true);
  $("#buildTitle").textContent = `Last build of ${folder} (build.log)`; $("#buildState").innerHTML = "";
  try { const r = await fetch(`/api/buildlog/${folder}`); if (!r.ok) throw new Error((await r.json()).error); (await r.text()).split(/\r?\n/).forEach(l => logLine(log, l)); log.scrollTop = log.scrollHeight; }
  catch (e) { logLine(log, "error: " + e.message); }
}
function followBuild() {
  if (es) es.close();
  const log = $("#buildLog");
  log.innerHTML = "";
  es = new EventSource("/api/build");
  es.addEventListener("start", e => { const d = JSON.parse(e.data); $("#buildTitle").textContent = `Build ${d.folder} (from ${d.from})`; $("#buildState").innerHTML = '<span class="badge warn">running…</span>'; });
  es.addEventListener("line", e => logLine(log, JSON.parse(e.data)));
  es.addEventListener("end", e => {
    const code = JSON.parse(e.data);
    es.close(); es = null;
    if (code === "none") { $("#buildTitle").textContent = "Build"; $("#buildState").innerHTML = '<span class="dim">nothing built yet in this session (a song\'s "Last log" button shows its log from disk)</span>'; return; }
    $("#buildState").innerHTML = code === "0" ? '<span class="badge ok">done</span> <span class="small dim">copy the song folder and ZZCUSTOMDB from out\\MUSIC to the memory stick</span>' : `<span class="badge bad">failed (exit ${esc(code)})</span>`;
    log.scrollTop = log.scrollHeight;
    if (code === "0" && !(window.editorDirty && window.editorDirty())) route();
  });
}

(async () => {
  META = await api("GET", "/api/meta");
  $("#setupLink").classList.toggle("warn", !META.setupOk);
  renderModeBadge();
  route();
})();
