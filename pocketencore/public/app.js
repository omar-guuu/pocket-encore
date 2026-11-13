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
  const h = location.hash.replace(/^#\/?/, "").split("/");
  try {
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
  const setupNote = META.setupOk ? "" : `<div class="panel warnline">Setup is incomplete: builds will fail until the missing pieces are installed. <a href="#/setup">Open Setup</a>.</div>`;
  $("#main").innerHTML = setupNote + `
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

// ---------- setup ----------
async function showSetup() {
  $("#crumb").innerHTML = `<a href="#/">Songs</a> / Setup`;
  const s = await api("GET", "/api/setup");
  const row = (k, label) => { const c = s.checks[k]; return `<tr><td>${c.ok ? '<span class="badge ok">ok</span>' : '<span class="badge bad">missing</span>'}</td><td>${label}</td><td class="mono small">${esc(c.detail)}</td><td class="small">${!c.ok && c.url ? (c.url.startsWith("http") ? `<a href="${esc(c.url)}" target="_blank">${esc(c.url)}</a>` : esc(c.url)) : ""}</td></tr>`; };
  $("#main").innerHTML = `<div class="panel"><h4>What the tool needs</h4>
    <p class="small dim">Pocket Encore and its scripts are ours; the pieces below are not, so they are not included. Install each one and set its path here (saved in <span class="mono">${esc(s.file)}</span>).</p>
    <table class="t setup"><tr><th></th><th>Piece</th><th>Found</th><th>Where to get it</th></tr>
      ${row("node", "Node.js (runs Pocket Encore and the scripts)")}${row("python", "Python 3.12 (charting, stem analysis, count-in, mid2rbu)")}${row("packages", "Python packages mido, numpy, miniaudio")}
      ${row("mid2rbu", "mid2rbu (Rock Band MIDI → .rbu chart)")}${row("at3tool", "at3tool.exe (ATRAC3 encoder for the audio)")}${row("music", "The game's MUSIC folder with your official DLC (donor chart and song list)")}</table></div>
    <div class="panel"><h4>Paths</h4><div class="form" style="grid-template-columns:160px 1fr auto">
      <label>MUSIC folder</label><input type="text" id="s_music" value="${esc(s.settings.music)}"><button onclick="pickInto('#s_music', null, true)">Browse…</button>
      <label>python.exe</label><input type="text" id="s_python" value="${esc(s.settings.python)}"><button onclick="pickInto('#s_python')">Browse…</button>
      <label>at3tool.exe</label><input type="text" id="s_at3tool" value="${esc(s.settings.at3tool)}"><button onclick="pickInto('#s_at3tool')">Browse…</button>
      <label>mid2rbu.py</label><input type="text" id="s_mid2rbu" value="${esc(s.settings.mid2rbu)}"><button onclick="pickInto('#s_mid2rbu')">Browse…</button>
    </div><div class="actions" style="margin-top:10px"><button class="primary" id="s_save">Save and check again</button>
      <span class="small dim">Python packages: open a console and run <span class="mono">pip install mido numpy miniaudio</span> (with the same python.exe).</span></div></div>`;
  $("#s_save").onclick = async () => {
    try {
      const r = await api("PUT", "/api/settings", { music: $("#s_music").value, python: $("#s_python").value, at3tool: $("#s_at3tool").value, mid2rbu: $("#s_mid2rbu").value });
      META.setupOk = r.ok; toast(r.ok ? "Setup complete" : "Saved; some pieces are still missing", !r.ok); showSetup();
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
  const stemLines = s.stems.map(st => `<div class="stemrow"><label>${st.part} ${tip(st.part)}</label><input type="text" data-stem="${st.part}" value="${esc(st.source || "")}" placeholder="(none)">
      <button onclick="pickInto('[data-stem=${st.part}]','${folder}')">Browse…</button><div class="stemstat">${stemLine(st)}</div></div>`).join("");
  const bleed = s.bleed && s.bleed.length ? `<div class="small warnline" style="margin-top:6px">Possible bleed (stems that rise and fall together): ${s.bleed.map(b => `${b.a} ↔ ${b.b} (${(b.corr * 100).toFixed(0)}%)`).join(", ")}. Normal for a real band playing together; with AI stems it usually means one instrument leaked into another's track.</div>` : "";
  const B = s.built;
  const starsTable = B ? `<table class="t"><tr><th>Difficulty</th><th>Drums</th><th>Bass</th><th>Guitar</th><th>Vocals</th><th>5★</th><th>Gold</th><th>Max</th></tr>
    ${B.map((d, i) => `<tr><td>${DIFFS[i]}</td>${d.gems.map(n => `<td>${n}</td>`).join("")}<td>${fmtN(d.stars[4])}</td><td>${fmtN(d.stars[5])}</td><td>${fmtN(d.max)}</td></tr>`).join("")}</table>
    <div class="small dim" style="margin-top:6px">Gems per part and star scores from the last build (estimated max × starsScale ${S.starsScale ?? 1}).</div>` : `<div class="dim">Not built yet.</div>`;
  const au = s.audio;
  $("#tab").innerHTML = `<div class="grid2"><div>
    <div class="panel"><h4>Song</h4><div class="form">
      <label>Title</label><input type="text" id="f_title" value="${esc(S.title)}">
      <label>Artist</label><input type="text" id="f_artist" value="${esc(S.artist)}">
      <label>Album</label><input type="text" id="f_album" value="${esc(S.album)}">
      <label>Year</label><input type="number" id="f_year" value="${esc(S.year)}">
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
      <label>Loudness (LUFS)</label><input type="number" step="0.5" id="f_loudness" value="${esc(S.loudness ?? "")}" placeholder="-14">
    </div></div>
    <div class="panel"><h4>Chart checks</h4><div id="checks" class="dim small">checking…</div></div>
  </div><div>
    <div class="panel"><h4>Stems</h4>${stemLines}${bleed}
      <div class="form" style="margin-top:10px">
        <label>Source</label><select id="f_srcType">${opt([["unknown", "unknown"], ["official", "official multitracks"], ["multitrack", "other multitracks"], ["ai", "AI separation"]], src.type || "unknown")}</select>
        <label>Tool</label><input type="text" id="f_srcTool" value="${esc(src.tool || "")}" placeholder="e.g. fadr, demucs">
        <label>Quality</label><select id="f_srcQuality">${opt([["", "(not rated)"], ["low", "low"], ["medium", "medium"], ["high", "high"]], src.quality || "")}</select>
        <label>Notes</label><input type="text" id="f_srcNotes" value="${esc(src.notes || "")}" placeholder="bleed, missing parts…">
      </div></div>
    <div class="panel"><h4>Chart</h4><div class="form">
      <label>Source MIDI</label><span class="inline"><input type="text" id="f_midi" value="${esc(S.midi || "")}" placeholder="(none: charted from the stems)" style="flex:1"><button onclick="pickInto('#f_midi','${folder}')">Browse…</button></span>
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

function showNew() {
  $("#crumb").innerHTML = `<a href="#/">Songs</a> / New song`;
  $("#main").innerHTML = `<div class="grid2"><div class="panel"><h4>New song</h4><div class="form">
      <label>Folder</label><span class="inline"><input type="text" id="n_folder" placeholder="ZMYSONG" style="text-transform:uppercase"><span class="small dim">Z + capital letters/digits</span></span>
      <label>Title</label><input type="text" id="n_title">
      <label>Artist</label><input type="text" id="n_artist">
      <label>Album</label><input type="text" id="n_album">
      <label>Year</label><input type="number" id="n_year">
      <label>Genre</label><select id="n_genre">${opt(META.genres.map(g => [g, g]), "ROCK")}</select>
      <label>Lead vocals</label><select id="n_vocals">${opt([[1, "male"], [2, "female"]], 1)}</select>
    </div></div>
    <div class="panel" id="dropPanel"><h4>Audio and chart</h4>
      <div class="dropzone" id="dropzone">Drop up to ${MAX_DROP} files here (stems and/or a MIDI). Each goes to the instrument its name mentions
        (drums, bass, guitar, vocals, backing…); the rest fill the empty slots in the order given.<br>
        <span class="small dim">Audio: ${META.audioExt.map(e => e.slice(1).toUpperCase()).join(", ")} (WAV: 16/24/32-bit or float, any rate, mono or stereo) · MIDI: ${META.midiExt.join(" ")}</span></div>
      ${STEM_SLOTS.map(k => `<div class="stemrow" data-slot="${k}"><label>${k} ${tip(k)}</label><input type="text" id="n_stem_${k}" placeholder="${k === "fill" ? "backing / everything else (optional)" : "(none)"}"><button onclick="pickInto('#n_stem_${k}')">Browse…</button></div>`).join("")}
      <div class="form" style="margin-top:10px">
        <label>MIDI (optional)</label><span class="inline"><input type="text" id="n_midi" placeholder="none: chart from the stems" style="flex:1"><button onclick="pickInto('#n_midi')">Browse…</button></span>
        <label>Stems from</label><select id="n_srcType">${opt([["ai", "AI separation"], ["official", "official multitracks"], ["multitrack", "other multitracks"], ["unknown", "unknown"]], "ai")}</select>
        <label>Tool</label><input type="text" id="n_srcTool" placeholder="e.g. fadr">
        <label>Quality</label><select id="n_srcQuality">${opt([["", "(not rated)"], ["low", "low"], ["medium", "medium"], ["high", "high"]], "")}</select>
        <label>Count-in</label><label class="inline"><input type="checkbox" id="n_countIn"> 4 stick clicks before the music</label>
      </div>
      <p class="small dim">Stems: WAV, MP3, FLAC or OGG. Without a MIDI the chart is made from the stems (needs at least drums). Tiers start at 2; set them on the Details tab.</p>
      <div class="actions"><button class="primary" id="n_create">Create</button><label class="small"><input type="checkbox" id="n_build" checked> and build now</label></div>
    </div></div>`;
  setupDrop();
  $("#n_create").onclick = async () => {
    const v = id => $(id).value.trim();
    const folder = v("#n_folder").toUpperCase();
    const S = { folder, title: v("#n_title"), artist: v("#n_artist"), album: v("#n_album") || undefined, year: v("#n_year") ? Number(v("#n_year")) : undefined,
      genre: v("#n_genre"), tiers: { drums: 2, guitar: 2, bass: 2, vocals: 2, band: 2 }, vocals: Number(v("#n_vocals")), stems: {} };
    for (const k of STEM_SLOTS) if (v("#n_stem_" + k)) S.stems[k] = v("#n_stem_" + k);
    if (v("#n_midi")) S.midi = v("#n_midi");
    S.stemSource = { type: v("#n_srcType") };
    if (v("#n_srcTool")) S.stemSource.tool = v("#n_srcTool");
    if (v("#n_srcQuality")) S.stemSource.quality = v("#n_srcQuality");
    if ($("#n_countIn").checked) S.countIn = true;
    try {
      if (!S.title || !S.artist) throw new Error("title and artist are needed");
      if (!Object.keys(S.stems).length) throw new Error("pick at least one stem");
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
  route();
})();
