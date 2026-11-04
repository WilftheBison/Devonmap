/* Voter tribes scenario tool.
   Each ward carries an estimated mix of seven voter tribes (data/tribes.json,
   built from the 2021 Census + rural-urban mix). The user sets how strongly
   our message appeals to each tribe (-2 puts them off ... +3 core). A ward's
   score is the average appeal across its (optionally turnout-weighted)
   tribe mix; wards are ranked by score, and the rank is compared with the
   "Current offer" preset. The URL hash keeps the current settings. The Print
   button prints exactly what is on screen, on white, at A4 or A3: through the browser's
   print on a computer, and as a PDF handed to the share sheet on an iPad. */

const SLIDER_MIN = -2, SLIDER_MAX = 3;
document.documentElement.classList.toggle("narrow", window.matchMedia("(max-width: 1000px)").matches);
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

const map = L.map("sc-map", { zoomControl: true, preferCanvas: true }).setView([50.75, -3.8], 9);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18, crossOrigin: true, attribution: "&copy; OpenStreetMap contributors" }).addTo(map);

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
  box.innerHTML = `<button class="sc-close" aria-label="Close">&times;</button><button class="sc-tomap">&uarr; Map</button>
    <h3>${esc(w.name)}${w.target ? " ★" : ""}</h3>
    <div class="sc-dim">${esc(w.district)} &middot; ${w.seats} seat${w.seats > 1 ? "s" : ""} &middot; ${Number(f.residents).toLocaleString()} residents &middot; ${f.town}% town</div>
    <div class="sc-dim">${r ? `Rank #${r.rank} in ${esc(area.replace("District: ", ""))}, score ${r.score.toFixed(2)}` : "Outside the selected area"}</div>
    <div class="sc-bar">${bar}</div>
    <table class="sc-mix"><tr class="sc-dim"><td>Estimated tribe mix (adults)</td><td class="num">Share</td><td class="num">Appeal</td></tr>${rows}</table>
    <div class="sc-dim" style="margin-top:8px">Census: aged 16&ndash;29 ${f.y}%, 65+ ${f.o65}%, graduates ${f.grad}%, routine/manual ${f.rm}%, own-account ${f.own}%, renting ${f.rent}%. 2016 Leave (estimate) ${f.leave}%, ${f.lean >= 0 ? f.lean + " pts more" : -f.lean + " pts less"} than its make-up predicts.</div>`;
  box.classList.remove("hidden");
  box.querySelector(".sc-tomap").addEventListener("click", () => document.getElementById("sc-map").scrollIntoView({ block: "start", behavior: "smooth" }));
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
  // show the ward's detail panel (just below the "Ranking" heading), not its table row
  const det = document.getElementById("sc-detail");
  if (det && !det.classList.contains("hidden")) det.scrollIntoView({ block: "end", behavior: "smooth" }); // scroll just far enough to show the whole panel
}
function fitArea() {
  const b = L.latLngBounds([]);
  wardLayer.eachLayer((l) => { const w = T.wards[norm(l.feature.properties.name)]; if (w && inArea(w)) b.extend(l.getBounds()); });
  if (b.isValid()) map.fitBounds(b, { padding: [20, 20] });
}

/* ---------- print ---------- */
// Prints the screen as it is (scroll positions, map zoom and pan) on a white background.
// Nothing is re-laid out: the page is frozen at its current size and scaled to fit the paper.
const PAPER_MM = { A4: [297, 210], A3: [420, 297] };   // landscape width x height
const MARGIN_MM = 8;
let printing = false, printSaved = null, printStartedAt = 0;
function setNarrow() {
  if (printing) return;
  document.documentElement.classList.toggle("narrow", window.matchMedia("(max-width: 1000px)").matches);
}
function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}
// Freeze the page exactly as it is on screen, ready to print or snapshot.
function preparePrint(freeze = true) {
  const root = document.documentElement, W = window.innerWidth, H = window.innerHeight;
  const paper = document.getElementById("sc-paper").value;
  const landscape = W >= H;
  let [pw, ph] = PAPER_MM[paper];
  if (!landscape) [pw, ph] = [ph, pw];
  const usable = (mm) => ((mm - 2 * MARGIN_MM - 8) * 96) / 25.4;   // CSS px, leaving room for the frame
  const scale = Math.min(usable(pw) / W, usable(ph) / H);
  const left = document.getElementById("sc-left"), right = document.getElementById("sc-right");
  printSaved = { sy: window.scrollY, sl: left.scrollTop, sr: right.scrollTop };
  const narrow = root.classList.contains("narrow");
  const set = (k, v) => root.style.setProperty(k, v);
  set("--pw", W + "px"); set("--ph", H + "px"); set("--scale", scale);
  set("--sy", printSaved.sy + "px");
  set("--sl", (narrow ? 0 : printSaved.sl) + "px"); set("--sr", (narrow ? 0 : printSaved.sr) + "px");
  let ps = document.getElementById("sc-page-style");
  if (!ps) { ps = document.createElement("style"); ps.id = "sc-page-style"; document.head.appendChild(ps); }
  ps.textContent = `@page { size: ${paper} ${landscape ? "landscape" : "portrait"}; margin: ${MARGIN_MM}mm; }`;
  const active = document.querySelector("#sc-presets button.active");
  document.getElementById("sc-print-date").textContent =
    `Printed ${new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}` +
    (active ? ` · ${active.textContent}` : " · custom sliders");
  printStartedAt = Date.now();
  if (!freeze) return { W, H, paper, landscape };
  printing = true;
  root.classList.add("printing");
  left.scrollTop = 0; right.scrollTop = 0; window.scrollTo(0, 0);
  return { W, H, paper, landscape };
}
function startPrint() {
  if (printing) return;
  if (isIOS()) { pdfPrint(); return; }
  preparePrint();
  window.print();   // called straight from the tap, or browsers may block it
}

/* iPad: the home-screen app can't use the browser's print, so make a PDF of the screen and hand it
   to the iPad's share sheet, which has Print (and Save to Files). */
function loadScript(src) {
  return new Promise((res, rej) => {
    if (document.querySelector(`script[src="${src}"]`)) return res();
    const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = () => rej(new Error("load " + src));
    document.head.appendChild(s);
  });
}
function showPdfReady(file, url, errMsg) {
  const old = document.getElementById("sc-pdf-ready"); if (old) old.remove();
  const ov = document.createElement("div"); ov.id = "sc-pdf-ready";
  const canShare = file && navigator.canShare && navigator.canShare({ files: [file] });
  ov.innerHTML = errMsg
    ? `<div class="box"><p>${esc(errMsg)}</p><button class="cancel">Close</button></div>`
    : `<div class="box"><p>Your ${esc(file.name.match(/A[34]/)[0])} page is ready.</p>
       ${canShare ? `<button class="go">Print or save&hellip;</button>` : `<a class="go" href="${url}" target="_blank" rel="noopener">Open PDF</a>`}
       <button class="cancel">Close</button></div>`;
  document.body.appendChild(ov);
  const close = () => { ov.remove(); if (url) setTimeout(() => URL.revokeObjectURL(url), 60000); };
  ov.querySelector(".cancel").addEventListener("click", close);
  const go = ov.querySelector("button.go");
  if (go) go.addEventListener("click", async () => {
    try { await navigator.share({ files: [file], title: "Voter tribes" }); close(); }
    catch (e) { if (e && e.name === "AbortError") return; window.open(url, "_blank"); }
  });
}
function mapComposite(scale) {
  const el = document.getElementById("sc-map"), r = el.getBoundingClientRect();
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
  return { canvas: c, rect: r };
}
async function pdfPrint() {
  const btn = document.getElementById("sc-print");
  btn.disabled = true; btn.textContent = "Making PDF…";
  let job;
  try {
    await Promise.all([loadScript("vendor/html2canvas.min.js"), loadScript("vendor/jspdf.umd.min.js")]);
    const narrow = document.documentElement.classList.contains("narrow");
    const sy = window.scrollY;
    // Landscape: the side panels scroll, so freeze them. Portrait: the whole page scrolls,
    // so leave it as it is and cut out the part on screen.
    job = preparePrint(!narrow);
    document.documentElement.classList.add("print-light");
    await new Promise((r) => setTimeout(r, 120));
    const SC = 2, app = document.getElementById("sc-app");
    const mapImg = mapComposite(SC);   // the map, copied layer by layer at its exact on-screen positions
    const page = await window.html2canvas(app, {
      useCORS: true, backgroundColor: null, scale: SC, width: job.W, height: job.H,
      ignoreElements: (el) => el.classList && el.classList.contains("leaflet-map-pane"),
      windowWidth: job.W, windowHeight: job.H, x: 0, y: narrow ? sy : 0, logging: false,
      onclone: (doc) => {
        // html2canvas can't draw range sliders, so swap each for a drawn track and knob (in the copy only)
        doc.querySelectorAll('#sc-sliders input[type="range"]').forEach((inp) => {
          const min = +inp.min, max = +inp.max, f = (+inp.value - min) / (max - min);
          const w = inp.getBoundingClientRect().width || 120;
          const d = doc.createElement("div");
          d.style.cssText = `position:relative;height:16px;width:${w}px`;
          d.innerHTML = `<div style="position:absolute;left:0;right:0;top:6px;height:4px;border-radius:2px;background:#d1d5db"></div>` +
            `<div style="position:absolute;left:0;width:${f * (w - 14) + 7}px;top:6px;height:4px;border-radius:2px;background:#0f766e"></div>` +
            `<div style="position:absolute;left:${f * (w - 14)}px;top:1px;width:14px;height:14px;border-radius:50%;background:#0f766e"></div>`;
          inp.replaceWith(d);
        });
        const m = doc.getElementById("sc-map"); if (m) m.style.background = "transparent";
      },
    });
    const canvas = document.createElement("canvas");
    canvas.width = page.width; canvas.height = page.height;
    const g = canvas.getContext("2d");
    g.fillStyle = "#ffffff"; g.fillRect(0, 0, canvas.width, canvas.height);
    g.drawImage(mapImg.canvas, mapImg.rect.left * SC, mapImg.rect.top * SC);   // on-screen position = position on the page
    g.drawImage(page, 0, 0);
    document.documentElement.classList.remove("print-light");
    endPrint();
    if (narrow) window.scrollTo(0, sy);
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ orientation: job.landscape ? "landscape" : "portrait", unit: "mm", format: job.paper.toLowerCase() });
    const pw = pdf.internal.pageSize.getWidth(), ph = pdf.internal.pageSize.getHeight();
    const pad = MARGIN_MM + 4, frame = 3;
    const s = Math.min((pw - 2 * pad) / job.W, (ph - 2 * pad) / job.H);
    const w = job.W * s, h = job.H * s, x = (pw - w) / 2, y = (ph - h) / 2;
    pdf.setFillColor(229, 231, 235); pdf.setDrawColor(156, 163, 175); pdf.setLineWidth(0.3);
    pdf.roundedRect(x - frame, y - frame, w + 2 * frame, h + 2 * frame, 5, 5, "FD");
    pdf.addImage(canvas.toDataURL("image/jpeg", 0.92), "JPEG", x, y, w, h);
    const blob = pdf.output("blob");
    const day = new Date().toISOString().slice(0, 10);
    const file = new File([blob], `Voter tribes ${day} ${job.paper}.pdf`, { type: "application/pdf" });
    showPdfReady(file, URL.createObjectURL(blob));
  } catch (e) {
    document.documentElement.classList.remove("print-light");
    endPrint();
    showPdfReady(null, null, "Sorry, the PDF couldn't be made (" + (e && e.message ? e.message : e) + "). Check you're online and try again.");
  } finally {
    btn.disabled = false; btn.textContent = "Print";
  }
}
function endPrint() {
  if (!printing) return;
  printing = false;
  const root = document.documentElement;
  root.classList.remove("printing");
  const left = document.getElementById("sc-left"), right = document.getElementById("sc-right");
  left.scrollTop = printSaved.sl; right.scrollTop = printSaved.sr; window.scrollTo(0, printSaved.sy);
  setNarrow();
}
function setupPrint() {
  const sel = document.getElementById("sc-paper");
  try { const p = localStorage.getItem("sc-paper"); if (p && PAPER_MM[p]) sel.value = p; } catch (e) { /* no storage */ }
  sel.addEventListener("change", () => { try { localStorage.setItem("sc-paper", sel.value); } catch (e) { /* no storage */ } });
  document.getElementById("sc-print").addEventListener("click", startPrint);
  // Desktop browsers block during print, so afterprint means done. On the iPad the print sheet
  // opens without blocking, so print mode ends on the next touch of the page instead.
  window.addEventListener("afterprint", () => { if (Date.now() - printStartedAt > 1500) endPrint(); });
  ["pointerdown", "touchstart", "wheel", "keydown"].forEach((ev) =>
    window.addEventListener(ev, () => { if (printing && Date.now() - printStartedAt > 800) endPrint(); }, { capture: true, passive: true }));
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
  document.getElementById("sc-reset").addEventListener("click", () => { setAppeal(presets[0].appeal); markPreset(); update(); });
  document.getElementById("sc-turnout").addEventListener("change", (e) => { useTurnout = e.target.checked; update(); });
  setupPrint();
  const sizeMap = () => {
    if (printing) return;
    setNarrow();
    const narrow = document.documentElement.classList.contains("narrow");
    const el = document.getElementById("sc-map");
    el.style.height = narrow ? Math.max(360, window.innerHeight - document.getElementById("sc-left").offsetHeight) + "px" : "";
    map.invalidateSize();
  };
  window.addEventListener("resize", sizeMap);
  window.addEventListener("orientationchange", () => setTimeout(sizeMap, 300));
  sizeMap();
  update(true);
})();
