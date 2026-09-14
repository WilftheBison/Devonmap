/* Standalone per-ward postcode map, opened in its own window/tab from the
   main app. Reads ?ward=<name> from the URL, loads that ward's precomputed
   postcode cells (a Voronoi tessellation of postcode points, clipped to the
   ward boundary - see README for why: individual postcodes have no
   official polygon of their own, only a centre point), and renders them. */

const PC_LABEL_MIN_ZOOM = 15;

// a small fixed palette, cycled - keeps neighbouring cells visually distinct
// without needing per-postcode colour logic
const PALETTE = [
  "#3a6fd8", "#2a9d54", "#e6a23c", "#c1121f", "#8e5fd8",
  "#22a6b3", "#d9527a", "#5a8f29", "#c77b2c", "#4a6fa5",
];

function normalizeName(s) {
  return (s || "").trim().toLowerCase().replace(/\s+/g, " ");
}

const params = new URLSearchParams(window.location.search);
const wardName = params.get("ward") || "";

document.getElementById("wp-ward-name").textContent = wardName || "No ward specified";

const map = L.map("wp-map", { zoomControl: true }).setView([50.78, -3.75], 13);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors",
}).addTo(map);

map.on("zoomend", () => {
  document.getElementById("wp-map").classList.toggle("show-pc-labels", map.getZoom() >= PC_LABEL_MIN_ZOOM);
});

function showStatus(msg) {
  const el = document.getElementById("wp-status");
  el.textContent = msg;
  el.classList.remove("hidden");
}

async function init() {
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

    const outlineLayer = L.geoJSON(outlineFeature, {
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

    map.fitBounds(outlineLayer.getBounds(), { padding: [20, 20] });
    document.getElementById("wp-count").textContent = `${cellFeatures.length} postcodes`;
    document.getElementById("wp-map").classList.toggle("show-pc-labels", map.getZoom() >= PC_LABEL_MIN_ZOOM);
  } catch (e) {
    console.error(e);
    showStatus(
      `Couldn't load postcode data for "${wardName}" - if you opened this file directly, ` +
      `serve the folder with a local web server instead (browsers block loading local files via fetch()).`
    );
  }
}

init();
