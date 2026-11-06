"""Descarga las ordenanzas vigentes (PDF del Diario Oficial) del catálogo del MINVU y revisa si traen texto.

Salida: C:/datos/normativa_chile/pdf/{cod}/{instrumento}_{n}.pdf y documentos.json (metadatos + páginas con texto).
Uso: python tools/normativa/descargar.py [cod ...]
"""
import json, re, sys, time
from pathlib import Path
import requests
from pypdf import PdfReader
try:
    import truststore; truststore.inject_into_ssl()
except ImportError:
    pass

BASE = Path("C:/datos/normativa_chile")
SITIO = "https://instrumentosdeplanificacion.minvu.cl"
TIPOS = {"Plan Regulador Comunal", "Modifica Plan Regulador Comunal", "Plan Seccional", "Modifica Plan Seccional"}
ARCH = re.compile(r"Ordenanza", re.I)        # si no hay, la publicación en el D.O.
PUB = re.compile(r"Publicaci", re.I)


def main(solo):
    cat = json.loads((BASE / "catalogo.json").read_text(encoding="utf-8"))
    meta_path = BASE / "documentos.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8")) if meta_path.exists() else {}
    s = requests.Session(); s.headers["User-Agent"] = "Mozilla/5.0 (Predial; catastro de IPT)"
    for cod, c in cat.items():
        if solo and cod not in solo:
            continue
        for ins in c["instrumentos"]:
            if ins["tipo"] not in TIPOS:
                continue
            pdfs = [a for a in ins["archivos"] if a["ruta"].lower().endswith(".pdf")]
            elegidos = [a for a in pdfs if ARCH.search(a["tipo"])] or [a for a in pdfs if PUB.search(a["tipo"])][:1] or pdfs[:1]
            for i, a in enumerate(elegidos):
                destino = BASE / "pdf" / cod / f"{ins['id']}_{i}.pdf"
                clave = f"{cod}/{destino.name}"
                if not destino.exists():
                    destino.parent.mkdir(parents=True, exist_ok=True)
                    try:
                        r = s.get(SITIO + a["ruta"], timeout=180)
                        r.raise_for_status()
                        if not r.content.startswith(b"%PDF"):
                            print("no es PDF", clave); continue
                        destino.write_bytes(r.content)
                    except requests.RequestException as e:
                        print("falló", clave, e); continue
                    time.sleep(0.3)
                if clave not in meta:
                    try:
                        pags = PdfReader(destino).pages
                        con_texto = sum(1 for p in pags if len((p.extract_text() or "").strip()) > 200)
                        n = len(pags)
                    except Exception:
                        n = con_texto = 0
                    meta[clave] = {"cod": cod, "comuna": c["comuna"], "instrumento": ins["id"], "materia": ins["materia"], "tipo": ins["tipo"],
                                   "tipoDoc": ins["tipoDoc"], "numero": ins["numero"], "publicacion": ins["publicacion"], "archivo": a["nombre"],
                                   "paginas": n, "paginas_texto": con_texto, "mb": round(destino.stat().st_size / 1e6, 2)}
                    print(clave, n, "págs", con_texto, "con texto", ins["materia"][:60])
        meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")


main(set(sys.argv[1:]))
