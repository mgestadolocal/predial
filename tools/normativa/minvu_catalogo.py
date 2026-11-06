"""Catálogo nacional de Instrumentos de Planificación Territorial vigentes por comuna,
desde el sitio oficial del MINVU (instrumentosdeplanificacion.minvu.cl).

Salida: C:/datos/normativa_chile/catalogo.json
  {cod_sii: {"comuna", "minvu_id", "region", "instrumentos": [{id, materia, tipo, numero, tipoDoc, publicacion, archivos:[{tipo, nombre, ruta}]}]}}
Uso: python tools/normativa/minvu_catalogo.py
"""
import json, re, time, unicodedata
from pathlib import Path
import requests
try:  # el sitio del MINVU no envía la cadena intermedia; el almacén de Windows sí la resuelve
    import truststore; truststore.inject_into_ssl()
except ImportError:
    pass

RAIZ = Path(__file__).resolve().parents[2]
SITIO = "https://instrumentosdeplanificacion.minvu.cl"
SALIDA = Path("C:/datos/normativa_chile/catalogo.json")
n = lambda s: re.sub(r"[^a-z]", "", unicodedata.normalize("NFD", s.lower()).encode("ascii", "ignore").decode())
ALIAS = {"santiago": ["santiagocentro", "santiagooeste", "santiagosur"], "aisen": ["aysen"], "paiguano": ["paihuano"],
         "trehuaco": ["treguaco"], "llayllay": ["llaillay"], "marchihue": ["marchigue"]}

INSTR = re.compile(
    r'\{\s*id:"(\d+)",\s*number:\d+,\s*instrumentoBase:"(.*?)",\s*materia:"(.*?)",\s*tipoInstrumento:"(.*?)",\s*'
    r'numeroDocumento:"(.*?)",\s*tipoDocumento:"(.*?)",\s*fechaPublicacion:\s*"(.*?)"\s*,\s*fechaAprobacion:\s*"(.*?)"\s*,'
    r'.*?archivo:\[(.*?)\],\s*deroga:\[(.*?)\]', re.S)
ARCH = re.compile(r'archivoTipoNombre:"(.*?)",\s*archivoMascara:"(.*?)",\s*archivoNombre:"(.*?)",\s*ruta:"(.*?)"', re.S)


def main():
    cat = json.load(open(RAIZ / "web/data/comunas.json", encoding="utf-8"))
    por_nombre = {}
    for c in cat["comunas"]:
        por_nombre.setdefault(n(c["nombre"]), []).append(c)
    s = requests.Session(); s.headers["User-Agent"] = "Mozilla/5.0 (Predial; catastro de IPT)"
    salida, sin_match = {}, []
    for reg in range(1, 17):
        html = s.get(f"{SITIO}/{reg}", timeout=60).text
        tok = re.search(r'name="province_commune\[_token\]"[^>]*value="([^"]+)"', html) or re.search(r'value="([^"]+)"[^>]*name="province_commune\[_token\]"', html)
        form = re.search(r'name="province_commune".*?</form>', html, re.S)
        if not tok or not form:
            print("región", reg, "sin formulario"); continue
        sel = re.search(r'name="province_commune\[commune\]".*?</select>', form.group(0), re.S).group(0)
        for mid, nombre in re.findall(r'<option value="(\d+)"[^>]*>([^<]+)</option>', sel):
            nombre = nombre.strip()
            r = s.post(f"{SITIO}/get-instruments-by-commune/{reg}", timeout=90, data={
                "province_commune[commune]": mid, "province_commune[status]": "1", "regionId": reg, "province_commune[_token]": tok.group(1)})
            instrumentos = []
            for m in INSTR.finditer(r.text):
                instrumentos.append({
                    "id": m[1], "base": m[2], "materia": m[3].strip(), "tipo": m[4], "numero": m[5], "tipoDoc": m[6],
                    "publicacion": m[7], "aprobacion": m[8],
                    "archivos": [{"tipo": a[0], "nombre": a[1], "ruta": a[3]} for a in ARCH.findall(m[9])],
                })
            destinos = [c for k in ALIAS.get(n(nombre), [n(nombre)]) for c in por_nombre.get(k, [])]
            if not destinos:
                sin_match.append((reg, nombre))
            for c in destinos or [{"cod": f"minvu-{mid}", "nombre": nombre}]:
                salida[str(c["cod"])] = {"comuna": c["nombre"], "minvu_id": mid, "region": reg, "instrumentos": instrumentos}
            print(reg, nombre, len(instrumentos))
            time.sleep(0.4)
    SALIDA.parent.mkdir(parents=True, exist_ok=True)
    SALIDA.write_text(json.dumps(salida, ensure_ascii=False, indent=1), encoding="utf-8")
    print("comunas:", len(salida), "· sin match con el catálogo SII:", sin_match)


main()
