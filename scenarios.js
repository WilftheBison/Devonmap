/* Voter tribes scenario tool.
   Each ward carries an estimated mix of seven voter tribes (data/tribes.json,
   built from the 2021 Census + rural-urban mix). The user sets how strongly
   our message appeals to each tribe (-2 puts them off ... +3 core). A ward's
   score is the average appeal across its (optionally turnout-weighted)
   tribe mix; wards are ranked by score, and the rank is compared with the
   "Current offer" preset. Scenarios can be shared via the URL hash. */

const SLIDER_MIN = -2, SLIDER_MAX = 3;
const norm = (s) => (s || "").trim().toLowerCase().replace(/&/g, "and").replace(/\s+/g, " ");
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let T = null;            // tribes.json
let tribes = [];         // [{id,name,colour,desc,turnout}]
let presets = [];
let appeal = {};         // id -> value
let useTurnout = true;
let area = "Central Devon";
let selected = null;     // normalised ward name
let baselineRanks = {};  // area-specific ranks under the baseline preset
let wardLayer = null;
const layersByWard = {};

const map = L.map("sc-map", { zoomControl: true }).setView([50.75, -3.8], 9);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18, attribution: "&copy; OpenStreetMap contributors" }).addTo(map);

/* ---------- scoring ---------- */
function wardScore(w, a, turnout) {
  let num = 0, den = 0;
  for (const t of tribes) {
    const s = (w.shares[t.id] || 0) * (turnout ? t.turnout : 1);
    num += s * a[t.id]; den += s;
  }
  return den ? num / den : 0;
}
function inArea(w) {
  if (area === "All Devon") return true;
  if (area.startsWith("District: ")) return w.district === area.slice(10);
  return w.constituencies.includes(area);
}
function rankWards(a, turnout) {
  const list = Object.entries(T.wards).filter(([, w]) => inArea(w))
    .map(([k, w]) => ({ k, w, score: wardScore(w, a, turnout) }))
    .sort((x, y) => y.score - x.score);
  list.forEach((r, i) => (r.rank = i + 1));
  return list;
}

/* ---------- colour ---------- */
const RAMP = ["#fff5d6", "#fed976", "#feb24c", "#fd8d3c", "#f03b20", "#bd0026", "#800026"];
function lerp(a, b, t) { return Math.round(a + (b - a) * t); }
function hex(h) { return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)); }
function rampColour(t) {
  t = Math.max(0, Math.min(1, t));
  const p = t * (RAMP.length - 1), i = Math.min(Math.floor(p), RAMP.length - 2), f = p - i;
  const a = hex(RAMP[i]), b = hex(RAMP[i + 1]);
  return `rgb(${lerp(a[0], b[0], f)},${lerp(a[1], b[1], f)},${lerp(a[2], b[2], f)})`;
}

/* ---------- UI build ---------- */
function buildSliders() {
  const box = document.getElementById("sc-sliders");
  box.innerHTML = "";
  for (const t of tribes) {
    const row = document.createElement("div");
    row.className = "sc-slider";
    row.innerHTML = `<span class="sc-name" title="Tap for description"><span class="sc-dot" style="background:${t.colour}"></span>${esc(t.name)}</span>
      <input type="range" min="${SLIDER_MIN}" max="${SLIDER_MAX}" step="1" value="${appeal[t.id]}" aria-label="${esc(t.name)} appeal">
      <span class="sc-val"></span>
      <div class="sc-desc">${esc(t.desc)}</div>`;
    const input = row.querySelector("input"), val = row.querySelector(".sc-val");
    const show = () => (val.textContent = (appeal[t.id] > 0 ? "+" : "") + appeal[t.id]);
    show();
    input.addEventListener("input", () => { appeal[t.id] = +input.value; show(); markPreset(); update(); });
    row.querySelector(".sc-name").addEventListener("click", () => row.classList.toggle("open"));
    t._input = input; t._show = show;
    box.appendChild(row);
  }
}
function setAppeal(values) {
  for (const t of tribes) { appeal[t.id] = values[t.id] ?? 0; if (t._input) { t._input.value = appeal[t.id]; t._show(); } }
}
function buildPresets() {
  const box = document.getElementById("sc-presets");
  for (const p of presets) {
    const b = document.createElement("button");
    b.textContent = p.name; b.title = p.desc; b.dataset.id = p.id;
    b.addEventListener("click", () => { setAppeal(p.appeal); markPreset(); update(); });
    box.appendChild(b);
  }
}
function markPreset() {
  document.querySelectorAll("#sc-presets button").forEach((b) => {
    const p = presets.find((x) => x.id === b.dataset.id);
    b.classList.toggle("active", tribes.every((t) => (p.appeal[t.id] ?? 0) === appeal[t.id]));
  });
}
function buildArea() {
  const sel = document.getElementById("sc-area");
  const cons = [...new Set(Object.values(T.wards).flatMap((w) => w.constituencies))].sort();
  const dists = [...new Set(Object.values(T.wards).map((w) => w.district))].sort();
  sel.innerHTML = `<option>All Devon</option><optgroup label="Constituency">${cons.map((c) => `<option>${esc(c)}</option>`).join("")}</optgroup>` +
    `<optgroup label="District">${dists.map((d) => `<option value="District: ${esc(d)}">${esc(d)}</option>`).join("")}</optgroup>`;
  sel.value = area;
  sel.addEventListener("change", () => { area = sel.value; update(true); });
}

/* ---------- hash (share links) ---------- */
function writeHash() {
  const a = tribes.map((t) => appeal[t.id]).join(",");
  history.replaceState(null, "", `#a:${a};t:${useTurnout ? 1 : 0};v:${encodeURIComponent(area)}`);
}
function readHash() {
  const h = decodeURIComponent(location.hash.slice(1));
  if (!h) return false;
  const parts = Object.fromEntries(h.split(";").map((p) => [p.slice(0, p.indexOf(":")), p.slice(p.indexOf(":") + 1)]));
  if (parts.a) { const v = parts.a.split(",").map(Number); tribes.forEach((t, i) => { if (Number.isFinite(v[i])) appeal[t.id] = Math.max(SLIDER_MIN, Math.min(SLIDER_MAX, v[i])); }); }
  if (parts.t !== undefined) useTurnout = parts.t === "1";
  if (parts.v) area = parts.v;
  return true;
}

/* ---------- render ---------- */
function update(fit) {
  const base = presets[0].appeal;
  baselineRanks = {};
  rankWards(base, useTurnout).forEach((r) => (baselineRanks[r.k] = r.rank));
  const list = rankWards(appeal, useTurnout);
  const byKey = Object.fromEntries(list.map((r) => [r.k, r]));
  const lo = list.length ? list[list.length - 1].score : 0, hi = list.length ? list[0].score : 1;
  const span = hi - lo || 1;

  wardLayer.eachLayer((layer) => {
    const k = norm(layer.feature.properties.name), r = byKey[k], w = T.wards[k];
    const isTarget = w && w.target;
    if (!r) {
      layer.setStyle({ fillColor: "#888", fillOpacity: 0.08, color: "#666", weight: 0.6, opacity: 0.5 });
    } else {
      layer.setStyle({ fillColor: rampColour((r.score - lo) / span), fillOpacity: 0.72, color: isTarget ? "#111" : "#444",
        weight: isTarget ? 3 : (k === selected ? 3 : 0.8), opacity: 1, dashArray: k === selected ? "4 3" : null });
    }
    layer.setTooltipContent(r ? `<b>${esc(layer.feature.properties.name)}</b><br>#${r.rank} &middot; score ${r.score.toFixed(2)}` : esc(layer.feature.properties.name));
  });

  renderTable(list);
  renderLegend(lo, hi);
  if (selected) renderDetail(selected, byKey[selected]);
  document.getElementById("sc-turnout").checked = useTurnout;
  writeHash();
  if (fit) fitArea();
}

function renderTable(list) {
  document.getElementById("sc-rank-title").textContent = `Ranking: ${area.replace("District: ", "")}`;
  document.getElementById("sc-rank-sub").textContent = `${list.length} wards. ★ = current target ward. Click a ward for its tribe mix.`;
  const tb = document.querySelector("#sc-table tbody");
  tb.innerHTML = list.map((r) => {
    const d = baselineRanks[r.k] - r.rank;
    const ch = d > 0 ? `<span class="up">▲${d}</span>` : d < 0 ? `<span class="down">▼${-d}</span>` : "&ndash;";
    return `<tr data-k="${esc(r.k)}" class="${r.w.target ? "target" : ""} ${r.k === selected ? "sel" : ""}">
      <td>${r.rank}</td><td>${esc(r.w.name)}${r.w.target ? ' <span class="sc-star">\u2605</span>' : ""}<span class="sc-ward-dist">${esc(r.w.district)}</span></td>
      <td class="num">${r.score.toFixed(2)}</td><td class="num">${ch}</td><td class="num">${r.w.seats}</td></tr>`;
  }).join("");
  tb.querySelectorAll("tr").forEach((tr) => tr.addEventListener("click", () => selectWard(tr.dataset.k, true)));
}

function renderDetail(k, r) {
  const w = T.wards[k], box = document.getElementById("sc-detail");
  if (!w) { box.classList.add("hidden"); return; }
  const shares = tribes.map((t) => ({ t, s: w.shares[t.id] || 0 }));
  const bar = shares.map(({ t, s }) => `<span style="width:${s}%;background:${t.colour}" title="${esc(t.name)} ${s.toFixed(0)}%"></span>`).join("");
  const rows = shares.slice().sort((a, b) => b.s - a.s).map(({ t, s }) =>
    `<tr><td><span class="sc-dot" style="display:inline-block;background:${t.colour}"></span> ${esc(t.name)}</td><td class="num">${s.toFixed(0)}%</td><td class="num">${appeal[t.id] > 0 ? "+" : ""}${appeal[t.id]}</td></tr>`).join("");
  const f = w.facts;
  box.innerHTML = `<button class="sc-close" aria-label="Close">&times;</button>
    <h3>${esc(w.name)}${w.target ? " ★" : ""}</h3>
    <div class="sc-dim">${esc(w.district)} &middot; ${w.seats} seat${w.seats > 1 ? "s" : ""} &middot; ${Number(f.residents).toLocaleString()} residents &middot; ${f.town}% town</div>
    <div class="sc-dim">${r ? `Rank #${r.rank} in ${esc(area.replace("District: ", ""))}, score ${r.score.toFixed(2)}` : "Outside the selected area"}</div>
    <div class="sc-bar">${bar}</div>
    <table class="sc-mix"><tr class="sc-dim"><td>Estimated tribe mix (adults)</td><td class="num">Share</td><td class="num">Appeal</td></tr>${rows}</table>
    <div class="sc-dim" style="margin-top:8px">Census: aged 16&ndash;29 ${f.y}%, 65+ ${f.o65}%, graduates ${f.grad}%, routine/manual ${f.rm}%, own-account ${f.own}%, renting ${f.rent}%.</div>`;
  box.classList.remove("hidden");
  box.querySelector(".sc-close").addEventListener("click", () => { selected = null; box.classList.add("hidden"); update(); });
}

let legendCtl = null;
function renderLegend(lo, hi) {
  if (!legendCtl) {
    legendCtl = L.control({ position: "bottomleft" });
    legendCtl.onAdd = () => { const d = L.DomUtil.create("div", "sc-legend"); d.id = "sc-legend"; return d; };
    legendCtl.addTo(map);
  }
  const grad = `linear-gradient(to right, ${RAMP.join(",")})`;
  document.getElementById("sc-legend").innerHTML = `Appeal score in this area<div class="ramp" style="background:${grad}"></div><div class="ends"><span>${lo.toFixed(2)}</span><span>${hi.toFixed(2)}</span></div>`;
}

function selectWard(k, zoom) {
  selected = k;
  update();
  if (zoom && layersByWard[k]) map.fitBounds(layersByWard[k].getBounds(), { maxZoom: 12, padding: [30, 30] });
  document.querySelectorAll("#sc-table tr.sel").forEach((tr) => tr.scrollIntoView({ block: "nearest" }));
}
function fitArea() {
  const b = L.latLngBounds([]);
  wardLayer.eachLayer((l) => { const w = T.wards[norm(l.feature.properties.name)]; if (w && inArea(w)) b.extend(l.getBounds()); });
  if (b.isValid()) map.fitBounds(b, { padding: [20, 20] });
}

/* ---------- boot ---------- */
(async function init() {
  const [tj, gj] = await Promise.all([fetch("data/tribes.json").then((r) => r.json()), fetch("data/wards.geojson").then((r) => r.json())]);
  T = tj; tribes = T.tribes; presets = T.presets;
  setAppeal(presets[0].appeal);
  readHash();
  if (area !== "All Devon" && !area.startsWith("District: ") && !Object.values(T.wards).some((w) => w.constituencies.includes(area))) area = "All Devon";

  wardLayer = L.geoJSON(gj, {
    style: { weight: 0.8, color: "#444", fillOpacity: 0.7 },
    onEachFeature: (f, layer) => {
      const k = norm(f.properties.name);
      layersByWard[k] = layer;
      layer.bindTooltip(esc(f.properties.name), { sticky: true });
      layer.on("click", () => selectWard(k, false));
    },
  }).addTo(map);

  buildSliders(); buildPresets(); buildArea(); markPreset();
  document.getElementById("sc-turnout").addEventListener("change", (e) => { useTurnout = e.target.checked; update(); });
  document.getElementById("sc-share").addEventListener("click", async () => {
    writeHash();
    const msg = document.getElementById("sc-share-msg");
    try { await navigator.clipboard.writeText(location.href); msg.textContent = "Link copied. Anyone opening it sees these settings."; }
    catch (e) { msg.textContent = "Copy this link: " + location.href; }
  });
  update(true);
})();
