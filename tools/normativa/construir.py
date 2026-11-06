"""Arma web/data/normativa/{cod}.json para el piloto de normativa (Maipú 14109, Providencia 15103).

Uso: python construir.py <carpeta_salida>
Necesita: shapely, pdfplumber (venv del video o cualquiera), y los datos en C:/datos/sitma_maipu y C:/datos/providencia_agol.
"""
import collections, glob, json, re, sys
from pathlib import Path
import pdfplumber
from shapely.geometry import shape, mapping

sys.path.insert(0, str(Path(__file__).parent))
from usos_maipu import usos as leer_usos
from condiciones_maipu import FILAS, Z, USOS_TEXTO, RIESGO

DATOS = Path("C:/datos")
PILOTO = DATOS / "normativa_piloto"
OUT = Path(sys.argv[1])
OUT.mkdir(parents=True, exist_ok=True)
TOL = 0.000003  # ~0,3 m


def geom(g):
    s = shape(g).simplify(TOL, preserve_topology=True)
    if s.is_empty:
        return None
    m = mapping(s)

    def r(c):
        if isinstance(c[0], (int, float)):
            return [round(c[0], 6), round(c[1], 6)]
        return [r(x) for x in c]
    return {"type": m["type"], "coordinates": r(m["coordinates"])}


def capa(ruta, props):
    d = json.load(open(ruta, encoding="utf-8"))
    fs = []
    for f in d["features"]:
        if not f["geometry"]:
            continue
        g = geom(f["geometry"])
        if g:
            fs.append({"type": "Feature", "geometry": g, "properties": props(f["properties"])})
    return {"type": "FeatureCollection", "features": fs}


def limpio(s):
    s = (s or "").strip()
    return "" if s in ("", "0", "None") else re.sub(r"\s+", " ", s)


def norm_zona(z):
    return z.replace("-", "").strip().upper()


# ───────────────────────── Maipú ─────────────────────────
def maipu():
    g = DATOS / "sitma_maipu/geojson"
    zon = json.load(open(g / "SECPLA_PRC_ZONIFICACION__0_ZONIFICACI_N_PRC.geojson", encoding="utf-8"))
    desc, pdf = collections.defaultdict(collections.Counter), {}
    for f in zon["features"]:
        p = f["properties"]; z = norm_zona(p["ZONA"])
        desc[z][limpio(p["DESCRIPCION"])] += 1
        if p.get("ORDENANZA"):
            pdf[z] = p["ORDENANZA"]

    usos = {}
    for t in glob.glob(str(PILOTO / "maipu/pdf/Z[HCI]*.txt")):
        zonas = Path(t).name.split("__")[0].split("_")
        u = leer_usos(open(t, encoding="utf-8").read())
        for z in zonas:
            usos[norm_zona(z)] = u

    normas = {}
    for z, c in desc.items():
        nombre = c.most_common(1)[0][0]
        n = {"nombre": nombre, "pdf": pdf.get(z)}
        if z in usos:
            n["usos"] = usos[z]
        clave = z.replace("AR", "AR-") if z.startswith("AR") else z
        if clave in USOS_TEXTO:
            n["usosTexto"] = USOS_TEXTO[clave]
        if z in Z:
            e = Z[z]
            n["cols"] = e["cols"]
            n["filas"] = [[et, un, e[k]] for k, et, un in FILAS if e.get(k)]
            if e.get("nota"):
                n["nota"] = e["nota"]
        normas[clave] = n

    zonas = capa(g / "SECPLA_PRC_ZONIFICACION__0_ZONIFICACI_N_PRC.geojson", lambda p: {
        "z": (lambda z: z.replace("AR", "AR-") if z.startswith("AR") else z)(norm_zona(p["ZONA"])),
        **({"n": limpio(p["NOMBRE"])} if limpio(p["NOMBRE"]) and not limpio(p["NOMBRE"]).upper().startswith(("ZE", "ZONAS")) else {}),
        **({"m": limpio(p["MODIFICACION"])} if limpio(p["MODIFICACION"]) else {}),
    })
    riesgo = capa(g / "Plan_Regulador_Comunal_de_Maip_Vectorial__6_Zonas_de_Riesgo.geojson", lambda p: {"t": p["TIPO_DE_AR"]})
    prms = capa(g / "SECPLA_PRMS_100_MAIPU__1_ZONIFICACI_N_PRMS-100.geojson", lambda p: {
        "z": limpio(p["ZONAS_PRMS"]), "u": limpio(p["USO_SUELO"]), **({"n": limpio(p["NOMBRE_"])} if limpio(p["NOMBRE_"]) not in ("", "--") else {})})
    vial = capa(g / "SECPLA_PRC_LINEA_AFECTACION__0_TIPO_AFECTACI_N.geojson", lambda p: {"t": limpio(p["OBSERVACIO"]).capitalize()})

    return {
        "cod": 14109, "comuna": "Maipú",
        "instrumento": "Plan Regulador Comunal de Maipú (con modificaciones) y PRMS-100",
        "fuente": "SITMA, Municipalidad de Maipú (sitma.maps.arcgis.com)",
        "visor": "https://experience.arcgis.com/experience/f68dfca730674cbdabe26d7810e6ddee",
        "edificacion": True, "normas": normas, "riesgos": RIESGO,
        "capas": {"zonas": zonas, "riesgo": riesgo, "prms": prms}, "lineas": vial,
    }


# ─────────────────────── Providencia ───────────────────────
def cuadro_usos(ruta):
    filas, actual = [], None
    with pdfplumber.open(ruta) as pdf:
        for pg in pdf.pages:
            for t in pg.extract_tables():
                for row in t:
                    row = [re.sub(r"\s+", " ", (c or "").replace("\n", " ")).strip() for c in row]
                    if len(row) < 3:
                        continue
                    perm, proh = row[-2], row[-1]
                    etiq = next((c for c in reversed(row[:-2]) if c), "")
                    if etiq.upper() in ("USO", "") and perm.upper() in ("PERMITIDAS", "ACTIVIDADES ESPECÍFICAS"):
                        continue
                    if perm.upper() == "PERMITIDAS" or (not perm and not proh):
                        continue
                    if re.match(r"^[A-Z]{1,6}[a-z]* ", perm) and not proh and not etiq:
                        continue  # título del cuadro
                    etiq = re.sub(r"- ", "", etiq).replace("ESPARCI MIENTO", "ESPARCIMIENTO").replace("INFRA ESTRUCTURA", "INFRAESTRUCTURA")
                    if etiq.startswith("SERVICIOS ") and len(etiq) > 10:  # fragmento de "muni-cipales" que cae en la columna del rótulo
                        perm = perm.replace("servicios cipales", "servicios " + etiq[10:].strip() + "cipales")
                        etiq = "SERVICIOS"
                    if etiq:
                        actual = {"uso": etiq.capitalize(), "perm": perm, "proh": proh}
                        filas.append(actual)
                    elif actual:
                        actual["perm"] = (actual["perm"] + " " + perm).strip()
                        actual["proh"] = (actual["proh"] + " " + proh).strip()
    return filas


def providencia():
    g = DATOS / "providencia_agol/geojson"
    src = json.load(open(g / "Uso_de_Suelo_PRCP_WFL1__0_Usos_de_Suelo_PRCP.geojson", encoding="utf-8"))
    normas = {}
    for f in src["features"]:
        p = f["properties"]; z = p["USO"].strip()
        n = normas.setdefault(z, {"nombre": limpio(p["NOMBRE"]), "categoria": limpio(p.get("CATEGORÍA") or p.get("CATEGOR\ufffdA"))})
        if (p.get("CUADRO_USO") or "").startswith("http"):
            n["pdf"] = p["CUADRO_USO"]
        cand = glob.glob(str(PILOTO / "providencia/cuadros" / (re.sub(r"\s", "_", z) + "_*.pdf")))
        if cand and "usosProv" not in n:
            u = cuadro_usos(cand[0])
            if u:
                n["usosProv"] = u
    zonas = capa(g / "Uso_de_Suelo_PRCP_WFL1__0_Usos_de_Suelo_PRCP.geojson", lambda p: {"z": p["USO"].strip()})
    zch = capa(g / "Zona_de_Conservaci_n_Hist_rica__0_Zona_de_Conservaci_n_Hist_rica.geojson",
               lambda p: {"n": limpio(p["Iden_ZCH"]), "d": limpio(p["Dir_ZCH"])})
    zt = capa(g / "Zona_t_pica__0_Zona_t_pica.geojson", lambda p: {"n": limpio(p["Iden_ZT"]), "d": limpio(p["Dir_ZT"])})
    return {
        "cod": 15103, "comuna": "Providencia",
        "instrumento": "Plan Regulador Comunal de Providencia 2007 (PRCP), zonas de uso de suelo",
        "fuente": "Municipalidad de Providencia (ArcGIS Online, SECPLA)",
        "edificacion": False, "normas": normas,
        "capas": {"zonas": zonas, "zch": zch, "zt": zt},
    }


for datos in (maipu(), providencia()):
    ruta = OUT / f"{datos['cod']}.json"
    ruta.write_text(json.dumps(datos, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(ruta, round(ruta.stat().st_size / 1e6, 2), "MB", len(datos["normas"]), "zonas")
