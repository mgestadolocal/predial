"""Pasa el OCR de las ordenanzas (C:/datos/normativa_chile/ocr/{cod}.json) al formato estándar de la ficha:
web/data/normativa/std/{cod}.json  {cod, comuna, zonas: {CODIGO: {nombre, cols, filas, fuente, pagina}}}
y web/data/normativa/std/index.json con las comunas disponibles.

Se ordenan los documentos por fecha de publicación: una modificación posterior reemplaza la zona del plan base.
Por ahora quedan fuera los planes seccionales (sus códigos de zona se repiten con otro significado).
Uso: python estandarizar.py [cod ...]
"""
import json, re, sys
from datetime import datetime
from pathlib import Path

BASE = Path("C:/datos/normativa_chile")
RAIZ = Path(__file__).resolve().parents[2]
SALIDA = RAIZ / "web/data/normativa/std"
ETIQ = {
    "sup": "Superficie predial mínima", "cos": "Ocupación de suelo máx.", "cosp": "Ocupación pisos superiores máx.",
    "cc": "Constructibilidad máx.", "cal": "Área libre mín.", "alt": "Altura máxima", "dens": "Densidad bruta máx.",
    "agr": "Agrupamiento", "ras": "Rasante", "dist": "Distanciamiento a medianeros", "ados": "Adosamiento", "ante": "Antejardín mínimo",
}
ORDEN = ["sup", "cos", "cosp", "cc", "cal", "alt", "agr", "ras", "dist", "ados", "ante", "dens"]
PALABRAS = {"DE", "EN", "QUE", "UNA", "S", "LA", "EL", "LOS", "LAS", "DEL", "Y", "URBANA", "A", "AL", "CON", "POR", "SU"}
SECCIONAL = {"Plan Seccional", "Modifica Plan Seccional"}


def clave(z):
    return re.sub(r"[\s\-]", "", z or "").upper()


def valida(z):
    z = re.sub(r"\([A-Z]{1,2}\)$", "", clave(z))   # "A2(E)"
    if not z or z in PALABRAS or len(z) > 7:
        return False
    return bool(re.fullmatch(r"[A-Z]{1,5}\d{0,2}[A-Z]{0,2}\d{0,2}", z)) and (bool(re.search(r"\d", z)) or (z.startswith("Z") and len(z) >= 3))


def fecha(s):
    try:
        return datetime.strptime(s, "%d-%m-%Y")
    except (TypeError, ValueError):
        return datetime(1900, 1, 1)


def limpiar(v):
    v = re.sub(r"\s+", " ", v or "").strip(" .;")
    v = re.sub(r"(\d)\s*m2\b", r"\1 m²", v)
    v = v.replace("（", "(").replace("）", ")")
    v = re.sub(r"(\d)(metros|mts|pisos|hab)", r"\1 \2", v)
    v = re.sub(r"^(\d+)\.(\d{1,2})$", r"\1,\2", v)                     # 0.8 -> 0,8 (no toca 1.200)
    v = re.sub(r"([a-z]),(?=[A-Za-z])", r"\1, ", v)                     # "Aislado,Pareado"
    v = re.sub(r"(?i)(aislado|pareado)y\s?(?=[a-z])", r"\1 y ", v)      # "Pareadoy Continuo"
    return v or "—"


def numero(v):
    m = re.search(r"\d+(?:[.,]\d+)?", (v or "").replace(".", "") if re.search(r"\d\.\d{3}", v or "") else (v or ""))
    return float(m.group(0).replace(",", ".")) if m else None


# Control de plausibilidad por fila: un valor fuera de rango se descarta (queda "—")
RANGO = {
    "sup": lambda v: (n := numero(v)) is not None and 20 <= n <= 1_000_000 and not re.search(r"(?i)piso|metro\b|hab", v),
    "cos": lambda v: (n := numero(v)) is not None and 0 < n <= 1.5 or bool(re.search(r"(?i)libre|no se exige|ogu?c", v)),
    "cosp": lambda v: (n := numero(v)) is not None and 0 < n <= 1.5 or bool(re.search(r"(?i)libre|ogu?c", v)),
    "cc": lambda v: (n := numero(v)) is not None and 0 < n <= 25 or bool(re.search(r"(?i)libre|ogu?c", v)),
    "cal": lambda v: (n := numero(v)) is not None and 0 <= n <= 1,
    "alt": lambda v: bool(re.search(r"(?i)\d\s*(m\b|mts?|metros?|pisos?)|\b(un|uno|dos|tres|cuatro|cinco|seis|siete|ocho|diez)\s+pisos?|libre|rasante|ogu?c", v)) or ((n := numero(v)) is not None and 2 <= n <= 200),
    "dens": lambda v: (n := numero(v)) is not None and 1 <= n <= 5000 or bool(re.search(r"(?i)no aplica|libre|existente", v)),
    "ras": lambda v: bool(re.search(r"\d\s*°|ogu?c|\d{2}", v)),
    "agr": lambda v: bool(re.search(r"(?i)aislad|paread|continu|todos|ogu?c|existente|libre", v)) and len(v) < 60,
    "dist": lambda v: bool(re.search(r"(?i)\d|ogu?c|no se exige|art", v)) and len(v) < 60,
    "ados": lambda v: bool(re.search(r"(?i)\d|ogu?c|no|prohib|permit|art", v)) and len(v) < 80,
    "ante": lambda v: bool(re.search(r"(?i)\d\s*(m\b|mts?|metros?)|no se (?:exige|considera|consulta)|opcional|ogu?c|existente|^\d+([.,]\d+)?$", v)) and not re.search(r"(?i)piso", v) and len(v) < 50,
}
GENERICO = re.compile(r"^(Destino \d+|Todos los usos)$")


def depurar(cols, filas):
    """Arregla encabezados y columnas partidas, y descarta valores implausibles. Devuelve (cols, filas) o None."""
    cols = [c if len(c) <= 40 and not re.search(r"(?i)zona\s*:|n°\s*\d", c) else "" for c in cols]
    cols = [x or f"Destino {i + 1}" for i, x in enumerate(cols)]
    # columna partida: encabezados genéricos y a lo más una celda con dato por fila -> una sola columna
    if len(cols) > 1 and all(GENERICO.match(c) for c in cols) and all(sum(1 for v in vs if v.strip()) <= 1 for _, vs in filas):
        cols = ["Todos los usos"]
        filas = [[k, [" ".join(v for v in vs if v.strip())]] for k, vs in filas]
    if len(cols) == 1 and GENERICO.match(cols[0]):
        cols = ["Todos los usos"]
    salida = []
    for k, vs in filas:
        vs = [limpiar(v) for v in vs]
        if k in ("cos", "cosp"):  # "40%" -> "0,4 (40 %)"
            vs = [f"{int(m.group(1)) / 100:g} ({m.group(1)} %)".replace(".", ",") if (m := re.match(r"^(\d{1,3})\s*%", v)) else v for v in vs]
        if k == "ras":  # el OCR lee "80°" como "800"
            vs = [f"{v[0]}0°" if re.fullmatch(r"[4-9]00?", v) else re.sub(r"^([4-9]\d)\s*%", r"\1°", v) for v in vs]
        prueba = RANGO.get(k)
        if prueba:
            vs = [v if v == "—" or prueba(v) else "—" for v in vs]
        if any(v != "—" for v in vs):
            salida.append([k, vs])
    # cuadro desordenado: la mayoría de las celdas numéricas quedaron vacías
    num = [v for k, vs in salida if k in ("sup", "cos", "cc", "alt") for v in vs]
    if num and sum(1 for v in num if v != "—") / (4 * len(cols)) < 0.6:
        return None
    claves = {k for k, _ in salida}
    if "cc" not in claves and "alt" not in claves:
        return None
    if len(claves & {"sup", "cos", "cc", "alt", "dens", "ante"}) < 3:
        return None
    return cols, salida


def ficha(z, r, meta, c):
    cols, filas = r
    filas = dict(filas)
    return {
        "codigo": z, "cols": cols,
        "filas": [[ETIQ[k], "", filas[k]] for k in ORDEN if k in filas],
        "fuente": f"{meta.get('materia', '').strip().capitalize()} ({meta.get('tipoDoc', '')} N° {meta.get('numero', '')}, D.O. {meta.get('publicacion', '')})",
        "pagina": c.get("pagina"),
    }


def comuna(cod, docs):
    ruta = BASE / "ocr" / f"{cod}.json"
    if not ruta.exists():
        return None
    ocr = json.loads(ruta.read_text(encoding="utf-8"))
    orden = sorted(ocr, key=lambda n: fecha(docs.get(f"{cod}/{n}", {}).get("publicacion")))
    zonas, nombre_comuna = {}, ""
    for n in orden:
        meta = docs.get(f"{cod}/{n}", {})
        nombre_comuna = meta.get("comuna", nombre_comuna)
        if meta.get("tipo") in SECCIONAL:
            continue
        for c in ocr[n]:
            # cuadro con una zona por columna (Z1a | Z1a-1 | …): cada columna es una zona
            if len(c["cols"]) >= 2 and sum(map(valida, c["cols"])) >= 0.6 * len(c["cols"]):
                for i, zc in enumerate(c["cols"]):
                    r = valida(zc) and depurar(["Todos los usos"], [[k, [vs[i] if i < len(vs) else ""]] for k, vs in c["filas"]])
                    if r:
                        zonas[clave(zc)] = ficha(zc, r, meta, c)
                continue
            adivinada = not (valida(c.get("zona")) or c.get("fiable"))
            z = c.get("zona") if valida(c.get("zona")) or (c.get("fiable") and re.fullmatch(r"[A-Z]{1,5}", clave(c.get("zona"))) and clave(c.get("zona")) not in PALABRAS) else next((x for x in reversed(c.get("zona_pagina") or []) if valida(x)), None)
            if not z:
                continue
            cols = [x if not x.startswith("Col ") else "" for x in c["cols"]]
            r = depurar(cols, c["filas"])
            if r:
                zonas[clave(z)] = ficha(z, r, meta, c) | ({"_adiv": 1} if adivinada else {})
    # zonas adivinadas por el texto de la página: si varias quedan idénticas, es un mismo cuadro mal asignado
    firma = {}
    for k, z in zonas.items():
        if z.get("_adiv"):
            firma.setdefault(json.dumps(z["filas"]), []).append(k)
    for ks in firma.values():
        if len(ks) > 1:
            for k in ks:
                zonas.pop(k)
    for z in zonas.values():
        z.pop("_adiv", None)
    if not zonas:
        return None
    return {"cod": int(cod), "comuna": nombre_comuna, "zonas": zonas,
            "nota": "Extraído automáticamente (OCR) de la ordenanza publicada en el Diario Oficial; puede contener errores de lectura."}


def main(solo):
    docs = json.loads((BASE / "documentos.json").read_text(encoding="utf-8"))
    SALIDA.mkdir(parents=True, exist_ok=True)
    idx_path = SALIDA / "index.json"
    idx = json.loads(idx_path.read_text(encoding="utf-8")) if idx_path.exists() else {}
    cods = solo or [p.stem for p in (BASE / "ocr").glob("*.json")]
    for cod in cods:
        d = comuna(cod, docs)
        if not d:
            continue
        (SALIDA / f"{cod}.json").write_text(json.dumps(d, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        idx[str(cod)] = len(d["zonas"])
        print(cod, d["comuna"], len(d["zonas"]), "zonas:", " ".join(sorted(d["zonas"])))
    idx_path.write_text(json.dumps(idx, sort_keys=True), encoding="utf-8")


main(sys.argv[1:])
