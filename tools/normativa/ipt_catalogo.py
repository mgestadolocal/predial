"""Arma web/data/normativa/ipt.json: qué capas del servicio IPT (MINVU, publicado por la SMA)
corresponden a cada comuna del catálogo del SII.

Servicio: https://ideserver.sma.gob.cl/arcgis/rest/services/IDE/MINVU/MapServer
Uso: python tools/normativa/ipt_catalogo.py
"""
import json, re, unicodedata, urllib.request
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[2]
SERVICIO = "https://ideserver.sma.gob.cl/arcgis/rest/services/IDE/MINVU/MapServer"
n = lambda s: re.sub(r"[^a-z]", "", unicodedata.normalize("NFD", s.lower()).encode("ascii", "ignore").decode())

# Nombre de la capa (normalizado) -> nombre de la comuna en el catálogo (normalizado)
ALIAS = {
    "diegoalmagro": ["diegodealmagro"], "paiguano": ["paihuano"], "quintatilcoco": ["quintadetilcoco"],
    "freirequepe": ["freire"], "lonquimayvillaportales": ["lonquimay"], "padredelascasas": ["padrelascasas"],
    "puertosaavedra": ["saavedra"], "reinacotijeral": ["renaico"], "quinchaoachao": ["quinchao"], "melinka": ["guaitecas"],
    "puertoaysen": ["aysen"], "puertochacabuco": ["aysen"], "puertonatales": ["natales"], "puertowilliiams": ["cabodehornos"],
    "puntadelgadasangregorio": ["sangregorio"], "rioserrano": ["torresdelpaine"], "tehuelcheslagunablanca": ["lagunablanca"],
    "santiago": ["santiagocentro", "santiagooeste", "santiagosur"], "pintotermas": ["pinto"],
}
METRO = {13: [544, 545, 546, 542], 8: [540]}   # PRMS (suelo, rural, riesgo, quebradas) y PRM Concepción


def main():
    req = urllib.request.Request(SERVICIO + "/layers?f=json", headers={"User-Agent": "Mozilla/5.0"})
    capas = {l["id"]: l for l in json.load(urllib.request.urlopen(req, timeout=120))["layers"]}
    cat = json.load(open(RAIZ / "web/data/comunas.json", encoding="utf-8"))
    por_nombre = {}
    for c in cat["comunas"]:
        por_nombre.setdefault(n(c["nombre"]), []).append(c)

    def hojas(i):
        l = capas[i]
        if l["type"] == "Feature Layer":
            return [i]
        return [h for s in (l.get("subLayers") or []) for h in hojas(s["id"])]

    salida = {}
    for top in capas.values():
        if top.get("parentLayer") or not top["name"].startswith("PRC"):
            continue
        for s in top.get("subLayers") or []:
            l = capas[s["id"]]
            if "mite urbano" in l["name"] or "Desarrollo Urbano" in l["name"]:
                continue
            for destino in ALIAS.get(n(l["name"]), [n(l["name"])]):
                for c in por_nombre.get(destino, []):
                    salida.setdefault(str(c["cod"]), {"prc": []})["prc"] += hojas(l["id"])
    for c in cat["comunas"]:
        if c["region"] in METRO:
            salida.setdefault(str(c["cod"]), {"prc": []})["metro"] = METRO[c["region"]]
    for v in salida.values():
        v["prc"] = sorted(set(v["prc"]))
    nombres = {str(i): capas[i]["name"].strip() for v in salida.values() for i in v["prc"] + v.get("metro", [])}
    ruta = RAIZ / "web/data/normativa/ipt.json"
    ruta.write_text(json.dumps({"servicio": SERVICIO, "comunas": salida, "capas": nombres}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    con = sum(1 for v in salida.values() if v["prc"])
    print(ruta, f"{con} comunas con PRC, {len(salida)} con alguna capa, de {len(cat['comunas'])}")


main()
