"""Arma el catálogo de comunas SII (código, capa WMS, centro, región) probando getServicioPredio.
Código SII = región antigua + provincia + comuna (2 dígitos). Salida: data_build/comunas_sii.json
"""
import json, time, threading, requests
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

URL = "https://www4.sii.cl/mapasui/services/data/mapasFacadeService/getServicioPredio"
H = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
     "Referer": "https://www4.sii.cl/mapasui/index.html", "Origin": "https://www4.sii.cl",
     "Content-Type": "application/json;charset=UTF-8", "Accept": "application/json, text/plain, */*"}
local = threading.local()

def sess():
    if not hasattr(local, "s"):
        local.s = requests.Session(); local.s.headers.update(H)
    return local.s

def probar(cod):
    p = {"data": {"comuna": cod, "eac": -1}, "metaData": {
        "namespace": "cl.sii.sdi.lob.bbrr.mapas.data.api.interfaces.MapasFacadeService/getServicioPredio",
        "conversationId": "UNAUTHENTICATED-CALL", "transactionId": f"cat-{cod}-{int(time.time()*1000)}"}}
    for i in range(3):
        try:
            r = sess().post(URL, json=p, timeout=20)
            if r.status_code == 200:
                d = r.json().get("data") or []
                for s in d:
                    if s.get("aliasServicio") == "P":
                        return {"cod": cod, "layer": s["layer"], "lat": s["latitud"], "lon": s["longitud"],
                                "zoom": s["zoom"], "region": s["region"]}
                return None
        except Exception:
            time.sleep(2 * (i + 1))
    return "ERR"

def provincia(rp):
    r, p = rp
    hits, miss, cc = [], 0, 1
    while cc <= 99:
        res = probar(r * 1000 + p * 100 + cc)
        if isinstance(res, dict):
            hits.append(res); miss = 0
        else:
            miss += 1
        if (not hits and cc >= 4) or miss >= 8:
            break
        cc += 1
    return hits

todo = []
with ThreadPoolExecutor(6) as ex:
    for hits in ex.map(provincia, [(r, p) for r in range(1, 17) for p in range(1, 10)]):
        todo += hits
todo.sort(key=lambda x: x["cod"])
Path(__file__).resolve().parent.parent.joinpath("data_build/comunas_sii.json").write_text(
    json.dumps(todo, ensure_ascii=False, indent=1), encoding="utf-8")
print(len(todo), "comunas")
