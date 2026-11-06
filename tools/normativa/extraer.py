"""Extrae las normas urbanísticas de las ordenanzas (PDF del Diario Oficial) a un esquema estándar,
con la API de Claude en lote (Message Batches, 50 % del precio) y salida JSON validada por esquema.

Pasos:
  python extraer.py subir     # sube los PDF descargados (Files API) -> estado/archivos.json
  python extraer.py enviar    # crea el lote con un pedido por documento -> estado/lote.json
  python extraer.py recoger   # espera el lote y guarda una respuesta por documento en extraido/
Credenciales: las del SDK de Anthropic (ANTHROPIC_API_KEY o `ant auth login`).
"""
import json, sys, time
from pathlib import Path
import anthropic
from anthropic.types.message_create_params import MessageCreateParamsNonStreaming
from anthropic.types.messages.batch_create_params import Request

BASE = Path("C:/datos/normativa_chile")
ESTADO = BASE / "estado"; ESTADO.mkdir(parents=True, exist_ok=True)
EXTRAIDO = BASE / "extraido"; EXTRAIDO.mkdir(parents=True, exist_ok=True)
MODELO = "claude-opus-5-5"

NUM = {"type": ["number", "null"]}
TXT = {"type": ["string", "null"]}
DESTINO = {
    "type": "object", "additionalProperties": False,
    "properties": {
        "destino": {"type": "string", "description": "Columna o destino al que aplica la norma (Vivienda, Equipamiento básico, Industria, Todos los usos…)"},
        "sup_predial_min_m2": NUM, "coef_ocupacion_suelo": NUM, "coef_ocupacion_pisos_sup": NUM,
        "coef_constructibilidad": NUM, "coef_area_libre": NUM, "altura_max_m": NUM, "altura_max_pisos": NUM,
        "densidad_bruta_max_hab_ha": NUM, "antejardin_m": NUM, "rasante_grados": NUM,
        "agrupamiento": TXT, "distanciamiento": TXT, "adosamiento": TXT,
        "texto": {"type": "object", "additionalProperties": False, "description": "Valor tal como aparece en el texto, para cada campo con condiciones o rangos",
                  "properties": {k: TXT for k in ["sup_predial_min", "ocupacion_suelo", "constructibilidad", "altura", "densidad", "antejardin"]},
                  "required": ["sup_predial_min", "ocupacion_suelo", "constructibilidad", "altura", "densidad", "antejardin"]},
    },
    "required": ["destino", "sup_predial_min_m2", "coef_ocupacion_suelo", "coef_ocupacion_pisos_sup", "coef_constructibilidad",
                 "coef_area_libre", "altura_max_m", "altura_max_pisos", "densidad_bruta_max_hab_ha", "antejardin_m", "rasante_grados",
                 "agrupamiento", "distanciamiento", "adosamiento", "texto"],
}
USO = {"type": "object", "additionalProperties": False,
       "properties": {"clase": {"type": "string"}, "estado": {"type": "string", "enum": ["permitido", "prohibido", "condicionado"]}, "condicion": TXT},
       "required": ["clase", "estado", "condicion"]}
ZONA = {
    "type": "object", "additionalProperties": False,
    "properties": {
        "codigo": {"type": "string", "description": "Código de la zona tal como figura (ZH-5, ZU-2, E-Ab1…)"},
        "nombre": TXT, "pagina": {"type": ["integer", "null"]},
        "accion": {"type": "string", "enum": ["define", "reemplaza", "modifica", "elimina"],
                   "description": "define en un plan base; en una modificación, si la zona se crea/reemplaza completa, se modifica en parte o se elimina"},
        "destinos": {"type": "array", "items": DESTINO},
        "usos": {"type": "array", "items": USO},
        "usos_permitidos_texto": TXT, "usos_prohibidos_texto": TXT, "notas": TXT,
    },
    "required": ["codigo", "nombre", "pagina", "accion", "destinos", "usos", "usos_permitidos_texto", "usos_prohibidos_texto", "notas"],
}
ESQUEMA = {
    "type": "object", "additionalProperties": False,
    "properties": {
        "es_ordenanza": {"type": "boolean", "description": "true si el documento contiene normas urbanísticas por zona"},
        "tipo": {"type": "string", "enum": ["plan_base", "modificacion", "seccional", "otro"]},
        "resumen": {"type": "string"},
        "zonas": {"type": "array", "items": ZONA},
        "generales": TXT,
    },
    "required": ["es_ordenanza", "tipo", "resumen", "zonas", "generales"],
}

SISTEMA = """Eres un analista de normativa urbana chilena. Recibes la publicación en el Diario Oficial de un Instrumento de Planificación Territorial (plan regulador comunal, seccional o una modificación) y extraes sus normas urbanísticas por zona a un esquema fijo.

Reglas:
- Extrae solo lo que dice el documento. Si un dato no aparece, usa null; no lo deduzcas de la OGUC ni de otras comunas.
- Una entrada en "destinos" por cada columna del cuadro de condiciones de edificación (Vivienda, Equipamiento básico, Equipamiento otras escalas, Industria…). Si la norma no distingue destinos, usa una sola entrada "Todos los usos".
- Números: decimales con punto (0,5 -> 0.5). Si hay varios valores (por escala, por ancho de vía, unifamiliar/multifamiliar), pon en el campo numérico el valor general o el primero, y el texto completo en "texto".
- Altura: si se expresa en pisos, llena altura_max_pisos; si en metros, altura_max_m; si en ambos, los dos. "Libre según rasantes" -> null y el texto.
- Usos: una entrada por clase o actividad que el cuadro trate (Vivienda, Hospedaje, Comercio, Industria molesta…), con estado permitido / prohibido / condicionado y la condición si la hay. Si el texto solo da listas generales, llena usos_permitidos_texto y usos_prohibidos_texto.
- En una modificación, incluye solo las zonas que cambian e indica la acción; describe en "resumen" qué modifica.
- "pagina" es la página del PDF donde está el cuadro de la zona.
- Copia los códigos de zona exactamente como los escribe el documento."""


def cliente():
    return anthropic.Anthropic()


def subir():
    c = cliente()
    reg_path = ESTADO / "archivos.json"
    reg = json.loads(reg_path.read_text(encoding="utf-8")) if reg_path.exists() else {}
    for pdf in sorted((BASE / "pdf").glob("*/*.pdf")):
        clave = f"{pdf.parent.name}/{pdf.name}"
        if clave in reg:
            continue
        f = c.files.upload(file=pdf)
        reg[clave] = f.id
        reg_path.write_text(json.dumps(reg, indent=1), encoding="utf-8")
        print("subido", clave, f.id)


def enviar(solo=None):
    c = cliente()
    reg = json.loads((ESTADO / "archivos.json").read_text(encoding="utf-8"))
    meta = json.loads((BASE / "documentos.json").read_text(encoding="utf-8"))
    pedidos = []
    for clave, fid in reg.items():
        cod = clave.split("/")[0]
        if solo and cod not in solo:
            continue
        m = meta.get(clave, {})
        contexto = f"Comuna: {m.get('comuna', '')}. Instrumento: {m.get('materia', '')} ({m.get('tipo', '')}, {m.get('tipoDoc', '')} N° {m.get('numero', '')}, publicado {m.get('publicacion', '')})."
        pedidos.append(Request(custom_id=clave.replace("/", "__").replace(".pdf", "")[:64], params=MessageCreateParamsNonStreaming(
            model=MODELO, max_tokens=64000,
            system=[{"type": "text", "text": SISTEMA, "cache_control": {"type": "ephemeral"}}],
            output_config={"effort": "medium", "format": {"type": "json_schema", "schema": ESQUEMA}},
            messages=[{"role": "user", "content": [
                {"type": "document", "source": {"type": "file", "file_id": fid}},
                {"type": "text", "text": contexto + "\nExtrae sus normas urbanísticas según el esquema."},
            ]}],
        )))
    lote = c.messages.batches.create(requests=pedidos)
    (ESTADO / "lote.json").write_text(json.dumps({"id": lote.id, "n": len(pedidos)}), encoding="utf-8")
    print("lote", lote.id, len(pedidos), "documentos")


def recoger():
    c = cliente()
    lote_id = json.loads((ESTADO / "lote.json").read_text(encoding="utf-8"))["id"]
    while (b := c.messages.batches.retrieve(lote_id)).processing_status != "ended":
        print("procesando…", b.request_counts.processing); time.sleep(60)
    ok = mal = 0
    uso = {"in": 0, "out": 0}
    for r in c.messages.batches.results(lote_id):
        if r.result.type != "succeeded":
            mal += 1; print("ERROR", r.custom_id, r.result.type); continue
        msg = r.result.message
        if msg.stop_reason != "end_turn":
            mal += 1; print("INCOMPLETO", r.custom_id, msg.stop_reason); continue
        txt = next((b.text for b in msg.content if b.type == "text"), "")
        (EXTRAIDO / f"{r.custom_id}.json").write_text(txt, encoding="utf-8")
        uso["in"] += msg.usage.input_tokens; uso["out"] += msg.usage.output_tokens; ok += 1
    print(f"ok {ok} · con problemas {mal} · tokens entrada {uso['in']:,} salida {uso['out']:,}")


if __name__ == "__main__":
    {"subir": subir, "enviar": lambda: enviar(set(sys.argv[2:]) or None), "recoger": recoger}[sys.argv[1]]()
