/* Predial — importar KML / KMZ / GeoJSON y ver dónde cae cada elemento.
   Todo ocurre en el navegador: el archivo no se sube a ningún servidor. */
(() => {
  "use strict";
  const P = window.Predial;
  if (!P) return;
  const { mapa, esc, clp, num, $ } = P;

  const MAX_MUESTRAS = 60;   // consultas por elemento al buscar predios
  const HILOS = 4;

  let capa = null;           // L.GeoJSON dibujado en el mapa
  let elementos = [];        // { id, nombre, tipo, geom, partes, medida, comunas, muestras, predios, estado }
  let archivo = "";

  // ── Lectura de archivos ─────────────────────────────────
  async function leer(file) {
    const nombre = file.name.toLowerCase();
    if (nombre.endsWith(".kmz")) {
      const zip = await JSZip.loadAsync(file);
      const kml = Object.values(zip.files).find((f) => !f.dir && f.name.toLowerCase().endsWith(".kml"));
      if (!kml) throw new Error("El KMZ no trae ningún archivo KML adentro.");
      return deKml(await kml.async("text"));
    }
    const texto = await file.text();
    if (nombre.endsWith(".kml") || texto.trimStart().startsWith("<")) return deKml(texto);
    const gj = JSON.parse(texto);
    return gj.type === "FeatureCollection" ? gj : { type: "FeatureCollection", features: gj.type === "Feature" ? [gj] : [{ type: "Feature", properties: {}, geometry: gj }] };
  }
  function deKml(texto) {
    const dom = new DOMParser().parseFromString(texto, "text/xml");
    if (dom.querySelector("parsererror")) throw new Error("El archivo KML no se pudo leer (XML inválido).");
    return toGeoJSON.kml(dom);
  }

  // ── Geometría ───────────────────────────────────────────
  // Descompone cualquier geometría en puntos, líneas y polígonos simples
  function partes(g, out = { puntos: [], lineas: [], poligonos: [] }) {
    if (!g) return out;
    const t = g.type, c = g.coordinates;
    if (t === "Point") out.puntos.push(c);
    else if (t === "MultiPoint") c.forEach((p) => out.puntos.push(p));
    else if (t === "LineString") out.lineas.push(c);
    else if (t === "MultiLineString") c.forEach((l) => out.lineas.push(l));
    else if (t === "Polygon") out.poligonos.push(c);
    else if (t === "MultiPolygon") c.forEach((p) => out.poligonos.push(p));
    else if (t === "GeometryCollection") g.geometries.forEach((x) => partes(x, out));
    return out;
  }
  // Proyección local en metros (suficiente para áreas y muestreo a escala predial)
  const proyector = (lat0) => {
    const kx = 111320 * Math.cos((lat0 * Math.PI) / 180), ky = 110540;
    return { a: ([lon, lat]) => [lon * kx, lat * ky], de: ([x, y]) => [x / kx, y / ky] };
  };
  const areaAnillo = (r) => { let s = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]); return Math.abs(s / 2); };
  function dentro(pt, anillo) {
    let ok = false;
    for (let i = 0, j = anillo.length - 1; i < anillo.length; j = i++) {
      const [xi, yi] = anillo[i], [xj, yj] = anillo[j];
      if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) ok = !ok;
    }
    return ok;
  }
  const enPoligono = (pt, pol) => dentro(pt, pol[0]) && !pol.slice(1).some((h) => dentro(pt, h));

  function analizarGeometria(g) {
    const pt = partes(g);
    const todos = [...pt.puntos, ...pt.lineas.flat(), ...pt.poligonos.flatMap((p) => p[0])];
    if (!todos.length) return null;
    const lat0 = todos.reduce((s, c) => s + c[1], 0) / todos.length;
    const pr = proyector(lat0);
    let area = 0, largo = 0, muestras = [];

    pt.poligonos.forEach((pol) => {
      const m = pol.map((r) => r.map(pr.a));
      area += areaAnillo(m[0]) - m.slice(1).reduce((s, h) => s + areaAnillo(h), 0);
    });
    pt.lineas.forEach((l) => { for (let i = 1; i < l.length; i++) { const a = pr.a(l[i - 1]), b = pr.a(l[i]); largo += Math.hypot(b[0] - a[0], b[1] - a[1]); } });

    // Muestras: polígonos con grilla interior, líneas a intervalos, puntos tal cual
    const cupo = MAX_MUESTRAS;
    const nPol = pt.poligonos.length, nLin = pt.lineas.length;
    pt.poligonos.forEach((pol) => {
      const m = pol.map((r) => r.map(pr.a));
      const a = Math.max(areaAnillo(m[0]), 1);
      const paso = Math.max(12, Math.sqrt(a / Math.max(4, cupo / nPol)));
      const xs = m[0].map((p) => p[0]), ys = m[0].map((p) => p[1]);
      const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
      let n = 0;
      for (let x = x0 + paso / 2; x < x1; x += paso) for (let y = y0 + paso / 2; y < y1; y += paso) {
        if (enPoligono([x, y], m)) { muestras.push(pr.de([x, y])); n++; }
      }
      if (!n) { // polígono angosto o muy chico: usar el promedio de vértices o el primer vértice
        const c = [xs.reduce((s, v) => s + v, 0) / xs.length, ys.reduce((s, v) => s + v, 0) / ys.length];
        muestras.push(pr.de(enPoligono(c, m) ? c : m[0][0]));
      }
    });
    pt.lineas.forEach((l) => {
      const m = l.map(pr.a);
      let tot = 0; for (let i = 1; i < m.length; i++) tot += Math.hypot(m[i][0] - m[i - 1][0], m[i][1] - m[i - 1][1]);
      const paso = Math.max(15, tot / Math.max(2, cupo / nLin));
      let resto = 0; muestras.push(l[0]);
      for (let i = 1; i < m.length; i++) {
        const [ax, ay] = m[i - 1], [bx, by] = m[i], d = Math.hypot(bx - ax, by - ay);
        let t = paso - resto;
        while (t <= d) { muestras.push(pr.de([ax + ((bx - ax) * t) / d, ay + ((by - ay) * t) / d])); t += paso; }
        resto = d - (t - paso);
      }
    });
    pt.puntos.forEach((p) => muestras.push(p));
    if (muestras.length > MAX_MUESTRAS) { const k = muestras.length / MAX_MUESTRAS; muestras = Array.from({ length: MAX_MUESTRAS }, (_, i) => muestras[Math.floor(i * k)]); }

    const tipo = pt.poligonos.length ? "Polígono" : pt.lineas.length ? "Línea" : pt.puntos.length > 1 ? "Puntos" : "Punto";
    const medida = pt.poligonos.length ? (area >= 10000 ? `${num.format(area / 10000)} ha` : `${num.format(Math.round(area))} m²`)
      : pt.lineas.length ? (largo >= 1000 ? `${num.format(largo / 1000)} km` : `${num.format(Math.round(largo))} m`) : "";

    // Comunas donde cae: vértices + muestras, con prueba estricta de punto en polígono
    const prueba = [...muestras, ...todos.filter((_, i) => i % Math.ceil(todos.length / 200 || 1) === 0)];
    const comunas = new Map();
    prueba.forEach(([lon, lat]) => P.comunasEnPunto(lat, lon, { estricto: true }).forEach((c) => comunas.set(c.cod, c)));
    return { tipo, medida, muestras, comunas: [...comunas.values()] };
  }

  // ── Importar ────────────────────────────────────────────
  async function importar(file) {
    if (!/\.(kml|kmz|geojson|json)$/i.test(file.name)) {
      P.pintarEstado(`<span class="mal">●</span> Formato no soportado: usa KML, KMZ o GeoJSON`); return;
    }
    P.pintarEstado(`Leyendo <b>${esc(file.name)}</b>…`);
    let gj;
    try { gj = await leer(file); } catch (e) {
      P.pintarEstado(`<span class="mal">●</span> ${esc(e.message || "No se pudo leer el archivo")}`); return;
    }
    const feats = (gj.features || []).filter((f) => f && f.geometry);
    if (!feats.length) { P.pintarEstado(`<span class="mal">●</span> El archivo no tiene geometrías`); return; }

    quitar(false);
    archivo = file.name;
    capa = L.geoJSON({ type: "FeatureCollection", features: feats }, {
      interactive: false,
      style: () => ({ color: "#ff5b1f", weight: 2.4, opacity: 1, fillColor: "#ff5b1f", fillOpacity: 0.1, dashArray: "6 4" }),
      pointToLayer: (_, ll) => L.circleMarker(ll, { radius: 6, color: "#0a0c0b", weight: 2, fillColor: "#ff5b1f", fillOpacity: 1 }),
    }).addTo(mapa);

    elementos = feats.map((f, i) => {
      const a = analizarGeometria(f.geometry) || { tipo: "—", medida: "", muestras: [], comunas: [] };
      const pr = f.properties || {};
      return { id: i, nombre: String(pr.name || pr.Name || pr.nombre || pr.NOMBRE || `Elemento ${i + 1}`).trim(), descripcion: pr.description || "", f, ...a, predios: null, estado: "" };
    });

    document.body.classList.remove("inicio");
    pintarPanelCapa();
    pintarAnalisis();  // primero el panel, para que el encuadre descuente su ancho
    const b = capa.getBounds();
    if (b.isValid()) mapa.flyToBounds(b, { ...P.paddingVista(), duration: 1.8, maxZoom: 17 });
    P.pintarEstado(`<span class="ok">●</span> <b>${esc(archivo)}</b> · ${elementos.length} elemento${elementos.length === 1 ? "" : "s"}`);
  }

  function quitar(limpiarEstado = true) {
    if (capa) mapa.removeLayer(capa);
    capa = null; elementos = []; archivo = "";
    pintarPanelCapa();
    if (limpiarEstado && document.querySelector(".analisis")) P.cerrarFicha();
  }

  // ── Panel en la consola ─────────────────────────────────
  function pintarPanelCapa() {
    const cont = $("#capaInfo");
    if (!capa) { cont.innerHTML = ""; cont.hidden = true; return; }
    cont.hidden = false;
    cont.innerHTML = `<span class="capa-nombre" title="${esc(archivo)}">${esc(archivo)}</span>
      <button class="enlace" id="verAnalisis">Ver análisis</button>
      <button class="enlace" id="quitarCapa" aria-label="Quitar capa">Quitar</button>`;
    $("#verAnalisis").onclick = () => { pintarAnalisis(); const b = capa.getBounds(); if (b.isValid()) mapa.flyToBounds(b, { ...P.paddingVista(), duration: 1.2, maxZoom: 17 }); };
    $("#quitarCapa").onclick = () => quitar();
  }

  // ── Análisis en el panel lateral ────────────────────────
  function filaPredio(p, e) {
    return `<button class="res-predio" data-e="${e.id}" data-lat="${p._lat}" data-lon="${p._lon}" data-cod="${p._cod}">
      <span class="rp-rol">${esc(p.rol)}</span>
      <span class="rp-dir">${esc((p.direccion || "Sin dirección").trim())}<small>${esc(P.titulo(p.destinoDescripcion))} · ${esc(p._comuna)}</small></span>
      <span class="rp-val">${p.valorTotal ? clp.format(p.valorTotal) : "—"}</span>
    </button>`;
  }

  function pintarAnalisis() {
    const totalComunas = new Map();
    elementos.forEach((e) => e.comunas.forEach((c) => totalComunas.set(c.cod, c)));
    const conPredios = elementos.filter((e) => e.predios && e.predios.length);
    const html = `
      <div class="analisis">
        <div class="ficha-cab">
          <div class="tipo">Capa importada</div>
          <div class="an-titulo">${esc(archivo)}</div>
          <div class="com">${elementos.length} elemento${elementos.length === 1 ? "" : "s"} · ${totalComunas.size} comuna${totalComunas.size === 1 ? "" : "s"}</div>
          <div class="chips">${[...totalComunas.values()].map((c) => `<span class="chip">${esc(c.nombre)}</span>`).join("") || `<span class="chip apagado">Fuera de las comunas con cartografía</span>`}</div>
        </div>
        <div class="an-acciones">
          <button class="boton primario" id="buscarTodos" ${elementos.some((e) => e.estado === "buscando") ? "disabled" : ""}>Buscar predios en todo</button>
          ${conPredios.length ? `<button class="boton" id="exportarCsv">Exportar CSV</button>` : ""}
        </div>
        <ol class="elementos">
          ${elementos.map((e) => `
            <li class="elemento" data-e="${e.id}">
              <div class="el-cab">
                <span class="el-num">${String(e.id + 1).padStart(2, "0")}</span>
                <span class="el-nombre">${esc(e.nombre)}</span>
                <span class="el-tipo">${esc(e.tipo)}${e.medida ? ` · ${esc(e.medida)}` : ""}</span>
              </div>
              <div class="el-comunas">${e.comunas.map((c) => esc(c.nombre)).join(" · ") || "Fuera de las comunas con cartografía del SII"}</div>
              <div class="el-acciones">
                <button class="enlace" data-ir="${e.id}">Ir al elemento</button>
                ${e.comunas.length ? `<button class="enlace" data-buscar="${e.id}" ${e.estado === "buscando" ? "disabled" : ""}>${e.predios ? "Volver a buscar" : "Buscar predios"}</button>` : ""}
              </div>
              ${e.estado === "buscando" ? `<div class="progreso"><i style="width:${e.avance || 0}%"></i></div><div class="el-nota">Consultando ${e.muestras.length} punto${e.muestras.length === 1 ? "" : "s"} al SII…</div>` : ""}
              ${e.predios ? (e.predios.length
                ? `<div class="el-nota">${e.predios.length} predio${e.predios.length === 1 ? "" : "s"} · avalúo sumado ${clp.format(e.predios.reduce((s, p) => s + (+p.valorTotal || 0), 0))}${e.tipo !== "Punto" ? " · muestreo, puede omitir lotes muy chicos" : ""}</div>
                   <div class="res-lista">${e.predios.map((p) => filaPredio(p, e)).join("")}</div>`
                : `<div class="el-nota">El SII no tiene predios en los puntos consultados.</div>`) : ""}
              ${e.error ? `<div class="el-nota mal">${esc(e.error)}</div>` : ""}
            </li>`).join("")}
        </ol>
        <p class="an-pie">El archivo se procesa en tu navegador; no se sube a ningún servidor. Para los polígonos y las líneas se consultan hasta ${MAX_MUESTRAS} puntos de muestra.</p>
      </div>`;
    P.abrirFicha(html);
  }

  // Delegación de eventos del panel de análisis
  $("#fichaCuerpo").addEventListener("click", async (ev) => {
    const t = ev.target.closest("button"); if (!t || !document.querySelector(".analisis") && !t.matches(".volver-analisis")) return;
    if (t.matches(".volver-analisis")) { pintarAnalisis(); return; }
    if (t.id === "buscarTodos") { for (const e of elementos) if (e.comunas.length) await buscar(e); return; }
    if (t.id === "exportarCsv") return exportar();
    if (t.dataset.ir != null) {
      const e = elementos[+t.dataset.ir];
      const b = L.geoJSON(e.f).getBounds();
      if (b.isValid()) mapa.flyToBounds(b, { ...P.paddingVista(), duration: 1.2, maxZoom: 18 });
      return;
    }
    if (t.dataset.buscar != null) return buscar(elementos[+t.dataset.buscar]);
    if (t.matches(".res-predio")) {
      const lat = +t.dataset.lat, lon = +t.dataset.lon, c = P.estado.porCod.get(+t.dataset.cod);
      mapa.flyTo([lat, lon], 18, { duration: 1.2 });
      await P.consultar(lat, lon, { candidatas: c ? [c] : undefined });
      const cab = document.querySelector("#fichaCuerpo .ficha-cab");
      if (cab && !document.querySelector(".analisis")) cab.insertAdjacentHTML("afterbegin", `<button class="enlace volver-analisis">← Volver a ${esc(archivo)}</button>`);
    }
  });

  // ── Búsqueda de predios por muestreo ────────────────────
  async function predioEn(lat, lon) {
    const candidatas = P.comunasEnPunto(lat, lon);
    for (const c of candidatas) {
      const r = await P.llamar("/predio", { cod: c.cod, layer: c.layer, lat: lat.toFixed(6), lon: lon.toFixed(6) });
      if (r.predio) return { ...r.predio, _lat: r.predio.ubicacionX || lat, _lon: r.predio.ubicacionY || lon, _cod: c.cod, _comuna: c.nombre };
    }
    return null;
  }

  async function buscar(e) {
    if (e.estado === "buscando") return;
    e.estado = "buscando"; e.avance = 0; e.error = ""; e.predios = null;
    pintarAnalisis();
    const vistos = new Map(); let hechas = 0, fallas = 0, cola = [...e.muestras];
    const trabajador = async () => {
      while (cola.length) {
        const [lon, lat] = cola.shift();
        try {
          const p = await predioEn(lat, lon);
          if (p) vistos.set(`${p._cod}:${p.rol}`, p);
        } catch (err) {
          fallas++;
          if (err.message === "sin-api") { cola = []; e.error = "Falta configurar el intermediario (PREDIAL_API)."; }
        }
        hechas++; e.avance = Math.round((hechas / e.muestras.length) * 100);
        const barra = document.querySelector(`.elemento[data-e="${e.id}"] .progreso i`);
        if (barra) barra.style.width = `${e.avance}%`;
      }
    };
    await Promise.all(Array.from({ length: HILOS }, trabajador));
    e.predios = [...vistos.values()].sort((a, b) => (+b.valorTotal || 0) - (+a.valorTotal || 0));
    e.estado = "";
    if (fallas && !e.error) e.error = `${fallas} consulta${fallas === 1 ? "" : "s"} no tuvieron respuesta del SII.`;
    if (document.querySelector(".analisis")) pintarAnalisis();
  }

  function exportar() {
    const cols = ["elemento", "rol", "comuna", "codigo_sii", "direccion", "destino", "ubicacion", "avaluo_total", "avaluo_afecto", "avaluo_exento", "lat", "lon"];
    const q = (v) => `"${String(v ?? "").replace(/"/g, '""').trim()}"`;
    const filas = elementos.flatMap((e) => (e.predios || []).map((p) => [e.nombre, p.rol, p._comuna, p._cod, p.direccion, p.destinoDescripcion, p.ubicacion, p.valorTotal, p.valorAfecto, p.valorExento, p._lat, p._lon].map(q).join(";")));
    const csv = "﻿" + [cols.join(";"), ...filas].join("\r\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    a.download = `predios_${archivo.replace(/\.[^.]+$/, "")}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // ── Entrada: botón y arrastrar al mapa ──────────────────
  const inputArchivo = $("#archivoCapa");
  $("#btnImportar").addEventListener("click", () => inputArchivo.click());
  inputArchivo.addEventListener("change", () => { if (inputArchivo.files[0]) importar(inputArchivo.files[0]); inputArchivo.value = ""; });

  const zona = $("#zonaSoltar");
  let profundidad = 0;
  const conArchivos = (ev) => [...(ev.dataTransfer?.types || [])].includes("Files");
  addEventListener("dragenter", (ev) => { if (!conArchivos(ev)) return; ev.preventDefault(); profundidad++; zona.hidden = false; });
  addEventListener("dragover", (ev) => { if (conArchivos(ev)) ev.preventDefault(); });
  addEventListener("dragleave", () => { if (--profundidad <= 0) { profundidad = 0; zona.hidden = true; } });
  addEventListener("drop", (ev) => {
    if (!conArchivos(ev)) return;
    ev.preventDefault(); profundidad = 0; zona.hidden = true;
    const f = ev.dataTransfer.files[0]; if (f) importar(f);
  });
})();
