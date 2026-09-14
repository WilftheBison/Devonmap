/* Standalone per-ward postcode map, opened in its own window/tab from the
   main app. Reads ?ward=<name> from the URL, loads that ward's precomputed
   postcode cells (a Voronoi tessellation of postcode points, clipped to the
   ward boundary - see README for why: individual postcodes have no
   official polygon of their own, only a centre point), and renders them.
   Also reads whatever's currently pinned in the main app (same-origin
   localStorage, so it carries over automatically) so this page keeps the
   same "colour by" picker and data table for the ward itself. */

const STORAGE_KEY = "devon-map-pinned-data-v1"; // must match app.js

// a small fixed palette, cycled - keeps neighbouring postcode cells visually
// distinct without needing per-postcode data (there isn't any)
const PALETTE = [
  "#3a6fd8", "#2a9d54", "#e6a23c", "#c1121f", "#8e5fd8",
  "#22a6b3", "#d9527a", "#5a8f29", "#c77b2c", "#4a6fa5",
];

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
  total_residents: "Total residents", pct_aged_50_plus: "% aged 50+",
  pct_AB_equivalent: "% AB-equivalent", pct_routine_manual: "% routine/manual",
  notes: "Notes",
};
function friendlyLabel(col) { return FRIENDLY_LABELS[col] || col; }
function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function lerpColor(a, b, t) {
  const pa = hexToRgb(a), pb = hexToRgb(b);
  return `rgb(${Math.round(pa.r + (pb.r - pa.r) * t)},${Math.round(pa.g + (pb.g - pa.g) * t)},${Math.round(pa.b + (pb.b - pa.b) * t)})`;
}

const params = new URLSearchParams(window.location.search);
const wardName = params.get("ward") || "";
document.getElementById("wp-ward-name").textContent = wardName || "No ward specified";

const map = L.map("wp-map", { zoomControl: true }).setView([50.78, -3.75], 13);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors",
}).addTo(map);

function showStatus(msg) {
  const el = document.getElementById("wp-status");
  el.textContent = msg;
  el.classList.remove("hidden");
}

/* ---------- pinned data (shared with the main app via localStorage) ---------- */

let pinnedData = null;
let pinnedColumns = [];
let numericColumns = [];
let activeColourColumn = null;

function loadPinnedData() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw);
    pinnedData = parsed.data;
    pinnedColumns = parsed.columns;
  } catch (e) {
    console.warn("Could not read pinned data:", e);
  }
}

function renderDataTable() {
  const tableEl = document.getElementById("wp-data-table");
  const rec = pinnedData ? pinnedData[normalizeName(wardName)] : null;
  if (!rec) {
    tableEl.innerHTML = `<tr><td colspan="2" style="color:var(--text-dim);">No data pinned for this ward.</td></tr>`;
    return;
  }
  let rows = "";
  for (const col of pinnedColumns) {
    if (rec[col] !== undefined && rec[col] !== "") {
      rows += `<tr><td>${escapeHtml(friendlyLabel(col))}</td><td>${escapeHtml(rec[col])}</td></tr>`;
    }
  }
  tableEl.innerHTML = rows || `<tr><td colspan="2" style="color:var(--text-dim);">No data pinned for this ward.</td></tr>`;
}

function populateColourPicker() {
  const select = document.getElementById("wp-colour-column");
  if (!pinnedData) {
    select.innerHTML = '<option value="">No pinned data loaded</option>';
    select.disabled = true;
    return;
  }
  numericColumns = pinnedColumns.filter((col) => {
    const vals = Object.values(pinnedData).map((r) => r[col]);
    const sample = vals.filter((v) => v !== undefined && v !== "").slice(0, 20);
    return sample.length > 0 && sample.every(isNumeric);
  });
  select.innerHTML =
    '<option value="">None</option>' +
    numericColumns.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(friendlyLabel(c))}</option>`).join("");
  select.addEventListener("change", () => {
    activeColourColumn = select.value || null;
    applyWardColour();
    updateLegend();
  });
}

function colourForValue(val) {
  const vals = Object.values(pinnedData)
    .map((r) => parseFloat(r[activeColourColumn]))
    .filter((v) => !isNaN(v));
  const min = Math.min(...vals), max = Math.max(...vals);
  const t = max > min ? (val - min) / (max - min) : 0.5;
  return lerpColor("#fff3b0", "#c1121f", t);
}

function updateLegend() {
  const legendEl = document.getElementById("wp-legend");
  if (!activeColourColumn || !pinnedData) {
    legendEl.classList.add("hidden");
    return;
  }
  const vals = Object.values(pinnedData)
    .map((r) => parseFloat(r[activeColourColumn]))
    .filter((v) => !isNaN(v));
  const min = Math.min(...vals).toFixed(1), max = Math.max(...vals).toFixed(1);
  legendEl.innerHTML = `
    <div class="legend-bar" style="background:linear-gradient(90deg,#fff3b0,#c1121f)"></div>
    <div class="legend-labels"><span>${min}</span><span>${escapeHtml(friendlyLabel(activeColourColumn))}</span><span>${max}</span></div>
  `;
  legendEl.classList.remove("hidden");
}

let outlineLayer = null;
function applyWardColour() {
  if (!outlineLayer) return;
  if (activeColourColumn && pinnedData) {
    const rec = pinnedData[normalizeName(wardName)];
    const val = rec ? parseFloat(rec[activeColourColumn]) : NaN;
    if (!isNaN(val)) {
      outlineLayer.setStyle({ fillColor: colourForValue(val), fillOpacity: 0.35, fill: true });
      return;
    }
    outlineLayer.setStyle({ fillColor: "#4a4f57", fillOpacity: 0.25, fill: true });
    return;
  }
  outlineLayer.setStyle({ fill: false });
}

/* ---------- postcode cells ---------- */

async function init() {
  loadPinnedData();
  renderDataTable();
  populateColourPicker();

  if (!wardName) {
    showStatus("Open this page from a ward's popup or the Ward detail page on the main map.");
    return;
  }
  try {
    const slugsRes = await fetch("data/postcode-cells/_slugs.json");
    if (!slugsRes.ok) throw new Error("slug index missing");
    const slugs = await slugsRes.json();
    const key = Object.keys(slugs).find((k) => normalizeName(k) === normalizeName(wardName));
    if (!key) throw new Error("ward not found");
    const slug = slugs[key];

    const res = await fetch(`data/postcode-cells/${slug}.geojson`);
    if (!res.ok) throw new Error("cell data missing");
    const geo = await res.json();

    const outlineFeature = geo.features.find((f) => f.properties.type === "ward-outline");
    const cellFeatures = geo.features.filter((f) => f.properties.type === "postcode-cell");

    outlineLayer = L.geoJSON(outlineFeature, {
      style: { color: "#e63946", weight: 3.5, fill: false },
    }).addTo(map);
    applyWardColour();
    updateLegend();

    let i = 0;
    L.geoJSON(cellFeatures, {
      style: () => {
        const color = PALETTE[i % PALETTE.length];
        i++;
        return { color: "#0d1117", weight: 1, fillColor: color, fillOpacity: 0.45 };
      },
      onEachFeature: (feature, layer) => {
        const list = feature.properties.postcodes || [feature.properties.postcode];
        layer.bindTooltip(list.join(", "), { sticky: true });
        layer.bindTooltip(feature.properties.postcode, {
          permanent: true, direction: "center", className: "pc-label",
        });
        layer.on("mouseover", () => layer.setStyle({ weight: 2.5, fillOpacity: 0.7 }));
        layer.on("mouseout", () => layer.setStyle({ weight: 1, fillOpacity: 0.45 }));
      },
    }).addTo(map);

    const dataEl = document.getElementById("wp-ward-parent");
    dataEl.textContent = `${cellFeatures.length} postcodes`;

    map.fitBounds(outlineLayer.getBounds(), { padding: [20, 20] });
    document.getElementById("wp-count").textContent = `(${cellFeatures.length})`;
  } catch (e) {
    console.error(e);
    showStatus(
      `Couldn't load postcode data for "${wardName}" - if you opened this file directly, ` +
      `serve the folder with a local web server instead (browsers block loading local files via fetch()).`
    );
  }
}

init();
