/* Devon Boundaries map app.
   County is always shown. A mode switch picks which "mid tier" and "wards"
   layer pair is active - District Councils + district wards, or Parliamentary
   Constituencies + constituency wards - so the two systems never clutter the
   map at once. An optional CSV can be pinned onto whichever wards layer is
   currently showing: joined by name, shown in popups, and optionally used
   to colour the map (a simple choropleth). Pinned data is kept in
   localStorage so it survives a reload, entirely client-side - nothing is
   sent anywhere. */

const STORAGE_KEY = "devon-map-pinned-data-v1";

const COLORS = {
  county: "#e63946",
  mid: "#2a9d54",
  ward: "#3a6fd8",
};

const MODES = {
  district: {
    label: "District Councils",
    midLabel: "Districts",
    midParentLabel: "District",
    wardLabel: "Wards",
    midFile: "data/districts.geojson",
    wardFile: "data/wards.geojson",
    wardParentProp: "district",
    bundledCsv: "data/ward-census-data.csv",
  },
  constituency: {
    label: "Parliamentary Constituencies",
    midLabel: "Constituencies",
    midParentLabel: "Constituency",
    wardLabel: "Wards",
    midFile: "data/constituencies.geojson",
    wardFile: "data/constituency-wards.geojson",
    wardParentProp: "constituency",
    bundledCsv: null,
  },
};

let currentMode = "district";
let topTenData = null; // normalizedName -> {ward, rm, ab, a50, residents, seats, rps, share:[], seat:[], both:[{constituency, crank, share, seat}]}
/* Special "Colour wards by" choices built from data/top-wards.json:
   Wards in the top ten on BOTH measures (working-class share, cheapest seat) are ranked within their
   constituency by the sum of their two ranks (crank); "top five" and "top one" pick crank <= 5 / == 1. */
const TOP_OPTIONS = {
  "__top5_both__": { label: "Top five wards per constituency (both measures)" },
  "__top1_both__": { label: "Top ward in each constituency (both measures)" },
};
/* 2011 Rural-Urban Classification, blended into wards via postcode sectors (data/ruc11-wards.json) */
let rucData = null; // normalizedName -> {n, mix:{classCode: % of addresses}}
let rucClasses = {};
const RUC_COLOURS = { A1: "#08306b", B1: "#2171b5", C1: "#6baed6", C2: "#9ecae1", D1: "#fdae61", D2: "#f46d43", E1: "#a6d96a", E2: "#66bd63", F1: "#1a9850", F2: "#006837" };
const RUC_OPTIONS = {
  "__ruc_class__": { label: "Rural-urban class (2011)" },
  "__ruc_rural__": { label: "% rural (2011 classification)" },
};
const rucOn = () => !!RUC_OPTIONS[activeColourColumn];
const rucRec = (name) => rucData && rucData[normalizeName(name)];
const rucDominant = (rec) => rec ? Object.entries(rec.mix).sort((a, b) => b[1] - a[1])[0][0] : null;
const rucRural = (rec) => rec ? Object.entries(rec.mix).filter(([k]) => !"ABC".includes(k[0])).reduce((t, [, v]) => t + v, 0) : null;
async function loadRuc() {
  try {
    const res = await fetch("data/ruc11-wards.json");
    if (res.ok) {
      const j = await res.json();
      rucClasses = j.classes; rucData = {};
      for (const [w, r] of Object.entries(j.wards)) rucData[normalizeName(w)] = r;
    }
  } catch (e) { /* optional */ }
}
const rucMixHtml = (rec) => Object.entries(rec.mix).filter(([, v]) => v >= 0.5)
  .map(([k, v]) => `${escapeHtml(rucClasses[k] || k)}: ${Math.round(v)}%`).join("<br>");
/* ---------- politics: election results and council control (data/elections.json) ---------- */
let E = null;          // elections.json
let censusCounts = null; // ward code -> exact 2021 Census counts (for constituency totals)
let households = null;   // ward code -> households (2021 Census)
const POLITICS = "__politics__";
const politicsOn = () => activeColourColumn === POLITICS;
async function loadElections() {
  try {
    const [e, c, h] = await Promise.all([
      fetch("data/elections.json").then((r) => (r.ok ? r.json() : null)),
      fetch("data/ward-census-2021-detail.json").then((r) => (r.ok ? r.json() : null)),
      fetch("data/ward-households.json").then((r) => (r.ok ? r.json() : null)),
    ]);
    E = e; censusCounts = c; households = h ? h.households : null;
  } catch (err) { /* optional */ }
}
const elecKey = (name) => normalizeName(name).replace(/&/g, "and").replace(/[.’]/g, "").replace(/\s+/g, " ");
const elecWard = (name) => E && E.wards[elecKey(name)];
const partyName = (p) => (E && E.parties[p] ? E.parties[p][0] : p);
const partyColour = (p) => (E && E.parties[p] ? E.parties[p][1] : "#bbbbbb");
const partyDot = (p) => `<span class="party-dot" style="background:${partyColour(p)}"></span>`;
const fmtN = (v) => (v === null || v === undefined ? "" : Number(v).toLocaleString());

/** A results table: candidate, party, votes, %. `compact` drops the party name column (dot only). */
function resultTable(res, compact) {
  if (!res) return "";
  const multi = res.seats > 1;
  const rows = res.cands.map((c) => `<tr class="${c.e ? "won" : ""}">
      <td>${partyDot(c.p)}${escapeHtml(c.n)}${c.e ? ' <span class="won-mark" title="Elected">&#10003;</span>' : ""}${compact ? `<span class="cand-party">${escapeHtml(partyName(c.p))}</span>` : ""}</td>
      ${compact ? "" : `<td>${escapeHtml(partyName(c.p))}</td>`}
      <td class="num">${res.unopposed ? "" : fmtN(c.v)}</td>
      <td class="num">${c.pc === null || c.pc === undefined ? "" : c.pc.toFixed(1) + "%"}</td></tr>`).join("");
  const head = `<tr><th>Candidate</th>${compact ? "" : "<th>Party</th>"}<th class="num">Votes</th><th class="num">%</th></tr>`;
  const foot = res.unopposed ? `<div class="elec-foot">Elected unopposed.</div>`
    : `<div class="elec-foot">${res.turnout ? `Turnout ${res.turnout}%` : ""}${multi ? `${res.turnout ? " · " : ""}${res.seats} seats: % is the share of ballot papers, so shares add up to more than 100` : ""}</div>`;
  return `<table class="elec-table">${head}${rows}</table>${foot}${res.note ? `<div class="elec-foot">${escapeHtml(res.note)}</div>` : ""}`;
}
function heldText(w) {
  return Object.entries(w.held).sort((a, b) => b[1] - a[1]).map(([p, n]) => `${partyDot(p)}${escapeHtml(partyName(p))} ${n}`).join(" &nbsp;");
}

/** Exact census totals for a set of wards (same measures as tools/build_census_layers.py). */
function censusTotals(codes) {
  if (!censusCounts) return null;
  const s = (d, ks) => ks.reduce((t, k) => t + (d[String(k)] || 0), 0);
  let res = 0, a50 = 0, ns = 0, ab = 0, rm = 0, hh = 0;
  for (const code of codes) {
    const c = censusCounts[code]; if (!c) continue;
    res += s(c.resident_age_4a, [1, 2, 3, 4]); a50 += s(c.resident_age_4b, [3, 4]);
    ns += s(c.ns_sec_10a, [1, 2, 3, 4, 5, 6, 7, 8, 9]); ab += s(c.ns_sec_10a, [1, 2]); rm += s(c.ns_sec_10a, [6, 7]);
    hh += Object.values(c.hh_tenure_5a).reduce((t, v) => t + v, 0);
  }
  const p = (a, b) => (b ? Math.round((1000 * a) / b) / 10 : null);
  return { residents: res, households: hh, a50: p(a50, res), ab: p(ab, ns), rm: p(rm, ns) };
}

/** Constituency popup: the ward-popup information classes, totalled over the constituency's Devon wards. */
function constituencyPopup(feature) {
  const name = feature.properties.name;
  const c = E && E.constituencies[name];
  const wardRecs = Object.values(E ? E.wards : {}).filter((w) => w.constituency === name);
  const tops = wardRecs.map((w) => topTenData && topTenData[normalizeName(w.name)]).filter(Boolean);
  const codes = wardRecs.map((w) => w.code);
  const ct = censusTotals(codes);
  // rural-urban mix weighted by number of addresses
  const mix = {}; let nAddr = 0;
  for (const w of wardRecs) { const r = rucRec(w.name); if (!r) continue; nAddr += r.n; for (const [k, v] of Object.entries(r.mix)) mix[k] = (mix[k] || 0) + (v * r.n) / 100; }
  const mixRec = nAddr ? { mix: Object.fromEntries(Object.entries(mix).map(([k, v]) => [k, (100 * v) / nAddr]).sort((a, b) => b[1] - a[1])) } : null;
  const dists = [...new Set(wardRecs.map((w) => w.district))].sort();
  const seats = wardRecs.reduce((t, w) => t + (w.seats || 0), 0);
  const best = tops.flatMap((t) => t.both.filter((b) => b.constituency === name && b.crank <= 5).map((b) => ({ ward: t.ward, ...b })))
    .sort((a, b) => a.crank - b.crank);
  let rows = `<tr><td>Constituency</td><td>${escapeHtml(name)}</td></tr>`;
  if (c) rows += `<tr><td>MP</td><td>${partyDot(c.party)}${escapeHtml(c.mp)} (${escapeHtml(partyName(c.party))}), majority ${fmtN(c.majority)}</td></tr>`;
  rows += `<tr><td>Council areas</td><td>${dists.map(escapeHtml).join(", ")}</td></tr>`;
  if (c) rows += `<tr><td colspan="2" class="elec-cell"><div class="elec-head">General election, ${c.last.date}</div>${resultTable(c.last, true)}</td></tr>`;
  if (best.length) rows += `<tr><td>Top wards (both measures)</td><td>${best.map((b) => `#${b.crank} ${escapeHtml(b.ward)}`).join("<br>")}</td></tr>`;
  if (ct) rows += `<tr><td>% routine/manual</td><td>${fmtPct(ct.rm)}</td></tr>
     <tr><td>% AB-equivalent</td><td>${fmtPct(ct.ab)}</td></tr>
     <tr><td>% aged 50+</td><td>${fmtPct(ct.a50)}</td></tr>
     <tr><td>Residents</td><td>${fmtN(ct.residents)}</td></tr>
     <tr><td>Households</td><td>${fmtN(ct.households)}</td></tr>`;
  if (mixRec) rows += `<tr><td>Rural-urban (2011)</td><td>${rucMixHtml(mixRec)}</td></tr>`;
  rows += `<tr><td>Wards / councillors</td><td>${wardRecs.length} wards, ${seats} district councillors</td></tr>`;
  const somerset = name === "Tiverton and Minehead" ? " The Somerset part of the seat (Minehead and around) is not included." : "";
  return `<p class="popup-title">${escapeHtml(name)}</p><table class="popup-table">${rows}</table>
    <p class="popup-note">Census figures, households and councillors are totals for the Devon wards whose centre lies in this constituency (2021 Census).${somerset}</p>
    <button class="text-button" onclick="openConstituencyDetail('${name.replace(/'/g, "\\'")}')">View full constituency page &rarr;</button>`;
}

/** District popup: council control. */
function districtPopup(feature) {
  const name = feature.properties.name;
  const k = E && E.councils[name];
  if (!k) return midPopup(feature);
  const seats = Object.entries(k.seats).sort((a, b) => b[1] - a[1])
    .map(([p, n]) => `<tr><td>${p === "Vacant" ? "Vacant" : partyDot(p) + escapeHtml(partyName(p))}</td><td class="num">${n}</td></tr>`).join("");
  const ctl = k.control === "NOC" ? "No overall control" : `${escapeHtml(partyName(k.control))} majority`;
  return `<p class="popup-title">${escapeHtml(name)} council</p>
    <p style="margin:0 0 6px;">${partyDot(k.control)}<b>${ctl}</b><br><span class="dim">Leader: ${escapeHtml(k.leader)}</span></p>
    <table class="elec-table">${seats}<tr><td><b>Total</b></td><td class="num"><b>${k.total}</b></td></tr></table>
    <div class="elec-foot">Seats as of ${escapeHtml(k.asOf)}, including by-elections and changes of party.</div>`;
}

const topFiveOn = () => !!TOP_OPTIONS[activeColourColumn];
function qualifies(rec, opt) {
  if (!rec) return false;
  if (opt === "__top5_both__") return rec.both.some((b) => b.crank <= 5);
  if (opt === "__top1_both__") return rec.both.some((b) => b.crank === 1);
  return false;
}
const topCount = (opt) => Object.values(topTenData || {}).filter((r) => qualifies(r, opt)).length;
const fmtPct = (v) => (v === null || v === undefined ? "n/a" : v + "%");
const rankList = (list) => list.map((r) => `#${r.rank} ${escapeHtml(r.constituency)}`).join(" &middot; ");

function wardLabelHtml(name, rec) {
  const limit = activeColourColumn === "__top1_both__" ? 1 : 5;
  const best = rec.both.filter((b) => b.crank <= limit).sort((x, y) => x.crank - y.crank)[0];
  return `<b>${escapeHtml(name)}</b><span class="tt-stats"><br>#${best.crank} in ${escapeHtml(best.constituency)}` +
    `<br>Class #${best.share} &middot; Seat #${best.seat} &middot; ${Number(rec.rps).toLocaleString()}/seat` +
    `<br>R/M ${fmtPct(rec.rm)} &middot; AB ${fmtPct(rec.ab)} &middot; 50+ ${fmtPct(rec.a50)}</span>`;
}

/** (Re)build each ward's permanent label: plain name normally, name + figures for wards the chosen option highlights. */
function bindWardLabel(layer) {
  const name = layer.feature.properties.name;
  const rec = topTenData && topTenData[normalizeName(name)];
  layer.unbindTooltip();
  if (topFiveOn() && qualifies(rec, activeColourColumn)) {
    layer.bindTooltip(wardLabelHtml(name, rec), { permanent: true, direction: "center", className: "ward-label topten-label" });
  } else {
    layer.bindTooltip(name, { permanent: true, direction: "center", className: "ward-label" });
  }
}
function refreshWardLabels() {
  if (wardLayer) wardLayer.eachLayer(bindWardLabel);
}
async function loadTopTen() {
  try {
    const res = await fetch("data/top-wards.json");
    if (res.ok) topTenData = await res.json();
  } catch (e) { /* optional */ }
}

const map = L.map("map", {
  zoomControl: true,
}).setView([50.78, -3.75], 10);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors",
}).addTo(map);

/* ---------- state ---------- */

let pinnedData = null;      // { normalizedName: { colName: value, ... } }
let pinnedColumns = [];     // column names, excluding the name column
let numericColumns = [];    // subset of pinnedColumns that look numeric
let activeColourColumn = null;

let countyLayer = null;

const WEIGHTS = {
  county: 4.5,
  mid: 3,
  ward: 1.4,
};

/** Keep draw order ward -> mid -> county, so outer boundaries always
    render on top of (and frame) the ward lines beneath them, rather than
    being hidden wherever the two coincide. */
function updateLayerOrder() {
  if (midLayer && map.hasLayer(midLayer)) midLayer.bringToFront();
  if (countyLayer && map.hasLayer(countyLayer)) countyLayer.bringToFront();
}

/** Ward labels only show once zoomed in enough that 168 of them wouldn't
    just overlap into noise; county/mid labels (1 and up to 10) always show. */
const WARD_LABEL_MIN_ZOOM = 11;
function updateWardLabelVisibility() {
  const show = map.getZoom() >= WARD_LABEL_MIN_ZOOM;
  document.getElementById("map").classList.toggle("show-ward-labels", show);
}
const TOPTEN_STATS_MIN_ZOOM = 13;
function updateTopTenStatsVisibility() {
  document.getElementById("map").classList.toggle("show-topten-stats", map.getZoom() >= TOPTEN_STATS_MIN_ZOOM);
}
map.on("zoomend", updateWardLabelVisibility);
map.on("zoomend", updateTopTenStatsVisibility);
let midLayer = null;        // currently-shown "districts" or "constituencies" layer
let wardLayer = null;       // currently-shown wards layer, whichever system

// cached, parsed data per mode so switching modes doesn't re-fetch
const cache = { district: {}, constituency: {} };

/* ---------- helpers ---------- */

function normalizeName(s) {
  return (s || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function isNumeric(v) {
  if (v === null || v === undefined || v === "") return false;
  return !isNaN(parseFloat(v)) && isFinite(v);
}

const FRIENDLY_LABELS = {
  total_residents: "Total residents",
  pct_aged_50_plus: "% aged 50+",
  pct_AB_equivalent: "% AB-equivalent",
  pct_routine_manual: "% routine/manual",
  notes: "Notes",
};

function friendlyLabel(col) {
  return FRIENDLY_LABELS[col] || col;
}

/* ---------- popups ---------- */

function countyPopup(feature) {
  return `<p class="popup-title">${escapeHtml(feature.properties.name)}</p>
          <p style="margin:0;color:var(--text-dim);font-size:12px;">County</p>`;
}

function midPopup(feature) {
  return `<p class="popup-title">${escapeHtml(feature.properties.name)}</p>
          <p style="margin:0;color:var(--text-dim);font-size:12px;">${MODES[currentMode].midParentLabel}</p>`;
}

function wardPopup(feature) {
  const name = feature.properties.name;
  const parentLabel = MODES[currentMode].midParentLabel;
  const parentValue = feature.properties[MODES[currentMode].wardParentProp];
  let rows = `<tr><td>Ward</td><td>${escapeHtml(name)}</td></tr>
              <tr><td>${escapeHtml(parentLabel)}</td><td>${escapeHtml(parentValue)}</td></tr>`;

  const ew = elecWard(name);
  if (ew) {
    rows += `<tr><td>Held by</td><td>${heldText(ew)}</td></tr>
             <tr><td colspan="2" class="elec-cell"><div class="elec-head">Last election, ${escapeHtml(ew.last.date)}</div>${resultTable(ew.last, true)}</td></tr>`;
  }
  const tt = topTenData && topTenData[normalizeName(name)];
  if (tt) {
    rows += `<tr><td>Working-class share</td><td>${rankList(tt.share)}</td></tr>
             <tr><td>Cheapest seat</td><td>${rankList(tt.seat)}</td></tr>`
          + (tt.both.length ? `<tr><td>Both measures</td><td>${tt.both.map((b) => `#${b.crank} in ${escapeHtml(b.constituency)} (class #${b.share}, seat #${b.seat})`).join("<br>")}</td></tr>` : "")
          + `<tr><td>% routine/manual</td><td>${fmtPct(tt.rm)}</td></tr>
             <tr><td>% AB-equivalent</td><td>${fmtPct(tt.ab)}</td></tr>
             <tr><td>% aged 50+</td><td>${fmtPct(tt.a50)}</td></tr>
             <tr><td>Residents</td><td>${Number(tt.residents).toLocaleString()}</td></tr>
             <tr><td>Councillors</td><td>${tt.seats}</td></tr>
             <tr><td>Residents per seat</td><td>${Number(tt.rps).toLocaleString()}</td></tr>`;
  }

  if (pinnedData) {
    const rec = pinnedData[normalizeName(name)];
    if (rec) {
      for (const col of pinnedColumns) {
        if (tt && FRIENDLY_LABELS[col] && col !== "notes") continue; // census figures already shown above
        if (rec[col] !== undefined && rec[col] !== "") {
          rows += `<tr><td>${escapeHtml(friendlyLabel(col))}</td><td>${escapeHtml(rec[col])}</td></tr>`;
        }
      }
    }
  }
  return `<table class="popup-table">${rows}</table>
          <div style="display:flex;gap:12px;margin-top:8px;">
            <button class="text-button" onclick="openWardDetail('${name.replace(/'/g, "\\'")}')">View full ward page &rarr;</button>
            <button class="text-button" onclick="openPostcodeMap('${name.replace(/'/g, "\\'")}')">Postcode map &#8599;</button>
          </div>`;
}

function openPostcodeMap(name) {
  window.open(`ward-postcodes.html?ward=${encodeURIComponent(name)}`, "_blank");
}
window.openPostcodeMap = openPostcodeMap;

/* ---------- layer loading ---------- */

async function loadLayer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

/** Fetch and cache a mode's mid + ward geojson. Returns true if both loaded. */
async function ensureModeLoaded(mode) {
  const c = cache[mode];
  if (c.loaded) return c.available;
  const cfg = MODES[mode];
  try {
    const [midGeo, wardGeo] = await Promise.all([
      loadLayer(cfg.midFile),
      loadLayer(cfg.wardFile),
    ]);
    c.midGeo = midGeo;
    c.wardGeo = wardGeo;
    c.available = true;
  } catch (e) {
    c.available = false;
  }
  c.loaded = true;
  return c.available;
}

/** District outlines (council control when Politics is on); constituencies are filled so a touch
    anywhere inside opens the constituency box, and coloured by the 2024 winner when Politics is on. */
function midStyle(feature) {
  const name = feature.properties.name;
  if (currentMode === "constituency") {
    const c = E && E.constituencies[name];
    if (politicsOn() && c) return { color: "#1b1f24", weight: 2.5, fill: true, fillColor: partyColour(c.party), fillOpacity: 0.55 };
    return { color: COLORS.mid, weight: WEIGHTS.mid, fill: true, fillColor: "#000", fillOpacity: 0 };
  }
  const k = E && E.councils[name];
  if (politicsOn() && k) {
    return k.control === "NOC"
      ? { color: "#111418", weight: 5, dashArray: "10 7", fill: false }
      : { color: partyColour(k.control), weight: 6, dashArray: null, fill: false };
  }
  return { color: COLORS.mid, weight: WEIGHTS.mid, dashArray: null, fill: false };
}

function buildMidLayer(mode) {
  const geo = cache[mode].midGeo;
  return L.geoJSON(geo, {
    style: midStyle,
    onEachFeature: (feature, layer) => {
      if (mode === "constituency") layer.bindPopup(() => constituencyPopup(feature), { maxWidth: 380, maxHeight: 460 });
      else layer.bindPopup(() => districtPopup(feature), { maxWidth: 320 });
      layer.bindTooltip(feature.properties.name, {
        permanent: true, direction: "center", className: "mid-label",
      });
    },
  });
}

function buildWardLayer(mode) {
  const geo = cache[mode].wardGeo;
  // ward boxes only in District Council mode; in constituency mode a touch goes to the constituency
  return L.geoJSON(geo, {
    style: wardStyle,
    interactive: mode === "district",
    onEachFeature: (feature, layer) => {
      layer.feature = feature;
      if (mode === "district") layer.bindPopup(() => wardPopup(feature), { maxWidth: 380, maxHeight: 460 });
      bindWardLabel(layer);
    },
  });
}

async function switchMode(mode) {
  if (mode === currentMode && midLayer) return;

  const hintEl = document.getElementById("mode-hint");
  hintEl.textContent = "Loading\u2026";

  const available = await ensureModeLoaded(mode);
  if (!available) {
    hintEl.textContent =
      `${MODES[mode].label} boundary data hasn't been loaded into this map yet.`;
    return;
  }
  hintEl.textContent = "";

  currentMode = mode;

  document.querySelectorAll(".mode-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.mode === mode)
  );
  document.getElementById("label-mid").textContent = MODES[mode].midLabel;
  document.getElementById("label-wards").textContent = MODES[mode].wardLabel;

  const midWasOn = midLayer ? map.hasLayer(midLayer) : true;
  const wardWasOn = wardLayer ? map.hasLayer(wardLayer) : false;

  if (midLayer) map.removeLayer(midLayer);
  if (wardLayer) map.removeLayer(wardLayer);

  midLayer = buildMidLayer(mode);
  wardLayer = buildWardLayer(mode);
  const wardOn = wardWasOn || (politicsOn() && mode === "district");   // party colours by ward need the wards layer
  if (midWasOn) midLayer.addTo(map);
  if (wardOn) wardLayer.addTo(map);

  document.getElementById("toggle-mid").checked = midWasOn;
  document.getElementById("toggle-wards").checked = wardOn;
  document.getElementById("ward-count").textContent =
    `${cache[mode].wardGeo.features.length}`;

  updateTopTenStatsVisibility();

  // re-apply/refresh whatever's pinned against the new ward layer
  wardLayer.setStyle(wardStyle);
  updateLegend();
  updateLayerOrder();
  updateWardLabelVisibility();
  populateWardPicker();
}

document.querySelectorAll(".mode-btn").forEach((btn) => {
  btn.addEventListener("click", () => switchMode(btn.dataset.mode));
});

/* ---------- ward detail page ---------- */

// Keyed by normalized ward name -> array of postcode strings. Ward
// geometry (and so ward names) are shared between District and
// Constituency mode, so one file covers both. Null until that data
// exists - see README for the expected shape.
let postcodeData = null;

async function loadPostcodeData() {
  try {
    const res = await fetch("data/postcodes-by-ward.json");
    if (!res.ok) return;
    postcodeData = await res.json();
  } catch (e) {
    // not bundled yet - the ward detail page explains this in place
  }
}

function populateWardPicker() {
  const select = document.getElementById("ward-picker-select");
  const names = (wardLayer ? wardLayer.toGeoJSON().features : [])
    .map((f) => f.properties.name)
    .sort((a, b) => a.localeCompare(b));
  select.innerHTML = names.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join("");
}

function findWardFeature(name) {
  if (!wardLayer) return null;
  const key = normalizeName(name);
  return wardLayer.toGeoJSON().features.find((f) => normalizeName(f.properties.name) === key) || null;
}

function electionSection(title, res, wardLabel) {
  return `<div class="elec-block"><h3>${escapeHtml(title)}${res && res.date ? `, ${escapeHtml(res.date)}` : ""}${wardLabel ? ` <span class="dim">(2019 ward: ${escapeHtml(wardLabel)})</span>` : ""}</h3>${resultTable(res, false)}</div>`;
}

/** Plain-text list of the ward's figures, for the line under the ward's name. */
function wardSummaryText(wname, ew) {
  const parts = [];
  const rec = pinnedData && pinnedData[normalizeName(wname)];
  const tt = topTenData && topTenData[normalizeName(wname)];
  const code = (ew && ew.code) || (tt && tt.code);
  const has = (c) => rec && rec[c] !== undefined && rec[c] !== "";
  if (has("total_residents")) parts.push(`${fmtN(rec.total_residents)} residents (2021)`);
  if (households && code && households[code]) parts.push(`${fmtN(households[code])} households`);
  if (has("pct_aged_50_plus")) parts.push(`${rec.pct_aged_50_plus}% aged 50+`);
  if (has("pct_AB_equivalent")) parts.push(`${rec.pct_AB_equivalent}% AB-equivalent`);
  if (has("pct_routine_manual")) parts.push(`${rec.pct_routine_manual}% routine/manual`);
  if (rec) for (const col of pinnedColumns) {
    if (["ward", "district", "total_residents", "pct_aged_50_plus", "pct_AB_equivalent", "pct_routine_manual"].includes(col) || !has(col)) continue;
    parts.push(`${friendlyLabel(col)}: ${rec[col]}`);
  }
  if (tt) {
    parts.push(`${tt.seats} councillor${tt.seats == 1 ? "" : "s"} (${fmtN(tt.rps)} residents per seat)`);
    const rl = (l) => l.map((r) => `#${r.rank} in ${r.constituency}`).join(" and ");
    if (tt.share.length) parts.push(`working-class share ${rl(tt.share)}`);
    if (tt.seat.length) parts.push(`cheapest seat ${rl(tt.seat)}`);
  }
  const rr = rucRec(wname);
  if (rr) parts.push("rural-urban (2011): " + Object.entries(rr.mix).filter(([, v]) => v >= 0.5)
    .map(([k, v]) => `${rucClasses[k] || k} ${Math.round(v)}%`).join(" / "));
  return parts.join(", ");
}

function wdElectionBlock(res, wardLabel) {
  return `<div class="elec-block"><h3>${res && res.date ? escapeHtml(res.date) : ""}${wardLabel ? ` <span class="dim">(2019 ward: ${escapeHtml(wardLabel)})</span>` : ""}</h3>${resultTable(res, false)}</div>`;
}

function openWardDetail(name) {
  const feature = findWardFeature(name);
  if (!feature) return;
  const wname = feature.properties.name;
  const ew = elecWard(wname);
  const box = document.getElementById("ward-detail");
  box.classList.add("sheet");

  document.getElementById("ward-detail-name").textContent = wname;
  const parent = ew ? `District: ${ew.district} · Constituency: ${ew.constituency}`
    : `${MODES[currentMode].midParentLabel}: ${feature.properties[MODES[currentMode].wardParentProp]}`;
  document.getElementById("ward-detail-parent").innerHTML = escapeHtml(parent) +
    ` &nbsp;<button class="text-button" onclick="openPostcodeMap('${wname.replace(/'/g, "\\'")}')">Postcode map &#8599;</button>`;
  document.getElementById("ward-detail-summary").textContent = wardSummaryText(wname, ew);

  const last = document.getElementById("wd-last-body"), prev = document.getElementById("wd-prev-body");
  if (ew) {
    last.innerHTML = `<p class="wd-held">Councillors as elected: ${heldText(ew)}${ew.heldNote ? ` &middot; ${escapeHtml(ew.heldNote)}` : ""}</p>` + wdElectionBlock(ew.last);
    let h = ew.prevNote ? `<p class="dim wd-note">${escapeHtml(ew.prevNote)}</p>` : "";
    h += ew.prev.map((p) => wdElectionBlock(p, p.ward)).join("");
    if (!ew.prev.length && !ew.prevNote) h += `<p class="dim wd-note">No previous result on these boundaries.</p>`;
    prev.innerHTML = h;
  } else {
    last.innerHTML = `<p class="dim wd-note">No election results loaded for this ward.</p>`;
    prev.innerHTML = "";
  }
  wdSetPrintDate();
  box.classList.remove("hidden");
  wdPlaceSheet();
  showWardMap(feature);
  wdFitText();
  fitWardMap();
}
window.openWardDetail = openWardDetail;

/* ---------- map of the ward on the full ward page ----------
   Plain base map, no colour overlay: the ward's boundary in red, zoomed to fit,
   with the neighbouring wards' boundaries in grey for context. */
let wdMap = null, wdLayer = null, wdBounds = null;
function showWardMap(feature) {
  if (!wdMap) {
    wdMap = L.map("ward-detail-map", {
      preferCanvas: true, zoomSnap: 0.25, zoomDelta: 0.5, scrollWheelZoom: false,
      tap: false, attributionControl: false,
    });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, crossOrigin: true }).addTo(wdMap);
  }
  if (wdLayer) wdMap.removeLayer(wdLayer);
  const key = normalizeName(feature.properties.name);
  const all = cache.district.wardGeo ? cache.district.wardGeo.features : [feature];
  const target = L.geoJSON(feature);
  wdBounds = target.getBounds();
  const near = wdBounds.pad(0.6);
  const others = all.filter((f) => normalizeName(f.properties.name) !== key && near.intersects(L.geoJSON(f).getBounds()));
  wdLayer = L.layerGroup([
    L.geoJSON({ type: "FeatureCollection", features: others }, { interactive: false, style: { color: "#555", weight: 1.5, dashArray: "5 4", fill: false } }),
    L.geoJSON(feature, { interactive: false, style: { color: "#d00000", weight: 4, opacity: 0.9, fill: false } }),
  ]).addTo(wdMap);
  fitWardMap();
}
function fitWardMap() {
  if (!wdMap || !wdBounds) return;
  wdMap.invalidateSize(false);
  wdMap.fitBounds(wdBounds, { padding: [24, 24], animate: false });
}

/* ---------- A4 print of the full ward page ----------
   The page is already an A4 landscape sheet; printing shows it at full size. Computers use the
   browser's print. On the iPad the home-screen app can't print, so the sheet is made into a PDF
   and handed to the share sheet (Print, or Save to Files). */
function wdIsIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}
function wdLoadScript(src) {
  return new Promise((res, rej) => {
    if (document.querySelector(`script[src="${src}"]`)) return res();
    const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = () => rej(new Error("load " + src));
    document.head.appendChild(s);
  });
}
function wdSetPrintDate() {
  document.getElementById("ward-detail-print-date").textContent =
    `Printed ${new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })} · Devon map, wilfthebison.github.io/Devonmap`;
}
// Scale the sheet to fit the window, centred under the top bar.
function wdPlaceSheet() {
  const box = document.getElementById("ward-detail");
  if (!box.classList.contains("sheet") || box.classList.contains("hidden")) return;
  const inner = box.querySelector(".ward-detail-inner");
  const topH = box.querySelector(".ward-detail-top").offsetHeight;
  const pad = 22, W = 1062, H = 733;
  const sc = Math.min((window.innerWidth - 2 * pad) / W, (window.innerHeight - topH - 2 * pad) / H);
  inner.style.setProperty("--wdscale", sc);
  inner.style.setProperty("--wdleft", Math.max(pad, (window.innerWidth - W * sc) / 2) + "px");
  inner.style.setProperty("--wdtop", topH + pad + "px");
}
window.addEventListener("resize", () => { if (!document.documentElement.classList.contains("ward-printing")) wdPlaceSheet(); });

// Shrink the text until both election columns fit; very long results lose all but the
// most recent previous election rather than being cut off.
function wdFitText() {
  const inner = document.querySelector(".ward-detail-inner");
  const cols = [document.getElementById("wd-last"), document.getElementById("wd-prev")];
  const fits = () => cols.every((c) => c.scrollHeight <= c.clientHeight + 1);
  const extra = [...document.querySelectorAll("#wd-prev-body .elec-block")].slice(1);
  const run = () => {
    let fs = 12.5;
    inner.style.setProperty("--wdfs", fs + "px");
    while (!fits() && fs > 7) { fs -= 0.25; inner.style.setProperty("--wdfs", fs + "px"); }
  };
  run();
  if (!fits() && extra.length) { extra.forEach((n) => { n.style.display = "none"; }); run(); }
}
function wdStartSheet() {
  wdSetPrintDate();
  document.documentElement.classList.add("ward-printing");
}
function wdEndPrint() {
  document.documentElement.classList.remove("ward-printing");
  wdPlaceSheet();
}
function wardPrint() {
  if (wdIsIOS()) { wardPdf(); return; }
  wdStartSheet();
  setTimeout(() => { window.print(); }, 300);
}
window.addEventListener("afterprint", () => {
  if (document.documentElement.classList.contains("ward-printing")) wdEndPrint();
});
function wdMapComposite(scale, origin) {
  const el = document.getElementById("ward-detail-map"), r = el.getBoundingClientRect();
  const c = document.createElement("canvas");
  c.width = Math.round(r.width * scale); c.height = Math.round(r.height * scale);
  const g = c.getContext("2d");
  g.scale(scale, scale);
  g.fillStyle = "#dddddd"; g.fillRect(0, 0, r.width, r.height);
  el.querySelectorAll(".leaflet-tile-pane img.leaflet-tile-loaded, .leaflet-overlay-pane canvas").forEach((n) => {
    const b = n.getBoundingClientRect();
    if (b.right < r.left || b.left > r.right || b.bottom < r.top || b.top > r.bottom) return;
    try { g.drawImage(n, b.left - r.left, b.top - r.top, b.width, b.height); } catch (e) { /* tile not readable: skip */ }
  });
  return { canvas: c, x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height };
}
function wdShowPdfReady(file, url, errMsg) {
  const old = document.getElementById("wd-pdf-ready"); if (old) old.remove();
  const ov = document.createElement("div"); ov.id = "wd-pdf-ready";
  const canShare = file && navigator.canShare && navigator.canShare({ files: [file] });
  ov.innerHTML = errMsg
    ? `<div class="box"><p>${escapeHtml(errMsg)}</p><button class="cancel">Close</button></div>`
    : `<div class="box"><p>Your A4 ward page is ready.</p>
       ${canShare ? `<button class="go">Print or save&hellip;</button>` : `<a class="go" href="${url}" target="_blank" rel="noopener">Open PDF</a>`}
       <button class="cancel">Close</button></div>`;
  document.body.appendChild(ov);
  const close = () => { ov.remove(); if (url) setTimeout(() => URL.revokeObjectURL(url), 60000); };
  ov.querySelector(".cancel").addEventListener("click", close);
  const go = ov.querySelector("button.go");
  if (go) go.addEventListener("click", async () => {
    try { await navigator.share({ files: [file], title: file.name }); close(); }
    catch (e) { if (e && e.name === "AbortError") return; window.open(url, "_blank"); }
  });
}
async function wardPdf() {
  const btn = document.getElementById("ward-detail-print");
  btn.disabled = true; btn.textContent = "Making PDF…";
  try {
    await Promise.all([wdLoadScript("vendor/html2canvas.min.js"), wdLoadScript("vendor/jspdf.umd.min.js")]);
    wdStartSheet();
    await new Promise((r) => setTimeout(r, 300));
    const SC = 2, inner = document.querySelector(".ward-detail-inner");
    const o = inner.getBoundingClientRect();
    const W = Math.round(o.width), H = Math.round(o.height);
    const mapImg = wdMapComposite(SC, o);
    const shot = await window.html2canvas(inner, {
      useCORS: true, backgroundColor: "#ffffff", scale: SC, width: W, height: H,
      windowWidth: Math.max(window.innerWidth, W + 40), logging: false,
      ignoreElements: (el) => el.classList && el.classList.contains("leaflet-map-pane"),
      onclone: (doc) => {
        const d = doc.getElementById("ward-detail"); d.style.position = "static"; d.style.overflow = "visible";
        doc.getElementById("sidebar").style.display = "none"; doc.getElementById("map").style.display = "none";
        const a = doc.getElementById("app"); a.style.display = "block"; a.style.height = "auto"; a.style.overflow = "visible";
      },
    });
    const g = shot.getContext("2d");
    g.setTransform(1, 0, 0, 1, 0, 0);   // html2canvas leaves its scale on the context
    g.drawImage(mapImg.canvas, mapImg.x * SC, mapImg.y * SC, mapImg.w * SC, mapImg.h * SC);
    wdEndPrint();
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
    const pw = pdf.internal.pageSize.getWidth(), ph = pdf.internal.pageSize.getHeight(), M = 8;
    const s = Math.min((pw - 2 * M) / W, (ph - 2 * M) / H);
    const w = W * s, h = H * s;
    pdf.addImage(shot.toDataURL("image/jpeg", 0.92), "JPEG", (pw - w) / 2, (ph - h) / 2, w, h);
    const name = document.getElementById("ward-detail-name").textContent.replace(/[\\/:*?"<>|]/g, "-");
    const blob = pdf.output("blob");
    const file = new File([blob], `${name} ward A4.pdf`, { type: "application/pdf" });
    wdShowPdfReady(file, URL.createObjectURL(blob));
  } catch (e) {
    wdEndPrint();
    wdShowPdfReady(null, null, "Sorry, the PDF couldn't be made (" + (e && e.message ? e.message : e) + "). Check you're online and try again.");
  } finally {
    btn.disabled = false; btn.textContent = "Print (A4)";
  }
}
document.getElementById("ward-detail-print").addEventListener("click", wardPrint);

/** Full page for a constituency: the popup's figures, the 2024 result and the notional 2019 result, and its wards. */
function openConstituencyDetail(name) {
  const c = E && E.constituencies[name];
  const feature = { properties: { name } };
  document.getElementById("ward-detail").classList.remove("sheet");
  document.getElementById("ward-detail-name").textContent = name;
  document.getElementById("ward-detail-parent").textContent = c ? `MP: ${c.mp} (${partyName(c.party)})` : "Constituency";
  document.getElementById("ward-detail-data-title").textContent = "Constituency figures";
  const tmp = document.createElement("div");
  tmp.innerHTML = constituencyPopup(feature);
  const table = tmp.querySelector(".popup-table");
  [...table.querySelectorAll("td.elec-cell")].forEach((td) => td.parentElement.remove());   // results go in their own section
  document.getElementById("ward-detail-data").innerHTML = table.innerHTML +
    `<tr><td colspan="2" class="dim" style="white-space:normal">${escapeHtml(tmp.querySelector(".popup-note").textContent)}</td></tr>`;
  let h = "";
  if (c) {
    h += electionSection("General election", c.last);
    const p = c.prev;
    const shares = p.shares.map((s) => `<tr><td>${partyDot(s.p)}${escapeHtml(partyName(s.p))}</td><td class="num">${s.v ? fmtN(s.v) : ""}</td><td class="num">${s.pc.toFixed(1)}%</td></tr>`).join("");
    h += `<div class="elec-block"><h3>Previous election, ${escapeHtml(p.date)}${p.notional ? ' <span class="dim">(notional result on the 2024 boundaries)</span>' : ""}</h3>
      <table class="elec-table"><tr><th>Party</th><th class="num">Votes</th><th class="num">%</th></tr>${shares}</table>
      <div class="elec-foot">${p.turnout ? `Turnout ${p.turnout}%` : ""}${p.majority ? ` · majority ${fmtN(p.majority)}` : ""}${p.notional ? " · Estimated by Rallings &amp; Thrasher: the 2019 election was fought on the old boundaries, so there are no candidate figures for this seat." : ""}</div></div>`;
  }
  const wards = Object.values(E ? E.wards : {}).filter((w) => w.constituency === name).sort((a, b) => a.name.localeCompare(b.name));
  if (wards.length) {
    h += `<div class="elec-block"><h3>District wards (${wards.length})</h3><table class="elec-table"><tr><th>Ward</th><th>District</th><th>Councillors</th></tr>` +
      wards.map((w) => `<tr><td>${escapeHtml(w.name)}</td><td>${escapeHtml(w.district)}</td><td>${heldText(w)}</td></tr>`).join("") + `</table></div>`;
  }
  document.getElementById("ward-detail-elections").innerHTML = h;
  document.getElementById("ward-detail-elections-section").classList.remove("hidden");
  document.getElementById("ward-detail").classList.remove("hidden");
  window.scrollTo(0, 0);
}
window.openConstituencyDetail = openConstituencyDetail;

function closeWardDetail() {
  document.getElementById("ward-detail").classList.add("hidden");
}

document.getElementById("ward-picker-go").addEventListener("click", () => {
  const select = document.getElementById("ward-picker-select");
  if (select.value) openWardDetail(select.value);
});
document.getElementById("ward-picker-leaflets").addEventListener("click", () => {
  const select = document.getElementById("ward-picker-select");
  if (select.value) window.open(`leaflets.html?ward=${encodeURIComponent(select.value)}`, "_blank");
});
document.getElementById("ward-picker-map").addEventListener("click", () => {
  const select = document.getElementById("ward-picker-select");
  if (select.value) openPostcodeMap(select.value);
});
document.getElementById("ward-detail-back").addEventListener("click", closeWardDetail);

async function init() {
  try {
    const countyGeo = await loadLayer("data/county.geojson");
    countyLayer = L.geoJSON(countyGeo, {
      style: { color: COLORS.county, weight: WEIGHTS.county, fill: false },
      onEachFeature: (feature, layer) => {
        layer.bindPopup(countyPopup(feature));
        layer.bindTooltip(feature.properties.name, {
          permanent: true, direction: "center", className: "county-label",
        });
      },
    }).addTo(map);

    const available = await ensureModeLoaded("district");
    if (!available) throw new Error("district boundary data missing");

    await Promise.all([loadTopTen(), loadRuc(), loadElections()]);
    midLayer = buildMidLayer("district").addTo(map);
    wardLayer = buildWardLayer("district");
    // wards start off, so 168+ shapes aren't dumped on screen immediately

    document.getElementById("ward-count").textContent =
      `${cache.district.wardGeo.features.length}`;

    // grey out the constituency tab until (if) that data is available
    const available2 = await ensureModeLoaded("constituency");
    if (!available2) {
      const btn = document.getElementById("mode-constituency");
      btn.title = "Boundary data not loaded yet";
    }

    if (!loadPinnedFromStorage()) {
      await loadBundledCsv();
    }
    await loadPostcodeData();
    populateWardPicker();
    updateLayerOrder();
    updateWardLabelVisibility();
  } catch (err) {
    console.error(err);
    document.getElementById("data-status").textContent =
      "Could not load boundary data - if you opened this file directly, " +
      "serve the folder with a local web server instead (browsers block " +
      "loading local files via fetch()).";
    document.getElementById("data-status").className = "status error";
  }
}

function wardStyle(feature) {
  const base = { color: COLORS.ward, weight: WEIGHTS.ward, dashArray: null };
  if (politicsOn()) {
    if (currentMode !== "district") return { ...base, color: "#2b2f36", weight: 0.8, fill: false };
    const w = elecWard(feature.properties.name);
    if (!w) return { ...base, fillColor: "#4a4f57", fillOpacity: 0.35, fill: true };
    // seats split between parties: dashed white outline
    return w.split
      ? { color: "#ffffff", weight: 1.6, dashArray: "4 3", fillColor: partyColour(w.party), fillOpacity: 0.62, fill: true }
      : { color: "#2b2f36", weight: 1, fillColor: partyColour(w.party), fillOpacity: 0.62, fill: true };
  }
  if (rucOn()) {
    const rec = rucRec(feature.properties.name);
    if (!rec) return { ...base, fillColor: "#4a4f57", fillOpacity: 0.35, fill: true };
    if (activeColourColumn === "__ruc_class__") return { ...base, fillColor: RUC_COLOURS[rucDominant(rec)], fillOpacity: 0.6, fill: true };
    return { ...base, fillColor: lerpColor("#fff3b0", "#c1121f", rucRural(rec) / 100), fillOpacity: 0.55, fill: true };
  }
  if (topFiveOn()) {
    const hit = qualifies(topTenData && topTenData[normalizeName(feature.properties.name)], activeColourColumn);
    return hit
      ? { color: "#b3202c", weight: 2, fillColor: "#e63946", fillOpacity: 0.5, fill: true }
      : { ...base, fill: false };
  }
  if (activeColourColumn && pinnedData) {
    const rec = pinnedData[normalizeName(feature.properties.name)];
    const val = rec ? parseFloat(rec[activeColourColumn]) : NaN;
    if (!isNaN(val)) {
      return { ...base, fillColor: colourForValue(val), fillOpacity: 0.55, fill: true };
    }
    // pinned data exists but no value for the chosen column on this ward -
    // show as "no data" rather than leaving it blank
    return { ...base, fillColor: "#4a4f57", fillOpacity: 0.35, fill: true };
  }
  return { ...base, fill: false };
}

/* ---------- layer toggles ---------- */

document.getElementById("toggle-county").addEventListener("change", (e) => {
  if (e.target.checked) countyLayer.addTo(map); else map.removeLayer(countyLayer);
  updateLayerOrder();
});
document.getElementById("toggle-mid").addEventListener("change", (e) => {
  if (e.target.checked) midLayer.addTo(map); else map.removeLayer(midLayer);
  updateLayerOrder();
});
document.getElementById("toggle-wards").addEventListener("change", (e) => {
  if (e.target.checked) wardLayer.addTo(map); else map.removeLayer(wardLayer);
  updateLayerOrder();
});

/* ---------- CSV pinning ---------- */

const fileInput = document.getElementById("csv-input");
const fileDrop = document.getElementById("file-drop");
const fileDropLabel = document.getElementById("file-drop-label");
const dataControls = document.getElementById("data-controls");
const colourSelect = document.getElementById("colour-column");
const legendEl = document.getElementById("legend");
const statusEl = document.getElementById("data-status");

fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  if (!file) return;
  Papa.parse(file, {
    header: true,
    skipEmptyLines: true,
    complete: (results) => applyParsedCsv(results.data, file.name),
    error: (err) => showStatus(`Could not parse CSV: ${err.message}`, true),
  });
});

function applyParsedCsv(rows, filename) {
  if (!rows.length) {
    showStatus("That CSV had no rows.", true);
    return;
  }
  const columns = Object.keys(rows[0]);
  const wardCol = columns.find((c) => normalizeName(c) === "ward")
    || columns.find((c) => normalizeName(c).includes("ward"));

  if (!wardCol) {
    showStatus('No "ward" column found - the CSV needs a column named "ward" with ward names to match against.', true);
    return;
  }

  const lookup = {};
  let matched = 0;
  const namesInMap = new Set(
    (wardLayer ? wardLayer.toGeoJSON().features : []).map((f) => normalizeName(f.properties.name))
  );

  for (const row of rows) {
    const key = normalizeName(row[wardCol]);
    if (!key) continue;
    lookup[key] = row;
    if (namesInMap.has(key)) matched++;
  }

  pinnedColumns = columns.filter((c) => c !== wardCol);
  pinnedData = lookup;

  savePinnedToStorage(filename);
  refreshDataControls();
  if (wardLayer) wardLayer.eachLayer((l) => l.setPopupContent(wardPopup(l.feature)));

  const unmatched = Object.keys(lookup).length - matched;
  showStatus(
    `Pinned "${filename}": matched ${matched} of ${Object.keys(lookup).length} rows to wards` +
    (unmatched ? ` (${unmatched} row${unmatched === 1 ? "" : "s"} didn't match any ward name).` : "."),
    false
  );
}

function refreshDataControls() {
  numericColumns = pinnedColumns.filter((col) => {
    const vals = Object.values(pinnedData).map((r) => r[col]);
    const sample = vals.filter((v) => v !== undefined && v !== "").slice(0, 20);
    return sample.length > 0 && sample.every(isNumeric);
  });

  colourSelect.innerHTML =
    '<option value="">None (outline only)</option>' +
    (E ? `<option value="${POLITICS}">Politics</option>` : "") +
    (topTenData ? Object.entries(TOP_OPTIONS).map(([k, o]) => `<option value="${k}">${o.label}</option>`).join("") : "") +
    (rucData ? Object.entries(RUC_OPTIONS).map(([k, o]) => `<option value="${k}">${o.label}</option>`).join("") : "") +
    numericColumns.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(friendlyLabel(c))}</option>`).join("");
  if (activeColourColumn) colourSelect.value = activeColourColumn;

  dataControls.classList.remove("hidden");
  fileDropLabel.textContent = "Replace CSV\u2026";
}

colourSelect.addEventListener("change", () => {
  activeColourColumn = colourSelect.value || null;
  document.getElementById("map").classList.toggle("topfive-on", topFiveOn());
  refreshWardLabels();
  const wardShading = topFiveOn() || rucOn() || (politicsOn() && currentMode === "district");
  if (wardShading && wardLayer && !map.hasLayer(wardLayer)) {   // the shading lives on the wards layer
    wardLayer.addTo(map);
    document.getElementById("toggle-wards").checked = true;
    updateLayerOrder();
  }
  if (politicsOn() && midLayer && !map.hasLayer(midLayer)) {     // council control / constituency colours live on the middle layer
    midLayer.addTo(map);
    document.getElementById("toggle-mid").checked = true;
    updateLayerOrder();
  }
  if (wardLayer) wardLayer.setStyle(wardStyle);
  if (midLayer) midLayer.setStyle(midStyle);
  updateLegend();
});

document.getElementById("clear-data").addEventListener("click", () => {
  pinnedData = null;
  pinnedColumns = [];
  numericColumns = [];
  activeColourColumn = null;
  document.getElementById("map").classList.remove("topfive-on");
  refreshWardLabels();
  localStorage.removeItem(STORAGE_KEY);
  dataControls.classList.add("hidden");
  legendEl.classList.add("hidden");
  fileDropLabel.textContent = "Choose CSV file\u2026";
  fileInput.value = "";
  if (wardLayer) wardLayer.setStyle(wardStyle);
  if (midLayer) midLayer.setStyle(midStyle);
  showStatus("Pinned data cleared.", false);
});

function showStatus(msg, isError) {
  statusEl.textContent = msg;
  statusEl.className = "status " + (isError ? "error" : "ok");
}

/* ---------- choropleth colouring ---------- */

function colourForValue(val) {
  const vals = Object.values(pinnedData)
    .map((r) => parseFloat(r[activeColourColumn]))
    .filter((v) => !isNaN(v));
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const t = max > min ? (val - min) / (max - min) : 0.5;
  return lerpColor("#fff3b0", "#c1121f", t);
}

function lerpColor(a, b, t) {
  const pa = hexToRgb(a), pb = hexToRgb(b);
  const r = Math.round(pa.r + (pb.r - pa.r) * t);
  const g = Math.round(pa.g + (pb.g - pa.g) * t);
  const b2 = Math.round(pa.b + (pb.b - pa.b) * t);
  return `rgb(${r},${g},${b2})`;
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function updateLegend() {
  if (!activeColourColumn) {
    legendEl.classList.add("hidden");
    return;
  }
  if (politicsOn()) {
    const sw = (p, extra = "") => `<span style="flex:none;width:14px;height:14px;background:${partyColour(p)};border-radius:2px;display:inline-block;${extra}"></span>`;
    const row = (p, label, extra) => `<div style="display:flex;align-items:center;gap:8px;margin:2px 0;">${sw(p, extra)}<span>${label}</span></div>`;
    let body, note;
    if (currentMode === "district") {
      const counts = {};
      Object.values(E.wards).forEach((w) => (counts[w.party] = (counts[w.party] || 0) + 1));
      body = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([p, n]) => row(p, `${escapeHtml(partyName(p))} (${n} ward${n === 1 ? "" : "s"})`)).join("") +
        row("NOC", "Split ward (seats shared between parties): dashed white outline", "background:transparent;border:2px dashed #fff;") +
        `<div style="margin-top:8px;font-weight:600;">Council control (district outline)</div>` +
        Object.entries(E.councils).map(([d, k]) => row(k.control, `${escapeHtml(d)}: ${k.control === "NOC" ? "no overall control, " + escapeHtml(k.leader) : escapeHtml(partyName(k.control)) + " majority"}`,
          k.control === "NOC" ? "background:transparent;border:2px dashed #c9d1d9;" : "")).join("");
      note = "Ward colour: the party holding most of the ward's seats as elected at the last full election (May 2023; Exeter: the 2023, 2024 and 2026 winners). Later by-elections and changes of party aren't in the ward colours but are in the council seat totals. Tap a ward for its last result, or a district outline for council seats.";
    } else {
      const counts = {};
      Object.values(E.constituencies).forEach((c) => (counts[c.party] = (counts[c.party] || 0) + 1));
      body = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([p, n]) => row(p, `${escapeHtml(partyName(p))} (${n} seat${n === 1 ? "" : "s"})`)).join("");
      note = "Constituency colour: the party that won at the general election of 4 July 2024. Tap anywhere in a constituency for its result and figures.";
    }
    legendEl.innerHTML = `${body}<p style="margin:8px 0 0;color:var(--text-dim);font-size:12px;">${note}</p>`;
    legendEl.classList.remove("hidden");
    return;
  }
  if (rucOn()) {
    const note = "2011 Rural-Urban Classification. Every current address is matched, through its postcode, to the 2011 output area it sits in and that area's class; each ward shows the mix of its addresses (see the ward popup). Estates built since 2011 that the 2021 classification treats as urban (e.g. Cranbrook) are counted as urban city and town.";
    let body;
    if (activeColourColumn === "__ruc_class__") {
      const present = [...new Set(Object.values(rucData).map(rucDominant))].sort();
      body = present.map((k) => `<div style="display:flex;align-items:center;gap:8px;margin:2px 0;"><span style="flex:none;width:14px;height:14px;background:${RUC_COLOURS[k]};opacity:.8;border-radius:2px;display:inline-block;"></span><span>${escapeHtml(rucClasses[k] || k)}</span></div>`).join("");
    } else {
      body = `<div class="legend-bar" style="background:linear-gradient(90deg,#fff3b0,#c1121f)"></div><div class="legend-labels"><span>0%</span><span>% of addresses rural</span><span>100%</span></div>`;
    }
    legendEl.innerHTML = `${body}<p style="margin:8px 0 0;color:var(--text-dim);font-size:12px;">${note}</p>`;
    legendEl.classList.remove("hidden");
    return;
  }
  if (topFiveOn()) {
    const n = topCount(activeColourColumn);
    const one = activeColourColumn === "__top1_both__";
    const text = one ? `Top ward in each constituency (${n} wards)` : `Top five per constituency (${n} wards)`;
    const note = "Ranked on both measures together: working-class share (% routine/manual, 2021 Census) plus cheapest seat (fewest residents per councillor). Only wards in the top ten on both are eligible, so some constituencies have fewer than five.";
    legendEl.innerHTML = `<div style="display:flex;align-items:center;gap:8px;">
        <span style="flex:none;width:14px;height:14px;background:rgba(230,57,70,.5);border:2px solid #b3202c;border-radius:2px;display:inline-block;"></span>
        <span>${text}</span></div>
      <p style="margin:8px 0 0;color:var(--text-dim);font-size:12px;">${note} Zoom in for each ward's figures.</p>`;
    legendEl.classList.remove("hidden");
    return;
  }
  const vals = Object.values(pinnedData)
    .map((r) => parseFloat(r[activeColourColumn]))
    .filter((v) => !isNaN(v));
  const min = Math.min(...vals).toFixed(1);
  const max = Math.max(...vals).toFixed(1);
  const noDataCount = wardLayer
    ? wardLayer.toGeoJSON().features.filter((f) => {
        const rec = pinnedData[normalizeName(f.properties.name)];
        return !rec || isNaN(parseFloat(rec[activeColourColumn]));
      }).length
    : 0;
  const noDataRow = noDataCount
    ? `<div style="display:flex;align-items:center;gap:6px;margin-top:8px;">
         <span style="width:10px;height:10px;background:#4a4f57;border-radius:2px;display:inline-block;"></span>
         <span style="color:var(--text-dim);">No data (${noDataCount} ward${noDataCount === 1 ? "" : "s"})</span>
       </div>`
    : "";
  legendEl.innerHTML = `
    <div class="legend-bar" style="background:linear-gradient(90deg,#fff3b0,#c1121f)"></div>
    <div class="legend-labels"><span>${min}</span><span>${escapeHtml(friendlyLabel(activeColourColumn))}</span><span>${max}</span></div>
    ${noDataRow}
  `;
  legendEl.classList.remove("hidden");
}

/* ---------- persistence ---------- */

function savePinnedToStorage(filename) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      filename, columns: pinnedColumns, data: pinnedData,
    }));
  } catch (e) {
    console.warn("Could not save pinned data to localStorage:", e);
  }
}

function loadPinnedFromStorage() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw);
    // The bundled census file is always re-read fresh, so corrections to it reach every device;
    // only data the user pinned themselves is restored from storage.
    if (String(parsed.filename || "").endsWith("(bundled)")) return false;
    pinnedData = parsed.data;
    pinnedColumns = parsed.columns;
    refreshDataControls();
    if (wardLayer) wardLayer.eachLayer((l) => l.setPopupContent(wardPopup(l.feature)));
    showStatus(`Restored pinned data from "${parsed.filename}".`, false);
    return true;
  } catch (e) {
    console.warn("Could not restore pinned data:", e);
    return false;
  }
}

async function loadBundledCsv() {
  const cfg = MODES[currentMode];
  if (!cfg.bundledCsv) return;
  try {
    const res = await fetch(cfg.bundledCsv);
    if (!res.ok) return;
    const text = await res.text();
    const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
    applyParsedCsv(parsed.data, `${cfg.bundledCsv} (bundled)`);

    // First-run convenience: show the wards layer and a default colouring,
    // so opening the map for the first time already demonstrates the data.
    document.getElementById("toggle-wards").checked = true;
    wardLayer.addTo(map);
    if (numericColumns.includes("pct_routine_manual")) {
      colourSelect.value = "pct_routine_manual";
      activeColourColumn = "pct_routine_manual";
      wardLayer.setStyle(wardStyle);
      updateLegend();
    }
  } catch (e) {
    console.warn("No bundled dataset loaded:", e);
  }
}

init();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch((e) => console.warn("Service worker registration failed:", e));
  });
}
