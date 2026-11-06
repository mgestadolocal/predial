"""Lee el cuadro de usos de suelo de cada PDF de zona de Maipú (texto extraído con pypdf)."""
import re, sys

FILA = re.compile(r"^\s*(\d\.\d{1,2})\s+(.+?)\s+(SI|NO)\b\s*(.*)$")
CATEG = r"(Residencial|Equipamiento|Actividades ?productivas|Infraestructura|Espacio ?p[uú]blico|[ÁA]rea verde)"
REF = ["1.1", "1.2"] + [f"2.{i}" for i in range(1, 12)] + ["3.1", "3.2", "3.3", "4.1", "4.2", "4.3"]


def usos(txt):
    cuerpo = txt.split("CONDICIONES DE EDIFICACI")[0]
    cuerpo = re.sub(r"^(\d\.\d{1,2})\s*\n", r"\1 ", cuerpo, flags=re.M)  # código solo en su línea
    # separar filas que el PDF dejó pegadas en una misma línea ("--- 3.2 Molestas NO ---")
    cuerpo = re.sub(r"(?<=\s)(\d\.\d{1,2}) (?=[A-Za-zÁÉÍÓÚáéíóú])", "\n\\1 ", cuerpo)
    cuerpo = re.sub(r"(?<=---)(?=\d\.\d)", "\n", cuerpo)
    # quitar rótulos de categoría ("3 Actividades productivas") que quedan al final de una línea
    cuerpo = re.sub(r"(^|\s)[1-6]\s*" + CATEG + r"\s*$", "", cuerpo, flags=re.M)
    out, cur = [], None
    for ln in cuerpo.splitlines():
        ln = ln.strip()
        m = FILA.match(ln)
        if m:
            cur = {"cod": m[1], "clase": m[2].strip().capitalize(), "si": m[3] == "SI", "cond": m[4].strip()}
            out.append(cur)
            continue
        if not cur or not ln:
            continue
        if re.match(r"^[1-6]\s*" + CATEG, ln) or ln.startswith(("CLASES", "USOS", "SUELO", "(SI", "Condiciones esp")):
            continue
        cur["cond"] += " " + ln
    out = [u for u in out if u["cod"] in REF]
    for u in out:
        u["cond"] = re.sub(r"\s+", " ", u["cond"].replace("---", "")).strip(" .")
    return out


if __name__ == "__main__":
    for f in sys.argv[1:]:
        u = usos(open(f, encoding="utf-8").read())
        cods = [x["cod"] for x in u]
        print(f[:6], "faltan", [r for r in REF if r not in cods])
