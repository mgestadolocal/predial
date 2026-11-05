"""Servidor de prueba: sirve web/ y replica las rutas /predio, /rol y /direccion del Worker.
Uso: python tools/servidor_local.py   ->  http://localhost:8787/?api=http://localhost:8787
"""
import json, re, time, requests
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse, parse_qs

WEB = Path(__file__).resolve().parent.parent / "web"
SII = "https://www4.sii.cl/mapasui/services/data/mapasFacadeService/"
H = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
     "Referer": "https://www4.sii.cl/mapasui/index.html", "Origin": "https://www4.sii.cl",
     "Content-Type": "application/json;charset=UTF-8", "Accept": "application/json, text/plain, */*"}
S = requests.Session(); S.headers.update(H)

def sii(ep, data):
    p = {"data": data, "metaData": {"namespace": "cl.sii.sdi.lob.bbrr.mapas.data.api.interfaces.MapasFacadeService/" + ep,
         "conversationId": "UNAUTHENTICATED-CALL", "transactionId": f"web-{int(time.time()*1000)}"}}
    r = S.post(SII + ep, json=p, timeout=20)
    try: txt = r.content.decode("utf-8")
    except UnicodeDecodeError: txt = r.content.decode("cp1252")
    return json.loads(txt).get("data") if r.ok else None

class H_(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=str(WEB), **k)
    def responder(self, obj, st=200):
        b = json.dumps(obj).encode(); self.send_response(st)
        self.send_header("Content-Type", "application/json"); self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        u = urlparse(self.path); q = {k: v[0] for k, v in parse_qs(u.query).items()}
        if u.path == "/predio":
            if not re.fullmatch(r"sii:BR_CART_[A-Z0-9_]+_WMS", q.get("layer", "")): return self.responder({"error": "layer"}, 400)
            lat, lon, cod, d = float(q["lat"]), float(q["lon"]), int(q["cod"]), 0.0005
            r = sii("getFeatureInfo", {"clickInfo": {"x": 400, "y": 300, "southwestx": lat-d, "southwesty": lon-d,
                    "northeastx": lat+d, "northeasty": lon+d, "width": 800, "height": 600, "layer": q["layer"],
                    "servicios": [{"comuna": cod, "layer": q["layer"], "style": "PREDIOS_WMS_V0", "eac": 0, "eacano": 0}]}})
            return self.responder({"predio": r} if r and r.get("existePredio", -1) != -1 and r.get("manzana") else {"vacio": True})
        if u.path == "/rol":
            r = sii("getPredioNacional", {"predio": {"comuna": int(q["cod"]), "manzana": int(q["manzana"]), "predio": int(q["predio"])}, "servicios": []})
            r = r[0] if isinstance(r, list) and r else r
            return self.responder({"predio": r} if r and r.get("ubicacionX") else {"vacio": True})
        if u.path == "/direccion":
            calle = q.get("calle", "").strip().upper(); num = q.get("numero", "").strip()
            if not re.fullmatch(r"[A-Z0-9Ñ .'-]{2,60}", calle) or not re.fullmatch(r"\d{1,6}", num): return self.responder({"error": "parámetros"}, 400)
            r = sii("getPrediosDireccion", {"rolDireccion": {"comuna": int(q["cod"]), "nombreComuna": "", "calle": calle, "numeroCalleStr": num,
                    "detalle": int(q.get("detalle", 0)), "numeroDetalleStr": q.get("unidad", "").upper(), "lugar": ""}, "servicios": []})
            r = r if isinstance(r, list) else []
            res = [{"rol": x["rol"], "manzana": x["manzana"], "predio": x["predio"], "direccion": (x.get("direccion") or "").strip(),
                    "destino": x.get("destinoDescripcion") or ""} for x in r[:400]]
            return self.responder({"resultados": res, "total": len(r), "vacio": not r})
        return super().do_GET()

if __name__ == "__main__":
    print("http://localhost:8787/?api=http://localhost:8787")
    ThreadingHTTPServer(("127.0.0.1", 8787), H_).serve_forever()
