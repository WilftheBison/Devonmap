"""Rebuild the main map's census layer (data/ward-census-data.csv) and the target-ward layer
(data/top-wards.json) from the exact 2021 Census counts in data/ward-census-2021-detail.json,
so every view of the map uses the same figures as the tribes model (data/tribes.json).

Measures (unchanged from the original spreadsheet method):
  total residents = sum of resident_age_4a
  % aged 50+      = resident_age_4b categories 3+4 / total
  % AB-equivalent = NS-SeC 1+2 / NS-SeC 1-9
  % routine/manual= NS-SeC 6+7 / NS-SeC 1-9
Target-ward layer: per constituency, top ten by routine/manual share ("share") and top ten by
fewest residents per seat contested ("seat"; Exeter elects by thirds, so one seat per ward); wards in both are ranked by the sum of the two ranks ("crank").
Ward codes, districts, seats and constituencies come from tribes.json. Councillor-confidence
flags ("conf") are carried over from the previous top-wards.json where present.
Run from the repo root:  python3 tools/build_census_layers.py
"""
import json, csv, os
D = json.load(open("data/ward-census-2021-detail.json"))
T = json.load(open("data/tribes.json"))["wards"]
old = json.load(open("data/top-wards.json")) if os.path.exists("data/top-wards.json") else {}
oldcsv = {r["ward"]: r for r in csv.DictReader(open("data/ward-census-data.csv"))}

def s(d, *ks): return sum(d.get(str(k), 0) for k in ks)
rows, rec = [], {}
for key, w in T.items():
    c = D[w["code"]]
    res = s(c["resident_age_4a"], 1, 2, 3, 4)
    a50 = 100 * s(c["resident_age_4b"], 3, 4) / res
    ns = s(c["ns_sec_10a"], *range(1, 10))
    ab = 100 * s(c["ns_sec_10a"], 1, 2) / ns
    rm = 100 * s(c["ns_sec_10a"], 6, 7) / ns
    rec[key] = dict(ward=w["name"], district=w["district"], code=w["code"], split=len(w["constituencies"]) > 1,
                    seats=w["seats"], residents=res,
                    # Exeter elects by thirds: one seat per ward is up at each election
                    rps=round(res / (1 if w["district"] == "Exeter" else w["seats"])), rm=round(rm, 1), ab=round(ab, 1),
                    a50=round(a50, 1), conf=old.get(key, {}).get("conf", "High"),
                    cons=w["constituencies"], share=[], seat=[], both=[])
    # keep the CSV's ward spelling so pinned-data matching is unchanged
    name = next((n for n in oldcsv if n.lower().replace("&", "and") == w["name"].lower().replace("&", "and")), w["name"])
    note = "2023 boundary: summed from 2021 Output Areas" if w["district"] == "Mid Devon" else ""
    if w["name"] == "Cullompton Vale": note += "; mostly new housing since 2021, check current electorate"
    rows.append([name, w["district"], res, round(a50, 1), round(ab, 1), round(rm, 1), note])

cons = sorted({c for r in rec.values() for c in r["cons"]})
for con in cons:
    ws = [k for k, r in rec.items() if con in r["cons"]]
    by_share = sorted(ws, key=lambda k: -rec[k]["rm"])[:10]
    by_seat = sorted(ws, key=lambda k: rec[k]["rps"])[:10]
    for i, k in enumerate(by_share, 1): rec[k]["share"].append(dict(constituency=con, rank=i))
    for i, k in enumerate(by_seat, 1): rec[k]["seat"].append(dict(constituency=con, rank=i))
    both = [(by_share.index(k) + 1, by_seat.index(k) + 1, k) for k in by_share if k in by_seat]
    both.sort(key=lambda x: (x[0] + x[1], x[0]))
    for i, (a, b, k) in enumerate(both, 1): rec[k]["both"].append(dict(constituency=con, crank=i, share=a, seat=b))

out = {k: {kk: vv for kk, vv in r.items() if kk != "cons"} for k, r in rec.items() if r["share"] or r["seat"]}
json.dump(out, open("data/top-wards.json", "w"), separators=(",", ":"))
with open("data/ward-census-data.csv", "w", newline="") as f:
    wr = csv.writer(f); wr.writerow(["ward", "district", "total_residents", "pct_aged_50_plus", "pct_AB_equivalent", "pct_routine_manual", "notes"])
    order = {n: i for i, n in enumerate(oldcsv)}
    for r in sorted(rows, key=lambda r: order.get(r[0], 999)): wr.writerow(r)
print(len(rows), "wards;", len(out), "in a target list;", len(cons), "constituencies")
