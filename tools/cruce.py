import json, unicodedata, re, geopandas as gpd, pandas as pd
def n(s): return re.sub(r"[^a-z]", "", unicodedata.normalize("NFKD", str(s)).encode("ascii","ignore").decode().lower())
sii = json.load(open("data_build/comunas_sii.json", encoding="utf-8"))
gs = []
for r in range(1, 17):
    try:
        g = gpd.read_file(f"https://raw.githubusercontent.com/caracena/chile-geojson/master/{r}.geojson"); g["reg"] = r; gs.append(g)
    except Exception as e: print("reg", r, e)
g = pd.concat(gs); print(g.columns.tolist(), len(g))
g["k"] = g["Comuna"].map(n)
for s in sii:
    s["k"] = n(s["layer"].replace("sii:BR_CART_","").replace("_WMS",""))
ks = {s["k"] for s in sii}
print("BCN sin match SII:", sorted(set(g.k) - ks))
print("SII sin match BCN:", sorted((s["cod"], s["k"]) for s in sii if s["k"] not in set(g.k)))
g.to_file("data_build/bcn_comunas.gpkg")
