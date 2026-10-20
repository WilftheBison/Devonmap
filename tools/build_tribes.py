"""Build data/tribes.json for the scenario tool.

Inputs:
  census.json   {ward_code: {dimension: {option_id: count}}}  (ONS Census 2021 API pulls)
  Ward_data.csv  ward list, codes, district, constituency, seats, residents
  ruc11-wards.json  rural-urban mix per ward (from the Devon map repo)

Each tribe gets a raw weight per ward from census proportions; weights are
scaled so the county-wide average share of each tribe matches a plausible
target split, then normalised so a ward's seven shares sum to 100%.
"""
import csv, json, re, sys

census = json.load(open(sys.argv[1]))
ruc = json.load(open(sys.argv[2]))["wards"]
out_path = sys.argv[3]

norm = lambda s: re.sub(r"\s+", " ", (s or "").strip().lower().replace("&", "and"))
ruc_n = {norm(k): v for k, v in ruc.items()}

TARGETS = {"crediton boniface", "taw vale", "okehampton north", "hatherleigh", "bovey", "ashburton and buckfastleigh"}

TRIBES = [
    dict(id="mtw", name="Market Town Workers", colour="#e4572e", turnout=0.75,
         desc="Working people in the towns: routine, manual and service jobs, many renting. Cost of living, housing, wages, immigration."),
    dict(id="lt", name="Land and Trades", colour="#8c6d31", turnout=1.0,
         desc="Farmers, contractors, self-employed trades and rural workers. Planning, regulation, rural crime, farm incomes."),
    dict(id="sp", name="Settled Patriots", colour="#2f4b7c", turnout=1.35,
         desc="Older residents, mostly retired, without degrees, often owning outright. Borders, law and order, council tax, national identity."),
    dict(id="wf", name="Working Families", colour="#f4a259", turnout=0.95,
         desc="Working-age households in clerical, supervisory and junior managerial jobs, usually mortgaged. Bills, schools, services, getting on."),
    dict(id="yf", name="Young and Fed Up", colour="#d62f7f", turnout=0.5,
         desc="Aged 16 to 29 without degrees, often renting or living with parents. Housing, jobs, a sense nobody listens."),
    dict(id="tp", name="Town Progressives", colour="#3fa34d", turnout=0.9,
         desc="Working-age graduates in the towns, often renting. Environment, public services, social liberalism. Lean Green or Labour."),
    dict(id="cs", name="Comfortable Shires", colour="#7a5195", turnout=1.3,
         desc="Affluent professionals and graduate retirees, in villages and on the retirement coast. Lean Lib Dem or Conservative, Remain."),
]

# Rough county-wide average shares (% of adults) the raw weights are calibrated to.
TARGET_SPLIT = {"mtw": 15, "lt": 12, "sp": 20, "wf": 14, "yf": 10, "tp": 11, "cs": 18}

PRESETS = [
    dict(id="current", name="Current offer", desc="Our message as it stands: strong with working people in town and country and older patriots, off-putting to progressives.",
         appeal=dict(mtw=2, lt=2, sp=2, wf=1, yf=1, tp=-2, cs=-1)),
    dict(id="youth", name="Youth push", desc="Lead on housing and jobs for the young, at some cost with older and affluent voters.",
         appeal=dict(mtw=2, lt=1, sp=1, wf=1, yf=3, tp=-1, cs=-2)),
    dict(id="towns", name="Towns first", desc="Cost of living and local services in the market towns.",
         appeal=dict(mtw=3, lt=1, sp=1, wf=2, yf=2, tp=-1, cs=-2)),
    dict(id="rural", name="Rural first", desc="Farming, planning and rural crime; less on town issues.",
         appeal=dict(mtw=1, lt=3, sp=2, wf=1, yf=0, tp=-2, cs=0)),
    dict(id="patriots", name="Older patriots", desc="Borders, law and order and council tax, aimed at older voters.",
         appeal=dict(mtw=1, lt=2, sp=3, wf=0, yf=-1, tp=-2, cs=0)),
    dict(id="broad", name="Broad church", desc="A softer, wider pitch that puts nobody off.",
         appeal=dict(mtw=2, lt=2, sp=2, wf=2, yf=1, tp=0, cs=0)),
]


def g(d, k):
    return float(d.get(str(k), 0) or 0)


rows = list(csv.DictReader(open(sys.argv[4])))
# Optional: Electoral Calculus ward-level 2016 Leave estimates (wardcode, leaveshare)
leave = {}
if len(sys.argv) > 5:
    for e in csv.DictReader(open(sys.argv[5])):
        leave[e["wardcode"]] = float(e["leaveshare"])
mean_leave = sum(leave.values()) / len(leave) if leave else 0.5
raw, facts, meta = {}, {}, {}
for r in rows:
    code, name = r["Ward code"], r["Ward"]
    c = census[code]
    a4a, a4b = c["resident_age_4a"], c["resident_age_4b"]
    u16 = g(a4a, 1)
    p16 = g(a4a, 2) + g(a4a, 3) + g(a4a, 4)
    y = (g(a4a, 2) + g(a4a, 3)) / p16
    o65 = g(a4b, 4) / p16
    mid = max(0.0, 1 - y - o65)
    q = c["highest_qualification"]
    qtot = sum(g(q, k) for k in range(0, 7))
    grad, noq = g(q, 5) / qtot, g(q, 0) / qtot
    n = c["ns_sec_10a"]
    ntot = sum(g(n, k) for k in range(1, 10))
    ns = {k: g(n, k) / ntot for k in range(1, 10)}
    ab = ns[1] + ns[2]
    rm = ns[6] + ns[7]
    t = c["hh_tenure_5a"]
    htot = sum(g(t, k) for k in range(0, 4))
    rent = (g(t, 2) + g(t, 3)) / htot
    mort = g(t, 1) / htot
    mix = ruc_n[norm(name)]["mix"]
    urb = sum(v for k, v in mix.items() if k[0] in "ABCD") / 100.0
    rur = 1 - urb
    working = ns[5] + ns[6] + ns[7] + ns[8]
    lv = leave.get(code, mean_leave)
    lf, rf = lv / mean_leave, (1 - lv) / (1 - mean_leave)  # Leave / Remain lean relative to the Devon average
    raw[norm(name)] = {
        "mtw": urb * working * (1 - o65) * (0.6 + rent) * lf ** 0.5,
        "lt": (rur * (ns[4] + working) * (1 - o65) + urb * ns[4] * 0.4) * lf ** 0.5,
        "sp": o65 * (1 - grad) * lf,
        "wf": mid * (ns[3] + ns[5] + 0.5 * ns[2]) * (0.6 + mort) * (1 - 0.5 * grad),
        "yf": max(0.0, y - ns[9] * ntot / p16) * (1 - grad),
        "tp": rf ** 0.5 * urb * grad * (1 - o65) * (0.7 + rent) + urb * ns[9] * ntot / p16 * 0.8,
        "cs": (ab * rur * 0.8 + o65 * grad + ab * urb * 0.25) * rf,
    }
    facts[norm(name)] = dict(residents=int(u16 + p16), town=round(urb * 100), y=round(y * 100, 1), o65=round(o65 * 100, 1),
                             grad=round(grad * 100, 1), rm=round(rm * 100, 1), own=round(ns[4] * 100, 1), rent=round(rent * 100, 1), noq=round(noq * 100, 1), leave=round(lv * 100, 1))
    cons = r["Parliamentary constituency (2024 boundaries)"].replace(" (split ward)", "").split(" / ")
    meta[norm(name)] = dict(name=name, code=code, district=r["District"], constituencies=cons, seats=int(float(r["Councillors elected"])))

ids = [t["id"] for t in TRIBES]
scale = {i: 1.0 for i in ids}
for _ in range(50):  # iterative proportional fitting of the county averages
    shares = {}
    for k, rw in raw.items():
        s = {i: rw[i] * scale[i] for i in ids}
        tot = sum(s.values())
        shares[k] = {i: s[i] / tot * 100 for i in ids}
    for i in ids:
        avg = sum(sh[i] for sh in shares.values()) / len(shares)
        scale[i] *= TARGET_SPLIT[i] / avg

wards = {}
for k in raw:
    wards[k] = dict(meta[k], target=k in TARGETS, shares={i: round(shares[k][i], 1) for i in ids}, facts=facts[k])

json.dump(dict(
    note="Estimated voter-tribe mix per Devon district ward. Built from 2021 Census (ONS API: age, highest qualification, NS-SeC, household tenure; Mid Devon summed from Output Areas to 2023 wards) the 2011 rural-urban classification, and Electoral Calculus ward-level estimates of the 2016 Leave vote. Estimates for comparing strategies, not measurements.",
    tribes=TRIBES, presets=PRESETS, target_split=TARGET_SPLIT, wards=wards), open(out_path, "w"), indent=0)
print("wards", len(wards))
