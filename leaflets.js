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

const BATCH_KEY = "devon-leaflets-batches-v1";
let batches = { next: 1, list: [] };   // list: {id, ward, uprns:[ordered], made}
let activeBatch = null;                // batch id being viewed
let startPt = null;                    // [lat,lon] chosen start
let settingStart = false;
let startMarker = null, routeLayer = null;
try { state = JSON.parse(localStorage.getItem(STORE_KEY) || "{}"); } catch (e) { state = {}; }
try { const b = JSON.parse(localStorage.getItem(BATCH_KEY) || "null"); if (b && b.list) batches = b; } catch (e) {}
function save() { try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); localStorage.setItem(BATCH_KEY, JSON.stringify(batches)); } catch (e) {} }
const batchById = (id) => batches.list.find((b) => b.id === id);
const myBatches = () => batches.list.filter((b) => b.ward === wardName);
const allocated = () => { const s = new Set(); batches.list.forEach((b) => b.uprns.forEach((u) => s.add(u))); return s; };

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
  const ab = activeBatch && batchById(activeBatch);
  const inSel = ab ? ab.uprns.includes(+uprn) : (!postcodeSel || pc === postcodeSel);
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
  renderBatchUI();
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
  if (settingStart) { const o = markers[uprn].m.getLatLng(); setStart([o.lat, o.lng]); return; }
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
  $("lf-copy").onclick = () => { $("lf-backup").value = JSON.stringify({ s: state, b: batches }); $("lf-backup").select(); try { navigator.clipboard.writeText($("lf-backup").value); } catch (e) {} };
  $("lf-restore").onclick = () => {
    try { const o = JSON.parse($("lf-backup").value); if (typeof o !== "object") throw 0; if (o.s && o.b) { Object.assign(state, o.s); batches = o.b; } else Object.assign(state, o); save(); restyleAll(); updateStats(); status("Backup restored."); }
    catch (e) { status("That backup text isn't valid."); }
  };
  $("lf-reset").onclick = () => {
    if (!data) return;
    const rows = postcodeSel ? data.pc[postcodeSel] : Object.values(data.pc).flat();
    if (!confirm(`Clear all ticks for ${postcodeSel || "the whole ward"}?`)) return;
    for (const r of rows) delete state[r[0]];
    if (!postcodeSel) batches.list = batches.list.filter((b) => b.ward !== wardName);
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
    initPlanner();
  } catch (e) {
    console.error(e);
    status(`Couldn't load leaflet data (${e.message}).`);
  }
}

/* ---------------- round planner & printable sheets ---------------- */
const KX = 111320, KY = 110574;
let lat0 = 50.7, cosl = 0.63;
function xy(lat, lon) { return [(lon + 3.6) * cosl * KX, (lat - lat0) * KY]; }
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function available() {
  const used = allocated(), out = [];
  for (const pc of Object.keys(data.pc)) for (const [u, la, lo] of data.pc[pc]) {
    if (state[u] || used.has(u)) continue;
    out.push({ u, la, lo, pc, p: xy(la, lo) });
  }
  return out;
}

function defaultStart(av) {
  const cell = 250, bins = new Map();
  for (const a of av) { const k = Math.floor(a.p[0] / cell) + "," + Math.floor(a.p[1] / cell); bins.set(k, (bins.get(k) || []).concat(a)); }
  let best = null;
  for (const v of bins.values()) if (!best || v.length > best.length) best = v;
  const m = best.reduce((s, a) => [s[0] + a.la, s[1] + a.lo], [0, 0]);
  return [m[0] / best.length, m[1] / best.length];
}

function orderRoute(pts, startP) {
  // nearest-neighbour from the point closest to the start, then 2-opt on the open path
  const n = pts.length; const left = pts.slice(); const path = [];
  let cur = left.reduce((b, a) => (dist(a.p, startP) < dist(b.p, startP) ? a : b));
  while (left.length) {
    left.splice(left.indexOf(cur), 1); path.push(cur);
    if (!left.length) break;
    cur = left.reduce((b, a) => (dist(a.p, cur.p) < dist(b.p, cur.p) ? a : b));
  }
  let improved = true, passes = 0;
  while (improved && passes++ < 40) {
    improved = false;
    for (let i = 0; i < n - 1; i++) for (let k = i + 1; k < n; k++) {
      const a = i > 0 ? path[i - 1].p : null, b = path[i].p, c = path[k].p, d = k < n - 1 ? path[k + 1].p : null;
      const before = (a ? dist(a, b) : 0) + (d ? dist(c, d) : 0);
      const after = (a ? dist(a, c) : 0) + (d ? dist(b, d) : 0);
      if (after + 1e-6 < before) { path.splice(i, k - i + 1, ...path.slice(i, k + 1).reverse()); improved = true; }
    }
  }
  return path;
}

function routeKm(b) {
  let t = 0, prev = null;
  for (const u of b.uprns) { const m = markers[u]; if (!m) continue; const ll = m.m.getLatLng(), p = xy(ll.lat, ll.lng); if (prev) t += dist(prev, p); prev = p; }
  return t / 1000;
}

function setStart(ll) {
  startPt = ll; settingStart = false; $("lf-setstart").classList.remove("armed");
  if (startMarker) map.removeLayer(startMarker);
  startMarker = L.marker(ll, { interactive: false, icon: L.divIcon({ className: "", html: "<div style='font-size:28px;line-height:28px;margin:-14px 0 0 -9px'>&#9873;</div>", iconSize: [0, 0] }) }).addTo(map);
  $("lf-plan-note").textContent = "Start set. Choose how many leaflets and tap Make batches.";
}

function makeBatches() {
  const av = available();
  if (!av.length) { $("lf-plan-note").textContent = "No dots left to allocate in this ward."; return; }
  const want = Math.min(+$("lf-count").value, av.length);
  const sp = startPt || defaultStart(av);
  const spP = xy(sp[0], sp[1]);
  av.sort((a, b) => dist(a.p, spP) - dist(b.p, spP));
  const chosen = av.slice(0, want);
  const path = orderRoute(chosen, spP);
  const made = [];
  for (let i = 0; i < path.length; i += 25) {
    const b = { id: batches.next++, ward: wardName, uprns: path.slice(i, i + 25).map((a) => a.u), made: new Date().toISOString() };
    batches.list.push(b); made.push(b);
  }
  save();
  $("lf-plan-note").textContent = `Made ${made.length} batch${made.length > 1 ? "es" : ""} (${path.length} dots)` + (want < +$("lf-count").value ? ` \u2013 only ${want} dots were left.` : ".");
  showBatch(made[0].id);
}

function showBatch(id) {
  activeBatch = id;
  const b = batchById(id);
  postcodeSel = ""; $("lf-postcode").value = "";
  for (const o of Object.values(markers)) { o.m.unbindTooltip(); }
  if (routeLayer) { map.removeLayer(routeLayer); routeLayer = null; }
  restyleAll();
  if (b) {
    const ll = [];
    b.uprns.forEach((u, i) => {
      const o = markers[u]; if (!o) return;
      o.m.bindTooltip(String(i + 1), { permanent: true, direction: "center", className: "lf-num" });
      o.m.bringToFront(); ll.push(o.m.getLatLng());
    });
    routeLayer = L.polyline(ll, { color: "#4da3ff", weight: 3, opacity: 0.8, dashArray: "6 6", interactive: false }).addTo(map);
    map.fitBounds(L.latLngBounds(ll), { padding: [50, 50], maxZoom: 18 });
  }
  renderBatchUI();
}

function renderBatchUI() {
  if (!data) return;
  const mine = myBatches();
  const box = $("lf-batches");
  box.innerHTML = mine.length ? mine.map((b) => {
    const done = b.uprns.filter((u) => state[u]).length;
    return `<button class="b ${b.id === activeBatch ? "on" : ""} ${done === b.uprns.length ? "full" : ""}" data-id="${b.id}">Batch ${b.id} &middot; ${b.uprns.length} dots &middot; ${done}/${b.uprns.length} done${done === b.uprns.length ? " \u2713" : ""}</button>`;
  }).join("") : '<p class="lf-sub">No batches yet. Pick a number above and tap Make batches.</p>';
  box.querySelectorAll("button.b").forEach((bt) => { bt.onclick = () => showBatch(+bt.dataset.id); });
  const ab = activeBatch && batchById(activeBatch);
  $("lf-check").innerHTML = ab ? ab.uprns.map((u, i) => `<button data-u="${u}" class="${state[u] === 1 ? "d" : state[u] === 2 ? "s" : ""}">${i + 1}</button>`).join("") : "";
  $("lf-check").querySelectorAll("button").forEach((bt) => { bt.onclick = () => { const u = +bt.dataset.u, cur = state[u] || 0; setState(u, cur === mode ? 0 : mode); }; });
  const av = available().length;
  $("lf-print-one").disabled = !ab; $("lf-b-done").disabled = !ab; $("lf-b-del").disabled = !ab;
  if (!settingStart && !$("lf-plan-note").textContent.startsWith("Made")) $("lf-plan-note").textContent = `${av} dots available (not delivered or already in a batch).`;
}

function initPlanner() {
  lat0 = Object.values(data.pc)[0][0][1]; cosl = Math.cos(lat0 * Math.PI / 180);
  const sel = $("lf-count");
  sel.innerHTML = Array.from({ length: 20 }, (_, i) => (i + 1) * 25).map((n) => `<option value="${n}" ${n === 125 ? "selected" : ""}>${n} leaflets (${n / 25} batch${n > 25 ? "es" : ""})</option>`).join("");
  $("lf-make").onclick = makeBatches;
  $("lf-setstart").onclick = () => { settingStart = !settingStart; $("lf-setstart").classList.toggle("armed", settingStart); if (settingStart) $("lf-plan-note").textContent = "Tap the map where the round should start (a dot or empty ground)."; };
  map.on("click", (e) => { if (settingStart) setStart([e.latlng.lat, e.latlng.lng]); });
  $("lf-b-done").onclick = () => { const b = batchById(activeBatch); if (b && confirm(`Mark all ${b.uprns.length} dots in batch ${b.id} as delivered?`)) b.uprns.forEach((u) => { if (!state[u]) state[u] = 1; }); save(); restyleAll(); updateStats(); };
  $("lf-b-del").onclick = () => {
    const b = batchById(activeBatch); if (!b || !confirm(`Delete batch ${b.id}? Its dots go back into the pool (ticks are kept).`)) return;
    batches.list = batches.list.filter((x) => x !== b); activeBatch = null;
    for (const o of Object.values(markers)) o.m.unbindTooltip();
    if (routeLayer) { map.removeLayer(routeLayer); routeLayer = null; }
    save(); restyleAll(); updateStats();
  };
  $("lf-print-one").onclick = () => printSheets([activeBatch]);
  $("lf-print-all").onclick = () => {
    const open = myBatches().filter((b) => b.uprns.some((u) => !state[u])).map((b) => b.id);
    if (!open.length) { status("No open batches to print."); return; }
    printSheets(open);
  };
  updateStats();
  const mine = myBatches();
  if (mine.length) showBatch(mine.find((b) => b.uprns.some((u) => !state[u]))?.id || mine[0].id);
}

async function printSheets(ids) {
  const host = $("lf-print"); host.innerHTML = "";
  status("Preparing sheets\u2026 loading map tiles.");
  const waits = [];
  const today = new Date().toLocaleDateString("en-GB");
  ids.forEach((id) => {
    const b = batchById(id); if (!b) return;
    const pts = b.uprns.map((u) => { const m = markers[u]; const ll = m.m.getLatLng(); return { u, ll, pc: m.pc }; });
    const page = document.createElement("div"); page.className = "pp";
    page.innerHTML = `<div class="pp-tag">Batch ${b.id} &middot; ${esc(data.ward)} &middot; ${pts.length} leaflets</div><div class="pp-map"></div>`;
    host.appendChild(page);
    const pm = L.map(page.querySelector(".pp-map"), { zoomControl: false, attributionControl: false, preferCanvas: false, fadeAnimation: false, zoomAnimation: false });
    const tl = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, maxNativeZoom: 19, crossOrigin: true }).addTo(pm);
    waits.push(new Promise((res) => { tl.on("load", res); setTimeout(res, 9000); }));
    pm.fitBounds(L.latLngBounds(pts.map((p) => p.ll)), { padding: [60, 60], maxZoom: 19 });
    // nudge overlapping dots (flats share one point) apart so every number is readable
    const placed = [];
    const px = pts.map((p) => {
      let c = pm.latLngToContainerPoint(p.ll), k = 0;
      const clash = (q) => placed.some((o) => Math.hypot(o.x - q.x, o.y - q.y) < 27);
      const base = c;
      while (clash(c) && k < 60) { k++; const ang = k * 2.4, r = 14 + 4.5 * k; c = L.point(base.x + r * Math.cos(ang), base.y + r * Math.sin(ang)); }
      placed.push(c); return c;
    });
    const lls = px.map((c) => pm.containerPointToLatLng(c));
    L.polyline(lls, { color: "#1f4fd8", weight: 2.5, opacity: 0.8, dashArray: "5 5" }).addTo(pm);
    lls.forEach((ll, i) => L.marker(ll, { icon: L.divIcon({ className: "pp-dot" + (i === 0 ? " first" : i === pts.length - 1 ? " last" : ""), html: `<span>${i + 1}</span>`, iconSize: [26, 26] }) }).addTo(pm));
  });
  await Promise.all(waits);
  await new Promise((r) => setTimeout(r, 400));
  $("lf-status").classList.add("hidden");
  window.print();
}

init();
