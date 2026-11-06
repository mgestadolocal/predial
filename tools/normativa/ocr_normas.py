"""Lee los cuadros de normas urbanísticas por zona de las ordenanzas (PDF del Diario Oficial) con OCR local
y gratuito (RapidOCR), y los pasa a un formato estándar.

En el D.O. los cuadros vienen como imágenes: se hace OCR a cada imagen, se reconstruyen filas por posición
y se reconocen los rótulos estándar de la OGUC (superficie predial mínima, constructibilidad, altura…).

Uso: python ocr_normas.py <pdf> [<pdf> ...]      -> imprime JSON
     python ocr_normas.py --comunas 2203 1101    -> procesa C:/datos/normativa_chile/pdf/{cod}/ y guarda ocr/{cod}.json
"""
import io, json, re, sys, unicodedata
from pathlib import Path
from pypdf import PdfReader

BASE = Path("C:/datos/normativa_chile")
_ocr = None


def ocr():
    global _ocr
    if _ocr is None:
        from rapidocr_onnxruntime import RapidOCR
        _ocr = RapidOCR()
    return _ocr


def plano(s):
    return unicodedata.normalize("NFD", s.lower()).encode("ascii", "ignore").decode()


# Rótulos estándar (orden de la ficha) -> patrón sobre el texto sin tildes
ROTULOS = [
    ("sup", "Superficie predial mínima", r"superficie\s*predial|subdivision\s*predial|predial\s*minima"),
    ("cosp", "Ocupación pisos superiores", r"pisos\s*superiores"),
    ("cos", "Ocupación de suelo", r"ocupacion"),
    ("cc", "Constructibilidad", r"constructibilidad"),
    ("cal", "Área libre", r"area\s*libre"),
    ("alt", "Altura máxima", r"altura"),
    ("dens", "Densidad", r"densidad"),
    ("agr", "Agrupamiento", r"agrupamiento"),
    ("ras", "Rasante", r"rasante"),
    ("dist", "Distanciamiento", r"distanciamiento"),
    ("ados", "Adosamiento", r"adosamiento"),
    ("ante", "Antejardín", r"antejardin"),
]
ZONA_TIT = re.compile(r"\bzona\s*[:\-]?\s*([a-z]{1,5}[\s\-]?\d{0,2}[a-z]?(?:[\s\-]\d{1,2}[a-z]?)?)\b", re.I)


def clave_rotulo(txt):
    p = plano(txt)
    for k, _, pat in ROTULOS:
        if re.search(pat, p):
            return k
    return None


def leer_imagen(data):
    res, _ = ocr()(data)
    cajas = []
    for box, txt, conf in res or []:
        xs = [p[0] for p in box]; ys = [p[1] for p in box]
        cajas.append({"t": txt.strip(), "x0": min(xs), "x1": max(xs), "y0": min(ys), "y1": max(ys)})
    return cajas


def cuadro(cajas):
    """Reconstruye un cuadro de condiciones: columnas (destinos) y filas estándar. None si no lo es."""
    if not cajas:
        return None
    con_clave = [c for c in cajas if clave_rotulo(c["t"])]
    if len({clave_rotulo(c["t"]) for c in con_clave}) < 3:
        return None
    # columna de rótulos: lo que está a la izquierda del rótulo con clave más ancho
    x_min = min(c["x0"] for c in cajas); x_max = max(c["x1"] for c in cajas)
    izquierdos = [c for c in con_clave if c["x0"] < x_min + (x_max - x_min) * 0.35] or con_clave
    borde = max(c["x1"] for c in izquierdos) + 6
    izq = sorted([c for c in cajas if c["x1"] <= borde + 2 and c["x0"] < borde - 20], key=lambda c: c["y0"])
    alto = sorted(c["y1"] - c["y0"] for c in cajas)[len(cajas) // 2] or 10
    # rótulos: una línea con clave abre fila; las líneas siguientes sin clave (rótulo partido) se suman
    rotulos = []
    for c in izq:
        k = clave_rotulo(c["t"])
        previo = rotulos[-1] if rotulos else None
        if previo and c["y0"] - previo["y1"] < alto * 0.9:
            k2 = clave_rotulo(previo["t"] + " " + c["t"])
            if previo["k"] and (not k or k == previo["k"]):
                previo["t"] += " " + c["t"]; previo["y1"] = c["y1"]; previo["k"] = previo["k"] or k2
                if previo["k"] == "cos" and re.search(r"pisos\s*superiores", plano(previo["t"])):
                    previo["k"] = "cosp"
                continue
        rotulos.append({"t": c["t"], "k": k, "y0": c["y0"], "y1": c["y1"]})
    rotulos = [r for r in rotulos if r["k"]]
    if len({r["k"] for r in rotulos}) < 3:
        return None
    primero = rotulos[0]["y0"]
    titulo = " ".join(c["t"] for c in sorted(cajas, key=lambda c: (c["y0"], c["x0"])) if c["y1"] <= primero)
    # encabezado: franja justo sobre la primera fila, a la derecha de los rótulos
    enc = [c for c in cajas if c["x0"] >= borde - 2 and primero - alto * 4 <= c["y0"] and c["y1"] <= primero + 2
           and not re.search(r"(?i)zona|normas|urban|edificaci", plano(c["t"]))]
    valores = [c for c in cajas if c["x0"] >= borde - 2 and c["y0"] >= primero - alto * 0.5]
    # columnas: tramos x del encabezado; si no hay, agrupar los valores por superposición en x
    def tramos(cs):
        out = []
        for c in sorted(cs, key=lambda c: c["x0"]):
            if out and c["x0"] <= out[-1][1] + alto * 0.3:
                out[-1][1] = max(out[-1][1], c["x1"]); out[-1][2].append(c)
            else:
                out.append([c["x0"], c["x1"], [c]])
        return out
    cols = tramos(enc) if enc else []
    if not cols or len(cols) > 6:
        cols = tramos(valores)[:6]
        enc = []
    if not cols:
        return None
    def col_de(c):
        xc = (c["x0"] + c["x1"]) / 2
        dentro_ = [i for i, (a, b, _) in enumerate(cols) if a - alto <= xc <= b + alto]
        return dentro_[0] if dentro_ else min(range(len(cols)), key=lambda i: abs((cols[i][0] + cols[i][1]) / 2 - xc))
    nombres = [" ".join(x["t"] for x in sorted(g, key=lambda x: (x["y0"], x["x0"]))) if enc else "" for _, _, g in cols]
    # filas: cada valor va al rótulo cuyo centro vertical está más cerca
    centros = [(r["y0"] + r["y1"]) / 2 for r in rotulos]
    celdas = [[""] * len(cols) for _ in rotulos]
    for c in sorted(valores, key=lambda c: (c["y0"], c["x0"])):
        yc = (c["y0"] + c["y1"]) / 2
        j = min(range(len(rotulos)), key=lambda i: abs(centros[i] - yc))
        if not (rotulos[j]["y0"] - alto * 1.5 <= yc <= rotulos[j]["y1"] + alto * 1.5):
            continue
        i = col_de(c); celdas[j][i] = (celdas[j][i] + " " + c["t"]).strip()
    filas, vistos = [], set()
    for r, cs in zip(rotulos, celdas):
        if r["k"] in vistos or not any(cs):
            continue
        filas.append([r["k"], cs]); vistos.add(r["k"])
    if len(filas) < 3:
        return None
    # código de zona: el título más cercano sobre la primera fila (puede estar dentro del cuadro: "ZONA:B1")
    sobre = sorted([c for c in cajas if c["y1"] <= primero + 2 and ZONA_TIT.search(c["t"])], key=lambda c: -c["y0"])
    m = ZONA_TIT.search(sobre[0]["t"]) if sobre else ZONA_TIT.search(titulo)
    return {"titulo": titulo, "zona": m.group(1).upper().replace(" ", "") if m else None,
            "cols": [n or f"Col {i + 1}" for i, n in enumerate(nombres)], "filas": filas}


def procesar_pdf(ruta):
    """Lee los cuadros de un PDF. La lectura cruda del OCR queda en ocr_raw/ para poder re-armar sin repetirlo."""
    ruta = Path(ruta)
    crudo_path = BASE / "ocr_raw" / ruta.parent.name / f"{ruta.stem}.json"
    crudo = json.loads(crudo_path.read_text(encoding="utf-8")) if crudo_path.exists() else None
    if crudo is None:
        crudo = leer_crudo(ruta)
        crudo_path.parent.mkdir(parents=True, exist_ok=True)
        crudo_path.write_text(json.dumps(crudo, ensure_ascii=False), encoding="utf-8")
    salida = []
    for img in crudo:
        c = cuadro(img["cajas"])
        if c:
            if not c["zona"]:                       # el nombre de la zona suele estar en el texto de la página
                c["zona_pagina"] = img["zonas_pagina"]
            c["pagina"] = img["pagina"]
            salida.append(c)
    return salida + cuadros_texto(ruta)


_COD = r"([a-z]{1,5}(?:\s?-?\s?[a-z]{0,2}\d{1,2}[a-z]?|-[a-z]{1,4}\d{0,2})?(?:\s?-\s?\d{1,2}[a-z]?)?(?:\s?\([a-z]{1,2}\)|-[a-z](?![a-z0-9]))?)"
ZONA_LINEA = re.compile(r"^\s*(?:\d+[.)]\s*)?zona\s+" + _COD + r"\s*(?:[:.\-–(]|$)", re.I)
ROTULO_LINEA = re.compile(r"^\s*[•\-–]?\s*([^:]{4,70}?)\s*:\s*(.+?)\s*$")
# rótulo completo al inicio de la línea (sobre texto sin tildes), con o sin ":" antes del valor
_PRE = r"^\s*(?:[a-z]?\d{1,2}\s*[.)\-]+\s*-?\s*|[•\-–·]\s*|[a-z]\)\s*)?"
ROTULO_TXT = [(k, re.compile(_PRE + "(?:" + p + ")" + r"\s*(?:\([^)]{0,20}\))?\s*[:.]?\s*(?P<v>.*)$")) for k, p in [
    ("sup", r"superficie\s+(?:de\s+)?(?:subdivision\s+)?predial\s+minima|subdivision\s+predial\s+minima|tamano\s+predial\s+minimo"),
    ("cosp", r"coeficiente\s+de\s+ocupacion\s+de\s+(?:los\s+)?pisos\s+superiores"),
    ("cos", r"coeficiente\s+(?:maximo\s+)?de\s+ocupacion\s+(?:de|del)\s+suelo"),
    ("cc", r"coeficiente\s+(?:maximo\s+)?de\s+constructibilidad"),
    ("alt", r"altura\s+maxima(?:\s+de\s+(?:la\s+)?edificacion)?"),
    ("agr", r"(?:sistema\s+de\s+)?agrupamiento"),
    ("dens", r"densidad(?:\s+bruta)?(?:\s+maxima)?"),
    ("ante", r"antejardin(?:es)?(?:\s+minimo)?"),
    ("ras", r"rasantes?"),
    ("ados", r"adosamiento"),
    ("dist", r"distanciamiento(?:\s+minimo)?(?:\s+a\s+medianeros)?|distancia\s+minima\s+a\s+medianeros"),
]]
# bloque alternativo (p. ej. "CONDICIONES ESPECIALES: … proyectos de densificación"): no reemplaza la norma base
ESPECIALES = re.compile(r"^\s*(?:\d+[.)]\s*)?condiciones\s+especiales\s*:", re.I)


def plano_igual(s):
    """Como plano(), pero conserva el largo (para recortar el valor del texto original)."""
    return "".join(unicodedata.normalize("NFD", ch)[0] for ch in s).lower()


def rotulo_txt(linea):
    """(clave, valor) si la línea empieza con un rótulo estándar; valor "" si viene en la línea siguiente."""
    p = plano_igual(linea)
    if len(p) != len(linea):
        p = plano(linea); linea = p
    for k, rx in ROTULO_TXT:
        m = rx.match(p)
        if m:
            return k, linea[m.start("v"):].strip()
    r = ROTULO_LINEA.match(linea)
    k = clave_rotulo(r.group(1)) if r else None
    if r and k == "cos" and re.search(r"pisos\s*superiores|[23]\s*[°º]\s*piso", plano(r.group(1))):
        k = "cosp"
    return (k, r.group(2)) if k else None


def cuadros_texto(ruta):
    """Normas escritas como texto ("Coeficiente de constructibilidad : 0,9") bajo un título "Zona A-2:".
    Las páginas del D.O. van a dos columnas: se lee cada mitad por separado. Si un rótulo aparece varias
    veces en la zona (p. ej. en "condiciones especiales"), vale el que está rodeado de más rótulos."""
    import pdfplumber
    lineas = []
    try:
        with pdfplumber.open(ruta) as pdf:
            for n, pg in enumerate(pdf.pages, 1):
                w = pg.width
                for x0, x1 in ((0, w / 2), (w / 2, w)):
                    t = pg.crop((x0, 0, x1, pg.height)).extract_text() or ""
                    lineas += [(n, l) for l in t.splitlines()]
    except Exception:
        return []
    zonas, actual = [], None
    for i, (n, l) in enumerate(lineas):
        m = ZONA_LINEA.match(l)
        if m and len(l) < 90:
            # "A2-e" (especial) se escribe "A2(E)", como en el IPT
            cod = re.sub(r"^(.*\d)-([A-Z])$", r"\1(\2)", m.group(1).upper().replace(" ", ""))
            actual = {"titulo": l.strip(), "zona": cod, "cols": ["Todos los usos"], "pagina": n, "_o": [],
                      "fiable": m.group(1) == m.group(1).upper()}
            zonas.append(actual); continue
        if not actual or actual.get("_cerrada"):
            continue
        if ESPECIALES.match(l) and len({k for _, k, _ in actual["_o"]}) >= 3:
            actual["_cerrada"] = True; continue
        kv = rotulo_txt(l)
        if not kv:
            continue
        k, v = kv
        if not v and i + 1 < len(lineas) and not rotulo_txt(lineas[i + 1][1]) and not ZONA_LINEA.match(lineas[i + 1][1]):
            v = lineas[i + 1][1].strip(" -•")
        if v:
            actual["_o"].append((i, k, v))
    out = []
    for z in zonas:
        oc = z.pop("_o"); z.pop("_cerrada", None)
        mejor = {}
        for i, k, v in oc:
            vecinos = len({k2 for j, k2, _ in oc if k2 != k and abs(j - i) <= 4})
            if k not in mejor or vecinos > mejor[k][0]:
                mejor[k] = (vecinos, i, v)
        z["filas"] = [[k, [v]] for k, (_, i, v) in sorted(mejor.items(), key=lambda x: x[1][1])]
        if len(z["filas"]) >= 3:
            out.append(z)
    return out


def leer_crudo(ruta):
    r = PdfReader(ruta)
    crudo = []
    for n, pag in enumerate(r.pages, 1):
        texto = pag.extract_text() or ""
        try:
            imgs = list(pag.images)
        except Exception:
            imgs = []
        # con texto: solo páginas que hablan de zonas; sin texto (escaneo): todas
        if texto.strip() and not re.search(r"(?i)zona|edificaci|constructib|predial", texto):
            continue
        for im in imgs:
            if len(im.data) < 15000:
                continue
            try:
                cajas = leer_imagen(im.data)
            except Exception:
                continue
            # solo se guardan las imágenes que parecen cuadros de normas
            if len({clave_rotulo(c["t"]) for c in cajas if clave_rotulo(c["t"])}) >= 3:
                zs = ZONA_TIT.findall(texto)
                crudo.append({"pagina": n, "cajas": cajas, "zonas_pagina": [z.upper().replace(" ", "") for z in zs][-3:]})
    return crudo


if __name__ == "__main__":
    if sys.argv[1] == "--comunas":
        (BASE / "ocr").mkdir(exist_ok=True)
        for cod in sys.argv[2:]:
            if (BASE / "ocr" / f"{cod}.json").exists():
                continue
            res = {}
            for pdf in sorted((BASE / "pdf" / cod).glob("*.pdf")):
                try:
                    res[pdf.name] = procesar_pdf(pdf)
                except Exception as e:
                    print(cod, pdf.name, "ERROR", e, flush=True); continue
                print(cod, pdf.name, len(res[pdf.name]), "cuadros", flush=True)
            (BASE / "ocr" / f"{cod}.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    else:
        for f in sys.argv[1:]:
            print(json.dumps(procesar_pdf(f), ensure_ascii=False, indent=1))
