// Intermediario mínimo entre la web y el visor de mapas del SII.
// El SII no envía cabeceras CORS, así que el navegador no puede leer su API directamente.
// Solo expone tres consultas de lectura (predio por punto, por rol y por dirección) con validación estricta;
// no es un proxy abierto. En /mcp expone las mismas consultas como servidor MCP para asistentes de IA (con clave).
import { manejarMcp } from "./mcp.js";

const SII = "https://www4.sii.cl/mapasui/services/data/mapasFacadeService/";
const NS = "cl.sii.sdi.lob.bbrr.mapas.data.api.interfaces.MapasFacadeService/";
const SII_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  "Referer": "https://www4.sii.cl/mapasui/index.html",
  "Origin": "https://www4.sii.cl",
  "Content-Type": "application/json;charset=UTF-8",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "es-CL,es;q=0.9",
};
const LAYER_RE = /^sii:BR_CART_[A-Z0-9_]+_WMS$/;

function cors(origin, env) {
  const permitidos = (env.ALLOWED_ORIGINS || "*").split(",").map((s) => s.trim());
  const ok = permitidos.includes("*") || permitidos.includes(origin);
  return {
    "Access-Control-Allow-Origin": ok ? (permitidos.includes("*") ? "*" : origin) : "null",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function json(body, status, headers, cache = 0) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...headers,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": cache ? `public, max-age=${cache}` : "no-store",
    },
  });
}

async function sii(endpoint, data) {
  const body = {
    data,
    metaData: {
      namespace: NS + endpoint,
      conversationId: "UNAUTHENTICATED-CALL",
      transactionId: `web-${Date.now()}`,
    },
  };
  // El SII a veces responde 504 tras ~10 s: se corta a los 7 s y se reintenta. Si nunca contesta bien,
  // se lanza error (502 sin caché) para no confundir una caída del SII con "no hay predio aquí".
  let respondio = false;
  for (let intento = 0; intento < 3; intento++) {
    let r;
    try {
      r = await fetch(SII + endpoint, { method: "POST", headers: SII_HEADERS, body: JSON.stringify(body), signal: AbortSignal.timeout(7000) });
    } catch { continue; }
    if (r.ok) {
      respondio = true;
      // El SII mezcla UTF-8 y Latin-1 según el servicio: decodificar con respaldo para no romper tildes y "m²".
      const bytes = await r.arrayBuffer();
      let texto;
      try { texto = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
      catch { texto = new TextDecoder("windows-1252").decode(bytes); }
      const j = JSON.parse(texto);
      if (j && j.data) return j.data;
    }
    await new Promise((res) => setTimeout(res, 400));
  }
  if (!respondio) throw new Error("sii");
  return null;
}

const entero = (v, min, max) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
};
const real = (v, min, max) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
};

async function predioPorPunto(p) {
  const cod = entero(p.get("cod"), 1000, 99999);
  const lat = real(p.get("lat"), -56.5, -17);
  const lon = real(p.get("lon"), -110, -66);
  const layer = p.get("layer") || "";
  if (!cod || lat === null || lon === null || !LAYER_RE.test(layer)) return { error: "parámetros inválidos", status: 400 };
  // Ventana local de ~100 m centrada en el clic: con el bbox de toda la comuna el SII devuelve roles vecinos.
  const d = 0.0005;
  const d0 = await sii("getFeatureInfo", {
    clickInfo: {
      x: 400, y: 300,
      southwestx: lat - d, southwesty: lon - d,
      northeastx: lat + d, northeasty: lon + d,
      width: 800, height: 600, layer,
      servicios: [{ comuna: cod, layer, style: "PREDIOS_WMS_V0", eac: 0, eacano: 0 }],
    },
  });
  if (!d0 || d0.existePredio === -1 || !d0.manzana) return { vacio: true };
  return { predio: d0 };
}

async function predioPorRol(p) {
  const cod = entero(p.get("cod"), 1000, 99999);
  const manzana = entero(p.get("manzana"), 0, 999999);
  const predio = entero(p.get("predio"), 0, 999999);
  if (!cod || manzana === null || predio === null) return { error: "parámetros inválidos", status: 400 };
  const d = await sii("getPredioNacional", { predio: { comuna: cod, manzana, predio }, servicios: [] });
  const item = Array.isArray(d) ? d[0] : d;
  if (!item || !item.ubicacionX) return { vacio: true };
  return { predio: item };
}

// Búsqueda por dirección (la misma del visor del SII). El SII compara de forma aproximada:
// devuelve todas las unidades del número (deptos, oficinas, bodegas…) y la web ordena las exactas primero.
const CALLE_RE = /^[A-Z0-9Ñ .'-]{2,60}$/;
const MAX_RESULTADOS = 400;
async function prediosPorDireccion(p) {
  const cod = entero(p.get("cod"), 1000, 99999);
  const calle = (p.get("calle") || "").trim().toUpperCase();
  const numero = (p.get("numero") || "").trim();
  const detalle = entero(p.get("detalle") || "0", 0, 12);
  const unidad = (p.get("unidad") || "").trim().toUpperCase();
  if (!cod || !CALLE_RE.test(calle) || !/^\d{1,6}$/.test(numero) || detalle === null || !/^[A-Z0-9-]{0,10}$/.test(unidad)) {
    return { error: "parámetros inválidos", status: 400 };
  }
  const d = await sii("getPrediosDireccion", {
    rolDireccion: { comuna: cod, nombreComuna: "", calle, numeroCalleStr: numero, detalle, numeroDetalleStr: unidad, lugar: "" },
    servicios: [],
  });
  if (!Array.isArray(d)) return { resultados: [], total: 0 };
  const resultados = d.slice(0, MAX_RESULTADOS).map((x) => ({
    rol: x.rol, manzana: x.manzana, predio: x.predio,
    direccion: String(x.direccion || "").trim(), destino: x.destinoDescripcion || "",
  }));
  return { resultados, total: d.length, vacio: !d.length };
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname.replace(/\/+$/, "") === "/mcp") {
      return manejarMcp(req, env, { punto: predioPorPunto, rol: predioPorRol, direccion: prediosPorDireccion });
    }
    const h = cors(req.headers.get("Origin") || "", env);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
    if (req.method !== "GET") return json({ error: "método no permitido" }, 405, h);

    const ruta = url.pathname.replace(/\/+$/, "");
    if (ruta === "" || ruta === "/salud") return json({ ok: true }, 200, h);
    const fn = { "/predio": predioPorPunto, "/rol": predioPorRol, "/direccion": prediosPorDireccion }[ruta];
    if (!fn) return json({ error: "ruta desconocida" }, 404, h);

    // Caché en el borde de Cloudflare: el mismo predio consultado dos veces no vuelve a ir al SII.
    const cache = caches.default;
    const clave = new Request(url.toString(), { method: "GET" });
    const guardado = await cache.match(clave);
    if (guardado) {
      const r = new Response(guardado.body, guardado);
      Object.entries(h).forEach(([k, v]) => r.headers.set(k, v));
      return r;
    }

    try {
      const res = await fn(url.searchParams);
      if (res.error) return json({ error: res.error }, res.status || 400, h);
      const resp = json(res, 200, h, res.vacio ? 300 : 86400);
      ctx.waitUntil(cache.put(clave, resp.clone()));
      return resp;
    } catch (e) {
      return json({ error: "el SII no respondió" }, 502, h);
    }
  },
};
