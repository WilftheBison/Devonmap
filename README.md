# Devon Boundaries

A small self-contained web map, installable as an app on an iPad (or any
device) home screen. County boundary always shown, plus a switch
between two boundary systems - **District Councils** (districts + their
wards) or **Parliamentary Constituencies** (constituencies + their wards,
once that data's added) - so the two never clutter the map at once. A
sidebar lets you pin your own data onto whichever wards layer is active,
and a ward detail page lists every postcode in a chosen ward, with a
polygon map of them in a new window.

No backend, no build step, no account - it's a handful of static files
plus a service worker for offline use. The map tiles come from
OpenStreetMap and the two JS libraries (Leaflet, PapaParse) load from
public CDNs; everything else, including any CSV you upload, stays in your
own browser.

## Installing on an iPad

This needs to be hosted somewhere reachable over HTTPS first (see
"Running it" below - GitHub Pages is the easiest free option) - Safari
won't offer "Add to Home Screen" as a proper app for a page opened
straight from a local file.

1. Open the hosted URL in **Safari** on the iPad (has to be Safari, not
   Chrome or another browser - only Safari can add a standalone app).
2. Tap the Share icon, then **Add to Home Screen**.
3. Open it from the home screen icon from then on: it launches full-screen
   with no address bar, and works offline for everything except the base
   map tiles (the boundaries, labels, popups, pinned data and postcode
   lookups all still work with no connection; only the OpenStreetMap
   imagery itself needs one).

One iOS quirk worth knowing: the "Postcode map" button opens in a new
window, which is how desktop browsers handle it - but iOS doesn't support
multiple standalone windows for one installed app, so on the iPad that
link opens in ordinary Safari instead, dropping out of the full-screen
app view. The postcode map itself still works fine there; you're just
back in a normal browser tab rather than the app shell until you switch
back.

## Running it

Browsers block a page from loading local files via `fetch()` when you just
double-click `index.html`, so this needs to be served, not opened directly.

**Quickest, for a look on your own machine:**

```
cd devon-map
python3 -m http.server 8000
```

then open `http://localhost:8000`.

**On your own server:** point any static file host (Apache, Nginx, Caddy)
at this folder as the document root, or a sub-path of it.

**On GitHub Pages:** push this folder to a repo, then in the repo's
Settings -> Pages, set the source to the branch/folder it's in. GitHub
gives you a URL within a minute or two.

## Postcode map

From a ward's popup ("Postcode map") or its full detail page ("Open
postcode map"), a new window opens showing that ward zoomed in with every
postcode drawn as a polygon, not just listed as text.

Individual postcodes don't have an official boundary anywhere - ONSPD only
gives each one a centre point - so these polygons are a Voronoi
tessellation computed from those points and clipped to the ward outline:
each cell is "closer to this postcode than any other," which gives a
genuinely useful visual but is a geometric approximation, not an
authoritative boundary. A handful of postcodes share an identical
coordinate (ONS snaps some blocks/buildings to one point); those share one
cell and are listed together in its tooltip rather than being dropped.

Data lives in `data/postcode-cells/` - one small GeoJSON file per ward
(`_slugs.json` maps ward name to filename), generated once from the same
ONSPD extract as `postcodes-by-ward.json`. To regenerate after a newer
ONSPD edition, redo the Voronoi step against the new postcode points and
overwrite these files - `ward-postcodes.html` / `ward-postcodes.js` don't
need to change.

## Ward detail page

Pick a ward from the "Ward detail" dropdown in the sidebar (or click a ward
on the map and use "View full ward page" in its popup) for a full-page view
of that one ward: its data (whatever's currently pinned), and every live
postcode inside it - 31,379 postcodes across all 168 wards, bundled in
`data/postcodes-by-ward.json` (source: ONS Postcode Directory, May 2026,
filtered to live postcodes only). Ward geometry is shared between District
Councils and Parliamentary Constituencies mode, so this one file covers
both.

To refresh it later (a newer ONSPD edition, or a wider area): group
postcode -> ward-name pairs into the same shape -

```json
{ "Axminster": ["EX13 5AA", "EX13 5AB", "..."], "...": ["..."] }
```

and overwrite the file - nothing else needs to change.

## Adding the Parliamentary Constituencies layer

The "Parliamentary Constituencies" tab is in the sidebar already, but shows
a "boundary data hasn't been loaded" message until two more files exist:

```
data/constituencies.geojson       one Feature per constituency, {name}
data/constituency-wards.geojson   one Feature per ward/building-block,
                                   {name, constituency}
```

Same shape as `districts.geojson` / `wards.geojson` - a plain GeoJSON
FeatureCollection, `district` swapped for `constituency` in the ward
properties. Once both files are in `data/`, the tab lights up automatically
- nothing else in the app needs to change.

## Pinning your own data

In the sidebar, under "Pinned data," upload a CSV with:

- a column named `ward` (or containing "ward") holding ward names to match
  against whichever wards layer is currently showing - matching is case-
  and whitespace-insensitive
- any other columns you like

Those columns then show in each ward's popup. Any column that's entirely
numeric also becomes available in the "Colour wards by" dropdown, which
gives a simple two-colour choropleth (pale yellow to red, low to high);
wards with no value for the chosen column show grey, labelled "no data" in
the legend, rather than being left blank.

The data is saved to your browser's local storage, so it's still there next
time you open the page - "Clear pinned data" removes it. Nothing is
uploaded anywhere; it's a client-side join, done in your browser, against
the ward name.

The map ships with 2021 Census data (`data/ward-census-data.csv` - total
residents, % aged 50+, % AB-equivalent, % routine/manual) pinned onto
district wards by default. Five Mid Devon wards (Cullompton Padbrook/St
Andrews/Vale, Upper Yeo & Taw, Yeo) show "no data": the 2023 boundary
review split and re-merged older wards into these, and the 2021 Census was
published against the old boundaries, so there's no direct 1:1 figure for
them without a proper output-area-level re-aggregation.

## Files

```
index.html                        the page
style.css                         styling
app.js                             map logic - modes, layers, popups, CSV join, choropleth
data/county.geojson
data/districts.geojson
data/wards.geojson
data/ward-census-data.csv          bundled default dataset (district wards)
data/constituencies.geojson        (add to enable the Constituencies tab)
data/constituency-wards.geojson    (add to enable the Constituencies tab)
```

## Extending it

- **A different base map**: swap the `L.tileLayer(...)` URL in `app.js` for
  any other XYZ tile source.
- **Editing boundaries by hand, or letting colleagues add markers/notes
  directly in the browser**: this setup doesn't do that - it's read-only
  boundaries plus a data join. For free-hand drawing and editing, something
  like uMap (self-hosted or via a public instance) is a better fit; this
  can sit alongside it rather than replace it.

## Data sources

Boundaries: Office for National Statistics / Ordnance Survey open data,
via the Saturday Walkers Club boundary KML service
(https://maps.walkingclub.org.uk/admin/), used here for non-commercial
reference. Census: 2021 Census, Office for National Statistics. Base map:
(c) OpenStreetMap contributors (https://www.openstreetmap.org/copyright).

