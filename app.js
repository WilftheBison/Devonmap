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
map.on("zoomend", updateWardLabelVisibility);
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

  if (pinnedData) {
    const rec = pinnedData[normalizeName(name)];
    if (rec) {
      for (const col of pinnedColumns) {
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

function buildMidLayer(mode) {
  const geo = cache[mode].midGeo;
  return L.geoJSON(geo, {
    style: { color: COLORS.mid, weight: WEIGHTS.mid, fill: false },
    onEachFeature: (feature, layer) => {
      layer.bindPopup(midPopup(feature));
      layer.bindTooltip(feature.properties.name, {
        permanent: true, direction: "center", className: "mid-label",
      });
    },
  });
}

function buildWardLayer(mode) {
  const geo = cache[mode].wardGeo;
  return L.geoJSON(geo, {
    style: wardStyle,
    onEachFeature: (feature, layer) => {
      layer.bindPopup(() => wardPopup(feature));
      layer.bindTooltip(feature.properties.name, {
        permanent: true, direction: "center", className: "ward-label",
      });
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
  if (midWasOn) midLayer.addTo(map);
  if (wardWasOn) wardLayer.addTo(map);

  document.getElementById("toggle-mid").checked = midWasOn;
  document.getElementById("toggle-wards").checked = wardWasOn;
  document.getElementById("ward-count").textContent =
    `${cache[mode].wardGeo.features.length}`;

  // re-apply/refresh whatever's pinned against the new ward layer
  wardLayer.setStyle(wardStyle);
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

function openWardDetail(name) {
  const feature = findWardFeature(name);
  if (!feature) return;

  const parentLabel = MODES[currentMode].midParentLabel;
  const parentValue = feature.properties[MODES[currentMode].wardParentProp];

  document.getElementById("ward-detail-name").textContent = feature.properties.name;
  document.getElementById("ward-detail-parent").textContent = `${parentLabel}: ${parentValue}`;

  const dataEl = document.getElementById("ward-detail-data");
  let rows = "";
  if (pinnedData) {
    const rec = pinnedData[normalizeName(feature.properties.name)];
    if (rec) {
      for (const col of pinnedColumns) {
        if (rec[col] !== undefined && rec[col] !== "") {
          rows += `<tr><td>${escapeHtml(friendlyLabel(col))}</td><td>${escapeHtml(rec[col])}</td></tr>`;
        }
      }
    }
  }
  dataEl.innerHTML = rows || `<tr><td colspan="2" style="color:var(--text-dim);">No data pinned for this ward.</td></tr>`;

  const pcEl = document.getElementById("ward-detail-postcodes");
  const rec = postcodeData ? postcodeData[normalizeName(feature.properties.name)] : null;
  const mapButton = `<button class="primary-button" style="margin-bottom:14px;" onclick="openPostcodeMap('${feature.properties.name.replace(/'/g, "\\'")}')">Open postcode map &#8599;</button>`;
  if (rec && rec.length) {
    pcEl.innerHTML =
      mapButton +
      `<p class="postcode-pending">${rec.length} postcode${rec.length === 1 ? "" : "s"}.</p>
       <div class="postcode-grid">` +
      rec.map((p) => `<div class="postcode-chip">${escapeHtml(p)}</div>`).join("") +
      `</div>`;
  } else {
    pcEl.innerHTML =
      `<p class="postcode-pending">Postcode data hasn't been loaded into this map yet -
       add <code>data/postcodes-by-ward.json</code> (ward name &rarr; array of postcodes)
       and this fills in automatically. See the README.</p>`;
  }

  document.getElementById("ward-detail").classList.remove("hidden");
  window.scrollTo(0, 0);
}
window.openWardDetail = openWardDetail;

function closeWardDetail() {
  document.getElementById("ward-detail").classList.add("hidden");
}

document.getElementById("ward-picker-go").addEventListener("click", () => {
  const select = document.getElementById("ward-picker-select");
  if (select.value) openWardDetail(select.value);
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
  const base = { color: COLORS.ward, weight: WEIGHTS.ward };
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
    numericColumns.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(friendlyLabel(c))}</option>`).join("");

  dataControls.classList.remove("hidden");
  fileDropLabel.textContent = "Replace CSV\u2026";
}

colourSelect.addEventListener("change", () => {
  activeColourColumn = colourSelect.value || null;
  if (wardLayer) wardLayer.setStyle(wardStyle);
  updateLegend();
});

document.getElementById("clear-data").addEventListener("click", () => {
  pinnedData = null;
  pinnedColumns = [];
  numericColumns = [];
  activeColourColumn = null;
  localStorage.removeItem(STORAGE_KEY);
  dataControls.classList.add("hidden");
  legendEl.classList.add("hidden");
  fileDropLabel.textContent = "Choose CSV file\u2026";
  fileInput.value = "";
  if (wardLayer) {
    wardLayer.setStyle(wardStyle);
    wardLayer.eachLayer((l) => l.setPopupContent(wardPopup(l.feature)));
  }
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
