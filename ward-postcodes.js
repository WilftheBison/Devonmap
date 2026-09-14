/* Standalone per-ward postcode map, opened from the main app. Reads
   ?ward=<name> from the URL, loads that ward's precomputed postcode cells
   (a Voronoi tessellation of postcode points, clipped to the ward boundary
   - individual postcodes have no official polygon of their own, only a
   centre point), and renders them with a label on each. The ward picker
   at the top lets you jump straight to a different ward (reloads the page
   with the new ?ward= value - simplest way to keep this page self
   contained). Data panel reads whatever's currently pinned in the main
   app (same-origin localStorage, so it carries over automatically). */

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
const FRIENDLY_LABELS = {
  total_residents: "Total residents", pct_aged_50_plus: "% aged 50+",
  pct_AB_equivalent: "% AB-equivalent", pct_routine_manual: "% routine/manual",
  notes: "Notes",
};
function friendlyLabel(col) { return FRIENDLY_LABELS[col] || col; }

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

/* ---------- pinned data panel (shared with the main app via localStorage) ---------- */

function renderDataTable() {
  const tableEl = document.getElementById("wp-data-table");
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    tableEl.innerHTML = `<tr><td colspan="2" style="color:var(--text-dim);">No data pinned.</td></tr>`;
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    tableEl.innerHTML = `<tr><td colspan="2" style="color:var(--text-dim);">No data pinned.</td></tr>`;
    return;
  }
  const rec = parsed.data ? parsed.data[normalizeName(wardName)] : null;
  if (!rec) {
    tableEl.innerHTML = `<tr><td colspan="2" style="color:var(--text-dim);">No data pinned for this ward.</td></tr>`;
    return;
  }
  let rows = "";
  for (const col of parsed.columns) {
    if (rec[col] !== undefined && rec[col] !== "") {
      rows += `<tr><td>${escapeHtml(friendlyLabel(col))}</td><td>${escapeHtml(rec[col])}</td></tr>`;
    }
  }
  tableEl.innerHTML = rows || `<tr><td colspan="2" style="color:var(--text-dim);">No data pinned for this ward.</td></tr>`;
}

/* ---------- ward picker (jumps to a different ward) ---------- */

function populateWardPicker(slugs) {
  const select = document.getElementById("wp-ward-select");
  const names = Object.keys(slugs).sort((a, b) => a.localeCompare(b));
  select.innerHTML = names.map((n) =>
    `<option value="${escapeHtml(n)}" ${normalizeName(n) === normalizeName(wardName) ? "selected" : ""}>${escapeHtml(n)}</option>`
  ).join("");
  select.addEventListener("change", () => {
    window.location.href = `ward-postcodes.html?ward=${encodeURIComponent(select.value)}`;
  });
}

/* ---------- postcode cells ---------- */

async function init() {
  renderDataTable();

  try {
    const slugsRes = await fetch("data/postcode-cells/slugs.json");
    if (!slugsRes.ok) throw new Error(`slug index missing (${slugsRes.status})`);
    const slugs = await slugsRes.json();
    populateWardPicker(slugs);

    if (!wardName) {
      showStatus("Pick a ward above.");
      return;
    }

    const key = Object.keys(slugs).find((k) => normalizeName(k) === normalizeName(wardName));
    if (!key) throw new Error("ward not found in index");
    const slug = slugs[key];

    const res = await fetch(`data/postcode-cells/${slug}.geojson`);
    if (!res.ok) throw new Error(`cell data missing (${res.status})`);
    const geo = await res.json();

    const outlineFeature = geo.features.find((f) => f.properties.type === "ward-outline");
    const cellFeatures = geo.features.filter((f) => f.properties.type === "postcode-cell");

    L.geoJSON(outlineFeature, {
      style: { color: "#e63946", weight: 3.5, fill: false },
    }).addTo(map);

    let i = 0;
    const cellsLayer = L.geoJSON(cellFeatures, {
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

    document.getElementById("wp-ward-count").textContent = `${cellFeatures.length} postcodes`;
    map.fitBounds(cellsLayer.getBounds(), { padding: [20, 20] });
  } catch (e) {
    console.error(e);
    showStatus(
      `Couldn't load postcode data for "${wardName}" (${e.message}). ` +
      `If this keeps happening, check data/postcode-cells/slugs.json is reachable directly in the browser.`
    );
  }
}

init();
