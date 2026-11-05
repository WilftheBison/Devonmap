"""Build data/elections.json (ward and constituency results, council control) and
data/ward-households.json (households per ward, 2021 Census) for the map.

Inputs, all in this folder:
  raw/<District>_<year>.txt   ward results, one file per council election, in the format
                              "# Ward|turnout %|optional note" then "name|party|votes|%|E" lines
                              (E = elected; votes blank = elected unopposed). % is the share of
                              ballot papers, as councils and Wikipedia report it, so in
                              multi-seat wards the shares add up to more than 100.
  CONSTITUENCIES / NOTIONAL / COUNCILS below (typed once from the sources named in SOURCES).

Run from the repo root:  python3 tools/elections/build_elections.py
"""
import json, os, sys
sys.path.insert(0, os.path.dirname(__file__))
from parse_raw import parse, norm, RAW

SOURCES = [
    "District results 2019 and 2023, Exeter 2023, 2024 and 2026: Wikipedia election pages, which reproduce each council's declarations of result.",
    "2024 general election: Exeter Observer's Devon results page (returning officers' declarations).",
    "Notional 2019 general election on 2024 boundaries (Rallings & Thrasher, for the BBC/ITV/Sky/PA): Wikipedia constituency pages and PollCheck. North Devon's boundary did not change, so its notional result is the actual 2019 result.",
    "Council control and seats: Wikipedia council pages and PollCheck, as of the date shown for each council.",
]

PARTIES = {  # code: [name, colour]
    "Con": ["Conservative", "#0087DC"], "Lab": ["Labour", "#E4003B"], "LD": ["Liberal Democrat", "#FAA61A"],
    "Grn": ["Green", "#02A95B"], "Ref": ["Reform UK", "#12B6CF"], "Ind": ["Independent", "#9AA0A6"],
    "Lib": ["Liberal", "#EB7A43"], "UKIP": ["UKIP", "#70147A"], "EDA": ["East Devon Alliance", "#8E44AD"],
    "SDA": ["South Devon Alliance", "#1F8A8A"], "Heritage": ["Heritage Party", "#0D0D80"],
    "TUSC": ["TUSC", "#EC008C"], "Brx": ["Brexit Party", "#5BC0DE"], "BF": ["Britain First", "#4A2C2A"],
    "CP": ["Christian Peoples Alliance", "#813887"], "POW": ["Party of Women", "#C71585"],
    "Volt": ["Volt", "#502379"], "Comm": ["Communist", "#C00000"], "Oth": ["Other", "#BBBBBB"],
    "NOC": ["No overall control", "#555555"],
}
ALIASES = {"Alliance": "SDA", "HRT": "Heritage", "VOLT": "Volt", "Communist": "Comm", "Britain First": "BF",
           "No description": "Ind", "Lab Co-op": "Lab"}

def pcode(p):
    p = ALIASES.get(p, p)
    return p if p in PARTIES else "Oth"

# --- council elections: which raw files are "last" and "previous" for each district -------------
DISTRICT_ELECTIONS = {d: [("2023", "4 May 2023"), ("2019", "2 May 2019")]
                      for d in ["East Devon", "Mid Devon", "North Devon", "South Hams", "Teignbridge", "Torridge", "West Devon"]}
DISTRICT_ELECTIONS["Exeter"] = [("2026", "7 May 2026"), ("2024", "2 May 2024")]
LATE = {("West Devon", "2023", "burrator"): "15 June 2023 (postponed poll)",
        ("North Devon", "2019", "chittlehampton"): "13 June 2019 (postponed poll)"}

# Mid Devon's wards were redrawn in 2023: show the nearest 2019 ward(s), flagged as different boundaries.
MID_DEVON_2019 = {
    "crediton boniface": ["boniface"], "crediton lawrence": ["lawrence"], "tiverton castle": ["castle"],
    "tiverton cranmore": ["cranmore"], "tiverton lowman": ["lowman"], "tiverton westexe": ["westexe"],
    "upper yeo and taw": ["upper yeo", "taw"],
    "cullompton padbrook": [], "cullompton st andrews": [], "cullompton vale": [],
}

# --- constituencies: 2024 results (from the Exeter Observer) --------------------------------------
CONSTITUENCIES = {
    "Central Devon": (71.25, 75385, [("Mel Stride","Con",16831,31.50,1),("Ollie Pearson","Lab",16770,31.39),("Mark Wooding","LD",8232,15.41),("Jeffrey Leeks","Ref",7784,14.57),("Gill Westcott","Grn",3338,6.25),("Stephen Price","Ind",477,0.89)]),
    "Exeter": (59.57, 67840, [("Steve Race","Lab",18225,45.34,1),("Tessa Tucker","Con",6288,15.64),("Andrew Bell","Grn",5907,14.70),("Lee Bunker","Ref",4914,12.23),("Will Aczel","LD",4201,10.45),("William Poulter","Ind",466,1.16),("Robert Spain","Ind",194,0.48)]),
    "Exmouth and Exeter East": (64.36, 79983, [("David Reed","Con",14728,28.70,1),("Helen Dallimore","Lab",14607,28.46),("Paul Arnott","LD",11387,22.19),("Garry Sutherland","Ref",7095,13.82),("Olly Davey","Grn",2331,4.54),("Daniel Wilson","Ind",590,1.15),("Peter Faithfull","Ind",454,0.88),("Mark Baldwin","CP",134,0.26)]),
    "Honiton and Sidmouth": (67.24, 75537, [("Richard Foord","LD",23007,45.42,1),("Simon Jupp","Con",16307,32.19),("Paul Quickenden","Ref",6289,12.42),("Jake Bonetta","Lab",2947,5.82),("Henry Gent","Grn",1394,2.75),("Vanessa Coxon","Ind",467,0.92),("Hazel Exon","POW",244,0.48)]),
    "Newton Abbot": (65.18, 73885, [("Martin Wrigley","LD",15201,31.67,1),("Anne Marie Morris","Con",12955,26.99),("Christopher Hilditch","Ref",8494,17.70),("Jacob Cousens","Lab",7115,14.83),("Pauline Wynter","Grn",2083,4.34),("Liam Mullone","SDA",1924,4.01),("Andre Sabine","Heritage",116,0.24),("Annaliese Cude","Volt",104,0.22)]),
    "North Devon": (65.19, 79079, [("Ian Roome","LD",21820,42.44,1),("Selaine Saxby","Con",15076,29.32),("Nigel Howard","Ref",8137,15.83),("Nicky Edwards","Lab",3216,6.25),("Cas Lay","Grn",2348,4.57),("Stephen Cotten","Ind",820,1.59)]),
    "South Devon": (68.01, 72261, [("Caroline Voaden","LD",22540,46.00,1),("Anthony Mangnall","Con",15413,31.45),("Michael Bagley","Ref",6363,12.98),("Daniel Steel","Lab",3066,6.26),("Robert Bagnell","Grn",1497,3.05),("Becca Collings","Heritage",125,0.26)]),
    "South West Devon": (67.48, 77600, [("Rebecca Smith","Con",17916,34.29,1),("Sarah Allen","Lab",15804,30.25),("Steve Horner","Ref",9361,17.92),("Julian Brazil","LD",5551,10.63),("Lauren McLay","Grn",2925,5.60),("Alan Spencer","Ind",438,0.84),("Ben Davy","TUSC",141,0.27),("Darryl Ingram","Heritage",106,0.20)]),
    "Tiverton and Minehead": (66.18, 72087, [("Rachel Gilmour","LD",18326,38.59,1),("Ian Liddell-Grainger","Con",14819,31.20),("Fred Keen","Ref",7787,16.40),("Jonathan Barter","Lab",4325,9.11),("Laura Buchanan","Grn",2234,4.70)]),
    "Torridge and Tavistock": (68.19, 74776, [("Geoffrey Cox","Con",16049,31.58,1),("Phil Hutty","LD",12099,23.81),("Isabel Saxby","Lab",10765,21.18),("Andrew Jackson","Ref",9152,18.01),("Judy Maciejowska","Grn",2350,4.62),("Alan Rayner","Ind",405,0.80)]),
}
# Notional 2019 on 2024 boundaries: (turnout %, majority or None, [(party, %, votes or None)])
NOTIONAL = {
    "Central Devon": (77.2, 17300, [("Con",55.3,None),("Lab",24.8,None),("LD",15.0,None),("Grn",4.9,None)]),
    "Exeter": (67.4, 10988, [("Lab",54.8,None),("Con",32.1,None),("Grn",9.3,None),("Brx",2.6,None),("Oth",1.2,None)]),
    "Exmouth and Exeter East": (74.9, 8809, [("Con",49.8,None),("Ind",34.7,None),("Lab",10.5,None),("LD",3.0,None),("Grn",1.7,None),("Brx",0.3,None)]),
    "Honiton and Sidmouth": (76.4, 26229, [("Con",60.4,None),("Lab",14.2,None),("Oth",12.0,None),("LD",9.6,None),("Grn",2.1,None),("Brx",1.7,None)]),
    "Newton Abbot": (71.8, None, [("Con",55.6,29117),("LD",22.2,11661),("Lab",17.7,9287),("Grn",2.9,1505),("Oth",1.6,840)]),
    "North Devon": (72.7, 14813, [("Con",56.6,None),("LD",30.0,None),("Lab",9.2,None),("Grn",3.2,None),("Oth",1.0,None)]),
    "South Devon": (75.6, 13719, [("Con",53.6,None),("LD",28.2,None),("Lab",17.0,None),("Oth",1.0,None),("Grn",0.2,None)]),
    "South West Devon": (74.4, None, [("Con",62.6,35102),("Lab",21.4,12012),("LD",12.1,6807),("Grn",3.9,2179)]),
    "Tiverton and Minehead": (69.8, None, [("Con",61.3,30297),("LD",19.5,9632),("Lab",14.3,7070),("Grn",4.3,2103),("Ind",0.6,309)]),
    "Torridge and Tavistock": (73.1, None, [("Con",59.8,32708),("LD",17.9,9809),("Lab",17.9,9761),("Grn",3.4,1843),("Oth",1.0,547)]),
}
# --- councils: current control -----------------------------------------------------------------
COUNCILS = {
    "East Devon":  ("NOC", "Paul Arnott (Lib Dem)", {"Ind":21,"LD":21,"Con":12,"Grn":3,"Lib":1,"Vacant":2}, "June 2026"),
    "Exeter":      ("NOC", "Phil Bialyk (Labour minority)", {"Lab":18,"Grn":10,"LD":5,"Ref":3,"Ind":2,"Con":1}, "May 2026"),
    "Mid Devon":   ("LD", "Luke Taylor (Lib Dem)", {"LD":35,"Con":3,"Grn":3,"Ind":1}, "June 2025"),
    "North Devon": ("LD", "David Clayton (Lib Dem)", {"LD":24,"Ind":8,"Con":7,"Grn":3}, "April 2026"),
    "South Hams":  ("LD", "Dan Thomas (Lib Dem)", {"LD":19,"Con":7,"Grn":3,"Lab":1,"Ind":1}, "2023 election (latest listed)"),
    "Teignbridge": ("LD", "Richard Keeling (Lib Dem)", {"LD":25,"Ind":12,"Con":9,"Ref":1}, "August 2026"),
    "Torridge":    ("NOC", "Ken James (Independent)", {"Ind":13,"LD":12,"Con":5,"Grn":4,"Lab":2}, "December 2025"),
    "West Devon":  ("NOC", "Mandy Ewings (Independent)", {"Con":11,"Ind":10,"LD":5,"Grn":4,"Lab":1}, "May 2025"),
}

def result(r, date):
    cands = [{"n": c["name"], "p": pcode(c["party"]), "v": c["votes"], "pc": c["pct"], "e": c["elected"]} for c in r["cands"]]
    cands.sort(key=lambda c: (-(c["v"] or 0), not c["e"]))
    out = {"date": date, "turnout": r["turnout"], "seats": sum(c["e"] for c in cands), "cands": cands}
    if all(c["v"] is None for c in cands): out["unopposed"] = True
    if r.get("note"): out["note"] = r["note"]
    return out

def held_from(results):
    held = {}
    for res in results:
        for c in res["cands"]:
            if c["e"]: held[c["p"]] = held.get(c["p"], 0) + 1
    return held

def main():
    wards_geo = json.load(open("data/wards.geojson"))["features"]
    cons_of = {norm(f["properties"]["name"]): f["properties"]["constituency"]
               for f in json.load(open("data/constituency-wards.geojson"))["features"]}
    loaded = {}
    def get(d, y):
        if (d, y) not in loaded: loaded[(d, y)] = parse(os.path.join(RAW, f"{d}_{y}.txt"))
        return loaded[(d, y)]
    exeter23 = parse(os.path.join(RAW, "Exeter_2023_winners.txt"))
    tribes = {norm(w["name"]): w for w in json.load(open("data/tribes.json"))["wards"].values()}
    wards = {}
    for f in wards_geo:
        name, dist = f["properties"]["name"], f["properties"]["district"]
        k = norm(name)
        (ly, ld), (py, pd) = DISTRICT_ELECTIONS[dist]
        last = result(get(dist, ly)[k], LATE.get((dist, ly, k), ld))
        tw = tribes[k]
        rec = {"name": name, "district": dist, "constituency": cons_of.get(k), "code": tw["code"], "seats": tw["seats"], "last": last}
        if dist == "Mid Devon" and k in MID_DEVON_2019:
            olds = MID_DEVON_2019[k]
            rec["prev"] = [dict(result(get(dist, py)[o], LATE.get((dist, py, o), pd)), ward=get(dist, py)[o]["ward"]) for o in olds]
            rec["prevNote"] = ("Ward boundaries were redrawn in 2023. " +
                               ("Shown: the nearest 2019 ward" + ("s" if len(olds) > 1 else "") + ", which covered different ground."
                                if olds else "The 2019 Cullompton wards (North, South, Outer) don't match the new wards closely enough to compare."))
        else:
            pr = get(dist, py).get(k)
            rec["prev"] = [result(pr, LATE.get((dist, py, k), pd))] if pr else []
        # seats held, as elected
        if dist == "Exeter":
            res = [last, rec["prev"][0]]
            if last["seats"] < 2: res.append(result(exeter23[k], "4 May 2023"))
            held = held_from(res)
            rec["heldNote"] = "Councillors elected in 2023, 2024 and 2026 (Exeter elects a third of the council at a time)."
        else:
            held = held_from([last])
        rec["held"] = held
        top = max(held.values())
        leaders = [p for p, n in held.items() if n == top]
        if len(leaders) > 1:  # tie: party of the best-polling winner at the last election
            for c in last["cands"]:
                if c["e"] and c["p"] in leaders: leaders = [c["p"]]; break
        rec["party"] = leaders[0]
        rec["split"] = len(held) > 1
        wards[k] = rec
    cons = {}
    for c, (turnout, electorate, cands) in CONSTITUENCIES.items():
        cl = [{"n": n, "p": pcode(p), "v": v, "pc": pc, "e": bool(e[0]) if e else False} for n, p, v, pc, *e in cands]
        cl.sort(key=lambda x: -x["v"])
        nt, nm, ns = NOTIONAL[c]
        cons[c] = {"party": cl[0]["p"], "mp": cl[0]["n"], "majority": cl[0]["v"] - cl[1]["v"],
                   "last": {"date": "4 July 2024", "turnout": turnout, "electorate": electorate, "cands": cl},
                   "prev": {"date": "12 December 2019", "notional": c != "North Devon", "turnout": nt, "majority": nm,
                            "shares": [{"p": p, "pc": pc, "v": v} for p, pc, v in ns]}}
    councils = {d: {"control": ctl, "leader": lead, "seats": seats, "asOf": asof,
                    "total": sum(n for p, n in seats.items())} for d, (ctl, lead, seats, asof) in COUNCILS.items()}
    out = {"note": "Election results for the Devon map. Ward party = the party holding most of the ward's seats as elected "
                   "at the last full election (Exeter: the 2023, 2024 and 2026 winners); later by-elections and defections are not shown "
                   "in the ward colours. Council control is current as of the date given.",
           "sources": SOURCES, "built": "5 November 2026", "parties": PARTIES,
           "councils": councils, "wards": wards, "constituencies": cons}
    json.dump(out, open("data/elections.json", "w"), ensure_ascii=False, separators=(",", ":"))

    # households per ward (2021 Census, household tenure total = occupied homes)
    D = json.load(open("data/ward-census-2021-detail.json"))
    T = json.load(open("data/tribes.json"))["wards"]
    hh = {w["code"]: sum(D[w["code"]]["hh_tenure_5a"].values()) for w in T.values()}
    json.dump({"note": "Households per ward (occupied homes), 2021 Census household tenure totals, keyed by ward code.",
               "households": hh}, open("data/ward-households.json", "w"), separators=(",", ":"))

    # checks
    seats = {}
    for w in wards.values():
        if w["district"] != "Exeter": seats[w["district"]] = seats.get(w["district"], 0) + w["last"]["seats"]
    print("seats at last full election:", seats)
    print("ward party counts:", {p: sum(1 for w in wards.values() if w["party"] == p) for p in PARTIES if any(w["party"] == p for w in wards.values())})
    print("households total:", sum(hh.values()), "wards", len(hh))

if __name__ == "__main__":
    main()
