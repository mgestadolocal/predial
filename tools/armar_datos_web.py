"""Genera web/data/comunas.json y web/data/comunas.geojson (contornos simplificados) desde
data_build/comunas_sii.json (catálogo SII) + data_build/bcn_comunas.gpkg (límites BCN)."""
import json, re, unicodedata, geopandas as gpd
from pathlib import Path
def n(s): return re.sub(r"[^a-z]", "", unicodedata.normalize("NFKD", str(s)).encode("ascii","ignore").decode().lower())
ALIAS = {"sanpedroatacama":"sanpedrodeatacama","lacalera":"calera","llayllay":"llaillay","sanfcomostazal":"mostazal",
 "quintatilcoco":"quintadetilcoco","trehuaco":"treguaco","sanpedrolapaz":"sanpedrodelapaz","sanjuanlacosta":"sanjuandelacosta",
 "puertonatales":"natales","sanjosemaipo":"sanjosedemaipo","paguirrecerda":"pedroaguirrecerda","santiagocentro":"santiago"}
REG = {1:"Tarapacá",2:"Antofagasta",3:"Atacama",4:"Coquimbo",5:"Valparaíso",6:"O'Higgins",7:"Maule",8:"Biobío",
 9:"La Araucanía",10:"Los Lagos",11:"Aysén",12:"Magallanes",13:"Metropolitana",14:"Los Ríos",15:"Arica y Parinacota",16:"Ñuble"}
ORDEN = [15,1,2,3,4,5,13,6,7,16,8,9,14,10,11,12]
ROMANO = {15:"XV",1:"I",2:"II",3:"III",4:"IV",5:"V",13:"RM",6:"VI",7:"VII",16:"XVI",8:"VIII",9:"IX",14:"XIV",10:"X",11:"XI",12:"XII"}
sii = json.load(open("data_build/comunas_sii.json", encoding="utf-8"))
g = gpd.read_file("data_build/bcn_comunas.gpkg").to_crs(4326)
g["k"] = g["Comuna"].map(n)
g["geometry"] = g.geometry.make_valid()
g = g.dissolve("k", aggfunc="first").reset_index()
out, feats, sin = [], [], []
for s in sii:
    k = n(s["layer"].replace("sii:BR_CART_","").replace("_WMS",""))
    k = ALIAS.get(k, k)
    row = g[g.k == k]
    item = {"cod": s["cod"], "layer": s["layer"], "region": s["region"], "lat": round(s["lat"],5), "lon": round(s["lon"],5)}
    if row.empty:
        item["nombre"] = s["layer"].replace("sii:BR_CART_","").replace("_WMS","").replace("_"," ").title()
        sin.append(item["nombre"])
    else:
        r = row.iloc[0]; item["nombre"] = r["Comuna"]; item["region"] = int(r["reg"])
        geom = r.geometry
        item["bbox"] = [round(v, 4) for v in geom.bounds]
        feats.append({"cod": s["cod"], "geometry": geom})
    out.append(item)
# Santiago Centro/Oeste/Sur comparten límite BCN "Santiago": nombres SII
stgo = next(c for c in out if c["cod"] == 13101)
for it in out:
    if it["cod"] in (13134, 13135):
        it["bbox"] = stgo["bbox"]; it["region"] = 13
    if it["cod"] in (13101, 13134, 13135):
        it["nombre"] = {13101:"Santiago Centro",13134:"Santiago Oeste",13135:"Santiago Sur"}[it["cod"]]
regiones = [{"id": r, "nombre": REG[r], "romano": ROMANO[r]} for r in ORDEN if any(c["region"] == r for c in out)]
Path("web/data").mkdir(parents=True, exist_ok=True)
json.dump({"regiones": regiones, "comunas": sorted(out, key=lambda c: c["nombre"])},
          open("web/data/comunas.json", "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
gf = gpd.GeoDataFrame(feats, crs=4326)
gf["geometry"] = gf.to_crs(32719).simplify(600).to_crs(4326)
gf = gf.drop_duplicates("cod")
gf.to_file("web/data/comunas.geojson", driver="GeoJSON", COORDINATE_PRECISION=4)
print(len(out), "comunas; sin límite:", sin)
print("regiones SII:", sorted({c["region"] for c in out}))
