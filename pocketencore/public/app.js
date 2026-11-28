"use strict";
// Pocket Encore page: library, song details (song.json form), new song, setup, builds. The chart editor is editor.js,
// the Effects & Band Anims tab anims.js (both on the shared time line, timeline.js).
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
  Object.assign(d.style, { position: "fixed", right: "16px", top: top + "px", background: bad ? "var(--toast-bad)" : "var(--toast-ok)", color: "var(--text)", border: "1px solid " + (bad ? "var(--bad-line)" : "var(--ok-line)"), padding: "8px 14px", borderRadius: "6px", zIndex: 30, maxWidth: "50vw" });
  document.body.appendChild(d);
  setTimeout(() => d.remove(), bad ? 6000 : 2500);
}
// error toast with context: "Couldn't save the pack: <server message>". Errors thrown with .user = true are already
// written for the user and are shown as they are.
const fail = ctx => e => toast(e && e.user ? e.message : `${ctx}: ${e && e.message || e}`, true);
const userError = msg => Object.assign(new Error(msg), { user: true });
// accessible names for form fields: the forms are grids of <label>Name</label><field> without for=/id, so a screen
// reader announced the fields with no name. Link each such label to the field right after it (or the first field
// inside the element right after it). Runs on everything the app renders, so new pages and dialogs are covered too.
let fieldSeq = 0;
function linkLabels(root) {
  root.querySelectorAll("label:not([for])").forEach(l => {
    if (l.querySelector("input,select,textarea") || !l.textContent.trim()) return;  // wraps its field, or a help row
    let f = l.nextElementSibling;
    if (f && !f.matches("input,select,textarea")) f = f.matches("label") ? null : f.querySelector("input,select,textarea");
    if (!f || (f.labels && f.labels.length) || f.hasAttribute("aria-label")) return;
    if (!f.id) f.id = "fld" + ++fieldSeq;
    l.htmlFor = f.id;
  });
}
new MutationObserver(ms => {
  const roots = new Set(); for (const m of ms) if (m.addedNodes.length && m.target.nodeType === 1) roots.add(m.target);
  roots.forEach(linkLabels);
}).observe(document.body, { childList: true, subtree: true });
linkLabels(document.body);
// a confirmation in the app's own modal, with buttons named after their action (not OK/Cancel).
// buttons: [{ label, value, kind: "primary" | "danger" }]; resolves to the clicked value, or null on Escape/backdrop.
let modalReturn = null;  // where focus was before a dialog moved it inside itself (set by ask, used when it closes)
let askPending = null;  // the open ask()'s close function: a new ask (e.g. the Back button pressed meanwhile) closes it as "no"
// ---------- Easy / Advanced Edit Mode ----------
// Controls that make a song easy to get wrong are read-only (greyed, 🔒) in Easy Edit Mode, the default. Advanced Edit
// Mode unlocks them after a warning. One setting for the whole app (this computer): pages listen for "editmodechange".
// What belongs to which mode: Help → Easy and Advanced Edit Mode.
window.editMode = () => { try { return localStorage["pe.editMode"] === "advanced" ? "advanced" : "easy"; } catch { return "easy"; } };
async function setEditMode(m) {
  if (m === "advanced" && window.editMode() !== "advanced") {
    const r = await ask("Enable Advanced Edit Mode?", "Sure you want to enable advanced edit? This option should only be used if you know what you are doing, most of the time is better to stick with Easy Edit Mode, for more information check the help page", [
      { label: "Enable Advanced Edit Mode", value: "on", kind: "danger" }, { label: "Open the help page", value: "help" }, { label: "Stay in Easy Edit Mode", value: null, kind: "primary" }]);
    if (r === "help") { window.open("#/help/editmodes", "_self"); return; }
    if (r !== "on") return;
  }
  try { localStorage["pe.editMode"] = m === "advanced" ? "advanced" : "easy"; } catch { }
  window.dispatchEvent(new Event("editmodechange"));
  toast(m === "advanced" ? "Advanced Edit Mode on: the locked controls can be changed." : "Back to Easy Edit Mode.");
}
window.setEditMode = setEditMode;
window.editModeButton = () => window.editMode() === "advanced"
  ? `<button class="advmode on" onclick="setEditMode('easy')" title="Advanced Edit Mode is on: locked controls can be changed. Click to go back to Easy Edit Mode.">⚠ Advanced Edit Mode</button>`
  : `<button class="advmode" onclick="setEditMode('advanced')" title="Easy Edit Mode: controls marked 🔒 are read-only. Click to unlock them (asks first).">Enable Advanced Edit Mode</button>`;

function ask(title, body, buttons) {
  if (askPending) askPending(null);
  return new Promise(resolve => {
    const modal = $("#modal");
    $("#modalBox").innerHTML = `<b>${esc(title)}</b>${body ? `<p>${esc(body)}</p>` : ""}<div class="actions" style="margin-top:12px">`
      + buttons.map((b, i) => `<button data-i="${i}"${b.kind ? ` class="${b.kind}"` : ""}>${esc(b.label)}</button>`).join("") + "</div>";
    const done = v => { askPending = null; modal.classList.add("hidden"); modal.onclick = null; window.removeEventListener("keydown", onKey, true); resolve(v); };
    askPending = done;
    const onKey = e => { if (e.key === "Escape") { e.stopPropagation(); done(null); } };
    $("#modalBox").querySelectorAll("button[data-i]").forEach(b => b.onclick = () => done(buttons[b.dataset.i].value));
    modal.onclick = e => { if (e.target === modal) done(null); };
    window.addEventListener("keydown", onKey, true);
    if (!$("#modalBox").contains(document.activeElement)) modalReturn = document.activeElement;
    modal.classList.remove("hidden");
    // focus the main choice; in a dialog whose main choice is dangerous (Delete…), the safe one, so Enter can't delete
    const safe = buttons.findIndex(b => b.value == null);
    ($("#modalBox .primary") || (buttons.some(b => b.kind === "danger") && safe >= 0 ? $(`#modalBox button[data-i="${safe}"]`) : null) || $("#modalBox button")).focus();
  });
}

// Every dialog shares #modal. While one is open: it is announced as a dialog named by its title, Tab stays inside it, Esc
// closes it (ask() handles its own Esc; the others through their Cancel / Close / Remind me later button), and focus goes
// back to where it was when it closes.
(() => {
  const modal = document.getElementById("modal"), box = document.getElementById("modalBox");
  let opener = null, lastOutside = null;
  document.addEventListener("focusin", e => { if (!box.contains(e.target)) lastOutside = e.target; }, true);
  const focusables = () => [...box.querySelectorAll('button, [href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])')].filter(e => !e.disabled && e.offsetParent);
  new MutationObserver(() => {
    const open = !modal.classList.contains("hidden");
    if (open && !opener) {
      const a = document.activeElement;
      opener = a && a !== document.body && !box.contains(a) ? a : [modalReturn, lastOutside].find(x => x && x !== document.body && x.isConnected) || document.body;
      modalReturn = null;
      const t = box.querySelector("b"); if (t) t.id = "modalTitle";
      box.setAttribute("role", "dialog"); box.setAttribute("aria-modal", "true"); box.setAttribute("aria-labelledby", "modalTitle");
      setTimeout(focusIn, 0);
    } else if (!open && opener) {
      // back where it was; a button inside a closed menu (More → Delete pack) gives the menu's summary instead
      const o = opener; opener = null;
      const back = o.isConnected && o.offsetParent ? o : o.isConnected && o.closest("details") ? o.closest("details").querySelector("summary") : null;
      if (back && (box.contains(document.activeElement) || document.activeElement === document.body)) back.focus();  // unless the dialog moved focus on purpose
    }
  }).observe(modal, { attributes: true, attributeFilter: ["class"] });
  // dialogs that fill in after opening (the file picker) or redraw (a folder opened in it): focus moves in again
  function focusIn() { if (!modal.classList.contains("hidden") && !box.contains(document.activeElement)) { const f = box.querySelector(".primary:not(:disabled)") || focusables()[0]; if (f) f.focus(); } }
  new MutationObserver(() => { const t = box.querySelector("b"); if (t && !t.id) t.id = "modalTitle"; setTimeout(focusIn, 0); }).observe(box, { childList: true });
  window.addEventListener("keydown", e => {
    if (modal.classList.contains("hidden")) return;
    if (e.key === "Tab") {
      const f = focusables(); if (!f.length) return;
      const i = f.indexOf(document.activeElement);
      if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && (i === -1 || i === f.length - 1)) { e.preventDefault(); f[0].focus(); }
    } else if (e.key === "Escape" && !askPending) {
      const c = box.querySelector('[id$="Cancel"], [id$="_cancel"], [id$="Close"], #updLater');
      if (c) { e.preventDefault(); e.stopPropagation(); c.click(); }
    }
  }, true);
})();

// ---------- unsaved changes ----------
// The page on screen registers what leaving it would lose: GUARD = { what, dirty(), save() }. save() resolves to true
// when saved (or throws); a page without save (New song) can only be discarded. route() asks before leaving, runBuild()
// before building, and closing the window warns. The chart editor reports through window.editorDirty / editorSave.
let GUARD = null;
const formState = root => [...root.querySelectorAll("input, select, textarea")].filter(e => !e.dataset.noguard).map(e => e.type === "checkbox" ? e.checked : e.value).join("\u0001");
// guard every field under root: dirty when any differs from when the page opened (or was last saved)
function guardForm(root, what, save) {
  let base = formState(root);
  GUARD = { what, save, dirty: () => root.isConnected && formState(root) !== base, saved: () => { base = formState(root); } };
}
const markSaved = () => { if (GUARD && GUARD.saved) GUARD.saved(); };
function pageGuard() {
  if (window.editorDirty && window.editorDirty()) return { what: "the chart", save: window.editorSave };
  if (window.animsDirty && window.animsDirty()) return { what: "the effects and band animations", save: window.animsSave };
  return GUARD && GUARD.dirty() ? GUARD : null;
}
async function saveGuard(g) {
  try { return !!(await g.save()); } catch (e) { fail(`Couldn't save ${g.what}`)(e); return false; }
}
// true when it is fine to leave the page: saved, or the changes discarded
async function confirmLeave(g) {
  if (!g.save) {  // nothing to save: leave (discard) or stay. g.leave words it for the page (default: New song)
    const L = g.leave || { title: "Leave without creating the song?", body: "What you've filled in will be lost.", discard: "Discard new song" };
    return await ask(L.title, L.body, [{ label: L.discard, value: "discard", kind: "danger" }, { label: "Keep editing", value: null }]) === "discard";
  }
  const a = await ask(`Leave without saving ${g.what}?`, "Your changes are only kept if you save them.", [
    { label: "Save and leave", value: "save", kind: "primary" },
    { label: "Discard changes", value: "discard", kind: "danger" },
    { label: "Keep editing", value: null }]);
  return a === "discard" || (a === "save" && await saveGuard(g));
}
const fmtN = n => n == null ? "–" : Number(n).toLocaleString("en-US");
const starStr = n => "★".repeat(n) + "☆".repeat(Math.max(0, 6 - n));
const fmtTime = s => { if (s == null || !isFinite(s)) return "–"; const m = Math.floor(s / 60); return `${m}:${(s - m * 60).toFixed(1).padStart(4, "0")}`; };

// ---------- theme: Auto (follows Windows) / Light / Dark; index.html applies it before the first paint ----------
const THEME_MQ = matchMedia("(prefers-color-scheme: light)");
function themePref() { try { return localStorage.peTheme || "auto"; } catch { return "auto"; } }
function applyTheme() {
  const p = themePref();
  document.documentElement.dataset.theme = p === "auto" ? (THEME_MQ.matches ? "light" : "dark") : p;
  window.dispatchEvent(new Event("themechange"));  // the chart editor redraws its canvas
}
THEME_MQ.addEventListener("change", () => { if (themePref() === "auto") applyTheme(); });
// the choice lives on Settings → Look (System Default / Light / Dark)
function setTheme(p) { try { localStorage.peTheme = p; } catch { } applyTheme(); }

// the top bar: the section of the page on screen is highlighted
function markNav(h) {
  const sec = h === "stick" ? "stick" : h === "packs" || h === "pack" || h === "merge" ? "share" : h === "setup" ? "setup" : h === "help" ? "help" : h === "welcome" ? "" : "songs";
  document.querySelectorAll("#top [data-nav]").forEach(a => { const on = a.dataset.nav === sec; a.classList.toggle("on", on); if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
}

// ---------- routing ----------
let skipRoute = false, leaving = false, lastHash = location.hash;
async function route(ev) {
  if (skipRoute) { skipRoute = false; return; }
  const g = ev && !leaving ? pageGuard() : null;
  if (g) {
    // stay on the page while asking; go on to the new one only after Save and leave / Discard changes
    const target = location.hash;
    skipRoute = true; location.hash = lastHash;
    if (!(await confirmLeave(g))) return;
    leaving = true; location.hash = target;
    return;
  }
  leaving = false;
  GUARD = null;
  lastHash = location.hash;
  if (window.editorClose) window.editorClose();
  if (window.animsClose) window.animsClose();
  document.body.classList.remove("editing");
  document.body.classList.remove("onboarding");
  const h = location.hash.replace(/^#\/?/, "").split("/");
  markNav(h[0]);
  $("#crumb").textContent = "";
  try {
    if (h[0] === "help") return showHelp(h[1]);
    if (!META.configured || h[0] === "welcome") { if (h[0] !== "welcome") { skipRoute = true; location.hash = "#/welcome"; lastHash = location.hash; } return await showWelcome(); }
    if (h[0] === "song" && h[1]) await showSong(h[1], h[2] || "details");
    else if (h[0] === "new") showNew();
    else if (h[0] === "setup") await showSetup();
    else if (h[0] === "packs") await showPacks();
    else if (h[0] === "stick") await showSticks(h[1] === "pack" && h[2] ? { id: h[2], mode: h[3] === "off" ? "uninstall" : "install" } : null);
    else if (h[0] === "merge") await showMerge();
    else if (h[0] === "help") showHelp(h[1]);
    else if (h[0] === "pack" && h[1] && h[2] === "share") await showPackShare(h[1]);
    else if (h[0] === "pack" && h[1]) await showPackEdit(h[1]);
    else await showLibrary();
  } catch (e) { $("#main").innerHTML = `<div class="panel">Couldn't load this page: ${esc(e.message)}. Try again, or restart Pocket Encore if it keeps happening.</div>`; }
}
window.addEventListener("hashchange", route);
window.addEventListener("beforeunload", e => { if (pageGuard()) { e.preventDefault(); e.returnValue = ""; } });

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
// Songs (home): the main task first (make a song), then managing and sharing, then your songs with where each one is.
async function showLibrary() {
  const list = await api("GET", "/api/songs");
  const sort = localStorage.libSort || "title";
  list.sort((a, b) => sort === "title" ? String(a.song?.title).localeCompare(String(b.song?.title)) : sort === "changed" ? (b.builtAt || 0) - (a.builtAt || 0) : a.folder.localeCompare(b.folder));
  const setupNote = META.setupOk ? "" : `<div class="notice warn"><b>Pocket Encore needs one more thing before it can make songs.</b> <a href="#/setup">Open Settings</a> to see what's missing.</div>`;
  const dbNote = META.db && META.db.stale ? `<div class="notice warn"><b>Your game changed</b> (now ${esc(META.mode.label)}) since your song list was made. Rebuild any song, then update your memory stick.</div>` : "";
  $("#main").innerHTML = `<div class="home">
    ${setupNote}${dbNote}
    <section class="hero" aria-labelledby="heroTitle">
      <div><h1 id="heroTitle">Make a new custom song for Rock Band Unplugged</h1>
        <p>Drop the custom song's audio tracks (and a MIDI if you have one to generate the chart from there, or autogenerate if you don't have one). Pocket Encore will handle the files automatically to be easily installed in the game.</p></div>
      <button class="primary big" onclick="location.hash='#/new'">Make a new song</button>
    </section>
    <div class="tasks">
      <section class="task"><h2>Manage my custom songs</h2><p class="small dim" id="stickLine">Checking your memory stick…</p>
        <div class="actions" id="stickAct"><button onclick="location.hash='#/stick'">See memory stick</button></div></section>
      <section class="task"><h2>Share &amp; Packs</h2><p class="small dim">Make a pack for your game or a friend's, or add songs someone shared with you.</p>
        <div class="actions"><button onclick="location.hash='#/packs'">Go to Share &amp; Packs</button></div></section>
    </div>
    <div class="bar"><h2>Your songs <span class="small dim">· ${list.length}</span></h2>
      <div class="actions"><input id="filter" type="search" aria-label="Find a song" placeholder="Find a song…" value="${esc(localStorage.libFilter || "")}">
        <select id="sort" aria-label="Sort songs"><option value="title">by title</option><option value="changed">last built</option><option value="folder">by folder name</option></select></div></div>
    <div id="noMatch" class="small dim hidden"></div>
    <div class="songgrid">
      <a class="addsong" href="#/new"><b>+ Make a new song</b><span class="small">from audio tracks and a MIDI</span></a>
      ${list.map(s => {
        if (s.error) return `<div class="songcard"><b>${esc(s.folder)}</b><span class="small" style="color:var(--bad)">${esc(s.error)}</span></div>`;
        const S = s.song, st = songState(s, null);
        return `<div class="songcard" data-f="${esc(s.folder)}" data-q="${esc((S.title + " " + S.artist + " " + s.folder).toLowerCase())}">
          <a class="songtitle" href="#/song/${esc(s.folder)}">${esc(S.title)}</a>
          <span class="small dim">${esc(S.artist)}${S.year ? " · " + esc(S.year) : ""}${S.genre ? " · " + esc(S.genre) : ""}${s.audio ? " · " + fmtTime(s.audio.audioSeconds) : ""}${S.imported ? " · shared with you" : ""}</span>
          <span class="state" data-state>${stateHtml(st)}</span>
          <div class="actions" data-act>${stateAction(s, st)}</div>
        </div>`;
      }).join("")}
    </div></div>`;
  $("#sort").value = sort;
  $("#sort").onchange = e => { localStorage.libSort = e.target.value; showLibrary(); };
  const filt = () => {
    const q = $("#filter").value.toLowerCase(); localStorage.libFilter = q; let shown = 0;
    document.querySelectorAll(".songcard[data-q]").forEach(c => { const hit = c.dataset.q.includes(q); c.classList.toggle("hidden", !hit); shown += hit; });
    const nm = $("#noMatch"); nm.textContent = `No songs match "${$("#filter").value}".`; nm.classList.toggle("hidden", !q || shown > 0 || !list.length);
  };
  $("#filter").oninput = filt; filt();
  libraryStickPanel(list);
}
// a song's state in plain words: [kind ok | todo | new, text]; x = its row on the memory stick (or null before the check)
function songState(s, x) {
  if (s.status === "not built") return ["todo", "Not made yet"];
  if (s.status === "changed since build") return ["todo", "Changed: rebuild it to play the new version"];
  if (!x) return ["", "Made"];
  if (x.state === "missing") return x.off ? ["", "Not added in game"] : ["new", "Not on your memory stick yet"];
  if (x.state === "installed") return x.listed ? ["ok", "On your memory stick"] : ["todo", "On your memory stick, but the game doesn't list it yet"];
  return ["todo", "Changed: update your memory stick"];
}
const stateHtml = ([k, t]) => `<span class="sdot ${k}" aria-hidden="true"></span>${esc(t)}`;
function stateAction(s, [k, t]) {
  const open = `<a class="btn" href="#/song/${esc(s.folder)}">Open</a>`;
  if (k === "new") return `<a class="btn" href="#/stick">Install on memory stick</a>${open}`;
  if (k === "todo" && /memory stick|game doesn't list/.test(t)) return `<a class="btn" href="#/stick">Update on memory stick</a>${open}`;
  return open;
}
// the memory stick summary on the home page, and each song card's state
async function libraryStickPanel(list) {
  let v;
  try { v = await loadSticks(); } catch (e) { if ($("#stickLine")) $("#stickLine").textContent = "Couldn't check the memory stick."; return; }
  const line = $("#stickLine"); if (!line) return;
  const st = v.sticks.find(s => s.online && s.kind === "ppsspp") || v.sticks.find(s => s.online) || v.sticks[0];
  if (!st) { line.innerHTML = `No memory stick found yet. Set PPSSPP's memory stick on <a href="#/setup">Settings</a>, or connect your PSP by USB.`; return; }
  const where = st.kind === "ppsspp" ? "in PPSSPP" : "on your PSP";
  const mine = st.songs.filter(x => x.built && x.inLibrary), ok = mine.filter(x => x.state === "installed" && x.listed).length;
  const upd = mine.filter(x => x.state === "older" || x.state === "different" || (x.state === "installed" && !x.listed)).length, notIn = mine.filter(x => x.state === "missing" && !x.off).length;
  const other = st.db && st.db.state === "other";
  line.innerHTML = other ? `<b>The game is showing someone else's song list</b>, so your custom songs are hidden. Update your memory stick to put yours back.`
    : `${ok} of ${mine.length} custom songs are installed ${where}${upd ? ` – ${upd} ${upd > 1 ? "need" : "needs"} an update` : ""}${notIn ? `${upd ? "," : " –"} ${notIn} not installed` : ""}.${st.online ? "" : ` <span class="dim">(last checked ${esc(whenTxt(st.at))})</span>`}`;
  $("#stickAct").innerHTML = `<button ${other || upd || notIn ? 'class="primary"' : ""} onclick="location.hash='#/stick'">${other || upd || notIn ? "Update memory stick" : "See memory stick"}</button>`;
  for (const s of list || []) {
    if (s.error) continue;
    const card = document.querySelector(`.songcard[data-f="${s.folder}"]`); if (!card) continue;
    const x = st.songs.find(y => y.folder === s.folder) || { state: "missing" }, k = songState(s, x);
    card.querySelector("[data-state]").innerHTML = stateHtml(k);
    card.querySelector("[data-act]").innerHTML = stateAction(s, k);
  }
}
async function openFolder(folder, what) {
  try { await api("POST", `/api/open/${folder || "ZNONE"}?what=${what}`); } catch (e) { fail("Couldn't open the folder")(e); }
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
      <p>Game: <b>${esc(m.label)}</b>. Songs are built on ${esc(m.donorName)}.</p>
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
  const recheck = async redetect => { if (redetect) OB.settings = null; else grab(); try { await obCheck(redetect); } catch (e) { fail("Couldn't check the setup")(e); } showWelcome(); };
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
    } catch (e) { fail("Couldn't save the setup")(e); }
  };
}
function renderModeBadge() {
  const el = $("#modeBadge");
  if (!el || !META.mode) return;
  const m = META.mode, stale = META.db && META.db.stale;
  el.className = "badge " + (stale ? "warn" : m.mode === "disc" ? "" : "ok");
  el.textContent = m.label + (stale ? " · rebuild needed" : "");
  el.title = `Game: ${m.label}. Songs are built on ${m.donorName}.` +
    (stale ? ` The song database was built for "${META.db.was}": build any song to update it.` : "") + " Checked every time Pocket Encore starts.";
}

// ---------- settings (was Setup): the game, the look, editing, updates and the tools ----------
const CHECK_NAME = { node: ["Node.js", "runs Pocket Encore"], python: ["Python 3.12", "charting and audio analysis"], packages: ["Python packages", "mido, numpy, miniaudio"],
  mid2rbu: ["mid2rbu", "turns a chart into the game's format"], at3tool: ["at3tool", "encodes the audio for the PSP"], game: ["Rock Band Unplugged", "your game (US, ULUS10418)"] };
function gameText(m) {
  const cov = m.coverage ? `${m.coverage.present} of the ${m.coverage.listed} DLC songs` : `${m.dlc || 0} DLC song${m.dlc === 1 ? "" : "s"}`;
  return m.complete ? [`Rock Band Unplugged (US) with all its DLC songs (${cov})`, "Your custom songs are added to the DLC song list, so every DLC song stays in the game."]
    : m.mode !== "disc" ? [`Rock Band Unplugged (US) with some DLC songs (${cov})`, "Your custom songs are added to your DLC song list, so your DLC songs stay in the game."]
    : ["Rock Band Unplugged (US), base game", "No DLC was found: your custom songs are listed with the base game's songs."];
}
async function showSetup() {
  const s = await api("GET", "/api/setup");
  const missing = Object.keys(CHECK_NAME).filter(k => s.checks[k] && !s.checks[k].ok);
  const adv = window.editMode() === "advanced", lockTools = !adv && !missing.length;
  const fix = k => { const c = s.checks[k], [n, what] = CHECK_NAME[k];
    return `<li><b>${n}</b> wasn't found (${what}). ${c.url ? (c.url.startsWith("http") ? `<a href="${esc(c.url)}" target="_blank">Where to get it</a>` : esc(c.url)) : ""}</li>`; };
  const [gTitle, gText] = gameText(s.mode), theme = themePref();
  const path = (id, label, val, dir, locked) => `<label for="s_${id}">${label}</label><span class="inline"><input type="text" id="s_${id}" value="${esc(val)}" ${locked ? "disabled" : ""}><button onclick="pickInto('#s_${id}'${dir ? ", null, true" : ""})" ${locked ? "disabled" : ""}>Choose…</button></span>`;
  $("#main").innerHTML = `<div class="settings"><h1>Settings</h1>
    ${missing.length ? `<section class="notice bad"><h2>Pocket Encore needs ${missing.length > 1 ? missing.length + " more things" : "one more thing"}</h2>
        <ul>${missing.map(fix).join("")}</ul>
        <p class="small">Install it, set where it is under <b>Tools</b> below (or <b>Your game</b>), then press <b>Save and check again</b>.${missing.includes("packages") ? ` Python packages: in a console, run <span class="mono">"${esc(s.settings.python)}" -m pip install mido numpy miniaudio</span>.` : ""}</p></section>`
      : `<section class="notice ok"><b>Pocket Encore has everything it needs.</b> <span class="small dim">Checked when it started.</span></section>`}
    <div class="grid2">
      <section class="panel"><h2>Your game</h2>
        <p><b>${esc(gTitle)}</b></p><p class="small dim">${esc(gText)} Pocket Encore checks this every time it starts.</p>
        <div class="form">${path("music", "PPSSPP memory stick (MUSIC folder)", s.settings.music, true, false)}${path("iso", "Disc image (ISO or CSO)", s.settings.iso, false, false)}</div>
        <p class="small dim">A PSP connected by USB is found by itself on the Memory stick page. <a href="#/welcome" onclick="OB.step=0;OB.check=null;OB.settings=null">Run the first-time setup again</a></p></section>
      <section class="panel"><h2>Look</h2>
        <div class="seg" role="radiogroup" aria-label="Theme">${[["auto", "System Default"], ["light", "Light"], ["dark", "Dark"]].map(([k, n]) => `<button role="radio" data-theme-set="${k}" class="${theme === k ? "on" : ""}" aria-checked="${theme === k}">${n}</button>`).join("")}</div>
        <h2 class="gap">Editing</h2>
        <label class="sw"><input type="checkbox" id="s_adv" data-noguard="1" ${adv ? "checked" : ""}><span>Advanced Edit Mode</span></label>
        <p class="small dim">Off (Easy Edit Mode) keeps settings that are easy to get wrong read-only and marked 🔒. Turning it on asks first. <a href="#/help/editmodes">What changes?</a></p></section>
    </div>
    <div class="grid2">
      <div id="updHost"></div>
      <details class="panel" ${missing.length || adv ? "open" : ""}><summary><b>Tools</b> ${lockTools ? `<span class="small dim">· 🔒 read-only in Easy Edit Mode</span>` : ""}</summary>
        <table class="t setup">${Object.keys(CHECK_NAME).map(k => { const c = s.checks[k]; if (!c) return ""; const [n, what] = CHECK_NAME[k];
          return `<tr><td><span class="badge ${c.ok ? "ok" : "bad"}">${c.ok ? "OK" : "not found"}</span></td><td><b>${n}</b><div class="small dim">${what}</div></td><td class="mono small">${esc(c.detail)}</td></tr>`; }).join("")}</table>
        <div class="form">${path("python", "python.exe", s.settings.python, false, lockTools)}${path("at3tool", "at3tool.exe", s.settings.at3tool, false, lockTools)}${path("mid2rbu", "mid2rbu.py", s.settings.mid2rbu, false, lockTools)}</div>
        <p class="small dim">Saved in <span class="mono">${esc(s.file)}</span>.</p></details>
    </div>
    <div class="actions"><button class="primary" id="s_save">Save and check again</button></div></div>`;
  $("#updHost").outerHTML = updatePanel();
  bindUpdatePanel();
  document.querySelectorAll("[data-theme-set]").forEach(b => b.onclick = () => {
    setTheme(b.dataset.themeSet);
    document.querySelectorAll("[data-theme-set]").forEach(x => { const on = x === b; x.classList.toggle("on", on); x.setAttribute("aria-checked", on); });
  });
  $("#s_adv").onchange = async e => { e.target.checked = window.editMode() === "advanced"; await setEditMode(window.editMode() === "advanced" ? "easy" : "advanced"); };
  const saveSetup = async () => {
    const v = id => $("#s_" + id).value;
    const r = await api("PUT", "/api/settings", { iso: v("iso"), music: v("music"), python: v("python"), at3tool: v("at3tool"), mid2rbu: v("mid2rbu") });
    markSaved();
    META = await api("GET", "/api/meta"); $("#setupLink").classList.toggle("warn", !META.setupOk);
    toast(r.ok ? "Everything Pocket Encore needs was found" : "Saved; something is still missing", !r.ok);
    return true;
  };
  $("#s_save").onclick = () => saveSetup().then(() => showSetup(), fail("Couldn't save the settings"));
  guardForm($("#main"), "the settings", saveSetup);
}
// Settings follows the edit mode switch (it is the one place for it)
window.addEventListener("editmodechange", () => { if (/^#\/setup/.test(location.hash)) showSetup(); });

// ---------- Share: packs (sets of your songs, for your own game or a friend's) and Merge Songs ----------
// A pack is installed on your memory stick through the Memory stick page (its songs switched on, every other song off:
// one pack at a time); "Installed on your memory stick" = the song list there lists exactly the pack's songs.
let PK = null;  // packs view from the server
const fmtDate = s => s ? new Date(s).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "";
async function savePacks(packs) { PK = await api("PUT", "/api/packs", { packs: packs.map(p => ({ id: p.id, name: p.name, songs: p.songs, zip: !!p.zip })) }); return PK; }
// [kind, text, detail]: Not made yet / Update ready / Up to date
function packState(p) {
  if (!p.built) return ["new", "Not made yet", "Make the pack to share it"];
  const same = p.built.folders && p.built.folders.length === p.songs.length && p.built.folders.every(x => p.songs.includes(x.folder));
  if (!same) return ["todo", "Update ready", "Its songs changed since you made it"];
  if (p.outdated.length) return ["todo", "Update ready", `${p.outdated.length} of its songs changed since you made it`];
  if (p.renamed) return ["todo", "Update ready", "Renamed since you made it"];
  if (p.zip && !p.built.zip) return ["todo", "Update ready", "Its .zip file isn't made yet"];
  return ["ok", "Up to date", ""];
}
const packReady = p => packState(p)[0] === "ok";
// the pack the memory stick has now (its song list lists exactly the pack's songs), or null
function activePackOf(packs, s) {
  if (!s || !ourStickDb(s)) return null;
  const lib = new Set(s.songs.filter(x => x.inLibrary).map(x => x.folder));
  return packs.find(p => { const songs = p.songs.filter(f => lib.has(f)); return songs.length && sameSet(songs, s.db.customs); }) || null;
}
const mainStick = v => v && (v.sticks.find(s => s.online && s.kind === "ppsspp") || v.sticks.find(s => s.online)) || null;
async function showPacks() {
  $("#main").innerHTML = `<div class="panel dim">Loading your packs…</div>`;
  let v = null;
  [PK, v] = await Promise.all([api("GET", "/api/packs"), loadSticks().catch(() => null)]);
  const st = mainStick(v), active = activePackOf(PK.packs, st);
  $("#main").innerHTML = `<div class="sharepage">
    <h1>Share &amp; Packs</h1>
    <div class="tasks">
      <section class="task"><h2>Share your songs in a pack</h2><p class="small dim">Select your custom songs and Pocket Encore will pack them to be easily installed in your game or a friend's game. Want to make a pack for Metal Music and another for Classic Rock? Pocket Encore packs allow you to easily manage both.</p>
        <div class="actions"><a class="btn primary" href="#/pack/new">Make a pack</a></div></section>
      <section class="task"><h2>Merge Songs</h2><p class="small dim">Got a pack or a song folder from someone? Add these shared songs to your custom songs list, then install them to play them like your own.</p>
        <div class="actions"><a class="btn primary" href="#/merge">Merge songs</a></div></section>
    </div>
    <section class="panel"><h2>Your packs</h2>
      ${PK.packs.length ? `<div class="srows">${PK.packs.map(p => { const [k, t, d] = packState(p), on = active && active.id === p.id;
        return `<div class="srow" data-id="${esc(p.id)}"><div class="rt"><b>${esc(p.display)}</b><span class="small dim">${p.songs.length} song${p.songs.length === 1 ? "" : "s"} · ${p.mb} MB${p.built ? ` · made ${esc(fmtDate(p.built.at))}` : ""}${p.missing.length ? ` · ${p.missing.length} no longer in your songs` : ""}</span></div>
          <div class="rs">${on ? `<span class="state"><span class="sdot ok" aria-hidden="true"></span>Installed on your memory stick</span>` : ""}
            ${k === "ok" ? (on ? "" : `<span class="state"><span class="sdot ok" aria-hidden="true"></span>Up to date</span>`) : `<span class="state"><span class="sdot ${k}" aria-hidden="true"></span>${t}</span><span class="small dim">${esc(d)}</span>`}</div>
          <div class="ctl">${k !== "ok" ? `<button class="small" data-a="build" aria-label="${p.built ? "Update pack" : "Make the pack"}: ${esc(p.display)}">${p.built ? "Update pack" : "Make the pack"}</button>` : ""}
            ${on ? `<a class="btn small" href="#/stick/pack/${esc(p.id)}/off" aria-label="Uninstall: ${esc(p.display)}">Uninstall</a>` : `<button class="small" data-a="install" aria-label="${active ? "Install instead" : "Install on my memory stick"}: ${esc(p.display)}">${active ? "Install instead" : "Install on my memory stick"}</button>`}
            <a class="btn small" href="#/pack/${esc(p.id)}/share" aria-label="Share it: ${esc(p.display)}">Share it</a>
            <details class="menu"><summary class="small" aria-label="More: ${esc(p.display)}">More</summary><div class="menubox"><a class="btn small" href="#/pack/${esc(p.id)}">Change its songs</a><button class="small danger" data-a="del">Delete pack</button></div></details></div></div>`; }).join("")}</div>`
      : `<p class="dim">No packs yet. Make one to put a set of songs in your game, or to share songs with a friend.</p>`}
      ${PK.packs.length > 1 ? `<p class="small dim">One pack is installed at a time: installing a pack uninstalls the other one (its songs leave the game, nothing is deleted).</p>` : ""}
    </section></div>`;
  document.querySelectorAll(".sharepage [data-a]").forEach(b => b.onclick = async () => {
    const id = b.closest(".srow").dataset.id, p = PK.packs.find(x => x.id === id), a = b.dataset.a;
    if (a === "build") return makePack(p, `#/packs`);
    if (a === "install") return installPack(p);
    if (a === "del") {
      if (await ask(`Delete the pack "${p.display}"?`, "Your songs are not touched: only the pack goes, with its folder and .zip file.", [{ label: "Delete pack", value: true, kind: "danger" }, { label: "Keep pack", value: null }]) !== true) return;
      try { await savePacks(PK.packs.filter(x => x.id !== id)); toast(`${p.display} deleted (your songs are not touched)`); showPacks(); } catch (e) { fail("Couldn't delete the pack")(e); }
    }
  });
}
// Install on my memory stick: the Memory stick page with the pack's songs switched on (its songs made first if needed)
async function installPack(p) {
  if (p.outdated.length) {
    const r = await ask(`Update ${p.display} first?`, `${p.outdated.length} of its songs ${p.outdated.length > 1 ? "aren't" : "isn't"} made with your latest changes yet. Updating the pack makes ${p.outdated.length > 1 ? "them" : "it"} first.`, [
      { label: "Update pack, then install", value: "build", kind: "primary" }, { label: "Install as it is", value: "go" }, { label: "Cancel", value: null }]);
    if (!r) return;
    if (r === "build") return makePack(p, `#/stick/pack/${p.id}`);
  }
  location.hash = `#/stick/pack/${p.id}`;
}
// build (make or update) a pack with progress on the page, then go to `then` (or show what went wrong)
async function makePack(p, then) {
  try { await api("POST", `/api/packbuild/${p.id}`); } catch (e) { return fail("Couldn't start making the pack")(e); }
  const steps = (p.outdated.length || 0) + 1 + (p.zip ? 1 : 0);
  let done = 0, last = "", err = [];
  $("#main").innerHTML = `<div class="sharepage"><section class="panel"><h2>Making ${esc(p.display)}…</h2><div class="meter" aria-hidden="true"><i id="pkMeter" style="width:5%"></i></div>
    <p class="small dim" id="pkLine" aria-live="polite">Starting…</p><p class="small dim">The Build log (top right) shows every step.</p></section></div>`;
  $("#buildToggle").classList.remove("hidden");
  window.onBuildLine = l => {
    if (/^\n?=== /.test(l)) done++;
    if (/ERROR/.test(l)) err.push(l.replace(/^\s*ERROR:\s*/, ""));
    if (l.trim()) last = l.trim();
    const m = $("#pkMeter"); if (m) m.style.width = Math.round(100 * Math.min(done, steps) / (steps + 1)) + "%";
    const t = $("#pkLine"); if (t) t.textContent = last;
  };
  window.onBuildEnd = code => {
    window.onBuildLine = window.onBuildEnd = null;
    if (!$("#pkMeter")) return false;
    if (code === "0") { toast(`${p.display} is ready`); if (location.hash === then) route(); else location.hash = then; return true; }
    $("#main").innerHTML = `<div class="sharepage"><section class="panel notice bad"><h2>${esc(p.display)} couldn't be made</h2><p>${esc(err.join(" ") || "Something went wrong.")}</p>
      <p class="small dim">The Build log (top right) shows every step.</p><div class="actions"><a class="btn primary" href="#/packs">Back to Share &amp; Packs</a><button onclick="showBuildPanel(true)">Show the log</button></div></section></div>`;
    return true;
  };
  followBuild();
}
// Make a pack (#/pack/new) or change its songs (#/pack/<id>)
async function showPackEdit(id) {
  PK = await api("GET", "/api/packs");
  const isNew = id === "new", p = isNew ? { id: "", name: "", songs: [], zip: true } : PK.packs.find(x => x.id === id);
  if (!p) { $("#main").innerHTML = `<div class="panel">No such pack. <a href="#/packs">Back to Share &amp; Packs</a></div>`; return; }
  const songs = PK.songs.filter(s => !s.error).sort((a, b) => String(a.title).localeCompare(String(b.title)));
  const E = { sel: new Set(p.songs.filter(f => songs.some(s => s.folder === f))), q: "", zip: isNew ? true : !!p.zip, name: p.name || "" };
  const code = String(Math.round((Date.UTC(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()) - Date.UTC(2008, 2, 7)) / 86400000)).padStart(6, "0");
  const render = () => {
    const q = E.q.toLowerCase(), shown = songs.filter(s => !q || `${s.title} ${s.artist} ${s.genre} ${s.folder}`.toLowerCase().includes(q));
    const chosen = songs.filter(s => E.sel.has(s.folder)), n = chosen.length, mb = chosen.reduce((a, s) => a + (s.mb || 0), 0), over = n > PK.capacity;
    const allOn = shown.length && shown.every(s => E.sel.has(s.folder)), todo = chosen.filter(s => s.status !== "built").length;
    $("#main").innerHTML = `<div class="sharepage packedit">
      <div><a href="#/packs" class="small">← Share &amp; Packs</a></div>
      <section class="panel"><h1>${isNew ? "Make a pack" : `Change the songs of ${esc(p.display)}`}</h1>
        <p class="dim">Pick the songs for this pack, for example all your metal songs. You can install it on your memory stick, share it with a friend, or both.</p>
        <div class="form"><label for="pkName">Pack name</label><div><input id="pkName" maxlength="60" placeholder="e.g. Metal night (empty: Pocket Encore ${code})" value="${esc(E.name)}">
          <div class="small dim">Shown to your friend when they add it.</div></div></div></section>
      <section class="panel"><div class="bar"><h2>Songs <span class="small dim">· ${n} picked · ${mb.toFixed(1)} MB</span></h2>
          <input type="search" id="pkq" placeholder="Find a song, artist or genre…" aria-label="Find a song, artist or genre" value="${esc(E.q)}"></div>
        <div class="listtools"><span class="small dim">${shown.length} shown</span><div class="actions">
          <button class="small" id="pkAll" ${allOn ? "disabled" : ""}>${q ? `Pick these ${shown.length}` : "Pick all"}</button><button class="small" id="pkNone" ${n ? "" : "disabled"}>Pick none</button></div></div>
        ${shown.length ? `<div class="srows">${shown.map(s => `<label class="srow pick"><input type="checkbox" data-pk="${esc(s.folder)}" ${E.sel.has(s.folder) ? "checked" : ""}>
          <span class="rt"><b>${esc(s.title)}</b><span class="small dim">${esc(s.artist)}${s.genre ? " · " + esc(s.genre) : ""}</span></span>
          <span class="small dim">${s.status === "built" ? "" : s.status === "not built" ? "Not made yet: made with the pack" : "Changed: made again with the pack"}</span><span class="small dim">${s.mb ? s.mb + " MB" : ""}</span></label>`).join("")}</div>`
          : `<p class="small dim">${songs.length ? "No songs match." : `No songs yet: <a href="#/new">make your first song</a>.`}</p>`}
        ${!isNew && p.missing.length ? `<p class="small warnline">No longer in your songs (left out when you save): ${esc(p.missing.join(", "))}</p>` : ""}</section>
      <section class="panel"><label class="sw wrap"><input type="checkbox" id="pkZip" ${E.zip ? "checked" : ""}><span>Also save it as one .zip file, ready to send</span></label>
        <div class="notice"><b>Before you share</b><p class="small">A pack has the songs' audio in it. Only share songs whose audio you're allowed to share.</p></div></section>
      <div class="applybar"><span>${n ? `<b>${n} song${n > 1 ? "s" : ""}</b> · ${mb.toFixed(1)} MB${todo ? ` · ${todo} to make first` : ""}${over ? ` <span class="warnline">The game holds at most ${PK.capacity} custom songs: remove ${n - PK.capacity}.</span>` : ""}` : `<span class="dim">Pick at least one song</span>`}</span>
        <button class="primary big" id="pkMake" ${n && !over ? "" : "disabled"}>${isNew ? "Make the pack" : "Save and update the pack"}</button></div></div>`;
    bind();
  };
  const keep = fn => { const y = window.scrollY, a = document.activeElement, sel = a && (a.id ? "#" + a.id : a.dataset.pk ? `[data-pk="${a.dataset.pk}"]` : null), c = a && a.id === "pkq" ? a.selectionStart : null;
    fn(); render(); window.scrollTo({ top: y }); const b = sel && $(sel); if (b) { b.focus(); if (c != null) b.setSelectionRange(c, c); } };
  const bind = () => {
    $("#pkName").oninput = e => { E.name = e.target.value; };
    $("#pkq").oninput = e => keep(() => { E.q = e.target.value; });
    document.querySelectorAll("[data-pk]").forEach(c => c.onchange = () => keep(() => { c.checked ? E.sel.add(c.dataset.pk) : E.sel.delete(c.dataset.pk); }));
    $("#pkAll").onclick = () => keep(() => document.querySelectorAll("[data-pk]").forEach(c => E.sel.add(c.dataset.pk)));
    $("#pkNone").onclick = () => keep(() => E.sel.clear());
    $("#pkZip").onchange = e => { E.zip = e.target.checked; };
    $("#pkMake").onclick = async () => { const saved = await save(); if (saved) { GUARD = null; makePack(saved, `#/pack/${saved.id}/share`); } };
  };
  // saves the pack (name, songs, .zip choice); resolves to the saved pack, or null
  const save = async () => {
    const name = E.name.trim();
    if (!E.sel.size) { toast("Pick at least one song for the pack.", true); return null; }
    if (name && PK.packs.some(x => x.id !== p.id && (x.name || "").toLowerCase() === name.toLowerCase())) { toast("Another pack already has that name. Choose a different one.", true); return null; }
    const list = songs.map(s => s.folder).filter(f => E.sel.has(f));
    const all = isNew ? [...PK.packs, { id: "", name, songs: list, zip: E.zip }] : PK.packs.map(x => x.id === p.id ? { ...x, name, songs: list, zip: E.zip } : x);
    try { const r = await savePacks(all); return isNew ? r.packs[r.packs.length - 1] : r.packs.find(x => x.id === p.id); } catch (e) { fail("Couldn't save the pack")(e); return null; }
  };
  const base = () => [E.name.trim(), [...E.sel].sort().join(), E.zip].join("|"), start = base();
  GUARD = { what: "the pack", save: async () => !!(await save()), dirty: () => !!$("#pkMake") && base() !== start };
  render();
}
// Share it (#/pack/<id>/share): what to send, and what your friend does
async function showPackShare(id) {
  PK = await api("GET", "/api/packs");
  const p = PK.packs.find(x => x.id === id);
  if (!p) { $("#main").innerHTML = `<div class="panel">No such pack. <a href="#/packs">Back to Share &amp; Packs</a></div>`; return; }
  const ready = packReady(p), z = !!(p.built && p.built.zip);
  $("#main").innerHTML = `<div class="sharepage packshare"><div><a href="#/packs" class="small">← Share &amp; Packs</a></div>
    ${ready ? `<section class="panel donebox"><h2>${esc(p.display)} is ready</h2><p class="small dim">${p.built.folders.length} songs · ${p.built.mb} MB</p>
        <p>${z ? `Send <b>${esc(p.built.name)}.zip</b> to your friend.` : `Send the <b>${esc(p.built.name)}</b> folder to your friend.`}</p>
        <div class="actions"><button class="primary" id="psInstall">Install it on my memory stick</button><button id="psShow">Show the ${z ? "zip file" : "folder"} to share</button><a class="btn" href="#/packs">Back to Share &amp; Packs</a></div></section>`
      : `<section class="panel notice warn"><h2>${esc(p.display)} ${p.built ? "needs an update" : "isn't made yet"}</h2><p>${esc(packState(p)[2])}. ${p.built ? "Update it" : "Make it"} first, so your friend gets your latest songs.</p>
        <div class="actions"><button class="primary" id="psBuild">${p.built ? "Update pack" : "Make the pack"}</button><a class="btn" href="#/packs">Back to Share &amp; Packs</a></div></section>`}
    <section class="panel"><h2>What your friend does</h2>
      <ol class="steps"><li><b>With Pocket Encore:</b> Share &amp; Packs → <i>Merge Songs</i> → pick the ${z ? "zip file" : "folder"}. Then install the songs from their Memory stick page.</li>
        <li><b>Without Pocket Encore:</b> copy what's inside the pack's <span class="mono">MUSIC</span> folder into <span class="mono">PSP\\GAME\\ULUS10418\\MUSIC</span> on their memory stick. This replaces their custom song list with yours, so their own custom songs stop showing.</li></ol></section></div>`;
  if ($("#psInstall")) $("#psInstall").onclick = () => installPack(p);
  if ($("#psShow")) $("#psShow").onclick = () => api("POST", `/api/packopen/${p.id}${z ? "?what=zip" : ""}`).catch(fail("Couldn't show the pack"));
  if ($("#psBuild")) $("#psBuild").onclick = () => makePack(p, `#/pack/${p.id}/share`);
}

// ---------- Merge Songs: a .zip, a pack folder or one song folder from someone -> your songs ----------
let MG = { stage: "pick" };
// from elsewhere (Memory stick page: Add to my library): straight to what's in that folder
function importFrom(dir) { MG = { stage: "pick", look: dir }; if (location.hash === "#/merge") showMerge(); else location.hash = "#/merge"; }
async function showMerge() {
  if (MG.look) { const d = MG.look; MG = { stage: "pick" }; return mergeLook(d); }
  if (MG.stage === "adding") MG = { stage: "pick" };
  renderMerge();
}
async function mergeLook(dir) {
  let c;
  $("#main").innerHTML = `<div class="sharepage"><section class="panel dim">Looking for songs…</section></div>`;
  try { c = await api("GET", "/api/import?dir=" + encodeURIComponent(dir)); } catch (e) { MG = { stage: "pick" }; renderMerge(); return fail("Couldn't find songs there")(e); }
  MG = { stage: "found", dir: c.root, c, sel: new Set(c.songs.filter(s => s.ok && !s.inLibrary).map(s => s.folder)) };
  renderMerge();
}
function renderMerge() {
  const back = `<div><a href="#/packs" class="small">← Share &amp; Packs</a></div>`;
  let body = "";
  if (MG.stage === "pick") body = `${back}<section class="panel"><h1>Merge songs</h1>
      <p class="dim">Pick the pack your friend sent: a .zip file, a pack folder, or a single song folder. Nothing is added until you confirm.</p>
      <div class="dropzone mgdrop" id="mgDrop"><b>Drop the .zip file here</b><span class="small dim">or</span>
        <div class="actions"><button class="primary" id="mgChoose">Choose the zip file or folder…</button></div><input type="hidden" id="mgPath"></div></section>`;
  else if (MG.stage === "found") {
    const c = MG.c, add = c.songs.filter(s => MG.sel.has(s.folder)), mine = c.songs.filter(s => s.yours).length;
    body = `<div><button class="linkbtn small" id="mgBack">← Pick another</button></div>
      <section class="panel"><h1>${esc(c.pack || "Shared songs")}</h1><p class="small dim">${c.songs.length} song${c.songs.length === 1 ? "" : "s"} found${mine ? ` · ${mine} made by you` : ""}</p>
        ${c.songs.length ? `<div class="srows">${c.songs.map(s => { const d = s.details, why = s.problem || (s.inLibrary ? "Already in your songs" : "");
          return `<label class="srow pick"><input type="checkbox" data-mg="${esc(s.folder)}" ${why ? "disabled" : MG.sel.has(s.folder) ? "checked" : ""}>
            <span class="rt"><b>${esc(d.title || s.folder)}</b><span class="small dim">${esc(d.artist || "")}${d.year ? " · " + esc(d.year) : ""} · ${s.mb} MB</span></span>
            <span class="state"><span class="sdot ${why ? "" : "new"}" aria-hidden="true"></span>${why ? esc(why) : "New"}</span>
            <span class="small dim">${!why && s.needsDetails ? "Its details are missing: fill them in after adding it" : ""}</span></label>`; }).join("")}</div>`
          : `<p>No song folders there.</p>`}
        <div class="notice"><b>Good to know</b><p class="small">Shared songs come with their own chart and audio, used as they are. You can change their song info and difficulty, but not their notes.</p></div></section>
      <div class="applybar"><span>${add.length ? `<b>${add.length} song${add.length > 1 ? "s" : ""} to add</b>` : `<span class="dim">Pick at least one song</span>`}</span>
        <button class="primary big" id="mgAdd" ${add.length ? "" : "disabled"}>Add to my songs</button></div>`;
  } else if (MG.stage === "adding") body = `<section class="panel"><h2>Adding ${MG.added.length} song${MG.added.length > 1 ? "s" : ""} to your songs…</h2>
      <div class="meter" aria-hidden="true"><i id="mgMeter" style="width:10%"></i></div><p class="small dim" id="mgLine" aria-live="polite">Copying…</p></section>`;
  else if (MG.stage === "done") {
    const n = MG.added.length, need = MG.added.filter(x => x.needsDetails);
    body = `<section class="panel donebox"><h2>${n} song${n > 1 ? "s" : ""} added to your songs</h2>
      <p>To play ${n > 1 ? "them" : "it"}, install ${n > 1 ? "them" : "it"} on your memory stick.</p>
      ${need.length ? `<p class="small warnline">Fill in the details of ${need.map(x => `<a href="#/song/${esc(x.folder)}">${esc(x.title || x.folder)}</a>`).join(", ")}: they weren't in the pack.</p>` : ""}
      <div class="actions"><a class="btn primary big" href="#/stick">Go to Memory stick</a><button id="mgMore">Add more shared songs</button></div></section>`;
  } else if (MG.stage === "failed") body = `<section class="panel notice bad"><h2>The songs were added, but not made ready for the game</h2><p>${esc(MG.err || "Something went wrong.")}</p>
      <p class="small dim">The Build log (top right) shows every step. Open each song and use Make the song.</p><div class="actions"><a class="btn primary" href="#/">Back to my songs</a></div></section>`;
  $("#main").innerHTML = `<div class="sharepage merge">${body}</div>`;
  bindMerge();
}
function bindMerge() {
  const on = (id, f) => { const e = $("#" + id); if (e) e.onclick = f; };
  on("mgChoose", () => pickInto("#mgPath", null, true, /\.zip$/i));
  const mp = $("#mgPath"); if (mp) mp.onchange = () => { if (mp.value) mergeLook(mp.value); };
  const d = $("#mgDrop");
  if (d) {
    d.ondragover = e => { e.preventDefault(); d.classList.add("over"); };
    d.ondragleave = () => d.classList.remove("over");
    d.ondrop = async e => {
      e.preventDefault(); d.classList.remove("over");
      const items = [...(e.dataTransfer.items || [])], folder = items.some(i => i.webkitGetAsEntry && i.webkitGetAsEntry() && i.webkitGetAsEntry().isDirectory);
      const f = [...e.dataTransfer.files].find(x => /\.zip$/i.test(x.name));
      if (folder || !f) return toast(folder ? "A dropped folder can't be opened here: use Choose… and pick the folder." : "Drop a .zip file, or use Choose… to pick a folder.", true);
      d.innerHTML = `<b>Reading ${esc(f.name)}…</b>`;
      try { mergeLook(await uploadFile(f, "mg" + Date.now().toString(36))); } catch (err) { fail("Couldn't read the zip file")(err); renderMerge(); }
    };
  }
  on("mgBack", () => { MG = { stage: "pick" }; renderMerge(); });
  document.querySelectorAll("[data-mg]").forEach(c => c.onchange = () => { c.checked ? MG.sel.add(c.dataset.mg) : MG.sel.delete(c.dataset.mg); const y = window.scrollY; renderMerge(); window.scrollTo({ top: y }); const b = $(`[data-mg="${c.dataset.mg}"]`); if (b) b.focus(); });
  on("mgMore", () => { MG = { stage: "pick" }; renderMerge(); });
  on("mgAdd", async () => {
    const folders = [...MG.sel];
    let r;
    try { r = await api("POST", "/api/import", { dir: MG.dir, folders }); } catch (e) { return fail("Couldn't add the songs")(e); }
    MG = { stage: "adding", added: r.imported };
    renderMerge();
    // make them ready for the game (an imported song's build only copies its files: quick)
    try { await api("POST", "/api/buildmany", { folders: r.imported.map(x => x.folder) }); } catch (e) { MG = { stage: "failed", added: r.imported, err: e.message }; return renderMerge(); }
    $("#buildToggle").classList.remove("hidden");
    let n = 0, err = [];
    window.onBuildLine = l => { if (/^\n?=== /.test(l)) n++; if (/ERROR/.test(l)) err.push(l.replace(/^\s*ERROR:\s*/, "")); const m = $("#mgMeter"); if (m) m.style.width = Math.round(100 * Math.min(n, folders.length) / (folders.length + 1)) + "%"; const t = $("#mgLine"); if (t && l.trim()) t.textContent = l.trim(); };
    window.onBuildEnd = code => {
      window.onBuildLine = window.onBuildEnd = null;
      MG = code === "0" ? { stage: "done", added: r.imported } : { stage: "failed", added: r.imported, err: err.join(" ") };
      if (location.hash !== "#/merge") return false;
      renderMerge(); return true;
    };
    followBuild();
  });
}

// ---------- memory sticks: what is installed, install, import ----------
// /api/sticks: PPSSPP's memory stick (the MUSIC folder on Setup) and a PSP connected by USB; an unplugged PSP shows
// its last check. Song states: installed · older / different (another build) · missing · extra (not built here).
let STK = null;
const whenTxt = iso => { const d = new Date(iso), days = Math.floor((Date.now() - d) / 86400000); return days < 1 ? `today ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : days < 2 ? "yesterday" : `${days} days ago (${d.toLocaleDateString()})`; };
async function loadSticks() { STK = await api("GET", "/api/sticks"); return STK; }
// ---------- the Memory stick page ----------
// Every custom song has an "Add in game" switch: the list shows what the memory stick will have. Nothing changes until
// Review and apply (POST /api/stick/apply: copies songs, writes a song database that lists exactly the songs switched
// on, removes the ones switched off; they stay in your songs). Archive and Remove from memory stick live here only.
const SP = { stick: null, plan: {}, filter: "all", q: "", view: "list", target: null, v: null };
const SCHIP = { ok: ["ok", "Installed", "Up to date"], upd: ["todo", "Update ready", "You changed it since it was installed"],
  new: ["new", "Not installed", "Not on the memory stick yet"], hidden: ["todo", "Not shown in the game", "On the memory stick, but the song list doesn't show it"],
  notmade: ["new", "Not made yet", "Make the song first, then add it in game"] };
const rowState = x => !x.built ? "notmade" : x.state === "missing" ? "new" : x.state === "installed" ? (x.listed ? "ok" : "hidden") : "upd";
const stickWhere = s => s && s.kind === "psp" ? "your PSP's memory stick" : "PPSSPP's memory stick";
const sameSet = (a, b) => a.length === b.length && [...a].sort().join() === [...b].sort().join();
const sizeTxt = mb => mb >= 1024 ? (mb / 1024).toFixed(1) + " GB" : (Math.round(mb * 10) / 10) + " MB";
const songName = x => x.title || x.folder;
const ourStickDb = s => !!s.db && (s.db.state === "current" || s.db.state === "yours-older");
// your songs on this stick, with the switch: default on, except songs not made yet and songs you switched off before
function stickRowsOf(s) {
  return s.songs.filter(x => x.inLibrary).map(x => {
    const st = rowState(x), def = st === "notmade" ? false : st === "new" ? !x.off : true;
    return { ...x, st, def, want: st === "notmade" ? false : SP.plan[x.folder] ?? def };
  }).sort((a, b) => String(songName(a)).localeCompare(String(songName(b))));
}
// what applying would do (the server works it out the same way: stickPlan in server.js)
function stickPending(s, rows) {
  const copy = rows.filter(r => r.want && (r.st === "new" || r.st === "upd")), show = rows.filter(r => r.want && r.st === "hidden"),
    rm = rows.filter(r => !r.want && ["ok", "upd", "hidden"].includes(r.st)), keep = rows.filter(r => r.want && r.st === "ok");
  const on = rows.filter(r => r.want).map(r => r.folder);
  const db = on.length ? (ourStickDb(s) && sameSet(s.db.customs, on) && !copy.length ? "keep" : "write") : ourStickDb(s) ? "none" : "keep";
  return { copy, show, rm, keep, on, db, any: !!(copy.length || rm.length || db !== "keep") };
}
function stickSummaryLine(s, rows) {
  const made = rows.filter(r => r.built), ok = rows.filter(r => r.st === "ok").length, upd = rows.filter(r => r.st === "upd" || r.st === "hidden").length;
  if (s.db && s.db.state === "other") return `The song list on this memory stick comes from someone else's ${s.db.pack ? `pack (${esc(s.db.pack)})` : "build"}, so the game shows their songs and none of yours. Applying puts your song list back.`;
  if (!ok && !upd) return made.length ? `None of your ${made.length} custom songs are on this memory stick yet.` : `You haven't made a custom song yet.`;
  return `${ok} of ${made.length} custom songs are installed ${s.kind === "psp" ? "on your PSP" : "in PPSSPP"}${upd ? ` – ${upd} ${upd > 1 ? "need" : "needs"} an update` : ""}.`;
}
async function showSticks(packReq) {
  Object.assign(SP, { plan: {}, filter: "all", q: "", view: "list", target: null, pack: null });
  $("#main").innerHTML = `<div class="panel dim">Looking at your memory stick…</div>`;
  SP.v = await loadSticks();
  if (!SP.stick || !SP.v.sticks.some(s => s.id === SP.stick)) SP.stick = (SP.v.sticks.find(s => s.online && s.kind === "ppsspp") || SP.v.sticks.find(s => s.online) || SP.v.sticks[0] || { id: "ppsspp" }).id;
  GUARD = { what: "your switch changes", dirty: () => !!$(".stickpage") && Object.keys(SP.plan).length > 0 && ["list", "review"].includes(SP.view),
    leave: { title: "Leave without applying your changes?", body: "Your switch changes aren't on the memory stick yet.", discard: "Discard changes" } };
  if (packReq) await stickPackPlan(packReq);
  renderSticks();
}
// Install a pack (Share page): its songs switched on, every other song off (one pack at a time); Uninstall: its songs off
async function stickPackPlan(req) {
  let pk; try { pk = await api("GET", "/api/packs"); } catch (e) { return fail("Couldn't read your packs")(e); }
  const p = pk.packs.find(x => x.id === req.id), s = SP.v.sticks.find(x => x.id === SP.stick);
  if (!p) return toast("That pack isn't there any more.", true);
  if (!s || !s.online) return;
  const active = activePackOf(pk.packs, s), rows = stickRowsOf(s);
  SP.pack = { id: p.id, name: p.display, songs: p.songs, mode: req.mode, active: active && active.id !== p.id ? active.display : null,
    notmade: rows.filter(r => r.st === "notmade" && p.songs.includes(r.folder)).length };
  for (const r of rows) {
    if (r.st === "notmade") continue;
    const w = req.mode === "install" ? p.songs.includes(r.folder) : p.songs.includes(r.folder) ? false : r.def;
    if (w !== r.def) SP.plan[r.folder] = w;
  }
}
const leavePackMode = () => { SP.pack = null; if (location.hash !== "#/stick") { history.replaceState(null, "", "#/stick"); lastHash = location.hash; } };
function stickPackBanner() {
  const k = SP.pack; if (!k) return "";
  const cancel = `Change any switch before you apply, or <button class="linkbtn small" id="spPackCancel">cancel</button>.`;
  if (k.mode === "uninstall") return `<div class="notice"><b>Uninstalling the pack ${esc(k.name)}</b><p class="small">Its ${k.songs.length} songs are switched off, so they leave the game. Nothing is deleted: the songs and the pack stay in your library, ready to install again. ${cancel}</p></div>`;
  return `<div class="notice"><b>Installing the pack ${esc(k.name)}</b><p class="small">Only one pack is installed at a time. ${k.active ? `This uninstalls <b>${esc(k.active)}</b>: its songs that aren't in ${esc(k.name)} leave the game, but nothing is deleted. ` : ""}The pack's ${k.songs.length} songs are switched on and every other song is switched off, so the memory stick will have exactly this pack. The other songs stay in your library.${k.notmade ? ` ${k.notmade} of its songs ${k.notmade > 1 ? "aren't" : "isn't"} made yet, so ${k.notmade > 1 ? "they stay" : "it stays"} off: update the pack first.` : ""} ${cancel}</p></div>`;
}
// re-render, keeping the keyboard focus on the same control (a switch, a filter, the search box)
function renderSticks() {
  const a = document.activeElement, keyOf = el => !el || el === document.body ? null
    : el.id ? "#" + el.id : ["want", "filter", "allwant", "dev", "archive", "restore", "rmone"].map(k => el.dataset[k] != null ? `[data-${k}="${el.dataset[k]}"]` : null).find(Boolean);
  const key = keyOf(a), caret = a && a.id === "stq" ? a.selectionStart : null;
  const v = SP.v, s = v.sticks.find(x => x.id === SP.stick);
  const views = { list: stickListHtml, review: stickReviewHtml, applying: stickApplyingHtml, done: stickDoneHtml, failed: stickFailedHtml, archive: stickArchiveHtml, remove: stickRemoveHtml };
  const body = !s ? stickMissingHtml(SP.stick) : !s.online ? stickOfflineHtml(s) : views[SP.view](s);
  $("#main").innerHTML = `<div class="stickpage"><div class="bar"><h1>Memory stick</h1>${stickTabs(v)}</div>${body}</div>`;
  bindSticks(s);
  const back = key && $(key);
  if (back) { back.focus(); if (caret != null) back.setSelectionRange(caret, caret); }
}
function stickTabs(v) {
  const list = v.sticks.map(s => [s.id, s.kind === "ppsspp" ? "PPSSPP on this computer" : s.online ? `PSP by USB (${s.drive || s.label.replace(/.*\((.*)\).*/, "$1")})` : "PSP (not connected)"]);
  if (!v.sticks.some(s => s.kind === "ppsspp")) list.unshift(["ppsspp", "PPSSPP on this computer"]);
  if (!v.sticks.some(s => s.kind === "psp")) list.push(["psp", "PSP by USB"]);
  const busy = SP.view === "applying";
  return `<div class="seg devtabs" role="tablist" aria-label="Memory stick">${list.map(([id, n]) => `<button role="tab" data-dev="${esc(id)}" class="${SP.stick === id ? "on" : ""}" aria-selected="${SP.stick === id}" ${busy ? "disabled" : ""}>${esc(n)}</button>`).join("")}</div>`;
}
function stickMissingHtml(id) {
  if (id === "ppsspp") return `<div class="panel"><h2>PPSSPP's memory stick isn't set yet</h2>
    <p>Pocket Encore needs to know where PPSSPP keeps its memory stick. <a href="#/setup">Open Settings</a> to set it.</p></div>`;
  return `<div class="panel"><h2>No PSP connected</h2><ol class="steps"><li>Connect your PSP to this computer with a USB cable.</li>
    <li>On the PSP, open <b>Settings → USB Connection</b>.</li><li>Then <button class="linkbtn" id="spRescan">check again</button>: Pocket Encore shows its songs here.</li></ol></div>`;
}
function stickOfflineHtml(s) {
  const mine = s.songs.filter(x => x.inLibrary && x.state !== "missing").length;
  return `<div class="panel"><h2>Your PSP isn't connected</h2><ol class="steps"><li>Connect your PSP to this computer with a USB cable.</li>
    <li>On the PSP, open <b>Settings → USB Connection</b>.</li><li>Then <button class="linkbtn" id="spRescan">check again</button>.</li></ol>
    <p class="small dim">Last time (${esc(whenTxt(s.at))}): ${mine} of your custom song${mine === 1 ? " was" : "s were"} on it.</p></div>`;
}
function stickListHtml(s) {
  const rows = stickRowsOf(s), P = stickPending(s, rows);
  const FILTERS = [["all", "All", () => true], ["ok", "Installed", r => r.st === "ok"], ["upd", "Update ready", r => r.st === "upd"], ["new", "Not installed", r => r.st === "new"],
    ["hidden", "Not shown in the game", r => r.st === "hidden"], ["notmade", "Not made yet", r => r.st === "notmade"]].filter(([k, , f]) => k === "all" || rows.some(f));
  const fdef = FILTERS.find(f => f[0] === SP.filter) || FILTERS[0], q = SP.q.toLowerCase();
  const shown = rows.filter(fdef[2]).filter(r => !q || `${r.title} ${r.artist} ${r.folder}`.toLowerCase().includes(q));
  const can = shown.filter(r => r.st !== "notmade"), onN = can.filter(r => r.want).length, all = fdef[0] === "all" && !q;
  const nNew = P.copy.filter(r => r.st === "new").length, nUpd = P.copy.length - nNew;
  const parts = [nNew && `${nNew} to install`, nUpd && `${nUpd} to update`, P.show.length && `${P.show.length} to show in the game again`, P.rm.length && `${P.rm.length} to remove`].filter(Boolean);
  const effect = r => r.st === "notmade" ? "" : r.st === "new" ? (r.want ? "Will be installed" : "Stays off the memory stick")
    : !r.want ? "Will be removed from the memory stick (it stays in your songs)" : r.st === "upd" ? "Will be updated" : r.st === "hidden" ? "Will be shown in the game again" : "";
  const others = s.songs.filter(x => !x.inLibrary && !x.archived && x.state !== "missing");
  const other = s.db && s.db.state === "other";
  const row = r => { const [k, label, sub] = SCHIP[r.st], e = effect(r);
    return `<div class="srow${r.want !== r.def ? " changed" : ""}" data-f="${esc(r.folder)}">
      <div class="rt"><a href="#/song/${esc(r.folder)}" class="sname">${esc(songName(r))}</a><span class="small dim">${esc(r.artist || "")}${r.mb ? ` · ${r.mb} MB` : ""}</span></div>
      <div class="rs"><span class="state"><span class="sdot ${k}" aria-hidden="true"></span>${label}</span><span class="small dim">${sub}</span>${e ? `<span class="small effect">${e}</span>` : ""}</div>
      <div class="ctl">${r.st === "notmade" ? `<a class="btn small" href="#/song/${esc(r.folder)}">Make the song</a>`
        : `<label class="sw"><input type="checkbox" data-want="${esc(r.folder)}" aria-label="Add in game: ${esc(songName(r))}" ${r.want ? "checked" : ""}><span aria-hidden="true">Add in game</span></label>`}
        <button class="small" data-archive="${esc(r.folder)}" aria-label="Archive: ${esc(songName(r))}">Archive</button></div></div>`; };
  const archived = SP.v.archived || [], onStick = f => s.songs.find(x => x.folder === f && x.state !== "missing");
  const archOn = archived.filter(a => onStick(a.folder));
  return `${stickPackBanner()}${other ? `<div class="notice warn"><b>${stickSummaryLine(s, rows)}</b></div>` : ""}
    <div class="panel lead"><p><b>${other ? "Your songs are switched on below." : stickSummaryLine(s, rows)}</b></p>
      <p class="small dim">The switches below show what the memory stick will have. Nothing changes until you press <b>Review and apply</b>.</p></div>
    <section class="panel"><div class="bar"><h2>Your custom songs <span class="small dim">· ${rows.length}</span></h2>
        <input type="search" id="stq" placeholder="Find a song…" aria-label="Find a song" value="${esc(SP.q)}"></div>
      <div class="listtools">
        <div class="chips" role="group" aria-label="Show">${FILTERS.map(([k, n, f]) => `<button class="fchip ${fdef[0] === k ? "on" : ""}" data-filter="${k}" aria-pressed="${fdef[0] === k}">${n} <span>${rows.filter(f).length}</span></button>`).join("")}</div>
        <div class="actions"><span class="small dim" aria-live="polite">${onN} of ${can.length} ${all ? "" : "shown "}added in game</span>
          <button class="small" data-allwant="1" ${onN === can.length ? "disabled" : ""}>${all ? "Add all in game" : `Add these ${can.length} in game`}</button>
          <button class="small" data-allwant="0" ${onN === 0 ? "disabled" : ""}>${all ? "Remove all from game" : `Remove these ${can.length} from game`}</button>
          ${Object.keys(SP.plan).length ? `<button class="linkbtn small" id="spUndo">Undo my changes</button>` : ""}</div></div>
      ${shown.length ? `<div class="srows">${shown.map(row).join("")}</div>` : `<p class="small dim">${rows.length ? "No songs match." : `No songs yet: <a href="#/new">make your first song</a>.`}</p>`}
    </section>
    ${others.length ? `<details class="panel others" ${other ? "open" : ""}><summary><b>${others.length} other song${others.length > 1 ? "s" : ""} on the memory stick</b> <span class="small dim">· not in your library</span></summary>
      <p class="small">${other ? "These came with the other pack. The game lists them now; after you apply, it won't, unless you add them to your library first."
        : "Song folders that aren't in your library (a friend's pack, or songs from an older library). The game doesn't list them; they only take up space."}</p>
      <div class="srows">${others.map(x => `<div class="srow"><div class="rt"><b>${esc(songName(x))}</b><span class="small dim">${esc(x.artist || "")}${x.artist ? " · " : ""}<span class="mono">${esc(x.folder)}</span> · ${x.stickMb} MB</span></div>
        <div class="rs"><span class="state"><span class="sdot" aria-hidden="true"></span>Not in your library</span>${x.listed ? `<span class="small dim">The game lists it now</span>` : ""}</div>
        <div class="ctl"><button class="small" data-import="${esc(s.music + "\\" + x.folder)}" aria-label="Add to my library: ${esc(songName(x))}">Add to my library</button>
          <button class="small" data-rmone="${esc(x.folder)}" aria-label="Remove from memory stick: ${esc(songName(x))}">Remove from memory stick</button></div></div>`).join("")}</div>
      ${others.length > 1 ? `<div class="actions"><button data-rmone="**">Remove all ${others.length} from the memory stick</button></div>` : ""}</details>` : ""}
    ${archived.length ? `<details class="panel"><summary><b>Archived songs</b> <span class="small dim">· ${archived.length} · kept on your computer, not in your song list${archOn.length ? ` · ${archOn.length} still on the memory stick` : ""}</span></summary>
      <p class="small">Archived songs aren't in the game's song list. ${archOn.length ? "Some still have their folder on the memory stick: they only take up space. " : ""}Restore one to bring it back to your custom songs.</p>
      <div class="srows">${archived.map(a => { const x = onStick(a.folder); return `<div class="srow"><div class="rt"><b>${esc(songName(a))}</b><span class="small dim">${esc(a.artist || "")}</span></div>
        <div class="rs"><span class="state"><span class="sdot" aria-hidden="true"></span>Archived</span><span class="small dim">${x ? `Its folder is still on the memory stick${x.listed ? " (the game lists it until you apply your next changes)" : " (the game doesn't list it)"}` : "Not on the memory stick"}</span></div>
        <div class="ctl"><button class="small" data-restore="${esc(a.folder)}" aria-label="Restore: ${esc(songName(a))}">Restore</button>${x ? `<button class="small" data-rmone="${esc(a.folder)}" aria-label="Remove from memory stick: ${esc(songName(a))}">Remove from memory stick</button>` : ""}</div></div>`; }).join("")}</div>
      ${archOn.length > 1 ? `<div class="actions"><button data-rmone="*">Remove all ${archOn.length} from the memory stick</button></div>` : ""}</details>` : ""}
    <p class="small dim">Got songs from someone? Add them on the <a href="#/packs">Share &amp; Packs</a> page.</p>
    <details class="panel"><summary>Details for experts</summary><p class="small dim"><span class="mono">${esc(s.music)}</span>${s.freeMb != null ? ` · ${sizeTxt(s.freeMb)} free` : ""}
      · song list ${s.db ? `<span class="mono">${esc(s.db.folder)}\\${esc(s.db.file)}</span> (${s.db.state === "official" ? "the game's own" : s.db.state === "other" ? `someone else's${s.db.pack ? `: ${esc(s.db.pack)}` : ""}` : "yours"}, ${s.db.customs.length} custom songs)` : "none (the game lists its own songs only)"}
      · each song is a folder named after it (${rows.slice(0, 2).map(r => esc(r.folder)).join(", ")}${rows.length > 2 ? "…" : ""}).</p></details>
    <div class="applybar"><span>${P.any ? `<b>${parts.join(", ") || "Your song list will be updated"}</b>` : `<span class="dim">The memory stick matches your library. Nothing to apply.</span>`}</span>
      <button class="primary big" id="spReview" ${P.any ? "" : "disabled"}>Review and apply</button></div>`;
}
const whatLi = (mark, html) => `<li><span class="mark ${mark}" aria-hidden="true">${mark === "ok" ? "✓" : mark === "rm" ? "−" : "·"}</span><span>${html}</span></li>`;
function stickReviewHtml(s) {
  const rows = stickRowsOf(s), P = stickPending(s, rows), names = l => esc(l.map(songName).join(", "));
  const fresh = P.copy.filter(r => r.st === "new"), upd = P.copy.filter(r => r.st === "upd");
  const mb = P.copy.reduce((a, r) => a + r.mb, 0), freed = P.rm.reduce((a, r) => a + (r.stickMb || 0), 0) + upd.reduce((a, r) => a + (r.stickMb || 0), 0);
  const others = s.songs.filter(x => !x.inLibrary && x.state !== "missing"), other = s.db && s.db.state === "other";
  const short = s.freeMb != null && mb - freed > s.freeMb;
  return `<section class="panel review"><h2>Apply these changes to ${stickWhere(s)}?</h2>
    <ul class="what">
      ${fresh.length ? whatLi("ok", `<b>Installs</b> ${names(fresh)}.`) : ""}
      ${upd.length ? whatLi("ok", `<b>Updates</b> ${names(upd)} with your latest changes.`) : ""}
      ${P.show.length ? whatLi("ok", `<b>Shows again</b> ${names(P.show)} in the game.`) : ""}
      ${P.rm.length ? whatLi("rm", `<b>Removes</b> ${names(P.rm)} from the memory stick. ${P.rm.length > 1 ? "They stay" : "It stays"} in your library, so you can install ${P.rm.length > 1 ? "them" : "it"} again any time.`) : ""}
      ${SP.pack && SP.pack.mode === "install" && SP.pack.active ? whatLi("rm", `<b>Uninstalls the pack ${esc(SP.pack.active)}</b> and installs <b>${esc(SP.pack.name)}</b> (one pack at a time). Nothing is deleted.`) : ""}
      ${SP.pack && SP.pack.mode === "uninstall" ? whatLi("rm", `<b>Uninstalls the pack ${esc(SP.pack.name)}</b>. Its songs stay in your library.`) : ""}
      ${P.db === "write" ? whatLi("ok", `<b>Updates your song list</b> so the game lists exactly the ${P.on.length} song${P.on.length > 1 ? "s" : ""} switched on${other ? `, replacing the other ${s.db.pack ? `pack's (${esc(s.db.pack)})` : "build's"} song list` : ""}.`) : ""}
      ${P.db === "none" ? whatLi("rm", `<b>Removes your song list:</b> no custom song is switched on, so the game lists only its own songs.`) : ""}
      ${P.keep.length ? whatLi("", `<b>Not touched:</b> ${names(P.keep)}.`) : ""}
      ${others.length ? whatLi("", other && P.db === "write" ? `<b>The other pack's songs</b> (${names(others)}) stay on the memory stick, but the game stops listing them.`
        : `<b>${others.length === 1 ? "1 other song folder" : `The ${others.length} other song folders`}</b> on the memory stick ${others.length === 1 ? "is" : "are"} not touched.`) : ""}
    </ul>
    <p class="small ${short ? "warnline" : "dim"}">Copies ${sizeTxt(mb)}${s.freeMb != null ? ` · ${sizeTxt(s.freeMb)} free on the memory stick` : ""}.${short ? " Not enough space: switch some songs off, or free some space on the memory stick first." : ""}
      ${s.kind === "ppsspp" ? "If the game is running in PPSSPP, restart it afterwards." : "Keep the PSP connected until it's done."}</p>
    <div class="actions"><button id="spBack">Back</button><span class="grow"></span><button class="primary big" id="spApply" ${short ? "disabled" : ""}>Apply changes</button></div></section>`;
}
function stickApplyingHtml(s) {
  return `<section class="panel"><h2>${esc(SP.busyTitle || `Updating ${stickWhere(s)}…`)}</h2>
    <div class="meter" aria-hidden="true"><i id="spMeter" style="width:${SP.total ? Math.round(100 * Math.min(SP.done, SP.total) / SP.total) : 5}%"></i></div>
    <p class="small dim" id="spLine" aria-live="polite">${esc(SP.last || "Starting…")}</p>
    <p class="small dim">${s.kind === "psp" ? "Keep the PSP connected until it's done." : "This takes a few seconds per song."}</p></section>`;
}
function stickDoneHtml(s) {
  return `<section class="panel donebox"><h2>${esc(SP.doneTitle || "Memory stick updated")}</h2>
    <p>${s.kind === "psp" ? "On your PSP, end the USB connection, then start Rock Band Unplugged: your custom songs are in the song list."
      : "Start Rock Band Unplugged in PPSSPP, or restart it if it's running: your custom songs are in the song list."}</p>
    <div class="actions"><button class="primary" id="spBack">Back to the memory stick</button><a class="btn" href="#/">Back to my songs</a></div></section>`;
}
function stickFailedHtml(s) {
  return `<section class="panel notice bad"><h2>The memory stick wasn't fully updated</h2>
    <p>${esc(SP.err && SP.err.length ? SP.err.join(" ") : "Something went wrong.")}</p>
    <p class="small dim">Songs already copied are complete: a copy that stops halfway never leaves half a song. The Build log (top right) shows every step.</p>
    <div class="actions"><button class="primary" id="spBack">Back to the memory stick</button><button id="spLog">Show the log</button></div></section>`;
}
function stickArchiveHtml(s) {
  const x = s.songs.find(y => y.folder === SP.target);
  if (!x) { SP.view = "list"; return stickListHtml(s); }
  const on = x.state !== "missing";
  return `<section class="panel review"><h2>Archive ${esc(songName(x))}?</h2>
    <ul class="what">${whatLi("", `<b>It leaves your songs</b> and the game's song list.`)}
      ${whatLi("ok", `<b>Nothing is deleted:</b> its audio, chart and settings are kept on your computer. Restore it any time from <i>Archived songs</i> on this page.`)}</ul>
    ${on ? `<label class="sw wrap"><input type="checkbox" id="archRm" checked><span>Also remove it from ${stickWhere(s)} now (frees ${x.stickMb || x.mb} MB)</span></label>
      <p class="small dim">Leave it unticked to keep its folder on the memory stick; the game stops listing it when you next apply changes on this page.</p>` : ""}
    <div class="actions"><button id="spBack">Cancel</button><span class="grow"></span><button class="primary big" id="archGo">Archive</button></div></section>`;
}
function stickRemoveTargets(s) {
  const onStick = f => s.songs.find(x => x.folder === f && x.state !== "missing" && !x.inLibrary);
  if (SP.target === "*") return (SP.v.archived || []).map(a => onStick(a.folder)).filter(Boolean);
  if (SP.target === "**") return s.songs.filter(x => !x.inLibrary && !x.archived && x.state !== "missing");
  const x = onStick(SP.target); return x ? [x] : [];
}
function stickRemoveHtml(s) {
  const list = stickRemoveTargets(s), n = list.length, one = n === 1;
  if (!n) { SP.view = "list"; return stickListHtml(s); }
  const archived = list.every(x => x.archived), listed = list.some(x => x.listed) && ourStickDb(s);
  return `<section class="panel review"><h2>Remove ${one ? esc(songName(list[0])) : n + " song folders"} from the memory stick?</h2>
    <p>${archived ? (one ? "This is an archived song: it stays in your archive on your computer." : `These are archived songs: ${esc(list.map(songName).join(", "))}. They stay in your archive on your computer.`)
      : one ? "It isn't in your library: Pocket Encore has no copy of it, so once it's removed, it's gone from the memory stick."
      : `They aren't in your library (${esc(list.map(songName).join(", "))}): Pocket Encore has no copy of them, so once they're removed, they're gone from the memory stick.`}</p>
    <ul class="what">${whatLi("rm", `${one ? "Its folder is" : "Their folders are"} deleted from the memory stick (${sizeTxt(list.reduce((a, x) => a + x.stickMb, 0))}).`)}
      ${whatLi("", listed ? "Your song list is updated so it stops listing " + (one ? "it" : "them") + ". Your custom songs are not touched." : "Your custom songs and your song list are not touched.")}
      ${whatLi("", archived ? `To play ${one ? "it" : "them"} again later, restore ${one ? "it" : "them"} and install from this page.` : `To play ${one ? "it" : "them"} again, add ${one ? "it" : "them"} from the pack or folder ${one ? "it" : "they"} came from.`)}</ul>
    <div class="actions"><button id="spBack">Back</button><span class="grow"></span><button class="danger big" id="rmGo">Remove ${one ? "this folder" : n + " folders"}</button></div></section>`;
}
// a memory stick job (apply, remove, archive): progress on the page, then Done or what went wrong
function followStick(total, busyTitle, doneTitle) {
  Object.assign(SP, { view: "applying", done: 0, total, last: "", err: [], busyTitle, doneTitle });
  renderSticks();
  $("#buildToggle").classList.remove("hidden");
  window.onBuildLine = l => {
    if (/^\s{2}\S/.test(l)) SP.done++;
    if (/ERROR/.test(l)) SP.err.push(l.replace(/^\s*ERROR:\s*/, ""));
    if (l.trim() && !l.startsWith("#")) SP.last = l.trim();
    const m = $("#spMeter"); if (m && SP.total) m.style.width = Math.round(100 * Math.min(SP.done, SP.total) / SP.total) + "%";
    const t = $("#spLine"); if (t) t.textContent = SP.last;
  };
  window.onBuildEnd = async code => {
    window.onBuildLine = window.onBuildEnd = null;
    if (!/^#\/stick/.test(location.hash) || SP.view !== "applying") return false;
    SP.plan = {}; SP.view = code === "0" ? "done" : "failed";
    try { SP.v = await loadSticks(); } catch { }
    renderSticks();
    return true;
  };
  followBuild();
}
function bindSticks(s) {
  const on = (sel, fn) => document.querySelectorAll(sel).forEach(b => b.onclick = fn);
  const go = view => { SP.view = view; renderSticks(); window.scrollTo(0, 0); };
  on("[data-dev]", async e => {
    const id = e.currentTarget.dataset.dev; if (id === SP.stick) return;
    if (Object.keys(SP.plan).length && await ask("Discard your changes?", "Your switch changes for this memory stick aren't applied yet.", [
      { label: "Discard changes", value: "y", kind: "danger" }, { label: "Keep them", value: null }]) !== "y") return;
    Object.assign(SP, { stick: id, plan: {}, view: "list" }); leavePackMode(); renderSticks();
  });
  on("#spRescan", () => showSticks());
  if (!s || !s.online) return;
  const rows = SP.view === "list" ? stickRowsOf(s) : [];
  const setWant = (f, w) => { const r = rows.find(x => x.folder === f); if (!r || r.st === "notmade") return; if (w === r.def) delete SP.plan[f]; else SP.plan[f] = w; };
  document.querySelectorAll("[data-want]").forEach(b => b.onchange = () => { setWant(b.dataset.want, b.checked); renderSticks(); });
  on("[data-filter]", e => { SP.filter = e.currentTarget.dataset.filter; renderSticks(); });
  if ($("#stq")) $("#stq").oninput = e => { SP.q = e.target.value; renderSticks(); };
  on("[data-allwant]", e => {
    const w = e.currentTarget.dataset.allwant === "1";
    document.querySelectorAll("[data-want]").forEach(b => setWant(b.dataset.want, w));  // the songs shown (filter and search)
    renderSticks();
  });
  on("#spUndo", () => { SP.plan = {}; leavePackMode(); renderSticks(); });
  on("#spPackCancel", () => { SP.plan = {}; leavePackMode(); renderSticks(); });
  on("[data-archive]", e => { SP.target = e.currentTarget.dataset.archive; go("archive"); });
  on("[data-rmone]", e => { SP.target = e.currentTarget.dataset.rmone; go("remove"); });
  on("[data-import]", e => importFrom(e.currentTarget.dataset.import));
  on("[data-restore]", async e => {
    const f = e.currentTarget.dataset.restore, a = (SP.v.archived || []).find(x => x.folder === f);
    try { await api("POST", "/api/restore", { folder: f }); } catch (err) { return fail("Couldn't restore the song")(err); }
    toast(`${a ? songName(a) : f} is back in your songs.`);
    SP.v = await loadSticks(); renderSticks();
  });
  on("#spReview", () => go("review"));
  on("#spBack", async () => { if (SP.view === "done" || SP.view === "failed") { SP.v = await loadSticks(); leavePackMode(); } go("list"); });
  on("#spLog", () => { showBuildPanel(true); followBuild(); });
  on("#spApply", async () => {
    const r = stickRowsOf(s), P = stickPending(s, r);
    try { await api("POST", "/api/stick/apply", { stick: s.id, want: P.on }); } catch (err) { return fail("Couldn't update the memory stick")(err); }
    const k = SP.pack, done = !k ? "Memory stick updated" : k.mode === "install" ? `${k.name} is installed on ${stickWhere(s)}` : `${k.name} is uninstalled`;
    followStick(P.copy.length + P.rm.length + (P.db !== "keep" ? 1 : 0), `Updating ${stickWhere(s)}…`, done);
  });
  on("#archGo", async () => {
    const x = s.songs.find(y => y.folder === SP.target), rm = !!($("#archRm") && $("#archRm").checked);
    let r; try { r = await api("POST", "/api/archive", { folder: SP.target, removeFrom: rm ? [s.id] : [] }); } catch (err) { return fail("Couldn't archive the song")(err); }
    delete SP.plan[SP.target];
    if (r.started) return followStick(2, `Archiving ${songName(x)}…`, `${songName(x)} is archived and off the memory stick`);
    toast(`${songName(x)} is archived.`);
    SP.v = await loadSticks(); go("list");
  });
  on("#rmGo", async () => {
    const list = stickRemoveTargets(s);
    try { await api("POST", "/api/stick/remove", { stick: s.id, folders: list.map(x => x.folder) }); } catch (err) { return fail("Couldn't remove it from the memory stick")(err); }
    followStick(list.length + 1, "Removing from the memory stick…", list.length === 1 ? `${songName(list[0])} is off the memory stick` : `${list.length} song folders removed`);
  });
}

// ---------- help ----------
const HELP = [
  ["start", "Getting started", `
    <p>Pocket Encore makes custom songs for <b>Rock Band Unplugged</b> (PSP, US version ULUS10418) that the game loads by
    itself on PPSSPP or a PSP: no plugin, no cheats. You need your own copy of the game (its disc image), with or without its DLC.</p>
    <ol>
      <li><b>Settings</b> shows your game and the tools Pocket Encore uses. The first start walks you through them; everything
        must be found before songs can be made.</li>
      <li><b>Make a new song</b> (on the Songs page): drop the song's audio tracks, and a MIDI if you have one (without one the
        chart is made from the audio). Fill in the details, then <b>Make the song</b>.</li>
      <li><b>Memory stick</b>: every song has an <b>Add in game</b> switch. <b>Review and apply</b> shows what will change, then
        copies the songs and your song list to PPSSPP's memory stick or to a PSP connected by USB.</li>
      <li><b>Share &amp; Packs</b>: put a set of your songs in a pack for your own game or a friend's, and add songs someone
        shared with you (<b>Merge Songs</b>).</li>
    </ol>
    <p>Each song's page says where the song stands ("Not made yet", "Your changes are saved but not in the game yet", "In the
    game · up to date"…) with a button for the next step.</p>`],
  ["stick", "Memory stick", `
    <p>The game lists the songs of <b>one</b> song database: the <span class="mono">JB</span> file with the highest number in
    any folder of <span class="mono">MUSIC</span>, with the names from the <span class="mono">TEXT</span> folder next to it. Song
    folders it doesn't list are hidden, even though they are on the memory stick. Pocket Encore's song database is the
    <span class="mono">ZZCUSTOMDB</span> folder.</p>
    <h3>Add in game</h3>
    <p>The <b>Memory stick</b> page has a tab for PPSSPP's memory stick (the MUSIC folder in Settings) and one for a PSP
    connected by USB (on the PSP: Settings → USB Connection). Each of your songs has an <b>Add in game</b> switch: the list
    shows what the memory stick will have. Nothing changes until you press <b>Review and apply</b>, which lists every change by
    name. <b>Apply changes</b> then copies new and updated songs, writes a song database that lists exactly the songs switched
    on, and removes the songs switched off.</p>
    <p>Switching a song off only takes it off the memory stick: it stays in your songs, and stays off until you switch it on
    again. The filters (Installed, Update ready, Not installed…) and the search narrow the list, and the add and remove buttons
    next to them work on the songs shown.</p>
    <h3>Archive</h3>
    <p><b>Archive</b> on a song's row puts the song away: it leaves your songs and the game's list (and the memory stick, if
    ticked), but Pocket Encore keeps it on your computer. <b>Archived songs</b> lists them; <b>Restore</b> brings one back.</p>
    <h3>Other song folders</h3>
    <p><b>Other songs on the memory stick</b> are song folders that aren't in your songs: a friend's pack, or songs from an
    older library. <b>Add to my library</b> adds one to your songs (see Merge Songs); <b>Remove from memory stick</b> deletes
    its folder there.</p>
    <h3>By hand</h3>
    <p>Copying by hand works too: the song folders and <span class="mono">ZZCUSTOMDB</span> from <span class="mono">out\\MUSIC</span>
    (a song's <b>More</b> → <b>Open the song's game files</b>) into <span class="mono">PSP\\GAME\\ULUS10418\\MUSIC</span>,
    replacing the old <span class="mono">ZZCUSTOMDB</span>. Never copy someone else's <span class="mono">ZZCUSTOMDB</span>:
    theirs only lists their songs, so yours disappear, and if it lands next to your <span class="mono">TEXT</span> its songs get
    your songs' names. Add their songs with <b>Merge Songs</b> instead.</p>
    <p class="small dim">Every song folder Pocket Encore makes has a small <span class="mono">PESONG.JSON</span>, and
    <span class="mono">ZZCUSTOMDB</span> a <span class="mono">PEDB.JSON</span>: the game ignores them; Pocket Encore reads them to
    tell what is installed. Your song database number is always raised above any other database Pocket Encore has seen on your
    memory sticks, so yours is the one the game uses.</p>`],
  ["song", "Making a song", `
    <h3>Audio tracks</h3>
    <p>One file per instrument: drums, bass, guitar, vocals (required) and a backing track (optional: everything else). WAV,
    MP3, FLAC or OGG. Drop up to 5 files at once: each goes to the instrument its name mentions; the rest fill the empty slots in
    order. Tracks from AI splitters (Fadr, Moises.ai, Lalal.ai…) work. The song's <b>Audio</b> tab shows how much of the song
    each track plays in, and warns about tracks that are almost silent, too loud, off-centre, low-quality MP3s, or that leak
    into each other.</p>
    <h3>Song info</h3>
    <ul>
      <li><b>Difficulty in the song list</b>: the marks the game shows next to the song, from Warmup (empty circles) through one
        to five dots to Impossible (five red rock hands). Click a dot to set it; click it again to go one lower.</li>
      <li><b>Count-in</b> (Audio tab): 4 drumstick clicks before the music starts.</li>
      <li><b>Advanced settings</b> 🔒 (Advanced Edit Mode): <b>Lead-in</b> (silence before the music; automatic),
        <b>Stars scale</b> (above 1 = harder stars, below 1 = easier; <b>Calibrate from a play…</b> works it out from when gold
        appeared), <b>Preview start</b>, <b>Guitar chords (%)</b> and <b>Loudness</b>.</li>
    </ul>
    <h3>Getting it in the game</h3>
    <p><b>Make the song</b> makes the audio, the chart and the song database. After you change something, the song page says
    "Your changes are saved but not in the game yet": <b>Rebuild song</b> redoes only what changed (the chart alone is much
    faster than the audio). Then update it on the Memory stick page. The <b>Build log</b> (top right) shows each step; a song's
    <b>More</b> → <b>Show the last build log</b> shows its previous one.</p>`],
  ["editor", "Chart editor", `
    <p>The <b>Chart</b> tab shows the four parts' gems over each track's waveform, with the song playing. Saving
    turns the automatic chart into your own (<span class="mono">chart.mid</span>); <b>Back to the automatic chart</b> on the
    Audio tab undoes that. <b>Save + rebuild</b> also puts your changes in the game files. In Easy Edit Mode you edit
    Expert, and Hard, Medium and Easy are view-only: the build makes them from Expert. <a href="#/help/editmodes">Advanced Edit Mode</a>
    lets you edit them by hand.</p>
    <table class="t"><tr><th>Key / action</th><th>Does</th></tr>
      <tr><td><kbd>Space</kbd></td><td>play / pause (click the ruler to jump)</td></tr>
      <tr><td><kbd>1</kbd>–<kbd>4</kbd></td><td>add a gem in that lane of the selected part at the playhead, also while playing; hold while playing = held note, together = chord</td></tr>
      <tr><td><kbd>R</kbd> / Record</td><td>play in record mode</td></tr>
      <tr><td>click a lane · drag · drag the right end</td><td>add a gem (with several gems selected, the click unselects them first) · move (all the selected gems) · make it a hold</td></tr>
      <tr><td><kbd>Del</kbd> · <kbd>←</kbd><kbd>→</kbd> · <kbd>↑</kbd><kbd>↓</kbd> · <kbd>T</kbd></td><td>delete · move by snap · change lane · tap/hold</td></tr>
      <tr><td>drag an overdrive or solo bar · drag its ends</td><td>move the phrase or solo · make it longer or shorter (snapped; it stops at the next phrase, and a solo at any part's next solo)</td></tr>
      <tr><td><kbd>F</kbd> · All parts / Focus / Only</td><td>show all four parts · enlarge the selected part, the others as thin strips (click one to switch) · only the selected part; double-click a part's name to enlarge it or go back</td></tr>
      <tr><td><kbd>O</kbd> / Overdrive · <kbd>L</kbd> / Solo</td><td>overdrive phrase · solo, on/off for the selected gems (one part has a solo at a time); while recording, <kbd>O</kbd> or Overdrive starts a phrase at the playhead and a second press ends it</td></tr>
      <tr><td>drag on the ruler · <kbd>K</kbd> / ⟲ Loop</td><td>mark a section to repeat · loop on/off: it starts at the playhead's bar, as long as the last loop (with gems selected: loops their bars)</td></tr>
      <tr><td><kbd>N</kbd> / Metronome (in the mixer)</td><td>a click on every beat of the song's tempo, higher on the first beat of each bar; it has its own volume and follows the playback speed</td></tr>
      <tr><td>Shapes · <kbd>Shift</kbd>+<kbd>1</kbd>–<kbd>7</kbd></td><td>drag a shape onto its part, or click it then click the part · add shape n at the playhead</td></tr>
      <tr><td><kbd>Ctrl</kbd>+<kbd>Z</kbd>/<kbd>Y</kbd> · <kbd>Ctrl</kbd>+<kbd>C</kbd>/<kbd>V</kbd> · <kbd>Ctrl</kbd>+<kbd>S</kbd></td><td>undo/redo · copy/paste at the playhead · save</td></tr>
      <tr><td>wheel · <kbd>Ctrl</kbd>+wheel</td><td>scroll · zoom</td></tr>
    </table>
    <h3>Chart rules</h3>
    <p>The rules button in the toolstrip (<b>⚠ 3 rules</b>, or <b>✓ Rules OK</b>) warns when the chart leaves what the official
    charts do (too fast, too many chords, one thumb alternating, held drums…); it flashes when an edit breaks a rule. Click it
    to see the list over the chart: <b>go</b> to a warning, or dismiss it with ×. It never blocks you.</p>
    <h3>Loop and shapes</h3>
    <p>Every bar is marked inside the parts: a stronger line where it starts, fainter lines on the beats, and every other
    bar lightly shaded, so a bar is easy to loop, chart, copy and paste at the start of another bar.</p>
    <p><b>Loop</b> repeats a section while you edit or record it: press <kbd>K</kbd> (or ⟲ Loop) where the playhead is,
    select gems and press <kbd>K</kbd>, or drag along the time ruler. <b>Shapes</b> (above the chart) are the gem combinations the official charts use most: guitar and drums
    chords (3-gem chords on Expert only), and for bass two gems in a row, since bass has no chords. Vocals have none.</p>
    <h3>Controller</h3>
    <p>Xbox and PlayStation controllers work in the editor with the game's layout: <b>D-pad ←</b> red, <b>D-pad ↑</b> yellow,
    <b>△ / Y</b> blue, <b>○ / B</b> green, <b>✕ / A</b> overdrive, <b>L1 / LB</b> and <b>R1 / RB</b> change the part. Press gem
    buttons together for a chord; hold one while playing for a held note; while recording, overdrive starts and ends a phrase.
    The other actions (play, record, loop, undo…) and the sticks are listed in the editor's <b>🎮 Controller</b> dialog, where
    any button can be changed. If your presses land early or late, use its <b>Calibrate…</b>.</p>
    <h3>Tempo</h3>
    <p><b>snap → attacks</b> places gems where a note starts in that part's track (a pick or strum, a drum hit, a sung
    syllable), found once per song from the audio; small marks along the bottom of each part show them, taller for
    stronger ones. A gem goes to the best attack within 60 ms, or to the 1/4 grid if there is none. It helps most on
    guitar and bass, whose waveform is a solid block: click or record roughly at the right moment and the gem lands on
    the note. The other snap choices use the beat grid.</p>
    <p><b>Tempo…</b> (Advanced Edit Mode) sets a steady BPM from the first beat, or shifts every gem against the audio. Screen effects are on the
    <b>Effects &amp; Band Anims</b> tab.</p>`],
  ["anims", "Effects & Band Anims", `
    <p>The <b>Effects &amp; Band Anims</b> tab shows, on the song's time line with playback, the screen effects and what the band
    does in game. Changes go into <span class="mono">song.json</span>; <b>Save + rebuild</b> (or <b>Rebuild song</b> on the song page) puts them in the game files.</p>
    <h3>Screen effects</h3>
    <p>One track for the whole song: an effect covers the whole screen, and only one runs at a time, so effects can't overlap.
    Double-click the track to add one, drag it to move it, drag an end to make it longer or shorter, <kbd>Del</kbd> deletes it.
    Click one to pick the effect or type its times. An effect starts and ends exactly at its times. The preview box on the
    right shows the effect at the playhead.</p>
    <h3>Singer props</h3>
    <p><b>Automatic</b> (the default): in guitar solos where nobody sings and in instrumental parts of 8 bars or more, the
    singer picks up a prop and plays it on the beat. Choose which one: <b>Tambourine</b>, <b>Cowbell</b>, <b>Hand clapping</b>
    or <b>None</b>. <b>My own sections</b> starts from the automatic ones and lets you move, resize, add (double-click, or the
    <b>Tambourine</b> / <b>Cowbell</b> / <b>Clapping</b> buttons) and delete them, each with its own prop.</p>
    <h3>Singer mic, Guitarist and Bassist 🔒</h3>
    <p>The singer raises the mic before each vocal part and lowers it in breaks of 4 s or more; the guitarist's and bassist's
    hands play one movement per note. These follow the song's notes, so they are read-only in Easy Edit Mode: change the
    notes on the Chart tab instead. In Advanced Edit Mode, mic changes can be moved, added (double-click) or deleted, and a
    guitarist or bassist clip can be changed for one note.</p>`],
  ["editmodes", "Easy and Advanced Edit Mode", `
    <p><b>Easy Edit Mode</b> (the default) keeps everything that is easy to get wrong read-only: those controls are greyed
    and marked 🔒. Most of the time it is better to stay in Easy Edit Mode: the build makes those parts from the song's own
    notes, the way the official songs do.</p>
    <p><b>Advanced Edit Mode</b> unlocks them. Turn it on with <b>Enable Advanced Edit Mode</b> (it asks first) and off with the
    same button. It is one setting for the whole app on this computer.</p>
    <table class="t"><tr><th>Where</th><th>Easy Edit Mode</th><th>Advanced Edit Mode adds</th></tr>
      <tr><td>Song info</td><td>title, artist, album, year, genre, singer; scores and notes</td>
        <td><b>Advanced settings</b>: lead-in, stars scale, preview, guitar chords, loudness</td></tr>
      <tr><td>Audio</td><td>the tracks, the MIDI or notes from the audio, the count-in, where the tracks came from</td><td>(nothing more)</td></tr>
      <tr><td>Chart</td><td>everything on <b>Expert</b>: gems, shapes, held notes (drums too: the rules button warns),
        overdrive, solos, recording, the controller. Hard, Medium and Easy are view-only: the build makes them from Expert</td>
        <td>editing Hard, Medium and Easy by hand (turn off "made from Expert"); <b>Tempo…</b> (constant tempo, shift every gem)</td></tr>
      <tr><td>Effects &amp; Band Anims</td><td>screen effects; singer props (automatic or your own sections)</td>
        <td>singer mic changes (move, add, delete); one guitarist or bassist clip per note</td></tr>
      <tr><td>song.json</td><td>(hidden)</td><td>the song.json tab: every setting as text</td></tr>
      <tr><td>Make a new song</td><td>the folder name is made from the title</td><td>choose the folder name (More options)</td></tr>
      <tr><td>Song page → More</td><td>open the song's folder, the last build log</td><td>open the song's game files</td></tr>
      <tr><td>Settings</td><td>your game, the look</td><td>change the tool paths</td></tr>
    </table>`],
  ["packs", "Share & Packs", `
    <p>The game lists at most 300 songs, official ones included (188 custom songs with all the DLC, 245 with the base game
    only). A <b>pack</b> is a set of your songs with its own song database: make one for metal and another for classic rock,
    and install whichever you want to play. A pack is also the easy way to give songs to a friend.</p>
    <h3>Make a pack</h3>
    <ol>
      <li><b>Share &amp; Packs</b> → <b>Make a pack</b>: name it (empty = "Pocket Encore" + a code) and pick its songs. The
        search also finds genres: type "metal", then <b>Pick these N</b>.</li>
      <li><b>Also save it as one .zip file, ready to send</b> (on by default) writes <span class="mono">out\\PACKS\\&lt;name&gt;.zip</span>
        next to the pack's folder <span class="mono">out\\PACKS\\&lt;name&gt;</span>.</li>
      <li><b>Make the pack</b> makes any of its songs that aren't made yet, then writes the pack. When one of its songs changes
        later, the pack says <b>Update ready</b>: press <b>Update pack</b>.</li>
    </ol>
    <h3>Install a pack</h3>
    <p>One pack is installed at a time. <b>Install on my memory stick</b> opens the Memory stick page with the pack's songs
    switched on and the others off; review and apply as usual. Installing another pack (<b>Install instead</b>) uninstalls the
    one installed: its songs leave the memory stick but stay in your songs. <b>Uninstall</b> does the same without installing
    another. Scores are kept per song, so they come back with the song.</p>
    <h3>Share a pack</h3>
    <p><b>Share it</b> shows what to send: the .zip file (or the pack's folder). A friend with Pocket Encore uses
    <b>Merge Songs</b>; without it, they copy the pack's <span class="mono">MUSIC</span> contents into
    <span class="mono">PSP\\GAME\\ULUS10418\\MUSIC</span> (its <span class="mono">pack.txt</span> explains how). A pack has the
    songs' audio in it: only share songs whose audio you're allowed to share.</p>
    <h3>Merge Songs</h3>
    <p>Got a pack or a song folder from someone? <b>Merge Songs</b>: drop the .zip file, or <b>Choose…</b> the zip or the
    folder. It lists what it found as <b>New</b> or <b>Already in your songs</b> before adding anything. <b>Add to my songs</b>
    adds the new ones with their chart and audio as shipped and makes them ready for the game; then add them in game on the
    Memory stick page. Never copy someone else's <span class="mono">ZZCUSTOMDB</span> onto your memory stick: your own songs
    would disappear from the game.</p>`],
  ["modes", "Game modes", `
    <p>Checked every time Pocket Encore starts (<b>Settings</b> → <b>Your game</b> shows which):</p>
    <ul>
      <li><b>Base Game + Complete DLC</b>: all the DLC is installed; songs are built on it and every song stays listed.</li>
      <li><b>Base Game + Incomplete DLC</b>: some DLC; songs are built on it and your DLC songs stay listed.</li>
      <li><b>Base Game only</b>: no DLC; songs are built from the game's disc image.</li>
    </ul>
    <p>When the mode changes (DLC added or removed), the Songs page says so: rebuild any song, then apply on the Memory stick
    page so the new song database goes there.</p>`],
  ["trouble", "Troubleshooting", `
    <ul>
      <li><b>Making a song fails</b>: the Build log (top right) says which step. Settings must show everything found.</li>
      <li><b>The song isn't in the game's list</b>: on the Memory stick page, check its <b>Add in game</b> switch and its state
        (Installed, Update ready, Not installed), then <b>Review and apply</b>. Only one song list counts: if the page says
        the song list on the memory stick comes from someone else's pack, applying puts yours back.</li>
      <li><b>Only someone else's song shows, under one of your songs' names</b>: their pack's <span class="mono">ZZCUSTOMDB</span>
        was copied onto yours. On the Memory stick page, <b>Add to my library</b> on their song's row (under other songs on the
        memory stick), then <b>Review and apply</b>.</li>
      <li><b>Notes feel early or late</b>: on the Chart tab, <b>Tempo…</b> → shift all gems by a few ms (Advanced Edit Mode).</li>
      <li><b>Stars too easy or hard</b>: Song info → Advanced settings → Stars scale → <b>Calibrate from a play…</b>, then
        Rebuild song.</li>
      <li><b>Pocket Encore won't start</b>: the console window says why; if it's already running, starting it again just opens
        its window.</li>
      <li><b>Uninstalling</b>: Windows Settings → Apps → Installed apps → Pocket Encore → Uninstall. It closes Pocket Encore
        if it is running and asks whether to delete your songs, settings and built output too (No keeps them, so a new
        install in the same folder finds them). Songs already copied to the memory stick stay there: delete their folders
        and <span class="mono">ZZCUSTOMDB</span> by hand (their <span class="mono">PESONG.JSON</span> / <span class="mono">PEDB.JSON</span> go with them).</li>
    </ul>
    <p>Everything in detail (file formats, every option, what was tested): <button id="openGuide">Open the full guide</button></p>`],
];
function showHelp(topic) {
  const t = HELP.find(h => h[0] === topic) || HELP[0];
  $("#crumb").innerHTML = META.configured ? `<a href="#/">Songs</a> / Help` : `<a href="#/welcome">Welcome</a> / Help`;
  $("#main").innerHTML = `<div class="helpwrap"><nav class="helpnav">${HELP.map(([k, n]) => `<a href="#/help/${k}" class="${k === t[0] ? "on" : ""}">${n}</a>`).join("")}
      <span class="small dim" style="margin-top:10px">Pocket Encore ${META.version ? `v${esc(META.version.version)} ${esc(META.version.stage)}` : ""}</span>
      <button id="updCheck" class="small" style="justify-self:start">Check for updates</button><span id="updState" class="small dim">${updateStatusText(UPD)}</span></nav>
    <div class="panel helpbody"><h2>${t[1]}</h2>${t[2]}</div></div>`;
  const g = $("#openGuide");
  if (g) g.onclick = () => api("POST", "/api/open/ZNONE?what=guide").catch(fail("Couldn't open the guide"));
  bindUpdatePanel();
}

// ---------- song page ----------
// ---------- song page: status and the next step above the title, then Song info | Audio | Chart | Effects & Band Anims ----------
const TIER_NAMES = ["Warmup", "Apprentice", "Solid", "Moderate", "Challenging", "Nightmare", "Impossible"];
// the game's Choose Difficulty screen: five marks; empty circles = Warmup, white dots up to Nightmare, five red rock hands = Impossible
const ROCK_SVG = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><rect x="5.5" y="1.5" width="3.4" height="12" rx="1.7"/><rect x="15.6" y="3" width="3.2" height="10.5" rx="1.6"/><rect x="8.6" y="8.6" width="7.2" height="4.6" rx="2"/><rect x="5.5" y="10.5" width="13.3" height="11" rx="3.4"/><rect x="3" y="13" width="9" height="3.6" rx="1.8"/></svg>`;
const SLOT_LABEL = { drums: "Drums", bass: "Bass", guitar: "Guitar", vocals: "Vocals", fill: "Backing track" };
async function showSong(folder, tab) {
  CUR = await api("GET", `/api/song/${folder}`);
  const S = CUR.song, adv = window.editMode() === "advanced";
  const tabs = S.imported ? [["details", "Song info"]] : [["details", "Song info"], ["audio", "Audio"], ["editor", "Chart"], ["anims", "Effects & Band Anims"], ...(adv ? [["json", "song.json"]] : [])];
  if (!tabs.some(t => t[0] === tab)) tab = "details";
  const compact = tab === "editor" || tab === "anims";
  const fx = Array.isArray(S.effects) ? S.effects.length : S.effects ? 1 : 0;
  const facts = S.imported ? [] : [["Audio", `${Object.keys(S.stems || {}).length} tracks`], ["Chart", CUR.chartSource === "edited" ? "edited by you" : CUR.chartSource === "midi" ? "from your MIDI" : "made from the audio"],
    ["Effects", fx ? `${fx} effect${fx > 1 ? "s" : ""}` : "none"], ["Built", CUR.builtAt ? new Date(CUR.builtAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "not yet"]];
  $("#main").innerHTML = `<div class="songpage${compact ? " compact" : ""}">
    <div class="shtop"><a href="#/">← Your songs</a>${compact ? `<b class="shname">${esc(S.title)}</b>` : ""}<span class="grow"></span>
      ${compact ? "" : `<span id="sgMode">${window.editModeButton()}</span>`}
      <details class="menu"><summary>More</summary><div class="menubox">
        ${window.editMode() === "advanced" ? `<button onclick="openFolder('${folder}','outsong')">Open the song's game files</button>` : ""}<button onclick="openFolder('${folder}','song')">Open the song's folder</button>
        ${CUR.buildLog ? `<button onclick="showStoredLog('${folder}')">Show the last build log</button>` : ""}</div></details></div>
    <div class="status" id="sgStatus" role="status">${songStatusHtml(songStatus(CUR, null))}</div>
    ${compact ? "" : `<div class="shtitle"><h1>${esc(S.title)}</h1><p class="dim">${esc(S.artist)}${S.year ? " · " + esc(S.year) : ""}${S.genre ? " · " + esc(S.genre) : ""}${S.imported ? " · shared with you" : ""}</p></div>
      ${facts.length ? `<ol class="facts">${facts.map(([k, v]) => `<li><span class="small dim">${k}</span><b>${esc(v)}</b></li>`).join("")}</ol>` : ""}`}
    <nav class="songtabs" role="tablist" aria-label="Song">${tabs.map(([k, n]) => `<a role="tab" href="#/song/${folder}/${k}" data-tab="${k}" class="${k === tab ? "on" : ""}" aria-selected="${k === tab}">${n}</a>`).join("")}</nav>
    <div id="tab"></div></div>`;
  document.querySelectorAll(".songtabs [data-tab]").forEach(a => a.onclick = e => {
    // Song info and Audio are one form: switching between them keeps unsaved changes
    if ((a.dataset.tab === "details" || a.dataset.tab === "audio") && document.querySelector(`.pane[data-pane="${a.dataset.tab}"]`)) { e.preventDefault(); showPane(a.dataset.tab); }
  });
  bindSongStatus(folder);
  songStatusFromStick(folder);
  if (tab === "editor") { document.body.classList.add("editing"); return window.openEditor($("#tab"), folder, CUR); }
  if (tab === "anims") { document.body.classList.add("editing"); return window.openAnims($("#tab"), folder, CUR); }
  if (tab === "json") return showJson(folder);
  showDetails(folder, tab);
}
function showPane(k) {
  document.querySelectorAll(".pane").forEach(p => p.hidden = p.dataset.pane !== k);
  document.querySelectorAll(".songtabs [data-tab]").forEach(a => { const on = a.dataset.tab === k; a.classList.toggle("on", on); a.setAttribute("aria-selected", on); });
  const h = location.hash.replace(/\/(details|audio)$/, "") + "/" + k;
  history.replaceState(null, "", /\/(details|audio)$/.test(location.hash) ? h : location.hash.replace(/(#\/song\/[^/]+).*/, "$1/" + k));
  lastHash = location.hash;
}
// the song's state in plain words, with the one next step: [kind ok | todo | run, text, button html]
function songStatus(s, x) {
  if (s.building) return ["run", "Rebuilding the song… (Build log, top right, shows the details)", ""];
  if (s.status === "not built") return ["todo", "Not made yet", `<button class="primary" data-sg="rebuild">Make the song</button>`];
  if (s.status === "changed since build") return ["todo", "Your changes are saved but not in the game yet", `<button class="primary" data-sg="rebuild">Rebuild song</button>`];
  if (!x) return ["ok", "Built", ""];
  if (x.state === "missing") return x.off ? ["", "Built · not added in game (switched off on the Memory stick page)", `<a class="btn" href="#/stick">Memory stick</a>`]
    : ["todo", "Built · not on the memory stick yet", `<a class="btn primary" href="#/stick">Install on memory stick</a>`];
  if (x.state === "installed") return x.listed ? ["ok", "In the game · up to date", ""] : ["todo", "On the memory stick, but the game doesn't list it yet", `<a class="btn primary" href="#/stick">Update on memory stick</a>`];
  return ["todo", "Built · the memory stick has an older version", `<a class="btn primary" href="#/stick">Update on memory stick</a>`];
}
const songStatusHtml = ([k, t, btn]) => `<span class="sdot ${k}" aria-hidden="true"></span><span>${esc(t)}</span>${btn ? `<span class="grow"></span>${btn}` : ""}`;
function bindSongStatus(folder) {
  document.querySelectorAll('[data-sg="rebuild"]').forEach(b => b.onclick = async () => {
    await runBuild(folder, "auto");
    if (es) { CUR.building = true; $("#sgStatus").innerHTML = songStatusHtml(songStatus(CUR, null)); }
  });
}
async function songStatusFromStick(folder) {
  if (!CUR || CUR.status !== "built") return;
  let v; try { v = await loadSticks(); } catch { return; }
  const st = v.sticks.find(s => s.online && s.kind === "ppsspp") || v.sticks.find(s => s.online) || v.sticks[0];
  if (!st || !$("#sgStatus") || CUR.folder !== folder) return;
  $("#sgStatus").innerHTML = songStatusHtml(songStatus(CUR, st.songs.find(y => y.folder === folder) || { state: "missing" }));
}
// a track's state in plain words
function stemPlain(st) {
  const x = st.stats, f = st.format;
  if (!st.source) return "";
  if (st.exists === false) return `<span class="warnline">The file isn't there any more: choose it again.</span>`;
  if (!x) return `<span class="dim">Checked when the song is made.</span>`;
  if (x.note) return esc(x.note);
  const w = [];
  if (x.silent) w.push("Almost silent: is this the right file?");
  if (x.clip > 50) w.push(`Too loud in places: it may crackle (${x.clip} samples)`);
  if (Math.abs(x.dc) > 1) w.push("Off-centre (DC offset): it may click");
  if (f && f.ext === "mp3" && f.mb / Math.max(1, x.seconds) * 8192 < 160) w.push(`Low-quality MP3 (about ${Math.round(f.mb / x.seconds * 8192)} kbps)`);
  return `<span class="dim">Sound in ${x.active}% of the song${f ? ` · ${f.ext.toUpperCase()} ${f.mb} MB` : ""}</span>${w.map(t => `<br><span class="warnline">${esc(t)}</span>`).join("")}`;
}
function tierDots(k, v) {
  const imp = v === 6;
  return `<div class="tier"><b>${k[0].toUpperCase() + k.slice(1)}</b><div class="dots" role="radiogroup" aria-label="${k} difficulty">
    ${[1, 2, 3, 4, 5].map(i => `<button type="button" role="radio" aria-checked="${v === i}" aria-label="${TIER_NAMES[i]}" title="${TIER_NAMES[i]}" data-tierdot="${k}" data-v="${i}" class="${imp ? "rock" : i <= v ? "fill" : ""}">${imp ? ROCK_SVG : ""}</button>`).join("")}
    <button type="button" role="radio" class="impos ${imp ? "on" : ""}" aria-checked="${imp}" aria-label="Impossible" title="Impossible" data-tierdot="${k}" data-v="6">${ROCK_SVG}</button></div>
    <span class="small dim" data-tiername="${k}">${TIER_NAMES[v]}</span><input type="hidden" data-tier="${k}" value="${v}"></div>`;
}
function bindTierDots(onChange) {
  document.querySelectorAll("[data-tierdot]").forEach(b => b.onclick = () => {
    const k = b.dataset.tierdot, inp = document.querySelector(`[data-tier="${k}"]`), cur = Number(inp.value), v = Number(b.dataset.v);
    inp.value = cur === v ? v - 1 : v;
    const had = document.activeElement === b;
    b.closest(".tier").outerHTML = tierDots(k, Number(inp.value));
    bindTierDots(onChange); onChange();
    if (had) { const f = document.querySelector(`[data-tierdot="${k}"][data-v="${v}"]`); if (f) f.focus(); }  // keep the keyboard's place
  });
}
// radio groups made of buttons (difficulty dots, theme): the arrow keys move to the next or previous choice and pick it
document.addEventListener("keydown", e => {
  const r = e.target.closest && e.target.closest('[role="radio"]'), g = r && r.closest('[role="radiogroup"]');
  if (!g || !/^Arrow(Left|Right|Up|Down)$/.test(e.key) || e.ctrlKey || e.altKey || e.metaKey) return;
  const all = [...g.querySelectorAll('[role="radio"]')].filter(x => !x.disabled), i = all.indexOf(r);
  const next = all[(i + (e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : all.length - 1)) % all.length];
  e.preventDefault();
  next.focus();
  if (next.getAttribute("aria-checked") !== "true") next.click();  // (a difficulty dot clicked again would go one lower)
});
// one Unsaved changes bar for the form on screen (Song info + Audio)
function unsavedBar(save) {
  const bar = document.createElement("div");
  bar.className = "unsaved hidden"; bar.setAttribute("role", "region"); bar.setAttribute("aria-label", "Unsaved changes");
  bar.innerHTML = `<b>Unsaved changes</b><span class="grow"></span><button id="usDiscard">Discard</button><button class="primary" id="usSave">Save</button>`;
  $("#tab").appendChild(bar);
  const check = () => bar.classList.toggle("hidden", !(GUARD && GUARD.dirty()));
  $("#tab").addEventListener("input", check); $("#tab").addEventListener("change", check);
  $("#usDiscard").onclick = () => { GUARD = null; route(); };
  $("#usSave").onclick = () => save().then(() => { GUARD = null; route(); }, fail("Couldn't save the song"));
  return check;
}
function aboutForm(S) {
  return `<section class="panel"><h2>About the song</h2><p class="small dim">How it shows in the game's song list.</p><div class="form">
      <label for="f_title">Title</label><input type="text" id="f_title" value="${esc(S.title)}" placeholder="${esc(PH.title)}">
      <label for="f_artist">Artist</label><input type="text" id="f_artist" value="${esc(S.artist)}" placeholder="${esc(PH.artist)}">
      <label for="f_album">Album</label><input type="text" id="f_album" value="${esc(S.album)}" placeholder="${esc(PH.album)}">
      <label for="f_year">Year</label><input type="number" id="f_year" value="${esc(S.year)}" placeholder="${esc(PH.year)}" style="width:100%">
      <label for="f_genre">Genre</label><select id="f_genre">${opt(META.genres.map(g => [g, g]), S.genre)}</select>
      <label for="f_vocals">Singer</label><select id="f_vocals">${opt([["", "(not set)"], [1, "Male singer"], [2, "Female singer"]], S.vocals)}</select></div></section>
    <section class="panel"><h2>Difficulty in the song list</h2><p class="small dim">The marks the game shows next to the song: empty circles for Warmup, one to five dots, and five red rock hands for Impossible (the hand at the end turns it on). They don't change the notes. Click a lit dot again to take one off.</p>
      <div class="tiers">${["band", "guitar", "bass", "drums", "vocals"].map(k => tierDots(k, (S.tiers || {})[k] ?? 0)).join("")}</div></section>`;
}
// an imported song: its song info and difficulty only (its chart and audio are as shipped)
function showImportedDetails(folder) {
  const S = CUR.song, I = S.imported || {};
  $("#tab").innerHTML = `<div class="pane" data-pane="details"><div class="notice">This song was shared with you${I.at ? ` (added ${esc(new Date(I.at).toLocaleDateString())})` : ""}: its chart and audio are used as they are, so only its song info and difficulty can be changed here.</div>
    <div class="grid2">${aboutForm(S)}</div></div>`;
  const save = async () => {
    const N = JSON.parse(JSON.stringify(S)), v = id => $(id).value.trim();
    N.title = v("#f_title"); N.artist = v("#f_artist"); setOrDelete(N, "album", v("#f_album"));
    setOrDelete(N, "year", v("#f_year") ? Number(v("#f_year")) : ""); N.genre = v("#f_genre");
    setOrDelete(N, "vocals", v("#f_vocals") ? Number(v("#f_vocals")) : "");
    N.tiers = Object.assign({}, N.tiers); document.querySelectorAll("[data-tier]").forEach(e => N.tiers[e.dataset.tier] = Number(e.value));
    if (!N.title || !N.artist) throw userError("Add a title and an artist to save the song.");
    CUR = await api("PUT", `/api/song/${folder}`, N); markSaved(); toast("Saved"); return true;
  };
  guardForm($("#tab"), "the song info", save);
  const check = unsavedBar(save);
  bindTierDots(check);
}
async function showDetails(folder, pane = "details") {
  if (CUR.song.imported) return showImportedDetails(folder);
  const s = CUR, S = s.song, src = S.stemSource || {}, adv = window.editMode() === "advanced", lock = adv ? "" : "disabled";
  const B = s.built;
  const starsTable = B ? `<div class="tablewrap"><table class="t"><tr><th>Difficulty</th><th>Drums</th><th>Bass</th><th>Guitar</th><th>Vocals</th><th>5★</th><th>Gold stars at</th><th>Max</th></tr>
    ${B.map((d, i) => `<tr><td>${DIFFS[i]}</td>${d.gems.map(n => `<td>${n}</td>`).join("")}<td>${fmtN(d.stars[4])}</td><td>${fmtN(d.stars[5])}</td><td>${fmtN(d.max)}</td></tr>`).join("")}</table></div>
    <p class="small dim">Notes per part and star scores from the last build.</p>` : `<p class="dim">Not made yet.</p>`;
  const stems = s.stems.map(st => { const k = st.part, has = !!st.source;
    return `<div class="slot" data-slot="${k}"><span class="mark ${has ? "ok" : ""}" aria-hidden="true">${has ? "✓" : ""}</span><b>${SLOT_LABEL[k] || k}${k === "fill" ? ' <span class="small dim">(optional)</span>' : ""}</b>
      <span class="f"><span data-fname="${k}">${has ? esc(fileName(st.source)) : `<span class="dim">${k === "fill" ? "not added" : "missing"}</span>`}</span><br>${stemPlain(st)}</span>
      <span class="actions"><button class="small" onclick="pickInto('[data-stem=${k}]','${folder}')">${has ? "Replace…" : "Choose…"}</button>${has && k === "fill" ? `<button class="small" data-stemrm="${k}">Remove</button>` : ""}</span>
      <input type="hidden" data-stem="${k}" value="${esc(st.source || "")}"></div>`; }).join("");
  const bleed = s.bleed && s.bleed.length ? `<p class="small warnline">Some tracks rise and fall together (${s.bleed.map(b => `${SLOT_LABEL[b.a] || b.a} and ${SLOT_LABEL[b.b] || b.b}`).join(", ")}). Normal for a band recorded together; with AI-split tracks it usually means one instrument leaked into another.</p>` : "";
  const au = s.audio;
  const chart = s.chartSource === "edited" ? `<p>You edited the notes on the Chart tab.</p><p class="small warnline">An edited chart keeps its timing: changing the lead-in, the count-in or the tracks moves the audio but not the notes.</p>
      <div class="actions"><button class="danger" onclick="revertChart('${folder}')">Back to the automatic chart</button></div>`
    : S.midi ? `<p>The notes come from your MIDI file: <span class="mono">${esc(fileName(S.midi))}</span>.</p><div class="actions"><button onclick="pickInto('#f_midi','${folder}')">Replace the MIDI…</button><button id="f_nomidi">Make the notes from the audio instead</button></div>`
    : `<p>The notes are made from the audio tracks (no MIDI).</p><div class="actions"><button onclick="pickInto('#f_midi','${folder}')">Use a MIDI for the chart…</button></div>`;
  $("#tab").innerHTML = `
    <div class="pane" data-pane="details" ${pane === "details" ? "" : "hidden"}>
      <div class="grid2">${aboutForm(S)}</div>
      <details class="panel" ${adv ? "open" : ""}><summary><b>Advanced settings</b> ${adv ? "" : `<span class="small dim">· 🔒 read-only in Easy Edit Mode</span>`}</summary>
        ${adv ? "" : `<p class="small dim">These change how the song sounds and scores; most songs never need them. Turn on Advanced Edit Mode (top right, or Settings) to change them.</p>`}
        <div class="form">
          <label for="f_leadIn">Lead-in (s)</label><span class="inline"><input type="number" step="0.1" id="f_leadIn" value="${esc(S.leadIn ?? "")}" placeholder="auto" ${lock}><span class="small dim">silence before the music; empty = auto (music starts after 3 s, 4.5 s with a count-in)</span></span>
          <label for="f_starsScale">Stars scale</label><span class="inline"><input type="number" step="0.01" id="f_starsScale" value="${esc(S.starsScale ?? "")}" placeholder="1" ${lock}><span class="small dim">above 1 = harder stars, below 1 = easier</span> <button class="small" id="calib" ${lock}>Calibrate from a play…</button></span>
          <label for="f_preview">Preview start (s)</label><span class="inline"><input type="number" step="0.1" id="f_preview" value="${esc(S.preview && S.preview.start != null ? S.preview.start : "")}" placeholder="loudest 30 s" ${S.preview === false || !adv ? "disabled" : ""}>
            <label class="small"><input type="checkbox" id="f_nopreview" ${S.preview === false ? "checked" : ""} ${lock}> no preview</label><span class="small dim">the clip played in the song list</span></span>
          <label for="f_chords">Guitar chords (%)</label><span class="inline"><input type="number" step="1" min="0" max="60" id="f_chords" value="${S.autochart && S.autochart.chords != null ? Math.round(S.autochart.chords * 100) : ""}" placeholder="auto" ${S.chart || !adv ? "disabled" : ""}><span class="small dim">${S.chart ? "not used: the notes were edited by hand" : "share of guitar notes that are chords; empty = from the music"}</span></span>
          <label for="f_loudness">Loudness (LUFS)</label><span class="inline"><input type="number" step="0.5" id="f_loudness" value="${esc(S.loudness ?? "")}" placeholder="-14" ${lock}><span class="small dim">-14 matches the official songs</span></span>
        </div></details>
      <details class="panel"><summary><b>Scores and notes</b> <span class="small dim">· from the last build</span></summary>${starsTable}</details>
    </div>
    <div class="pane" data-pane="audio" ${pane === "audio" ? "" : "hidden"}>
      <section class="panel"><h2>Audio tracks</h2><p class="small dim">Changing a track rebuilds the whole song, which can take a few minutes.${au ? ` Length ${fmtTime(au.audioSeconds)}, the music starts at ${au.musicStart ?? "–"} s.` : ""}</p>
        <div class="slots">${stems}</div>${bleed}</section>
      <section class="panel"><h2>Notes chart</h2>${chart}<input type="hidden" id="f_midi" value="${esc(S.midi || "")}"></section>
      <section class="panel"><h2>Count-in</h2><label class="inline"><input type="checkbox" id="f_countIn" ${S.countIn ? "checked" : ""}> Automatically add a 4 drumstick count-in before the music starts in game</label></section>
      <section class="panel"><h2>Where the tracks came from</h2><div class="form">
        <label for="f_srcType">Tracks came from</label><select id="f_srcType">${opt([["unknown", "I don't know"], ["ai", "An AI splitter"], ["official", "The official multitracks"], ["multitrack", "Other multitracks"]], src.type || "unknown")}</select>
        <label for="f_srcTool">Splitter used</label><input type="text" id="f_srcTool" value="${esc(src.tool || "")}" placeholder="${esc(PH.tool)}">
        <label for="f_srcQuality">How good they sound</label><select id="f_srcQuality">${opt([["", "(not rated)"], ["low", "Low"], ["medium", "Medium"], ["high", "High"]], src.quality || "")}</select>
        <label for="f_srcNotes">Notes</label><input type="text" id="f_srcNotes" value="${esc(src.notes || "")}" placeholder="bleed, missing parts…"></div></section>
    </div>`;
  $("#f_nopreview").onchange = e => { $("#f_preview").disabled = e.target.checked || window.editMode() !== "advanced"; };
  if ($("#calib")) $("#calib").onclick = () => calibrate(folder);
  const save = () => saveDetails(folder).then(() => true);
  guardForm($("#tab"), "the song", save);
  const check = unsavedBar(save);
  bindTierDots(check);
  // a picked or removed file shows its name straight away
  document.querySelectorAll("[data-stem]").forEach(inp => inp.addEventListener("change", () => { const n = document.querySelector(`[data-fname="${inp.dataset.stem}"]`); if (n) n.textContent = fileName(inp.value) || "not added"; check(); }));
  document.querySelectorAll("[data-stemrm]").forEach(b => b.onclick = () => { const inp = document.querySelector(`[data-stem="${b.dataset.stemrm}"]`); inp.value = ""; inp.dispatchEvent(new Event("change", { bubbles: true })); b.remove(); });
  $("#f_midi").addEventListener("change", check);
  if ($("#f_nomidi")) $("#f_nomidi").onclick = () => { $("#f_midi").value = ""; $("#f_midi").dispatchEvent(new Event("change", { bubbles: true })); toast("The notes will be made from the audio: save, then rebuild the song"); };
}
// the song page follows the edit mode (the json tab and the advanced settings), unless that would lose unsaved changes
window.addEventListener("editmodechange", () => {
  const m = /^#\/song\/([^/]+)\/?(\w*)/.exec(location.hash);
  if (!m || m[2] === "editor" || m[2] === "anims") return;
  if (pageGuard()) { toast("Save or discard your changes to see the unlocked settings.", true); const b = $("#sgMode"); if (b) b.innerHTML = window.editModeButton(); return; }
  route();
});
function opt(list, cur) { return list.map(([v, n]) => `<option value="${esc(v)}" ${String(v) === String(cur ?? "") ? "selected" : ""}>${esc(n)}</option>`).join(""); }
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
    $("#c_apply").onclick = () => { $("#f_starsScale").value = r.toFixed(2); $("#f_starsScale").dispatchEvent(new Event("change", { bubbles: true })); $("#modal").classList.add("hidden"); toast("Scale set: save, then rebuild the song"); };
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
  if (!S.title || !S.artist) throw userError("Add a title and an artist to save the song.");
  CUR = await api("PUT", `/api/song/${folder}`, S);
  markSaved();
  toast("Saved");
}
async function revertChart(folder) {
  // the page reloads afterwards, so unsaved Details changes would go: offer to save them first
  const g = pageGuard();
  const a = await ask("Use the automatic chart again?", "Your chart.mid stays in the song folder, but the build will no longer use it."
    + (g ? " You also have unsaved changes on this page." : ""),
    [...(g ? [{ label: "Save changes and use automatic chart", value: "save", kind: "danger" }, { label: "Discard changes and use automatic chart", value: "discard" }]
           : [{ label: "Use automatic chart", value: "go", kind: "danger" }]), { label: "Keep my chart", value: null }]);
  if (!a || (a === "save" && !(await saveGuard(g)))) return;
  await api("POST", `/api/chart-revert/${folder}`);
  toast("Back to the automatic chart: build to apply");
  route();
}
function showJson(folder) {
  $("#tab").innerHTML = `<div class="panel"><h4>songs/${esc(folder)}/song.json</h4>
    <textarea id="raw" aria-label="song.json" rows="34" spellcheck="false">${esc(JSON.stringify(CUR.song, null, 2))}</textarea>
    <div class="actions" style="margin-top:8px"><button class="primary" id="saveRaw">Save</button><span class="dim small">Every option is listed at the top of scripts/mksong.js. Effect names: ${META.effects.filter(e => e !== "end").join(", ")}.</span></div></div>`;
  const saveRaw = async () => { const S = JSON.parse($("#raw").value); CUR = await api("PUT", `/api/song/${folder}`, S); markSaved(); toast("song.json saved"); return true; };
  $("#saveRaw").onclick = () => saveRaw().catch(fail("Couldn't save song.json"));
  guardForm($("#tab"), "song.json", saveRaw);
}

// ---------- new song ----------
// ---------- stems: slots, tooltips, drag and drop ----------
const STEM_SLOTS = ["drums", "bass", "guitar", "vocals", "fill"];
const MAX_DROP = 5;
// Hover text for each instrument (to be written).
const STEM_TIPS = { drums: "placeholder", bass: "placeholder", guitar: "placeholder", vocals: "placeholder", fill: "placeholder" };
const tip = k => `<span class="tip" aria-hidden="true" data-tip="${esc(STEM_TIPS[k] || "")}">ⓘ</span>`;
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
async function uploadFile(file, batch) {
  const r = await fetch(`/api/upload?name=${encodeURIComponent(file.name)}&batch=${batch}`, { method: "POST", body: file });
  const v = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(v.error || r.statusText);
  return v.path;
}
// Placeholders shared by the New song form and the Details tab (they say what each field is for).
const PH = {
  folder: "ZMYSONG",
  title: "Song name",
  artist: "Band or artist",
  album: "Album name",
  year: "1999",
  midi: "None: will auto-generate chart from stems",
  tool: "eg: Fadr, Moises.ai, Lalal.ai",
  stem: k => k === "fill" ? "Backing: everything else in the song (optional)" : `${k[0].toUpperCase() + k.slice(1)} stem (required): drop a file or Browse…`,
};
const REQUIRED_STEMS = ["drums", "bass", "guitar", "vocals"];
// ---------- make a new song: Audio → About the song → Review song details → (making) → Play it ----------
const SLOT_NAME = { drums: "Drums", bass: "Bass", guitar: "Guitar", vocals: "Vocals", fill: "Backing track" };
const WSTEPS = [["audio", "Audio"], ["info", "About the song"], ["review", "Review song details"], ["done", "Play it"]];
const MAKE_STAGES = [["[audio]", "Preparing the audio"], ["[preview]", "Making the preview clip for the song list"], ["[chart]", "Making the notes for drums, bass, guitar and vocals"],
  ["Hard/Medium/Easy from Expert", "Making Hard, Medium and Easy from Expert"], ["band animations:", "Adding the band's animations"], ["[song database]", "Adding it to your song list"]];
let NW = null;
function newWizard() {
  return { step: "audio", stems: {}, names: {}, midi: "", midiName: "", title: "", artist: "", album: "", year: "", genre: "", vocals: "",
    folder: "", folderTouched: false, countIn: false, srcType: "ai", srcTool: "", batch: Date.now().toString(36), taken: [], stage: -1, started: 0, failed: false };
}
async function showNew() {
  NW = newWizard();
  try { NW.taken = (await api("GET", "/api/songs")).map(s => s.folder); } catch { }
  renderNew();
}
const fileName = p => String(p || "").split(/[\\/]/).pop();
// "Seven Nation Army - Drums.mp3" -> "Seven Nation Army"
function titleFromFiles() {
  const f = NW.names.drums || NW.names.bass || NW.names.guitar || NW.names.vocals || NW.names.fill || "";
  const base = f.replace(/\.[^.]+$/, "").replace(/[-_ ]*\b(drums?|bass|guitar|gtr|vocals?|vox|voice|other|backing|instrumental|accomp|stems?|mono|stereo|no[ _]?vocals?)\b[-_ ]*/gi, " ");
  return base.replace(/[_]+/g, " ").replace(/\s{2,}/g, " ").replace(/^[\s\-–]+|[\s\-–]+$/g, "").trim();
}
function folderFromTitle(t) {
  let f = "Z" + String(t).normalize("NFKD").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 28);
  if (f === "Z") f = "ZMYSONG";
  let k = 2, g = f; while (NW.taken.includes(g)) g = f.slice(0, 28) + k++;
  return g;
}
const wReady = () => REQUIRED_STEMS.every(k => NW.stems[k]);
function wStepper(cur) {
  const i = WSTEPS.findIndex(s => s[0] === cur);
  return `<ol class="stepper" aria-label="Steps">${WSTEPS.map(([k, n], j) => `<li class="${j === i ? "on" : j < i ? "done" : ""}"${j === i ? ' aria-current="step"' : ""}>${n}</li>`).join("")}</ol>`;
}
function renderNew() {
  const v = { audio: wAudio, info: wInfo, review: wReview, making: wMaking, done: wDone }[NW.step]();
  $("#main").innerHTML = `<div class="wizard">${v}</div>`;
  bindNew();
  const h = $("#main h2"); if (h) { h.tabIndex = -1; h.focus({ preventScroll: true }); }
  // leaving before the song is made asks first (nothing is created until Make the song)
  GUARD = ["audio", "info", "review"].includes(NW.step) ? { what: "the new song", save: null, dirty: () => !!(Object.keys(NW.stems).length || NW.midi || NW.title) } : null;
}
function wAudio() {
  const missing = REQUIRED_STEMS.filter(k => !NW.stems[k]).map(k => SLOT_NAME[k]);
  return `${wStepper("audio")}
    <section class="panel" id="dropPanel"><h2>Add the song's audio</h2>
      <p class="dim">You need the song split into separate tracks (stems): drums, bass, guitar and vocals. AI splitters such as Fadr or Moises.ai make them from a normal song file.</p>
      <div class="dropzone" id="dropzone"><b>Drop the track files here</b> <span class="small dim">(up to ${MAX_DROP} at once, a MIDI too)</span><br>
        <span class="small dim">${META.audioExt.map(e => e.slice(1).toUpperCase()).join(", ")} · each file goes to the part its name mentions</span>
        <div class="actions" style="justify-content:center;margin-top:8px"><button id="w_pickAll">Choose files…</button></div></div>
      <div class="slots">${STEM_SLOTS.map(k => { const has = !!NW.stems[k];
        return `<div class="slot" data-slot="${k}"><span class="mark ${has ? "ok" : ""}" aria-hidden="true">${has ? "✓" : ""}</span><b>${SLOT_NAME[k]}${k === "fill" ? ' <span class="small dim">(optional)</span>' : ""}</b>
          <span class="f ${has ? "" : "dim"}">${has ? esc(NW.names[k] || fileName(NW.stems[k])) : k === "fill" ? "not added" : "missing"}</span>
          <span class="actions">${has ? `<button class="small" data-wrm="${k}" aria-label="Remove the ${SLOT_NAME[k].toLowerCase()} file">Remove</button>` : `<button class="small" data-wpick="${k}" aria-label="Choose a ${SLOT_NAME[k].toLowerCase()} file">Choose…</button>`}</span>
          <input type="hidden" id="w_stem_${k}"></div>`; }).join("")}</div>
      ${Object.keys(NW.stems).length ? `<div class="actions"><button class="linkbtn small" id="w_rmall">Remove all tracks</button></div>` : ""}
    </section>
    <section class="panel"><h2>Notes chart (MIDI) <span class="small dim">· optional</span></h2>
      <p class="small dim">Have a Rock Band MIDI or any MIDI of the song? Add it and Pocket Encore uses it for the notes. Without one, it makes the notes from the audio tracks.</p>
      <div class="actions">${NW.midi ? `<span>✓ ${esc(NW.midiName || fileName(NW.midi))}</span><button class="small" id="w_midirm">Remove</button>` : `<button id="w_midi">Add a MIDI…</button>`}<input type="hidden" id="w_midiPath"></div></section>
    <div class="wnav"><a class="btn" href="#/">Cancel</a><span class="grow"></span>${missing.length ? `<span class="small dim">Still needed: ${missing.join(", ")}</span>` : ""}
      <button class="primary" id="w_next" ${missing.length ? "disabled" : ""}>Continue</button></div>`;
}
function wInfo() {
  const year = new Date().getFullYear();
  if (!NW.title) NW.title = titleFromFiles();
  if (!NW.folderTouched) NW.folder = folderFromTitle(NW.title);
  const f = (id, label, val, extra = "") => `<label for="w_${id}">${label}</label><input type="text" id="w_${id}" data-w="${id}" value="${esc(val)}" ${extra}>`;
  return `${wStepper("info")}
    <section class="panel"><h2>About the song</h2><p class="small dim">How it shows in the game's song list. All six are needed.</p>
      <div class="form">
        ${f("title", "Title", NW.title)}${NW.title && NW.title === titleFromFiles() ? `<span></span><span class="small dim fieldhelp">Filled in from the file names: check it.</span>` : ""}
        ${f("artist", "Artist", NW.artist)}${f("album", "Album", NW.album)}
        <label for="w_year">Year</label><input type="number" id="w_year" data-w="year" min="1900" max="${year}" value="${esc(NW.year)}" style="width:100%">
        <span></span><span class="small dim fieldhelp">Release year, 1900–${year}. Sets the song's era in the game.</span>
        <label for="w_genre">Genre</label><select id="w_genre" data-w="genre"><option value="">Choose the song list genre…</option>${opt(META.genres.map(g => [g, g]), NW.genre)}</select>
        <label for="w_vocals">Singer</label><select id="w_vocals" data-w="vocals"><option value="">Choose the singer shown in game…</option>${opt([[1, "Male singer"], [2, "Female singer"]], NW.vocals)}</select>
      </div>
      <details class="more"><summary>More options (optional)</summary><div class="form">
        ${window.editMode() === "advanced" ? `<label for="w_folder">Folder name</label><input type="text" id="w_folder" data-w="folder" value="${esc(NW.folder)}" style="text-transform:uppercase">
        <span></span><span class="small dim fieldhelp">The song's folder on the memory stick. Made from the title; change it only if you need to.</span>` : ""}
        <label for="w_countIn">Count-in</label><label class="inline" style="color:var(--text)"><input type="checkbox" id="w_countIn" ${NW.countIn ? "checked" : ""}> Automatically add a 4 drumstick count-in before the music starts in game</label>
        <label for="w_srcType">Tracks came from</label><select id="w_srcType" data-w="srcType">${opt([["ai", "An AI splitter"], ["official", "The official multitracks"], ["multitrack", "Other multitracks"], ["unknown", "I don't know"]], NW.srcType)}</select>
        <label for="w_srcTool">Splitter used</label><input type="text" id="w_srcTool" data-w="srcTool" value="${esc(NW.srcTool)}" placeholder="${esc(PH.tool)}">
      </div></details>
      <p id="w_missing" class="small warnline"></p>
    </section>
    <div class="wnav"><button id="w_back">Back</button><span class="grow"></span><button class="primary" id="w_next">Continue</button></div>`;
}
function wReview() {
  const li = t => `<li><span class="mark ok" aria-hidden="true">✓</span><span>${t}</span></li>`;
  return `${wStepper("review")}
    <section class="panel"><h2>Review song details</h2>
      <ul class="what">${li(`<b>${esc(NW.title)}</b> by ${esc(NW.artist)} · ${esc(NW.year)} · ${esc(NW.genre)}`)}${li(`Album ${esc(NW.album)} · ${NW.vocals == 2 ? "female" : "male"} singer`)}
        ${li(`${NW.stems.fill ? "4 parts + backing track" : "4 parts, no backing track"} · notes ${NW.midi ? "from your MIDI" : "made from the audio"}`)}${li(NW.countIn ? "With a 4 drumstick count-in" : "No count-in")}
        ${li(`Folder on the memory stick: <span class="mono">${esc(NW.folder)}</span>`)}</ul>
      <div class="actions"><button class="linkbtn small" data-wgo="audio">Change the audio</button><button class="linkbtn small" data-wgo="info">Change the details</button></div>
      <p class="small dim">Making the song can take a few minutes. You can keep using Pocket Encore meanwhile.</p></section>
    <div class="wnav"><button id="w_back">Back</button><span class="grow"></span><button class="primary big" id="w_make">Make the song</button></div>`;
}
function wMaking() {
  const pct = Math.round(Math.max(0, NW.stage) / MAKE_STAGES.length * 100);
  return `${wStepper("review")}
    <section class="panel"><h2>${NW.failed ? `Making ${esc(NW.title)} stopped` : `Making ${esc(NW.title)}…`}</h2>
      ${NW.failed ? `<p class="warnline">Something went wrong. The build log says what; the song is saved, so you can fix it and rebuild it from its page.</p>`
        : `<div class="meter" aria-hidden="true"><i style="width:${pct}%"></i></div>`}
      <div class="progress" role="status" aria-live="polite">${MAKE_STAGES.map(([, t], i) => { const s = i < NW.stage ? "done" : i === NW.stage ? (NW.failed ? "fail" : "run") : "";
        return `<div class="pstep ${s}"><span class="mark ${s === "done" ? "ok" : ""}" aria-hidden="true">${s === "done" ? "✓" : s === "run" ? "…" : s === "fail" ? "!" : ""}</span><span>${t}</span></div>`; }).join("")}</div>
      <div class="actions"><button id="w_log">Show the build log</button>${NW.failed ? `<a class="btn" href="#/song/${esc(NW.folder)}">Open the song</a>` : `<span class="small dim">You can keep using Pocket Encore meanwhile.</span>`}</div></section>`;
}
function wDone() {
  const secs = NW.started ? Math.round((Date.now() - NW.started) / 1000) : 0, F = esc(NW.folder);
  return `${wStepper("done")}
    <section class="panel donebox"><h2>${esc(NW.title)} is ready</h2>${secs ? `<p class="small dim">Made in ${Math.floor(secs / 60)} min ${secs % 60} s.</p>` : ""}
      <p>You are almost there: install the song to play it. You can always come back to edit the chart if it doesn't feel right to play, or generate the chart from a MIDI file.</p>
      <div class="actions"><a class="btn primary big" href="#/stick">Install on memory stick</a></div></section>
    <section class="panel"><h2>Or, first</h2>
      <div class="nextgrid">
        <a class="btn next" href="#/song/${F}/editor"><b>Listen and fix notes</b><span>Play the song with its notes and change any that feel wrong.</span></a>
        <a class="btn next" href="#/song/${F}"><b>Make the chart from a MIDI</b><span>Add a MIDI file and the notes are made from it instead.</span></a>
        <a class="btn next" href="#/song/${F}/anims"><b>Add screen effects</b><span>Black and white, old film, kaleidoscope… at chosen times.</span></a>
        <button class="next" id="w_another"><b>Make another song</b><span>Start again with new audio.</span></button>
      </div>
      <div class="actions"><a href="#/">Back to my songs</a></div></section>`;
}
async function wAddFiles(files, slot) {
  if (!files.length) return;
  if (files.length > MAX_DROP) return toast(`You added ${files.length} files. Add up to ${MAX_DROP} at a time.`, true);
  const bad = badFiles(files);
  if (bad.length) return toast(`Can't use ${bad.map(f => f.name).join(", ")}: not a supported file type. Audio: ${META.audioExt.join(" ")}; MIDI: ${META.midiExt.join(" ")}`, true);
  const isMidi = f => META.midiExt.includes("." + f.name.split(".").pop().toLowerCase());
  const plan = slot && files.length === 1 && !isMidi(files[0]) ? { out: { [slot]: files[0] }, midi: null, unplaced: [] } : assignFiles(files, STEM_SLOTS.filter(s => NW.stems[s]));
  const zone = $("#dropzone"); if (zone) zone.innerHTML = "<b>Copying the files…</b>";
  try {
    for (const [s, f] of Object.entries(plan.out)) { NW.stems[s] = await uploadFile(f, NW.batch); NW.names[s] = f.name; }
    if (plan.midi) { NW.midi = await uploadFile(plan.midi, NW.batch); NW.midiName = plan.midi.name; }
    if (plan.unplaced.length) toast(`No free slot for ${plan.unplaced.map(f => f.name).join(", ")}: remove a track first.`, true);
  } catch (e) { fail("Couldn't add the files")(e); }
  renderNew();
}
function bindNew() {
  const on = (id, f) => { const e = $("#" + id); if (e) e.onclick = f; };
  // audio
  const panel = $("#dropPanel");
  if (panel) {
    let depth = 0;
    panel.addEventListener("dragenter", e => { e.preventDefault(); depth++; panel.classList.add("dragging"); });
    panel.addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; panel.classList.remove("dragging"); } });
    panel.addEventListener("dragover", e => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; });
    panel.addEventListener("drop", e => { e.preventDefault(); depth = 0; panel.classList.remove("dragging"); const row = e.target.closest && e.target.closest("[data-slot]"); wAddFiles([...e.dataTransfer.files], row && row.dataset.slot); });
  }
  const pickFiles = slot => { const inp = document.createElement("input"); inp.type = "file"; inp.multiple = !slot; inp.accept = [...META.audioExt, ...(slot ? [] : META.midiExt)].join(","); inp.onchange = () => wAddFiles([...inp.files], slot); inp.click(); };
  on("w_pickAll", () => pickFiles(null));
  document.querySelectorAll("[data-wpick]").forEach(b => b.onclick = () => pickFiles(b.dataset.wpick));
  document.querySelectorAll("[data-wrm]").forEach(b => b.onclick = () => { delete NW.stems[b.dataset.wrm]; delete NW.names[b.dataset.wrm]; renderNew(); });
  on("w_rmall", () => { NW.stems = {}; NW.names = {}; renderNew(); });
  on("w_midi", () => { const inp = document.createElement("input"); inp.type = "file"; inp.accept = META.midiExt.join(","); inp.onchange = () => wAddFiles([...inp.files]); inp.click(); });
  on("w_midirm", () => { NW.midi = ""; NW.midiName = ""; renderNew(); });
  // info
  document.querySelectorAll("[data-w]").forEach(el => el.oninput = el.onchange = () => {
    const k = el.dataset.w; NW[k] = el.value;
    if (k === "folder") NW.folderTouched = true;
    if (k === "title" && !NW.folderTouched) { NW.folder = folderFromTitle(NW.title); const fo = $("#w_folder"); if (fo) fo.value = NW.folder; }
    el.classList.remove("invalid");
  });
  const ci = $("#w_countIn"); if (ci) ci.onchange = () => { NW.countIn = ci.checked; };
  document.querySelectorAll("[data-wgo]").forEach(b => b.onclick = () => { NW.step = b.dataset.wgo; renderNew(); });
  on("w_back", () => { NW.step = NW.step === "review" ? "info" : "audio"; renderNew(); });
  on("w_next", () => {
    if (NW.step === "audio") { if (!wReady()) return; NW.step = "info"; return renderNew(); }
    if (NW.step === "info") {
      const year = new Date().getFullYear(), bad = [];
      for (const [k, n] of [["title", "Title"], ["artist", "Artist"], ["album", "Album"], ["genre", "Genre"], ["vocals", "Singer"]]) if (!String(NW[k]).trim()) { bad.push(n); $("#w_" + k).classList.add("invalid"); }
      const y = Number(NW.year); if (!(Number.isInteger(y) && y >= 1900 && y <= year)) { bad.push(`Year (1900–${year})`); $("#w_year").classList.add("invalid"); }
      NW.folder = String(NW.folder).toUpperCase();
      // Easy Edit Mode hides the folder name: an unusable one goes back to the one made from the title
      if (!$("#w_folder") && (!/^Z[A-Z0-9_]{1,30}$/.test(NW.folder) || NW.taken.includes(NW.folder))) { NW.folderTouched = false; NW.folder = folderFromTitle(NW.title); }
      if (!/^Z[A-Z0-9_]{1,30}$/.test(NW.folder)) { bad.push("Folder name (Z + capital letters or digits)"); $("#w_folder").classList.add("invalid"); $(".wizard details").open = true; }
      else if (NW.taken.includes(NW.folder)) { bad.push("Folder name (another song already uses it)"); $("#w_folder").classList.add("invalid"); $(".wizard details").open = true; }
      if (bad.length) { $("#w_missing").textContent = "Still needed: " + bad.join(", "); document.querySelector(".wizard .invalid")?.focus(); return; }
      NW.step = "review"; return renderNew();
    }
  });
  on("w_make", wMake);
  on("w_log", () => { showBuildPanel(true); });
  on("w_another", () => { NW = null; showNew(); });
}
async function wMake() {
  const S = { folder: NW.folder, title: NW.title.trim(), artist: NW.artist.trim(), album: NW.album.trim(), year: Number(NW.year), genre: NW.genre,
    tiers: { drums: 2, guitar: 2, bass: 2, vocals: 2, band: 2 }, vocals: Number(NW.vocals), stems: { ...NW.stems }, stemSource: { type: NW.srcType } };
  if (NW.srcTool.trim()) S.stemSource.tool = NW.srcTool.trim();
  if (NW.midi) S.midi = NW.midi;
  if (NW.countIn) S.countIn = true;
  try { await api("POST", "/api/new", S); } catch (e) { return fail("Couldn't create the song")(e); }
  GUARD = null; NW.step = "making"; NW.stage = 0; NW.started = Date.now(); NW.failed = false;
  const mine = NW;
  window.onBuildLine = l => { if (NW !== mine) return; const i = MAKE_STAGES.findIndex(([m]) => l.includes(m)); if (i > NW.stage) { NW.stage = i; if (/^#\/new/.test(location.hash)) renderNew(); } };
  window.onBuildEnd = code => {
    window.onBuildLine = window.onBuildEnd = null;
    if (NW !== mine) return false;
    if (code === "0") { NW.step = "done"; NW.stage = MAKE_STAGES.length; } else NW.failed = true;
    if (/^#\/new/.test(location.hash)) { renderNew(); return true; }  // handled: stay on the result
    return false;
  };
  renderNew();
  runBuild(S.folder, "audio", { quiet: true });
}

// ---------- file picker ----------
async function pickInto(selector, folder, dirs, accept) {
  const target = $(selector);
  let cur = localStorage.pickDir || "";
  const open = async dir => {
    let r;
    try { r = await api("GET", "/api/ls?dir=" + encodeURIComponent(dir || "")); } catch (e) { fail("Couldn't open that folder")(e); return; }
    localStorage.pickDir = r.dir;
    $("#modalBox").innerHTML = `<b>${dirs ? (accept ? "Pick a folder or a .zip file" : "Pick a folder") : "Pick a file"}</b><div class="mono small dim" style="margin-top:6px">${esc(r.dir)}</div>
      <div class="filelist">${r.parent ? `<div class="d" data-p="${esc(r.parent)}">..</div>` : ""}
      ${r.entries.map(e => `<div class="${e.dir ? "d" : ""}" data-p="${esc(r.dir + "\\" + e.name)}" data-file="${e.dir ? "" : 1}">${e.dir ? "📁 " : ""}${esc(e.name)}</div>`).join("")}</div>
      <div class="actions"><input type="text" id="pickPath" style="flex:1" placeholder="or type a folder path"><button id="pickGo">Go</button>${dirs ? '<button id="pickThis" class="primary">Use this folder</button>' : ""}<button id="pickCancel">Cancel</button></div>`;
    document.querySelectorAll(".filelist div").forEach(d => d.onclick = async () => {
      if (!d.dataset.file) return open(d.dataset.p);
      if (dirs && !(accept && accept.test(d.dataset.p))) return;
      let p = d.dataset.p;
      if (folder) p = (await api("GET", `/api/relpath/${folder}?p=${encodeURIComponent(p)}`)).rel;
      target.value = p; target.dispatchEvent(new Event("change", { bubbles: true })); $("#modal").classList.add("hidden");
    });
    $("#pickGo").onclick = () => open($("#pickPath").value.trim());
    if (dirs) $("#pickThis").onclick = () => { target.value = r.dir; $("#modal").classList.add("hidden"); target.dispatchEvent(new Event("change", { bubbles: true })); };
    $("#pickCancel").onclick = () => $("#modal").classList.add("hidden");
  };
  $("#modal").classList.remove("hidden");
  await open(cur);
}

// ---------- connection: notice when Pocket Encore stops (closed, or restarting for an update) and reload when it is back ----------
let OFFLINE = false;
async function heartbeat() {
  try {
    const r = await fetch("/api/ping", { cache: "no-store", signal: AbortSignal.timeout(2500) });
    if (!r.ok) throw new Error();
    const v = (await r.json()).version || {};
    if (OFFLINE) {
      OFFLINE = false;
      // back: reload for the new version, unless that would lose unsaved changes
      if (!pageGuard()) return location.reload();
      $("#offline").innerHTML = `Pocket Encore is running again (v${esc(v.version)} ${esc(v.stage)}). Save your changes, then <button id="offReload">Reload</button>`;
      $("#offReload").onclick = () => location.reload();
    }
  } catch {
    if (!OFFLINE) {
      OFFLINE = true;
      $("#offline").classList.remove("hidden");
      $("#offline").textContent = UPD_INSTALLING ? `Installing Pocket Encore ${UPD_INSTALLING}… this window reloads when it starts again.` : "Pocket Encore isn't running. Waiting for it to start again…";
    }
  }
  setTimeout(heartbeat, OFFLINE ? 1000 : 3000);
}

// ---------- updates: badge in the header, dialog with the release notes, one-click install ----------
let UPD = null, UPD_INSTALLING = null;
async function checkUpdate(force) {
  try { UPD = await api("GET", "/api/update" + (force ? "?force=1" : "")); } catch (e) { if (force) throw e; return null; }
  const b = $("#updBadge"), show = UPD.available && !UPD.skipped;
  b.classList.toggle("hidden", !show);
  if (show) { b.textContent = `Update available: ${UPD.latest.label}`; b.onclick = () => updateDialog(); }
  return UPD;
}
// release notes (GitHub Markdown) as simple HTML: headings, lists, tables, bold, code; links as plain text
function mdLite(md) {
  const inline = s => esc(s).replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, '<span class="mono">$1</span>').replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  const out = []; let list = false, table = null;
  const flush = () => { if (list) { out.push("</ul>"); list = false; } if (table) { out.push(`<table class="t">${table.join("")}</table>`); table = null; } };
  for (const raw of md.replace(/\r/g, "").split("\n")) {
    const l = raw.trim();
    if (/^\|/.test(l)) {
      if (/^\|[\s|:-]+\|$/.test(l)) continue;
      if (list) { out.push("</ul>"); list = false; }
      const cells = l.replace(/^\||\|$/g, "").split("|").map(c => inline(c.trim()));
      if (!table) table = [`<tr>${cells.map(c => `<th>${c}</th>`).join("")}</tr>`]; else table.push(`<tr>${cells.map(c => `<td>${c}</td>`).join("")}</tr>`);
      continue;
    }
    if (table) { out.push(`<table class="t">${table.join("")}</table>`); table = null; }
    const h = /^(#{1,4})\s+(.*)/.exec(l);
    if (h) { flush(); out.push(`<h4>${inline(h[2])}</h4>`); continue; }
    if (/^[-*]\s+/.test(l)) { if (!list) { out.push("<ul>"); list = true; } out.push(`<li>${inline(l.replace(/^[-*]\s+/, ""))}`); continue; }
    if (!l) { flush(); continue; }
    if (list) out.push(" " + inline(l)); else out.push(`<p>${inline(l)}</p>`);
  }
  flush();
  return out.join("");
}
function updateDialog() {
  const s = UPD, L = s.latest;
  const how = s.mode === "installer" ? "" : s.mode === "git"
    ? `<p class="warnline">This copy runs from its git folder: update it with <span class="mono">git pull</span>.</p>`
    : `<p class="warnline">This copy wasn't installed with the installer: download the new installer from the release page.</p>`;
  $("#modalBox").innerHTML = `<b>Pocket Encore ${esc(L.label)} is available</b>
    <p class="small dim">You have ${esc(s.current)}.${L.published ? ` Released ${esc(new Date(L.published).toLocaleDateString())}.` : ""}</p>${how}
    <div class="relnotes">${mdLite(L.notes)}</div>
    <div id="updProg" class="small" style="margin-top:8px"></div>
    <div class="actions" style="margin-top:12px">
      ${s.mode === "installer" ? `<button class="primary" id="updGo">Download and install</button>` : `<button class="primary" id="updPage">Open the release page</button>`}
      <button id="updLater">Remind me later</button><span class="grow"></span><button id="updSkip">Skip this version</button></div>`;
  $("#modal").classList.remove("hidden");
  const close = () => $("#modal").classList.add("hidden");
  $("#updLater").onclick = close;
  $("#updSkip").onclick = async () => { await api("PUT", "/api/update", { skip: L.tag }).catch(() => { }); close(); checkUpdate(); toast(`Version ${L.label} skipped. Help → Check for updates finds it again.`); };
  if ($("#updPage")) $("#updPage").onclick = () => api("POST", "/api/update/open").catch(fail("Couldn't open the release page"));
  if ($("#updGo")) $("#updGo").onclick = installUpdate;
}
async function installUpdate() {
  if (pageGuard()) { toast("Save or discard your unsaved changes first: Pocket Encore restarts to update.", true); return; }
  const prog = $("#updProg"), go = $("#updGo");
  go.disabled = true; $("#updSkip").disabled = true;
  try { await api("POST", "/api/update/install"); } catch (e) { go.disabled = false; return fail("Couldn't start the update")(e); }
  const mb = n => (n / 1048576).toFixed(1);
  const tick = async () => {
    let j; try { j = await api("GET", "/api/update/progress"); } catch { return; }  // Pocket Encore has quit to install: heartbeat takes over
    if (!j) return;
    if (j.phase === "download") prog.innerHTML = `Downloading… ${mb(j.received)} of ${mb(j.total)} MB <progress max="${j.total}" value="${j.received}"></progress>`;
    else if (j.phase === "verify") prog.textContent = "Checking the download…";
    else if (j.phase === "install") { UPD_INSTALLING = j.version; prog.textContent = `Installing ${j.version}: Pocket Encore restarts and this window reloads by itself.`; $("#updLater").disabled = true; return; }
    else if (j.phase === "error") { prog.innerHTML = `<span class="warnline">The update failed: ${esc(j.error)}</span> <button id="updPage2">Open the release page</button>`; $("#updPage2").onclick = () => api("POST", "/api/update/open"); go.disabled = false; return; }
    setTimeout(tick, 400);
  };
  tick();
}
// Setup and Help: the automatic check and "Check for updates"
function updateStatusText(s) {
  if (!s) return "";
  const when = s.checkedAt ? ` (checked ${new Date(s.checkedAt).toLocaleString()})` : "";
  if (s.error) return `Couldn't reach GitHub: ${esc(s.error)}`;
  if (!s.latest) return `No release found yet${when}.`;
  return s.available ? `Pocket Encore ${esc(s.latest.label)} is available${when}.` : `You have the latest version, ${esc(s.current)}${when}.`;
}
function updatePanel() {
  return `<div class="panel"><h4>Updates</h4>
    <label class="small"><input type="checkbox" id="updAuto" data-noguard="1" ${!UPD || UPD.auto ? "checked" : ""}> Check for updates once a day</label>
    <span class="small dim">(asks GitHub for the latest release; nothing about you is sent)</span>
    <div class="actions" style="margin-top:8px"><button id="updCheck">Check for updates</button><span id="updState" class="small">${updateStatusText(UPD)}</span></div></div>`;
}
function bindUpdatePanel() {
  if (!$("#updCheck")) return;
  if ($("#updAuto")) $("#updAuto").onchange = e => api("PUT", "/api/update", { auto: e.target.checked }).then(s => { UPD = s; toast(e.target.checked ? "Automatic update check on" : "Automatic update check off"); }).catch(fail("Couldn't save the setting"));
  $("#updCheck").onclick = async () => {
    $("#updState").textContent = "Checking…";
    try {
      // an explicit check also brings back a skipped version
      const s = await checkUpdate(true);
      if (s.skipped) { await api("PUT", "/api/update", { skip: null }); await checkUpdate(); }
      $("#updState").innerHTML = updateStatusText(UPD);
      if (UPD.available) updateDialog();
    } catch (e) { $("#updState").textContent = "Couldn't check: " + e.message; }
  };
}

// ---------- builds ----------
let es = null;
// the Build log button in the top bar appears once a build has run in this session (or a stored log was opened)
function showBuildPanel(show = true) { $("#buildPanel").classList.toggle("hidden", !show); if (show) $("#buildToggle").classList.remove("hidden"); }
$("#buildToggle").onclick = () => { showBuildPanel($("#buildPanel").classList.contains("hidden")); followBuild(); };
$("#buildClose").onclick = () => showBuildPanel(false);
async function runBuild(folder, from, opts = {}) {
  const g = pageGuard();
  if (g && g.save) {
    const a = await ask("Build without your unsaved changes?", `Your unsaved changes to ${g.what} won't be in this build.`, [
      { label: "Save and build", value: "save", kind: "primary" },
      { label: "Build without changes", value: "build" },
      { label: "Cancel", value: null }]);
    if (!a || (a === "save" && !(await saveGuard(g)))) return;
  }
  try { await api("POST", `/api/build/${folder}?from=${from}`); } catch (e) { fail("Build couldn't start")(e); if (window.onBuildEnd) window.onBuildEnd("start"); return; }
  if (opts.quiet) $("#buildToggle").classList.remove("hidden"); else showBuildPanel(true);
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
  let kind = "";
  es.addEventListener("start", e => { const d = JSON.parse(e.data); kind = d.from; $("#buildTitle").textContent = d.from === "install" ? `Install to the ${d.folder}` : d.from === "stick" ? `Memory stick: ${d.folder}` : d.from === "pack" ? `Build ${d.folder}` : d.from === "many" ? `Build ${d.folder}` : `Build ${d.folder} (from ${d.from})`; $("#buildState").innerHTML = '<span class="badge warn">running…</span>'; });
  es.addEventListener("line", e => { const l = JSON.parse(e.data); logLine(log, l); if (window.onBuildLine) window.onBuildLine(l); });
  es.addEventListener("end", e => {
    const code = JSON.parse(e.data);
    es.close(); es = null;
    if (code === "none") { $("#buildTitle").textContent = "Build"; $("#buildState").innerHTML = '<span class="dim">nothing built yet in this session (a song\'s "Last log" button shows its log from disk)</span>'; return; }
    $("#buildState").innerHTML = code === "0" ? (kind === "install" || kind === "stick"
      ? '<span class="badge ok">installed</span> <span class="small dim">restart the game to see the changes (on a PSP, end the USB connection first)</span>'
      : kind === "pack"
      ? '<span class="badge ok">done</span> <span class="small dim">pack ready in out\\PACKS: Install on my memory stick, on the Share &amp; Packs page, puts it in the game</span>'
      : '<span class="badge ok">done</span> <span class="small dim">Memory stick (on the song list) shows what to copy, or copies it for you</span>') : `<span class="badge bad">failed (exit ${esc(code)})</span>`;
    log.scrollTop = log.scrollHeight;
    if (window.onBuildEnd && window.onBuildEnd(code, kind)) return;  // a page that follows the build (Make a new song) shows the result itself
    if (code === "0" && !pageGuard()) route();  // refresh the page, unless that would lose unsaved changes
  });
}

(async () => {
  META = await api("GET", "/api/meta");
  $("#setupLink").classList.toggle("warn", !META.setupOk);
  if (META.version) { $("#version").textContent = `v${META.version.version} ${META.version.stage}`.trim(); document.title = `Pocket Encore v${META.version.version} ${META.version.stage}`.trim(); }
  renderModeBadge();
  route();
  heartbeat();
  checkUpdate();  // at most once a day it asks GitHub (when the automatic check is on); otherwise the last answer
})();
