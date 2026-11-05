"""Compare golden results: python (argv[1]) vs node (argv[2]).
Prints per-area match counts and the first differing case details."""
import json
import sys
from collections import defaultdict

py = json.load(open(sys.argv[1]))
node = json.load(open(sys.argv[2]))
spec = json.load(open("/home/hatch/workspace/packet-tracer-mcp-node/scripts/golden_cases.json"))
area_of = {c["id"]: c["area"] for c in spec["cases"]}

stats = defaultdict(lambda: [0, 0])
mismatches = []
for cid, p in py.items():
    n = node.get(cid)
    area = area_of.get(cid, "?")
    stats[area][1] += 1
    if n is not None and n.get("kind") == p.get("kind") and n.get("value") == p.get("value"):
        stats[area][0] += 1
    else:
        mismatches.append(cid)

total_ok = sum(v[0] for v in stats.values())
total = sum(v[1] for v in stats.values())
for area in sorted(stats):
    ok, tot = stats[area]
    print(f"{area:28s} {ok}/{tot}")
print(f"{'TOTAL':28s} {total_ok}/{total}")
if mismatches:
    print("\nMISMATCHES:")
    for cid in mismatches:
        print(f"--- {cid}")
        p, n = py[cid], node.get(cid)
        print(f"  py:   {json.dumps(p, ensure_ascii=False)[:300]}")
        print(f"  node: {json.dumps(n, ensure_ascii=False)[:300] if n else 'MISSING'}")
