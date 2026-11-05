"""Parse tools/elections/raw/<District>_<year>.txt into dicts. Shared by build_elections.py."""
import os, re
RAW = os.path.join(os.path.dirname(__file__), "raw")
def norm(s):
    return re.sub(r"\s+", " ", s.strip().lower().replace("&", "and").replace("’", "'").replace(".", ""))
def parse(path):
    wards, cur = {}, None
    for line in open(path, encoding="utf-8"):
        line = line.strip()
        if not line: continue
        if line.startswith("#"):
            name, _, rest = line[1:].strip().partition("|")
            parts = rest.split("|")
            cur = {"ward": name.strip(), "turnout": float(parts[0]) if parts[0] else None, "cands": []}
            if len(parts) > 1 and parts[1]: cur["note"] = parts[1]
            wards[norm(name)] = cur
            continue
        f = line.split("|") + ["", "", "", ""]
        cur["cands"].append({"name": f[0].strip(), "party": f[1].strip(),
                             "votes": int(f[2].replace(",", "")) if f[2].strip() else None,
                             "pct": float(f[3]) if f[3].strip() else None, "elected": f[4].strip() == "E"})
    return wards
