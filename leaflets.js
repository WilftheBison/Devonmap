/* Leaflet round: one dot per address point (UPRN) from the ONS UPRN Directory,
   Sep 2026. Tap to tick off as delivered, or mark "not a house". Saved in
   localStorage on this device. */
const STORE_KEY = "devon-leaflets-v1";
const COL = { todo: "#ffd23f", done: "#2ecc71", skip: "#8d99a6" };

const params = new URLSearchParams(location.search);
let wardName = params.get("ward") || "";
let postcodeSel = params.get("pc") || "";

let state = {};            // uprn -> 1 delivered | 2 not a house
let undoStack = [];
let hideDone = false;
let mode = 1;              // 1 deliver, 2 skip
let data = null;           // {ward, pc:{postcode:[[uprn,lat,lon]]}}
let markers = {};          // uprn -> {m, pc}

try { state = JSON.parse(localStorage.getItem(STORE_KEY) || "{}"); } catch (e) { state = {}; }
function save() { try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) {} }

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const norm = (s) => s.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]/g, "");
function status(msg) { const el = $("lf-status"); el.textContent = msg; el.classList.remove("hidden"); }

const map = L.map("lf-map", { preferCanvas: true, maxZoom: 20, tap: true }).setView([50.72, -3.65], 9);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, maxNativeZoom: 19, attribution: "&copy; OpenStreetMap contributors" }).addTo(map);
const canvas = L.canvas({ padding: 0.5, tolerance: 10 });
let group = L.layerGroup().addTo(map);
let outline = null;

function style(uprn, pc) {
  const s = state[uprn];
  const inSel = !postcodeSel || pc === postcodeSel;
  const col = s === 1 ? COL.done : s === 2 ? COL.skip : COL.todo;
  const hidden = hideDone && s;
  return {
    radius: inSel ? 9 : 4, weight: inSel ? 2.5 : 1, color: inSel ? "#ffffff" : "#0d1117",
    fillColor: col, fillOpacity: hidden ? 0 : (inSel ? 0.95 : 0.35),
    opacity: hidden ? 0 : 1,
  };
}

function counts(pcFilter) {
  let total = 0, done = 0, skip = 0;
  for (const [uprn, o] of Object.entries(markers)) {
    if (pcFilter && o.pc !== pcFilter) continue;
    total++;
    const s = state[uprn];
    if (s === 1) done++; else if (s === 2) skip++;
  }
  return { total, done, skip, houses: total - skip, left: total - skip - done };
}

function updateStats() {
  if (!data) return;
  const c = counts(postcodeSel);
  const w = counts("");
  $("lf-left").textContent = c.left.toLocaleString();
  $("lf-left-label").textContent = (postcodeSel ? postcodeSel : "whole ward") + " – leaflets still to deliver";
  $("lf-barfill").style.width = (c.houses ? (100 * c.done / c.houses) : 0) + "%";
  $("lf-detail").textContent = `${c.done} delivered of ${c.houses} houses` + (c.skip ? ` (${c.skip} marked not a house; ${c.total} address points)` : ` (${c.total} address points)`);
  $("lf-ward-detail").textContent = `Ward ${data.ward}: ${w.done} of ${w.houses} delivered, ${w.left} to go.`;
  // postcode dropdown labels
  const sel = $("lf-postcode");
  for (const opt of sel.options) {
    if (!opt.value) { opt.textContent = `All postcodes (${w.houses} houses, ${w.left} left)`; continue; }
    const x = counts(opt.value);
    opt.textContent = `${opt.value} – ${x.houses} houses${x.left === 0 ? " ✓" : ", " + x.left + " left"}`;
  }
}

function restyleAll() {
  for (const [uprn, o] of Object.entries(markers)) o.m.setStyle(style(uprn, o.pc));
}

function setState(uprn, newVal, record = true) {
  const old = state[uprn] || 0;
  if (record) undoStack.push([uprn, old]);
  if (newVal) state[uprn] = newVal; else delete state[uprn];
  const o = markers[uprn];
  if (o) o.m.setStyle(style(uprn, o.pc));
  save(); updateStats();
}

function onTap(uprn, pc) {
  if (postcodeSel && pc !== postcodeSel) { selectPostcode(pc); return; }
  const cur = state[uprn] || 0;
  setState(uprn, cur === mode ? 0 : mode);
}

function selectPostcode(pc, fit = false) {
  postcodeSel = pc;
  $("lf-postcode").value = pc;
  restyleAll(); updateStats();
  history.replaceState(null, "", `leaflets.html?ward=${encodeURIComponent(wardName)}${pc ? "&pc=" + encodeURIComponent(pc) : ""}`);
  if (pc && data.pc[pc]) {
    map.fitBounds(L.latLngBounds(data.pc[pc].map((r) => [r[1], r[2]])), { padding: [40, 40], maxZoom: 19 });
  } else if (outline) {
    map.fitBounds(outline.getBounds(), { padding: [20, 20] });
  }
  for (const o of Object.values(markers)) if (o.pc === pc) o.m.bringToFront();
}

async function init() {
  $("lf-mode-deliver").onclick = () => { mode = 1; $("lf-mode-deliver").classList.add("on"); $("lf-mode-skip").classList.remove("on"); };
  $("lf-mode-skip").onclick = () => { mode = 2; $("lf-mode-skip").classList.add("on"); $("lf-mode-deliver").classList.remove("on"); };
  $("lf-undo").onclick = () => { const last = undoStack.pop(); if (last) setState(last[0], last[1], false); };
  $("lf-hide").onclick = () => { hideDone = !hideDone; $("lf-hide").textContent = hideDone ? "Show delivered" : "Hide delivered"; restyleAll(); };
  $("lf-copy").onclick = () => { $("lf-backup").value = JSON.stringify(state); $("lf-backup").select(); try { navigator.clipboard.writeText($("lf-backup").value); } catch (e) {} };
  $("lf-restore").onclick = () => {
    try { const o = JSON.parse($("lf-backup").value); if (typeof o !== "object") throw 0; Object.assign(state, o); save(); restyleAll(); updateStats(); status("Backup restored."); }
    catch (e) { status("That backup text isn't valid."); }
  };
  $("lf-reset").onclick = () => {
    if (!data) return;
    const rows = postcodeSel ? data.pc[postcodeSel] : Object.values(data.pc).flat();
    if (!confirm(`Clear all ticks for ${postcodeSel || "the whole ward"}?`)) return;
    for (const r of rows) delete state[r[0]];
    save(); restyleAll(); updateStats();
  };

  try {
    const slugs = await (await fetch("data/postcode-cells/slugs.json")).json();
    const names = Object.keys(slugs).sort((a, b) => a.localeCompare(b));
    $("lf-ward").innerHTML = `<option value="">Pick a ward&hellip;</option>` + names.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join("");
    $("lf-ward").onchange = () => { if ($("lf-ward").value) location.href = `leaflets.html?ward=${encodeURIComponent($("lf-ward").value)}`; };
    if (!wardName) { status("Pick a ward above."); return; }
    const key = names.find((k) => norm(k) === norm(wardName));
    if (!key) throw new Error("ward not found");
    wardName = key; $("lf-ward").value = key;

    const [res, cellRes] = await Promise.all([fetch(`data/leaflets/${slugs[key]}.json`), fetch(`data/postcode-cells/${slugs[key]}.geojson`)]);
    if (!res.ok) throw new Error(`leaflet data missing (${res.status})`);
    data = await res.json();
    if (cellRes.ok) {
      const geo = await cellRes.json();
      const f = geo.features.find((x) => x.properties.type === "ward-outline");
      if (f) outline = L.geoJSON(f, { style: { color: "#e63946", weight: 3, fill: false }, interactive: false }).addTo(map);
    }

    const pcs = Object.keys(data.pc).sort();
    $("lf-postcode").innerHTML = `<option value="">All postcodes</option>` + pcs.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join("");
    $("lf-postcode").onchange = () => selectPostcode($("lf-postcode").value, true);

    for (const pc of pcs) {
      for (const [uprn, lat, lon] of data.pc[pc]) {
        const m = L.circleMarker([lat, lon], { renderer: canvas, ...style(uprn, pc) });
        m.on("click", () => onTap(uprn, pc));
        m.addTo(group);
        markers[uprn] = { m, pc };
      }
    }
    if (postcodeSel && !data.pc[postcodeSel]) postcodeSel = "";
    selectPostcode(postcodeSel);
  } catch (e) {
    console.error(e);
    status(`Couldn't load leaflet data (${e.message}).`);
  }
}
init();
