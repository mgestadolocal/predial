// Servidor MCP (Model Context Protocol, transporte HTTP "streamable", sin estado) para asistentes de IA.
// Ruta /mcp del Worker. Requiere la clave MCP_KEY (secreto del Worker): cabecera "Authorization: Bearer <clave>"
// o ?key=<clave> en la URL (los conectores de claude.ai solo permiten una URL).
//
// Herramientas: buscar_direccion, predio_por_rol, predio_en_punto, normativa.
// No entrega el propietario: solo indica cómo pedir el certificado de la TGR (uno a uno, con captcha).

const WEB = "https://mgestadolocal.github.io/predial/";
const TGR_URL = "https://tgr.gob.cl/tramites-tgr/certificado-de-deuda-de-contribuciones/";
const VERSIONES = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_POR_HORA = 600;   // consultas al SII por clave y por hora (aprox., por instancia del Worker)

// ── Datos publicados en Pages (se guardan en memoria mientras viva la instancia) ──
const cacheDatos = new Map();
async function datos(ruta) {
  if (!cacheDatos.has(ruta)) {
    cacheDatos.set(ruta, fetch(WEB + ruta, { cf: { cacheTtl: 3600 } }).then((r) => (r.ok ? r.json() : null)).catch(() => null));
  }
  const d = await cacheDatos.get(ruta);
  if (!d) cacheDatos.delete(ruta);
  return d;
}
const catalogo = () => datos("data/comunas.json");
const iptCatalogo = () => datos("data/normativa/ipt.json");
async function stdComuna(cod) {
  const idx = await datos("data/normativa/std/index.json");
  return idx && idx[cod] ? datos(`data/normativa/std/${cod}.json`) : null;
}

// ── Texto ──
const plano = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const txt = (s) => String(s ?? "").replace(/\u0081/g, "").replace(/\s+/g, " ").trim();
const attr = (a, ...ks) => { for (const k of ks) { const v = txt(a[k]); if (v && v !== "0" && v !== "--") return v; } return ""; };
const clp = (n) => "$" + Math.round(+n || 0).toLocaleString("es-CL");
const titulo = (s) => txt(s).toLowerCase().replace(/(^|\s)\S/g, (m) => m.toUpperCase());

async function buscarComuna(texto) {
  const cat = await catalogo();
  if (!cat) return null;
  const t = plano(texto).trim();
  if (/^\d{4,5}$/.test(t)) return cat.comunas.find((c) => c.cod === +t) || null;
  return cat.comunas.find((c) => plano(c.nombre) === t) || null;
}
// comuna mencionada dentro de un texto libre: el nombre más largo que aparezca como palabra completa
async function comunaEnTexto(texto) {
  const cat = await catalogo();
  const t = ` ${plano(texto).replace(/[^a-z0-9ñ ]/g, " ").replace(/\s+/g, " ")} `;
  let mejor = null;
  for (const c of cat.comunas) {
    const n = plano(c.nombre).replace(/[^a-z0-9ñ ]/g, " ").replace(/\s+/g, " ").trim();
    const i = t.lastIndexOf(` ${n} `);
    if (i >= 0 && (!mejor || n.length > mejor.n.length)) mejor = { c, n, i };
  }
  if (!mejor) return null;
  const resto = (t.slice(0, mejor.i) + " " + t.slice(mejor.i + mejor.n.length + 2)).replace(/\b(comuna de|comuna|en)\s*$/, "");
  return { comuna: mejor.c, resto: resto.trim() };
}
async function comunasEnPunto(lat, lon) {
  const cat = await catalogo();
  return cat.comunas
    .filter((c) => c.bbox && lon >= c.bbox[0] && lon <= c.bbox[2] && lat >= c.bbox[1] && lat <= c.bbox[3])
    .sort((a, b) => (a.lat - lat) ** 2 + (a.lon - lon) ** 2 - ((b.lat - lat) ** 2 + (b.lon - lon) ** 2))
    .slice(0, 3);
}

// Dirección escrita como en la web: "Espoz 5783 depto 12"
const UNIDADES = {
  casa: 1, cs: 1, depto: 2, dpto: 2, dto: 2, dp: 2, departamento: 2, of: 3, ofi: 3, oficina: 3,
  box: 4, bx: 4, estacionamiento: 4, est: 4, bodega: 5, bd: 5, parcela: 8, pc: 8,
  local: 9, loc: 9, lc: 9, sitio: 10, lote: 10, block: 12, blk: 12,
};
function leerDireccion(texto) {
  let t = plano(texto).replace(/[,#°º]/g, " ").replace(/\s+/g, " ").trim();
  let detalle = 0, unidad = "";
  const u = t.match(new RegExp(`\\s(${Object.keys(UNIDADES).join("|")})\\.?\\s*([a-z0-9-]{1,10})$`, "i"));
  if (u) { detalle = UNIDADES[u[1].toLowerCase()]; unidad = u[2].toUpperCase(); t = t.slice(0, u.index).trim(); }
  const n = t.match(/^(.*?[a-zñ].*?)\s+(?:n\.?\s*)?(\d{1,6})$/i);
  if (!n) return null;
  const calle = n[1].replace(/^(avenida|avda\.?|av\.?)\s+/i, "").replace(/[^a-zñ0-9 .'-]/gi, " ").replace(/\s+/g, " ").trim().toUpperCase();
  return calle.length >= 2 ? { calle, numero: n[2], detalle, unidad } : null;
}

// ── Ficha de un predio ──
function coordenadas(p, lat, lon) {
  // en las respuestas del SII ubicacionX es la latitud y ubicacionY la longitud
  const la = Number(p.ubicacionX), lo = Number(p.ubicacionY);
  if (la && lo && la < 0 && lo < 0) return { lat: la, lon: lo };
  return lat != null ? { lat, lon } : null;
}
async function ficha(p, c, pos) {
  const cat = await catalogo();
  const region = cat.regiones.find((r) => r.id === c.region);
  const sup = Number(p.supTerreno) || 0, supC = Number(p.supConsMt2) || 0;
  return {
    rol: p.rol || `${p.manzana}-${p.predio}`,
    comuna: c.nombre, codigo_sii: c.cod, region: region ? region.nombre : String(c.region),
    direccion: txt(p.direccion) || null,
    destino: titulo(p.destinoDescripcion) || null,
    ubicacion: titulo(p.ubicacion) || null,
    avaluo_total: Number(p.valorTotal) || null, avaluo_afecto: Number(p.valorAfecto) || null, avaluo_exento: Number(p.valorExento) || null,
    sup_terreno_m2: sup || null, sup_construida_m2: supC || null,
    periodo: titulo(p.periodo) || null, reavaluo: titulo(p.eacsDescripcion) || null,
    lat: pos ? +pos.lat.toFixed(6) : null, lon: pos ? +pos.lon.toFixed(6) : null,
    ver_en_mapa: pos ? `${WEB}#${c.cod}/${pos.lat.toFixed(5)}/${pos.lon.toFixed(5)}` : WEB,
    propietario: {
      disponible: false,
      como_obtenerlo: `El nombre del propietario no se entrega automáticamente. Se obtiene pidiendo el certificado de deuda de contribuciones en la TGR (uno por predio, con captcha): Región ${region ? region.nombre : c.region}, comuna ${c.nombre}, rol ${p.rol || `${p.manzana}-${p.predio}`}.`,
      enlace: TGR_URL,
    },
  };
}
function textoFicha(f) {
  return [
    `Rol ${f.rol} · ${f.comuna} (código SII ${f.codigo_sii}), Región ${f.region}`,
    f.direccion ? `Dirección: ${f.direccion}` : null,
    f.destino ? `Destino: ${f.destino}${f.ubicacion ? ` · ${f.ubicacion}` : ""}` : null,
    f.avaluo_total ? `Avalúo fiscal: ${clp(f.avaluo_total)} (afecto ${clp(f.avaluo_afecto)}, exento ${clp(f.avaluo_exento)})` : null,
    f.sup_terreno_m2 ? `Superficie de terreno: ${f.sup_terreno_m2.toLocaleString("es-CL")} m²` : null,
    f.sup_construida_m2 ? `Superficie construida: ${f.sup_construida_m2.toLocaleString("es-CL")} m²` : null,
    f.lat ? `Coordenadas: ${f.lat}, ${f.lon} · Mapa: ${f.ver_en_mapa}` : null,
    `Propietario: ${f.propietario.como_obtenerlo} ${f.propietario.enlace}`,
  ].filter(Boolean).join("\n");
}

// ── Normativa urbana (IPT del MINVU vía SMA + normas leídas de las ordenanzas) ──
const decimal = (s) => { const m = String(s || "").match(/^(\d+(?:[.,]\d+)?)/); return m ? +m[1].replace(",", ".") : null; };
const claveZona = (z) => String(z || "").replace(/[\s-]/g, "").toUpperCase();

async function consultarIPT(ipt, ids, lat, lon) {
  const q = new URLSearchParams({ geometry: `${lon},${lat}`, geometryType: "esriGeometryPoint", inSR: 4326,
    spatialRel: "esriSpatialRelIntersects", outFields: "*", returnGeometry: false, f: "json" });
  const res = await Promise.all(ids.map(async (id) => {
    try {
      const j = await (await fetch(`${ipt.servicio}/${id}/query?${q}`, { signal: AbortSignal.timeout(8000) })).json();
      return (j.features || []).map((f) => ({ id, capa: ipt.capas[id] || "", a: f.attributes }));
    } catch { return []; }
  }));
  return res.flat();
}
function edificacion(z, superficie) {
  const out = { codigo: z.codigo, fuente: `${z.fuente}${z.pagina ? `, pág. ${z.pagina} del PDF` : ""}`, destinos: [] };
  z.cols.forEach((col, i) => {
    const normas = Object.fromEntries(z.filas.map(([et, , vs]) => [et, vs[i]]).filter(([, v]) => v && v !== "—"));
    const d = { destino: col, normas };
    const val = (et) => { const f = z.filas.find((x) => x[0].startsWith(et)); return f ? f[2][i] : null; };
    const cc = decimal(val("Constructibilidad")), cos = decimal(val("Ocupación de suelo"));
    if (superficie && cc != null) {
      d.calculo = {
        superficie_terreno_m2: superficie,
        construible_max_m2: Math.round(cc * superficie),
        huella_primer_piso_m2: cos != null ? Math.round(cos * superficie) : null,
        altura: val("Altura") || null,
        formula: `constructibilidad ${cc} × ${superficie} m²${cos != null ? `; ocupación ${cos} × ${superficie} m²` : ""}`,
      };
    }
    out.destinos.push(d);
  });
  return out;
}
async function normativa(cod, lat, lon, superficie) {
  const ipt = await iptCatalogo();
  const conf = ipt && ipt.comunas[cod];
  const std = await stdComuna(cod);
  const res = { comuna_codigo: cod, zonas: [], afectaciones: [], aviso: "Referencial. No reemplaza el Certificado de Informaciones Previas (CIP) que emite la Dirección de Obras Municipales." };
  if (!conf) {
    res.nota = std ? "Esta comuna no tiene mapa de zonas digital; hay normas leídas de la ordenanza para las zonas: " + Object.values(std.zonas).map((z) => z.codigo).join(", ") + ". Usa el parámetro 'zona' para verlas."
                   : "No hay información del Plan Regulador para esta comuna en el IPT del MINVU.";
    return res;
  }
  const metro = new Set(conf.metro || []);
  const filas = await consultarIPT(ipt, [...conf.prc, ...(conf.metro || [])], lat, lon);
  for (const f of filas) {
    const zona = attr(f.a, "ZONA", "ZONA_1", "SIGLA"), nombre = attr(f.a, "NOMBRE", "NOM");
    if (/^(PRC Actual|S\/I|)$/i.test(zona) && /sin informaci|^$/i.test(attr(f.a, "UPREF", "NOMBRE", "NOM"))) continue;
    const base = { instrumento: f.capa, zona: zona || null, nombre: nombre || null };
    if (metro.has(f.id) || /Riesgo|Restricci|Resguardo/i.test(f.capa)) {
      res.afectaciones.push({ ...base, norma: attr(f.a, "NORMA").slice(0, 300) || null });
      continue;
    }
    const z = { ...base, uso_preferente: attr(f.a, "UPREF") || null, usos_permitidos: attr(f.a, "UPERM") || null, usos_prohibidos: attr(f.a, "UPROH") || null,
      documento: [attr(f.a, "T_DO", "TIPO_DOC"), attr(f.a, "N_DOC", "N_DO"), attr(f.a, "P_DO", "FECHA")].filter(Boolean).join(" ") || null };
    const ze = std && !/Seccional/i.test(f.capa) ? std.zonas[claveZona(zona)] : null;
    if (ze) z.edificacion = edificacion(ze, superficie);
    res.zonas.push(z);
  }
  if (!res.zonas.length) res.nota = "El punto no cae en una zona del Plan Regulador (puede ser vialidad, espacio público o fuera del límite urbano), o el servicio del MINVU no respondió.";
  else if (!res.zonas.some((z) => z.edificacion)) res.nota = "Para esta zona no hay coeficientes de edificación cargados (solo usos de suelo). Revisa la ordenanza local.";
  else if (!superficie) res.nota = "Agrega 'superficie_m2' para calcular los m² construibles.";
  return res;
}
function textoNormativa(n) {
  const l = [];
  for (const z of n.zonas) {
    l.push(`Zona ${z.zona || "—"}${z.nombre ? ` · ${z.nombre}` : ""} (${z.instrumento})`);
    if (z.uso_preferente) l.push(`  Uso preferente: ${z.uso_preferente}`);
    if (z.usos_permitidos) l.push(`  Permitidos: ${z.usos_permitidos}`);
    if (z.usos_prohibidos) l.push(`  Prohibidos: ${z.usos_prohibidos}`);
    if (z.edificacion) {
      for (const d of z.edificacion.destinos) {
        l.push(`  Normas de edificación${z.edificacion.destinos.length > 1 ? ` · ${d.destino}` : ""}: ` + Object.entries(d.normas).map(([k, v]) => `${k} ${v}`).join("; "));
        if (d.calculo) l.push(`  Con ${d.calculo.superficie_terreno_m2} m² de terreno: hasta ${d.calculo.construible_max_m2} m² construibles` +
          (d.calculo.huella_primer_piso_m2 != null ? `, huella en 1er piso ${d.calculo.huella_primer_piso_m2} m²` : "") + (d.calculo.altura ? `, altura ${d.calculo.altura}` : "") + ".");
      }
      l.push(`  Fuente: ${z.edificacion.fuente} (lectura automática, puede tener errores)`);
    }
  }
  for (const a of n.afectaciones) {
    const desc = a.nombre && a.zona && a.nombre.startsWith(a.zona) ? a.nombre : [a.zona, a.nombre].filter(Boolean).join(" · ");
    l.push(`Afectación (${a.instrumento}): ${desc}`);
  }
  if (n.nota) l.push(n.nota);
  l.push(n.aviso);
  return l.join("\n");
}

// ── Herramientas ──
const HERRAMIENTAS = [
  {
    name: "buscar_direccion",
    title: "Buscar predio por dirección",
    description: "Busca predios de Chile en el SII por dirección y entrega su rol, avalúo fiscal, destino y ubicación. Acepta texto libre con la comuna, por ejemplo \"lo recabarren 6529 vitacura\" o \"espoz 5783 depto 12, vitacura\". Si hay varias unidades (deptos, bodegas), las lista.",
    inputSchema: { type: "object", properties: {
      direccion: { type: "string", description: "Calle y número, opcionalmente con depto/oficina/bodega y la comuna." },
      comuna: { type: "string", description: "Comuna (nombre o código SII), si no viene en la dirección." },
      incluir_normativa: { type: "boolean", description: "Si es true y hay un solo resultado, agrega la normativa del Plan Regulador." },
    }, required: ["direccion"] },
  },
  {
    name: "predio_por_rol",
    title: "Predio por rol",
    description: "Ficha de un predio por su rol de avalúo del SII (manzana-predio, por ejemplo 3251-21) y comuna: dirección, destino, avalúo fiscal, superficies y coordenadas.",
    inputSchema: { type: "object", properties: {
      comuna: { type: "string", description: "Nombre o código SII de la comuna." },
      rol: { type: "string", description: "Rol manzana-predio, por ejemplo 3251-21." },
      incluir_normativa: { type: "boolean" },
    }, required: ["comuna", "rol"] },
  },
  {
    name: "predio_en_punto",
    title: "Predio en una coordenada",
    description: "Predio del SII que está en una coordenada (WGS84).",
    inputSchema: { type: "object", properties: {
      lat: { type: "number" }, lon: { type: "number" }, incluir_normativa: { type: "boolean" },
    }, required: ["lat", "lon"] },
  },
  {
    name: "normativa",
    title: "Normativa urbana",
    description: "Zona del Plan Regulador en una coordenada: usos permitidos y prohibidos, afectaciones (riesgo, PRMS) y, en las comunas con normas cargadas, coeficientes de edificación y cálculo de m² construibles para una superficie de terreno. Para comunas sin mapa digital de zonas, indica 'zona'.",
    inputSchema: { type: "object", properties: {
      lat: { type: "number" }, lon: { type: "number" },
      comuna: { type: "string", description: "Nombre o código SII; necesario si se usa 'zona' sin coordenadas." },
      zona: { type: "string", description: "Código de zona (por ejemplo A1) para comunas sin mapa de zonas." },
      superficie_m2: { type: "number", description: "Superficie del terreno para calcular los m² construibles." },
    } },
  },
];

class ErrorUsuario extends Error {}

async function herramienta(nombre, a, sii) {
  const sup = Number(a.superficie_m2) > 0 ? Number(a.superficie_m2) : null;
  const conNormativa = async (f, c) => {
    if (!a.incluir_normativa || f.lat == null) return [f, ""];
    const sup2 = sup || f.sup_terreno_m2;
    const n = await normativa(c.cod, f.lat, f.lon, sup2);
    return [{ ...f, normativa: n }, "\n\nNormativa urbana:\n" + textoNormativa(n)];
  };

  if (nombre === "buscar_direccion") {
    let comuna = a.comuna ? await buscarComuna(a.comuna) : null, resto = String(a.direccion || "");
    if (a.comuna && !comuna) throw new ErrorUsuario(`No reconozco la comuna "${a.comuna}".`);
    if (!comuna) {
      const e = await comunaEnTexto(resto);
      if (!e) throw new ErrorUsuario("Indica la comuna (en la dirección o en el parámetro 'comuna').");
      comuna = e.comuna; resto = e.resto;
    }
    const d = leerDireccion(resto);
    if (!d) throw new ErrorUsuario(`No pude leer calle y número en "${resto}". Ejemplo: "lo recabarren 6529".`);
    const r = await sii.direccion(new URLSearchParams({ cod: comuna.cod, calle: d.calle, numero: d.numero, detalle: d.detalle, unidad: d.unidad }));
    let lista = r.resultados || [];
    const ultima = d.calle.split(" ").pop().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const exacto = new RegExp(`(^|\\s)\\S*${ultima}\\s+0*${d.numero}(?=\\s|$)`, "i");
    lista = [...lista.filter((x) => exacto.test(x.direccion)), ...lista.filter((x) => !exacto.test(x.direccion))];
    if (!lista.length) return { texto: `No encontré "${d.calle} ${d.numero}${d.unidad ? ` ${d.unidad}` : ""}" en ${comuna.nombre} en el SII. Revisa el nombre de la calle (por ejemplo sin "Avenida") o prueba con el rol.`, datos: { resultados: [] } };
    if (lista.length === 1 || (exacto.test(lista[0].direccion) && !exacto.test(lista[1]?.direccion || "") && !d.unidad) || (d.unidad && lista.length <= 3)) {
      const p = await sii.rol(new URLSearchParams({ cod: comuna.cod, manzana: lista[0].manzana, predio: lista[0].predio }));
      if (p.predio) {
        const [f, extra] = await conNormativa(await ficha(p.predio, comuna, coordenadas(p.predio)), comuna);
        const otros = lista.length > 1 ? `\n\nOtras coincidencias: ${lista.slice(1, 8).map((x) => `${x.rol} ${x.direccion}`).join(" · ")}` : "";
        return { texto: textoFicha(f) + extra + otros, datos: { predio: f, otros: lista.slice(1, 50) } };
      }
    }
    return {
      texto: `${r.total} predios en ${comuna.nombre} para "${d.calle} ${d.numero}"${r.total > lista.length ? ` (se muestran ${lista.length})` : ""}:\n` +
        lista.slice(0, 40).map((x) => `${x.rol} · ${x.direccion} · ${titulo(x.destino)}`).join("\n") +
        "\nUsa predio_por_rol para ver la ficha de uno, o agrega el depto/oficina a la dirección.",
      datos: { comuna: comuna.nombre, codigo_sii: comuna.cod, total: r.total, resultados: lista.slice(0, 100) },
    };
  }

  if (nombre === "predio_por_rol") {
    const comuna = await buscarComuna(a.comuna);
    if (!comuna) throw new ErrorUsuario(`No reconozco la comuna "${a.comuna}".`);
    const m = String(a.rol || "").trim().match(/^0*(\d{1,6})\s*-\s*0*(\d{1,6})$/);
    if (!m) throw new ErrorUsuario("El rol va como manzana-predio, por ejemplo 3251-21.");
    const r = await sii.rol(new URLSearchParams({ cod: comuna.cod, manzana: m[1], predio: m[2] }));
    if (!r.predio) return { texto: `El SII no tiene el rol ${m[1]}-${m[2]} en ${comuna.nombre}.`, datos: null };
    const [f, extra] = await conNormativa(await ficha(r.predio, comuna, coordenadas(r.predio)), comuna);
    return { texto: textoFicha(f) + extra, datos: f };
  }

  if (nombre === "predio_en_punto") {
    const lat = Number(a.lat), lon = Number(a.lon);
    if (!(lat < -17 && lat > -56 && lon < -66 && lon > -110)) throw new ErrorUsuario("La coordenada no está en Chile (usa lat y lon en grados decimales, WGS84).");
    const cands = await comunasEnPunto(lat, lon);
    for (const c of cands) {
      const r = await sii.punto(new URLSearchParams({ cod: c.cod, layer: c.layer, lat, lon }));
      if (r.predio) {
        const [f, extra] = await conNormativa(await ficha(r.predio, c, { lat, lon }), c);
        return { texto: textoFicha(f) + extra, datos: f };
      }
    }
    return { texto: "No hay un predio registrado en el SII en ese punto (puede ser una calle, un río o un bien público).", datos: null };
  }

  if (nombre === "normativa") {
    let c = a.comuna ? await buscarComuna(a.comuna) : null;
    if (a.comuna && !c) throw new ErrorUsuario(`No reconozco la comuna "${a.comuna}".`);
    if (a.zona) {
      if (!c) throw new ErrorUsuario("Para consultar por zona indica la comuna.");
      const std = await stdComuna(c.cod);
      const z = std && std.zonas[claveZona(a.zona)];
      if (!z) return { texto: `No hay normas de edificación cargadas para la zona ${a.zona} de ${c.nombre}.` + (std ? ` Zonas disponibles: ${Object.values(std.zonas).map((x) => x.codigo).join(", ")}.` : ""), datos: null };
      const e = edificacion(z, sup);
      const n = { comuna_codigo: c.cod, zonas: [{ instrumento: "Plan Regulador Comunal", zona: z.codigo, nombre: null, edificacion: e }], afectaciones: [], aviso: "Referencial. No reemplaza el Certificado de Informaciones Previas (CIP) que emite la Dirección de Obras Municipales." };
      return { texto: `${c.nombre}\n` + textoNormativa(n), datos: n };
    }
    const lat = Number(a.lat), lon = Number(a.lon);
    if (!(lat < -17 && lat > -56 && lon < -66 && lon > -110)) throw new ErrorUsuario("Indica lat y lon (WGS84) en Chile, o comuna y zona.");
    if (!c) c = (await comunasEnPunto(lat, lon))[0];
    if (!c) throw new ErrorUsuario("Ese punto no cae en ninguna comuna con cartografía.");
    const n = await normativa(c.cod, lat, lon, sup);
    return { texto: `${c.nombre}\n` + textoNormativa(n), datos: n };
  }
  throw new ErrorUsuario(`Herramienta desconocida: ${nombre}`);
}

// ── Protocolo ──
function rpc(id, result) { return { jsonrpc: "2.0", id, result }; }
function rpcError(id, code, message) { return { jsonrpc: "2.0", id: id ?? null, error: { code, message } }; }

const usos = new Map();   // clave -> { hora, n }
function limite(clave) {
  const hora = Math.floor(Date.now() / 3600000), u = usos.get(clave);
  if (!u || u.hora !== hora) { usos.set(clave, { hora, n: 1 }); return true; }
  return ++u.n <= MAX_POR_HORA;
}

async function procesar(m, sii, clave) {
  const { id, method, params } = m || {};
  if (method === "initialize") {
    const pedida = params && params.protocolVersion;
    return rpc(id, {
      protocolVersion: VERSIONES.includes(pedida) ? pedida : VERSIONES[0],
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "predios-chile", title: "Predios de Chile (SII · Plan Regulador)", version: "1.0.0" },
      instructions: "Datos públicos de predios de Chile: rol y avalúo fiscal del SII, y normativa urbana del Plan Regulador (IPT del MINVU). " +
        "No entrega el nombre del propietario: si lo piden, explica cómo pedir el certificado de deuda de contribuciones en la TGR con región, comuna y rol. " +
        "La normativa es referencial y no reemplaza el Certificado de Informaciones Previas.",
    });
  }
  if (method === "ping") return rpc(id, {});
  if (method === "tools/list") return rpc(id, { tools: HERRAMIENTAS });
  if (method === "tools/call") {
    const nombre = params && params.name, args = (params && params.arguments) || {};
    if (!HERRAMIENTAS.some((h) => h.name === nombre)) return rpcError(id, -32602, `Herramienta desconocida: ${nombre}`);
    if (!limite(clave)) return rpc(id, { content: [{ type: "text", text: "Se alcanzó el límite de consultas por hora. Intenta más tarde." }], isError: true });
    try {
      const r = await herramienta(nombre, args, sii);
      return rpc(id, { content: [{ type: "text", text: r.texto }], structuredContent: r.datos ? { resultado: r.datos } : undefined, isError: false });
    } catch (e) {
      const msg = e instanceof ErrorUsuario ? e.message : e.message === "sii" ? "El SII no respondió (está inestable). Intenta de nuevo en unos segundos." : "Error interno al consultar.";
      return rpc(id, { content: [{ type: "text", text: msg }], isError: true });
    }
  }
  if (id === undefined || id === null) return null;   // notificación (p. ej. notifications/initialized)
  return rpcError(id, -32601, `Método no soportado: ${method}`);
}

function igual(a, b) {   // comparación en tiempo constante
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}

export async function manejarMcp(req, env, sii) {
  const url = new URL(req.url);
  const h = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version, Accept",
    "Cache-Control": "no-store",
  };
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
  const dada = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "") || url.searchParams.get("key") || "";
  if (!env.MCP_KEY || !igual(dada, env.MCP_KEY)) {
    return new Response(JSON.stringify(rpcError(null, -32001, "Clave inválida o ausente")), { status: 401, headers: { ...h, "Content-Type": "application/json", "WWW-Authenticate": "Bearer" } });
  }
  if (req.method === "GET" || req.method === "DELETE") return new Response(null, { status: 405, headers: { ...h, Allow: "POST" } });
  if (req.method !== "POST") return new Response(null, { status: 405, headers: h });
  let cuerpo;
  try { cuerpo = await req.json(); } catch {
    return new Response(JSON.stringify(rpcError(null, -32700, "JSON inválido")), { status: 400, headers: { ...h, "Content-Type": "application/json" } });
  }
  const lote = Array.isArray(cuerpo);
  const salidas = (await Promise.all((lote ? cuerpo : [cuerpo]).slice(0, 10).map((m) => procesar(m, sii, dada)))).filter(Boolean);
  if (!salidas.length) return new Response(null, { status: 202, headers: h });
  return new Response(JSON.stringify(lote ? salidas : salidas[0]), { status: 200, headers: { ...h, "Content-Type": "application/json" } });
}
