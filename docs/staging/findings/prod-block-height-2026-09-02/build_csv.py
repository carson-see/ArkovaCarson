"""Join prod anchor_proofs / anchors (hash,height) groups with explorer heights -> blocks.csv + summary."""
import csv
import json
import sys
from collections import defaultdict

out_dir = sys.argv[1]
pairs = json.load(open(out_dir + "/prod_pairs.json"))
anchors = json.load(open(out_dir + "/anchors_pairs.json"))
explorer = json.load(open(out_dir + "/explorer_heights.json"))

anchors_by_hash = defaultdict(list)
for r in anchors:
    anchors_by_hash[r["chain_block_hash"]].append(r)

proof_hashes = {r["block_hash"] for r in pairs if r["block_hash"]}
all_hashes = sorted(proof_hashes | set(anchors_by_hash))

rows = []
for r in pairs:
    h = r["block_hash"]
    if not h:
        continue
    ex = explorer.get(h, {})
    bs = ex.get("blockstream", {}).get("height")
    mp = ex.get("mempool", {}).get("height")
    agree = (bs is not None and mp is not None and bs == mp)
    chain = bs if bs is not None else mp
    a = anchors_by_hash.get(h, [])
    a_h = a[0]["chain_block_height"] if len(a) == 1 else (";".join(str(x["chain_block_height"]) for x in a) if a else None)
    a_rows = sum(x["anchors"] for x in a) if a else 0
    proof_delta = (chain - r["block_height"]) if (chain is not None and r["block_height"] is not None) else None
    a_delta = (chain - a[0]["chain_block_height"]) if (chain is not None and len(a) == 1) else None
    rows.append({
        "block_hash": h,
        "proof_block_height": r["block_height"],
        "proof_row_count": r["row_count"],
        "proof_min_created": r["min_created"],
        "proof_max_created": r["max_created"],
        "anchors_chain_block_height": a_h,
        "anchors_row_count": a_rows,
        "blockstream_height": bs,
        "mempool_height": mp,
        "explorers_agree": agree,
        "chain_minus_proof": proof_delta,
        "chain_minus_anchors": a_delta,
        "proof_height_correct": (proof_delta == 0) if proof_delta is not None else None,
        "anchors_height_correct": (a_delta == 0) if a_delta is not None else None,
        "block_timestamp_utc": ex.get("blockstream", {}).get("timestamp") or ex.get("mempool", {}).get("timestamp"),
    })
# anchors-only hashes (no anchor_proofs row)
for h in sorted(set(anchors_by_hash) - proof_hashes):
    ex = explorer.get(h, {})
    bs = ex.get("blockstream", {}).get("height")
    mp = ex.get("mempool", {}).get("height")
    chain = bs if bs is not None else mp
    a = anchors_by_hash[h]
    a_delta = (chain - a[0]["chain_block_height"]) if (chain is not None and len(a) == 1) else None
    rows.append({
        "block_hash": h,
        "proof_block_height": None, "proof_row_count": 0, "proof_min_created": None, "proof_max_created": None,
        "anchors_chain_block_height": a[0]["chain_block_height"] if len(a) == 1 else ";".join(str(x["chain_block_height"]) for x in a),
        "anchors_row_count": sum(x["anchors"] for x in a),
        "blockstream_height": bs, "mempool_height": mp,
        "explorers_agree": (bs is not None and mp is not None and bs == mp),
        "chain_minus_proof": None, "chain_minus_anchors": a_delta,
        "proof_height_correct": None, "anchors_height_correct": (a_delta == 0) if a_delta is not None else None,
        "block_timestamp_utc": ex.get("blockstream", {}).get("timestamp") or ex.get("mempool", {}).get("timestamp"),
    })

rows.sort(key=lambda x: ((x["blockstream_height"] or x["mempool_height"] or 0), x["block_hash"], x["proof_block_height"] or 0))
fields = list(rows[0].keys())
with open(out_dir + "/blocks.csv", "w", newline="") as fh:
    w = csv.DictWriter(fh, fieldnames=fields)
    w.writeheader()
    w.writerows(rows)

# summary
checked = [h for h in all_hashes if explorer.get(h, {}).get("blockstream", {}).get("height") is not None or explorer.get(h, {}).get("mempool", {}).get("height") is not None]
both = [h for h in all_hashes if explorer.get(h, {}).get("blockstream", {}).get("height") is not None and explorer.get(h, {}).get("mempool", {}).get("height") is not None]
agree = [h for h in both if explorer[h]["blockstream"]["height"] == explorer[h]["mempool"]["height"]]
missing = [h for h in all_hashes if h not in checked]
proof_pairs = [r for r in rows if r["proof_block_height"] is not None]
pp_correct = [r for r in proof_pairs if r["proof_height_correct"] is True]
pp_wrong = [r for r in proof_pairs if r["proof_height_correct"] is False]
rows_wrong = sum(r["proof_row_count"] for r in pp_wrong)
rows_right = sum(r["proof_row_count"] for r in pp_correct)
hash_wrong = {r["block_hash"] for r in pp_wrong}
hash_all_pairs_right = {r["block_hash"] for r in pp_correct} - hash_wrong
a_checked = [r for r in rows if r["anchors_height_correct"] is not None]
a_wrong = [r for r in a_checked if r["anchors_height_correct"] is False]
deltas = defaultdict(int)
for r in pp_wrong:
    deltas[r["chain_minus_proof"]] += r["proof_row_count"]
print("distinct hashes (proofs U anchors):", len(all_hashes))
print("hashes resolved on >=1 explorer:", len(checked), "on both:", len(both), "both agree:", len(agree), "unresolved:", len(missing), missing[:5])
print("(hash,proof_height) pairs:", len(proof_pairs), "correct pairs:", len(pp_correct), "wrong pairs:", len(pp_wrong))
print("proof rows wrong:", rows_wrong, "proof rows correct:", rows_right)
print("distinct hashes with >=1 wrong pair:", len(hash_wrong), "hashes fully correct:", len(hash_all_pairs_right))
print("anchors (hash,height) checked:", len({r['block_hash'] for r in a_checked}), "anchors wrong:", len(a_wrong), [(r['block_hash'][-8:], r['chain_minus_anchors']) for r in a_wrong][:10])
print("delta distribution (chain - proof) by rows:", dict(sorted(deltas.items())))
neg = [r for r in pp_wrong if r["chain_minus_proof"] is not None and r["chain_minus_proof"] < 0]
print("pairs with proof height ABOVE chain:", len(neg))
