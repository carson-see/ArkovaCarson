import json, os, sys, time, urllib.error, urllib.request
out_dir = sys.argv[1]
hashes = [h.strip() for h in open(os.path.join(out_dir, "hashes.txt")) if h.strip()]
res_path = os.path.join(out_dir, "explorer_heights.json")
results = json.load(open(res_path)) if os.path.exists(res_path) else {}
HOSTS = {"blockstream": "https://blockstream.info/api/block/{h}", "mempool": "https://mempool.space/api/block/{h}"}
UA = "arkova-prod-block-height-audit/1.0 (read-only audit)"
def get(url):
    for attempt in range(6):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=20) as r:
                return r.status, r.read().decode()
        except urllib.error.HTTPError as e:
            if e.code == 429 or e.code >= 500:
                time.sleep(2 ** attempt)
                continue
            return e.code, e.read().decode()[:200]
        except Exception:
            time.sleep(2 ** attempt)
    return None, "exhausted"
n = 0
for h in hashes:
    entry = results.get(h, {})
    for host, tmpl in HOSTS.items():
        if host in entry and entry[host].get("height") is not None:
            continue
        status, body = get(tmpl.format(h=h))
        rec = {"status": status}
        if status == 200:
            try:
                j = json.loads(body)
                rec["height"] = j.get("height")
                rec["timestamp"] = j.get("timestamp")
                rec["tx_count"] = j.get("tx_count")
            except Exception as ex:
                rec["error"] = "parse: " + str(ex)
        else:
            rec["error"] = str(body)
        entry[host] = rec
        n += 1
        time.sleep(0.5)
    results[h] = entry
    if n and n % 20 == 0:
        json.dump(results, open(res_path, "w"))
        print("progress", len(results), "/", len(hashes), flush=True)
json.dump(results, open(res_path, "w"))
print("DONE", len(results), flush=True)
