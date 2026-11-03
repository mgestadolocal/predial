import json, sys
from concurrent.futures import ThreadPoolExecutor
sys.path.insert(0, "tools")
import importlib.util
spec = importlib.util.spec_from_file_location("c", "tools/catalogo_comunas.py")
src = open("tools/catalogo_comunas.py", encoding="utf-8").read().split("todo = []")[0]
ns = {"__file__": "tools/catalogo_comunas.py"}; exec(src, ns)
sii = json.load(open("data_build/comunas_sii.json", encoding="utf-8"))
ya = {s["cod"] for s in sii}
provs = {s["cod"] // 100 for s in sii} | {r*10+p for r in (13,14,15,16) for p in range(1,10)}
cods = [rp*100 + cc for rp in sorted(provs) for cc in range(1, 100) if rp*100+cc not in ya]
print(len(cods), "códigos a probar")
with ThreadPoolExecutor(8) as ex:
    res = list(ex.map(ns["probar"], cods))
nuevos = [r for r in res if isinstance(r, dict)]
print("nuevos:", [(r["cod"], r["layer"]) for r in nuevos], "errores:", sum(r == "ERR" for r in res))
sii = sorted(sii + nuevos, key=lambda x: x["cod"])
json.dump(sii, open("data_build/comunas_sii.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(len(sii), "total")
